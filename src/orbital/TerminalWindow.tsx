// ── ORBITAL · The Burner (TerminalWindow) ───────────────────────────────
// Ported from the design's drawers.jsx TerminalWindow, but the faux `st.tail`
// line list is replaced by the REAL xterm (src/components/TerminalView) wired to
// the live raw-chunk stream (terminalStream) + backfill scrollback. Everything
// here hits the real backend:
//   • live output  — stdout_chunk over the /live?observe=1 socket → publishChunk → xterm
//   • backfill     — Terminal.backfill (raw ANSI) seeds scrollback on open
//   • control keys — POST /api/terminals/:id/raw-input (shared RAW_KEY_TABLE allowlist)
//   • grid resize  — POST /api/terminals/:id/resize (debounced)
//   • restart      — POST /api/terminals/:id/restart
//   • Order Pad    — per-pane WIP draft: GET/PUT /api/panes/:proj/:pane/draft + POST …/draft/send
// The "Notes & beads" tab is an explicit placeholder until The Pass (P7) wires
// notes CRUD — it is visibly disabled, not a fake input.
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { TerminalView } from "../components/TerminalView";
import { apiFetch } from "../utils/api";
import { isE2EWireArmed } from "../e2e/harness";
import { RAW_KEY_TABLE } from "../rawKeyClass";
import { INK, RUNTIMES } from "./theme";
import { Button, Chip, Icon, PostureChip, StatusBadge, VoiceCue } from "./primitives";
import { TICKET_KINDS } from "./theme";
import { useDialog } from "./useFocusTrap";
import type { Station } from "./station";
import type { StoredNote } from "../store/types";
import type { PaneHistoryEntry } from "./useOrbitalData";
// Pure helpers live in a CSS-free sibling module so unit tests can import them
// without triggering the xterm/css load that kills the Node test runner.
export {
  formatHistoryTimestamp,
  buildHistoryOutputText,
  deriveStatusLineText,
  derive86Title,
  derive86ButtonStyle,
  derive86ButtonLabel,
  resolveNoteTicketKey,
} from "./terminalWindowHelpers";
import {
  formatHistoryTimestamp,
  buildHistoryOutputText,
  deriveStatusLineText,
  derive86Title,
  derive86ButtonStyle,
  derive86ButtonLabel,
  resolveNoteTicketKey,
} from "./terminalWindowHelpers";

// The control-key strip. Bytes come straight from the SERVER allowlist (RAW_KEY_TABLE in
// src/rawKeyClass.ts) — importing it (a pure, dep-free table) is the single source of truth, so a
// frontend key can never drift out of the /raw-input allowlist. Nav/Enter/Tab/Esc/paging are always
// allowed; Ctrl+C (emergency brake) is too; Shift+Tab is gated (may 202-defer) → warn tint.
const KEYS: { id: string; bytes: string; label: string; title: string; warn?: boolean }[] = [
  { id: "up", bytes: RAW_KEY_TABLE.up, label: "↑", title: "Send Up arrow" },
  { id: "down", bytes: RAW_KEY_TABLE.down, label: "↓", title: "Send Down arrow" },
  { id: "left", bytes: RAW_KEY_TABLE.left, label: "←", title: "Send Left arrow" },
  { id: "right", bytes: RAW_KEY_TABLE.right, label: "→", title: "Send Right arrow" },
  { id: "enter", bytes: RAW_KEY_TABLE.enter, label: "⏎", title: "Send Enter (commit the staged line)" },
  { id: "tab", bytes: RAW_KEY_TABLE.tab, label: "Tab", title: "Send Tab" },
  { id: "esc", bytes: RAW_KEY_TABLE.esc, label: "Esc", title: "Send Esc (dismiss / cancel)" },
  { id: "pageUp", bytes: RAW_KEY_TABLE.pageUp, label: "PgUp", title: "Send Page Up" },
  { id: "pageDown", bytes: RAW_KEY_TABLE.pageDown, label: "PgDn", title: "Send Page Down" },
  { id: "ctrlc", bytes: RAW_KEY_TABLE.ctrlC, label: "^C", title: "Send Ctrl+C (interrupt / emergency brake)", warn: true },
  { id: "shifttab", bytes: RAW_KEY_TABLE.shiftTab, label: "⇧Tab", title: "Send Shift+Tab (cycle agent mode — gated)", warn: true },
];

function ControlKeyBar({ paneId, dark, onKey }: { paneId: string; dark: boolean; onKey: (paneId: string, bytes: string) => void }) {
  const base: CSSProperties = {
    minWidth: 30, padding: "5px 8px", borderRadius: 7, border: "1.5px solid " + INK, cursor: "pointer",
    fontFamily: "JetBrains Mono, monospace", fontSize: 12, fontWeight: 700, lineHeight: 1,
  };
  return (
    <div data-testid="burner-keys" role="group" aria-label="Send a control key to the pane"
      style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "8px 14px", borderTop: "1px solid #ffffff18", background: "#1a0f08" }}>
      {KEYS.map((k) => (
        <Fragment key={k.id}>
          <button type="button" data-testid={`burner-key-${k.id}`} title={k.title} onClick={() => onKey(paneId, k.bytes)}
            style={{ ...base, background: k.warn ? "#3a1a14" : "#241409", color: k.warn ? "#ff8a3d" : "#e9d9c0", borderColor: k.warn ? "#ff8a3d" : INK }}>
            {k.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

// Per-pane WIP draft — the Order Pad. Fetches the saved draft on open (skipped in mock; the harness
// has no server), persists edits over the observe WS (`draft_edit`) when connected or PUT otherwise,
// and Send fires the real …/draft/send POST. Returns the live text + handlers.
function useDraft(projectId: string, paneId: string, isMockRef: MutableRefObject<boolean>, wsRef: MutableRefObject<WebSocket | null>, incoming?: { text: string; at: number }) {
  const [text, setText] = useState("");
  // 2K.3: the focus-lock (classic App.tsx:1164-1176) — a server-pushed draft must never clobber
  // the operator mid-keystroke. Tracked by the textarea's onFocus/onBlur below.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!paneId || isMockRef.current) { setText(""); return; }
    let cancelled = false;
    apiFetch(`/api/panes/${projectId}/${paneId}/draft`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setText(d.draft?.text ?? ""); })
      .catch(() => { /* pane has no draft yet */ });
    return () => { cancelled = true; };
  }, [projectId, paneId, isMockRef]);

  // 2K.3: mirror incoming draft_updated frames (Janus dictation, another view's edit) into the
  // pad — ONLY while the textarea isn't focused (the classic guard). `at` keys re-application.
  const incomingAt = incoming?.at;
  const incomingText = incoming?.text;
  useEffect(() => {
    if (incomingAt === undefined || typeof incomingText !== "string") return;
    if (focusedRef.current) return; // operator is typing — their keystrokes win
    setText(incomingText);
  }, [incomingAt, incomingText]);

  const onChange = (v: string) => {
    setText(v);
    if (!paneId) return;
    // 3C.3b: under plain ?mock=1 the draft stays client-side; only a Playwright-armed page
    // persists over the wire (the e2e intercepts + asserts the PUT).
    if (isMockRef.current && !isE2EWireArmed()) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "draft_edit", projectId, paneId, text: v }));
    } else {
      apiFetch(`/api/panes/${projectId}/${paneId}/draft`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: v }),
      }).catch(() => { /* best-effort */ });
    }
  };
  const send = async (): Promise<boolean> => {
    if (!text.trim() || !paneId) return false;
    // 3C.3b: same gate — a manual ?mock=1 "send" clears the pad client-side, no real POST.
    if (isMockRef.current && !isE2EWireArmed()) { setText(""); return true; }
    try {
      const r = await apiFetch(`/api/panes/${projectId}/${paneId}/draft/send`, { method: "POST" });
      if (r.ok) { setText(""); return true; }
    } catch { /* pane may have exited */ }
    return false;
  };
  return { text, onChange, send, scrap: () => onChange(""), focusedRef };
}

// 4U.2: the pane's recorded command history — the same raw feed the classic per-pane panel reads
// (GET /api/terminals/:id/history, classic App.tsx:340-351). Fetched on open; a server-pushed
// history_updated frame (mirrored per-pane by useOrbitalData) repaints in place — when the frame
// carries the array we adopt it directly, otherwise we refetch. Under plain ?mock=1 the GET is
// skipped (client-only harness); a Playwright-armed page fires the real wire (3C.3b).
function usePaneHistory(
  paneId: string,
  isMockRef: MutableRefObject<boolean>,
  incoming?: { entries: PaneHistoryEntry[] | null; at: number },
) {
  const [entries, setEntries] = useState<PaneHistoryEntry[]>([]);
  const refetch = useCallback(async () => {
    if (!paneId) return;
    if (isMockRef.current && !isE2EWireArmed()) return;
    try {
      const r = await apiFetch(`/api/terminals/${paneId}/history`);
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d)) setEntries(d);
    } catch { /* pane may have exited — keep what we have */ }
  }, [paneId, isMockRef]);
  useEffect(() => { setEntries([]); refetch(); }, [refetch]);
  const incomingAt = incoming?.at;
  useEffect(() => {
    if (incomingAt === undefined) return;
    if (incoming && Array.isArray(incoming.entries)) setEntries(incoming.entries);
    else refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingAt]);
  return { entries, setEntries };
}

// One history row: command + time, tap to unfold the recorded output (collapsed by default).
function HistoryRow({ e, dark }: { e: PaneHistoryEntry; dark: boolean }) {
  const [open, setOpen] = useState(false);
  const fg = dark ? "#ffe9c7" : INK;
  const when = formatHistoryTimestamp(e.timestamp);
  const outputText = buildHistoryOutputText(e.output, e.finalResponse);
  return (
    <div data-testid="burner-history-entry" style={{ border: "2px solid " + INK, borderRadius: 9, background: dark ? "#241409" : "#fff4de", boxShadow: "2px 2px 0 0 " + INK, overflow: "hidden" }}>
      <button onClick={() => setOpen((o) => !o)} title={open ? "Fold the output back up" : "Peek at what came back"}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", border: "none", background: "transparent", cursor: "pointer", textAlign: "left" }}>
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, fontWeight: 700, color: fg, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.command}</span>
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f", flexShrink: 0 }}>{when}</span>
        <span style={{ fontFamily: "DM Sans", fontSize: 12, color: "#8a6a4f", transform: open ? "rotate(180deg)" : "none", flexShrink: 0 }}>▾</span>
      </button>
      {open && (
        <pre data-testid="burner-history-output" style={{ margin: 0, padding: "8px 10px", borderTop: "1.5px solid " + INK, background: dark ? "#1a0f08" : "#fff9ec", color: dark ? "#e9d9c0" : "#5b3a23", fontFamily: "JetBrains Mono", fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 180, overflowY: "auto" }}>
          {outputText}
        </pre>
      )}
    </div>
  );
}

export function TerminalWindow({ st, backfill, accentHex, dark, isMockRef, wsRef, voiceCues, paneNotes, incomingDraft, incomingHistory, onAddNote, onDeleteNote, onClose, onRestart, onStop, onRename, writeControlKey, resizeTerminal, showToast, streamGeneration, fetchBackfill }: {
  st: Station;
  backfill?: string;
  /** 3C.2b: bumps when the observe socket RE-opens — drives the xterm resync-with-marker. */
  streamGeneration?: number;
  /** 3C.2b: fetch this pane's freshest raw backfill (server truth) for the resync/open rebuild. */
  fetchBackfill?: () => Promise<string | null>;
  accentHex: string;
  dark: boolean;
  isMockRef: MutableRefObject<boolean>;
  wsRef: MutableRefObject<WebSocket | null>;
  voiceCues: boolean;
  paneNotes: StoredNote[];
  /** 2K.3: the latest server-pushed draft for this pane (applied only while the pad isn't focused). */
  incomingDraft?: { text: string; at: number };
  /** 4U.2: the latest server-pushed history for this pane (history_updated; entries null = refetch). */
  incomingHistory?: { entries: PaneHistoryEntry[] | null; at: number };
  onAddNote: (text: string) => void;
  onDeleteNote: (id: string) => void;
  onClose: () => void;
  onRestart: () => void;
  /** 2K.1: "86 this station" — graceful stop + archive (recoverable). */
  onStop: () => void;
  /** 2K.1: rename the station (PUT …/rename). */
  onRename: (name: string) => void;
  writeControlKey: (paneId: string, bytes: string) => void;
  resizeTerminal: (paneId: string, cols: number, rows: number) => void;
  showToast: (msg: string, kind?: "fire" | "warn") => void;
}) {
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"pad" | "notes" | "history">("pad");
  // 2K.1: inline rename + a one-tap inline confirm for 86 (an Exited pane skips the confirm).
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(st.name);
  const [confirm86, setConfirm86] = useState(false);
  const confirm86Timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (confirm86Timer.current) clearTimeout(confirm86Timer.current); }, []);
  // 4U.2: the ticket history (recorded commands) + the two-tap confirm for the destructive clear.
  const history = usePaneHistory(st.id, isMockRef, incomingHistory);
  const [confirmClear, setConfirmClear] = useState(false);
  const confirmClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (confirmClearTimer.current) clearTimeout(confirmClearTimer.current); }, []);
  const onClearHistory = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      if (confirmClearTimer.current) clearTimeout(confirmClearTimer.current);
      confirmClearTimer.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    // Under plain ?mock=1 the wire stays client-side (3C.3b); armed pages fire the real POST.
    if (isMockRef.current && !isE2EWireArmed()) { history.setEntries([]); showToast("Ticket history wiped"); return; }
    try {
      const r = await apiFetch(`/api/terminals/${st.id}/history/clear`, { method: "POST" });
      if (r.ok) { history.setEntries([]); showToast("Ticket history wiped"); return; }
      // Honest failure: the server refuses while stop-all is frozen (clear_history checks the
      // brake itself) — surface ITS reason, e.g. "Stop-all is engaged — release it first."
      const d = await r.json().catch(() => ({} as { error?: unknown }));
      showToast(typeof d.error === "string" && d.error ? d.error : "Couldn't wipe the history, Chef — try again.", "warn");
    } catch { showToast("Couldn't wipe the history, Chef — try again.", "warn"); }
  };
  const rt = RUNTIMES[st.toolPreset] || RUNTIMES.Custom;
  const live = st.status === "Running";
  const fg = dark ? "#ffe9c7" : INK;
  const draft = useDraft(st.project || "default_project", st.id, isMockRef, wsRef, incomingDraft);
  // 2K.5: shared dialog semantics — initial focus, focus trap, Escape closes (top-most only).
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  const onSend = async () => {
    const ok = await draft.send();
    showToast(ok ? "Sent to the line 🔥" : "Nothing to send", ok ? "fire" : "warn");
  };

  // Guard against the Enter→blur double-fire (Enter commits, then the input unmounts and its
  // blur would commit again) — one commit per edit session.
  const renameDone = useRef(false);
  const commitRename = () => {
    if (renameDone.current) return;
    renameDone.current = true;
    const n = nameDraft.trim();
    setRenaming(false);
    if (n && n !== st.name) onRename(n);
  };

  const on86 = () => {
    // An Exited pane has nothing left to kill — 86 it without ceremony. A live one confirms once.
    if (st.status !== "Exited" && !confirm86) {
      setConfirm86(true);
      if (confirm86Timer.current) clearTimeout(confirm86Timer.current);
      confirm86Timer.current = setTimeout(() => setConfirm86(false), 3000);
      return;
    }
    setConfirm86(false);
    onStop();
  };

  // Inline render-helper: the title-bar name section (renaming toggle).
  // NOT a React component — called directly in JSX, no new fiber identity.
  const renderTitleBarNameSection = () => {
    if (renaming) {
      return (
        <input data-testid="burner-rename-input" autoFocus value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { e.stopPropagation(); renameDone.current = true; setNameDraft(st.name); setRenaming(false); }
          }}
          onBlur={commitRename}
          aria-label="Rename this station"
          style={{ width: "min(360px, 90%)", padding: "3px 8px", border: "2px solid " + INK, borderRadius: 8, background: "#fff9ec", color: INK, fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 16, textAlign: "center", outline: "none" }} />
      );
    }
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, minWidth: 0 }}>
        <span style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 18, color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{st.name}</span>
        <button data-testid="burner-rename" onClick={() => { renameDone.current = false; setNameDraft(st.name); setRenaming(true); }} title="Rename this station" aria-label="Rename this station"
          style={{ display: "grid", placeItems: "center", width: 22, height: 22, padding: 0, borderRadius: 6, border: "1.5px solid " + INK, background: "#fff4de", color: INK, cursor: "pointer", flexShrink: 0 }}>
          <Icon name="ticket" size={11} />
        </button>
      </div>
    );
  };

  // Inline render-helper: the terminal status dot + label bar.
  const renderTerminalStatusBar = () => (
    <div style={{ padding: "7px 14px", borderBottom: "1px solid #ffffff18", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: live ? "#9be3c0" : "#8a6a4f", animation: live ? "orb-pulse 1s var(--ease-bounce) infinite" : "none" }} />
      <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#c89f74", textTransform: "uppercase", letterSpacing: ".08em" }}>
        {deriveStatusLineText(st.status, live)}
      </span>
      <div style={{ flex: 1 }} />
      <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>{rt.burner} station</span>
    </div>
  );

  // Inline render-helper: the Order Pad tab content.
  const renderPadTab = () => (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 14, background: dark ? "#2f1d12" : "#fff9ec" }}>
      <textarea data-testid="burner-draft" value={draft.text} onChange={(e) => draft.onChange(e.target.value)}
        onFocus={() => { draft.focusedRef.current = true; }}
        onBlur={() => { draft.focusedRef.current = false; }}
        placeholder={`Write the next order for ${st.name}, or dictate it to the Chef…`}
        style={{ flex: 1, minHeight: 120, resize: "none", padding: 12, border: "2px solid " + INK, borderRadius: 10, background: dark ? "#241409" : "#fff4de", color: fg, fontFamily: "DM Sans", fontSize: 13.5, fontWeight: 600, lineHeight: 1.5, outline: "none", boxShadow: "inset 2px 2px 0 0 #00000010" }} />
      {voiceCues && <div style={{ marginTop: 8 }}><VoiceCue phrase="send it to the line" dark={dark} tone="live" /></div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button variant="default" size="sm" icon="x" onClick={draft.scrap} style={{ flex: 1, justifyContent: "center" }}>Scrap</Button>
        <Button variant="primary" size="sm" icon="arrow-right" onClick={onSend} style={{ flex: 1, justifyContent: "center" }}>Send to the line</Button>
      </div>
      <div style={{ marginTop: 8, fontFamily: "Caveat, cursive", fontSize: 13.5, color: "#8a6a4f", lineHeight: 1.1 }}>
        saved per-pane — your draft waits when you switch stations
      </div>
    </div>
  );

  // Inline render-helper: the Ticket History tab content.
  // 4U.2: recorded commands (newest first) with fold-out output peek + destructive clear.
  const renderHistoryTab = () => (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 14, background: dark ? "#2f1d12" : "#fff9ec" }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
        {history.entries.length === 0 ? (
          <div data-testid="burner-history-empty" style={{ fontFamily: "Caveat, cursive", fontSize: 15, color: "#8a6a4f" }}>no orders on this ticket yet, Chef</div>
        ) : (
          [...history.entries].reverse().map((e, i) => (
            <Fragment key={`${e.timestamp}-${history.entries.length - 1 - i}`}><HistoryRow e={e} dark={dark} /></Fragment>
          ))
        )}
      </div>
      <div style={{ display: "flex", gap: 7, flexShrink: 0, alignItems: "center" }}>
        <span style={{ flex: 1, fontFamily: "Caveat, cursive", fontSize: 13.5, color: "#8a6a4f", lineHeight: 1.1 }}>
          every order this station fired, on the record
        </span>
        <Button testId="burner-history-clear" variant={confirmClear ? "primary" : "default"} size="sm" icon="x"
          disabled={history.entries.length === 0}
          title={confirmClear ? "This wipes the record for keeps — tap again" : "Clear this station's command history"}
          onClick={onClearHistory}>{confirmClear ? "Sure, Chef?" : "Clear history"}</Button>
      </div>
    </div>
  );

  // Inline render-helper: the Notes & beads tab content.
  const renderNotesTab = () => (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 14, background: dark ? "#2f1d12" : "#fff9ec" }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
        {paneNotes.length === 0 ? (
          <div style={{ fontFamily: "Caveat, cursive", fontSize: 15, color: "#8a6a4f" }}>nothin' stitched to this pane yet, Chef</div>
        ) : paneNotes.map((n) => {
          const k = TICKET_KINDS[resolveNoteTicketKey(n.type)];
          return (
            <Fragment key={n.id}>
              <div data-testid="burner-note" style={{ padding: 9, border: "2px solid " + INK, borderRadius: 9, background: dark ? "#241409" : "#fff4de", boxShadow: "2px 2px 0 0 " + INK }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <Chip bg={k.color} color={k.color === "#d4a15a" ? INK : "#fff4de"}>{k.emoji} {k.label}</Chip>
                  <div style={{ flex: 1 }} />
                  <button data-testid="burner-note-delete" onClick={() => onDeleteNote(n.id)} title="86 this note" style={{ width: 22, height: 20, display: "grid", placeItems: "center", border: "1.5px solid " + INK, borderRadius: 6, background: dark ? "#1a0f08" : "#fff9ec", color: "#e23a3a", cursor: "pointer", padding: 0 }}><Icon name="x" size={11} /></button>
                </div>
                <div style={{ fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, color: fg, lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{n.text}</div>
              </div>
            </Fragment>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 7, flexShrink: 0 }}>
        <input data-testid="burner-note-input" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && note.trim()) { onAddNote(note); setNote(""); } }}
          placeholder="jot a note for this pane…" style={{ flex: 1, padding: "8px 10px", border: "2px solid " + INK, borderRadius: 8, background: dark ? "#241409" : "#fff4de", color: fg, fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, outline: "none" }} />
        <Button testId="burner-note-add" variant="blueberry" size="sm" icon="plus" disabled={!note.trim()} onClick={() => { onAddNote(note); setNote(""); }}>Bead</Button>
      </div>
    </div>
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(42,26,16,.62)", zIndex: 200, display: "grid", placeItems: "center", padding: 24 }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${st.name} — station terminal`}
        onClick={(e) => e.stopPropagation()} className="orb-pop-in" data-testid="burner" data-burner-pane={st.id} data-status={st.status}
        style={{ width: "min(1080px, 96vw)", height: "min(760px, 94vh)", background: dark ? "#241409" : "#fff4de", border: "4px solid " + INK, borderRadius: 16, boxShadow: "10px 10px 0 0 " + INK, display: "flex", flexDirection: "column", overflow: "hidden", outline: "none" }}>
        {/* window title bar */}
        <div style={{ padding: "11px 16px", background: accentHex, borderBottom: "3px solid " + INK, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button data-testid="burner-close" onClick={onClose} aria-label="Close the burner" title="Close" style={{ width: 13, height: 13, padding: 0, borderRadius: "50%", background: "#e23a3a", border: "1.5px solid " + INK, cursor: "pointer" }} />
            <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#ffc94a", border: "1.5px solid " + INK }} />
            <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#4db892", border: "1.5px solid " + INK }} />
          </div>
          <div style={{ flex: 1, textAlign: "center", lineHeight: 1.1, minWidth: 0 }}>
            {renderTitleBarNameSection()}
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: INK, opacity: .8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>#{st.id} · {rt.label} on the {rt.burner} · {st.cwd}</div>
          </div>
          <button data-testid="burner-restart" onClick={onRestart} title="Re-fire this station (restart the process)"
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 8, border: "2px solid " + INK, background: "#fff4de", color: INK, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, whiteSpace: "nowrap" }}>
            <Icon name="fire" size={13} color="#e23a3a" /> Re-fire
          </button>
          <button data-testid="burner-86" onClick={on86} data-confirming={confirm86 || undefined}
            title={derive86Title(st.status)}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 8, border: "2px solid " + INK, ...derive86ButtonStyle(confirm86), cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, whiteSpace: "nowrap" }}>
            <Icon name="x" size={12} /> {derive86ButtonLabel(confirm86)}
          </button>
          <PostureChip posture={st.posture} mode={st.mode} />
          <StatusBadge status={st.status} />
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* the terminal — the hero */}
          <div style={{ flex: 1.7, minWidth: 0, background: INK, display: "flex", flexDirection: "column", borderRight: "3px solid " + INK }}>
            {renderTerminalStatusBar()}
            {/* the REAL xterm: backfill scrollback + live raw-chunk stream, grid synced to the PTY */}
            <div data-testid="burner-terminal" style={{ flex: 1, minHeight: 0, position: "relative", padding: 6 }}>
              <TerminalView
                key={st.id}
                terminalId={st.id}
                backfill={backfill}
                onResize={(cols, rows) => resizeTerminal(st.id, cols, rows)}
                resyncKey={streamGeneration}
                fetchBackfill={fetchBackfill}
              />
            </div>
            <ControlKeyBar paneId={st.id} dark={dark} onKey={writeControlKey} />
          </div>

          {/* right column: Order Pad ⇄ Notes & beads */}
          <div style={{ flex: 1, minWidth: 300, display: "flex", flexDirection: "column", background: dark ? "#241409" : "#fff4de" }}>
            <div style={{ display: "flex", borderBottom: "3px solid " + INK, flexShrink: 0 }}>
              {([["pad", "📝 Order Pad"], ["notes", "🎫 Notes & beads"], ["history", "🧾 Ticket history"]] as const).map(([id, lbl]) => (
                <Fragment key={id}>
                  <button data-testid={`burner-tab-${id}`} onClick={() => setTab(id)} aria-pressed={tab === id}
                    style={{ flex: 1, padding: "9px 6px", border: "none", borderBottom: tab === id ? "3px solid #e23a3a" : "3px solid transparent", background: tab === id ? (dark ? "#2f1d12" : "#fff9ec") : "transparent", color: tab === id ? fg : "#8a6a4f", cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5 }}>{lbl}</button>
                </Fragment>
              ))}
            </div>

            {tab === "pad" ? renderPadTab() : tab === "history" ? renderHistoryTab() : renderNotesTab()}
          </div>
        </div>
      </div>
    </div>
  );
}
