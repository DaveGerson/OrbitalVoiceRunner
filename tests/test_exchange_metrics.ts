// tests/test_exchange_metrics.ts
//
// AgentExchange spine — communication-quality METRICS (Phase 5, Step 5.2; src/exchanges/metrics.ts).
// Pins each metric against a constructed fixture DB with known counts/latencies, the deterministic
// nearest-rank percentiles, wrong-target/duplicate-delivery anomaly detection on planted fixtures,
// and the zero-activity "all-zero report" baseline.

import { describe, it } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import {
  buildExchangeMetricsReport,
  UNCORRELATED_COMPLETIONS_NOTE,
  NOTIFICATION_LATENCY_NOTE,
  SPEECH_TO_DRAFT_LATENCY_NOTE,
  CLARIFICATION_PRE_EXCHANGE_NOTE,
  type ExchangeMetricsReport,
} from "../src/exchanges/metrics";
import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import type { ActionContext } from "../src/actions/types";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

describe("metrics: zero-activity DB -> all-zero report", () => {
  it("every count/rate is zero/null/empty; nothing is fabricated", () => {
    const s = freshStore();
    const report = buildExchangeMetricsReport(s);
    assert.strictEqual(report.sinceMs, 0);
    assert.strictEqual(report.exchangeCount, 0);
    assert.strictEqual(report.eventCount, 0);
    assert.strictEqual(report.wrongTargetDeliveries, 0);
    assert.strictEqual(report.duplicateDeliveries, 0);
    assert.strictEqual(report.uncorrelatedCompletions, null);
    assert.deepStrictEqual(report.clarificationCauses, {});
    assert.deepStrictEqual(report.draftEditCounts, {});
    assert.strictEqual(report.speechToDraftLatency, null);
    assert.strictEqual(report.deliveryLatency, null);
    assert.strictEqual(report.needsInputNotificationLatency, null);
    assert.strictEqual(report.resultNotificationLatency, null);
    assert.deepStrictEqual(report.contextCost, {
      deliveredExchangesWithContext: 0, totalDeliveries: 0, totalIncludedSources: 0, totalDroppedSources: 0,
    });
    assert.deepStrictEqual(report.recoveryState, {
      interruptedEvents: 0, revertedMissingApprovalEvents: 0, retriedEvents: 0, currentlyInterruptedExchanges: 0,
    });
    assert.deepStrictEqual(report.notes, [
      UNCORRELATED_COMPLETIONS_NOTE,
      NOTIFICATION_LATENCY_NOTE,
      SPEECH_TO_DRAFT_LATENCY_NOTE,
      CLARIFICATION_PRE_EXCHANGE_NOTE,
    ]);
    s.close();
  });
});

describe("metrics: wrongTargetDeliveries — planted anomaly fires, honest traffic does not", () => {
  it("fires when target_resolved names a different pane than the exchange's own delivery pane", () => {
    const s = freshStore();
    const bad = s.insertExchange({ project_id: "p1", pane_id: "pane-a", state: "delivered" });
    s.appendExchangeEvent({
      exchange_id: bad.exchange_id, event_type: "target_resolved", pane_id: "pane-a", ts: 1000,
      payload_redacted_json: JSON.stringify({ paneId: "pane-b" }),
    });
    const good = s.insertExchange({ project_id: "p1", pane_id: "pane-c", state: "delivered" });
    s.appendExchangeEvent({
      exchange_id: good.exchange_id, event_type: "target_resolved", pane_id: "pane-c", ts: 1000,
      payload_redacted_json: JSON.stringify({ paneId: "pane-c" }),
    });
    const report = buildExchangeMetricsReport(s);
    assert.strictEqual(report.wrongTargetDeliveries, 1);
    s.close();
  });
});

describe("metrics: duplicateDeliveries — adjacency detection", () => {
  it("flags a second delivery_succeeded with no attempt/retry marker between them", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "delivered" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_attempted", ts: 1000 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_succeeded", ts: 1010 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_succeeded", ts: 1020 }); // duplicate: no reset marker before this one
    const report = buildExchangeMetricsReport(s);
    assert.strictEqual(report.duplicateDeliveries, 1);
    s.close();
  });

  it("does NOT flag a legitimate retry (a reset marker sits between the two successes)", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "delivered" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_attempted", ts: 1000 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_succeeded", ts: 1010 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_failed", ts: 1020 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "retry_initiated", ts: 1030 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_succeeded", ts: 1040 });
    const report = buildExchangeMetricsReport(s);
    assert.strictEqual(report.duplicateDeliveries, 0);
    s.close();
  });
});

describe("metrics: clarificationCauses", () => {
  it("buckets by payload.cause, defaulting blank/absent to 'unspecified'", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "clarification_requested", ts: 1000,
      payload_redacted_json: JSON.stringify({ cause: "missing_target" }),
    });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "clarification_requested", ts: 1100,
      payload_redacted_json: JSON.stringify({ cause: "missing_target" }),
    });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "clarification_requested", ts: 1200,
      payload_redacted_json: JSON.stringify({ cause: "missing_objective" }),
    });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "clarification_requested", ts: 1300 });
    const report = buildExchangeMetricsReport(s);
    assert.deepStrictEqual(report.clarificationCauses, {
      missing_target: 2, missing_objective: 1, unspecified: 1,
    });
    s.close();
  });
});

describe("metrics: draftEditCounts", () => {
  it("counts draft_revised events per exchange_id; only edited exchanges appear", () => {
    const s = freshStore();
    const edited = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    const untouched = s.insertExchange({ project_id: "p1", pane_id: "pane-2", state: "draft" });
    void untouched;
    for (let i = 0; i < 3; i++) {
      s.appendExchangeEvent({ exchange_id: edited.exchange_id, event_type: "draft_revised", ts: 1000 + i });
    }
    const report = buildExchangeMetricsReport(s);
    assert.deepStrictEqual(report.draftEditCounts, { [edited.exchange_id]: 3 });
    s.close();
  });
});

describe("metrics: latency percentiles — deterministic nearest-rank", () => {
  it("speechToDraftLatency: exchange_created -> first draft-milestone event (draft_revised), p50/p95 over 4 known samples", () => {
    const s = freshStore();
    const samples = [100, 200, 300, 400];
    samples.forEach((ms, i) => {
      const row = s.insertExchange({ project_id: "p1", pane_id: `pane-${i}`, state: "draft" });
      s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "exchange_created", ts: 1000 });
      // target_resolved is co-timestamped with exchange_created at mint (persistCreate) — it is no
      // longer a draft milestone (that was the speechToDraftLatency artifact this suite closes).
      s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "target_resolved", ts: 1000 });
      s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "draft_revised", ts: 1000 + ms });
    });
    const report = buildExchangeMetricsReport(s);
    assert.ok(report.speechToDraftLatency);
    assert.strictEqual(report.speechToDraftLatency!.count, 4);
    assert.strictEqual(report.speechToDraftLatency!.p50, 200, "nearest-rank p50 over [100,200,300,400]");
    assert.strictEqual(report.speechToDraftLatency!.p95, 400, "nearest-rank p95 over [100,200,300,400]");
    s.close();
  });

  it("speechToDraftLatency: a persistCreate-shaped fixture (exchange_created + co-timestamped target_resolved, no later milestone) yields null — the co-timestamp artifact is gone", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "exchange_created", ts: 1000 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "target_resolved", ts: 1000 });
    const report = buildExchangeMetricsReport(s);
    assert.strictEqual(report.speechToDraftLatency, null, "target_resolved alone must no longer yield a spurious 0 sample");
    s.close();
  });

  it("speechToDraftLatency: exchange_created + co-timestamped target_resolved + delivery_attempted(1300) measures created->first GENUINE forward progress (300ms), not the mint-time resolve", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "exchange_created", ts: 1000 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "target_resolved", ts: 1000 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_attempted", ts: 1300 });
    const report = buildExchangeMetricsReport(s);
    assert.ok(report.speechToDraftLatency);
    assert.strictEqual(report.speechToDraftLatency!.count, 1);
    assert.strictEqual(report.speechToDraftLatency!.p50, 300);
    s.close();
  });

  it("deliveryLatency: latest of {approval_confirmed, delivery_attempted, retry_initiated} -> delivery_succeeded", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "delivered" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "approval_confirmed", ts: 2000 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_attempted", ts: 2100 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_succeeded", ts: 2400 });
    const report = buildExchangeMetricsReport(s);
    assert.ok(report.deliveryLatency);
    assert.strictEqual(report.deliveryLatency!.count, 1);
    assert.strictEqual(report.deliveryLatency!.p50, 300, "2400 - 2100 (the LATEST start marker wins)");
    s.close();
  });

  it("both latencies are null when no exchange has the qualifying event pair", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "exchange_created", ts: 1000 });
    const report = buildExchangeMetricsReport(s);
    assert.strictEqual(report.speechToDraftLatency, null);
    assert.strictEqual(report.deliveryLatency, null);
    s.close();
  });
});

describe("metrics: contextCost", () => {
  it("joins context_deliveries matching an exchange's own (project, session, context_version)", () => {
    const s = freshStore();
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "delivered",
      voice_session_id: "sess-1", context_version: "2",
    });
    s.insertContextDelivery({
      context_version: "2", trigger: "manual", project_id: "p1", voice_session_id: "sess-1",
      included_sources_json: JSON.stringify(["a", "b", "c"]), dropped_sources_json: JSON.stringify(["d"]),
    });
    // A delivery for a different session must never be counted against this exchange.
    s.insertContextDelivery({ context_version: "2", trigger: "manual", project_id: "p1", voice_session_id: "sess-OTHER" });
    void row;
    const report = buildExchangeMetricsReport(s);
    assert.strictEqual(report.contextCost.deliveredExchangesWithContext, 1);
    assert.strictEqual(report.contextCost.totalDeliveries, 1);
    assert.strictEqual(report.contextCost.totalIncludedSources, 3);
    assert.strictEqual(report.contextCost.totalDroppedSources, 1);
    s.close();
  });
});

describe("metrics: recoveryState", () => {
  it("buckets exchange_recovered by disposition, counts retry_initiated, and currently-interrupted rows", () => {
    const s = freshStore();
    const interrupted = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "interrupted" });
    s.appendExchangeEvent({
      exchange_id: interrupted.exchange_id, event_type: "exchange_recovered", ts: 1000,
      payload_redacted_json: JSON.stringify({ disposition: "interrupted", reason: "boot_quarantine" }),
    });
    const reverted = s.insertExchange({ project_id: "p1", pane_id: "pane-2", state: "draft" });
    s.appendExchangeEvent({
      exchange_id: reverted.exchange_id, event_type: "exchange_recovered", ts: 1100,
      payload_redacted_json: JSON.stringify({ disposition: "reverted_missing_approval" }),
    });
    const retried = s.insertExchange({ project_id: "p1", pane_id: "pane-3", state: "delivered" });
    s.appendExchangeEvent({ exchange_id: retried.exchange_id, event_type: "retry_initiated", ts: 1200 });
    s.appendExchangeEvent({ exchange_id: retried.exchange_id, event_type: "retry_initiated", ts: 1300 });

    const report = buildExchangeMetricsReport(s);
    assert.deepStrictEqual(report.recoveryState, {
      interruptedEvents: 1, revertedMissingApprovalEvents: 1, retriedEvents: 2,
      currentlyInterruptedExchanges: 1,
    });
    s.close();
  });
});

describe("metrics: clarificationCauses — parity guard against the live producer shape", () => {
  it("a clarification_requested event with payload.cause='dispatch_clarify' (the exact shape recordClarificationRequested writes) makes clarificationCauses non-empty", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "clarification_requested", ts: 1000,
      payload_redacted_json: JSON.stringify({ cause: "dispatch_clarify" }),
    });
    const report = buildExchangeMetricsReport(s);
    assert.deepStrictEqual(report.clarificationCauses, { dispatch_clarify: 1 });
    s.close();
  });
});

describe("metrics: window (sinceMs) scoping", () => {
  it("excludes exchanges/events created before sinceMs", () => {
    const s = freshStore();
    const old = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft", created_at: 500 });
    s.appendExchangeEvent({ exchange_id: old.exchange_id, event_type: "draft_revised", ts: 500 });
    const recent = s.insertExchange({ project_id: "p1", pane_id: "pane-2", state: "draft", created_at: 5000 });
    s.appendExchangeEvent({ exchange_id: recent.exchange_id, event_type: "draft_revised", ts: 5000 });

    const report = buildExchangeMetricsReport(s, { sinceMs: 2000 });
    assert.strictEqual(report.exchangeCount, 1);
    assert.strictEqual(report.eventCount, 1);
    assert.deepStrictEqual(report.draftEditCounts, { [recent.exchange_id]: 1 });
    s.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The `get_exchange_metrics` ActionDef (src/actions/defs/observability.ts) — proving the REGISTRY/
// REST wiring itself (rest-only surface, ungated read, since_ms/limit coercion, runAction dispatch),
// not just buildExchangeMetricsReport's own math the describe blocks above already cover directly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
function makeMetricsActionCtx(store: JanusStore | null): ActionContext {
  // runAction's readOnly leg calls ctx.redact on the result before returning it — a minimal fake
  // context still needs this (unlike a direct handler call, which skips runAction's pipeline).
  return { manager: { terminals: {} }, session: null, store, redact: (s: string) => s } as unknown as ActionContext;
}

describe("get_exchange_metrics ActionDef registered in REGISTRY (rest-only, ungated read)", () => {
  it("is registered, rest-only, readOnly, and dispatches to buildExchangeMetricsReport via runAction", async () => {
    const def = REGISTRY.find((d) => d.name === "get_exchange_metrics");
    assert.ok(def, "get_exchange_metrics missing from REGISTRY");
    assert.ok(!def!.surfaces.has("voice"), "get_exchange_metrics is rest-only (not a voice tool)");
    assert.ok(def!.surfaces.has("rest"), "get_exchange_metrics must be a rest surface");
    assert.ok(def!.readOnly, "get_exchange_metrics must be readOnly");
    assert.strictEqual(def!.rest!.method, "get");

    const s = freshStore();
    s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    // z.coerce.number → a REST query string ("since_ms=0") coerces to a number, mirroring
    // ActionLogParams's own REST-query-string coercion contract. runAction itself parses rawArgs
    // through def.params, so passing the raw (string) query-string shape here exercises that
    // coercion boundary exactly as a real REST request would.
    const result = await runAction(REGISTRY, "get_exchange_metrics", { since_ms: "0" }, makeMetricsActionCtx(s));
    assert.strictEqual(result.kind, "ok");
    const report = (result as { kind: "ok"; output: ExchangeMetricsReport }).output;
    assert.strictEqual(report.exchangeCount, 1);
    s.close();
  });

  it("reports a clean 'no durable store wired' output when ctx.store is null", async () => {
    const result = await runAction(REGISTRY, "get_exchange_metrics", {}, makeMetricsActionCtx(null));
    assert.strictEqual(result.kind, "ok");
  });
});
