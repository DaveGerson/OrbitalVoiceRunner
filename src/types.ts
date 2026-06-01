import type { AnnouncementTemplates } from "./announcementKinds";

// ─────────────────────────────────────────────────────────────────────────────
// Capability Gate Matrix (design §3/§7). A capability can only TIGHTEN, never
// loosen, the pane's effectiveMode (AND-veto). Absent matrix ⇒ all "Auto"
// (back-compat: today's implicit behavior).
// ─────────────────────────────────────────────────────────────────────────────
export type CapabilityGate =
  | "write_to_pane" | "deliver_handoff" | "create_pane" | "close_pane"
  | "restart_pane" | "set_pane_permissions" | "set_global_permissions"
  | "set_capability_gate" | "add_watch_rule" | "execute_plan"
  | "apply_recipe" | "create_project" | "update_metadata"
  | "switch_context" | "set_voice_mute" | "dismiss_attention";

export type GateValue = "Auto" | "Ask" | "Off";

export type CapabilityGateMap = Partial<Record<CapabilityGate, GateValue>>;

// ─────────────────────────────────────────────────────────────────────────────
// Handoff artifact (design §4). A first-class, persisted artifact whose only
// gated transition is staged → delivered (rides deliver_handoff → write_to_pane).
// `composed_prompt` is delivered VERBATIM/unredacted; `source_context` IS redacted.
// ─────────────────────────────────────────────────────────────────────────────
export type HandoffState =
  | "composing" | "revising" | "staged" | "delivered" | "consumed"
  | "rejected" | "expired" | "blocked_read_only";

export type HandoffKind = "agent_instruction" | "shell";

export interface Handoff {
  id: string;
  workspace_id: string;
  from_pane: string | null;        // NULLABLE: source may be archived/gone
  to_pane: string;
  kind: HandoffKind;
  composed_prompt: string;         // cargo; NOT redacted
  source_context: string;          // JSON snapshot, redactSecrets-applied
  source_context_refs: string;     // JSON provenance pointers (advisory)
  state: HandoffState;
  gate_approval_id: string | null; // == PendingApproval.messageId while pending
  approved_by: string | null;
  approved_via: string | null;     // voice|rest|full_auto|ttl_expire
  revision_count: number;
  created_at: number;
  staged_at: number | null;
  delivered_at: number | null;
  consumed_at: number | null;
  terminal_at: number | null;
  expires_at: number | null;
}

export interface Terminal {
  id: string;
  cwd: string;
  command: string;
  output: string;
  status: "Running" | "Exited" | "Idle";
  permissions_mode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  tool_preset?: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  session_id?: string;
  context_size?: number;
}

export interface PendingCommand {
  messageId: string;
  cmd: string;
  terminalId: string;
  rationale?: {
    trigger?: string;
    summary: string;
  };
}

// Single source of truth for the ledger pane/workspace shapes (D7). These live
// here (frontend-safe, no `fs`) and are re-exported from ./ledger.ts so the
// browser App and the server ledger share one definition. The WS-C
// status-detection fields are OPTIONAL so existing persisted ledgers load
// unchanged.
// A single orientation-context entry. Context is the substrate the conversational
// composer reads to understand a pane; writing it is never gated (it is not a CLI
// write). See docs/refactor/PROMPT_COMPOSER_ARCHITECTURE.md §4.
export interface ContextEntry {
  text: string;
  at: string;       // ISO timestamp
  source?: string;  // optional free-form origin tag (e.g. "handoff", "synthesizer")
}

// A per-pane work-in-progress draft prompt (prompt-composer refactor, step 6 — the Workbench).
// Each pane keeps its OWN draft, persisted, so switching panes never loses the prompt you were
// composing with Janus for another pane. `updatedBy` lets the WIP register show who last touched it.
export interface PaneDraft {
  text: string;
  updatedAt: string;                  // ISO timestamp
  updatedBy?: "janus" | "operator";
}

export interface PaneMeta {
  pane_id: string;
  name: string;
  runtime_type: string;
  last_known_state: string;
  is_busy: boolean;
  alive: boolean;
  // Legacy flat note bucket. Retained for back-compat with persisted ledgers and
  // existing readers; new writes go to the layered context below.
  notes: string[];
  // Layered per-terminal context (prompt-composer refactor §4). Optional so older
  // persisted ledgers load unchanged.
  modelContext?: ContextEntry[];  // machine-maintained orientation (Janus / synthesizer)
  humanContext?: ContextEntry[];  // operator-typed steering; authoritative when present
  // Per-pane WIP draft prompt (step 6). Optional so older persisted ledgers load unchanged.
  draft?: PaneDraft;
  permissions_mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  session_id: string;
  tool_preset: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  context_size: number;
  // WS-C status-detection additions (design §4.1).
  last_status_change_at?: string;   // ISO timestamp of last Running/Idle/Exited transition
  last_command?: string;            // most recent command written via writeInput
  elapsed_ms?: number;              // derived at read time: now - last_status_change_at
  // Per-pane capability-gate override (design §3). Absent ⇒ falls through to global ⇒ "Auto".
  capabilityGates?: CapabilityGateMap;
}

export interface Workspace {
  id: string;
  name: string;
  directory: string;
  summary: string;
  notes: string[];
  panes: Record<string, PaneMeta>;
  keyTerms?: string[];
}

export interface CliPreset {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
  permissionsMode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  windowMode?: "Standard Split-Pane" | "Side Dock Panel" | "Overlay Modal Console" | "Background Agent Thread";
  visualTheme?: "Default Green Mono" | "Cosmic Slate" | "Crimson Warning" | "Royal Purple" | "Amber Slop-Shield";
  persistentRestore?: boolean;
  dangerouslySkipPermissions?: boolean;
  sessionResume?: boolean;
  portOffset?: string;
  customEnvVars?: string;
  // Template-level capability-gate defaults applied to panes spawned from this preset.
  capabilityGates?: CapabilityGateMap;
}

export interface SystemSettings {
  server: {
    port: number;
    host: string;
    appUrl: string;
  };
  voiceAi: {
    voice: string;
    voiceStyle: "Direct" | "Creative" | "Concise" | "Explanatory";
    volume: number;
    speechSpeed: number;
    isMicMuted: boolean;
    model: string;
  };
  projects: {
    activeContext: string;
    localWorkspacePath: string;
  };
  presets: CliPreset[];
  // WS-D: operator-editable proactive-announcement message templates. `{pane}` and
  // `{summary}` are interpolated. Defaults are brief (see DEFAULT_ANNOUNCEMENT_TEMPLATES).
  announcements?: AnnouncementTemplates;
  advanced: {
    webSocketUrl: string;
    latencyMode: "Low Latency" | "High Throughput" | "Balanced";
    throughputBps: number;
    audioBufferSize: number;
    debugLogging: boolean;
    connectionTimeoutMs: number;
    rateLimitRequestsPerMin: number;
    maxBufferLines: number;
    idleTimeoutMs: number;
    defaultShellCommand: string;
    globalPermissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";
    historyMaxCommands?: number;
    historyMaxOutputLength?: number;
    // Global default capability-gate matrix (design §3/§7). Absent/empty ⇒ all "Auto".
    capabilityGates?: CapabilityGateMap;
  };
  secrets: {
    geminiApiKey: string;
  };
}

export interface AttentionItem {
  id: string;
  type: "approval" | "exited" | "error" | "build-failed" | "confirmation";
  terminalId: string;
  projectId: string;
  message: string;
  timestamp: string;
  dismissed: boolean;
  details?: any;
}

export interface WatchRule {
  id: string;
  triggerTerminalId: string;
  triggerTransition: "idle" | "prompt" | "error" | "build-failed" | "exited";
  actionTerminalId: string;
  actionCommand: string;
  enabled: boolean;
  oneShot: boolean;
}

export interface PlanStep {
  id: string;
  terminalId: string;
  command: string;
  expectedTransition: "idle" | "prompt";
  status: "pending" | "running" | "completed" | "failed";
}

export interface Plan {
  id: string;
  name: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: "idle" | "running" | "paused" | "completed";
}

export interface TemplateRecipe {
  id: string;
  name: string;
  description: string;
  panes: {
    id: string;
    name: string;
    command: string;
    preset: "Claude Code" | "Codex" | "Antigravity" | "Custom";
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  }[];
}


