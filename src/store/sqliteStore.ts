// src/store/sqliteStore.ts
import Database from "better-sqlite3";
import { applyMigrations } from "./schema";
import { EVENT_TYPES, type NewEvent, type StoredEvent } from "./eventTypes";
import type { StoredPane, StoredPendingApproval, StoredPendingAction, StoredHandoff, HandoffState } from "./types";
import type {
  PaneRow, ArchivedPaneRow, ProjectRow, NoteRow, PendingApprovalRow, PendingActionRow,
  AttentionRow, HandoffRow, ValueRow, CountRow, IdRow, SearchHitRow,
  AgentExchangeRow, ExchangeEventRow, ContextDeliveryRow, TranscriptRow,
  JumpOverRow, ArbiterDrainRow,
} from "./types";
import { pruneOnBoot, pruneIncremental, type PruneOpts, type SweepOpts, type SweepResult } from "./retention";
import type { AgentExchange, ExchangeEvent, ContextDelivery, ExchangeState, ExchangeEventType } from "../exchanges/types";
import { mintExchangeId, mintContextDeliveryId } from "../exchanges/types";
import { TERMINAL_STATES } from "../exchanges/lifecycle";

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
  private _macros?: import("../macros").Macro[];

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
  // Voice macros (8fz.6) — same kv-JSON self-persisting document array as promptTemplates/layouts.
  get macros(): import("../macros").Macro[] {
    if (!this._macros) this._macros = this.persistingArray("macros", this.loadJsonArray("macros"));
    return this._macros;
  }

  /** Flush in-place element edits that the array Proxy can't observe. */
  persistWatchRules(): void { this.setKV("watchRules", JSON.stringify(this.watchRules)); }
  persistPlans(): void { this.setKV("plans", JSON.stringify(this.plans)); }
  persistPromptTemplates(): void { this.setKV("promptTemplates", JSON.stringify(this.promptTemplates)); }
  persistLayouts(): void { this.setKV("layouts", JSON.stringify(this.layouts)); }
  persistMacros(): void { this.setKV("macros", JSON.stringify(this.macros)); }

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
  /** Single note by id (hwu.4 — the promoter reads back the note it just marked). Null when gone. */
  getNote(id: string): import("./types").StoredNote | null {
    const r = this.db.prepare("SELECT * FROM notes WHERE id=?").get(id) as NoteRow | undefined;
    return r ? { ...r } : null;
  }
  /**
   * hwu.4: set (or clear) a note's draft→bead promotion marker. `bead_status` does NOT feed the FTS
   * index (the notes_au trigger re-indexes `text` only, so this UPDATE writes text=text unchanged —
   * a no-op re-index that keeps the row's snippet intact). This is the ONLY writer of the column; the
   * live Gemini path never reaches it — the promoter (on operator approval) and the proposal marker do.
   */
  setNoteBeadStatus(id: string, status: import("./types").BeadStatus | null): void {
    this.db.prepare("UPDATE notes SET bead_status=?, updated_at=? WHERE id=?").run(status, Date.now(), id);
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
      `INSERT INTO pending_approvals(id,session_id,workspace_id,pane_id,command,kind,rationale,claimed,timestamp,expires_at,exchange_id)
       VALUES(@id,@session_id,@workspace_id,@pane_id,@command,@kind,@rationale,@claimed,@timestamp,@expires_at,@exchange_id)
       ON CONFLICT(id) DO UPDATE SET
         session_id=excluded.session_id, workspace_id=excluded.workspace_id, pane_id=excluded.pane_id,
         command=excluded.command, kind=excluded.kind, rationale=excluded.rationale,
         timestamp=excluded.timestamp, expires_at=excluded.expires_at, exchange_id=excluded.exchange_id,
         claimed=CASE WHEN pending_approvals.claimed=1 THEN 1 ELSE excluded.claimed END`
    ).run({ ...a, claimed: a.claimed?1:0, rationale: a.rationale ?? null, exchange_id: a.exchange_id ?? null });
  }
  /** Atomic claim: flips 0->1 only if currently 0. True == this caller won. */
  claimApproval(id: string): boolean {
    return this.db.prepare("UPDATE pending_approvals SET claimed=1 WHERE id=? AND claimed=0").run(id).changes === 1;
  }
  deletePendingApproval(id: string): void {
    this.db.prepare("DELETE FROM pending_approvals WHERE id=?").run(id);
  }
  /** AgentExchange spine boot recovery (step 1.4, spec §4): does a durable pending_approval row
   *  still exist for this id (claimed or not)? Used to decide whether an `awaiting_approval`
   *  exchange can be safely KEPT (the approval survivor re-hydrates via the existing path) or must
   *  revert to `draft` (the row was claimed+deleted or TTL-swept mid-crash — never assume the
   *  missing approval was confirmed). */
  hasPendingApproval(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pending_approvals WHERE id=?").get(id);
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

  /**
   * Phase 5, Step 5.2 (exchange replay): every `pending_approvals` row stamped with this
   * `exchange_id` (schema v12's nullable correlation column), regardless of claimed state —
   * a replay's whole point is showing the operator the approval record that GOVERNED the
   * exchange, even one already claimed/resolved. A row is only ever durably ABSENT here once
   * `deletePendingApproval` actually runs (normal resolve, or the 4E.3c claimed=1 retention
   * sweep) — replay degrades to "no surviving approval record" in that case, never fabricated.
   * Ordered by timestamp ASC (oldest first, mirrors getPendingApprovals). Bounded: at most a
   * handful of approval requests ever correlate to one exchange in practice.
   */
  listPendingApprovalsByExchange(exchangeId: string): StoredPendingApproval[] {
    return (this.db.prepare(
      "SELECT * FROM pending_approvals WHERE exchange_id=? ORDER BY timestamp ASC"
    ).all(exchangeId) as PendingApprovalRow[]).map(r => this.hydrateApproval(r));
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
    /** AgentExchange spine correlation (schema v12's action_log.exchange_id, ALTER-added but not
     *  previously exposed here — storage-API gap closed for step 1.3 task C). Nullable; only an
     *  exchange-correlated dispatch (flag on) ever sets it. */
    exchange_id?: string | null;
  }): void {
    this.db.prepare(
      `INSERT INTO action_log(ts,name,capability,result_kind,ms,args_redacted,surface,idempotency_key,interaction_id,exchange_id)
       VALUES(@ts,@name,@capability,@result_kind,@ms,@args_redacted,@surface,@idempotency_key,@interaction_id,@exchange_id)`
    ).run({
      ts: Date.now(),
      name: row.name,
      capability: row.capability,
      result_kind: row.result_kind,
      ms: row.ms,
      args_redacted: row.args_redacted ?? null,
      surface: row.surface ?? null,
      exchange_id: row.exchange_id ?? null,
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

  // ── AgentExchange spine (schema v12, Phase 1 step 1.2) ──────────────────────────────────────────
  // STORAGE ONLY: pure CRUD + the exchange-level CAS (spec §2a). No transition-legality checking
  // lives here — src/exchanges/lifecycle.ts (step 1.3) owns the state machine and decides what to
  // write; this layer just persists it atomically and reports whether a CAS won. Core ledger data
  // (like handoffs/pending_approvals), so these throw on a genuine DB error rather than fail-soft —
  // callers need a real signal to distinguish "CAS lost" (changed:false) from "the store broke".

  // Per-column defaults for insertExchange, table-driven (the paneMetaToStoredPane /
  // PANE_META_DEFAULTS idiom) so the constructor stays well under the CC-10 gate instead of a
  // 16-field chain of `??` (which alone would trip the complexity rule — each `??` is a branch).
  private static readonly EXCHANGE_DEFAULTS: ReadonlyArray<readonly [keyof AgentExchange, unknown]> = [
    ["voice_session_id", null], ["interaction_id", null], ["operator_utterance", ""],
    ["distilled_instruction", ""], ["instruction_envelope_json", "{}"], ["draft_version", 1],
    ["context_version", null], ["state", "draft"], ["approval_id", null],
    ["approval_draft_version", null], ["delivery_attempt", 0], ["terminal_state", null],
    ["result_summary", null], ["result_envelope_json", null], ["delivered_at", null], ["completed_at", null],
  ];

  /** Insert a new exchange row. `exchange_id` is minted (spec §2 ID minting) when absent. Every
   *  other column has a documented default (schema v12) so a caller only needs to pass the fields
   *  it actually knows at `exchange_created` time (project_id, pane_id, the utterance/instruction). */
  insertExchange(input: Partial<AgentExchange> & Pick<AgentExchange, "project_id" | "pane_id">): AgentExchange {
    const now = Date.now();
    const rec = {
      exchange_id: input.exchange_id ?? mintExchangeId(now),
      project_id: input.project_id,
      pane_id: input.pane_id,
      created_at: input.created_at ?? now,
      updated_at: input.updated_at ?? now,
    } as Record<string, unknown>;
    for (const [col, dflt] of JanusStore.EXCHANGE_DEFAULTS) {
      rec[col] = (input as Record<string, unknown>)[col] ?? dflt;
    }
    const row = rec as unknown as AgentExchange;
    this.db.prepare(
      `INSERT INTO agent_exchanges(exchange_id,project_id,pane_id,voice_session_id,interaction_id,
         operator_utterance,distilled_instruction,instruction_envelope_json,draft_version,
         context_version,state,approval_id,approval_draft_version,delivery_attempt,terminal_state,
         result_summary,result_envelope_json,created_at,updated_at,delivered_at,completed_at)
       VALUES(@exchange_id,@project_id,@pane_id,@voice_session_id,@interaction_id,
         @operator_utterance,@distilled_instruction,@instruction_envelope_json,@draft_version,
         @context_version,@state,@approval_id,@approval_draft_version,@delivery_attempt,@terminal_state,
         @result_summary,@result_envelope_json,@created_at,@updated_at,@delivered_at,@completed_at)`
    ).run(row);
    return row;
  }

  getExchange(exchangeId: string): AgentExchange | null {
    const r = this.db.prepare("SELECT * FROM agent_exchanges WHERE exchange_id=?").get(exchangeId) as AgentExchangeRow | undefined;
    return r ? { ...r } : null;
  }

  /** Exchanges currently in `state`, oldest first (idx_agent_exchanges_state). */
  listExchangesByState(state: ExchangeState): AgentExchange[] {
    return (this.db.prepare(
      "SELECT * FROM agent_exchanges WHERE state=? ORDER BY created_at ASC"
    ).all(state) as AgentExchangeRow[]).map(r => ({ ...r }));
  }

  /**
   * Boot-recovery efficiency: full rows for exchanges in ANY of `states`, oldest first — one query
   * in place of one `listExchangesByState` call per state (src/exchanges/recovery.ts's
   * `recoverExchangesOnBoot` used to do exactly that, once per one of the 12 ExchangeState values).
   * Deliberately UNBOUNDED and ASC-ordered, mirroring `listExchangesByState`'s own contract exactly
   * — NOT `listExchangesByStates`'s bounded, DESC "recent activity" shape (a different read for a
   * different caller: SITREP/catch-up, where newest-first + a cap is the right answer). Boot
   * recovery must never silently drop a row to a LIMIT.
   */
  listExchangesByStatesForRecovery(states: ExchangeState[]): AgentExchange[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT * FROM agent_exchanges WHERE state IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...states) as AgentExchangeRow[]).map(r => ({ ...r }));
  }

  /**
   * Boot-recovery efficiency: JUST the `exchange_id` column for exchanges in ANY of `states` — the
   * "kept, untouched, nothing else needed" half of `recoverExchangesOnBoot` (draft/
   * awaiting_clarification/agent_complete/agent_failed/interrupted/cancelled), which only ever
   * pushes the id into its report and reads no other column. Unbounded, same reasoning as
   * `listExchangesByStatesForRecovery`.
   */
  listExchangeIdsByStates(states: ExchangeState[]): string[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT exchange_id FROM agent_exchanges WHERE state IN (${placeholders})`
    ).all(...states) as Array<{ exchange_id: string }>).map(r => r.exchange_id);
  }

  /** Every exchange ever created for `paneId`, oldest first (idx_agent_exchanges_pane_state). */
  listExchangesByPane(paneId: string): AgentExchange[] {
    return (this.db.prepare(
      "SELECT * FROM agent_exchanges WHERE pane_id=? ORDER BY created_at ASC"
    ).all(paneId) as AgentExchangeRow[]).map(r => ({ ...r }));
  }

  /**
   * Phase 5, Step 5.1 (Fleet View): the SINGLE most-recently-updated exchange for `paneId`, or
   * null when the pane has no exchange history at all. Bounded (`LIMIT 1`, uses
   * idx_agent_exchanges_pane_state) — the read the fleet-card projection needs ("what is this
   * pane's current/most-recent exchange"), as opposed to `listExchangesByPane`'s full oldest-first
   * history (a plan/replay read, unbounded per pane).
   */
  getLatestExchangeForPane(paneId: string): AgentExchange | null {
    const r = this.db.prepare(
      "SELECT * FROM agent_exchanges WHERE pane_id=? ORDER BY updated_at DESC LIMIT 1"
    ).get(paneId) as AgentExchangeRow | undefined;
    return r ? { ...r } : null;
  }

  /**
   * Phase 2 Step 2.1 (WorldModel board-tier efficiency): the single newest NON-TERMINAL exchange
   * for `paneId` — src/memory/worldModel.ts's "current in-flight exchange" read, previously done by
   * pulling the pane's ENTIRE history via `listExchangesByPane` and filtering/sorting in JS. Matches
   * that JS selection EXACTLY: newest by `created_at` DESC, tie-broken by `exchange_id` DESC (both
   * columns are plain ASCII, so SQLite's default BINARY collation orders identically to the JS
   * string comparison it replaces) — deliberately NOT `updated_at` (that's `getLatestExchangeForPane`
   * above, a different ordering for a different caller). `null` when the pane has no open exchange.
   * Terminal states come from `TERMINAL_STATES` (src/exchanges/lifecycle.ts) — the single authority
   * worldModel.ts's own TERMINAL_EXCHANGE_STATES now also imports.
   */
  getLatestOpenExchangeForPane(paneId: string): AgentExchange | null {
    const terminal = [...TERMINAL_STATES];
    const placeholders = terminal.map(() => "?").join(",");
    const r = this.db.prepare(
      `SELECT * FROM agent_exchanges WHERE pane_id=? AND state NOT IN (${placeholders}) ORDER BY created_at DESC, exchange_id DESC LIMIT 1`
    ).get(paneId, ...terminal) as AgentExchangeRow | undefined;
    return r ? { ...r } : null;
  }

  /**
   * CAS-guarded update — the SQL half of spec §2(a): `UPDATE … WHERE exchange_id=? AND state=?
   * [AND approval_id=? AND approval_draft_version=?]`. Every legal transition in the lifecycle
   * machine (step 1.3) is exactly one such guarded UPDATE, so repeated/racing application of the
   * same event is a structural no-op. Returns `changed:false` on a lost/stale CAS — callers must
   * treat that as "already applied / superseded", never retry it as a fresh write.
   */
  updateExchange(
    exchangeId: string,
    patch: Partial<Omit<AgentExchange, "exchange_id" | "project_id" | "pane_id" | "created_at">>,
    cas: { state: ExchangeState; approvalId?: string | null; approvalDraftVersion?: number | null },
  ): { changed: boolean; exchange: AgentExchange | null } {
    const sets: string[] = [];
    const params: Record<string, unknown> = { exchange_id: exchangeId, cas_state: cas.state };
    for (const [col, value] of Object.entries(patch)) { sets.push(`${col}=@${col}`); params[col] = value; }
    if (!("updated_at" in patch)) { sets.push("updated_at=@updated_at"); params.updated_at = Date.now(); }
    let where = "exchange_id=@exchange_id AND state=@cas_state";
    if (cas.approvalId !== undefined) { where += " AND approval_id=@cas_approval_id"; params.cas_approval_id = cas.approvalId; }
    if (cas.approvalDraftVersion !== undefined) {
      where += " AND approval_draft_version=@cas_approval_draft_version";
      params.cas_approval_draft_version = cas.approvalDraftVersion;
    }
    const res = this.db.prepare(`UPDATE agent_exchanges SET ${sets.join(", ")} WHERE ${where}`).run(params);
    return { changed: res.changes === 1, exchange: this.getExchange(exchangeId) };
  }

  /** Append one exchange_events row (AUTOINCREMENT event_id). Append-only audit spine — the
   *  exchange row above is the mutable head. Never throws on a genuine insert error (core ledger
   *  data), mirroring appendEventInTxn's contract for the parallel `events` table. */
  appendExchangeEvent(event: {
    exchange_id: string;
    event_type: ExchangeEvent["event_type"];
    project_id?: string | null;
    pane_id?: string | null;
    payload_redacted_json?: string;
    source?: ExchangeEvent["source"];
    interaction_id?: string | null;
    ts?: number;
  }): ExchangeEvent {
    const rec = {
      exchange_id: event.exchange_id,
      project_id: event.project_id ?? null,
      pane_id: event.pane_id ?? null,
      event_type: event.event_type,
      payload_redacted_json: event.payload_redacted_json ?? "{}",
      source: event.source ?? "system",
      interaction_id: event.interaction_id ?? null,
      ts: event.ts ?? Date.now(),
    };
    const info = this.db.prepare(
      `INSERT INTO exchange_events(exchange_id,project_id,pane_id,event_type,payload_redacted_json,source,interaction_id,ts)
       VALUES(@exchange_id,@project_id,@pane_id,@event_type,@payload_redacted_json,@source,@interaction_id,@ts)`
    ).run(rec);
    return { event_id: Number(info.lastInsertRowid), ...rec };
  }

  /** Ordered timeline for one exchange (idx_exchange_events_exchange_ts): `ts ASC, event_id ASC` —
   *  event_id is the AUTOINCREMENT PK, so same-millisecond bursts still get a deterministic order. */
  listExchangeEvents(exchangeId: string): ExchangeEvent[] {
    return (this.db.prepare(
      "SELECT * FROM exchange_events WHERE exchange_id=? ORDER BY ts ASC, event_id ASC"
    ).all(exchangeId) as ExchangeEventRow[]).map(r => ({ ...r }));
  }

  /**
   * Phase 2 Step 2.1 (WorldModel event-focus efficiency): one exchange's timeline, filtered to
   * `eventTypes` — a type-filtered VARIANT of `listExchangeEvents` (same table, same ordering: `ts
   * ASC, event_id ASC`), not a different selection. src/memory/worldModel.ts's
   * `candidateForExchangeEvent` only ever turns `needs_input_detected` + a small
   * RELEVANT_EXCHANGE_EVENTS set into a RecentCandidate and silently drops everything else — this
   * lets that caller ask for exactly that subset up front instead of pulling an exchange's full
   * (often much longer) event timeline just to discard most of it in JS.
   */
  listExchangeEventsByTypes(exchangeId: string, eventTypes: ExchangeEventType[]): ExchangeEvent[] {
    if (eventTypes.length === 0) return [];
    const placeholders = eventTypes.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT * FROM exchange_events WHERE exchange_id=? AND event_type IN (${placeholders}) ORDER BY ts ASC, event_id ASC`
    ).all(exchangeId, ...eventTypes) as ExchangeEventRow[]).map(r => ({ ...r }));
  }

  /**
   * Phase 4, Step 4.2: exchanges currently in ANY of `states`, most-recently-updated FIRST — the
   * cross-pane query catch-up/SITREP/attention prioritization needs ("what does the operator need
   * to hear about right now", newest first), as opposed to `listExchangesByState` (single state,
   * oldest-first, used by boot recovery). Uses idx_agent_exchanges_state per matched state.
   */
  listExchangesByStates(states: ExchangeState[], opts: { limit?: number } = {}): AgentExchange[] {
    if (states.length === 0) return [];
    const limit = opts.limit ?? 200;
    const placeholders = states.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT * FROM agent_exchanges WHERE state IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`
    ).all(...states, limit) as AgentExchangeRow[]).map(r => ({ ...r }));
  }

  /**
   * Phase 4, Step 4.2: recent `exchange_events` rows of the given `eventTypes`, newest first
   * (idx_exchange_events_type_ts) — feeds the catch-up/SITREP "recent decisions" tier (e.g.
   * `approval_confirmed`) without walking every exchange's own timeline individually.
   */
  listRecentExchangeEventsByTypes(
    eventTypes: ExchangeEventType[],
    opts: { sinceTs?: number; limit?: number } = {},
  ): ExchangeEvent[] {
    if (eventTypes.length === 0) return [];
    const limit = opts.limit ?? 20;
    const sinceTs = opts.sinceTs ?? 0;
    const placeholders = eventTypes.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT * FROM exchange_events WHERE event_type IN (${placeholders}) AND ts >= ? ORDER BY ts DESC, event_id DESC LIMIT ?`
    ).all(...eventTypes, sinceTs, limit) as ExchangeEventRow[]).map(r => ({ ...r }));
  }

  /**
   * Phase 5, Step 5.2 (exchange metrics report): EVERY exchange row created since `sinceMs` —
   * the report-window read `buildExchangeMetricsReport` (src/exchanges/metrics.ts) needs, as
   * opposed to `listExchangesByState`/`listExchangesByStates` (state-scoped) or
   * `listExchangesByPane` (pane-scoped). Oldest first (mirrors `listExchangesByPane`'s
   * ordering); mirrors `getContextDeliveries`'s window/limit/fail-soft shape (Phase 2 Step 2.2)
   * so the two report modules share one calling convention.
   */
  listExchangesSince(sinceMs: number, opts: { limit?: number } = {}): AgentExchange[] {
    const limit = opts.limit ?? 1_000_000;
    try {
      return (this.db.prepare(
        "SELECT * FROM agent_exchanges WHERE created_at >= ? ORDER BY created_at ASC LIMIT ?"
      ).all(sinceMs, limit) as AgentExchangeRow[]).map(r => ({ ...r }));
    } catch (e) {
      console.error("[store] listExchangesSince failed:", e);
      return [];
    }
  }

  /**
   * Phase 5, Step 5.2: EVERY `exchange_events` row (any event_type) since `sinceMs`, ordered
   * `ts ASC, event_id ASC` — a single flat, globally-ordered stream a report module groups by
   * `exchange_id` itself (grouping a stream already sorted this way preserves each group's own
   * chronological order, so no per-exchange re-sort is needed downstream). Distinct from
   * `listRecentExchangeEventsByTypes` (type-filtered, newest-first, small default limit — a
   * catch-up/SITREP read) and `listExchangeEvents` (single exchange only).
   */
  listExchangeEventsSince(sinceMs: number, opts: { limit?: number } = {}): ExchangeEvent[] {
    const limit = opts.limit ?? 1_000_000;
    try {
      return (this.db.prepare(
        "SELECT * FROM exchange_events WHERE ts >= ? ORDER BY ts ASC, event_id ASC LIMIT ?"
      ).all(sinceMs, limit) as ExchangeEventRow[]).map(r => ({ ...r }));
    } catch (e) {
      console.error("[store] listExchangeEventsSince failed:", e);
      return [];
    }
  }

  // ── context_deliveries (schema v12) ──────────────────────────────────────────────────────────
  // Sibling of the v10 context_injections telemetry spine (same fail-soft contract as
  // recordContextInjection/getContextInjections: a delivery ledger row is useful-but-not-critical
  // observability, so a DB fault here logs and degrades gracefully rather than breaking a caller
  // on the voice hot path).

  private static readonly CONTEXT_DELIVERY_DEFAULTS: ReadonlyArray<readonly [keyof ContextDelivery, unknown]> = [
    ["project_id", null], ["voice_session_id", null], ["snapshot_hash", null], ["brief_hash", null],
    ["included_sources_json", "[]"], ["dropped_sources_json", "[]"], ["acknowledged_at", null],
  ];

  /** Insert one context-delivery row. `delivery_id` is minted (mirrors `ctxevt-` minting) when
   *  absent. Fail-soft: swallows + console.error on any DB error (mirrors recordContextInjection);
   *  the constructed row is still returned so a caller has a stable delivery_id either way. */
  insertContextDelivery(
    input: Partial<ContextDelivery> & Pick<ContextDelivery, "context_version" | "trigger">,
  ): ContextDelivery {
    const now = Date.now();
    const rec = {
      delivery_id: input.delivery_id ?? mintContextDeliveryId(now),
      context_version: input.context_version,
      trigger: input.trigger,
      ts: input.ts ?? now,
    } as Record<string, unknown>;
    for (const [col, dflt] of JanusStore.CONTEXT_DELIVERY_DEFAULTS) {
      rec[col] = (input as Record<string, unknown>)[col] ?? dflt;
    }
    const row = rec as unknown as ContextDelivery;
    try {
      this.db.prepare(
        `INSERT INTO context_deliveries(delivery_id,project_id,voice_session_id,context_version,trigger,
           snapshot_hash,brief_hash,included_sources_json,dropped_sources_json,acknowledged_at,ts)
         VALUES(@delivery_id,@project_id,@voice_session_id,@context_version,@trigger,
           @snapshot_hash,@brief_hash,@included_sources_json,@dropped_sources_json,@acknowledged_at,@ts)`
      ).run(row);
    } catch (e) {
      console.error("[store] insertContextDelivery failed:", e);
    }
    return row;
  }

  /** Stamp `acknowledged_at` exactly once. True iff this call did the stamping (idempotent: a
   *  second ack on an already-acknowledged row is a no-op, `false`). Fail-soft on a DB error. */
  acknowledgeContextDelivery(deliveryId: string, at: number = Date.now()): boolean {
    try {
      const res = this.db.prepare(
        "UPDATE context_deliveries SET acknowledged_at=? WHERE delivery_id=? AND acknowledged_at IS NULL"
      ).run(at, deliveryId);
      return res.changes === 1;
    } catch (e) {
      console.error("[store] acknowledgeContextDelivery failed:", e);
      return false;
    }
  }

  /** Every delivery for one voice session, oldest first (idx_context_deliveries_session_ts).
   *  Fail-soft: an unexpected DB error yields an empty array (mirrors getContextInjections). */
  listContextDeliveries(sessionId: string): ContextDelivery[] {
    try {
      return (this.db.prepare(
        "SELECT * FROM context_deliveries WHERE voice_session_id=? ORDER BY ts ASC"
      ).all(sessionId) as ContextDeliveryRow[]).map(r => ({ ...r }));
    } catch (e) {
      console.error("[store] listContextDeliveries failed:", e);
      return [];
    }
  }

  /** All context-delivery rows since `since` (ts >=), most-recent-first, capped by `limit`
   *  (default 1000) — powers report-style aggregation across EVERY voice session (unlike
   *  `listContextDeliveries`, which is scoped to one session). Mirrors `getContextInjections`'
   *  shape/fail-soft contract (src/memory/contextMetricsReport.ts, Phase 2 Step 2.2). */
  getContextDeliveries(filter?: { since?: number; limit?: number }): ContextDelivery[] {
    const since = filter?.since ?? 0;
    const limit = filter?.limit ?? 1000;
    try {
      return (this.db.prepare(
        "SELECT * FROM context_deliveries WHERE ts >= ? ORDER BY ts DESC LIMIT ?"
      ).all(since, limit) as ContextDeliveryRow[]).map(r => ({ ...r }));
    } catch (e) {
      console.error("[store] getContextDeliveries failed:", e);
      return [];
    }
  }

  // ── transcripts (schema v13, bead 98f2 — durable transcript sink) ───────────────────────────────
  // OPT-IN observability: a transcript row is useful-but-not-critical (mirrors recordContextInjection/
  // insertContextDelivery's contract exactly) — a DB fault on the voice hot path must degrade, never
  // throw. The store does NOT redact: `text_redacted` is persisted VERBATIM — the caller
  // (src/transcripts/sink.ts) is the redaction boundary, exactly like exchange_events.

  /** Append one transcript row. Fail-soft: swallows + console.error on any DB error — a sink/store
   *  fault must never break the voice hot path that feeds it. */
  recordTranscript(input: {
    channel: "operator" | "model";
    text_redacted: string;
    session_id?: string | null;
    project_id?: string | null;
    pane_id?: string | null;
    interaction_id?: string | null;
    ts?: number;
  }): void {
    try {
      this.db.prepare(
        `INSERT INTO transcripts(ts,channel,session_id,project_id,pane_id,interaction_id,text_redacted)
         VALUES(@ts,@channel,@session_id,@project_id,@pane_id,@interaction_id,@text_redacted)`
      ).run({
        ts: input.ts ?? Date.now(),
        channel: input.channel,
        session_id: input.session_id ?? null,
        project_id: input.project_id ?? null,
        pane_id: input.pane_id ?? null,
        interaction_id: input.interaction_id ?? null,
        text_redacted: input.text_redacted,
      });
    } catch (e) {
      console.error("[store] recordTranscript failed:", e);
    }
  }

  /** Transcript rows since `sinceMs` (ts >=), oldest first (ts ASC, id tiebreak — mirrors
   *  `listExchangeEventsSince`'s ordering). Fail-soft: an unexpected DB error yields an empty array. */
  listTranscriptsSince(sinceMs: number, opts: { limit?: number } = {}): TranscriptRow[] {
    const limit = opts.limit ?? 1_000_000;
    try {
      return (this.db.prepare(
        "SELECT * FROM transcripts WHERE ts >= ? ORDER BY ts ASC, id ASC LIMIT ?"
      ).all(sinceMs, limit) as TranscriptRow[]).map(r => ({ ...r }));
    } catch (e) {
      console.error("[store] listTranscriptsSince failed:", e);
      return [];
    }
  }

  // ── turn-arbiter program T4 telemetry (schema v14) ──────────────────────────────────────────────
  // jump_over proves the arbiter's own steady-state invariant (post-arbiter: structurally zero
  // forced turns landing mid-answer/mid-utterance); arbiter_drain gives the drain-size distribution
  // the D2 headline+counted-tail policy is judged by. Both fail-soft BOTH ways (recordGeminiTurnUsage's
  // try/catch writer shape; getContextInjections' hardened-reader shape) — telemetry must never
  // throw into the live voice loop, and a closed handle must read as [].

  /** Append one jump-over row. Fail-soft: swallows + console.error on any DB error. */
  recordJumpOver(row: { ts: number; sessionId: string | null; producer: string | null; cls: number | null; detail: string | null }): void {
    try {
      this.db.prepare(
        `INSERT INTO jump_over(ts,session_id,producer,cls,detail) VALUES(@ts,@session_id,@producer,@cls,@detail)`
      ).run({ ts: row.ts, session_id: row.sessionId, producer: row.producer, cls: row.cls, detail: row.detail });
    } catch (e) {
      console.error("[store] recordJumpOver failed:", e);
    }
  }

  /** Read jump-over rows (most-recent-first) at or after `sinceTs`. Default limit 100. Fail-soft:
   *  an unexpected DB error (including a closed handle) degrades to []. */
  getJumpOvers(sinceTs: number, limit = 100): JumpOverRow[] {
    try {
      return this.db.prepare(
        `SELECT * FROM jump_over WHERE ts >= ? ORDER BY id DESC LIMIT ?`
      ).all(sinceTs, limit) as JumpOverRow[];
    } catch (e) {
      console.error("[store] getJumpOvers failed:", e);
      return [];
    }
  }

  /** Append one arbiter-drain row. `drainSize` === `1 + tailCount` is the CALLER's own invariant —
   *  this writer persists whatever it is handed. `delivered` is REQUIRED (schema v15, bead r59t) so
   *  no call site can silently omit the send verdict and re-create the over-count it fixes — the
   *  caller (sendArbiterDigest) writes its own `sent` local here. Fail-soft: swallows + console.error
   *  on any DB error. */
  recordArbiterDrain(row: { ts: number; sessionId: string | null; mode: string; headlineCls: number; drainSize: number; tailCount: number; delivered: boolean }): void {
    try {
      this.db.prepare(
        `INSERT INTO arbiter_drain(ts,session_id,mode,headline_cls,drain_size,tail_count,delivered)
         VALUES(@ts,@session_id,@mode,@headline_cls,@drain_size,@tail_count,@delivered)`
      ).run({
        ts: row.ts, session_id: row.sessionId, mode: row.mode,
        headline_cls: row.headlineCls, drain_size: row.drainSize, tail_count: row.tailCount,
        delivered: row.delivered ? 1 : 0,
      });
    } catch (e) {
      console.error("[store] recordArbiterDrain failed:", e);
    }
  }

  /** Read arbiter-drain rows (most-recent-first) at or after `sinceTs`. Default limit 100 — the
   *  drain-size distribution over these rows is the T4 analysis unit. Fail-soft: an unexpected DB
   *  error (including a closed handle) degrades to []. */
  getArbiterDrains(sinceTs: number, limit = 100): ArbiterDrainRow[] {
    try {
      return this.db.prepare(
        `SELECT * FROM arbiter_drain WHERE ts >= ? ORDER BY id DESC LIMIT ?`
      ).all(sinceTs, limit) as ArbiterDrainRow[];
    } catch (e) {
      console.error("[store] getArbiterDrains failed:", e);
      return [];
    }
  }
}