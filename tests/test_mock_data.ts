// tests/test_mock_data.ts — CHARACTERIZATION tests for buildMockData, the demo-fixture factory
// extracted out of App.generateMockData (bead dbt4 — App.tsx decomposition). The fixture literals
// (the three mock terminals, the mock project + panes ledger, the two pending commands, the seeded
// transcript) were relocated VERBATIM into src/mockData.ts so the data baked into the view becomes
// independently testable. generateMockData now spreads this factory into the same setters in the
// same order; behavior is unchanged. The only seam is `now` (was Date.now() inline) — passed in so
// the transcript timestamps are deterministic.
//
// Runner: npx tsx --test --test-force-exit tests/test_mock_data.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildMockData, MOCK_PROJECT_ID } from "../src/mockData";

describe("mockData — buildMockData", () => {
  const NOW = 1_700_000_000_000;
  const d = buildMockData(NOW);

  it("seeds exactly three terminals with the pinned ids/presets/status", () => {
    assert.strictEqual(d.terminals.length, 3);
    assert.deepStrictEqual(d.terminals.map((t) => t.id), [
      "terminal_mock_1", "terminal_mock_2", "terminal_mock_3",
    ]);
    assert.strictEqual(d.terminals[0].tool_preset, "Claude Code");
    assert.strictEqual(d.terminals[0].status, "Running");
    assert.strictEqual(d.terminals[1].status, "Idle");
    assert.strictEqual(d.terminals[1].permissions_mode, "Human-in-the-Loop");
    assert.strictEqual(d.terminals[2].context_size, 1024);
  });

  it("activeProjectId is the mock project and the ledger carries its three panes", () => {
    assert.strictEqual(d.activeProjectId, MOCK_PROJECT_ID);
    assert.strictEqual(d.activeProjectId, "mock_project_alpha");
    const proj = d.ledger[MOCK_PROJECT_ID];
    assert.strictEqual(proj.name, "Alpha Project");
    assert.deepStrictEqual(Object.keys(proj.panes).sort(), [
      "terminal_mock_1", "terminal_mock_2", "terminal_mock_3",
    ]);
    assert.strictEqual(proj.panes["terminal_mock_2"].is_busy, false);
    assert.strictEqual(proj.panes["terminal_mock_3"].notes.length, 2);
    assert.deepStrictEqual(proj.keyTerms, ["react", "vite", "nodejs"]);
  });

  it("seeds two pending commands keyed to the right terminals", () => {
    assert.strictEqual(d.pendingCommands.length, 2);
    assert.strictEqual(d.pendingCommands[0].messageId, "mock_msg_1");
    assert.strictEqual(d.pendingCommands[0].terminalId, "terminal_mock_2");
    assert.strictEqual(d.pendingCommands[1].cmd, "pip install pandas");
    assert.strictEqual(d.pendingCommands[1].terminalId, "terminal_mock_3");
  });

  it("seeds four transcript turns with timestamps derived from `now` (deterministic)", () => {
    assert.strictEqual(d.transcript.length, 4);
    assert.deepStrictEqual(d.transcript.map((t) => t.sender), ["User", "Janus", "User", "Janus"]);
    // The original offsets: -60000, -55000, -10000, -5000 from `now`.
    assert.strictEqual(d.transcript[0].timestamp.getTime(), NOW - 60000);
    assert.strictEqual(d.transcript[1].timestamp.getTime(), NOW - 55000);
    assert.strictEqual(d.transcript[2].timestamp.getTime(), NOW - 10000);
    assert.strictEqual(d.transcript[3].timestamp.getTime(), NOW - 5000);
  });

  it("returns fresh objects per call (no shared mutable fixture leak between mode toggles)", () => {
    const a = buildMockData(NOW);
    const b = buildMockData(NOW);
    assert.notStrictEqual(a.terminals, b.terminals);
    assert.notStrictEqual(a.ledger[MOCK_PROJECT_ID], b.ledger[MOCK_PROJECT_ID]);
  });
});
