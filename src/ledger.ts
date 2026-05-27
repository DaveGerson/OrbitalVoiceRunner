export interface PaneMeta {
  pane_id: string;
  name: string;
  runtime_type: string;
  last_known_state: string;
  is_busy: boolean;
  alive: boolean;
}

export interface Workspace {
  id: string;
  directory: string;
  summary: string;
  notes: string[];
  panes: Record<string, PaneMeta>;
}

export class Ledger {
  activeProjectId: string | null = null;
  workspaces: Record<string, Workspace> = {};

  addProject(id: string, directory: string, summary: string = "") {
    if (!this.workspaces[id]) {
      this.workspaces[id] = {
        id,
        directory,
        summary,
        notes: [],
        panes: {}
      };
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
    }
  }

  addNote(projectId: string, note: string) {
    if (this.workspaces[projectId]) {
      this.workspaces[projectId].notes.push(note);
    }
  }

  updatePane(projectId: string, paneMeta: PaneMeta) {
    if (this.workspaces[projectId]) {
      this.workspaces[projectId].panes[paneMeta.pane_id] = paneMeta;
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
