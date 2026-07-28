// src/exchanges/flagReader.ts
//
// The shared env-flag-parsing primitives behind this subsystem's two remaining flags
// (src/exchanges/flag.ts's JANUS_EXCHANGE_SPINE, src/exchanges/resultEnvelope.ts's
// JANUS_AGENT_COMPLETION_PROMPT) — INCLUDING `ExchangeSpineMode`/`readExchangeSpineMode`
// themselves (see below for why they live HERE, not in flag.ts).
//
// Deliberately its OWN tiny module with NO module-level side effects of its own — every export
// here is a pure function/type, so importing this module never freezes anything.
//
// WHY `readExchangeSpineMode` LIVES HERE AND NOT IN flag.ts (read before "simplifying" this):
// flag.ts ALSO exports `EXCHANGE_SPINE_MODE`, a module-level constant EAGERLY computed at import
// time (`export const EXCHANGE_SPINE_MODE = readExchangeSpineMode();`) — the established
// "read once at module load, frozen for the process" idiom. Importing ANYTHING from a module runs
// that module's ENTIRE top-level body first (ES module semantics) — so importing so much as one
// named export from flag.ts unavoidably also runs its `EXCHANGE_SPINE_MODE` line, freezing it from
// whatever `process.env.JANUS_EXCHANGE_SPINE` looks like AT THAT MOMENT.
//
// src/exchanges/instructionEnvelope.ts and src/exchanges/resultEnvelope.ts are imported throughout
// this codebase for PURE, flag-agnostic reasons that have nothing to do with the spine
// (`buildEnvelope`, `createDraft`, `renderEnvelope`, `RENDER_PROFILES`, `COMPLETION_REQUEST_LINE`,
// `scanForResultEnvelope`, …) — often the FIRST thing a test file imports, well before that test's
// own `before()` hook (or a later describe block) deliberately sets `JANUS_EXCHANGE_SPINE` and
// dynamically imports the flag-sensitive pieces (the documented pattern across
// tests/test_exchange_recovery.ts, tests/test_instruction_routing_journeys.ts, etc.). A REAL
// regression this file's own history caught: an earlier draft of the 2026-07 flag collapse had
// instructionEnvelope.ts import `EXCHANGE_SPINE_MODE` directly from flag.ts (reasoning "they're
// derived 1:1 now, so sharing the freeze point is intentional") — this silently froze
// `EXCHANGE_SPINE_MODE` to "off" the moment ANY test statically imported `createDraft`/
// `buildEnvelope` for unrelated pure-logic assertions, breaking
// tests/test_exchange_recovery.ts's real-server-boot suite (recovery quietly never ran). Fixed by
// moving the reader itself here, side-effect-free, so instructionEnvelope.ts/resultEnvelope.ts can
// compute THEIR OWN independently-frozen copy of the spine mode (see each file's own module-level
// constant) without ever touching flag.ts's module body. flag.ts still re-exports
// `readExchangeSpineMode`/`ExchangeSpineMode` from here (so `import { readExchangeSpineMode } from
// "./flag"` keeps working for any caller that wants it from there) and layers its OWN eager
// `EXCHANGE_SPINE_MODE` cache on top — but instructionEnvelope.ts and resultEnvelope.ts import the
// reader from HERE directly, never pulling in flag.ts's own eager constant.
export function readEnumFlag<T extends string>(
  name: string,
  valid: readonly T[],
  dflt: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const raw = (env[name] ?? "").trim().toLowerCase();
  return (valid as readonly string[]).includes(raw) ? (raw as T) : dflt;
}

export type ExchangeSpineMode = "off" | "record" | "authoritative";

const EXCHANGE_SPINE_MODES: readonly ExchangeSpineMode[] = ["off", "record", "authoritative"];

/** Pre-collapse spellings, still accepted (BACK-COMPAT — src/exchanges/flag.ts's file header) —
 *  mapped to their post-collapse equivalent BEFORE validation, so an operator's existing
 *  `shadow`/`primary` env value keeps working unchanged, case-insensitively, exactly like every
 *  canonical spelling.
 *
 *  A `Map` — NOT an object literal — on purpose (adversarial-review finding, 2026-07). A plain
 *  object's string lookup walks `Object.prototype`, so `JANUS_EXCHANGE_SPINE=constructor` (or
 *  `__proto__`) returned a truthy inherited member, which then sailed past the `if (aliased)` guard
 *  as the "mode". Every production gate is `mode !== "off"`, so those two magic values silently
 *  ACTIVATED the whole subsystem — a fail-OPEN regression against the pre-collapse reader, whose
 *  `readEnumFlag` validation correctly sent any unrecognized value to `off`. `Map.get` has no
 *  prototype chain for string keys, so unrecognized input falls through to validation and defaults
 *  closed, as the doc below promises. Pinned by tests/test_exchange_flag.ts. */
const LEGACY_EXCHANGE_SPINE_ALIASES: ReadonlyMap<string, ExchangeSpineMode> = new Map([
  ["shadow", "record"],
  ["primary", "authoritative"],
] as const);

/**
 * Default mode when the env var is unset/empty/unrecognized: **`record`** (graduated from `off`
 * 2026-07; bead wsm-e2e-pinned-d71d).
 *
 * WHY `record` AND NOT `authoritative`: `record` writes the exchange ledger and runs the target
 * resolver in DRY RUN — it logs what it *would* have routed without steering delivery, and no
 * existing code path reads exchange state to make a decision. So it is behavior-neutral by
 * construction while populating `wrongTargetDeliveries` (the resolver tripwire in
 * `GET /api/exchange-metrics`, where non-zero means a resolver bug). That measurement is the
 * evidence gate for promoting to `authoritative`, which is where the ledger starts *governing*
 * dispatch. Shipping `record` by default is what generates the data; shipping `authoritative`
 * by default would be assuming the answer.
 *
 * ESCAPE HATCH: `JANUS_EXCHANGE_SPINE=off` still fully disables the subsystem, and the durable
 * tables are inert under `off`.
 *
 * UNRECOGNIZED INPUT lands on this default (standard `readEnumFlag` behavior). That is safe here
 * precisely because the default is the observe-only rung: a typo can cost you bookkeeping you
 * didn't ask for, never a behavior change, and never `authoritative` — pinned in
 * tests/test_exchange_flag.ts.
 */
export function readExchangeSpineMode(env: NodeJS.ProcessEnv = process.env): ExchangeSpineMode {
  const raw = (env.JANUS_EXCHANGE_SPINE ?? "").trim().toLowerCase();
  const aliased = LEGACY_EXCHANGE_SPINE_ALIASES.get(raw);
  if (aliased) return aliased;
  return readEnumFlag("JANUS_EXCHANGE_SPINE", EXCHANGE_SPINE_MODES, "record", env);
}

/**
 * Pure: true iff `varName` is set to a non-empty (post-trim) value in `env`. Backs the startup
 * warning for the two flags retired by the 2026-07 flag collapse (JANUS_INSTRUCTION_ENVELOPE,
 * JANUS_AGENT_RESULT_ENVELOPE) — an operator with a stale `.env` entry is never crashed, just
 * warned once at module load that the setting is now ignored/subsumed. Returns the ready-to-log
 * message (never null) when set, `null` when unset/empty — callers `console.warn(...)` themselves
 * so this stays pure and independently testable (no console capture needed). `note` should name
 * what subsumed the old var; presence alone triggers the warning, regardless of whether the value
 * itself is a recognized spelling — an operator who typo'd the old var still deserves the heads-up
 * that it does nothing now.
 */
export function legacyFlagRetirementWarning(
  varName: string,
  note: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = (env[varName] ?? "").trim();
  if (raw.length === 0) return null;
  return `[exchange-spine] ${varName} is set but no longer read — ${note} This setting is IGNORED.`;
}
