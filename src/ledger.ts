import fs from "fs";

export interface PaneMeta {
  pane_id: string;
  name: string;
  runtime_type: string;
  last_known_state: string;
  is_busy: boolean;
  alive: boolean;
  notes: string[];
  permissions_mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  session_id: string;
  tool_preset: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  cpu_usage: number;
}

export interface Workspace {
  id: string;
  name: string;
  directory: string;
  summary: string;
  notes: string[];
  panes: Record<string, PaneMeta>;
}

export class Ledger {
  activeProjectId: string | null = null;
  workspaces: Record<string, Workspace> = {};
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
      }
    } catch (e) {
      console.warn(`Failed to load ledger from ${this.storagePath}:`, e);
    }
  }

  private save() {
    try {
      const data = JSON.stringify({
        activeProjectId: this.activeProjectId,
        workspaces: this.workspaces
      }, null, 2);
      fs.writeFileSync(this.storagePath, data, "utf-8");
    } catch (e) {
      console.error(`Failed to save ledger to ${this.storagePath}:`, e);
    }
  }

  addProject(id: string, directory: string, summary: string = "") {
    if (!this.workspaces[id]) {
      this.workspaces[id] = {
        id,
        name: id,
        directory,
        summary,
        notes: [],
        panes: {}
      };
      this.save();
    }
  }

  renameProject(id: string, name: string) {
    if (this.workspaces[id]) {
      this.workspaces[id].name = name;
      this.save();
    }
  }

  renamePane(projectId: string, paneId: string, name: string) {
    if (this.workspaces[projectId] && this.workspaces[projectId].panes[paneId]) {
      this.workspaces[projectId].panes[paneId].name = name;
      this.save();
    }
  }

  addPaneNote(projectId: string, paneId: string, note: string) {
    if (this.workspaces[projectId] && this.workspaces[projectId].panes[paneId]) {
      this.workspaces[projectId].panes[paneId].notes.push(note);
      this.save();
    }
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
      this.save();
    }
  }

  addNote(projectId: string, note: string) {
    if (this.workspaces[projectId]) {
      this.workspaces[projectId].notes.push(note);
      this.save();
    }
  }

  updatePane(projectId: string, paneMeta: PaneMeta) {
    if (this.workspaces[projectId]) {
      this.workspaces[projectId].panes[paneMeta.pane_id] = paneMeta;
      this.save();
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
      notes: ws.notes
    };
  }
}
