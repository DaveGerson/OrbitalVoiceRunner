// tests/test_sync_ledger_persist_wins.ts
//
// BEAD gpd (P1) — syncLedger PERSIST-WINS.
//
// syncLedger() reconciles the LIVE PTY state into the persisted ledger on every
// listPanes()/refreshLedger() call. The hazard: it used to write the LIVE
// term.permissionsMode over the persisted ledger value (and never carried
// capabilityGates at all, so it NULL'd a persisted per-pane gate override). A
// routine sync therefore REVERTED deliberate operator intent — e.g. a Read-Only
// lock the operator set on a pane would silently flip back to whatever the live
// process happened to hold.
//
// PERSIST-WINS contract: when reconciling, the PERSISTED ledger values for
// permissions_mode and capabilityGates must SURVIVE a sync with a divergent live
// term value. Operator intent recorded to the ledger is authoritative.
import { test } from "node:test";
import assert from "node:assert";
import { OrchestratorManager, UniversalTerminal } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import type { CapabilityGateMap } from "../src/types";

test("syncLedger PERSIST-WINS: persisted permissions_mode + capabilityGates survive a divergent live sync", () => {
  const store = new JanusStore(":memory:");
  store.init();
  const manager = new OrchestratorManager({ ledger: store });
  const proj = manager.ledger.activeProjectId!;

  const PERSISTED_GATES: CapabilityGateMap = { write_to_pane: "Off", restart_pane: "Off" };

  // 1) Stage a PERSISTED pane carrying deliberate operator intent: a Read-Only
  //    lock and a per-pane capability-gate override.
  store.savePane({
    pane_id: "t1", workspace_id: proj, name: "t1", runtime_type: "interactive_cli",
    tool_preset: "Claude Code", permissions_mode: "Read-Only", session_id: "",
    last_known_state: "Idle", is_busy: false, alive: true, context_size: 0,
    last_status_change_at: null, last_command: null, scrollback_path: null,
    created_at: 0, updated_at: 0,
  });
  // capabilityGates round-trips through updatePane (the only seam that writes the
  // capability_gates column); stage it the same way the app persists an override.
  store.updatePane(proj, {
    ...store.getProject(proj)!.panes["t1"],
    capabilityGates: PERSISTED_GATES,
  }, false);

  // Precondition: the persisted intent is actually on the ledger.
  const before = store.getProject(proj)!.panes["t1"];
  assert.equal(before.permissions_mode, "Read-Only", "precondition: persisted mode is Read-Only");
  assert.deepEqual(before.capabilityGates, PERSISTED_GATES, "precondition: persisted gates staged");

  // 2) Register a LIVE terminal with a DIVERGENT mode (Full Auto) and NO gates,
  //    WITHOUT spawning a PTY (the constructor never spawns; only start() does).
  const live = new UniversalTerminal("t1", process.cwd(), "echo hi", "Claude Code", "Full Auto", "", proj);
  assert.equal(live.permissionsMode, "Full Auto", "live term diverges from persisted intent");
  (manager.terminals as Record<string, UniversalTerminal>)["t1"] = live;

  // 3) Force a sync (the public seam over the private syncLedger()).
  manager.refreshLedger();

  // 4) PERSIST-WINS: the operator's recorded intent must SURVIVE the sync.
  const after = store.getProject(proj)!.panes["t1"];
  assert.equal(
    after.permissions_mode,
    "Read-Only",
    `persisted permissions_mode must survive the sync (persist-wins), got ${after.permissions_mode}`,
  );
  assert.deepEqual(
    after.capabilityGates,
    PERSISTED_GATES,
    `persisted capabilityGates must survive the sync (persist-wins), got ${JSON.stringify(after.capabilityGates)}`,
  );

  store.close();
});
