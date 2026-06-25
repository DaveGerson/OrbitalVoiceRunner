// src/classic/hooks/useApprovalsQueue.ts — the gated-approval / deferred-action queue layer, extracted
// VERBATIM out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, mirroring the gold-standard
// src/hooks/useLiveSession.ts / src/classic/hooks/useComposer.ts seam: params-interface in,
// returns-interface out, the pure list-update decisions split into the node:test-pinned
// src/classic/helpers/approvalsLogic.ts sibling).
//
// Owns:
//   * pendingCommands — the queue of gated PTY-write approvals (drives the ApprovalDialog list).
//   * pendingActions — the queue of gated non-PTY deferred actions (drives the ActionConfirmDialog).
//   * fetchPendingCommands() — GET the pending-approval queue (no-op under mock mode).
//   * handleApprove(messageId) / handleReject(messageId) — optimistically drop the approval, then POST
//     the approve/reject (the mock branch mutates the seeded terminal output for the e2e).
//   * handleConfirmAction(actionId) / handleCancelAction(actionId) — optimistically drop the deferred
//     action, then POST confirm/cancel (the server runs the staged side effect exactly once on confirm).
//
// *** HARNESS COUPLING (load-bearing) ***: setPendingCommands AND setPendingActions are BOTH wired into
// the e2e harness (E2EHarnessDeps.setPendingCommands at src/e2e/harness.ts:161 / setPendingActions:162,
// driven by injectPendingApproval / injectPendingAction used by approval.spec + action.spec). This hook
// RETURNS both setters and App threads those exact identities back into the useE2EHarness deps object —
// mirroring how useStdoutStream preserved queueStdoutChunk and useComposer preserved setWipDrafts.
//
// Seam: the handlers perform REST POST I/O + a mock-mode terminal mutation, so the caller (App) supplies
// isMockModeRef (the client-only mock gate), setTerminals (the optimistic mock output mutation), and
// fetchTerminals (the post-resolve refresh). The WS router that PUSHES into these queues stays in App
// and writes through the returned setters (identity preserved).
//
// Behavior is byte-identical to the former App body: same mock/real branches, same optimistic filters,
// same setTimeout(fetchTerminals, 500) refresh cadence, same handler ORDERING. No observable change —
// the e2e classic net (approval.spec / action.spec) is the integration witness.

import type * as React from "react";
import { useState, type Dispatch, type SetStateAction } from "react";
import type { Terminal, PendingCommand, PendingActionView } from "../../types";
import { apiFetch } from "../../utils/api";
import { removeByMessageId, removeByActionId } from "../helpers/approvalsLogic";

export interface ApprovalsQueueParams {
  /** Client-only mock gate (App-owned). When true the handlers short-circuit the real REST POSTs. */
  isMockModeRef: React.MutableRefObject<boolean>;
  /** App-owned terminal setter — handleApprove's mock branch mutates the seeded pane output. */
  setTerminals: Dispatch<SetStateAction<Terminal[]>>;
  /** App-owned refresh — re-pulls terminals 500ms after an approve/confirm resolves. */
  fetchTerminals: () => void;
}

/**
 * The hook's return shape, kept as documentation of the seam (mirrors the useLiveSession/useComposer
 * `interface`s). NOTE: it is deliberately NOT used as an explicit `: ApprovalsQueue` return annotation
 * on the hook below — see the comment on useApprovalsQueue. The pendingCommands element type
 * (PendingCommand, whose rationale.trigger is OPTIONAL) is byte-identical to the former inline
 * `useState<PendingCommand[]>`; the type is documented here for readers, not enforced at the boundary.
 */
export interface ApprovalsQueue {
  pendingCommands: PendingCommand[];
  /** Returned for the e2e harness (injectPendingApproval) — App threads this identity into useE2EHarness. */
  setPendingCommands: Dispatch<SetStateAction<PendingCommand[]>>;
  pendingActions: PendingActionView[];
  /** Returned for the e2e harness (injectPendingAction) — App threads this identity into useE2EHarness. */
  setPendingActions: Dispatch<SetStateAction<PendingActionView[]>>;
  fetchPendingCommands: () => Promise<void>;
  handleApprove: (messageId: string) => Promise<void>;
  handleReject: (messageId: string) => Promise<void>;
  handleConfirmAction: (actionId: string) => Promise<void>;
  handleCancelAction: (actionId: string) => Promise<void>;
}

// dbt4 — IMPORTANT: the return type is INFERRED (no explicit `: ApprovalsQueue`), on purpose. The
// former state lived inline as `useState<PendingCommand[]>` in App, and the ApprovalDialog `rationale`
// prop types `trigger` as REQUIRED while `PendingCommand.rationale.trigger` is OPTIONAL. Under this
// tsconfig (no `strict`/`strictNullChecks`) the inline-`useState` type flowed to the JSX boundary
// without tripping the optional→required structural check, so the codebase relied on that. Pinning the
// return to the explicit `ApprovalsQueue` interface materializes a stricter `PendingCommand[]` that
// DOES trip TS2322 at `rationale={pending.rationale}` (App.tsx). Letting the return type infer from
// the same `useState` reproduces the original behavior byte-for-byte with ZERO change to ApprovalDialog
// or any consumer. The `ApprovalsQueue` interface above documents the shape for readers regardless.
export function useApprovalsQueue(params: ApprovalsQueueParams) {
  const { isMockModeRef, setTerminals, fetchTerminals } = params;

  const [pendingCommands, setPendingCommands] = useState<PendingCommand[]>([]);
  // G1: gated non-PTY deferred actions (create_pane / set_*_permissions on the Ask tier).
  // rbh: PendingActionView carries the SERVER-resolved EFFECTIVE posture so the confirm dialog can
  // render the effective rider + a divergence "heads up" when nominal ≠ effective (degrade-safe).
  const [pendingActions, setPendingActions] = useState<PendingActionView[]>([]);

  const fetchPendingCommands = async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/commands/pending");
      if (!res.ok) return;
      const data = await res.json();
      setPendingCommands(data);
    } catch (e) {}
  };

  const handleApprove = async (messageId: string) => {
    if (isMockModeRef.current) {
      const pendingCmd = pendingCommands.find(p => p.messageId === messageId);
      setPendingCommands(prev => removeByMessageId(prev, messageId));
      if (pendingCmd) {
        setTerminals(prev => prev.map(t => {
          if (t.id === pendingCmd.terminalId) {
            return {
              ...t,
              status: "Running",
              command: pendingCmd.cmd,
              output: t.output + `\n\n> ${pendingCmd.cmd}\n` + (pendingCmd.cmd.includes("tailwindcss") ? "added 1 package, and audited 2 packages in 3s" : "Successfully installed pandas 2.1.0\nDONE"),
            };
          }
          return t;
        }));
      }
      return;
    }
    try {
      await apiFetch("/api/commands/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, approved: true })
      });
      setPendingCommands(prev => removeByMessageId(prev, messageId));
      setTimeout(fetchTerminals, 500);
    } catch (e) {}
  };

  const handleReject = async (messageId: string) => {
    if (isMockModeRef.current) {
      setPendingCommands(prev => removeByMessageId(prev, messageId));
      return;
    }
    try {
      await apiFetch("/api/commands/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, approved: false })
      });
      setPendingCommands(prev => removeByMessageId(prev, messageId));
    } catch (e) {}
  };

  // G1: confirm/cancel a gated non-PTY deferred action. Optimistically drop from the UI; the
  // server runs the staged side effect exactly once on confirm (no-ops on a lost race).
  const handleConfirmAction = async (actionId: string) => {
    setPendingActions(prev => removeByActionId(prev, actionId));
    if (isMockModeRef.current) return;
    try {
      await apiFetch(`/api/actions/${actionId}/confirm`, { method: "POST" });
      setTimeout(fetchTerminals, 500);
    } catch (e) {}
  };

  const handleCancelAction = async (actionId: string) => {
    setPendingActions(prev => removeByActionId(prev, actionId));
    if (isMockModeRef.current) return;
    try {
      await apiFetch(`/api/actions/${actionId}/cancel`, { method: "POST" });
    } catch (e) {}
  };

  return {
    pendingCommands,
    setPendingCommands,
    pendingActions,
    setPendingActions,
    fetchPendingCommands,
    handleApprove,
    handleReject,
    handleConfirmAction,
    handleCancelAction,
  };
}
