// PLM1 — per-action timeout + the audit() seam in runAction (registry TDD spec §5.6 / PLM1).
//
// These are PURE wrapper tests over runAction with a FIXTURE registry + a stubbed ActionContext —
// no server boot, no Gemini key, no PTY. They prove:
//   (a) a NON-ALWAYS_ALLOWED handler that never resolves, with timeoutMs:50, returns kind:"error"
//       (the deadline wins; no hang — run via --test-force-exit);
//   (b) a fast handler under the deadline returns kind:"ok" immediately (ceiling, not a delay);
//   (c) an ALWAYS_ALLOWED def with a slow handler is NOT timed out — it runs to completion;
//   (d) ctx.audit is called exactly once per dispatch with the right resultKind + a numeric ms.
//
// Runner: npx tsx --test --test-force-exit tests/test_action_timeout.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { z } from "zod";

import { runAction, DEFAULT_ACTION_TIMEOUT_MS } from "../src/actions/gemini";
import { ALWAYS_ALLOWED } from "../src/actions/types";
import type {
  ActionAuditRow,
  ActionContext,
  ActionDef,
  ActionResult,
} from "../src/actions/types";
import { PendingApprovalStore } from "../src/pendingApprovals";

// ─────────────────────────────────────────────────────────────────────────────
// Test double: a stubbed ActionContext. Mirrors makeCtx() from test_action_registry.ts but only
// wires what the timeout/audit seam needs — every other injected closure is an inert no-op/null.
// `auditRows` collects each ActionAuditRow the wrapper emits so tests can assert the seam fired.
// ─────────────────────────────────────────────────────────────────────────────
function makeCtx(opts: {
  audit?: (row: ActionAuditRow) => void;
  trigger?: string;
  surface?: string;
} = {}): ActionContext {
  return {
    manager: {} as ActionContext["manager"],
    session: null,
    callId: "call_test",
    trigger: opts.trigger ?? "test",
    surface: opts.surface,
    userUtterance: "",
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    gateOrDefer: () => ({ disposition: "run" }),
    dispatchProposal: (a) => ({ kind: "executed", text: `executed on ${a.targetId}` }),
    gateCapability: () => ({ forbidden: false, gate: "Auto" }),
    redact: (s) => s,
    audit: opts.audit,
    getActivePaneId: () => null,
    setActivePane: () => {},
    activeDraftTarget: () => null,
    broadcastDraft: () => {},
    broadcastTerminalsUpdated: () => {},
    effectiveCapabilityGateFor: () => "Auto",
    pruneAttention: () => {},
    pendingApprovals: new PendingApprovalStore(null),
    applyResolution: () => ({ reason: "not_found", doWrite: false }),
    store: null,
    sanitizeSettingsForClient: (settings) => settings,
    recipes: [],
    stopAll: async () => [],
    releaseStopAll: () => {},
    isFrozen: () => false,
    runningPaneIds: () => [],
    posturePayloadForPane: (id) => ({ id, effective_gates: {} as never, posture: undefined }),
  };
}

// ── Fixture handlers ────────────────────────────────────────────────────────

/** A handler that NEVER resolves (a wedged tool). Used to prove the deadline fires. */
function neverResolvesAction(timeoutMs?: number): ActionDef<z.ZodObject<Record<string, never>>> {
  return {
    name: "test_never",
    description: "a handler that never resolves",
    params: z.object({}),
    capability: "update_metadata",
    readOnly: false,
    surfaces: new Set(["voice"]),
    timeoutMs,
    handler: (): Promise<ActionResult> => new Promise<ActionResult>(() => { /* never settles */ }),
  };
}

/** A fast synchronous handler well under any deadline. */
function fastAction(): ActionDef<z.ZodObject<Record<string, never>>> {
  return {
    name: "test_fast",
    description: "a fast handler",
    params: z.object({}),
    capability: "update_metadata",
    readOnly: false,
    surfaces: new Set(["voice"]),
    handler: (): ActionResult => ({ kind: "ok", output: "fast done" }),
  };
}

/**
 * An ALWAYS_ALLOWED (emergency-brake) handler that is SLOW but DOES eventually resolve. It must NOT
 * be timed out — even with a deadline shorter than its runtime, the brake runs to completion.
 */
function slowBrakeAction(ran: { value: boolean }): ActionDef<z.ZodObject<Record<string, never>>> {
  return {
    name: "test_brake",
    description: "an ALWAYS_ALLOWED slow handler",
    params: z.object({}),
    capability: ALWAYS_ALLOWED,
    readOnly: false,
    surfaces: new Set(["voice"]),
    // A deadline this short would trip a NON-brake action; the brake is exempt and must ignore it.
    timeoutMs: 20,
    handler: async (): Promise<ActionResult> => {
      await new Promise((r) => setTimeout(r, 80)); // outlasts the (ignored) 20ms ceiling
      ran.value = true;
      return { kind: "ok", output: "brake ran" };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) deadline fires on a wedged NON-ALWAYS_ALLOWED handler
// ─────────────────────────────────────────────────────────────────────────────
describe("PLM1 per-action timeout", () => {
  it("(a) a never-resolving handler with timeoutMs:50 -> kind:error (no hang)", async () => {
    const reg = [neverResolvesAction(50)];
    const result = await runAction(reg, "test_never", {}, makeCtx());
    assert.strictEqual(result.kind, "error");
    assert.match(
      (result as { message: string }).message,
      /test_never exceeded its 50ms deadline/,
      "the deadline message must name the action + its ms ceiling"
    );
  });

  it("(b) a fast handler under the deadline -> kind:ok (ceiling, not a delay)", async () => {
    const reg = [fastAction()];
    const t0 = performance.now();
    const result = await runAction(reg, "test_fast", {}, makeCtx());
    const elapsed = performance.now() - t0;
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual((result as { output: unknown }).output, "fast done");
    // The fast path must return promptly — nowhere near the default 30s ceiling.
    assert.ok(elapsed < DEFAULT_ACTION_TIMEOUT_MS, "a fast handler must not be delayed by the deadline");
  });

  it("(c) an ALWAYS_ALLOWED slow handler is NOT timed out (runs to completion)", async () => {
    const ran = { value: false };
    const reg = [slowBrakeAction(ran)];
    const result = await runAction(reg, "test_brake", {}, makeCtx());
    assert.strictEqual(result.kind, "ok", "the brake must complete, not time out");
    assert.strictEqual((result as { output: unknown }).output, "brake ran");
    assert.strictEqual(ran.value, true, "the brake handler must have fully run despite the short ceiling");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) the audit() seam fires exactly once per dispatch with the right shape
// ─────────────────────────────────────────────────────────────────────────────
describe("PLM1 audit() seam", () => {
  it("(d) ctx.audit is called once with the right resultKind + a numeric ms (ok path)", async () => {
    const rows: ActionAuditRow[] = [];
    const reg = [fastAction()];
    const result = await runAction(reg, "test_fast", {}, makeCtx({ audit: (r) => rows.push(r), surface: "voice" }));
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rows.length, 1, "audit must fire exactly once per dispatch");
    const row = rows[0];
    assert.strictEqual(row.name, "test_fast");
    assert.strictEqual(row.capability, "update_metadata");
    assert.strictEqual(row.resultKind, "ok");
    assert.strictEqual(typeof row.ms, "number", "ms must be numeric");
    assert.ok(Number.isFinite(row.ms) && row.ms >= 0, "ms must be a finite non-negative number");
    assert.strictEqual(row.surface, "voice", "surface comes from the explicit ctx.surface token (set by the context builder)");
  });

  it("(d) audit fires once with resultKind:error on the timeout path", async () => {
    const rows: ActionAuditRow[] = [];
    const reg = [neverResolvesAction(40)];
    const result = await runAction(reg, "test_never", {}, makeCtx({ audit: (r) => rows.push(r) }));
    assert.strictEqual(result.kind, "error");
    assert.strictEqual(rows.length, 1, "audit must fire once even when the deadline wins");
    assert.strictEqual(rows[0].resultKind, "error");
    assert.strictEqual(typeof rows[0].ms, "number");
    // The measured ms should reflect the ~40ms the deadline waited (sanity: at least the ceiling-ish).
    assert.ok(rows[0].ms >= 0, "ms is a non-negative duration");
  });

  it("(d) a throwing audit sink never breaks dispatch (best-effort try/catch)", async () => {
    const reg = [fastAction()];
    const result = await runAction(
      reg, "test_fast", {},
      makeCtx({ audit: () => { throw new Error("audit sink blew up"); } })
    );
    // The audit fault is swallowed; the dispatch result is still the handler's ok.
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual((result as { output: unknown }).output, "fast done");
  });
});
