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
