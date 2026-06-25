// src/classic/components/ApprovalQueue.tsx — the classic ApprovalDialog queue, extracted VERBATIM
// out of src/App.tsx (App.tsx decomposition, chunk-5 "modal-queues + AppHeader", section 1). Was the
// inline `pendingCommands.map(pending => <ApprovalDialog key={pending.messageId} ... />)` inside the
// modal-cluster IIFE. DOM is byte-identical. ApprovalDialog stays a module import (./ApprovalDialog,
// the existing component). onApprove/onReject are the SAME handler refs from useApprovalsQueue,
// passed straight through unchanged. key={pending.messageId} + every prop spread are byte-identical.

import * as React from "react";
import { PendingCommand } from "../../types";
import { ApprovalDialog } from "../../components/ApprovalDialog";

export function ApprovalQueue({
  pendingCommands,
  onApprove,
  onReject,
}: {
  pendingCommands: PendingCommand[];
  onApprove: (messageId: string) => void | Promise<void>;
  onReject: (messageId: string) => void | Promise<void>;
}) {
  return (
    <>
      {pendingCommands.map((pending) => (
        <ApprovalDialog
          key={pending.messageId}
          messageId={pending.messageId}
          terminalId={pending.terminalId}
          cmd={pending.cmd}
          rationale={pending.rationale as { trigger: string; summary: string } | undefined}
          posture={pending.posture}
          effectiveGates={pending.effective_gates}
          effectiveMode={pending.effective_mode}
          capability={pending.capability}
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}
    </>
  );
}
