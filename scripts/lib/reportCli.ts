/**
 * Shared CLI shell for the metrics-report scripts (scripts/exchange-metrics-report.ts,
 * scripts/context-metrics-report.ts). Both scripts used to hand-roll an IDENTICAL shell: open a
 * JanusStore, parse the same --db/--since-ms/--limit/--out flag family (each optionally adding a
 * few report-specific flags), resolve the RELATIVE --since-ms window to an absolute epoch cutoff,
 * call the report's own pure aggregation function, and print/write the resulting JSON with the
 * same exit-code contract (0 = report written, 1 = bad args or the db could not be opened). This
 * module is the ONE shell; each script now only declares its own extra flags/validation and its
 * `buildReport` call — see either script for the thin usage.
 */
import fs from "fs";
import path from "path";
import { JanusStore } from "../../src/store/sqliteStore";

export interface BaseCliArgs {
  db: string;
  sinceMs: number;
  limit: number | undefined;
  out: string | undefined;
}

export type FlagSetter<TArgs> = (args: TArgs, value: string) => void;

export interface RunMetricsReportCliOptions<TArgs extends BaseCliArgs> {
  /** Log-line prefix, e.g. "exchange-metrics-report" — matches each script's own pre-existing
   *  `[label] ...` console messages byte-for-byte. */
  label: string;
  /** Seed the report-specific fields onto the args object (BaseCliArgs's own fields are seeded by
   *  this shell) — e.g. context-metrics-report.ts's `costConfig: {}`. Omit when a script adds no
   *  extra fields (the exchange-metrics-report.ts case). */
  extraDefaults?: () => Omit<TArgs, keyof BaseCliArgs>;
  /** Extra flag -> setter entries beyond --db/--since-ms/--limit/--out (which this shell already
   *  wires); merged on top, so a script CANNOT accidentally shadow the shared four. */
  extraFlags?: Record<string, FlagSetter<TArgs>>;
  /** Extra validation beyond the shared --since-ms/--limit numeric checks (e.g.
   *  context-metrics-report.ts's price-flag finiteness check). Throws on failure, same as the
   *  shared checks. */
  extraValidate?: (args: TArgs, argv: string[]) => void;
  /** Build the report from the opened store + parsed args. `resolvedSinceMs` is already the
   *  absolute-epoch cutoff (RELATIVE --since-ms resolved against `Date.now()`) — distinct from the
   *  raw `args.sinceMs` window, exactly as both scripts' own `resolveSinceMsCutoff` used to do. */
  buildReport: (store: JanusStore, args: TArgs, resolvedSinceMs: number) => unknown;
}

/** CLI's `--since-ms` is a RELATIVE lookback window (e.g. 3600000 = last hour); 0 (default) means
 *  "all time". Distinct from a report module's own absolute-epoch `sinceMs` option (those are also
 *  called directly by tests with fixed absolute cutoffs) — only this CLI shell resolves the
 *  relative window. */
function resolveSinceMsCutoff(sinceMsWindow: number, now: number): number {
  return sinceMsWindow > 0 ? now - sinceMsWindow : 0;
}

export function runMetricsReportCli<TArgs extends BaseCliArgs>(opts: RunMetricsReportCliOptions<TArgs>): void {
  const { label, extraFlags, extraValidate, buildReport } = opts;
  const flagSetters: Record<string, FlagSetter<TArgs>> = {
    ...(extraFlags ?? {}),
    // The shared four are spread LAST so a script's extraFlags genuinely cannot shadow them
    // (matches the extraFlags doc contract above).
    "--db": (args, v) => { args.db = v; },
    "--since-ms": (args, v) => { args.sinceMs = Number(v); },
    "--limit": (args, v) => { args.limit = Number(v); },
    "--out": (args, v) => { args.out = v; },
  };

  /** The shared --since-ms/--limit numeric checks — split out of `parseArgs` purely to keep that
   *  function's own branch count under the complexity gate. */
  function validateSharedFlags(args: TArgs, argv: string[]): void {
    if (!Number.isFinite(args.sinceMs) || args.sinceMs < 0) {
      throw new Error(`--since-ms must be a non-negative number, got: ${argv.join(" ")}`);
    }
    if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit <= 0)) {
      throw new Error(`--limit must be a positive number, got: ${argv.join(" ")}`);
    }
  }

  function parseArgs(argv: string[]): TArgs {
    const base: BaseCliArgs = { db: ".janus.db", sinceMs: 0, limit: undefined, out: undefined };
    const args = { ...base, ...(opts.extraDefaults?.() ?? {}) } as TArgs;
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      const setter = flagSetters[flag];
      if (!setter) throw new Error(`unknown flag: ${flag}`);
      setter(args, argv[++i]);
    }
    validateSharedFlags(args, argv);
    extraValidate?.(args, argv);
    return args;
  }

  let args: TArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[${label}] ${(e as Error).message}`);
    process.exit(1);
  }

  if (!fs.existsSync(args.db)) {
    console.error(`[${label}] db not found: ${args.db}`);
    process.exit(1);
  }

  const store = new JanusStore(args.db);
  try {
    store.init(); // additive migrations only — safe on an already-current db.
    const report = buildReport(store, args, resolveSinceMsCutoff(args.sinceMs, Date.now()));
    const json = JSON.stringify(report, null, 2);
    console.log(json);
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, json + "\n", "utf8");
      console.error(`[${label}] wrote ${args.out}`);
    }
  } finally {
    store.close();
  }
}
