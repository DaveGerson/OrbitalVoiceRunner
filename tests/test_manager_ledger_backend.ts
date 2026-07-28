// tests/test_manager_ledger_backend.ts
// The WS-M cutover seam: OrchestratorManager.ledger is a LedgerLike. dbt3 retired the
// legacy JSON Ledger backend — SQLite (JanusStore) is now the ONLY backend, and the
// `ledger` constructor option is mandatory (no default). Migration of real legacy JSON
// into SQLite is NOT covered here — this only proves the dependency-injection seam
// compiles and works end-to-end against a JanusStore.
// bead eoef: pin the settings file into a tmpdir for this whole file — constructing an
// OrchestratorManager (directly or via startServer) without this writes a cwd-relative
// .janus_settings.json into the repo root, which the run-unit cleanliness gate fails on.
import { pinSettingsPathToTmpdir } from "./helpers/settingsPath";
pinSettingsPathToTmpdir();

import { test } from "node:test";
import assert from "node:assert";
import { OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";

test("OrchestratorManager can be constructed on an injected JanusStore (LedgerLike)", () => {
  const store = new JanusStore(":memory:"); store.init();
  const m = new OrchestratorManager({ ledger: store });
  // The manager's constructor registers + switches to an active project on boot;
  // those calls must land on the injected store.
  assert.ok(m.ledger === store, "injected store should be the live ledger");
  const active = m.ledger.activeProjectId;
  assert.ok(active, "constructor should have set an active project on the store");
  assert.ok(m.ledger.getProject(active!), "active project should exist in the store");
  store.close();
});

test("draft + context flow through the injected store end-to-end", () => {
  const store = new JanusStore(":memory:"); store.init();
  const m = new OrchestratorManager({ ledger: store });
  const proj = m.ledger.activeProjectId!;
  // Register a pane the way the app does (savePane is store-native; the manager
  // uses ledger.addProject/switchContext on boot, panes come later via the store).
  store.savePane({
    pane_id: "t1", workspace_id: proj, name: "t1", runtime_type: "shell",
    tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop", session_id: "",
    last_known_state: "Idle", is_busy: false, alive: true, context_size: 0,
    last_status_change_at: null, last_command: null, scrollback_path: null,
    created_at: 0, updated_at: 0,
  });
  assert.equal(m.ledger.setDraft(proj, "t1", "composed prompt", "operator"), true);
  assert.equal(m.ledger.getDraft(proj, "t1")!.text, "composed prompt");
  assert.equal(m.ledger.addModelContext(proj, "t1", "orientation", "synthesizer"), true);
  assert.equal(m.ledger.getPaneContext(proj, "t1")!.model[0].text, "orientation");
  store.close();
});
