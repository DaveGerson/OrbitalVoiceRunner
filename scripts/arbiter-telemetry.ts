// scripts/arbiter-telemetry.ts — the v02l watch's 5-minute check (turn-arbiter T4 telemetry).
//
// The +14d watch bead reviews two things after live use, via the REAL JanusStore readers
// (src/store/sqliteStore.ts getJumpOvers/getArbiterDrains, schema v14):
//   1. the jump_over counter — post-arbiter this is STRUCTURALLY ZERO (a forced turn landing
//      mid-answer/mid-utterance can only mean an arbiter bypass or a classifier bug), so every
//      row prints in full;
//   2. the arbiter_drain shape — count, drain_size distribution (min/p50/p90/max + count by
//      size), delivery-mode distribution, and headline-cls distribution (the D2 headline +
//      counted-tail policy's analysis unit).
//
// Usage: npm run telemetry:arbiter [-- --days N | --all]      (default window: 14 days)
//        JANUS_DB=path/to/.janus.db npm run telemetry:arbiter
//
// READ-ONLY discipline: the CLI never calls store.init() — no schema is created or migrated —
// and refuses to run at all when the DB file is absent (a fresh `new Database()` would CREATE an
// empty one). better-sqlite3's `{ readonly: true }` open is deliberately NOT used: a WAL-mode DB
// (the production default) can refuse a strictly read-only open when its -shm sidecar is absent
// (e.g. right after a clean server shutdown), which would make this check flaky; skipping init()
// plus a zero-write report path is the actual no-create/no-migrate guarantee.
//
// The report core is exported as a pure function over a store handle so the unit test
// (tests/test_arbiter_telemetry.ts) drives it through the real record/read API; this CLI shell
// only resolves the production DB path (the server.ts convention: JANUS_DB || .janus.db).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JanusStore } from "../src/store/sqliteStore";
import type { JumpOverRow, ArbiterDrainRow } from "../src/store/types";

/** The two readers the report needs — structural, so tests can hand in any real store. */
export interface TelemetryStoreReader {
  getJumpOvers(sinceTs: number, limit?: number): JumpOverRow[];
  getArbiterDrains(sinceTs: number, limit?: number): ArbiterDrainRow[];
}

/** Far above any sane 2-week volume (retention caps both tables at 30d anyway); if a window ever
 *  hits this limit the totals below are floors, which the header calls out. */
const ROW_LIMIT = 10_000;

const iso = (ts: number): string => new Date(ts).toISOString();

/** Nearest-rank percentile over an ASCENDING-sorted array (deterministic, no interpolation). */
function percentile(sortedAsc: number[], p: number): number {
  return sortedAsc[Math.max(0, Math.ceil(p * sortedAsc.length) - 1)];
}

function countBy<T>(rows: T[], key: (r: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function distLine(label: string, m: Map<string, number>): string {
  const parts = [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([k, n]) => `${k} x${n}`);
  return `${label}: ${parts.join(", ")}`;
}

function jumpOverSection(rows: JumpOverRow[]): string[] {
  const lines = ["== jump_over (post-arbiter invariant: structurally ZERO) =="];
  if (rows.length === 0) {
    lines.push("jump_over total: 0 (expected — no forced turn landed mid-answer/mid-utterance)");
    return lines;
  }
  lines.push(`jump_over total: ${rows.length}  ** NON-ZERO — every row below is a bypass/classifier bug; investigate **`);
  for (const r of rows) {
    lines.push(`  ${iso(r.ts)} producer=${r.producer ?? "-"} cls=${r.cls ?? "-"} detail=${r.detail ?? "-"}`);
  }
  return lines;
}

function drainSection(rows: ArbiterDrainRow[]): string[] {
  const lines = ["== arbiter_drain (D2 headline + counted-tail shape) =="];
  lines.push(`drains total: ${rows.length}`);
  if (rows.length === 0) return lines;
  const sizes = rows.map((r) => r.drain_size).sort((a, b) => a - b);
  lines.push(`drain_size: min=${sizes[0]} p50=${percentile(sizes, 0.5)} p90=${percentile(sizes, 0.9)} max=${sizes[sizes.length - 1]}`);
  lines.push(distLine("by size", countBy(rows, (r) => `size ${r.drain_size}`)));
  lines.push(distLine("by mode", countBy(rows, (r) => r.mode ?? "(null)")));
  lines.push(distLine("by headline_cls", countBy(rows, (r) => `cls ${r.headline_cls ?? "(null)"}`)));
  return lines;
}

/** The v02l report over any store handle. Pure w.r.t. the store: two reads, zero writes. */
export function buildArbiterTelemetryReport(
  store: TelemetryStoreReader,
  opts?: { sinceTs?: number },
): string {
  const sinceTs = opts?.sinceTs ?? 0;
  const jumpOvers = store.getJumpOvers(sinceTs, ROW_LIMIT);
  const drains = store.getArbiterDrains(sinceTs, ROW_LIMIT);
  return [...jumpOverSection(jumpOvers), "", ...drainSection(drains)].join("\n");
}

// ── CLI shell ──────────────────────────────────────────────────────────────────────────────────

/** `--days N` narrows the window; `--all` reads everything retention still holds; default 14d
 *  (the v02l watch window). Returns null for --all. */
function parseWindowDays(argv: string[]): number | null {
  if (argv.includes("--all")) return null;
  const i = argv.indexOf("--days");
  if (i !== -1) {
    const n = Number(argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
    console.error(`ignoring invalid --days value ${JSON.stringify(argv[i + 1])}; using 14`);
  }
  return 14;
}

function runCli(): void {
  const dbPath = process.env.JANUS_DB || ".janus.db";
  if (dbPath !== ":memory:" && !fs.existsSync(dbPath)) {
    console.error(`no ledger DB at ${path.resolve(dbPath)} — set JANUS_DB or run from the server's working directory`);
    process.exit(1);
  }
  const days = parseWindowDays(process.argv.slice(2));
  const sinceTs = days === null ? 0 : Date.now() - days * 86_400_000;
  const store = new JanusStore(dbPath); // no init(): open-only, never create/migrate (see header)
  try {
    console.log(`arbiter telemetry — db=${path.resolve(dbPath)} window=${days === null ? "all retained" : `${days}d`} (row cap ${ROW_LIMIT}/table)`);
    console.log(buildArbiterTelemetryReport(store, { sinceTs }));
  } finally {
    store.close();
  }
}

// tsx main-module guard: run the shell only when invoked directly, never on test import.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli();
}
