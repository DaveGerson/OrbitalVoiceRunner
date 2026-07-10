// src/store/retention.ts
import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { TERMINAL_STATES } from "../exchanges/lifecycle";

/** The `agent_exchanges.state IN (...)` clause for the three TERMINAL states (agent_complete/
 *  agent_failed/cancelled) — built ONCE from the single source of truth (`TERMINAL_STATES`,
 *  src/exchanges/lifecycle.ts) instead of two hand-synced SQL string literals (pruneOnBoot's and
 *  pruneIncremental's used to drift-risk independently). The three values are this module's own
 *  compile-time-fixed vocabulary (never user input), so inlining them into the SQL text is safe. */
const TERMINAL_STATES_SQL_LIST = [...TERMINAL_STATES].map((s) => `'${s}'`).join(",");

export interface PruneOpts {
  now: number; eventsTtlDays: number; archiveTtlDays: number;
  scrollbackDirs: string[];   // dirs to scan for orphaned .janus_scrollback_*.log
  /** action_log TTL in days (4E.3c). Default 30. See ACTION_LOG_TTL_DAYS. */
  actionLogTtlDays?: number;
  /** cortex_decision TTL in days (B-3 spine). Default 30. */
  cortexDecisionTtlDays?: number;
  /** gemini_turn_usage TTL in days (B-3 spine). Default 30. */
  geminiTurnUsageTtlDays?: number;
  /** exchange_events TTL in days (AgentExchange spine, schema v12). Default 30 — same append-only,
   *  no-replay-requirement rationale as action_log/cortex_decision (ACTION_LOG_TTL_DAYS). */
  exchangeEventsTtlDays?: number;
  /** agent_exchanges TERMINAL-row TTL in days (Phase 5.4 security review). Default 30. Only rows
   *  whose `state` is one of the three terminal states (agent_complete/agent_failed/cancelled —
   *  src/exchanges/lifecycle.ts TERMINAL_STATES) are ever pruned: their redacted free-text columns
   *  (operator_utterance/distilled_instruction/result_summary/result_envelope_json) are the
   *  longest-lived at-rest copies of operator/agent text, so they get the same bounded retention
   *  as the event timeline that references them. In-flight rows and `interrupted` rows are NEVER
   *  pruned — `interrupted` is the operator's recovery backlog (spec §4: "the only path out of
   *  interrupted is the operator"), so automatic disposal would silently revoke a decision the
   *  spec reserves for a human. */
  exchangesTtlDays?: number;
  /** context_deliveries TTL in days (schema v12). Default 30 — append-only observability ledger
   *  (hashes + source-id lists, no free text), same posture as exchange_events. Pruning it in the
   *  same pass as the terminal exchange rows means a replay for a TTL-expired exchange degrades
   *  honestly (replay.ts's detectDegradation) instead of leaving orphaned delivery rows pointing
   *  at pruned exchanges. */
  contextDeliveriesTtlDays?: number;
  /** context_injections TTL in days (schema v10 cortex telemetry). Default 30 — closes the
   *  pre-existing gap the Phase 5.4 security review reported-not-fixed (out of that review's
   *  scope; Step 5.5 completes it): the table is append-only observability (hashes, dispositions,
   *  counters, plus a bounded `error` string), written on every injection attempt, and had NO
   *  retention anywhere. Same 30d posture as its v9 siblings (cortex_decision/gemini_turn_usage)
   *  that it three-way-joins via inject_id — pruning all three on the same cadence keeps the join
   *  honest instead of leaving orphaned halves. */
  contextInjectionsTtlDays?: number;
}

/**
 * 4E.3c: default action_log TTL. The PLM4 replay-detection
 * (hasSucceededIdempotencyKey) defines NO explicit time window in code — it matches an
 * idempotency_key forever. Operationally a replay of a voice/REST dispatch arrives within
 * seconds-to-minutes; 24h is a safely generous replay window, so a 30-day TTL keeps every
 * idempotency_key row far past it while still bounding the append-only log.
 */
export const ACTION_LOG_TTL_DAYS = 30;

// Grace window applied past a deferred row's own `expires_at` before the boot prune
// reclaims it (bead 1qs). The in-memory sweep (gating/index.ts) already retires expired
// pending rows during a live session; this grace ensures the durable boot prune never
// races AHEAD of that sweep for a row that only just crossed expiry. 1h is generous
// relative to the 5m default action TTL — the prune is purely about reclaiming LEAKED
// rows (a claimed-but-undeleted survivor, or one long past its TTL after a crash).
export const PENDING_PRUNE_GRACE_MS = 60 * 60 * 1000;

export function pruneOnBoot(db: Database.Database, opts: PruneOpts): void {
  const day = 86_400_000;
  const evCutoff = opts.now - opts.eventsTtlDays * day;
  const arCutoff = opts.now - opts.archiveTtlDays * day;
  // Reclaim cutoff for deferred pending rows: anything expired MORE than the grace ago.
  const pendingCutoff = opts.now - PENDING_PRUNE_GRACE_MS;
  // 30d-default cutoffs, precomputed OUTSIDE the transaction arrow (hoisting the `??` defaults
  // via ttlCutoffMs keeps the tx body's cyclomatic count under the CC-10 gate as tables accrue).
  const alCutoff = ttlCutoffMs(opts.now, opts.actionLogTtlDays);
  const cdCutoff = ttlCutoffMs(opts.now, opts.cortexDecisionTtlDays);
  const gtuCutoff = ttlCutoffMs(opts.now, opts.geminiTurnUsageTtlDays);
  const ciCutoff = ttlCutoffMs(opts.now, opts.contextInjectionsTtlDays);
  const eeCutoff = ttlCutoffMs(opts.now, opts.exchangeEventsTtlDays);
  const exCutoff = ttlCutoffMs(opts.now, opts.exchangesTtlDays);
  const cdelCutoff = ttlCutoffMs(opts.now, opts.contextDeliveriesTtlDays);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM events WHERE ts < ?").run(evCutoff);          // triggers keep events_fts in sync
    db.prepare("DELETE FROM panes_archive WHERE archived_at < ?").run(arCutoff);
    // Prune terminal handoffs past the archive cutoff (audit trail survives in events).
    db.prepare("DELETE FROM handoffs WHERE terminal_at IS NOT NULL AND terminal_at < ?").run(arCutoff);
    // Boot-prune leaked deferred ACTIONS (bead 1qs, mirrors the pending_approvals hazard):
    // a crash between claimAction() and deletePendingAction() leaves a claimed=1 row that
    // getPendingActions()/hydrate filter out (claimed=0) but never delete, so it grows
    // unbounded. An unconfirmed claimed=0 row past its expiry+grace is likewise dead weight.
    // Delete both classes; a live, unclaimed, unexpired row is untouched and survives to hydrate.
    db.prepare("DELETE FROM pending_actions WHERE claimed=1 OR expires_at < ?").run(pendingCutoff);
    // 4E.3c: claimed pending_approvals leak exactly like claimed pending_actions (crash
    // between claim and delete). UNCLAIMED rows are deliberately kept regardless of expiry —
    // the disconnected-clock-pause semantics (an operator who walks away mid-approval must
    // find the queue intact) are owned by the live sweep, not retention.
    db.prepare("DELETE FROM pending_approvals WHERE claimed=1").run();
    // 4E.3c: action_log had NO retention at all. TTL default 30d — see ACTION_LOG_TTL_DAYS
    // for why that is safely above the PLM4 idempotency replay window.
    db.prepare("DELETE FROM action_log WHERE ts < ?").run(alCutoff);
    // B-3 measurement spine: cortex_decision + gemini_turn_usage are append-only observability
    // tables with no replay requirement — 30d TTL keeps enough history for trend analysis while
    // bounding unbounded growth. Only runs if the tables exist (v9+ DB).
    try {
      db.prepare("DELETE FROM cortex_decision WHERE ts < ?").run(cdCutoff);
      db.prepare("DELETE FROM gemini_turn_usage WHERE ts < ?").run(gtuCutoff);
    } catch { /* pre-v9 DB: tables absent, skip */ }
    // Cortex context-injection telemetry (schema v10): same append-only posture and 30d TTL as
    // the v9 pair it joins via inject_id. Own guard — a v9 DB has cortex_decision but not this.
    try {
      db.prepare("DELETE FROM context_injections WHERE ts < ?").run(ciCutoff);
    } catch { /* pre-v10 DB: table absent, skip */ }
    // AgentExchange spine (schema v12): exchange_events is append-only like action_log/
    // cortex_decision, so it gets the same bounded TTL. Guarded for the same reason as the B-3
    // pair above — a pre-v12 DB (tables absent) must not fail the whole boot-prune transaction.
    try {
      db.prepare("DELETE FROM exchange_events WHERE ts < ?").run(eeCutoff);
    } catch { /* pre-v12 DB: table absent, skip */ }
    // Phase 5.4 security review: TERMINAL agent_exchanges head rows + context_deliveries get the
    // same bounded TTL (see the PruneOpts doc comments for the exact scope — in-flight and
    // `interrupted` rows are never touched). Uses updated_at (the last transition time) so a row
    // is aged from when it SETTLED, not when it was created.
    try {
      db.prepare(
        `DELETE FROM agent_exchanges WHERE state IN (${TERMINAL_STATES_SQL_LIST}) AND updated_at < ?`
      ).run(exCutoff);
      db.prepare("DELETE FROM context_deliveries WHERE ts < ?").run(cdelCutoff);
    } catch { /* pre-v12 DB: tables absent, skip */ }
  });
  tx();
  // Orphaned scrollback sweep: delete .log files not referenced by any live or archived pane.
  const referenced = new Set<string>(
    (db.prepare("SELECT scrollback_path FROM panes WHERE scrollback_path IS NOT NULL").all() as any[])
      .concat(db.prepare("SELECT scrollback_path FROM panes_archive WHERE scrollback_path IS NOT NULL").all() as any[])
      .map((r:any) => path.resolve(r.scrollback_path))
  );
  for (const dir of opts.scrollbackDirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/^\.janus_scrollback_.*\.log$/.test(f)) continue;
      const full = path.resolve(dir, f);
      if (!referenced.has(full)) { try { fs.unlinkSync(full); } catch {} }
    }
  }
}

// ── 4E.3b: periodic incremental retention ────────────────────────────────────
// pruneOnBoot runs ONCE at boot — an always-on server never pruned again, and the
// eventual boot prune after weeks of uptime was one giant blocking delete. This is the
// in-flight counterpart: each sweep tick deletes AT MOST `batchLimit` rows per table
// (subselect-LIMIT, so no SQLITE_ENABLE_UPDATE_DELETE_LIMIT dependency) and each
// category runs in its own short implicit transaction, so a tick can never stall the
// serving loop. The caller (server.ts, JANUS_RETENTION_SWEEP_MS interval — default
// 10min) just keeps ticking; `more=true` means a full batch fired somewhere and the
// backlog drains over the following ticks.

export interface SweepOpts {
  now: number;
  eventsTtlDays: number;
  archiveTtlDays: number;
  /** action_log TTL in days. Default ACTION_LOG_TTL_DAYS (30 — ≥ the PLM4 replay window). */
  actionLogTtlDays?: number;
  /** cortex_decision TTL in days (B-3 spine). Default 30. */
  cortexDecisionTtlDays?: number;
  /** gemini_turn_usage TTL in days (B-3 spine). Default 30. */
  geminiTurnUsageTtlDays?: number;
  /** exchange_events TTL in days (AgentExchange spine, schema v12). Default 30. */
  exchangeEventsTtlDays?: number;
  /** agent_exchanges TERMINAL-row TTL in days (Phase 5.4). Default 30 — see PruneOpts. */
  exchangesTtlDays?: number;
  /** context_deliveries TTL in days (schema v12, Phase 5.4). Default 30 — see PruneOpts. */
  contextDeliveriesTtlDays?: number;
  /** context_injections TTL in days (schema v10, Phase 5.5). Default 30 — see PruneOpts. */
  contextInjectionsTtlDays?: number;
  /** Max rows deleted per TABLE per tick. Default 1000. */
  batchLimit?: number;
}

export interface SweepResult {
  /** Rows deleted this tick, per category. */
  deleted: Record<string, number>;
  /** True iff some category hit its batch cap (backlog remains for the next tick). */
  more: boolean;
}

/** `now - <days or the 30d default> in ms` — the shared TTL-cutoff shape every 30d-default table
 *  uses. Hoisted so the `??` default lives in ONE place instead of one branch per table inside
 *  `pruneIncremental` (complexity gate). */
function ttlCutoffMs(now: number, ttlDays: number | undefined): number {
  return now - (ttlDays ?? ACTION_LOG_TTL_DAYS) * 86_400_000;
}

export function pruneIncremental(db: Database.Database, opts: SweepOpts): SweepResult {
  const day = 86_400_000;
  const limit = Math.max(1, opts.batchLimit ?? 1000);
  const evCutoff = opts.now - opts.eventsTtlDays * day;
  const arCutoff = opts.now - opts.archiveTtlDays * day;
  const alCutoff = ttlCutoffMs(opts.now, opts.actionLogTtlDays);
  const cdCutoff = ttlCutoffMs(opts.now, opts.cortexDecisionTtlDays);
  const gtuCutoff = ttlCutoffMs(opts.now, opts.geminiTurnUsageTtlDays);
  const eeCutoff = ttlCutoffMs(opts.now, opts.exchangeEventsTtlDays);
  const pendingCutoff = opts.now - PENDING_PRUNE_GRACE_MS;

  const deleted: Record<string, number> = {};
  let more = false;
  const step = (label: string, sql: string, args: unknown[]) => {
    const n = db.prepare(sql).run(...args, limit).changes;
    deleted[label] = n;
    if (n >= limit) more = true;
  };

  // Same predicates as pruneOnBoot, batched. The events delete fires the events_fts
  // triggers row-by-row, so FTS stays consistent through every partial batch.
  step("events",
    "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? ORDER BY id LIMIT ?)",
    [evCutoff]);
  step("panes_archive",
    "DELETE FROM panes_archive WHERE rowid IN (SELECT rowid FROM panes_archive WHERE archived_at < ? LIMIT ?)",
    [arCutoff]);
  step("handoffs",
    "DELETE FROM handoffs WHERE rowid IN (SELECT rowid FROM handoffs WHERE terminal_at IS NOT NULL AND terminal_at < ? LIMIT ?)",
    [arCutoff]);
  step("pending_actions",
    "DELETE FROM pending_actions WHERE rowid IN (SELECT rowid FROM pending_actions WHERE claimed=1 OR expires_at < ? LIMIT ?)",
    [pendingCutoff]);
  // Claimed-approval leak (4E.3c). Unclaimed rows are NEVER touched here — expiry of
  // unclaimed approvals is the live sweep's judgement call (disconnected-clock-pause
  // semantics are deliberate).
  step("pending_approvals",
    "DELETE FROM pending_approvals WHERE rowid IN (SELECT rowid FROM pending_approvals WHERE claimed=1 LIMIT ?)",
    []);
  step("action_log",
    "DELETE FROM action_log WHERE id IN (SELECT id FROM action_log WHERE ts < ? ORDER BY id LIMIT ?)",
    [alCutoff]);
  // B-3 spine: measurement tables pruned on same cadence as action_log. Guard with try/catch
  // so a pre-v9 DB (tables absent) just skips these steps gracefully.
  try {
    step("cortex_decision",
      "DELETE FROM cortex_decision WHERE id IN (SELECT id FROM cortex_decision WHERE ts < ? ORDER BY id LIMIT ?)",
      [cdCutoff]);
    step("gemini_turn_usage",
      "DELETE FROM gemini_turn_usage WHERE id IN (SELECT id FROM gemini_turn_usage WHERE ts < ? ORDER BY id LIMIT ?)",
      [gtuCutoff]);
  } catch { /* pre-v9 DB: tables absent, skip */ }
  // Cortex context-injection telemetry (schema v10, Phase 5.5): same batched pattern, own
  // try/catch so a pre-v10 DB (table absent) doesn't fail the whole sweep tick.
  try {
    step("context_injections",
      "DELETE FROM context_injections WHERE id IN (SELECT id FROM context_injections WHERE ts < ? ORDER BY rowid LIMIT ?)",
      [ttlCutoffMs(opts.now, opts.contextInjectionsTtlDays)]);
  } catch { /* pre-v10 DB: table absent, skip */ }
  // AgentExchange spine (schema v12): same batched-append-only pattern, own try/catch so a
  // pre-v12 DB (table absent) doesn't fail the whole sweep tick.
  try {
    step("exchange_events",
      "DELETE FROM exchange_events WHERE event_id IN (SELECT event_id FROM exchange_events WHERE ts < ? ORDER BY event_id LIMIT ?)",
      [eeCutoff]);
  } catch { /* pre-v12 DB: table absent, skip */ }
  // Phase 5.4 security review: TERMINAL agent_exchanges rows + context_deliveries — the same
  // predicates as pruneOnBoot, batched. In-flight and `interrupted` rows are never touched
  // (see PruneOpts.exchangesTtlDays).
  try {
    step("agent_exchanges",
      `DELETE FROM agent_exchanges WHERE exchange_id IN (SELECT exchange_id FROM agent_exchanges WHERE state IN (${TERMINAL_STATES_SQL_LIST}) AND updated_at < ? LIMIT ?)`,
      [ttlCutoffMs(opts.now, opts.exchangesTtlDays)]);
    step("context_deliveries",
      "DELETE FROM context_deliveries WHERE delivery_id IN (SELECT delivery_id FROM context_deliveries WHERE ts < ? LIMIT ?)",
      [ttlCutoffMs(opts.now, opts.contextDeliveriesTtlDays)]);
  } catch { /* pre-v12 DB: tables absent, skip */ }

  return { deleted, more };
}
