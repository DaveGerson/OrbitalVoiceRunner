// src/store/schema.ts
import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 8;

/** Ordered migrations. Index+1 == target user_version. Each runs once, in a txn. */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  // v1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        project_id TEXT,
        pane_id TEXT,
        session_id TEXT,
        summary TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_events_project_ts ON events(project_id, ts);
      CREATE INDEX idx_events_pane_ts    ON events(pane_id, ts);
      CREATE INDEX idx_events_type_ts    ON events(type, ts);

      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        directory TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        key_terms TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE panes (
        pane_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        runtime_type TEXT NOT NULL DEFAULT '',
        tool_preset TEXT NOT NULL DEFAULT 'Custom',
        permissions_mode TEXT NOT NULL DEFAULT 'Human-in-the-Loop',
        session_id TEXT NOT NULL DEFAULT '',
        last_known_state TEXT NOT NULL DEFAULT 'Idle',
        is_busy INTEGER NOT NULL DEFAULT 0,
        alive INTEGER NOT NULL DEFAULT 0,
        context_size INTEGER NOT NULL DEFAULT 0,
        last_status_change_at TEXT,
        last_command TEXT,
        scrollback_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (pane_id, workspace_id)
      );

      CREATE TABLE panes_archive (
        pane_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        runtime_type TEXT NOT NULL DEFAULT '',
        tool_preset TEXT NOT NULL DEFAULT 'Custom',
        permissions_mode TEXT NOT NULL DEFAULT 'Human-in-the-Loop',
        session_id TEXT NOT NULL DEFAULT '',
        last_known_state TEXT NOT NULL DEFAULT 'Exited',
        is_busy INTEGER NOT NULL DEFAULT 0,
        alive INTEGER NOT NULL DEFAULT 0,
        context_size INTEGER NOT NULL DEFAULT 0,
        last_status_change_at TEXT,
        last_command TEXT,
        scrollback_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL,
        archive_reason TEXT,
        PRIMARY KEY (pane_id, workspace_id, archived_at)
      );

      CREATE TABLE notes (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        pane_id TEXT,
        text TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'note',
        author TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_notes_project ON notes(project_id);
      CREATE INDEX idx_notes_pane    ON notes(pane_id);
      CREATE INDEX idx_notes_type    ON notes(type);

      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        pane_id TEXT NOT NULL,
        command TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'agent_instruction',
        rationale TEXT,
        claimed INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE attention (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0,
        details TEXT
      );

      CREATE TABLE settings_kv (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE kv (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE events_fts USING fts5(summary, payload, content='events', content_rowid='id');
      CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, summary, payload) VALUES (new.id, new.summary, new.payload);
      END;
      CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, summary, payload) VALUES('delete', old.id, old.summary, old.payload);
      END;
      CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, summary, payload) VALUES('delete', old.id, old.summary, old.payload);
        INSERT INTO events_fts(rowid, summary, payload) VALUES (new.id, new.summary, new.payload);
      END;

      CREATE VIRTUAL TABLE notes_fts USING fts5(text, content='notes', content_rowid='rowid');
      CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
  },
  // v2: first-class Handoff artifact (design §5.1). Dedicated mutable-state table +
  // indexed observability queries; events stays the append-only audit spine.
  (db) => {
    db.exec(`
      CREATE TABLE handoffs (
        id            TEXT PRIMARY KEY NOT NULL,
        workspace_id  TEXT NOT NULL,
        from_pane     TEXT,
        to_pane       TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'agent_instruction',
        composed_prompt TEXT NOT NULL DEFAULT '',
        source_context  TEXT NOT NULL DEFAULT '{}',
        source_context_refs TEXT NOT NULL DEFAULT '[]',
        state         TEXT NOT NULL DEFAULT 'composing',
        gate_approval_id TEXT,
        approved_by   TEXT,
        approved_via  TEXT,
        revision_count INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        staged_at     INTEGER,
        delivered_at  INTEGER,
        consumed_at   INTEGER,
        terminal_at   INTEGER,
        expires_at    INTEGER
      );
      CREATE INDEX idx_handoffs_ws_state      ON handoffs(workspace_id, state);
      CREATE INDEX idx_handoffs_state_expires ON handoffs(state, expires_at);
      CREATE INDEX idx_handoffs_to_pane       ON handoffs(to_pane);
      ALTER TABLE events ADD COLUMN handoff_id TEXT;
      CREATE INDEX idx_events_handoff ON events(handoff_id);
    `);
  },
  // v3: prompt-composer refactor parity (per-pane Workbench draft + layered context).
  // `draft` is a JSON-encoded PaneDraft ({text,updatedAt,updatedBy?}) or NULL.
  // model_context / human_context are JSON arrays of ContextEntry ({text,at,source?}),
  // defaulting to '[]'. All three are additive and nullable/defaulted, so existing
  // explicit-column pane INSERT/UPSERTs are unaffected.
  (db) => {
    db.exec(`
      ALTER TABLE panes ADD COLUMN draft TEXT;
      ALTER TABLE panes ADD COLUMN model_context TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE panes ADD COLUMN human_context TEXT NOT NULL DEFAULT '[]';
    `);
  },
  // v4 (bead 8sq): per-pane capability-gate OVERRIDE map. `capability_gates` is a JSON-encoded
  // CapabilityGateMap (Partial<Record<CapabilityGate,GateValue>>) or NULL (no override → falls
  // through to the global default). Until now per-pane gates set via the voice tool / matrix UI were
  // SILENTLY DROPPED on the next getProject() reconstruction (the SQLite default backend never
  // persisted the field) — this column closes that data-loss path. Additive + nullable, so existing
  // explicit-column pane INSERT/UPSERTs are unaffected (the upsert sets it explicitly going forward).
  (db) => {
    db.exec(`
      ALTER TABLE panes ADD COLUMN capability_gates TEXT;
      ALTER TABLE panes_archive ADD COLUMN capability_gates TEXT;
    `);
  },
  // v5 (bead wsm-e2e-pinned-kzt): durable deferred ACTIONS across a process restart. An Ask-tier
  // non-PTY mutator (create_pane / set_*_permissions / update_metadata) stages a side-effect closure
  // in PendingActionStore; that closure is non-serializable, so we persist the action's INTENT
  // (capability + JSON params) here and rebuild run() on boot via src/actionEffects.ts. Mirrors
  // pending_approvals (v1): `claimed` is the exactly-once gate (atomic UPDATE … WHERE claimed=0),
  // `expires_at` drives the boot/sweep prune. Purely additive (new table, no ALTER) — safe on an
  // already-migrated DB. NOTE: v4 above is #26's capability_gates column — left verbatim; this slots
  // at v5 so per-pane gate persistence is NOT clobbered.
  (db) => {
    db.exec(`
      CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY NOT NULL,
        capability TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        params TEXT NOT NULL DEFAULT '{}',
        claimed INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_pending_actions_expires ON pending_actions(claimed, expires_at);
    `);
  },
  // v6 (PLM2): unified ACTION LOG — one append-only row per runAction() invocation (the registry's
  // observability spine). `ts` is the store-stamped insert time (epoch ms). `args_redacted` is a
  // redaction-applied JSON string (nullable). `idempotency_key` is reserved for PLM4 replay-detection
  // and is indexed so a future exactly-once lookup is O(log n). Purely additive (new table, no ALTER)
  // — safe on an already-migrated DB. Distinct from the `events` audit spine: events tracks domain
  // state-changes; action_log tracks the registry-action call surface (name/capability/result/latency).
  (db) => {
    db.exec(`
      CREATE TABLE action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        name TEXT,
        capability TEXT,
        result_kind TEXT,
        ms INTEGER,
        args_redacted TEXT,
        surface TEXT,
        idempotency_key TEXT
      );
      CREATE INDEX idx_action_log_ts              ON action_log(ts);
      CREATE INDEX idx_action_log_name_ts         ON action_log(name, ts);
      CREATE INDEX idx_action_log_idempotency_key ON action_log(idempotency_key);
    `);
  },
  // v7: correlated interaction log — thread an interaction_id (one per operator TURN) onto every
  // action_log row so a runAction record joins back to the voice utterance that caused it (the SQLite
  // half of the interaction log; the JSONL half is src/interactionLog.ts). Additive ALTER — safe on an
  // already-migrated v6 DB (existing rows get NULL). Indexed so a "show me everything in turn X" join
  // stays O(log n).
  (db) => {
    db.exec(`
      ALTER TABLE action_log ADD COLUMN interaction_id TEXT;
      CREATE INDEX idx_action_log_interaction_id ON action_log(interaction_id);
    `);
  },
  // v8 (Phase 2 / 2S.3): panes_archive twins for the v3 panes columns. v3 added draft /
  // model_context / human_context to `panes` only, so the archive round-trip silently dropped an
  // operator's unsent draft and both context lanes (the columns didn't exist on panes_archive to
  // carry them). Additive ALTERs with the same defaults as v3 — safe on an already-migrated DB
  // (existing archive rows hydrate as no-draft / empty contexts).
  (db) => {
    db.exec(`
      ALTER TABLE panes_archive ADD COLUMN draft TEXT;
      ALTER TABLE panes_archive ADD COLUMN model_context TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE panes_archive ADD COLUMN human_context TEXT NOT NULL DEFAULT '[]';
    `);
  },
  // v9 (B-3 cortex measurement spine): two append-only observability tables that join
  // every cortex decision and each Gemini turn's token cost to the injection that caused
  // them.  `inject_id` is a per-injection key minted in injectMemoryBrief (Task 6).
  // `applied` distinguishes SHADOW (counterfactual, 0) from a future realized flip (1).
  // Purely additive (new tables + indexes only) — safe on an already-migrated DB.
  (db) => {
    db.exec(`
      CREATE TABLE cortex_decision (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        inject_id TEXT,
        session_id TEXT,
        active_pane_id TEXT,
        trigger TEXT,
        rule_fired TEXT,
        applied INTEGER NOT NULL DEFAULT 0,   -- 0 = SHADOW (counterfactual), 1 = applied (post-flip)
        trace_json TEXT NOT NULL
      );
      CREATE INDEX idx_cortex_decision_ts        ON cortex_decision(ts);
      CREATE INDEX idx_cortex_decision_inject_id ON cortex_decision(inject_id);

      CREATE TABLE gemini_turn_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT,
        inject_id TEXT,                        -- nearest preceding injection, by time
        prompt_tokens INTEGER,
        response_tokens INTEGER,
        total_tokens INTEGER
      );
      CREATE INDEX idx_gemini_turn_usage_ts        ON gemini_turn_usage(ts);
      CREATE INDEX idx_gemini_turn_usage_inject_id ON gemini_turn_usage(inject_id);
    `);
  },
];

/** Apply any migrations whose version is greater than the DB's current user_version. */
export function applyMigrations(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  let current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const run = db.transaction(() => {
      MIGRATIONS[i](db);
      db.pragma(`user_version = ${i + 1}`);
    });
    run();
  }
}
