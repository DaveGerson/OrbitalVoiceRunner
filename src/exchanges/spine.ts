// src/exchanges/spine.ts
//
// AgentExchange spine — the process-wide wiring seam (Phase 1, Step 1.3, task C). One
// `ExchangeService` per process, gated by `JANUS_EXCHANGE_SPINE` (src/exchanges/flag.ts).
//
// SCOPE NOTE (reported to the operator at the end of step 1.3): this seam wires the IN-MEMORY
// correlator (src/exchanges/service.ts) into the live dispatch/approval paths so exchange_id +
// draft_version thread through them under the flag. It does NOT yet dual-write to the
// `agent_exchanges` / `exchange_events` SQLite tables that landed in step 1.2
// (src/store/sqliteStore.ts's insertExchange/updateExchange/appendExchangeEvent) — that
// persistence bridge needs a faithful from-state CAS mirror at every call site (so the store
// truly enforces spec §2a's guarded UPDATE, not just trusts the in-memory result) and was
// deliberately deferred rather than rushed; see the step 1.3 report for the follow-up bead. Every
// call in this module is best-effort and NEVER throws back into a caller (spec §9.6 — a spine
// outage must never block or loosen a write decision); `off` mode (the default) touches nothing.

import { ExchangeService } from "./service";
import { EXCHANGE_SPINE_MODE, type ExchangeSpineMode } from "./flag";

let singleton: ExchangeService | null = null;

/** The one process-wide correlator, created lazily on first use so a process that never turns
 *  the flag on never even allocates it. */
export function getExchangeService(): ExchangeService {
  if (!singleton) singleton = new ExchangeService();
  return singleton;
}

export function exchangeSpineMode(): ExchangeSpineMode {
  return EXCHANGE_SPINE_MODE;
}

export function exchangeSpineActive(): boolean {
  return EXCHANGE_SPINE_MODE !== "off";
}

/** Test-only reset (fresh singleton + fresh in-memory state) — mirrors the reset seams other
 *  process-wide singletons in this codebase expose for test isolation. Not used by production
 *  wiring. */
export function resetExchangeServiceForTests(): void {
  singleton = null;
}
