// src/memory/types.ts — shared shapes for the in-process memory layer (P0a).
// Budget is CHAR-based (≈4 chars/token) to avoid a tokenizer dependency in v1.
import { z } from "zod";

export interface ProjectTier {
  projectId: string;
  name: string;
  summary: string;
  keyTerms: string[];
  recentDecisions: string[];   // redacted, newest-first (typed notes, type=decision)
  // Phase 2 Step 2.1 (AgentExchange spine context enrichment): OPTIONAL so pre-existing tier
  // literals built by hand (assembler/synthesizer test fixtures) still typecheck unchanged.
  // Populated from typed notes (Wave 6 NoteType: "warning" / "todo"), redacted, newest-first,
  // bounded — see src/memory/worldModel.ts's PROJECT_LIST_MAX.
  warnings?: string[];         // redacted, newest-first (typed notes, type=warning)
  openTodos?: string[];        // redacted, newest-first (typed notes, type=todo, not yet promoted to a bead)
}
export interface PaneTier {
  paneId: string;
  name: string;
  runtimeType: string;
  status: string;              // "Running" | "Idle" | "Exited"
  lastCommand: string | null;  // redacted
  recent: string[];            // redacted recent pane lines/outcomes, newest-first
}
export interface BoardEntry {
  paneId: string; name: string; status: string;
  // Phase 2 Step 2.1: OPTIONAL AgentExchange enrichment (current in-flight exchange state for
  // this pane + a human-readable reason it's waiting, when applicable). Absent/undefined on any
  // pre-existing BoardEntry literal built without exchange data — see src/memory/worldModel.ts.
  exchangeState?: string | null;   // e.g. "running" | "needs_input" | "awaiting_approval" | null
  waitingReason?: string | null;   // "needs input" | "awaiting approval" | "awaiting clarification" | null
}
export interface JanusFrame {
  role: string;
  gatePosture: string;         // global permissions mode summary
  prefs: string[];             // redacted global operator prefs, may be empty
}
// text already redacted. `projectId` (Phase 2 Step 2.4/2.5 fix — cross-project breadcrumb leak):
// the pane's OWNING project at drop time, stamped by the observe-layer call sites so the render
// path can scope crumbs to the brief's project. OPTIONAL + nullable: a crumb with no project
// affinity (system/global, unresolvable pane, or any pre-existing caller/test that never stamps
// it) stays visible everywhere — byte-identical to the pre-scoping behavior for those callers.
export interface Breadcrumb { ts: number; paneId: string | null; text: string; projectId?: string | null; }

/**
 * Phase 2 Step 2.1: the "affected pane" / event-focus block. Populated ONLY when a background
 * (non-active-pane) outcome triggers context assembly (src/memory/worldModel.ts's
 * `getEventFocusTier`, wired via `WorldModel.getTiers`'s optional `affectedPaneId` param) — so
 * Cortex (and the TS floor renderer) can name the specific pane + event that caused this
 * injection cycle, independent of whichever pane is currently in the operator's foreground.
 */
export interface EventFocusTier {
  paneId: string;
  name: string;
  eventText: string;           // redacted — the most recent outcome/question/handoff/exchange delta
  exchangeState: string | null;
  waitingReason: string | null;
}

export interface MemoryTiers {
  project: ProjectTier | null;
  pane: PaneTier | null;       // the ACTIVE pane (focus)
  board: BoardEntry[];
  frame: JanusFrame;
  breadcrumbs: Breadcrumb[];   // newest-first, already age/cap filtered
  // Phase 2 Step 2.1: OPTIONAL so every existing MemoryTiers literal (tests, the python parity
  // fixtures) that never mentions it still typechecks/behaves byte-identically. null/undefined
  // both mean "no background-pane event to focus on this cycle".
  eventFocus?: EventFocusTier | null;
}

export interface BudgetWeights {
  project: number; pane: number; breadcrumbs: number; board: number; frame: number;
  // Phase 2 Step 2.1: OPTIONAL extra share for the eventFocus tier (additive, on top of the
  // five existing fractions — NOT rebalanced out of them, so every pre-existing weights literal
  // (server.ts, docs, other tests) that omits it keeps its EXACT prior byte output). Missing ⇒
  // assembler.ts's collect() treats it as 0 (tier renders empty/absent).
  eventFocus?: number;
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
  source: "fallback" | "python" | "cortex-primary";  // P0a "fallback"; "cortex-primary" = cortex FLIP (B-1)
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  totalBudgetChars: 4800,
  // eventFocus (Phase 2 Step 2.1) is an ADDITIVE extra share, not a rebalance of the five
  // pre-existing fractions — those five stay byte-identical to every historical value pinned by
  // test_memory_assembler.ts / test_assembler_complexity_refactor.ts (e.g. the hardcoded `* 0.40`
  // project-cap assertion). eventFocus itself renders only when the tier is actually present
  // (the rare background-outcome-trigger case), so this budget is otherwise inert.
  weights: { project: 0.40, pane: 0.30, breadcrumbs: 0.15, board: 0.10, frame: 0.05, eventFocus: 0.15 },
  breadcrumbMax: 12,
  breadcrumbMaxAgeMs: 15 * 60 * 1000,
};

/** The NDJSON wire protocol version. A mismatch ⇒ daemon treated as unavailable ⇒ fallback.
 *  SINGLE SOURCE for the TS side; Python's copy lives in python/synthesizer/dispatch.py. The two are
 *  kept equal by tests/test_wire_version_parity.ts (a red test on any silent drift) — see seam plan
 *  task 1.4. Bump here AND there in the same change, then re-run the golden sweep. */
export const WIRE_VERSION = 1;

/** Shape of the brief Python returns (TS stamps `source` authoritatively; Python cannot claim it). */
export const PythonBriefSchema = z.object({
  text: z.string(),
  perTierChars: z.record(z.string(), z.number()),
  activePaneId: z.string().nullable(),
});

export const PingResponseSchema = z.object({
  id: z.string(),
  v: z.literal(WIRE_VERSION),
  ok: z.literal(true),
  pong: z.literal(true),
  synthVersion: z.string(),
});

export const SynthesizeResponseSchema = z.union([
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    brief: PythonBriefSchema,
    meta: z.object({ strategy: z.string(), synthVersion: z.string() }).optional(),
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type PingResponse = z.infer<typeof PingResponseSchema>;
export type SynthesizeResponse = z.infer<typeof SynthesizeResponseSchema>;

// ── approval.parse op envelope (seam Inc 1, task 1.4) ─────────────────────────────────────────────
// Request payload: { transcript: string }. Response payload: the ParsedApproval-shaped `parsed`.
// This is the WIRE contract the approval typed facade validates; the parser's own TS type lives in
// src/approvalIntent.ts (ParsedApproval) and is structurally identical to `z.infer<ParsedApprovalSchema>`.
export const ApprovalIntentSchema = z.enum(["approve", "reject", "defer", "clarify", "none"]);

/** A target hint: a 1-based ordinal (-1 = last) and/or a named fragment. Both keys optional; the
 *  parser OMITS a key it did not set (matching the TS `JSON.stringify(undefined)` drop). */
export const TargetHintSchema = z.object({
  fragment: z.string().optional(),
  ordinal: z.number().optional(),
});

export const ParsedApprovalSchema = z.object({
  intent: ApprovalIntentSchema,
  targetHint: TargetHintSchema.optional(),
});

export const ApprovalParseResponseSchema = z.union([
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    parsed: ParsedApprovalSchema,
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type WireParsedApproval = z.infer<typeof ParsedApprovalSchema>;
export type ApprovalParseResponse = z.infer<typeof ApprovalParseResponseSchema>;

// ── cortex.decide op envelope (Inc 4 slice 1, SHADOW) ─────────────────────────────────────────────
// Request payload: { tiers: MemoryTiers, ctx: CortexCtx, now: number }. Response payload: a curation
// `decision` (ordered keep/drop/rerank — v1 IDENTITY) + a structured `trace` (the over-document
// substrate). SHADOW: TS LOGS the trace, never applies the decision. The cortex owns relevance + the
// char-budget; the synthesizer renders. Spec: docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md
export interface CortexCtx {
  activePaneId: string | null;
  sessionId?: string | null;
  trigger: string;
  // Wave 4 (D0/D4, docs/superpowers/specs/2026-07-02-cortex-cutover-design.md): the last
  // HISTORY_K decide outcomes (oldest-first), so Python's hysteresis rule can suppress a
  // just-dropped tier from re-surfacing without the daemon retaining any state itself.
  history?: CortexHistoryEntry[];
  // Wave 4 (D4): TS-computed per-tier content hashes for THIS call's snapshot. Python never
  // hashes — it only compares these against tierHashes recorded on prior history entries to
  // detect a "strong trigger" (content actually changed since the tier was dropped).
  tierHashes?: Record<string, string>;
  // Wave 4 (D1): the paneId the triggering signal was about (e.g. the pane that just went
  // idle), independent of activePaneId, so a command-outcome profile can lead with it.
  affectedPaneId?: string | null;
}

// Wave 4 (D0, cortex cutover design): the wire-level trigger vocabulary Python's profile
// table is keyed on EXACTLY — see D3. Distinct from the free-form `ContextInjectionTrigger`
// telemetry union (src/memory/contextTelemetry.ts), which describes call-site provenance;
// this is the narrower, curated set the cortex actually branches on.
export type CortexWireTrigger = "session-start" | "pane-switch" | "command-outcome" | "catch-up";

/** Map an arbitrary TS-side trigger string onto the wire vocabulary. Unknown values fall to
 *  "catch-up" (never "session-start") so an unrecognized trigger can never bypass the inject
 *  gate's session-start-only bypass (D2). */
export function toCortexTrigger(t: string): CortexWireTrigger {
  switch (t) {
    case "session_start":
    case "reconnect":
      return "session-start";
    case "pane_switch":
    case "project_switch":
      return "pane-switch";
    case "command_outcome":
      return "command-outcome";
    default:
      return "catch-up";
  }
}

/** One prior decide outcome, as retained by the D4 ring buffer (src/memory/decisionRing.ts).
 *  `tierHashes` covers only the tiers listed in `droppedTiers` (the hysteresis rule only ever
 *  needs the hash of what was dropped, to detect a later content change). */
export interface CortexHistoryEntry {
  droppedTiers: string[];
  tierHashes: Record<string, string>;
  trigger: string;
  ts: number;
}

/** Ring-buffer depth for CortexCtx.history (D4). Named constant, reviewable default — not a
 *  magic number. Mirrors python/synthesizer's own HISTORY_K, which MUST stay equal (D4). */
export const HISTORY_K = 8;

export const CortexDecisionSchema = z.object({
  keep: z.array(z.string()),
  drop: z.array(z.string()),
  rerank: z.array(z.string()),
  // Wave 4 (D3): per-tier char caps the cortex allocated for this decision. Optional so an
  // older daemon (pre-cutover, no budget field) still validates; absent ⇒ renderer falls back
  // to its own default weights (src/memory/index.ts assembleBrief).
  budget: z.record(z.string(), z.number()).optional(),
});

export const CortexTraceSchema = z.object({
  cortexVersion: z.string(),
  strategy: z.string(),
  ruleFired: z.string(),
  inputs: z.object({
    activePaneId: z.string().nullable(),
    sessionId: z.string().nullable().optional(),
    trigger: z.string().nullable(),
    tierKeys: z.array(z.string()),
    tierChars: z.record(z.string(), z.number()),
  }).passthrough(),
  output: z.object({
    orderedKeep: z.array(z.string()),
    dropped: z.array(z.string()),
  }).passthrough(),
  // Inc 4 slice 2 (SHADOW, bead wsm-e2e-pinned-5gv): the cortex's OWN renderer budget allocation +
  // the rendered text LENGTH (not the full text — logs stay lean). Additive/optional so an older
  // daemon (no shadowBudget) still validates; absent when the shadow render raised. TS stays log-only.
  shadowBudget: z.object({
    perTierChars: z.record(z.string(), z.number()),
    textLen: z.number(),
  }).optional(),
  // 0.2.1: post-drop renderer budget (curated tiers only). Present only when drop is non-empty.
  // Enables savings = shadowBudget.textLen - shadowBudgetCurated.textLen computation. Pure observation.
  shadowBudgetCurated: z.object({
    perTierChars: z.record(z.string(), z.number()),
    textLen: z.number(),
  }).optional(),
  ts: z.number(),
});

export const CortexDecideResponseSchema = z.union([
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    decision: CortexDecisionSchema,
    trace: CortexTraceSchema,
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type CortexDecision = z.infer<typeof CortexDecisionSchema>;
export type CortexTrace = z.infer<typeof CortexTraceSchema>;
export type CortexDecideResponse = z.infer<typeof CortexDecideResponseSchema>;
