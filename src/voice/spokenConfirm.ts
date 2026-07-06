// src/voice/spokenConfirm.ts — the spoken destructive-confirm protocol (voice-UX wave 3, bead
// wsm-e2e-pinned-f09.1). Sole owner: f09. Entirely synchronous TS — same fail-closed reasoning as
// the capability gate; uses the TS parseApprovalIntent + selectPendingAction imports directly,
// NEVER the python approval path (D5, docs/superpowers/specs/2026-07-02-voice-ux-trio-design.md).
//
// D5 in one paragraph: a destructive action (delete_pane / delete_project / clear_history) gated to
// Ask creates the SAME pendingActions record as today (no second store). The voice lane reads it
// back VERBATIM and opens a confirmTimeoutMs phrase window. Inside the window the action-echo phrase
// ("confirm delete" / "confirm clear") resolves it through the EXISTING claim-and-delete
// pendingActions.confirm() (exactly-once); bare yes/affirmatives are rejected with exactly ONE
// re-prompt; a second bare yes, an explicit cancel word, or the timer expiring all cancel the SPOKEN
// PROMPT ONLY — the underlying pendingActions record is untouched and keeps its own TTL, staying
// resolvable via the UI or a typed/spoken SURE. An explicit reject (paired reject verb) closes our
// window and falls through (`return false`) so the normal approval routing rejects the record for
// real. Non-destructive pendingActions targets are never touched here (`return false` lets the
// existing voiceApprovalRouting resolve them, byte-identical to before this file existed).
import { normalizeUtterance, parseApprovalIntent, selectPendingAction } from "../approvalIntent";
import type { TargetableEntry } from "../approvalIntent";

/** The frozen dependency bag createSpokenConfirm takes. Every field is a live closure/binding from
 *  the caller's connection scope, injected by reference (same posture as ActionContext). */
export interface SpokenConfirmDeps {
  narrate(text: string): void;
  redact(s: string): string;
  nowMs(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  confirmTimeoutMs(): number;
  pendingActions: {
    all(): Array<{ id: string; summary: string; capability?: string; claimed?: boolean }>;
    confirm(id: string): { reason: string; output?: string };
    cancel(id: string): { reason: string };
  };
  heldEntries(): TargetableEntry[];
  broadcast(msg: unknown): void;
}

/** The CONFIRM_PHRASES table (static, explicitly enumerated, extensible). The destructive class is a
 *  staged pendingActions record whose `capability` is one of these keys. */
export const CONFIRM_PHRASES: Readonly<Record<string, string>> = {
  delete_pane: "confirm delete",
  delete_project: "confirm delete",
  clear_history: "confirm clear",
};

export interface SpokenConfirm {
  /** Consume one operator utterance IFF it is part of the spoken-confirm protocol (arming/advancing/
   *  resolving a destructive confirm window). Returns true when the utterance was consumed (the
   *  caller's normal approval routing must NOT also process it); false to fall through unchanged. */
  intercept(utterance: string): boolean;
  /** Cancel any open window (ws close) — the SPOKEN PROMPT only; the staged action itself is untouched. */
  dispose(): void;
}

type PendingActionRecord = ReturnType<SpokenConfirmDeps["pendingActions"]["all"]>[number];

/** Look up the confirm phrase for a record's capability, or undefined when it's not in the
 *  destructive class (or has no capability at all — the frozen deps type marks it optional). */
function destructivePhraseFor(capability: string | undefined): string | undefined {
  if (!capability) return undefined;
  return (CONFIRM_PHRASES as Record<string, string | undefined>)[capability];
}

/** Bare cancel words the operator may say INSIDE an open window to close the spoken prompt only
 *  (the underlying pendingActions record is left untouched — same posture as a timeout). These are
 *  deliberately NOT routed through parseApprovalIntent: a lone "cancel"/"never mind" is too short to
 *  pair as a reject verb under the general parser's ambient-speech guard (P0-A), but inside this
 *  narrow, single-target window a permissive literal match is safe — the worst case is closing a
 *  prompt that stays fully resolvable afterward. */
const WINDOW_CANCEL_WORDS = new Set(["cancel", "never mind", "nevermind"]);

/** One open confirm window's live state. At most one may be open at a time (D5 resolved decision). */
interface ArmedWindow {
  actionId: string;
  summary: string;
  phrase: string;
  timer: unknown;
}

export function createSpokenConfirm(deps: SpokenConfirmDeps): SpokenConfirm {
  let phase: "idle" | "awaiting_phrase" | "reprompted" = "idle";
  let armed: ArmedWindow | null = null;

  const closeWindow = (): void => {
    if (armed) deps.clearTimer(armed.timer);
    armed = null;
    phase = "idle";
  };

  const onTimeout = (): void => {
    if (!armed) return;
    const summary = armed.summary;
    closeWindow();
    deps.narrate(
      `The spoken confirm window closed — '${deps.redact(summary)}' is still pending; approve it in the UI or ask me again.`
    );
  };

  const armWindow = (id: string, summary: string, phrase: string): void => {
    const timer = deps.setTimer(onTimeout, deps.confirmTimeoutMs());
    armed = { actionId: id, summary, phrase, timer };
    phase = "awaiting_phrase";
    const seconds = Math.round(deps.confirmTimeoutMs() / 1000);
    deps.narrate(
      `Heads up — '${deps.redact(summary)}' is destructive. To approve it, say '${phrase}' within ${seconds} seconds; anything else leaves it pending.`
    );
  };

  /** Resolve via the EXISTING claim-and-delete machinery. Mirrors voiceApprovalRouting's
   *  handleApprove: confirm() removes the record then runs its side effect and can rethrow — caught
   *  here so a failing effect surfaces as `action_resolved`/failed instead of unwinding the caller. */
  const resolveConfirmed = (id: string, summary: string): void => {
    try {
      const result = deps.pendingActions.confirm(id);
      if (result.reason === "confirmed") {
        deps.broadcast({ type: "action_resolved", actionId: id, outcome: "confirmed" });
        deps.narrate(`Done — ${deps.redact(summary)}.`);
      }
      // lost_race / not_found -> a concurrent REST confirm/cancel already resolved it; stay silent.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.broadcast({ type: "action_resolved", actionId: id, outcome: "failed", error: msg });
      deps.narrate(`That action failed — ${deps.redact(summary)}: ${deps.redact(msg)}.`);
    }
  };

  const cancelPromptOnly = (): void => {
    const summary = armed?.summary ?? "";
    closeWindow();
    deps.narrate(`Cancelled — '${deps.redact(summary)}' is still pending; approve it in the UI or ask me again.`);
  };

  /** idle: parse the utterance. Only an approve intent (with no held pane-write approvals in the
   *  way) can ever touch the destructive class; everything else is not our concern. */
  const handleIdle = (utterance: string): boolean => {
    const parsed = parseApprovalIntent(utterance);
    if (parsed.intent !== "approve") return false;
    if (deps.heldEntries().length > 0) return false; // held write approvals keep their precedence.

    const all = deps.pendingActions.all();
    if (all.length === 0) return false;
    const target = selectPendingAction(all.map((a) => ({ id: a.id, summary: a.summary })), parsed.targetHint);
    if (target.ambiguous || !target.id) return false;

    const rec: PendingActionRecord | undefined = all.find((a) => a.id === target.id);
    const phrase = rec ? destructivePhraseFor(rec.capability) : undefined;
    if (!rec || !phrase) return false; // non-destructive target -> normal routing handles it.

    // Front-loaded phrase ("confirm delete" as the FIRST utterance): the phrase is strictly stronger
    // than yes, so a unique destructive target resolves in one turn instead of arming a window.
    if (normalizeUtterance(utterance) === phrase) {
      resolveConfirmed(rec.id, rec.summary);
      return true;
    }
    armWindow(rec.id, rec.summary, phrase);
    return true;
  };

  /** awaiting_phrase / reprompted: the window is open for exactly one destructive target. */
  const handleWindowedUtterance = (utterance: string): boolean => {
    if (!armed) return false; // defensive; phase should never be non-idle without an armed window.
    const normalized = normalizeUtterance(utterance);

    if (normalized === armed.phrase) {
      const { actionId, summary } = armed;
      closeWindow();
      resolveConfirmed(actionId, summary);
      return true;
    }
    if (WINDOW_CANCEL_WORDS.has(normalized)) {
      cancelPromptOnly();
      return true;
    }

    const parsed = parseApprovalIntent(utterance);
    if (parsed.intent === "reject") {
      closeWindow(); // falls through so the normal reject routing rejects the record for real.
      return false;
    }
    if (parsed.intent === "approve") {
      if (phase !== "reprompted") {
        phase = "reprompted";
        deps.narrate(`A yes isn't enough for this one — say '${armed.phrase}' to run it.`);
        return true;
      }
      cancelPromptOnly(); // a second bare yes cancels the SPOKEN PROMPT only.
      return true;
    }
    return false; // anything else -> the window stays open, unconsumed.
  };

  return {
    intercept(utterance: string): boolean {
      return phase === "idle" ? handleIdle(utterance) : handleWindowedUtterance(utterance);
    },
    dispose(): void {
      // ws close: cancel the SPOKEN PROMPT only — the pendingActions record survives and stays
      // resolvable via UI/typed SURE (D5).
      closeWindow();
    },
  };
}
