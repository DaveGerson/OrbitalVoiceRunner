// tests/test_voiceapprovalrouting_complexity_refactor.ts — CHARACTERIZATION harness for the
// cyclomatic-complexity burndown of src/voiceApprovalRouting.ts (resolvePendingActionByVoice,
// CC 18 -> ≤10). Every branch and edge of the PRE-refactor function is pinned here so a
// behavior-preserving extraction can be verified GREEN both before AND after the refactor.
//
// Runner: npx tsx --test --test-force-exit tests/test_voiceapprovalrouting_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { PendingActionStore } from "../src/pendingActions";
import { ACTION_DEFAULT_TTL_MS } from "../src/pendingActions";
import { MAX_DEFERRALS } from "../src/approvalIntent";
import { shouldRouteUtterance, resolvePendingActionByVoice } from "../src/voiceApprovalRouting";

function makeDeps(redact?: (s: string) => string) {
  const broadcasts: any[] = [];
  const narrations: string[] = [];
  return {
    broadcasts,
    narrations,
    deps: {
      broadcast: (m: any) => broadcasts.push(m),
      narrate: (t: string) => narrations.push(t),
      redact: redact ?? ((s: string) => s),
    },
  };
}

function stage(store: PendingActionStore, id: string, summary: string, run: () => string, timestamp = Date.now()) {
  store.add({ id, capability: "create_pane", summary, timestamp, run });
}

describe("shouldRouteUtterance (A4 gate)", () => {
  it("true for any non-whitespace content (incl. bare 2-char votes)", () => {
    for (const u of ["no", "ok", "go", "yes", "a", "  hi  "]) {
      assert.strictEqual(shouldRouteUtterance(u), true, `"${u}"`);
    }
  });
  it("false for empty / whitespace-only", () => {
    for (const u of ["", " ", "\t", "\n  ", "   \t\n"]) {
      assert.strictEqual(shouldRouteUtterance(u), false, JSON.stringify(u));
    }
  });
});

describe("resolvePendingActionByVoice — early-return guards", () => {
  it("intent 'none' (ambient speech) is a no-op even with staged actions", () => {
    const store = new PendingActionStore();
    stage(store, "act_1", "Create pane", () => "ok");
    const { broadcasts, narrations, deps } = makeDeps();
    resolvePendingActionByVoice("the weather is nice today", store, deps);
    assert.strictEqual(store.has("act_1"), true);
    assert.strictEqual(broadcasts.length, 0);
    assert.strictEqual(narrations.length, 0);
  });

  it("empty store is a no-op (no broadcast, no narration) even on a clear vote", () => {
    const store = new PendingActionStore();
    const { broadcasts, narrations, deps } = makeDeps();
    resolvePendingActionByVoice("approve", store, deps);
    assert.strictEqual(broadcasts.length, 0);
    assert.strictEqual(narrations.length, 0);
  });
});

describe("resolvePendingActionByVoice — clarify branch", () => {
  it("clarify with ONE pending: singular phrasing, no resolution", () => {
    const store = new PendingActionStore();
    stage(store, "act_1", "Create pane", () => "ok");
    const { broadcasts, narrations, deps } = makeDeps();
    // "approve but reject" => parser returns clarify
    resolvePendingActionByVoice("approve the command but reject it", store, deps);
    assert.strictEqual(store.has("act_1"), true);
    assert.strictEqual(broadcasts.length, 0);
    const t = narrations.at(-1) ?? "";
    assert.ok(t.includes("I heard both approve and reject"), t);
    assert.ok(t.includes("1 pending action") && !t.includes("actions"), `singular: ${t}`);
  });

  it("clarify with TWO pending: plural phrasing", () => {
    const store = new PendingActionStore();
    stage(store, "act_a", "Create pane A", () => "a");
    stage(store, "act_b", "Create pane B", () => "b");
    const { narrations, deps } = makeDeps();
    resolvePendingActionByVoice("approve the command but reject it", store, deps);
    const t = narrations.at(-1) ?? "";
    assert.ok(t.includes("2 pending actions"), `plural: ${t}`);
  });
});

describe("resolvePendingActionByVoice — ambiguous target read-back", () => {
  it("multi-pending approve, no disambiguator -> reads back redacted summaries, resolves nothing", () => {
    const store = new PendingActionStore();
    let ranA = 0, ranB = 0;
    stage(store, "act_a", "Create pane A", () => { ranA++; return "a"; });
    stage(store, "act_b", "Set permissions to Full Auto", () => { ranB++; return "b"; });
    const { broadcasts, narrations, deps } = makeDeps((s) => `<${s}>`);
    resolvePendingActionByVoice("approve", store, deps);
    assert.strictEqual(ranA, 0);
    assert.strictEqual(ranB, 0);
    assert.strictEqual(broadcasts.length, 0);
    const t = narrations.at(-1) ?? "";
    assert.ok(t.includes("I have 2 pending actions"), t);
    // numbered, redacted summaries joined with "; "
    assert.ok(t.includes("1. <Create pane A>"), t);
    assert.ok(t.includes("2. <Set permissions to Full Auto>"), t);
    assert.ok(t.includes("; "), t);
    assert.ok(t.endsWith("Which one?"), t);
  });
});

describe("resolvePendingActionByVoice — defer branch", () => {
  it("'ask me later' re-arms TTL in place, clears lastCallAt, increments deferCount; no resolve", () => {
    const store = new PendingActionStore();
    let ran = 0;
    const T0 = Date.now() - 60_000;
    stage(store, "act_1", "Create pane x", () => { ran++; return "ok"; }, T0);
    store.get("act_1")!.lastCallAt = T0 + 1;
    const { broadcasts, narrations, deps } = makeDeps();

    resolvePendingActionByVoice("ask me later", store, deps);

    assert.strictEqual(ran, 0);
    assert.ok(store.has("act_1"));
    assert.ok(!store.get("act_1")!.claimed);
    assert.ok(store.get("act_1")!.timestamp > T0, "TTL re-armed");
    assert.strictEqual(store.get("act_1")!.lastCallAt, undefined);
    assert.strictEqual((store.get("act_1") as any).deferCount, 1);
    assert.strictEqual(broadcasts.length, 0);
    const expectMin = Math.round(ACTION_DEFAULT_TTL_MS / 60000);
    assert.strictEqual(narrations.at(-1), `Holding it — I'll ask again in ${expectMin} minutes.`);
  });

  it("the (MAX+1)th defer hits the cap: window untouched, narrates the limit", () => {
    const store = new PendingActionStore();
    stage(store, "act_1", "Create pane x", () => "ok");
    const { narrations, deps } = makeDeps((s) => `[${s}]`);
    for (let i = 0; i < MAX_DEFERRALS; i++) resolvePendingActionByVoice("not now", store, deps);
    const armed = store.get("act_1")!.timestamp;
    narrations.length = 0;

    resolvePendingActionByVoice("not now", store, deps);

    assert.strictEqual(store.get("act_1")!.timestamp, armed, "window untouched at cap");
    assert.ok(store.has("act_1"));
    assert.strictEqual((store.get("act_1") as any).deferCount, MAX_DEFERRALS, "deferCount not incremented past cap");
    const t = narrations.at(-1) ?? "";
    assert.ok(t.includes(`already held that ${MAX_DEFERRALS} times`), t);
    assert.ok(t.includes("[Create pane x]"), `redacted summary in cap message: ${t}`);
    assert.ok(t.includes("needs a yes or a no now"), t);
  });
});

describe("resolvePendingActionByVoice — approve branch", () => {
  it("approve runs effect once, broadcasts confirmed, narrates redacted Done", () => {
    const store = new PendingActionStore();
    let ran = 0;
    stage(store, "act_1", "Create pane claude_new", () => { ran++; return "ok"; });
    const { broadcasts, narrations, deps } = makeDeps((s) => `«${s}»`);

    resolvePendingActionByVoice("approve", store, deps);

    assert.strictEqual(ran, 1);
    assert.strictEqual(store.has("act_1"), false);
    assert.deepStrictEqual(broadcasts, [{ type: "action_resolved", actionId: "act_1", outcome: "confirmed" }]);
    assert.strictEqual(narrations.at(-1), "Done — «Create pane claude_new».");
  });

  it("approve with a throwing run() does NOT propagate: broadcasts failed + narrates redacted failure", () => {
    const store = new PendingActionStore();
    stage(store, "act_boom", "Create pane that explodes", () => { throw new Error("boom"); });
    const { broadcasts, narrations, deps } = makeDeps((s) => `R(${s})`);

    assert.doesNotThrow(() => resolvePendingActionByVoice("approve", store, deps));

    assert.strictEqual(store.has("act_boom"), false);
    assert.deepStrictEqual(broadcasts, [
      { type: "action_resolved", actionId: "act_boom", outcome: "failed", error: "boom" },
    ]);
    assert.strictEqual(narrations.at(-1), "That action failed — R(Create pane that explodes): R(boom).");
  });

  it("approve thrown non-Error (string) surfaces String(e) as the error/message", () => {
    const store = new PendingActionStore();
    // eslint-disable-next-line no-throw-literal
    stage(store, "act_s", "Explodey", () => { throw "kaput"; });
    const { broadcasts, narrations, deps } = makeDeps();

    assert.doesNotThrow(() => resolvePendingActionByVoice("approve", store, deps));
    assert.deepStrictEqual(broadcasts, [
      { type: "action_resolved", actionId: "act_s", outcome: "failed", error: "kaput" },
    ]);
    assert.ok((narrations.at(-1) ?? "").includes("kaput"));
  });
});

describe("resolvePendingActionByVoice — reject branch", () => {
  it("reject cancels without running, broadcasts cancelled, narrates redacted Cancelled", () => {
    const store = new PendingActionStore();
    let ran = 0;
    stage(store, "act_1", "Create pane claude_new", () => { ran++; return "ok"; });
    const { broadcasts, narrations, deps } = makeDeps((s) => `~${s}~`);

    resolvePendingActionByVoice("reject", store, deps);

    assert.strictEqual(ran, 0);
    assert.strictEqual(store.has("act_1"), false);
    assert.deepStrictEqual(broadcasts, [{ type: "action_resolved", actionId: "act_1", outcome: "cancelled" }]);
    assert.strictEqual(narrations.at(-1), "Cancelled — ~Create pane claude_new~.");
  });
});

describe("resolvePendingActionByVoice — single-pending targeting", () => {
  it("with exactly one staged action, a bare vote resolves THAT one (via 'only')", () => {
    const store = new PendingActionStore();
    let ran = 0;
    stage(store, "the_only", "Run npm install", () => { ran++; return "ok"; });
    const { broadcasts, deps } = makeDeps();
    resolvePendingActionByVoice("yes", store, deps);
    assert.strictEqual(ran, 1);
    assert.deepStrictEqual(broadcasts, [{ type: "action_resolved", actionId: "the_only", outcome: "confirmed" }]);
  });
});
