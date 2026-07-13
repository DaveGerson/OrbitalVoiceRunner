// src/memory/assembler.ts — deterministic, no-LLM blend of tiers into one budgeted brief.
// This is the anti-rot guarantee: it always produces a FRESH brief with Python absent (spec M8).
//
// Wave 4 (D5, docs/superpowers/specs/2026-07-02-cortex-cutover-design.md): assembleBrief gained an
// optional render PLAN — {order, caps} — so the renderer can honor the cortex's curated tier order
// and per-tier char budget while staying a pure renderer (the cortex is the single curation
// authority; this module never decides relevance, only renders). An ABSENT plan renders the
// CANONICAL order with weight-derived caps — i.e. TODAY'S bytes verbatim, byte-for-byte identical
// to the pre-cutover behavior. This is the fail-closed FLOOR every miss path falls back to.
import type { MemoryTiers, MemoryConfig, SynthesizedBrief } from "./types";

/** The cortex's curated render instructions: an ordered tier list (`decision.keep`, reordered) and
 *  optional per-tier char caps (`decision.budget`). A tier key ABSENT from `order` is simply never
 *  rendered — that IS "drop"; there is no separate filter/null step. `frame` is structural and is
 *  ALWAYS rendered even if omitted from `order` (appended last). An unknown key in `order` (not one
 *  of the six canonical tier names — project/pane/eventFocus/breadcrumbs/board/frame, Phase 2 Step
 *  2.1 added eventFocus) is silently ignored. */
export interface RenderPlan {
  order: string[];
  caps: Record<string, number>;
}

// Phase 2 Step 2.1: eventFocus inserted right after the active pane (foreground-adjacent — it
// names a DIFFERENT pane, but it's the reason this brief was assembled at all) and before the
// decaying breadcrumbs. Absent for every trigger that never supplies an affectedPaneId (the
// pre-existing behavior), so this insertion is a no-op for all of today's call sites.
const CANONICAL_ORDER = ["project", "pane", "eventFocus", "breadcrumbs", "board", "frame"];

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/** PROJECT (mid-ground) block, or null when absent. `warnings`/`openTodos` (Phase 2 Step 2.1)
 *  are optional — appended only when present/non-empty, so a tier literal that never sets them
 *  renders byte-identically to before. */
function projectBlock(tiers: MemoryTiers, capChars: number): string | null {
  if (!tiers.project) return null;
  const p = tiers.project;
  const decisions = p.recentDecisions.length ? ` | decisions: ${p.recentDecisions.slice(0, 3).join("; ")}` : "";
  const warnings = p.warnings?.length ? ` | warnings: ${p.warnings.slice(0, 3).join("; ")}` : "";
  const todos = p.openTodos?.length ? ` | todos: ${p.openTodos.slice(0, 3).join("; ")}` : "";
  return cap(
    `PROJECT ${p.name}: ${p.summary}` +
    (p.keyTerms.length ? ` | terms: ${p.keyTerms.join(", ")}` : "") +
    decisions + warnings + todos,
    capChars);
}

/** ACTIVE PANE (sharp foreground) block, or null when absent. */
function paneBlock(tiers: MemoryTiers, capChars: number): string | null {
  if (!tiers.pane) return null;
  const pn = tiers.pane;
  return cap(
    `ACTIVE PANE ${pn.name} (${pn.status}, ${pn.runtimeType})` +
    (pn.lastCommand ? ` last: ${pn.lastCommand}` : "") +
    (pn.recent.length ? ` | recent: ${pn.recent.slice(0, 4).join("; ")}` : ""),
    capChars);
}

/** EVENT FOCUS (Phase 2 Step 2.1) — the background pane + delta that triggered this assembly
 *  cycle, or null when no affected pane was supplied / it IS the active pane. */
function eventFocusBlock(tiers: MemoryTiers, capChars: number): string | null {
  const ef = tiers.eventFocus;
  if (!ef) return null;
  const state = ef.exchangeState ? ` (${ef.exchangeState}${ef.waitingReason ? `: ${ef.waitingReason}` : ""})` : "";
  return cap(`EVENT FOCUS ${ef.name}${state}: ${ef.eventText}`, capChars);
}

/** BREADCRUMBS (decaying working memory) block, or null when empty. */
function breadcrumbsBlock(tiers: MemoryTiers, capChars: number): string | null {
  if (!tiers.breadcrumbs.length) return null;
  return cap(`RECENTLY: ${tiers.breadcrumbs.map(b => b.text).join(" · ")}`, capChars);
}

/** BOARD (perception) block, or null when empty. Per-entry exchange-state suffix (Phase 2 Step
 *  2.1) is appended only when present, so an entry built without it renders exactly as before. */
function boardBlock(tiers: MemoryTiers, capChars: number): string | null {
  if (!tiers.board.length) return null;
  const parts = tiers.board.map(b => {
    const suffix = b.exchangeState ? `[${b.exchangeState}${b.waitingReason ? `:${b.waitingReason}` : ""}]` : "";
    return `${b.name}=${b.status}${suffix}`;
  });
  return cap(`BOARD: ${parts.join(", ")}`, capChars);
}

/** JANUS FRAME (self-model) block — always present. */
function frameBlock(tiers: MemoryTiers, capChars: number): string {
  const f = tiers.frame;
  return cap(`FRAME ${f.role} | gates: ${f.gatePosture}` + (f.prefs.length ? ` | prefs: ${f.prefs.join("; ")}` : ""),
    capChars);
}

const RENDERERS: Record<string, (tiers: MemoryTiers, capChars: number) => string | null> = {
  project: projectBlock,
  pane: paneBlock,
  eventFocus: eventFocusBlock,
  breadcrumbs: breadcrumbsBlock,
  board: boardBlock,
  frame: frameBlock,
};

export function assembleBrief(tiers: MemoryTiers, cfg: MemoryConfig, _now: number, plan?: RenderPlan): SynthesizedBrief {
  const B = cfg.totalBudgetChars;
  const weights = cfg.weights as unknown as Record<string, number>;
  const order = plan?.order ?? CANONICAL_ORDER;
  const caps = plan?.caps ?? {};
  const perTierChars: Record<string, number> = {};
  const blocks: string[] = [];
  const seen = new Set<string>();

  const collect = (key: string): void => {
    const render = RENDERERS[key];
    if (!render || seen.has(key)) return; // unknown/duplicate key — ignored
    seen.add(key);
    const capChars = caps[key] ?? Math.floor(B * (weights[key] ?? 0));
    // Phase 2 Step 2.5 review fix: a tier with NO budget (weight/cap absent or 0 — e.g. a caller
    // whose weights literal predates the eventFocus tier) is ABSENT, exactly as its type doc
    // promises ("Missing ⇒ tier renders empty/absent") — cap(s, 0) used to render a lone "…"
    // (a garbage 1-char block that still claimed a perTierChars entry).
    if (capChars <= 0) return;
    const body = render(tiers, capChars);
    if (body === null) return;
    perTierChars[key] = body.length;
    blocks.push(body);
  };

  for (const key of order) collect(key);
  if (!seen.has("frame")) collect("frame"); // structural — always rendered, even if plan omitted it

  return {
    text: blocks.join("\n"),
    perTierChars,
    activePaneId: tiers.pane?.paneId ?? null,
    source: "fallback",
  };
}
