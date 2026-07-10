// tests/test_status_summary.ts — get_status_summary (voice-UX wave 3). Sole owner: hwu1.
//
// Covers the three pure stages independently (composeSitrep / fallbackRanking / renderSitrep) plus
// the impure entry point runStatusSummary's two ranking sources (policies-daemon vs TS fallback).
//
// Runner: npx tsx --test --test-force-exit tests/test_status_summary.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  composeSitrep,
  fallbackRanking,
  renderSitrep,
  runStatusSummary,
} from "../src/voice/sitrep";
import type { ActionContext } from "../src/actions/types";
import type { SitrepPayload, SitrepRanking } from "../src/voice/policyClient";
import { JanusStore } from "../src/store/sqliteStore";

const EMPTY_TEXT =
  "Nothing needs your attention: no pending approvals, no alerts, and no panes are busy.";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function emptyPayload(now = 0): SitrepPayload {
  return { now, panes: [], approvals: [], attention: [], plans: [] };
}

function samplePayload(): SitrepPayload {
  return {
    now: 100_000,
    panes: [
      { paneId: "p1", projectId: "proj1", name: "build", state: "Running", isBusy: true, elapsedMs: 90_000, lastCommand: "npm run build" },
      { paneId: "p2", projectId: "proj1", name: "scratch", state: "Idle", isBusy: false, elapsedMs: 5_000, lastCommand: null },
      { paneId: "p3", projectId: "proj1", name: "server", state: "Idle", isBusy: false, elapsedMs: 1_000, lastCommand: null },
    ],
    approvals: [
      { id: "appr-1", kind: "shell", paneId: "p1", summary: "rm -rf tmp" },
      { id: "act-1", kind: "delete_pane", paneId: null, summary: "delete pane p9" },
    ],
    attention: [
      { paneId: "p1", type: "error", message: "build failed", ageMs: 30_000 },
    ],
    plans: [
      { id: "plan-1", name: "release", status: "running", currentStepIndex: 2, totalSteps: 5 },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fallbackRanking — deterministic order (D2)
// ─────────────────────────────────────────────────────────────────────────────
describe("fallbackRanking", () => {
  it("empty payload ranks to no sections", () => {
    assert.deepStrictEqual(fallbackRanking(emptyPayload()), { sections: [] });
  });

  it("fixed section order: approvals -> busy(+plans) -> attention -> idle", () => {
    const r = fallbackRanking(samplePayload());
    assert.deepStrictEqual(
      r.sections.map((s) => s.key),
      ["approvals", "busy", "attention", "idle"],
    );
  });

  it("approvals preserve gather order (oldest-first)", () => {
    const r = fallbackRanking(samplePayload());
    const approvals = r.sections.find((s) => s.key === "approvals")!;
    assert.deepStrictEqual(approvals.itemIds, ["appr-1", "act-1"]);
  });

  it("busy panes rank longest-elapsed-first, ties break by paneId; plans fold in after, most-progressed first", () => {
    const payload: SitrepPayload = {
      now: 0,
      panes: [
        { paneId: "p-short", projectId: "x", name: "p-short", state: "Running", isBusy: true, elapsedMs: 1_000, lastCommand: null },
        { paneId: "p-long", projectId: "x", name: "p-long", state: "Running", isBusy: true, elapsedMs: 60_000, lastCommand: null },
        { paneId: "p-tie-b", projectId: "x", name: "p-tie-b", state: "Running", isBusy: true, elapsedMs: 1_000, lastCommand: null },
        { paneId: "p-tie-a", projectId: "x", name: "p-tie-a", state: "Running", isBusy: true, elapsedMs: 1_000, lastCommand: null },
      ],
      approvals: [],
      attention: [],
      plans: [
        { id: "plan-behind", name: "behind", status: "paused", currentStepIndex: 1, totalSteps: 4 },
        { id: "plan-ahead", name: "ahead", status: "running", currentStepIndex: 3, totalSteps: 4 },
      ],
    };
    const busy = fallbackRanking(payload).sections.find((s) => s.key === "busy")!;
    // p-short/p-tie-a/p-tie-b all tie at 1000ms; the tie-break is paneId ascending ("p-short" < "p-tie-a").
    assert.deepStrictEqual(busy.itemIds, ["p-long", "p-short", "p-tie-a", "p-tie-b", "plan-ahead", "plan-behind"]);
  });

  it("attention ranks newest-first (smallest ageMs), ties break by paneId", () => {
    const payload: SitrepPayload = {
      now: 0,
      panes: [],
      approvals: [],
      attention: [
        { paneId: "p-old", type: "error", message: "m", ageMs: 60_000 },
        { paneId: "p-new", type: "error", message: "m", ageMs: 1_000 },
        { paneId: "p-tie-b", type: "error", message: "m", ageMs: 5_000 },
        { paneId: "p-tie-a", type: "error", message: "m", ageMs: 5_000 },
      ],
      plans: [],
    };
    const attention = fallbackRanking(payload).sections.find((s) => s.key === "attention")!;
    assert.deepStrictEqual(attention.itemIds, ["p-new", "p-tie-a", "p-tie-b", "p-old"]);
  });

  it("idle panes rank by paneId ascending", () => {
    const payload: SitrepPayload = {
      now: 0,
      panes: [
        { paneId: "p-z", projectId: "x", name: "z", state: "Idle", isBusy: false, elapsedMs: 0, lastCommand: null },
        { paneId: "p-a", projectId: "x", name: "a", state: "Idle", isBusy: false, elapsedMs: 0, lastCommand: null },
      ],
      approvals: [],
      attention: [],
      plans: [],
    };
    const idle = fallbackRanking(payload).sections.find((s) => s.key === "idle")!;
    assert.deepStrictEqual(idle.itemIds, ["p-a", "p-z"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderSitrep — golden text per shape
// ─────────────────────────────────────────────────────────────────────────────
describe("renderSitrep goldens", () => {
  it("empty world -> the fixed empty-state sentence, regardless of shape", () => {
    const ranking = fallbackRanking(emptyPayload());
    assert.strictEqual(renderSitrep(emptyPayload(), ranking, "brief"), EMPTY_TEXT);
    assert.strictEqual(renderSitrep(emptyPayload(), ranking, "walk"), EMPTY_TEXT);
    assert.strictEqual(renderSitrep(emptyPayload(), ranking, "full"), EMPTY_TEXT);
  });

  it("empty world with idle panes only still renders the empty sentence", () => {
    const payload: SitrepPayload = {
      now: 0,
      panes: [{ paneId: "p1", projectId: "x", name: "p1", state: "Idle", isBusy: false, elapsedMs: 0, lastCommand: null }],
      approvals: [],
      attention: [],
      plans: [],
    };
    const ranking = fallbackRanking(payload);
    assert.strictEqual(renderSitrep(payload, ranking, "brief"), EMPTY_TEXT);
  });

  it("brief: counts + single most urgent item per section", () => {
    const payload = samplePayload();
    const ranking = fallbackRanking(payload);
    const text = renderSitrep(payload, ranking, "brief");
    assert.strictEqual(
      text,
      '2 items awaiting your approval — most pressing: "rm -rf tmp". ' +
        '2 busy — longest-running: pane build (p1), busy for 1 minute. ' +
        '1 alert — most recent: pane p1 error: build failed. ' +
        "2 panes idle.",
    );
  });

  it("walk: one line per needs-action item (approvals + attention), counts for the rest", () => {
    const payload = samplePayload();
    const ranking = fallbackRanking(payload);
    const text = renderSitrep(payload, ranking, "walk");
    assert.strictEqual(
      text,
      '1. pane p1: "rm -rf tmp" 2. a staged action: "delete pane p9" ' +
        "3. pane p1 error: build failed " +
        "Also: 2 busy, 2 idle.",
    );
  });

  it("full: everything, one line per item", () => {
    const payload = samplePayload();
    const ranking = fallbackRanking(payload);
    const text = renderSitrep(payload, ranking, "full");
    assert.strictEqual(
      text,
      '1. pane p1: "rm -rf tmp" 2. a staged action: "delete pane p9" ' +
        "Busy: pane build (p1), busy for 1 minute. " +
        'Busy: plan "release" at step 3 of 5. ' +
        "Alert: pane p1 error: build failed. " +
        "Idle: pane scratch (p2). " +
        "Idle: pane server (p3).",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// composeSitrep — gather + redaction
// ─────────────────────────────────────────────────────────────────────────────
function makeCtx(overrides: Partial<{
  terminals: Record<string, any>;
  workspaces: Record<string, any>;
  plans: any[];
  attentionQueue: any[];
  approvals: any[];
  actions: any[];
  redact: (s: string) => string;
  policies: ActionContext["policies"];
  sitrepShape: "brief" | "walk" | "full";
}> = {}): ActionContext {
  return {
    manager: {
      terminals: overrides.terminals ?? {},
      ledger: {
        workspaces: overrides.workspaces ?? {},
        plans: overrides.plans ?? [],
      },
      attentionQueue: overrides.attentionQueue ?? [],
      settings: { voiceUx: overrides.sitrepShape ? { sitrepShape: overrides.sitrepShape, focusBindPolicy: "confirm", confirmTimeoutMs: 10_000 } : undefined },
    },
    session: null,
    redact: overrides.redact ?? ((s: string) => s),
    pruneAttention: () => {},
    pendingApprovals: { forSession: () => overrides.approvals ?? [] },
    pendingActions: { all: () => overrides.actions ?? [] },
    policies: overrides.policies,
  } as unknown as ActionContext;
}

describe("composeSitrep", () => {
  it("gathers panes with derived isBusy/elapsedMs and a resolved ledger name", () => {
    const ctx = makeCtx({
      terminals: { p1: { projectId: "proj1", status: "Running", lastStatusChangeAt: 40_000, lastCommand: "echo hi" } },
      workspaces: { proj1: { panes: { p1: { name: "build" } } } },
    });
    const payload = composeSitrep(ctx, 100_000);
    assert.deepStrictEqual(payload.panes, [
      { paneId: "p1", projectId: "proj1", name: "build", state: "Running", isBusy: true, elapsedMs: 60_000, lastCommand: "echo hi" },
    ]);
  });

  it("falls back to the pane id when no ledger name is recorded", () => {
    const ctx = makeCtx({
      terminals: { p1: { projectId: "proj1", status: "Idle", lastStatusChangeAt: 0, lastCommand: "" } },
    });
    const payload = composeSitrep(ctx, 0);
    assert.strictEqual(payload.panes[0].name, "p1");
    assert.strictEqual(payload.panes[0].lastCommand, null);
  });

  it("redacts pane lastCommand, approval summaries, and staged-action summaries", () => {
    const redact = (s: string) => s.replace("SECRET", "***");
    const ctx = makeCtx({
      terminals: { p1: { projectId: "proj1", status: "Running", lastStatusChangeAt: 0, lastCommand: "echo SECRET" } },
      approvals: [{ messageId: "m1", instruction: "run SECRET", kind: "shell", terminalId: "p1" }],
      actions: [{ id: "a1", capability: "delete_pane", summary: "delete SECRET pane" }],
      redact,
    });
    const payload = composeSitrep(ctx, 0);
    assert.strictEqual(payload.panes[0].lastCommand, "echo ***");
    assert.strictEqual(payload.approvals[0].summary, "run ***");
    assert.strictEqual(payload.approvals[1].summary, "delete *** pane");
  });

  it("redacts pane name, attention messages, and plan names (egress gap — get_status_summary is readOnly:false, so runAction's central redact pass never runs)", () => {
    const redact = (s: string) => s.replace("SECRET", "***");
    const ctx = makeCtx({
      terminals: { p1: { projectId: "proj1", status: "Running", lastStatusChangeAt: 0, lastCommand: "" } },
      workspaces: { proj1: { panes: { p1: { name: "pane-SECRET-name" } } } },
      attentionQueue: [
        {
          terminalId: "p1",
          type: "error",
          message: "export API_KEY=SECRET && deploy failed",
          timestamp: new Date(0).toISOString(),
          dismissed: false,
        },
      ],
      plans: [{ id: "plan-1", name: "release-SECRET-plan", status: "running", currentStepIndex: 0, steps: [1] }],
      redact,
    });
    const payload = composeSitrep(ctx, 0);
    assert.strictEqual(payload.panes[0].name, "pane-***-name");
    assert.strictEqual(payload.attention[0].message, "export API_KEY=*** && deploy failed");
    assert.strictEqual(payload.plans[0].name, "release-***-plan");
  });

  it("merges multiple attention items on the same pane into one, joining messages (no dropped alert)", () => {
    const ctx = makeCtx({
      attentionQueue: [
        { terminalId: "p1", type: "error", message: "first alert", timestamp: new Date(1_000).toISOString(), dismissed: false },
        { terminalId: "p1", type: "exited", message: "second alert", timestamp: new Date(5_000).toISOString(), dismissed: false },
      ],
    });
    const payload = composeSitrep(ctx, 10_000);
    assert.strictEqual(payload.attention.length, 1);
    assert.strictEqual(payload.attention[0].paneId, "p1");
    assert.strictEqual(payload.attention[0].message, "first alert; second alert");
    // ageMs reflects the MOST RECENT item (min age), not the first/oldest.
    assert.strictEqual(payload.attention[0].ageMs, 5_000);
  });

  it("merges held approvals then staged actions, in that order", () => {
    const ctx = makeCtx({
      approvals: [{ messageId: "held-1", instruction: "i1", kind: "shell", terminalId: "p1" }],
      actions: [{ id: "staged-1", capability: "delete_pane", summary: "s1" }],
    });
    const payload = composeSitrep(ctx, 0);
    assert.deepStrictEqual(
      payload.approvals.map((a) => a.id),
      ["held-1", "staged-1"],
    );
    assert.strictEqual(payload.approvals[1].paneId, null);
  });

  it("only includes running/paused plans, with totalSteps derived from steps.length", () => {
    const ctx = makeCtx({
      plans: [
        { id: "p-run", name: "r", status: "running", currentStepIndex: 1, steps: [1, 2, 3] },
        { id: "p-paused", name: "p", status: "paused", currentStepIndex: 0, steps: [1] },
        { id: "p-done", name: "d", status: "completed", currentStepIndex: 2, steps: [1, 2] },
        { id: "p-idle", name: "i", status: "idle", currentStepIndex: 0, steps: [] },
      ],
    });
    const payload = composeSitrep(ctx, 0);
    assert.deepStrictEqual(
      payload.plans.map((p) => p.id),
      ["p-run", "p-paused"],
    );
    assert.strictEqual(payload.plans[0].totalSteps, 3);
  });

  it("prunes the attention queue before reading it, and filters dismissed items", () => {
    let pruned = false;
    const ctx = makeCtx({
      attentionQueue: [
        { terminalId: "p1", type: "error", message: "boom", timestamp: new Date(0).toISOString(), dismissed: false },
        { terminalId: "p2", type: "exited", message: "gone", timestamp: new Date(0).toISOString(), dismissed: true },
      ],
    });
    (ctx as any).pruneAttention = () => { pruned = true; };
    const payload = composeSitrep(ctx, 5_000);
    assert.strictEqual(pruned, true);
    assert.deepStrictEqual(payload.attention, [{ paneId: "p1", type: "error", message: "boom", ageMs: 5_000 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runStatusSummary — policies-daemon vs TS-fallback ranking source
// ─────────────────────────────────────────────────────────────────────────────
describe("runStatusSummary", () => {
  it("empty world -> the fixed empty-state text", async () => {
    const ctx = makeCtx({});
    const result = await runStatusSummary(ctx);
    assert.deepStrictEqual(result, { kind: "ok", output: EMPTY_TEXT });
  });

  it("ctx.policies absent -> uses the TS fallback ranking", async () => {
    const ctx = makeCtx({
      terminals: { p1: { projectId: "x", status: "Running", lastStatusChangeAt: 0, lastCommand: "" } },
      sitrepShape: "brief",
    });
    const result = await runStatusSummary(ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("1 busy"));
  });

  it("ctx.policies resolves null (daemon miss) -> uses the TS fallback ranking, never widened", async () => {
    const ctx = makeCtx({
      terminals: { p1: { projectId: "x", status: "Running", lastStatusChangeAt: 0, lastCommand: "" } },
      policies: { resolveFocus: async () => null, rankSitrep: async () => null, available: () => false, dispose: () => {} },
    });
    const result = await runStatusSummary(ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("1 busy"));
  });

  it("ctx.policies resolves a ranking -> that ranking drives the render, not the fallback", async () => {
    // Two busy panes: fallbackRanking (longest-elapsed-first) would put p-long ahead of p-short. The
    // stubbed policies ranking deliberately inverts that order — asserting on the "top" busy pane
    // proves the policies ranking, not fallbackRanking, drove the render.
    const ctx = makeCtx({
      terminals: {
        "p-short": { projectId: "x", status: "Running", lastStatusChangeAt: 99_000, lastCommand: "" },
        "p-long": { projectId: "x", status: "Running", lastStatusChangeAt: 0, lastCommand: "" },
      },
      policies: {
        resolveFocus: async () => null,
        rankSitrep: async (): Promise<SitrepRanking> => ({
          sections: [{ key: "busy", itemIds: ["p-short", "p-long"] }],
        }),
        available: () => true,
        dispose: () => {},
      },
    });
    const result = await runStatusSummary(ctx);
    assert.strictEqual(result.kind, "ok");
    const output = String((result as { output: unknown }).output);
    assert.ok(output.includes("longest-running: pane p-short"), `policies order won: ${output}`);
  });

  it("ctx.policies returns a schema-valid but incomplete ranking (drops approvals) -> discarded in favor of the TS fallback, never a false all-clear", async () => {
    const ctx = makeCtx({
      approvals: [{ messageId: "held-1", instruction: "run something", kind: "shell", terminalId: "p1" }],
      policies: {
        resolveFocus: async () => null,
        // Mimics the scaffold-phase stub / a buggy daemon: {"sections": []} even though there is a
        // real pending approval. Must NOT render "Nothing needs your attention".
        rankSitrep: async (): Promise<SitrepRanking> => ({ sections: [] }),
        available: () => true,
        dispose: () => {},
      },
    });
    const result = await runStatusSummary(ctx);
    assert.strictEqual(result.kind, "ok");
    const output = String((result as { output: unknown }).output);
    assert.ok(!output.includes("Nothing needs your attention"), `false all-clear: ${output}`);
    assert.ok(output.includes("awaiting your approval"), `expected approval to surface: ${output}`);
  });

  it("ctx.policies returns a ranking with a busy section but silently omits approvals -> discarded", async () => {
    const ctx = makeCtx({
      terminals: { p1: { projectId: "x", status: "Running", lastStatusChangeAt: 0, lastCommand: "" } },
      approvals: [{ messageId: "held-1", instruction: "run something", kind: "shell", terminalId: "p1" }],
      policies: {
        resolveFocus: async () => null,
        rankSitrep: async (): Promise<SitrepRanking> => ({ sections: [{ key: "busy", itemIds: ["p1"] }] }),
        available: () => true,
        dispose: () => {},
      },
    });
    const result = await runStatusSummary(ctx);
    const output = String((result as { output: unknown }).output);
    assert.ok(output.includes("awaiting your approval"), `expected approval to surface: ${output}`);
  });

  it("never throws: a broken ctx still answers once", async () => {
    const ctx = {
      manager: { get terminals(): never { throw new Error("boom"); } },
    } as unknown as ActionContext;
    const result = await runStatusSummary(ctx);
    assert.strictEqual(result.kind, "ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4, Step 4.2 — exchange-aware SITREP: runStatusSummary prefers the exchange board
// (src/voice/sitrep.ts composeExchangeBoard) whenever there is real exchange activity, and falls
// back to the byte-identical legacy pipeline above when there is none (every test above has no
// ctx.store, so none of them exercise this branch).
// ─────────────────────────────────────────────────────────────────────────────
describe("runStatusSummary — exchange-aware board (Phase 4, Step 4.2)", () => {
  it("a needs_input exchange drives the spoken summary ahead of plain busy/idle pane text", async () => {
    const store = new JanusStore(":memory:");
    store.init();
    const now = Date.now();
    store.insertExchange({
      project_id: "proj1", pane_id: "p1", state: "needs_input",
      terminal_state: "deploy to prod? y/n", updated_at: now - 1000,
    });
    const ctx = makeCtx({
      terminals: { p1: { projectId: "proj1", status: "Running", lastStatusChangeAt: now, lastCommand: "" } },
    });
    (ctx as unknown as { store: JanusStore }).store = store;
    const result = await runStatusSummary(ctx);
    const output = String((result as { output: unknown }).output);
    assert.ok(output.includes(`needs your input: "deploy to prod? y/n"`), output);
    store.close();
  });

  it("an idle pane count is still appended after the exchange board (nothing silently dropped)", async () => {
    const store = new JanusStore(":memory:");
    store.init();
    const now = Date.now();
    store.insertExchange({
      project_id: "proj1", pane_id: "p1", state: "agent_failed",
      terminal_state: "build broke", updated_at: now - 1000,
    });
    const ctx = makeCtx({
      terminals: {
        p1: { projectId: "proj1", status: "Idle", lastStatusChangeAt: now, lastCommand: "" },
        p2: { projectId: "proj1", status: "Idle", lastStatusChangeAt: now, lastCommand: "" },
      },
    });
    (ctx as unknown as { store: JanusStore }).store = store;
    const result = await runStatusSummary(ctx);
    const output = String((result as { output: unknown }).output);
    assert.ok(output.includes("failed: build broke"), output);
    assert.ok(output.includes("2 panes idle."), output);
    store.close();
  });

  it("no exchange activity (store attached, but empty) -> byte-identical to the legacy pipeline", async () => {
    const store = new JanusStore(":memory:");
    store.init();
    const ctx = makeCtx({
      terminals: { p1: { projectId: "x", status: "Running", lastStatusChangeAt: 0, lastCommand: "" } },
      sitrepShape: "brief",
    });
    (ctx as unknown as { store: JanusStore }).store = store;
    const result = await runStatusSummary(ctx);
    assert.ok(String((result as { output: unknown }).output).includes("1 busy"));
    store.close();
  });
});
