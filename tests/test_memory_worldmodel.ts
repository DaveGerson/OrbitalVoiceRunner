import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldModel } from "../src/memory/worldModel";
import { BreadcrumbRing } from "../src/memory/breadcrumbs";

function fakeDeps() {
  const breadcrumbs = new BreadcrumbRing({ breadcrumbMax: 5, breadcrumbMaxAgeMs: 1e9 });
  const manager = {
    activeId: "p1",
    terminals: {
      p1: { name: "p1", runtimeType: "interactive_cli", status: "Running", lastCommand: "export TOKEN=sk-secret123 && npm test" },
      p2: { name: "p2", runtimeType: "shell", status: "Idle", lastCommand: "ls" },
    },
    ledger: { activeProjectId: "proj" },
    settings: { globalPermissionsMode: "Human-in-the-Loop" },
    listPanes: () => [{ project_id: "proj", panes: [
      { pane_id: "p1", name: "p1", last_known_state: "Running" },
      { pane_id: "p2", name: "p2", last_known_state: "Idle" },
    ]}],
  };
  const store = {
    getProject: (_id: string) => ({ id: "proj", name: "Janus", summary: "orchestrator", key_terms: ["pty"] }),
    getProjectBriefing: (_id: string) => ({ summary: "orchestrator", recentNotes: [] }),
  };
  const redact = (s: string) => s.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]");
  return { manager, store, redact, breadcrumbs };
}

test("getPaneTier redacts lastCommand and reflects live status", () => {
  const wm = new WorldModel(fakeDeps() as any);
  const t = wm.getPaneTier("p1")!;
  assert.equal(t.status, "Running");
  assert.doesNotMatch(t.lastCommand!, /sk-secret/);  // secret scrubbed
  assert.match(t.lastCommand!, /\[REDACTED\]/);
});

test("getBoardTier lists all panes; getTiers foregrounds the active pane", () => {
  const wm = new WorldModel(fakeDeps() as any);
  const board = wm.getBoardTier();
  assert.equal(board.length, 2);
  const tiers = wm.getTiers("p1", 1000);
  assert.equal(tiers.pane!.paneId, "p1");
  assert.equal(tiers.project!.name, "Janus");
  assert.equal(tiers.frame.gatePosture, "Human-in-the-Loop");
});

// Phase 2 Step 2.1 (docs/superpowers/specs/2026-07-09-agent-exchange-spine.md): fakeDeps()'s
// store deliberately stays narrow (no getNotes/getEvents/listHandoffs/listExchangesByPane/
// listExchangeEvents) — WorldModel's new store accessors are all OPTIONAL, so a caller that never
// grows the store shape must keep working exactly as before. The full enriched-store battery
// lives in tests/test_worldmodel_exchange_context.ts.
test("new tiers/fields degrade to empty/null (never throw) against a narrow store lacking the new accessors", () => {
  const wmodel = new WorldModel(fakeDeps() as any);
  const project = wmodel.getProjectTier("proj")!;
  assert.deepEqual(project.recentDecisions, []);
  assert.deepEqual(project.warnings, []);
  assert.deepEqual(project.openTodos, []);
  const pane = wmodel.getPaneTier("p1")!;
  assert.deepEqual(pane.recent, []);
  const board = wmodel.getBoardTier();
  assert.ok(board.every(b => b.exchangeState === null && b.waitingReason === null));
  // No affectedPaneId supplied -> eventFocus stays null (pre-existing default-behavior floor).
  const tiers = wmodel.getTiers("p1", 1000);
  assert.equal(tiers.eventFocus, null);
});

test("eventFocus is populated from manager.terminals identity even with a narrow store (no exchange data)", () => {
  const wmodel = new WorldModel(fakeDeps() as any);
  const tiers = wmodel.getTiers("p1", 1000, "p2");
  // p2 exists in manager.terminals (fakeDeps), so the block is built, just with empty content.
  assert.ok(tiers.eventFocus);
  assert.equal(tiers.eventFocus!.paneId, "p2");
  assert.equal(tiers.eventFocus!.name, "p2");
  assert.equal(tiers.eventFocus!.eventText, "");
  assert.equal(tiers.eventFocus!.exchangeState, null);
});
