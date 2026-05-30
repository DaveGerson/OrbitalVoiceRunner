/**
 * DRAFT SCAFFOLD — not wired into the app. better-sqlite3 is NOT yet a dependency;
 * do not import this from server.ts until the maintainer finalizes the schema (WS-M).
 *
 * This module is intentionally isolated: nothing in the main build imports it, so
 * the missing better-sqlite3 package does NOT cause build or type errors elsewhere.
 *
 * Purpose: propose a unified SQLite durable store that replaces the scattered JSON
 * files (.janus_ledger.json, .janus_settings.json, .janus_history.json) and stops
 * BUG-013/BUG-014 volatile-state loss on restart.
 *
 * Design principles:
 *   - Synchronous (better-sqlite3) — matches the existing ledger's synchronous
 *     atomic write model and avoids async-on-top-of-sync complexity.
 *   - Schema-first: every table is wrapped in a "PROPOSED" comment block because the
 *     maintainer must sign off before any migration runs (WS-M).
 *   - Minimal surface: methods map 1-to-1 to current Ledger / server.ts needs so the
 *     future wiring layer is a thin adapter, not a rewrite.
 *   - JSON-in-TEXT columns for blobs whose shape is still undecided (flexible, cheap
 *     to change before migration, queryable via json_extract if needed later).
 */

// @ts-ignore  better-sqlite3 is not yet installed (see WS-M in IMPLEMENTATION_PLAN.md).
// Replace this ignore with a real import once the dependency is added to package.json.
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Minimal local type shims so tsc --noEmit elsewhere is unaffected.
// (These are erased at runtime; they only satisfy the type-checker in this file.)
// ---------------------------------------------------------------------------

/** Minimal interface mirroring better-sqlite3's Statement for internal use. */
interface BetterSqliteStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Minimal interface mirroring a better-sqlite3 Database handle. */
interface BetterSqliteDB {
  prepare(sql: string): BetterSqliteStatement;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
  pragma(pragma: string, options?: { simple?: boolean }): unknown;
}

// ---------------------------------------------------------------------------
// Domain types (duplicated from src/types.ts so this file is self-contained
// and doesn't pull the real import graph before the schema is finalised)
// ---------------------------------------------------------------------------

export type PermissionsMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";
export type ToolPreset = "Claude Code" | "Codex" | "Antigravity" | "Custom";
export type PaneStatus = "Running" | "Idle" | "Exited";

export interface StoredWorkspace {
  id: string;
  name: string;
  directory: string;
  summary: string;
  key_terms: string[];           // JSON array in DB
  notes: string[];               // JSON array in DB — may migrate to rows (see open Q1)
  created_at: number;            // epoch ms
  updated_at: number;
}

export interface StoredPane {
  pane_id: string;
  workspace_id: string;
  name: string;
  runtime_type: string;
  tool_preset: ToolPreset;
  permissions_mode: PermissionsMode;
  session_id: string;
  last_known_state: PaneStatus;
  is_busy: boolean;
  alive: boolean;
  notes: string[];               // JSON array in DB
  context_size: number;
  last_status_change_at: string | null;   // ISO timestamp
  last_command: string | null;
  scrollback_path: string | null;         // path to the .janus_scrollback_*.log file on disk
  created_at: number;
  updated_at: number;
}

export interface StoredArchivedPane extends StoredPane {
  archived_at: number;
  archive_reason: string | null;
}

export interface StoredPendingApproval {
  id: string;                    // = messageId / call.id
  session_id: string;
  workspace_id: string;
  pane_id: string;
  command: string;
  rationale: string | null;      // JSON blob: { trigger?, summary }
  claimed: boolean;
  timestamp: number;
  expires_at: number;
}

export interface StoredHistoryEntry {
  id: number;                    // rowid alias
  workspace_id: string;
  pane_id: string;
  command: string;
  summary: string;
  exit_code: number | null;
  timestamp: number;
}

export interface KVRow {
  key: string;
  value: string;                 // TEXT — may be JSON-encoded
  updated_at: number;
}

// ---------------------------------------------------------------------------
// JanusStore
// ---------------------------------------------------------------------------

export class JanusStore {
  private db: BetterSqliteDB;

  /**
   * Open (or create) the SQLite database at dbPath.
   * Call `.init()` immediately after construction to apply the DDL.
   */
  constructor(dbPath: string) {
    // Cast through `any` because better-sqlite3 is not installed yet; the @ts-ignore
    // on the import handles the module-resolution error, but the constructor call
    // needs the same escape hatch during draft phase.
    this.db = new (Database as any)(dbPath) as BetterSqliteDB;
    this.db.pragma("journal_mode = WAL");   // safe concurrent reads; atomic writes
    this.db.pragma("foreign_keys = ON");
  }

  /**
   * Apply the proposed DDL.  Every CREATE TABLE statement is wrapped in a
   * "PROPOSED — pending maintainer review (WS-M)" comment so it is impossible
   * to miss which parts need sign-off before migration runs.
   *
   * Schema overview:
   *   projects          — workspaces (one row per project / workspace)
   *   panes             — live panes (one row per pane, keyed by pane_id + workspace_id)
   *   panes_archive     — soft-deleted / restored panes (same shape + archive metadata)
   *   history           — append-only command outcome log (replaces .janus_history.json)
   *   settings_kv       — flat key-value store for SystemSettings fields (replaces .janus_settings.json)
   *   pending_approvals — durable pending-approval queue (replaces in-memory pendingApprovals map)
   *   kv                — generic key-value escape hatch for volatile scalar state:
   *                       activeProjectId, promptBufferText, lastSessionResumptionToken, etc.
   */
  init(): void {
    this.db.exec(`
      /* ==========================================================================
         PROPOSED — pending maintainer review (WS-M)
         See docs/review/IMPLEMENTATION_PLAN.md §WS-M for open schema questions.
         ========================================================================== */

      /* ---- projects ------------------------------------------------------------ */
      /* PROPOSED — pending maintainer review (WS-M) */
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL DEFAULT '',
        directory   TEXT NOT NULL DEFAULT '',
        summary     TEXT NOT NULL DEFAULT '',
        key_terms   TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
        notes       TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings; see open Q1 re: normalising to rows
        created_at  INTEGER NOT NULL,            -- epoch ms
        updated_at  INTEGER NOT NULL
      );

      /* ---- panes --------------------------------------------------------------- */
      /* PROPOSED — pending maintainer review (WS-M) */
      CREATE TABLE IF NOT EXISTS panes (
        pane_id               TEXT NOT NULL,
        workspace_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name                  TEXT NOT NULL DEFAULT '',
        runtime_type          TEXT NOT NULL DEFAULT '',
        tool_preset           TEXT NOT NULL DEFAULT 'Custom',
        permissions_mode      TEXT NOT NULL DEFAULT 'Human-in-the-Loop',
        session_id            TEXT NOT NULL DEFAULT '',
        last_known_state      TEXT NOT NULL DEFAULT 'Idle',
        is_busy               INTEGER NOT NULL DEFAULT 0,  -- SQLite BOOLEAN: 0/1
        alive                 INTEGER NOT NULL DEFAULT 0,
        notes                 TEXT NOT NULL DEFAULT '[]',  -- JSON array; see open Q1
        context_size          INTEGER NOT NULL DEFAULT 0,
        last_status_change_at TEXT,                        -- ISO timestamp or NULL
        last_command          TEXT,
        scrollback_path       TEXT,  -- absolute path to .janus_scrollback_*.log; see open Q3
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        PRIMARY KEY (pane_id, workspace_id)
      );

      /* ---- panes_archive ------------------------------------------------------- */
      /* PROPOSED — pending maintainer review (WS-M) */
      CREATE TABLE IF NOT EXISTS panes_archive (
        pane_id               TEXT NOT NULL,
        workspace_id          TEXT NOT NULL,
        name                  TEXT NOT NULL DEFAULT '',
        runtime_type          TEXT NOT NULL DEFAULT '',
        tool_preset           TEXT NOT NULL DEFAULT 'Custom',
        permissions_mode      TEXT NOT NULL DEFAULT 'Human-in-the-Loop',
        session_id            TEXT NOT NULL DEFAULT '',
        last_known_state      TEXT NOT NULL DEFAULT 'Exited',
        is_busy               INTEGER NOT NULL DEFAULT 0,
        alive                 INTEGER NOT NULL DEFAULT 0,
        notes                 TEXT NOT NULL DEFAULT '[]',
        context_size          INTEGER NOT NULL DEFAULT 0,
        last_status_change_at TEXT,
        last_command          TEXT,
        scrollback_path       TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        archived_at           INTEGER NOT NULL,    -- epoch ms
        archive_reason        TEXT,
        PRIMARY KEY (pane_id, workspace_id, archived_at)  -- same pane can be archived multiple times
      );

      /* ---- history ------------------------------------------------------------- */
      /* PROPOSED — pending maintainer review (WS-M) */
      CREATE TABLE IF NOT EXISTS history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        pane_id      TEXT NOT NULL,
        command      TEXT NOT NULL DEFAULT '',
        summary      TEXT NOT NULL DEFAULT '',
        exit_code    INTEGER,          -- NULL means unknown / not captured
        timestamp    INTEGER NOT NULL  -- epoch ms
      );

      /* ---- settings_kv --------------------------------------------------------- */
      /* PROPOSED — pending maintainer review (WS-M)
         Stores the SystemSettings object as flat key-value rows.
         The key convention mirrors the dot-path in SystemSettings, e.g.
         "voiceAi.voice", "advanced.idleTimeoutMs", "secrets.geminiApiKey".
         JSON-encode non-scalar values. */
      CREATE TABLE IF NOT EXISTS settings_kv (
        key        TEXT PRIMARY KEY NOT NULL,
        value      TEXT NOT NULL,  -- TEXT or JSON-encoded
        updated_at INTEGER NOT NULL
      );

      /* ---- pending_approvals --------------------------------------------------- */
      /* PROPOSED — pending maintainer review (WS-M)
         Durable replacement for the in-memory pendingApprovals Record on server.ts:978.
         The claimed column implements the atomic-claim pattern from WS-F (N-1 race fix). */
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id          TEXT PRIMARY KEY NOT NULL,  -- = messageId / call.id
        session_id  TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        pane_id     TEXT NOT NULL,
        command     TEXT NOT NULL,
        rationale   TEXT,          -- JSON blob: { trigger?, summary } or NULL
        claimed     INTEGER NOT NULL DEFAULT 0,  -- 0=open, 1=claimed (atomic-claim gate)
        timestamp   INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );

      /* ---- kv ------------------------------------------------------------------ */
      /* PROPOSED — pending maintainer review (WS-M)
         Generic escape hatch for scalar volatile state that doesn't warrant its own table.
         Current candidates:
           "activeProjectId"            — TEXT
           "promptBufferText"           — TEXT (full, untruncated)
           "lastSessionResumptionToken" — TEXT (TTL enforced at read time by the caller)
         Add rows freely; this table never changes shape. */
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY NOT NULL,
        value      TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------------------------
  // Workspaces / Projects
  // ---------------------------------------------------------------------------

  /** Return all workspaces, keyed by id. */
  getWorkspaces(): Record<string, StoredWorkspace> {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY created_at`).all() as any[];
    const out: Record<string, StoredWorkspace> = {};
    for (const row of rows) {
      out[row.id] = this._hydrateWorkspace(row);
    }
    return out;
  }

  /** Upsert a workspace row. */
  saveWorkspace(ws: StoredWorkspace): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO projects (id, name, directory, summary, key_terms, notes, created_at, updated_at)
      VALUES (@id, @name, @directory, @summary, @key_terms, @notes, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        name       = excluded.name,
        directory  = excluded.directory,
        summary    = excluded.summary,
        key_terms  = excluded.key_terms,
        notes      = excluded.notes,
        updated_at = excluded.updated_at
    `).run({
      id: ws.id,
      name: ws.name,
      directory: ws.directory,
      summary: ws.summary,
      key_terms: JSON.stringify(ws.key_terms),
      notes: JSON.stringify(ws.notes),
      created_at: ws.created_at || now,
      updated_at: now,
    });
  }

  // ---------------------------------------------------------------------------
  // Panes
  // ---------------------------------------------------------------------------

  /** Return all live panes for a workspace, keyed by pane_id. */
  getPanes(workspaceId: string): Record<string, StoredPane> {
    const rows = this.db
      .prepare(`SELECT * FROM panes WHERE workspace_id = ? ORDER BY created_at`)
      .all(workspaceId) as any[];
    const out: Record<string, StoredPane> = {};
    for (const row of rows) {
      out[row.pane_id] = this._hydratePane(row);
    }
    return out;
  }

  /** Upsert a live pane row. */
  savePane(pane: StoredPane): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO panes (
        pane_id, workspace_id, name, runtime_type, tool_preset, permissions_mode,
        session_id, last_known_state, is_busy, alive, notes, context_size,
        last_status_change_at, last_command, scrollback_path, created_at, updated_at
      ) VALUES (
        @pane_id, @workspace_id, @name, @runtime_type, @tool_preset, @permissions_mode,
        @session_id, @last_known_state, @is_busy, @alive, @notes, @context_size,
        @last_status_change_at, @last_command, @scrollback_path, @created_at, @updated_at
      )
      ON CONFLICT(pane_id, workspace_id) DO UPDATE SET
        name                  = excluded.name,
        runtime_type          = excluded.runtime_type,
        tool_preset           = excluded.tool_preset,
        permissions_mode      = excluded.permissions_mode,
        session_id            = excluded.session_id,
        last_known_state      = excluded.last_known_state,
        is_busy               = excluded.is_busy,
        alive                 = excluded.alive,
        notes                 = excluded.notes,
        context_size          = excluded.context_size,
        last_status_change_at = excluded.last_status_change_at,
        last_command          = excluded.last_command,
        scrollback_path       = excluded.scrollback_path,
        updated_at            = excluded.updated_at
    `).run({
      ...pane,
      notes: JSON.stringify(pane.notes),
      is_busy: pane.is_busy ? 1 : 0,
      alive: pane.alive ? 1 : 0,
      created_at: pane.created_at || now,
      updated_at: now,
    });
  }

  /**
   * Move a live pane to panes_archive (soft-delete).
   * The original row in `panes` is deleted; a copy lands in `panes_archive`.
   */
  archivePane(paneId: string, workspaceId: string, reason?: string): void {
    const archiveOne = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM panes WHERE pane_id = ? AND workspace_id = ?`
      ).get(paneId, workspaceId) as any;
      if (!row) return;

      this.db.prepare(`
        INSERT OR REPLACE INTO panes_archive (
          pane_id, workspace_id, name, runtime_type, tool_preset, permissions_mode,
          session_id, last_known_state, is_busy, alive, notes, context_size,
          last_status_change_at, last_command, scrollback_path,
          created_at, updated_at, archived_at, archive_reason
        ) VALUES (
          @pane_id, @workspace_id, @name, @runtime_type, @tool_preset, @permissions_mode,
          @session_id, @last_known_state, @is_busy, @alive, @notes, @context_size,
          @last_status_change_at, @last_command, @scrollback_path,
          @created_at, @updated_at, @archived_at, @archive_reason
        )
      `).run({ ...row, archived_at: Date.now(), archive_reason: reason ?? null });

      this.db.prepare(
        `DELETE FROM panes WHERE pane_id = ? AND workspace_id = ?`
      ).run(paneId, workspaceId);
    });
    archiveOne();
  }

  /**
   * Restore the most-recently-archived snapshot of a pane back into `panes`.
   * The archive row is NOT deleted (history is preserved).
   */
  restorePane(paneId: string, workspaceId: string): StoredPane | null {
    const row = this.db.prepare(`
      SELECT * FROM panes_archive
      WHERE pane_id = ? AND workspace_id = ?
      ORDER BY archived_at DESC LIMIT 1
    `).get(paneId, workspaceId) as any;

    if (!row) return null;

    const pane = this._hydratePane(row);
    this.savePane({ ...pane, alive: false, last_known_state: "Exited", updated_at: Date.now() });
    return pane;
  }

  /** List all archived snapshots for a workspace (newest first). */
  listArchived(workspaceId: string): StoredArchivedPane[] {
    const rows = this.db.prepare(`
      SELECT * FROM panes_archive WHERE workspace_id = ? ORDER BY archived_at DESC
    `).all(workspaceId) as any[];
    return rows.map((r) => ({ ...this._hydratePane(r), archived_at: r.archived_at, archive_reason: r.archive_reason ?? null }));
  }

  // ---------------------------------------------------------------------------
  // Settings (flat KV)
  // ---------------------------------------------------------------------------

  /**
   * Read a settings value by dot-path key (e.g. "voiceAi.voice").
   * Returns null if the key does not exist.
   */
  getSettings(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings_kv WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  }

  /** Write (upsert) a settings value. */
  saveSettings(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings_kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  /** Append a command outcome entry. */
  appendHistory(entry: Omit<StoredHistoryEntry, "id">): void {
    this.db.prepare(`
      INSERT INTO history (workspace_id, pane_id, command, summary, exit_code, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.workspace_id,
      entry.pane_id,
      entry.command,
      entry.summary,
      entry.exit_code ?? null,
      entry.timestamp,
    );
  }

  /**
   * Retrieve recent history for a pane.
   * @param limit  defaults to 50; pass 0 for all (use sparingly)
   */
  getHistory(workspaceId: string, paneId: string, limit = 50): StoredHistoryEntry[] {
    const sql = limit > 0
      ? `SELECT * FROM history WHERE workspace_id = ? AND pane_id = ? ORDER BY timestamp DESC LIMIT ?`
      : `SELECT * FROM history WHERE workspace_id = ? AND pane_id = ? ORDER BY timestamp DESC`;
    const args = limit > 0 ? [workspaceId, paneId, limit] : [workspaceId, paneId];
    return this.db.prepare(sql).all(...args) as StoredHistoryEntry[];
  }

  // ---------------------------------------------------------------------------
  // Generic KV (volatile scalar state)
  // ---------------------------------------------------------------------------

  /** Read a KV entry.  Returns null if absent. */
  getKV(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  }

  /** Write (upsert) a KV entry. */
  setKV(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  /** Delete a KV entry (e.g., clear the resumption token after expiry). */
  deleteKV(key: string): void {
    this.db.prepare(`DELETE FROM kv WHERE key = ?`).run(key);
  }

  // ---------------------------------------------------------------------------
  // Pending Approvals (durable queue)
  // ---------------------------------------------------------------------------

  /** Insert a new pending-approval entry. */
  insertPendingApproval(entry: StoredPendingApproval): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO pending_approvals
        (id, session_id, workspace_id, pane_id, command, rationale, claimed, timestamp, expires_at)
      VALUES
        (@id, @session_id, @workspace_id, @pane_id, @command, @rationale, @claimed, @timestamp, @expires_at)
    `).run({
      ...entry,
      claimed: entry.claimed ? 1 : 0,
      rationale: entry.rationale ?? null,
    });
  }

  /**
   * Atomic claim: set claimed=1 only if it is currently 0.
   * Returns true if this caller won the claim (should proceed), false if already claimed.
   * This is the WS-F N-1 race-safety gate.
   */
  claimApproval(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE pending_approvals SET claimed = 1
      WHERE id = ? AND claimed = 0
    `).run(id);
    return (result as any).changes === 1;
  }

  /** Delete a pending approval (call after successful claim + dispatch or expiry). */
  deletePendingApproval(id: string): void {
    this.db.prepare(`DELETE FROM pending_approvals WHERE id = ?`).run(id);
  }

  /** Return all open (unclaimed) approvals for a session. */
  getPendingApprovals(sessionId: string): StoredPendingApproval[] {
    return this.db.prepare(`
      SELECT * FROM pending_approvals
      WHERE session_id = ? AND claimed = 0
      ORDER BY timestamp ASC
    `).all(sessionId) as StoredPendingApproval[];
  }

  /** Return all open approvals past their expires_at (for the TTL sweep). */
  getExpiredApprovals(now = Date.now()): StoredPendingApproval[] {
    return this.db.prepare(`
      SELECT * FROM pending_approvals
      WHERE claimed = 0 AND expires_at < ?
      ORDER BY expires_at ASC
    `).all(now) as StoredPendingApproval[];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Close the database connection (call on server shutdown). */
  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _hydrateWorkspace(row: any): StoredWorkspace {
    return {
      id: row.id,
      name: row.name,
      directory: row.directory,
      summary: row.summary,
      key_terms: this._parseJSON(row.key_terms, []),
      notes: this._parseJSON(row.notes, []),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private _hydratePane(row: any): StoredPane {
    return {
      pane_id: row.pane_id,
      workspace_id: row.workspace_id,
      name: row.name,
      runtime_type: row.runtime_type,
      tool_preset: row.tool_preset,
      permissions_mode: row.permissions_mode,
      session_id: row.session_id,
      last_known_state: row.last_known_state,
      is_busy: Boolean(row.is_busy),
      alive: Boolean(row.alive),
      notes: this._parseJSON(row.notes, []),
      context_size: row.context_size ?? 0,
      last_status_change_at: row.last_status_change_at ?? null,
      last_command: row.last_command ?? null,
      scrollback_path: row.scrollback_path ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private _parseJSON<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }
}

// ---------------------------------------------------------------------------
// Convenience KV keys (document the expected keys used by the server)
// ---------------------------------------------------------------------------

export const KV_KEYS = {
  /** The currently active project/workspace id (mirrors Ledger.activeProjectId). */
  ACTIVE_PROJECT_ID: "activeProjectId",
  /** Full text of the ambient voice-dictated prompt buffer (untruncated, replaces BUG-027 100-char limit). */
  PROMPT_BUFFER_TEXT: "promptBufferText",
  /** The Gemini Live session resumption token (TTL enforced by caller). */
  LAST_SESSION_RESUMPTION_TOKEN: "lastSessionResumptionToken",
} as const;
