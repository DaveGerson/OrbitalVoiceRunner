// tests/test_exchange_recovery_actions.ts
//
// AgentExchange spine — the OPERATOR-FACING RECOVERY ACTIONS (Phase 4, Step 4.3; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §4). Pins src/exchanges/
// recoveryActions.ts: resume-inspect (read-only), retry (guarded, never-automatic), and cancel —
// operating DIRECTLY on the durable store (never the in-memory ExchangeMachine), because a
// recovery action's whole reason to exist is acting on an exchange that may have been quarantined
// in a PRIOR process lifetime. See that module's own doc for the full retry-policy reconciliation
// against the spec's "never auto-resume" hard rule (interrupted exchanges always get a NEW
// follow-up exchange; only a provably-failed `draft` resumes the SAME one — no lifecycle-machine
// change was needed for either case).

import { describe, it } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import { ExchangeService } from "../src/exchanges/service";
import {
  resumeInspectExchange,
  classifyRetryEligibility,
  retryExchange,
  cancelExchangeDurable,
  openExchangePane,
} from "../src/exchanges/recoveryActions";
import type { ExchangeState } from "../src/exchanges/lifecycle";
import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import type { ActionContext, GateDisposition } from "../src/actions/types";
import type { ResumeInspectView, OpenExchangePaneView } from "../src/exchanges/recoveryActions";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

function freshSvc(store: JanusStore): ExchangeService {
  return new ExchangeService({ store });
}

function liveTerm(): { writeInput: (s: string) => void; status?: string; calls: string[] } {
  const calls: string[] = [];
  return { writeInput: (s: string) => { calls.push(s); }, status: "Running", calls };
}

describe("recoveryActions: resumeInspectExchange (read-only)", () => {
  it("returns the exchange row + recent events, newest first, bounded", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "interrupted" });
    for (let i = 0; i < 3; i++) {
      s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "terminal_running", ts: 1000 + i });
    }
    const view = resumeInspectExchange(s, row.exchange_id, { limit: 2 });
    assert.ok(view);
    assert.strictEqual(view!.exchange.exchange_id, row.exchange_id);
    assert.strictEqual(view!.recentEvents.length, 2, "bounded to the limit");
    assert.ok(view!.recentEvents[0].ts >= view!.recentEvents[1].ts, "newest first");
    s.close();
  });

  it("returns null for an unknown exchange id", () => {
    const s = freshStore();
    assert.strictEqual(resumeInspectExchange(s, "exch-nope"), null);
    s.close();
  });
});

describe("recoveryActions: classifyRetryEligibility (pure)", () => {
  it("interrupted -> new_exchange (never a same-exchange resume, spec §4 hard rule)", () => {
    const row = { state: "interrupted" } as any;
    assert.deepStrictEqual(classifyRetryEligibility(row, []), { kind: "new_exchange" });
  });

  it("draft whose LAST event is delivery_failed -> same_exchange (provably failed — certain nothing landed)", () => {
    const row = { state: "draft" } as any;
    const events = [{ event_type: "delivery_attempted" }, { event_type: "delivery_failed" }] as any;
    assert.deepStrictEqual(classifyRetryEligibility(row, events), { kind: "same_exchange" });
  });

  it("draft with NO delivery_failed as the last event -> refused (never sent, or approval merely vanished)", () => {
    const row = { state: "draft" } as any;
    assert.strictEqual(classifyRetryEligibility(row, []).kind, "refused");
    const reverted = [{ event_type: "exchange_recovered" }] as any; // recovery.ts's approval-vanished revert
    assert.strictEqual(classifyRetryEligibility(row, reverted).kind, "refused");
  });

  for (const state of ["agent_complete", "agent_failed", "cancelled"] as ExchangeState[]) {
    it(`${state} (terminal) -> refused, "already settled"`, () => {
      const result = classifyRetryEligibility({ state } as any, []);
      assert.strictEqual(result.kind, "refused");
      assert.match((result as any).reason, /already settled/);
    });
  }

  for (const state of ["awaiting_clarification", "awaiting_approval", "staged", "delivered", "running", "needs_input", "terminal_idle"] as ExchangeState[]) {
    it(`${state} -> refused (not provably failed, still resolvable through its own normal path)`, () => {
      assert.strictEqual(classifyRetryEligibility({ state } as any, []).kind, "refused");
    });
  }
});

describe("recoveryActions: retryExchange — interrupted -> ALWAYS a new follow-up exchange", () => {
  it("creates a brand-new draft exchange pre-filled from the original; the ORIGINAL is left untouched", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const original = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "interrupted",
      distilled_instruction: "fix the bug", operator_utterance: "please fix the bug",
      instruction_envelope_json: JSON.stringify({ kind: "envelope_draft" }),
    });

    const outcome = retryExchange(s, svc, original.exchange_id, liveTerm());

    assert.strictEqual(outcome.kind, "new_exchange");
    assert.ok(outcome.exchangeId && outcome.exchangeId !== original.exchange_id);
    const fresh = s.getExchange(outcome.exchangeId!)!;
    assert.strictEqual(fresh.state, "draft");
    assert.strictEqual(fresh.distilled_instruction, "fix the bug");
    assert.strictEqual(fresh.pane_id, "pane-1");
    assert.strictEqual(fresh.instruction_envelope_json, JSON.stringify({ kind: "envelope_draft" }));
    const events = s.listExchangeEvents(fresh.exchange_id);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, "exchange_created");
    assert.strictEqual(JSON.parse(events[0].payload_redacted_json).follow_up_of, original.exchange_id);

    // The original is completely unchanged — still interrupted, still independently cancellable.
    const untouched = s.getExchange(original.exchange_id)!;
    assert.strictEqual(untouched.state, "interrupted");
    assert.deepStrictEqual(s.listExchangeEvents(original.exchange_id), []);
    s.close();
  });

  it("does NOT bind the new draft's pane as 'active' — a draft has nothing in flight to correlate a pane signal against", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const original = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "interrupted" });
    retryExchange(s, svc, original.exchange_id, liveTerm());
    assert.strictEqual(svc.activeExchangeForPane("pane-1"), undefined);
    s.close();
  });

  it("DOUBLE-FIRE idempotency (4.5 review): a rapid repeat returns the SAME open follow-up draft instead of minting a duplicate", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const original = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "interrupted", distilled_instruction: "fix the bug",
    });

    const first = retryExchange(s, svc, original.exchange_id, liveTerm());
    const second = retryExchange(s, svc, original.exchange_id, liveTerm()); // e.g. a client retrying a timed-out POST

    assert.strictEqual(first.kind, "new_exchange");
    assert.strictEqual(second.kind, "new_exchange");
    assert.strictEqual(second.exchangeId, first.exchangeId, "the repeat resolves to the SAME open follow-up draft");
    assert.match(second.message, /already has an open follow-up draft/);
    const drafts = s.listExchangesByStates(["draft"]).filter((r) => r.pane_id === "pane-1");
    assert.strictEqual(drafts.length, 1, "exactly ONE follow-up draft exists after the double-fire");
    // The original is still untouched by both calls (the pinned "never touches the original" contract).
    assert.deepStrictEqual(s.listExchangeEvents(original.exchange_id), []);
    s.close();
  });

  it("a follow-up that already MOVED past draft no longer blocks a fresh retry (a later retry is a new operator decision)", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const original = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "interrupted", distilled_instruction: "fix it" });
    const first = retryExchange(s, svc, original.exchange_id, liveTerm());
    // The operator cancelled the first follow-up draft; a fresh retry may mint a new one.
    assert.ok(s.updateExchange(first.exchangeId!, { state: "cancelled" }, { state: "draft" }).changed);
    const second = retryExchange(s, svc, original.exchange_id, liveTerm());
    assert.strictEqual(second.kind, "new_exchange");
    assert.notStrictEqual(second.exchangeId, first.exchangeId, "a genuinely fresh follow-up draft this time");
    s.close();
  });
});

describe("recoveryActions: retryExchange — provably-failed draft -> SAME exchange", () => {
  it("re-delivers on the SAME exchange: delivery_attempt increments, ends 'delivered', writes to the live pane", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "draft", delivery_attempt: 1,
      distilled_instruction: "run the tests",
    });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_failed", ts: 1000 });
    const term = liveTerm();

    const outcome = retryExchange(s, svc, row.exchange_id, term);

    assert.strictEqual(outcome.kind, "same_exchange");
    assert.strictEqual(outcome.exchangeId, row.exchange_id);
    assert.deepStrictEqual(term.calls, ["run the tests"], "the SAME distilled instruction is redelivered");
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "delivered");
    assert.strictEqual(after.delivery_attempt, 2, "a genuinely NEW delivery attempt, not a phantom repeat");
    assert.ok(after.delivered_at);

    const events = s.listExchangeEvents(row.exchange_id).map((e) => e.event_type);
    assert.deepStrictEqual(events, ["delivery_failed", "retry_initiated", "delivery_succeeded"]);

    // Live correlation: a subsequent pane signal (idle/running/needs_input) must be able to settle
    // THIS exchange — adoptExchangeSnapshot must have bound it as pane-1's active exchange.
    assert.strictEqual(svc.activeExchangeForPane("pane-1"), row.exchange_id);
    assert.strictEqual(svc.get(row.exchange_id)?.state, "delivered");
    s.close();
  });

  it("refuses when the pane is not live (no term) — never silently drops the retry as a fake success", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_failed", ts: 1000 });

    const outcome = retryExchange(s, svc, row.exchange_id, undefined);

    assert.strictEqual(outcome.kind, "refused");
    assert.match(outcome.message, /not live/);
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "draft", "no state change on refusal");
    s.close();
  });

  it("refuses when the pane's term.status is 'Exited'", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_failed", ts: 1000 });

    const outcome = retryExchange(s, svc, row.exchange_id, { writeInput: () => {}, status: "Exited" });

    assert.strictEqual(outcome.kind, "refused");
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "draft");
    s.close();
  });

  it("a write that THROWS reverts the exchange back to draft (never stranded 'staged') and records delivery_failed", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft", delivery_attempt: 1 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_failed", ts: 1000 });
    const throwingTerm = { writeInput: () => { throw new Error("pty gone"); }, status: "Running" };

    const outcome = retryExchange(s, svc, row.exchange_id, throwingTerm);

    assert.strictEqual(outcome.kind, "refused");
    assert.match(outcome.message, /pty gone/);
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "draft", "reverted, not left stranded at 'staged'");
    assert.strictEqual(after.delivery_attempt, 2, "the attempt is preserved as forensic evidence, not erased");
    const events = s.listExchangeEvents(row.exchange_id).map((e) => e.event_type);
    assert.deepStrictEqual(events, ["delivery_failed", "retry_initiated", "delivery_failed"]);
    s.close();
  });

  it("refuses a not-found exchange id", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const outcome = retryExchange(s, svc, "exch-nope", liveTerm());
    assert.strictEqual(outcome.kind, "refused");
    assert.match(outcome.message, /not found/);
    s.close();
  });

  it("refuses a draft that was never provably failed — states the uncertainty, no silent guess", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" }); // never sent
    const outcome = retryExchange(s, svc, row.exchange_id, liveTerm());
    assert.strictEqual(outcome.kind, "refused");
    assert.match(outcome.message, /not provably failed/);
    s.close();
  });
});

describe("recoveryActions: cancelExchangeDurable", () => {
  it("cancels an interrupted exchange — its only real legal edge", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "interrupted" });
    const result = cancelExchangeDurable(s, svc, row.exchange_id, "operator dismissed it");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "cancelled");
    const events = s.listExchangeEvents(row.exchange_id);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, "exchange_cancelled");
    assert.strictEqual(JSON.parse(events[0].payload_redacted_json).reason, "operator dismissed it");
  });

  for (const state of ["draft", "awaiting_clarification", "awaiting_approval", "staged", "delivered", "running", "needs_input", "terminal_idle"] as ExchangeState[]) {
    it(`cancels from '${state}' (every cancellable state)`, () => {
      const s = freshStore();
      const svc = freshSvc(s);
      const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state });
      const result = cancelExchangeDurable(s, svc, row.exchange_id, undefined);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(s.getExchange(row.exchange_id)!.state, "cancelled");
      s.close();
    });
  }

  for (const state of ["agent_complete", "agent_failed", "cancelled"] as ExchangeState[]) {
    it(`refuses to cancel an already-terminal '${state}' exchange`, () => {
      const s = freshStore();
      const svc = freshSvc(s);
      const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state });
      const result = cancelExchangeDurable(s, svc, row.exchange_id, undefined);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(s.getExchange(row.exchange_id)!.state, state, "untouched");
      s.close();
    });
  }

  it("refuses a not-found exchange id", () => {
    const s = freshStore();
    const svc = freshSvc(s);
    const result = cancelExchangeDurable(s, svc, "exch-nope", undefined);
    assert.strictEqual(result.ok, false);
    s.close();
  });
});

describe("recoveryActions: openExchangePane", () => {
  it("resolves the (project, pane) an exchange belongs to", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "proj-x", pane_id: "pane-y", state: "interrupted" });
    assert.deepStrictEqual(openExchangePane(s, row.exchange_id), { projectId: "proj-x", paneId: "pane-y" });
    s.close();
  });

  it("returns null for an unknown exchange id", () => {
    const s = freshStore();
    assert.strictEqual(openExchangePane(s, "exch-nope"), null);
    s.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The four ActionDefs (src/actions/defs/lifecycle_rest.ts) — proving the REGISTRY wiring itself
// (param parsing, capability/gate dispatch, rest binding), not just the recoveryActions.ts logic
// the describe blocks above already cover directly. Mirrors the tests/test_c55_14_lifecycle.ts
// def-level idiom (runAction + a minimal fake ActionContext) for the sibling defs in the SAME file.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
function makeActionCtx(opts: {
  store: JanusStore;
  terminals?: Record<string, { writeInput: (s: string) => void; status?: string }>;
  gateDisposition?: GateDisposition;
}): { ctx: ActionContext; gateCalls: Array<{ capability: string; paneId: string | null }> } {
  const gateCalls: Array<{ capability: string; paneId: string | null }> = [];
  const ctx = {
    manager: { terminals: opts.terminals ?? {} },
    session: null,
    redact: (s: string) => s,
    store: opts.store,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    // Mirrors the REAL gateOrDefer (src/gating): STAGES `run` only on the deferred (Ask) path; on
    // "run" (Auto) it returns {disposition:"run"} WITHOUT invoking run — the caller runs the effect.
    gateOrDefer: (capability: string, paneId: string | null, _summary: string, run: () => string) => {
      gateCalls.push({ capability, paneId });
      const d = opts.gateDisposition ?? ({ disposition: "run" as const });
      void run;
      return d;
    },
  } as unknown as ActionContext;
  return { ctx, gateCalls };
}

describe("Recovery ActionDefs registered in REGISTRY: resume_inspect_exchange / retry_exchange / cancel_exchange / open_exchange_pane", () => {
  it("resume_inspect_exchange: runAction returns the exchange + its recent events", async () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "interrupted" });
    const { ctx } = makeActionCtx({ store: s });
    const result = await runAction(REGISTRY, "resume_inspect_exchange", { exchange_id: row.exchange_id }, ctx);
    assert.strictEqual(result.kind, "ok");
    const view = (result as { kind: "ok"; output: unknown }).output as ResumeInspectView;
    assert.strictEqual(view.exchange.exchange_id, row.exchange_id);
    s.close();
  });

  it("retry_exchange: Auto disposition actually redelivers a provably-failed draft via the real ActionDef", async () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft", distilled_instruction: "run it" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_failed", ts: 1000 });
    const calls: string[] = [];
    const { ctx, gateCalls } = makeActionCtx({
      store: s,
      terminals: { "pane-1": { writeInput: (cmd: string) => { calls.push(cmd); }, status: "Running" } },
    });
    const result = await runAction(REGISTRY, "retry_exchange", { exchange_id: row.exchange_id }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(calls, ["run it"]);
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "delivered");
    assert.deepStrictEqual(gateCalls, [{ capability: "write_to_pane", paneId: "pane-1" }], "gated through write_to_pane");
    s.close();
  });

  it("retry_exchange: Ask disposition -> pending, no side effect yet", async () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_failed", ts: 1000 });
    const { ctx } = makeActionCtx({
      store: s,
      terminals: { "pane-1": { writeInput: () => {}, status: "Running" } },
      gateDisposition: { disposition: "deferred", actionId: "pa-1", summary: "Retry exchange" },
    });
    const result = await runAction(REGISTRY, "retry_exchange", { exchange_id: row.exchange_id }, ctx);
    assert.strictEqual(result.kind, "pending");
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "draft", "no delivery until confirmed");
    s.close();
  });

  it("retry_exchange: Off disposition -> blocked", async () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_failed", ts: 1000 });
    const { ctx } = makeActionCtx({ store: s, gateDisposition: { disposition: "forbidden" } });
    const result = await runAction(REGISTRY, "retry_exchange", { exchange_id: row.exchange_id }, ctx);
    assert.strictEqual(result.kind, "blocked");
    s.close();
  });

  it("cancel_exchange: runAction cancels an interrupted exchange, ungated", async () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "interrupted" });
    const { ctx } = makeActionCtx({ store: s });
    const result = await runAction(REGISTRY, "cancel_exchange", { exchange_id: row.exchange_id }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "cancelled");
    s.close();
  });

  it("open_exchange_pane: runAction resolves the owning (project, pane)", async () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "proj-z", pane_id: "pane-z", state: "draft" });
    const { ctx } = makeActionCtx({ store: s });
    const result = await runAction(REGISTRY, "open_exchange_pane", { exchange_id: row.exchange_id }, ctx);
    assert.strictEqual(result.kind, "ok");
    const view = (result as { kind: "ok"; output: unknown }).output as OpenExchangePaneView;
    assert.deepStrictEqual(view, { projectId: "proj-z", paneId: "pane-z" });
    s.close();
  });
});
