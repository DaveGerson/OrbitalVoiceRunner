// tests/test_store_migrate.ts
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JanusStore } from "../src/store/sqliteStore";
import { migrateFromObjects, migrateFromJson } from "../src/store/migrate";

test("migrateFromObjects is atomic: a mid-import failure leaves the DB empty", () => {
  const s = new JanusStore(":memory:"); s.init();

  // First workspace is valid. Second workspace has a pane with pane_id: null,
  // which violates the NOT NULL constraint on panes.pane_id and throws mid-transaction.
  const input = {
    ledger: {
      workspaces: {
        ws1: {
          id: "ws1", name: "WS1", directory: "/a", summary: "", keyTerms: [],
          notes: [], panes: {},
        },
        ws2: {
          id: "ws2", name: "WS2", directory: "/b", summary: "", keyTerms: [],
          notes: [],
          panes: {
            badPane: {
              pane_id: null,         // NOT NULL violation — forces the INSERT to throw
              name: "bad", runtime_type: "shell", tool_preset: "Custom",
              permissions_mode: "Human-in-the-Loop", session_id: "",
              last_known_state: "Idle", is_busy: false, alive: false, context_size: 0,
            },
          },
        },
      },
    },
  };

  // The transaction must throw (NOT NULL on pane_id)
  assert.throws(() => migrateFromObjects(s, input), /NOT NULL|constraint/i);

  // The outer transaction must have rolled back everything — even ws1 must be absent
  assert.strictEqual(Object.keys(s.getWorkspaces()).length, 0,
    "partial workspace import must be rolled back");
  assert.strictEqual(s.getEvents({}).length, 0,
    "partial event import must be rolled back");

  s.close();
});

test("migrateFromObjects imports ledger + settings + history with no data loss", () => {
  const s = new JanusStore(":memory:"); s.init();
  const ledger = {
    activeProjectId: "p1",
    workspaces: { p1: {
      id:"p1", name:"P1", directory:"/tmp", summary:"sum", keyTerms:["k"],
      notes:["old decision"],
      panes: { t1: { pane_id:"t1", name:"t1", runtime_type:"shell", last_known_state:"Idle",
        is_busy:false, alive:false, notes:["pane note"], permissions_mode:"Human-in-the-Loop",
        session_id:"", tool_preset:"Claude Code", context_size:0 } }
    }},
    watchRules: [{ id:"w1" }], plans: [{ id:"pl1" }],
  };
  const settings = { advanced: { globalPermissionsMode: "Inherit", idleTimeoutMs: 1500 } };
  const history = { t1: [{ command:"npm test", timestamp:5, finalResponse:"ok", output:"" }] };

  migrateFromObjects(s, { ledger, settings, history });

  assert.equal(s.getWorkspaces()["p1"].name, "P1");
  assert.equal(Object.keys(s.getPanes("p1")).length, 1);
  const notes = s.getNotes({ projectId:"p1" });
  assert.ok(notes.some(n => n.text === "old decision" && n.pane_id === null));
  assert.ok(notes.some(n => n.text === "pane note" && n.pane_id === "t1"));
  assert.equal(s.getEvents({ paneId:"t1", type:"command_outcome" }).length, 1);
  assert.equal(s.getSettings("advanced.idleTimeoutMs"), "1500");
  assert.equal(s.getKV("activeProjectId"), "p1");
  assert.equal(JSON.parse(s.getKV("watchRules")!).length, 1);
  s.close();
});

test("migrateFromJson preserves the settings JSON in place (ahm regression) — config + Gemini key survive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-ahm-"));
  const ledgerPath = path.join(dir, ".janus_ledger.json");
  const settingsPath = path.join(dir, ".janus_settings.json");
  const historyPath = path.join(dir, ".janus_history.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({ activeProjectId: "p1", workspaces: {} }), "utf8");
  // Legacy settings file holds the operator's config AND the Gemini key (the pre-hardening shape).
  fs.writeFileSync(settingsPath, JSON.stringify({ secrets: { geminiApiKey: "LEGACY-KEY-123" }, advanced: { idleTimeoutMs: 1500 } }), "utf8");
  fs.writeFileSync(historyPath, JSON.stringify({}), "utf8");

  const s = new JanusStore(":memory:"); s.init();
  migrateFromJson(s, { ledgerPath, settingsPath, historyPath });

  // ahm fix: the settings JSON is NOT renamed, so OrchestratorManager.loadSettings still reads it
  // post-migration — the operator's config + the legacy Gemini key survive the first-migration boot.
  assert.ok(fs.existsSync(settingsPath), "settings JSON must remain in place (ahm regression)");
  assert.ok(!fs.existsSync(`${settingsPath}.bak`), "settings JSON must NOT be archived to .bak");
  const preserved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(preserved.secrets.geminiApiKey, "LEGACY-KEY-123", "the legacy Gemini key must survive the migration");
  assert.equal(preserved.advanced.idleTimeoutMs, 1500, "operator config must survive the migration");

  // ledger + history ARE migrated into SQLite, so their JSON originals are archived to .bak.
  assert.ok(fs.existsSync(`${ledgerPath}.bak`), "ledger JSON migrated → archived to .bak");
  assert.ok(!fs.existsSync(ledgerPath), "ledger JSON original removed after migration");
  assert.ok(fs.existsSync(`${historyPath}.bak`), "history JSON migrated → archived to .bak");

  // secrets.* must never leak into the durable store (in-memory-only hardening).
  assert.ok(s.getSettings("secrets.geminiApiKey") == null, "the Gemini key must NOT be imported into the store");

  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
