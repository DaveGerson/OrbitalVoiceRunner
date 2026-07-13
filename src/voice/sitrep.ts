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
import { DEFAULT_VOICE_UX, type AttentionItem, type FleetExchangeTier, type FleetExchangeKind } from "../types";
import type { AgentExchange, ExchangeEvent, ExchangeState } from "../exchanges/types";
import { tierKindForState } from "../exchanges/priority";
import { redactCapped } from "../exchanges/textUtil";
import { getExchangeNarrationGate } from "../announcementBus";

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

/** Aliases of the src/types.ts six-tier unions (FleetExchangeTier/FleetExchangeKind) — the exact
 *  same tiering shared with src/exchanges/fleetProjection.ts's FleetExchangeSummary and
 *  src/orbital/fleetExchangeOrdering.ts's FleetRow. `FleetExchangeKind` also carries `"staged"`
 *  (tier 5, a durable-summary-only case this board never emits itself — approval items use kind
 *  `"approval"` directly), so this is a strict widening, never a narrowing, of what this board's
 *  own items are ever assigned. */
export type ExchangeBoardTier = FleetExchangeTier;
export type ExchangeBoardKind = FleetExchangeKind;

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
/** Phase 5.5 (the 4.5 review's B11 finding): tier-3 completions are WINDOWED, mirroring tier 6's
 *  DECISION_WINDOW_MS rationale — "delivered exchanges with a meaningful result" means RECENT
 *  results. Unwindowed, every terminal `agent_complete` row (retained up to the 30-DAY store TTL,
 *  src/store/retention.ts) re-surfaced on every single SITREP until pruned. A completion older
 *  than this window falls off the spoken board; its durable record stays reachable via replay /
 *  the attention queue / catch_me_up's own away-window filter (src/actions/defs/catchup.ts). */
export const COMPLETION_WINDOW_MS = 30 * 60 * 1000;

function capBoardText(s: string, max: number = BOARD_TEXT_CAP): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** A minimal ledger read surface — `OrchestratorManager["ledger"]` satisfies this directly. */
interface LedgerLike {
  workspaces?: Record<string, { panes?: Record<string, { name?: string }> }>;
}

/** Resolve a pane's display name off the ledger, falling back to the bare pane id, then redact (a
 *  ledger-recorded pane name is operator-authored free text). Shared by every board/narration
 *  surface that needs "what does this pane look like to the operator" — composeSitrep and the
 *  exchange board here, and src/voice/index.ts's live-session narration seam (resolvePaneLabel). A
 *  null `projectId` (no known owning project) degrades straight to the bare paneId, same as a
 *  project id with no matching workspace entry. */
export function paneDisplayLabel(
  ledger: LedgerLike | undefined,
  projectId: string | null,
  paneId: string,
  redact: (s: string) => string,
): string {
  const raw = projectId ? (ledger?.workspaces?.[projectId]?.panes?.[paneId]?.name || paneId) : paneId;
  return redact(raw);
}

/** Thin exchange-board-specific wrapper — every caller here always has a non-null `projectId`. */
function exchangePaneLabel(ctx: ActionContext, projectId: string, paneId: string): string {
  return paneDisplayLabel(ctx.manager.ledger, projectId, paneId, ctx.redact);
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
  const q = redactCapped(terminalState, redact, BOARD_TEXT_CAP);
  return q ? `Pane '${paneLabel}' needs your input: "${q}"` : `Pane '${paneLabel}' needs your input.`;
}

function failedLine(paneLabel: string, terminalState: string | null, redact: (s: string) => string): string {
  const d = redactCapped(terminalState, redact, BOARD_TEXT_CAP);
  return d ? `Pane '${paneLabel}' failed: ${d}` : `Pane '${paneLabel}' failed.`;
}

/** null = no meaningful result to say (a completion with nothing to report is not narrated). */
function completeLine(paneLabel: string, resultSummary: string | null, redact: (s: string) => string): string | null {
  const s = redactCapped(resultSummary, redact, BOARD_TEXT_CAP);
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

/** One parameterized builder for every store-derived board item (tiers 1a/2/3/4) — collapses what
 *  used to be four near-identical needsInputItem/failedItem/completeItem/runningItem functions
 *  (same shape, differing only in which literal tier/kind/state they hardcoded). Tier/kind now come
 *  from the shared src/exchanges/priority.ts table keyed on the exchange's OWN `state` — exactly
 *  the same values each hardcoded call site passed (every caller only ever hands this a `ex` whose
 *  `state` is already within the state-group it queried for, e.g. needs_input-only, running/
 *  delivered, etc.), so this is a mechanical, behavior-preserving fold. Keeps the tier-3 "no
 *  meaningful result" null guard (a completion with nothing to report is not narrated) — the ONLY
 *  builder that can return null. */
function exchangeStoreBoardItem(ctx: ActionContext, ex: AgentExchange): ExchangeBoardItem | null {
  const pane = exchangePaneLabel(ctx, ex.project_id, ex.pane_id);
  const text = terseExchangeOutcomeLine(pane, ex.state, ex.terminal_state, ex.result_summary, ctx.redact);
  if (!text) return null;
  const { tier, kind } = tierKindForState(ex.state);
  return {
    tier, kind, exchangeId: ex.exchange_id, paneId: ex.pane_id, projectId: ex.project_id,
    text, updatedAt: ex.updated_at,
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

/** Push `exchangeStoreBoardItem(ctx, ex)` for every `ex` in `exchanges`, skipping the ones that
 *  build to `null` (the tier-3 "no meaningful result" guard). Split out of
 *  gatherExchangeStoreItems purely so its own per-state loops stay a flat one-liner each
 *  (complexity gate). */
function pushExchangeStoreBoardItems(items: ExchangeBoardItem[], ctx: ActionContext, exchanges: AgentExchange[]): void {
  for (const ex of exchanges) {
    const it = exchangeStoreBoardItem(ctx, ex);
    if (it) items.push(it);
  }
}

/** Tiers 1a/2/3/4/6 — every item derived DIRECTLY from the durable exchange store. Split out of
 *  composeExchangeBoard purely to keep that function's own branch count low (complexity gate). */
function gatherExchangeStoreItems(ctx: ActionContext, store: NonNullable<ActionContext["store"]>, now: number): ExchangeBoardItem[] {
  const items: ExchangeBoardItem[] = [];
  pushExchangeStoreBoardItems(items, ctx, safeList(() => store.listExchangesByStates(["needs_input"])));
  pushExchangeStoreBoardItems(items, ctx, safeList(() => store.listExchangesByStates(["agent_failed", "interrupted"])));
  const recentComplete = safeList(() => store.listExchangesByStates(["agent_complete"]))
    .filter((ex) => ex.updated_at >= now - COMPLETION_WINDOW_MS); // B11: recent results only (see COMPLETION_WINDOW_MS)
  pushExchangeStoreBoardItems(items, ctx, recentComplete);
  pushExchangeStoreBoardItems(items, ctx, safeList(() => store.listExchangesByStates(["running", "delivered"])));
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

/** Phase 5.5 (the 4.5 review's B11 finding): COMPLETION attention items are minted exactly once
 *  per (exchange_id, updated_at) anchor for the process lifetime. This reuses the shared
 *  ExchangeNarrationGate (src/announcementBus.ts) — the SAME exactly-once derived-anchor primitive
 *  the live voice-session narration seam uses — instead of a second, hand-rolled Set with identical
 *  semantics; event type "attention_complete" keeps this mint's keyspace disjoint from the live
 *  narration seam's own event types on the shared gate. Without it, a completion whose attention
 *  item was dismissed or TTL-pruned (pruneAttentionQueue) was re-minted by the very next board
 *  sync, nagging forever. Scoped to `complete` ONLY: needs_input/failed are the operator's
 *  OUTSTANDING backlog, and their dismiss-then-re-push behavior is pinned intended
 *  (tests/test_exchange_notifications.ts "a DISMISSED prior item does not block a fresh push") —
 *  an unanswered question should keep resurfacing; a finished result should not. A NEW completion
 *  on the same exchange (a fresh transition ⇒ fresh updated_at) is a fresh anchor, minted again.
 *  Test-only reset: resetExchangeNarrationGateForTests (src/announcementBus.ts) — no separate reset
 *  seam here anymore. */
function completionAlreadyMinted(item: ExchangeBoardItem): boolean {
  if (item.kind !== "complete" || !item.exchangeId) return false;
  return !getExchangeNarrationGate().shouldNarrate(item.exchangeId, "attention_complete", item.updatedAt);
}

export function syncExchangeAttentionItems(ctx: ActionContext, board: ExchangeBoardItem[], now: number): void {
  const queue = ctx.manager.attentionQueue;
  if (!queue) return;
  for (const item of board) {
    const type = item.exchangeId ? attentionTypeForBoardItem(item) : null;
    if (!type || !item.exchangeId) continue;
    if (completionAlreadyMinted(item)) continue;
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
    return {
      paneId,
      projectId,
      name: paneDisplayLabel(ctx.manager.ledger, projectId, paneId, ctx.redact),
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
/** Count of currently-idle panes, straight from `ctx.manager.terminals` — the SAME `isBusy` rule
 *  `composeSitrep` uses (`term.status === "Running"`), without paying for that function's full
 *  legacy gather (panes/approvals/attention/plans) just to read one field of it. Appended as a
 *  one-line tail after an exchange-aware board so "what's free right now" is never silently
 *  dropped just because real exchange activity exists elsewhere. Deliberately NOT routed through
 *  renderSitrep (whose isEmptyWorld() treats an idle-only ranking as "nothing to report" — correct
 *  for the LEGACY empty-world sentence, wrong here where the board has already established there
 *  IS something to report). */
function idleTailFromTerminals(ctx: ActionContext): string {
  const idleCount = Object.values(ctx.manager.terminals).filter((t) => t.status !== "Running").length;
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
      // This path used to call composeSitrep(ctx, now) purely to read its idle-pane count back out
      // — composeSitrep's BUG-035-style attention-queue hygiene (pruneAttention() BEFORE reading
      // the queue) was a side effect of that call, not something idleTailFromTerminals needs, so it
      // is preserved explicitly here rather than silently dropped now that composeSitrep itself is
      // no longer on this path.
      ctx.pruneAttention();
      const tail = idleTailFromTerminals(ctx);
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
