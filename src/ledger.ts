import { WatchRule, Plan, PaneMeta, Workspace, ContextEntry, PaneDraft, PromptTemplate, PaneLayout } from "./types";
import type { StoredNote } from "./store/types";
import type { Macro } from "./macros";

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
 * The ledger surface OrchestratorManager + server.ts depend on. `JanusStore` (SQLite) is the
 * ONLY production implementation (dbt3 retired the legacy in-memory/JSON `Ledger` backend +
 * its `JANUS_LEDGER_BACKEND=legacy` escape hatch); the interface stays a seam — not a dual-
 * backend selector — so call sites remain decoupled from the concrete store (WS-M design §5.3),
 * and test doubles can still implement it directly where a real store would be overkill.
 *
 * Note methods are truthy-on-success: the store returns `StoredNote | null` (or `boolean` for
 * a hand-rolled test double), so callers use `if (ok)` rather than `assert.strictEqual(..., true)`.
 */
export interface LedgerLike {
  activeProjectId: string | null;
  workspaces: Record<string, Workspace>;
  addProject(id: string, directory: string, summary?: string, keyTerms?: string[]): unknown;
  renameProject(id: string, name: string): unknown;
  renamePane(projectId: string, paneId: string, name: string): unknown;
  // wsm-e2e-pinned major-finding fix: the delete_pane/delete_project actions' REAL durable effect.
  // Truthy-on-success (Ledger parity). Snapshot mutation (`delete workspaces[id]` / `delete
  // ws.panes[id]`) is NOT sufficient against JanusStore — `workspaces`/`getProject` rebuild fresh
  // from SQL per call and `save()` is a no-op, so a snapshot-only delete silently resurrects the row.
  deletePane(projectId: string, paneId: string): boolean;
  deleteProject(id: string): boolean;
  switchContext(id: string): unknown;
  getProject(id: string): Workspace | null;
  getActiveProject(): Workspace | null;
  // bd #69: targeted pane→owning-project lookup for findPaneOwningProject tier-3. The SQLite
  // backend answers this with ONE indexed query (panes PK leads with pane_id) instead of
  // materializing every workspace via the `workspaces` getter on the hot gate/posture path.
  getProjectIdForPane(paneId: string): string | null;
  getProjectBriefing(id: string): {
    project_id: string; summary: string; directory: string;
    panes: PaneMeta[]; notes: string[]; key_codebase_terms: string[];
  } | null;
  updatePane(projectId: string, paneMeta: PaneMeta, shouldSave?: boolean): void;
  save(immediate?: boolean): void;
  // Truthy-on-success: JanusStore returns StoredNote|null (or boolean for a hand-rolled test double).
  addNote(projectId: string, text: string): unknown;
  addPaneNote(projectId: string, paneId: string, text: string): unknown;
  // bead bjm: notes-recall surface. JanusStore implements these over id-bearing rows + FTS5.
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
  promptTemplates: PromptTemplate[];
  layouts: PaneLayout[];
  // Voice macros (8fz.6) — self-persisting document array (kv-JSON, same shape as promptTemplates).
  macros: Macro[];
  archiveExitedPanes(projectId?: string): number;
  // PHASE 1 (deferrable-toggle honesty): archive ONE pane by its owning project + id (recoverable,
  // does NOT terminate the process). Truthy-on-success: false when the pane row is already gone.
  // JanusStore's internal archivePane(paneId, workspaceId) keeps its own argument order; this
  // alias bridges to the consistent (projectId, paneId) order so archive_pane stays call-site-stable.
  archivePaneOwned(projectId: string, paneId: string): boolean;
  listArchived(workspaceId?: string): ArchivedPane[];
  restoreArchivedPane(paneId: string): ArchivedPane | null;
  deleteArchivedPane(paneId: string): boolean;
}
