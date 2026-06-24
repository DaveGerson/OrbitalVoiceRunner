// tests/test_station_urgency_sort.ts
//
// velocity-mech: the board's urgency-sort. A pure, stable ordering so the panes that need a human
// float to the top of the line. Order (most→least urgent): Needs Input → Exited → Idle → Running.
// Ties keep input order (stable), so the sort is deterministic for the memoized board.
//
// Runner: npx tsx --test --test-force-exit tests/test_station_urgency_sort.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  deriveStations,
  sortStationsByUrgency,
  urgencyRank,
  type Station,
} from "../src/orbital/station";
import { chefForPane } from "../src/orbital/theme";
import type { Terminal, Workspace } from "../src/types";

function term(over: Partial<Terminal> = {}): Terminal {
  return { id: "t1", cwd: "", command: "", output: "", status: "Running", ...over } as Terminal;
}

// A minimal Station with only the fields the sort reads; the rest are filler.
function stn(id: string, status: Station["status"]): Station {
  return {
    id,
    project: "",
    projectName: "Unassigned",
    projectColor: "#111",
    projectEmoji: "🍳",
    name: id,
    status,
    toolPreset: "Custom",
    chef: chefForPane(id),
    scribble: "",
    cwd: "~",
    elapsed: "—",
    contextFill: 0,
    contextLabel: "0 ctx",
    contextPips: 0,
    outputTail: [],
    needsInput: status === "Needs Input",
  };
}

// ── urgencyRank: the ordinal each status maps to ──────────────────────────
describe("urgencyRank", () => {
  it("orders Needs Input < Exited < Idle < Running (lower = more urgent)", () => {
    assert.ok(urgencyRank("Needs Input") < urgencyRank("Exited"));
    assert.ok(urgencyRank("Exited") < urgencyRank("Idle"));
    assert.ok(urgencyRank("Idle") < urgencyRank("Running"));
  });
  it("is total over every StationStatus", () => {
    const ranks = (["Needs Input", "Exited", "Idle", "Running"] as Station["status"][]).map(urgencyRank);
    assert.deepEqual([...new Set(ranks)].length, 4); // all distinct
    assert.ok(ranks.every((r) => Number.isInteger(r)));
  });
});

// ── sortStationsByUrgency: pure, stable, non-mutating ─────────────────────
describe("sortStationsByUrgency", () => {
  it("floats pending → exited → idle → running", () => {
    const input = [
      stn("run", "Running"),
      stn("idle", "Idle"),
      stn("pending", "Needs Input"),
      stn("exit", "Exited"),
    ];
    const out = sortStationsByUrgency(input);
    assert.deepEqual(out.map((s) => s.id), ["pending", "exit", "idle", "run"]);
  });

  it("is stable: same-status stations keep input order", () => {
    const input = [
      stn("r1", "Running"),
      stn("r2", "Running"),
      stn("p1", "Needs Input"),
      stn("p2", "Needs Input"),
      stn("r3", "Running"),
    ];
    const out = sortStationsByUrgency(input);
    assert.deepEqual(out.map((s) => s.id), ["p1", "p2", "r1", "r2", "r3"]);
  });

  it("does not mutate the input array", () => {
    const input = [stn("run", "Running"), stn("pending", "Needs Input")];
    const before = input.map((s) => s.id);
    sortStationsByUrgency(input);
    assert.deepEqual(input.map((s) => s.id), before);
  });

  it("empty in, empty out", () => {
    assert.deepEqual(sortStationsByUrgency([]), []);
  });
});

// ── deriveStations applies the urgency-sort end-to-end ────────────────────
describe("deriveStations urgency ordering", () => {
  function ws(over: Partial<Workspace> = {}): Workspace {
    return { id: "w1", name: "P", directory: "/p", summary: "", notes: [], panes: {}, ...over } as Workspace;
  }
  it("returns the board pre-sorted by urgency", () => {
    const terminals = [
      term({ id: "run", status: "Running" }),
      term({ id: "exit", status: "Exited" }),
      term({ id: "idle", status: "Idle" }),
      term({ id: "pend", status: "Running" }), // becomes Needs Input via a pending command
    ];
    const out = deriveStations(terminals, {}, [{ messageId: "m", cmd: "ls", terminalId: "pend" } as any]);
    assert.deepEqual(out.map((s) => s.id), ["pend", "exit", "idle", "run"]);
  });

  it("preserves input order within a status band (stable across the real pipeline)", () => {
    const terminals = [
      term({ id: "a", status: "Running" }),
      term({ id: "b", status: "Running" }),
      term({ id: "c", status: "Running" }),
    ];
    void ws();
    const out = deriveStations(terminals, {}, []);
    assert.deepEqual(out.map((s) => s.id), ["a", "b", "c"]);
  });
});
