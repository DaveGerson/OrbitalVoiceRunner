// src/store/schema.ts
import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 14;

/** Ordered migrations. Index+1 == target user_version. Each runs once, in a txn.
 *  Exported (not just `applyMigrations`) so tests can build a pre-migration fixture DB by
 *  running a PREFIX of this array directly (see tests/test_store_migration.ts) — the same
 *  technique `applyMigrations` itself uses, just index-bounded instead of full-length. */
export const MIGRATIONS: ((db: Database.Database) => void)[] = [
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
  // v10 (cortex context-injection telemetry, P0 first PR — 2026-07-02): one append-only row per
  // ATTEMPTED context injection (injected or skipped/failed), joining the v9 measurement spine
  // (cortex_decision, gemini_turn_usage) via the SAME `inject_id` — a three-way join on inject_id.
  // Unlike v9's tables, `inject_id` here is NOT an afterthought: it's recorded on every event that
  // reaches the mint (delta 18.1) and indexed accordingly. Purely additive (new table + indexes
  // only) — safe on an already-migrated DB. See docs/superpowers/specs/2026-07-02-cortex-context-
  // telemetry.md §7 and §18.1 for the design rationale.
  (db) => {
    db.exec(`
      CREATE TABLE context_injections (
        id TEXT PRIMARY KEY NOT NULL,
        ts INTEGER NOT NULL,
        session_id TEXT,
        interaction_id TEXT,
        inject_id TEXT,
        trigger TEXT NOT NULL,
        active_project_id TEXT,
        active_pane_id TEXT,
        brief_active_pane_id TEXT,
        source TEXT NOT NULL,
        disposition TEXT NOT NULL,
        skipped_reason TEXT,
        source_snapshot_hash TEXT,
        brief_hash TEXT,
        brief_chars INTEGER NOT NULL DEFAULT 0,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER,
        error TEXT
      );
      CREATE INDEX idx_context_injections_ts               ON context_injections(ts);
      CREATE INDEX idx_context_injections_session_ts        ON context_injections(session_id, ts);
      CREATE INDEX idx_context_injections_inject_id         ON context_injections(inject_id);
      CREATE INDEX idx_context_injections_active_pane_ts    ON context_injections(active_pane_id, ts);
      CREATE INDEX idx_context_injections_brief_hash        ON context_injections(brief_hash);
    `);
  },
  // v11 (hwu.4 — draft→knowledge promotion): a nullable `bead_status` marker on notes so a note
  // that was promoted toward a bead can be surfaced durably (proposed → created | denied). NULL for
  // every ordinary note (the overwhelming majority) — additive + nullable, so the explicit-column
  // addNote INSERT and the notes_fts triggers (which index `text` only) are unaffected. The live
  // Gemini path NEVER writes a bead; this column only records the OPERATOR-approved promotion state
  // set by the constrained promoter (src/beadPromoter.ts) and the note's proposal marker.
  //
  // Guarded on the notes table's existence so the migration stays robust in isolation (a bare db
  // fast-forwarded to a prior user_version without the v1 `notes` DDL). On any REAL db the notes table
  // was created in v1, so the column is always added on a fresh boot or a v10→v11 upgrade.
  (db) => {
    const hasNotes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='notes'"
    ).get();
    if (hasNotes) db.exec(`ALTER TABLE notes ADD COLUMN bead_status TEXT;`);
  },
  // v12 (AgentExchange spine, Phase 1 step 1.2 — spec 2026-07-09-agent-exchange-spine.md §6): the
  // communication-only exchange lifecycle. Purely additive: three new tables + nullable
  // `ALTER TABLE … ADD COLUMN exchange_id` correlation columns on five existing tables (the v2
  // `handoff_id` / v7 `interaction_id` precedent), so every existing explicit-column INSERT/UPSERT
  // is unaffected and every pre-existing row reads back unchanged with exchange_id = NULL. NO
  // historical correlation is ever backfilled — new columns stay NULL for pre-existing rows
  // forever; only a NEW exchange-service write (step 1.3+) ever populates them. Storage only here:
  // no lifecycle/state-machine code lands with this migration (that's src/exchanges/lifecycle.ts,
  // step 1.3). Terminal command history is file-backed (HistoryManager / .janus_history.json), NOT
  // SQLite, so it gets no DDL — its `exchange_id` correlation is an additive optional JSON field
  // (spec §6, "Where a column can't land").
  //
  // Each ALTER is guarded on its target table's existence (the v11 `hasNotes` idiom) — NOT because
  // a real upgrade path can ever be missing these tables (pending_approvals/events/action_log/
  // attention all predate v9, context_injections is v10, so on any real DB every one of them
  // exists long before v12 runs), but because a test fixture that bumps `user_version` directly
  // to isolate ONE later migration's bump-path (tests/test_context_telemetry_store.ts's "v9->v10"
  // case) legitimately skips the earlier tables' DDL. Guarding keeps this migration robust to that
  // pattern without weakening it for the real, full-chain upgrade it exists to serve.
  (db) => {
    const hasTable = (name: string): boolean =>
      !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    db.exec(`
      CREATE TABLE agent_exchanges (
        exchange_id            TEXT PRIMARY KEY NOT NULL,
        project_id             TEXT NOT NULL,
        pane_id                TEXT NOT NULL,
        voice_session_id       TEXT,
        interaction_id         TEXT,
        operator_utterance     TEXT NOT NULL DEFAULT '',
        distilled_instruction  TEXT NOT NULL DEFAULT '',
        instruction_envelope_json TEXT NOT NULL DEFAULT '{}',
        draft_version          INTEGER NOT NULL DEFAULT 1,
        context_version        TEXT,
        state                  TEXT NOT NULL DEFAULT 'draft',
        approval_id            TEXT,
        approval_draft_version INTEGER,
        delivery_attempt       INTEGER NOT NULL DEFAULT 0,
        terminal_state         TEXT,
        result_summary         TEXT,
        result_envelope_json   TEXT,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL,
        delivered_at           INTEGER,
        completed_at           INTEGER
      );
      CREATE INDEX idx_agent_exchanges_state         ON agent_exchanges(state);
      CREATE INDEX idx_agent_exchanges_pane_state    ON agent_exchanges(pane_id, state);
      CREATE INDEX idx_agent_exchanges_project_created ON agent_exchanges(project_id, created_at);
      CREATE INDEX idx_agent_exchanges_approval      ON agent_exchanges(approval_id);

      CREATE TABLE exchange_events (
        event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        exchange_id   TEXT NOT NULL,
        project_id    TEXT,
        pane_id       TEXT,
        event_type    TEXT NOT NULL,
        payload_redacted_json TEXT NOT NULL DEFAULT '{}',
        source        TEXT NOT NULL DEFAULT 'system',
        interaction_id TEXT,
        ts            INTEGER NOT NULL
      );
      CREATE INDEX idx_exchange_events_exchange_ts ON exchange_events(exchange_id, ts);
      CREATE INDEX idx_exchange_events_type_ts     ON exchange_events(event_type, ts);

      CREATE TABLE context_deliveries (
        delivery_id      TEXT PRIMARY KEY NOT NULL,
        project_id       TEXT,
        voice_session_id TEXT,
        context_version  TEXT NOT NULL,
        trigger          TEXT NOT NULL,
        snapshot_hash    TEXT,
        brief_hash       TEXT,
        included_sources_json TEXT NOT NULL DEFAULT '[]',
        dropped_sources_json  TEXT NOT NULL DEFAULT '[]',
        acknowledged_at  INTEGER,
        ts               INTEGER NOT NULL
      );
      CREATE INDEX idx_context_deliveries_session_ts ON context_deliveries(voice_session_id, ts);
      CREATE INDEX idx_context_deliveries_version    ON context_deliveries(context_version);
    `);
    if (hasTable("pending_approvals")) db.exec(`ALTER TABLE pending_approvals ADD COLUMN exchange_id TEXT;`);
    if (hasTable("action_log")) db.exec(`
      ALTER TABLE action_log ADD COLUMN exchange_id TEXT;
      CREATE INDEX idx_action_log_exchange_id ON action_log(exchange_id);
    `);
    if (hasTable("attention")) db.exec(`ALTER TABLE attention ADD COLUMN exchange_id TEXT;`);
    if (hasTable("context_injections")) db.exec(`ALTER TABLE context_injections ADD COLUMN exchange_id TEXT;`);
    if (hasTable("events")) db.exec(`
      ALTER TABLE events ADD COLUMN exchange_id TEXT;
      CREATE INDEX idx_events_exchange ON events(exchange_id);
    `);
  },
  // v13 (bead 98f2 — durable transcript sink): an OPT-IN, append-only table for BOTH voice channels
  // (operator ASR + Janus narration), fed from src/liveTranscripts.ts's extractTranscripts via
  // src/transcripts/sink.ts. Purely additive (new table only, no ALTER) — no existence guard is
  // needed (mirrors the v5/v6/v9/v10 additive-table migrations). Column named `text_redacted` (not
  // `text`) to encode the redaction-at-boundary contract explicitly: the caller (the sink) pre-
  // redacts via redactSecrets BEFORE calling recordTranscript — the store persists verbatim, the
  // exact same convention as exchange_events.payload_redacted_json. The sink itself is gated OFF by
  // default (JANUS_TRANSCRIPT_SINK, src/transcripts/flag.ts) — this migration applies unconditionally
  // (schema always advances), but no row is EVER written unless an operator opts in.
  (db) => {
    db.exec(`
      CREATE TABLE transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        channel TEXT NOT NULL,
        session_id TEXT,
        project_id TEXT,
        pane_id TEXT,
        interaction_id TEXT,
        text_redacted TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_transcripts_ts ON transcripts(ts);
      CREATE INDEX idx_transcripts_session_ts ON transcripts(session_id, ts);
    `);
  },
  // v14 (turn-arbiter program, Wave 4 — spec docs/superpowers/specs/2026-07-29-turn-arbiter-
  // design.md §5-T4): two append-only observability tables proving the arbiter's own steady-state
  // invariant. `jump_over` records ANY forced turn (turnComplete:true) landing mid-answer/mid-
  // utterance — post-arbiter this should be STRUCTURALLY ZERO; the row exists so the +14d watch
  // bead (mute-rate precedent) has real rows to read. `arbiter_drain` records every drain's shape
  // (`drain_size` === `1 + tail_count`) for the D2 headline+counted-tail distribution. Purely
  // additive (new tables + ts indexes only), same v9 gemini_turn_usage naming idiom.
  (db) => {
    db.exec(`
      CREATE TABLE jump_over (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT,
        producer TEXT,
        cls INTEGER,
        detail TEXT
      );
      CREATE INDEX idx_jump_over_ts ON jump_over(ts);

      CREATE TABLE arbiter_drain (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT,
        mode TEXT,
        headline_cls INTEGER,
        drain_size INTEGER NOT NULL,
        tail_count INTEGER NOT NULL
      );
      CREATE INDEX idx_arbiter_drain_ts ON arbiter_drain(ts);
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
