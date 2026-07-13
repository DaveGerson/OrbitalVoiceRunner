/**
 * Cortex context-injection metrics report CLI — bead/spec docs/superpowers/specs/
 * 2026-07-02-cortex-context-telemetry.md §11, §18.6.
 *
 * Thin declaration over the shared report-CLI shell (scripts/lib/reportCli.ts) — ALL the actual
 * math lives in src/memory/contextMetricsReport.ts and is independently unit-tested; this script
 * only declares its extra `costConfig` flags/validation and its `buildContextMetricsReport` call.
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
 *                                     only the shared CLI shell (scripts/lib/reportCli.ts) resolves
 *                                     the relative window.
 *   --limit <n>                      Max rows read from the store (default: report module's own
 *                                     DEFAULT_QUERY_LIMIT). Must be a positive finite number.
 *   --out <path>                     Also write the JSON to this file (parent dir created if
 *                                     missing). Always prints to stdout regardless.
 *   --text-input-usd-per-1m <n>      Override ContextCostConfig.textInputUsdPer1M. Must be finite.
 *   --audio-input-usd-per-minute <n> Override ContextCostConfig.audioInputUsdPerMinute. Must be finite.
 *   --audio-output-usd-per-minute <n> Override ContextCostConfig.audioOutputUsdPerMinute. Must be finite.
 *
 * Exit codes: 0 = report written. 1 = bad args or the db could not be opened.
 *
 * Wave 4 (D6, docs/superpowers/specs/2026-07-02-cortex-cutover-design.md): the report JSON gained
 * `cortexPrimaryRate` / `cortexFallbackRate` (see src/memory/contextMetricsReport.ts). No new CLI
 * flag — both are pure derivations over `context_injections` rows already read by this script, so
 * they appear automatically in the printed/written JSON.
 */
import { buildContextMetricsReport, type ContextCostConfig } from "../src/memory/contextMetricsReport";
import { runMetricsReportCli, type BaseCliArgs, type FlagSetter } from "./lib/reportCli";

interface ContextCliArgs extends BaseCliArgs {
  costConfig: Partial<ContextCostConfig>;
}

/** flag -> costConfig key, for validating the three price overrides uniformly (keeps the
 *  validator's own branch count flat as validated flags grow). */
const PRICE_FLAG_KEYS = [
  ["--text-input-usd-per-1m", "textInputUsdPer1M"],
  ["--audio-input-usd-per-minute", "audioInputUsdPerMinute"],
  ["--audio-output-usd-per-minute", "audioOutputUsdPerMinute"],
] as const;

const EXTRA_FLAGS: Record<string, FlagSetter<ContextCliArgs>> = {
  "--text-input-usd-per-1m": (args, v) => { args.costConfig.textInputUsdPer1M = Number(v); },
  "--audio-input-usd-per-minute": (args, v) => { args.costConfig.audioInputUsdPerMinute = Number(v); },
  "--audio-output-usd-per-minute": (args, v) => { args.costConfig.audioOutputUsdPerMinute = Number(v); },
};

/** Throws a usage error if any parsed price override is non-finite (e.g. `--limit abc` style typo). */
function validatePriceFlags(args: ContextCliArgs, argv: string[]): void {
  for (const [flag, key] of PRICE_FLAG_KEYS) {
    const value = args.costConfig[key];
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`${flag} must be a finite number, got: ${argv.join(" ")}`);
    }
  }
}

runMetricsReportCli<ContextCliArgs>({
  label: "context-metrics-report",
  extraDefaults: () => ({ costConfig: {} }),
  extraFlags: EXTRA_FLAGS,
  extraValidate: validatePriceFlags,
  buildReport: (store, args, resolvedSinceMs) =>
    buildContextMetricsReport(store, { sinceMs: resolvedSinceMs, limit: args.limit, costConfig: args.costConfig }),
});
