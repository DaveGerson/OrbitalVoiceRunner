/**
 * src/actions/defs/catchup.ts — hwu.2: the "catch me up" voice verb.
 *
 * A NARROWED consumer of the existing away-digest composer (src/gating/index.ts composeAwayDigest,
 * the "while you were away" reconnect line). Instead of firing only on reconnect over the
 * since-last-detach window, catch_me_up runs the SAME composer over an ARBITRARY [now - window, now]
 * range so the operator can ask "what happened in the last hour?" WITHOUT reconnecting. It does NOT
 * rebuild curation — it fires the shipped path (composer + the cortex "catch-up" injection).
 *
 * Seam (ADR 2026-06-19): pure TypeScript. composeAwayDigest reads durable SQLite event rows (SQLite
 * I/O stays TS); `window_minutes` arrives as a structured number off the Gemini declaration, so there
 * is no NL parsing to send to Python.
 *
 * Wiring (integrator — see the item's requiredRegistrations):
 *   - composeAwayDigest is a closure inside the gating factory; the integrator exposes it on the
 *     Gating API and threads it onto the voice ActionContext as the OPTIONAL `composeAwayDigest`
 *     field this handler reads. Absent (REST/test paths) => graceful "nothing notable" line.
 *   - injectMemoryBrief is ALREADY on ActionContext (server-wired on the voice surface). Firing it
 *     with "catch_me_up" maps through toCortexTrigger -> the cortex wire trigger "catch-up"
 *     (src/memory/types.ts) -> MemoryService.synthesizeAsync(trigger:"catch-up"). It owns its own
 *     try/catch and never rejects; we also guard the synchronous call so a memory-daemon failure can
 *     never break the spoken digest (fail-open on the cortex leg).
 */

import { z } from "zod";
import type { ActionContext, ActionDef, ActionResult } from "../types";

/** window_minutes arrives structured off the Gemini declaration; the handler clamps it. */
const CatchMeUpParams = z.object({
  window_minutes: z.number(),
});

/** The optional composer the integrator threads onto the voice ActionContext (see file header).
 *  Kept as a local structural extension so this def compiles WITHOUT widening the frozen
 *  ActionContext contract (src/actions/types.ts is integrator-owned). */
interface CatchMeUpContext extends ActionContext {
  composeAwayDigest?: (since: number, now: number) => string | null;
}

/** Window bounds (minutes). The clamp is load-bearing: an unclamped negative/huge/NaN window would
 *  drive a degenerate `since` (a future/ancient boundary) into the composer's event scan. */
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 1440; // 24h
const DEFAULT_WINDOW_MINUTES = 60;
const MS_PER_MINUTE = 60_000;

/** The explicit-Off veto string — mirrors the reads.ts read-gating lever shape for read_notes. */
const FORBID_CATCHUP =
  "Error: the 'read_notes' capability is gated Off; reading activity history is forbidden by policy.";

/** Clamp `window_minutes` into [1, 1440]; a non-finite (NaN/Infinity) value falls to the default so
 *  the events scan is ALWAYS bounded. Floor first so fractional minutes never widen the window. */
function clampWindowMinutes(raw: number): number {
  const n = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_WINDOW_MINUTES;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, n));
}

export const catchMeUp: ActionDef<typeof CatchMeUpParams> = {
  name: "catch_me_up",
  description:
    "Catch the operator up on what happened over a recent time window WITHOUT reconnecting: speaks the same 'while you were away' digest (panes that errored/exited/finished, stop-all activity, auto-dispatches) over the last window_minutes. Use it when the operator asks 'what happened in the last hour?' / 'catch me up on the last 30 minutes'. window_minutes is clamped to [1, 1440]; nothing notable in the window yields a short 'nothing notable' line.",
  params: CatchMeUpParams,
  // read_notes is the alert/activity-recall row (the get_attention_digest sibling). Declared for the
  // matrix + discoverability AND actually enforced below as an explicit-Off veto (hwu.2 acceptance #4).
  capability: "read_notes",
  // readOnly:true => runAction re-redacts every string leaf on egress (the inline ctx.redact below is
  // therefore an idempotent double-redact, same as the reads.ts ports). Consistent with the §8.1
  // invariant that binds readOnly:true to the read_pane/read_notes capabilities.
  readOnly: true,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    // Read-gating parity (reads.ts lever): block ONLY on the EXPLICIT operator Off for read_notes at
    // global scope (there is no pane arg). Reads stay available during a STOP-ALL freeze — block on an
    // operator Off, NOT the frozen short-circuit (behavior-preserving with the other voice reads).
    if (!ctx.isFrozen() && ctx.effectiveCapabilityGateFor(null, "read_notes") === "Off") {
      return { kind: "ok", output: FORBID_CATCHUP };
    }

    const minutes = clampWindowMinutes(args.window_minutes);
    const now = Date.now();
    const since = now - minutes * MS_PER_MINUTE;

    // Fire the SAME away-digest composer over the [since, now] window (fires the shipped path, does not
    // rebuild curation). Absent on REST/test paths => null => the graceful "nothing notable" line.
    const compose = (ctx as CatchMeUpContext).composeAwayDigest;
    const digest = compose ? compose(since, now) : null;

    // Fire the existing cortex "catch-up" injection fire-and-forget. injectMemoryBrief("catch_me_up")
    // maps to the cortex wire trigger "catch-up" (toCortexTrigger) and owns its own try/catch; the guard
    // here defends against any synchronous throw so a memory-daemon failure NEVER breaks the digest.
    try {
      ctx.injectMemoryBrief?.("catch_me_up");
    } catch {
      /* fail-open on the cortex leg — the spoken digest is the contract, the injection is best-effort */
    }

    const spoken =
      digest ?? `Nothing notable in the last ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    // Redaction pass before the string leaves the process (composeAwayDigest clauses are pane-id/count
    // strings today, but the redact is unconditional so no future raw text can ever escape unredacted).
    return { kind: "ok", output: ctx.redact(spoken) };
  },
};

/** The catch-up group's canonical def slice (integrator spreads this into REGISTRY). */
export const CATCHUP_ACTIONS: ActionDef[] = [catchMeUp];
