# src/store — SQLite Durable Store (Draft Scaffold)

## Status: INERT — not wired into the app

`sqliteStore.ts` is a **draft scaffold only**. It is not imported by `server.ts`, `ledger.ts`, or any other module in the production build. `better-sqlite3` is not yet listed in `package.json`. **Nothing here runs until the maintainer signs off on the schema (WS-M).**

---

## Why SQLite?

The app currently persists state across five file types:

| File | Content | Problems |
|---|---|---|
| `.janus_ledger.json` | Workspaces, panes, watch rules, plans | Single JSON blob; merge conflicts on concurrent writes (mitigated by atomic rename, but still a single large object) |
| `.janus_settings.json` | System settings | Same shape problem; any settings change rewrites the whole file |
| `.janus_history.json` | Command outcome history | Append-only use case in a rewrite file; grows unboundedly |
| `.janus_scrollback_<id>.log` | Raw PTY scrollback per pane | On-disk, fine to keep here; path reference in DB is enough |
| *(in-memory only)* | `pendingApprovals`, `promptBufferText`, `lastSessionResumptionToken`, `attentionQueue` | **Lost on restart** — root cause of BUG-013 and BUG-014 |

SQLite solves all of these with one well-understood primitive:

- **Atomic, consistent writes** — WAL mode gives safe concurrent reads without a write lock.
- **Structured queries** — no need to load the entire ledger blob to query history or pane state.
- **Durable volatile state** — `pending_approvals` and the `kv` table survive a server restart, fixing BUG-013/BUG-014.
- **Archive without clutter** — `panes_archive` replaces ad-hoc scrollback file accumulation.
- **Single file to backup / inspect** — `janus.db` instead of five scattered files.

`better-sqlite3` is chosen because it is **synchronous** — matching the existing ledger's atomic write model — and has zero native addon compilation on Node ≥ 18 (pre-built binaries via `@mapbox/node-pre-gyp`).

---

## Schema design is collaborative (WS-M)

The proposed tables and columns in `sqliteStore.ts::init()` are marked:

```sql
/* PROPOSED — pending maintainer review (WS-M) */
```

Before any migration runs, the maintainer must answer the open questions listed in `docs/review/IMPLEMENTATION_PLAN.md §WS-M`. Key open points:

1. **Notes as rows vs JSON blob** — keep `notes TEXT DEFAULT '[]'` on `projects`/`panes`, or normalise into a dedicated `notes` table (required for WS-I typed `NoteEntry[]`)?
2. **Archive retention / TTL** — how long should `panes_archive` rows live? Prune on startup, on explicit delete, or never?
3. **Scrollback in DB vs on disk** — store the raw PTY scrollback as a `BLOB` column, or keep the `.log` files and store only the path?

The implementation plan section (WS-M) has the full list.

---

## How the migration will work (outline)

1. On first startup after the package lands, `JanusStore.migrate()` (not yet written) will:
   - Read `.janus_ledger.json`, `.janus_settings.json`, `.janus_history.json`.
   - Populate the corresponding SQLite tables in a single transaction.
   - Write `.janus_ledger.json.bak`, `.janus_settings.json.bak`, `.janus_history.json.bak` as rollback copies.
2. `server.ts` switches its `Ledger` instantiation to use `JanusStore` (thin adapter layer, not a rewrite).
3. The old JSON files are **not deleted automatically** — the operator confirms the migration looks correct before removing them.

---

## Files

| File | Purpose |
|---|---|
| `sqliteStore.ts` | Draft `JanusStore` class with proposed schema DDL and stub methods |
| `README.md` | This file |
