// src/memory/index.ts — the public facade. P0a synthesizes via the deterministic fallback;
// P0b will route to the Python synthesizer here, falling back to assembleBrief on timeout/error.
import { WorldModel, type WorldModelDeps } from "./worldModel";
import { BreadcrumbRing } from "./breadcrumbs";
import { assembleBrief } from "./assembler";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig, type SynthesizedBrief, type Breadcrumb } from "./types";

export { WorldModel } from "./worldModel";
export { BreadcrumbRing } from "./breadcrumbs";
export * from "./types";

export class MemoryService {
  constructor(private wm: WorldModel, private cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG) {}
  synthesize(activePaneId: string | null, now: number): SynthesizedBrief {
    return assembleBrief(this.wm.getTiers(activePaneId, now), this.cfg, now);
  }
}

export interface CreatedMemory {
  service: MemoryService;
  breadcrumbs: BreadcrumbRing;
  addBreadcrumb: (b: Breadcrumb) => void;
}

/** Build the wired memory service from the live manager/store + redactor. */
export function createMemoryService(
  deps: Omit<WorldModelDeps, "breadcrumbs">,
  cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): CreatedMemory {
  const breadcrumbs = new BreadcrumbRing(cfg);
  const wm = new WorldModel({ ...deps, breadcrumbs });
  return { service: new MemoryService(wm, cfg), breadcrumbs, addBreadcrumb: (b) => breadcrumbs.add(b) };
}
