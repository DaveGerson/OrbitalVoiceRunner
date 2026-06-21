// tests/test_smokekitchen_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-
// complexity burndown refactor of scripts/live-smoke-kitchen.mjs (CC 19 → 9 in `main`).
//
// These tests pin the PURE helper functions extracted from `main` to prove behavior preservation.
// The live-server / WebSocket / PTY path in `main` itself requires a real running server and browser
// and is NOT exercised here (spinning one up is explicitly excluded per task constraints). Those
// paths are covered by the live smoke run itself; tsc + isolated eslint cover structural correctness.
//
// Runner: npx tsx --test --test-force-exit tests/test_smokekitchen_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---- Import the pure helpers via dynamic import (ESM .mjs) ----
// We use top-level await at describe-time; tsx supports this in --test mode.
const {
  isValidAppShell,
  findOurPendingAction,
  buildFrameHistogram,
  paneHasMarker,
} = await import("../scripts/live-smoke-kitchen.mjs");

// ---------------------------------------------------------------------------
// isValidAppShell
// ---------------------------------------------------------------------------
describe("isValidAppShell", () => {
  it("returns true for a well-formed 200 app shell", () => {
    const html = '<html><body><div id="root"></div><script src="assets/index-abc123.js"></script></body></html>';
    assert.equal(isValidAppShell(200, html), true);
  });

  it("returns false when status is not 200", () => {
    const html = '<div id="root"></div><script src="assets/index-abc123.js"></script>';
    assert.equal(isValidAppShell(404, html), false);
  });

  it("returns false when <div id=\"root\"> is missing", () => {
    const html = '<html><body><script src="assets/index-abc123.js"></script></body></html>';
    assert.equal(isValidAppShell(200, html), false);
  });

  it("returns false when the assets/index-*.js script tag is missing", () => {
    const html = '<html><body><div id="root"></div></body></html>';
    assert.equal(isValidAppShell(200, html), false);
  });

  it("returns false for empty html", () => {
    assert.equal(isValidAppShell(200, ""), false);
  });
});

// ---------------------------------------------------------------------------
// findOurPendingAction
// ---------------------------------------------------------------------------
describe("findOurPendingAction", () => {
  const paneId = "livesmoke_12345_1700000000000";

  it("returns the exact-match action when summary includes paneId", () => {
    const pending = [
      { id: "a1", capability: "create_pane", summary: "create pane livesmoke_12345_1700000000000" },
      { id: "a2", capability: "create_pane", summary: "create pane other_pane" },
    ];
    const act = findOurPendingAction(pending, paneId);
    assert.equal(act?.id, "a1");
  });

  it("falls back to any create_pane action when no summary matches paneId", () => {
    const pending = [
      { id: "a1", capability: "other_cap", summary: "something" },
      { id: "a2", capability: "create_pane", summary: "create pane other_pane" },
    ];
    const act = findOurPendingAction(pending, paneId);
    assert.equal(act?.id, "a2");
  });

  it("prefers exact-match over earlier fallback-eligible entries", () => {
    const pending = [
      { id: "fallback", capability: "create_pane", summary: "stale from previous run" },
      { id: "exact", capability: "create_pane", summary: `spawn ${paneId} now` },
    ];
    const act = findOurPendingAction(pending, paneId);
    assert.equal(act?.id, "exact");
  });

  it("returns undefined when pending is not an array", () => {
    assert.equal(findOurPendingAction(null, paneId), undefined);
    assert.equal(findOurPendingAction(undefined, paneId), undefined);
    assert.equal(findOurPendingAction({}, paneId), undefined);
  });

  it("returns undefined when pending array is empty", () => {
    assert.equal(findOurPendingAction([], paneId), undefined);
  });

  it("returns undefined when no create_pane action exists", () => {
    const pending = [{ id: "a1", capability: "other_cap", summary: "" }];
    assert.equal(findOurPendingAction(pending, paneId), undefined);
  });

  it("handles missing summary field (treats as empty string)", () => {
    const pending = [{ id: "a1", capability: "create_pane" }];
    const act = findOurPendingAction(pending, paneId);
    assert.equal(act?.id, "a1");
  });
});

// ---------------------------------------------------------------------------
// buildFrameHistogram
// ---------------------------------------------------------------------------
describe("buildFrameHistogram", () => {
  it("returns an empty object for an empty frames array", () => {
    assert.deepEqual(buildFrameHistogram([]), {});
  });

  it("counts a single frame type", () => {
    const frames = [{ type: "terminals_updated" }, { type: "terminals_updated" }];
    assert.deepEqual(buildFrameHistogram(frames), { terminals_updated: 2 });
  });

  it("counts multiple distinct frame types", () => {
    const frames = [
      { type: "terminals_updated" },
      { type: "stdout_chunk" },
      { type: "terminals_updated" },
      { type: "pane_status" },
      { type: "stdout_chunk" },
      { type: "stdout_chunk" },
    ];
    assert.deepEqual(buildFrameHistogram(frames), {
      terminals_updated: 2,
      stdout_chunk: 3,
      pane_status: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// paneHasMarker
// ---------------------------------------------------------------------------
describe("paneHasMarker", () => {
  it("returns true when backfill contains the marker", () => {
    assert.equal(paneHasMarker({ backfill: "ORBITAL_LIVE_1\nORBITAL_LIVE_2\n", output: "" }), true);
  });

  it("returns true when output contains the marker", () => {
    assert.equal(paneHasMarker({ backfill: "", output: "some text ORBITAL_LIVE_5 more" }), true);
  });

  it("returns true when both backfill and output are searched (marker in output only)", () => {
    assert.equal(paneHasMarker({ backfill: "no marker here", output: "ORBITAL_LIVE_10" }), true);
  });

  it("returns false when neither backfill nor output contains the marker", () => {
    assert.equal(paneHasMarker({ backfill: "some output", output: "more output" }), false);
  });

  it("returns false for null (guards against Array.isArray false + no-find returning false)", () => {
    assert.equal(paneHasMarker(null), false);
  });

  it("returns false for undefined", () => {
    assert.equal(paneHasMarker(undefined), false);
  });

  it("returns false for a plain false value (from Array.isArray(term) && term.find(...) returning false)", () => {
    assert.equal(paneHasMarker(false), false);
  });

  it("handles missing backfill/output fields (treats as empty strings)", () => {
    assert.equal(paneHasMarker({ id: "x" }), false);
    assert.equal(paneHasMarker({ id: "x", output: "ORBITAL_LIVE_3" }), true);
  });
});
