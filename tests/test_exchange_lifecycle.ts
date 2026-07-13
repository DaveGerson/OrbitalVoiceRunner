// tests/test_exchange_lifecycle.ts
//
// AgentExchange spine — RED-FIRST state-transition matrix (Phase 1, step 1.1; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §1-§4).
//
// This suite imports `../src/exchanges/lifecycle`, which DOES NOT EXIST YET — the suite must
// fail (module-not-found) until step 1.3 implements it. It is the executable contract:
//   - the 12-state machine and its EXACT legal-transition relation (spec §1.3);
//   - draft-version binding: a revision bumps draft_version and invalidates an older
//     unresolved approval; approval confirmation binds the exact version (spec §3);
//   - delivery ordering: `delivered` only via `staged`, and only after a recorded
//     delivery attempt (the two-phase durable-intent rule, spec §2b);
//   - idempotency: repeated approval / repeated delivery are structural no-ops (spec §2a);
//   - cancellation from every cancellable state; refusal from terminal states;
//   - restart quarantine: recoverOnBoot marks uncertain in-flight exchanges `interrupted`,
//     never resends, never invents outcomes (spec §4).
//
// Contract expected from src/exchanges/lifecycle (pure, no I/O — the decideProposal /
// resolveDecision pure-core idiom):
//   export type ExchangeState = "draft" | "awaiting_clarification" | "awaiting_approval"
//     | "staged" | "delivered" | "running" | "needs_input" | "terminal_idle"
//     | "agent_complete" | "agent_failed" | "interrupted" | "cancelled";
//   export const EXCHANGE_STATES: readonly ExchangeState[];
//   export const TERMINAL_STATES: ReadonlySet<ExchangeState>;      // complete/failed/cancelled
//   export const CANCELLABLE_STATES: ReadonlySet<ExchangeState>;   // every non-terminal state
//   export function isLegalTransition(from: ExchangeState, to: ExchangeState): boolean;
//   export function recoveryDisposition(state: ExchangeState): "keep" | "interrupt";
//   export class ExchangeMachine {
//     constructor(opts?: { now?: () => number });
//     create(input: { projectId: string; paneId: string; operatorUtterance: string;
//                     distilledInstruction: string; exchangeId?: string }): ExchangeSnapshot;
//     get(id: string): ExchangeSnapshot | undefined;
//     reviseDraft(id: string, instruction: string): LifecycleResult;        // version++, invalidates approval
//     requestClarification(id: string, question: string): LifecycleResult;  // draft -> awaiting_clarification
//     resolveClarification(id: string, instruction: string): LifecycleResult; // -> draft, version++
//     requestApproval(id: string, approvalId: string): LifecycleResult;     // binds (approvalId, draftVersion)
//     confirmApproval(id: string, approvalId: string, draftVersion: number): LifecycleResult; // CAS -> staged
//     stageAutoExecute(id: string): LifecycleResult;                        // draft -> staged (Full Auto)
//     markDeliveryAttempted(id: string): LifecycleResult;                   // staged only; deliveryAttempt++
//     markDelivered(id: string): LifecycleResult;                           // staged -> delivered (needs attempt)
//     markDeliveryFailed(id: string, detail: string): LifecycleResult;      // staged -> draft (certain failure)
//     markRunning(id: string): LifecycleResult;
//     markNeedsInput(id: string, detail?: string): LifecycleResult;
//     markTerminalIdle(id: string, summary?: string): LifecycleResult;
//     markAgentComplete(id: string, resultSummary: string): LifecycleResult;
//     markAgentFailed(id: string, detail: string): LifecycleResult;
//     cancel(id: string, reason?: string): LifecycleResult;
//     markInterrupted(id: string, reason?: string): LifecycleResult;
//     recoverOnBoot(): { kept: string[]; interrupted: string[] };
//   }
//   LifecycleResult = { ok: true; snapshot: ExchangeSnapshot }
//                   | { ok: false; reason: string; snapshot?: ExchangeSnapshot }
//   ExchangeSnapshot carries at least: exchangeId, state, draftVersion, approvalId,
//   approvalDraftVersion, deliveryAttempt, deliveredAt, completedAt, distilledInstruction.

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  EXCHANGE_STATES,
  TERMINAL_STATES,
  CANCELLABLE_STATES,
  isLegalTransition,
  recoveryDisposition,
  ExchangeMachine,
  type ExchangeState,
} from "../src/exchanges/lifecycle";

// ---------------------------------------------------------------------------------------------
// The normative transition relation, transcribed verbatim from spec §1.3. This table is the
// single source of truth for the matrix tests below: every pair listed here must be legal and
// EVERY other ordered pair must be rejected.
// ---------------------------------------------------------------------------------------------
const LEGAL: Array<[ExchangeState, ExchangeState]> = [
  ["draft", "awaiting_clarification"],
  ["draft", "awaiting_approval"],
  ["draft", "staged"],                       // Full-Auto / spotlight gate (no approval leg)
  ["draft", "cancelled"],
  ["awaiting_clarification", "draft"],
  ["awaiting_clarification", "cancelled"],
  ["awaiting_approval", "draft"],            // draft_revised — invalidates the bound approval
  ["awaiting_approval", "staged"],           // approval_confirmed (exact-version CAS)
  ["awaiting_approval", "cancelled"],        // reject / TTL expiry
  ["staged", "delivered"],                   // delivery_succeeded (write accepted by live PTY)
  ["staged", "draft"],                       // delivery_failed with CERTAINTY nothing landed
  ["staged", "interrupted"],                 // restart quarantine (uncertain delivery)
  ["staged", "cancelled"],
  ["delivered", "running"],
  ["delivered", "needs_input"],
  ["delivered", "terminal_idle"],            // fast command — no distinct Running edge observed
  ["delivered", "agent_failed"],
  ["delivered", "interrupted"],
  ["delivered", "cancelled"],
  ["running", "needs_input"],
  ["running", "terminal_idle"],
  ["running", "agent_failed"],
  ["running", "interrupted"],
  ["running", "cancelled"],
  ["needs_input", "running"],
  ["needs_input", "terminal_idle"],
  ["needs_input", "agent_failed"],
  ["needs_input", "interrupted"],
  ["needs_input", "cancelled"],
  ["terminal_idle", "agent_complete"],
  ["terminal_idle", "agent_failed"],
  ["terminal_idle", "running"],              // idle was premature; pane resumed
  ["terminal_idle", "interrupted"],
  ["terminal_idle", "cancelled"],
  ["interrupted", "cancelled"],              // the ONLY edge out of interrupted (no auto-resume)
];

const ALL_STATES: ExchangeState[] = [
  "draft", "awaiting_clarification", "awaiting_approval", "staged", "delivered",
  "running", "needs_input", "terminal_idle", "agent_complete", "agent_failed",
  "interrupted", "cancelled",
];

function isListedLegal(from: ExchangeState, to: ExchangeState): boolean {
  return LEGAL.some(([f, t]) => f === from && t === to);
}

/** Fresh machine + one exchange in `draft`; returns [machine, exchangeId]. */
function draftExchange(now = () => 1_000): [InstanceType<typeof ExchangeMachine>, string] {
  const m = new ExchangeMachine({ now });
  const snap = m.create({
    projectId: "proj-1",
    paneId: "pane-1",
    operatorUtterance: "tell the agent to run the unit tests",
    distilledInstruction: "run the unit test suite and report failures",
  });
  return [m, snap.exchangeId];
}

/** Drive a fresh exchange to `state` through legal edges only. */
function exchangeIn(state: ExchangeState): [InstanceType<typeof ExchangeMachine>, string] {
  const [m, id] = draftExchange();
  const step = (r: { ok: boolean; reason?: string }) =>
    assert.ok(r.ok, `setup transition failed: ${(r as any).reason}`);
  switch (state) {
    case "draft": break;
    case "awaiting_clarification": step(m.requestClarification(id, "which pane?")); break;
    case "awaiting_approval": step(m.requestApproval(id, "appr-1")); break;
    case "staged": step(m.stageAutoExecute(id)); break;
    case "delivered":
      step(m.stageAutoExecute(id));
      step(m.markDeliveryAttempted(id));
      step(m.markDelivered(id));
      break;
    case "running":
      step(m.stageAutoExecute(id));
      step(m.markDeliveryAttempted(id));
      step(m.markDelivered(id));
      step(m.markRunning(id));
      break;
    case "needs_input":
      step(m.stageAutoExecute(id));
      step(m.markDeliveryAttempted(id));
      step(m.markDelivered(id));
      step(m.markRunning(id));
      step(m.markNeedsInput(id, "waiting at a prompt"));
      break;
    case "terminal_idle":
      step(m.stageAutoExecute(id));
      step(m.markDeliveryAttempted(id));
      step(m.markDelivered(id));
      step(m.markRunning(id));
      step(m.markTerminalIdle(id, "tests finished"));
      break;
    case "agent_complete":
      step(m.stageAutoExecute(id));
      step(m.markDeliveryAttempted(id));
      step(m.markDelivered(id));
      step(m.markRunning(id));
      step(m.markTerminalIdle(id));
      step(m.markAgentComplete(id, "all tests green"));
      break;
    case "agent_failed":
      step(m.stageAutoExecute(id));
      step(m.markDeliveryAttempted(id));
      step(m.markDelivered(id));
      step(m.markRunning(id));
      step(m.markAgentFailed(id, "pane exited"));
      break;
    case "interrupted":
      step(m.stageAutoExecute(id));
      step(m.markDeliveryAttempted(id));
      step(m.markDelivered(id));
      step(m.markInterrupted(id, "restart"));
      break;
    case "cancelled":
      step(m.cancel(id, "operator"));
      break;
  }
  const snap = m.get(id);
  assert.ok(snap, "setup: exchange must exist");
  assert.equal(snap!.state, state, `setup: expected ${state}, got ${snap!.state}`);
  return [m, id];
}

// ---------------------------------------------------------------------------------------------
// 1. The transition relation itself
// ---------------------------------------------------------------------------------------------
describe("exchange lifecycle: state vocabulary", () => {
  it("exports exactly the 12 spec states", () => {
    assert.deepEqual([...EXCHANGE_STATES].sort(), [...ALL_STATES].sort());
  });

  it("terminal states are agent_complete / agent_failed / cancelled", () => {
    assert.deepEqual(
      [...TERMINAL_STATES].sort(),
      ["agent_complete", "agent_failed", "cancelled"],
    );
  });

  it("cancellable states are every non-terminal state (9 of them, incl. interrupted)", () => {
    const expected = ALL_STATES.filter((s) => !TERMINAL_STATES.has(s));
    assert.deepEqual([...CANCELLABLE_STATES].sort(), expected.sort());
    assert.equal(CANCELLABLE_STATES.size, 9);
  });
});

describe("exchange lifecycle: legal transition matrix (spec §1.3)", () => {
  for (const [from, to] of LEGAL) {
    it(`accepts ${from} -> ${to}`, () => {
      assert.equal(isLegalTransition(from, to), true);
    });
  }

  it("rejects every ordered pair NOT in the normative table (incl. self-loops)", () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (isListedLegal(from, to)) continue;
        assert.equal(
          isLegalTransition(from, to),
          false,
          `expected ${from} -> ${to} to be ILLEGAL`,
        );
      }
    }
  });

  it("terminal states have no outgoing edges at all", () => {
    for (const from of TERMINAL_STATES) {
      for (const to of ALL_STATES) {
        assert.equal(isLegalTransition(from, to), false, `${from} -> ${to} must be illegal`);
      }
    }
  });

  it("interrupted's only exit is cancelled (never auto-resume)", () => {
    for (const to of ALL_STATES) {
      assert.equal(
        isLegalTransition("interrupted", to),
        to === "cancelled",
        `interrupted -> ${to}`,
      );
    }
  });

  it("delivery can never be reached without passing staged (no draft -> delivered shortcut)", () => {
    assert.equal(isLegalTransition("draft", "delivered"), false);
    assert.equal(isLegalTransition("awaiting_approval", "delivered"), false);
  });

  it("a landed write can never be un-delivered", () => {
    for (const from of ["delivered", "running", "needs_input", "terminal_idle"] as ExchangeState[]) {
      for (const to of ["staged", "awaiting_approval", "draft"] as ExchangeState[]) {
        assert.equal(isLegalTransition(from, to), false, `${from} -> ${to} must be illegal`);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Draft-version binding (spec §3)
// ---------------------------------------------------------------------------------------------
describe("exchange lifecycle: draft-version binding", () => {
  it("a fresh exchange starts at draft_version 1 in state draft", () => {
    const [m, id] = draftExchange();
    const s = m.get(id)!;
    assert.equal(s.state, "draft");
    assert.equal(s.draftVersion, 1);
    assert.equal(s.approvalId, null);
    assert.equal(s.deliveryAttempt, 0);
  });

  it("reviseDraft bumps draft_version and replaces the instruction", () => {
    const [m, id] = draftExchange();
    const r = m.reviseDraft(id, "run ONLY the store tests");
    assert.ok(r.ok);
    assert.equal(r.snapshot!.draftVersion, 2);
    assert.equal(r.snapshot!.distilledInstruction, "run ONLY the store tests");
    assert.equal(r.snapshot!.state, "draft");
  });

  it("resolving a clarification returns to draft with a bumped version", () => {
    const [m, id] = exchangeIn("awaiting_clarification");
    const r = m.resolveClarification(id, "run the tests in pane-1");
    assert.ok(r.ok);
    assert.equal(r.snapshot!.state, "draft");
    assert.equal(r.snapshot!.draftVersion, 2);
  });

  it("requestApproval binds the approval to the CURRENT draft_version", () => {
    const [m, id] = draftExchange();
    m.reviseDraft(id, "v2 instruction"); // -> version 2
    const r = m.requestApproval(id, "appr-9");
    assert.ok(r.ok);
    assert.equal(r.snapshot!.state, "awaiting_approval");
    assert.equal(r.snapshot!.approvalId, "appr-9");
    assert.equal(r.snapshot!.approvalDraftVersion, 2);
  });

  it("editing while awaiting_approval returns to draft and invalidates the binding", () => {
    const [m, id] = exchangeIn("awaiting_approval");
    const r = m.reviseDraft(id, "actually, run lint first");
    assert.ok(r.ok);
    assert.equal(r.snapshot!.state, "draft");
    assert.equal(r.snapshot!.draftVersion, 2);
    assert.equal(r.snapshot!.approvalId, null, "old approval binding must be cleared");
    assert.equal(r.snapshot!.approvalDraftVersion, null);
  });

  it("an older approval can NEVER fire after a revision (stale version is refused)", () => {
    const [m, id] = exchangeIn("awaiting_approval"); // bound: appr-1 @ v1
    m.reviseDraft(id, "revised");                    // -> draft, v2, binding cleared
    const stale = m.confirmApproval(id, "appr-1", 1);
    assert.equal(stale.ok, false);
    assert.equal(m.get(id)!.state, "draft", "stale approval must not move the exchange");
    assert.equal(m.get(id)!.deliveryAttempt, 0, "and must never trigger a delivery");
  });

  it("confirmApproval requires the EXACT bound (approvalId, draftVersion) pair", () => {
    const [m, id] = exchangeIn("awaiting_approval"); // appr-1 @ v1
    assert.equal(m.confirmApproval(id, "appr-1", 2).ok, false, "wrong version refused");
    assert.equal(m.confirmApproval(id, "appr-OTHER", 1).ok, false, "wrong approval id refused");
    assert.equal(m.get(id)!.state, "awaiting_approval");
    const r = m.confirmApproval(id, "appr-1", 1);
    assert.ok(r.ok, "exact pair confirms");
    assert.equal(r.snapshot!.state, "staged");
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Delivery ordering + exactly-once (spec §2)
// ---------------------------------------------------------------------------------------------
describe("exchange lifecycle: delivery ordering and idempotency", () => {
  it("markDelivered without a prior recorded attempt is refused (two-phase intent)", () => {
    const [m, id] = exchangeIn("staged");
    const r = m.markDelivered(id);
    assert.equal(r.ok, false, "delivered requires a durable delivery_attempted first");
    assert.equal(m.get(id)!.state, "staged");
  });

  it("markDeliveryAttempted is legal only from staged, and increments delivery_attempt", () => {
    const [m, id] = exchangeIn("staged");
    const r = m.markDeliveryAttempted(id);
    assert.ok(r.ok);
    assert.equal(r.snapshot!.deliveryAttempt, 1);
    assert.equal(r.snapshot!.state, "staged", "the attempt is intent, not the delivered state");

    const [m2, id2] = draftExchange();
    assert.equal(m2.markDeliveryAttempted(id2).ok, false, "no attempt from draft");
  });

  it("delivery succeeds only from staged (attempt -> delivered, stamps deliveredAt)", () => {
    const [m, id] = exchangeIn("staged");
    m.markDeliveryAttempted(id);
    const r = m.markDelivered(id);
    assert.ok(r.ok);
    assert.equal(r.snapshot!.state, "delivered");
    assert.ok(r.snapshot!.deliveredAt !== null);
  });

  it("repeated confirmApproval is a structural no-op (state and attempt unchanged)", () => {
    const [m, id] = exchangeIn("awaiting_approval");
    assert.ok(m.confirmApproval(id, "appr-1", 1).ok);
    const again = m.confirmApproval(id, "appr-1", 1);
    assert.equal(again.ok, false, "second confirm must not 'win' again");
    assert.equal(m.get(id)!.state, "staged");
    assert.equal(m.get(id)!.deliveryAttempt, 0);
  });

  it("repeated markDelivered is a structural no-op (deliveredAt not re-stamped)", () => {
    let t = 1_000;
    const m = new ExchangeMachine({ now: () => t });
    const id = m.create({
      projectId: "p", paneId: "pane-1",
      operatorUtterance: "u", distilledInstruction: "i",
    }).exchangeId;
    m.stageAutoExecute(id);
    m.markDeliveryAttempted(id);
    t = 2_000;
    assert.ok(m.markDelivered(id).ok);
    const firstDeliveredAt = m.get(id)!.deliveredAt;
    t = 9_999;
    const again = m.markDelivered(id);
    assert.equal(again.ok, false);
    assert.equal(m.get(id)!.deliveredAt, firstDeliveredAt, "deliveredAt must not move");
  });

  it("certain delivery failure re-arms to draft and clears the approval binding", () => {
    const [m, id] = exchangeIn("awaiting_approval");
    m.confirmApproval(id, "appr-1", 1);          // -> staged
    m.markDeliveryAttempted(id);
    const r = m.markDeliveryFailed(id, "pane not running (Exited)");
    assert.ok(r.ok);
    assert.equal(r.snapshot!.state, "draft");
    assert.equal(r.snapshot!.approvalId, null, "a re-send needs a FRESH approval");
    assert.equal(r.snapshot!.deliveryAttempt, 1, "the attempt stays on the record");
  });

  it("operations against an unknown exchange id are refused, never throw", () => {
    const m = new ExchangeMachine();
    assert.equal(m.markDelivered("exch_nope").ok, false);
    assert.equal(m.cancel("exch_nope").ok, false);
    assert.equal(m.get("exch_nope"), undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Cancellation (spec §1.1)
// ---------------------------------------------------------------------------------------------
describe("exchange lifecycle: cancellation", () => {
  const cancellable: ExchangeState[] = [
    "draft", "awaiting_clarification", "awaiting_approval", "staged", "delivered",
    "running", "needs_input", "terminal_idle", "interrupted",
  ];
  for (const state of cancellable) {
    it(`cancels from ${state}`, () => {
      const [m, id] = exchangeIn(state);
      const r = m.cancel(id, "operator said stop");
      assert.ok(r.ok, `cancel from ${state} must succeed`);
      assert.equal(r.snapshot!.state, "cancelled");
    });
  }

  const terminal: ExchangeState[] = ["agent_complete", "agent_failed", "cancelled"];
  for (const state of terminal) {
    it(`refuses to cancel from terminal state ${state}`, () => {
      const [m, id] = exchangeIn(state);
      const r = m.cancel(id);
      assert.equal(r.ok, false, `cancel from ${state} must be refused`);
      assert.equal(m.get(id)!.state, state, "terminal state must be preserved");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// 5. Restart recovery / quarantine (spec §4)
// ---------------------------------------------------------------------------------------------
describe("exchange lifecycle: restart quarantine", () => {
  it("recoveryDisposition: pre-commitment states are kept", () => {
    for (const s of ["draft", "awaiting_clarification", "awaiting_approval"] as ExchangeState[]) {
      assert.equal(recoveryDisposition(s), "keep", s);
    }
  });

  it("recoveryDisposition: uncertain in-flight states are interrupted", () => {
    for (const s of ["staged", "delivered", "running", "needs_input", "terminal_idle"] as ExchangeState[]) {
      assert.equal(recoveryDisposition(s), "interrupt", s);
    }
  });

  it("recoveryDisposition: settled states are kept", () => {
    for (const s of ["agent_complete", "agent_failed", "cancelled", "interrupted"] as ExchangeState[]) {
      assert.equal(recoveryDisposition(s), "keep", s);
    }
  });

  it("recoverOnBoot quarantines every uncertain in-flight exchange to interrupted", () => {
    const m = new ExchangeMachine();
    const ids: Partial<Record<ExchangeState, string>> = {};
    // One exchange per representative state, built on the SAME machine instance.
    const mk = (instruction: string) => m.create({
      projectId: "p", paneId: `pane-${instruction}`,
      operatorUtterance: "u", distilledInstruction: instruction,
    }).exchangeId;
    ids.draft = mk("d");
    ids.awaiting_approval = mk("a"); m.requestApproval(ids.awaiting_approval!, "appr-a");
    ids.staged = mk("s"); m.stageAutoExecute(ids.staged!); m.markDeliveryAttempted(ids.staged!);
    ids.delivered = mk("v"); m.stageAutoExecute(ids.delivered!); m.markDeliveryAttempted(ids.delivered!); m.markDelivered(ids.delivered!);
    ids.running = mk("r"); m.stageAutoExecute(ids.running!); m.markDeliveryAttempted(ids.running!); m.markDelivered(ids.running!); m.markRunning(ids.running!);
    ids.agent_complete = mk("c");
    m.stageAutoExecute(ids.agent_complete!); m.markDeliveryAttempted(ids.agent_complete!);
    m.markDelivered(ids.agent_complete!); m.markRunning(ids.agent_complete!);
    m.markTerminalIdle(ids.agent_complete!); m.markAgentComplete(ids.agent_complete!, "done");

    const out = m.recoverOnBoot();

    assert.equal(m.get(ids.draft!)!.state, "draft", "draft survives");
    assert.equal(m.get(ids.awaiting_approval!)!.state, "awaiting_approval", "awaiting_approval survives");
    assert.equal(m.get(ids.staged!)!.state, "interrupted", "staged (uncertain write) quarantined");
    assert.equal(m.get(ids.delivered!)!.state, "interrupted", "delivered quarantined (PTY gone)");
    assert.equal(m.get(ids.running!)!.state, "interrupted", "running quarantined (PTY gone)");
    assert.equal(m.get(ids.agent_complete!)!.state, "agent_complete", "settled exchange untouched");

    assert.ok(out.interrupted.includes(ids.staged!));
    assert.ok(out.interrupted.includes(ids.delivered!));
    assert.ok(out.interrupted.includes(ids.running!));
    assert.ok(out.kept.includes(ids.draft!));
    assert.ok(!out.interrupted.includes(ids.agent_complete!));
  });

  it("recovery NEVER resends: delivery_attempt is unchanged and nothing flips to delivered", () => {
    const m = new ExchangeMachine();
    const id = m.create({
      projectId: "p", paneId: "pane-1",
      operatorUtterance: "u", distilledInstruction: "i",
    }).exchangeId;
    m.stageAutoExecute(id);
    m.markDeliveryAttempted(id); // crash happened between attempt and success
    m.recoverOnBoot();
    const s = m.get(id)!;
    assert.equal(s.state, "interrupted");
    assert.equal(s.deliveryAttempt, 1, "recovery must not add attempts");
    assert.equal(s.deliveredAt, null, "recovery must not invent a delivery");
  });

  it("an interrupted exchange can only be dismissed (cancel), never resumed", () => {
    const [m, id] = exchangeIn("interrupted");
    assert.equal(m.markRunning(id).ok, false, "no resume to running");
    assert.equal(m.markDelivered(id).ok, false, "no late delivery success");
    assert.equal(m.markDeliveryAttempted(id).ok, false, "no re-send");
    const r = m.cancel(id, "operator dismissed the quarantined exchange");
    assert.ok(r.ok);
    assert.equal(r.snapshot!.state, "cancelled");
  });
});
