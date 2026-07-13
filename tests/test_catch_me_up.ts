// hwu.2 — the "catch me up" voice verb: run the existing away-digest composer over an arbitrary
// [now - window, now] window and fire the shipped cortex "catch-up" injection, WITHOUT reconnecting.
//
// PURE handler tests (no server boot, no Gemini key, no PTY). They prove:
//   (1) digest PRESENT   -> the composed line is spoken (redacted, passed through ctx.redact);
//   (2) digest NULL      -> a graceful "nothing notable in the last N minutes" line;
//   (3) window CLAMP     -> composeAwayDigest is called with since = now - clamp([1,1440])*60000
//                           (negative/huge/NaN never drive an out-of-range window);
//   (4) gating Off veto  -> read_notes="Off" (not frozen) returns the forbidden string and never
//                           composes; a STOP-ALL freeze does NOT suppress the read (reads stay live);
//   (5) cortex leg       -> injectMemoryBrief("catch_me_up") fires fire-and-forget, and a throwing
//                           memory daemon NEVER breaks the spoken digest (fail-open on the cortex leg).
//
// Runner: npx tsx --test --test-force-exit tests/test_catch_me_up.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { catchMeUp } from "../src/actions/defs/catchup";
import type { ActionContext } from "../src/actions/types";
import type { CapabilityGate, GateValue } from "../src/types";
import type { ContextInjectionTrigger } from "../src/memory/contextTelemetry";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { PendingActionStore } from "../src/pendingActions";
import { JanusStore } from "../src/store/sqliteStore";

const FORBID_CATCHUP =
  "Error: the 'read_notes' capability is gated Off; reading activity history is forbidden by policy.";

interface Spy {
  composeCalls: Array<{ since: number; now: number }>;
  injectTriggers: ContextInjectionTrigger[];
  redactCalls: string[];
}

function freshSpy(): Spy {
  return { composeCalls: [], injectTriggers: [], redactCalls: [] };
}

/**
 * Build a stubbed ActionContext for catch_me_up. `composeReturn` is what the injected away-digest
 * composer hands back (a spoken line, or null for "nothing notable"). `gates` maps a capability ->
 * the GateValue effectiveCapabilityGateFor returns (unset falls to "Auto"). `injectThrows` makes the
 * cortex catch-up leg throw synchronously, to prove the digest still returns (fail-open).
 */
function makeCtx(
  composeReturn: string | null,
  spy: Spy,
  opts: {
    gates?: Partial<Record<string, GateValue>>;
    frozen?: boolean;
    injectThrows?: boolean;
    omitCompose?: boolean;
    omitInject?: boolean;
  } = {},
): ActionContext {
  const gates = opts.gates ?? {};
  const composeAwayDigest = (since: number, now: number): string | null => {
    spy.composeCalls.push({ since, now });
    return composeReturn;
  };
  const ctx = {
    manager: {} as unknown as ActionContext["manager"],
    session: null,
    callId: "call_test",
    trigger: "test",
    surface: "voice",
    userUtterance: "",
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    gateOrDefer: () => ({ disposition: "run" as const }),
    dispatchProposal: (a) => ({ kind: "executed" as const, text: `executed on ${a.targetId}` }),
    gateCapability: () => ({ forbidden: false, gate: "Auto" as GateValue }),
    redact: (s: string): string => {
      spy.redactCalls.push(s);
      return s;
    },
    getActivePaneId: () => null,
    setActivePane: () => {},
    activeDraftTarget: () => null,
    broadcastDraft: () => {},
    broadcastTerminalsUpdated: () => {},
    effectiveCapabilityGateFor: (_paneId: string | null | undefined, capability: CapabilityGate): GateValue =>
      gates[capability] ?? "Auto",
    pruneAttention: () => {},
    pendingApprovals: new PendingApprovalStore(null),
    pendingActions: new PendingActionStore(null),
    applyResolution: () => ({ reason: "not_found" as const, doWrite: false }),
    store: null,
    sanitizeSettingsForClient: (settings) => settings,
    recipes: [],
    stopAll: async () => [],
    releaseStopAll: () => {},
    isFrozen: () => opts.frozen ?? false,
    runningPaneIds: () => [],
    posturePayloadForPane: (id) => ({ id, effective_gates: {} as never, posture: undefined }),
    injectMemoryBrief: opts.omitInject
      ? undefined
      : (trigger?: ContextInjectionTrigger) => {
          spy.injectTriggers.push(trigger ?? "catch_me_up");
          if (opts.injectThrows) throw new Error("memory daemon down");
        },
  } as ActionContext;
  // composeAwayDigest is threaded onto the voice ActionContext by the integrator (see
  // requiredRegistrations). Attach it here the same way for the pure handler test.
  if (!opts.omitCompose) {
    (ctx as ActionContext & { composeAwayDigest?: (s: number, n: number) => string | null }).composeAwayDigest =
      composeAwayDigest;
  }
  return ctx;
}

describe("catch_me_up — digest present / null", () => {
  it("(1) digest PRESENT -> speaks the composed line, redacted", async () => {
    const spy = freshSpy();
    const ctx = makeCtx("While you were away: pane build reported an error.", spy);
    const res = await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual(
      (res as { output: unknown }).output,
      "While you were away: pane build reported an error.",
    );
    // The spoken string went through ctx.redact (egress redaction pass).
    assert.ok(spy.redactCalls.includes("While you were away: pane build reported an error."));
  });

  it("(2) digest NULL -> graceful 'nothing notable in the last N minutes'", async () => {
    const spy = freshSpy();
    const ctx = makeCtx(null, spy);
    const res = await catchMeUp.handler({ window_minutes: 45 }, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual((res as { output: unknown }).output, "Nothing notable in the last 45 minutes.");
  });

  it("(2b) singular minute wording at window = 1", async () => {
    const spy = freshSpy();
    const ctx = makeCtx(null, spy);
    const res = await catchMeUp.handler({ window_minutes: 1 }, ctx);
    assert.strictEqual((res as { output: unknown }).output, "Nothing notable in the last 1 minute.");
  });
});

describe("catch_me_up — window clamp [1, 1440]", () => {
  const NOW_TOL_MS = 5000; // wall-clock tolerance for Date.now() inside the handler

  it("(3a) in-range window -> since = now - window*60000", async () => {
    const spy = freshSpy();
    const ctx = makeCtx("x", spy);
    const before = Date.now();
    await catchMeUp.handler({ window_minutes: 60 }, ctx);
    assert.strictEqual(spy.composeCalls.length, 1);
    const { since, now } = spy.composeCalls[0];
    assert.ok(now >= before && now <= Date.now());
    assert.ok(Math.abs(now - since - 60 * 60000) <= NOW_TOL_MS, "60-min window => 3_600_000ms span");
  });

  it("(3b) window > 1440 clamps to 1440", async () => {
    const spy = freshSpy();
    const ctx = makeCtx("x", spy);
    await catchMeUp.handler({ window_minutes: 999999 }, ctx);
    const { since, now } = spy.composeCalls[0];
    assert.ok(Math.abs(now - since - 1440 * 60000) <= NOW_TOL_MS, "clamped to 1440 minutes");
  });

  it("(3c) window < 1 (zero / negative) clamps to 1", async () => {
    const spy = freshSpy();
    const ctxZero = makeCtx("x", spy);
    await catchMeUp.handler({ window_minutes: 0 }, ctxZero);
    let { since, now } = spy.composeCalls[0];
    assert.ok(Math.abs(now - since - 1 * 60000) <= NOW_TOL_MS, "0 clamps to 1 minute");

    const spyNeg = freshSpy();
    const ctxNeg = makeCtx("x", spyNeg);
    await catchMeUp.handler({ window_minutes: -500 }, ctxNeg);
    ({ since, now } = spyNeg.composeCalls[0]);
    assert.ok(Math.abs(now - since - 1 * 60000) <= NOW_TOL_MS, "negative clamps to 1 minute");
  });

  it("(3d) NaN window -> a bounded in-range default, never an unbounded scan", async () => {
    const spy = freshSpy();
    const ctx = makeCtx(null, spy);
    const res = await catchMeUp.handler({ window_minutes: Number.NaN }, ctx);
    assert.strictEqual(res.kind, "ok");
    const { since, now } = spy.composeCalls[0];
    const spanMin = (now - since) / 60000;
    assert.ok(spanMin >= 1 && spanMin <= 1440, `NaN must clamp into [1,1440], got ${spanMin}`);
  });
});

describe("catch_me_up — read-gating parity (explicit-Off veto)", () => {
  it("(4a) read_notes=Off (not frozen) -> forbidden string, never composes", async () => {
    const spy = freshSpy();
    const ctx = makeCtx("x", spy, { gates: { read_notes: "Off" } });
    const res = await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual((res as { output: unknown }).output, FORBID_CATCHUP);
    assert.strictEqual(spy.composeCalls.length, 0, "the away composer must NOT run when read_notes is Off");
    assert.strictEqual(spy.injectTriggers.length, 0, "the cortex leg must NOT fire when vetoed");
  });

  it("(4b) frozen=TRUE does NOT suppress the read (reads stay live during a freeze)", async () => {
    const spy = freshSpy();
    // Mirror the STOP-ALL short-circuit: every cap resolves Off, but isFrozen() is true.
    const ctx = makeCtx("While you were away: 2 panes exited.", spy, {
      gates: { read_notes: "Off" },
      frozen: true,
    });
    const res = await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual((res as { output: unknown }).output, "While you were away: 2 panes exited.");
    assert.strictEqual(spy.composeCalls.length, 1, "the composer must run during a freeze");
  });
});

describe("catch_me_up — cortex catch-up injection leg (fire-and-forget, fail-open)", () => {
  it("(5a) fires injectMemoryBrief('catch_me_up')", async () => {
    const spy = freshSpy();
    const ctx = makeCtx("x", spy);
    await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.deepStrictEqual(spy.injectTriggers, ["catch_me_up"]);
  });

  it("(5b) a throwing memory daemon NEVER breaks the spoken digest", async () => {
    const spy = freshSpy();
    const ctx = makeCtx("While you were away: pane api finished.", spy, { injectThrows: true });
    const res = await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual((res as { output: unknown }).output, "While you were away: pane api finished.");
  });

  it("(5c) absent injectMemoryBrief hook is a safe no-op (REST/test paths)", async () => {
    const spy = freshSpy();
    const ctx = makeCtx(null, spy, { omitInject: true });
    const res = await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual((res as { output: unknown }).output, "Nothing notable in the last 30 minutes.");
  });
});

describe("catch_me_up — composer not wired (graceful degrade)", () => {
  it("absent composeAwayDigest -> graceful 'nothing notable' line, still fires the cortex leg", async () => {
    const spy = freshSpy();
    const ctx = makeCtx("ignored", spy, { omitCompose: true });
    const res = await catchMeUp.handler({ window_minutes: 15 }, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual((res as { output: unknown }).output, "Nothing notable in the last 15 minutes.");
    assert.deepStrictEqual(spy.injectTriggers, ["catch_me_up"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Phase 4, Step 4.2 — exchange-aware catch-up: the exchange board (needs_input/failed/complete/
// running/decisions, src/voice/sitrep.ts composeExchangeBoard) is PREPENDED ahead of the legacy
// away-digest, windowed to [since, now] so an unchanged exchange is never replayed on a repeated
// call. Every test above stays green untouched (no ctx.store attached there -> an empty board,
// exactly the pre-4.2 behavior).
// ─────────────────────────────────────────────────────────────────────────────────────────────
function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

/** A fuller ActionContext than `makeCtx` above (which stubs `manager` down to nothing) — the
 *  exchange board reads `ctx.manager.ledger.workspaces`/`activeProjectId` and
 *  `ctx.manager.attentionQueue`, none of which the pure hwu.2 handler tests above ever touch. */
function makeExchangeCtx(opts: {
  store: JanusStore | null;
  composeReturn?: string | null;
  digestSpy?: Array<{ since: number; now: number }>;
}): ActionContext {
  const digestSpy = opts.digestSpy ?? [];
  return {
    manager: {
      terminals: {},
      ledger: { workspaces: {}, activeProjectId: "proj-1" },
      attentionQueue: [],
      settings: {},
    },
    session: null,
    callId: "call_test",
    redact: (s: string) => s,
    isFrozen: () => false,
    effectiveCapabilityGateFor: () => "Auto" as GateValue,
    pruneAttention: () => {},
    pendingApprovals: new PendingApprovalStore(null),
    pendingActions: new PendingActionStore(null),
    store: opts.store,
    injectMemoryBrief: () => {},
    composeAwayDigest:
      opts.composeReturn === undefined
        ? undefined
        : (since: number, now: number): string | null => {
            digestSpy.push({ since, now });
            return opts.composeReturn ?? null;
          },
  } as unknown as ActionContext;
}

describe("catch_me_up — exchange-aware board (Phase 4, Step 4.2)", () => {
  it("a needs_input exchange within the window surfaces its redacted question, ahead of the legacy digest", async () => {
    const store = freshStore();
    const now = Date.now();
    store.insertExchange({
      project_id: "proj-1", pane_id: "p1", state: "needs_input",
      terminal_state: "overwrite existing file? y/n", updated_at: now - 5_000,
    });
    const ctx = makeExchangeCtx({ store, composeReturn: "2 panes finished while you were away." });
    const res = await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.strictEqual(res.kind, "ok");
    const output = String((res as { output: unknown }).output);
    assert.ok(output.startsWith(`Pane 'p1' needs your input: "overwrite existing file? y/n"`), output);
    assert.ok(output.includes("2 panes finished while you were away."), output);
    store.close();
  });

  it("an exchange OUTSIDE the requested window is not replayed (no unchanged-context replay)", async () => {
    const store = freshStore();
    const now = Date.now();
    // 2 hours old — outside a 30-minute catch-up window.
    store.insertExchange({
      project_id: "proj-1", pane_id: "p1", state: "agent_failed",
      terminal_state: "stale failure", updated_at: now - 2 * 60 * 60 * 1000,
    });
    const ctx = makeExchangeCtx({ store, composeReturn: null });
    const res = await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.strictEqual((res as { output: unknown }).output, "Nothing notable in the last 30 minutes.");
    store.close();
  });

  it("no exchange activity at all -> byte-identical to the pre-4.2 digest-only behavior", async () => {
    const store = freshStore(); // real store, but zero exchange rows.
    const ctx = makeExchangeCtx({ store, composeReturn: "1 pane exited." });
    const res = await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.strictEqual((res as { output: unknown }).output, "1 pane exited.");
    store.close();
  });

  it("no store attached (REST/test paths) -> the exchange board is silently empty, digest-only as before", async () => {
    const ctx = makeExchangeCtx({ store: null, composeReturn: "1 pane exited." });
    const res = await catchMeUp.handler({ window_minutes: 30 }, ctx);
    assert.strictEqual((res as { output: unknown }).output, "1 pane exited.");
  });
});
