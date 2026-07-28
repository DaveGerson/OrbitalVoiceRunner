// src/exchanges/flag.ts
//
// JANUS_EXCHANGE_SPINE feature flag (spec §8). Read once at boot, the JANUS_SHELL_ALLOWLIST /
// VOICE_TRACE env idiom (src/pendingApprovals.ts:120-ish, src/observe/index.ts:170) — a plain
// module-level env read, no config framework.
//
//   off (default)   — migration applies but nothing exchange-shaped is written or read; zero
//                      behavior delta from pre-spine code.
//   record          — the spine observes the existing seams and writes agent_exchanges /
//                      exchange_events rows; the legal-transition guard never throws (an illegal
//                      transition attempt is swallowed + logged, mirroring the observe module's
//                      "observation never breaks the pipeline" rule); nothing reads exchange state
//                      to make a decision — every existing path is untouched.
//   authoritative   — the exchange row becomes authoritative for "what's in flight"; step 1.4
//                      wires the dispatch join-tracker replacement on top of this mode.
//
// Exported as a function (not a frozen module constant) so tests can pass an explicit env map
// without mutating process.env or relying on import order/caching.
//
// FLAG COLLAPSE (2026-07, refactor/collapse-exchange-flags): this flag USED TO be one of three
// independent tri-state env vars in this subsystem — JANUS_EXCHANGE_SPINE (off/shadow/primary),
// JANUS_INSTRUCTION_ENVELOPE (off/shadow/primary), JANUS_AGENT_RESULT_ENVELOPE (off/accept/
// request) — 27 nominal combinations, most meaningless (the latter two were always inert no-ops
// unless this one was on). They are now collapsed to TWO: this flag (renamed rungs shadow->record,
// primary->authoritative — same meaning, self-describing names) plus the independent, orthogonal
// JANUS_AGENT_COMPLETION_PROMPT off|on (src/exchanges/resultEnvelope.ts). See the FLAG LATTICE
// below for exactly what this flag now subsumes, and BACK-COMPAT below for the old spellings.
//
// BACK-COMPAT: an operator with `JANUS_EXCHANGE_SPINE=shadow` or `=primary` already set (the
// pre-collapse spellings) keeps working unchanged — `readExchangeSpineMode` aliases them to
// `record`/`authoritative` before validating. The two vars this flag ABSORBED
// (`JANUS_INSTRUCTION_ENVELOPE`, `JANUS_AGENT_RESULT_ENVELOPE`) are different: they no longer do
// ANYTHING when set (never an error — see each module's own `legacyFlagRetirementWarning` call,
// src/exchanges/flagReader.ts, for the one-line startup heads-up).

/**
 * Shared env-flag reader for the off/on-ish enum idiom used across this subsystem — this exact
 * reader backs `readExchangeSpineMode` below and `readAgentCompletionPromptMode`
 * (src/exchanges/resultEnvelope.ts). `readEnumFlag`/`readExchangeSpineMode`/`ExchangeSpineMode`
 * are all re-exported from their own side-effect-free module (src/exchanges/flagReader.ts — see
 * that file's doc comment for exactly WHY `readExchangeSpineMode` itself is not defined directly
 * in this file: importing it from instructionEnvelope.ts/resultEnvelope.ts must never transitively
 * trigger THIS module's own eager `EXCHANGE_SPINE_MODE` read below).
 *
 * FLAG LATTICE (post-collapse — read before assuming a rung does something in isolation):
 * `JANUS_EXCHANGE_SPINE` gates whether an `agent_exchanges` row exists AT ALL, AND now fully
 * determines instruction-envelope mode (formerly the independent `JANUS_INSTRUCTION_ENVELOPE`
 * off/shadow/primary flag) — off -> off, `record` -> the old shadow-equivalent (envelopes built +
 * stored, not yet the delivered instruction), `authoritative` -> the old primary-equivalent (the
 * rendered envelope IS the delivered instruction). It ALSO subsumes the old
 * `JANUS_AGENT_RESULT_ENVELOPE=accept` rung: whenever this flag is `record` or `authoritative`,
 * result-envelope SCANNING is active (an agent's self-reported completion JSON is parsed if
 * volunteered — Orbital never asks for one on its own). The one behavior that used to live behind
 * `JANUS_AGENT_RESULT_ENVELOPE=request` — inviting a completion report by appending the exchange
 * id to the outgoing instruction text — is now the separate, orthogonal
 * `JANUS_AGENT_COMPLETION_PROMPT=on` flag (src/exchanges/resultEnvelope.ts): meaningful only when
 * THIS flag is non-off, an inert no-op when it's off, but its own independent on/off knob rather
 * than a third rung here.
 */
export { readEnumFlag, readExchangeSpineMode, type ExchangeSpineMode } from "./flagReader";
import { readExchangeSpineMode, type ExchangeSpineMode } from "./flagReader";

/** Cached at module load (the established env-flag idiom) — one process, one mode. THIS is the
 *  constant every real production call site (spine.ts, gating/index.ts, observe/index.ts,
 *  voice/index.ts, server.ts, …) reads — instructionEnvelope.ts/resultEnvelope.ts deliberately do
 *  NOT import it (see flagReader.ts's doc comment); they compute their own independently-frozen
 *  copy from the same side-effect-free `readExchangeSpineMode` instead. */
export const EXCHANGE_SPINE_MODE: ExchangeSpineMode = readExchangeSpineMode();

export function exchangeSpineWrites(mode: ExchangeSpineMode = EXCHANGE_SPINE_MODE): boolean {
  return mode === "record" || mode === "authoritative";
}

// `exchangeSpineIsAuthoritative` (mode === "authoritative") was removed here — dead API, zero
// consumers anywhere in src/ or tests/ beyond its own definition (Fix 5, dead-API removal pass).
// `authoritative` mode is still read via `EXCHANGE_SPINE_MODE`/`readExchangeSpineMode` directly
// wherever a caller actually needs it.
