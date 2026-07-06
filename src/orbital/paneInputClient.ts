/**
 * src/orbital/paneInputClient.ts — the CLIENT side of the operator pane-typing wire contract.
 *
 * Single source of truth for the `pane_input` frame the frontend sends when the operator types into a
 * focused xterm pane. Centralizing construction here (instead of an inline object literal at each
 * `<TerminalView onInput=…>` call site) pins the wire field names — `type` / `paneId` / `data` — that
 * the server's `applyPaneInputFrame` (src/voice/paneInputFrame.ts) reads off the frame. A field-name
 * typo at a call site (e.g. `pane_id`) would otherwise silently send a frame the server ignores or
 * mis-routes, and only the live e2e would catch it. Unit-pinned in tests/test_pane_input_client.ts.
 */

/** The `pane_input` WS frame: operator keystrokes (raw xterm onData bytes) bound for a pane's PTY. */
export interface PaneInputClientFrame {
  type: "pane_input";
  paneId: string;
  data: string;
}

/** Build the `pane_input` frame carrying the operator's keystroke bytes `data` destined for `paneId`. */
export function buildPaneInputFrame(paneId: string, data: string): PaneInputClientFrame {
  return { type: "pane_input", paneId, data };
}

/**
 * The `TerminalView onInput=` send guard, pulled out of the App.tsx / TerminalWindow.tsx call
 * sites (bead wsm-e2e-pinned-vs7) so it's a plain, testable predicate instead of an inline closure
 * duplicated at both sites. Mirrors the original two conditions exactly:
 *  - under plain `?mock=1` (isMock, not e2e-wire-armed) keystrokes never leave the browser — no
 *    live pane exists to receive them;
 *  - otherwise a frame only ever goes out while the observe socket is actually OPEN.
 * `readyState` accepts a raw WebSocket (or a `{readyState}`-shaped stand-in for tests) so this
 * module never needs to import the `WebSocket` global itself.
 */
export function shouldSendPaneInput(
  isMock: boolean,
  wireArmed: boolean,
  ws: { readyState: number } | null | undefined,
): boolean {
  if (isMock && !wireArmed) return false;
  return ws != null && ws.readyState === WS_OPEN;
}

// WebSocket.OPEN is spec-pinned to 1 (CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3) — hardcoded so
// this module has no dependency on a global WebSocket existing (e.g. under a jsdom test runner).
const WS_OPEN = 1;
