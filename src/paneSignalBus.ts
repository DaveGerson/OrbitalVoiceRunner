import type { PaneSignal, PaneSignalKind } from "./paneSignals";

type Observer = (signal: PaneSignal) => void;

/** Priority order for cross-kind cooldown bypass — higher number = higher priority.
 *  error/exited always pass through; lower-priority status signals are suppressed
 *  during the cross-kind cooldown to prevent the re-announcement loop (bug L1). */
const KIND_PRIORITY: Record<PaneSignalKind, number> = {
  closed:    0,
  prompt:    1,
  created:   2,
  quiescing: 3,
  running:   4,
  idle:      5,
  exited:    6,
  error:     7,
};

/** Bridges global pane-event callbacks to N per-connection live sessions.
 *  Per-(pane,kind) debounce keeps a chatty pane from spamming the model.
 *  Cross-kind cooldown (L1 fix) prevents status-flap loops (running→idle→running…)
 *  from each generating a forced spoken turn. */
export class PaneSignalBus {
  private observers = new Set<Observer>();
  private lastPushAt = new Map<string, number>();
  /** 4D.2: the detail last DELIVERED per (pane,kind) — a different detail inside the window is
   *  genuinely new information and passes through; only identical repeats collapse. */
  private lastDetail = new Map<string, string | undefined>();
  /** L1: last-delivered timestamp per paneId (ANY kind) for cross-kind cooldown. */
  private lastPaneSignalAt = new Map<string, number>();

  constructor(
    private debounceMs = 3000,
    private crossKindCooldownMs = 5000,
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

    // L1 cross-kind cooldown: if ANY signal for this pane was delivered within the cooldown
    // window, suppress low-priority kinds to break the status-flap re-announcement loop
    // (running→quiescing→idle→running…). High-priority kinds (error, exited) always pass.
    const lastAnyKind = this.lastPaneSignalAt.get(signal.paneId) ?? Number.NEGATIVE_INFINITY;
    if (t - lastAnyKind < this.crossKindCooldownMs && (KIND_PRIORITY[signal.kind] ?? 0) < KIND_PRIORITY.exited) {
      return false; // low-priority kind inside cross-kind cooldown -> suppress.
    }

    this.lastPushAt.set(key, t);
    this.lastDetail.set(key, signal.detail);
    this.lastPaneSignalAt.set(signal.paneId, t);
    for (const observer of this.observers) {
      try { observer(signal); }
      catch (e) { console.error("PaneSignalBus observer failed:", e); }
    }
    return true;
  }

  get observerCount(): number { return this.observers.size; }
}
