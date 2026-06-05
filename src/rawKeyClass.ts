/**
 * Raw control-key classification for POST /api/terminals/:id/raw-input (multi-cli adapter spec §10).
 *
 * The control-key bar sends literal keystrokes (arrows / Tab / Esc / Enter / PgUp/PgDn / Ctrl+C /
 * Shift+Tab) as raw bytes into a pane's PTY. The capability model is BIFURCATED:
 *
 *   - "always-allowed" — orientation/navigation keys (arrows, Tab, Esc, Enter, PageUp/PageDown) AND
 *     the Ctrl+C emergency brake. These bypass the gate (no friction in HITL; halting a runaway must
 *     never be gated — approved decision override of spec §13.1).
 *   - "gated"          — the disruptive Shift+Tab mode-cycle (ESC[Z = 0x1b 0x5b 0x5a). Routed
 *     through gateOrDefer("write_to_pane", …): Ask off-spotlight, Auto on-spotlight, durable defer.
 *
 * This pure helper is the single source of that decision so it is unit-pinnable independently of the
 * Express/PTY surface. Keep it byte-exact: the gate fires ONLY on the precise Shift+Tab sequence.
 */

/** Shift+Tab — ESC [ Z — 0x1b 0x5b 0x5a. The ONLY gated raw key (Claude live mode-cycle). */
export const SHIFT_TAB_BYTES = "\x1b\x5b\x5a";

export type RawKeyClass = "gated" | "always-allowed";

/**
 * Classify a raw byte string. Returns "gated" ONLY for the exact Shift+Tab sequence; every other
 * key (arrows ESC[A..D, Tab 0x09, Esc 0x1b, Enter 0x0d, PgUp/PgDn ESC[5~/ESC[6~, Ctrl+C 0x03) is
 * "always-allowed". A bare ESC (0x1b) is allowed — only the full ESC[Z triplet is the mode-cycle.
 */
export function classifyRawKey(bytes: string): RawKeyClass {
  return bytes === SHIFT_TAB_BYTES ? "gated" : "always-allowed";
}
