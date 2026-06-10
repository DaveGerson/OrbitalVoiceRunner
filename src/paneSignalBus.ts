import type { PaneSignal } from "./paneSignals";

type Observer = (signal: PaneSignal) => void;

/** Bridges global pane-event callbacks to N per-connection live sessions.
 *  Per-(pane,kind) debounce keeps a chatty pane from spamming the model. */
export class PaneSignalBus {
  private observers = new Set<Observer>();
  private lastPushAt = new Map<string, number>();
  /** 4D.2: the detail last DELIVERED per (pane,kind) — a different detail inside the window is
   *  genuinely new information and passes through; only identical repeats collapse. */
  private lastDetail = new Map<string, string | undefined>();

  constructor(
    private debounceMs = 3000,
    private now: () => number = () => Date.now(),
  ) {}

  /** Returns an unsubscribe function. */
  subscribe(observer: Observer): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  /** Fan out unless this (pane,kind) fired within the debounce window with the SAME detail.
   *  Returns true if delivered, false if dropped (no observers / identical repeat).
   *
   *  4D.2 (Phase 4 Track D) — two deliberate departures from the original drop-everything window:
   *   - ZERO OBSERVERS: the signal is lost on the floor anyway (nobody is listening), so it must
   *     NOT stamp the window. Pre-fix, a signal landing just before the radio connected consumed
   *     the window and debounced away the FIRST real signal after connect.
   *   - SAME KIND, DIFFERENT DETAIL: delivered (and it re-stamps the window for its own repeats).
   *     Pre-fix, a second DIFFERENT error within 3s was silently dropped. We chose this pass-through
   *     over a coalesce-to-latest timer ON PURPOSE: pane signals are spoken as "now" statements into
   *     the live model, so a 3s-deferred replay would narrate stale state; the bus has an injected
   *     clock but no timer seam; and spam stays bounded because identical repeats (the actual
   *     flapping mode) still collapse — only detail-NOVEL signals pass. */
  publish(signal: PaneSignal): boolean {
    if (this.observers.size === 0) return false; // nobody heard it -> the window is NOT consumed.
    const key = `${signal.paneId}:${signal.kind}`;
    const last = this.lastPushAt.get(key) ?? Number.NEGATIVE_INFINITY;
    const t = this.now();
    if (t - last < this.debounceMs && signal.detail === this.lastDetail.get(key)) {
      return false; // identical repeat inside the window -> collapse (anti-spam intent preserved).
    }
    this.lastPushAt.set(key, t);
    this.lastDetail.set(key, signal.detail);
    for (const observer of this.observers) {
      try { observer(signal); }
      catch (e) { console.error("PaneSignalBus observer failed:", e); }
    }
    return true;
  }

  get observerCount(): number { return this.observers.size; }
}
