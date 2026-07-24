// tests/test_store_migration.ts
//
// AgentExchange spine — v11 -> v12 migration safety (Phase 1, step 1.2; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §6). Builds a pre-v12 fixture DB by
// running ONLY MIGRATIONS[0..10] (the first 11 migrations == schema v11) directly against a raw
// better-sqlite3 handle — the same technique applyMigrations itself uses, just index-bounded —
// seeds representative rows into the five tables that get a new nullable `exchange_id` column,
// then runs the real `applyMigrations` (which advances a v11 DB by exactly one step, v12) and
// asserts: old rows are untouched and still readable, the new columns exist and are NULL for
// every pre-existing row (NEVER heuristically backfilled), and the three new tables exist, are
// empty, and are usable.

import { describe, it } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";

import { MIGRATIONS, applyMigrations, SCHEMA_VERSION } from "../src/store/schema";

const V11 = 11;

/** A raw better-sqlite3 handle fast-forwarded to EXACTLY schema v11 — no further. */
function buildV11Fixture(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (let i = 0; i < V11; i++) MIGRATIONS[i](db);
  db.pragma(`user_version = ${V11}`);
  return db;
}

/** Seed one representative row into each of the five tables that gain `exchange_id` at v12. */
function seedPreV12Rows(db: Database.Database, now: number): void {
  db.prepare(
    `INSERT INTO pending_approvals(id,session_id,workspace_id,pane_id,command,kind,rationale,claimed,timestamp,expires_at)
     VALUES('appr-1','sess-1','proj-1','pane-1','run tests','agent_instruction',NULL,0,?,?)`
  ).run(now, now + 60_000);

  db.prepare(
    `INSERT INTO action_log(ts,name,capability,result_kind,ms,args_redacted,surface,idempotency_key,interaction_id)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(now, "run_command", "pty_write", "ok", 12, "{}", "voice", "idem-1", "ixn-1");

  db.prepare(
    `INSERT INTO attention(id,type,terminal_id,project_id,message,timestamp,dismissed,details)
     VALUES('att-1','needs_input','pane-1','proj-1','waiting at prompt',?,0,NULL)`
  ).run(now);

  db.prepare(
    `INSERT INTO context_injections(
       id,ts,session_id,interaction_id,inject_id,trigger,active_project_id,active_pane_id,
       brief_active_pane_id,source,disposition,skipped_reason,source_snapshot_hash,brief_hash,
       brief_chars,estimated_tokens,elapsed_ms,error
     ) VALUES('ctxevt-1',?,'sess-1','ixn-1','inj-1','session_start','proj-1','pane-1','pane-1',
       'python','injected',NULL,'snap-hash','brief-hash',100,25,5,NULL)`
  ).run(now);

  db.prepare(
    `INSERT INTO events(ts,type,project_id,pane_id,session_id,summary,payload,handoff_id)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(now, "command_outcome", "proj-1", "pane-1", "sess-1", "legacy summary", "{}", null);
}

describe("v11 -> v12 migration: fixture sanity (pre-migration)", () => {
  it("the v11 fixture has none of the v12 tables/columns yet", () => {
    const db = buildV11Fixture();
    const tableNames = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as any[]).map((r) => r.name);
    for (const t of ["agent_exchanges", "exchange_events", "context_deliveries"]) {
      assert.ok(!tableNames.includes(t), `v11 fixture must NOT already have ${t}`);
    }
    const paCols = (db.prepare("PRAGMA table_info(pending_approvals)").all() as any[]).map((c) => c.name);
    assert.ok(!paCols.includes("exchange_id"), "v11 fixture must not have exchange_id yet");
    assert.equal(db.pragma("user_version", { simple: true }), V11);
    db.close();
  });
});

describe("v11 -> v12 migration: applyMigrations upgrades cleanly", () => {
  // NOTE: applyMigrations always runs to the CURRENT SCHEMA_VERSION (13, since bead 98f2's v13
  // transcripts migration), not just to v12 — so from an v11 fixture it now advances two steps in
  // one call. The literal "12" pin this test used to assert was stale post-v13; verified below via
  // MIGRATIONS[11] run in isolation, which is exactly the v12 step this describe block is about.
  it("MIGRATIONS[11] (the v12 step) taken alone lands on user_version 12", () => {
    const db = buildV11Fixture();
    MIGRATIONS[11](db);
    db.pragma("user_version = 12");
    assert.equal(db.pragma("user_version", { simple: true }), 12);
    db.close();
  });

  it("applyMigrations from v11 lands on the CURRENT SCHEMA_VERSION (now 13, past v12)", () => {
    const db = buildV11Fixture();
    applyMigrations(db);
    assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 13);
    db.close();
  });

  it("old rows in all five ALTER'd tables are readable, unchanged, with exchange_id = NULL", () => {
    const db = buildV11Fixture();
    const now = 1_700_000_000_000;
    seedPreV12Rows(db, now);

    const countsBefore: Record<string, number> = {};
    for (const t of ["pending_approvals", "action_log", "attention", "context_injections", "events"]) {
      countsBefore[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
    }

    applyMigrations(db);

    for (const t of ["pending_approvals", "action_log", "attention", "context_injections", "events"]) {
      const countAfter = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
      assert.equal(countAfter, countsBefore[t], `${t} row count must not change across the migration`);
    }

    const appr = db.prepare("SELECT * FROM pending_approvals WHERE id='appr-1'").get() as any;
    assert.equal(appr.command, "run tests");
    assert.equal(appr.exchange_id, null, "pre-existing row must NEVER be heuristically backfilled");

    const action = db.prepare("SELECT * FROM action_log WHERE idempotency_key='idem-1'").get() as any;
    assert.equal(action.name, "run_command");
    assert.equal(action.exchange_id, null);

    const attn = db.prepare("SELECT * FROM attention WHERE id='att-1'").get() as any;
    assert.equal(attn.message, "waiting at prompt");
    assert.equal(attn.exchange_id, null);

    const ctxInj = db.prepare("SELECT * FROM context_injections WHERE id='ctxevt-1'").get() as any;
    assert.equal(ctxInj.brief_hash, "brief-hash");
    assert.equal(ctxInj.exchange_id, null);

    const ev = db.prepare("SELECT * FROM events WHERE summary='legacy summary'").get() as any;
    assert.equal(ev.type, "command_outcome");
    assert.equal(ev.exchange_id, null);

    db.close();
  });

  it("the new exchange_id columns exist (schema-level), not just absent-and-tolerated", () => {
    const db = buildV11Fixture();
    seedPreV12Rows(db, 1_700_000_000_000);
    applyMigrations(db);
    for (const t of ["pending_approvals", "action_log", "attention", "context_injections", "events"]) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
      assert.ok(cols.includes("exchange_id"), `${t} must have an exchange_id column post-migration`);
    }
    db.close();
  });

  it("the three new tables exist post-migration, are empty, and are usable", () => {
    const db = buildV11Fixture();
    applyMigrations(db);

    for (const t of ["agent_exchanges", "exchange_events", "context_deliveries"]) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
      assert.equal(n, 0, `${t} must start empty on an upgraded DB`);
    }

    // Usable: a real insert against each new table succeeds post-migration.
    db.prepare(
      `INSERT INTO agent_exchanges(exchange_id,project_id,pane_id,created_at,updated_at)
       VALUES('exch_1','proj-1','pane-1',1,1)`
    ).run();
    db.prepare(
      `INSERT INTO exchange_events(exchange_id,event_type,ts) VALUES('exch_1','exchange_created',1)`
    ).run();
    db.prepare(
      `INSERT INTO context_deliveries(delivery_id,context_version,trigger,ts) VALUES('cd_1','v1','session_start',1)`
    ).run();

    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_exchanges").get() as any).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM exchange_events").get() as any).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM context_deliveries").get() as any).n, 1);
    db.close();
  });

  it("re-running applyMigrations on an already-v12 DB is a safe no-op", () => {
    const db = buildV11Fixture();
    seedPreV12Rows(db, 1_700_000_000_000);
    applyMigrations(db);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n;
    applyMigrations(db); // idempotent: user_version already at SCHEMA_VERSION, loop body never runs
    const after = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n;
    assert.equal(after, before);
    assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    db.close();
  });
});

describe("v11 -> v12 migration: fresh boot (no prior data) also lands on v12's tables (and beyond)", () => {
  it("a brand-new :memory: DB migrates straight through v12 (and on to the current SCHEMA_VERSION) with all v12 tables present", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    for (const t of ["agent_exchanges", "exchange_events", "context_deliveries"]) {
      assert.ok(names.includes(t));
    }
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// v12 -> v13 migration: opt-in transcripts table (bead 98f2, durable transcript sink).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const V12 = 12;

describe("v12 -> v13 migration: opt-in transcripts table", () => {
  it("bumps SCHEMA_VERSION to 13", () => {
    assert.equal(SCHEMA_VERSION, 13);
  });

  it("a v12-only DB (MIGRATIONS[0..11]) has NO transcripts table yet", () => {
    const db = new Database(":memory:");
    for (let i = 0; i < V12; i++) MIGRATIONS[i](db);
    db.pragma(`user_version = ${V12}`);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    assert.ok(!names.includes("transcripts"), "v12 fixture must NOT already have transcripts");
    db.close();
  });

  it("applyMigrations from v12 lands on v13 with a usable transcripts table", () => {
    const db = new Database(":memory:");
    for (let i = 0; i < V12; i++) MIGRATIONS[i](db);
    db.pragma(`user_version = ${V12}`);

    applyMigrations(db);
    assert.equal(db.pragma("user_version", { simple: true }), 13);
    assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);

    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    assert.ok(names.includes("transcripts"));

    const cols = (db.prepare("PRAGMA table_info(transcripts)").all() as any[]).map((c) => c.name);
    for (const c of ["id", "ts", "channel", "session_id", "project_id", "pane_id", "interaction_id", "text_redacted"]) {
      assert.ok(cols.includes(c), `transcripts must have column ${c}`);
    }

    const idxNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='transcripts'").all() as any[]).map((r) => r.name);
    assert.ok(idxNames.includes("idx_transcripts_ts"));
    assert.ok(idxNames.includes("idx_transcripts_session_ts"));

    db.prepare(
      `INSERT INTO transcripts(ts,channel,session_id,project_id,pane_id,interaction_id,text_redacted)
       VALUES(1,'operator','sess-1','proj-1','pane-1','ixn-1','hello')`
    ).run();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM transcripts").get() as any).n, 1);
    db.close();
  });

  it("a brand-new :memory: DB migrates straight to v13 with transcripts present", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    assert.equal(db.pragma("user_version", { simple: true }), 13);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    assert.ok(names.includes("transcripts"));
    db.close();
  });
});
