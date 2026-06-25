// tests/test_app_header_derivations.ts — CHARACTERIZATION tests for the two AppHeader brand-strip
// pure derivations extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition, chunk-5
// "modal-queues + AppHeader"). The header brand strip previously rendered two inline JSX template
// expressions:
//   • the live-status dot class  `isLive ? (isReconnecting ? amber : cyan) : zinc`
//   • the "N RUNNING" count      `terminals.filter(t => t.status === "Running").length ||
//                                 Object.values(activeProject?.panes || {}).filter(p => p.alive).length`
// Each was relocated VERBATIM into a pure helper in src/appHelpers.ts (headerStatusDotClass /
// headerRunningCount) so the BYTE-EXACT className + the load-bearing `||` fallback are independently
// testable. Nothing observable differs.
//
// Runner: npx tsx --test --test-force-exit tests/test_app_header_derivations.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { headerStatusDotClass, headerRunningCount } from "../src/appHelpers";
import type { Terminal, PaneMeta, Workspace } from "../src/types";

// ═════════════════════════════════════════════════════════════════════════════
// headerStatusDotClass — isLive ? (isReconnecting ? amber : cyan) : zinc.
// All three branches pinned to their byte-exact Tailwind class strings.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — headerStatusDotClass (live-status dot, 3 branches)", () => {
  it("live + connected -> cyan pulsing", () => {
    assert.strictEqual(headerStatusDotClass(true, false), "bg-cyan-400 animate-pulse");
  });
  it("live + reconnecting -> amber pulsing", () => {
    assert.strictEqual(headerStatusDotClass(true, true), "bg-amber-500 animate-pulse");
  });
  it("offline -> zinc (reconnecting flag ignored when not live)", () => {
    assert.strictEqual(headerStatusDotClass(false, false), "bg-zinc-600");
    assert.strictEqual(headerStatusDotClass(false, true), "bg-zinc-600");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// headerRunningCount — live Running terminals OR (fallback) alive ledger panes.
// The `||` is load-bearing: when zero live terminals are Running it must fall through
// to the active project's alive-pane count, NOT report 0.
// ═════════════════════════════════════════════════════════════════════════════
function term(status: string): Terminal {
  return { id: status, status } as unknown as Terminal;
}
function pane(pane_id: string, alive: boolean): PaneMeta {
  return { pane_id, alive } as unknown as PaneMeta;
}
function project(panes: Record<string, PaneMeta>): Workspace {
  return { id: "p", name: "p", directory: "", summary: "", notes: [], panes } as Workspace;
}

describe("appHelpers — headerRunningCount (live Running count || alive ledger panes)", () => {
  it("counts the live terminals in Running status", () => {
    const terminals = [term("Running"), term("Idle"), term("Running")];
    assert.strictEqual(headerRunningCount(terminals, project({})), 2);
  });

  it("falls through to alive ledger panes when ZERO terminals are Running (|| fallback)", () => {
    const terminals = [term("Idle"), term("Exited")];
    const proj = project({ a: pane("a", true), b: pane("b", false), c: pane("c", true) });
    assert.strictEqual(headerRunningCount(terminals, proj), 2);
  });

  it("live Running count WINS over the ledger fallback when non-zero", () => {
    const terminals = [term("Running")];
    // ledger has 3 alive panes, but a single live Running terminal short-circuits the ||.
    const proj = project({ a: pane("a", true), b: pane("b", true), c: pane("c", true) });
    assert.strictEqual(headerRunningCount(terminals, proj), 1);
  });

  it("undefined activeProject -> empty panes object -> 0 when nothing is Running", () => {
    assert.strictEqual(headerRunningCount([term("Idle")], undefined), 0);
    assert.strictEqual(headerRunningCount([], undefined), 0);
  });

  it("0 Running and 0 alive panes -> 0 (both sides of the || are 0)", () => {
    const proj = project({ a: pane("a", false), b: pane("b", false) });
    assert.strictEqual(headerRunningCount([term("Idle")], proj), 0);
  });
});
