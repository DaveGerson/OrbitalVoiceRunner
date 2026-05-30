// src/store/retention.ts
import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface PruneOpts {
  now: number; eventsTtlDays: number; archiveTtlDays: number;
  scrollbackDirs: string[];   // dirs to scan for orphaned .janus_scrollback_*.log
}

export function pruneOnBoot(db: Database.Database, opts: PruneOpts): void {
  const day = 86_400_000;
  const evCutoff = opts.now - opts.eventsTtlDays * day;
  const arCutoff = opts.now - opts.archiveTtlDays * day;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM events WHERE ts < ?").run(evCutoff);          // triggers keep events_fts in sync
    db.prepare("DELETE FROM panes_archive WHERE archived_at < ?").run(arCutoff);
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
