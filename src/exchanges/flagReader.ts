// src/exchanges/flagReader.ts
//
// The shared env-flag-parsing primitive behind every off/shadow/primary (and off/accept/request)
// tri-state flag in this subsystem (src/exchanges/flag.ts's JANUS_EXCHANGE_SPINE,
// src/exchanges/instructionEnvelope.ts's JANUS_INSTRUCTION_ENVELOPE,
// src/exchanges/resultEnvelope.ts's JANUS_AGENT_RESULT_ENVELOPE).
//
// Deliberately its OWN tiny module with NO other exports and NO module-level side effects. Each of
// the three flag modules above caches ITS OWN mode in a module-level constant evaluated at first
// import (the established env-flag idiom — "one process, one mode, frozen at module load"), and at
// least one test suite (tests/test_exchange_recovery.ts's "wired into the REAL server boot
// sequence" case) depends on being able to control EXACTLY which import is "the first one" that
// freezes `JANUS_EXCHANGE_SPINE` for a given test process, setting the env var immediately before
// it. If this reader lived inside src/exchanges/flag.ts itself, importing it from
// instructionEnvelope.ts/resultEnvelope.ts would transitively import flag.ts too — silently
// freezing `EXCHANGE_SPINE_MODE` from whatever `process.env` looked like at THAT unrelated import,
// defeating any test that sets the env var right before its own first deliberate touch of the flag
// module. Keeping this reader side-effect-free and in its own module means importing it never has
// that consequence — src/exchanges/flag.ts still re-exports it (so `import { readEnumFlag } from
// "./flag"` keeps working for any caller that wants it from there), but instructionEnvelope.ts and
// resultEnvelope.ts import it from HERE directly, never pulling in flag.ts's own eager constant.
export function readEnumFlag<T extends string>(
  name: string,
  valid: readonly T[],
  dflt: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const raw = (env[name] ?? "").trim().toLowerCase();
  return (valid as readonly string[]).includes(raw) ? (raw as T) : dflt;
}
