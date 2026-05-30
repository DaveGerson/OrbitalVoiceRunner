// src/store/sqliteStore.ts
import Database from "better-sqlite3";
import { applyMigrations } from "./schema";
import { EVENT_TYPES, type NewEvent, type StoredEvent } from "./eventTypes";
import type { StoredPane, StoredPendingApproval } from "./types";
import { pruneOnBoot, type PruneOpts } from "./retention";

export class JanusStore {
  readonly db: Database.Database;
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
  }
  init(): void { applyMigrations(this.db); }
  close(): void { this.db.close(); }

  /** Append `event` AND run `mutations(db)` in ONE transaction (parallel-write). */
  recordActivity(event: NewEvent, mutations?: (db: Database.Database) => void): void {
    const tx = this.db.transaction(() => {
      this.appendEventInTxn(event);
      if (mutations) mutations(this.db);
    });
    tx();
  }

  appendEvent(event: NewEvent): void { this.recordActivity(event); }

  private appendEventInTxn(event: NewEvent): void {
    this.db.prepare(
      `INSERT INTO events(ts,type,project_id,pane_id,session_id,summary,payload)
       VALUES(@ts,@type,@project_id,@pane_id,@session_id,@summary,@payload)`
    ).run({
      ts: event.ts ?? Date.now(),
      type: event.type,
      project_id: event.project_id ?? null,
      pane_id: event.pane_id ?? null,
      session_id: event.session_id ?? null,
      summary: event.summary ?? "",
      payload: JSON.stringify(event.payload ?? {}),
    });
  }

  getEvents(filter: { projectId?: string; paneId?: string; type?: string; limit?: number } = {}): StoredEvent[] {
    const where: string[] = []; const args: any[] = [];
    if (filter.projectId) { where.push("project_id = ?"); args.push(filter.projectId); }
    if (filter.paneId) { where.push("pane_id = ?"); args.push(filter.paneId); }
    if (filter.type) { where.push("type = ?"); args.push(filter.type); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const hasLimit = filter.limit !== undefined && filter.limit > 0;
    if (hasLimit) args.push(filter.limit);
    const rows = this.db.prepare(
      `SELECT * FROM events ${clause} ORDER BY id ASC${hasLimit ? " LIMIT ?" : ""}`
    ).all(...args) as any[];
    return rows.map(r => ({ ...r, payload: this.parseJSON(r.payload, {}) }));
  }

  protected parseJSON<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  // --- getWorkspaces minimal (full CRUD added in Task 5) ---
  getWorkspaces(): Record<string, any> {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at").all() as any[];
    const out: Record<string, any> = {};
    for (const r of rows) out[r.id] = { ...r, key_terms: this.parseJSON(r.key_terms, []) };
    return out;
  }

  saveWorkspace(ws: import("./types").StoredWorkspace): void {
    const now = Date.now();
    this.recordActivity(
      { type: EVENT_TYPES.PROJECT_CREATED, project_id: ws.id, summary: `project ${ws.name}` },
      (db) => db.prepare(
        `INSERT INTO projects(id,name,directory,summary,key_terms,created_at,updated_at)
         VALUES(@id,@name,@directory,@summary,@key_terms,@created_at,@updated_at)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, directory=excluded.directory,
           summary=excluded.summary, key_terms=excluded.key_terms, updated_at=excluded.updated_at`
      ).run({ ...ws, key_terms: JSON.stringify(ws.key_terms ?? []),
              created_at: ws.created_at || now, updated_at: now })
    );
  }

  addNote(projectId: string, text: string,
          opts: { paneId?: string; type?: import("./types").NoteType; author?: "janus"|"user" } = {}): import("./types").StoredNote {
    const now = Date.now();
    const id = `note_${now}_${Math.floor(this.rand() * 1e6)}`;
    const note: import("./types").StoredNote = {
      id, project_id: projectId, pane_id: opts.paneId ?? null, text,
      type: opts.type ?? "note", author: opts.author ?? "user", created_at: now, updated_at: now,
    };
    this.recordActivity(
      { type: EVENT_TYPES.NOTE_ADDED, project_id: projectId, pane_id: opts.paneId ?? null, summary: text.slice(0,120) },
      (db) => db.prepare(
        `INSERT INTO notes(id,project_id,pane_id,text,type,author,created_at,updated_at)
         VALUES(@id,@project_id,@pane_id,@text,@type,@author,@created_at,@updated_at)`
      ).run(note)
    );
    return note;
  }

  /** Pane-scoped note (Ledger API parity). */
  addPaneNote(projectId: string, paneId: string, text: string): import("./types").StoredNote {
    return this.addNote(projectId, text, { paneId });
  }

  amendNote(id: string, text: string): void {
    this.db.prepare("UPDATE notes SET text=?, updated_at=? WHERE id=?").run(text, Date.now(), id);
  }
  deleteNote(id: string): void {
    this.db.prepare("DELETE FROM notes WHERE id=?").run(id);
  }
  getNotes(filter: { projectId?: string; paneId?: string; type?: string } = {}): import("./types").StoredNote[] {
    const where: string[] = []; const args: any[] = [];
    if (filter.projectId) { where.push("project_id=?"); args.push(filter.projectId); }
    if (filter.paneId) { where.push("pane_id=?"); args.push(filter.paneId); }
    if (filter.type) { where.push("type=?"); args.push(filter.type); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT * FROM notes ${clause} ORDER BY created_at DESC`
    ).all(...args).map((r:any) => ({ ...r })) as any;
  }

  /** Full-text search across notes + events, ranked by bm25. */
  search(query: string, opts: { limit?: number } = {}): Array<{ source:"note"|"event"; id:string; snippet:string; rank:number }> {
    const limit = opts.limit ?? 25;
    const notes = this.db.prepare(
      `SELECT n.id AS id, n.text AS snippet, bm25(notes_fts) AS rank
       FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
       WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(query, limit) as any[];
    const events = this.db.prepare(
      `SELECT e.id AS id, e.summary AS snippet, bm25(events_fts) AS rank
       FROM events_fts JOIN events e ON e.id = events_fts.rowid
       WHERE events_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(query, limit) as any[];
    const merged = [
      ...notes.map(r => ({ source:"note" as const, id:String(r.id), snippet:r.snippet, rank:r.rank })),
      ...events.map(r => ({ source:"event" as const, id:String(r.id), snippet:r.snippet, rank:r.rank })),
    ].sort((a,b) => a.rank - b.rank);
    return merged.slice(0, limit);
  }

  /** Seam for deterministic IDs in tests. */
  protected rand(): number { return Math.random(); }

  insertPendingApproval(a: StoredPendingApproval): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO pending_approvals(id,session_id,workspace_id,pane_id,command,kind,rationale,claimed,timestamp,expires_at)
       VALUES(@id,@session_id,@workspace_id,@pane_id,@command,@kind,@rationale,@claimed,@timestamp,@expires_at)`
    ).run({ ...a, claimed: a.claimed?1:0, rationale: a.rationale ?? null });
  }
  /** Atomic claim: flips 0->1 only if currently 0. True == this caller won. */
  claimApproval(id: string): boolean {
    return this.db.prepare("UPDATE pending_approvals SET claimed=1 WHERE id=? AND claimed=0").run(id).changes === 1;
  }
  deletePendingApproval(id: string): void {
    this.db.prepare("DELETE FROM pending_approvals WHERE id=?").run(id);
  }
  getPendingApprovals(sessionId: string): StoredPendingApproval[] {
    return (this.db.prepare("SELECT * FROM pending_approvals WHERE session_id=? AND claimed=0 ORDER BY timestamp ASC").all(sessionId) as any[])
      .map(r => ({ ...r, claimed: Boolean(r.claimed) }));
  }
  getExpiredApprovals(now = Date.now()): StoredPendingApproval[] {
    return (this.db.prepare("SELECT * FROM pending_approvals WHERE claimed=0 AND expires_at<? ORDER BY expires_at ASC").all(now) as any[])
      .map(r => ({ ...r, claimed: Boolean(r.claimed) }));
  }

  upsertAttention(a: import("./types").StoredAttention): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO attention(id,type,terminal_id,project_id,message,timestamp,dismissed,details)
       VALUES(@id,@type,@terminal_id,@project_id,@message,@timestamp,@dismissed,@details)`
    ).run({ ...a, dismissed: a.dismissed?1:0, details: a.details ? JSON.stringify(a.details) : null });
  }
  dismissAttention(id: string): void { this.db.prepare("UPDATE attention SET dismissed=1 WHERE id=?").run(id); }
  clearAttention(): void { this.db.prepare("DELETE FROM attention").run(); }
  getAttention(opts: { includeDismissed?: boolean } = {}): import("./types").StoredAttention[] {
    const sql = opts.includeDismissed
      ? "SELECT * FROM attention ORDER BY timestamp DESC"
      : "SELECT * FROM attention WHERE dismissed=0 ORDER BY timestamp DESC";
    return (this.db.prepare(sql).all() as any[])
      .map(r => ({ ...r, dismissed: Boolean(r.dismissed), details: this.parseJSON(r.details, null) }));
  }

  getSettings(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings_kv WHERE key=?").get(key) as any;
    return r?.value ?? null;
  }
  saveSettings(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(key, value, Date.now());
  }
  getKV(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as any;
    return r?.value ?? null;
  }
  setKV(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(key, value, Date.now());
  }
  deleteKV(key: string): void { this.db.prepare("DELETE FROM kv WHERE key=?").run(key); }

  savePane(pane: StoredPane): void {
    const now = Date.now();
    this.recordActivity(
      { type: EVENT_TYPES.PANE_CREATED, project_id: pane.workspace_id, pane_id: pane.pane_id, summary: `pane ${pane.name}` },
      (db) => db.prepare(
        `INSERT INTO panes(pane_id,workspace_id,name,runtime_type,tool_preset,permissions_mode,
           session_id,last_known_state,is_busy,alive,context_size,last_status_change_at,
           last_command,scrollback_path,created_at,updated_at)
         VALUES(@pane_id,@workspace_id,@name,@runtime_type,@tool_preset,@permissions_mode,
           @session_id,@last_known_state,@is_busy,@alive,@context_size,@last_status_change_at,
           @last_command,@scrollback_path,@created_at,@updated_at)
         ON CONFLICT(pane_id,workspace_id) DO UPDATE SET name=excluded.name,
           runtime_type=excluded.runtime_type, tool_preset=excluded.tool_preset,
           permissions_mode=excluded.permissions_mode, session_id=excluded.session_id,
           last_known_state=excluded.last_known_state, is_busy=excluded.is_busy, alive=excluded.alive,
           context_size=excluded.context_size, last_status_change_at=excluded.last_status_change_at,
           last_command=excluded.last_command, scrollback_path=excluded.scrollback_path,
           updated_at=excluded.updated_at`
      ).run({ ...pane, is_busy: pane.is_busy?1:0, alive: pane.alive?1:0,
              created_at: pane.created_at || now, updated_at: now })
    );
  }

  getPanes(workspaceId: string): Record<string, StoredPane> {
    const rows = this.db.prepare("SELECT * FROM panes WHERE workspace_id=? ORDER BY created_at").all(workspaceId) as any[];
    const out: Record<string, StoredPane> = {};
    for (const r of rows) out[r.pane_id] = this.hydratePane(r);
    return out;
  }

  archivePane(paneId: string, workspaceId: string, reason?: string): void {
    this.recordActivity(
      { type: EVENT_TYPES.PANE_ARCHIVED, project_id: workspaceId, pane_id: paneId, summary: reason ?? "archived" },
      (db) => {
        const row = db.prepare("SELECT * FROM panes WHERE pane_id=? AND workspace_id=?").get(paneId, workspaceId) as any;
        if (!row) return;
        db.prepare(
          `INSERT OR REPLACE INTO panes_archive(pane_id,workspace_id,name,runtime_type,tool_preset,
             permissions_mode,session_id,last_known_state,is_busy,alive,context_size,last_status_change_at,
             last_command,scrollback_path,created_at,updated_at,archived_at,archive_reason)
           VALUES(@pane_id,@workspace_id,@name,@runtime_type,@tool_preset,@permissions_mode,@session_id,
             @last_known_state,@is_busy,@alive,@context_size,@last_status_change_at,@last_command,
             @scrollback_path,@created_at,@updated_at,@archived_at,@archive_reason)`
        ).run({ ...row, archived_at: Date.now(), archive_reason: reason ?? null });
        db.prepare("DELETE FROM panes WHERE pane_id=? AND workspace_id=?").run(paneId, workspaceId);
      }
    );
  }

  restorePane(paneId: string, workspaceId: string): StoredPane | null {
    const row = this.db.prepare(
      "SELECT * FROM panes_archive WHERE pane_id=? AND workspace_id=? ORDER BY archived_at DESC LIMIT 1"
    ).get(paneId, workspaceId) as any;
    if (!row) return null;
    const pane = { ...this.hydratePane(row), alive: false, last_known_state: "Exited" as const };
    this.recordActivity(
      { type: EVENT_TYPES.PANE_RESTORED, project_id: workspaceId, pane_id: paneId, summary: "restored" },
      (db) => db.prepare(
        `INSERT INTO panes(pane_id,workspace_id,name,runtime_type,tool_preset,permissions_mode,session_id,
           last_known_state,is_busy,alive,context_size,last_status_change_at,last_command,scrollback_path,
           created_at,updated_at)
         VALUES(@pane_id,@workspace_id,@name,@runtime_type,@tool_preset,@permissions_mode,@session_id,
           @last_known_state,@is_busy,@alive,@context_size,@last_status_change_at,@last_command,
           @scrollback_path,@created_at,@updated_at)
         ON CONFLICT(pane_id,workspace_id) DO UPDATE SET alive=excluded.alive,
           last_known_state=excluded.last_known_state, updated_at=excluded.updated_at`
      ).run({ ...pane, is_busy: 0, alive: 0, updated_at: Date.now() })
    );
    return pane;
  }

  listArchived(workspaceId: string): import("./types").StoredArchivedPane[] {
    const rows = this.db.prepare("SELECT * FROM panes_archive WHERE workspace_id=? ORDER BY archived_at DESC").all(workspaceId) as any[];
    return rows.map(r => ({ ...this.hydratePane(r), archived_at: r.archived_at, archive_reason: r.archive_reason ?? null }));
  }

  private hydratePane(r: any): StoredPane {
    return { ...r, is_busy: Boolean(r.is_busy), alive: Boolean(r.alive),
             last_status_change_at: r.last_status_change_at ?? null,
             last_command: r.last_command ?? null, scrollback_path: r.scrollback_path ?? null };
  }

  bootMaintenance(opts: PruneOpts): void {
    pruneOnBoot(this.db, opts);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ledger API parity shims (WS-M Task 13, Part B).
  //
  // These reproduce the OLD `Ledger` return shapes against SQLite so server.ts
  // call sites keep working when wired through this store. They are ADDITIVE —
  // nothing above is changed. Where the Ledger exposed a `Workspace` with
  // nested `panes: Record<string,PaneMeta>` and `notes: string[]`, these methods
  // project the relational tables back into that legacy shape.
  //
  // NOT covered here (intentionally): `plans`, `watchRules`, `archivedPanes` as
  // live mutable arrays, and `.save()`. There are no `plans`/`watch_rules`
  // tables in the schema, and server.ts mutates those arrays in place
  // (`.push`/`.splice`). Those must remain on the legacy Ledger. See the Part C
  // analysis in the task report.
  // ──────────────────────────────────────────────────────────────────────────

  /** Active project id, persisted in kv (Ledger.activeProjectId parity). */
  get activeProjectId(): string | null {
    return this.getKV("activeProjectId");
  }
  set activeProjectId(id: string | null) {
    if (id == null) this.deleteKV("activeProjectId");
    else this.setKV("activeProjectId", id);
  }

  /** Set the active project (Ledger.switchContext parity). Only switches if it exists. */
  switchContext(id: string): void {
    const exists = this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(id);
    if (exists) this.setKV("activeProjectId", id);
  }

  /** Project notes as a plain string[] (legacy Workspace.notes shape). */
  private projectNoteStrings(projectId: string): string[] {
    // Legacy notes were chronological; getNotes returns DESC, so reverse to ASC.
    return this.getNotes({ projectId }).filter(n => !n.pane_id).map(n => n.text).reverse();
  }

  /** Pane notes as a plain string[] (legacy PaneMeta.notes shape). */
  private paneNoteStrings(projectId: string, paneId: string): string[] {
    return this.getNotes({ projectId, paneId }).map(n => n.text).reverse();
  }

  /** Project a StoredPane into the legacy PaneMeta shape (with notes[]). */
  private toPaneMeta(p: StoredPane): import("../types").PaneMeta {
    return {
      pane_id: p.pane_id,
      name: p.name,
      alive: p.alive,
      last_command: p.last_command ?? undefined,
      last_known_state: p.last_known_state,
      notes: this.paneNoteStrings(p.workspace_id, p.pane_id),
      session_id: p.session_id,
      context_size: p.context_size,
      is_busy: p.is_busy,
      tool_preset: p.tool_preset,
      permissions_mode: p.permissions_mode,
      runtime_type: p.runtime_type,
    } as import("../types").PaneMeta;
  }

  /** A single project in the legacy Workspace shape, or null. */
  getProject(id: string): import("../types").Workspace | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as any;
    if (!r) return null;
    const panes: Record<string, import("../types").PaneMeta> = {};
    for (const [pid, sp] of Object.entries(this.getPanes(id))) {
      panes[pid] = this.toPaneMeta(sp);
    }
    return {
      id: r.id,
      name: r.name,
      directory: r.directory,
      summary: r.summary ?? "",
      notes: this.projectNoteStrings(id),
      panes,
      keyTerms: this.parseJSON(r.key_terms, [] as string[]),
    } as import("../types").Workspace;
  }

  /** The active project in legacy Workspace shape, or null. */
  getActiveProject(): import("../types").Workspace | null {
    const id = this.activeProjectId;
    return id ? this.getProject(id) : null;
  }

  /** All projects keyed by id, in legacy Workspace shape (read snapshot). */
  get workspaces(): Record<string, import("../types").Workspace> {
    const out: Record<string, import("../types").Workspace> = {};
    const ids = (this.db.prepare("SELECT id FROM projects ORDER BY created_at").all() as any[]).map(r => r.id);
    for (const id of ids) {
      const ws = this.getProject(id);
      if (ws) out[id] = ws;
    }
    return out;
  }

  /** Create a project if absent (Ledger.addProject parity). */
  addProject(id: string, directory: string, summary = "", keyTerms: string[] = []): void {
    const exists = this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(id);
    if (exists) return;
    const now = Date.now();
    this.saveWorkspace({ id, name: id, directory, summary, key_terms: keyTerms, created_at: now, updated_at: now });
  }

  /** Rename a project (Ledger.renameProject parity). */
  renameProject(id: string, name: string): void {
    this.db.prepare("UPDATE projects SET name=?, updated_at=? WHERE id=?").run(name, Date.now(), id);
  }

  /** Rename a pane (Ledger.renamePane parity). */
  renamePane(projectId: string, paneId: string, name: string): void {
    this.db.prepare("UPDATE panes SET name=?, updated_at=? WHERE pane_id=? AND workspace_id=?")
      .run(name, Date.now(), paneId, projectId);
  }

  /**
   * Project briefing in the exact legacy Ledger.getProjectBriefing shape, or null.
   * { project_id, summary, directory, panes: PaneMeta[], notes: string[], key_codebase_terms: string[] }
   */
  getProjectBriefing(id: string): {
    project_id: string; summary: string; directory: string;
    panes: import("../types").PaneMeta[]; notes: string[]; key_codebase_terms: string[];
  } | null {
    const ws = this.getProject(id);
    if (!ws) return null;
    return {
      project_id: ws.id,
      summary: ws.summary,
      directory: ws.directory,
      panes: Object.values(ws.panes),
      notes: ws.notes,
      key_codebase_terms: ws.keyTerms ?? [],
    };
  }
}