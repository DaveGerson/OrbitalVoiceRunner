/**
 * AgentExchange communication-quality metrics report CLI — Phase 5, Step 5.2.
 *
 * Thin wrapper over the exported aggregation function (src/exchanges/metrics.ts) — ALL the actual
 * math lives there and is independently unit-tested. This script only: opens the SQLite store
 * (init() just applies migrations, additive/idempotent), parses CLI flags, calls
 * buildExchangeMetricsReport, and writes the JSON (stdout and/or --out). Mirrors
 * scripts/context-metrics-report.ts's exact shape/flag conventions so the two report CLIs feel like
 * one family.
 *
 * Usage:
 *   tsx scripts/exchange-metrics-report.ts --db .janus.db --since-ms 3600000
 *   tsx scripts/exchange-metrics-report.ts --db .janus.db --out reports/exchange-metrics.json
 *
 * Flags:
 *   --db <path>       SQLite db file (default: .janus.db, matching the store's production default).
 *   --since-ms <n>    RELATIVE lookback window in ms from "now" (e.g. 3600000 = last hour). 0
 *                     (default) means all time — a RELATIVE window, resolved to an absolute
 *                     epoch cutoff here (see resolveSinceMsCutoff), distinct from
 *                     buildExchangeMetricsReport's own absolute-epoch `sinceMs` option (that
 *                     function is also called directly by tests with fixed absolute cutoffs).
 *   --limit <n>       Max rows read from each underlying store read (default: the report module's
 *                     own DEFAULT_QUERY_LIMIT). Must be a positive finite number.
 *   --out <path>      Also write the JSON to this file (parent dir created if missing). Always
 *                     prints to stdout regardless.
 *
 * Exit codes: 0 = report written. 1 = bad args or the db could not be opened.
 */
import fs from "fs";
import path from "path";
import { JanusStore } from "../src/store/sqliteStore";
import { buildExchangeMetricsReport } from "../src/exchanges/metrics";

interface CliArgs {
  db: string;
  sinceMs: number;
  limit: number | undefined;
  out: string | undefined;
}

/** flag -> setter, keyed instead of switch-cased so parseArgs stays a flat single-branch loop
 *  (mirrors context-metrics-report.ts's FLAG_SETTERS idiom — new flags are new table entries, not
 *  new `case`s, keeping CC low as the CLI grows). */
const FLAG_SETTERS: Record<string, (args: CliArgs, value: string) => void> = {
  "--db": (args, v) => { args.db = v; },
  "--since-ms": (args, v) => { args.sinceMs = Number(v); },
  "--limit": (args, v) => { args.limit = Number(v); },
  "--out": (args, v) => { args.out = v; },
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { db: ".janus.db", sinceMs: 0, limit: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const setter = FLAG_SETTERS[flag];
    if (!setter) throw new Error(`unknown flag: ${flag}`);
    setter(args, argv[++i]);
  }
  if (!Number.isFinite(args.sinceMs) || args.sinceMs < 0) {
    throw new Error(`--since-ms must be a non-negative number, got: ${argv.join(" ")}`);
  }
  if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error(`--limit must be a positive number, got: ${argv.join(" ")}`);
  }
  return args;
}

/** CLI's `--since-ms` is a RELATIVE lookback window (mirrors context-metrics-report.ts's own flag),
 *  distinct from buildExchangeMetricsReport's absolute-epoch `sinceMs` option. 0 (default) means
 *  "all time". */
function resolveSinceMsCutoff(sinceMsWindow: number, now: number): number {
  return sinceMsWindow > 0 ? now - sinceMsWindow : 0;
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[exchange-metrics-report] ${(e as Error).message}`);
    process.exit(1);
  }

  if (!fs.existsSync(args.db)) {
    console.error(`[exchange-metrics-report] db not found: ${args.db}`);
    process.exit(1);
  }

  const store = new JanusStore(args.db);
  try {
    store.init(); // additive migrations only — safe on an already-current db.
    const report = buildExchangeMetricsReport(store, {
      sinceMs: resolveSinceMsCutoff(args.sinceMs, Date.now()),
      limit: args.limit,
    });
    const json = JSON.stringify(report, null, 2);
    console.log(json);
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, json + "\n", "utf8");
      console.error(`[exchange-metrics-report] wrote ${args.out}`);
    }
  } finally {
    store.close();
  }
}

main();
