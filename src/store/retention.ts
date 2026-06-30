// src/store/retention.ts
import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface PruneOpts {
  now: number; eventsTtlDays: number; archiveTtlDays: number;
  scrollbackDirs: string[];   // dirs to scan for orphaned .janus_scrollback_*.log
  /** action_log TTL in days (4E.3c). Default 30. See ACTION_LOG_TTL_DAYS. */
  actionLogTtlDays?: number;
  /** cortex_decision TTL in days (B-3 spine). Default 30. */
  cortexDecisionTtlDays?: number;
  /** gemini_turn_usage TTL in days (B-3 spine). Default 30. */
  geminiTurnUsageTtlDays?: number;
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
    db.prepare("DELETE FROM action_log WHERE ts < ?").run(opts.now - (opts.actionLogTtlDays ?? ACTION_LOG_TTL_DAYS) * day);
    // B-3 measurement spine: cortex_decision + gemini_turn_usage are append-only observability
    // tables with no replay requirement — 30d TTL keeps enough history for trend analysis while
    // bounding unbounded growth. Only runs if the tables exist (v9+ DB).
    try {
      db.prepare("DELETE FROM cortex_decision WHERE ts < ?").run(opts.now - (opts.cortexDecisionTtlDays ?? ACTION_LOG_TTL_DAYS) * day);
      db.prepare("DELETE FROM gemini_turn_usage WHERE ts < ?").run(opts.now - (opts.geminiTurnUsageTtlDays ?? ACTION_LOG_TTL_DAYS) * day);
    } catch { /* pre-v9 DB: tables absent, skip */ }
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
  /** Max rows deleted per TABLE per tick. Default 1000. */
  batchLimit?: number;
}

export interface SweepResult {
  /** Rows deleted this tick, per category. */
  deleted: Record<string, number>;
  /** True iff some category hit its batch cap (backlog remains for the next tick). */
  more: boolean;
}

export function pruneIncremental(db: Database.Database, opts: SweepOpts): SweepResult {
  const day = 86_400_000;
  const limit = Math.max(1, opts.batchLimit ?? 1000);
  const evCutoff = opts.now - opts.eventsTtlDays * day;
  const arCutoff = opts.now - opts.archiveTtlDays * day;
  const alCutoff = opts.now - (opts.actionLogTtlDays ?? ACTION_LOG_TTL_DAYS) * day;
  const cdCutoff = opts.now - (opts.cortexDecisionTtlDays ?? ACTION_LOG_TTL_DAYS) * day;
  const gtuCutoff = opts.now - (opts.geminiTurnUsageTtlDays ?? ACTION_LOG_TTL_DAYS) * day;
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

  return { deleted, more };
}
