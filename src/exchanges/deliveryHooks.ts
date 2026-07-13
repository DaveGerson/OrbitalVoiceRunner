// src/exchanges/deliveryHooks.ts
//
// AgentExchange spine — the shared two-phase delivery hooks (spec §2b) that used to be triplicated
// verbatim across src/gating/index.ts (the approved-write path), src/dispatch/paneWrite.ts (the
// auto_execute path), and server.ts (the Workbench direct-send path). Each call site's own copy was
// byte-identical in spirit: `exchangeSpineActive() && exchangeId` guard, a try/catch that swallows
// and logs (spec §9.6 — a spine outage must never block or loosen the real write decision), and one
// of `stageForDelivery`+`beginDeliveryAttempt` / `completeDelivery` / `failDelivery`. This module is
// the ONE implementation; every call site now calls into it instead of re-declaring its own copy.
//
// `mintExchangeForSend` is the sibling dedupe for the OTHER thing that used to be duplicated: the
// "mint an exchange for a fresh send" core (src/voice/index.ts's `stampExchangeForDispatch` and
// server.ts's `stampExchangeForWorkbenchSend` both did `createExchange` + "serialize this pane's
// open envelope draft, if any, into `instructionEnvelopeJson`" by hand). Callers keep their own
// additional gating (voice's dispatch-time project resolution, the Workbench's
// `instructionEnvelopeIsPrimary()` check) — this only folds the shared core.

import { getExchangeService, exchangeSpineActive } from "./spine";
// No new flag-freeze hazard: draftRegistry (imported below) already transitively imports
// instructionEnvelope.ts, so its INSTRUCTION_ENVELOPE_MODE constant is frozen at the same point
// with or without this direct import.
import { instructionEnvelopeActive } from "./instructionEnvelope";
import { getOpenDraft, serializeDraftEnvelope } from "./draftRegistry";

/** Phase 1, Step 1.4 / Phase 3 Step 3.5: durable pre-write intent — legal only from `staged`,
 *  genuinely precedes the pane write. No-op (never throws) unless the flag is active AND
 *  `exchangeId` is set. `label` names the call site for the swallowed-error log line. */
export function beginExchangeDelivery(exchangeId: string | undefined, label: string): void {
  if (!exchangeSpineActive() || !exchangeId) return;
  try {
    const svc = getExchangeService();
    svc.stageForDelivery(exchangeId); // no-op (illegal transition) if already staged
    svc.beginDeliveryAttempt(exchangeId);
  } catch (e) {
    console.error(`[exchange-spine] ${label} failed:`, e);
  }
}

/** Phase 2 of the two-phase ordering: the write was ACCEPTED by a live PTY. No-op unless the flag
 *  is active AND `exchangeId` is set. */
export function completeExchangeDelivery(exchangeId: string | undefined, label: string): void {
  if (!exchangeSpineActive() || !exchangeId) return;
  try {
    getExchangeService().completeDelivery(exchangeId);
  } catch (e) {
    console.error(`[exchange-spine] ${label} failed:`, e);
  }
}

/** Certain-failure leg: the write did NOT land — re-arm to `draft` (a fresh approval, not a
 *  quarantine) instead of leaving the exchange stranded `staged`. No-op unless the flag is active
 *  AND `exchangeId` is set. */
export function failExchangeDelivery(exchangeId: string | undefined, reason: string, label: string): void {
  if (!exchangeSpineActive() || !exchangeId) return;
  try {
    getExchangeService().failDelivery(exchangeId, reason);
  } catch (e) {
    console.error(`[exchange-spine] ${label} failed:`, e);
  }
}

export interface MintExchangeForSendInput {
  projectId: string;
  paneId: string;
  operatorUtterance: string;
  distilledInstruction: string;
  /** Optional durable-mirror-only stamps (Phase 2 Step 2.2) — absent everywhere the caller has no
   *  value for them, unchanged from the store's own NULL defaults. */
  voiceSessionId?: string | null;
  interactionId?: string | null;
  contextVersion?: string | null;
}

/**
 * Shared "mint an exchange for a fresh send" core: `createExchange` plus — when the
 * instruction-envelope flag is active AND this pane has an OPEN envelope draft
 * (src/exchanges/draftRegistry.ts) — serializing it into `instructionEnvelopeJson` (the durable
 * source `rehydrateDraftRegistryOnBoot` reads back after a restart). The `instructionEnvelopeActive()`
 * gate is load-bearing, not redundant: the compose_draft voice actions (src/actions/defs/
 * voice_ux.ts) can register an open draft regardless of the envelope flag, so "flag off ⇒ registry
 * empty" does NOT hold — with the flag off the column must stay at its schema default (exactly what
 * the pre-consolidation voice lane's `draftEnvelopeJsonForDispatch` guaranteed). A pane with no
 * open draft (the plain, non-envelope dispatch case) likewise gets `undefined`. No-op (returns
 * `undefined`) unless the spine flag is active; never throws.
 */
export function mintExchangeForSend(input: MintExchangeForSendInput): string | undefined {
  if (!exchangeSpineActive()) return undefined;
  try {
    const openDraft = instructionEnvelopeActive() ? getOpenDraft(input.projectId, input.paneId) : undefined;
    return getExchangeService().createExchange({
      projectId: input.projectId,
      paneId: input.paneId,
      operatorUtterance: input.operatorUtterance,
      distilledInstruction: input.distilledInstruction,
      voiceSessionId: input.voiceSessionId ?? null,
      interactionId: input.interactionId ?? null,
      contextVersion: input.contextVersion ?? null,
      instructionEnvelopeJson: openDraft ? (serializeDraftEnvelope(openDraft) ?? undefined) : undefined,
    }).exchangeId;
  } catch (e) {
    console.error("[exchange-spine] mintExchangeForSend failed:", e);
    return undefined;
  }
}
