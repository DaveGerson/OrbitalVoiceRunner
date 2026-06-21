/**
 * WS-D: AnnouncementBus — proactive feedback controller.
 *
 * Per the BINDING maintainer decision (wsd-proactive-audio-design.md §0), proactive
 * feedback is delivered as (a) status-keyed EARCONS and (b) a coalescing on-screen
 * NOTIFICATION STACK — NOT Gemini in-voice spoken turns. There is no `sendClientContent`
 * / `activeVoiceSession` path here.
 *
 * The bus is a pure unit with injected seams (a `broadcast` sink + an advanceable clock)
 * so the de-spam timing (per-pane debounce, coalescing window, token-bucket rate limit)
 * can be driven deterministically in tests without real timers. It is the single place
 * that decides WHETHER and WHEN to fire a proactive notification, so the event path
 * (`manager.onIdle`, `detectAndTriggerTransitions`, `handlePlansTrigger`) stays thin and
 * just calls `enqueue(...)`.
 */

import type { AttentionItem } from "./types";
import type { ProactiveNotification } from "./notificationStack";
import {
  type AnnouncementKind,
  type EarconType,
  type AnnouncementTemplates,
  DEFAULT_ANNOUNCEMENT_TEMPLATES,
  EARCON_FOR,
  PRIORITY,
  severityOf,
  isHighSeverity,
  templateFor,
} from "./announcementKinds";

export type { AnnouncementKind, EarconType, AnnouncementTemplates };
export { DEFAULT_ANNOUNCEMENT_TEMPLATES };

/** Named magic numbers for the attention-queue prune (BUG-035). The bus `itemTtlMs`
 *  default references ATTENTION_TTL_MS so "stale = 10 minutes" is one edit. */
export const ATTENTION_QUEUE_CAP = 50;
export const ATTENTION_TTL_MS = 10 * 60 * 1000;
export const ATTENTION_DISMISSED_TTL_MS = 60 * 1000;

/**
 * BUG-035: cap + TTL-evict the (previously unbounded) attentionQueue in place.
 *  - TTL: drop active items older than `ttlMs`, and dismissed items older than
 *    `dismissedTtlMs` (a dismissed item lingers only briefly).
 *  - Cap: keep at most `cap` items; when over, drop the oldest DISMISSED first,
 *    then the oldest. Mutates and returns the same array reference.
 */
export function pruneAttentionQueue(
  queue: AttentionItem[],
  now: number = Date.now(),
  opts: { cap?: number; ttlMs?: number; dismissedTtlMs?: number } = {}
): AttentionItem[] {
  const cap = opts.cap ?? ATTENTION_QUEUE_CAP;
  const ttlMs = opts.ttlMs ?? ATTENTION_TTL_MS;
  const dismissedTtlMs = opts.dismissedTtlMs ?? ATTENTION_DISMISSED_TTL_MS;

  evictExpiredAttentionItems(queue, now, ttlMs, dismissedTtlMs);
  evictAttentionItemsOverCap(queue, cap);
  return queue;
}

/** Age of an attention item in ms. An unparseable/NaN timestamp is treated as infinitely
 *  old (stale) so it always evicts — `new Date("x").getTime()` is NaN and `NaN > ttl` is
 *  false, which previously pinned such items forever. */
function attentionItemAge(it: AttentionItem, now: number): number {
  const t = new Date(it.timestamp).getTime();
  return Number.isNaN(t) ? Infinity : now - t;
}

/** TTL eviction (in place): drop active items older than `ttlMs`, and dismissed items
 *  older than `dismissedTtlMs`. */
function evictExpiredAttentionItems(
  queue: AttentionItem[],
  now: number,
  ttlMs: number,
  dismissedTtlMs: number
): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    const age = attentionItemAge(queue[i], now);
    if (age > ttlMs || (queue[i].dismissed && age > dismissedTtlMs)) {
      queue.splice(i, 1);
    }
  }
}

/** Cap eviction (in place): while over `cap`, drop the oldest DISMISSED first, then the
 *  oldest overall. */
function evictAttentionItemsOverCap(queue: AttentionItem[], cap: number): void {
  while (queue.length > cap) {
    let idx = queue.findIndex((it) => it.dismissed);
    if (idx === -1) idx = 0; // no dismissed -> oldest overall
    queue.splice(idx, 1);
  }
}

export interface AnnouncementItem {
  kind: AnnouncementKind;
  /** Pane/terminal the event concerns (used as the coalescing key together with the
   *  status severity bucket). For plan events this is the plan id. */
  terminalId: string;
  /** A brief, already-REDACTED summary line (WS-B). Never raw pane text. */
  summary?: string;
  /** Monotonic time the item was enqueued (filled in by the bus from its clock). */
  at?: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(handle: any): void;
}

/** Real clock backed by the host timers. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

export interface AnnouncementBusOptions {
  /** Sink for the typed proactive-notification broadcast (Seam B). */
  broadcast: (msg: any) => void;
  clock?: Clock;
  /** Coalescing window: items enqueued within this window collapse on flush. */
  coalesceWindowMs?: number;
  /** Per-pane debounce: a 2nd announcement for the same pane within this window is
   *  suppressed (a flapping build must not machine-gun the operator). */
  perPaneDebounceMs?: number;
  /** Token-bucket rate limit: max N flushes per window, burst capacity = burst. */
  rateLimitWindowMs?: number;
  rateLimitBurst?: number;
  /** Drop coalesced items older than this on flush (mirrors attention TTL). */
  itemTtlMs?: number;
  /** Returns the current operator-editable templates (read fresh each flush so a
   *  Settings edit takes effect without a restart). */
  getTemplates?: () => AnnouncementTemplates;
}

function applyTemplate(tpl: string, pane: string, summary: string): string {
  // Use FUNCTION replacers: a plain replacement string makes `$&`, `` $` ``, `$'`, `$n`
  // in the dynamic pane/summary value special, which corrupts/injects text when build
  // output contains `$` (very common). A function replacer is verbatim.
  return tpl
    .replace(/\{pane\}/g, () => pane)
    .replace(/\{summary\}/g, () => summary || "")
    .replace(/\s+/g, " ")
    .trim();
}

export class AnnouncementBus {
  private broadcast: (msg: any) => void;
  private clock: Clock;
  private coalesceWindowMs: number;
  private perPaneDebounceMs: number;
  private rateLimitWindowMs: number;
  private rateLimitBurst: number;
  private itemTtlMs: number;
  private getTemplates: () => AnnouncementTemplates;

  private buffer: AnnouncementItem[] = [];
  private flushTimer: any = null;
  /** 4D.2: the debounce window stamps, keyed PER (pane, kind) — see the matrix on enqueue(). */
  private lastAnnouncedAt: Record<string, number> = {};
  /** Timestamps of recent flushes for the token-bucket. */
  private flushTimes: number[] = [];
  /** 4D.2: suppressed items COALESCE-TO-LATEST here per (pane,kind) instead of dropping. */
  private pendingCoalesced = new Map<string, AnnouncementItem>();
  /** One unref'd timer per pending (pane,kind) slot, fired when its debounce window expires. */
  private pendingTimers = new Map<string, any>();
  /** 4D.1: observers notified on EVERY enqueue (pre-debounce) — the durable activity recorder. */
  private enqueueListeners = new Set<(item: AnnouncementItem) => void>();

  constructor(opts: AnnouncementBusOptions) {
    this.broadcast = opts.broadcast;
    this.clock = opts.clock || realClock;
    this.coalesceWindowMs = opts.coalesceWindowMs ?? 1500;
    this.perPaneDebounceMs = opts.perPaneDebounceMs ?? 4000;
    this.rateLimitWindowMs = opts.rateLimitWindowMs ?? 3000;
    this.rateLimitBurst = opts.rateLimitBurst ?? 2;
    this.itemTtlMs = opts.itemTtlMs ?? ATTENTION_TTL_MS;
    this.getTemplates = opts.getTemplates || (() => DEFAULT_ANNOUNCEMENT_TEMPLATES);
  }

  /**
   * 4D.1: subscribe to EVERY enqueue, pre-debounce (even items the window later coalesces) — the
   * gating core records the pane lifecycle edges durably for the "while you were away" digest.
   * A throwing listener is contained. Returns an unsubscribe function.
   */
  onEnqueue(listener: (item: AnnouncementItem) => void): () => void {
    this.enqueueListeners.add(listener);
    return () => { this.enqueueListeners.delete(listener); };
  }

  /** Enqueue an announcement. Returns false when the item was DEFERRED (coalesced-to-latest into
   *  its (pane,kind) window slot) — never silently dropped.
   *
   *  4D.2 debounce matrix (what stamps what — the original anti-spam INTENT, "a flapping build
   *  must not machine-gun the operator", is preserved by collapsing repeats per window):
   *   - HIGH severity (error / build-failed / exited / approval kinds / plan_paused): delivered now,
   *     bypasses the window, stamps NOTHING. (Pre-fix it stamped the per-PANE window, so an error
   *     silenced a genuine completion on the same pane forever — the 4D.2 finding.)
   *   - normal severity, cold (pane,kind) window: delivered now; stamps its own (pane,kind).
   *   - normal severity, hot (pane,kind) window: COALESCES-TO-LATEST into a pending slot and is
   *     delivered (earcon + notification) when the window expires; the flush re-stamps the window,
   *     so sustained flapping keeps collapsing to one announcement per window. */
  enqueue(item: AnnouncementItem): boolean {
    const now = this.clock.now();
    // 4D.1: every genuine edge reaches the listeners, even when the announcement defers.
    for (const listener of this.enqueueListeners) {
      try { listener(item); } catch (e) { console.error("AnnouncementBus onEnqueue listener failed:", e); }
    }

    if (!isHighSeverity(item.kind)) {
      const key = `${item.terminalId} ${item.kind}`;
      const last = this.lastAnnouncedAt[key];
      if (last !== undefined && now - last < this.perPaneDebounceMs) {
        // 4D.2: DEFER, never drop — latest-wins into the pending slot; one timer per slot fires
        // at window expiry. The timer is unref'd so a pending coalesce can never pin the process.
        this.pendingCoalesced.set(key, { ...item, at: now });
        if (!this.pendingTimers.has(key)) {
          const wait = Math.max(1, last + this.perPaneDebounceMs - now);
          const handle = this.clock.setTimeout(() => this.flushCoalesced(key), wait);
          if (handle && typeof handle.unref === "function") handle.unref();
          this.pendingTimers.set(key, handle);
        }
        return false;
      }
      this.lastAnnouncedAt[key] = now;
    }

    this.deliver({ ...item, at: now });
    return true;
  }

  /** Push an (already window-cleared) item into the coalescing buffer + fire its earcon. */
  private deliver(item: AnnouncementItem): void {
    this.buffer.push(item);

    // Immediate earcon (Seam B) — sub-100ms non-verbal feedback. For a coalesced item this runs
    // at FLUSH time (the moment the item is actually announced), per the 4D.2 design.
    this.broadcast({
      type: "proactive_earcon",
      earcon: EARCON_FOR[item.kind],
      kind: item.kind,
      terminalId: item.terminalId,
    });

    if (!this.flushTimer) {
      this.flushTimer = this.clock.setTimeout(() => this.flush(), this.coalesceWindowMs);
    }
  }

  /** 4D.2: a (pane,kind) debounce window expired — deliver the latest coalesced item, if any,
   *  and re-stamp the window so continued flapping collapses into the NEXT window. */
  private flushCoalesced(key: string): void {
    this.pendingTimers.delete(key);
    const item = this.pendingCoalesced.get(key);
    this.pendingCoalesced.delete(key);
    if (!item) return;
    const now = this.clock.now();
    this.lastAnnouncedAt[key] = now;
    this.deliver({ ...item, at: now });
  }

  /** Flush the coalescing buffer: emit the proactive notification(s). Respects the
   *  token-bucket rate limit; when the bucket is empty, items WAIT (re-armed timer)
   *  rather than dropping. Drops items older than the TTL. */
  flush(): void {
    this.flushTimer = null;
    const now = this.clock.now();

    // Drop stale items past TTL (never announce a 10-minute-old "build finished").
    this.buffer = this.buffer.filter((it) => now - (it.at ?? now) <= this.itemTtlMs);
    if (this.buffer.length === 0) return;

    // Token-bucket: prune flush timestamps outside the window, check capacity.
    this.flushTimes = this.flushTimes.filter((t) => now - t < this.rateLimitWindowMs);
    if (this.flushTimes.length >= this.rateLimitBurst) {
      // Bucket empty: re-arm and wait for the oldest token to expire. Items are kept.
      const wait = this.rateLimitWindowMs - (now - this.flushTimes[0]) + 1;
      this.flushTimer = this.clock.setTimeout(() => this.flush(), Math.max(wait, 1));
      return;
    }
    this.flushTimes.push(now);

    // Sort by severity (highest first), then recency.
    const items = [...this.buffer].sort(
      (a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || (b.at ?? 0) - (a.at ?? 0)
    );
    this.buffer = [];

    const templates = this.getTemplates();
    for (const item of items) {
      this.broadcast(this.toNotification(item, templates, now));
    }
  }

  private toNotification(
    item: AnnouncementItem,
    templates: AnnouncementTemplates,
    now: number
  ): { type: string } & ProactiveNotification {
    const severity = severityOf(item.kind);
    // Coalesce key: same pane + same severity bucket -> the client stack updates the
    // existing entry to the latest message instead of spawning a duplicate.
    const id = `notif_${item.terminalId}_${severity}`;
    const tpl = templateFor(item.kind, templates);
    const message = applyTemplate(tpl, item.terminalId, item.summary || "");
    return {
      type: "proactive_notification",
      id,
      kind: item.kind,
      terminalId: item.terminalId,
      severity,
      message,
      timestamp: new Date(now).toISOString(),
    };
  }

  /** Tear down all timers so the process/test suite exits cleanly. */
  stop(): void {
    if (this.flushTimer) {
      this.clock.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // 4D.2: cancel every pending coalesce slot too.
    for (const handle of this.pendingTimers.values()) {
      this.clock.clearTimeout(handle);
    }
    this.pendingTimers.clear();
    this.pendingCoalesced.clear();
    this.buffer = [];
  }
}
