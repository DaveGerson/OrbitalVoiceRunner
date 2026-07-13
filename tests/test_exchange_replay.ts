// tests/test_exchange_replay.ts
//
// AgentExchange spine — exchange REPLAY (Phase 5, Step 5.2; src/exchanges/replay.ts). Pins the
// full-journey timeline join (exchange row + events + approvals + context deliveries), the
// defensive re-redaction guarantee (every joinable source may carry a planted secret; none may
// survive into the timeline), the delivered-text hash-not-raw-text rule, retention-pruning
// degradation, and the "unknown exchange" clean-error path. Also spot-checks
// src/exchanges/recoveryActions.ts's `resumeInspectExchange` still behaves identically after its
// refactor to share `fetchExchangeCore` with this module.

import { describe, it } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import { buildReplayTimeline, fetchExchangeCore } from "../src/exchanges/replay";
import { hashText } from "../src/memory/contextTelemetry";
import { resumeInspectExchange } from "../src/exchanges/recoveryActions";
import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import type { ActionContext } from "../src/actions/types";
import type { ReplayResult } from "../src/exchanges/replay";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

const SECRET = "sk-ant-abcdefghijklmnopqrstuvwx"; // matches redactSecrets' HIGH_CONFIDENCE api-key pattern

describe("replay: buildReplayTimeline — full-journey ordering + joins", () => {
  it("joins the exchange row, ordered events, approvals, and context deliveries into one timeline", () => {
    const s = freshStore();
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "delivered", created_at: 1000,
      distilled_instruction: "run the deploy script now",
      voice_session_id: "sess-1", context_version: "3",
    });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "exchange_created", ts: 1000 });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "target_resolved", pane_id: "pane-1", ts: 1100,
      payload_redacted_json: JSON.stringify({ paneId: "pane-1", projectId: "p1" }),
    });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "draft_revised", ts: 1200,
      payload_redacted_json: JSON.stringify({ superseded_approval_id: "appr-old" }),
    });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "clarification_requested", ts: 1300,
      payload_redacted_json: JSON.stringify({ clarification: "Which pane should this go to?" }),
    });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "approval_confirmed", ts: 1400,
      payload_redacted_json: JSON.stringify({ approval_id: "appr-1", draft_version: 1 }),
    });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_attempted", ts: 1450 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "delivery_succeeded", ts: 1500 });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "needs_input_detected", ts: 1600,
      payload_redacted_json: JSON.stringify({ detail: "which environment?" }),
    });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "agent_completion_reported", ts: 1700,
      payload_redacted_json: JSON.stringify({ summary: "deploy finished" }),
    });

    s.insertPendingApproval({
      id: "appr-1", session_id: "sess-1", workspace_id: "p1", pane_id: "pane-1",
      command: "run the deploy script now", kind: "agent_instruction", rationale: "operator approved",
      claimed: true, timestamp: 1400, expires_at: 999999999999, exchange_id: row.exchange_id,
    });
    s.insertContextDelivery({
      context_version: "3", trigger: "manual", project_id: "p1", voice_session_id: "sess-1",
      included_sources_json: JSON.stringify(["a", "b"]), dropped_sources_json: JSON.stringify(["c"]),
    });
    // A delivery for a DIFFERENT context_version must never leak into this exchange's join.
    s.insertContextDelivery({
      context_version: "9", trigger: "manual", project_id: "p1", voice_session_id: "sess-1",
    });

    const result = buildReplayTimeline(s, row.exchange_id);
    assert.strictEqual(result.found, true);
    if (!result.found) return;
    const tl = result.timeline;

    assert.strictEqual(tl.exchangeId, row.exchange_id);
    assert.strictEqual(tl.exchange.paneId, "pane-1");
    assert.strictEqual(tl.exchange.state, "delivered");

    // Ordering: ASC by ts (matches listExchangeEvents' own ORDER BY).
    const tsSeq = tl.events.map((e) => e.ts);
    assert.deepStrictEqual(tsSeq, [...tsSeq].sort((a, b) => a - b));
    assert.strictEqual(tl.events.length, 9);
    assert.strictEqual(tl.events[0].eventType, "exchange_created");

    assert.strictEqual(tl.targetResolutions.length, 1);
    assert.strictEqual(tl.targetResolutions[0].paneId, "pane-1");

    assert.strictEqual(tl.draftRevisions.length, 1);
    assert.strictEqual(tl.draftRevisions[0].supersededApprovalId, "appr-old");

    assert.strictEqual(tl.questions.length, 2, "clarification_requested + needs_input_detected");
    assert.deepStrictEqual(tl.questions.map((q) => q.text), ["Which pane should this go to?", "which environment?"]);

    assert.ok(tl.terminalTransitions.some((t) => t.eventType === "delivery_succeeded"));

    assert.strictEqual(tl.resultSummaries.length, 1);
    assert.strictEqual(tl.resultSummaries[0].summary, "deploy finished");

    assert.strictEqual(tl.approvals.length, 1);
    assert.strictEqual(tl.approvals[0].approvalId, "appr-1");
    assert.strictEqual(tl.approvals[0].claimed, true);
    assert.strictEqual(tl.approvals[0].rationale, "operator approved");

    assert.strictEqual(tl.contextDeliveries.length, 1, "only the matching context_version delivery joins");
    assert.strictEqual(tl.contextDeliveries[0].contextVersion, "3");
    assert.strictEqual(tl.contextDeliveries[0].includedSourceCount, 2);
    assert.strictEqual(tl.contextDeliveries[0].droppedSourceCount, 1);

    assert.strictEqual(tl.degraded, false);
    s.close();
  });

  it("resumeInspectExchange (recoveryActions.ts) still returns exchange + recent events after sharing fetchExchangeCore", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "interrupted" });
    for (let i = 0; i < 3; i++) {
      s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "terminal_running", ts: 1000 + i });
    }
    const view = resumeInspectExchange(s, row.exchange_id, { limit: 2 });
    assert.ok(view);
    assert.strictEqual(view!.exchange.exchange_id, row.exchange_id);
    assert.strictEqual(view!.recentEvents.length, 2);
    assert.ok(view!.recentEvents[0].ts >= view!.recentEvents[1].ts, "newest first");

    // The two joiners must agree on what "the exchange's events" are.
    const core = fetchExchangeCore(s, row.exchange_id);
    assert.strictEqual(core!.events.length, 3);
    s.close();
  });
});

describe("replay: redaction — every joinable source may carry a secret; none survive", () => {
  it("scrubs the exchange row's free-text columns, event payloads, and approval rationale", () => {
    const s = freshStore();
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "agent_failed",
      operator_utterance: `please use ${SECRET}`,
      distilled_instruction: `use ${SECRET} to log in`,
      terminal_state: `blocked on ${SECRET}`,
      result_summary: `failed because of ${SECRET}`,
    });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "clarification_requested", ts: 1000,
      payload_redacted_json: JSON.stringify({ clarification: `need ${SECRET}` }),
    });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "needs_input_detected", ts: 1100,
      payload_redacted_json: JSON.stringify({ detail: `waiting on ${SECRET}` }),
    });
    s.appendExchangeEvent({
      exchange_id: row.exchange_id, event_type: "agent_failure_reported", ts: 1200,
      payload_redacted_json: JSON.stringify({ summary: `died holding ${SECRET}` }),
    });
    s.insertPendingApproval({
      id: "appr-2", session_id: "sess-1", workspace_id: "p1", pane_id: "pane-1",
      command: "x", kind: "agent_instruction", rationale: `because ${SECRET}`,
      claimed: false, timestamp: 1000, expires_at: 999999999999, exchange_id: row.exchange_id,
    });

    const result = buildReplayTimeline(s, row.exchange_id);
    assert.strictEqual(result.found, true);
    if (!result.found) return;
    const json = JSON.stringify(result.timeline);
    assert.ok(!json.includes(SECRET), "the secret must not survive anywhere in the serialized timeline");
    assert.ok(json.includes("[REDACTED"), "redactSecrets should have scrubbed something visibly");
    s.close();
  });
});

describe("replay: delivered-text hash, never raw text", () => {
  it("emits hashText(distilled_instruction), and the raw text never appears in the serialized timeline", () => {
    const s = freshStore();
    const instruction = "run the deploy script now and report back when done";
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "delivered", distilled_instruction: instruction,
      instruction_envelope_json: JSON.stringify({ kind: "envelope_draft", objective: instruction }),
    });
    const result = buildReplayTimeline(s, row.exchange_id);
    assert.strictEqual(result.found, true);
    if (!result.found) return;
    assert.strictEqual(result.timeline.deliveredInstructionHash, hashText(instruction));
    assert.strictEqual(result.timeline.instructionEnvelopeHash, hashText(row.instruction_envelope_json));
    const json = JSON.stringify(result.timeline);
    assert.ok(!json.includes(instruction), "raw delivered instruction text must never appear in replay output");
    assert.ok(!json.includes("envelope_draft"), "raw envelope JSON must never appear in replay output");
    s.close();
  });

  it("null hash for a bare draft with no instruction / default envelope", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    const result = buildReplayTimeline(s, row.exchange_id);
    assert.strictEqual(result.found, true);
    if (!result.found) return;
    assert.strictEqual(result.timeline.deliveredInstructionHash, null);
    assert.strictEqual(result.timeline.instructionEnvelopeHash, null);
    s.close();
  });
});

describe("replay: retention degradation (task D)", () => {
  it("flags degraded when NO exchange_events survive", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "agent_complete" });
    // No appendExchangeEvent call at all — mirrors an exchange whose entire event history was pruned
    // (or was never mirrored, e.g. a store-less ExchangeService instance in a prior process).
    const result = buildReplayTimeline(s, row.exchange_id);
    assert.strictEqual(result.found, true);
    if (!result.found) return;
    assert.strictEqual(result.timeline.degraded, true);
    assert.match(result.timeline.degradationNote ?? "", /no exchange_events rows survive/);
    // The exchange row itself is still fully present — a partial history beats a crash.
    assert.strictEqual(result.timeline.exchange.paneId, "pane-1");
    s.close();
  });

  it("flags degraded when the EARLIEST events are gone (retention pruned the head of the timeline)", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "running", created_at: 1000 });
    // No exchange_created event (pruned); only later events survive.
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "terminal_running", ts: 5000 });
    const result = buildReplayTimeline(s, row.exchange_id);
    assert.strictEqual(result.found, true);
    if (!result.found) return;
    assert.strictEqual(result.timeline.degraded, true);
    assert.match(result.timeline.degradationNote ?? "", /earliest exchange_events row/);
    assert.strictEqual(result.timeline.events.length, 1, "the surviving event is still shown");
    s.close();
  });

  it("NOT degraded when exchange_created is present and ts-matched (the ordinary, complete case)", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft", created_at: 2000 });
    s.appendExchangeEvent({ exchange_id: row.exchange_id, event_type: "exchange_created", ts: 2000 });
    const result = buildReplayTimeline(s, row.exchange_id);
    assert.strictEqual(result.found, true);
    if (!result.found) return;
    assert.strictEqual(result.timeline.degraded, false);
    assert.strictEqual(result.timeline.degradationNote, null);
    s.close();
  });
});

describe("replay: unknown exchange -> clean error", () => {
  it("returns { found: false } for an unknown exchange id, never throws", () => {
    const s = freshStore();
    const result = buildReplayTimeline(s, "exch-does-not-exist");
    assert.deepStrictEqual(result, { found: false });
    assert.strictEqual(fetchExchangeCore(s, "exch-does-not-exist"), null);
    s.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The `replay_exchange` ActionDef (src/actions/defs/observability.ts) — proving the REGISTRY/REST
// wiring itself (rest-only surface, ungated read, runAction dispatch), not just buildReplayTimeline's
// own logic the describe blocks above already cover directly. Mirrors
// tests/test_exchange_recovery_actions.ts's def-level idiom for the sibling recovery ActionDefs.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
function makeReplayActionCtx(store: JanusStore | null): ActionContext {
  // runAction's readOnly leg calls ctx.redact on the result before returning it — a minimal fake
  // context still needs this (unlike a direct handler call, which skips runAction's pipeline).
  return { manager: { terminals: {} }, session: null, store, redact: (s: string) => s } as unknown as ActionContext;
}

describe("replay_exchange ActionDef registered in REGISTRY (rest-only, ungated read)", () => {
  it("is registered, rest-only, readOnly, and dispatches to buildReplayTimeline via runAction", async () => {
    const def = REGISTRY.find((d) => d.name === "replay_exchange");
    assert.ok(def, "replay_exchange missing from REGISTRY");
    assert.ok(!def!.surfaces.has("voice"), "replay_exchange is rest-only (not a voice tool)");
    assert.ok(def!.surfaces.has("rest"), "replay_exchange must be a rest surface");
    assert.ok(def!.readOnly, "replay_exchange must be readOnly");
    assert.strictEqual(def!.rest!.method, "get");

    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    const result = await runAction(REGISTRY, "replay_exchange", { exchange_id: row.exchange_id }, makeReplayActionCtx(s));
    assert.strictEqual(result.kind, "ok");
    const timeline = (result as { kind: "ok"; output: ReplayResult }).output;
    assert.strictEqual(timeline.found, true);
    s.close();
  });

  it("reports a clean 'no durable store wired' output when ctx.store is null", async () => {
    const result = await runAction(REGISTRY, "replay_exchange", { exchange_id: "exch-x" }, makeReplayActionCtx(null));
    assert.strictEqual(result.kind, "ok");
  });
});
