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
  migrateFromJson(store, paths);                        // import + .bak the originals
  store.setKV(LEDGER_MIGRATED_KEY, new Date().toISOString());
  return true;
}

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

    // Secrets-at-rest hardening: NEVER import secrets.* into the durable store. The Gemini API key
    // is an in-memory-only secret (director decision 2026-06-05); flattening secrets.geminiApiKey
    // into settings_kv is exactly what leaked the key into .janus.db on the 2026-06-05 boot. Migrate
    // every non-secret setting unchanged.
    flatten(input.settings ?? {}, "").forEach(([k, v]) => {
      if (k === "secrets" || k.startsWith("secrets.")) return;
      store.saveSettings(k, typeof v === "string" ? v : JSON.stringify(v));
    });

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

/** File-driven entry point: read JSON, import, then rename the LEDGER + HISTORY originals to .bak.
 *  The settings JSON is left in place — see the rename loop below (bug ahm). */
export function migrateFromJson(store: JanusStore, paths: MigrationPaths): void {
  const read = (p: string) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };
  migrateFromObjects(store, {
    ledger: read(paths.ledgerPath), settings: read(paths.settingsPath), history: read(paths.historyPath),
  });
  // ahm fix: rename ONLY the ledger + history originals — they now live authoritatively in SQLite.
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
