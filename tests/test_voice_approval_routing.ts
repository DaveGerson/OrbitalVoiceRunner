// tests/test_voice_approval_routing.ts — REAL voice-approval routing (A4 + A5), extracted from the
// server's onmessage inline block so the SERVER runs the same code these tests exercise (retiring the
// mirror-drift hazard in test_approvals_wse.ts, where a hand-copied re-implementation could diverge
// from server.ts silently).
//
// A4 — short-utterance gate: bare votes ("no"/"ok"/"go", 2 chars) must REACH the parser. The old
//      server guard `cleanUtter.length > 2` amputated them before parseApprovalIntent (which already
//      resolves bare yes/no). shouldRouteUtterance encodes the corrected contract: route any utterance
//      with non-whitespace content; drop only empty/whitespace noise.
// A5 — a staged action whose run() THROWS on confirm must NOT crash the voice handler. confirm()
//      removes the record THEN runs it (pendingActions.ts) and rethrows, so the voice path must mirror
//      REST's try/catch: tell the operator + UI the action FAILED instead of unwinding silently.
//
// Runner: npx tsx --test --test-force-exit tests/test_voice_approval_routing.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { PendingActionStore } from "../src/pendingActions";
import { shouldRouteUtterance, resolvePendingActionByVoice } from "../src/voiceApprovalRouting";

function makeDeps() {
  const broadcasts: any[] = [];
  const narrations: string[] = [];
  return {
    broadcasts,
    narrations,
    deps: {
      broadcast: (m: any) => broadcasts.push(m),
      narrate: (t: string) => narrations.push(t),
      redact: (s: string) => s,
    },
  };
}

function stage(store: PendingActionStore, id: string, summary: string, run: () => string) {
  store.add({ id, capability: "create_pane", summary, timestamp: Date.now(), run });
}

describe("A4 — shouldRouteUtterance (short-utterance gate)", () => {
  it("routes bare 2-char votes that the old `> 2` guard dropped", () => {
    for (const u of ["no", "ok", "go", "yes", "approve", "reject"]) {
      assert.strictEqual(shouldRouteUtterance(u), true, `"${u}" must reach the parser`);
    }
  });
  it("drops empty / whitespace-only noise", () => {
    for (const u of ["", " ", "\t", "\n  "]) {
      assert.strictEqual(shouldRouteUtterance(u), false, `"${JSON.stringify(u)}" must be dropped`);
    }
  });
});

describe("A5 — resolvePendingActionByVoice (real staged-action voice resolution)", () => {
  it("approve runs the staged effect exactly once, broadcasts confirmed, narrates Done", () => {
    const store = new PendingActionStore();
    let ran = 0;
    stage(store, "act_1", "Create pane claude_new", () => { ran++; return "ok"; });
    const { broadcasts, narrations, deps } = makeDeps();

    resolvePendingActionByVoice("approve", store, deps);

    assert.strictEqual(ran, 1);
    assert.strictEqual(store.has("act_1"), false);
    assert.deepStrictEqual(broadcasts, [{ type: "action_resolved", actionId: "act_1", outcome: "confirmed" }]);
    assert.ok(narrations.at(-1)?.includes("Done"), "operator hears the success");
  });

  it("reject cancels without running and narrates Cancelled", () => {
    const store = new PendingActionStore();
    let ran = 0;
    stage(store, "act_1", "Create pane claude_new", () => { ran++; return "ok"; });
    const { broadcasts, narrations, deps } = makeDeps();

    resolvePendingActionByVoice("reject", store, deps);

    assert.strictEqual(ran, 0);
    assert.strictEqual(store.has("act_1"), false);
    assert.deepStrictEqual(broadcasts, [{ type: "action_resolved", actionId: "act_1", outcome: "cancelled" }]);
    assert.ok(narrations.at(-1)?.includes("Cancelled"));
  });

  it("A5: a throwing run() on approve does NOT propagate — it broadcasts failed and narrates the failure", () => {
    const store = new PendingActionStore();
    stage(store, "act_boom", "Create pane that explodes", () => { throw new Error("boom"); });
    const { broadcasts, narrations, deps } = makeDeps();

    // The whole point: this call must NOT throw.
    assert.doesNotThrow(() => resolvePendingActionByVoice("approve", store, deps));

    assert.strictEqual(store.has("act_boom"), false, "confirm() removed the record before run() threw");
    assert.deepStrictEqual(
      broadcasts,
      [{ type: "action_resolved", actionId: "act_boom", outcome: "failed", error: "boom" }],
      "UI is told the action terminally failed (so it stops showing it as pending)",
    );
    const last = narrations.at(-1) ?? "";
    assert.ok(last.includes("failed"), "operator hears a coherent failure, not silence");
    assert.ok(last.includes("boom"), "the failure reason is surfaced");
  });

  it("a 'none' utterance and an empty store are both no-ops", () => {
    const store = new PendingActionStore();
    stage(store, "act_1", "Create pane", () => "ok");
    const a = makeDeps();
    resolvePendingActionByVoice("the weather is nice", store, a.deps); // parses to none
    assert.strictEqual(store.has("act_1"), true);
    assert.strictEqual(a.broadcasts.length, 0);

    const empty = new PendingActionStore();
    const b = makeDeps();
    resolvePendingActionByVoice("approve", empty, b.deps);
    assert.strictEqual(b.broadcasts.length, 0);
    assert.strictEqual(b.narrations.length, 0);
  });

  it("multi-pending approve with no disambiguator reads back summaries and resolves nothing", () => {
    const store = new PendingActionStore();
    let ranA = 0, ranB = 0;
    stage(store, "act_a", "Create pane A", () => { ranA++; return "a"; });
    stage(store, "act_b", "Set global permissions to Full Auto", () => { ranB++; return "b"; });
    const { broadcasts, narrations, deps } = makeDeps();

    resolvePendingActionByVoice("approve", store, deps);

    assert.strictEqual(ranA, 0);
    assert.strictEqual(ranB, 0);
    assert.strictEqual(broadcasts.length, 0);
    const text = narrations.at(-1) ?? "";
    assert.ok(text.includes("Create pane A") && text.includes("Set global permissions to Full Auto"));
  });
});
