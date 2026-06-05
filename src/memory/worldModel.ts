// src/memory/worldModel.ts — the in-process raw-truth reader. Pure reads off live manager + store;
// every text field is redacted at this boundary (spec invariant). No server.ts import.
import type { BreadcrumbRing } from "./breadcrumbs";
import type { MemoryTiers, ProjectTier, PaneTier, BoardEntry, JanusFrame } from "./types";

export interface WorldModelDeps {
  manager: {
    activeId: string | null;
    terminals: Record<string, { name?: string; runtimeType?: string; status?: string; lastCommand?: string | null }>;
    ledger: { activeProjectId?: string | null };
    settings: { globalPermissionsMode?: string };
    listPanes: () => Array<{ project_id: string; panes: Array<{ pane_id: string; name?: string; last_known_state?: string }> }>;
  };
  store: { getProject: (id: string) => any | null; getProjectBriefing: (id: string) => any | null };
  redact: (s: string) => string;
  breadcrumbs: BreadcrumbRing;
}

export class WorldModel {
  constructor(private deps: WorldModelDeps) {}

  getProjectTier(projectId: string): ProjectTier | null {
    const ws = this.deps.store.getProject(projectId);
    if (!ws) return null;
    return {
      projectId,
      name: ws.name ?? projectId,
      summary: this.deps.redact(ws.summary ?? ""),
      keyTerms: Array.isArray(ws.key_terms) ? ws.key_terms : [],
      recentDecisions: [], // P0a: kept simple; P0b enriches from notes(type=decision)
    };
  }

  getPaneTier(paneId: string): PaneTier | null {
    const t = this.deps.manager.terminals[paneId];
    if (!t) return null;
    return {
      paneId,
      name: t.name ?? paneId,
      runtimeType: t.runtimeType ?? "",
      status: t.status ?? "Idle",
      lastCommand: t.lastCommand ? this.deps.redact(t.lastCommand) : null,
      recent: [],
    };
  }

  getBoardTier(): BoardEntry[] {
    const out: BoardEntry[] = [];
    for (const grp of this.deps.manager.listPanes()) {
      for (const p of grp.panes) out.push({ paneId: p.pane_id, name: p.name ?? p.pane_id, status: p.last_known_state ?? "Idle" });
    }
    return out;
  }

  getJanusFrameTier(): JanusFrame {
    return {
      role: "Janus — voice orchestrator for live CLI panes",
      gatePosture: this.deps.manager.settings.globalPermissionsMode ?? "Human-in-the-Loop",
      prefs: [],
    };
  }

  getTiers(activePaneId: string | null, now: number): MemoryTiers {
    const projectId = this.deps.manager.ledger.activeProjectId ?? "";
    return {
      project: projectId ? this.getProjectTier(projectId) : null,
      pane: activePaneId ? this.getPaneTier(activePaneId) : null,
      board: this.getBoardTier(),
      frame: this.getJanusFrameTier(),
      breadcrumbs: this.deps.breadcrumbs.recent(now),
    };
  }
}
