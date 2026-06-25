// tests/test_pane_grid_logic.ts — CHARACTERIZATION tests for the residual pure derivations hoisted
// out of the dashboard pane-grid IIFE during its extraction into <PaneGridSection/> (bead dbt4
// "sec-pane-grid" — App.tsx decomposition, chunk-7 "pane-grid"). Each was a genuinely-INLINE
// expression inside the grid `.map`/render*Card closures, relocated VERBATIM to src/appHelpers.ts so
// the component renders a single call and the BYTE-EXACT value is independently testable without
// jsdom. Nothing observable differs; the four already-existing card helpers (resolvePaneStatus /
// resolveCardContextSize / detailedCardPresetClasses / the *DotClass family) keep their own tests.
//
// Runner: npx tsx --test --test-force-exit tests/test_pane_grid_logic.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  paneHasPendingCommand,
  isRecentlyIdled,
  tailOutputLines,
  chooseChronicleSource,
} from "../src/appHelpers";
import type { PendingCommand } from "../src/types";
import type { ProjectNote } from "../src/classic/hooks/useLedgerData";

function cmd(terminalId: string): Pick<PendingCommand, "terminalId"> {
  return { terminalId };
}
function note(id: string, pane_id: string | null, text = "n"): ProjectNote {
  return { id, project_id: "p", pane_id, text, type: "note", created_at: 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// paneHasPendingCommand — `pendingCommands.some(cmd => cmd.terminalId === paneId)` (the card's
// `isAlertActive`). True iff ANY queued command targets the pane.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — paneHasPendingCommand (the card isAlertActive)", () => {
  it("true when a pending command targets the pane", () => {
    assert.strictEqual(paneHasPendingCommand([cmd("a"), cmd("b")], "b"), true);
  });
  it("false when no pending command targets the pane", () => {
    assert.strictEqual(paneHasPendingCommand([cmd("a"), cmd("b")], "z"), false);
  });
  it("false on an empty queue", () => {
    assert.strictEqual(paneHasPendingCommand([], "a"), false);
  });
  it("matches only on exact terminalId (no substring/prefix coincidences)", () => {
    assert.strictEqual(paneHasPendingCommand([cmd("ab")], "a"), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// isRecentlyIdled — `!!recentlyIdled[paneId]`, normalizing the inline truthiness lookup that drives
// the compact/detailed dot's `heartbeat-animation` suffix.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — isRecentlyIdled (heartbeat-animation gate)", () => {
  it("true when the pane is flagged recently-idled", () => {
    assert.strictEqual(isRecentlyIdled({ a: true }, "a"), true);
  });
  it("false when the pane flag is explicitly false", () => {
    assert.strictEqual(isRecentlyIdled({ a: false }, "a"), false);
  });
  it("false when the pane is absent from the map (undefined -> false)", () => {
    assert.strictEqual(isRecentlyIdled({}, "a"), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// tailOutputLines — `output.split("\n").slice(-n).join("\n")` (videowall security-camera tail, n=7).
// The caller keeps the outer `term?.output ? … : <idle span>` guard, so this only runs on real output.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — tailOutputLines (videowall last-N tail)", () => {
  it("keeps the last n lines when there are more than n", () => {
    const out = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n");
    assert.strictEqual(tailOutputLines(out, 7), "l3\nl4\nl5\nl6\nl7\nl8\nl9");
  });
  it("returns everything when there are fewer than n lines", () => {
    assert.strictEqual(tailOutputLines("a\nb", 7), "a\nb");
  });
  it("a single line round-trips unchanged", () => {
    assert.strictEqual(tailOutputLines("only", 7), "only");
  });
  it("preserves trailing blank lines (split/join is byte-faithful)", () => {
    // A trailing newline yields a final empty element; slice(-7).join must keep it.
    assert.strictEqual(tailOutputLines("x\ny\n", 7), "x\ny\n");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// chooseChronicleSource — the detailed card's Node Chronicle source selector (bead bjm precedence):
// id-bearing project notes for this pane win; else the ledger's bare-string notes; else empty.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — chooseChronicleSource (id-notes > legacy strings > empty)", () => {
  it("id-bearing notes for the pane win, filtered to that pane_id", () => {
    const notes = [note("1", "a"), note("2", "b"), note("3", "a")];
    const result = chooseChronicleSource(notes, ["legacy"], "a");
    assert.strictEqual(result.kind, "notes");
    if (result.kind === "notes") {
      assert.deepStrictEqual(result.notes.map((n) => n.id), ["1", "3"]);
    }
  });
  it("falls back to the ledger's bare strings when no id-notes match the pane", () => {
    const result = chooseChronicleSource([note("1", "other")], ["s1", "s2"], "a");
    assert.strictEqual(result.kind, "legacy");
    if (result.kind === "legacy") {
      assert.deepStrictEqual(result.notes, ["s1", "s2"]);
    }
  });
  it("id-notes take precedence even when legacy strings are also present", () => {
    const result = chooseChronicleSource([note("1", "a")], ["legacy"], "a");
    assert.strictEqual(result.kind, "notes");
  });
  it("empty when no id-notes match and there are no legacy strings", () => {
    assert.strictEqual(chooseChronicleSource([], [], "a").kind, "empty");
    assert.strictEqual(chooseChronicleSource([note("1", "other")], undefined, "a").kind, "empty");
  });
  it("an empty legacy array is treated as empty (length > 0 guard), not legacy", () => {
    assert.strictEqual(chooseChronicleSource([], [], "a").kind, "empty");
  });
});
