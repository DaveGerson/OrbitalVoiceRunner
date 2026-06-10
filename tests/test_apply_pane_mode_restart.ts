// tests/test_apply_pane_mode_restart.ts
//
// CARD 3V.4 — deferred mode-changes must SURVIVE a restart.
//
// FINDING: applyPaneMode staged its Ask deferral WITHOUT the PLM3 version stamp
// (src/applyPaneMode.ts gate params), so boot hydration (src/gating/index.ts hydrate loop) treated
// the persisted intent as "unknown_action" and QUARANTINED it: the operator's pending confirm
// silently vanished on restart. The stamped legacy path (src/actions/defs/locks.ts:144) replayed
// fine — only the live-choke-point path was unstamped.
//
// FIX UNDER TEST:
//   (a) applyPaneMode spreads { actionName: "set_pane_permissions", schemaHash } into its gate
//       params, exactly like locks.ts does via ctx.versionStamp — checkActionVersion passes.
//   (b) actionEffects.buildActionRun grows a rebuild arm for the applyPaneMode-SHAPED intent
//       (discriminated by the `source` param the choke point stages and the legacy path never
//       does): it applies the mode to the live pane object (next-spawn semantics) + persists it
//       to the ledger (PERSIST-WINS mirror of gating's persistMode) and broadcasts a note that a
//       restart-resume is needed for the LIVE process — a full live-signal replay is impractical
//       post-restart (buildActionRun's deps carry no adapter/gate seams, and re-entering
//       applyPaneMode would re-gate -> re-defer forever).

import { test, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { JanusStore } from "../src/store/sqliteStore";
import { createGating, type GatingDeps } from "../src/gating";
import { applyPaneMode } from "../src/applyPaneMode";
import { checkActionVersion } from "../src/actionEffects";

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-mode-restart-"));
  tmpDirs.push(dir);
  return join(dir, "modes.db");
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** A fresh fake manager per "process": records setPermissionsMode + ledger persist calls. */
function makeManager() {
  const setCalls: string[] = [];
  const updatedPanes: Array<[string, any, boolean | undefined]> = [];
  const pane: any = { permissions_mode: "Human-in-the-Loop", capabilityGates: {} };
  const ws: any = { id: "default_project", panes: { "pane-1": pane } };
  const manager: any = {
    globalPermissionsMode: "Inherit",
    terminals: {
      "pane-1": {
        permissionsMode: "Human-in-the-Loop",
        setPermissionsMode(m: string) { setCalls.push(m); this.permissionsMode = m; },
      },
    },
    settings: { advanced: { capabilityGates: { set_pane_permissions: "Ask" } } },
    ledger: {
      activeProjectId: "default_project",
      getActiveProject: () => ws,
      getProject: (id: string) => (id === "default_project" ? ws : null),
      updatePane: (pid: string, p: any, force?: boolean) => { updatedPanes.push([pid, p, force]); },
      save: () => {},
      plans: [],
      watchRules: [],
    },
  };
  return { manager, setCalls, updatedPanes, pane };
}

function makeDeps(store: JanusStore, manager: any): GatingDeps {
  const coreState: any = {
    activeFrontendWs: null,
    activeLiveSession: null,
    clients: new Set(),
    activePaneId: null,
    frozen: false,
    lastStopAllFailed: [],
    setFrozen: () => {},
  };
  return {
    manager,
    store,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    broadcastDraft: () => {},
    coreState,
    announcementBus: { enqueue: () => true, stop: () => {} } as any,
    pushApprovalNarration: () => {},
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
  };
}

// ---------------------------------------------------------------------------
// (a) The staged intent is version-stamped — checkActionVersion must pass on it.
// ---------------------------------------------------------------------------
test("3V.4 (a): applyPaneMode stages a VERSION-STAMPED intent the boot guard accepts", async () => {
  let captured: Record<string, unknown> | undefined;
  const r = await applyPaneMode(
    "pane-9",
    "Read-Only",
    "ui",
    { permissionsMode: "Human-in-the-Loop" } as any, // deferred path never touches the adapter
    {
      gateOrDefer: (_cap, _pane, summary, _run, params) => {
        captured = params;
        return { disposition: "deferred", actionId: "act-x", summary };
      },
      pendingApprovals: {} as any,
      pendingActions: {} as any,
      broadcast: () => {},
      persistMode: () => {},
    },
  );
  assert.strictEqual(r.kind, "deferred");
  assert.ok(captured, "the gate received intent params");
  assert.strictEqual(captured!.actionName, "set_pane_permissions", "the canonical action name is stamped");
  assert.ok(typeof captured!.schemaHash === "string" && (captured!.schemaHash as string).length > 0, "the schema hash is stamped");
  const check = checkActionVersion(captured as { actionName?: string; schemaHash?: string });
  assert.deepStrictEqual(check, { ok: true }, "boot hydration would NOT quarantine this intent");
  // The capability-specific params the rebuild needs are still all present.
  assert.strictEqual(captured!.paneId, "pane-9");
  assert.strictEqual(captured!.permissionsMode, "Read-Only");
  assert.strictEqual(captured!.source, "ui");
});

// ---------------------------------------------------------------------------
// (b) Full durable round-trip: defer via the REAL gate -> restart -> survive -> confirm applies.
// ---------------------------------------------------------------------------
test("3V.4 (b): a deferred applyPaneMode change SURVIVES restart hydration and confirm applies the mode", async () => {
  const dbPath = tmpDbPath();

  // "Process 1": stage the Ask deferral through the real gating choke point + durable store.
  const store1 = new JanusStore(dbPath); store1.init();
  const m1 = makeManager();
  const gating1 = createGating(makeDeps(store1, m1.manager));
  const r = await gating1.applyPaneMode("pane-1", "Full Auto", "voice");
  assert.strictEqual(r.kind, "deferred", "Ask tier defers the mode change");
  const actionId = r.actionId!;
  assert.ok(gating1.pendingActions.has(actionId), "the deferral is staged in-process");
  assert.deepStrictEqual(m1.setCalls, [], "NO side effect before operator confirm");
  store1.close();

  // "Process 2" (the restart): createGating re-runs the boot hydration loop over the same DB.
  const store2 = new JanusStore(dbPath); store2.init();
  const m2 = makeManager();
  const gating2 = createGating(makeDeps(store2, m2.manager));

  // THE 3V.4 REGRESSION: pre-fix the unstamped intent was quarantined here and the operator's
  // pending confirm silently vanished.
  assert.ok(gating2.pendingActions.has(actionId), "the deferred mode-change SURVIVES the restart (not quarantined)");

  // Operator confirms after the restart: the rebuilt effect applies the mode.
  const c = gating2.pendingActions.confirm(actionId);
  assert.strictEqual(c.reason, "confirmed");
  assert.deepStrictEqual(m2.setCalls, ["Full Auto"], "confirm applies the mode to the live pane object");
  assert.strictEqual(m2.pane.permissions_mode, "Full Auto", "confirm persists the mode to the ledger pane (PERSIST-WINS)");
  assert.ok(m2.updatedPanes.length >= 1, "the ledger persist write fired");
  assert.match(String(c.output), /restart/i, "the confirm string names the restart-resume caveat for the LIVE process");
  assert.strictEqual(gating2.pendingActions.has(actionId), false, "confirm consumes the deferral exactly once");
  store2.close();
});
