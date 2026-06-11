/**
 * src/templates.ts — the PURE prompt-template engine (journey-expansion).
 *
 * Slot syntax: `{{slot_name}}` where slot_name matches [A-Za-z0-9_-]+. Slots are always DERIVED
 * from the body at read time (never stored), so an edited body can't drift from a stale slot list.
 *
 * Pure on purpose (no I/O, no Date, no manager): the action defs (src/actions/defs/templates.ts)
 * and the dispatch fan-out (src/actions/defs/dispatch_group.ts) both instantiate through here, and
 * the unit suite exercises the engine without a server boot.
 */

const SLOT_RE = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

/** The unique slot names in a template body, in order of first appearance. */
export function extractSlots(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(SLOT_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export interface InstantiateResult {
  /** The body with every provided slot filled. Unfilled slots are left verbatim (`{{name}}`). */
  text: string;
  /** Slot names present in the body but missing from `values` (callers clarify, not guess). */
  missing: string[];
}

/**
 * Fill `{{slot}}` placeholders from `values`. Missing slots are reported, NOT silently dropped —
 * the caller decides whether to clarify back to the operator (apply/dispatch do) or accept a
 * partial fill. Extra values that match no slot are ignored.
 */
export function instantiateTemplate(body: string, values: Record<string, string>): InstantiateResult {
  const missing: string[] = [];
  for (const slot of extractSlots(body)) {
    if (values[slot] === undefined) missing.push(slot);
  }
  const text = body.replace(SLOT_RE, (whole, name: string) =>
    values[name] !== undefined ? values[name] : whole
  );
  return { text, missing };
}

/** Normalize the voice/REST `values` arg shape ([{name,value}]) into a record. Later wins on dupes. */
export function valuesArrayToRecord(
  values: ReadonlyArray<{ name: string; value: string }> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values ?? []) out[v.name] = v.value;
  return out;
}
