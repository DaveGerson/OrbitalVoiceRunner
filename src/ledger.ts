import fs from "fs";
import { WatchRule, Plan, PaneMeta, Workspace, ContextEntry, PaneDraft } from "./types";
import type { StoredNote } from "./store/types";

// PaneMeta and Workspace are defined once in ./types (frontend-safe) and
// re-exported here so existing `from "./ledger"` imports keep working (D7).
export type { PaneMeta, Workspace };

// An archived pane: the PaneMeta snapshot plus where it came from and when it was
// archived, so it can be restored into its original project later (recoverable clear).
export interface ArchivedPane {
  pane: PaneMeta;
  project_id: string;
  archived_at: string; // ISO timestamp
}

/**
 * The ledger surface OrchestratorManager + server.ts depend on. Both the legacy
 * JSON `Ledger` and the durable `JanusStore` satisfy it, so the running app can
 * swap backends without touching call sites (WS-M cutover seam, design §5.3).
 *
 * Note methods are truthy-on-success: the legacy Ledger returns `boolean`, the
 * store returns `StoredNote | null`. Both are accepted (callers use `if (ok)`),
 * so the union return keeps either implementation assignable.
 */
export interface LedgerLike {
  activeProjectId: string | null;
  workspaces: Record<string, Workspace>;
  addProject(id: string, directory: string, summary?: string, keyTerms?: string[]): unknown;
  renameProject(id: string, name: string): unknown;
  renamePane(projectId: string, paneId: string, name: string): unknown;
  switchContext(id: string): unknown;
  getProject(id: string): Workspace | null;
  getActiveProject(): Workspace | null;
  getProjectBriefing(id: string): {
    project_id: string; summary: string; directory: string;
    panes: PaneMeta[]; notes: string[]; key_codebase_terms: string[];
  } | null;
  updatePane(projectId: string, paneMeta: PaneMeta, shouldSave?: boolean): void;
  save(immediate?: boolean): void;
  // Truthy-on-success: legacy Ledger returns boolean, JanusStore returns StoredNote|null.
  addNote(projectId: string, text: string): unknown;
  addPaneNote(projectId: string, paneId: string, text: string): unknown;
  // bead bjm: notes-recall surface. JanusStore implements these over id-bearing rows + FTS5; the
  // legacy Ledger projects its flat string[] notes into the same shape (synthetic positional ids).
  getNotes(filter?: { projectId?: string; paneId?: string; type?: string }): StoredNote[];
  search(query: string, opts?: { limit?: number; source?: "note" | "event" }): Array<{ source: "note" | "event"; id: string; snippet: string; rank: number }>;
  amendNote(id: string, text: string): void;
  deleteNote(id: string): void;
  getDraft(projectId: string, paneId: string): PaneDraft | null;
  setDraft(projectId: string, paneId: string, text: string, updatedBy?: "janus" | "operator"): boolean;
  appendDraft(projectId: string, paneId: string, text: string, updatedBy?: "janus" | "operator"): boolean;
  listDrafts(projectId: string): { paneId: string; draft: PaneDraft }[];
  addModelContext(projectId: string, paneId: string, text: string, source?: string): boolean;
  addHumanContext(projectId: string, paneId: string, text: string): boolean;
  getPaneContext(projectId: string, paneId: string): { model: ContextEntry[]; human: ContextEntry[]; legacy: string[] } | null;
  plans: Plan[];
  watchRules: WatchRule[];
  archiveExitedPanes(projectId?: string): number;
  listArchived(workspaceId?: string): ArchivedPane[];
  restoreArchivedPane(paneId: string): ArchivedPane | null;
  deleteArchivedPane(paneId: string): boolean;
}

export class Ledger {
  activeProjectId: string | null = null;
  workspaces: Record<string, Workspace> = {};
  watchRules: WatchRule[] = [];
  plans: Plan[] = [];
  archivedPanes: ArchivedPane[] = [];
  private storagePath: string;

  constructor(storagePath: string = ".janus_ledger.json") {
    this.storagePath = storagePath;
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = fs.readFileSync(this.storagePath, "utf-8");
        const parsed = JSON.parse(data);
        this.activeProjectId = parsed.activeProjectId || null;
        this.workspaces = parsed.workspaces || {};
        this.watchRules = parsed.watchRules || [];
        this.plans = parsed.plans || [];
        this.archivedPanes = parsed.archivedPanes || [];
      }
    } catch (e) {
      console.warn(`Failed to load ledger from ${this.storagePath}:`, e);
    }
  }

  private isSaving = false;
  private isDirty = false;
  private saveTimeout: NodeJS.Timeout | null = null;

  public save(sync = false) {
    this.isDirty = true;
    if (sync) {
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }
      this.flushSaveSync();
      return;
    }

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.flushSave().catch((err) => {
        console.error("Async flushSave failed:", err);
      });
    }, 100);
  }

  public async flushSave(): Promise<void> {
    if (!this.isDirty) return;
    if (this.isSaving) {
      return;
    }
    this.isSaving = true;
    this.isDirty = false;

    const tempPath = `${this.storagePath}.tmp`;
    try {
      const data = JSON.stringify({
        activeProjectId: this.activeProjectId,
        workspaces: this.workspaces,
        watchRules: this.watchRules,
        plans: this.plans,
        archivedPanes: this.archivedPanes
      }, null, 2);
      await fs.promises.writeFile(tempPath, data, "utf-8");
      await fs.promises.rename(tempPath, this.storagePath);
    } catch (e) {
      console.error(`Failed to save ledger atomically to ${this.storagePath}:`, e);
      this.isDirty = true;
    } finally {
      this.isSaving = false;
      if (this.isDirty) {
        this.save();
      }
    }
  }

  public flushSaveSync() {
    if (!this.isDirty) return;
    this.isDirty = false;
    const tempPath = `${this.storagePath}.tmp`;
    try {
      const data = JSON.stringify({
        activeProjectId: this.activeProjectId,
        workspaces: this.workspaces,
        watchRules: this.watchRules,
        plans: this.plans,
        archivedPanes: this.archivedPanes
      }, null, 2);
      fs.writeFileSync(tempPath, data, "utf-8");
      fs.renameSync(tempPath, this.storagePath);
    } catch (e) {
      console.error(`Failed to save ledger atomically sync to ${this.storagePath}:`, e);
      this.isDirty = true;
    }
  }

  addProject(id: string, directory: string, summary: string = "", keyTerms: string[] = []) {
    if (!this.workspaces[id]) {
      this.workspaces[id] = {
        id,
        name: id,
        directory,
        summary,
        notes: [],
        panes: {},
        keyTerms
      };
      this.save(true);
    }
  }

  renameProject(id: string, name: string) {
    if (this.workspaces[id]) {
      this.workspaces[id].name = name;
      this.save(true);
    }
  }

  renamePane(projectId: string, paneId: string, name: string) {
    if (this.workspaces[projectId] && this.workspaces[projectId].panes[paneId]) {
      this.workspaces[projectId].panes[paneId].name = name;
      this.save(true);
    }
  }

  addPaneNote(projectId: string, paneId: string, note: string): boolean {
    if (this.workspaces[projectId] && this.workspaces[projectId].panes[paneId]) {
      this.workspaces[projectId].panes[paneId].notes.push(note);
      this.save(true);
      return true;
    }
    return false;
  }

  // Layered per-terminal context (prompt-composer refactor §4). Writing context is
  // NOT a CLI write and is never gated. `addModelContext` is for machine-maintained
  // orientation (Janus / synthesizer / handoff); `addHumanContext` is for operator
  // steering. Both append a timestamped entry and persist.
  private appendContext(
    layer: "modelContext" | "humanContext",
    projectId: string,
    paneId: string,
    text: string,
    source?: string
  ): boolean {
    const pane = this.workspaces[projectId]?.panes[paneId];
    if (!pane) return false;
    const entry: ContextEntry = { text, at: new Date().toISOString() };
    if (source) entry.source = source;
    (pane[layer] ??= []).push(entry);
    this.save(true);
    return true;
  }

  addModelContext(projectId: string, paneId: string, text: string, source?: string): boolean {
    return this.appendContext("modelContext", projectId, paneId, text, source);
  }

  addHumanContext(projectId: string, paneId: string, text: string): boolean {
    return this.appendContext("humanContext", projectId, paneId, text);
  }

  // Unified read of a pane's orientation context across all layers, newest-last.
  // `legacy` surfaces pre-refactor flat notes so nothing is lost on migration.
  getPaneContext(projectId: string, paneId: string): {
    model: ContextEntry[];
    human: ContextEntry[];
    legacy: string[];
  } | null {
    const pane = this.workspaces[projectId]?.panes[paneId];
    if (!pane) return null;
    return {
      model: pane.modelContext ?? [],
      human: pane.humanContext ?? [],
      legacy: pane.notes ?? [],
    };
  }

  // Per-pane WIP draft prompt (step 6 — the Workbench). A draft is a proposed prompt that has not
  // yet been sent to the pane; composing/editing it is not a CLI write and is never gated. Each
  // pane keeps its own, persisted, so switching panes preserves the work in progress.
  getDraft(projectId: string, paneId: string): PaneDraft | null {
    return this.workspaces[projectId]?.panes[paneId]?.draft ?? null;
  }

  setDraft(projectId: string, paneId: string, text: string, updatedBy?: "janus" | "operator"): boolean {
    const pane = this.workspaces[projectId]?.panes[paneId];
    if (!pane) return false;
    pane.draft = { text, updatedAt: new Date().toISOString(), ...(updatedBy ? { updatedBy } : {}) };
    this.save(true);
    return true;
  }

  appendDraft(projectId: string, paneId: string, text: string, updatedBy?: "janus" | "operator"): boolean {
    const pane = this.workspaces[projectId]?.panes[paneId];
    if (!pane) return false;
    const prev = pane.draft?.text ?? "";
    const next = prev ? `${prev}\n${text}` : text;
    pane.draft = { text: next, updatedAt: new Date().toISOString(), ...(updatedBy ? { updatedBy } : {}) };
    this.save(true);
    return true;
  }

  // The WIP register (step 6, the scalable part of "B"): every pane in a project that has a
  // non-empty draft, so the operator never loses work composed for a pane they switched away from.
  listDrafts(projectId: string): { paneId: string; draft: PaneDraft }[] {
    const ws = this.workspaces[projectId];
    if (!ws) return [];
    return Object.values(ws.panes)
      .filter((p) => p.draft && p.draft.text.trim().length > 0)
      .map((p) => ({ paneId: p.pane_id, draft: p.draft! }));
  }

  getProject(id: string): Workspace | null {
    return this.workspaces[id] || null;
  }

  getActiveProject(): Workspace | null {
    if (!this.activeProjectId) return null;
    return this.workspaces[this.activeProjectId] || null;
  }

  switchContext(id: string) {
    if (this.workspaces[id]) {
      this.activeProjectId = id;
      this.save(true);
    }
  }

  addNote(projectId: string, note: string): boolean {
    if (this.workspaces[projectId]) {
      this.workspaces[projectId].notes.push(note);
      this.save(true);
      return true;
    }
    return false;
  }

  // ── Notes-recall surface (bead bjm) ──────────────────────────────────────────────────────────
  // The SQLite JanusStore (default backend) implements these natively over id-bearing rows + FTS5.
  // The legacy in-memory Ledger keeps notes as bare string[] with no stable identity, so we project
  // them into StoredNote rows with a deterministic synthetic id (`legacy:<projectId>:<paneId>:<idx>`)
  // and back id-based amend/delete + a substring search off that. Positional and best-effort —
  // SQLite is the supported path for durable id-based recall.
  private legacyNoteRow(projectId: string, paneId: string | null, index: number, text: string): StoredNote {
    return {
      id: `legacy:${projectId}:${paneId ?? ""}:${index}`,
      project_id: projectId, pane_id: paneId, text,
      type: "note", author: "user", created_at: index, updated_at: index,
    };
  }
  private parseLegacyNoteId(id: string): { projectId: string; paneId: string | null; index: number } | null {
    if (!id.startsWith("legacy:")) return null;
    const parts = id.split(":");
    if (parts.length < 4) return null;
    const index = Number(parts[parts.length - 1]);
    const projectId = parts[1];
    const paneId = parts[2] || null;
    if (!projectId || Number.isNaN(index)) return null;
    return { projectId, paneId, index };
  }
  private legacyNoteArray(projectId: string, paneId: string | null): string[] | undefined {
    const ws = this.workspaces[projectId];
    if (!ws) return undefined;
    return paneId ? ws.panes[paneId]?.notes : ws.notes;
  }

  getNotes(filter: { projectId?: string; paneId?: string; type?: string } = {}): StoredNote[] {
    const rows: StoredNote[] = [];
    const projectIds = filter.projectId ? [filter.projectId] : Object.keys(this.workspaces);
    for (const pid of projectIds) {
      const ws = this.workspaces[pid];
      if (!ws) continue;
      if (!filter.paneId) {
        (ws.notes ?? []).forEach((text, i) => rows.push(this.legacyNoteRow(pid, null, i, text)));
      }
      for (const pane of Object.values(ws.panes)) {
        if (filter.paneId && pane.pane_id !== filter.paneId) continue;
        (pane.notes ?? []).forEach((text, i) => rows.push(this.legacyNoteRow(pid, pane.pane_id, i, text)));
      }
    }
    const typed = filter.type ? rows.filter((r) => r.type === filter.type) : rows;
    // Mirror JanusStore.getNotes: newest-first.
    return typed.sort((a, b) => b.created_at - a.created_at);
  }

  search(query: string, opts: { limit?: number; source?: "note" | "event" } = {}): Array<{ source: "note" | "event"; id: string; snippet: string; rank: number }> {
    // The legacy in-memory Ledger has no event index — it only ever surfaces notes.
    if (opts.source === "event") return [];
    const limit = opts.limit ?? 25;
    const q = query.toLowerCase();
    return this.getNotes({})
      .filter((n) => n.text.toLowerCase().includes(q))
      .slice(0, limit)
      .map((n, i) => ({ source: "note" as const, id: n.id, snippet: n.text, rank: i }));
  }

  amendNote(id: string, text: string): void {
    const p = this.parseLegacyNoteId(id);
    if (!p) return;
    const arr = this.legacyNoteArray(p.projectId, p.paneId);
    if (arr && p.index >= 0 && p.index < arr.length) { arr[p.index] = text; this.save(true); }
  }

  deleteNote(id: string): void {
    const p = this.parseLegacyNoteId(id);
    if (!p) return;
    const arr = this.legacyNoteArray(p.projectId, p.paneId);
    if (arr && p.index >= 0 && p.index < arr.length) { arr.splice(p.index, 1); this.save(true); }
  }

  updatePane(projectId: string, paneMeta: PaneMeta, shouldSave = true) {
    if (this.workspaces[projectId]) {
      this.workspaces[projectId].panes[paneMeta.pane_id] = paneMeta;
      if (shouldSave) {
        this.save(false);
      }
    }
  }

  // --- Pane archive (recoverable "clear exited") ---

  /** Move a pane out of its project into the archive. Returns false if not found. */
  archivePane(projectId: string, paneId: string): boolean {
    const ws = this.workspaces[projectId];
    if (!ws || !ws.panes[paneId]) return false;
    const pane = ws.panes[paneId];
    delete ws.panes[paneId];
    this.archivedPanes.push({
      pane,
      project_id: projectId,
      archived_at: new Date().toISOString()
    });
    this.save(true);
    return true;
  }

  /** Archive every Exited (not alive) pane across all projects. Returns count archived. */
  archiveExitedPanes(projectId?: string): number {
    let count = 0;
    const projectIds = projectId ? [projectId] : Object.keys(this.workspaces);
    for (const pId of projectIds) {
      const ws = this.workspaces[pId];
      if (!ws) continue;
      for (const paneId of Object.keys(ws.panes)) {
        if (!ws.panes[paneId].alive) {
          const pane = ws.panes[paneId];
          delete ws.panes[paneId];
          this.archivedPanes.push({ pane, project_id: pId, archived_at: new Date().toISOString() });
          count++;
        }
      }
    }
    if (count > 0) this.save(true);
    return count;
  }

  listArchived(): ArchivedPane[] {
    return this.archivedPanes;
  }

  /** Restore an archived pane back into its original project. Returns the entry or null. */
  restoreArchivedPane(paneId: string): ArchivedPane | null {
    const idx = this.archivedPanes.findIndex(a => a.pane.pane_id === paneId);
    if (idx === -1) return null;
    const entry = this.archivedPanes[idx];
    // Recreate the destination project if it has since been removed.
    if (!this.workspaces[entry.project_id]) {
      this.addProject(entry.project_id, entry.pane.last_command ? process.cwd() : process.cwd(), "Restored workspace");
    }
    this.workspaces[entry.project_id].panes[entry.pane.pane_id] = entry.pane;
    this.archivedPanes.splice(idx, 1);
    this.save(true);
    return entry;
  }

  /** Permanently remove an archived pane. Returns true if it existed. */
  deleteArchivedPane(paneId: string): boolean {
    const idx = this.archivedPanes.findIndex(a => a.pane.pane_id === paneId);
    if (idx === -1) return false;
    this.archivedPanes.splice(idx, 1);
    this.save(true);
    return true;
  }

  getProjectBriefing(id: string) {
    const ws = this.workspaces[id];
    if (!ws) return null;

    return {
      project_id: ws.id,
      summary: ws.summary,
      directory: ws.directory,
      panes: Object.values(ws.panes),
      notes: ws.notes,
      key_codebase_terms: ws.keyTerms || []
    };
  }
}
