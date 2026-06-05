import { describe, it } from "node:test";
import assert from "node:assert";
// FAILS FIRST: src/activePaneMeta.ts does not exist yet (TS2307 / missing export).
import { resolveActivePaneMeta } from "../src/activePaneMeta";
import type { PaneMeta, Workspace } from "../src/types";

// Minimal PaneMeta factory — fills the required fields so we can focus each case on the
// name/modelContext/humanContext the context body actually renders (src/App.tsx:2031-2034).
function pane(overrides: Partial<PaneMeta> & { pane_id: string; name: string }): PaneMeta {
  return {
    runtime_type: "bash",
    last_known_state: "Running",
    is_busy: false,
    alive: true,
    notes: [],
    permissions_mode: "Human-in-the-Loop",
    session_id: "s",
    tool_preset: "Claude Code",
    context_size: 0,
    ...overrides,
  };
}

function workspace(id: string, panes: Record<string, PaneMeta>): Workspace {
  return { id, name: id, directory: ".", summary: "", notes: [], panes };
}

describe("resolveActivePaneMeta — context body tracks the active pane with zero round-trip (f06)", () => {
  // The headline pin: A→B meta flips with NO fetch. The function is pure — there is no
  // round-trip to await — so a passing assertion codifies "the body derives from the local
  // ledger, in the same render that moves the highlight."
  const A = pane({
    pane_id: "A",
    name: "A",
    modelContext: [{ text: "A-model", at: "2026-06-04T00:00:00Z" }],
    humanContext: [{ text: "A-human", at: "2026-06-04T00:00:01Z" }],
  });
  const B = pane({
    pane_id: "B",
    name: "B",
    modelContext: [{ text: "B-model", at: "2026-06-04T00:00:02Z" }],
    humanContext: [{ text: "B-human", at: "2026-06-04T00:00:03Z" }],
  });
  const ledgerAB = { P: workspace("P", { A, B }) };

  it("A→B: the resolved meta (name + model/human context) flips to B with no fetch", () => {
    const onA = resolveActivePaneMeta(ledgerAB, "A");
    assert.strictEqual(onA.pane?.name, "A");
    assert.deepStrictEqual(onA.pane?.modelContext, [{ text: "A-model", at: "2026-06-04T00:00:00Z" }]);

    const onB = resolveActivePaneMeta(ledgerAB, "B");
    assert.strictEqual(onB.pane?.name, "B");
    assert.deepStrictEqual(onB.pane?.modelContext, [{ text: "B-model", at: "2026-06-04T00:00:02Z" }]);
    assert.deepStrictEqual(onB.pane?.humanContext, [{ text: "B-human", at: "2026-06-04T00:00:03Z" }]);
    // The project comes back too (consumer: activeProjectMeta).
    assert.strictEqual(onB.project?.id, "P");
  });

  it("open-from-grid: resolving B from a cold null active pane returns B immediately", () => {
    const r = resolveActivePaneMeta(ledgerAB, "B");
    assert.strictEqual(r.pane?.name, "B");
    assert.strictEqual(r.project?.id, "P");
  });

  it("switch to null (back to grid): returns {pane:null, project:null}", () => {
    const r = resolveActivePaneMeta(ledgerAB, null);
    assert.strictEqual(r.pane, null);
    assert.strictEqual(r.project, null);
  });

  it("pane absent from ledger (just-spawned, not yet broadcast): returns {pane:null, project:null}", () => {
    const r = resolveActivePaneMeta(ledgerAB, "X");
    assert.strictEqual(r.pane, null);
    assert.strictEqual(r.project, null);
  });

  it("optional context preserved: a pane with no model/human context returns them undefined (no placeholder)", () => {
    const bare = pane({ pane_id: "C", name: "C" });
    const ledger = { P: workspace("P", { C: bare }) };
    const r = resolveActivePaneMeta(ledger, "C");
    assert.strictEqual(r.pane?.name, "C");
    assert.strictEqual(r.pane?.modelContext, undefined);
    assert.strictEqual(r.pane?.humanContext, undefined);
  });

  it("cross-project scan: finds B in P2 even while P1 is the 'active' project (robust to a stale active-project)", () => {
    const ledger = {
      P1: workspace("P1", { A }),
      P2: workspace("P2", { B }),
    };
    const r = resolveActivePaneMeta(ledger, "B");
    assert.strictEqual(r.pane?.name, "B");
    assert.strictEqual(r.project?.id, "P2");
  });

  it("reconciliation: re-resolving after a ledger_updated merges mutated context with no revert", () => {
    const onB1 = resolveActivePaneMeta(ledgerAB, "B");
    assert.deepStrictEqual(onB1.pane?.modelContext, [{ text: "B-model", at: "2026-06-04T00:00:02Z" }]);
    // A later ledger_updated lands with the active pane's context mutated (App.tsx:1303 setLedger).
    const Bupdated = pane({
      pane_id: "B",
      name: "B",
      modelContext: [
        { text: "B-model", at: "2026-06-04T00:00:02Z" },
        { text: "B-model-2", at: "2026-06-04T00:00:09Z" },
      ],
      humanContext: B.humanContext,
    });
    const ledger2 = { P: workspace("P", { A, B: Bupdated }) };
    const onB2 = resolveActivePaneMeta(ledger2, "B");
    assert.strictEqual(onB2.pane?.modelContext?.length, 2);
    assert.strictEqual(onB2.pane?.modelContext?.[1].text, "B-model-2");
  });
});
