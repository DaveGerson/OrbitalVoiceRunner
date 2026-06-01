// tests/test_store_boot_migration.ts
// The gated, idempotent boot migration: import the legacy JSON ledger into the
// store exactly once, marked by a kv flag (NOT by .janus.db existence — the
// handoff store already creates that file), and rename the originals to .bak.
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JanusStore } from "../src/store/sqliteStore";
import { migrateOnBootIfNeeded, LEDGER_MIGRATED_KEY } from "../src/store/migrate";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "janus-boot-"));
}
function writeLedger(dir: string) {
  const ledgerPath = path.join(dir, ".janus_ledger.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({
    activeProjectId: "p1",
    workspaces: { p1: {
      id: "p1", name: "P1", directory: "/tmp", summary: "s", keyTerms: ["k"],
      notes: ["legacy decision"],
      panes: { t1: { pane_id: "t1", name: "t1", runtime_type: "shell",
        last_known_state: "Idle", is_busy: false, alive: false, notes: [],
        permissions_mode: "Human-in-the-Loop", session_id: "", tool_preset: "Claude Code",
        context_size: 0 } },
    }},
    watchRules: [], plans: [],
  }), "utf8");
  return ledgerPath;
}

test("migrateOnBootIfNeeded imports the legacy ledger, marks it, and .bak's the originals", () => {
  const dir = tmp();
  const ledgerPath = writeLedger(dir);
  const store = new JanusStore(path.join(dir, "janus.db")); store.init();

  const ran = migrateOnBootIfNeeded(store, {
    ledgerPath, settingsPath: path.join(dir, ".janus_settings.json"),
    historyPath: path.join(dir, ".janus_history.json"),
  });

  assert.equal(ran, true, "should report it ran");
  assert.equal(store.getWorkspaces()["p1"].name, "P1", "ledger data imported");
  assert.ok(store.getNotes({ projectId: "p1" }).some(n => n.text === "legacy decision"));
  assert.ok(store.getKV(LEDGER_MIGRATED_KEY), "migration marker set");
  assert.ok(fs.existsSync(`${ledgerPath}.bak`), "original renamed to .bak");
  assert.ok(!fs.existsSync(ledgerPath), "original no longer at the live path");

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("migrateOnBootIfNeeded is idempotent — a second call (or reopen) does nothing", () => {
  const dir = tmp();
  const ledgerPath = writeLedger(dir);
  const dbPath = path.join(dir, "janus.db");
  const paths = { ledgerPath, settingsPath: path.join(dir, ".janus_settings.json"), historyPath: path.join(dir, ".janus_history.json") };

  const s1 = new JanusStore(dbPath); s1.init();
  assert.equal(migrateOnBootIfNeeded(s1, paths), true);
  s1.close();

  // Reopen the SAME db: marker persists, so even if the .json reappeared it must not re-import.
  fs.writeFileSync(ledgerPath, JSON.stringify({ workspaces: { p2: { id: "p2", name: "SHOULD_NOT_IMPORT", panes: {} } } }), "utf8");
  const s2 = new JanusStore(dbPath); s2.init();
  assert.equal(migrateOnBootIfNeeded(s2, paths), false, "already migrated → no-op");
  assert.equal(s2.getWorkspaces()["p2"], undefined, "the second file must NOT be imported");
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("migrateOnBootIfNeeded is a no-op when there is no legacy ledger file", () => {
  const dir = tmp();
  const store = new JanusStore(path.join(dir, "janus.db")); store.init();
  const ran = migrateOnBootIfNeeded(store, {
    ledgerPath: path.join(dir, ".janus_ledger.json"),   // does not exist
    settingsPath: path.join(dir, ".janus_settings.json"),
    historyPath: path.join(dir, ".janus_history.json"),
  });
  assert.equal(ran, false);
  assert.equal(store.getKV(LEDGER_MIGRATED_KEY), null, "no marker when nothing migrated");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
