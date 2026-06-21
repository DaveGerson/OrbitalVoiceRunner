// tests/test_terminalview_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-
// complexity burndown refactor of src/components/TerminalView.tsx (the `resync` async arrow, CC 16
// → 9). Three pure helpers were extracted to module level as named exports:
//
//   tryFetchBackfill  — async I/O wrapper with try/catch (removes catch + ??)
//   resolveBackfill   — priority-merge between server fetch and React-state fallback (removes if + ??)
//   shouldSkipQuietResync — three-branch OR guard, quiet-path short-circuit (removes 2× ||)
//
// The three pure helpers now live in src/components/terminalViewResync.ts — a CSS-free sibling
// module — so these tests import the REAL production implementations (no mirror copies, no
// test/production drift). TerminalView.tsx imports them from that same module too.
//
// Runner: npx tsx --test --test-force-exit tests/test_terminalview_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tryFetchBackfill, resolveBackfill, shouldSkipQuietResync } from "../src/components/terminalViewResync";

// ─────────────────────────────────────────────────────────────────────────────
// 1. tryFetchBackfill — branch coverage
// ─────────────────────────────────────────────────────────────────────────────
describe("tryFetchBackfill", () => {
  it("returns the resolved string when the fetcher succeeds", async () => {
    const fetcher = async () => "snapshot-data";
    assert.equal(await tryFetchBackfill(fetcher), "snapshot-data");
  });

  it("returns null when the fetcher resolves to null", async () => {
    const fetcher = async () => null;
    assert.equal(await tryFetchBackfill(fetcher), null);
  });

  it("returns null when fetcher is undefined (no fetcher wired)", async () => {
    assert.equal(await tryFetchBackfill(undefined), null);
  });

  it("returns null (does NOT throw) when the fetcher rejects", async () => {
    const fetcher = async (): Promise<string | null> => {
      throw new Error("network down");
    };
    assert.equal(await tryFetchBackfill(fetcher), null);
  });

  it("preserves empty-string from fetcher (not null, not collapsed by ?? null)", async () => {
    // empty string is a valid cleared snapshot — ?? null must NOT collapse it
    const fetcher = async () => "";
    assert.equal(await tryFetchBackfill(fetcher), "");
  });

  it("preserves a non-empty escape-sequence string exactly (no trimming or mutation)", async () => {
    const raw = "\x1b[2J\x1b[H$ echo hello\r\n";
    const fetcher = async () => raw;
    assert.equal(await tryFetchBackfill(fetcher), raw);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. resolveBackfill — branch coverage
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveBackfill", () => {
  it("returns the fetched value when it is a non-null string", () => {
    assert.equal(resolveBackfill("server-snapshot", "react-state"), "server-snapshot");
  });

  it("returns the fetched value even when it is an empty string (not null)", () => {
    // empty-string is a valid cleared snapshot, not the same as null
    assert.equal(resolveBackfill("", "react-state"), "");
  });

  it("falls back to reactFallback when fetched is null", () => {
    assert.equal(resolveBackfill(null, "react-state"), "react-state");
  });

  it("returns null when fetched is null and reactFallback is undefined", () => {
    assert.equal(resolveBackfill(null, undefined), null);
  });

  it("falls back to reactFallback (escape-sequence string) when fetched is null", () => {
    const snap = "\x1b[H$ ls -la\r\n";
    assert.equal(resolveBackfill(null, snap), snap);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. shouldSkipQuietResync — all three OR branches + the passing case
// ─────────────────────────────────────────────────────────────────────────────
describe("shouldSkipQuietResync", () => {
  it("returns true when fresh is null (nothing to write — first branch)", () => {
    assert.equal(shouldSkipQuietResync(null, "last", true), true);
  });

  it("returns true when fresh equals lastBase (snapshot unchanged — second branch)", () => {
    assert.equal(shouldSkipQuietResync("same", "same", true), true);
  });

  it("returns true when operator is NOT at bottom (reading history — third branch)", () => {
    assert.equal(shouldSkipQuietResync("new-data", "old-data", false), true);
  });

  it("returns false only when: fresh non-null, differs from lastBase, AND operator at bottom", () => {
    assert.equal(shouldSkipQuietResync("new-data", "old-data", true), false);
  });

  it("empty-string fresh differs from non-empty lastBase, operator at bottom → no skip", () => {
    assert.equal(shouldSkipQuietResync("", "something", true), false);
  });

  it("empty-string fresh matching empty-string lastBase → skip (snapshot unchanged)", () => {
    assert.equal(shouldSkipQuietResync("", "", true), true);
  });

  it("null still returns true even when atBottom=false (null short-circuits first)", () => {
    assert.equal(shouldSkipQuietResync(null, "last", false), true);
  });

  it("!atBottom short-circuits: fresh differs from lastBase but operator is reading → skip", () => {
    assert.equal(shouldSkipQuietResync("new", "old", false), true);
  });
});
