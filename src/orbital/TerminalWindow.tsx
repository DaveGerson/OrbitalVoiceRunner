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
import { Fragment, useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { TerminalView } from "../components/TerminalView";
import { apiFetch } from "../utils/api";
import { RAW_KEY_TABLE } from "../rawKeyClass";
import { INK, RUNTIMES } from "./theme";
import { Button, Icon, Mascot, StatusBadge, VoiceCue } from "./primitives";
import type { Station } from "./station";

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
function useDraft(projectId: string, paneId: string, isMockRef: MutableRefObject<boolean>, wsRef: MutableRefObject<WebSocket | null>) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!paneId || isMockRef.current) { setText(""); return; }
    let cancelled = false;
    apiFetch(`/api/panes/${projectId}/${paneId}/draft`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setText(d.draft?.text ?? ""); })
      .catch(() => { /* pane has no draft yet */ });
    return () => { cancelled = true; };
  }, [projectId, paneId, isMockRef]);

  const onChange = (v: string) => {
    setText(v);
    if (!paneId) return;
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
    try {
      const r = await apiFetch(`/api/panes/${projectId}/${paneId}/draft/send`, { method: "POST" });
      if (r.ok) { setText(""); return true; }
    } catch { /* pane may have exited */ }
    return false;
  };
  return { text, onChange, send, scrap: () => onChange("") };
}

export function TerminalWindow({ st, backfill, accentHex, dark, isMockRef, wsRef, voiceCues, onClose, onRestart, writeControlKey, resizeTerminal, showToast }: {
  st: Station;
  backfill?: string;
  accentHex: string;
  dark: boolean;
  isMockRef: MutableRefObject<boolean>;
  wsRef: MutableRefObject<WebSocket | null>;
  voiceCues: boolean;
  onClose: () => void;
  onRestart: () => void;
  writeControlKey: (paneId: string, bytes: string) => void;
  resizeTerminal: (paneId: string, cols: number, rows: number) => void;
  showToast: (msg: string, kind?: "fire" | "warn") => void;
}) {
  const [tab, setTab] = useState<"pad" | "notes">("pad");
  const rt = RUNTIMES[st.toolPreset] || RUNTIMES.Custom;
  const live = st.status === "Running";
  const fg = dark ? "#ffe9c7" : INK;
  const draft = useDraft(st.project || "default_project", st.id, isMockRef, wsRef);

  const onSend = async () => {
    const ok = await draft.send();
    showToast(ok ? "Sent to the line 🔥" : "Nothing to send", ok ? "fire" : "warn");
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(42,26,16,.62)", zIndex: 200, display: "grid", placeItems: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="orb-pop-in" data-testid="burner" data-burner-pane={st.id} data-status={st.status}
        style={{ width: "min(1080px, 96vw)", height: "min(760px, 94vh)", background: dark ? "#241409" : "#fff4de", border: "4px solid " + INK, borderRadius: 16, boxShadow: "10px 10px 0 0 " + INK, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* window title bar */}
        <div style={{ padding: "11px 16px", background: accentHex, borderBottom: "3px solid " + INK, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button data-testid="burner-close" onClick={onClose} aria-label="Close the burner" title="Close" style={{ width: 13, height: 13, padding: 0, borderRadius: "50%", background: "#e23a3a", border: "1.5px solid " + INK, cursor: "pointer" }} />
            <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#ffc94a", border: "1.5px solid " + INK }} />
            <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#4db892", border: "1.5px solid " + INK }} />
          </div>
          <div style={{ flex: 1, textAlign: "center", lineHeight: 1.1, minWidth: 0 }}>
            <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 18, color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{st.name}</div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 10.5, color: INK, opacity: .8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>#{st.id} · {rt.label} on the {rt.burner} · {st.cwd}</div>
          </div>
          <button data-testid="burner-restart" onClick={onRestart} title="Re-fire this station (restart the process)"
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 8, border: "2px solid " + INK, background: "#fff4de", color: INK, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 11.5, whiteSpace: "nowrap" }}>
            <Icon name="fire" size={13} color="#e23a3a" /> Re-fire
          </button>
          <StatusBadge status={st.status} />
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* the terminal — the hero */}
          <div style={{ flex: 1.7, minWidth: 0, background: INK, display: "flex", flexDirection: "column", borderRight: "3px solid " + INK }}>
            <div style={{ padding: "7px 14px", borderBottom: "1px solid #ffffff18", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: live ? "#9be3c0" : "#8a6a4f", animation: live ? "orb-pulse 1s var(--ease-bounce) infinite" : "none" }} />
              <span style={{ fontFamily: "JetBrains Mono", fontSize: 10.5, color: "#c89f74", textTransform: "uppercase", letterSpacing: ".08em" }}>
                {live ? "live on the burner" : st.status === "Exited" ? "process ended" : st.status === "Needs Input" ? "waiting on you, Chef" : "idle — prompt ready"}
              </span>
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: "#8a6a4f" }}>{rt.burner} station</span>
            </div>
            {/* the REAL xterm: backfill scrollback + live raw-chunk stream, grid synced to the PTY */}
            <div data-testid="burner-terminal" style={{ flex: 1, minHeight: 0, position: "relative", padding: 6 }}>
              <TerminalView
                key={st.id}
                terminalId={st.id}
                backfill={backfill}
                onResize={(cols, rows) => resizeTerminal(st.id, cols, rows)}
              />
            </div>
            <ControlKeyBar paneId={st.id} dark={dark} onKey={writeControlKey} />
          </div>

          {/* right column: Order Pad ⇄ Notes & beads */}
          <div style={{ flex: 1, minWidth: 300, display: "flex", flexDirection: "column", background: dark ? "#241409" : "#fff4de" }}>
            <div style={{ display: "flex", borderBottom: "3px solid " + INK, flexShrink: 0 }}>
              {([["pad", "📝 Order Pad"], ["notes", "🎫 Notes & beads"]] as const).map(([id, lbl]) => (
                <Fragment key={id}>
                  <button data-testid={`burner-tab-${id}`} onClick={() => setTab(id)} aria-pressed={tab === id}
                    style={{ flex: 1, padding: "9px 6px", border: "none", borderBottom: tab === id ? "3px solid #e23a3a" : "3px solid transparent", background: tab === id ? (dark ? "#2f1d12" : "#fff9ec") : "transparent", color: tab === id ? fg : "#8a6a4f", cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5 }}>{lbl}</button>
                </Fragment>
              ))}
            </div>

            {tab === "pad" ? (
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 14, background: dark ? "#2f1d12" : "#fff9ec" }}>
                <textarea data-testid="burner-draft" value={draft.text} onChange={(e) => draft.onChange(e.target.value)}
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
            ) : (
              <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 20, background: dark ? "#2f1d12" : "#fff9ec", textAlign: "center" }}>
                <div>
                  <Mascot variant="default" size={56} style={{ margin: "0 auto 8px" }} />
                  <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 17, color: fg }}>Notes &amp; beads</div>
                  <div style={{ fontFamily: "Caveat, cursive", fontSize: 16, color: "#8a6a4f", marginTop: 2 }}>stitched up at the Pass — opening soon, Chef</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
