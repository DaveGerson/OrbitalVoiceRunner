// src/store/retention.ts
import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface PruneOpts {
  now: number; eventsTtlDays: number; archiveTtlDays: number;
  scrollbackDirs: string[];   // dirs to scan for orphaned .janus_scrollback_*.log
}

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
