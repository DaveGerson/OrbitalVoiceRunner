// src/memory/assembler.ts — deterministic, no-LLM blend of tiers into one budgeted brief.
// This is the anti-rot guarantee: it always produces a FRESH brief with Python absent (spec M8).
import type { MemoryTiers, MemoryConfig, SynthesizedBrief } from "./types";

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/** PROJECT (mid-ground) block, or null when absent. Identical text to the inline original. */
function projectBlock(tiers: MemoryTiers, B: number, w: MemoryConfig["weights"]): string | null {
  if (!tiers.project) return null;
  const p = tiers.project;
  return cap(
    `PROJECT ${p.name}: ${p.summary}` +
    (p.keyTerms.length ? ` | terms: ${p.keyTerms.join(", ")}` : "") +
    (p.recentDecisions.length ? ` | decisions: ${p.recentDecisions.slice(0, 3).join("; ")}` : ""),
    Math.floor(B * w.project));
}

/** ACTIVE PANE (sharp foreground) block, or null when absent. */
function paneBlock(tiers: MemoryTiers, B: number, w: MemoryConfig["weights"]): string | null {
  if (!tiers.pane) return null;
  const pn = tiers.pane;
  return cap(
    `ACTIVE PANE ${pn.name} (${pn.status}, ${pn.runtimeType})` +
    (pn.lastCommand ? ` last: ${pn.lastCommand}` : "") +
    (pn.recent.length ? ` | recent: ${pn.recent.slice(0, 4).join("; ")}` : ""),
    Math.floor(B * w.pane));
}

/** BREADCRUMBS (decaying working memory) block, or null when empty. */
function breadcrumbsBlock(tiers: MemoryTiers, B: number, w: MemoryConfig["weights"]): string | null {
  if (!tiers.breadcrumbs.length) return null;
  return cap(`RECENTLY: ${tiers.breadcrumbs.map(b => b.text).join(" · ")}`, Math.floor(B * w.breadcrumbs));
}

/** BOARD (perception) block, or null when empty. */
function boardBlock(tiers: MemoryTiers, B: number, w: MemoryConfig["weights"]): string | null {
  if (!tiers.board.length) return null;
  return cap(`BOARD: ${tiers.board.map(b => `${b.name}=${b.status}`).join(", ")}`, Math.floor(B * w.board));
}

/** JANUS FRAME (self-model) block — always present. */
function frameBlock(tiers: MemoryTiers, B: number, w: MemoryConfig["weights"]): string {
  const f = tiers.frame;
  return cap(`FRAME ${f.role} | gates: ${f.gatePosture}` + (f.prefs.length ? ` | prefs: ${f.prefs.join("; ")}` : ""),
    Math.floor(B * w.frame));
}

export function assembleBrief(tiers: MemoryTiers, cfg: MemoryConfig, _now: number): SynthesizedBrief {
  const B = cfg.totalBudgetChars, w = cfg.weights;
  const perTierChars: Record<string, number> = {};
  const blocks: string[] = [];

  const collect = (key: string, body: string | null): void => {
    if (body === null) return;
    perTierChars[key] = body.length;
    blocks.push(body);
  };

  collect("project", projectBlock(tiers, B, w));
  collect("pane", paneBlock(tiers, B, w));
  collect("breadcrumbs", breadcrumbsBlock(tiers, B, w));
  collect("board", boardBlock(tiers, B, w));
  collect("frame", frameBlock(tiers, B, w));

  return {
    text: blocks.join("\n"),
    perTierChars,
    activePaneId: tiers.pane?.paneId ?? null,
    source: "fallback",
  };
}
