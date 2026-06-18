// Janus Memory Synthesis P0a — Task 7 freshness trigger on switch_context.
//
// switch_context already runs a live ledger sync (refreshLedger) before reading the briefing
// (fact [E], test_switch_context_sync.ts). P0a extends that "catch me up" path: AFTER the sync,
// it must request a FRESH memory synthesis + injection for the now-active pane, so Gemini Live
// re-focuses instead of being served the stale snapshot briefing alone (spec freshness trigger 1).
//
// PURE handler test (no server boot, no Gemini key, no PTY): we call switchContext.handler with a
// stubbed ActionContext whose injectMemoryBrief is a spy, and assert it fires AFTER the live sync.
// The wiring is OPTIONAL on the ActionContext (additive) — a ctx without it (REST/test paths) must
// not throw.
//
// Runner: npx tsx --test --test-force-exit tests/test_memory_switch_context_inject.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { switchContext } from "../src/actions/defs/orient";
import type { ActionContext } from "../src/actions/types";

describe("switch_context triggers a fresh memory synthesis (P0a freshness trigger)", () => {
  it("calls ctx.injectMemoryBrief AFTER the live ledger sync", () => {
    const order: string[] = [];

    const manager = {
      refreshLedger: () => { order.push("sync"); },
      listPanes: () => { order.push("sync"); return []; },
      settings: { projects: { activeContext: "", localWorkspacePath: "" } },
      saveSettings: () => {},
      ledger: {
        switchContext: (_id: string) => {},
        workspaces: { proj_x: { directory: "/tmp/proj_x" } },
        getProjectBriefing: (_id: string) => ({ project_id: "proj_x", panes: [], notes: [] }),
      },
    } as unknown as ActionContext["manager"];

    const ctx = {
      manager,
      broadcastLedgerUpdate: () => {},
      injectMemoryBrief: () => { order.push("inject"); },
      // PHASE 2: switch_context now Off-vetoes on its veto-class capability; default Auto = no change.
      effectiveCapabilityGateFor: () => "Auto",
    } as unknown as ActionContext;

    const res = switchContext.handler({ project_id: "proj_x" }, ctx);

    assert.strictEqual((res as any).kind, "ok");
    assert.ok(order.includes("inject"), "a fresh memory brief was injected during switch_context");
    assert.ok(
      order.lastIndexOf("sync") < order.indexOf("inject"),
      `the fresh synthesis must run AFTER the live sync (order was: ${order.join(" -> ")})`,
    );
  });

  it("does not throw when injectMemoryBrief is absent (REST / test paths)", () => {
    const manager = {
      refreshLedger: () => {},
      listPanes: () => [],
      settings: { projects: { activeContext: "", localWorkspacePath: "" } },
      saveSettings: () => {},
      ledger: {
        switchContext: (_id: string) => {},
        workspaces: { proj_y: { directory: "/tmp/proj_y" } },
        getProjectBriefing: (_id: string) => ({ project_id: "proj_y", panes: [], notes: [] }),
      },
    } as unknown as ActionContext["manager"];

    // No injectMemoryBrief on this ctx — the additive call site must be a safe no-op.
    const ctx = {
      manager,
      broadcastLedgerUpdate: () => {},
      // PHASE 2: switch_context now Off-vetoes on its veto-class capability; default Auto = no change.
      effectiveCapabilityGateFor: () => "Auto",
    } as unknown as ActionContext;

    const res = switchContext.handler({ project_id: "proj_y" }, ctx);
    assert.strictEqual((res as any).kind, "ok");
  });
});
