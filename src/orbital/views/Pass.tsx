// ── ORBITAL · The Pass (notes-backed tickets) ──────────────────────────
// The expediter's pass: loose notes become tickets, frictionlessly. Every ticket
// is a real StoredNote (GET/POST /api/projects/:id/notes, PUT/DELETE /api/notes/:id)
// — there is NO beads REST surface, so the bead jar (BeadsExplorer) is an honest
// disabled placeholder, not a fake input.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { INK, TICKET_KINDS, type TicketKind } from "../theme";
import { Button, Chip, Icon, VoiceCue } from "../primitives";
import { useDialog } from "../useFocusTrap";
import type { Station, StationProject } from "../station";
import type { StoredNote, NoteType } from "../../store/types";
import type { PaneLayout, Plan, AttentionItem } from "../../types";
import type { TemplateView } from "../useOrbitalData";
import { pendingApprovalBadgeCount } from "../useOrbitalDataHelpers";
import { apiFetch } from "../../utils/api";

// Map the persisted NoteType onto the design's ticket kinds (the wire only ever stores "note"; the
// kind chip is a read-time presentation of whatever type the note carries).
function kindFor(t: StoredNote["type"]): TicketKind {
  if (t === "warning") return "bug";
  if (t === "todo") return "todo";
  if (t === "handoff" || t === "decision") return "log";
  return "note";
}
// ── hwu.6: the project export download (GET /api/projects/:id/export) ────────────────────────────
// A best-effort browser download of the SAME deterministic, redacted Markdown the voice export_project
// tool writes to disk — this button never writes anything server-side, it just fetches the composed
// text and hands the browser a Blob to save. A failed fetch degrades to a silent no-op (there is
// nothing else useful to show inline for a download button).
async function downloadProjectExport(projectId: string): Promise<void> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/export`);
  if (!res.ok) return;
  const text = await res.text();
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ORBITAL_EXPORT.md";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Pure module-level helpers (exported for tests) ────────────────────────────

/** Returns "" for 1, "s" for any other count — avoids repeated ternaries in JSX. */
export function pluralSuffix(n: number): string {
  return n === 1 ? "" : "s";
}

/** Resolves TemplateForm's optional `initial` prop into concrete default strings. */
export function resolveTemplateInitial(initial?: { name: string; description: string; body: string }): { name: string; description: string; body: string } {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    body: initial?.body ?? "",
  };
}

// ── hwu.5: The Pass ticket filter chips (type/author/date) — pure helpers ─────────────────────
// Client-side only: notes already carry their persisted type/author/created_at, so filtering is a
// pure narrowing of the same list the server already sent. Kept as pure exported functions (same
// idiom as pluralSuffix/attentionActKind above) so ThePass's own render function stays under the
// complexity gate.

export type NoteTypeFilter = "all" | NoteType;
export type NoteAuthorFilter = "all" | "janus" | "you";
export type NoteDateFilter = "all" | "today" | "week";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = DAY_MS * 7;

/** The type chip: "all" always matches; otherwise an exact NoteType match. */
export function matchesTypeFilter(n: Pick<StoredNote, "type">, filter: NoteTypeFilter): boolean {
  return filter === "all" || n.type === filter;
}

/** The author chip: "you" maps to the persisted "user" author (the operator's own notes/turns);
 *  "janus" matches the model's own notes; "all" always matches. */
export function matchesAuthorFilter(n: Pick<StoredNote, "author">, filter: NoteAuthorFilter): boolean {
  if (filter === "all") return true;
  return n.author === (filter === "you" ? "user" : "janus");
}

/** The recency-bucket chip: "today" = last 24h, "week" = last 7d (inclusive of "today"), "all" =
 *  no recency narrowing. `now` is injectable so tests are deterministic. */
export function matchesDateFilter(n: Pick<StoredNote, "created_at">, filter: NoteDateFilter, now: number = Date.now()): boolean {
  if (filter === "all") return true;
  const age = now - n.created_at;
  return age <= (filter === "today" ? DAY_MS : WEEK_MS);
}

/** Compose all three chip filters into one pure narrowing pass — the single point the ticket-list
 *  render narrows `notes` through. Generic over any note-shaped row so tests can pass minimal fixtures. */
export function filterNotes<T extends Pick<StoredNote, "type" | "author" | "created_at">>(
  notes: T[],
  filters: { type: NoteTypeFilter; author: NoteAuthorFilter; date: NoteDateFilter },
  now: number = Date.now(),
): T[] {
  return notes.filter((n) =>
    matchesTypeFilter(n, filters.type) && matchesAuthorFilter(n, filters.author) && matchesDateFilter(n, filters.date, now));
}

/** Chip metadata for the type-filter row (emoji + label), independent of the ticket-card kindFor
 *  collapse (decision/handoff share a ticket "kind" visually but are DISTINCT filter chips). */
export const NOTE_TYPE_CHIPS: Array<{ id: NoteTypeFilter; label: string; emoji: string }> = [
  { id: "all", label: "all", emoji: "📋" },
  { id: "decision", label: "decision", emoji: "🧭" },
  { id: "todo", label: "todo", emoji: "✅" },
  { id: "warning", label: "warning", emoji: "⚠️" },
  { id: "note", label: "note", emoji: "📝" },
  { id: "handoff", label: "handoff", emoji: "🤝" },
];
export const NOTE_AUTHOR_CHIPS: Array<{ id: NoteAuthorFilter; label: string }> = [
  { id: "all", label: "all" },
  { id: "janus", label: "janus" },
  { id: "you", label: "you" },
];
export const NOTE_DATE_CHIPS: Array<{ id: NoteDateFilter; label: string }> = [
  { id: "all", label: "all" },
  { id: "today", label: "today" },
  { id: "week", label: "week" },
];

// ── D2: the Attention ("what needs me") tab ───────────────────────────────────
// The act a queue row offers, by AttentionItem.type AND whether it carries a resolvable messageId:
//   approval / confirmation WITH a messageId → a HELD gated request: real Approve/Deny that hit the
//     SAME POST /api/commands/approve resolver voice uses (bead e7h).
//   approval / confirmation WITHOUT a messageId → a triage-only suggestion (no held request to
//     resolve): "Open" (go to the station) + "Dismiss". Never a fake approve.
//   error / exited / build-failed → a dead/failed station: restart (+ jump)
//   idle (completion) / anything else → nothing to act on: jump to the station
export type AttentionActKind = "approve" | "open" | "restart" | "jump";

/** The Attention tab label: bare "Attention" when nothing's waiting, "Attention • N" otherwise.
 *  A non-positive/garbage count is treated as empty (never renders a stray bullet). */
export function attentionTabLabel(count: number): string {
  return count > 0 ? `Attention • ${count}` : "Attention";
}

/** Which act buttons one attention row shows, from its item type AND its resolvability (bead e7h).
 *  An approval/confirmation item is only truly ACTIONABLE (real Approve/Deny) when it carries a
 *  messageId — the id of the held gated request to resolve. Without one it degrades to "open" (go to
 *  the station + Dismiss), so the inbox never offers a fake approve. Unknown types degrade to a plain
 *  jump so a row is never dead. Keep ≤ the complexity gate (a flat lookup, no nesting). */
export function attentionActKind(item: { type?: string; messageId?: string }): AttentionActKind {
  if (item.type === "approval" || item.type === "confirmation") return item.messageId ? "approve" : "open";
  if (item.type === "error" || item.type === "exited" || item.type === "build-failed") return "restart";
  return "jump";
}

function TicketCard({ n, dark, onEdit, onDelete, onFirePane, onJumpToPane }: { n: StoredNote; dark: boolean; onEdit: (id: string, text: string) => void; onDelete: (id: string) => void; onFirePane: (projectId: string) => void; onJumpToPane: (paneId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(n.text);
  const k = TICKET_KINDS[kindFor(n.type)];
  const fg = dark ? "#ffe9c7" : INK;

  // Inline render helper — moves 3 dark-mode branches out of TicketCard's CC budget.
  function renderJumpButton(): ReactNode {
    if (!n.pane_id) return null;
    return (
      <button data-testid="pass-ticket-jump" onClick={() => onJumpToPane(n.pane_id!)} title="Jump to this station"
        style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, border: "1.5px solid " + INK, background: dark ? "#2f1d12" : "#fff4de", color: dark ? "#9be3c0" : "#2f7a5e", cursor: "pointer", fontFamily: "JetBrains Mono", fontSize: 12, fontWeight: 700 }}>#{n.pane_id} ›</button>
    );
  }

  return (
    <div data-testid="pass-ticket" style={{ width: 230, flexShrink: 0, padding: 11, border: "2px solid " + INK, borderRadius: 11, background: dark ? "#241409" : "#fff9ec", boxShadow: "2px 2px 0 0 " + INK, display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Chip bg={k.color} color={k.color === "#d4a15a" ? INK : "#fff4de"}>{k.emoji} {k.label}</Chip>
        {renderJumpButton()}
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>{ago(n.created_at)}</span>
      </div>
      {editing ? (
        <textarea data-testid="pass-ticket-edit" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
          style={{ resize: "none", minHeight: 56, padding: 7, border: "2px solid " + INK, borderRadius: 8, background: dark ? "#1a0f08" : "#fff4de", color: fg, fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, outline: "none" }} />
      ) : (
        <div style={{ fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, color: fg, lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{n.text}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: "#8a6a4f", textTransform: "uppercase", letterSpacing: ".05em" }}>— {n.author === "janus" ? "Chef de Cuisine" : "you"}</span>
        <div style={{ flex: 1 }} />
        {editing ? (
          <>
            <button onClick={() => { setEditing(false); setDraft(n.text); }} title="Cancel" style={miniBtn(dark)}>✕</button>
            <button data-testid="pass-ticket-save" onClick={() => { onEdit(n.id, draft); setEditing(false); }} title="Save" style={{ ...miniBtn(dark), background: "#4db892", color: "#fff4de" }}>✓</button>
          </>
        ) : (
          <>
            {!n.pane_id && <button data-testid="pass-ticket-fire" onClick={() => onFirePane(n.project_id)} title="Fire a pane on this ticket" style={{ ...miniBtn(dark), background: "#e23a3a", color: "#fff4de", width: "auto", padding: "0 8px", gap: 4, display: "inline-flex" }}><Icon name="fire" size={11} /><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Fire a pane</span></button>}
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

// ── Journey-expansion C: templates + layouts on The Pass ─────────────────────
// Shared field/chip styling for the inline forms (same palette as the jot input / edit textarea).
function fieldStyle(dark: boolean): CSSProperties {
  return { width: "100%", boxSizing: "border-box", padding: 7, border: "2px solid " + INK, borderRadius: 8, background: dark ? "#1a0f08" : "#fff4de", color: dark ? "#ffe9c7" : INK, fontFamily: "DM Sans", fontSize: 12, fontWeight: 600, outline: "none" };
}
// Slot / pane-id chips — the same mono pill palette as the ticket's #pane jump chip.
function monoChip(dark: boolean): CSSProperties {
  return { display: "inline-flex", alignItems: "center", padding: "1px 6px", borderRadius: 999, border: "1.5px solid " + INK, background: dark ? "#1a0f08" : "#fff4de", color: dark ? "#9be3c0" : "#2f7a5e", fontFamily: "JetBrains Mono", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" };
}
const cardText = (fg: string): CSSProperties => ({ fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, color: fg, lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word" });
const byline: CSSProperties = { fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: "#8a6a4f", textTransform: "uppercase", letterSpacing: ".05em" };

// The Phase-2 two-tap inline 86 (SpecTicket's idiom, reusable): first tap arms "Sure, Chef?",
// auto-resets after 3s; the second tap within the window fires the delete for keeps.
function Confirm86({ dark, title, testId, onConfirm }: { dark: boolean; title: string; testId: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const tap = () => {
    if (!confirming) {
      setConfirming(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    onConfirm();
  };
  return (
    <button data-testid={testId} onClick={tap} data-confirming={confirming || undefined}
      title={confirming ? "This 86 is for keeps — tap again" : title}
      style={confirming
        ? { ...miniBtn(dark), background: "#e23a3a", color: "#fff4de", width: "auto", padding: "0 8px" }
        : { ...miniBtn(dark), color: "#e23a3a" }}>
      {confirming ? <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Sure, Chef?</span> : <Icon name="x" size={12} />}
    </button>
  );
}

// Inline create/edit form for a template (name, optional description, body). Slots are never typed
// in — they're derived from {{slot_name}} placeholders in the body, so the hint is the contract.
function TemplateForm({ dark, initial, testPrefix, onCancel, onSave }: {
  dark: boolean; initial?: { name: string; description: string; body: string }; testPrefix: string;
  onCancel: () => void; onSave: (o: { name: string; body: string; description?: string }) => void;
}) {
  // resolveTemplateInitial removes 6 optional-chain/nullish branches from this function's CC.
  const defaults = resolveTemplateInitial(initial);
  const [name, setName] = useState(defaults.name);
  const [description, setDescription] = useState(defaults.description);
  const [body, setBody] = useState(defaults.body);
  const can = !!name.trim() && !!body.trim();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input data-testid={`${testPrefix}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="template name" autoFocus style={fieldStyle(dark)} />
      <input data-testid={`${testPrefix}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="description (optional)" style={fieldStyle(dark)} />
      <textarea data-testid={`${testPrefix}-body`} value={body} onChange={(e) => setBody(e.target.value)}
        placeholder={"Review the {{branch}} branch focusing on {{focus}}"}
        style={{ ...fieldStyle(dark), resize: "none", minHeight: 72, fontFamily: "JetBrains Mono", fontSize: 12 }} />
      <div style={{ fontFamily: "Caveat, cursive", fontSize: 13.5, color: "#8a6a4f", lineHeight: 1.2 }}>
        {"{{slot_name}} placeholders become fillable parameters"}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={onCancel} title="Cancel" style={miniBtn(dark)}>✕</button>
        <button data-testid={`${testPrefix}-save`} onClick={() => { if (can) onSave({ name: name.trim(), body, description: description.trim() || undefined }); }}
          title={can ? "Save" : "Needs a name and a body"} disabled={!can}
          style={{ ...miniBtn(dark), background: "#4db892", color: "#fff4de", opacity: can ? 1 : 0.5, cursor: can ? "pointer" : "not-allowed" }}>✓</button>
      </div>
    </div>
  );
}

// The Apply flow: pick a station (active pane pre-selected), fill one input per slot, fire. The
// instantiated text lands on that pane's EXISTING draft surface (the burner's Order Pad) — this
// form never shows the result, it only fills the draft for review there.
function TemplateApplyForm({ t, dark, stations, activePaneId, onCancel, onApply }: {
  t: TemplateView; dark: boolean; stations: Station[]; activePaneId: string | null;
  onCancel: () => void; onApply: (paneId: string, values: { name: string; value: string }[]) => void;
}) {
  const [paneId, setPaneId] = useState<string>(
    activePaneId && stations.some((s) => s.id === activePaneId) ? activePaneId : (stations[0]?.id ?? ""),
  );
  const [vals, setVals] = useState<Record<string, string>>({});
  const can = !!paneId;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {stations.length === 0 ? (
        <div style={{ fontFamily: "Caveat, cursive", fontSize: 14, color: "#8a6a4f" }}>no stations on the line — fire one up first</div>
      ) : (
        <select data-testid="pass-template-apply-station" value={paneId} onChange={(e) => setPaneId(e.target.value)} style={fieldStyle(dark)}>
          {stations.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.projectName})</option>)}
        </select>
      )}
      {t.slots.map((slot) => (
        <input key={slot} data-testid={`pass-template-slot-${slot}`} value={vals[slot] ?? ""}
          onChange={(e) => setVals((v) => ({ ...v, [slot]: e.target.value }))} placeholder={slot}
          style={{ ...fieldStyle(dark), fontFamily: "JetBrains Mono", fontSize: 12 }} />
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={onCancel} title="Cancel" style={miniBtn(dark)}>✕</button>
        <button data-testid="pass-template-apply-fire" disabled={!can}
          onClick={() => { if (can) onApply(paneId, t.slots.map((name) => ({ name, value: vals[name] ?? "" }))); }}
          title={can ? "Fill that station's draft (you review and send it there)" : "Pick a station first"}
          style={{ ...miniBtn(dark), background: "#4db892", color: INK, width: "auto", padding: "0 8px", gap: 4, display: "inline-flex", opacity: can ? 1 : 0.5, cursor: can ? "pointer" : "not-allowed" }}>
          <Icon name="ticket" size={11} /><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Fill the draft</span>
        </button>
      </div>
    </div>
  );
}

// One saved prompt template as a pass card: name, description, derived slot chips; inline edit;
// the Apply flow above; two-tap 86. Every field is real (GET /api/templates / templates_updated).
function TemplateTicket({ t, dark, stations, activePaneId, onUpdate, onDelete, onApply }: {
  t: TemplateView; dark: boolean; stations: Station[]; activePaneId: string | null;
  onUpdate: (id: string, o: { name: string; body: string; description?: string }) => void;
  onDelete: (id: string) => void;
  onApply: (id: string, paneId: string, values: { name: string; value: string }[]) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "apply">("view");
  const fg = dark ? "#ffe9c7" : INK;
  return (
    <div data-testid="pass-template" data-template-id={t.id}
      style={{ width: 230, flexShrink: 0, padding: 11, border: "2px solid " + INK, borderRadius: 11, background: dark ? "#0f2418" : "#e9f6ee", boxShadow: "2px 2px 0 0 " + INK, display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Chip bg="#4db892" color={INK}>🧾 template</Chip>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>{t.slots.length ? `${t.slots.length} slot${t.slots.length === 1 ? "" : "s"}` : "no slots"}</span>
      </div>
      {mode === "edit" ? (
        <TemplateForm dark={dark} initial={{ name: t.name, description: t.description ?? "", body: t.body }} testPrefix="pass-template-edit"
          onCancel={() => setMode("view")} onSave={(o) => { onUpdate(t.id, o); setMode("view"); }} />
      ) : (
        <>
          <div style={cardText(fg)}>{t.name}</div>
          {!!t.description && <div style={{ ...cardText("#8a6a4f"), fontSize: 12 }}>{t.description}</div>}
          {t.slots.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {t.slots.map((s) => <span key={s} style={monoChip(dark)}>{`{{${s}}}`}</span>)}
            </div>
          )}
          {mode === "apply" ? (
            <TemplateApplyForm t={t} dark={dark} stations={stations} activePaneId={activePaneId}
              onCancel={() => setMode("view")} onApply={(paneId, values) => { onApply(t.id, paneId, values); setMode("view"); }} />
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={byline}>— the cookbook</span>
              <div style={{ flex: 1 }} />
              <button data-testid="pass-template-apply" onClick={() => setMode("apply")} title="Fill a station's draft from this template"
                style={{ ...miniBtn(dark), background: "#4db892", color: INK, width: "auto", padding: "0 8px", gap: 4, display: "inline-flex" }}>
                <Icon name="ticket" size={11} /><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Apply</span>
              </button>
              <button data-testid="pass-template-edit-btn" onClick={() => setMode("edit")} title="Amend the template" style={miniBtn(dark)}><Icon name="ticket" size={12} /></button>
              <Confirm86 dark={dark} title="86 this template" testId="pass-template-delete" onConfirm={() => onDelete(t.id)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// The "new template" affordance — a ghost card that blooms into the inline form.
function NewTemplateCard({ dark, onCreate }: { dark: boolean; onCreate: (o: { name: string; body: string; description?: string }) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="pass-template-new" style={{ width: 230, flexShrink: 0, padding: 11, border: `2px dashed ${INK}88`, borderRadius: 11, display: "flex", flexDirection: "column", gap: 7, justifyContent: open ? "flex-start" : "center", alignItems: open ? "stretch" : "center" }}>
      {open ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Chip bg="#4db892" color={INK}>🧾 template</Chip></div>
          <TemplateForm dark={dark} testPrefix="pass-template-create" onCancel={() => setOpen(false)} onSave={(o) => { onCreate(o); setOpen(false); }} />
        </>
      ) : (
        <Button testId="pass-template-add" variant="ghost" size="sm" icon="plus" onClick={() => setOpen(true)}>New template</Button>
      )}
    </div>
  );
}

// One saved pane layout as a pass card: name, source kitchen, pane-id chips; Apply rides the same
// gates as a recipe (the 200 narration / 403 reason surfaces in the toast); two-tap 86.
function LayoutTicket({ l, dark, onApply, onDelete }: {
  l: PaneLayout; dark: boolean; onApply: (id: string) => void; onDelete: (id: string) => void;
}) {
  const fg = dark ? "#ffe9c7" : INK;
  const panes = Array.isArray(l.panes) ? l.panes : [];
  return (
    <div data-testid="pass-layout" data-layout-id={l.id}
      style={{ width: 230, flexShrink: 0, padding: 11, border: "2px solid " + INK, borderRadius: 11, background: dark ? "#2b1c0a" : "#fff0dc", boxShadow: "2px 2px 0 0 " + INK, display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Chip bg="#ff8a3d" color={INK}>🗺 layout</Chip>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>{panes.length} pane{panes.length === 1 ? "" : "s"}</span>
      </div>
      <div style={cardText(fg)}>{l.name}</div>
      {!!l.sourceProjectId && <div style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>from {l.sourceProjectId}</div>}
      {panes.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {panes.map((p) => <span key={p.id} style={monoChip(dark)}>#{p.id}</span>)}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={byline}>— mise en place</span>
        <div style={{ flex: 1 }} />
        <button data-testid="pass-layout-apply" onClick={() => onApply(l.id)}
          title="Set these stations back up (gated like a recipe — may need your ok)"
          style={{ ...miniBtn(dark), background: "#e23a3a", color: "#fff4de", width: "auto", padding: "0 8px", gap: 4, display: "inline-flex" }}>
          <Icon name="fire" size={11} /><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Set it up</span>
        </button>
        <Confirm86 dark={dark} title="86 this layout" testId="pass-layout-delete" onConfirm={() => onDelete(l.id)} />
      </div>
    </div>
  );
}

// ── Voice macros (8fz.6): a self-contained management panel on The Pass ────────
// Macros are REST/UI-authored ONLY (voice can FIRE them but never DEFINE/MODIFY — operator decision
// 2026-07-06). This section owns its own data: it fetches GET /api/macros on mount and re-reads after
// each mutation (no parent prop plumbing — the panel is self-sufficient). Each macro is a phrase that
// fans out to an ordered group of per-pane steps; firing stages one pending approval per step.

/** The macro projection GET /api/macros returns (snake_case steps, mirroring the REST body). */
interface SavedMacroStep { pane_name: string; instruction: string }
interface SavedMacro { id: string; phrase: string; name: string; steps: SavedMacroStep[]; created_at: number; updated_at: number }

/** One saved macro as a pass card: phrase, name, ordered per-pane step chips; two-tap 86. */
function MacroTicket({ m, dark, onDelete }: { m: SavedMacro; dark: boolean; onDelete: (id: string) => void }) {
  const fg = dark ? "#ffe9c7" : INK;
  const steps = Array.isArray(m.steps) ? m.steps : [];
  return (
    <div data-testid="pass-macro" data-macro-id={m.id}
      style={{ width: 230, flexShrink: 0, padding: 11, border: "2px solid " + INK, borderRadius: 11, background: dark ? "#2b1c0a" : "#fff0dc", boxShadow: "2px 2px 0 0 " + INK, display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Chip bg="#b36ae0" color={INK}>🎙 macro</Chip>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>{steps.length} step{pluralSuffix(steps.length)}</span>
      </div>
      <div style={cardText(fg)}>{m.name}</div>
      <div style={{ fontFamily: "Caveat, cursive", fontSize: 14, color: "#8a6a4f", lineHeight: 1.2 }}>say “{m.phrase}”</div>
      {steps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={monoChip(dark)}>#{s.pane_name}</span>
              <span style={{ ...cardText(fg), fontSize: 12, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.instruction}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={byline}>— voice macro</span>
        <div style={{ flex: 1 }} />
        <Confirm86 dark={dark} title="86 this macro" testId="pass-macro-delete" onConfirm={() => onDelete(m.id)} />
      </div>
    </div>
  );
}

/** The "new macro" ghost card: name + phrase + an editable ordered step list. Surfaces the server's
 *  403 reason (a phrase that would shadow a voice approval / a reserved command is refused). */
function NewMacroCard({ dark, onCreate }: {
  dark: boolean; onCreate: (o: { name: string; phrase: string; steps: SavedMacroStep[] }, onErr: (msg: string) => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phrase, setPhrase] = useState("");
  const [steps, setSteps] = useState<SavedMacroStep[]>([{ pane_name: "", instruction: "" }]);
  const [err, setErr] = useState("");
  const setStep = (i: number, patch: Partial<SavedMacroStep>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const cleanSteps = steps.map((s) => ({ pane_name: s.pane_name.trim(), instruction: s.instruction.trim() })).filter((s) => s.pane_name && s.instruction);
  const can = !!name.trim() && !!phrase.trim() && cleanSteps.length > 0;
  const reset = () => { setName(""); setPhrase(""); setSteps([{ pane_name: "", instruction: "" }]); setErr(""); setOpen(false); };
  const save = () => { if (can) onCreate({ name: name.trim(), phrase: phrase.trim(), steps: cleanSteps }, setErr); };
  if (!open) {
    return (
      <div data-testid="pass-macro-new" style={{ width: 230, flexShrink: 0, padding: 11, border: `2px dashed ${INK}88`, borderRadius: 11, display: "flex", flexDirection: "column", gap: 7, justifyContent: "center", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Chip bg="#b36ae0" color={INK}>🎙 macro</Chip></div>
        <Button testId="pass-macro-add" variant="ghost" size="sm" icon="plus" onClick={() => setOpen(true)}>New macro</Button>
      </div>
    );
  }
  return (
    <div data-testid="pass-macro-new" style={{ width: 230, flexShrink: 0, padding: 11, border: `2px dashed ${INK}88`, borderRadius: 11, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Chip bg="#b36ae0" color={INK}>🎙 macro</Chip></div>
      <input data-testid="pass-macro-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="macro name" autoFocus style={fieldStyle(dark)} />
      <input data-testid="pass-macro-phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="spoken phrase (e.g. morning rounds)" style={fieldStyle(dark)} />
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 4 }}>
          <input data-testid={`pass-macro-step-pane-${i}`} value={s.pane_name} onChange={(e) => setStep(i, { pane_name: e.target.value })} placeholder="pane" style={{ ...fieldStyle(dark), width: 80 }} />
          <input data-testid={`pass-macro-step-instr-${i}`} value={s.instruction} onChange={(e) => setStep(i, { instruction: e.target.value })} placeholder="instruction" style={fieldStyle(dark)} />
        </div>
      ))}
      <button data-testid="pass-macro-add-step" onClick={() => setSteps((p) => [...p, { pane_name: "", instruction: "" }])} style={{ ...miniBtn(dark), width: "auto", padding: "0 8px", alignSelf: "flex-start" }}>+ step</button>
      {!!err && <div data-testid="pass-macro-error" style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: "#e23a3a", lineHeight: 1.2 }}>{err}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={reset} title="Cancel" style={miniBtn(dark)}>✕</button>
        <button data-testid="pass-macro-save" onClick={save} disabled={!can} title={can ? "Save" : "Needs a name, a phrase, and at least one full step"}
          style={{ ...miniBtn(dark), background: "#b36ae0", color: "#fff4de", opacity: can ? 1 : 0.5, cursor: can ? "pointer" : "not-allowed" }}>✓</button>
      </div>
    </div>
  );
}

/** The self-fetching macros section rendered inline on The Pass (cards + the expanded creator card). */
function MacrosSection({ dark, expanded }: { dark: boolean; expanded: boolean }) {
  const [macros, setMacros] = useState<SavedMacro[]>([]);
  const load = (): void => {
    apiFetch("/api/macros")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setMacros(Array.isArray(d) ? (d as SavedMacro[]) : []))
      .catch(() => { /* a management-panel read failure is non-fatal */ });
  };
  useEffect(() => {
    let alive = true;
    apiFetch("/api/macros")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (alive) setMacros(Array.isArray(d) ? (d as SavedMacro[]) : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const remove = (id: string): void => {
    apiFetch(`/api/macros/${id}`, { method: "DELETE" }).then(() => load()).catch(() => {});
  };
  const create = (o: { name: string; phrase: string; steps: SavedMacroStep[] }, onErr: (msg: string) => void): void => {
    apiFetch("/api/macros", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) })
      .then(async (r) => {
        if (r.ok) { load(); return; }
        const body = await r.json().catch(() => ({}));
        onErr((body as { error?: string }).error ?? `Could not save macro (HTTP ${r.status}).`);
      })
      .catch(() => onErr("Could not reach the server."));
  };
  return (
    <>
      {macros.map((m) => <Fragment key={m.id}><MacroTicket m={m} dark={dark} onDelete={remove} /></Fragment>)}
      {expanded && <NewMacroCard dark={dark} onCreate={create} />}
    </>
  );
}

// "Save current setup as layout" — a ghost card with a name input; the server snapshots the active
// kitchen's live stations (POST /api/layouts {name}).
function SaveLayoutCard({ dark, onSave }: { dark: boolean; onSave: (name: string) => void }) {
  const [name, setName] = useState("");
  const fire = () => { if (name.trim()) { onSave(name.trim()); setName(""); } };
  return (
    <div data-testid="pass-layout-new" style={{ width: 230, flexShrink: 0, padding: 11, border: `2px dashed ${INK}88`, borderRadius: 11, display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Chip bg="#ff8a3d" color={INK}>🗺 layout</Chip></div>
      <div style={{ fontFamily: "Caveat, cursive", fontSize: 13.5, color: "#8a6a4f", lineHeight: 1.2 }}>snapshot the live stations as a re-fireable setup</div>
      <input data-testid="pass-layout-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") fire(); }}
        placeholder="layout name" style={fieldStyle(dark)} />
      <Button testId="pass-layout-save" variant="butter" size="sm" icon="plus" disabled={!name.trim()} onClick={fire}>Save current setup</Button>
    </div>
  );
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
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>{done}/{steps.length} steps</span>
      </div>
      <div style={{ fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, color: fg, lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.name}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: "#8a6a4f", textTransform: "uppercase", letterSpacing: ".05em" }}>— Chef de Cuisine</span>
        <div style={{ flex: 1 }} />
        <button data-testid="pass-spec-fire" onClick={() => onExecute(p.id)}
          title={p.status === "running" ? "Already firing — re-fire step 1" : "Fire this spec (step 1 runs through the gate)"}
          style={{ ...miniBtn(dark), background: "#e23a3a", color: "#fff4de", width: "auto", padding: "0 8px", gap: 4, display: "inline-flex" }}>
          <Icon name="fire" size={11} /><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Fire it</span>
        </button>
        <button data-testid="pass-spec-delete" onClick={on86} data-confirming={confirming || undefined}
          title={confirming ? "This 86 is for keeps — tap again" : "86 this spec"}
          style={confirming
            ? { ...miniBtn(dark), background: "#e23a3a", color: "#fff4de", width: "auto", padding: "0 8px" }
            : { ...miniBtn(dark), color: "#e23a3a" }}>
          {confirming ? <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Sure, Chef?</span> : <Icon name="x" size={12} />}
        </button>
      </div>
    </div>
  );
}

/** One row of exclusive filter chips (type/author/date share this shape). Generic over the filter's
 *  literal-union id type so all three chip rows reuse one small component. */
function FilterChipRow<F extends string>({ dark, prefix, options, value, onChange }: {
  dark: boolean; prefix: string; options: Array<{ id: F; label: string; emoji?: string }>; value: F; onChange: (v: F) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={o.id} data-testid={`pass-filter-${prefix}-${o.id}`} data-active={value === o.id || undefined}
          onClick={() => onChange(o.id)}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 999, border: "1.5px solid " + INK, cursor: "pointer",
            background: value === o.id ? (dark ? "#1a0f08" : "#fff9ec") : "transparent", color: dark ? "#ffe9c7" : INK,
            fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, opacity: value === o.id ? 1 : 0.6 }}>
          {o.emoji ? `${o.emoji} ${o.label}` : o.label}
        </button>
      ))}
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

// ── D2: the Attention inbox tab ───────────────────────────────────────────────
// One alert row: a per-type chip, the message, and act buttons driven by attentionActKind
// (approve+deny / restart / jump), plus an always-present Dismiss. Every field is real
// (AttentionItem from GET /api/attention + attention_updated frames).
const ATTN_CHIP: Record<string, { emoji: string; label: string; bg: string }> = {
  error:          { emoji: "🔥", label: "error",     bg: "#e23a3a" },
  "build-failed": { emoji: "🧱", label: "build",     bg: "#e23a3a" },
  exited:         { emoji: "💀", label: "exited",    bg: "#a14b4b" },
  approval:       { emoji: "🛎", label: "approval",  bg: "#ff8a3d" },
  confirmation:   { emoji: "🛎", label: "confirm",   bg: "#ff8a3d" },
  idle:           { emoji: "✅", label: "done",      bg: "#4db892" },
};
export function attnChip(type: string): { emoji: string; label: string; bg: string } {
  return ATTN_CHIP[type] ?? { emoji: "📌", label: type || "alert", bg: "#8a6a4f" };
}

function AttentionRow({ item, dark, onApprove, onDeny, onRestart, onJump, onDismiss }: {
  item: AttentionItem; dark: boolean;
  onApprove: (item: AttentionItem) => void; onDeny: (item: AttentionItem) => void;
  onRestart: (terminalId: string) => void; onJump: (terminalId: string) => void; onDismiss: (id: string) => void;
}) {
  const fg = dark ? "#ffe9c7" : INK;
  const c = attnChip(item.type);
  const act = attentionActKind(item);
  // The per-act button set — each arm owns a tiny slice of JSX so the row stays under the gate.
  function renderActs(): ReactNode {
    // bead e7h: a HELD gated request (messageId present) — real Approve/Deny that resolve it through
    // the SAME POST /api/commands/approve resolver voice uses. The parent (onApprove/onDeny) reads
    // item.messageId and calls approveCommand/rejectCommand.
    if (act === "approve") {
      return (
        <>
          <button data-testid="attn-approve" onClick={() => onApprove(item)} title="Approve this — let it run" style={{ ...miniBtn(dark), background: "#4db892", color: "#fff4de", width: "auto", padding: "0 8px" }}><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Approve</span></button>
          <button data-testid="attn-deny" onClick={() => onDeny(item)} title="Deny this — hold it back" style={{ ...miniBtn(dark), color: "#e23a3a", width: "auto", padding: "0 8px" }}><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Deny</span></button>
        </>
      );
    }
    // A triage-only suggestion (no held request): "Open" the station + "Dismiss" the alert. Honest —
    // it never claims to resolve a gate, because there is none to resolve.
    if (act === "open") {
      return (
        <button data-testid="attn-open" onClick={() => onApprove(item)} title="Go to the station" style={{ ...miniBtn(dark), background: "#4db892", color: "#fff4de", width: "auto", padding: "0 8px" }}><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Open</span></button>
      );
    }
    if (act === "restart") {
      return (
        <button data-testid="attn-restart" onClick={() => onRestart(item.terminalId)} title="Re-fire this station" style={{ ...miniBtn(dark), background: "#e23a3a", color: "#fff4de", width: "auto", padding: "0 8px", gap: 4, display: "inline-flex" }}><Icon name="fire" size={11} /><span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12 }}>Re-fire</span></button>
      );
    }
    return (
      <button data-testid="attn-jump" onClick={() => onJump(item.terminalId)} title="Jump to this station" style={{ ...monoChip(dark), cursor: "pointer", padding: "2px 8px" }}>#{item.terminalId} ›</button>
    );
  }
  return (
    <div data-testid="attn-row" data-attn-id={item.id} data-attn-act={act}
      style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", border: "2px solid " + INK, borderRadius: 10, background: dark ? "#241409" : "#fff9ec", boxShadow: "2px 2px 0 0 " + INK }}>
      <Chip bg={c.bg} color={c.bg === "#d4a15a" ? INK : "#fff4de"}>{c.emoji} {c.label}</Chip>
      <div style={{ flex: 1, minWidth: 0, fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, color: fg, lineHeight: 1.3, wordBreak: "break-word" }}>{item.message}</div>
      {renderActs()}
      <button data-testid="attn-dismiss" onClick={() => onDismiss(item.id)} title="Clear this alert" style={miniBtn(dark)}><Icon name="x" size={12} /></button>
    </div>
  );
}

function AttentionTab({ items, dark, onApprove, onDeny, onRestart, onJump, onDismiss }: {
  items: AttentionItem[]; dark: boolean;
  onApprove: (item: AttentionItem) => void; onDeny: (item: AttentionItem) => void;
  onRestart: (terminalId: string) => void; onJump: (terminalId: string) => void; onDismiss: (id: string) => void;
}) {
  // Only undismissed items reach the operator — a dismissed item is gone from "what needs me".
  const live = items.filter((i) => !i.dismissed);
  if (live.length === 0) {
    return <div data-testid="attn-empty" style={{ padding: "10px 16px 14px", fontFamily: "Caveat, cursive", fontSize: 16, color: "#8a6a4f" }}>nothin' needs you right now — clean board, Chef 😌</div>;
  }
  return (
    <div data-testid="attn-list" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "2px 16px 14px" }}>
      {live.map((it) => (
        <Fragment key={it.id}>
          <AttentionRow item={it} dark={dark}
            onApprove={onApprove} onDeny={onDeny} onRestart={onRestart} onJump={onJump} onDismiss={onDismiss} />
        </Fragment>
      ))}
    </div>
  );
}

export function ThePass({ notes, plans, templates, layouts, attention, stations, activePaneId, jotProjectId, jotProjectName, dark, voiceCues, onAdd, onEdit, onDelete, onFirePane, onJumpToPane, onExecutePlan, onDeletePlan, onCreateTemplate, onUpdateTemplate, onDeleteTemplate, onApplyTemplate, onSaveLayout, onApplyLayout, onDeleteLayout, onApproveAttention, onDenyAttention, onRestartAttention, onDismissAttention }: {
  notes: StoredNote[]; jotProjectId: string | null; jotProjectName: string; dark: boolean; voiceCues: boolean;
  /** 4U.1: voice-built orchestrator plans, surfaced as spec tickets. */
  plans: Plan[];
  /** Journey-expansion C: the cookbook (GET /api/templates) + mise en place (GET /api/layouts). */
  templates: TemplateView[];
  layouts: PaneLayout[];
  /** D2: the attention/"what needs me" inbox (GET /api/attention + attention_updated frames). */
  attention: AttentionItem[];
  /** The live board, for the Apply flow's station picker (the active pane pre-selects). */
  stations: Station[];
  activePaneId: string | null;
  onAdd: (projectId: string, text: string) => void; onEdit: (id: string, text: string) => void; onDelete: (id: string) => void;
  onFirePane: (projectId: string) => void; onJumpToPane: (paneId: string) => void;
  onExecutePlan: (planId: string) => void; onDeletePlan: (planId: string) => void;
  onCreateTemplate: (o: { name: string; body: string; description?: string }) => void;
  onUpdateTemplate: (id: string, o: { name: string; body: string; description?: string }) => void;
  onDeleteTemplate: (id: string) => void;
  onApplyTemplate: (id: string, paneId: string, values: { name: string; value: string }[]) => void;
  onSaveLayout: (name: string) => void;
  onApplyLayout: (id: string) => void;
  onDeleteLayout: (id: string) => void;
  /** D2: attention act callbacks. approve/deny take the whole item (the parent resolves the underlying
   *  gate decision / station); restart + dismiss take the terminalId / item id. */
  onApproveAttention: (item: AttentionItem) => void; onDenyAttention: (item: AttentionItem) => void;
  onRestartAttention: (terminalId: string) => void; onDismissAttention: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [jar, setJar] = useState(false);
  // D2: which view the pass shows. "tickets" = the classic strip; "attention" = the what-needs-me inbox.
  const [tab, setTab] = useState<"tickets" | "attention">("tickets");
  // hwu.5: the three ticket filter chips (type/author/date) — pure client-side narrowing of `notes`.
  const [typeFilter, setTypeFilter] = useState<NoteTypeFilter>("all");
  const [authorFilter, setAuthorFilter] = useState<NoteAuthorFilter>("all");
  const [dateFilter, setDateFilter] = useState<NoteDateFilter>("all");
  const filteredNotes = filterNotes(notes, { type: typeFilter, author: authorFilter, date: dateFilter });
  const canJot = !!jotProjectId && jotProjectId !== "all";
  const fg = dark ? "#ffe9c7" : INK;
  const empty = notes.length === 0 && plans.length === 0 && templates.length === 0 && layouts.length === 0;
  // The inbox count drives the tab badge; only undismissed items are "what needs me".
  const attnCount = attention.filter((i) => !i.dismissed).length;
  // bead 8xn: of those, how many are HELD APPROVALS (a real Approve/Deny waiting on a messageId) —
  // distinct from triage. This is the always-on "a pane is silently blocked" safeguard, styled apart
  // from the generic attention total below.
  const approvalCount = pendingApprovalBadgeCount(attention);

  // Inline render helpers — each owns its own CC budget so ThePass stays ≤10.

  function renderTabToggle(): ReactNode {
    const tabBtn = (id: "tickets" | "attention", label: string): ReactNode => (
      <button data-testid={`pass-tab-${id}`} data-active={tab === id || undefined} onClick={() => setTab(id)}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 11px", borderRadius: 999, border: "2px solid " + INK, cursor: "pointer",
          background: tab === id ? (dark ? "#1a0f08" : "#fff9ec") : "transparent", color: id === "attention" && attnCount > 0 ? "#e23a3a" : fg, fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, opacity: tab === id ? 1 : 0.6 }}>
        {label}
      </button>
    );
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 16px 8px" }}>
        {tabBtn("tickets", "Tickets")}
        {tabBtn("attention", attentionTabLabel(attnCount))}
        {/* bead 8xn: the held-approval badge — distinct styling (a 🛎 pill) so a silently-blocked pane
            is always visible, separate from generic triage. Renders only when something is held. */}
        {approvalCount > 0 && (
          <span data-testid="pass-approval-badge" data-approval-count={approvalCount}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 999, border: "2px solid " + INK, background: "#ff8a3d", color: INK, fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, flexShrink: 0 }}>
            🛎 {approvalCount} need{approvalCount === 1 ? "s" : ""} approval
          </span>
        )}
      </div>
    );
  }

  // Extracted out of renderPassBar to keep its complexity under the gate — a single-purpose button
  // whose disabled-ness mirrors the jot input's canJot gate (no kitchen picked -> nothing to export).
  function renderExportButton(): ReactNode {
    return (
      <button data-testid="pass-export" disabled={!canJot} onClick={() => canJot && jotProjectId && downloadProjectExport(jotProjectId)}
        title={canJot ? "Download a Markdown export of this kitchen (notes/panes/history/plans)" : "pick a kitchen to export"}
        style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 10px", borderRadius: 9, border: "2px solid " + INK, background: dark ? "#1a0f08" : "#fff9ec", color: fg, cursor: canJot ? "pointer" : "not-allowed", opacity: canJot ? 1 : 0.5, fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, flexShrink: 0 }}>⬇ export</button>
    );
  }

  function renderPassBar(): ReactNode {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 16px" }}>
        <button data-testid="pass-expand" onClick={() => setExpanded((e) => !e)} title={expanded ? "fold up" : "blow out the pass"}
          style={{ display: "flex", alignItems: "center", gap: 7, border: "none", background: "transparent", cursor: "pointer", color: fg }}>
          <span style={{ fontSize: 17 }}>🎫</span>
          <span style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 17 }}>The Pass</span>
          <Chip bg="#e23a3a" color="#fff4de">{notes.length}</Chip>
          {plans.length > 0 && <Chip bg="#4b3bb3" color="#fff4de">{plans.length} spec{pluralSuffix(plans.length)}</Chip>}
          {templates.length > 0 && <Chip bg="#4db892" color={INK}>{templates.length} template{pluralSuffix(templates.length)}</Chip>}
          {layouts.length > 0 && <Chip bg="#ff8a3d" color={INK}>{layouts.length} layout{pluralSuffix(layouts.length)}</Chip>}
          <span style={{ fontFamily: "DM Sans", fontSize: 12, color: "#8a6a4f", transform: expanded ? "rotate(180deg)" : "none" }}>▾</span>
        </button>
        {voiceCues && <VoiceCue phrase="what's on the pass?" dark={dark} />}
        <div style={{ flex: 1 }} />
        <JotNote dark={dark} projectName={jotProjectName} disabled={!canJot} onAdd={(t) => jotProjectId && onAdd(jotProjectId, t)} />
        {renderExportButton()}
        <button data-testid="pass-jar" onClick={() => setJar(true)} title="Explore the bead jar" style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 10px", borderRadius: 9, border: "2px solid " + INK, background: dark ? "#1a0f08" : "#fff9ec", color: fg, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, flexShrink: 0 }}>🫙 jar</button>
      </div>
    );
  }

  // hwu.5: the type/author/date filter chip bar — only earns its space when there's at least one
  // note to narrow. Purely client-side (filteredNotes above); nothing here ever refetches.
  function renderNoteFilters(): ReactNode {
    if (notes.length === 0) return null;
    return (
      <div data-testid="pass-filters" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "0 16px 8px" }}>
        <FilterChipRow dark={dark} prefix="type" options={NOTE_TYPE_CHIPS} value={typeFilter} onChange={setTypeFilter} />
        <FilterChipRow dark={dark} prefix="author" options={NOTE_AUTHOR_CHIPS} value={authorFilter} onChange={setAuthorFilter} />
        <FilterChipRow dark={dark} prefix="date" options={NOTE_DATE_CHIPS} value={dateFilter} onChange={setDateFilter} />
        <span data-testid="pass-filter-count" style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>
          {filteredNotes.length} of {notes.length} ticket{pluralSuffix(notes.length)}
        </span>
      </div>
    );
  }

  function renderPassTickets(): ReactNode {
    // Collapsed with nothing on the pass → render nothing.
    if (empty && !expanded) return null;
    return (
      /* the tickets (collapsed = a single scrolling row; expanded = wrap). 4U.1: spec tickets
         (voice-built plans) lead the row — they're the fireable work; notes follow (narrowed by the
         type/author/date filter chips above), then the cookbook (templates) and mise en place
         (layouts). The two ghost creator cards live in the expanded pass only, so the collapsed
         strip stays glanceable. */
      <div style={{ display: "flex", gap: 10, padding: "2px 16px 14px", overflowX: expanded ? "visible" : "auto", flexWrap: expanded ? "wrap" : "nowrap" }}>
        {empty && <div data-testid="pass-empty" style={{ alignSelf: "center", flexShrink: 0, fontFamily: "Caveat, cursive", fontSize: 16, color: "#8a6a4f" }}>nothin' on the pass — clean board, Chef 😌</div>}
        {plans.map((p) => <Fragment key={p.id}><SpecTicket p={p} dark={dark} onExecute={onExecutePlan} onDelete={onDeletePlan} /></Fragment>)}
        {filteredNotes.map((n) => <Fragment key={n.id}><TicketCard n={n} dark={dark} onEdit={onEdit} onDelete={onDelete} onFirePane={onFirePane} onJumpToPane={onJumpToPane} /></Fragment>)}
        {templates.map((t) => <Fragment key={t.id}><TemplateTicket t={t} dark={dark} stations={stations} activePaneId={activePaneId} onUpdate={onUpdateTemplate} onDelete={onDeleteTemplate} onApply={onApplyTemplate} /></Fragment>)}
        {layouts.map((l) => <Fragment key={l.id}><LayoutTicket l={l} dark={dark} onApply={onApplyLayout} onDelete={onDeleteLayout} /></Fragment>)}
        {/* Voice macros (8fz.6): self-fetching REST/UI-authored management panel. */}
        <MacrosSection dark={dark} expanded={expanded} />
        {expanded && <NewTemplateCard dark={dark} onCreate={onCreateTemplate} />}
        {expanded && <SaveLayoutCard dark={dark} onSave={onSaveLayout} />}
      </div>
    );
  }

  // D2: the toggle earns its space when the pass is open OR there's anything in the inbox; the
  // tab decides which body renders below it.
  const showTabs = expanded || attnCount > 0;
  const renderBody = (): ReactNode => {
    if (tab === "attention") {
      return (
        <AttentionTab items={attention} dark={dark}
          onApprove={onApproveAttention} onDeny={onDenyAttention}
          onRestart={onRestartAttention} onJump={onJumpToPane} onDismiss={onDismissAttention} />
      );
    }
    return (
      <>
        {renderNoteFilters()}
        {renderPassTickets()}
      </>
    );
  };

  return (
    <div data-testid="the-pass" style={{ flexShrink: 0, borderBottom: "3px solid " + INK, background: dark ? "#2f1d12" : "#fff4de" }}>
      {/* the bar */}
      {renderPassBar()}

      {/* the tab toggle (tickets | attention) */}
      {showTabs && renderTabToggle()}

      {/* the active tab's body */}
      {renderBody()}

      {jar && <BeadsExplorer dark={dark} onClose={() => setJar(false)} />}
    </div>
  );
}
