// src/hooks/liveSessionLogic.ts — pure, browser-API-free decision helpers for the live
// voice-session lifecycle (useLiveSession). Extracted out of src/App.tsx (bead dbt4) so the
// teardown loop and the auto-reconnect decision can be unit-pinned without jsdom. Behavior is
// VERBATIM from the original App.tsx body (cleanupSocketOnly's disposeRef loop + the onclose/catch
// reconnect branch); see tests/test_use_live_session.ts.

import type { MutableRefObject } from "react";

/** A ref paired with the closer that tears its current value down. */
export type DisposableRef<T> = [MutableRefObject<T | null>, (value: T) => void];

/**
 * Guarded teardown + null-out for each ref, in order. Mirrors cleanupSocketOnly's original body:
 * each teardown was an identical `if (ref.current) { try { close } catch; ref=null }`. A throwing
 * close() is swallowed but the ref is STILL nulled out.
 */
export function disposeRefs(refs: DisposableRef<any>[]): void {
  for (const [ref, close] of refs) {
    if (ref.current) {
      try { close(ref.current); } catch (e) { /* best-effort teardown */ }
      ref.current = null;
    }
  }
}

/** The next live/reconnecting state after a socket close or a failed connect attempt. */
export interface ReconnectPlan {
  live: boolean;
  reconnecting: boolean;
  scheduleRetry: boolean;
}

/**
 * The onclose/catch reconnect decision (VERBATIM from App.connectLive). When the operator still
 * wants to be live (desiredLive), keep the live flag set, surface reconnecting, and schedule a
 * retry; otherwise drop fully out of the live state.
 */
export function planReconnect(desiredLive: boolean): ReconnectPlan {
  if (desiredLive) {
    return { live: true, reconnecting: true, scheduleRetry: true };
  }
  return { live: false, reconnecting: false, scheduleRetry: false };
}
