import { WorldModel, type WorldModelDeps } from "./worldModel";
import { BreadcrumbRing } from "./breadcrumbs";
import { assembleBrief } from "./assembler";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig, type SynthesizedBrief, type Breadcrumb } from "./types";
import type { PythonSynthClient } from "./pythonClient";

export { WorldModel } from "./worldModel";
export { BreadcrumbRing } from "./breadcrumbs";
export * from "./types";
export * from "./pythonClient";
export { createPythonApprovalClient, type PythonApprovalClient } from "./approvalClient";
export { createDaemonStateTracker, type DaemonStateTracker, type DaemonStateStats } from "./daemonStateTracker";

/** Latest-wins predicate (invariant I3): a brief is only injectable if its pane is still the focus. */
export function briefIsForActivePane(briefActivePaneId: string | null, currentActivePaneId: string | null): boolean {
  return briefActivePaneId === currentActivePaneId;
}

export class MemoryService {
  constructor(
    private wm: WorldModel,
    private cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
    private pythonClient?: PythonSynthClient,
    private timeoutMs: number = 150,
  ) {}

  /** Synchronous deterministic fallback — unchanged P0a path (REST/tests + the race else-branch). */
  synthesize(activePaneId: string | null, now: number): SynthesizedBrief {
    return assembleBrief(this.wm.getTiers(activePaneId, now), this.cfg, now);
  }

  /** P0b: race the Python daemon (≤timeoutMs) against the in-process floor; TS owns `source` (I1/I4). */
  async synthesizeAsync(activePaneId: string | null, now: number): Promise<SynthesizedBrief> {
    try {
      const tiers = this.wm.getTiers(activePaneId, now);
      const fallback = (): SynthesizedBrief => assembleBrief(tiers, this.cfg, now);
      const client = this.pythonClient;
      if (!client || !client.available()) return fallback();
      // In-flight rule: the awaited race DEPENDS on this ceiling to settle if the daemon request
      // hangs, so it holds the loop while live and is cleared as soon as the race settles.
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((res) => { timeoutTimer = setTimeout(() => res(null), this.timeoutMs); });
      let raced: Awaited<ReturnType<PythonSynthClient["request"]>> | null;
      try {
        raced = await Promise.race([client.request(tiers, this.cfg, now), timeout]);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
      if (raced && raced.ok) {
        return {
          text: raced.brief.text,
          perTierChars: raced.brief.perTierChars as Record<string, number>,
          activePaneId: raced.brief.activePaneId,
          source: "python",
        };
      }
      return fallback();
    } catch {
      // Last-resort floor: even if getTiers/assembleBrief throws, never reject.
      return { text: "", perTierChars: {}, activePaneId, source: "fallback" };
    }
  }

  synthesizerState(): "python" | "fallback" {
    return this.pythonClient?.synthesizerState() ?? "fallback";
  }
}

export interface CreatedMemory {
  service: MemoryService;
  breadcrumbs: BreadcrumbRing;
  addBreadcrumb: (b: Breadcrumb) => void;
}

/** Build the wired memory service. `pythonClient`/`timeoutMs` are optional (P0b); absent ⇒ pure fallback. */
export function createMemoryService(
  deps: Omit<WorldModelDeps, "breadcrumbs">,
  cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
  pythonClient?: PythonSynthClient,
  timeoutMs: number = 150,
): CreatedMemory {
  const breadcrumbs = new BreadcrumbRing(cfg);
  const wm = new WorldModel({ ...deps, breadcrumbs });
  return { service: new MemoryService(wm, cfg, pythonClient, timeoutMs), breadcrumbs, addBreadcrumb: (b) => breadcrumbs.add(b) };
}
