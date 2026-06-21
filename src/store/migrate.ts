// src/store/migrate.ts
import * as fs from "fs";
import { JanusStore } from "./sqliteStore";
import { EVENT_TYPES } from "./eventTypes";

export interface MigrationInput { ledger?: any; settings?: any; history?: any; }
export interface MigrationPaths { ledgerPath: string; settingsPath: string; historyPath: string; }

/** kv marker recording that the one-shot JSON→SQLite ledger import has run.
 *  Gating on this (not on .janus.db existence) keeps the migration idempotent —
 *  the handoff store already creates .janus.db before the ledger is imported. */
export const LEDGER_MIGRATED_KEY = "ledgerMigratedAt";

/**
 * Boot-time, gated, idempotent migration. Imports the legacy JSON ledger into
 * `store` and archives the ledger + history originals to `.bak` (the settings JSON
 * is preserved in place — bug ahm) — but only once, and only if a legacy ledger
 * file actually exists. Returns true iff it performed the import.
 *
 * The gate is the in-DB `LEDGER_MIGRATED_KEY` marker, so re-running the server
 * (or a stray reappearance of the .json) never re-imports stale data over the
 * now-authoritative SQLite store.
 */
export function migrateOnBootIfNeeded(store: JanusStore, paths: MigrationPaths): boolean {
  if (store.getKV(LEDGER_MIGRATED_KEY)) return false;   // already migrated
  if (!fs.existsSync(paths.ledgerPath)) return false;   // nothing to migrate
  // 3V.5: the marker is written INSIDE the import transaction (threaded down via markMigratedAt),
  // never as a separate post-commit write — a failure anywhere rolls back BOTH the imported rows and
  // the marker, so a half-migrated store can never be marked "done" (and a marked store always holds
  // the full import). The .bak rename runs strictly AFTER the commit, so a failed import leaves the
  // legacy JSON untouched at its live path.
  migrateFromJson(store, paths, { markMigratedAt: new Date().toISOString() });
  return true;
}

/** Pure, testable importer over already-parsed objects. Runs in one transaction.
 *  3V.5: opts.markMigratedAt, when given, writes LEDGER_MIGRATED_KEY INSIDE that same transaction. */
export function migrateFromObjects(
  store: JanusStore,
  input: MigrationInput,
  opts?: { markMigratedAt?: string },
): void {
  const tx = store.db.transaction(() => {
    const now = Date.now();
    importLedger(store, input.ledger ?? {}, now);
    importSettings(store, input.settings ?? {});
    importHistory(store, input.history ?? {}, now);
    store.appendEvent({ type: EVENT_TYPES.COMMAND_OUTCOME, summary: "migrated from JSON", ts: now, payload: { migration: true } });
    // 3V.5: the migration marker commits ATOMICALLY with the import (see migrateOnBootIfNeeded).
    if (opts?.markMigratedAt) store.setKV(LEDGER_MIGRATED_KEY, opts.markMigratedAt);
  });
  tx();
}

/** Identity/config half of the pane row — same field defaults / `??` coalescing as before. */
function buildPaneIdentity(wsId: string, p: any): any {
  return { pane_id: p.pane_id, workspace_id: wsId, name: p.name ?? "",
    runtime_type: p.runtime_type ?? "", tool_preset: p.tool_preset ?? "Custom",
    permissions_mode: p.permissions_mode ?? "Human-in-the-Loop", session_id: p.session_id ?? "" };
}

/** Runtime-state half of the pane row — same field defaults / `??` coalescing as before. */
function buildPaneState(p: any, now: number): any {
  return { last_known_state: p.last_known_state ?? "Idle", is_busy: !!p.is_busy, alive: !!p.alive,
    context_size: p.context_size ?? 0, last_status_change_at: p.last_status_change_at ?? null,
    last_command: p.last_command ?? null, scrollback_path: p.scrollback_path ?? null,
    created_at: now, updated_at: now };
}

/** Build the pane row exactly as before — same fields, same order, same defaults. */
function buildPaneRecord(wsId: string, p: any, now: number): any {
  return { ...buildPaneIdentity(wsId, p), ...buildPaneState(p, now) };
}

/** Import one pane (with its notes) under workspace `wsId`. Same DDL/ordering as before. */
function importPane(store: JanusStore, wsId: string, p: any, now: number): void {
  store.savePane(buildPaneRecord(wsId, p, now));
  for (const note of (p.notes ?? [])) store.addNote(wsId, String(note), { paneId: p.pane_id, type:"note", author:"user" });
}

/** Import one workspace (with its notes + panes). Same ordering/DDL/defaults as before. */
function importWorkspace(store: JanusStore, ws: any, now: number): void {
  store.saveWorkspace({ id: ws.id, name: ws.name ?? "", directory: ws.directory ?? "",
    summary: ws.summary ?? "", key_terms: ws.keyTerms ?? [], created_at: now, updated_at: now });
  for (const note of (ws.notes ?? [])) store.addNote(ws.id, String(note), { type:"note", author:"user" });
  for (const p of Object.values<any>(ws.panes ?? {})) importPane(store, ws.id, p, now);
}

/** Import the ledger: every workspace (notes/panes) then the three ledger-level KV markers. */
function importLedger(store: JanusStore, ledger: any, now: number): void {
  for (const ws of Object.values<any>(ledger.workspaces ?? {})) importWorkspace(store, ws, now);
  if (ledger.activeProjectId) store.setKV("activeProjectId", String(ledger.activeProjectId));
  if (ledger.watchRules) store.setKV("watchRules", JSON.stringify(ledger.watchRules));
  if (ledger.plans) store.setKV("plans", JSON.stringify(ledger.plans));
}

/** Import settings, flattened, excluding secrets.* (in-memory-only hardening). */
function importSettings(store: JanusStore, settings: any): void {
  // Secrets-at-rest hardening: NEVER import secrets.* into the durable store. The Gemini API key
  // is an in-memory-only secret (director decision 2026-06-05); flattening secrets.geminiApiKey
  // into settings_kv is exactly what leaked the key into .janus.db on the 2026-06-05 boot. Migrate
  // every non-secret setting unchanged.
  flatten(settings, "").forEach(([k, v]) => {
    if (k === "secrets" || k.startsWith("secrets.")) return;
    store.saveSettings(k, typeof v === "string" ? v : JSON.stringify(v));
  });
}

/** Import history: one command_outcome event per entry, with the same field coalescing. */
function importHistory(store: JanusStore, history: any, now: number): void {
  for (const [paneId, entries] of Object.entries<any>(history)) {
    for (const e of (entries as any[])) {
      store.appendEvent({ type: EVENT_TYPES.COMMAND_OUTCOME, pane_id: paneId,
        ts: e.timestamp ?? now, summary: e.finalResponse ?? "",
        payload: { command: e.command, output: e.output } });
    }
  }
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

/** File-driven entry point: read JSON, import, then rename the LEDGER + HISTORY originals to .bak.
 *  The settings JSON is left in place — see the rename loop below (bug ahm).
 *  3V.5: opts.markMigratedAt is threaded into migrateFromObjects so the migration marker commits in
 *  the same transaction as the import. */
export function migrateFromJson(
  store: JanusStore,
  paths: MigrationPaths,
  opts?: { markMigratedAt?: string },
): void {
  const read = (p: string) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };
  // 3V.5: an EXISTING ledger file that cannot be read/parsed must THROW, not silently import an
  // empty ledger — the pre-fix swallow archived the (unparsed!) file to .bak and set the migration
  // marker, silently losing the operator's data and permanently blocking a re-import. The throw
  // happens BEFORE the import transaction and BEFORE any rename, so the file stays untouched at its
  // live path; server.ts's existing migration catch logs it and boots without the import.
  const readLedger = (p: string) => {
    if (!fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      throw new Error(`legacy ledger ${p} exists but could not be read/parsed — refusing to archive it or mark the migration done: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  migrateFromObjects(store, {
    ledger: readLedger(paths.ledgerPath), settings: read(paths.settingsPath), history: read(paths.historyPath),
  }, opts);
  // ahm fix: rename ONLY the ledger + history originals — they now live authoritatively in SQLite.
  // (3V.5: this rename block runs strictly AFTER the import transaction committed — a throw above
  // leaves every original at its live path.)
  // The settings JSON is DELIBERATELY NOT renamed: OrchestratorManager.loadSettings reads
  // .janus_settings.json as its source of truth post-migration, so archiving it to .bak dropped the
  // operator's config (gates/presets/model) AND the legacy Gemini key on the first-migration boot
  // (voice silently died). Non-secret settings are also imported into settings_kv above
  // (redundant-but-harmless); the JSON stays authoritative for loadSettings. secrets.* is never
  // imported into the store (in-memory-only hardening), so the key lives only in the JSON.
  for (const p of [paths.ledgerPath, paths.historyPath]) {
    try { if (fs.existsSync(p)) fs.renameSync(p, `${p}.bak`); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3V.5 — store-boot QUARANTINE. server.ts used to fall back to the legacy JSON ledger whenever
// JanusStore init threw. But a PREVIOUS boot's migration already renamed .janus_ledger.json → .bak
// (and LEDGER_MIGRATED_KEY blocks any re-import), so a corrupt .janus.db made the app boot EMPTY on
// the legacy backend and strand every new write. Instead: quarantine the bad DB file aside
// (recoverable, loud) and retry ONCE with a fresh DB — the SQLite backend stays authoritative.
// Only if the retry ALSO fails (a non-file-level fault: missing native module, unwritable dir, ...)
// does the caller fall back to legacy, logging that handoff persistence is disabled.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface StoreInitResult {
  /** The booted store, or null when BOTH the first attempt and the post-quarantine retry failed. */
  store: JanusStore | null;
  /** Where the corrupt DB was moved (`<dbPath>.corrupt-<epoch-ms>`), or null if no quarantine ran. */
  quarantinedTo: string | null;
}

/**
 * Construct + boot a JanusStore at `dbPath` (the `boot` callback runs init/maintenance). On failure,
 * QUARANTINE the on-disk DB — rename it to `<dbPath>.corrupt-<ts>` together with its -wal/-shm twins
 * (a stale twin left under the live name would be replayed into the fresh DB sqlite creates there) —
 * and retry once with a fresh file. Never throws; the caller decides what a null store means.
 */
export function initStoreWithQuarantine(
  dbPath: string,
  boot: (store: JanusStore) => void,
  now: number = Date.now(),
): StoreInitResult {
  const attempt = (): JanusStore => {
    const s = new JanusStore(dbPath);
    try { boot(s); } catch (e) {
      try { s.close(); } catch { /* release the handle so the rename below can run on every platform */ }
      throw e;
    }
    return s;
  };
  try {
    return { store: attempt(), quarantinedTo: null };
  } catch (firstErr) {
    console.error(`[STORE] JanusStore failed to initialize at ${dbPath}:`, firstErr);
    if (dbPath === ":memory:" || !fs.existsSync(dbPath)) {
      // Nothing on disk to quarantine — the failure is environmental; a retry would just repeat it.
      return { store: null, quarantinedTo: null };
    }
    const target = `${dbPath}.corrupt-${now}`;
    try {
      fs.renameSync(dbPath, target);
    } catch (renameErr) {
      console.error(`[STORE] could not quarantine ${dbPath} -> ${target}; store stays down:`, renameErr);
      return { store: null, quarantinedTo: null };
    }
    for (const suffix of ["-wal", "-shm"]) {
      try { if (fs.existsSync(`${dbPath}${suffix}`)) fs.renameSync(`${dbPath}${suffix}`, `${target}${suffix}`); } catch { /* best-effort */ }
    }
    console.error(`[STORE] QUARANTINED the corrupt database to ${target} (with any -wal/-shm twins). Prior data is recoverable from that file. Retrying ONCE with a fresh DB at ${dbPath}.`);
    try {
      return { store: attempt(), quarantinedTo: target };
    } catch (retryErr) {
      console.error("[STORE] the fresh-DB retry ALSO failed — handoff persistence will be disabled:", retryErr);
      return { store: null, quarantinedTo: target };
    }
  }
}
