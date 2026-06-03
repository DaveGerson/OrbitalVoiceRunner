import { describe, it } from "node:test";
import assert from "node:assert";
import { planRecipeApply } from "../src/recipeApply"; // FAILS FIRST: src/recipeApply.ts does not exist (TS2307 / missing export)
import { PendingActionStore } from "../src/pendingActions";
import type { GateValue } from "../src/types";

const panes = [{ id: "build" }, { id: "test" }, { id: "review" }];

describe("planRecipeApply — pure recipe gate planner (bri)", () => {
  it("layout apply_recipe=Off forbids the whole layout, zero pane plans", () => {
    const plan = planRecipeApply(panes, new Set(), () => "Off", () => "Auto");
    assert.strictEqual(plan.layoutForbidden, true);
    assert.deepStrictEqual(plan.panes, []);
  });

  it("create_pane=Auto -> every pane spawns now", () => {
    const plan = planRecipeApply(panes, new Set(), () => "Auto", () => "Auto");
    assert.strictEqual(plan.layoutForbidden, false);
    assert.deepStrictEqual(plan.panes.map(p => p.disposition), ["spawn", "spawn", "spawn"]);
  });

  it("create_pane=Ask -> every pane DEFERS (the WF-2 divergence: voice must stage, not spawn)", () => {
    const plan = planRecipeApply(panes, new Set(), () => "Auto", () => "Ask");
    assert.deepStrictEqual(plan.panes.map(p => p.disposition), ["defer", "defer", "defer"]);
  });

  it("create_pane=Off -> every pane is blocked", () => {
    const plan = planRecipeApply(panes, new Set(), () => "Auto", () => "Off");
    assert.deepStrictEqual(plan.panes.map(p => p.disposition), ["block", "block", "block"]);
  });

  it("already-live panes are skipped, not re-planned", () => {
    const plan = planRecipeApply(panes, new Set(["test"]), () => "Auto", () => "Ask");
    const byId = Object.fromEntries(plan.panes.map(p => [p.paneId, p.disposition]));
    assert.strictEqual(byId["test"], "skip-existing");
    assert.strictEqual(byId["build"], "defer");
  });

  it("per-pane gate is resolved PER PANE (mixed policy)", () => {
    const perPane = (id: string): GateValue => (id === "build" ? "Off" : id === "test" ? "Ask" : "Auto");
    const plan = planRecipeApply(panes, new Set(), () => "Auto", perPane);
    assert.deepStrictEqual(plan.panes.map(p => p.disposition), ["block", "defer", "spawn"]);
  });
});

// Voice↔REST parity: a 'defer' plan staged into pendingActions runs the spawn effect ONLY on confirm
// (mirrors test_rest_gate.ts:29-42 but proves the recipe planner feeds the SAME deferral seam).
describe("recipe defer -> pendingActions: effect runs exactly on confirm (voice parity)", () => {
  it("a deferred recipe pane does not spawn until confirmed", () => {
    const store = new PendingActionStore();
    let spawns = 0, broadcasts = 0;
    const plan = planRecipeApply([{ id: "build" }], new Set(), () => "Auto", () => "Ask");
    for (const p of plan.panes) {
      if (p.disposition !== "defer") continue;
      store.add({ id: `act_${p.paneId}`, capability: "create_pane", summary: `Create pane ${p.paneId} (recipe r1)`, timestamp: Date.now(),
        run: () => { spawns++; broadcasts++; return p.paneId; } });
    }
    assert.strictEqual(spawns, 0, "staging a deferred recipe pane must NOT spawn (the voice bug)");
    store.confirm("act_build");
    assert.strictEqual(spawns, 1);
    assert.strictEqual(broadcasts, 1, "confirm must broadcast so the deferred pane repaints");
  });
});
