// tests/test_composer_draft_pending.ts — CHARACTERIZATION tests for the pure draft-pending predicate
// extracted out of src/App.tsx renderHelperPanelTabs (bead dbt4 — App.tsx decomposition, chunk-2
// "composer-cluster"). Pins the badge gate that the right-rail "Sync Spec" header (HelperPanelTabHeader)
// uses to show its sync-spec-draft-badge pulse dot.
//
// This predicate INTENTIONALLY differs from the legacy mobile-nav dot (which gates on raw
// promptBuffer.length and ignores wipDrafts) — these tests pin that distinction.
//
// Runner: npx tsx --test --test-force-exit tests/test_composer_draft_pending.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { computeDraftPending } from "../src/classic/helpers/composerLogic";

describe("composerLogic — computeDraftPending", () => {
  it("false when the buffer is empty AND there are no WIP drafts", () => {
    assert.strictEqual(computeDraftPending("", []), false);
  });

  it("true when the (trimmed) buffer holds non-whitespace text", () => {
    assert.strictEqual(computeDraftPending("hello", []), true);
  });

  it("false when the buffer is whitespace-only AND there are no WIP drafts", () => {
    assert.strictEqual(computeDraftPending("   \n\t  ", []), false);
  });

  it("true when the buffer is empty BUT >=1 pane has a WIP draft", () => {
    assert.strictEqual(computeDraftPending("", [{ paneId: "p1" }]), true);
  });
});
