// Phase 1 ears (fact [E]): switch_context must run a LIVE ledger sync BEFORE reading the
// project briefing, so a pane that just flipped Running->Idle (or Idle->Running) is reflected
// in the is_busy/status the briefing reports. Today getProjectBriefing reads ws.panes WITHOUT
// a prior syncLedger(), so the catch-up briefing can be stale.
//
// PURE handler test (no server boot, no Gemini key, no PTY): we call switchContext.handler
// directly with a stubbed ActionContext whose manager records the ORDER of listPanes() (the
// public sync seam — manager.listPanes() calls syncLedger()) vs getProjectBriefing(). The fix
// is correct iff the sync runs strictly before the briefing read.
//
// Runner: npx tsx --test --test-force-exit tests/test_switch_context_sync.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { switchContext } from "../src/actions/defs/orient";
import type { ActionContext } from "../src/actions/types";

describe("switch_context catch-up briefing is non-stale (fact [E])", () => {
  it("runs a live ledger sync BEFORE getProjectBriefing", () => {
    const order: string[] = [];

    const manager = {
      // The public sync seams. Both the new manager.refreshLedger() and manager.listPanes()
      // call syncLedger() first (terminal.ts), which is exactly the live refresh
      // switch_context must trigger. Record either as "sync" so the test pins the BEHAVIOR
      // (a live sync precedes the briefing) rather than the exact method name.
      refreshLedger: () => {
        order.push("sync");
      },
      listPanes: () => {
        order.push("sync");
        return [];
      },
      settings: { projects: { activeContext: "", localWorkspacePath: "" } },
      saveSettings: () => {},
      ledger: {
        switchContext: (_id: string) => {},
        workspaces: { proj_x: { directory: "/tmp/proj_x" } },
        getProjectBriefing: (_id: string) => {
          order.push("briefing");
          return { project_id: "proj_x", panes: [], notes: [] };
        },
      },
    } as unknown as ActionContext["manager"];

    const ctx = {
      manager,
      broadcastLedgerUpdate: () => {},
      // PHASE 2: switch_context now Off-vetoes on its veto-class capability; default Auto = no change.
      effectiveCapabilityGateFor: () => "Auto",
      // WS3 (voice-followups-tdd): switch_context now consults the focused-pane seam
      // (resolveSwitchContextHonesty); no focused pane here, so the honesty branch never engages.
      getActivePaneId: () => null,
    } as unknown as ActionContext;

    const res = switchContext.handler({ project_id: "proj_x" }, ctx);

    assert.strictEqual((res as any).kind, "ok");
    assert.ok(order.includes("sync"), "a live ledger sync ran during switch_context");
    assert.ok(order.includes("briefing"), "the briefing was read");
    assert.ok(
      order.indexOf("sync") < order.indexOf("briefing"),
      `the live sync must run BEFORE the briefing read (order was: ${order.join(" -> ")})`,
    );
  });

  it("still returns the briefing payload and preserves the unconditional settings writes", () => {
    // Guard: the sync insertion must not disturb the ordered side effects (the ASYMMETRY
    // HAZARD comment at orient.ts:76-83). switchContext / settings writes / saveSettings /
    // broadcastLedgerUpdate all still happen, and the briefing is the OK output.
    const events: string[] = [];
    const manager = {
      refreshLedger: () => { events.push("sync"); },
      listPanes: () => { events.push("sync"); return []; },
      settings: { projects: { activeContext: "", localWorkspacePath: "" } },
      saveSettings: () => { events.push("saveSettings"); },
      ledger: {
        switchContext: (_id: string) => { events.push("switchContext"); },
        workspaces: { proj_y: { directory: "/tmp/proj_y" } },
        getProjectBriefing: (_id: string) => ({ project_id: "proj_y", panes: [], notes: [] }),
      },
    } as unknown as ActionContext["manager"];

    const ctx = {
      manager,
      broadcastLedgerUpdate: () => { events.push("broadcastLedgerUpdate"); },
      // PHASE 2: switch_context now Off-vetoes on its veto-class capability; default Auto = no change.
      effectiveCapabilityGateFor: () => "Auto",
      // WS3 (voice-followups-tdd): see the sibling test above.
      getActivePaneId: () => null,
    } as unknown as ActionContext;

    const res = switchContext.handler({ project_id: "proj_y" }, ctx);

    assert.deepStrictEqual((res as any).output, { project_id: "proj_y", panes: [], notes: [] });
    assert.strictEqual((manager as any).settings.projects.activeContext, "proj_y");
    assert.strictEqual((manager as any).settings.projects.localWorkspacePath, "/tmp/proj_y");
    for (const required of ["switchContext", "saveSettings", "broadcastLedgerUpdate", "sync"]) {
      assert.ok(events.includes(required), `${required} still runs`);
    }
  });
});
