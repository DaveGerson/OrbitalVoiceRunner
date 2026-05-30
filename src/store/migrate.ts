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

    flatten(input.settings ?? {}, "").forEach(([k,v]) => store.saveSettings(k, typeof v === "string" ? v : JSON.stringify(v)));

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
