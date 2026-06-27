// src/memory/cortexClient.ts — the CORTEX typed facade over the shared Python daemon core (Inc 4,
// slice 1, SHADOW). A thin sibling to synthFacadeOverCore / createPythonApprovalClient: it owns ONLY
// the `cortex.decide` op's wire mapping (tiers+ctx+now in, {decision,trace} out) and validates the raw
// response with CortexDecideResponseSchema. It SHARES the caller's core so synth + approval + cortex ride
// one multiplexed daemon — it never spawns its own. NEVER rejects: any miss (daemon unavailable, expiry,
// error response, schema reject, even a rejected request) resolves to { ok: false }. The cortex never
// enforces and never sits on a hot path — Gemini is the brain; this is the deterministic prosthetic.
import type { PythonModuleClient } from "./pythonClient";
import {
  CortexDecideResponseSchema,
  type CortexCtx,
  type CortexDecision,
  type CortexTrace,
  type MemoryTiers,
} from "./types";

export type CortexResult =
  | { ok: true; decision: CortexDecision; trace: CortexTrace }
  | { ok: false };

export interface PythonCortexClient {
  /** Run one curation decision via the daemon; resolves {ok,decision,trace} or {ok:false} on any miss.
   *  NEVER rejects. SHADOW: the caller LOGS the trace and does NOT apply the decision. */
  decide(tiers: MemoryTiers, ctx: CortexCtx, now: number): Promise<CortexResult>;
  /** True only when the shared daemon has pinged and the breaker is closed. */
  available(): boolean;
}

/** Build the cortex facade over an EXISTING shared core (does NOT dispose it — the core owner does). */
export function createPythonCortexClient(core: PythonModuleClient): PythonCortexClient {
  return {
    available() { return core.available(); },
    decide(tiers, ctx, now) {
      return core.request("cortex.decide", { tiers, ctx, now }).then((obj) => {
        if (!obj) return { ok: false } as CortexResult;
        const parsed = CortexDecideResponseSchema.safeParse(obj);
        if (parsed.success && parsed.data.ok) {
          return { ok: true, decision: parsed.data.decision, trace: parsed.data.trace };
        }
        return { ok: false } as CortexResult;
      }, () => ({ ok: false } as CortexResult));  // belt-and-suspenders: the core never rejects, but if it did, still a miss
    },
  };
}
