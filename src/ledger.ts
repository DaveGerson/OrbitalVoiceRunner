import fs from "fs";
import { WatchRule, Plan, PaneMeta, Workspace } from "./types";

// PaneMeta and Workspace are defined once in ./types (frontend-safe) and
// re-exported here so existing `from "./ledger"` imports keep working (D7).
export type { PaneMeta, Workspace };

export class Ledger {
  activeProjectId: string | null = null;
  workspaces: Record<string, Workspace> = {};
  watchRules: WatchRule[] = [];
  plans: Plan[] = [];
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
        plans: this.plans
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
        plans: this.plans
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

  updatePane(projectId: string, paneMeta: PaneMeta, shouldSave = true) {
    if (this.workspaces[projectId]) {
      this.workspaces[projectId].panes[paneMeta.pane_id] = paneMeta;
      if (shouldSave) {
        this.save(false);
      }
    }
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
