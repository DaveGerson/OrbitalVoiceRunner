// tests/test_handoff_drawer_reducer.ts — j4e1: pin the PURE handoff helpers the Line drawer rides.
//
// The handoff lifecycle (compose/revise/stage/deliver/reject) is server-tested but had ZERO UI; j4e1
// adds a per-station DRAWER on The Line. Its live data spine is the `handoffs_updated` WS frame, which
// the observe-lane reducer adopts through `handoffsFromFrame` — the SAME shape as the existing
// templates_updated/history_updated frame reducers (full array adopted, else null = refetch signal).
// `handoffStatusLabel` is the pure state→chip-label map the drawer renders. Both are PURE (no React,
// no fetch), so the node runner pins every branch here; the drawer render + REST wiring are pinned by
// e2e/orbital_handoff_drawer.spec.ts.
//
// Runner: npx tsx --test --test-force-exit tests/test_handoff_drawer_reducer.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { handoffsFromFrame, handoffStatusLabel, normalizeHandoffRows, groupHandoffsByPane } from "../src/orbital/useOrbitalDataHelpers";
import type { StoredHandoff } from "../src/store/types";

function mkHandoff(over: Partial<StoredHandoff> = {}): StoredHandoff {
  return {
    id: "h1", workspace_id: "mock_project", from_pane: "mock_pane_1", to_pane: "mock_pane_2",
    kind: "agent_instruction", composed_prompt: "run the tests", source_context: "{}",
    source_context_refs: "[]", state: "staged", gate_approval_id: null, approved_by: null,
    approved_via: null, revision_count: 0, created_at: 1, staged_at: 2, delivered_at: null,
    consumed_at: null, terminal_at: null, expires_at: null, ...over,
  };
}

describe("handoffsFromFrame", () => {
  it("adopts the full handoffs array when the frame carries one", () => {
    const rows = [mkHandoff(), mkHandoff({ id: "h2", state: "composing" })];
    assert.strictEqual(handoffsFromFrame({ handoffs: rows } as never), rows as never);
  });
  it("returns null when the frame carries no array (caller refetches GET /api/handoffs)", () => {
    assert.strictEqual(handoffsFromFrame({}), null);
    assert.strictEqual(handoffsFromFrame({ type: "handoffs_updated" } as never), null);
    assert.strictEqual(handoffsFromFrame({ handoffs: "nope" as unknown }), null);
    assert.strictEqual(handoffsFromFrame({ handoffs: null as unknown }), null);
  });
  it("an empty array is a real (adopted) value, not a refetch signal", () => {
    const empty: StoredHandoff[] = [];
    assert.strictEqual(handoffsFromFrame({ handoffs: empty } as never), empty as never);
  });
});

describe("normalizeHandoffRows", () => {
  it("coalesces the REST projection's handoff_id -> id and defaults the rest", () => {
    // The exact shape GET /api/handoffs (list_handoffs) emits per row: handoff_id, redacted prompt.
    const out = normalizeHandoffRows([
      { handoff_id: "h9", state: "staged", to_pane: "mock_pane_2", from_pane: "mock_pane_1", revision_count: 2, composed_prompt: "run it" },
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, "h9");
    assert.strictEqual(out[0].to_pane, "mock_pane_2");
    assert.strictEqual(out[0].from_pane, "mock_pane_1");
    assert.strictEqual(out[0].state, "staged");
    assert.strictEqual(out[0].revision_count, 2);
    assert.strictEqual(out[0].composed_prompt, "run it");
    // defaulted fields the projection omits
    assert.strictEqual(out[0].kind, "agent_instruction");
    assert.strictEqual(out[0].staged_at, null);
  });
  it("prefers a full-row `id` (cv2 frame) over handoff_id when both are present", () => {
    const out = normalizeHandoffRows([{ id: "real", handoff_id: "proj", to_pane: "p2", state: "delivered" }]);
    assert.strictEqual(out[0].id, "real");
  });
  it("drops malformed rows (no id, or no to_pane, or non-object) instead of crashing", () => {
    const out = normalizeHandoffRows([
      { state: "staged", to_pane: "p2" },            // no id → dropped
      { handoff_id: "h1" },                          // no to_pane → dropped
      null,                                          // non-object → dropped
      "nope",                                        // non-object → dropped
      { handoff_id: "ok", to_pane: "p2", state: "composing" }, // kept
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, "ok");
  });
  it("non-array input yields [] (never throws)", () => {
    assert.deepStrictEqual(normalizeHandoffRows(undefined), []);
    assert.deepStrictEqual(normalizeHandoffRows({}), []);
    assert.deepStrictEqual(normalizeHandoffRows("x"), []);
  });
});

describe("groupHandoffsByPane", () => {
  it("buckets handoffs by to_pane (preserving per-bucket order)", () => {
    const rows = [
      mkHandoff({ id: "a", to_pane: "p2" }),
      mkHandoff({ id: "b", to_pane: "p3" }),
      mkHandoff({ id: "c", to_pane: "p2" }),
    ];
    const by = groupHandoffsByPane(rows);
    assert.deepStrictEqual(Object.keys(by).sort(), ["p2", "p3"]);
    assert.deepStrictEqual(by.p2.map((h) => h.id), ["a", "c"]);
    assert.deepStrictEqual(by.p3.map((h) => h.id), ["b"]);
  });
  it("skips rows without a usable to_pane and yields {} for an empty list", () => {
    assert.deepStrictEqual(groupHandoffsByPane([]), {});
    const by = groupHandoffsByPane([mkHandoff({ id: "a", to_pane: "" }), mkHandoff({ id: "b", to_pane: "p2" })]);
    assert.deepStrictEqual(Object.keys(by), ["p2"]);
  });
});

describe("handoffStatusLabel", () => {
  it("maps each lifecycle state to a human chip label", () => {
    assert.strictEqual(handoffStatusLabel("composing"), "Drafting");
    assert.strictEqual(handoffStatusLabel("revising"), "Revising");
    assert.strictEqual(handoffStatusLabel("staged"), "Staged");
    assert.strictEqual(handoffStatusLabel("delivered"), "Delivered");
    assert.strictEqual(handoffStatusLabel("consumed"), "Consumed");
    assert.strictEqual(handoffStatusLabel("rejected"), "Rejected");
    assert.strictEqual(handoffStatusLabel("expired"), "Expired");
    assert.strictEqual(handoffStatusLabel("blocked_read_only"), "Blocked");
  });
  it("falls back to the raw state for an unknown value (degrade, never crash)", () => {
    assert.strictEqual(handoffStatusLabel("mystery" as never), "mystery");
  });
});
