// tests/test_rawkey_allowlist.ts — bead ym3: the raw-input ALLOWLIST (close the denylist-of-one).
//
// ROOT CAUSE THIS LOCKS: the old raw-input contract was a DENYLIST of exactly one sequence — only the
// precise Shift+Tab (ESC[Z) was gated; classifyRawKey returned "always-allowed" for LITERALLY EVERY
// other payload, so an arbitrary shell line ("rm -rf ~\r") was written verbatim to the PTY via
// writeRaw, BYPASSING the write_to_pane gate entirely. The fix flips it to an ALLOWLIST: only the 11
// vetted control-key sequences are recognized; anything else is rejected BEFORE classifyRawKey runs.
//
// This pure unit pins isKnownRawKey (the allowlist predicate) independently of the Express/PTY surface.
// The §13.1 Ctrl+C-always-allowed emergency-brake decision is PRESERVED: the exact \x03 stays known.
//
// Runner: npx tsx --test --test-force-exit tests/test_rawkey_allowlist.ts

import { test } from "node:test";
import assert from "node:assert";
import { isKnownRawKey, RAW_KEY_TABLE, SHIFT_TAB_BYTES, classifyRawKey } from "../src/rawKeyClass";

// The 11 vetted canonical sequences (multi-cli adapter spec §8/§10). Spelled out here BYTE-EXACT so a
// silent drift in the production table fails this test.
const CANONICAL: Array<[string, string]> = [
  ["Up arrow", "\x1b[A"],
  ["Down arrow", "\x1b[B"],
  ["Right arrow", "\x1b[C"],
  ["Left arrow", "\x1b[D"],
  ["Enter", "\r"],
  ["Tab", "\t"],
  ["Esc", "\x1b"],
  ["PgUp", "\x1b[5~"],
  ["PgDn", "\x1b[6~"],
  ["Ctrl+C", "\x03"],
  ["Shift+Tab", "\x1b[Z"],
];

test("isKnownRawKey: every one of the 11 canonical sequences is recognized", () => {
  for (const [label, bytes] of CANONICAL) {
    assert.strictEqual(isKnownRawKey(bytes), true, `${label} (${JSON.stringify(bytes)}) must be a known raw key`);
  }
});

test("isKnownRawKey: the EXACT Ctrl+C (\\x03) stays known — §13.1 emergency brake is preserved", () => {
  assert.strictEqual(isKnownRawKey("\x03"), true, "the bare 0x03 Ctrl+C must remain an allowed raw key");
});

test("isKnownRawKey: the EXACT Shift+Tab (ESC[Z) stays known — it is gated, not denied", () => {
  assert.strictEqual(isKnownRawKey(SHIFT_TAB_BYTES), true);
  assert.strictEqual(classifyRawKey(SHIFT_TAB_BYTES), "gated", "known + gated, NOT rejected");
});

test("isKnownRawKey: near-misses and arbitrary payloads are REJECTED (the allowlist closes the hole)", () => {
  const REJECTED = [
    " \x03",       // leading space — NOT canonical Ctrl+C
    "\x03\x03",    // double Ctrl+C — not a single canonical key
    "\x03 ",       // trailing space
    "rm -rf ~\r",  // a full shell line (the headline exploit)
    "\x1b[Z ",     // Shift+Tab with trailing junk
    "\x1b[5~~",    // PgUp with trailing junk
    "x",           // a printable char
    "\x1b[E",      // an ESC[ seq NOT in the table
    "\x04",        // Ctrl+D — never allowlisted
    "",            // empty
  ];
  for (const bytes of REJECTED) {
    assert.strictEqual(isKnownRawKey(bytes), false, `${JSON.stringify(bytes)} must NOT be a known raw key`);
  }
});

test("RAW_KEY_TABLE: exposes exactly the 11 vetted byte sequences (canonical source of truth)", () => {
  const values: readonly string[] = Object.values(RAW_KEY_TABLE);
  assert.strictEqual(values.length, 11, "the canonical table has exactly 11 entries");
  for (const [label, bytes] of CANONICAL) {
    assert.ok(values.includes(bytes), `${label} (${JSON.stringify(bytes)}) must appear in RAW_KEY_TABLE`);
  }
});
