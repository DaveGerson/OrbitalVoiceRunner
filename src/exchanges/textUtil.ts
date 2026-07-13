// src/exchanges/textUtil.ts — tiny shared "redact-then-cap" text helper.
//
// Every operator/agent-authored text field that reaches a client-facing summary or spoken/caption
// line goes through the same two-step treatment: redact (strip secrets) then cap (bound length) —
// and `null`/empty input stays `null` (an absent field is never fabricated into an empty string a
// card/caption would render as a blank line). This was previously hand-duplicated in
// src/exchanges/fleetProjection.ts's `summaryText` and src/voice/sitrep.ts's needsInputLine /
// failedLine / completeLine; this module is the one implementation both adopt.
//
// NOTE: this is distinct from src/exchanges/resultEnvelope.ts's `capString`, which caps text that
// has ALREADY been redacted by its caller — that one stays as-is.

/** Redact then cap `s` to `max` chars. `null`/empty/undefined input stays `null`. */
export function redactCapped(
  s: string | null | undefined,
  redact: (s: string) => string,
  max: number,
): string | null {
  if (!s) return null;
  const r = redact(s);
  return r.length > max ? r.slice(0, max) : r;
}
