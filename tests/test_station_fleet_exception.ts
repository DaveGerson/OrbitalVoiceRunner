// tests/test_station_fleet_exception.ts
//
// Phase 5, Step 5.1 (Fleet View "communication-by-exception") — pure row-building/ordering,
// src/orbital/fleetExchangeOrdering.ts. Covers: the precedence ladder (held approval > durable
// exchange summary > Station-status fallback), the six-tier sort + tie-breaks, fleet-wide
// counters, and the zero-delta guarantee (no exchange data at all degrades to plain Station
// status ordering, identical to today's board).
//
// Runner: npx tsx --test --test-force-exit tests/test_station_fleet_exception.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  attentionApprovalsByPane,
  buildFleetRow,
  buildFleetRows,
  computeFleetCounters,
  sortFleetRows,
  type FleetRowInputs,
} from "../src/orbital/fleetExchangeOrdering";
import { attentionResolveTarget } from "../src/orbital/useOrbitalDataHelpers";
import { chefForPane } from "../src/orbital/theme";
import type { Station } from "../src/orbital/station";
import type { ExchangeDraftView, FleetExchangeSummary, PendingCommand } from "../src/types";

function stn(id: string, status: Station["status"], over: Partial<Station> = {}): Station {
  return {
    id, project: "proj_1", projectName: "Proj", projectColor: "#111", projectEmoji: "🍳",
    name: id, status, toolPreset: "Custom", chef: chefForPane(id), scribble: "last cmd " + id,
    cwd: "~", elapsed: "1m", contextFill: 0, contextLabel: "0 ctx", contextPips: 0,
    outputTail: [], needsInput: status === "Needs Input", ...over,
  };
}

function summary(over: Partial<FleetExchangeSummary> = {}): FleetExchangeSummary {
  return {
    exchangeId: "exch_1", state: "running", tier: 4, kind: "running",
    instructionSummary: "do the thing", waitingReason: null, resultSummary: null,
    updatedAt: 1000, ...over,
  };
}

function draft(over: Partial<ExchangeDraftView> = {}): ExchangeDraftView {
  return {
    exchangeId: "exch_draft", target: { projectId: "proj_1", paneId: "p1" }, objective: "fix the bug",
    relevantContext: [], constraints: [], requestedOutput: null, completionSignal: null,
    draftVersion: 1, sentVersions: [], readiness: { ready: true }, ...over,
  };
}

function pending(over: Partial<PendingCommand> = {}): PendingCommand {
  return { messageId: "msg_1", cmd: "rm -rf build", terminalId: "p1", ...over };
}

describe("attentionApprovalsByPane — the background-pane (non-active) approval source", () => {
  it("projects a resolvable 'approval' item, keyed by terminalId", () => {
    const out = attentionApprovalsByPane(
      [{ type: "approval", messageId: "msg_bg_1", terminalId: "p2", message: "npm run deploy" }],
      attentionResolveTarget,
    );
    assert.deepEqual(out, { p2: { messageId: "msg_bg_1", summary: "npm run deploy" } });
  });

  it("ignores a triage-only item (no messageId) — never fabricates a resolvable approval", () => {
    const out = attentionApprovalsByPane(
      [{ type: "error", terminalId: "p2", message: "pane exited" }],
      attentionResolveTarget,
    );
    assert.deepEqual(out, {});
  });

  it("prefers rawCmd (the bare command) over the wrapped display message when both are present", () => {
    const out = attentionApprovalsByPane(
      [{ type: "approval", messageId: "msg_1", terminalId: "p1", message: "p1 needs your ok: npm run deploy", rawCmd: "npm run deploy" }],
      attentionResolveTarget,
    );
    assert.equal(out.p1.summary, "npm run deploy");
  });

  it("keeps the FIRST (oldest) item when a pane has more than one queued approval", () => {
    const out = attentionApprovalsByPane(
      [
        { type: "approval", messageId: "msg_1", terminalId: "p1", message: "first" },
        { type: "approval", messageId: "msg_2", terminalId: "p1", message: "second" },
      ],
      attentionResolveTarget,
    );
    assert.equal(out.p1.messageId, "msg_1");
  });
});

describe("buildFleetRow — precedence ladder", () => {
  it("a HELD approval always wins tier 1, even over a durable summary that disagrees", () => {
    const row = buildFleetRow(stn("p1", "Running"), {
      pendingCommandByPane: { p1: pending() },
      summaryByPane: { p1: summary({ tier: 4, kind: "running" }) },
    });
    assert.equal(row.tier, 1);
    assert.equal(row.kind, "approval");
    assert.equal(row.isException, true);
    assert.equal(row.pendingApproval?.messageId, "msg_1");
    assert.equal(row.instructionSummary, "rm -rf build");
  });

  it("a BACKGROUND-pane held approval (attentionApprovalByPane) also wins tier 1 — the common fleet-wide case", () => {
    const row = buildFleetRow(stn("p1", "Running"), {
      attentionApprovalByPane: { p1: { messageId: "msg_bg_1", summary: "npm run deploy" } },
      summaryByPane: { p1: summary({ tier: 4, kind: "running" }) },
    });
    assert.equal(row.tier, 1);
    assert.equal(row.kind, "approval");
    assert.equal(row.pendingApproval?.messageId, "msg_bg_1");
  });

  it("an active-pane pendingCommand wins over a background attentionApproval for the SAME pane", () => {
    const row = buildFleetRow(stn("p1", "Running"), {
      pendingCommandByPane: { p1: pending({ messageId: "msg_active" }) },
      attentionApprovalByPane: { p1: { messageId: "msg_bg", summary: "other" } },
    });
    assert.equal(row.pendingApproval?.messageId, "msg_active");
  });

  it("a durable summary (no held approval) fully drives tier/kind", () => {
    const row = buildFleetRow(stn("p1", "Idle"), {
      summaryByPane: { p1: summary({ tier: 2, kind: "failed", resultSummary: null, waitingReason: "build failed" }) },
    });
    assert.equal(row.tier, 2);
    assert.equal(row.kind, "failed");
    assert.equal(row.isException, true);
    assert.equal(row.waitingReason, "build failed");
  });

  it("a completed exchange with a result surfaces it as lastResult (tier 3, non-exception)", () => {
    const row = buildFleetRow(stn("p1", "Idle"), {
      summaryByPane: { p1: summary({ tier: 3, kind: "complete", resultSummary: "tests green, PR opened" }) },
    });
    assert.equal(row.tier, 3);
    assert.equal(row.isException, false);
    assert.equal(row.lastResult, "tests green, PR opened");
  });

  it("no pending / no summary: degrades to the Station status ladder (Needs Input -> tier 1)", () => {
    const row = buildFleetRow(stn("p1", "Needs Input"), {});
    assert.equal(row.tier, 1);
    assert.equal(row.kind, "needs_input");
    assert.equal(row.isException, true);
  });

  it("Exited degrades to tier 2 (failed) — an exception, matching today's urgency order", () => {
    const row = buildFleetRow(stn("p1", "Exited"), {});
    assert.equal(row.tier, 2);
    assert.equal(row.isException, true);
  });

  it("Running (no exchange data at all) degrades to tier 4, non-exception", () => {
    const row = buildFleetRow(stn("p1", "Running"), {});
    assert.equal(row.tier, 4);
    assert.equal(row.isException, false);
  });

  it("Idle (no exchange data) degrades to tier 6, non-exception", () => {
    const row = buildFleetRow(stn("p1", "Idle"), {});
    assert.equal(row.tier, 6);
    assert.equal(row.isException, false);
  });

  it("an open draft's objective feeds instructionSummary when the Station scribble is empty", () => {
    const row = buildFleetRow(stn("p1", "Running", { scribble: "" }), {
      exchangeByPane: { p1: draft({ objective: "refactor the retry loop" }) },
    });
    assert.equal(row.instructionSummary, "refactor the retry loop");
  });

  it("Needs Input with an unready open draft surfaces its clarification as the waiting reason", () => {
    const row = buildFleetRow(stn("p1", "Needs Input"), {
      exchangeByPane: { p1: draft({ readiness: { ready: false, missing: "objective", clarification: "What should it do?" } }) },
    });
    assert.equal(row.waitingReason, "What should it do?");
  });

  it("long text is capped, never silently truncated without an ellipsis marker", () => {
    const long = "x".repeat(500);
    const row = buildFleetRow(stn("p1", "Idle"), { summaryByPane: { p1: summary({ tier: 3, kind: "complete", resultSummary: long }) } });
    assert.ok(row.lastResult!.length <= 140);
    assert.ok(row.lastResult!.endsWith("…"));
  });

  it("a null/absent field never becomes a fabricated empty string", () => {
    const row = buildFleetRow(stn("p1", "Running"), {});
    assert.equal(row.waitingReason, null);
    assert.equal(row.lastResult, null);
    assert.equal(row.pendingApproval, null);
  });
});

describe("buildFleetRows — one row per station, input order preserved", () => {
  it("maps every station", () => {
    const stations = [stn("a", "Running"), stn("b", "Needs Input"), stn("c", "Idle")];
    const rows = buildFleetRows(stations, {});
    assert.deepEqual(rows.map((r) => r.station.id), ["a", "b", "c"]);
  });
});

describe("sortFleetRows — six-tier stable sort", () => {
  it("orders needs-input/approval before failed before complete before running before staged before decision", () => {
    const inputs: FleetRowInputs = {
      summaryByPane: {
        s3: summary({ tier: 3, kind: "complete" }),
        s5: summary({ tier: 5, kind: "staged" }),
      },
    };
    const rows = buildFleetRows(
      [stn("s6", "Idle"), stn("s4", "Running"), stn("s3", "Idle"), stn("s1", "Needs Input"), stn("s2", "Exited"), stn("s5", "Idle")],
      inputs,
    );
    const sorted = sortFleetRows(rows);
    assert.deepEqual(sorted.map((r) => r.station.id), ["s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  it("within a tier, most-recently-updated sorts first", () => {
    const rows = buildFleetRows(
      [stn("old", "Idle"), stn("new", "Idle")],
      { summaryByPane: { old: summary({ tier: 3, kind: "complete", updatedAt: 100 }), new: summary({ tier: 3, kind: "complete", updatedAt: 999 }) } },
    );
    const sorted = sortFleetRows(rows);
    assert.deepEqual(sorted.map((r) => r.station.id), ["new", "old"]);
  });

  it("ties (same tier, unknown updatedAt) break on station id — stable and deterministic", () => {
    const rows = buildFleetRows([stn("b", "Running"), stn("a", "Running")], {});
    const sorted = sortFleetRows(rows);
    assert.deepEqual(sorted.map((r) => r.station.id), ["a", "b"]);
  });

  it("does not mutate its input array", () => {
    const rows = buildFleetRows([stn("a", "Running"), stn("b", "Needs Input")], {});
    const idsBefore = rows.map((r) => r.station.id);
    sortFleetRows(rows);
    assert.deepEqual(rows.map((r) => r.station.id), idsBefore);
  });
});

describe("computeFleetCounters", () => {
  it("counts total / needs-you (exceptions) / running", () => {
    const rows = sortFleetRows(buildFleetRows(
      [stn("n1", "Needs Input"), stn("n2", "Exited"), stn("r1", "Running"), stn("r2", "Running"), stn("i1", "Idle")],
      {},
    ));
    const counters = computeFleetCounters(rows);
    assert.deepEqual(counters, { total: 5, needsYou: 2, running: 2 });
  });

  it("zero exceptions, zero running: all zero (never negative/NaN)", () => {
    const rows = buildFleetRows([stn("i1", "Idle")], {});
    assert.deepEqual(computeFleetCounters(rows), { total: 1, needsYou: 0, running: 0 });
  });

  it("empty board: all zero", () => {
    assert.deepEqual(computeFleetCounters([]), { total: 0, needsYou: 0, running: 0 });
  });
});
