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
import { EXCHANGE_SPINE_MODE } from "./flag";
import { recoverExchangesOnBoot, type ExchangeRecoveryReport } from "./recovery";
import { rehydrateDraftRegistryOnBoot, type DraftRegistryRehydrationReport } from "./draftRegistry";
import { instructionEnvelopeActive } from "./instructionEnvelope";
import type { JanusStore } from "../store/sqliteStore";

let singleton: ExchangeService | null = null;

/** The one process-wide correlator, created lazily on first use so a process that never turns
 *  the flag on never even allocates it. `initExchangeSpineOnBoot` (below) constructs it EAGERLY at
 *  boot and attaches the store immediately afterward — synchronously, before panes/voice can
 *  produce any activity (panes boot INERT) — so a lazily-constructed store-less singleton here is
 *  purely the "boot wiring never ran / flag is off" fallback, never a race with real traffic. */
export function getExchangeService(): ExchangeService {
  if (!singleton) singleton = new ExchangeService();
  return singleton;
}

export function exchangeSpineActive(): boolean {
  return EXCHANGE_SPINE_MODE !== "off";
}

// `exchangeSpineMode()` (a plain `() => EXCHANGE_SPINE_MODE` accessor) was removed here — dead API,
// zero consumers anywhere in src/ or tests/ beyond its own definition (Fix 5, dead-API removal
// pass). Every real caller either wants `exchangeSpineActive()` (the boolean it actually branches
// on) or reads `EXCHANGE_SPINE_MODE` directly.

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
/** Boot recovery's report, PLUS (Phase 4, Step 4.3) the draft-registry rehydration report when the
 *  instruction-envelope flag is active — `undefined` when the envelope flag is off (no registry
 *  to rehydrate) or when rehydration itself best-effort-failed (logged, never fatal). */
export type ExchangeBootRecoveryResult = ExchangeRecoveryReport & {
  draftRegistry?: DraftRegistryRehydrationReport;
};

/**
 * Phase 4, Step 4.3: rehydrate the in-memory envelope-draft registry (src/exchanges/draftRegistry
 * .ts) from the durable rows `recoverExchangesOnBoot` just classified. MUST run AFTER that
 * quarantine walk (an `awaiting_approval` row it reverted to `draft` because the bound approval
 * vanished must rehydrate as a plain draft, never with a binding to a dead approval) — this
 * function's own defensive re-check (`rehydrateApprovalBindingIfSurvived`) also makes it safe on
 * its own, but the ordering here is the intended, tested one. Only runs when the instruction-
 * envelope flag is active (off ⇒ no registry exists to rehydrate); never throws back into boot.
 */
function rehydrateDraftRegistryOnBootBestEffort(store: JanusStore): DraftRegistryRehydrationReport | undefined {
  if (!instructionEnvelopeActive()) return undefined;
  try {
    return rehydrateDraftRegistryOnBoot(store);
  } catch (e) {
    console.error("[exchange-spine] draft-registry rehydration failed (continuing boot; registry stays empty for this process):", e);
    return undefined;
  }
}

export function initExchangeSpineOnBoot(store: JanusStore): ExchangeBootRecoveryResult | undefined {
  if (!exchangeSpineActive()) return undefined;
  const svc = getExchangeService();
  svc.attachStore(store);
  try {
    const report = recoverExchangesOnBoot(store);
    svc.recoverOnBoot();
    const draftRegistry = rehydrateDraftRegistryOnBootBestEffort(store);
    return draftRegistry ? { ...report, draftRegistry } : report;
  } catch (e) {
    console.error("[exchange-spine] boot recovery failed (continuing boot; store sink stays attached for new exchanges):", e);
    svc.recoverOnBoot();
    return undefined;
  }
}

/** Test-only reset (fresh singleton + fresh in-memory state) — mirrors the reset seams other
 *  process-wide singletons in this codebase expose for test isolation. Not used by production
 *  wiring. */
export function resetExchangeServiceForTests(): void {
  singleton = null;
}
