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

// ──────────────────────────────────────────────────────────────────────────
// Raw SQLite ROW shapes (bead dbt-typing). better-sqlite3 returns the on-disk
// representation verbatim: an `INTEGER` boolean column comes back as 0|1 (NOT
// a JS boolean) and a JSON-encoded `TEXT` column comes back as the raw string.
// These row interfaces type the `.all()/.get()` reads so the hydrators below
// (hydratePane / hydrateHandoff and their peers in sqliteStore.ts) replace the
// blanket `as any` casts with a precise Row -> Stored mapping. They mirror the
// CREATE TABLE definitions in src/store/schema.ts column-for-column.
// ──────────────────────────────────────────────────────────────────────────

/** A SQLite-stored boolean: 0 (false) or 1 (true). Hydrators coerce to a real boolean. */
export type SqlBool = 0 | 1;

/** Raw `panes` row (booleans as 0|1; draft/context/gates are JSON TEXT or null). */
export interface PaneRow {
  pane_id: string; workspace_id: string; name: string; runtime_type: string;
  tool_preset: string; permissions_mode: string; session_id: string;
  last_known_state: string; is_busy: SqlBool; alive: SqlBool; context_size: number;
  last_status_change_at: string | null; last_command: string | null;
  scrollback_path: string | null; created_at: number; updated_at: number;
  capability_gates?: string | null;
  draft?: string | null; model_context?: string | null; human_context?: string | null;
}
/** Raw `panes_archive` row — a PaneRow plus the archive twins. */
export interface ArchivedPaneRow extends PaneRow {
  archived_at: number; archive_reason: string | null;
}
/** Raw `projects` row (key_terms is a JSON TEXT array). */
export interface ProjectRow {
  id: string; name: string; directory: string; summary: string;
  key_terms: string; created_at: number; updated_at: number;
}
/** Raw `notes` row (1:1 with StoredNote; no coercion needed). */
export type NoteRow = StoredNote;
/** Raw `pending_approvals` row (claimed as 0|1). */
export interface PendingApprovalRow {
  id: string; session_id: string; workspace_id: string; pane_id: string;
  command: string; kind: string; rationale: string | null;
  claimed: SqlBool; timestamp: number; expires_at: number;
}
/** Raw `pending_actions` row (claimed as 0|1). */
export interface PendingActionRow {
  id: string; capability: string; summary: string; params: string;
  claimed: SqlBool; timestamp: number; expires_at: number;
}
/** Raw `attention` row (dismissed as 0|1; details is JSON TEXT or null). */
export interface AttentionRow {
  id: string; type: string; terminal_id: string; project_id: string;
  message: string; timestamp: number; dismissed: SqlBool; details: string | null;
}
/** Raw `handoffs` row. Booleans are absent (none in the table); timestamps may be null. */
export type HandoffRow = StoredHandoff;
/** A single-column `value` read (settings_kv / kv). */
export interface ValueRow { value: string }
/** A `SELECT COUNT(*) AS n` scalar read. */
export interface CountRow { n: number }
/** A bare project-id projection (`SELECT id FROM projects`). */
export interface IdRow { id: string }
/** An FTS search hit (`id`, `snippet`, `rank`) — id may arrive as a number from the rowid join. */
export interface SearchHitRow { id: string | number; snippet: string; rank: number }
/** Raw `cortex_decision` row (schema v9, B-3 spine). `applied` is a SQLite boolean (0|1). */
export interface CortexDecisionRow {
  id: number; ts: number; inject_id: string | null; session_id: string | null;
  active_pane_id: string | null; trigger: string | null; rule_fired: string | null;
  applied: SqlBool; trace_json: string;
}
/** Raw `gemini_turn_usage` row (schema v9, B-3 spine). Token counts are nullable (field absent ⇒ null). */
export interface GeminiTurnUsageRow {
  id: number; ts: number; session_id: string | null; inject_id: string | null;
  prompt_tokens: number | null; response_tokens: number | null; total_tokens: number | null;
}
