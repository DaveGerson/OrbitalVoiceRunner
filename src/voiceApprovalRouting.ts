// src/voiceApprovalRouting.ts — REAL voice-approval routing logic, lifted out of server.ts's
// onmessage inline block so the SERVER and the tests run the SAME code (no hand-copied mirror to
// drift). Two pieces:
//
//   shouldRouteUtterance        — A4: the short-utterance gate. Route any utterance with non-
//                                 whitespace content; drop only empty/whitespace ASR noise. (Was
//                                 `cleanUtter.length > 2` in server.ts, which amputated bare votes
//                                 like "no"/"ok" before they reached the already-bare-vote-aware
//                                 parser.)
//   resolvePendingActionByVoice — A5: resolve a GLOBAL staged pendingAction (gateOrDefer Ask branch)
//                                 by voice, MIRRORING the REST confirm/cancel handlers AND wrapping
//                                 confirm() in try/catch so a throwing run() can't unwind the voice
//                                 message handler. (REST already does this; voice did not.)

import { parseApprovalIntent, selectPendingAction, MAX_DEFERRALS } from "./approvalIntent";
import { ACTION_DEFAULT_TTL_MS } from "./pendingActions";

/** Minimal structural view of the PendingActionStore this resolver needs (keeps it decoupled).
 *  4D.3: all() now exposes the record's sweep fields (timestamp / lastCallAt) because the DEFER
 *  verb re-arms the TTL window by mutating the live record in place — the real
 *  PendingActionStore.all() already returns the live PendingAction objects, so this is a
 *  structural widening, not a behavior change. */
export interface PendingActionResolverStore {
  all(): Array<{ id: string; summary: string; timestamp: number; lastCallAt?: number; claimed?: boolean }>;
  confirm(id: string): { reason: string; output?: string };
  cancel(id: string): { reason: string };
}

export interface VoiceApprovalDeps {
  /** Fan out an `action_resolved` frame to WS clients (server.ts `broadcast`). */
  broadcast: (msg: unknown) => void;
  /** Speak a line to the operator (server.ts injects `(t) => pushApprovalNarration(session, t)`). */
  narrate: (text: string) => void;
  /** Redact secrets from any text before it leaves the process (server.ts `redactSecrets`). */
  redact: (s: string) => string;
}

/**
 * A4 — should this (already-trimmed) operator utterance be routed to the approval parser? Route any
 * utterance carrying non-whitespace content so bare votes ("no", "ok", "go") reach the parser; drop
 * only empty/whitespace fragments. The parser itself (parseApprovalIntent) is the real safety choke-
 * point — it resolves the explicit BARE_YES/BARE_NO allowlist and returns "none" for ambient speech.
 */
export function shouldRouteUtterance(utterance: string): boolean {
  return utterance.trim().length > 0;
}

/** The live record rows returned by `actions.all()`, widened with the in-place defer counter. */
type ActionRecord = ReturnType<PendingActionResolverStore["all"]>[number];
type DeferrableRecord = ActionRecord & { deferCount?: number };

/** Pluralized "pending action(s)" suffix — identical phrasing to the original inline template. */
function pendingActionWord(count: number): string {
  return `pending action${count === 1 ? "" : "s"}`;
}

/** clarify — operator said both approve and reject; ask which of the N pending actions they meant. */
function narrateClarify(narrate: VoiceApprovalDeps["narrate"], count: number): void {
  narrate(`I heard both approve and reject — which of the ${count} ${pendingActionWord(count)} did you mean?`);
}

/** ambiguous target — >1 staged and nothing disambiguates: read back the redacted SUMMARIES. */
function narrateAmbiguous(deps: VoiceApprovalDeps, all: ActionRecord[]): void {
  const { narrate, redact } = deps;
  const list = all.map((a, i) => `${i + 1}. ${redact(a.summary)}`).join("; ");
  narrate(`I have ${all.length} ${pendingActionWord(all.length)}: ${list}. Which one?`);
}

/**
 * defer — "later" / "not now" / "hold that" must NEVER fall into the cancel branch. Re-arm the
 * record's TTL window IN PLACE (the sweep measures off the in-memory `timestamp`; see
 * gating.sweepExpiredApprovals + PendingActionStore.expired) and clear the last-call transient so the
 * fresh window earns a fresh last-call. The record is NEVER claimed/removed here — a later
 * approve/reject (or the normal expiry) still resolves it exactly once. No-infinite-parking cap:
 * after MAX_DEFERRALS re-arms, refuse further holds and let the normal last-call → grace → expire
 * flow close it out on the last-armed window.
 */
function handleDefer(deps: VoiceApprovalDeps, actions: PendingActionResolverStore, targetId: string, summary: string): void {
  const { narrate, redact } = deps;
  const rec = actions.all().find((a) => a.id === targetId);
  if (!rec) return; // resolved concurrently — nothing to hold.
  const r = rec as DeferrableRecord;
  const count = r.deferCount ?? 0;
  if (count >= MAX_DEFERRALS) {
    narrate(`I've already held that ${MAX_DEFERRALS} times — ${redact(summary)} needs a yes or a no now.`);
    return;
  }
  r.deferCount = count + 1;
  rec.timestamp = Date.now();
  rec.lastCallAt = undefined;
  narrate(`Holding it — I'll ask again in ${Math.round(ACTION_DEFAULT_TTL_MS / 60000)} minutes.`);
}

/**
 * approve — confirm() removes the record then runs its side effect, rethrowing on failure. The
 * try/catch keeps a throwing run() from unwinding the voice handler: a failed run is surfaced as
 * `action_resolved`/`failed` to the UI plus a spoken failure (mirroring the REST handler).
 */
function handleApprove(deps: VoiceApprovalDeps, actions: PendingActionResolverStore, targetId: string, summary: string): void {
  const { broadcast, narrate, redact } = deps;
  try {
    const result = actions.confirm(targetId);
    if (result.reason === "confirmed") {
      broadcast({ type: "action_resolved", actionId: targetId, outcome: "confirmed" });
      narrate(`Done — ${redact(summary)}.`);
    }
    // lost_race / not_found -> a concurrent REST already resolved it; stay silent.
  } catch (e) {
    // confirm() already removed the record before run() threw (terminal, nothing to roll back). The
    // only job here is to not crash the handler and to inform the operator + UI.
    const msg = e instanceof Error ? e.message : String(e);
    broadcast({ type: "action_resolved", actionId: targetId, outcome: "failed", error: msg });
    narrate(`That action failed — ${redact(summary)}: ${redact(msg)}.`);
  }
}

/** reject — cancel() claims+removes without running; broadcast cancelled, narrate on a true cancel. */
function handleReject(deps: VoiceApprovalDeps, actions: PendingActionResolverStore, targetId: string, summary: string): void {
  const { broadcast, narrate, redact } = deps;
  const result = actions.cancel(targetId);
  broadcast({ type: "action_resolved", actionId: targetId, outcome: "cancelled" });
  if (result.reason === "cancelled") narrate(`Cancelled — ${redact(summary)}.`);
}

/**
 * A5 — resolve a GLOBAL staged pendingAction by voice. Behaviorally identical to the prior server.ts
 * inline block EXCEPT the approve branch is wrapped in try/catch: pendingActions.confirm() removes the
 * record and THEN runs its side effect, rethrowing on failure; an unguarded throw used to unwind the
 * Gemini onmessage handler (operator hears nothing, action silently gone). Now a failed run is
 * surfaced — `action_resolved`/`failed` to the UI + a spoken failure to the operator — mirroring the
 * REST handler's resilience (server.ts:2169).
 */
export function resolvePendingActionByVoice(
  utterance: string,
  actions: PendingActionResolverStore,
  deps: VoiceApprovalDeps,
): void {
  const parsed = parseApprovalIntent(utterance);
  if (parsed.intent === "none") return;

  const all = actions.all();
  if (all.length === 0) return;

  if (parsed.intent === "clarify") {
    narrateClarify(deps.narrate, all.length);
    return;
  }

  const target = selectPendingAction(all.map((a) => ({ id: a.id, summary: a.summary })), parsed.targetHint);
  if (target.ambiguous || !target.id) {
    // >1 staged and nothing disambiguates -> read back the SUMMARIES (actions have no meaningful
    // terminalId; never narrate an empty pane id).
    narrateAmbiguous(deps, all);
    return;
  }

  const summary = target.summary ?? "";

  if (parsed.intent === "defer") {
    handleDefer(deps, actions, target.id, summary);
  } else if (parsed.intent === "approve") {
    handleApprove(deps, actions, target.id, summary);
  } else {
    handleReject(deps, actions, target.id, summary);
  }
}
