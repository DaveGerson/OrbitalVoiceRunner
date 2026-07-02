/**
 * Cortex context-injection metrics report CLI — bead/spec docs/superpowers/specs/
 * 2026-07-02-cortex-context-telemetry.md §11, §18.6.
 *
 * Thin wrapper over the exported aggregation function (src/memory/contextMetricsReport.ts) — ALL
 * the actual math lives there and is independently unit-tested. This script only: opens the
 * SQLite store read-only-in-spirit (init() just applies migrations, additive/idempotent), parses
 * CLI flags, calls buildContextMetricsReport, and writes the JSON (stdout and/or --out).
 *
 * Usage:
 *   tsx scripts/context-metrics-report.ts --db .janus.db --since-ms 3600000 --out reports/context-metrics.json
 *   tsx scripts/context-metrics-report.ts --db .janus.db --text-input-usd-per-1m 0.3
 *
 * Flags:
 *   --db <path>                      SQLite db file (default: .janus.db, matching the store's
 *                                     production default file name — see src/store bootstrap).
 *   --since-ms <n>                   RELATIVE lookback window in ms from "now" (e.g. 3600000 = last
 *                                     hour, matching the usage example above). 0 (default) means
 *                                     all time. This is deliberately NOT the same absolute-epoch
 *                                     semantics as buildContextMetricsReport's own `sinceMs` option
 *                                     (see src/memory/contextMetricsReport.ts) — that function is
 *                                     also called directly by tests with fixed absolute cutoffs, so
 *                                     only this CLI wrapper resolves the relative window, via
 *                                     `resolveSinceMsCutoff` below.
 *   --limit <n>                      Max rows read from the store (default: report module's own
 *                                     DEFAULT_QUERY_LIMIT). Must be a positive finite number.
 *   --out <path>                     Also write the JSON to this file (parent dir created if
 *                                     missing). Always prints to stdout regardless.
 *   --text-input-usd-per-1m <n>      Override ContextCostConfig.textInputUsdPer1M. Must be finite.
 *   --audio-input-usd-per-minute <n> Override ContextCostConfig.audioInputUsdPerMinute. Must be finite.
 *   --audio-output-usd-per-minute <n> Override ContextCostConfig.audioOutputUsdPerMinute. Must be finite.
 *
 * Exit codes: 0 = report written. 1 = bad args or the db could not be opened.
 */
import fs from "fs";
import path from "path";
import { JanusStore } from "../src/store/sqliteStore";
import { buildContextMetricsReport, type ContextCostConfig } from "../src/memory/contextMetricsReport";

interface CliArgs {
  db: string;
  sinceMs: number;
  limit: number | undefined;
  out: string | undefined;
  costConfig: Partial<ContextCostConfig>;
}

/** flag -> setter, keyed instead of switch-cased so parseArgs stays a flat single-branch loop
 *  (each new flag is one new table entry, not a new `case`, which keeps CC low as the CLI grows). */
const FLAG_SETTERS: Record<string, (args: CliArgs, value: string) => void> = {
  "--db": (args, v) => { args.db = v; },
  "--since-ms": (args, v) => { args.sinceMs = Number(v); },
  "--limit": (args, v) => { args.limit = Number(v); },
  "--out": (args, v) => { args.out = v; },
  "--text-input-usd-per-1m": (args, v) => { args.costConfig.textInputUsdPer1M = Number(v); },
  "--audio-input-usd-per-minute": (args, v) => { args.costConfig.audioInputUsdPerMinute = Number(v); },
  "--audio-output-usd-per-minute": (args, v) => { args.costConfig.audioOutputUsdPerMinute = Number(v); },
};

/** flag -> costConfig key, for validating the three price overrides uniformly (keeps parseArgs'
 *  branch count flat as validated flags grow — same rationale as FLAG_SETTERS above). */
const PRICE_FLAG_KEYS = [
  ["--text-input-usd-per-1m", "textInputUsdPer1M"],
  ["--audio-input-usd-per-minute", "audioInputUsdPerMinute"],
  ["--audio-output-usd-per-minute", "audioOutputUsdPerMinute"],
] as const;

/** Throws a usage error if any parsed price override is non-finite (e.g. `--limit abc` style typo). */
function validatePriceFlags(args: CliArgs, argv: string[]): void {
  for (const [flag, key] of PRICE_FLAG_KEYS) {
    const value = args.costConfig[key];
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`${flag} must be a finite number, got: ${argv.join(" ")}`);
    }
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { db: ".janus.db", sinceMs: 0, limit: undefined, out: undefined, costConfig: {} };
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
  validatePriceFlags(args, argv);
  return args;
}

/** CLI's `--since-ms` is a RELATIVE lookback window (spec §11's `--since-ms 3600000` = "last hour"),
 *  distinct from buildContextMetricsReport's own absolute-epoch `sinceMs` option. 0 (default) means
 *  "all time", matching the pre-existing default behavior. */
function resolveSinceMsCutoff(sinceMsWindow: number, now: number): number {
  return sinceMsWindow > 0 ? now - sinceMsWindow : 0;
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[context-metrics-report] ${(e as Error).message}`);
    process.exit(1);
  }

  if (!fs.existsSync(args.db)) {
    console.error(`[context-metrics-report] db not found: ${args.db}`);
    process.exit(1);
  }

  const store = new JanusStore(args.db);
  try {
    store.init(); // additive migrations only — safe on an already-current db.
    const report = buildContextMetricsReport(store, {
      sinceMs: resolveSinceMsCutoff(args.sinceMs, Date.now()),
      limit: args.limit,
      costConfig: args.costConfig,
    });
    const json = JSON.stringify(report, null, 2);
    console.log(json);
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, json + "\n", "utf8");
      console.error(`[context-metrics-report] wrote ${args.out}`);
    }
  } finally {
    store.close();
  }
}

main();
