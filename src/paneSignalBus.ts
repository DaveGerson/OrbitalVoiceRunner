import type { PaneSignal, PaneSignalKind } from "./paneSignals";

type Observer = (signal: PaneSignal) => void;

/** z5c slice 1 (spec 2026-07-07 D1, closes bead wsm-e2e-pinned-1d6w): the concern a subscriber
 *  consumes deliveries for. `spoken` = voice announcements — keeps the L1 cross-kind cooldown
 *  (speech pacing). `inject` = context-injection triggers — NOT cross-kind suppressed; the
 *  per-session InjectGate (hash + debounce, spec 2026-07-02 D2) is that leg's anti-spam
 *  authority, so suppressing it here only reproduced the fast-command under-injection. */
export type DeliveryClass = "spoken" | "inject";

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

/** Per-class delivery state. Each class runs its OWN (pane,kind)+detail debounce window so a
 *  delivery to one class never consumes the other's window — the 4D.2 zero-observer rule,
 *  generalized per class. Cross-kind cooldown state stays bus-level but only the spoken lane
 *  reads or stamps it (crossKind flag). */
interface DeliveryLane {
  observers: Set<Observer>;
  /** 4D.2: last delivery timestamp per (pane,kind) — this lane only. */
  lastPushAt: Map<string, number>;
  /** 4D.2: the detail last DELIVERED per (pane,kind) — a different detail inside the window is
   *  genuinely new information and passes through; only identical repeats collapse. */
  lastDetail: Map<string, string | undefined>;
  /** L1 applies to the spoken lane only. */
  crossKind: boolean;
}

/** Bridges global pane-event callbacks to N per-connection live sessions.
 *  Per-(pane,kind) debounce keeps a chatty pane from spamming the model — per delivery class.
 *  Cross-kind cooldown (L1 fix) prevents status-flap loops (running→idle→running…) from each
 *  generating a forced spoken turn; it deliberately does NOT govern the inject class. */
export class PaneSignalBus {
  private lanes: Record<DeliveryClass, DeliveryLane> = {
    spoken: { observers: new Set(), lastPushAt: new Map(), lastDetail: new Map(), crossKind: true },
    inject: { observers: new Set(), lastPushAt: new Map(), lastDetail: new Map(), crossKind: false },
  };
  /** L1: last-delivered timestamp per paneId (ANY kind) for cross-kind cooldown — spoken lane only. */
  private lastPaneSignalAt = new Map<string, number>();

  constructor(
    private debounceMs = 3000,
    private crossKindCooldownMs = 5000,
    private now: () => number = () => Date.now(),
  ) {}

  /** Returns an unsubscribe function. Default class is `spoken` — every pre-slice-1 subscriber
   *  keeps its exact semantics without touching its call site. */
  subscribe(observer: Observer, cls: DeliveryClass = "spoken"): () => void {
    const lane = this.lanes[cls];
    lane.observers.add(observer);
    return () => { lane.observers.delete(observer); };
  }

  /** L1: true when a low-priority signal should be suppressed by the cross-kind cooldown. */
  private isCrossKindSuppressed(paneId: string, kind: PaneSignalKind, t: number): boolean {
    const lastAnyKind = this.lastPaneSignalAt.get(paneId) ?? Number.NEGATIVE_INFINITY;
    return t - lastAnyKind < this.crossKindCooldownMs && (KIND_PRIORITY[kind] ?? 0) < KIND_PRIORITY.exited;
  }

  /** One lane's independent delivery decision + state stamping. 4D.2 rules hold per lane:
   *  a zero-observer lane never consumes its window; same-kind-different-detail passes through;
   *  identical repeats collapse. Only a crossKind (spoken) lane checks/stamps the L1 state. */
  private deliverToLane(lane: DeliveryLane, signal: PaneSignal, t: number): boolean {
    if (lane.observers.size === 0) return false; // nobody heard it -> the window is NOT consumed.
    const key = `${signal.paneId}:${signal.kind}`;
    const last = lane.lastPushAt.get(key) ?? Number.NEGATIVE_INFINITY;
    if (t - last < this.debounceMs && signal.detail === lane.lastDetail.get(key)) {
      return false; // identical repeat inside the window -> collapse (anti-spam intent preserved).
    }
    if (lane.crossKind && this.isCrossKindSuppressed(signal.paneId, signal.kind, t)) {
      return false;
    }
    lane.lastPushAt.set(key, t);
    lane.lastDetail.set(key, signal.detail);
    if (lane.crossKind) this.lastPaneSignalAt.set(signal.paneId, t);
    for (const observer of lane.observers) {
      try { observer(signal); }
      catch (e) { console.error("PaneSignalBus observer failed:", e); }
    }
    return true;
  }

  /** Fan out per delivery class — each lane decides independently (see 4D.2 comments above for
   *  why dropped/unheard deliveries must not stamp state). Returns true if ANY lane delivered. */
  publish(signal: PaneSignal): boolean {
    const t = this.now();
    const spoken = this.deliverToLane(this.lanes.spoken, signal, t);
    const inject = this.deliverToLane(this.lanes.inject, signal, t);
    return spoken || inject;
  }

  get observerCount(): number {
    return this.lanes.spoken.observers.size + this.lanes.inject.observers.size;
  }
}
