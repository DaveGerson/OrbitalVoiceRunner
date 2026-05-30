# SQLite Durable Store (WS-M) — Design Spec

> **Status:** Approved 2026-05-30. Supersedes the DRAFT scaffold in
> `src/store/sqliteStore.ts` and the open questions in
> `docs/review/IMPLEMENTATION_PLAN.md §WS-M`.
>
> **One-liner:** Replace the five scattered JSON/in-memory stores with a single
> `janus.db` whose spine is an append-only **event log** (the source of truth for
> *what happened*), paired with **current-state tables** upserted in the same
> transaction (parallel-write), made searchable via **FTS5**, pruned on boot, and
> wired in behind a thin `JanusStore` adapter that preserves the `Ledger` API.

---

## 1. Motivation

State today is fragmented and partly volatile (see
`docs/synthesis/current-technical-process.md §4`):

| Store | Today | Problem |
|---|---|---|
| `.janus_ledger.json` | workspaces, panes, watchRules, plans | whole-blob rewrite; single large object |
| `.janus_settings.json` | SystemSettings | whole-blob rewrite on any change |
| `.janus_history.json` | command outcomes | append use-case in a rewrite file; unbounded; **siloed from the ledger** (J4-G4) |
| `.janus_scrollback_<id>.log` | raw PTY scrollback | accumulates, never pruned, never read back |
| *in-memory only* | `pendingApprovals`, `promptBufferText`, `lastSessionResumptionToken`, `attentionQueue` | **lost on restart** — root cause of BUG-013 / BUG-014 |

There is no retention, no recoverable archive query, and no searchable interface
over past work.

## 2. Goals / Non-Goals

**Goals**
- One durable store; volatile in-flight state survives restart (closes BUG-013/BUG-014).
- An append-only event log as the authoritative record of *details* (every
  activity/submission performed).
- Current-state tables that always reflect "now" and are fast to read.
- A **searchable interface** over context and WIP (notes + events) via FTS5.
- Bounded growth via TTL pruning on boot.
- Drop-in via a thin adapter — `server.ts` swaps `Ledger` → `JanusStore`, not a rewrite.
- Lossless one-shot migration from the existing JSON files, reversible via `.bak`.

**Non-Goals (YAGNI)**
- No event-sourcing replay/reducer engine. State is updated directly (parallel-write),
  not reconstructed by replaying events.
- No scrollback in the DB — files stay on disk; the DB stores the path.
- No dedicated tables for plans/watchRules yet — JSON blobs in `kv` until query needs arise.
- No multi-process / multi-writer concurrency model — single server process, one writer.

## 3. Key Decisions (locked 2026-05-30)

| # | Decision | Choice |
|---|---|---|
| D1 | Storage engine | **better-sqlite3** (synchronous; matches existing atomic-write model) |
| D2 | Event log ↔ state coupling | **Parallel-write**: append event + upsert state in one transaction. No replay engine. Event log = searchable detail/audit truth; state tables = authoritative-on-read. |
| D3 | State posture | DB holds **current state** of the app + a searchable interface for context/WIP (not a full per-snapshot time series). |
| D4 | Notes | **Normalized `notes` table** (folds in WS-I typed `NoteEntry[]` now). |
| D5 | Scrollback | **Path reference** on disk + orphan-cleanup sweep. |
| D6 | Search | **FTS5** virtual tables over `events` + `notes`, synced by triggers. |
| D7 | Retention | **TTL prune on boot** — defaults: events 90 days, archive 30 days; configurable via `settings_kv`. |

## 4. Architecture

```
   every material activity (command relayed, approval decided, status flip,
   note, handoff, permission change, pane lifecycle, plan step)
                              │
                   recordActivity()  ── ONE db.transaction ──┐
                              │                               │
                   ┌─────────▼──────────┐          ┌──────────▼────────────┐
                   │  events (APPEND)   │          │  STATE TABLES (UPSERT) │
                   │  immutable, ts'd   │          │  "where things are now"│
                   └─────────┬──────────┘          └────────────────────────┘
                             │ triggers
                   ┌─────────▼─────────────────────┐
                   │ events_fts / notes_fts (FTS5)  │  ← searchable index
                   └────────────────────────────────┘
```

- **`events`** — the logbook. Never edited. Ordered by autoincrement `id`. Answers
  "what happened, when, in what order."
- **State tables** — the bridge board. Always reflect *now*; fast reads. Authoritative-on-read.
- **The discipline** — every writer goes through one `recordActivity(event, mutations)`
  helper wrapping the append + upserts in a single `db.transaction(...)`. Log and
  state commit together or not at all, so they can never disagree.

## 5. Schema

All DDL lives in `JanusStore.init()`, guarded by `PRAGMA user_version` migrations.
PRAGMAs at open: `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`.

### 5.1 Spine — `events`

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic order
  ts          INTEGER NOT NULL,                   -- epoch ms
  type        TEXT NOT NULL,                      -- see event types below
  project_id  TEXT,                               -- nullable
  pane_id     TEXT,                               -- nullable
  session_id  TEXT,                               -- nullable
  summary     TEXT NOT NULL DEFAULT '',           -- one-line, voice-readable, REDACTED
  payload     TEXT NOT NULL DEFAULT '{}'          -- JSON detail, REDACTED; shape varies by type
);
CREATE INDEX idx_events_project_ts ON events(project_id, ts);
CREATE INDEX idx_events_pane_ts    ON events(pane_id, ts);
CREATE INDEX idx_events_type_ts    ON events(type, ts);
```

**Event `type` vocabulary (initial):** `project_created`, `pane_created`,
`pane_archived`, `pane_restored`, `status_transition`, `command_proposed`,
`command_dispatched`, `command_outcome`, `approval_decided` (payload carries
`decision: approved|rejected|expired`), `permission_changed`, `note_added`,
`handoff`, `plan_step`.

> **Command history is folded into `events`** (`command_dispatched` /
> `command_outcome`, exit_code + summary in payload) — this removes today's
> history-vs-ledger silo. `get_pane_command_history` reads
> `events WHERE pane_id=? AND type IN ('command_dispatched','command_outcome')`.
>
> **Handoffs are events** (`type='handoff'`, payload `{ sourcePane, targetPane,
> contextNotes, lastCommands[] }`) — "show me the last handoff" is a filtered
> event query. No dedicated handoffs table.

### 5.2 Current state

**`projects`**
```sql
CREATE TABLE projects (
  id         TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  directory  TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  key_terms  TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**`panes`** (live) / **`panes_archive`** (same columns + `archived_at`, `archive_reason`)
```sql
CREATE TABLE panes (
  pane_id               TEXT NOT NULL,
  workspace_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL DEFAULT '',
  runtime_type          TEXT NOT NULL DEFAULT '',
  tool_preset           TEXT NOT NULL DEFAULT 'Custom',
  permissions_mode      TEXT NOT NULL DEFAULT 'Human-in-the-Loop',
  session_id            TEXT NOT NULL DEFAULT '',
  last_known_state      TEXT NOT NULL DEFAULT 'Idle',
  is_busy               INTEGER NOT NULL DEFAULT 0,
  alive                 INTEGER NOT NULL DEFAULT 0,
  context_size          INTEGER NOT NULL DEFAULT 0,
  last_status_change_at TEXT,                     -- ISO timestamp (WS-C)
  last_command          TEXT,
  scrollback_path       TEXT,                     -- absolute path to .janus_scrollback_*.log
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (pane_id, workspace_id)
);
-- panes_archive: same shape + archived_at INTEGER NOT NULL, archive_reason TEXT,
-- PRIMARY KEY (pane_id, workspace_id, archived_at)  -- re-archivable
```
*Note: `notes` column removed from both `projects` and `panes` — notes are now their own table (D4).*

**`notes`** (normalized, NEW — folds in WS-I)
```sql
CREATE TABLE notes (
  id         TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  pane_id    TEXT,                                -- NULL = project-scoped
  text       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'note',        -- decision|todo|warning|note|handoff
  author     TEXT NOT NULL DEFAULT 'user',        -- janus|user
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_notes_project ON notes(project_id);
CREATE INDEX idx_notes_pane    ON notes(pane_id);
CREATE INDEX idx_notes_type    ON notes(type);
```

**`pending_approvals`** (durable in-flight queue)
```sql
CREATE TABLE pending_approvals (
  id           TEXT PRIMARY KEY NOT NULL,         -- = messageId / call.id
  session_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  pane_id      TEXT NOT NULL,
  command      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'agent_instruction', -- agent_instruction|shell (WS-E)
  rationale    TEXT,                              -- JSON { trigger?, summary } or NULL
  claimed      INTEGER NOT NULL DEFAULT 0,        -- 0=open, 1=claimed (atomic-claim, N-1 gate)
  timestamp    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
```

**`attention`** (NEW — judgment call, see §9) — durable, dismissable WIP alerts
```sql
CREATE TABLE attention (
  id          TEXT PRIMARY KEY NOT NULL,
  type        TEXT NOT NULL,                      -- approval|exited|error|build-failed|confirmation
  terminal_id TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  message     TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  dismissed   INTEGER NOT NULL DEFAULT 0,
  details     TEXT                                -- JSON or NULL
);
```

**`settings_kv`** (replaces `.janus_settings.json`) — `key` (dot-path) → `value`, `updated_at`.

**`kv`** (generic scalar volatile) — keys: `activeProjectId`, `promptBufferText`,
`lastSessionResumptionToken`; plus `watchRules` and `plans` as JSON blobs (graduate
to tables only if querying is needed — YAGNI).

### 5.3 Search — FTS5

```sql
CREATE VIRTUAL TABLE events_fts USING fts5(summary, payload, content='events', content_rowid='id');
CREATE VIRTUAL TABLE notes_fts  USING fts5(text, content='notes', content_rowid='rowid');
```
Kept in sync by AFTER INSERT/UPDATE/DELETE triggers on `events` and `notes`. A single
`search(query, opts)` method queries both and returns ranked hits (bm25), tagged by
source, for "find the rate-limiting decision" / "what was I doing on the auth pane."

## 6. `JanusStore` surface

**Adapter (Ledger-compatible, lets `server.ts` swap not rewrite):**
`getWorkspaces`, `saveWorkspace`, `getPanes`, `savePane`, `archivePane`,
`restorePane`, `listArchived`, `addNote`/`addPaneNote`, `getProjectBriefing`,
`switchContext`, `getSettings`/`saveSettings`, `getKV`/`setKV`/`deleteKV`.

**New / additive:**
- `recordActivity(event, mutations)` — the transactional parallel-write helper (core discipline).
- `appendEvent(event)`, `getEvents(filter)` — timeline reads.
- `search(query, opts)` — FTS over events + notes.
- `getNotes(filter)`, `deleteNote(id)`, `amendNote(id, text)` — WS-I recall CRUD.
- `insertPendingApproval`, `claimApproval(id)` (atomic, N-1), `deletePendingApproval`,
  `getPendingApprovals(sessionId)`, `getExpiredApprovals(now)`.
- `getAttention`, `upsertAttention`, `dismissAttention`, `clearAttention`.
- `pruneOnBoot()` — TTL sweep (events, archive, orphaned scrollback files).
- `migrateFromJson(paths)` — one-shot import (see §8).
- `close()`.

## 7. Data flow & lifecycle

- **Write:** `recordActivity()` → transaction { append event; upsert state; FTS via triggers }.
- **Read (hot):** state tables directly. **Read (recall/WIP):** `search()` / `getEvents()`.
- **Boot:** open WAL + `foreign_keys=ON`; run pending migrations (`user_version`);
  `pruneOnBoot()` deletes events older than `EVENTS_TTL_DAYS` (default **90**),
  archive rows older than `ARCHIVE_TTL_DAYS` (default **30**), and orphaned
  scrollback `.log` files. Both TTLs configurable via `settings_kv`.
- **Restart recovery:** reload `pending_approvals` and re-announce (BUG-013); read
  `lastSessionResumptionToken` from `kv` with TTL check and replay to Gemini (BUG-014).
- **DB location:** `.janus.db` in CWD; override via `JANUS_DB_PATH`.
- **Schema versioning:** `PRAGMA user_version` + an ordered migrations array; each
  migration runs once inside a transaction.

## 8. Migration (one-shot, transactional, reversible)

1. **Read** `.janus_ledger.json` (→ `projects`, `panes`, `notes` rows;
   `watchRules`/`plans` → `kv` JSON), `.janus_settings.json` (→ `settings_kv`),
   `.janus_history.json` (→ `events` as `command_outcome`).
2. **Populate** all tables in **one transaction** (all-or-nothing). Seed a synthetic
   `migrated` event.
3. **Rename** originals to `.janus_*.json.bak` (atomic OS rename). **Not auto-deleted.**
4. **Switch** `server.ts` to instantiate `JanusStore`; the `Ledger` class stays intact
   until the migration is confirmed green.
5. **Rollback** = rename `.bak` files back.

String notes from the old ledger migrate as `notes` rows with `type='note'`,
`author='user'`.

## 9. Flagged judgment calls (deviations from the WS-M scaffold plan)

1. **`attention` as a table** (plan put `attentionQueue` in `kv`). A real table makes
   dismiss/restore survive restart and keeps alerts queryable as WIP context. **Accepted.**
2. **plans/watchRules as JSON blobs in `kv`** (not dedicated tables). YAGNI until we
   need to query them. **Accepted.**
3. **TTL defaults 90d events / 30d archive.** **Accepted**, configurable via settings.

## 10. Testing

- **Migration round-trip:** JSON → SQLite → export must diff clean (no data loss).
- **Parallel-write atomicity:** a failing state upsert rolls back the event append (both-or-neither).
- **Restart recovery:** `pending_approvals` restored + re-announced (BUG-013);
  `lastSessionResumptionToken` read from `kv` (BUG-014).
- **FTS search:** ranked, relevant hits over notes + events; negative test for noise.
- **TTL prune:** removes old events/archive, keeps recent, FTS stays consistent,
  orphaned scrollback logs removed (live ones kept).
- **Atomic claim:** concurrent REST + voice approve dispatches exactly once (N-1).
- **Adapter parity:** `JanusStore` satisfies the `Ledger` call sites `server.ts` uses.

Run: `npx tsx --test tests/*.ts`.

## 11. Acceptance criteria

- `src/store/sqliteStore.ts` compiles under `tsc --noEmit` with `better-sqlite3`
  installed (import un-`@ts-ignore`'d; dep added to `package.json`).
- Migration imports all three JSON files in one transaction with no data loss
  (round-trip test green).
- After migration + restart: pending approvals restored & re-announced; resumption
  token replayed.
- `search()` returns ranked results over notes + events.
- `pruneOnBoot()` enforces both TTLs and cleans orphaned scrollback.
- Every state-mutating path goes through `recordActivity()` (event + state never diverge).
- `server.ts` runs on `JanusStore` via the adapter; `.bak` files exist for rollback.

## 12. Out of scope / follow-ups

- Graduating plans/watchRules to dedicated tables (only if query needs emerge).
- Scrollback BLOB storage (revisit only if file-based WS-J search is a bottleneck).
- Cross-device sync / multi-writer concurrency.
