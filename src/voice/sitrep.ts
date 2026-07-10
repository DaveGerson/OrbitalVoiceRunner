// src/voice/sitrep.ts — get_status_summary (voice-UX wave 3, spec D3 + decision record #1).
// Sole owner: hwu1.
//
// Three pure, independently-testable stages feed the one impure entry point:
//   composeSitrep   — gathers a renderer-agnostic SitrepPayload off ctx (pre-redacted, no prose).
//   fallbackRanking — the FIXED deterministic TS floor (D2): approvals -> busy(+plans) -> attention
//                     -> idle. This is what the operator hears whenever the "policies" daemon is
//                     unavailable (down, breaker open, timeout, schema reject) — see the FALLBACK
//                     CONTRACT in src/voice/policyClient.ts. It is ALSO what python/policies/sitrep.py
//                     rank_sitrep() reproduces when the daemon IS up, so a SITREP reads identically
//                     either way until the python side grows real ranking heuristics.
//   renderSitrep    — pure text rendering of a (payload, ranking) pair, honoring voiceUx.sitrepShape.
//                     Golden-testable: given the same inputs it always renders the same string.
//
// runStatusSummary(ctx) is the only impure piece: gather -> rank (python-first, TS-fallback) ->
// render -> speak. It NEVER throws (wrapped; falls back to a safe static string on any failure).
import type { ActionContext, ActionResult } from "../actions/types";
import type { SitrepPayload, SitrepRanking } from "./policyClient";
import { DEFAULT_VOICE_UX, type AttentionItem } from "../types";
import type { AgentExchange, ExchangeEvent, ExchangeState } from "../exchanges/types";

const EMPTY_SITREP_TEXT =
  "Nothing needs your attention: no pending approvals, no alerts, and no panes are busy.";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Phase 4, Step 4.2 — the exchange-aware "board": a prioritized, cross-pane view built directly
// off the durable AgentExchange spine (src/exchanges/**) plus the existing pending-approval
// surfaces, ADDITIVE to everything above. This is a SEPARATE composition from
// composeSitrep/fallbackRanking/renderSitrep (which stay byte-identical — every existing golden in
// tests/test_status_summary.ts keeps passing unmodified) so that a world with NO exchange activity
// (the exchange spine off, or `ctx.store` absent — every hand-built test ActionContext today)
// degrades to EXACTLY the legacy rendering, and a world WITH real exchange activity gets the
// spec's 6-tier priority order:
//   (1) agents waiting for operator input — needs_input exchanges + held pane-write approvals
//   (2) failed/exited exchanges — agent_failed + interrupted
//   (3) delivered exchanges with a meaningful result — agent_complete (non-empty result_summary)
//   (4) currently running exchanges — running/delivered
//   (5) unresolved approvals not already covered by (1) — staged (non-PTY) deferred actions
//   (6) relevant recent decisions — recently confirmed approvals (approval_confirmed events)
// Within a tier, items sort newest-first (freshest signal leads), matching "avoid replaying
// unchanged context" — an exchange that hasn't moved since the last read never reorders itself
// ahead of something that just changed.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type ExchangeBoardTier = 1 | 2 | 3 | 4 | 5 | 6;
export type ExchangeBoardKind = "needs_input" | "approval" | "failed" | "complete" | "running" | "decision";

export interface ExchangeBoardItem {
  tier: ExchangeBoardTier;
  kind: ExchangeBoardKind;
  /** null for approval items that carry no exchange correlation (a staged non-PTY action). */
  exchangeId: string | null;
  paneId: string | null;
  projectId: string | null;
  /** Already-redacted, capped, TERSE spoken clause (project + pane + one-clause outcome/question) —
   *  the voice-terseness contract: this is the ONE line a spoken summary reads for this item; full
   *  detail (evidence, full instruction text) stays in the action panel / replay, never spoken. */
  text: string;
  /** Sort anchor within a tier — larger = more recent. Exchange rows use their durable
   *  `updated_at`; approvals (no such column) use their own creation `timestamp`, or `0` when
   *  neither is available (stable, but always last within its tier on ties). */
  updatedAt: number;
}

const BOARD_TEXT_CAP = 160;
const DECISION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes — "relevant RECENT decisions" only
const MAX_DECISION_ITEMS = 3;

function capBoardText(s: string, max: number = BOARD_TEXT_CAP): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Resolve a pane's display name off the ledger the same way composeSitrep does, falling back to
 *  the bare pane id — then redact (a ledger-recorded pane name is operator-authored free text). */
function exchangePaneLabel(ctx: ActionContext, projectId: string, paneId: string): string {
  const raw = ctx.manager.ledger?.workspaces?.[projectId]?.panes?.[paneId]?.name || paneId;
  return ctx.redact(raw);
}

/**
 * Phase 4, Step 4.2 — the terse spoken/caption clause for one exchange's CURRENT terminal-ish
 * state. Shared by the on-demand board composer here AND the live voice-session narration seam
 * (src/voice/index.ts's pushSignal enrichment) so both surfaces read the SAME wording for the
 * SAME state — the `redact` function is injected because the live-session seam doesn't carry an
 * ActionContext (it uses `redactSecrets` directly; the board composer uses `ctx.redact`).
 * `state` values with nothing terse to say (draft/staged/delivered/etc.) return null — the caller
 * decides what (if anything) to fall back to.
 */
function needsInputLine(paneLabel: string, terminalState: string | null, redact: (s: string) => string): string {
  const q = terminalState ? capBoardText(redact(terminalState)) : null;
  return q ? `Pane '${paneLabel}' needs your input: "${q}"` : `Pane '${paneLabel}' needs your input.`;
}

function failedLine(paneLabel: string, terminalState: string | null, redact: (s: string) => string): string {
  const d = terminalState ? capBoardText(redact(terminalState)) : null;
  return d ? `Pane '${paneLabel}' failed: ${d}` : `Pane '${paneLabel}' failed.`;
}

/** null = no meaningful result to say (a completion with nothing to report is not narrated). */
function completeLine(paneLabel: string, resultSummary: string | null, redact: (s: string) => string): string | null {
  const s = resultSummary ? capBoardText(redact(resultSummary)) : null;
  return s ? `Pane '${paneLabel}' finished: ${s}` : null;
}

/** state -> the terse-line builder for it, or null for states with nothing terse to say. Table-
 *  driven so the top-level `terseExchangeOutcomeLine` stays a flat one-line dispatch (complexity
 *  gate) instead of a long switch. */
const TERSE_LINE_BUILDERS: Partial<
  Record<ExchangeState, (paneLabel: string, terminalState: string | null, resultSummary: string | null, redact: (s: string) => string) => string | null>
> = {
  needs_input: (p, t, _r, redact) => needsInputLine(p, t, redact),
  agent_failed: (p, t, _r, redact) => failedLine(p, t, redact),
  interrupted: (p) => `Pane '${p}' was interrupted.`,
  agent_complete: (p, _t, r, redact) => completeLine(p, r, redact),
  running: (p) => `Pane '${p}' is still working.`,
  delivered: (p) => `Pane '${p}' is still working.`,
};

export function terseExchangeOutcomeLine(
  paneLabel: string,
  state: ExchangeState | string,
  terminalState: string | null,
  resultSummary: string | null,
  redact: (s: string) => string,
): string | null {
  const build = TERSE_LINE_BUILDERS[state as ExchangeState];
  return build ? build(paneLabel, terminalState, resultSummary, redact) : null;
}

function needsInputItem(ctx: ActionContext, ex: AgentExchange): ExchangeBoardItem {
  const pane = exchangePaneLabel(ctx, ex.project_id, ex.pane_id);
  return {
    tier: 1, kind: "needs_input", exchangeId: ex.exchange_id, paneId: ex.pane_id, projectId: ex.project_id,
    text: terseExchangeOutcomeLine(pane, "needs_input", ex.terminal_state, ex.result_summary, ctx.redact)!,
    updatedAt: ex.updated_at,
  };
}

function failedItem(ctx: ActionContext, ex: AgentExchange): ExchangeBoardItem {
  const pane = exchangePaneLabel(ctx, ex.project_id, ex.pane_id);
  return {
    tier: 2, kind: "failed", exchangeId: ex.exchange_id, paneId: ex.pane_id, projectId: ex.project_id,
    text: terseExchangeOutcomeLine(pane, ex.state, ex.terminal_state, ex.result_summary, ctx.redact)!,
    updatedAt: ex.updated_at,
  };
}

function completeItem(ctx: ActionContext, ex: AgentExchange): ExchangeBoardItem | null {
  const pane = exchangePaneLabel(ctx, ex.project_id, ex.pane_id);
  const text = terseExchangeOutcomeLine(pane, "agent_complete", ex.terminal_state, ex.result_summary, ctx.redact);
  if (!text) return null; // no meaningful result — a completion with nothing to report is not narrated
  return {
    tier: 3, kind: "complete", exchangeId: ex.exchange_id, paneId: ex.pane_id, projectId: ex.project_id,
    text, updatedAt: ex.updated_at,
  };
}

function runningItem(ctx: ActionContext, ex: AgentExchange): ExchangeBoardItem {
  const pane = exchangePaneLabel(ctx, ex.project_id, ex.pane_id);
  return {
    tier: 4, kind: "running", exchangeId: ex.exchange_id, paneId: ex.pane_id, projectId: ex.project_id,
    text: terseExchangeOutcomeLine(pane, "running", ex.terminal_state, ex.result_summary, ctx.redact)!,
    updatedAt: ex.updated_at,
  };
}

interface HeldApproval { messageId: string; instruction: string; terminalId: string; timestamp?: number; exchangeId?: string }

function heldApprovalItem(ctx: ActionContext, a: HeldApproval): ExchangeBoardItem {
  const summary = capBoardText(ctx.redact(a.instruction));
  return {
    tier: 1, kind: "approval", exchangeId: a.exchangeId ?? null, paneId: a.terminalId ?? null, projectId: null,
    text: `Pane '${a.terminalId}' is awaiting your approval: "${summary}"`,
    updatedAt: a.timestamp ?? 0,
  };
}

interface StagedApproval { id: string; summary: string }

function stagedApprovalItem(ctx: ActionContext, a: StagedApproval): ExchangeBoardItem {
  return {
    tier: 5, kind: "approval", exchangeId: null, paneId: null, projectId: null,
    text: `A staged action is awaiting your approval: "${capBoardText(ctx.redact(a.summary))}"`,
    updatedAt: 0,
  };
}

function decisionItem(ctx: ActionContext, ev: ExchangeEvent): ExchangeBoardItem {
  const pane = ev.pane_id && ev.project_id ? exchangePaneLabel(ctx, ev.project_id, ev.pane_id) : (ev.pane_id ?? "a pane");
  return {
    tier: 6, kind: "decision", exchangeId: ev.exchange_id, paneId: ev.pane_id, projectId: ev.project_id,
    text: `Pane '${pane}': your instruction was approved.`,
    updatedAt: ev.ts,
  };
}

/** Never-throw wrapper around one store query — a single bad query must not blank the whole board
 *  (mirrors the QW5 never-throw idiom used throughout src/observe/index.ts). */
function safeList<T>(fn: () => T[]): T[] {
  try { return fn(); } catch (e) { console.error("[sitrep] exchange board query failed:", e); return []; }
}

/** Tiers 1a/2/3/4/6 — every item derived DIRECTLY from the durable exchange store. Split out of
 *  composeExchangeBoard purely to keep that function's own branch count low (complexity gate). */
function gatherExchangeStoreItems(ctx: ActionContext, store: NonNullable<ActionContext["store"]>, now: number): ExchangeBoardItem[] {
  const items: ExchangeBoardItem[] = [];
  for (const ex of safeList(() => store.listExchangesByStates(["needs_input"]))) items.push(needsInputItem(ctx, ex));
  for (const ex of safeList(() => store.listExchangesByStates(["agent_failed", "interrupted"]))) items.push(failedItem(ctx, ex));
  for (const ex of safeList(() => store.listExchangesByStates(["agent_complete"]))) {
    const it = completeItem(ctx, ex);
    if (it) items.push(it);
  }
  for (const ex of safeList(() => store.listExchangesByStates(["running", "delivered"]))) items.push(runningItem(ctx, ex));
  for (const ev of safeList(() =>
    store.listRecentExchangeEventsByTypes(["approval_confirmed"], { sinceTs: now - DECISION_WINDOW_MS, limit: MAX_DECISION_ITEMS }),
  )) items.push(decisionItem(ctx, ev));
  return items;
}

/** Tiers 1b (held pane-write approvals) + 5 (staged non-PTY approvals) — folded in ONLY once the
 *  caller has already established real exchange activity exists (composeExchangeBoard's own
 *  early-return). Never-throw: a pending-store fault must not blank the exchange-derived items
 *  already gathered. */
function gatherApprovalItems(ctx: ActionContext): ExchangeBoardItem[] {
  const items: ExchangeBoardItem[] = [];
  try {
    for (const a of ctx.pendingApprovals?.forSession(ctx.session) ?? []) items.push(heldApprovalItem(ctx, a as unknown as HeldApproval));
  } catch (e) { console.error("[sitrep] exchange board held-approvals gather failed:", e); }
  try {
    for (const a of ctx.pendingActions?.all() ?? []) items.push(stagedApprovalItem(ctx, a as unknown as StagedApproval));
  } catch (e) { console.error("[sitrep] exchange board staged-approvals gather failed:", e); }
  return items;
}

/**
 * Phase 4, Step 4.2 — gather the exchange-aware board (§ priority tiers, see module doc above).
 * Returns `[]` whenever there is no real exchange activity at all (no store attached, or the store
 * has no needs_input/failed/complete/running/decision rows) — callers MUST treat an empty board as
 * "fall back to the legacy composeSitrep/renderSitrep pipeline", never as "nothing to say".
 * Approvals (tiers 1's held-approval half and tier 5) are folded in ONLY once real exchange
 * activity already justifies taking this path — an approvals-only world (no exchange rows at all)
 * keeps using the legacy pipeline verbatim, so every existing composeSitrep/runStatusSummary golden
 * stays byte-identical.
 */
export function composeExchangeBoard(ctx: ActionContext, now: number): ExchangeBoardItem[] {
  const store = ctx.store;
  const items = store ? gatherExchangeStoreItems(ctx, store, now) : [];
  if (items.length === 0) return []; // no real exchange activity — legacy pipeline handles this response.

  items.push(...gatherApprovalItems(ctx));

  try {
    syncExchangeAttentionItems(ctx, items, now);
  } catch (e) { console.error("[sitrep] exchange attention sync failed:", e); }

  return items;
}

/** Deterministic within-tier order: tier ascending, then most-recently-updated first, then a
 *  stable id tie-break so repeated calls over an UNCHANGED board always render identically. */
export function rankExchangeBoard(items: ExchangeBoardItem[]): ExchangeBoardItem[] {
  return [...items].sort(
    (a, b) =>
      a.tier - b.tier ||
      b.updatedAt - a.updatedAt ||
      (a.exchangeId ?? a.paneId ?? "").localeCompare(b.exchangeId ?? b.paneId ?? ""),
  );
}

/** Pure text rendering — VOICE TERSENESS: one clause per item, joined with a single space (mirrors
 *  the existing renderBrief/renderWalk idiom's word-salad-but-scannable style). Detail beyond one
 *  clause per item belongs to the action panel / replay, not the spoken line. */
export function renderExchangeBoard(items: ExchangeBoardItem[]): string {
  return items.map((i) => i.text).join(" ");
}

/** The exchange-kind -> AttentionItem.type projection for the durable-attention sync below. `null`
 *  means "this tier is not attention-queue-worthy" (approvals/running/decisions already have their
 *  own established surfaces — pendingApprovals/pendingActions and the spoken board itself). */
function attentionTypeForBoardItem(item: ExchangeBoardItem): AttentionItem["type"] | null {
  switch (item.kind) {
    case "needs_input": return "needs_input";
    case "failed": return "error";
    case "complete": return "idle";
    default: return null;
  }
}

/**
 * Phase 4, Step 4.2 — reconcile exchange-derived board items into the durable attention queue
 * (`ctx.manager.attentionQueue`), each carrying `details.exchange_id` (spec: "each carrying
 * exchange_id in details"). This is a PULL-based sync (called from every board composition) rather
 * than a push at the moment the underlying pane transition happens — the true event-occurrence
 * hook (src/observe/index.ts) is out of this step's allowed-paths scope, so a fresh item surfaces
 * the first time any exchange-aware voice action (get_status_summary / catch_me_up) runs after the
 * transition, which is a small, acceptable latency trade for staying inside the allowed surface.
 * Dedupes on (exchange_id, type): a non-dismissed item for the SAME exchange+kind is never
 * duplicated, so repeated syncs across many calls are idempotent.
 */
/** True when `board`'s exchange-derived item already has a live (non-dismissed) attention entry of
 *  the same type in `queue` — split out purely to keep the loop body in
 *  `syncExchangeAttentionItems` a flat one-branch-per-line shape (complexity gate). */
function attentionAlreadyCovers(queue: AttentionItem[], exchangeId: string, type: AttentionItem["type"]): boolean {
  return queue.some((q) => !q.dismissed && q.details?.exchange_id === exchangeId && q.type === type);
}

function newExchangeAttentionItem(
  ctx: ActionContext,
  item: ExchangeBoardItem,
  type: AttentionItem["type"],
  now: number,
): AttentionItem {
  return {
    id: "att_ex_" + Math.random().toString(36).substring(2, 11),
    type,
    terminalId: item.paneId ?? "",
    projectId: item.projectId ?? ctx.manager.ledger?.activeProjectId ?? "default_project",
    message: item.text,
    timestamp: new Date(now).toISOString(),
    dismissed: false,
    details: { exchange_id: item.exchangeId, kind: item.kind },
  };
}

export function syncExchangeAttentionItems(ctx: ActionContext, board: ExchangeBoardItem[], now: number): void {
  const queue = ctx.manager.attentionQueue;
  if (!queue) return;
  for (const item of board) {
    const type = item.exchangeId ? attentionTypeForBoardItem(item) : null;
    if (!type || !item.exchangeId) continue;
    if (attentionAlreadyCovers(queue, item.exchangeId, type)) continue;
    queue.push(newExchangeAttentionItem(ctx, item, type, now));
  }
  ctx.pruneAttention?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// composeSitrep — pure gather (D3). NO prose. Every string field is ALREADY redacted via ctx.redact
// before it lands in the payload, so every downstream consumer (fallbackRanking, renderSitrep, the
// eventual python ranking, and hwu.7's visual renderer) can treat the payload as safe to display.
// ─────────────────────────────────────────────────────────────────────────────
export function composeSitrep(ctx: ActionContext, now: number): SitrepPayload {
  const panes = Object.entries(ctx.manager.terminals).map(([paneId, term]) => {
    const projectId = term.projectId || "default_project";
    const rawName = ctx.manager.ledger.workspaces[projectId]?.panes?.[paneId]?.name || paneId;
    return {
      paneId,
      projectId,
      name: ctx.redact(rawName),
      state: term.status,
      isBusy: term.status === "Running",
      elapsedMs: Math.max(0, now - term.lastStatusChangeAt),
      lastCommand: term.lastCommand ? ctx.redact(term.lastCommand) : null,
    };
  });

  // Held pane-write approvals (this session) + globally-staged deferred actions (gated Ask), MERGED
  // into one "approvals" list — the resolved decision recorded in the architect contract §2.
  const heldApprovals = ctx.pendingApprovals.forSession(ctx.session).map((p) => ({
    id: p.messageId,
    kind: p.kind as string,
    paneId: p.terminalId as string | null,
    summary: ctx.redact(p.instruction),
  }));
  const stagedActions = ctx.pendingActions.all().map((a) => ({
    id: a.id,
    kind: a.capability,
    paneId: null as string | null,
    summary: ctx.redact(a.summary),
  }));

  // BUG-035-style hygiene: evict stale attention items BEFORE reading the queue (same idiom as
  // get_attention_digest / dismiss_attention).
  ctx.pruneAttention();
  // Merge to ONE entry per paneId (the wire SitrepPayload.attention carries no item id — see the
  // wave-3 review finding on duplicate-pane attention). The queue is push-ordered (chronological,
  // oldest first), so joining preserves read order; ageMs takes the MOST RECENT item's age (min) so
  // ranking (newest-first) reflects the freshest alert on that pane, not a stale first one.
  const attentionByPane = new Map<string, { paneId: string; type: string; message: string; ageMs: number }>();
  for (const item of ctx.manager.attentionQueue) {
    if (item.dismissed) continue;
    const message = ctx.redact(item.message);
    const ageMs = Math.max(0, now - Date.parse(item.timestamp));
    const existing = attentionByPane.get(item.terminalId);
    if (existing) {
      existing.message = `${existing.message}; ${message}`;
      existing.ageMs = Math.min(existing.ageMs, ageMs);
    } else {
      attentionByPane.set(item.terminalId, { paneId: item.terminalId, type: item.type, message, ageMs });
    }
  }
  const attention = [...attentionByPane.values()];

  const plans = ctx.manager.ledger.plans
    .filter((p) => p.status === "running" || p.status === "paused")
    .map((p) => ({
      id: p.id,
      name: ctx.redact(p.name),
      status: p.status,
      currentStepIndex: p.currentStepIndex,
      totalSteps: p.steps.length,
    }));

  return {
    now,
    panes,
    approvals: [...heldApprovals, ...stagedActions],
    attention,
    plans,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fallbackRanking — the FIXED deterministic order (D2). Pure; no Date.now(). Every sort carries a
// total (id-based) tie-breaker so re-ranking the SAME payload always yields the SAME order. A
// section with no items is OMITTED (rather than emitted with an empty itemIds array) — sectionIds()
// below treats a missing key exactly like a present key with an empty list, so this is invisible to
// every consumer. Mirror this EXACTLY in python/policies/sitrep.py rank_sitrep() — a SITREP must
// read identically regardless of which side produced the ranking.
// ─────────────────────────────────────────────────────────────────────────────
export function fallbackRanking(payload: SitrepPayload): SitrepRanking {
  // approvals: preserve gather order (already oldest-first — the composer reads the stores in their
  // own insertion order; no timestamp travels in the wire payload to re-derive it from).
  const approvalIds = payload.approvals.map((a) => a.id);

  const busyPaneIds = [...payload.panes]
    .filter((p) => p.isBusy)
    .sort((a, b) => b.elapsedMs - a.elapsedMs || a.paneId.localeCompare(b.paneId))
    .map((p) => p.paneId);
  // Executing-plan items fold into "busy" (resolved decision) — most-progressed first.
  const planIds = [...payload.plans]
    .sort((a, b) => b.currentStepIndex - a.currentStepIndex || a.id.localeCompare(b.id))
    .map((p) => p.id);

  const attentionIds = [...payload.attention]
    .sort((a, b) => a.ageMs - b.ageMs || a.paneId.localeCompare(b.paneId))
    .map((a) => a.paneId);

  const idleIds = [...payload.panes]
    .filter((p) => !p.isBusy)
    .sort((a, b) => a.paneId.localeCompare(b.paneId))
    .map((p) => p.paneId);

  const ordered: Array<{ key: SitrepRanking["sections"][number]["key"]; itemIds: string[] }> = [
    { key: "approvals", itemIds: approvalIds },
    { key: "busy", itemIds: [...busyPaneIds, ...planIds] },
    { key: "attention", itemIds: attentionIds },
    { key: "idle", itemIds: idleIds },
  ];
  return { sections: ordered.filter((s) => s.itemIds.length > 0) };
}

// ─────────────────────────────────────────────────────────────────────────────
// renderSitrep — pure text rendering (golden-testable). Resolves each ranked itemId back against
// the payload: approvals by `id`, busy by paneId-then-plan-id, attention/idle by paneId.
// ─────────────────────────────────────────────────────────────────────────────
function sectionIds(ranking: SitrepRanking, key: SitrepRanking["sections"][number]["key"]): string[] {
  return ranking.sections.find((s) => s.key === key)?.itemIds ?? [];
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins > 0) return `${mins} minute${plural(mins)}`;
  return `${secs} second${plural(secs)}`;
}

function findApproval(payload: SitrepPayload, id: string) {
  return payload.approvals.find((a) => a.id === id);
}

function findPane(payload: SitrepPayload, paneId: string) {
  return payload.panes.find((p) => p.paneId === paneId);
}

function findPlan(payload: SitrepPayload, id: string) {
  return payload.plans.find((p) => p.id === id);
}

function findAttention(payload: SitrepPayload, paneId: string) {
  return payload.attention.find((a) => a.paneId === paneId);
}

function describeApprovalItem(a: { paneId: string | null; summary: string }, index: number): string {
  const where = a.paneId ? `pane ${a.paneId}` : "a staged action";
  return `${index}. ${where}: "${a.summary}"`;
}

/** Resolve one ranked "busy" itemId to prose — it is either a busy pane or an executing plan. */
function describeBusyItem(payload: SitrepPayload, id: string): string | null {
  const pane = findPane(payload, id);
  if (pane) return `pane ${pane.name} (${pane.paneId}), busy for ${formatDuration(pane.elapsedMs)}`;
  const plan = findPlan(payload, id);
  if (plan) return `plan "${plan.name}" at step ${plan.currentStepIndex + 1} of ${plan.totalSteps}`;
  return null;
}

function describeAttentionItem(payload: SitrepPayload, paneId: string): string | null {
  const item = findAttention(payload, paneId);
  return item ? `pane ${item.paneId} ${item.type}: ${item.message}` : null;
}

function describeIdleItem(payload: SitrepPayload, paneId: string): string | null {
  const pane = findPane(payload, paneId);
  return pane ? `pane ${pane.name} (${pane.paneId})` : null;
}

function isEmptyWorld(ranking: SitrepRanking): boolean {
  return (
    sectionIds(ranking, "approvals").length === 0 &&
    sectionIds(ranking, "busy").length === 0 &&
    sectionIds(ranking, "attention").length === 0
  );
}

function renderBrief(payload: SitrepPayload, ranking: SitrepRanking): string {
  const parts: string[] = [];

  const approvals = sectionIds(ranking, "approvals");
  if (approvals.length) {
    const top = findApproval(payload, approvals[0]);
    parts.push(
      `${approvals.length} item${plural(approvals.length)} awaiting your approval` +
        (top ? ` — most pressing: "${top.summary}".` : "."),
    );
  }

  const busy = sectionIds(ranking, "busy");
  if (busy.length) {
    const top = describeBusyItem(payload, busy[0]);
    parts.push(`${busy.length} busy` + (top ? ` — longest-running: ${top}.` : "."));
  }

  const attention = sectionIds(ranking, "attention");
  if (attention.length) {
    const top = describeAttentionItem(payload, attention[0]);
    parts.push(
      `${attention.length} alert${plural(attention.length)}` + (top ? ` — most recent: ${top}.` : "."),
    );
  }

  const idle = sectionIds(ranking, "idle");
  if (idle.length) parts.push(`${idle.length} pane${plural(idle.length)} idle.`);

  return parts.join(" ");
}

function renderWalk(payload: SitrepPayload, ranking: SitrepRanking): string {
  const lines: string[] = [];

  const approvals = sectionIds(ranking, "approvals");
  approvals.forEach((id, i) => {
    const a = findApproval(payload, id);
    if (a) lines.push(describeApprovalItem(a, i + 1));
  });

  const attention = sectionIds(ranking, "attention");
  attention.forEach((id, i) => {
    const text = describeAttentionItem(payload, id);
    if (text) lines.push(`${approvals.length + i + 1}. ${text}`);
  });

  const tail: string[] = [];
  const busyCount = sectionIds(ranking, "busy").length;
  const idleCount = sectionIds(ranking, "idle").length;
  if (busyCount) tail.push(`${busyCount} busy`);
  if (idleCount) tail.push(`${idleCount} idle`);
  if (tail.length) lines.push(`Also: ${tail.join(", ")}.`);

  return lines.join(" ");
}

function renderFull(payload: SitrepPayload, ranking: SitrepRanking): string {
  const lines: string[] = [];

  sectionIds(ranking, "approvals").forEach((id, i) => {
    const a = findApproval(payload, id);
    if (a) lines.push(describeApprovalItem(a, i + 1));
  });
  sectionIds(ranking, "busy").forEach((id) => {
    const text = describeBusyItem(payload, id);
    if (text) lines.push(`Busy: ${text}.`);
  });
  sectionIds(ranking, "attention").forEach((id) => {
    const text = describeAttentionItem(payload, id);
    if (text) lines.push(`Alert: ${text}.`);
  });
  sectionIds(ranking, "idle").forEach((id) => {
    const text = describeIdleItem(payload, id);
    if (text) lines.push(`Idle: ${text}.`);
  });

  return lines.join(" ");
}

export function renderSitrep(
  payload: SitrepPayload,
  ranking: SitrepRanking,
  shape: "brief" | "walk" | "full",
): string {
  if (isEmptyWorld(ranking)) return EMPTY_SITREP_TEXT;
  if (shape === "full") return renderFull(payload, ranking);
  if (shape === "walk") return renderWalk(payload, ranking);
  return renderBrief(payload, ranking);
}

// ─────────────────────────────────────────────────────────────────────────────
// A schema-valid ranking from the policies daemon is trusted verbatim by design (D2 fallback
// contract only covers null/timeout/schema-reject) — but a daemon that answers `ok:true` with a
// ranking that DROPS a section the payload actually has pending items for would otherwise render a
// false all-clear (e.g. "Nothing needs your attention" while approvals are outstanding). This is a
// defense-in-depth coverage check, not a widening of the fallback contract: it only ever REJECTS a
// ranking (falling back to fallbackRanking), never accepts something outside it.
// ─────────────────────────────────────────────────────────────────────────────
function rankingCoversPendingWork(payload: SitrepPayload, ranking: SitrepRanking): boolean {
  const payloadHasWork =
    payload.approvals.length > 0 ||
    payload.panes.some((p) => p.isBusy) ||
    payload.plans.length > 0 ||
    payload.attention.length > 0;
  if (!payloadHasWork) return true; // genuinely empty world; any ranking (incl. []) is fine
  if (ranking.sections.length === 0) return false; // would render the empty-world sentence, falsely
  if (payload.approvals.length > 0 && sectionIds(ranking, "approvals").length === 0) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// runStatusSummary — the impure entry point the get_status_summary tool def delegates to.
// ─────────────────────────────────────────────────────────────────────────────
/** Count of currently-idle panes, appended as a one-line tail after an exchange-aware board so
 *  "what's free right now" is never silently dropped just because real exchange activity exists
 *  elsewhere. Deliberately NOT routed through renderSitrep (whose isEmptyWorld() treats an
 *  idle-only ranking as "nothing to report" — correct for the LEGACY empty-world sentence, wrong
 *  here where the board has already established there IS something to report). */
function idleTail(payload: SitrepPayload): string {
  const idleCount = payload.panes.filter((p) => !p.isBusy).length;
  return idleCount === 0 ? "" : `${idleCount} pane${idleCount === 1 ? "" : "s"} idle.`;
}

export async function runStatusSummary(ctx: ActionContext): Promise<ActionResult> {
  try {
    const now = Date.now();
    // Phase 4, Step 4.2: prefer the exchange-aware board whenever there is real exchange activity
    // (see composeExchangeBoard's doc — an empty board means "no exchange activity at all", and the
    // legacy pipeline below runs byte-identical to before this step, preserving every existing
    // golden). Never throws (composeExchangeBoard/rankExchangeBoard are pure/guarded internally).
    const board = rankExchangeBoard(composeExchangeBoard(ctx, now));
    if (board.length > 0) {
      const payload = composeSitrep(ctx, now);
      const tail = idleTail(payload);
      const text = tail ? `${renderExchangeBoard(board)} ${tail}` : renderExchangeBoard(board);
      return { kind: "ok", output: text };
    }

    const payload = composeSitrep(ctx, now);
    const remoteRanking = (await ctx.policies?.rankSitrep(payload)) ?? null;
    const ranking =
      remoteRanking && rankingCoversPendingWork(payload, remoteRanking)
        ? remoteRanking
        : fallbackRanking(payload);
    const shape = (ctx.manager.settings.voiceUx ?? DEFAULT_VOICE_UX).sitrepShape;
    return { kind: "ok", output: renderSitrep(payload, ranking, shape) };
  } catch {
    // Never throw (contract): any unexpected failure still answers the call once.
    return { kind: "ok", output: "The status summary could not be generated right now." };
  }
}
