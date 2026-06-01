// src/store/schema.ts
import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 3;

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
