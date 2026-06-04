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

import { parseApprovalIntent, selectPendingAction } from "./approvalIntent";

/** Minimal structural view of the PendingActionStore this resolver needs (keeps it decoupled). */
export interface PendingActionResolverStore {
  all(): Array<{ id: string; summary: string }>;
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
  const { broadcast, narrate, redact } = deps;
  const parsed = parseApprovalIntent(utterance);
  if (parsed.intent === "none") return;

  const all = actions.all();
  if (all.length === 0) return;

  if (parsed.intent === "clarify") {
    narrate(
      `I heard both approve and reject — which of the ${all.length} pending action${all.length === 1 ? "" : "s"} did you mean?`,
    );
    return;
  }

  const target = selectPendingAction(all.map((a) => ({ id: a.id, summary: a.summary })), parsed.targetHint);
  if (target.ambiguous || !target.id) {
    // >1 staged and nothing disambiguates -> read back the SUMMARIES (actions have no meaningful
    // terminalId; never narrate an empty pane id).
    const list = all.map((a, i) => `${i + 1}. ${redact(a.summary)}`).join("; ");
    narrate(`I have ${all.length} pending action${all.length === 1 ? "" : "s"}: ${list}. Which one?`);
    return;
  }

  const summary = target.summary ?? "";

  if (parsed.intent === "approve") {
    try {
      const result = actions.confirm(target.id);
      if (result.reason === "confirmed") {
        broadcast({ type: "action_resolved", actionId: target.id, outcome: "confirmed" });
        narrate(`Done — ${redact(summary)}.`);
      }
      // lost_race / not_found -> a concurrent REST already resolved it; stay silent.
    } catch (e) {
      // confirm() already removed the record before run() threw (terminal, nothing to roll back). The
      // only job here is to not crash the handler and to inform the operator + UI.
      const msg = e instanceof Error ? e.message : String(e);
      broadcast({ type: "action_resolved", actionId: target.id, outcome: "failed", error: msg });
      narrate(`That action failed — ${redact(summary)}: ${redact(msg)}.`);
    }
  } else {
    // reject
    const result = actions.cancel(target.id);
    broadcast({ type: "action_resolved", actionId: target.id, outcome: "cancelled" });
    if (result.reason === "cancelled") narrate(`Cancelled — ${redact(summary)}.`);
  }
}
