// ── ORBITAL · The Pass (notes-backed tickets) ──────────────────────────
// The expediter's pass: loose notes become tickets, frictionlessly. Every ticket
// is a real StoredNote (GET/POST /api/projects/:id/notes, PUT/DELETE /api/notes/:id)
// — there is NO beads REST surface, so the bead jar (BeadsExplorer) is an honest
// disabled placeholder, not a fake input.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { INK, TICKET_KINDS, type TicketKind } from "../theme";
import { Button, Chip, Icon, VoiceCue } from "../primitives";
import { useDialog } from "../useFocusTrap";
import type { StationProject } from "../station";
import type { StoredNote } from "../../store/types";
import type { Plan } from "../../types";

// Map the persisted NoteType onto the design's ticket kinds (the wire only ever stores "note"; the
// kind chip is a read-time presentation of whatever type the note carries).
function kindFor(t: StoredNote["type"]): TicketKind {
  if (t === "warning") return "bug";
  if (t === "todo") return "todo";
  if (t === "handoff" || t === "decision") return "log";
  return "note";
}
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function TicketCard({ n, dark, onEdit, onDelete, onFirePane, onJumpToPane }: { n: StoredNote; dark: boolean; onEdit: (id: string, text: string) => void; onDelete: (id: string) => void; onFirePane: (projectId: string) => void; onJumpToPane: (paneId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(n.text);
  const k = TICKET_KINDS[kindFor(n.type)];
  const fg = dark ? "#ffe9c7" : INK;
  return (
    <div data-testid="pass-ticket" style={{ width: 230, flexShrink: 0, padding: 11, border: "2px solid " + INK, borderRadius: 11, background: dark ? "#241409" : "#fff9ec", boxShadow: "2px 2px 0 0 " + INK, display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Chip bg={k.color} color={k.color === "#d4a15a" ? INK : "#fff4de"}>{k.emoji} {k.label}</Chip>
        {n.pane_id && (
          <button data-testid="pass-ticket-jump" onClick={() => onJumpToPane(n.pane_id!)} title="Jump to this station"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, border: "1.5px solid " + INK, background: dark ? "#2f1d12" : "#fff4de", color: dark ? "#9be3c0" : "#2f7a5e", cursor: "pointer", fontFamily: "JetBrains Mono", fontSize: 10, fontWeight: 700 }}>#{n.pane_id} ›</button>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 8.5, color: "#8a6a4f" }}>{ago(n.created_at)}</span>
      </div>
      {editing ? (
        <textarea data-testid="pass-ticket-edit" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
          style={{ resize: "none", minHeight: 56, padding: 7, border: "2px solid " + INK, borderRadius: 8, background: dark ? "#1a0f08" : "#fff4de", color: fg, fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, outline: "none" }} />
      ) : (
        <div style={{ fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, color: fg, lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{n.text}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontFamily: "DM Sans", fontSize: 9.5, fontWeight: 700, color: "#8a6a4f", textTransform: "uppercase", letterSpacing: ".05em" }}>— {n.author === "janus" ? "Chef de Cuisine" : "you"}</span>
        <div style={{ flex: 1 }} />
        {editing ? (
          <>
            <button onClick={() => { setEditing(false); setDraft(n.text); }} title="Cancel" style={miniBtn(dark)}>✕</button>
            <button data-testid="pass-ticket-save" onClick={() => { onEdit(n.id, draft); setEditing(false); }} title="Save" style={{ ...miniBtn(dark), background: "#4db892", color: "#fff4de" }}>✓</button>
          </>
        ) : (
          <>
            {!n.pane_id && <button data-testid="pass-ticket-fire" onClick={() => onFirePane(n.project_id)} title="Fire a pane on this ticket" style={{ ...miniBtn(dark), background: "#e23a3a", color: "#fff4de", width: "auto", padding: "0 8px", gap: 4, display: "inline-flex" }}><Icon name="fire" size={11} /><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 10 }}>Fire a pane</span></button>}
            <button data-testid="pass-ticket-edit-btn" onClick={() => setEditing(true)} title="Amend the ticket" style={miniBtn(dark)}><Icon name="ticket" size={12} /></button>
            <button data-testid="pass-ticket-delete" onClick={() => onDelete(n.id)} title="86 this one" style={{ ...miniBtn(dark), color: "#e23a3a" }}><Icon name="x" size={12} /></button>
          </>
        )}
      </div>
    </div>
  );
}
function miniBtn(dark: boolean): CSSProperties {
  return { width: 26, height: 24, display: "grid", placeItems: "center", border: "1.5px solid " + INK, borderRadius: 7, background: dark ? "#1a0f08" : "#fff4de", color: dark ? "#ffe9c7" : INK, cursor: "pointer", fontWeight: 800, fontSize: 12, padding: 0 };
}

// 4U.1: a voice-built plan as a spec ticket. Every field is real (GET /api/plans / plans_updated):
// name, step count + progress, status. Execute fires the classic POST /api/plans/:id/execute (step 1
// runs through the gate server-side — 202 means "needs your ok at the pass"); 86 is the gated DELETE
// with the Phase-2 two-tap inline confirm (auto-resets after 3s).
const SPEC_STATUS: Record<Plan["status"], { label: string; bg: string; fg: string }> = {
  idle:      { label: "ready",   bg: "#d4a15a", fg: INK },
  running:   { label: "firing",  bg: "#ffc94a", fg: INK },
  paused:    { label: "paused",  bg: "#ff8a3d", fg: INK },
  completed: { label: "plated",  bg: "#4db892", fg: INK },
};
function SpecTicket({ p, dark, onExecute, onDelete }: {
  p: Plan; dark: boolean; onExecute: (id: string) => void; onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);
  const fg = dark ? "#ffe9c7" : INK;
  const skin = SPEC_STATUS[p.status] ?? SPEC_STATUS.idle;
  const steps = Array.isArray(p.steps) ? p.steps : [];
  const done = steps.filter((s) => s.status === "completed").length;
  const on86 = () => {
    if (!confirming) {
      setConfirming(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    onDelete(p.id);
  };
  return (
    <div data-testid="pass-spec" data-plan-id={p.id} data-plan-status={p.status}
      style={{ width: 230, flexShrink: 0, padding: 11, border: "2px solid " + INK, borderRadius: 11, background: dark ? "#1c1430" : "#efeaff", boxShadow: "2px 2px 0 0 " + INK, display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Chip bg="#4b3bb3" color="#fff4de">📋 spec</Chip>
        <Chip bg={skin.bg} color={skin.fg}>{skin.label}</Chip>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 8.5, color: "#8a6a4f" }}>{done}/{steps.length} steps</span>
      </div>
      <div style={{ fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, color: fg, lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.name}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontFamily: "DM Sans", fontSize: 9.5, fontWeight: 700, color: "#8a6a4f", textTransform: "uppercase", letterSpacing: ".05em" }}>— Chef de Cuisine</span>
        <div style={{ flex: 1 }} />
        <button data-testid="pass-spec-fire" onClick={() => onExecute(p.id)}
          title={p.status === "running" ? "Already firing — re-fire step 1" : "Fire this spec (step 1 runs through the gate)"}
          style={{ ...miniBtn(dark), background: "#e23a3a", color: "#fff4de", width: "auto", padding: "0 8px", gap: 4, display: "inline-flex" }}>
          <Icon name="fire" size={11} /><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 10 }}>Fire it</span>
        </button>
        <button data-testid="pass-spec-delete" onClick={on86} data-confirming={confirming || undefined}
          title={confirming ? "This 86 is for keeps — tap again" : "86 this spec"}
          style={confirming
            ? { ...miniBtn(dark), background: "#e23a3a", color: "#fff4de", width: "auto", padding: "0 8px" }
            : { ...miniBtn(dark), color: "#e23a3a" }}>
          {confirming ? <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 10 }}>Sure, Chef?</span> : <Icon name="x" size={12} />}
        </button>
      </div>
    </div>
  );
}

function JotNote({ dark, projectName, disabled, onAdd }: { dark: boolean; projectName: string; disabled: boolean; onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  const fire = () => { if (text.trim()) { onAdd(text); setText(""); } };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
      <input data-testid="pass-jot-input" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") fire(); }}
        placeholder={disabled ? "pick a kitchen to jot…" : `what's on your mind, Chef? (${projectName})`}
        style={{ width: 260, padding: "8px 11px", border: "2px solid " + INK, borderRadius: 9, background: dark ? "#1a0f08" : "#fff4de", color: dark ? "#ffe9c7" : INK, fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, outline: "none", opacity: disabled ? 0.6 : 1 }} />
      <Button testId="pass-jot-add" variant="blueberry" size="sm" icon="plus" disabled={disabled || !text.trim()} onClick={fire}>Jot it</Button>
    </div>
  );
}

function BeadsExplorer({ dark, onClose }: { dark: boolean; onClose: () => void }) {
  // 2K.5: dialog semantics — initial focus, focus trap, Escape closes (top-most only).
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(42,26,16,.6)", zIndex: 220, display: "grid", placeItems: "center", padding: 20 }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="The bead jar"
        onClick={(e) => e.stopPropagation()} data-testid="beads-explorer" style={{ width: "min(440px, 94vw)", background: dark ? "#241409" : "#fff9ec", border: "3px solid " + INK, borderRadius: 16, boxShadow: "8px 8px 0 0 " + INK, padding: 24, textAlign: "center", outline: "none" }}>
        <div style={{ fontSize: 34, marginBottom: 6 }}>🫙</div>
        <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 22, color: dark ? "#ffe9c7" : INK }}>The bead jar</div>
        <div style={{ fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, color: "#8a6a4f", margin: "8px auto 16px", maxWidth: 320, lineHeight: 1.45 }}>
          Beads live in the project's local Dolt DB, reached through the <code style={{ fontFamily: "JetBrains Mono" }}>bd</code> CLI — there's no HTTP door to them yet. The Pass runs on notes for now.
        </div>
        <Button variant="default" onClick={onClose}>Back to the pass</Button>
      </div>
    </div>
  );
}

export function ThePass({ notes, plans, jotProjectId, jotProjectName, dark, voiceCues, onAdd, onEdit, onDelete, onFirePane, onJumpToPane, onExecutePlan, onDeletePlan }: {
  notes: StoredNote[]; jotProjectId: string | null; jotProjectName: string; dark: boolean; voiceCues: boolean;
  /** 4U.1: voice-built orchestrator plans, surfaced as spec tickets. */
  plans: Plan[];
  onAdd: (projectId: string, text: string) => void; onEdit: (id: string, text: string) => void; onDelete: (id: string) => void;
  onFirePane: (projectId: string) => void; onJumpToPane: (paneId: string) => void;
  onExecutePlan: (planId: string) => void; onDeletePlan: (planId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [jar, setJar] = useState(false);
  const canJot = !!jotProjectId && jotProjectId !== "all";
  const fg = dark ? "#ffe9c7" : INK;

  return (
    <div data-testid="the-pass" style={{ flexShrink: 0, borderBottom: "3px solid " + INK, background: dark ? "#2f1d12" : "#fff4de" }}>
      {/* the bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 16px" }}>
        <button data-testid="pass-expand" onClick={() => setExpanded((e) => !e)} title={expanded ? "fold up" : "blow out the pass"}
          style={{ display: "flex", alignItems: "center", gap: 7, border: "none", background: "transparent", cursor: "pointer", color: fg }}>
          <span style={{ fontSize: 17 }}>🎫</span>
          <span style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 17 }}>The Pass</span>
          <Chip bg="#e23a3a" color="#fff4de">{notes.length}</Chip>
          {plans.length > 0 && <Chip bg="#4b3bb3" color="#fff4de">{plans.length} spec{plans.length === 1 ? "" : "s"}</Chip>}
          <span style={{ fontFamily: "DM Sans", fontSize: 11, color: "#8a6a4f", transform: expanded ? "rotate(180deg)" : "none" }}>▾</span>
        </button>
        {voiceCues && <VoiceCue phrase="what's on the pass?" dark={dark} />}
        <div style={{ flex: 1 }} />
        <JotNote dark={dark} projectName={jotProjectName} disabled={!canJot} onAdd={(t) => jotProjectId && onAdd(jotProjectId, t)} />
        <button data-testid="pass-jar" onClick={() => setJar(true)} title="Explore the bead jar" style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 10px", borderRadius: 9, border: "2px solid " + INK, background: dark ? "#1a0f08" : "#fff9ec", color: fg, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, flexShrink: 0 }}>🫙 jar</button>
      </div>

      {/* the tickets (collapsed = a single scrolling row; expanded = wrap). 4U.1: spec tickets
          (voice-built plans) lead the row — they're the fireable work; notes follow. */}
      {notes.length === 0 && plans.length === 0 ? (
        expanded && <div data-testid="pass-empty" style={{ padding: "4px 16px 14px", fontFamily: "Caveat, cursive", fontSize: 16, color: "#8a6a4f" }}>nothin' on the pass — clean board, Chef 😌</div>
      ) : (
        <div style={{ display: "flex", gap: 10, padding: "2px 16px 14px", overflowX: expanded ? "visible" : "auto", flexWrap: expanded ? "wrap" : "nowrap" }}>
          {plans.map((p) => <Fragment key={p.id}><SpecTicket p={p} dark={dark} onExecute={onExecutePlan} onDelete={onDeletePlan} /></Fragment>)}
          {notes.map((n) => <Fragment key={n.id}><TicketCard n={n} dark={dark} onEdit={onEdit} onDelete={onDelete} onFirePane={onFirePane} onJumpToPane={onJumpToPane} /></Fragment>)}
        </div>
      )}

      {jar && <BeadsExplorer dark={dark} onClose={() => setJar(false)} />}
    </div>
  );
}
