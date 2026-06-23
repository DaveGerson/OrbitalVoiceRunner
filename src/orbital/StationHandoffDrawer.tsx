// ── ORBITAL · the Station handoff DRAWER (operator decision D1: a LINE drawer, not a Pass card) ──
// j4e1: the handoff lifecycle (compose/revise/stage/deliver/reject) is server-tested but had ZERO UI.
// This drawer slides out from a station row on The Line and FOREGROUNDS the three hero actions —
// deliver / revise / reject — for every handoff bound TO that station (to_pane). It is purely a
// decision surface: from→to, a status chip, the composed-prompt summary, and the three buttons that
// call the canonical handoff REST twins (wired in useOrbitalData → POST /api/handoffs/:id/<verb>).
import { Fragment, useState } from "react";
import { INK } from "./theme";
import type { StoredHandoff } from "../store/types";
import { handoffStatusLabel } from "./useOrbitalDataHelpers";

// The lifecycle stages where deliver/revise are still meaningful. A delivered/consumed/rejected/
// expired/blocked handoff is terminal — we still SHOW it (history is honest) but the hero buttons
// are disabled, so the operator never fires a no-op into a settled row.
const ACTIONABLE: ReadonlySet<StoredHandoff["state"]> = new Set(["composing", "revising", "staged"]);
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

function HeroButton({ label, emoji, kind, disabled, onClick, testid }: {
  label: string; emoji: string; kind: "deliver" | "revise" | "reject"; disabled: boolean;
  onClick: () => void; testid: string;
}) {
  const bg = kind === "deliver" ? "#ffc94a" : kind === "reject" ? "#e2a3a3" : "#fff4de";
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

function HandoffRow({ h, onDeliver, onRevise, onReject }: {
  h: StoredHandoff;
  onDeliver: (id: string) => void;
  onRevise: (id: string, text: string) => void;
  onReject: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(h.composed_prompt);
  const actionable = ACTIONABLE.has(h.state);
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
          onChange={(e) => setDraft(e.target.value)} rows={3} style={{
            width: "100%", boxSizing: "border-box", padding: 7, borderRadius: 7, border: "1.5px solid " + INK,
            fontFamily: "JetBrains Mono", fontSize: 11, resize: "vertical", marginBottom: 7, background: "#fff",
          }} />
      ) : (
        <div data-testid="handoff-summary" style={{
          fontFamily: "JetBrains Mono", fontSize: 11, color: INK, lineHeight: 1.35, marginBottom: 7,
          whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 66, overflow: "hidden",
        }}>{h.composed_prompt || "(empty draft)"}</div>
      )}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {editing ? (
          <>
            <HeroButton testid="handoff-revise-save" kind="revise" emoji="✓" label="Save"
              disabled={!draft.trim()} onClick={() => { onRevise(h.id, draft); setEditing(false); }} />
            <button data-testid="handoff-revise-cancel" onClick={(e) => { e.stopPropagation(); setDraft(h.composed_prompt); setEditing(false); }}
              style={{ padding: "5px 11px", borderRadius: 8, border: "2px solid " + INK, background: "#fff4de", color: INK, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 11.5 }}>Cancel</button>
          </>
        ) : (
          <>
            <HeroButton testid="handoff-deliver" kind="deliver" emoji="🍽" label="Deliver"
              disabled={!DELIVERABLE.has(h.state)} onClick={() => onDeliver(h.id)} />
            <HeroButton testid="handoff-revise" kind="revise" emoji="✍️" label="Revise"
              disabled={!actionable} onClick={() => { setDraft(h.composed_prompt); setEditing(true); }} />
            <HeroButton testid="handoff-reject" kind="reject" emoji="🗑" label="Reject"
              disabled={!actionable} onClick={() => onReject(h.id)} />
          </>
        )}
      </div>
    </div>
  );
}

export function StationHandoffDrawer({ handoffs, onDeliver, onRevise, onReject }: {
  /** Handoffs bound to THIS station (already filtered to to_pane === station id by the caller). */
  handoffs: StoredHandoff[];
  onDeliver: (id: string) => void;
  onRevise: (id: string, text: string) => void;
  onReject: (id: string) => void;
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
              <HandoffRow h={h} onDeliver={onDeliver} onRevise={onRevise} onReject={onReject} />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
