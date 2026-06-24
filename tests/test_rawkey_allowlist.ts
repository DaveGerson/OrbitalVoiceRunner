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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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

// ──────────────────────────────────────────────────────────────────────────────────────────────
// bead 6q5 — FRONTEND↔SERVER raw-key DRIFT GUARD.
//
// There are TWO hand-built raw-key tables: the SERVER allowlist RAW_KEY_TABLE here (src/rawKeyClass.ts,
// the route's 400-gate) and the FRONTEND control-key-bar table `RAW_KEY` in
// src/classic/components/ControlKeyBar.tsx (extracted verbatim out of src/App.tsx in dbt4 PR-A).
// They have no shared source of truth (a shared import would pull a server module into the Vite
// browser bundle — higher churn, riskier build-graph change), so we pin the invariant instead:
// EVERY frontend RAW_KEY value must be a MEMBER of the server RAW_KEY_TABLE. If a future frontend-only
// key add slips in, the server allowlist would 400 it at runtime — this guard turns that latent 400
// into a RED unit test.
//
// We scan the module AS TEXT (same source-as-text pattern as tests/test_no_inline_twins.ts) rather
// than importing it: it pulls React/lucide/the UI tree, none of which a node test can boot.
const here = path.dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(path.join(here, "..", "src", "classic", "components", "ControlKeyBar.tsx"), "utf8");

/**
 * Decode a JS double-quoted string-literal BODY (the chars between the quotes) into its runtime bytes.
 * Handles the escapes that appear in these control-key tables — \xHH, \r, \n, \t, \0, \\, \" — so the
 * parsed values compare equal to the runtime RAW_KEY_TABLE values. (JSON.parse can't be used: JSON has
 * no \xHH escape, only \uHHHH, and these literals use \x1b.)
 */
function decodeJsStringBody(body: string): string {
  return body.replace(/\\x([0-9A-Fa-f]{2})|\\(.)/g, (_all, hex, ch) => {
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    switch (ch) {
      case "r": return "\r";
      case "n": return "\n";
      case "t": return "\t";
      case "0": return "\0";
      default: return ch; // \\ , \" , and any other escaped literal char
    }
  });
}

/**
 * Extract the string VALUES from the `const RAW_KEY = { … } as const;` object literal in
 * src/classic/components/ControlKeyBar.tsx. Returns [name, decodedBytes] pairs. Throws if the
 * literal can't be located (so a rename also fails RED).
 */
function extractFrontendRawKeyValues(src: string): Array<[string, string]> {
  const block = /const\s+RAW_KEY\s*=\s*\{([\s\S]*?)\}\s*as const;/.exec(src);
  assert.ok(block, "could not locate `const RAW_KEY = { … } as const;` in src/classic/components/ControlKeyBar.tsx (renamed?)");
  // Match `name: "….."` pairs; the value is a double-quoted JS string literal (may contain \x.. escapes).
  const pairRe = /(\w+)\s*:\s*"((?:\\.|[^"\\])*)"/g;
  const out: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(block[1])) !== null) {
    out.push([m[1], decodeJsStringBody(m[2])]);
  }
  // l1c: prove the parser actually decoded the literal — not just "some" entries, but specifically
  // the load-bearing Enter byte ("\r"). A non-empty-but-garbage parse (e.g. it matched key NAMES but
  // dropped every value) would slip past a bare length>0 check; this catches that drift.
  const decodedBytes = out.map(([, bytes]) => bytes);
  assert.ok(decodedBytes.includes("\r"), `frontend RAW_KEY parse must include the Enter byte; got ${JSON.stringify(out)}`);
  return out;
}

test("drift guard (6q5): every frontend RAW_KEY value is a member of the server RAW_KEY_TABLE", () => {
  const frontend = extractFrontendRawKeyValues(appSrc);
  for (const [name, bytes] of frontend) {
    assert.ok(
      isKnownRawKey(bytes),
      `frontend RAW_KEY.${name} = ${JSON.stringify(bytes)} is NOT in the server RAW_KEY_TABLE allowlist. ` +
        `The server /raw-input route will 400 it. Add it to RAW_KEY_TABLE in src/rawKeyClass.ts ` +
        `(and tests/test_rawkey_allowlist.ts CANONICAL) before shipping the frontend key.`,
    );
  }
});
