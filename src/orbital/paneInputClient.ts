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
