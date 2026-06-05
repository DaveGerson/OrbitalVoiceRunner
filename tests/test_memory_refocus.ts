import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryService } from "../src/memory";

function mkManager() {
  return {
    activeId: "p1" as string | null,
    terminals: {
      p1: { name: "p1", runtimeType: "interactive_cli", status: "Running", lastCommand: "edit server.ts" },
      p2: { name: "p2", runtimeType: "interactive_cli", status: "Idle", lastCommand: "npm test" },
    } as Record<string, any>,
    ledger: { activeProjectId: "proj" },
    settings: { globalPermissionsMode: "Human-in-the-Loop" },
    listPanes: () => [{ project_id: "proj", panes: [
      { pane_id: "p1", name: "p1", last_known_state: "Running" },
      { pane_id: "p2", name: "p2", last_known_state: "Idle" },
    ]}],
  };
}

test("switching active pane re-focuses: new pane sharp, old pane demoted to breadcrumb, project stable", () => {
  const manager = mkManager();
  const store = { getProject: () => ({ id: "proj", name: "Janus", summary: "orchestrator", key_terms: [] }), getProjectBriefing: () => null };
  const redact = (s: string) => s;
  const { service, addBreadcrumb } = createMemoryService({ manager: manager as any, store: store as any, redact });

  // Focused on p2 first
  manager.activeId = "p2";
  const before = service.synthesize("p2", 1000);
  assert.match(before.text, /ACTIVE PANE p2/);
  assert.match(before.text, /npm test/);            // p2's detail is in focus

  // Operator switches to p1; p2's work demotes to a breadcrumb
  addBreadcrumb({ ts: 1500, paneId: "p2", text: "was on p2: npm test" });
  manager.activeId = "p1";
  const after = service.synthesize("p1", 2000);

  assert.match(after.text, /ACTIVE PANE p1/);        // p1 now sharp
  assert.match(after.text, /edit server\.ts/);       // p1 detail present
  assert.doesNotMatch(after.text, /ACTIVE PANE p2/); // p2 NO LONGER in focus (no rot)
  assert.match(after.text, /was on p2/);             // p2 demoted to breadcrumb
  assert.match(after.text, /PROJECT Janus/);         // project continuity preserved
});
