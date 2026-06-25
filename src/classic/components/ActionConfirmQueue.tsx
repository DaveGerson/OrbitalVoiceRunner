// src/classic/components/ActionConfirmQueue.tsx — the classic ActionConfirmDialog queue, extracted
// VERBATIM out of src/App.tsx (App.tsx decomposition, chunk-5 "modal-queues + AppHeader", section 2).
// Was the inline `pendingActions.map(action => <ActionConfirmDialog key={action.actionId} ... />)`
// inside the modal-cluster IIFE. DOM is byte-identical. ActionConfirmDialog stays a module import
// (../../components/ActionConfirmDialog, the existing component). onConfirm/onCancel are the SAME
// handler refs from useApprovalsQueue, passed straight through. key={action.actionId} + every prop
// spread are byte-identical.

import * as React from "react";
import { PendingActionView } from "../../types";
import { ActionConfirmDialog } from "../../components/ActionConfirmDialog";

export function ActionConfirmQueue({
  pendingActions,
  onConfirm,
  onCancel,
}: {
  pendingActions: PendingActionView[];
  onConfirm: (actionId: string) => void | Promise<void>;
  onCancel: (actionId: string) => void | Promise<void>;
}) {
  return (
    <>
      {pendingActions.map((action) => (
        <ActionConfirmDialog
          key={action.actionId}
          actionId={action.actionId}
          capability={action.capability}
          summary={action.summary}
          posture={action.posture}
          effectiveGate={action.effective_gate}
          effectiveMode={action.effective_mode}
          requestedMode={action.requested_mode}
          globalOverride={action.global_override}
          paneId={action.pane_id}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ))}
    </>
  );
}
