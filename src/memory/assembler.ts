// src/memory/assembler.ts — deterministic, no-LLM blend of tiers into one budgeted brief.
// This is the anti-rot guarantee: it always produces a FRESH brief with Python absent (spec M8).
import type { MemoryTiers, MemoryConfig, SynthesizedBrief } from "./types";

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

export function assembleBrief(tiers: MemoryTiers, cfg: MemoryConfig, _now: number): SynthesizedBrief {
  const B = cfg.totalBudgetChars, w = cfg.weights;
  const perTierChars: Record<string, number> = {};
  const blocks: string[] = [];

  // PROJECT (mid-ground)
  if (tiers.project) {
    const p = tiers.project;
    const body = cap(
      `PROJECT ${p.name}: ${p.summary}` +
      (p.keyTerms.length ? ` | terms: ${p.keyTerms.join(", ")}` : "") +
      (p.recentDecisions.length ? ` | decisions: ${p.recentDecisions.slice(0, 3).join("; ")}` : ""),
      Math.floor(B * w.project));
    perTierChars.project = body.length; blocks.push(body);
  }
  // ACTIVE PANE (sharp foreground)
  if (tiers.pane) {
    const pn = tiers.pane;
    const body = cap(
      `ACTIVE PANE ${pn.name} (${pn.status}, ${pn.runtimeType})` +
      (pn.lastCommand ? ` last: ${pn.lastCommand}` : "") +
      (pn.recent.length ? ` | recent: ${pn.recent.slice(0, 4).join("; ")}` : ""),
      Math.floor(B * w.pane));
    perTierChars.pane = body.length; blocks.push(body);
  }
  // BREADCRUMBS (decaying working memory)
  if (tiers.breadcrumbs.length) {
    const body = cap(`RECENTLY: ${tiers.breadcrumbs.map(b => b.text).join(" · ")}`, Math.floor(B * w.breadcrumbs));
    perTierChars.breadcrumbs = body.length; blocks.push(body);
  }
  // BOARD (perception)
  if (tiers.board.length) {
    const body = cap(`BOARD: ${tiers.board.map(b => `${b.name}=${b.status}`).join(", ")}`, Math.floor(B * w.board));
    perTierChars.board = body.length; blocks.push(body);
  }
  // JANUS FRAME (self-model)
  {
    const f = tiers.frame;
    const body = cap(`FRAME ${f.role} | gates: ${f.gatePosture}` + (f.prefs.length ? ` | prefs: ${f.prefs.join("; ")}` : ""),
      Math.floor(B * w.frame));
    perTierChars.frame = body.length; blocks.push(body);
  }

  return {
    text: blocks.join("\n"),
    perTierChars,
    activePaneId: tiers.pane?.paneId ?? null,
    source: "fallback",
  };
}
