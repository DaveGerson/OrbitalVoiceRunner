// tests/test_boot_recovery_summary.ts — bead res3 (server-restart recovery UX).
//
// THE GAP (per recon): reconcilePanesInert (src/terminal.ts) durably flips every persisted pane
// to inert (alive=false/is_busy=false/last_known_state='Exited') on boot — good, that fix already
// landed in this tree — but it was PURELY SILENT bookkeeping: no console log, no attention-digest
// entry, no narration, no UI banner. The operator had no way to learn "N panes were running before
// this restart" short of discovering dead panes one at a time.
//
// THE FIX: reconcilePanesInert now captures which panes were alive BEFORE the flip and, if any
// were, pushes ONE informational ("idle" — matches the existing dispatch-join-completion idiom)
// attention item summarizing them. This reuses the EXISTING idioms end to end:
//   - voice: get_attention_digest narrates unread attentionQueue items (src/actions/defs/reads.ts)
//   - REST:  GET /api/attention returns the raw queue (src/orbital/useOrbitalData.ts refetchAttention
//            already fetches this on mount)
// No new endpoint, no new WS frame type, no auto-restart — restoring a pane stays an explicit
// respawn_pane/restore_archived_pane/POST-restart action.
//
// This suite proves it at two layers:
//   1. Unit: OrchestratorManager constructed directly on a seeded JanusStore(":memory:") — precise
//      assertions on the item shape, message content, and that an already-dead pane is excluded.
//   2. Integration: a REAL server boots (startServer) against a seeded ON-DISK JanusStore file
//      (the "restart" — a fresh process/instance reading the same persisted ledger), and we assert
//      the summary surfaces over the REAL GET /api/attention REST endpoint and that GET /api/terminals
//      is empty (nothing auto-spawned).
//
// Runner: npx tsx --test --test-force-exit tests/test_boot_recovery_summary.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import type { StoredPane } from "../src/store/types";

function paneRow(id: string, workspaceId: string, alive: boolean): StoredPane {
  return {
    pane_id: id, workspace_id: workspaceId, name: id, runtime_type: "interactive_cli",
    tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop", session_id: "",
    last_known_state: alive ? "Running" : "Exited", is_busy: alive, alive, context_size: 0,
    last_status_change_at: null, last_command: null, scrollback_path: null,
    created_at: 0, updated_at: 0,
  };
}

describe("res3 — boot-time 'N panes were live before restart' summary (unit)", () => {
  // bead 1p84: OrchestratorManager resolves its settings file via JANUS_SETTINGS_PATH, else a
  // cwd-relative ".janus_settings.json". These cases construct a manager directly (no chdir), so
  // pin the settings file into a tmpdir — otherwise the manager writes .janus_settings.json into
  // the repo root, which the run-unit cleanliness gate (bead 1p84) now fails the battery on.
  let settingsDir: string;
  let prevSettingsPath: string | undefined;
  before(() => {
    settingsDir = mkdtempSync(join(tmpdir(), "janus-bootrec-unit-"));
    prevSettingsPath = process.env.JANUS_SETTINGS_PATH;
    process.env.JANUS_SETTINGS_PATH = join(settingsDir, ".janus_settings.json");
  });
  after(() => {
    if (prevSettingsPath === undefined) delete process.env.JANUS_SETTINGS_PATH;
    else process.env.JANUS_SETTINGS_PATH = prevSettingsPath;
    try { rmSync(settingsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("pushes ONE informational attentionQueue item listing only the panes that were alive", () => {
    const store = new JanusStore(":memory:");
    store.init();
    store.addProject("proj1", process.cwd(), "test project");
    store.switchContext("proj1");
    store.savePane(paneRow("p1", "proj1", true));
    store.savePane(paneRow("p2", "proj1", true));
    store.savePane(paneRow("p3", "proj1", false)); // already inert before "restart" — must be excluded

    const m = new OrchestratorManager({ ledger: store });

    // Nothing auto-spawned — the manager never touches term registration during reconciliation.
    assert.deepStrictEqual(Object.keys(m.terminals), []);

    // The ledger flip itself is durable (dbt3 fix this tree already made).
    const proj = m.ledger.getProject("proj1")!;
    assert.strictEqual(proj.panes["p1"].alive, false);
    assert.strictEqual(proj.panes["p1"].last_known_state, "Exited");
    assert.strictEqual(proj.panes["p2"].alive, false);
    assert.strictEqual(proj.panes["p3"].alive, false);

    const recovery = m.attentionQueue.filter((it) => it.type === "idle" && /before this restart/.test(it.message));
    assert.strictEqual(recovery.length, 1, "exactly one boot-recovery item pushed");
    const item = recovery[0];
    assert.strictEqual(item.dismissed, false);
    assert.strictEqual(item.projectId, "proj1");
    assert.match(item.message, /^2 panes were running before this restart/);
    assert.match(item.message, /p1/);
    assert.match(item.message, /p2/);
    assert.doesNotMatch(item.message, /p3/, "an already-dead pane is not part of the recovery story");
    assert.match(item.message, /restart/i);
    store.close();
  });

  it("emits nothing when no pane was alive before boot (a clean prior shutdown)", () => {
    const store = new JanusStore(":memory:");
    store.init();
    store.addProject("proj2", process.cwd(), "test project");
    store.switchContext("proj2");
    store.savePane(paneRow("p1", "proj2", false));

    const m = new OrchestratorManager({ ledger: store });
    const recovery = m.attentionQueue.filter((it) => /before this restart/.test(it.message));
    assert.strictEqual(recovery.length, 0, "no summary item when nothing needs recovering");
    store.close();
  });

  it("emits nothing on a fresh project with zero panes", () => {
    const store = new JanusStore(":memory:");
    store.init();
    const m = new OrchestratorManager({ ledger: store });
    assert.strictEqual(m.attentionQueue.length, 0);
    store.close();
  });
});

describe("res3 — boot-time summary surfaces over the REAL server + REST (integration)", () => {
  let tmpDir: string;
  let dbPath: string;
  let running: RunningServer | undefined;
  const prevEnv: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined) {
    prevEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "janus-boot-recovery-"));
    dbPath = join(tmpDir, "boot.db");

    // Seed the durable store BEFORE boot — models "the server was killed while p1/p2 were running".
    const seed = new JanusStore(dbPath);
    seed.init();
    seed.addProject("default_project", tmpDir, "seeded");
    seed.switchContext("default_project");
    seed.savePane(paneRow("p1", "default_project", true));
    seed.savePane(paneRow("p2", "default_project", true));
    seed.close();

    setEnv("JANUS_DB", dbPath);
    setEnv("JANUS_NO_AUTOSTART", "1");
    setEnv("NODE_ENV", "test");
    // bead 1p84: keep the booted server's settings file out of the repo root (else startServer's
    // OrchestratorManager writes a cwd-relative .janus_settings.json — the cleanliness gate reds).
    setEnv("JANUS_SETTINGS_PATH", join(tmpDir, ".janus_settings.json"));

    const serverMod = await import("../server");
    // This IS the "fresh process boots against the same persisted ledger" restart story — a new
    // OrchestratorManager (inside startServer) is constructed against the seeded on-disk file.
    running = await serverMod.startServer({ port: 0, enableVite: false });

    const apiToken = serverMod.API_AUTH_TOKEN;
    (running as any)._testApiToken = apiToken;
  });

  after(async () => {
    await teardownServerSuite(running);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("GET /api/attention carries the boot-recovery summary naming both previously-live panes", async () => {
    const base = `http://127.0.0.1:${running!.port}`;
    const apiToken = (running as any)._testApiToken as string;
    const res = await fetch(`${base}/api/attention`, { headers: { "x-api-token": apiToken } });
    assert.strictEqual(res.status, 200);
    const queue = (await res.json()) as Array<{ type: string; message: string }>;
    const recovery = queue.filter((it) => /before this restart/.test(it.message));
    assert.strictEqual(recovery.length, 1, "exactly one boot-recovery item over the wire");
    assert.match(recovery[0].message, /p1/);
    assert.match(recovery[0].message, /p2/);
  });

  it("GET /api/terminals is empty — nothing auto-spawned on boot despite two previously-live panes", async () => {
    const base = `http://127.0.0.1:${running!.port}`;
    const apiToken = (running as any)._testApiToken as string;
    const res = await fetch(`${base}/api/terminals`, { headers: { "x-api-token": apiToken } });
    assert.strictEqual(res.status, 200);
    const rows = await res.json();
    assert.deepStrictEqual(rows, [], "panes boot INERT — nothing auto-spawns");
  });
});
