/**
 * AgentExchange communication-quality metrics report CLI — Phase 5, Step 5.2.
 *
 * Thin declaration over the shared report-CLI shell (scripts/lib/reportCli.ts) — ALL the actual
 * math lives in src/exchanges/metrics.ts and is independently unit-tested; this script only
 * declares the flag family (no extras beyond the shared --db/--since-ms/--limit/--out) and its
 * `buildExchangeMetricsReport` call. Mirrors scripts/context-metrics-report.ts's exact
 * shape/flag conventions so the two report CLIs feel like one family.
 *
 * Usage:
 *   tsx scripts/exchange-metrics-report.ts --db .janus.db --since-ms 3600000
 *   tsx scripts/exchange-metrics-report.ts --db .janus.db --out reports/exchange-metrics.json
 *
 * Flags:
 *   --db <path>       SQLite db file (default: .janus.db, matching the store's production default).
 *   --since-ms <n>    RELATIVE lookback window in ms from "now" (e.g. 3600000 = last hour). 0
 *                     (default) means all time — a RELATIVE window, resolved to an absolute
 *                     epoch cutoff (see scripts/lib/reportCli.ts), distinct from
 *                     buildExchangeMetricsReport's own absolute-epoch `sinceMs` option (that
 *                     function is also called directly by tests with fixed absolute cutoffs).
 *   --limit <n>       Max rows read from each underlying store read (default: the report module's
 *                     own DEFAULT_QUERY_LIMIT). Must be a positive finite number.
 *   --out <path>      Also write the JSON to this file (parent dir created if missing). Always
 *                     prints to stdout regardless.
 *
 * Exit codes: 0 = report written. 1 = bad args or the db could not be opened.
 */
import { buildExchangeMetricsReport } from "../src/exchanges/metrics";
import { runMetricsReportCli, type BaseCliArgs } from "./lib/reportCli";

runMetricsReportCli<BaseCliArgs>({
  label: "exchange-metrics-report",
  buildReport: (store, args, resolvedSinceMs) =>
    buildExchangeMetricsReport(store, { sinceMs: resolvedSinceMs, limit: args.limit }),
});
