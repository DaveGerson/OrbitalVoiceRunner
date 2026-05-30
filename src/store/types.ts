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
export interface StoredAttention {
  id: string; type: string; terminal_id: string; project_id: string;
  message: string; timestamp: number; dismissed: boolean; details: any;
}
