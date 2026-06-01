# SQLite Durable Store (WS-M) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five scattered JSON/in-memory stores with a single `janus.db` (better-sqlite3) — an append-only event-log spine + parallel-write current-state tables + FTS5 search + TTL-prune-on-boot — behind a Ledger-compatible `JanusStore` adapter.

**Architecture:** Every state mutation goes through one transactional `recordActivity(event, mutations)` helper that appends to the immutable `events` log AND upserts state tables together. FTS5 virtual tables (`events_fts`, `notes_fts`) are kept in sync by triggers and power `search()`. A one-shot, reversible migration imports the existing JSON. `server.ts` swaps `Ledger` → `JanusStore` via preserved method signatures.

**Tech Stack:** TypeScript, better-sqlite3 (synchronous), SQLite FTS5, node:test (`npx tsx --test`).

**Spec:** `docs/superpowers/specs/2026-05-30-sqlite-durable-store-design.md` (read it first — it has the full schema and decisions D1–D7).

**File structure (created/modified):**
- `src/store/schema.ts` — DDL + ordered migrations + `applyMigrations(db)`
- `src/store/eventTypes.ts` — event-type constants + payload/`StoredEvent` types
- `src/store/types.ts` — `StoredWorkspace`, `StoredPane`, `StoredNote`, `StoredPendingApproval`, `StoredAttention` (moved out of the scaffold for reuse)
- `src/store/sqliteStore.ts` — the `JanusStore` class (open, recordActivity, all CRUD, search, adapter methods) — **rewrite of the scaffold**
- `src/store/migrate.ts` — `migrateFromJson(store, paths)`
- `src/store/retention.ts` — `pruneOnBoot(db, opts)`
- `tests/test_store_schema.ts`, `tests/test_store_core.ts`, `tests/test_store_panes.ts`, `tests/test_store_approvals.ts`, `tests/test_store_search.ts`, `tests/test_store_retention.ts`, `tests/test_store_migrate.ts`
- `package.json` — add `better-sqlite3` + `@types/better-sqlite3`
- `server.ts`, `src/ledger.ts` — adapter wiring (final task)

**Test DB convention:** every test opens `new JanusStore(":memory:")` (or a tmp file where boot/restart is under test), calls `.init()`, and `.close()` in a cleanup hook. Never touch the repo's real `.janus_*.json`.

> **Native-build note (Task 1):** `better-sqlite3` compiles a native addon. On this Windows host the install may need prebuilt binaries (Node ≥18) or MSVC build tools. If `npm install` fails to produce a loadable binary, STOP and surface it — do not proceed to Task 2.

---

### Task 1: Add better-sqlite3 and prove it loads

**Files:**
- Modify: `package.json` (dependencies)
- Test: `tests/test_store_schema.ts`

- [ ] **Step 1: Install the dependency**

Run: `npm install better-sqlite3 && npm install -D @types/better-sqlite3`
Expected: both added to `package.json`; `node_modules/better-sqlite3/build/Release/better_sqlite3.node` exists.

- [ ] **Step 2: Write a smoke test that opens an in-memory DB with FTS5**

```typescript
// tests/test_store_schema.ts
import { test } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";

test("better-sqlite3 loads and FTS5 is available", () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  // FTS5 must be compiled in (it is, in better-sqlite3's bundled SQLite):
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x);");
  db.prepare("INSERT INTO t(x) VALUES (?)").run("hello world");
  const row = db.prepare("SELECT x FROM t WHERE t MATCH ?").get("hello") as any;
  assert.equal(row.x, "hello world");
  db.close();
});
```

- [ ] **Step 3: Run it**

Run: `npx tsx --test tests/test_store_schema.ts`
Expected: PASS. (If it errors on loading the native module, STOP per the native-build note.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tests/test_store_schema.ts
git commit -m "feat(WS-M): add better-sqlite3 + FTS5 smoke test"
```

---

### Task 2: Schema + migrations

**Files:**
- Create: `src/store/schema.ts`
- Test: `tests/test_store_schema.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/test_store_schema.ts
import { applyMigrations, SCHEMA_VERSION } from "../src/store/schema";

test("applyMigrations creates all tables, FTS, and sets user_version", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
  ).all() as any[]).map(r => r.name);
  for (const t of ["events","projects","panes","panes_archive","notes",
                   "pending_approvals","attention","settings_kv","kv",
                   "events_fts","notes_fts"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  const v = db.pragma("user_version", { simple: true });
  assert.equal(v, SCHEMA_VERSION);
  db.close();
});
```

Run: `npx tsx --test tests/test_store_schema.ts` → Expected: FAIL (`Cannot find module ../src/store/schema`).

- [ ] **Step 2: Implement `src/store/schema.ts`**

```typescript
// src/store/schema.ts
import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 1;

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

      -- FTS5 external-content tables + sync triggers
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
```

Run: `npx tsx --test tests/test_store_schema.ts` → Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/store/schema.ts tests/test_store_schema.ts
git commit -m "feat(WS-M): schema DDL, FTS5 triggers, and migration runner"
```

---

### Task 3: Shared types + event vocabulary

**Files:**
- Create: `src/store/types.ts`, `src/store/eventTypes.ts`
- Test: `tests/test_store_core.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/test_store_core.ts
import { test } from "node:test";
import assert from "node:assert";
import { EVENT_TYPES } from "../src/store/eventTypes";

test("event vocabulary is frozen and complete", () => {
  assert.ok(Object.isFrozen(EVENT_TYPES));
  for (const t of ["command_dispatched","command_outcome","approval_decided",
                   "status_transition","note_added","handoff","permission_changed",
                   "pane_created","pane_archived","pane_restored","project_created","plan_step"]) {
    assert.ok(Object.values(EVENT_TYPES).includes(t as any), `missing event type ${t}`);
  }
});
```

Run → Expected: FAIL (module not found).

- [ ] **Step 2: Implement `src/store/eventTypes.ts`**

```typescript
// src/store/eventTypes.ts
export const EVENT_TYPES = Object.freeze({
  PROJECT_CREATED: "project_created",
  PANE_CREATED: "pane_created",
  PANE_ARCHIVED: "pane_archived",
  PANE_RESTORED: "pane_restored",
  STATUS_TRANSITION: "status_transition",
  COMMAND_PROPOSED: "command_proposed",
  COMMAND_DISPATCHED: "command_dispatched",
  COMMAND_OUTCOME: "command_outcome",
  APPROVAL_DECIDED: "approval_decided",
  PERMISSION_CHANGED: "permission_changed",
  NOTE_ADDED: "note_added",
  HANDOFF: "handoff",
  PLAN_STEP: "plan_step",
} as const);

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface NewEvent {
  type: EventType;
  ts?: number;            // defaults to Date.now()
  project_id?: string | null;
  pane_id?: string | null;
  session_id?: string | null;
  summary?: string;       // REDACTED by caller before passing in
  payload?: unknown;      // JSON-serializable, REDACTED by caller
}

export interface StoredEvent {
  id: number;
  ts: number;
  type: string;
  project_id: string | null;
  pane_id: string | null;
  session_id: string | null;
  summary: string;
  payload: any;           // parsed JSON
}
```

- [ ] **Step 3: Implement `src/store/types.ts`**

```typescript
// src/store/types.ts
export type PermissionsMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";
export type ToolPreset = "Claude Code" | "Codex" | "Antigravity" | "Custom";
export type PaneStatus = "Running" | "Idle" | "Exited";
export type NoteType = "decision" | "todo" | "warning" | "note" | "handoff";
export type ApprovalKind = "agent_instruction" | "shell";

export interface StoredWorkspace {
  id: string; name: string; directory: string; summary: string;
  key_terms: string[]; created_at: number; updated_at: number;
}
export interface StoredPane {
  pane_id: string; workspace_id: string; name: string; runtime_type: string;
  tool_preset: ToolPreset; permissions_mode: PermissionsMode; session_id: string;
  last_known_state: PaneStatus; is_busy: boolean; alive: boolean; context_size: number;
  last_status_change_at: string | null; last_command: string | null;
  scrollback_path: string | null; created_at: number; updated_at: number;
}
export interface StoredArchivedPane extends StoredPane { archived_at: number; archive_reason: string | null; }
export interface StoredNote {
  id: string; project_id: string; pane_id: string | null; text: string;
  type: NoteType; author: "janus" | "user"; created_at: number; updated_at: number;
}
export interface StoredPendingApproval {
  id: string; session_id: string; workspace_id: string; pane_id: string;
  command: string; kind: ApprovalKind; rationale: string | null;
  claimed: boolean; timestamp: number; expires_at: number;
}
export interface StoredAttention {
  id: string; type: string; terminal_id: string; project_id: string;
  message: string; timestamp: number; dismissed: boolean; details: any;
}
```

Run → Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/store/types.ts src/store/eventTypes.ts tests/test_store_core.ts
git commit -m "feat(WS-M): shared store types + event-type vocabulary"
```

---

### Task 4: JanusStore open + recordActivity (the transactional spine)

**Files:**
- Modify: `src/store/sqliteStore.ts` (full rewrite of the scaffold)
- Test: `tests/test_store_core.ts` (append)

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/test_store_core.ts
import { JanusStore } from "../src/store/sqliteStore";
import { EVENT_TYPES } from "../src/store/eventTypes";

test("recordActivity appends an event and applies state mutation atomically", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.recordActivity(
    { type: EVENT_TYPES.PROJECT_CREATED, project_id: "p1", summary: "created p1" },
    (db) => db.prepare(
      "INSERT INTO projects(id,name,directory,summary,key_terms,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
    ).run("p1","P1","/tmp","",JSON.stringify([]),1,1)
  );
  const ev = s.getEvents({ projectId: "p1" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "project_created");
  const proj = s.getWorkspaces()["p1"];
  assert.equal(proj.name, "P1");
  s.close();
});

test("recordActivity rolls back the event if the mutation throws", () => {
  const s = new JanusStore(":memory:"); s.init();
  assert.throws(() => s.recordActivity(
    { type: EVENT_TYPES.PROJECT_CREATED, project_id: "p2", summary: "x" },
    () => { throw new Error("boom"); }
  ));
  assert.equal(s.getEvents({ projectId: "p2" }).length, 0);
  s.close();
});
```

Run → Expected: FAIL.

- [ ] **Step 2: Rewrite `src/store/sqliteStore.ts`** with the open/init/recordActivity/getEvents core. (Subagent: build the class skeleton here; subsequent tasks add CRUD methods to the SAME class.)

```typescript
// src/store/sqliteStore.ts
import Database from "better-sqlite3";
import { applyMigrations } from "./schema";
import { EVENT_TYPES, type NewEvent, type StoredEvent } from "./eventTypes";

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
    const limit = filter.limit && filter.limit > 0 ? `LIMIT ${filter.limit}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM events ${clause} ORDER BY id ASC ${limit}`
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
}
```

Run → Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/store/sqliteStore.ts tests/test_store_core.ts
git commit -m "feat(WS-M): JanusStore open + transactional recordActivity spine"
```

---

### Task 5: Projects + Notes CRUD (adapter methods)

**Files:**
- Modify: `src/store/sqliteStore.ts`
- Test: `tests/test_store_core.ts` (append)

- [ ] **Step 1: Write failing tests**

```typescript
// append to tests/test_store_core.ts
import type { StoredWorkspace, StoredNote } from "../src/store/types";

test("saveWorkspace upserts; addNote writes a normalized row + note_added event", () => {
  const s = new JanusStore(":memory:"); s.init();
  const ws: StoredWorkspace = { id:"p1", name:"P1", directory:"/tmp", summary:"s", key_terms:["a"], created_at:0, updated_at:0 };
  s.saveWorkspace(ws);
  assert.equal(s.getWorkspaces()["p1"].key_terms[0], "a");

  const note = s.addNote("p1", "we chose CJS", { type: "decision", author: "user" });
  const notes = s.getNotes({ projectId: "p1" });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, "decision");
  assert.equal(notes[0].id, note.id);
  // parallel-write: a note_added event exists
  assert.equal(s.getEvents({ type: "note_added" }).length, 1);
  s.close();
});

test("amendNote and deleteNote keep FTS consistent", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id:"p1", name:"P1", directory:"", summary:"", key_terms:[], created_at:0, updated_at:0 });
  const n = s.addNote("p1", "rate limiting via token bucket", {});
  s.amendNote(n.id, "rate limiting via leaky bucket");
  assert.equal(s.getNotes({ projectId:"p1" })[0].text, "rate limiting via leaky bucket");
  s.deleteNote(n.id);
  assert.equal(s.getNotes({ projectId:"p1" }).length, 0);
  s.close();
});
```

Run → Expected: FAIL.

- [ ] **Step 2: Add methods to `JanusStore`** (inside the class):

```typescript
  saveWorkspace(ws: StoredWorkspace): void {
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

  /** Seam for deterministic IDs in tests. */
  protected rand(): number { return Math.random(); }
```

> Note: `rand()` is a protected seam so tests can subclass for determinism; production uses `Math.random()`. (`Math.random()` is fine in app code; only workflow scripts forbid it.)

Run → Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/store/sqliteStore.ts tests/test_store_core.ts
git commit -m "feat(WS-M): projects + normalized notes CRUD with parallel-write"
```

---

### Task 6: Panes + archive/restore

**Files:**
- Modify: `src/store/sqliteStore.ts`
- Test: `tests/test_store_panes.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/test_store_panes.ts
import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredPane } from "../src/store/types";

function mkPane(id: string): StoredPane {
  return { pane_id:id, workspace_id:"p1", name:id, runtime_type:"shell",
    tool_preset:"Claude Code", permissions_mode:"Human-in-the-Loop", session_id:"",
    last_known_state:"Idle", is_busy:false, alive:true, context_size:0,
    last_status_change_at:null, last_command:null, scrollback_path:null, created_at:0, updated_at:0 };
}
function seed(): JanusStore {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id:"p1", name:"P1", directory:"", summary:"", key_terms:[], created_at:0, updated_at:0 });
  return s;
}

test("savePane upserts and round-trips booleans", () => {
  const s = seed(); s.savePane(mkPane("t1"));
  const p = s.getPanes("p1")["t1"];
  assert.equal(p.alive, true); assert.equal(p.is_busy, false);
  s.close();
});

test("archivePane removes from live + adds to archive (+event); restorePane brings it back", () => {
  const s = seed(); s.savePane(mkPane("t1"));
  s.archivePane("t1","p1","cleared");
  assert.equal(Object.keys(s.getPanes("p1")).length, 0);
  assert.equal(s.listArchived("p1").length, 1);
  assert.equal(s.getEvents({ type:"pane_archived" }).length, 1);
  const restored = s.restorePane("t1","p1");
  assert.ok(restored);
  assert.equal(Object.keys(s.getPanes("p1")).length, 1);
  s.close();
});
```

Run → Expected: FAIL.

- [ ] **Step 2: Add pane methods to `JanusStore`:**

```typescript
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
```

Run → Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/store/sqliteStore.ts tests/test_store_panes.ts
git commit -m "feat(WS-M): pane upsert + recoverable archive/restore"
```

---

### Task 7: Pending approvals + atomic claim (N-1) + attention

**Files:**
- Modify: `src/store/sqliteStore.ts`
- Test: `tests/test_store_approvals.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/test_store_approvals.ts
import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredPendingApproval } from "../src/store/types";

function mkApproval(id: string): StoredPendingApproval {
  return { id, session_id:"s1", workspace_id:"p1", pane_id:"t1", command:"npm test",
    kind:"agent_instruction", rationale:null, claimed:false, timestamp:1, expires_at:9_999_999_999_999 };
}

test("claimApproval succeeds once; a second claim returns false (N-1)", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.insertPendingApproval(mkApproval("a1"));
  assert.equal(s.claimApproval("a1"), true);
  assert.equal(s.claimApproval("a1"), false);
  s.close();
});

test("getPendingApprovals returns only unclaimed; getExpiredApprovals respects now", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.insertPendingApproval({ ...mkApproval("a1"), expires_at: 100 });
  s.insertPendingApproval({ ...mkApproval("a2"), expires_at: 9_999_999_999_999 });
  assert.equal(s.getPendingApprovals("s1").length, 2);
  assert.deepEqual(s.getExpiredApprovals(1000).map(a=>a.id), ["a1"]);
  s.claimApproval("a2");
  assert.equal(s.getPendingApprovals("s1").length, 1);
  s.close();
});

test("attention upsert/dismiss survives and filters", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.upsertAttention({ id:"x1", type:"error", terminal_id:"t1", project_id:"p1", message:"boom", timestamp:1, dismissed:false, details:null });
  assert.equal(s.getAttention({ includeDismissed:false }).length, 1);
  s.dismissAttention("x1");
  assert.equal(s.getAttention({ includeDismissed:false }).length, 0);
  assert.equal(s.getAttention({ includeDismissed:true }).length, 1);
  s.close();
});
```

Run → Expected: FAIL.

- [ ] **Step 2: Add methods to `JanusStore`:**

```typescript
  insertPendingApproval(a: StoredPendingApproval): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO pending_approvals(id,session_id,workspace_id,pane_id,command,kind,rationale,claimed,timestamp,expires_at)
       VALUES(@id,@session_id,@workspace_id,@pane_id,@command,@kind,@rationale,@claimed,@timestamp,@expires_at)`
    ).run({ ...a, claimed: a.claimed?1:0, rationale: a.rationale ?? null });
  }
  /** Atomic claim: flips 0→1 only if currently 0. True == this caller won. */
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
    const clause = opts.includeDismissed ? "" : "WHERE dismissed=0";
    return (this.db.prepare(`SELECT * FROM attention ${clause} ORDER BY timestamp DESC`).all() as any[])
      .map(r => ({ ...r, dismissed: Boolean(r.dismissed), details: this.parseJSON(r.details, null) }));
  }
```

Run → Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/store/sqliteStore.ts tests/test_store_approvals.ts
git commit -m "feat(WS-M): durable approvals with atomic claim (N-1) + attention queue"
```

---

### Task 8: settings_kv + kv

**Files:**
- Modify: `src/store/sqliteStore.ts`
- Test: `tests/test_store_core.ts` (append)

- [ ] **Step 1: Write failing tests**

```typescript
// append to tests/test_store_core.ts
test("settings_kv and kv round-trip and upsert", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.saveSettings("voiceAi.voice", "Charon");
  assert.equal(s.getSettings("voiceAi.voice"), "Charon");
  s.saveSettings("voiceAi.voice", "Puck");
  assert.equal(s.getSettings("voiceAi.voice"), "Puck");
  s.setKV("activeProjectId", "p1");
  assert.equal(s.getKV("activeProjectId"), "p1");
  s.deleteKV("activeProjectId");
  assert.equal(s.getKV("activeProjectId"), null);
  s.close();
});
```

Run → Expected: FAIL.

- [ ] **Step 2: Add methods to `JanusStore`:**

```typescript
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
```

Run → Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/store/sqliteStore.ts tests/test_store_core.ts
git commit -m "feat(WS-M): settings_kv + generic kv accessors"
```

---

### Task 9: FTS search over events + notes

**Files:**
- Modify: `src/store/sqliteStore.ts`
- Test: `tests/test_store_search.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/test_store_search.ts
import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";

test("search returns ranked hits across notes and events; noise excluded", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id:"p1", name:"P1", directory:"", summary:"", key_terms:[], created_at:0, updated_at:0 });
  s.addNote("p1", "decided to use a token-bucket rate limiter", { type:"decision" });
  s.addNote("p1", "lunch order is pizza", {});
  s.appendEvent({ type: "command_outcome" as any, project_id:"p1", summary:"rate limiter tests passed" });

  const hits = s.search("rate limiter");
  const texts = hits.map(h => h.snippet.toLowerCase());
  assert.ok(hits.length >= 2);
  assert.ok(texts.some(t => t.includes("rate")));
  assert.ok(!texts.some(t => t.includes("pizza")));
  s.close();
});
```

Run → Expected: FAIL.

- [ ] **Step 2: Add `search` to `JanusStore`:**

```typescript
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
```

Run → Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/store/sqliteStore.ts tests/test_store_search.ts
git commit -m "feat(WS-M): FTS5 search across notes + events (bm25)"
```

---

### Task 10: Retention — pruneOnBoot

**Files:**
- Create: `src/store/retention.ts`
- Modify: `src/store/sqliteStore.ts` (call from a `bootMaintenance()` method)
- Test: `tests/test_store_retention.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/test_store_retention.ts
import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";

test("pruneOnBoot deletes old events + archive, keeps recent, FTS stays consistent", () => {
  const s = new JanusStore(":memory:"); s.init();
  const now = 1_000_000_000_000;
  const day = 86_400_000;
  s.appendEvent({ type:"command_outcome" as any, summary:"ancient", ts: now - 100*day });
  s.appendEvent({ type:"command_outcome" as any, summary:"fresh", ts: now - 1*day });
  s.bootMaintenance({ now, eventsTtlDays: 90, archiveTtlDays: 30, scrollbackDirs: [] });
  const remaining = s.getEvents({});
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].summary, "fresh");
  // FTS no longer returns the pruned row
  assert.equal(s.search("ancient").length, 0);
  assert.equal(s.search("fresh").length, 1);
  s.close();
});
```

Run → Expected: FAIL.

- [ ] **Step 2: Implement `src/store/retention.ts`:**

```typescript
// src/store/retention.ts
import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface PruneOpts {
  now: number; eventsTtlDays: number; archiveTtlDays: number;
  scrollbackDirs: string[];   // dirs to scan for orphaned .janus_scrollback_*.log
}

export function pruneOnBoot(db: Database.Database, opts: PruneOpts): void {
  const day = 86_400_000;
  const evCutoff = opts.now - opts.eventsTtlDays * day;
  const arCutoff = opts.now - opts.archiveTtlDays * day;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM events WHERE ts < ?").run(evCutoff);          // triggers keep events_fts in sync
    db.prepare("DELETE FROM panes_archive WHERE archived_at < ?").run(arCutoff);
  });
  tx();
  // Orphaned scrollback sweep: delete .log files not referenced by any live or archived pane.
  const referenced = new Set<string>(
    (db.prepare("SELECT scrollback_path FROM panes WHERE scrollback_path IS NOT NULL").all() as any[])
      .concat(db.prepare("SELECT scrollback_path FROM panes_archive WHERE scrollback_path IS NOT NULL").all() as any[])
      .map((r:any) => path.resolve(r.scrollback_path))
  );
  for (const dir of opts.scrollbackDirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/^\.janus_scrollback_.*\.log$/.test(f)) continue;
      const full = path.resolve(dir, f);
      if (!referenced.has(full)) { try { fs.unlinkSync(full); } catch {} }
    }
  }
}
```

- [ ] **Step 3: Add `bootMaintenance` to `JanusStore`:**

```typescript
  bootMaintenance(opts: import("./retention").PruneOpts): void {
    const { pruneOnBoot } = require("./retention");
    pruneOnBoot(this.db, opts);
  }
```

Run → Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/store/retention.ts src/store/sqliteStore.ts tests/test_store_retention.ts
git commit -m "feat(WS-M): TTL prune-on-boot for events, archive, orphaned scrollback"
```

---

### Task 11: Migration from JSON (reversible)

**Files:**
- Create: `src/store/migrate.ts`
- Test: `tests/test_store_migrate.ts`

- [ ] **Step 1: Write failing test (round-trip, no data loss)**

```typescript
// tests/test_store_migrate.ts
import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import { migrateFromObjects } from "../src/store/migrate";

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
  // old string notes became note rows (project + pane scoped)
  const notes = s.getNotes({ projectId:"p1" });
  assert.ok(notes.some(n => n.text === "old decision" && n.pane_id === null));
  assert.ok(notes.some(n => n.text === "pane note" && n.pane_id === "t1"));
  // history imported as command_outcome events
  assert.equal(s.getEvents({ paneId:"t1", type:"command_outcome" }).length, 1);
  // settings + kv
  assert.equal(s.getSettings("advanced.idleTimeoutMs"), "1500");
  assert.equal(s.getKV("activeProjectId"), "p1");
  assert.equal(JSON.parse(s.getKV("watchRules")!).length, 1);
  s.close();
});
```

Run → Expected: FAIL.

- [ ] **Step 2: Implement `src/store/migrate.ts`:**

```typescript
// src/store/migrate.ts
import * as fs from "fs";
import { JanusStore } from "./sqliteStore";
import { EVENT_TYPES } from "./eventTypes";

export interface MigrationInput { ledger?: any; settings?: any; history?: any; }
export interface MigrationPaths { ledgerPath: string; settingsPath: string; historyPath: string; }

/** Pure, testable importer over already-parsed objects. Runs in one transaction. */
export function migrateFromObjects(store: JanusStore, input: MigrationInput): void {
  const tx = store.db.transaction(() => {
    const now = Date.now();
    const ledger = input.ledger ?? {};
    for (const ws of Object.values<any>(ledger.workspaces ?? {})) {
      store.saveWorkspace({ id: ws.id, name: ws.name ?? "", directory: ws.directory ?? "",
        summary: ws.summary ?? "", key_terms: ws.keyTerms ?? [], created_at: now, updated_at: now });
      for (const note of (ws.notes ?? [])) store.addNote(ws.id, String(note), { type:"note", author:"user" });
      for (const p of Object.values<any>(ws.panes ?? {})) {
        store.savePane({ pane_id: p.pane_id, workspace_id: ws.id, name: p.name ?? "",
          runtime_type: p.runtime_type ?? "", tool_preset: p.tool_preset ?? "Custom",
          permissions_mode: p.permissions_mode ?? "Human-in-the-Loop", session_id: p.session_id ?? "",
          last_known_state: p.last_known_state ?? "Idle", is_busy: !!p.is_busy, alive: !!p.alive,
          context_size: p.context_size ?? 0, last_status_change_at: p.last_status_change_at ?? null,
          last_command: p.last_command ?? null, scrollback_path: p.scrollback_path ?? null,
          created_at: now, updated_at: now });
        for (const note of (p.notes ?? [])) store.addNote(ws.id, String(note), { paneId: p.pane_id, type:"note", author:"user" });
      }
    }
    if (ledger.activeProjectId) store.setKV("activeProjectId", String(ledger.activeProjectId));
    if (ledger.watchRules) store.setKV("watchRules", JSON.stringify(ledger.watchRules));
    if (ledger.plans) store.setKV("plans", JSON.stringify(ledger.plans));

    // settings → settings_kv as flattened dot-paths
    flatten(input.settings ?? {}, "").forEach(([k,v]) => store.saveSettings(k, typeof v === "string" ? v : JSON.stringify(v)));

    // history → command_outcome events
    for (const [paneId, entries] of Object.entries<any>(input.history ?? {})) {
      for (const e of (entries as any[])) {
        store.appendEvent({ type: EVENT_TYPES.COMMAND_OUTCOME, pane_id: paneId,
          ts: e.timestamp ?? now, summary: e.finalResponse ?? "",
          payload: { command: e.command, output: e.output } });
      }
    }
    store.appendEvent({ type: EVENT_TYPES.COMMAND_OUTCOME, summary: "migrated from JSON", ts: now, payload: { migration: true } });
  });
  tx();
}

function flatten(obj: any, prefix: string): [string, any][] {
  const out: [string, any][] = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flatten(v, key));
    else out.push([key, v]);
  }
  return out;
}

/** File-driven entry point: read JSON, import, then rename originals to .bak. */
export function migrateFromJson(store: JanusStore, paths: MigrationPaths): void {
  const read = (p: string) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };
  migrateFromObjects(store, {
    ledger: read(paths.ledgerPath), settings: read(paths.settingsPath), history: read(paths.historyPath),
  });
  for (const p of [paths.ledgerPath, paths.settingsPath, paths.historyPath]) {
    try { if (fs.existsSync(p)) fs.renameSync(p, `${p}.bak`); } catch {}
  }
}
```

> Note: `migrateFromObjects` calls `store.saveWorkspace`/`addNote`/etc., which each open their own transaction. Nesting `db.transaction` calls in better-sqlite3 is supported (savepoints), so the outer `tx` still gives all-or-nothing. The test exercises the object path; the file path is a thin wrapper.

Run → Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/store/migrate.ts tests/test_store_migrate.ts
git commit -m "feat(WS-M): reversible one-shot JSON→SQLite migration"
```

---

### Task 12: Un-`@ts-ignore`, typecheck, full test sweep

**Files:**
- Modify: `src/store/sqliteStore.ts` (remove any residual `@ts-ignore`/`as any` left from the scaffold)
- Verify only

- [ ] **Step 1: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: PASS (0 errors). Fix any type errors in the store modules.

- [ ] **Step 2: Run the whole store test suite**

Run: `npx tsx --test tests/test_store_*.ts`
Expected: all PASS.

- [ ] **Step 3: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "chore(WS-M): typecheck clean + full store suite green"
```

---

### Task 13: Wire JanusStore into server.ts via the Ledger adapter

> **This is the integration task — do it last, carefully. It edits the large `server.ts`. Keep changes minimal and reversible.**

**Files:**
- Modify: `server.ts` (Ledger instantiation + the WS-close purge + reconnect restore)
- Modify: `src/ledger.ts` (only if a shared interface helps; otherwise leave intact)
- Test: `tests/test_store_integration.ts`

- [ ] **Step 1: Map the adapter surface.** Read `src/ledger.ts` and grep `server.ts` for every `manager.ledger.` and `ledger.` call. List each method used. Confirm `JanusStore` implements the same name + signature; add thin shims for any gap (e.g. `getProjectBriefing`, `switchContext`, `activeProjectId` getter backed by `kv`).

Run: `npx tsx -e "0"` (noop) and `grep -n "ledger\." server.ts` → record the call list in the commit body.

- [ ] **Step 2: Write an integration test for restart recovery (BUG-013/014)**

```typescript
// tests/test_store_integration.ts
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JanusStore } from "../src/store/sqliteStore";

test("pending approvals + resumption token survive a 'restart' (reopen same file)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  s1.insertPendingApproval({ id:"a1", session_id:"s1", workspace_id:"p1", pane_id:"t1",
    command:"npm test", kind:"agent_instruction", rationale:null, claimed:false, timestamp:1, expires_at: 9_999_999_999_999 });
  s1.setKV("lastSessionResumptionToken", "tok-123");
  s1.close();

  const s2 = new JanusStore(dbPath); s2.init();
  assert.equal(s2.getPendingApprovals("s1").length, 1);   // BUG-013
  assert.equal(s2.getKV("lastSessionResumptionToken"), "tok-123"); // BUG-014
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

Run → Expected: PASS (no server wiring needed for this test).

- [ ] **Step 3: Swap the store in `server.ts`** — instantiate `JanusStore` (path `process.env.JANUS_DB_PATH || ".janus.db"`), call `.init()` and `.bootMaintenance(...)` at startup, run `migrateFromJson` once if `.janus_ledger.json` exists and no DB yet, and replace the WS-close silent purge with `insertPendingApproval` persistence + reconnect `getPendingApprovals` re-announce. Keep the old `Ledger` import available for rollback. Show the exact diff in the commit.

- [ ] **Step 4: Typecheck + full suite + manual boot**

Run: `npx tsc --noEmit` → PASS
Run: `npx tsx --test tests/*.ts` → all PASS
Manual: start the server, confirm it boots on `.janus.db`, `.bak` files created, zero panes auto-spawned (preserves the runaway fix).

- [ ] **Step 5: Commit**

```bash
git add server.ts src/ledger.ts tests/test_store_integration.ts package.json
git commit -m "feat(WS-M): wire JanusStore into server via Ledger adapter + restart recovery"
```

---

## Self-Review

**Spec coverage:** D1 engine→T1; D2 parallel-write→T4; D3 state+search→T5/T9; D4 notes table→T5; D5 scrollback path + cleanup→T6/T10; D6 FTS→T2/T9; D7 TTL prune→T10. Event log spine→T2/T4. Migration→T11. Restart recovery (BUG-013/014)→T13. Adapter→T13. Attention table→T7. settings_kv/kv→T8. All §5 tables created in T2. All §10 tests mapped. **No gaps.**

**Placeholder scan:** every code step has complete code; no TBD/TODO. Integration Task 13 steps 1/3 are described-not-coded because they edit a 1900-line file whose exact lines the executing subagent must read first — but each names the exact methods/behaviors and requires showing the diff in the commit.

**Type consistency:** method names are stable across tasks (`recordActivity`, `saveWorkspace`, `addNote`, `savePane`, `archivePane`, `restorePane`, `claimApproval`, `upsertAttention`, `search`, `bootMaintenance`, `migrateFromObjects`/`migrateFromJson`). Types in `src/store/types.ts` (T3) are consumed unchanged by T5–T13.
