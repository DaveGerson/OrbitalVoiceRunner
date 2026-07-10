// tests/test_fleet_exchange_projection.ts
//
// Phase 5, Step 5.1 (Fleet View "communication-by-exception") — the server-side additive
// projection: JanusStore.getLatestExchangeForPane (src/store/sqliteStore.ts) and
// src/exchanges/fleetProjection.ts's buildFleetExchangeSummary / projectFleetExchangeSummaries.
// Mirrors tests/test_exchange_store.ts's ":memory:" JanusStore idiom.

import { describe, it } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import {
  buildFleetExchangeSummary,
  projectFleetExchangeSummaries,
  type FleetExchangeSource,
} from "../src/exchanges/fleetProjection";
import type { AgentExchange } from "../src/exchanges/types";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

const identity = (s: string) => s;

describe("JanusStore.getLatestExchangeForPane", () => {
  it("returns null for a pane with no exchange history", () => {
    const s = freshStore();
    assert.equal(s.getLatestExchangeForPane("nope"), null);
    s.close();
  });

  it("returns the single most-recently-UPDATED row for the pane, not the most-recently-created", () => {
    const s = freshStore();
    const older = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "agent_complete" });
    const newer = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "running" });
    // Force `older` to have been updated MOST recently despite being created first.
    s.updateExchange(older.exchange_id, { updated_at: Date.now() + 10_000 }, { state: "agent_complete" });
    const latest = s.getLatestExchangeForPane("pane-1");
    assert.equal(latest?.exchange_id, older.exchange_id);
    void newer;
    s.close();
  });

  it("never crosses panes", () => {
    const s = freshStore();
    s.insertExchange({ project_id: "p1", pane_id: "pane-a" });
    const b = s.insertExchange({ project_id: "p1", pane_id: "pane-b" });
    assert.equal(s.getLatestExchangeForPane("pane-b")?.exchange_id, b.exchange_id);
    s.close();
  });
});

function ex(over: Partial<AgentExchange> = {}): AgentExchange {
  return {
    exchange_id: "exch_1", project_id: "p1", pane_id: "pane-1", voice_session_id: null,
    interaction_id: null, operator_utterance: "", distilled_instruction: "run the tests",
    instruction_envelope_json: "{}", draft_version: 1, context_version: null, state: "running",
    approval_id: null, approval_draft_version: null, delivery_attempt: 0, terminal_state: null,
    result_summary: null, result_envelope_json: null, created_at: 1, updated_at: 1000,
    delivered_at: null, completed_at: null, ...over,
  };
}

describe("buildFleetExchangeSummary", () => {
  it("maps needs_input -> tier 1 / kind needs_input, carrying the terminal_state as waitingReason", () => {
    const s = buildFleetExchangeSummary(ex({ state: "needs_input", terminal_state: "Which branch?" }), identity);
    assert.equal(s.tier, 1);
    assert.equal(s.kind, "needs_input");
    assert.equal(s.waitingReason, "Which branch?");
  });

  it("maps awaiting_approval -> tier 1 / kind approval", () => {
    const s = buildFleetExchangeSummary(ex({ state: "awaiting_approval" }), identity);
    assert.equal(s.tier, 1);
    assert.equal(s.kind, "approval");
  });

  it("maps agent_failed and interrupted -> tier 2 / kind failed", () => {
    assert.equal(buildFleetExchangeSummary(ex({ state: "agent_failed" }), identity).tier, 2);
    assert.equal(buildFleetExchangeSummary(ex({ state: "interrupted" }), identity).kind, "failed");
  });

  it("maps agent_complete -> tier 3 / kind complete, carrying result_summary", () => {
    const s = buildFleetExchangeSummary(ex({ state: "agent_complete", result_summary: "PR #42 opened" }), identity);
    assert.equal(s.tier, 3);
    assert.equal(s.kind, "complete");
    assert.equal(s.resultSummary, "PR #42 opened");
  });

  it("maps running/delivered/terminal_idle -> tier 4 / kind running", () => {
    assert.equal(buildFleetExchangeSummary(ex({ state: "running" }), identity).tier, 4);
    assert.equal(buildFleetExchangeSummary(ex({ state: "delivered" }), identity).tier, 4);
    assert.equal(buildFleetExchangeSummary(ex({ state: "terminal_idle" }), identity).tier, 4);
  });

  it("maps staged -> tier 5", () => {
    assert.equal(buildFleetExchangeSummary(ex({ state: "staged" }), identity).tier, 5);
  });

  it("maps draft/cancelled -> tier 6 / kind decision (the least-urgent fallback bucket)", () => {
    assert.equal(buildFleetExchangeSummary(ex({ state: "draft" }), identity).tier, 6);
    assert.equal(buildFleetExchangeSummary(ex({ state: "cancelled" }), identity).kind, "decision");
  });

  it("distilled_instruction wins over operator_utterance when both are present", () => {
    const s = buildFleetExchangeSummary(ex({ distilled_instruction: "run tests", operator_utterance: "please run the tests" }), identity);
    assert.equal(s.instructionSummary, "run tests");
  });

  it("falls back to operator_utterance when distilled_instruction is blank", () => {
    const s = buildFleetExchangeSummary(ex({ distilled_instruction: "", operator_utterance: "the raw ask" }), identity);
    assert.equal(s.instructionSummary, "the raw ask");
  });

  it("every text field runs through the injected redact function", () => {
    const spy: string[] = [];
    const redact = (s: string) => { spy.push(s); return "[REDACTED]"; };
    const s = buildFleetExchangeSummary(ex({ distilled_instruction: "secret", terminal_state: "secret2", result_summary: "secret3", state: "agent_complete" }), redact);
    assert.equal(s.instructionSummary, "[REDACTED]");
    assert.equal(s.waitingReason, "[REDACTED]");
    assert.equal(s.resultSummary, "[REDACTED]");
    assert.deepEqual(spy.sort(), ["secret", "secret2", "secret3"]);
  });

  it("caps overlong text (never an unbounded payload)", () => {
    const s = buildFleetExchangeSummary(ex({ distilled_instruction: "x".repeat(1000) }), identity);
    assert.ok(s.instructionSummary!.length <= 160);
  });

  it("null/absent fields stay null, never a fabricated empty string", () => {
    const s = buildFleetExchangeSummary(ex({ distilled_instruction: "", operator_utterance: "", terminal_state: null, result_summary: null }), identity);
    assert.equal(s.instructionSummary, null);
    assert.equal(s.waitingReason, null);
    assert.equal(s.resultSummary, null);
  });

  it("carries the exchange_id and updated_at through verbatim", () => {
    const s = buildFleetExchangeSummary(ex({ exchange_id: "exch_abc", updated_at: 12345 }), identity);
    assert.equal(s.exchangeId, "exch_abc");
    assert.equal(s.updatedAt, 12345);
  });
});

describe("projectFleetExchangeSummaries", () => {
  it("returns one row per pane that HAS an exchange, and omits panes that don't (no fabricated rows)", () => {
    const fake: FleetExchangeSource = {
      getLatestExchangeForPane: (paneId) => (paneId === "has-one" ? ex({ pane_id: paneId }) : null),
    };
    const out = projectFleetExchangeSummaries(fake, ["has-one", "has-none"], identity);
    assert.ok(out["has-one"]);
    assert.equal(out["has-none"], undefined);
  });

  it("bounded to exactly the requested paneIds, one row max each", () => {
    const fake: FleetExchangeSource = { getLatestExchangeForPane: (paneId) => ex({ pane_id: paneId }) };
    const out = projectFleetExchangeSummaries(fake, ["a", "b", "c"], identity);
    assert.deepEqual(Object.keys(out).sort(), ["a", "b", "c"]);
  });

  it("never throws when one pane's read faults — the rest of the fleet still projects", () => {
    const fake: FleetExchangeSource = {
      getLatestExchangeForPane: (paneId) => {
        if (paneId === "boom") throw new Error("disk fault");
        return ex({ pane_id: paneId });
      },
    };
    const out = projectFleetExchangeSummaries(fake, ["boom", "ok"], identity);
    assert.equal(out.boom, undefined);
    assert.ok(out.ok);
  });

  it("empty paneIds -> empty map", () => {
    const fake: FleetExchangeSource = { getLatestExchangeForPane: () => ex() };
    assert.deepEqual(projectFleetExchangeSummaries(fake, [], identity), {});
  });
});
