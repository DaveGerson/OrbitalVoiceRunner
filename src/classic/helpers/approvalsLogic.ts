// src/classic/helpers/approvalsLogic.ts — pure, browser-API-free list-update helpers for the
// gated-approval / deferred-action queue hook (useApprovalsQueue). Extracted out of src/App.tsx
// (bead dbt4 — App.tsx decomposition, mirroring the src/classic/helpers/historyLogic.ts /
// src/classic/helpers/composerLogic.ts gold-standard seam). The REST POST + WS I/O and the React
// state live in the hook; this module pins the optimistic-update DECISIONS the four handlers ran
// inline — the exact "drop the just-resolved item from the queue" filters.
//
// Behavior is VERBATIM from the original App.tsx body:
//   handleApprove / handleReject : prev.filter(item => item.messageId !== messageId)
//   handleConfirmAction / handleCancelAction : prev.filter(a => a.actionId !== actionId)
// so these helpers return exactly those filtered lists. See tests/test_approvals_logic.ts.

/**
 * Drop the approval whose messageId matches (the optimistic remove handleApprove/handleReject ran).
 * Pure: returns a new array; never mutates `list`. A no-match id leaves the list unchanged.
 */
export function removeByMessageId<T extends { messageId: string }>(list: T[], messageId: string): T[] {
  return list.filter((item) => item.messageId !== messageId);
}

/**
 * Drop the deferred action whose actionId matches (the optimistic remove handleConfirmAction/
 * handleCancelAction ran). Pure: returns a new array; never mutates `list`.
 */
export function removeByActionId<T extends { actionId: string }>(list: T[], actionId: string): T[] {
  return list.filter((a) => a.actionId !== actionId);
}
