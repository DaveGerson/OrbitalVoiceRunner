// src/store/sqliteStore.ts
import Database from "better-sqlite3";
import { applyMigrations } from "./schema";
import { EVENT_TYPES, type NewEvent, type StoredEvent } from "./eventTypes";
import type { StoredPane, StoredPendingApproval, StoredPendingAction, StoredHandoff, HandoffState } from "./types";
import type {
  PaneRow, ArchivedPaneRow, ProjectRow, NoteRow, PendingApprovalRow, PendingActionRow,
  AttentionRow, HandoffRow, ValueRow, CountRow, IdRow, SearchHitRow,
} from "./types";
import { pruneOnBoot, pruneIncremental, type PruneOpts, type SweepOpts, type SweepResult } from "./retention";

/**
 * One persisted row of the unified ACTION LOG (schema v6, PLM2). Mirrors F1's ActionAuditRow call
 * shape (name/capability/result_kind/ms/args/surface) so runAction's ctx.audit seam can be wired
 * straight to recordAction() in server.ts. `ts` is store-stamped at insert; `id` is the autoincrement
 * PK. `idempotency_key` is reserved for PLM4 replay-detection (indexed, nullable).
 */
export interface ActionLogRow {
  id: number;
  ts: number;
  name: string | null;
  capability: string | null;
  result_kind: string | null;
  ms: number | null;
  args_redacted: string | null;
  surface: string | null;
  idempotency_key: string | null;
  interaction_id: string | null;
}

export class JanusStore {
  readonly db: Database.Database;
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // A corrupt/garbage DB typically throws HERE (SQLITE_NOTADB on the first header touch), AFTER
    // new Database() opened the OS file handle. Close that handle before rethrowing — otherwise
    // initStoreWithQuarantine's renameSync hits the still-open handle and fails EPERM/EBUSY on
    // Windows, leaving the quarantine path non-functional on the production platform.
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");
    } catch (e) {
      try { this.db.close(); } catch { /* best-effort — the throw below is the signal */ }
      throw e;
    }
  }
  init(): void { applyMigrations(this.db); }
  // Idempotent: better-sqlite3's db.close() is a no-op at the JS level on a second
  // call, but each call still schedules a libuv async-handle close. When TWO
  // in-process servers share this singleton store (e.g. two test suites that each
  // boot startServer() and call RunningServer.close()), the second close races the
  // first mid-teardown and the runner's --test-force-exit process.exit then aborts
  // (Assertion: !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c). Guarding on
  // db.open ensures the native handle is closed exactly once.
  close(): void { if (this.db.open) this.db.close(); }

  // ──────────────────────────────────────────────────────────────────────────
  // watchRules / plans — live, self-persisting arrays (Ledger parity).
  //
  // server.ts treats these as mutable arrays and does `.push`/`.splice`/`.find`
  // directly on the property. There is no relational table for them (they are
  // small, document-shaped config), so we back each with a kv-JSON blob and wrap
  // the in-memory array in a Proxy that re-serializes on any structural write.
  // The array IDENTITY is stable across reads, so a captured reference the server
  // mutates stays wired to persistence. In-place field edits on an *element*
  // (e.g. `plan.status = "done"`) bypass the array proxy — callers flush those
  // with persistPlans()/persistWatchRules(), mirroring how the legacy Ledger
  // required an explicit `.save()`. ──────────────────────────────────────────

  private _watchRules?: import("../types").WatchRule[];
  private _plans?: import("../types").Plan[];
  private _promptTemplates?: import("../types").PromptTemplate[];
  private _layouts?: import("../types").PaneLayout[];

  private loadJsonArray<T>(key: string): T[] {
    return this.parseJSON<T[]>(this.getKV(key), []);
  }

  /** Wrap an array so structural mutations (set/delete length, push, splice, …) persist. */
  private persistingArray<T>(key: string, backing: T[]): T[] {
    const flush = () => this.setKV(key, JSON.stringify(backing));
    return new Proxy(backing, {
      set: (target, prop, value) => { Reflect.set(target, prop, value); flush(); return true; },
      deleteProperty: (target, prop) => { Reflect.deleteProperty(target, prop); flush(); return true; },
    });
  }

  get watchRules(): import("../types").WatchRule[] {
    if (!this._watchRules) this._watchRules = this.persistingArray("watchRules", this.loadJsonArray("watchRules"));
    return this._watchRules;
  }
  get plans(): import("../types").Plan[] {
    if (!this._plans) this._plans = this.persistingArray("plans", this.loadJsonArray("plans"));
    return this._plans;
  }
  get promptTemplates(): import("../types").PromptTemplate[] {
    if (!this._promptTemplates) this._promptTemplates = this.persistingArray("promptTemplates", this.loadJsonArray("promptTemplates"));
    return this._promptTemplates;
  }
  get layouts(): import("../types").PaneLayout[] {
    if (!this._layouts) this._layouts = this.persistingArray("layouts", this.loadJsonArray("layouts"));
    return this._layouts;
  }

  /** Flush in-place element edits that the array Proxy can't observe. */
  persistWatchRules(): void { this.setKV("watchRules", JSON.stringify(this.watchRules)); }
  persistPlans(): void { this.setKV("plans", JSON.stringify(this.plans)); }
  persistPromptTemplates(): void { this.setKV("promptTemplates", JSON.stringify(this.promptTemplates)); }
  persistLayouts(): void { this.setKV("layouts", JSON.stringify(this.layouts)); }

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
      `INSERT INTO events(ts,type,project_id,pane_id,session_id,summary,payload,handoff_id)
       VALUES(@ts,@type,@project_id,@pane_id,@session_id,@summary,@payload,@handoff_id)`
    ).run({
      ts: event.ts ?? Date.now(),
      type: event.type,
      project_id: event.project_id ?? null,
      pane_id: event.pane_id ?? null,
      session_id: event.session_id ?? null,
      summary: event.summary ?? "",
      payload: JSON.stringify(event.payload ?? {}),
      handoff_id: event.handoff_id ?? null,
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
    ).all(...args) as StoredEvent[];
    return rows.map(r => ({ ...r, payload: this.parseJSON(r.payload, {}) }));
  }

  protected parseJSON<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  // --- getWorkspaces minimal (full CRUD added in Task 5) ---
  getWorkspaces(): Record<string, any> {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at").all() as ProjectRow[];
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

  /**
   * Persist a note (a first-class, FTS-indexed `notes` row) and return it so
   * callers can use its generated id. Returns null when the target project
   * (or, for a pane-scoped note, the target pane) does not exist — so the
   * server's `if (ok)` correctly reports "not found" rather than writing an
   * orphan row. Mirrors the legacy Ledger's add{Note,PaneNote} success signal.
   */
  addNote(projectId: string, text: string,
          opts: { paneId?: string; type?: import("./types").NoteType; author?: "janus"|"user" } = {}): import("./types").StoredNote | null {
    // Target must exist (no orphan notes). Pane-scoped notes need the pane;
    // project-scoped notes need the project.
    if (opts.paneId) {
      const pane = this.db.prepare("SELECT 1 FROM panes WHERE pane_id=? AND workspace_id=?").get(opts.paneId, projectId);
      if (!pane) return null;
    } else {
      const proj = this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId);
      if (!proj) return null;
    }
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

  /** Pane-scoped note (Ledger API parity). Null when the pane does not exist. */
  addPaneNote(projectId: string, paneId: string, text: string): import("./types").StoredNote | null {
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
    return (this.db.prepare(
      `SELECT * FROM notes ${clause} ORDER BY created_at DESC`
    ).all(...args) as NoteRow[]).map(r => ({ ...r }));
  }

  /** Full-text search across notes + events, ranked by bm25. Pass opts.source to restrict to one
   *  kind — the notes-recall voice tool passes 'note' so a flood of higher-ranked event rows can't
   *  starve note hits out of the result limit (each sub-query is itself capped at `limit`). */
  search(query: string, opts: { limit?: number; source?: "note" | "event" } = {}): Array<{ source:"note"|"event"; id:string; snippet:string; rank:number }> {
    const limit = opts.limit ?? 25;
    const notes = opts.source === "event" ? [] : this.db.prepare(
      `SELECT n.id AS id, n.text AS snippet, bm25(notes_fts) AS rank
       FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
       WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(query, limit) as SearchHitRow[];
    const events = opts.source === "note" ? [] : this.db.prepare(
      `SELECT e.id AS id, e.summary AS snippet, bm25(events_fts) AS rank
       FROM events_fts JOIN events e ON e.id = events_fts.rowid
       WHERE events_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(query, limit) as SearchHitRow[];
    const merged = [
      ...notes.map(r => ({ source:"note" as const, id:String(r.id), snippet:r.snippet, rank:r.rank })),
      ...events.map(r => ({ source:"event" as const, id:String(r.id), snippet:r.snippet, rank:r.rank })),
    ].sort((a,b) => a.rank - b.rank);
    return merged.slice(0, limit);
  }

  /** Seam for deterministic IDs in tests. */
  protected rand(): number { return Math.random(); }

  /**
   * wsm-e2e-pinned-4s2 (3): plain INSERT OR REPLACE would let a re-add of an existing messageId
   * (e.g. a stray retry, or a hydration re-insert racing a live claim) silently reset claimed=1
   * back to 0, re-opening an exactly-once row for a second write. ON CONFLICT DO UPDATE still
   * lets legitimate rewrites through (reattachSession() carries the row to a new session_id/
   * expires_at on reconnect), but the `claimed` column is STICKY: once 1, it can never be written
   * back to 0 by this path — only claimApproval()'s atomic UPDATE flips it, and deletePendingApproval
   * is the only way a claimed row goes away. `excluded.claimed` still applies when the existing row
   * is unclaimed, so a legitimate claimed:true insert (there is none today, but the seam stays
   * correct) is not silently downgraded either.
   */
  insertPendingApproval(a: StoredPendingApproval): void {
    this.db.prepare(
      `INSERT INTO pending_approvals(id,session_id,workspace_id,pane_id,command,kind,rationale,claimed,timestamp,expires_at)
       VALUES(@id,@session_id,@workspace_id,@pane_id,@command,@kind,@rationale,@claimed,@timestamp,@expires_at)
       ON CONFLICT(id) DO UPDATE SET
         session_id=excluded.session_id, workspace_id=excluded.workspace_id, pane_id=excluded.pane_id,
         command=excluded.command, kind=excluded.kind, rationale=excluded.rationale,
         timestamp=excluded.timestamp, expires_at=excluded.expires_at,
         claimed=CASE WHEN pending_approvals.claimed=1 THEN 1 ELSE excluded.claimed END`
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
    return (this.db.prepare("SELECT * FROM pending_approvals WHERE session_id=? AND claimed=0 ORDER BY timestamp ASC").all(sessionId) as PendingApprovalRow[])
      .map(r => this.hydrateApproval(r));
  }
  // wsm-e2e-pinned-4s2 (2): expires_at alone has no tiebreak — two rows staged in the same
  // millisecond (a real possibility for co-arriving approvals) would sort in undefined/storage
  // order, so hydration/reconnect ordering could vary run-to-run. `timestamp ASC, id ASC` gives a
  // fully deterministic total order (id is the PK, so it is always a unique final tiebreak).
  getExpiredApprovals(now = Date.now()): StoredPendingApproval[] {
    return (this.db.prepare("SELECT * FROM pending_approvals WHERE claimed=0 AND expires_at<? ORDER BY expires_at ASC, timestamp ASC, id ASC").all(now) as PendingApprovalRow[])
      .map(r => this.hydrateApproval(r));
  }

  // ── durable deferred actions (bead wsm-e2e-pinned-kzt, schema v5) ─────────────────────────────
  // Mirrors the pending_approvals seam: insert the INTENT, atomic-claim the exactly-once gate, delete
  // on resolve, hydrate un-claimed survivors on boot. PendingActionStore rebuilds run() via
  // src/actionEffects from `params`. INSERT OR REPLACE so a re-staged survivor (boot re-add) is a
  // harmless no-op rewrite.
  insertPendingAction(a: StoredPendingAction): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO pending_actions(id,capability,summary,params,claimed,timestamp,expires_at)
       VALUES(@id,@capability,@summary,@params,@claimed,@timestamp,@expires_at)`
    ).run({ ...a, claimed: a.claimed ? 1 : 0 });
  }
  /** Atomic claim: flips 0->1 only if currently 0. True == this caller won (exactly-once seam). */
  claimAction(id: string): boolean {
    return this.db.prepare("UPDATE pending_actions SET claimed=1 WHERE id=? AND claimed=0").run(id).changes === 1;
  }
  deletePendingAction(id: string): void {
    this.db.prepare("DELETE FROM pending_actions WHERE id=?").run(id);
  }
  /** Un-claimed survivors (the boot hydration set). Claimed-but-undeleted rows are excluded so a
   *  mid-resolve crash never re-replays. Ordered by timestamp ASC (== staging order). */
  getPendingActions(): StoredPendingAction[] {
    return (this.db.prepare("SELECT * FROM pending_actions WHERE claimed=0 ORDER BY timestamp ASC").all() as PendingActionRow[])
      .map(r => this.hydrateAction(r));
  }
  getExpiredActions(now = Date.now()): StoredPendingAction[] {
    return (this.db.prepare("SELECT * FROM pending_actions WHERE claimed=0 AND expires_at<? ORDER BY expires_at ASC").all(now) as PendingActionRow[])
      .map(r => this.hydrateAction(r));
  }
  /** Total pending_actions rows REGARDLESS of claimed/expiry — the boot-prune (bead 1qs) target
   *  surface. getPendingActions/getExpiredActions both filter claimed=0, so a leaked claimed=1 row
   *  is invisible to them; this counts the raw table for retention assertions/observability. */
  countPendingActions(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM pending_actions").get() as CountRow).n;
  }

  // ── unified action log (schema v6, PLM2) ────────────────────────────────────────────────────────
  // Append-only observability spine for the action registry: one row per runAction() invocation. `ts`
  // is store-stamped (epoch ms) at insert so callers never have to. server.ts will wire runAction's
  // ctx.audit seam (F1) to recordAction — keep the row shape compatible with F1's ActionAuditRow
  // (name/capability/result_kind/ms/args/surface). Mirrors the recordActivity/insertPendingAction style.

  /** Insert one action-log row, stamping `ts` with the current epoch ms (store-side). */
  recordAction(row: {
    name: string;
    capability: string;
    result_kind: string;
    ms: number;
    args_redacted?: string | null;
    surface?: string | null;
    idempotency_key?: string | null;
    interaction_id?: string | null;
  }): void {
    this.db.prepare(
      `INSERT INTO action_log(ts,name,capability,result_kind,ms,args_redacted,surface,idempotency_key,interaction_id)
       VALUES(@ts,@name,@capability,@result_kind,@ms,@args_redacted,@surface,@idempotency_key,@interaction_id)`
    ).run({
      ts: Date.now(),
      name: row.name,
      capability: row.capability,
      result_kind: row.result_kind,
      ms: row.ms,
      args_redacted: row.args_redacted ?? null,
      surface: row.surface ?? null,
      idempotency_key: row.idempotency_key ?? null,
      interaction_id: row.interaction_id ?? null,
    });
  }

  /**
   * PLM4 replay-detection: has this idempotency_key already produced a SUCCEEDED action-log row?
   * A row counts as succeeded when result_kind is anything OTHER than "error" (ok / pending / clarify
   * / blocked are all "this dispatch already ran" — re-running it would double-apply a side effect; a
   * prior "error" did NOT land a side effect, so a retry is allowed). Empty/undefined keys never match.
   * Backed by idx_action_log_idempotency_key (schema v6).
   */
  hasSucceededIdempotencyKey(key: string | null | undefined): boolean {
    if (!key) return false;
    const r = this.db.prepare(
      `SELECT 1 FROM action_log
        WHERE idempotency_key = ? AND (result_kind IS NULL OR result_kind <> 'error')
        LIMIT 1`
    ).get(key);
    return r !== undefined;
  }

  /** Read the action log most-recent-first. Optional name filter + `since` (ts >= since). Default limit 100. */
  getActionLog(filter: { limit?: number; name?: string; since?: number } = {}): ActionLogRow[] {
    const where: string[] = []; const args: any[] = [];
    if (filter.name) { where.push("name = ?"); args.push(filter.name); }
    if (filter.since !== undefined) { where.push("ts >= ?"); args.push(filter.since); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit !== undefined && filter.limit > 0 ? filter.limit : 100;
    args.push(limit);
    return this.db.prepare(
      `SELECT * FROM action_log ${clause} ORDER BY id DESC LIMIT ?`
    ).all(...args) as ActionLogRow[];
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
    return (this.db.prepare(sql).all() as AttentionRow[])
      .map(r => this.hydrateAttention(r));
  }

  getSettings(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings_kv WHERE key=?").get(key) as ValueRow | undefined;
    return r?.value ?? null;
  }
  saveSettings(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(key, value, Date.now());
  }
  getKV(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as ValueRow | undefined;
    return r?.value ?? null;
  }
  setKV(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(key, value, Date.now());
  }
  deleteKV(key: string): void { this.db.prepare("DELETE FROM kv WHERE key=?").run(key); }

  savePane(pane: StoredPane): void {
    const now = Date.now();
    const upsert = (db: Database.Database) => db.prepare(
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
            created_at: pane.created_at || now, updated_at: now });
    // 4E.3a: PANE_CREATED fires ONLY on a genuine first insert. This method used to emit
    // it (+ an events_fts row) unconditionally per call — and listPanes()→syncLedger()→
    // updatePane→savePane runs per voice turn, so the events table filled with bogus
    // 'created' spam. The existence pre-check and the event+insert run in ONE transaction
    // (recordActivity nests as a savepoint), so the audit semantics for real creations —
    // from every path that lands here — are unchanged and atomic.
    const tx = this.db.transaction(() => {
      const exists = this.db.prepare(
        "SELECT 1 FROM panes WHERE pane_id=? AND workspace_id=?"
      ).get(pane.pane_id, pane.workspace_id);
      if (exists) {
        upsert(this.db);
      } else {
        this.recordActivity(
          { type: EVENT_TYPES.PANE_CREATED, project_id: pane.workspace_id, pane_id: pane.pane_id, summary: `pane ${pane.name}` },
          upsert
        );
      }
    });
    tx();
  }

  getPanes(workspaceId: string): Record<string, StoredPane> {
    const rows = this.db.prepare("SELECT * FROM panes WHERE workspace_id=? ORDER BY created_at").all(workspaceId) as PaneRow[];
    const out: Record<string, StoredPane> = {};
    for (const r of rows) out[r.pane_id] = this.hydratePane(r);
    return out;
  }

  archivePane(paneId: string, workspaceId: string, reason?: string): void {
    this.recordActivity(
      { type: EVENT_TYPES.PANE_ARCHIVED, project_id: workspaceId, pane_id: paneId, summary: reason ?? "archived" },
      (db) => {
        const row = db.prepare("SELECT * FROM panes WHERE pane_id=? AND workspace_id=?").get(paneId, workspaceId) as PaneRow | undefined;
        if (!row) return;
        // 2S.3: capability_gates (schema v4) and the v3 columns (draft / model_context /
        // human_context, archive twins added in v8) must be LISTED here — better-sqlite3 silently
        // ignores extra named params, so the v1-only column list dropped them all to NULL/default
        // and an operator's "Off" override (and unsent draft) silently reverted through the
        // archive round-trip.
        db.prepare(
          `INSERT OR REPLACE INTO panes_archive(pane_id,workspace_id,name,runtime_type,tool_preset,
             permissions_mode,session_id,last_known_state,is_busy,alive,context_size,last_status_change_at,
             last_command,scrollback_path,created_at,updated_at,archived_at,archive_reason,capability_gates,
             draft,model_context,human_context)
           VALUES(@pane_id,@workspace_id,@name,@runtime_type,@tool_preset,@permissions_mode,@session_id,
             @last_known_state,@is_busy,@alive,@context_size,@last_status_change_at,@last_command,
             @scrollback_path,@created_at,@updated_at,@archived_at,@archive_reason,@capability_gates,
             @draft,@model_context,@human_context)`
        ).run({
          ...row,
          capability_gates: row.capability_gates ?? null,
          draft: row.draft ?? null,
          model_context: row.model_context ?? "[]",
          human_context: row.human_context ?? "[]",
          archived_at: Date.now(),
          archive_reason: reason ?? null,
        });
        db.prepare("DELETE FROM panes WHERE pane_id=? AND workspace_id=?").run(paneId, workspaceId);
      }
    );
  }

  restorePane(paneId: string, workspaceId: string): StoredPane | null {
    const row = this.db.prepare(
      "SELECT * FROM panes_archive WHERE pane_id=? AND workspace_id=? ORDER BY archived_at DESC LIMIT 1"
    ).get(paneId, workspaceId) as ArchivedPaneRow | undefined;
    if (!row) return null;
    const pane = { ...this.hydratePane(row), alive: false, last_known_state: "Exited" as const };
    this.recordActivity(
      { type: EVENT_TYPES.PANE_RESTORED, project_id: workspaceId, pane_id: paneId, summary: "restored" },
      // 2S.3: capability_gates AND the v3/v8 columns (draft, model_context, human_context) must be
      // LISTED here too (see archivePane) so the restored live row carries the archived per-pane
      // override, unsent draft, and both context lanes instead of silently reverting to defaults.
      // (hydratePane leaves these as raw TEXT from the row, so they bind directly.)
      (db) => db.prepare(
        `INSERT INTO panes(pane_id,workspace_id,name,runtime_type,tool_preset,permissions_mode,session_id,
           last_known_state,is_busy,alive,context_size,last_status_change_at,last_command,scrollback_path,
           created_at,updated_at,capability_gates,draft,model_context,human_context)
         VALUES(@pane_id,@workspace_id,@name,@runtime_type,@tool_preset,@permissions_mode,@session_id,
           @last_known_state,@is_busy,@alive,@context_size,@last_status_change_at,@last_command,
           @scrollback_path,@created_at,@updated_at,@capability_gates,@draft,@model_context,@human_context)
         ON CONFLICT(pane_id,workspace_id) DO UPDATE SET alive=excluded.alive,
           last_known_state=excluded.last_known_state, updated_at=excluded.updated_at`
      ).run({
        ...pane,
        // Read the raw TEXT extras off the typed archive `row` (hydratePane carries them through on
        // the runtime object, but they are not declared on StoredPane — so the row is the typed source).
        capability_gates: row.capability_gates ?? null,
        draft: row.draft ?? null,
        model_context: row.model_context ?? "[]",
        human_context: row.human_context ?? "[]",
        is_busy: 0, alive: 0, updated_at: Date.now(),
      })
    );
    return pane;
  }

  /**
   * Archived panes in the legacy `ArchivedPane[]` shape ({pane, project_id,
   * archived_at}) the server consumes. Pass a workspaceId to scope to one project,
   * or omit for all projects (Ledger.listArchived() parity). `archived_at` is an
   * ISO string to match the legacy shape.
   */
  listArchived(workspaceId?: string): import("../ledger").ArchivedPane[] {
    const rows = workspaceId
      ? this.db.prepare("SELECT * FROM panes_archive WHERE workspace_id=? ORDER BY archived_at DESC").all(workspaceId) as ArchivedPaneRow[]
      : this.db.prepare("SELECT * FROM panes_archive ORDER BY archived_at DESC").all() as ArchivedPaneRow[];
    return rows.map(r => ({
      pane: this.toPaneMeta(this.hydratePane(r)),
      project_id: r.workspace_id,
      archived_at: new Date(r.archived_at).toISOString(),
    }));
  }

  // ── Archive aliases matching the legacy Ledger signatures server.ts calls ───

  /** PHASE 1 (deferrable-toggle honesty): backend-agnostic single-pane archive (LedgerLike parity).
   *  Bridges the legacy (projectId, paneId) order to JanusStore's internal archivePane(paneId,
   *  workspaceId). Truthy-on-success: false when the pane row is already gone (so the archive_pane
   *  action narrates "already gone" without a spurious broadcast). */
  archivePaneOwned(projectId: string, paneId: string): boolean {
    const exists = !!(this.db.prepare("SELECT 1 FROM panes WHERE pane_id=? AND workspace_id=?").get(paneId, projectId));
    if (!exists) return false;
    this.archivePane(paneId, projectId, "archived");
    return true;
  }

  /** Archive every non-alive pane (optionally in one project). Returns the count. */
  archiveExitedPanes(projectId?: string): number {
    const projectIds = projectId
      ? [projectId]
      : (this.db.prepare("SELECT id FROM projects").all() as IdRow[]).map(r => r.id);
    let count = 0;
    for (const pId of projectIds) {
      for (const [paneId, sp] of Object.entries(this.getPanes(pId))) {
        if (!sp.alive) { this.archivePane(paneId, pId, "exited"); count++; }
      }
    }
    return count;
  }

  /** Restore an archived pane by id alone (Ledger parity). Returns the legacy entry or null. */
  restoreArchivedPane(paneId: string): import("../ledger").ArchivedPane | null {
    const row = this.db.prepare(
      "SELECT * FROM panes_archive WHERE pane_id=? ORDER BY archived_at DESC LIMIT 1"
    ).get(paneId) as ArchivedPaneRow | undefined;
    if (!row) return null;
    const entry: import("../ledger").ArchivedPane = {
      pane: this.toPaneMeta(this.hydratePane(row)),
      project_id: row.workspace_id,
      archived_at: new Date(row.archived_at).toISOString(),
    };
    // Legacy-Ledger parity (src/ledger.ts:440-443): recreate the destination project if it has since
    // been removed. panes_archive deliberately carries NO FK (the record survives a project delete),
    // but panes.workspace_id REFERENCES projects(id) with foreign_keys=ON — without this guard the
    // re-insert below would throw where the legacy backend quietly recreates "Restored workspace".
    // Known degraded path: the original project directory is gone, so a restore into a since-deleted
    // project lands the pane in the server cwd (process.cwd()) rather than its real working directory.
    this.addProject(row.workspace_id, process.cwd(), "Restored workspace");
    this.restorePane(paneId, row.workspace_id);
    this.db.prepare("DELETE FROM panes_archive WHERE pane_id=? AND workspace_id=?").run(paneId, row.workspace_id);
    return entry;
  }

  /** Permanently remove an archived pane by id. Returns true if it existed. */
  deleteArchivedPane(paneId: string): boolean {
    const res = this.db.prepare("DELETE FROM panes_archive WHERE pane_id=?").run(paneId);
    return res.changes > 0;
  }

  private hydratePane(r: PaneRow): StoredPane {
    // The TEXT enum columns are stored as plain strings; the schema's CHECK-less defaults mean only
    // valid values are ever written, so narrowing them back to their unions here reproduces what the
    // prior `as any` cast did implicitly — without re-opening the unsafe cast.
    return { ...r,
             tool_preset: r.tool_preset as StoredPane["tool_preset"],
             permissions_mode: r.permissions_mode as StoredPane["permissions_mode"],
             last_known_state: r.last_known_state as StoredPane["last_known_state"],
             is_busy: Boolean(r.is_busy), alive: Boolean(r.alive),
             last_status_change_at: r.last_status_change_at ?? null,
             last_command: r.last_command ?? null, scrollback_path: r.scrollback_path ?? null };
  }

  // Peer hydrators (bead dbt-typing) mirroring hydratePane / hydrateHandoff: map a raw SQLite Row to its
  // Stored shape, coercing the INTEGER boolean columns (0|1) to real booleans and parsing JSON TEXT.
  // Behaviour-identical to the prior inline `.map(r => ({ ...r, claimed: Boolean(r.claimed) }))`.
  private hydrateApproval(r: PendingApprovalRow): StoredPendingApproval {
    return { ...r, kind: r.kind as StoredPendingApproval["kind"], claimed: Boolean(r.claimed) };
  }
  private hydrateAction(r: PendingActionRow): StoredPendingAction {
    return { ...r, claimed: Boolean(r.claimed) };
  }
  private hydrateAttention(r: AttentionRow): import("./types").StoredAttention {
    return { ...r, dismissed: Boolean(r.dismissed), details: this.parseJSON(r.details, null) };
  }

  bootMaintenance(opts: PruneOpts): void {
    pruneOnBoot(this.db, opts);
  }

  /**
   * 4E.3b: one tick of the PERIODIC retention sweep (armed in server.ts on an unref'd
   * JANUS_RETENTION_SWEEP_MS interval). Batched deletes — see pruneIncremental. Guarded
   * on db.open: the unref'd timer can fire during process teardown after the
   * process-exit handler closed the shared store.
   */
  sweepMaintenance(opts: SweepOpts): SweepResult {
    if (!this.db.open) return { deleted: {}, more: false };
    return pruneIncremental(this.db, opts);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Per-pane Workbench draft (prompt-composer refactor step 6). The draft is a
  // proposed-but-unsent prompt; composing it is never a CLI write. Stored as a
  // JSON-encoded PaneDraft in panes.draft so it survives restart and pane switch.
  // Semantics mirror src/ledger.ts exactly. ──────────────────────────────────

  getDraft(projectId: string, paneId: string): import("../types").PaneDraft | null {
    const r = this.db.prepare(
      "SELECT draft FROM panes WHERE pane_id=? AND workspace_id=?"
    ).get(paneId, projectId) as { draft: string | null } | undefined;
    if (!r) return null;
    return this.parseJSON<import("../types").PaneDraft | null>(r.draft, null);
  }

  setDraft(projectId: string, paneId: string, text: string, updatedBy?: "janus" | "operator"): boolean {
    const draft: import("../types").PaneDraft = {
      text, updatedAt: new Date().toISOString(), ...(updatedBy ? { updatedBy } : {}),
    };
    const res = this.db.prepare(
      "UPDATE panes SET draft=?, updated_at=? WHERE pane_id=? AND workspace_id=?"
    ).run(JSON.stringify(draft), Date.now(), paneId, projectId);
    return res.changes === 1;
  }

  appendDraft(projectId: string, paneId: string, text: string, updatedBy?: "janus" | "operator"): boolean {
    const prev = this.getDraft(projectId, paneId);
    if (prev === null) {
      // Distinguish "no draft yet" (still a real pane) from "no such pane".
      const exists = this.db.prepare(
        "SELECT 1 FROM panes WHERE pane_id=? AND workspace_id=?"
      ).get(paneId, projectId);
      if (!exists) return false;
    }
    const prevText = prev?.text ?? "";
    const next = prevText ? `${prevText}\n${text}` : text;
    return this.setDraft(projectId, paneId, next, updatedBy);
  }

  /** Every pane in a project with a non-empty (trimmed) draft — the WIP register. */
  listDrafts(projectId: string): { paneId: string; draft: import("../types").PaneDraft }[] {
    const rows = this.db.prepare(
      "SELECT pane_id, draft FROM panes WHERE workspace_id=? AND draft IS NOT NULL ORDER BY created_at"
    ).all(projectId) as { pane_id: string; draft: string | null }[];
    const out: { paneId: string; draft: import("../types").PaneDraft }[] = [];
    for (const r of rows) {
      const draft = this.parseJSON<import("../types").PaneDraft | null>(r.draft, null);
      if (draft && draft.text.trim().length > 0) out.push({ paneId: r.pane_id, draft });
    }
    return out;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Layered per-pane context (prompt-composer refactor §4). `model_context` is
  // machine-maintained orientation (Janus / synthesizer / handoff); `human_context`
  // is operator steering. Both are JSON arrays of ContextEntry; writing context is
  // never a CLI write. Semantics mirror src/ledger.ts. ────────────────────────

  private appendContext(
    column: "model_context" | "human_context",
    projectId: string,
    paneId: string,
    text: string,
    source?: string,
  ): boolean {
    const r = this.db.prepare(
      `SELECT ${column} AS ctx FROM panes WHERE pane_id=? AND workspace_id=?`
    ).get(paneId, projectId) as { ctx: string | null } | undefined;
    if (!r) return false;
    const entries = this.parseJSON<import("../types").ContextEntry[]>(r.ctx, []);
    const entry: import("../types").ContextEntry = { text, at: new Date().toISOString(), ...(source ? { source } : {}) };
    entries.push(entry);
    this.db.prepare(
      `UPDATE panes SET ${column}=?, updated_at=? WHERE pane_id=? AND workspace_id=?`
    ).run(JSON.stringify(entries), Date.now(), paneId, projectId);
    return true;
  }

  addModelContext(projectId: string, paneId: string, text: string, source?: string): boolean {
    return this.appendContext("model_context", projectId, paneId, text, source);
  }

  addHumanContext(projectId: string, paneId: string, text: string): boolean {
    return this.appendContext("human_context", projectId, paneId, text);
  }

  /** Unified read of a pane's orientation context across all layers. `legacy`
   *  surfaces pre-refactor flat pane notes so nothing is lost on migration. */
  getPaneContext(projectId: string, paneId: string): {
    model: import("../types").ContextEntry[];
    human: import("../types").ContextEntry[];
    legacy: string[];
  } | null {
    const r = this.db.prepare(
      "SELECT model_context, human_context FROM panes WHERE pane_id=? AND workspace_id=?"
    ).get(paneId, projectId) as { model_context: string | null; human_context: string | null } | undefined;
    if (!r) return null;
    return {
      model: this.parseJSON<import("../types").ContextEntry[]>(r.model_context, []),
      human: this.parseJSON<import("../types").ContextEntry[]>(r.human_context, []),
      legacy: this.paneNoteStrings(projectId, paneId),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Manager-facing Ledger methods (OrchestratorManager calls these directly).

  /** No-op: the store persists on every mutation (WAL), so there is no batched
   *  flush to force. Present so manager code written against Ledger.save() works. */
  save(_immediate?: boolean): void { /* auto-persisted per mutation */ }

  // PaneMeta -> StoredPane string/number fields with their `?? <default>` fallback, driven off a table
  // so paneMetaFromMeta stays under CC 10 while reproducing the prior per-field defaults verbatim.
  // (Booleans use `!!` and the constants are handled separately below — see paneMetaToStoredPane.)
  private static readonly PANE_META_DEFAULTS: ReadonlyArray<readonly [keyof StoredPane, string | number | null]> = [
    ["name", ""], ["runtime_type", ""], ["tool_preset", "Custom"],
    ["permissions_mode", "Human-in-the-Loop"], ["session_id", ""], ["last_known_state", "Idle"],
    ["context_size", 0], ["last_status_change_at", null], ["last_command", null],
  ];

  /** Coerce a legacy PaneMeta into the StoredPane savePane expects. Extracted from updatePane verbatim:
   *  identical per-field defaults, `!!` boolean coercion, and the fixed scrollback_path/created_at fields. */
  private paneMetaToStoredPane(projectId: string, paneMeta: import("../types").PaneMeta): StoredPane {
    const sp = {
      pane_id: paneMeta.pane_id,
      workspace_id: projectId,
      is_busy: !!paneMeta.is_busy,
      alive: !!paneMeta.alive,
      scrollback_path: null,
      created_at: 0,
      updated_at: Date.now(),
    } as Record<string, unknown>;
    for (const [col, dflt] of JanusStore.PANE_META_DEFAULTS) {
      // `??` so a missing/undefined meta field gets the documented default; present values pass through.
      // PaneMeta shares these column names with StoredPane; index via a string-record view (not `any`).
      sp[col] = (paneMeta as unknown as Record<string, unknown>)[col] ?? dflt;
    }
    return sp as unknown as StoredPane;
  }

  /** Persist the PaneMeta-carried columns the savePane upsert does NOT touch. Extracted from updatePane
   *  verbatim (same conditions, same SQL, same order): draft / model_context / human_context are written
   *  ONLY when present on the meta (so an in-place mutator can't silently drop them), while
   *  capability_gates is ALWAYS written — NULL when absent/empty — so clearing an override erases it. */
  private persistPaneMetaExtras(projectId: string, paneMeta: import("../types").PaneMeta): void {
    const update = (column: string, value: unknown) =>
      this.db.prepare(`UPDATE panes SET ${column}=? WHERE pane_id=? AND workspace_id=?`)
        .run(value, paneMeta.pane_id, projectId);
    if (paneMeta.draft) update("draft", JSON.stringify(paneMeta.draft));
    if (paneMeta.modelContext) update("model_context", JSON.stringify(paneMeta.modelContext));
    if (paneMeta.humanContext) update("human_context", JSON.stringify(paneMeta.humanContext));
    // bead 8sq: ALWAYS written (even when undefined → NULL) so clearing an override actually erases it
    // rather than leaving a stale row value. The savePane upsert above doesn't touch this column.
    const gates = paneMeta.capabilityGates && Object.keys(paneMeta.capabilityGates).length
      ? JSON.stringify(paneMeta.capabilityGates)
      : null;
    update("capability_gates", gates);
  }

  /** Upsert a pane from the legacy PaneMeta shape into the panes table. The
   *  `shouldSave` flag is accepted for Ledger parity but ignored (always durable). */
  updatePane(projectId: string, paneMeta: import("../types").PaneMeta, _shouldSave = true): void {
    this.savePane(this.paneMetaToStoredPane(projectId, paneMeta));
    // Persist layered context / draft / per-pane gate override carried on the meta, so a manager that
    // mutates PaneMeta in place doesn't silently drop them (see persistPaneMetaExtras for semantics).
    this.persistPaneMetaExtras(projectId, paneMeta);
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

  /** Project a StoredPane into the legacy PaneMeta shape (with notes[]).
   *  4E.4: `notes` may be pre-fetched by a batched caller (the `workspaces` projection);
   *  per-call paths keep the per-pane query. Output shape is identical either way. */
  private toPaneMeta(p: StoredPane, notes?: string[]): import("../types").PaneMeta {
    return {
      pane_id: p.pane_id,
      name: p.name,
      alive: p.alive,
      last_command: p.last_command ?? undefined,
      last_known_state: p.last_known_state,
      notes: notes ?? this.paneNoteStrings(p.workspace_id, p.pane_id),
      session_id: p.session_id,
      context_size: p.context_size,
      is_busy: p.is_busy,
      tool_preset: p.tool_preset,
      permissions_mode: p.permissions_mode,
      runtime_type: p.runtime_type,
      // bead 8sq: hydrate the per-pane capability-gate override (schema v4). NULL/absent → undefined
      // (no override; the resolver falls through to the global default).
      capabilityGates: this.parseJSON<import("../types").CapabilityGateMap | undefined>(p.capability_gates ?? null, undefined) || undefined,
    } as import("../types").PaneMeta;
  }

  /** A single project in the legacy Workspace shape, or null. */
  getProject(id: string): import("../types").Workspace | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as ProjectRow | undefined;
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

  /** bd #69: the owning project id for a pane via ONE indexed query (the panes PRIMARY KEY leads
   *  with pane_id, so this is an index probe — NOT a table scan). findPaneOwningProject's tier-3
   *  runs on the hot gate/posture path; the old fallback read the `workspaces` getter, which on this
   *  backend materializes the ENTIRE ledger (3× SELECT * + assembly) just to read one pane's owner.
   *  Returns null when the pane is unknown. */
  getProjectIdForPane(paneId: string): string | null {
    const r = this.db.prepare("SELECT workspace_id FROM panes WHERE pane_id=? LIMIT 1").get(paneId) as
      | { workspace_id: string }
      | undefined;
    return r?.workspace_id ?? null;
  }

  /** All projects keyed by id, in legacy Workspace shape (read snapshot).
   *
   *  4E.4: built in ONE pass — three queries total (projects, panes, notes) assembled in
   *  JS. The old shape did getProject per id → getPanes per project → getNotes per pane
   *  (N+1 synchronous queries), and broadcastLedgerUpdate calls this getter on ~40
   *  mutation sites. Output is byte-identical to the per-call assembly (the golden suite
   *  tests/test_store_projection.ts pins deepStrictEqual against getProject-per-id):
   *   - projects iterate in created_at order; panes in created_at order per project;
   *   - notes replicate getNotes' ORDER BY created_at DESC then .reverse() (ASC), with
   *     project notes = rows with no pane_id and pane notes partitioned per (project,pane);
   *   - orphan pane notes (their pane is gone) stay invisible, exactly as before. */
  // Composite key separator for the per-(project,pane) note map. A NUL byte cannot appear in a
  // project/pane id, so `${project_id}\0${pane_id}` is an unambiguous key (a space would collide for
  // ids containing spaces). Centralized here and threaded through the partition/assembly helpers so the
  // workspaces refactor preserves the original delimiter EXACTLY.
  private static readonly WS_NOTE_KEY_SEP = "\u0000";

  /** Partition note rows (DESC by created_at) into project-scoped and pane-scoped buckets. Extracted
   *  from the `workspaces` getter verbatim: partitioning preserves the DESC order within each group so
   *  the getter trailing reverse() reproduces the legacy per-group ASC lists exactly; pane notes are
   *  keyed `${project_id}\0${pane_id}` (WS_NOTE_KEY_SEP). Maps (not plain objects), so no string-key
   *  prototype-leak surface. */
  private partitionNotes(noteRows: NoteRow[]): { projectNotes: Map<string, string[]>; paneNotes: Map<string, string[]> } {
    const projectNotes = new Map<string, string[]>();
    const paneNotes = new Map<string, string[]>(); // key: `${project_id}\u0000${pane_id}`
    for (const n of noteRows) {
      const [bucket, key] = n.pane_id
        ? ([paneNotes, `${n.project_id}${JanusStore.WS_NOTE_KEY_SEP}${n.pane_id}`] as const)
        : ([projectNotes, n.project_id] as const);
      const arr = bucket.get(key);
      if (arr) arr.push(n.text); else bucket.set(key, [n.text]);
    }
    return { projectNotes, paneNotes };
  }

  /** Group pane rows by their owning project (workspace_id), preserving row order. Extracted verbatim. */
  private partitionPanesByProject(paneRows: PaneRow[]): Map<string, PaneRow[]> {
    const panesByProject = new Map<string, PaneRow[]>();
    for (const r of paneRows) {
      const arr = panesByProject.get(r.workspace_id);
      if (arr) arr.push(r); else panesByProject.set(r.workspace_id, [r]);
    }
    return panesByProject;
  }

  /** Assemble ONE project row into the legacy Workspace shape using the pre-partitioned note/pane maps.
   *  Extracted from the `workspaces` getter verbatim: identical field set, the per-group `.slice()
   *  .reverse()` (DESC->ASC), orphan-pane-note invisibility, and the summary/keyTerms defaults. */
  private assembleWorkspace(
    r: ProjectRow,
    panesByProject: Map<string, PaneRow[]>,
    projectNotes: Map<string, string[]>,
    paneNotes: Map<string, string[]>,
  ): import("../types").Workspace {
    const panes: Record<string, import("../types").PaneMeta> = {};
    for (const paneRow of panesByProject.get(r.id) ?? []) {
      const sp = this.hydratePane(paneRow);
      const notes = (paneNotes.get(`${r.id}${JanusStore.WS_NOTE_KEY_SEP}${sp.pane_id}`) ?? []).slice().reverse();
      panes[sp.pane_id] = this.toPaneMeta(sp, notes);
    }
    return {
      id: r.id,
      name: r.name,
      directory: r.directory,
      summary: r.summary ?? "",
      notes: (projectNotes.get(r.id) ?? []).slice().reverse(),
      panes,
      keyTerms: this.parseJSON(r.key_terms, [] as string[]),
    } as import("../types").Workspace;
  }

  get workspaces(): Record<string, import("../types").Workspace> {
    const out: Record<string, import("../types").Workspace> = {};
    const projRows = this.db.prepare("SELECT * FROM projects ORDER BY created_at").all() as ProjectRow[];
    if (projRows.length === 0) return out;
    const paneRows = this.db.prepare("SELECT * FROM panes ORDER BY created_at").all() as PaneRow[];
    const noteRows = this.db.prepare("SELECT * FROM notes ORDER BY created_at DESC").all() as NoteRow[];

    const { projectNotes, paneNotes } = this.partitionNotes(noteRows);
    const panesByProject = this.partitionPanesByProject(paneRows);
    for (const r of projRows) {
      out[r.id] = this.assembleWorkspace(r, panesByProject, projectNotes, paneNotes);
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

  /** wsm-e2e-pinned major-finding fix: hard-delete a LIVE pane row (the delete_pane action's real
   *  durable effect — NOT the recoverable archivePane/archivePaneOwned pair above). Truthy-on-success
   *  (Ledger parity): false when the row was already gone, so callers can narrate idempotently without
   *  a spurious broadcast. `workspaces`/`getProject` are snapshot getters that re-read SQL on every
   *  call and `save()` is a documented no-op — a caller that only mutated the projected snapshot object
   *  (`delete ws.panes[id]`) never touched the database, so the row silently resurrected on next read.
   *  This issues the actual `DELETE FROM panes` row mutation. */
  deletePane(projectId: string, paneId: string): boolean {
    const res = this.db.prepare("DELETE FROM panes WHERE pane_id=? AND workspace_id=?").run(paneId, projectId);
    return res.changes > 0;
  }

  /** wsm-e2e-pinned major-finding fix: hard-delete a project row (the delete_project action's real
   *  durable effect). Truthy-on-success. `panes.workspace_id REFERENCES projects(id) ON DELETE CASCADE`
   *  with `foreign_keys=ON` (schema.ts), so this also removes the project's own panes in the same
   *  statement — the SQL analog of the legacy in-memory Ledger dropping the whole nested workspace
   *  object. See deletePane's doc comment for why a snapshot-only mutation is a silent no-op here. */
  deleteProject(id: string): boolean {
    const res = this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
    return res.changes > 0;
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

  // ──────────────────────────────────────────────────────────────────────────
  // Handoff artifact (design §4/§5). The row is the live projection; the events
  // table is the immutable audit spine. Every state transition emits ONE HANDOFF
  // event in the SAME transaction as the row-flip via recordActivity().
  // ──────────────────────────────────────────────────────────────────────────

  // Columns hydrated verbatim (no default) and the per-column default for nullable columns. Driving
  // the repetitive `?? <default>` fallbacks off a table (instead of 16 inline `??` operators) keeps
  // hydrateHandoff under CC 10 while preserving EXACTLY the prior per-field defaults. `null` here means
  // "absent column -> null" (was `?? null`); the literals reproduce the prior `?? ""`/`?? 0`/`?? "{}"`/
  // `?? "[]"` defaults. Static const map (typed-literal keyed) — no string-key prototype-leak surface.
  private static readonly HANDOFF_VERBATIM = ["id", "workspace_id", "to_pane", "kind", "state", "created_at"] as const;
  private static readonly HANDOFF_DEFAULTS: ReadonlyArray<readonly [keyof StoredHandoff, string | number | null]> = [
    ["from_pane", null], ["composed_prompt", ""], ["source_context", "{}"],
    ["source_context_refs", "[]"], ["gate_approval_id", null], ["approved_by", null],
    ["approved_via", null], ["revision_count", 0], ["staged_at", null],
    ["delivered_at", null], ["consumed_at", null], ["terminal_at", null], ["expires_at", null],
  ];

  private hydrateHandoff(r: HandoffRow): StoredHandoff {
    const out = {} as Record<string, unknown>;
    for (const col of JanusStore.HANDOFF_VERBATIM) out[col] = r[col];
    for (const [col, dflt] of JanusStore.HANDOFF_DEFAULTS) out[col] = r[col] ?? dflt;
    return out as unknown as StoredHandoff;
  }

  /** Insert a new handoff row (state defaults to 'composing'). Emits a HANDOFF event. */
  createHandoff(h: {
    id?: string;
    workspace_id: string;
    from_pane?: string | null;
    to_pane: string;
    kind?: import("./types").ApprovalKind;
    composed_prompt?: string;
    source_context?: string;
    source_context_refs?: string;
    state?: HandoffState;
    expires_at?: number | null;
  }): StoredHandoff {
    const now = Date.now();
    const id = h.id ?? `handoff_${now}_${Math.floor(this.rand() * 1e6)}`;
    const row: StoredHandoff = {
      id,
      workspace_id: h.workspace_id,
      from_pane: h.from_pane ?? null,
      to_pane: h.to_pane,
      kind: h.kind ?? "agent_instruction",
      composed_prompt: h.composed_prompt ?? "",
      source_context: h.source_context ?? "{}",
      source_context_refs: h.source_context_refs ?? "[]",
      state: h.state ?? "composing",
      gate_approval_id: null,
      approved_by: null,
      approved_via: null,
      revision_count: 0,
      created_at: now,
      staged_at: null,
      delivered_at: null,
      consumed_at: null,
      terminal_at: null,
      expires_at: h.expires_at ?? null,
    };
    this.recordActivity(
      {
        type: EVENT_TYPES.HANDOFF,
        project_id: row.workspace_id,
        pane_id: row.to_pane,
        handoff_id: id,
        summary: `handoff proposed -> ${row.state}`,
        payload: { handoff_id: id, from: null, to: row.state, from_pane: row.from_pane, to_pane: row.to_pane },
      },
      (db) => db.prepare(
        `INSERT INTO handoffs(id,workspace_id,from_pane,to_pane,kind,composed_prompt,source_context,
           source_context_refs,state,gate_approval_id,approved_by,approved_via,revision_count,
           created_at,staged_at,delivered_at,consumed_at,terminal_at,expires_at)
         VALUES(@id,@workspace_id,@from_pane,@to_pane,@kind,@composed_prompt,@source_context,
           @source_context_refs,@state,@gate_approval_id,@approved_by,@approved_via,@revision_count,
           @created_at,@staged_at,@delivered_at,@consumed_at,@terminal_at,@expires_at)`
      ).run(row)
    );
    return row;
  }

  getHandoff(id: string): StoredHandoff | null {
    const r = this.db.prepare("SELECT * FROM handoffs WHERE id=?").get(id) as HandoffRow | undefined;
    return r ? this.hydrateHandoff(r) : null;
  }

  /** Ungated revise: rewrite the cargo + bump revision_count. Emits a composing->revising event. */
  updateHandoffCargo(id: string, composedPrompt: string): StoredHandoff | null {
    const existing = this.getHandoff(id);
    if (!existing) return null;
    this.recordActivity(
      {
        type: EVENT_TYPES.HANDOFF,
        project_id: existing.workspace_id,
        pane_id: existing.to_pane,
        handoff_id: id,
        summary: `handoff ${existing.state} -> revising`,
        payload: { handoff_id: id, from: existing.state, to: "revising", revision: existing.revision_count + 1 },
      },
      (db) => db.prepare(
        "UPDATE handoffs SET composed_prompt=?, state='revising', revision_count=revision_count+1 WHERE id=?"
      ).run(composedPrompt, id)
    );
    return this.getHandoff(id);
  }

  /**
   * Atomic state-flip + audit event. `patch` carries optional column updates (e.g.
   * approved_by/approved_via/staged_at/delivered_at). Sets terminal_at for terminal states.
   */
  // The state -> "stamp this timestamp column with patch.<col> ?? now" rule, in the exact order the
  // original pushed them (staged, delivered, consumed). At most one fires per call (state is one value).
  private static readonly HANDOFF_STATE_TS: ReadonlyArray<readonly [HandoffState, keyof StoredHandoff]> = [
    ["staged", "staged_at"], ["delivered", "delivered_at"], ["consumed", "consumed_at"],
  ];
  // Patch columns written ONLY when present in the patch (=== undefined check, so an explicit null IS
  // written), in the original push order. Listed via a typed-literal tuple table — no string-key map.
  private static readonly HANDOFF_PATCH_COLS: ReadonlyArray<keyof StoredHandoff> = [
    "approved_by", "approved_via", "gate_approval_id",
  ];
  private static readonly HANDOFF_TERMINAL_STATES: ReadonlySet<HandoffState> = new Set<HandoffState>([
    "consumed", "rejected", "expired", "blocked_read_only",
  ]);

  /** Build the ordered SET fragments + bound params for an updateHandoffState flip. Extracted verbatim
   *  (behavior-preserving) so the host method clears CC 10; the fragment ORDER is identical to the
   *  prior inline pushes (state, then any state-timestamp, then present patch cols, then terminal_at). */
  private buildHandoffStateUpdate(
    id: string,
    state: HandoffState,
    patch: Partial<StoredHandoff>,
    now: number,
  ): { sets: string[]; params: Record<string, any> } {
    const sets: string[] = ["state=@state"];
    const params: Record<string, any> = { id, state };
    for (const [matchState, col] of JanusStore.HANDOFF_STATE_TS) {
      if (state === matchState) { sets.push(`${col}=@${col}`); params[col] = patch[col] ?? now; }
    }
    for (const col of JanusStore.HANDOFF_PATCH_COLS) {
      if (patch[col] !== undefined) { sets.push(`${col}=@${col}`); params[col] = patch[col]; }
    }
    if (JanusStore.HANDOFF_TERMINAL_STATES.has(state)) {
      sets.push("terminal_at=@terminal_at"); params.terminal_at = patch.terminal_at ?? now;
    }
    return { sets, params };
  }

  updateHandoffState(id: string, state: HandoffState, patch: Partial<StoredHandoff> = {}): StoredHandoff | null {
    const existing = this.getHandoff(id);
    if (!existing) return null;
    // wsm-e2e-pinned-3vl (2): defense-in-depth terminal-state no-op. Exactly-once already rests on
    // the UPSTREAM claim gate (resolveDecision's atomic claim() — only the claim winner ever reaches
    // a flip call), so under correct operation this branch should never fire. It exists so a second
    // write attempt against an already-terminal row (a bug elsewhere, a replay, a future caller that
    // forgets the claim gate) can never re-stamp terminal_at/approved_via or emit a second handoff
    // audit event — it silently returns the row UNCHANGED rather than corrupting the audit trail.
    if (JanusStore.HANDOFF_TERMINAL_STATES.has(existing.state)) return existing;
    const now = Date.now();
    const { sets, params } = this.buildHandoffStateUpdate(id, state, patch, now);
    this.recordActivity(
      {
        type: EVENT_TYPES.HANDOFF,
        project_id: existing.workspace_id,
        pane_id: existing.to_pane,
        handoff_id: id,
        summary: `handoff ${existing.state} -> ${state}`,
        payload: { handoff_id: id, from: existing.state, to: state },
      },
      (db) => db.prepare(`UPDATE handoffs SET ${sets.join(", ")} WHERE id=@id`).run(params)
    );
    return this.getHandoff(id);
  }

  /** Persist the in-memory PendingApproval messageId on the handoff (gate leg, design §5.3). */
  setGateApprovalId(id: string, approvalId: string | null): void {
    this.db.prepare("UPDATE handoffs SET gate_approval_id=? WHERE id=?").run(approvalId, id);
  }

  listHandoffs(filter: { workspaceId?: string; toPane?: string; state?: HandoffState } = {}): StoredHandoff[] {
    const where: string[] = []; const args: any[] = [];
    if (filter.workspaceId) { where.push("workspace_id=?"); args.push(filter.workspaceId); }
    if (filter.toPane) { where.push("to_pane=?"); args.push(filter.toPane); }
    if (filter.state) { where.push("state=?"); args.push(filter.state); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM handoffs ${clause} ORDER BY created_at DESC`).all(...args) as HandoffRow[])
      .map(r => this.hydrateHandoff(r));
  }

  /**
   * Observability sweep (design §5/§5.3): staged/pending rows past their TTL, plus long-'delivered'
   * rows (the fallback transport cannot authoritatively confirm consumption).
   */
  getStuckHandoffs(now = Date.now(), deliveredStaleMs = 10 * 60 * 1000): StoredHandoff[] {
    const rows = this.db.prepare(
      `SELECT * FROM handoffs
        WHERE (state IN ('staged','composing','revising') AND expires_at IS NOT NULL AND expires_at < ?)
           OR (state='delivered' AND delivered_at IS NOT NULL AND delivered_at < ?)
        ORDER BY created_at ASC`
    ).all(now, now - deliveredStaleMs) as HandoffRow[];
    return rows.map(r => this.hydrateHandoff(r));
  }

  // ── B-3 cortex measurement spine (schema v9) ────────────────────────────────────────────────────
  // Fail-soft writers: measurement must NEVER throw into the caller. Each prepared INSERT mirrors
  // the recordAction style (named params, store-stamped ts optional). Read helpers follow the
  // getActionLog pattern (since filter, most-recent-first, default limit 100).

  /** Append one cortex decision trace row. Fail-soft: swallows + console.error on any DB error. */
  recordCortexDecision(row: {
    ts: number;
    injectId: string | null;
    sessionId: string | null;
    activePaneId: string | null;
    trigger: string;
    ruleFired: string;
    applied: boolean;
    traceJson: string;
  }): void {
    try {
      this.db.prepare(
        `INSERT INTO cortex_decision(ts,inject_id,session_id,active_pane_id,trigger,rule_fired,applied,trace_json)
         VALUES(@ts,@inject_id,@session_id,@active_pane_id,@trigger,@rule_fired,@applied,@trace_json)`
      ).run({
        ts: row.ts,
        inject_id: row.injectId,
        session_id: row.sessionId,
        active_pane_id: row.activePaneId,
        trigger: row.trigger,
        rule_fired: row.ruleFired,
        applied: row.applied ? 1 : 0,
        trace_json: row.traceJson,
      });
    } catch (e) {
      console.error("[store] recordCortexDecision failed:", e);
    }
  }

  /** Read cortex decision rows (most-recent-first) at or after `sinceTs`. Default limit 100. */
  getCortexDecisions(sinceTs: number, limit = 100): import("./types").CortexDecisionRow[] {
    return this.db.prepare(
      `SELECT * FROM cortex_decision WHERE ts >= ? ORDER BY id DESC LIMIT ?`
    ).all(sinceTs, limit) as import("./types").CortexDecisionRow[];
  }

  /** Append one Gemini turn usage row. Fail-soft: swallows + console.error on any DB error. */
  recordGeminiTurnUsage(row: {
    ts: number;
    sessionId: string | null;
    injectId: string | null;
    promptTokens: number | null;
    responseTokens: number | null;
    totalTokens: number | null;
  }): void {
    try {
      this.db.prepare(
        `INSERT INTO gemini_turn_usage(ts,session_id,inject_id,prompt_tokens,response_tokens,total_tokens)
         VALUES(@ts,@session_id,@inject_id,@prompt_tokens,@response_tokens,@total_tokens)`
      ).run({
        ts: row.ts,
        session_id: row.sessionId,
        inject_id: row.injectId,
        prompt_tokens: row.promptTokens,
        response_tokens: row.responseTokens,
        total_tokens: row.totalTokens,
      });
    } catch (e) {
      console.error("[store] recordGeminiTurnUsage failed:", e);
    }
  }

  /** Read Gemini turn usage rows (most-recent-first) at or after `sinceTs`. Default limit 100. */
  getGeminiTurnUsages(sinceTs: number, limit = 100): import("./types").GeminiTurnUsageRow[] {
    return this.db.prepare(
      `SELECT * FROM gemini_turn_usage WHERE ts >= ? ORDER BY id DESC LIMIT ?`
    ).all(sinceTs, limit) as import("./types").GeminiTurnUsageRow[];
  }

  // ── Cortex context-injection telemetry (schema v10) ─────────────────────────────────────────────
  // Fail-soft writer: telemetry must NEVER throw into the live voice loop (mirrors
  // recordGeminiTurnUsage's try/catch-and-console.error shape, delta 18.4). Read helper follows the
  // getGeminiTurnUsages pattern (since filter, most-recent-first, default limit 100), plus optional
  // sessionId/limit filters per the delta-18-required round-trip contract.

  /** Append one context-injection attempt row. Fail-soft: swallows + console.error on any DB error. */
  recordContextInjection(row: import("../memory/contextTelemetry").ContextInjectionEvent): void {
    try {
      this.db.prepare(
        `INSERT INTO context_injections(
           id,ts,session_id,interaction_id,inject_id,trigger,active_project_id,active_pane_id,
           brief_active_pane_id,source,disposition,skipped_reason,source_snapshot_hash,brief_hash,
           brief_chars,estimated_tokens,elapsed_ms,error
         ) VALUES(
           @id,@ts,@session_id,@interaction_id,@inject_id,@trigger,@active_project_id,@active_pane_id,
           @brief_active_pane_id,@source,@disposition,@skipped_reason,@source_snapshot_hash,@brief_hash,
           @brief_chars,@estimated_tokens,@elapsed_ms,@error
         )`
      ).run({
        id: row.id,
        ts: row.ts,
        session_id: row.session_id,
        interaction_id: row.interaction_id,
        inject_id: row.inject_id,
        trigger: row.trigger,
        active_project_id: row.active_project_id,
        active_pane_id: row.active_pane_id,
        brief_active_pane_id: row.brief_active_pane_id,
        source: row.source,
        disposition: row.disposition,
        skipped_reason: row.skipped_reason,
        source_snapshot_hash: row.source_snapshot_hash,
        brief_hash: row.brief_hash,
        brief_chars: row.brief_chars,
        estimated_tokens: row.estimated_tokens,
        elapsed_ms: row.elapsed_ms,
        error: row.error,
      });
    } catch (e) {
      console.error("[store] recordContextInjection failed:", e);
    }
  }

  /** Read context-injection rows (most-recent-first), optionally filtered by `since` (ts >=),
   *  `sessionId` (exact match), and capped by `limit` (default 100). Never throws — an unexpected
   *  DB error yields an empty array (telemetry reads must not break a caller either).
   *
   *  Ordering: `ts DESC, rowid DESC`. Event ids are minted `ctxevt-<Date.now()>-<seq>`
   *  (src/memory/contextTelemetry.ts) and are NOT zero-padded, so they are not safely
   *  lexicographically sortable once `seq` reaches two digits (e.g. "...-10" < "...-9").
   *  SQLite's implicit `rowid` reflects insertion order instead, giving a deterministic
   *  tiebreak for same-millisecond bursts without depending on the id's string shape. */
  getContextInjections(filter?: { since?: number; sessionId?: string; limit?: number }): import("./types").ContextInjectionRow[] {
    const since = filter?.since ?? 0;
    const limit = filter?.limit ?? 100;
    try {
      if (filter?.sessionId !== undefined) {
        return this.db.prepare(
          `SELECT * FROM context_injections WHERE ts >= ? AND session_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?`
        ).all(since, filter.sessionId, limit) as import("./types").ContextInjectionRow[];
      }
      return this.db.prepare(
        `SELECT * FROM context_injections WHERE ts >= ? ORDER BY ts DESC, rowid DESC LIMIT ?`
      ).all(since, limit) as import("./types").ContextInjectionRow[];
    } catch (e) {
      console.error("[store] getContextInjections failed:", e);
      return [];
    }
  }
}