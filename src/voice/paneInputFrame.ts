/**
 * src/voice/paneInputFrame.ts — OPERATOR-DIRECT pane input (the "type into the terminal" path).
 *
 * Server-side handler for the `pane_input` WS frame: the operator typing directly into a focused
 * xterm pane (TerminalView's `onInput` → `term.onData` → a `{ type:"pane_input", paneId, data }`
 * frame; the client builder is `buildPaneInputFrame` in src/orbital/paneInputClient.ts). `msg.data`
 * is written VERBATIM to the pane's PTY via `term.writeRaw`.
 *
 * INTENTIONALLY UNGATED — a deliberate product decision. Operator keystrokes are routed ABOVE the
 * capability gate: NO capability gate, NO approval prompt, NO interaction log. A human at the keyboard
 * typing into a pane they have focused is the operator exercising direct control of their own terminal;
 * the gate exists to mediate the MODEL's autonomous writes, not the human's hands.
 *
 * HONEST PEER COMPARISON (do not confuse this with `draft_edit`): the right analogue is the raw-input
 * REST route (server.ts, POST /api/terminals/:id/raw-input) — the *other* `writeRaw` surface. NOT
 * `draft_edit`: that writes inert text to a DB draft row (executed LATER, through the gate); this writes
 * live bytes (including a `\r` Enter) straight to the PTY — i.e. immediate command execution. So:
 *   - Unlike the raw-input route we DELIBERATELY do NOT apply the `isKnownRawKey` allowlist. That route
 *     allowlists 11 control keys to stop an arbitrary shell line; here arbitrary printable input IS the
 *     feature the operator asked for, so the allowlist would defeat it. This is a conscious relaxation.
 *   - We DO keep the two scopings that route relies on to keep the relaxation safe:
 *       1. WS AUTH — the observe/voice socket rejects any client whose auth cookie ≠ API_AUTH_TOKEN
 *          (httpOnly + SameSite=strict), so only the authenticated operator's own browser can send a
 *          pane_input frame (no cross-origin / unauthenticated PTY write).
 *       2. SINGLE-ACTIVE-PANE guard (`isPaneActiveForWrite`) — keystrokes may only reach the ONE pane
 *          the operator currently has open/active, exactly like the control-key bar. A stale or
 *          hand-crafted frame, or a set_active_pane/pane_input race, targeting a non-active pane is
 *          dropped, never written.
 *
 * writeRaw vs writeInput: `writeRaw` writes the bytes in a single `transport.write` with NO appended
 * `\r` and NO optimistic "Running" status kick. xterm already sends Enter as a `\r` inside `data`, so we
 * must NOT add a second one, and a keystroke stream must not be misread as the start of a command run.
 * Do NOT switch this to `writeInput`.
 *
 * Best-effort by design (this is NOT a clean "no-op" in every case):
 *   - no resolvable pane / non-string / empty data / pane not the active pane / unknown pane → ignored.
 *   - Bytes typed in the brief ConPTY spawn window (transport set but the child's stdin reader not yet
 *     attached) go straight through and may be DROPPED by the PTY — they are NOT buffered like
 *     writeInput's `pendingInput` queue (that queue flushes via deliverSubmit, which appends a CR and
 *     would mangle raw bytes). In practice the operator sees the shell prompt before typing, so this
 *     window is tiny — but it is a real drop, not a no-op.
 *   - STOP-ALL freeze does NOT suppress typing: the operator stays above the gate, consistent with the
 *     always-allowed Ctrl+C brake — you must be able to type a recovery command after hitting stop. (If
 *     freeze should ever gate typing, that is a deliberate follow-up, not an accident.)
 *
 * The module is SIDE-EFFECT-FREE and depends only on MINIMAL STRUCTURAL types plus the pure
 * `isPaneActiveForWrite` leaf, so the unit test imports the REAL helper without the heavy voice module.
 * The concrete `OrchestratorManager` and `CoreState` are structurally compatible with the interfaces
 * below, so the call sites pass them unchanged.
 */

import { isPaneActiveForWrite } from "../activePane";

/** The raw `pane_input` WS frame as received off the wire (untrusted — fields are validated below). */
export interface PaneInputFrame {
  type?: string;
  paneId?: unknown;
  data?: unknown;
}

/** Minimal structural view of a `UniversalTerminal` — just the raw passthrough primitive we need. */
export interface PaneInputTerminal {
  writeRaw(bytes: string): void;
}

/** Minimal structural view of the `OrchestratorManager` — just the pane lookup map. */
export interface PaneInputManager {
  terminals: Record<string, PaneInputTerminal | undefined>;
}

/** Minimal structural view of `CoreState` — the active-pane fallback + write-scope target. */
export interface PaneInputCoreState {
  activePaneId: string | null;
}

/**
 * Apply a `pane_input` frame: write the operator's raw keystroke bytes VERBATIM to the target pane.
 * UNGATED by design (see module doc), but SCOPED to the single active pane and to existing panes —
 * every malformed, stale, or off-target frame is a safe no-op, never an exception.
 */
export function applyPaneInputFrame(
  msg: PaneInputFrame,
  manager: PaneInputManager,
  coreState: PaneInputCoreState,
): void {
  const paneId = typeof msg.paneId === "string" ? msg.paneId : coreState.activePaneId;
  if (!paneId) return;
  if (typeof msg.data !== "string" || msg.data.length === 0) return;
  // wsm-e2e-pinned-izj (2026-07-02, no behavior change): a `coreState.frozen` check would
  // otherwise live HERE, before the write below. It is deliberately absent — STOP-ALL freeze does
  // NOT gate operator direct typing, same rationale as the always-allowed Ctrl+C brake: the
  // operator stays above the gate so they can type a recovery command right after hitting stop.
  // See docs/design/2026-06-24-pane-direct-typing.md ("2026-07-02 — decision reaffirmed").
  // Single-active-pane targeting (matches the raw-input control-key route): the operator's keystrokes
  // may only ever reach the pane they currently have open. An explicit paneId that isn't the active
  // pane — a stale/hand-crafted frame, or a set_active_pane/pane_input race — is dropped, not written.
  if (!isPaneActiveForWrite(coreState.activePaneId, paneId)) return;
  const term = manager.terminals[paneId];
  if (!term) return; // unknown / dead pane -> safe no-op
  term.writeRaw(msg.data); // verbatim, UNGATED, no Running kick (NOT writeInput)
}
