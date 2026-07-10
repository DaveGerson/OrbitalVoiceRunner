// src/exchanges/payload.ts
//
// Tiny shared JSON-payload helpers for the exchange-spine observability modules
// (src/exchanges/replay.ts, src/exchanges/metrics.ts) — both used to carry byte-identical private
// copies of "parse this exchange_events payload_redacted_json safely" and "how many entries does
// this JSON array string have". Neither function does anything spine-specific; this module exists
// purely so there is ONE implementation instead of two hand-synced ones.

/** Parse `json` and return it as a plain object, or `{}` for anything that isn't one — a parse
 *  error, `null`, an array, a primitive. Never throws. The `json || "{}"` fallback treats an empty
 *  string the same as an absent/default payload column. */
export function parseJsonObject(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Length of a JSON array string (e.g. `included_sources_json`/`dropped_sources_json`), or `0` for
 *  anything that isn't a JSON array (parse error, an object, a primitive). Never throws. */
export function safeArrayLength(json: string): number {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}
