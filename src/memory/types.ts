// src/memory/types.ts — shared shapes for the in-process memory layer (P0a).
// Budget is CHAR-based (≈4 chars/token) to avoid a tokenizer dependency in v1.

export interface ProjectTier {
  projectId: string;
  name: string;
  summary: string;
  keyTerms: string[];
  recentDecisions: string[];   // redacted, newest-first
}
export interface PaneTier {
  paneId: string;
  name: string;
  runtimeType: string;
  status: string;              // "Running" | "Idle" | "Exited"
  lastCommand: string | null;  // redacted
  recent: string[];            // redacted recent pane lines/outcomes, newest-first
}
export interface BoardEntry { paneId: string; name: string; status: string; }
export interface JanusFrame {
  role: string;
  gatePosture: string;         // global permissions mode summary
  prefs: string[];             // redacted global operator prefs, may be empty
}
export interface Breadcrumb { ts: number; paneId: string | null; text: string; } // text already redacted

export interface MemoryTiers {
  project: ProjectTier | null;
  pane: PaneTier | null;       // the ACTIVE pane (focus)
  board: BoardEntry[];
  frame: JanusFrame;
  breadcrumbs: Breadcrumb[];   // newest-first, already age/cap filtered
}

export interface BudgetWeights {
  project: number; pane: number; breadcrumbs: number; board: number; frame: number;
}
export interface MemoryConfig {
  totalBudgetChars: number;    // default 4800 (~1200 tokens)
  weights: BudgetWeights;      // fractions, sum ≈ 1
  breadcrumbMax: number;       // default 12
  breadcrumbMaxAgeMs: number;  // default 15 min
}
export interface SynthesizedBrief {
  text: string;
  perTierChars: Record<string, number>;
  activePaneId: string | null;
  source: "fallback" | "python";  // P0a always "fallback"
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  totalBudgetChars: 4800,
  weights: { project: 0.40, pane: 0.30, breadcrumbs: 0.15, board: 0.10, frame: 0.05 },
  breadcrumbMax: 12,
  breadcrumbMaxAgeMs: 15 * 60 * 1000,
};
