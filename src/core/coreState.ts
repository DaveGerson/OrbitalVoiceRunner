import type { JanusStore } from "../store/sqliteStore";

/**
 * coreState — the shared mutable runtime state hoisted out of `startServer()` (DBT5 / dec-1) so the
 * domain modules later carved out of server.ts (observe / gating / voice) can mutate the SAME cells
 * through an injected deps bag instead of closing over server-local `let`s.
 *
 * The ONE hard requirement: this is a single object passed BY REFERENCE — never value-copied — so a
 * WS `set_active_pane` write is immediately visible to the gate resolver that reads `activePaneId`
 * across the module boundary. (Value copies are the desync hazard this whole effort removes.)
 *
 * `frozen` is read-only from the outside and may only be mutated via `setFrozen`, which keeps the
 * STOP-ALL durable persistence coupled to every write — a froze-for-a-reason survives a restart.
 */
export interface CoreState {
  /** The frontend WS that owns the single live operator channel (last-connection-wins; null = none). */
  activeFrontendWs: any;
  /**
   * The current live Gemini session, hoisted so the module-level sweep can speak a last-call for
   * non-session-bound pending ACTIONS. Set when a connect resolves, nulled on socket close.
   * Null === no voice channel to narrate into.
   */
  activeLiveSession: any;
  /** The broadcast client set; dead-socket self-healing lives in server.ts `broadcast()`. */
  readonly clients: Set<any>;
  /**
   * The pane the operator currently has open on screen (driven by the UI via `set_active_pane`) —
   * the SINGLE source of truth for where Janus may write (see `isPaneActiveForWrite`). Null when no
   * pane is open / no UI is connected (no write permitted).
   */
  activePaneId: string | null;
  /**
   * STOP-ALL Stage-1 freeze (spec §2.C / §3): while true the gate resolver short-circuits EVERY
   * capability to Off at the single choke-point (`effectiveCapabilityGateFor`). Read-only here —
   * mutate ONLY via `setFrozen` so persistence stays coupled.
   */
  readonly frozen: boolean;
  /**
   * The panes whose Stage-2 `stop()` rejected on the most recent confirm (QW4). Set by `stopAll(true)`
   * right before its return; read synchronously by the REST confirm route after it awaits stopAll.
   */
  lastStopAllFailed: string[];
  /** Set + durably persist the freeze flag (survives a process restart via the kv). */
  setFrozen(value: boolean): void;
}

const FROZEN_KV = "frozen";

/**
 * Build the shared `coreState`. `frozen` is restored from the durable kv on construction so a freeze
 * survives a restart. Pass the process-wide `JanusStore` (or `null` when the store failed to boot).
 */
export function createCoreState(store: JanusStore | null): CoreState {
  let frozen: boolean = store?.getKV(FROZEN_KV) === "1";
  return {
    activeFrontendWs: null,
    activeLiveSession: null,
    clients: new Set<any>(),
    activePaneId: null,
    lastStopAllFailed: [],
    get frozen(): boolean {
      return frozen;
    },
    setFrozen(value: boolean): void {
      frozen = value;
      if (!store) return;
      try {
        if (value) store.setKV(FROZEN_KV, "1");
        else store.deleteKV(FROZEN_KV);
      } catch (e) {
        console.error("[STOP-ALL] failed to persist frozen flag:", e);
      }
    },
  };
}
