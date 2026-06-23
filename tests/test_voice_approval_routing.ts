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
import { shouldRouteUtterance, resolvePendingActionByVoice, resolveHeldCommandByVoice } from "../src/voiceApprovalRouting";
import type { TargetableEntry } from "../src/approvalIntent";

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

// bead 8xn — resolveHeldCommandByVoice: the pure sibling of resolvePendingActionByVoice, for HELD
// pane-WRITE commands (pendingApprovals / the approval-dialog), keyed by messageId. Behavior is the
// byte-for-byte extraction of routeApprovalIntent's held-entries branch (src/voice/index.ts): the
// same parseApprovalIntent → selectApprovalTarget disambiguation, with the PTY/store/broadcast
// effects injected as `onResolve(messageId, approve)` / `onDefer(messageId)` sinks. The server rewire
// (test_approvals_wse.ts) pins that the live path still behaves identically.
function makeHeldDeps() {
  const narrations: string[] = [];
  const resolves: { messageId: string; approve: boolean }[] = [];
  const defers: string[] = [];
  return {
    narrations,
    resolves,
    defers,
    deps: {
      narrate: (t: string) => narrations.push(t),
      redact: (s: string) => s,
      onResolve: (messageId: string, approve: boolean) => resolves.push({ messageId, approve }),
      onDefer: (messageId: string) => defers.push(messageId),
    },
  };
}
function held(messageId: string, instruction: string, terminalId = "claude_1"): TargetableEntry {
  return { messageId, instruction, terminalId };
}

describe("8xn — resolveHeldCommandByVoice (held pane-write voice resolution)", () => {
  it("a single held command + 'approve' resolves it (messageId, approve=true)", () => {
    const { resolves, defers, deps } = makeHeldDeps();
    resolveHeldCommandByVoice("approve", [held("msg_1", "rm -rf build")], null, deps);
    assert.deepStrictEqual(resolves, [{ messageId: "msg_1", approve: true }]);
    assert.strictEqual(defers.length, 0);
  });

  it("'reject' resolves with approve=false", () => {
    const { resolves, deps } = makeHeldDeps();
    resolveHeldCommandByVoice("reject", [held("msg_1", "drop table users")], null, deps);
    assert.deepStrictEqual(resolves, [{ messageId: "msg_1", approve: false }]);
  });

  it("'later' / 'not now' defers (onDefer), never resolves", () => {
    for (const u of ["later", "not now", "hold that"]) {
      const { resolves, defers, deps } = makeHeldDeps();
      resolveHeldCommandByVoice(u, [held("msg_1", "deploy")], null, deps);
      assert.deepStrictEqual(defers, ["msg_1"], `"${u}" must defer`);
      assert.strictEqual(resolves.length, 0, `"${u}" must not resolve`);
    }
  });

  it("'none' (ambient speech) and an empty held list are both no-ops", () => {
    const a = makeHeldDeps();
    resolveHeldCommandByVoice("the weather is nice", [held("msg_1", "deploy")], null, a.deps);
    assert.strictEqual(a.resolves.length + a.defers.length + a.narrations.length, 0);

    const b = makeHeldDeps();
    resolveHeldCommandByVoice("approve", [], null, b.deps);
    assert.strictEqual(b.resolves.length + b.defers.length + b.narrations.length, 0);
  });

  it("a 'clarify' utterance (both approve AND reject) reads back the pending count, resolves nothing", () => {
    const { resolves, narrations, deps } = makeHeldDeps();
    resolveHeldCommandByVoice("yes no", [held("msg_1", "a"), held("msg_2", "b")], null, deps);
    assert.strictEqual(resolves.length, 0);
    const text = narrations.at(-1) ?? "";
    assert.ok(text.includes("approve and reject"), "asks which they meant");
    assert.ok(text.includes("2"), "names the pending count");
  });

  it("multi-held + bare 'approve' (no hint, no lastAnnounced) reads back the redacted list, resolves nothing", () => {
    const { resolves, defers, narrations, deps } = makeHeldDeps();
    resolveHeldCommandByVoice(
      "approve",
      [held("msg_1", "deploy to prod", "deploy_pane"), held("msg_2", "run migrations", "db_pane")],
      null,
      deps,
    );
    assert.strictEqual(resolves.length, 0);
    assert.strictEqual(defers.length, 0);
    const text = narrations.at(-1) ?? "";
    assert.ok(text.includes("I have 2 pending"), "reads back the count");
    assert.ok(text.includes("deploy to prod") && text.includes("run migrations"), "lists both instructions");
    assert.ok(text.includes("deploy_pane") && text.includes("db_pane"), "names each pane");
  });

  it("multi-held + a fragment hint resolves the UNIQUE matching target", () => {
    const { resolves, deps } = makeHeldDeps();
    resolveHeldCommandByVoice(
      "approve the migrations one",
      [held("msg_1", "deploy to prod", "deploy_pane"), held("msg_2", "run migrations", "db_pane")],
      null,
      deps,
    );
    assert.deepStrictEqual(resolves, [{ messageId: "msg_2", approve: true }]);
  });

  it("multi-held + lastAnnouncedId resolves the most-recently-announced one", () => {
    const { resolves, deps } = makeHeldDeps();
    resolveHeldCommandByVoice(
      "approve",
      [held("msg_1", "deploy to prod"), held("msg_2", "run migrations")],
      "msg_2",
      deps,
    );
    assert.deepStrictEqual(resolves, [{ messageId: "msg_2", approve: true }]);
  });

  it("a throwing onResolve does NOT propagate is NOT this fn's job — it injects effects; the sink owns try/catch (parity with the server's resolveApprovalByVoice)", () => {
    // Documents the contract boundary: resolveHeldCommandByVoice only DECIDES + injects; the sink
    // (resolveApprovalByVoice → applyResolution) carries the claim/redaction/exactly-once guarantees.
    const { resolves, deps } = makeHeldDeps();
    resolveHeldCommandByVoice("approve", [held("only", "one thing")], null, deps);
    assert.deepStrictEqual(resolves, [{ messageId: "only", approve: true }]);
  });
});
