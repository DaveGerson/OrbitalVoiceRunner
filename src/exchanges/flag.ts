// src/exchanges/flag.ts
//
// JANUS_EXCHANGE_SPINE feature flag (spec §8). Read once at boot, the JANUS_SHELL_ALLOWLIST /
// VOICE_TRACE env idiom (src/pendingApprovals.ts:120-ish, src/observe/index.ts:170) — a plain
// module-level env read, no config framework.
//
//   off (default)  — migration applies but nothing exchange-shaped is written or read; zero
//                     behavior delta from pre-spine code.
//   shadow         — the spine observes the existing seams and writes agent_exchanges /
//                     exchange_events rows; the legal-transition guard never throws (an illegal
//                     transition attempt is swallowed + logged, mirroring the observe module's
//                     "observation never breaks the pipeline" rule); nothing reads exchange state
//                     to make a decision — every existing path is untouched.
//   primary        — the exchange row becomes authoritative for "what's in flight"; step 1.4
//                     wires the dispatch join-tracker replacement on top of this mode.
//
// Exported as a function (not a frozen module constant) so tests can pass an explicit env map
// without mutating process.env or relying on import order/caching.

/**
 * Shared env-flag reader for the tri-state off/shadow/primary (and off/accept/request) idiom used
 * across this subsystem — this exact reader backs `readExchangeSpineMode` below,
 * `readInstructionEnvelopeMode` (src/exchanges/instructionEnvelope.ts), and
 * `readResultEnvelopeMode` (src/exchanges/resultEnvelope.ts). Re-exported from its own
 * side-effect-free module (src/exchanges/flagReader.ts — see that file's doc comment for WHY it is
 * not defined directly in this file: importing it from the other two flag modules must never
 * transitively trigger THIS module's own eager `EXCHANGE_SPINE_MODE` read).
 *
 * FLAG LATTICE (which flag implies which — read before flipping one on in isolation):
 * `JANUS_EXCHANGE_SPINE` gates whether an `agent_exchanges` row exists AT ALL; every other
 * exchange-adjacent flag below it (`JANUS_INSTRUCTION_ENVELOPE`, `JANUS_AGENT_RESULT_ENVELOPE`) is
 * only meaningful once the spine itself is `shadow`/`primary` — there is nothing durable for an
 * envelope/result-envelope to attach to otherwise. No flag silently forces another's value, though:
 * each is read and validated independently, so turning one on with the spine off is a harmless,
 * inert no-op rather than an error.
 */
export { readEnumFlag } from "./flagReader";
import { readEnumFlag } from "./flagReader";

export type ExchangeSpineMode = "off" | "shadow" | "primary";

const EXCHANGE_SPINE_MODES: readonly ExchangeSpineMode[] = ["off", "shadow", "primary"];

/**
 * Default mode when the env var is unset/empty/unrecognized: **off**.
 *
 * NOTE (spec/task discrepancy, documented per step 1.3 instructions): the step 1.3 implementer
 * brief's parenthetical says "JANUS_EXCHANGE_SPINE flag (default: shadow …)", but the spine spec
 * itself — docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §8, which the brief names as
 * "THE authoritative contract... implement it exactly" — is explicit: "off (default): migration
 * applies..., but no exchange rows are written and no code path consults them. Zero behavior
 * delta." Resolved in favor of the spec doc (the stated authority) over the brief's parenthetical:
 * `off` is the default here. This is also the more conservative engineering choice for a step that
 * threads new fields through hot paths (voice dispatch, approval resolution) touched by a very
 * large existing regression suite — an operator opts into `shadow` (observe-only, writes but never
 * reads back to decide) explicitly via the env var once ready to collect fidelity data, and into
 * `primary` only after that.
 */
export function readExchangeSpineMode(env: NodeJS.ProcessEnv = process.env): ExchangeSpineMode {
  return readEnumFlag("JANUS_EXCHANGE_SPINE", EXCHANGE_SPINE_MODES, "off", env);
}

/** Cached at module load (the established env-flag idiom) — one process, one mode. */
export const EXCHANGE_SPINE_MODE: ExchangeSpineMode = readExchangeSpineMode();

export function exchangeSpineWrites(mode: ExchangeSpineMode = EXCHANGE_SPINE_MODE): boolean {
  return mode === "shadow" || mode === "primary";
}

// `exchangeSpineIsAuthoritative` (mode === "primary") was removed here — dead API, zero consumers
// anywhere in src/ or tests/ beyond its own definition (Fix 5, dead-API removal pass). `primary`
// mode is still read via `EXCHANGE_SPINE_MODE`/`readExchangeSpineMode` directly wherever a caller
// actually needs it.
