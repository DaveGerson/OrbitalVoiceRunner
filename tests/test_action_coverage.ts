// REG1 Phase-1 exit (workstream A) — surface-coverage allow-list tests (registry TDD spec §8.4).
//
// These are PURE structural tests over REGISTRY + the coverage helpers — no server boot, no Gemini
// key, no PTY (mirrors tests/test_action_registry.ts import style). They pin the §8.4 build-gate:
//   #20  — every single-surface action is on the INTENTIONAL_ASYMMETRY allow-list, i.e.
//          unexpectedAsymmetries(REGISTRY) deep-equals [] (no un-allow-listed asymmetry can land).
//   #20b — surfaceCoverage(REGISTRY) is TOTAL: exactly one row per tool, each carrying a boolean for
//          every surface (voice/rest/ws) — the capability×surface matrix has no holes.
//
// Runner: npx tsx --test --test-force-exit tests/test_action_coverage.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { REGISTRY } from "../src/actions/registry";
import { surfaceCoverage, unexpectedAsymmetries } from "../src/actions/coverage";

// ─────────────────────────────────────────────────────────────────────────────
// §8.4 #20 — the asymmetry build-gate is GREEN: no un-allow-listed single-surface action.
// ─────────────────────────────────────────────────────────────────────────────
describe("§8.4 #20 surface-coverage allow-list", () => {
  it("unexpectedAsymmetries(REGISTRY) === [] (every single-surface action is allow-listed)", () => {
    const drift = unexpectedAsymmetries(REGISTRY);
    assert.deepStrictEqual(
      drift,
      [],
      `un-allow-listed single-surface action(s): ${drift.join(", ")} — add each to INTENTIONAL_ASYMMETRY (or give it its missing surface twin).`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8.4 #20b — surfaceCoverage is TOTAL over the registry: one row per tool, a boolean per surface.
// ─────────────────────────────────────────────────────────────────────────────
describe("§8.4 #20b surfaceCoverage totality", () => {
  it("returns exactly one row per tool (length === REGISTRY.length)", () => {
    const coverage = surfaceCoverage(REGISTRY);
    assert.strictEqual(coverage.length, REGISTRY.length, "one coverage row per registered action");
    // No row is dropped or duplicated: the row names are exactly the registry names (as a set).
    const rowNames = coverage.map((r) => r.name).sort();
    const regNames = REGISTRY.map((d) => d.name).sort();
    assert.deepStrictEqual(rowNames, regNames, "coverage rows must mirror the registry names exactly");
    assert.strictEqual(new Set(rowNames).size, rowNames.length, "no duplicate coverage row");
  });

  it("every row carries a boolean for each of voice/rest/ws (no holes)", () => {
    for (const row of surfaceCoverage(REGISTRY)) {
      assert.strictEqual(typeof row.name, "string", "row name must be a string");
      assert.strictEqual(typeof row.voice, "boolean", `voice not boolean for ${row.name}`);
      assert.strictEqual(typeof row.rest, "boolean", `rest not boolean for ${row.name}`);
      assert.strictEqual(typeof row.ws, "boolean", `ws not boolean for ${row.name}`);
      // Totality also means every tool is exposed on AT LEAST one surface (no orphan with no surface).
      assert.ok(row.voice || row.rest || row.ws, `${row.name} is exposed on no surface`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cv1 — the six session-independent reads now expose a REST twin (voice+rest).
// ─────────────────────────────────────────────────────────────────────────────
describe("cv1 read-twin convergence", () => {
  const CONVERGED_READS = [
    "get_pane_summary",
    "get_pane_command_history",
    "get_pane_gates",
    "list_capabilities",
    "list_handoffs",
    "read_handoff",
  ];

  it("each converged read reports voice:true AND rest:true in surfaceCoverage", () => {
    const byName = new Map(surfaceCoverage(REGISTRY).map((r) => [r.name, r]));
    for (const name of CONVERGED_READS) {
      const row = byName.get(name);
      assert.ok(row, `${name} missing from surfaceCoverage`);
      assert.strictEqual(row.voice, true, `${name} should still be on voice`);
      assert.strictEqual(row.rest, true, `${name} should now expose a REST twin`);
    }
  });

  it("each converged read carries a GET rest binding (route param matches its schema key)", () => {
    const byName = new Map(REGISTRY.map((d) => [d.name, d]));
    const expectedPaths: Record<string, string> = {
      get_pane_summary: "/api/panes/:pane_id/summary",
      get_pane_command_history: "/api/panes/:pane_id/history",
      get_pane_gates: "/api/panes/:pane_id/gates",
      list_capabilities: "/api/capabilities",
      list_handoffs: "/api/handoffs",
      read_handoff: "/api/handoffs/:handoff_id",
    };
    for (const name of CONVERGED_READS) {
      const def = byName.get(name);
      assert.ok(def, `${name} missing from REGISTRY`);
      assert.ok(def.rest, `${name} must declare a rest binding`);
      assert.strictEqual(def.rest.method, "get", `${name} rest twin must be a GET`);
      assert.strictEqual(def.rest.path, expectedPaths[name], `${name} rest path mismatch`);
    }
  });
});
