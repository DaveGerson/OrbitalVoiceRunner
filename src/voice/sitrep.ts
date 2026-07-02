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
import { DEFAULT_VOICE_UX } from "../types";

const EMPTY_SITREP_TEXT =
  "Nothing needs your attention: no pending approvals, no alerts, and no panes are busy.";

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
export async function runStatusSummary(ctx: ActionContext): Promise<ActionResult> {
  try {
    const payload = composeSitrep(ctx, Date.now());
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
