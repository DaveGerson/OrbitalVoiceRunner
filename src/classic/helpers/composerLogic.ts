// src/classic/helpers/composerLogic.ts — pure, browser-API-free decision helper for the prompt-buffer
// composer hook (useComposer). Extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition,
// mirroring the src/classic/helpers/historyLogic.ts / src/hooks/liveSessionLogic.ts gold-standard
// seam). The REST/WS I/O and the React state live in the hook; this module pins the ONE pure piece —
// the decision the former `handlePromptBufferChange` made inline about whether to push a draft edit
// over the live socket or fall back to a REST PUT.
//
// Behavior is VERBATIM from the original App.tsx body: the WS branch was taken iff
//   wsRef.current && wsRef.current.readyState === WebSocket.OPEN
// so the predicate here returns true on exactly that conjunction (and the hook then sends over WS;
// otherwise it fires the REST PUT). See tests/test_composer_logic.ts.

/**
 * Whether a draft edit should be pushed over the live WebSocket (vs. the REST-PUT fallback), given
 * the current socket. Pure: the caller passes the socket in; a null/non-OPEN socket → REST fallback.
 * `OPEN` is passed explicitly so this stays free of the DOM `WebSocket` global (Node test-runnable).
 */
export function shouldSendDraftOverWs(
  ws: { readyState: number } | null,
  openState: number,
): boolean {
  return !!ws && ws.readyState === openState;
}

// ── Phase 3, Step 3.3: instruction-envelope exchange draft — pure derivations ───────────────────
//
// The Workbench/Kitchen UI surfaces a pane's open InstructionEnvelope draft (src/types.ts's
// ExchangeDraftView, mirrored from src/exchanges/draftRegistry.ts's viewOpenDraft). These two pure
// functions are the ONLY non-trivial decisions that view needs, extracted here (rather than inlined
// in the component) so they're node:test-pinned like the rest of this module — see
// tests/test_composer_logic.ts.

/**
 * "none"    — this draft has never been sent (no version recorded as delivered).
 * "pending" — the CURRENT draft_version is parked as a pending operator approval: it left for the
 *             gate but has NOT been written to the pane (step 3.5 — before this state existed the
 *             chip claimed "delivered" for an undelivered staged approval).
 * "sent"    — the CURRENT draft_version is the one most recently delivered — nothing has changed
 *             since; what's on screen is what the pane received.
 * "stale"   — a delivery happened, but the draft has since been revised (draft_version has moved
 *             past the last delivered version) — what's on screen is NOT what the pane received.
 */
export type ExchangeApprovalState = "none" | "pending" | "sent" | "stale";

/**
 * Derives the approval/delivery state from `draftVersion` + the exchange machinery's own
 * `sentVersions` and `pendingApprovalVersion` (spec docs/superpowers/specs/
 * 2026-07-09-instruction-routing.md §5.3; both stamped server-side by the voice
 * `send_instruction` verb — src/exchanges/draftRegistry.ts). The pending check runs FIRST: a
 * version awaiting approval is in `sentVersions` too (the idempotency key), but calling it
 * "delivered" would be a lie. `optimisticDeliveredVersion` is the client-local "I clicked Send and
 * the server accepted it" latency bridge for the REST Workbench lane (which since step 3.5 closes
 * the exchange server-side — the marker only covers the broadcast round-trip window, and because
 * the REST lane sends the SERVER's current draft text, marking an older client-known version can
 * only ever under-claim, never mask a real mismatch). Pure: no clocks, no I/O.
 */
export function deriveExchangeApprovalState(
  draftVersion: number,
  sentVersions: readonly number[],
  optimisticDeliveredVersion?: number | null,
  pendingApprovalVersion?: number | null,
): ExchangeApprovalState {
  if (pendingApprovalVersion != null && pendingApprovalVersion === draftVersion) return "pending";
  const lastDelivered = Math.max(-1, ...sentVersions, optimisticDeliveredVersion ?? -1);
  if (lastDelivered < 0) return "none";
  return lastDelivered >= draftVersion ? "sent" : "stale";
}

/** A one-line, screen-reader-friendly summary of an ExchangeReadiness result (src/types.ts), for
 *  the Workbench panel's aria-live status text and title attributes. */
export function exchangeReadinessSummary(
  readiness: { ready: true } | { ready: false; missing: "target" | "objective"; clarification: string },
): string {
  // NOTE: `readiness.ready === false` (not `!readiness.ready`) — mirrors src/actions/defs/
  // voice_ux.ts's sendInstruction note on the exact same pattern: TS's narrowing on a negated
  // boolean-discriminant does not reliably exclude the `{ ready: true }` union member.
  if (readiness.ready === false) return `Not ready — ${readiness.clarification}`;
  return "Ready to send";
}

/**
 * Whether the right-rail "Sync Spec" header should show its draft-pending pulse dot
 * (sync-spec-draft-badge): true iff the active-pane buffer holds non-whitespace text OR any pane
 * has a staged WIP draft. Pure mirror of the composer-send enable gate (.trim()).
 *
 * NOTE (load-bearing): this predicate INTENTIONALLY differs from the legacy mobile-nav dot, which
 * gates on raw promptBuffer.length and ignores wipDrafts. Do not "unify" the two — they pin
 * different surfaces (this one is asserted by e2e/draft_badge.spec.ts).
 */
export function computeDraftPending(
  promptBuffer: string,
  wipDrafts: { length: number },
): boolean {
  return promptBuffer.trim().length > 0 || wipDrafts.length > 0;
}
