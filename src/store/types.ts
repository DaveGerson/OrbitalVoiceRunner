// src/store/types.ts
export type PermissionsMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";
export type ToolPreset = "Claude Code" | "Codex" | "Antigravity" | "Custom";
export type PaneStatus = "Running" | "Idle" | "Exited";
export type NoteType = "decision" | "todo" | "warning" | "note" | "handoff";
export type ApprovalKind = "agent_instruction" | "shell";

export interface StoredWorkspace {
  id: string; name: string; directory: string; summary: string;
  key_terms: string[]; created_at: number; updated_at: number;
}
export interface StoredPane {
  pane_id: string; workspace_id: string; name: string; runtime_type: string;
  tool_preset: ToolPreset; permissions_mode: PermissionsMode; session_id: string;
  last_known_state: PaneStatus; is_busy: boolean; alive: boolean; context_size: number;
  last_status_change_at: string | null; last_command: string | null;
  scrollback_path: string | null; created_at: number; updated_at: number;
  // bead 8sq (schema v4): JSON-encoded per-pane CapabilityGateMap override, or null (no override).
  capability_gates?: string | null;
}
export interface StoredArchivedPane extends StoredPane { archived_at: number; archive_reason: string | null; }
export interface StoredNote {
  id: string; project_id: string; pane_id: string | null; text: string;
  type: NoteType; author: "janus" | "user"; created_at: number; updated_at: number;
}
export interface StoredPendingApproval {
  id: string; session_id: string; workspace_id: string; pane_id: string;
  command: string; kind: ApprovalKind; rationale: string | null;
  claimed: boolean; timestamp: number; expires_at: number;
}
/**
 * Row shape for the pending_actions table (schema v5, bead wsm-e2e-pinned-kzt). A deferred Ask-tier
 * non-PTY mutator persisted as its serializable INTENT (capability + JSON params) so the side effect
 * can be rebuilt on boot via src/actionEffects.ts (the run() closure itself is non-serializable).
 */
export interface StoredPendingAction {
  id: string;
  capability: string;
  summary: string;
  params: string;        // JSON-encoded intent params (capability-specific)
  claimed: boolean;
  timestamp: number;
  expires_at: number;    // timestamp + ttlMs (parity with pending_approvals; drives boot/sweep prune)
}
export interface StoredAttention {
  id: string; type: string; terminal_id: string; project_id: string;
  message: string; timestamp: number; dismissed: boolean; details: any;
}

export type HandoffState =
  | "composing" | "revising" | "staged" | "delivered" | "consumed"
  | "rejected" | "expired" | "blocked_read_only";

/** Row shape for the handoffs table (schema v2, design §5.1). */
export interface StoredHandoff {
  id: string;
  workspace_id: string;
  from_pane: string | null;
  to_pane: string;
  kind: ApprovalKind;
  composed_prompt: string;
  source_context: string;          // JSON string (redactSecrets-applied), stored verbatim
  source_context_refs: string;     // JSON string
  state: HandoffState;
  gate_approval_id: string | null;
  approved_by: string | null;
  approved_via: string | null;
  revision_count: number;
  created_at: number;
  staged_at: number | null;
  delivered_at: number | null;
  consumed_at: number | null;
  terminal_at: number | null;
  expires_at: number | null;
}
