import type { PaneSignal } from "./paneSignals";

type Observer = (signal: PaneSignal) => void;

/** Bridges global pane-event callbacks to N per-connection live sessions.
 *  Per-(pane,kind) debounce keeps a chatty pane from spamming the model. */
export class PaneSignalBus {
  private observers = new Set<Observer>();
  private lastPushAt = new Map<string, number>();

  constructor(
    private debounceMs = 3000,
    private now: () => number = () => Date.now(),
  ) {}

  /** Returns an unsubscribe function. */
  subscribe(observer: Observer): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  /** Fan out unless this (pane,kind) fired within the debounce window.
   *  Returns true if delivered, false if coalesced. */
  publish(signal: PaneSignal): boolean {
    const key = `${signal.paneId}:${signal.kind}`;
    const last = this.lastPushAt.get(key) ?? Number.NEGATIVE_INFINITY;
    const t = this.now();
    if (t - last < this.debounceMs) return false;
    this.lastPushAt.set(key, t);
    for (const observer of this.observers) {
      try { observer(signal); }
      catch (e) { console.error("PaneSignalBus observer failed:", e); }
    }
    return true;
  }

  get observerCount(): number { return this.observers.size; }
}
