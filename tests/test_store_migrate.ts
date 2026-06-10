// tests/test_store_migrate.ts
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JanusStore } from "../src/store/sqliteStore";
import {
  migrateFromObjects,
  migrateFromJson,
  migrateOnBootIfNeeded,
  initStoreWithQuarantine,
  LEDGER_MIGRATED_KEY,
} from "../src/store/migrate";

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CARD 3V.5 — DB quarantine + migration marker inside the import transaction.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("3V.5: an EXISTING but unparseable legacy ledger THROWS — file untouched, no marker, nothing imported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-3v5-parse-"));
  const ledgerPath = path.join(dir, ".janus_ledger.json");
  fs.writeFileSync(ledgerPath, "{ not json !!!", "utf8"); // exists, does not parse

  const s = new JanusStore(":memory:"); s.init();
  // Pre-fix the unreadable file was SWALLOWED (read() -> undefined), then archived to .bak and the
  // marker set — the data was silently lost AND re-import was permanently blocked. Post-fix: throw,
  // leave the file exactly where it is (server.ts's migration catch logs and boots without import).
  assert.throws(() => migrateOnBootIfNeeded(s, {
    ledgerPath,
    settingsPath: path.join(dir, ".janus_settings.json"),
    historyPath: path.join(dir, ".janus_history.json"),
  }), /ledger|parse/i, "an existing-but-unparseable ledger must throw, not be silently archived");

  assert.ok(fs.existsSync(ledgerPath), "the unparseable ledger file is left IN PLACE (recoverable)");
  assert.ok(!fs.existsSync(`${ledgerPath}.bak`), "it is NOT renamed to .bak");
  assert.strictEqual(s.getKV(LEDGER_MIGRATED_KEY), null, "the migration marker is NOT set");
  assert.strictEqual(Object.keys(s.getWorkspaces()).length, 0, "nothing was imported");

  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("3V.5: the migration marker commits ATOMICALLY with the import (a marker-write failure rolls back everything)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-3v5-marker-"));
  const ledgerPath = path.join(dir, ".janus_ledger.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({
    activeProjectId: "p1",
    workspaces: { p1: { id: "p1", name: "P1", directory: "/tmp", summary: "", keyTerms: [], notes: [], panes: {} } },
  }), "utf8");

  const s = new JanusStore(":memory:"); s.init();
  // Fault-inject EXACTLY the marker write. Pre-fix the marker was set OUTSIDE the import
  // transaction: the import committed, the originals were renamed, and only then did the marker
  // write fail — leaving an imported-but-unmarked store with the source file already archived.
  // Post-fix the marker is written INSIDE the same transaction, so this throw rolls back the whole
  // import and (because the .bak rename runs after the transaction) leaves the JSON untouched.
  const origSetKV = s.setKV.bind(s);
  (s as any).setKV = (k: string, v: string) => {
    if (k === LEDGER_MIGRATED_KEY) throw new Error("simulated marker-write failure (disk full)");
    return origSetKV(k, v);
  };

  assert.throws(() => migrateOnBootIfNeeded(s, {
    ledgerPath,
    settingsPath: path.join(dir, ".janus_settings.json"),
    historyPath: path.join(dir, ".janus_history.json"),
  }), /marker-write failure/);

  assert.strictEqual(Object.keys(s.getWorkspaces()).length, 0,
    "the import ROLLED BACK with the failed marker (marker + import are one transaction)");
  assert.ok(fs.existsSync(ledgerPath), "the legacy ledger is still at the live path (no .bak rename)");
  assert.ok(!fs.existsSync(`${ledgerPath}.bak`), "no .bak was created for a failed import");
  assert.strictEqual(s.getKV(LEDGER_MIGRATED_KEY), null, "no marker survives the rollback");

  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("3V.5: a successful migrateOnBootIfNeeded still sets the marker (inside the txn) and archives the originals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-3v5-happy-"));
  const ledgerPath = path.join(dir, ".janus_ledger.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({ activeProjectId: "p1", workspaces: {} }), "utf8");
  const s = new JanusStore(":memory:"); s.init();
  assert.strictEqual(migrateOnBootIfNeeded(s, {
    ledgerPath,
    settingsPath: path.join(dir, ".janus_settings.json"),
    historyPath: path.join(dir, ".janus_history.json"),
  }), true);
  assert.ok(s.getKV(LEDGER_MIGRATED_KEY), "marker set on success");
  assert.ok(fs.existsSync(`${ledgerPath}.bak`), "original archived to .bak on success");
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("3V.5: initStoreWithQuarantine — a corrupt DB is quarantined to .corrupt-<ts> and a FRESH store boots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-3v5-quar-"));
  const dbPath = path.join(dir, "janus.db");
  const GARBAGE = "THIS IS NOT A SQLITE DATABASE   garbage bytes";
  fs.writeFileSync(dbPath, GARBAGE, "utf8");
  // Stale WAL/SHM twins must travel WITH the quarantined main file (a leftover -wal would otherwise
  // be replayed into the FRESH db sqlite creates under the same name).
  fs.writeFileSync(`${dbPath}-wal`, "stale wal", "utf8");
  fs.writeFileSync(`${dbPath}-shm`, "stale shm", "utf8");

  const result = initStoreWithQuarantine(dbPath, (s) => s.init());

  assert.ok(result.store, "a FRESH store boots after the quarantine (never a silent legacy fallback)");
  assert.ok(result.quarantinedTo, "the quarantine path is reported");
  assert.match(result.quarantinedTo!, /\.corrupt-\d+$/, "the bad DB is renamed to .corrupt-<timestamp>");
  assert.ok(fs.existsSync(result.quarantinedTo!), "the quarantined file exists (data recoverable)");
  assert.strictEqual(fs.readFileSync(result.quarantinedTo!, "utf8"), GARBAGE, "the corrupt bytes are preserved verbatim");
  // Twin hygiene: the REAL safety property is that no stale -wal/-shm lingers under the LIVE name
  // (a leftover -wal would replay into the fresh DB sqlite creates under the same path). sqlite's
  // own close() checkpoints/unlinks the twins — which the handle-hygiene fix (close-before-rename,
  // required for Windows renameSync) now triggers on the constructor-throw shape too. The earlier
  // "twins moved with the quarantine" expectation was an artifact of the LEAKED handle (close never
  // ran) — exactly the Windows-breaking bug. Either fate is safe: moved aside or unlinked — never
  // present under the live name.
  assert.ok(!fs.existsSync(`${dbPath}-wal`) || fs.readFileSync(`${dbPath}-wal`, "utf8") !== "stale wal",
    "no stale -wal twin lingers under the live name (replay hazard)");
  assert.ok(!fs.existsSync(`${dbPath}-shm`) || fs.readFileSync(`${dbPath}-shm`, "utf8") !== "stale shm",
    "no stale twin lingers under the live name");

  // The fresh store WORKS (writes + reads round-trip).
  result.store!.setKV("smoke", "ok");
  assert.strictEqual(result.store!.getKV("smoke"), "ok", "the fresh store is functional");
  result.store!.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test("3V.5: initStoreWithQuarantine — a healthy (or absent) DB boots normally with NO quarantine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-3v5-healthy-"));
  const dbPath = path.join(dir, "janus.db");
  const r1 = initStoreWithQuarantine(dbPath, (s) => s.init()); // absent -> created fresh
  assert.ok(r1.store, "an absent DB is created fresh");
  assert.strictEqual(r1.quarantinedTo, null, "no quarantine for a fresh DB");
  r1.store!.setKV("k", "v");
  r1.store!.close();

  const r2 = initStoreWithQuarantine(dbPath, (s) => s.init()); // healthy reopen
  assert.ok(r2.store, "a healthy DB reopens");
  assert.strictEqual(r2.quarantinedTo, null, "no quarantine for a healthy DB");
  assert.strictEqual(r2.store!.getKV("k"), "v", "existing data is intact (no destructive rename)");
  r2.store!.close();
  assert.strictEqual(fs.readdirSync(dir).some((f) => f.includes(".corrupt-")), false, "no .corrupt-* artifacts");
  fs.rmSync(dir, { recursive: true, force: true });
});

// Review finding (PR #67 block): when the corrupt-DB throw originates INSIDE the JanusStore
// constructor (SQLITE_NOTADB at the first pragma — the most common corruption shape), the
// already-opened better-sqlite3 file handle must be CLOSED before the quarantine rename.
// Linux renames an open-handled file happily (inode rename), so the quarantine test above can't
// see the leak — but Windows renameSync throws EPERM/EBUSY on an open handle, making the entire
// recovery path non-functional on the production platform. PIN the handle hygiene directly:
// after a constructor throw, no fd in /proc/self/fd may point at the corrupt file.
test("3V.5: a constructor-throw (SQLITE_NOTADB) leaves NO open handle on the corrupt file", (t) => {
  if (!fs.existsSync("/proc/self/fd")) { t.skip("needs /proc (Linux)"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-3v5-fd-"));
  const dbPath = path.join(dir, "janus.db");
  fs.writeFileSync(dbPath, "THIS IS NOT A SQLITE DATABASE", "utf8");

  assert.throws(() => new JanusStore(dbPath), /file is not a database|SQLITE_NOTADB/i,
    "garbage DB must throw from the constructor (the pragma header touch)");

  const openTargets = fs.readdirSync("/proc/self/fd").flatMap((fd) => {
    try { return [fs.readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; }
  });
  assert.ok(!openTargets.some((p) => p.includes(dbPath)),
    "no open fd may point at the corrupt DB after the constructor throw (Windows rename precondition)");

  // And the full quarantine flow works on the constructor-throw shape too.
  const result = initStoreWithQuarantine(dbPath, (s) => s.init());
  assert.ok(result.store, "fresh store boots after constructor-throw quarantine");
  assert.ok(result.quarantinedTo && fs.existsSync(result.quarantinedTo), "corrupt file quarantined");
  result.store!.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
