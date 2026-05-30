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
  const cap = opts.cap ?? 50;
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  const dismissedTtlMs = opts.dismissedTtlMs ?? 60 * 1000;

  const ageOf = (it: AttentionItem) => now - new Date(it.timestamp).getTime();

  // TTL eviction (in place).
  for (let i = queue.length - 1; i >= 0; i--) {
    const age = ageOf(queue[i]);
    if (age > ttlMs || (queue[i].dismissed && age > dismissedTtlMs)) {
      queue.splice(i, 1);
    }
  }

  // Cap eviction: drop oldest dismissed first, then oldest overall.
  while (queue.length > cap) {
    let idx = queue.findIndex((it) => it.dismissed);
    if (idx === -1) idx = 0; // no dismissed -> oldest overall
    queue.splice(idx, 1);
  }
  return queue;
}

export type AnnouncementKind =
  | "completion"   // genuine WS-C Running->Idle edge (real work finished)
  | "error"        // error text detected
  | "build-failed" // build failure
  | "exited"       // process exited
  | "plan_completed"
  | "plan_paused";

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

/** Earcon keyed to the event status. Reuses the existing client earcon vocabulary and
 *  adds the new "completion" tone (App.tsx). */
export type EarconType = "completion" | "alert" | "success" | "execute" | "chime";

export interface NotificationPayload {
  /** Stable id keyed by pane + severity so the client stack coalesces to the latest. */
  id: string;
  kind: AnnouncementKind;
  terminalId: string;
  /** Severity bucket the stack groups by. */
  severity: "high" | "normal";
  message: string;
  earcon: EarconType;
  timestamp: string;
}

/** Operator-editable message templates (Settings surface). `{pane}` / `{summary}` are
 *  interpolated. Defaults are intentionally brief (maintainer Decision 2). */
export interface AnnouncementTemplates {
  completion: string;
  error: string;
  buildFailed: string;
  exited: string;
  planCompleted: string;
  planPaused: string;
}

export const DEFAULT_ANNOUNCEMENT_TEMPLATES: AnnouncementTemplates = {
  completion: "Pane '{pane}' finished. {summary}",
  error: "Pane '{pane}' reported an error. {summary}",
  buildFailed: "Build failed on pane '{pane}'.",
  exited: "Pane '{pane}' exited.",
  planCompleted: "Plan completed. {summary}",
  planPaused: "Plan paused. {summary}",
};

/** Severity / priority ranking — highest fires first when a window is flushed.
 *  Errors are never starved by completions (§4). */
const PRIORITY: Record<AnnouncementKind, number> = {
  "build-failed": 5,
  error: 4,
  exited: 3,
  plan_paused: 2,
  completion: 1,
  plan_completed: 0,
};

const HIGH_SEVERITY: AnnouncementKind[] = ["build-failed", "error", "plan_paused"];

const EARCON_FOR: Record<AnnouncementKind, EarconType> = {
  completion: "completion",
  error: "alert",
  "build-failed": "alert",
  exited: "completion",
  plan_completed: "success",
  plan_paused: "alert",
};

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
  return tpl
    .replace(/\{pane\}/g, pane)
    .replace(/\{summary\}/g, summary || "")
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
  private lastAnnouncedAt: Record<string, number> = {};
  /** Timestamps of recent flushes for the token-bucket. */
  private flushTimes: number[] = [];

  constructor(opts: AnnouncementBusOptions) {
    this.broadcast = opts.broadcast;
    this.clock = opts.clock || realClock;
    this.coalesceWindowMs = opts.coalesceWindowMs ?? 1500;
    this.perPaneDebounceMs = opts.perPaneDebounceMs ?? 4000;
    this.rateLimitWindowMs = opts.rateLimitWindowMs ?? 3000;
    this.rateLimitBurst = opts.rateLimitBurst ?? 2;
    this.itemTtlMs = opts.itemTtlMs ?? 10 * 60 * 1000;
    this.getTemplates = opts.getTemplates || (() => DEFAULT_ANNOUNCEMENT_TEMPLATES);
  }

  /** Enqueue an announcement. The earcon fires IMMEDIATELY (non-verbal awareness even
   *  while deferred), while the on-screen notification is debounced/coalesced/rate-limited
   *  and emitted on the next flush. Returns false if the item was suppressed (per-pane
   *  debounce) — the caller need not care, but tests assert on it. */
  enqueue(item: AnnouncementItem): boolean {
    const now = this.clock.now();
    const paneKey = item.terminalId;

    // Per-pane debounce: suppress a repeat for the same pane inside the window.
    const last = this.lastAnnouncedAt[paneKey];
    if (last !== undefined && now - last < this.perPaneDebounceMs) {
      return false;
    }
    this.lastAnnouncedAt[paneKey] = now;

    this.buffer.push({ ...item, at: now });

    // Immediate earcon (Seam B) — sub-100ms non-verbal feedback, never deferred.
    this.broadcast({
      type: "proactive_earcon",
      earcon: EARCON_FOR[item.kind],
      kind: item.kind,
      terminalId: item.terminalId,
    });

    if (!this.flushTimer) {
      this.flushTimer = this.clock.setTimeout(() => this.flush(), this.coalesceWindowMs);
    }
    return true;
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
  ): { type: string } & NotificationPayload {
    const severity: "high" | "normal" = HIGH_SEVERITY.includes(item.kind) ? "high" : "normal";
    // Coalesce key: same pane + same severity bucket -> the client stack updates the
    // existing entry to the latest message instead of spawning a duplicate.
    const id = `notif_${item.terminalId}_${severity}`;
    const tpl = this.templateFor(item.kind, templates);
    const message = applyTemplate(tpl, item.terminalId, item.summary || "");
    return {
      type: "proactive_notification",
      id,
      kind: item.kind,
      terminalId: item.terminalId,
      severity,
      message,
      earcon: EARCON_FOR[item.kind],
      timestamp: new Date(now).toISOString(),
    };
  }

  private templateFor(kind: AnnouncementKind, t: AnnouncementTemplates): string {
    switch (kind) {
      case "completion": return t.completion;
      case "error": return t.error;
      case "build-failed": return t.buildFailed;
      case "exited": return t.exited;
      case "plan_completed": return t.planCompleted;
      case "plan_paused": return t.planPaused;
    }
  }

  /** Tear down all timers so the process/test suite exits cleanly. */
  stop(): void {
    if (this.flushTimer) {
      this.clock.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = [];
  }
}
