import { WorldModel, type WorldModelDeps } from "./worldModel";
import { BreadcrumbRing } from "./breadcrumbs";
import { assembleBrief } from "./assembler";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig, type SynthesizedBrief, type Breadcrumb, type CortexCtx, type MemoryTiers } from "./types";
import type { PythonSynthClient } from "./pythonClient";
import type { PythonCortexClient } from "./cortexClient";
import { isCortexPrimary, resolveWithCortex, cortexPrimaryTimeoutMs } from "./cortexShadow";

export { WorldModel } from "./worldModel";
export { BreadcrumbRing } from "./breadcrumbs";
export * from "./types";
export * from "./pythonClient";
export { createPythonApprovalClient, type PythonApprovalClient } from "./approvalClient";
export { createPythonCortexClient, type PythonCortexClient, type CortexResult } from "./cortexClient";
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
    private cortexClient?: PythonCortexClient,
  ) {}

  /** Inc 4 slice 1 (SHADOW): fire-and-forget cortex curation OBSERVATION. Builds the same tiers,
   *  asks the cortex what it WOULD curate, and LOGS the decision-trace. It NEVER blocks injection,
   *  NEVER throws, and NEVER applies the decision — parity with today is total (invariants I-P1..I-P3).
   *  Absent/unavailable client ⇒ a synchronous no-op. The cortex carries no risk; TS is the floor. */
  observeCortexShadow(activePaneId: string | null, now: number, trigger: string = "brief-inject"): void {
    const client = this.cortexClient;
    if (!client || !client.available()) return;
    try {
      const tiers = this.wm.getTiers(activePaneId, now);
      const ctx: CortexCtx = { activePaneId, sessionId: null, trigger };
      // Fire-and-forget: do NOT await. The facade never rejects, but guard the rejection arm anyway so
      // an unexpected throw can never surface as an unhandled rejection in the live loop.
      void client.decide(tiers, ctx, now).then(
        (res) => { if (res.ok) console.error(`[cortex-shadow] ${JSON.stringify(res.trace)}`); },
        () => { /* miss — silent; parity preserved */ },
      );
    } catch {
      // getTiers (or a synchronous throw from decide) must never affect injection — swallow.
    }
  }

  /** Synchronous deterministic fallback — unchanged P0a path (REST/tests + the race else-branch). */
  synthesize(activePaneId: string | null, now: number): SynthesizedBrief {
    return assembleBrief(this.wm.getTiers(activePaneId, now), this.cfg, now);
  }

  /** B-1 FLIP (default OFF): when the cortex is PRIMARY and available, ask it which tiers survive,
   *  render ONLY those, and stamp `source: "cortex-primary"`. Returns null on ANY miss (flag off,
   *  unavailable, timeout, ok:false, throw) so the caller falls through to the full-tier floor UNCHANGED
   *  — the parity guarantee while the flag is off (the branch is never even entered). */
  private async cortexCuratedBrief(tiers: MemoryTiers, activePaneId: string | null, now: number): Promise<SynthesizedBrief | null> {
    const cortex = this.cortexClient;
    if (!isCortexPrimary() || !cortex || !cortex.available()) return null;
    const ctx: CortexCtx = { activePaneId, sessionId: null, trigger: "brief-inject" };
    const filtered = await resolveWithCortex(tiers, ctx, now, cortex, cortexPrimaryTimeoutMs());
    if (!filtered) return null;
    return { ...assembleBrief(filtered, this.cfg, now), source: "cortex-primary" };
  }

  /** P0b: race the Python daemon (≤timeoutMs) against the in-process floor; TS owns `source` (I1/I4). */
  async synthesizeAsync(activePaneId: string | null, now: number): Promise<SynthesizedBrief> {
    try {
      const tiers = this.wm.getTiers(activePaneId, now);
      const fallback = (): SynthesizedBrief => assembleBrief(tiers, this.cfg, now);
      // B-1: cortex-primary curation (default OFF). On a clean hit this REPLACES the synth race below
      // (the cortex already curated the tiers); on any miss it returns null and we fall through.
      const curated = await this.cortexCuratedBrief(tiers, activePaneId, now);
      if (curated) return curated;
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
  cortexClient?: PythonCortexClient,
): CreatedMemory {
  const breadcrumbs = new BreadcrumbRing(cfg);
  const wm = new WorldModel({ ...deps, breadcrumbs });
  return { service: new MemoryService(wm, cfg, pythonClient, timeoutMs, cortexClient), breadcrumbs, addBreadcrumb: (b) => breadcrumbs.add(b) };
}
