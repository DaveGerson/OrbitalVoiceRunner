// tests/test_exchange_correlation.ts
//
// AgentExchange spine — RED-FIRST correlation invariants (Phase 1, step 1.1; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §4-§5).
//
// This suite imports `../src/exchanges/service`, which DOES NOT EXIST YET — the suite must
// fail (module-not-found) until step 1.3 implements it. It pins the invariants that keep the
// spine an honest CORRELATOR instead of a guesser:
//   - unrelated pane activity can never settle an exchange;
//   - pane activity BEFORE delivery never advances an exchange (no retroactive adoption);
//   - two exchanges on one pane stay independent — a new delivery supersedes (interrupts) the
//     earlier in-flight exchange, and settled exchanges on the pane are never touched;
//   - legacy/manual command writes stay uncorrelated forever (never adopted, even when the
//     text matches a delivered instruction byte-for-byte);
//   - post-boot signals never settle pre-boot in-flight exchanges (recovery quarantines them;
//     it never invents historical correlation).
//
// Contract expected from src/exchanges/service:
//   export class ExchangeService {
//     constructor(opts?: { now?: () => number });
//     createExchange(input: { projectId: string; paneId: string; operatorUtterance: string;
//                             distilledInstruction: string }): ExchangeSnapshot;   // 'draft'
//     get(id: string): ExchangeSnapshot | undefined;
//     stageForDelivery(id: string): LifecycleResult;   // draft -> staged (gate already decided)
//     recordDelivery(id: string): LifecycleResult;     // attempt + delivered; binds the pane's
//                                                      // ACTIVE exchange; supersedes (interrupts)
//                                                      // a prior in-flight exchange on that pane;
//                                                      // records the command write with exchange_id
//     recordCompletionReport(id: string, summary: string): LifecycleResult; // terminal_idle -> agent_complete
//     onPaneSignal(sig: { paneId: string; kind: "running" | "quiescing" | "idle" | "prompt"
//                               | "error" | "exited"; detail?: string }): SettleOutcome[];
//     recordManualCommand(paneId: string, command: string): void;  // legacy/raw write — no exchange
//     commandLog(paneId: string): Array<{ command: string; exchangeId: string | null }>;
//     recoverOnBoot(): { interrupted: string[] };
//   }
//   SettleOutcome = { exchangeId: string; state: ExchangeState }
//
// Signal -> transition mapping under test (spec §1.4): running -> terminal_running,
// idle -> terminal_idle, prompt -> needs_input_detected, error/exited -> agent_failure_reported,
// quiescing -> advisory only (no state change).

import { describe, it } from "node:test";
import assert from "node:assert";

import { ExchangeService } from "../src/exchanges/service";

/** Create + stage + deliver one exchange on `paneId`; returns its id. */
function delivered(svc: InstanceType<typeof ExchangeService>, paneId: string, instruction = "run tests"): string {
  const snap = svc.createExchange({
    projectId: "proj-1",
    paneId,
    operatorUtterance: `please ${instruction}`,
    distilledInstruction: instruction,
  });
  const staged = svc.stageForDelivery(snap.exchangeId);
  assert.ok(staged.ok, `stageForDelivery failed: ${(staged as any).reason}`);
  const del = svc.recordDelivery(snap.exchangeId);
  assert.ok(del.ok, `recordDelivery failed: ${(del as any).reason}`);
  assert.equal(svc.get(snap.exchangeId)!.state, "delivered");
  return snap.exchangeId;
}

describe("exchange correlation: unrelated pane activity never settles an exchange", () => {
  it("a signal on a DIFFERENT pane advances nothing", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    const settled = svc.onPaneSignal({ paneId: "pane-2", kind: "idle", detail: "finished" });
    assert.deepEqual(settled, [], "no exchange may settle off another pane's edge");
    assert.equal(svc.get(id)!.state, "delivered", "the pane-1 exchange is untouched");
  });

  it("an error on a DIFFERENT pane cannot fail an exchange", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });
    const settled = svc.onPaneSignal({ paneId: "pane-2", kind: "error", detail: "Error: boom" });
    assert.deepEqual(settled, []);
    assert.equal(svc.get(id)!.state, "running");
  });

  it("signals for a pane with no exchanges are a harmless no-op (no throw, empty result)", () => {
    const svc = new ExchangeService();
    assert.deepEqual(svc.onPaneSignal({ paneId: "pane-ghost", kind: "idle" }), []);
    assert.deepEqual(svc.onPaneSignal({ paneId: "pane-ghost", kind: "exited" }), []);
  });
});

describe("exchange correlation: pre-delivery activity is never adopted", () => {
  it("a draft exchange is not advanced by its own target pane's signals", () => {
    const svc = new ExchangeService();
    const snap = svc.createExchange({
      projectId: "proj-1", paneId: "pane-1",
      operatorUtterance: "u", distilledInstruction: "i",
    });
    const settled = svc.onPaneSignal({ paneId: "pane-1", kind: "idle" });
    assert.deepEqual(settled, []);
    assert.equal(svc.get(snap.exchangeId)!.state, "draft");
  });

  it("a STAGED (approved, not yet written) exchange is not settled by pane signals", () => {
    // The write has not landed — an idle/running edge on the target pane belongs to whatever
    // the pane was already doing, not to this exchange.
    const svc = new ExchangeService();
    const snap = svc.createExchange({
      projectId: "proj-1", paneId: "pane-1",
      operatorUtterance: "u", distilledInstruction: "i",
    });
    svc.stageForDelivery(snap.exchangeId);
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });
    svc.onPaneSignal({ paneId: "pane-1", kind: "idle" });
    assert.equal(svc.get(snap.exchangeId)!.state, "staged", "staged must wait for its OWN delivery");
  });
});

describe("exchange correlation: signal -> transition mapping for the pane's active exchange", () => {
  it("running / prompt / idle advance the delivered exchange through the observation states", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");

    let settled = svc.onPaneSignal({ paneId: "pane-1", kind: "running" });
    assert.deepEqual(settled.map((s) => s.exchangeId), [id]);
    assert.equal(svc.get(id)!.state, "running");

    settled = svc.onPaneSignal({ paneId: "pane-1", kind: "prompt", detail: "y/n?" });
    assert.deepEqual(settled.map((s) => s.exchangeId), [id]);
    assert.equal(svc.get(id)!.state, "needs_input");

    settled = svc.onPaneSignal({ paneId: "pane-1", kind: "running" });
    assert.equal(svc.get(id)!.state, "running", "input supplied -> back to running");

    settled = svc.onPaneSignal({ paneId: "pane-1", kind: "idle", detail: "done" });
    assert.deepEqual(settled.map((s) => s.exchangeId), [id]);
    assert.equal(svc.get(id)!.state, "terminal_idle");
  });

  it("quiescing is advisory only — it never changes exchange state", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });
    const settled = svc.onPaneSignal({ paneId: "pane-1", kind: "quiescing" });
    assert.deepEqual(settled, [], "quiescing is humble: not a settle edge");
    assert.equal(svc.get(id)!.state, "running");
  });

  it("a fast command can settle delivered -> terminal_idle without a running edge", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    const settled = svc.onPaneSignal({ paneId: "pane-1", kind: "idle" });
    assert.deepEqual(settled.map((s) => s.exchangeId), [id]);
    assert.equal(svc.get(id)!.state, "terminal_idle");
  });

  it("exited fails the active exchange; the completion report is what completes one", () => {
    const svc = new ExchangeService();
    const a = delivered(svc, "pane-1");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });
    svc.onPaneSignal({ paneId: "pane-1", kind: "exited" });
    assert.equal(svc.get(a)!.state, "agent_failed");

    const b = delivered(svc, "pane-2");
    svc.onPaneSignal({ paneId: "pane-2", kind: "idle" });
    const r = svc.recordCompletionReport(b, "build green, 0 failures");
    assert.ok(r.ok);
    assert.equal(svc.get(b)!.state, "agent_complete");
    assert.equal(svc.get(b)!.resultSummary, "build green, 0 failures");
  });
});

describe("exchange correlation: two exchanges on one pane stay independent", () => {
  it("a second delivery supersedes the earlier IN-FLIGHT exchange (interrupted, not settled)", () => {
    const svc = new ExchangeService();
    const a = delivered(svc, "pane-1", "first instruction");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" }); // A is in flight
    const b = delivered(svc, "pane-1", "second instruction"); // operator barged in
    assert.equal(svc.get(a)!.state, "interrupted", "A was superseded — settled-but-uncertain");
    assert.equal(svc.get(b)!.state, "delivered");
  });

  it("after supersession, pane signals settle ONLY the new active exchange", () => {
    const svc = new ExchangeService();
    const a = delivered(svc, "pane-1", "first");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });
    const b = delivered(svc, "pane-1", "second");
    const settled = svc.onPaneSignal({ paneId: "pane-1", kind: "idle" });
    assert.deepEqual(settled.map((s) => s.exchangeId), [b], "only B settles");
    assert.equal(svc.get(b)!.state, "terminal_idle");
    assert.equal(svc.get(a)!.state, "interrupted", "A must never be revived or settled");
  });

  it("a SETTLED exchange on the pane is never touched by later activity", () => {
    const svc = new ExchangeService();
    const a = delivered(svc, "pane-1", "first");
    svc.onPaneSignal({ paneId: "pane-1", kind: "idle" });
    svc.recordCompletionReport(a, "done");
    const aCompletedAt = svc.get(a)!.completedAt;
    assert.equal(svc.get(a)!.state, "agent_complete");

    const b = delivered(svc, "pane-1", "second");
    svc.onPaneSignal({ paneId: "pane-1", kind: "error", detail: "Error: boom" });
    assert.equal(svc.get(b)!.state, "agent_failed", "the new exchange takes the edge");
    assert.equal(svc.get(a)!.state, "agent_complete", "the settled exchange is immutable");
    assert.equal(svc.get(a)!.completedAt, aCompletedAt, "its completion stamp never moves");
  });
});

describe("exchange correlation: legacy/manual commands are never adopted", () => {
  it("a manual write is recorded with exchangeId null", () => {
    const svc = new ExchangeService();
    svc.recordManualCommand("pane-1", "npm test");
    assert.deepEqual(svc.commandLog("pane-1"), [{ command: "npm test", exchangeId: null }]);
  });

  it("only the delivery-path write carries the exchange_id — identical text does not adopt", () => {
    const svc = new ExchangeService();
    svc.recordManualCommand("pane-1", "npm test");          // before any exchange
    const id = delivered(svc, "pane-1", "npm test");        // the exchange delivery itself
    svc.recordManualCommand("pane-1", "npm test");          // operator typed it again by hand

    const log = svc.commandLog("pane-1");
    assert.equal(log.length, 3);
    assert.deepEqual(log.map((e) => e.exchangeId), [null, id, null],
      "byte-identical legacy commands must stay uncorrelated, before AND after the delivery");
    assert.deepEqual(log.map((e) => e.command), ["npm test", "npm test", "npm test"]);
  });

  it("manual writes on the pane do not advance the exchange lifecycle", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    svc.recordManualCommand("pane-1", "ls -la");
    assert.equal(svc.get(id)!.state, "delivered", "a manual write is not an exchange event");
  });
});

describe("exchange correlation: recovery never invents history", () => {
  it("post-boot signals cannot settle a pre-boot in-flight exchange", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });

    const out = svc.recoverOnBoot(); // process restarted; PTYs are gone (panes boot inert)
    assert.ok(out.interrupted.includes(id), "in-flight exchange is quarantined");
    assert.equal(svc.get(id)!.state, "interrupted");

    // The pane comes back to life doing something ELSE — its edges must not touch the quarantine.
    const settled = svc.onPaneSignal({ paneId: "pane-1", kind: "idle", detail: "fresh boot idle" });
    assert.deepEqual(settled, []);
    assert.equal(svc.get(id)!.state, "interrupted", "never settled by post-boot activity");
  });

  it("recovery leaves pre-commitment exchanges alone and does not resend them", () => {
    const svc = new ExchangeService();
    const snap = svc.createExchange({
      projectId: "proj-1", paneId: "pane-1",
      operatorUtterance: "u", distilledInstruction: "i",
    });
    const out = svc.recoverOnBoot();
    assert.ok(!out.interrupted.includes(snap.exchangeId));
    assert.equal(svc.get(snap.exchangeId)!.state, "draft");
    assert.equal(svc.get(snap.exchangeId)!.deliveryAttempt, 0, "recovery never delivers");
    assert.deepEqual(svc.commandLog("pane-1"), [], "recovery writes NOTHING to any pane");
  });
});
