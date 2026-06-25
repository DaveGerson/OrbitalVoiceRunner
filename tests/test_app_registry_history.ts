// tests/test_app_registry_history.ts — CHARACTERIZATION tests for the two pure predicates hoisted
// out of src/App.tsx during chunk-6 ("terminal-view + dashboard chrome") of the App.tsx
// decomposition (bead dbt4 / branch dbt4/sec-terminal-dashboard-chrome). Each was relocated VERBATIM
// from an inline expression into src/appHelpers.ts so the decision is independently testable:
//   • isPaneLive(terminals, paneId)            — was `terminals.some(t => t.id === pane.pane_id)`
//                                                in the ArtifactsRegistryPanel "Active RAM vs Idle
//                                                Registry" badge derivation (`isLiveProcess`).
//   • historyEntryIsSelected(selected, entry)  — was `selectedHistoryEntry?.command === entry.command
//                                                && selectedHistoryEntry?.timestamp === entry.timestamp`
//                                                in the PaneHistorySidebar list (used 3x per row).
// Nothing observable differs.
//
// Runner: npx tsx --test --test-force-exit tests/test_app_registry_history.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { isPaneLive, historyEntryIsSelected } from "../src/appHelpers";
import type { Terminal } from "../src/types";

// ═════════════════════════════════════════════════════════════════════════════
// isPaneLive — `terminals.some(t => t.id === paneId)`. True ⇒ "Active RAM" (no Recover
// button); false ⇒ "Idle Registry" (the Recover & Wake button shows).
// ═════════════════════════════════════════════════════════════════════════════
function term(id: string): Terminal {
  return { id } as unknown as Terminal;
}

describe("appHelpers — isPaneLive (live terminal backs a ledger pane)", () => {
  it("true when a terminal's id matches the pane id", () => {
    assert.strictEqual(isPaneLive([term("a"), term("b")], "b"), true);
  });

  it("false when no terminal matches (idle registry pane)", () => {
    assert.strictEqual(isPaneLive([term("a"), term("b")], "c"), false);
  });

  it("false against an empty terminal list", () => {
    assert.strictEqual(isPaneLive([], "a"), false);
  });

  it("matches the FIRST id exactly (some short-circuits)", () => {
    assert.strictEqual(isPaneLive([term("a")], "a"), true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// historyEntryIsSelected — command AND timestamp must both match. The optional chains are
// load-bearing: a null selection must compare false (not throw), on BOTH sides.
// ═════════════════════════════════════════════════════════════════════════════
const entryA = { command: "ls -la", timestamp: "2026-06-25T10:00:00Z", output: "" };
const entryB = { command: "ls -la", timestamp: "2026-06-25T11:00:00Z", output: "" };

describe("appHelpers — historyEntryIsSelected (command+timestamp match, null-safe)", () => {
  it("true when both command and timestamp match", () => {
    assert.strictEqual(historyEntryIsSelected({ command: "ls -la", timestamp: "2026-06-25T10:00:00Z" }, entryA), true);
  });

  it("false when the command matches but the timestamp differs (same cmd, two runs)", () => {
    assert.strictEqual(historyEntryIsSelected({ command: "ls -la", timestamp: "2026-06-25T10:00:00Z" }, entryB), false);
  });

  it("false when the timestamp matches but the command differs", () => {
    assert.strictEqual(historyEntryIsSelected({ command: "pwd", timestamp: "2026-06-25T10:00:00Z" }, entryA), false);
  });

  it("false (not throw) when the selection is null — the optional chains short-circuit", () => {
    assert.strictEqual(historyEntryIsSelected(null, entryA), false);
  });
});
