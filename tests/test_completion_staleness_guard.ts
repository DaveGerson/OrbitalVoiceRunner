// tests/test_completion_staleness_guard.ts — chain-review fix I-2 RED: hasActiveExchange must not
// trust the sticky paneActive marker without a staleness guard.
//
// The hazard: ExchangeService.paneActive is a DELIVERY marker — set on completeDelivery
// (src/exchanges/service.ts ~201) and cleared only in recoverOnBoot (~498), NEVER on settle. So
// `!!activeExchangeForPane(paneId)` reports hasExchange:true for every later ambient Running→Idle
// edge on a pane that EVER carried a dispatch — and completionNarration's default `dispatched`
// tier then speaks "pane X finished" for uncorroborated idles: the exact false-done amplification
// the tier guard exists to block. PR #152's own completionKindFor already staleness-guards this
// seam (lastCommandBelongsToActiveExchange); hasActiveExchange must match its own doc claim
// ("was a LIVE exchange bound") by ALSO requiring the resolved exchange's state to be
// non-terminal (TERMINAL_STATES: agent_complete / agent_failed / cancelled —
// src/exchanges/lifecycle.ts).
//
// JANUS_EXCHANGE_SPINE is set BEFORE the first import of anything touching src/exchanges/ (the
// flag caches its mode at module load — same note as tests/test_completion_failed_earcon.ts).
// `node --test` runs each test FILE as its own process, so this can't leak into a sibling file.
//
// Runner: npx tsx --test --test-force-exit tests/test_completion_staleness_guard.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { completionNarration } from "../src/voice/completionPolicy"; // PURE — no flag/spine reads

type AnyRec = Record<string, any>;

let voiceIndex: AnyRec;
let getExchangeService: typeof import("../src/exchanges/spine").getExchangeService;
let resetExchangeServiceForTests: typeof import("../src/exchanges/spine").resetExchangeServiceForTests;

const prevEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  prevEnv[k] = process.env[k];
  process.env[k] = v;
}

before(async () => {
  setEnv("JANUS_EXCHANGE_SPINE", "record"); // active, sufficient for these settlement tests.
  voiceIndex = await import("../src/voice/index");
  ({ getExchangeService, resetExchangeServiceForTests } = await import("../src/exchanges/spine"));
});

after(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

/** Deliver a fresh exchange onto `paneId` via the REAL process-wide singleton — mirrors the
 *  identical helper in tests/test_completion_failed_earcon.ts. */
function deliverExchange(paneId: string, instruction = "run tests"): string {
  const svc = getExchangeService();
  const snap = svc.createExchange({
    projectId: "proj-1", paneId,
    operatorUtterance: `please ${instruction}`, distilledInstruction: instruction,
  });
  assert.ok(svc.stageForDelivery(snap.exchangeId).ok);
  assert.ok(svc.recordDelivery(snap.exchangeId).ok);
  return snap.exchangeId;
}

/** The idle-edge decision the voice layer's onPaneSignal 'idle' arm makes, under the LOCKED
 *  `dispatched` default, keyed off the REAL hasActiveExchange. */
function idleDecision(paneId: string): AnyRec {
  return completionNarration({
    sig: { paneId, kind: "idle", detail: "went quiet" },
    outcomeKind: "completion",
    hasExchange: voiceIndex.hasActiveExchange(paneId),
    policy: "dispatched",
  });
}

describe("hasActiveExchange — the I-2 staleness guard (src/voice/index.ts)", () => {
  it("is exported for the focused suite (the file's export-for-test pattern)", () => {
    assert.equal(typeof voiceIndex.hasActiveExchange, "function",
      "I-2 feature absent: src/voice/index.ts must export hasActiveExchange so the staleness " +
        "guard is directly testable (sibling exports: paneSignalClass, completionContradiction, ...)");
  });

  it("positive control — an idle DURING the live exchange still reports hasExchange:true and speaks under `dispatched`", () => {
    resetExchangeServiceForTests();
    deliverExchange("stale_live1");
    getExchangeService().onPaneSignal({ paneId: "stale_live1", kind: "running" });

    assert.equal(voiceIndex.hasActiveExchange("stale_live1"), true,
      "a delivered, un-settled exchange IS a live exchange — the guard must not over-tighten");
    const d = idleDecision("stale_live1");
    assert.equal(d.speak, true, "the dispatched tier speaks the live exchange's completion");
  });

  it("SETTLED clean (agent_complete): the sticky paneActive marker no longer counts — a later ambient idle is NOT spoken", () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("stale_done1");
    getExchangeService().onPaneSignal({ paneId: "stale_done1", kind: "running" });
    assert.ok(getExchangeService().recordReportedOutcome("stale_done1", id, "complete", "all green"),
      "precondition: the explicit complete report settled the exchange");
    assert.equal(getExchangeService().get(id)?.state, "agent_complete", "precondition: terminal state");
    // The HAZARD this fix guards (not a bug in itself): the delivery marker stays sticky on settle.
    assert.equal(getExchangeService().activeExchangeForPane("stale_done1"), id,
      "precondition: paneActive is NEVER cleared on settle — the raw marker still points at the settled exchange");

    assert.equal(voiceIndex.hasActiveExchange("stale_done1"), false,
      "I-2 feature absent: a SETTLED exchange is not a live one — hasActiveExchange must also " +
        "require a non-terminal state, or every later ambient idle on this pane amplifies into a " +
        "spoken 'pane X finished' under the default dispatched tier (false-done amplification)");
    const d = idleDecision("stale_done1");
    assert.equal(d.speak, false, "dispatched tier: no spoken completion for an uncorroborated later idle");
  });

  it("SETTLED failed (agent_failed) and cancelled behave the same: no live exchange reported", () => {
    resetExchangeServiceForTests();
    const failId = deliverExchange("stale_fail1");
    assert.ok(getExchangeService().recordReportedOutcome("stale_fail1", failId, "failed", "build broke"));
    assert.equal(getExchangeService().get(failId)?.state, "agent_failed", "precondition");
    assert.equal(voiceIndex.hasActiveExchange("stale_fail1"), false,
      "I-2 feature absent: agent_failed is terminal — not a live exchange");

    const cxlId = deliverExchange("stale_cxl1");
    assert.ok(getExchangeService().cancel(cxlId, "operator changed their mind").ok);
    assert.equal(getExchangeService().get(cxlId)?.state, "cancelled", "precondition");
    assert.equal(voiceIndex.hasActiveExchange("stale_cxl1"), false,
      "I-2 feature absent: cancelled is terminal — not a live exchange");
  });

  it("a NEW exchange on the same pane restores hasExchange:true — the guard is staleness-only, never sticky itself", () => {
    resetExchangeServiceForTests();
    const first = deliverExchange("stale_reuse1");
    assert.ok(getExchangeService().recordReportedOutcome("stale_reuse1", first, "complete", "done"));
    assert.equal(voiceIndex.hasActiveExchange("stale_reuse1"), false,
      "I-2 feature absent: the settled first exchange must not count");

    deliverExchange("stale_reuse1", "run tests again");
    assert.equal(voiceIndex.hasActiveExchange("stale_reuse1"), true,
      "a fresh delivery re-binds the pane — the guard must report the NEW live exchange");
  });

  it("baseline — a pane that never carried an exchange reports false", () => {
    resetExchangeServiceForTests();
    assert.equal(voiceIndex.hasActiveExchange("stale_ghost1"), false);
    assert.equal(idleDecision("stale_ghost1").speak, false,
      "dispatched tier never amplifies an uncorroborated idle");
  });
});
