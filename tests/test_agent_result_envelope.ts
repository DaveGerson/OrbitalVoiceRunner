// tests/test_agent_result_envelope.ts
//
// AgentExchange spine — Phase 4, Step 4.1: the agent RESULT ENVELOPE parser
// (src/exchanges/resultEnvelope.ts) and its trust-boundary integration with
// ExchangeService.recordReportedOutcome (src/exchanges/service.ts).
//
// Covers: schema validation (valid/malformed/oversize/unknown-status/missing-id), matching-marker
// acceptance, wrong-id ignored, stale-after-retry ignored, forged-id-for-other-pane ignored,
// redaction of summary/evidence (a planted secret), detection-contract cases (embedded in noisy
// output, truncated JSON, multiple envelopes -> last valid wins), and flag-off -> no parsing.

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  scanForResultEnvelope,
  readResultEnvelopeMode,
  resultEnvelopeActive,
  RESULT_ENVELOPE_MODE,
  COMPLETION_REQUEST_LINE,
  withExchangeCorrelationHint,
} from "../src/exchanges/resultEnvelope";
import { ExchangeService } from "../src/exchanges/service";
import { RENDER_PROFILES, renderEnvelope, type InstructionEnvelope } from "../src/exchanges/instructionEnvelope";

/** Create + stage + deliver one exchange on `paneId`; returns its id. Mirrors the identical
 *  helper in tests/test_exchange_correlation.ts. */
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
  return snap.exchangeId;
}

const ACCEPT = { mode: "accept" as const };

// ── flag ─────────────────────────────────────────────────────────────────────────────────────

describe("resultEnvelope: flag semantics", () => {
  it("defaults to off when unset/unrecognized", () => {
    assert.equal(readResultEnvelopeMode({}), "off");
    assert.equal(readResultEnvelopeMode({ JANUS_AGENT_RESULT_ENVELOPE: "bogus" }), "off");
    assert.equal(resultEnvelopeActive("off"), false);
  });

  it("accept and request are both active modes", () => {
    assert.equal(readResultEnvelopeMode({ JANUS_AGENT_RESULT_ENVELOPE: "accept" }), "accept");
    assert.equal(readResultEnvelopeMode({ JANUS_AGENT_RESULT_ENVELOPE: "REQUEST" }), "request");
    assert.ok(resultEnvelopeActive("accept"));
    assert.ok(resultEnvelopeActive("request"));
  });

  it("module default mode is off (no env var set in this test run's expectation)", () => {
    // Not asserting process.env directly (CI may set it) — just that the cached constant is one
    // of the three valid modes and the reader is total.
    assert.ok(["off", "accept", "request"].includes(RESULT_ENVELOPE_MODE));
  });

  it("request mode reuses the ALREADY-EXISTING COMPLETION_REQUEST_LINE — no second prompt string", () => {
    // Coherence check (task A): resultEnvelope.ts re-exports the one existing invitation string
    // rather than minting a competing one.
    assert.match(COMPLETION_REQUEST_LINE, /done or blocked/i);
  });

  it("flag off -> no parsing, even over an otherwise-perfectly-valid envelope", () => {
    const text = JSON.stringify({ exchange_id: "exch_1", status: "complete", summary: "ok" });
    const scan = scanForResultEnvelope(text, { mode: "off" });
    assert.equal(scan.found, false);
    assert.equal(scan.candidatesSeen, 0);
  });
});

// ── schema validation ───────────────────────────────────────────────────────────────────────

describe("resultEnvelope: schema validation", () => {
  it("accepts a well-formed minimal envelope", () => {
    const text = JSON.stringify({ exchange_id: "exch_abc", status: "complete" });
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.ok(scan.found);
    assert.equal(scan.envelope!.exchangeId, "exch_abc");
    assert.equal(scan.envelope!.status, "complete");
    assert.equal(scan.envelope!.summary, "");
    assert.deepEqual(scan.envelope!.evidence, []);
    assert.equal(scan.envelope!.needsOperator, false);
  });

  it("accepts every field populated", () => {
    const text = JSON.stringify({
      exchange_id: "exch_abc",
      status: "needs_input",
      summary: "waiting on a y/n",
      evidence: ["line one", "line two"],
      needs_operator: true,
    });
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.ok(scan.found);
    assert.equal(scan.envelope!.status, "needs_input");
    assert.equal(scan.envelope!.needsOperator, true);
    assert.deepEqual(scan.envelope!.evidence, ["line one", "line two"]);
  });

  it("rejects missing exchange_id", () => {
    const text = JSON.stringify({ status: "complete", summary: "ok" });
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.equal(scan.found, false);
    assert.equal(scan.candidatesValid, 0);
  });

  it("rejects an unrecognized status value", () => {
    const text = JSON.stringify({ exchange_id: "exch_abc", status: "done" }); // not in the enum
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.equal(scan.found, false);
  });

  it("rejects malformed JSON", () => {
    const text = '{"exchange_id":"exch_abc","status":"complete"'; // missing closing brace
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.equal(scan.found, false);
  });

  it("rejects unknown keys (strict schema — untrusted input)", () => {
    const text = JSON.stringify({
      exchange_id: "exch_abc",
      status: "complete",
      extra_field: "should not be here",
    });
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.equal(scan.found, false);
  });

  it("rejects an oversize summary field", () => {
    const text = JSON.stringify({ exchange_id: "exch_abc", status: "complete", summary: "x".repeat(5000) });
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.equal(scan.found, false);
  });

  it("rejects a candidate substring larger than the per-candidate cap without attempting parse", () => {
    // A syntactically valid but enormous JSON object — must be skipped on size alone.
    const bloat = JSON.stringify({
      exchange_id: "exch_abc",
      status: "complete",
      evidence: Array.from({ length: 1 }, () => "y".repeat(9000)),
    });
    assert.ok(bloat.length > 8192, "fixture must exceed MAX_CANDIDATE_CHARS to test the cap");
    const scan = scanForResultEnvelope(bloat, ACCEPT);
    assert.equal(scan.found, false);
  });

  it("wrong TYPE for a field (needs_operator as a string) is rejected", () => {
    const text = JSON.stringify({ exchange_id: "exch_abc", status: "complete", needs_operator: "true" });
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.equal(scan.found, false);
  });
});

// ── redaction ────────────────────────────────────────────────────────────────────────────────

describe("resultEnvelope: redaction of summary/evidence", () => {
  it("scrubs a planted AWS access key out of both summary and evidence before returning", () => {
    const plantedSecret = "AKIAIOSFODNN7EXAMPLE";
    const text = JSON.stringify({
      exchange_id: "exch_abc",
      status: "complete",
      summary: `done, but leaked ${plantedSecret} in the log`,
      evidence: [`export AWS_KEY=${plantedSecret}`],
    });
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.ok(scan.found);
    assert.ok(!scan.envelope!.summary.includes(plantedSecret), "summary must not carry the raw secret");
    assert.ok(!scan.envelope!.evidence[0].includes(plantedSecret), "evidence must not carry the raw secret");
    assert.match(scan.envelope!.summary, /REDACTED/);
    // The persisted JSON string must ALSO be scrubbed (it's built from the redacted fields).
    assert.ok(!scan.envelope!.redactedEnvelopeJson.includes(plantedSecret));
  });

  it("an injectable redact function is honored (test double)", () => {
    const text = JSON.stringify({ exchange_id: "exch_abc", status: "complete", summary: "secret-token-xyz" });
    const scan = scanForResultEnvelope(text, { mode: "accept", redact: (s) => s.replace("secret-token-xyz", "<gone>") });
    assert.equal(scan.envelope!.summary, "<gone>");
  });
});

// ── detection contract ──────────────────────────────────────────────────────────────────────

describe("resultEnvelope: detection contract", () => {
  it("finds an envelope embedded in noisy surrounding pane output", () => {
    const envelope = { exchange_id: "exch_abc", status: "complete", summary: "all green" };
    const noisy = [
      "$ npm test",
      "..................",
      "142 passing (3.2s)",
      JSON.stringify(envelope),
      "$ ",
    ].join("\n");
    const scan = scanForResultEnvelope(noisy, ACCEPT);
    assert.ok(scan.found);
    assert.equal(scan.envelope!.exchangeId, "exch_abc");
  });

  it("a truncated/unbalanced trailing JSON object is never partially parsed", () => {
    const text = `some preamble ${JSON.stringify({ exchange_id: "exch_abc", status: "complete" }).slice(0, -5)}`;
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.equal(scan.found, false, "an unbalanced object must fail safe, never guess-close");
  });

  it("multiple envelopes in one window: the LAST valid one wins", () => {
    const first = { exchange_id: "exch_abc", status: "needs_input", summary: "first, superseded" };
    const second = { exchange_id: "exch_abc", status: "complete", summary: "second, corrected" };
    const text = `${JSON.stringify(first)}\n...\n${JSON.stringify(second)}`;
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.ok(scan.found);
    assert.equal(scan.candidatesValid, 2);
    assert.equal(scan.envelope!.status, "complete");
    assert.equal(scan.envelope!.summary, "second, corrected");
  });

  it("a later INVALID fragment never overrides an earlier valid envelope", () => {
    const valid = { exchange_id: "exch_abc", status: "complete", summary: "the real one" };
    const text = `${JSON.stringify(valid)}\n{"exchange_id":"exch_abc","status":"bogus-status"}`;
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.ok(scan.found);
    assert.equal(scan.envelope!.summary, "the real one");
  });

  it("plain output with no JSON at all is a clean, silent 'not found'", () => {
    const scan = scanForResultEnvelope("just a normal shell prompt\n$ ", ACCEPT);
    assert.equal(scan.found, false);
    assert.equal(scan.candidatesSeen, 0);
  });

  it("only scans the tail-anchored window (bounded scan, last-N-KB)", () => {
    const envelope = { exchange_id: "exch_abc", status: "complete", summary: "found me" };
    // Put the valid envelope WAY outside a tiny scan window, padded by filler after it.
    const text = JSON.stringify(envelope) + "z".repeat(200);
    const scan = scanForResultEnvelope(text, { mode: "accept", maxScanChars: 50 });
    assert.equal(scan.found, false, "the envelope fell outside the tail window and must not be found");
  });
});

// ── trust boundary: matching-marker acceptance, mismatch/stale/forged rejection ────────────────

describe("resultEnvelope + ExchangeService: trust-boundary correlation", () => {
  it("a matched envelope (exchange_id == the pane's active delivery marker) settles the exchange", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });

    const text = JSON.stringify({ exchange_id: id, status: "complete", summary: "build green" });
    const scan = scanForResultEnvelope(text, ACCEPT);
    assert.ok(scan.found);

    const outcome = svc.recordReportedOutcome("pane-1", scan.envelope!.exchangeId, scan.envelope!.status, scan.envelope!.summary, scan.envelope!.redactedEnvelopeJson);
    assert.ok(outcome);
    assert.equal(outcome!.state, "agent_complete");
    assert.equal(svc.get(id)!.state, "agent_complete");
    assert.equal(svc.get(id)!.resultSummary, "build green");
  });

  it("a WRONG exchange_id (mismatched active marker) is ignored — nothing settles", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });

    const outcome = svc.recordReportedOutcome("pane-1", "exch_not_the_active_one", "complete", "nope");
    assert.equal(outcome, null);
    assert.equal(svc.get(id)!.state, "running", "the real exchange must be untouched");
  });

  it("a STALE id from an already-superseded/retried delivery is ignored, even though it once existed", () => {
    const svc = new ExchangeService();
    const first = delivered(svc, "pane-1", "first instruction");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" }); // first is in flight
    const second = delivered(svc, "pane-1", "second instruction"); // operator retried/barged in
    assert.equal(svc.get(first)!.state, "interrupted", "supersession quarantines the earlier one");

    // A late-arriving envelope for the FIRST (now-stale) exchange must never reach back and settle it.
    const outcome = svc.recordReportedOutcome("pane-1", first, "complete", "late report for a dead exchange");
    assert.equal(outcome, null);
    assert.equal(svc.get(first)!.state, "interrupted", "stale exchange stays interrupted forever");
    assert.equal(svc.get(second)!.state, "delivered", "the CURRENT exchange must be untouched by the stale report");
  });

  it("a FORGED id belonging to a DIFFERENT pane's exchange cannot impersonate this pane's exchange", () => {
    const svc = new ExchangeService();
    const paneOneId = delivered(svc, "pane-1");
    const paneTwoId = delivered(svc, "pane-2");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });
    svc.onPaneSignal({ paneId: "pane-2", kind: "running" });

    // Pretend pane-2's terminal output tries to report completion for pane-1's exchange id.
    const outcome = svc.recordReportedOutcome("pane-2", paneOneId, "complete", "forged");
    assert.equal(outcome, null, "pane-2's active marker is paneTwoId, not paneOneId — must be ignored");
    assert.equal(svc.get(paneOneId)!.state, "running", "pane-1's real exchange is untouched");
    assert.equal(svc.get(paneTwoId)!.state, "running", "pane-2's real exchange is also untouched");
  });

  it("an envelope for a pane with NO active exchange at all is ignored", () => {
    const svc = new ExchangeService();
    const outcome = svc.recordReportedOutcome("pane-ghost", "exch_whatever", "complete", "nothing here");
    assert.equal(outcome, null);
  });
});

// ── neg1: live correlation — withExchangeCorrelationHint ───────────────────────────────────────

const RICH_ENVELOPE: InstructionEnvelope = {
  objective: "run the full test suite",
  relevant_context: ["ci is red"],
  constraints: ["do not skip any suite"],
  requested_output: "a pass/fail summary",
  completion_signal: "all suites report",
  operator_language: "en",
};

function renderedWithCompletionLine(): string {
  const rendered = renderEnvelope(RICH_ENVELOPE, RENDER_PROFILES["Claude Code"]);
  assert.ok(rendered.includes(COMPLETION_REQUEST_LINE), "fixture must carry the completion-request line");
  return rendered;
}

describe("resultEnvelope: withExchangeCorrelationHint (neg1 — live correlation)", () => {
  it("request mode + non-empty exchangeId: the delivered completion line carries the exchange_id", () => {
    const rendered = renderedWithCompletionLine();
    const out = withExchangeCorrelationHint(rendered, "exch_test_123", "request");
    assert.ok(out.includes(COMPLETION_REQUEST_LINE));
    assert.ok(out.includes("exch_test_123"), "the rendered line must carry the exchange id");
  });

  it("request mode: the appended hint is prose, never a parseable JSON key — and never self-settles", () => {
    const rendered = renderedWithCompletionLine();
    const out = withExchangeCorrelationHint(rendered, "exch_test_123", "request");
    assert.ok(!out.includes('"exchange_id"'), "must never spell the literal JSON key");
    const scan = scanForResultEnvelope(out, ACCEPT);
    assert.equal(scan.found, false, "the delivered instruction text itself must never self-settle");
  });

  it("mode 'accept': byte-identical — request-only behavior", () => {
    const rendered = renderedWithCompletionLine();
    assert.equal(withExchangeCorrelationHint(rendered, "exch_test_123", "accept"), rendered);
  });

  it("mode 'off': byte-identical", () => {
    const rendered = renderedWithCompletionLine();
    assert.equal(withExchangeCorrelationHint(rendered, "exch_test_123", "off"), rendered);
  });

  it("request mode + undefined/null/'' exchangeId: no dangling hint", () => {
    const rendered = renderedWithCompletionLine();
    assert.equal(withExchangeCorrelationHint(rendered, undefined, "request"), rendered);
    assert.equal(withExchangeCorrelationHint(rendered, null, "request"), rendered);
    assert.equal(withExchangeCorrelationHint(rendered, "", "request"), rendered);
  });

  it("request mode but rendered has NO completion line: a bare shell pane never gets a hint", () => {
    const rendered = renderEnvelope(RICH_ENVELOPE, RENDER_PROFILES.Custom);
    assert.ok(!rendered.includes(COMPLETION_REQUEST_LINE));
    assert.equal(withExchangeCorrelationHint(rendered, "exch_test_123", "request"), rendered);
  });

  it("default mode arg omitted resolves to the module-cached RESULT_ENVELOPE_MODE", () => {
    const rendered = renderedWithCompletionLine();
    const withDefault = withExchangeCorrelationHint(rendered, "exch_test_123");
    const withExplicit = withExchangeCorrelationHint(rendered, "exch_test_123", RESULT_ENVELOPE_MODE);
    assert.equal(withDefault, withExplicit);
  });

  // neg1 (adversarial-review fix): the hint must never push the DELIVERED text past the pane's size
  // ceiling — the guard at the send seams measured only the PRE-hint text.
  it("request mode + maxChars: the hint is DROPPED (un-hinted text delivered) when it would exceed the cap", () => {
    const rendered = renderedWithCompletionLine();
    const hinted = withExchangeCorrelationHint(rendered, "exch_test_123", "request");
    assert.ok(hinted.length > rendered.length, "sanity: the hint grows the text");
    const cap = hinted.length - 1; // the un-hinted text fits, the hinted text does not
    const out = withExchangeCorrelationHint(rendered, "exch_test_123", "request", cap);
    assert.equal(out, rendered, "best-effort correlation is dropped rather than overflow the size ceiling");
  });

  it("request mode + maxChars: the hint is KEPT when it fits exactly within the cap", () => {
    const rendered = renderedWithCompletionLine();
    const hinted = withExchangeCorrelationHint(rendered, "exch_test_123", "request");
    const out = withExchangeCorrelationHint(rendered, "exch_test_123", "request", hinted.length);
    assert.equal(out, hinted, "a hint that fits exactly at the cap is delivered");
    assert.ok(out.includes("exch_test_123"));
  });

  it("maxChars omitted: unbounded (prior behavior) — the hint is applied regardless of length", () => {
    const rendered = renderedWithCompletionLine();
    const out = withExchangeCorrelationHint(rendered, "exch_test_123", "request");
    assert.ok(out.includes("exch_test_123"), "no cap supplied → hint applied");
  });
});

describe("resultEnvelope + ExchangeService: live correlation settlement (neg1)", () => {
  it("a LIVE echoed envelope whose id matches the delivered instruction's carried id settles the exchange", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });

    const rendered = renderedWithCompletionLine();
    const deliveredLine = withExchangeCorrelationHint(rendered, id, "request");
    assert.ok(deliveredLine.includes(id), "the delivered line must carry the live agent's own exchange id");

    const echo = JSON.stringify({ exchange_id: id, status: "complete", summary: "done" });
    const scan = scanForResultEnvelope(echo, ACCEPT);
    assert.ok(scan.found);
    assert.equal(scan.envelope!.exchangeId, id);

    const outcome = svc.recordReportedOutcome(
      "pane-1",
      scan.envelope!.exchangeId,
      scan.envelope!.status,
      scan.envelope!.summary,
      scan.envelope!.redactedEnvelopeJson,
    );
    assert.ok(outcome);
    assert.equal(svc.get(id)!.state, "agent_complete");
  });

  it("a forged/unknown id on the same pane is STILL ignored", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });

    const outcome = svc.recordReportedOutcome("pane-1", "exch_FORGED", "complete", "not really");
    assert.equal(outcome, null);
    assert.equal(svc.get(id)!.state, "running", "the real exchange stays untouched");
  });

  it("a stale-after-retry id is STILL ignored once a second delivery has superseded it", () => {
    const svc = new ExchangeService();
    const first = delivered(svc, "pane-1", "first instruction");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });
    const second = delivered(svc, "pane-1", "second instruction"); // supersedes `first`
    assert.equal(svc.get(first)!.state, "interrupted");

    const outcome = svc.recordReportedOutcome("pane-1", first, "complete", "late report");
    assert.equal(outcome, null);
    assert.equal(svc.get(first)!.state, "interrupted", "stale id remains rejected");
    assert.equal(svc.get(second)!.state, "delivered", "the current exchange is untouched");
  });

  it("redaction-at-boundary preserved: a settled summary carrying a planted secret is redacted before persistence", () => {
    const svc = new ExchangeService();
    const id = delivered(svc, "pane-1");
    svc.onPaneSignal({ paneId: "pane-1", kind: "running" });

    const plantedSecret = "AKIAIOSFODNN7EXAMPLE";
    const echo = JSON.stringify({ exchange_id: id, status: "complete", summary: `done, leaked ${plantedSecret}` });
    const scan = scanForResultEnvelope(echo, ACCEPT);
    assert.ok(scan.found);
    assert.ok(!scan.envelope!.summary.includes(plantedSecret));

    svc.recordReportedOutcome(
      "pane-1",
      scan.envelope!.exchangeId,
      scan.envelope!.status,
      scan.envelope!.summary,
      scan.envelope!.redactedEnvelopeJson,
    );
    assert.equal(svc.get(id)!.state, "agent_complete");
    assert.ok(!svc.get(id)!.resultSummary!.includes(plantedSecret), "stored summary must not carry the raw secret");
  });
});
