// ── ORBITAL · the Station handoff DRAWER (operator decision D1: a LINE drawer, not a Pass card) ──
// j4e1: the handoff lifecycle (compose/revise/stage/deliver/reject) is server-tested but had ZERO UI.
// This drawer slides out from a station row on The Line and FOREGROUNDS the four hero actions —
// stage / deliver / revise / reject — for every handoff bound TO that station (to_pane). It is purely
// a decision surface: from→to, a status chip, the composed-prompt summary, and the buttons that call
// the canonical handoff REST twins (wired in useOrbitalData → POST /api/handoffs/:id/<verb>).
import { Fragment, useState } from "react";
import { INK } from "./theme";
import type { StoredHandoff } from "../store/types";
import { handoffStatusLabel } from "./useOrbitalDataHelpers";

// The lifecycle stages where revise/reject are still meaningful. A delivered/consumed/rejected/
// expired/blocked handoff is terminal — we still SHOW it (history is honest) but the hero buttons
// are disabled, so the operator never fires a no-op into a settled row.
const ACTIONABLE: ReadonlySet<StoredHandoff["state"]> = new Set(["composing", "revising", "staged"]);
// Stage advances a fresh/edited draft to `staged` (the ONLY state Deliver accepts); it's meaningful
// only while the draft is still mutable (composing/revising). A staged row is already staged.
const STAGEABLE: ReadonlySet<StoredHandoff["state"]> = new Set(["composing", "revising"]);
// Deliver is only valid from `staged` (the server rejects a non-staged deliver); gate the button so
// the affordance reads honestly rather than bouncing off a server "not staged" narration.
const DELIVERABLE: ReadonlySet<StoredHandoff["state"]> = new Set(["staged"]);

const STATUS_BG: Record<string, string> = {
  composing: "#d4a15a", revising: "#d4a15a", staged: "#ffc94a", delivered: "#9be3c0",
  consumed: "#9be3c0", rejected: "#e2a3a3", expired: "#c9a97a", blocked_read_only: "#ff8a3d",
};

function StatusChip({ state }: { state: StoredHandoff["state"] }) {
  return (
    <span data-testid="handoff-status" data-state={state} style={{
      display: "inline-flex", alignItems: "center", padding: "1px 8px", borderRadius: 999,
      background: STATUS_BG[state] ?? "#c9a97a", border: "1.5px solid " + INK, color: INK,
      fontFamily: "DM Sans", fontSize: 9.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase",
    }}>{handoffStatusLabel(state)}</span>
  );
}

const HERO_BG: Record<string, string> = {
  stage: "#9be3c0", deliver: "#ffc94a", reject: "#e2a3a3", revise: "#fff4de",
};

function HeroButton({ label, emoji, kind, disabled, onClick, testid }: {
  label: string; emoji: string; kind: "stage" | "deliver" | "revise" | "reject"; disabled: boolean;
  onClick: () => void; testid: string;
}) {
  const bg = HERO_BG[kind] ?? "#fff4de";
  return (
    <button data-testid={testid} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 11px", borderRadius: 8,
        border: "2px solid " + INK, background: bg, color: INK, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1, fontFamily: "DM Sans", fontWeight: 800, fontSize: 11.5,
        boxShadow: disabled ? "none" : "2px 2px 0 0 " + INK,
      }}>{emoji} {label}</button>
  );
}

// The textarea style — shared so the editor reads identically wherever it mounts.
const REVISE_INPUT_STYLE = {
  width: "100%", boxSizing: "border-box" as const, padding: 7, borderRadius: 7, border: "1.5px solid " + INK,
  fontFamily: "JetBrains Mono", fontSize: 11, resize: "vertical" as const, marginBottom: 7, background: "#fff",
};

// Save is enabled ONLY when the operator actually changed the (non-empty) text vs. the editor's seed —
// so a no-op Save can never PUT the seeded prompt back (which, if the seed were the truncated list
// projection, would corrupt a >200-char prompt). The seed is the FULL prompt (read_handoff), so an
// unchanged Save would also be a wasteful revision; both are prevented by this single guard.
function isReviseDirty(draft: string, seed: string): boolean {
  return !!draft.trim() && draft !== seed;
}

/** Edit-mode action row: Save (gated on a real change) + Cancel (restores the seed). */
function EditActions({ id, draft, seed, onRevise, onDone }: {
  id: string; draft: string; seed: string; onRevise: (id: string, text: string) => void; onDone: (restore: boolean) => void;
}) {
  return (
    <>
      <HeroButton testid="handoff-revise-save" kind="revise" emoji="✓" label="Save"
        disabled={!isReviseDirty(draft, seed)} onClick={() => { onRevise(id, draft); onDone(false); }} />
      <button data-testid="handoff-revise-cancel" onClick={(e) => { e.stopPropagation(); onDone(true); }}
        style={{ padding: "5px 11px", borderRadius: 8, border: "2px solid " + INK, background: "#fff4de", color: INK, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 11.5 }}>Cancel</button>
    </>
  );
}

/** View-mode hero row: Stage → Deliver → Revise → Reject, each gated to its valid lifecycle window. */
function ViewActions({ h, actionable, onStartEdit, onDeliver, onStage, onReject }: {
  h: StoredHandoff; actionable: boolean; onStartEdit: () => void;
  onDeliver: (id: string) => void; onStage: (id: string) => void; onReject: (id: string) => void;
}) {
  return (
    <>
      <HeroButton testid="handoff-stage" kind="stage" emoji="🍳" label="Stage"
        disabled={!STAGEABLE.has(h.state)} onClick={() => onStage(h.id)} />
      <HeroButton testid="handoff-deliver" kind="deliver" emoji="🍽" label="Deliver"
        disabled={!DELIVERABLE.has(h.state)} onClick={() => onDeliver(h.id)} />
      <HeroButton testid="handoff-revise" kind="revise" emoji="✍️" label="Revise"
        disabled={!actionable} onClick={onStartEdit} />
      <HeroButton testid="handoff-reject" kind="reject" emoji="🗑" label="Reject"
        disabled={!actionable} onClick={() => onReject(h.id)} />
    </>
  );
}

function HandoffRow({ h, onDeliver, onRevise, onStage, onReject, onFetchPrompt }: {
  h: StoredHandoff;
  onDeliver: (id: string) => void;
  onRevise: (id: string, text: string) => void;
  onStage: (id: string) => void;
  onReject: (id: string) => void;
  onFetchPrompt: (id: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(h.composed_prompt);
  // The editor's BASELINE — the full prompt the textarea was seeded with. Save compares against it so
  // an unchanged Save is a no-op, and it can never resubmit the truncated list projection.
  const [seed, setSeed] = useState(h.composed_prompt);
  const actionable = ACTIONABLE.has(h.state);
  // Entering edit: seed from the FULL prompt (read_handoff), NOT the list projection (truncated/redacted
  // to 200 chars). Open immediately with the projection so the UI is responsive, then upgrade to the
  // full text when it lands (caller returns null in mock / on failure → keep the projection).
  const startEdit = () => {
    setDraft(h.composed_prompt); setSeed(h.composed_prompt); setEditing(true);
    onFetchPrompt(h.id).then((full) => { if (typeof full === "string") { setDraft(full); setSeed(full); } });
  };
  const finishEdit = (restore: boolean) => { if (restore) setDraft(seed); setEditing(false); };
  return (
    <div data-testid="handoff-row" data-handoff-id={h.id} style={{
      padding: 9, borderRadius: 9, border: "1.5px solid " + INK, background: "#fff9ec", marginBottom: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 10, fontWeight: 700, color: "#8a6a4f" }}>
          {h.from_pane ?? "—"} → {h.to_pane}
        </span>
        <div style={{ flex: 1 }} />
        <StatusChip state={h.state} />
      </div>
      {editing ? (
        <textarea data-testid="handoff-revise-input" value={draft} onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)} rows={3} style={REVISE_INPUT_STYLE} />
      ) : (
        <div data-testid="handoff-summary" style={{
          fontFamily: "JetBrains Mono", fontSize: 11, color: INK, lineHeight: 1.35, marginBottom: 7,
          whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 66, overflow: "hidden",
        }}>{h.composed_prompt || "(empty draft)"}</div>
      )}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {editing ? (
          <EditActions id={h.id} draft={draft} seed={seed} onRevise={onRevise} onDone={finishEdit} />
        ) : (
          <ViewActions h={h} actionable={actionable} onStartEdit={startEdit}
            onDeliver={onDeliver} onStage={onStage} onReject={onReject} />
        )}
      </div>
    </div>
  );
}

export function StationHandoffDrawer({ handoffs, onDeliver, onRevise, onStage, onReject, onFetchPrompt }: {
  /** Handoffs bound to THIS station (already filtered to to_pane === station id by the caller). */
  handoffs: StoredHandoff[];
  onDeliver: (id: string) => void;
  onRevise: (id: string, text: string) => void;
  onStage: (id: string) => void;
  onReject: (id: string) => void;
  onFetchPrompt: (id: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  if (handoffs.length === 0) return null;
  // The active count = rows still in play (drives the chip badge; settled rows stay visible in the drawer).
  const active = handoffs.filter((h) => ACTIONABLE.has(h.state)).length;
  return (
    <div data-testid="handoff-drawer" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} style={{
      marginTop: 9, paddingTop: 8, borderTop: "1.5px dashed #c9a97a",
    }}>
      <button data-testid="handoff-drawer-toggle" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999,
          border: "2px solid " + INK, background: active > 0 ? "#ffc94a" : "#fff4de", color: INK,
          cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 11,
        }}>
        📋 {handoffs.length} handoff{handoffs.length === 1 ? "" : "s"}{active > 0 ? ` · ${active} live` : ""}
        <span style={{ fontSize: 9 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div data-testid="handoff-drawer-body" style={{ marginTop: 9 }}>
          {handoffs.map((h) => (
            <Fragment key={h.id}>
              <HandoffRow h={h} onDeliver={onDeliver} onRevise={onRevise} onStage={onStage}
                onReject={onReject} onFetchPrompt={onFetchPrompt} />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
