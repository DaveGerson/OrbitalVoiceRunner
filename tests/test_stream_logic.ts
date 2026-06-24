// tests/test_stream_logic.ts — CHARACTERIZATION tests for the pure stdout-flush + resize-dedup
// helpers extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition). The rAF / setTimeout /
// publishChunk / apiFetch I/O lives in useStdoutStream (src/classic/hooks/useStdoutStream.ts) and is
// exercised by the terminal e2e; these pin the two pure pieces the hook delegates to:
//
//   * appendCappedOutput  — one pane's preview tail re-capped to the last 110 lines.
//   * applyBufferedChunks — the rAF flush merge over the terminals array (untouched panes pass through).
//   * shouldSkipResize    — the grid-key dedup (unchanged cols×rows never re-POSTs).
//
// Runner: npx tsx --test --test-force-exit tests/test_stream_logic.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import type { Terminal } from "../src/types";
import {
  appendCappedOutput,
  applyBufferedChunks,
  shouldSkipResize,
  STDOUT_PREVIEW_LINE_CAP,
} from "../src/classic/helpers/streamLogic";

function term(id: string, output: string): Terminal {
  return { id, cwd: ".", command: "bash", output, status: "Running" } as Terminal;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. appendCappedOutput — concat then keep only the last 110 lines.
// ═════════════════════════════════════════════════════════════════════════════
describe("streamLogic — appendCappedOutput", () => {
  it("appends the chunk verbatim when under the cap", () => {
    assert.strictEqual(appendCappedOutput("a\nb", "\nc"), "a\nb\nc");
  });

  it("keeps only the last 110 lines when over the cap", () => {
    const prev = Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n");
    const out = appendCappedOutput(prev, "\nLAST");
    const lines = out.split("\n");
    assert.strictEqual(lines.length, STDOUT_PREVIEW_LINE_CAP);
    assert.strictEqual(lines[lines.length - 1], "LAST");
    // 201 lines after append → first kept is index 91 (201 - 110).
    assert.strictEqual(lines[0], "L91");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. applyBufferedChunks — merge buffered chunks; leave untouched panes alone.
// ═════════════════════════════════════════════════════════════════════════════
describe("streamLogic — applyBufferedChunks", () => {
  it("appends buffered chunks to the matching panes", () => {
    const terms = [term("a", "x"), term("b", "y")];
    const next = applyBufferedChunks(terms, { a: "1", b: "2" });
    assert.strictEqual(next[0].output, "x1");
    assert.strictEqual(next[1].output, "y2");
  });

  it("returns the SAME object reference for a pane with no buffered bytes", () => {
    const terms = [term("a", "x"), term("b", "y")];
    const next = applyBufferedChunks(terms, { a: "1" });
    assert.strictEqual(next[0].output, "x1");
    assert.strictEqual(next[1], terms[1]); // untouched → identity preserved
  });

  it("ignores buffer keys with no matching pane", () => {
    const terms = [term("a", "x")];
    const next = applyBufferedChunks(terms, { ghost: "z" });
    assert.deepStrictEqual(next, terms);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. shouldSkipResize — dedup an unchanged grid key.
// ═════════════════════════════════════════════════════════════════════════════
describe("streamLogic — shouldSkipResize", () => {
  it("skips when the new key equals the last sent key", () => {
    assert.strictEqual(shouldSkipResize("80x24", "80x24"), true);
  });

  it("does NOT skip when the key changed", () => {
    assert.strictEqual(shouldSkipResize("80x24", "100x30"), false);
  });

  it("does NOT skip when no key was ever sent (undefined)", () => {
    assert.strictEqual(shouldSkipResize(undefined, "80x24"), false);
  });
});
