// src/exchanges/spine.ts
//
// AgentExchange spine — the process-wide wiring seam (Phase 1, Step 1.3, task C; Step 1.5b adds
// the durable persistence bridge below). One `ExchangeService` per process, gated by
// `JANUS_EXCHANGE_SPINE` (src/exchanges/flag.ts).
//
// Step 1.3 wired the IN-MEMORY correlator (src/exchanges/service.ts) into the live dispatch/
// approval paths so exchange_id + draft_version thread through them under the flag. Step 1.5b
// closes the gap that left open: `ExchangeService` itself now dual-writes to the `agent_exchanges`
// / `exchange_events` SQLite tables (src/store/sqliteStore.ts's insertExchange/updateExchange/
// appendExchangeEvent) whenever a `JanusStore` is attached — see that module's own doc for the
// bridge design. This file's job is just wiring order: `initExchangeSpineOnBoot` (called once
// from server.ts, right after the store is initialized and before panes/voice can produce any
// exchange) attaches the real store to the singleton and runs the durable boot-recovery walk.
// Every call in this module is best-effort and NEVER throws back into a caller (spec §9.6 — a
// spine outage must never block or loosen a write decision); `off` mode (the default) touches
// nothing — the store is never wired, recovery never runs, and the singleton (if ever created
// later, e.g. by a stray call in `off` mode) stays store-less.

import { ExchangeService } from "./service";
import { EXCHANGE_SPINE_MODE, type ExchangeSpineMode } from "./flag";
import { recoverExchangesOnBoot, type ExchangeRecoveryReport } from "./recovery";
import type { JanusStore } from "../store/sqliteStore";

let singleton: ExchangeService | null = null;
/** Set by `initExchangeSpineOnBoot` so a singleton constructed AFTER boot wiring (the common
 *  case — nothing touches `getExchangeService()` until real pane/voice activity, and panes boot
 *  inert) still picks up the store on first construction, without requiring boot to run after
 *  the first `getExchangeService()` call. */
let bootStore: JanusStore | null = null;

/** The one process-wide correlator, created lazily on first use so a process that never turns
 *  the flag on never even allocates it. */
export function getExchangeService(): ExchangeService {
  if (!singleton) singleton = new ExchangeService({ store: bootStore ?? undefined });
  return singleton;
}

export function exchangeSpineMode(): ExchangeSpineMode {
  return EXCHANGE_SPINE_MODE;
}

export function exchangeSpineActive(): boolean {
  return EXCHANGE_SPINE_MODE !== "off";
}

/**
 * Boot-time wiring (Phase 1, Step 1.5b) — called once from server.ts's boot sequence, AFTER the
 * `JanusStore` is initialized and BEFORE panes/voice can produce any new exchange (server.ts is
 * still executing its synchronous module-scope boot sequence at that call site; panes boot INERT
 * — CLAUDE.md — so nothing can race this with a real write). `off` mode is a complete no-op
 * (returns `undefined` without touching the store, the singleton, or the durable table).
 *
 * Unifies the two recovery stories the step 1.5b brief flagged as overlapping:
 *   1. `recoverExchangesOnBoot` (src/exchanges/recovery.ts) — the actual restart-safety
 *      mechanism. It walks the DURABLE `agent_exchanges` rows, which is the only place a fresh
 *      process's restart-safety truth can live (a fresh `ExchangeMachine` starts empty).
 *   2. `ExchangeService.recoverOnBoot()` — clears the (at a real boot, always-empty) in-memory
 *      active-pane bindings, so the "a restart clears the correlator's binding" invariant holds
 *      unconditionally even in the unusual case something touched the singleton earlier in this
 *      same process (see that method's own doc).
 * Never throws: a durable-recovery failure is logged loudly and boot continues with the store
 * still attached for new exchanges going forward (only a STORE-INIT failure, handled entirely
 * separately in server.ts before this ever runs, is fatal).
 */
export function initExchangeSpineOnBoot(store: JanusStore): ExchangeRecoveryReport | undefined {
  if (!exchangeSpineActive()) return undefined;
  bootStore = store;
  const svc = getExchangeService();
  svc.attachStore(store);
  try {
    const report = recoverExchangesOnBoot(store);
    svc.recoverOnBoot();
    return report;
  } catch (e) {
    console.error("[exchange-spine] boot recovery failed (continuing boot; store sink stays attached for new exchanges):", e);
    svc.recoverOnBoot();
    return undefined;
  }
}

/** Test-only reset (fresh singleton + fresh in-memory state, and forgets any boot-wired store) —
 *  mirrors the reset seams other process-wide singletons in this codebase expose for test
 *  isolation. Not used by production wiring. */
export function resetExchangeServiceForTests(): void {
  singleton = null;
  bootStore = null;
}
