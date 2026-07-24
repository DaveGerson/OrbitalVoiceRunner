// tests/test_exchange_metrics_live.ts
//
// Bead 9d8d — LIVE producer-chain parity. Proves the REAL ExchangeService producer chain
// (ExchangeService.recordClarificationRequested, the call src/voice/index.ts's
// settleExchangeForDispatch makes) reaches buildExchangeMetricsReport non-empty — closing the
// parity the benchmark's metrics_5_2 cross-check documents as a gap. Constructs a real
// ExchangeService, attaches a :memory: JanusStore.

import { describe, it } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import { ExchangeService } from "../src/exchanges/service";
import { buildExchangeMetricsReport } from "../src/exchanges/metrics";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

describe("live producer chain: ExchangeService -> exchange_events -> buildExchangeMetricsReport", () => {
  it("recordClarificationRequested persists a clarification_requested event the metrics report picks up", () => {
    const s = freshStore();
    const svc = new ExchangeService({ store: s });
    const snap = svc.createExchange({
      projectId: "p1",
      paneId: "pane-1",
      operatorUtterance: "please run the tests",
      distilledInstruction: "run tests",
    });
    svc.recordClarificationRequested(snap.exchangeId, "dispatch_clarify");

    const report = buildExchangeMetricsReport(s);
    assert.deepStrictEqual(report.clarificationCauses, { dispatch_clarify: 1 });
    s.close();
  });

  it("redacts a planted secret in the cause before it reaches the durable event payload", () => {
    const s = freshStore();
    const svc = new ExchangeService({ store: s });
    const snap = svc.createExchange({
      projectId: "p1",
      paneId: "pane-1",
      operatorUtterance: "please run the tests",
      distilledInstruction: "run tests",
    });
    const secret = "AIza" + "A".repeat(35);
    svc.recordClarificationRequested(snap.exchangeId, `leaked key ${secret}`);

    const events = s.listExchangeEventsSince(0);
    const clarify = events.find((e) => e.event_type === "clarification_requested");
    assert.ok(clarify, "clarification_requested event missing");
    assert.ok(!clarify!.payload_redacted_json.includes(secret), "raw secret leaked past the redaction boundary");
    assert.ok(clarify!.payload_redacted_json.includes("[REDACTED"), "expected a scrub placeholder in the persisted payload");
    s.close();
  });

  it("with no store attached, recordClarificationRequested is a no-op and never throws", () => {
    const svc = new ExchangeService();
    const snap = svc.createExchange({
      projectId: "p1",
      paneId: "pane-1",
      operatorUtterance: "please run the tests",
      distilledInstruction: "run tests",
    });
    assert.doesNotThrow(() => svc.recordClarificationRequested(snap.exchangeId, "dispatch_clarify"));

    const s = freshStore();
    const report = buildExchangeMetricsReport(s);
    assert.deepStrictEqual(report.clarificationCauses, {});
    s.close();
  });
});
