import { describe, it } from "node:test";
import assert from "node:assert";
import { restGateOutcome } from "../src/restGate"; // <- fails first: src/restGate.ts does not exist yet
// NOTE: import from ../src/restGate, NEVER ../server — server.ts calls startServer() at module load
// (verified at file tail) and would boot a real listener on import.
import { PendingActionStore } from "../src/pendingActions";

describe("G6 — restGateOutcome maps a gateOrDefer disposition to the REST contract", () => {
  it("Off  -> 403 forbidden, no actionId", () => {
    const o = restGateOutcome({ disposition: "forbidden" });
    assert.strictEqual(o.status, 403);
    assert.strictEqual(o.body.capability, "create_pane");
    assert.ok(!("actionId" in o.body));
  });
  it("Ask  -> 202 deferred, carries actionId + summary", () => {
    const o = restGateOutcome({ disposition: "deferred", actionId: "act_1", summary: "Create pane build-1" });
    assert.strictEqual(o.status, 202);
    assert.strictEqual(o.body.deferred, true);
    assert.strictEqual(o.body.actionId, "act_1");
    assert.strictEqual(o.body.summary, "Create pane build-1");
  });
  it("Auto -> 200 success", () => {
    const o = restGateOutcome({ disposition: "run" });
    assert.strictEqual(o.status, 200);
    assert.strictEqual(o.body.success, true);
  });
});

describe("G6 — a deferred spawn effect runs (and would broadcast) exactly on confirm", () => {
  it("stages without running; confirm runs the effect exactly once", () => {
    const store = new PendingActionStore();
    let spawns = 0, broadcasts = 0;
    const spawnEffect = () => { spawns++; broadcasts++; return "spawned"; }; // models addTerminal + broadcast bundled
    store.add({ id: "a1", capability: "create_pane", summary: "Create pane x", timestamp: Date.now(), run: spawnEffect });
    assert.strictEqual(spawns, 0, "staging must NOT spawn");
    assert.strictEqual(broadcasts, 0, "staging must NOT broadcast");
    const r = store.confirm("a1");
    assert.strictEqual(r.output, "spawned");
    assert.strictEqual(spawns, 1);
    assert.strictEqual(broadcasts, 1, "confirm must broadcast (else the deferred pane lands silently)");
  });
});
