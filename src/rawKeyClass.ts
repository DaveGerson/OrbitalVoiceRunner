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

/**
 * The canonical raw-key ALLOWLIST (bead ym3) — the 11 vetted control-key byte sequences the
 * control-key bar may send through POST /api/terminals/:id/raw-input. This is the SINGLE source of
 * truth for "which raw bytes are recognized at all": the route rejects anything not in this table
 * BEFORE classifyRawKey runs, so classifyRawKey only ever sees a vetted key. Keep byte-exact.
 *
 *   - arrows ESC[A / ESC[B / ESC[C / ESC[D — navigation
 *   - Enter \r, Tab \t, Esc \x1b           — terminal ops
 *   - PgUp ESC[5~, PgDn ESC[6~             — paging
 *   - Ctrl+C \x03                          — §13.1 emergency brake (always-allowed)
 *   - Shift+Tab ESC[Z                      — the one GATED mode-cycle key (SHIFT_TAB_BYTES)
 */
export const RAW_KEY_TABLE = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  tab: "\t",
  esc: "\x1b",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  ctrlC: "\x03",
  shiftTab: SHIFT_TAB_BYTES,
} as const;

/** The allowlist values, frozen once for O(1)-ish membership checks (small list — .includes is fine). */
const RAW_KEY_VALUES: readonly string[] = Object.values(RAW_KEY_TABLE);

/**
 * Whether `bytes` is EXACTLY one of the 11 vetted raw-key sequences (the allowlist). This is the
 * gate the /raw-input route consults before writeRaw: only a known key is ever dispatched; any other
 * payload — a near-miss like " \x03", a doubled "\x03\x03", or an arbitrary shell line "rm -rf ~\r" —
 * returns false and the route 400s it. Closing this allowlist is the ym3 fix (was a denylist-of-one).
 */
export function isKnownRawKey(bytes: string): boolean {
  return RAW_KEY_VALUES.includes(bytes);
}

export type RawKeyClass = "gated" | "always-allowed";

/**
 * Classify a raw byte string. Returns "gated" ONLY for the exact Shift+Tab sequence; every other
 * key (arrows ESC[A..D, Tab 0x09, Esc 0x1b, Enter 0x0d, PgUp/PgDn ESC[5~/ESC[6~, Ctrl+C 0x03) is
 * "always-allowed". A bare ESC (0x1b) is allowed — only the full ESC[Z triplet is the mode-cycle.
 *
 * PRECONDITION (ym3): callers MUST first reject any byte string that is NOT isKnownRawKey — this
 * function presumes a vetted key and would otherwise classify an arbitrary payload "always-allowed".
 */
export function classifyRawKey(bytes: string): RawKeyClass {
  return bytes === SHIFT_TAB_BYTES ? "gated" : "always-allowed";
}
