/**
 * WS-D (BUG-010): client-side event-bus mapping.
 *
 * The server broadcasts ~9 orchestration event types that previously had NO client
 * handler (the UI leaned on a 3s poll). This module is the pure, DOM-free description
 * of how each pushed event drives React state + an earcon, so the dispatch table can be
 * unit-tested without jsdom (the App.tsx `ws.onmessage` handler consumes it).
 */

import type { EarconTypeOrNull } from "./announcementKinds";

/** The client event bus may also yield "no earcon", so it uses the null-augmented alias. */
export type EarconType = EarconTypeOrNull;

/** Which React setter a pushed event feeds (so the UI no longer depends on the poll). */
export type SetterKey =
  | "setAttentionQueue"
  | "setPlans"
  | "setWatchRules"
  | "fetchTerminals"
  | "fetchPlans"
  | "noop";

export interface EventEffect {
  setter: SetterKey;
  earcon: EarconType;
}

/** The authoritative event -> (setter, earcon) mapping. Data-driven so it is testable. */
export function effectForEvent(msg: any): EventEffect | null {
  switch (msg?.type) {
    case "attention_updated":
      return { setter: "setAttentionQueue", earcon: earconForAttention(msg.queue) };
    case "plans_updated":
      return { setter: "setPlans", earcon: null };
    case "watch_rules_updated":
      return { setter: "setWatchRules", earcon: null };
    case "pane_transition":
      return { setter: "fetchTerminals", earcon: earconForTransition(msg.transition) };
    case "plan_step_completed":
      return { setter: "fetchPlans", earcon: "execute" };
    case "plan_completed":
      return { setter: "fetchPlans", earcon: "success" };
    case "plan_paused":
      return { setter: "fetchPlans", earcon: "alert" };
    case "history_updated":
      return { setter: "noop", earcon: null };
    case "watch_rule_fired":
      return { setter: "fetchTerminals", earcon: "chime" };
    default:
      return null;
  }
}

/** Highest unread severity in the queue decides the earcon (alert for error/exit/build,
 *  else a soft completion chime; nothing if all read). */
export function earconForAttention(queue: any[] | undefined): EarconType {
  if (!Array.isArray(queue)) return null;
  const unread = queue.filter((i) => i && !i.dismissed);
  if (unread.length === 0) return null;
  const hasAlert = unread.some((i) =>
    i.type === "error" || i.type === "build-failed" || i.type === "exited"
  );
  return hasAlert ? "alert" : "completion";
}

export function earconForTransition(transition: string | undefined): EarconType {
  switch (transition) {
    case "error":
    case "build-failed":
    case "exited":
      return "alert";
    // NOTE: "idle" deliberately yields NO earcon here. On a genuine Running->Idle edge the
    // AnnouncementBus already fires the "completion" tone via its `proactive_earcon`
    // broadcast; mapping idle->completion here too would double-play it (one event, two tones).
    default:
      return null; // idle / prompt / routine -> no earcon (bus owns completion)
  }
}
