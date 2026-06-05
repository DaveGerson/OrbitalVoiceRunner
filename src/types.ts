import type { AnnouncementTemplates } from "./announcementKinds";

// ─────────────────────────────────────────────────────────────────────────────
// Capability Gate Matrix (design §3/§7). A capability can only TIGHTEN, never
// loosen, the pane's effectiveMode (AND-veto). Absent matrix ⇒ all "Auto"
// (back-compat: today's implicit behavior).
// ─────────────────────────────────────────────────────────────────────────────
// F4 (wsm-e2e-pinned-lqb): the union is the WHOLE capability matrix (22 rows) — the 16 original
// gates PLUS the 6 promoted capabilities (read_pane / read_notes / focus_pane / compose_draft /
// archive_pane / clear_history). Promotions default to today's effective behavior (Auto, except
// clear_history=Ask) so widening the type is behavior-preserving. Kept in lockstep with
// CAPABILITY_DEFS (src/actions/capabilities.ts) — a test asserts ALL_CAPABILITIES === that id set.
export type CapabilityGate =
  | "write_to_pane" | "deliver_handoff" | "create_pane" | "close_pane"
  | "restart_pane" | "set_pane_permissions" | "set_global_permissions"
  | "set_capability_gate" | "add_watch_rule" | "execute_plan"
  | "apply_recipe" | "create_project" | "update_metadata"
  | "switch_context" | "set_voice_mute" | "dismiss_attention"
  // ── promoted capabilities (Decision 6/9) — surfaced as individually-tunable matrix rows ──
  | "read_pane" | "read_notes" | "focus_pane"
  | "compose_draft" | "archive_pane" | "clear_history";

export type GateValue = "Auto" | "Ask" | "Off";

export type CapabilityGateMap = Partial<Record<CapabilityGate, GateValue>>;

// The DEFAULT global matrix (design §7, director posture 2026-06-01: "friction is worse,
// gate by category"). This is the OFF-CONTEXT baseline — the gate that applies to a pane the
// director is NOT focused on. The context layer (effectiveCapabilityGateFor) loosens the
// ACTIVE pane's productive capabilities to Auto (the "spotlight"). Categories:
//   - Productive writes (write_to_pane, deliver_handoff): Ask off-context — a write the
//     director hasn't seen lands only with approval unless it's the focused pane.
//   - Destructive (close_pane, restart_pane): Ask — killing work deserves a checkpoint.
//   - Meta / changing-the-locks (set_pane_permissions, set_global_permissions,
//     set_capability_gate): Ask — the control surface never bends to in-the-moment looseness.
//   - Pane creation / plan / recipe (create_pane, execute_plan, apply_recipe, add_watch_rule):
//     Ask — spawning agents or autonomous rules costs compute/money.
//   - Low-risk orientation (switch_context, create_project, update_metadata, set_voice_mute,
//     dismiss_attention): Auto — pure velocity, no pane mutation of consequence.
// Anything omitted resolves to "Auto" via resolveCapabilityGate (back-compat).
export const DEFAULT_CAPABILITY_GATES: CapabilityGateMap = {
  write_to_pane: "Ask",
  deliver_handoff: "Ask",
  create_pane: "Ask",
  close_pane: "Ask",
  restart_pane: "Ask",
  set_pane_permissions: "Ask",
  set_global_permissions: "Ask",
  set_capability_gate: "Ask",
  add_watch_rule: "Ask",
  execute_plan: "Ask",
  apply_recipe: "Ask",
  create_project: "Auto",
  update_metadata: "Auto",
  switch_context: "Auto",
  set_voice_mute: "Auto",
  dismiss_attention: "Auto",
};

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
  /** ANSI-stripped recent output, used for the pane-card text previews. */
  output: string;
  /** Raw bytes (escape sequences intact) seeding xterm on (re)open. */
  backfill?: string;
  status: "Running" | "Exited" | "Idle";
  // Conservative Phase 2: an ADDITIVE overlay flag (not a status-union change, which would
  // ripple through statusMachine.ts + ~8 App.tsx arms + mocks). When true the pane is STILL
  // "Running" but has gone quiet inside the pre-idle debounce window — the UI renders a humble
  // "cooking…" label distinct from green "executing" and yellow "idle". Cleared when the pane
  // next reports Running or Idle. Optional so older payloads/mocks degrade gracefully.
  quiescing?: boolean;
  permissions_mode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  tool_preset?: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  session_id?: string;
  context_size?: number;
  // bead 8sq (spec §2.A / §5): SERVER-resolved effective posture. The chip + popover render from
  // these (server truth) — the client never re-derives policy. Optional so older payloads / mocks
  // that omit them degrade gracefully (no chip).
  effective_gates?: CapabilityGateMap;
  posture?: "OPEN" | "GUARDED" | "LOCKED";
}

export interface PendingCommand {
  messageId: string;
  cmd: string;
  terminalId: string;
  rationale?: {
    trigger?: string;
    summary: string;
  };
  // rbh (wsm-e2e-pinned-rbh): SERVER-resolved EFFECTIVE posture for the TARGET pane, so the
  // approve/reject dialog answers "into what posture am I approving this write?" with the same
  // truth the chip shows. All optional → older payloads / mocks degrade to today's dialog (D5).
  effective_gates?: CapabilityGateMap;
  posture?: "OPEN" | "GUARDED" | "LOCKED";
  effective_mode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  /** The write capability gating this approval (e.g. write_to_pane / deliver_handoff). */
  capability?: CapabilityGate;
}

/**
 * rbh (wsm-e2e-pinned-rbh): the pending-action view the ActionConfirmDialog renders. Carries the
 * SERVER-resolved EFFECTIVE posture the engine WILL apply (not the nominal summary string) so the
 * dialog can render an effective rider + a divergence "heads up" when nominal ≠ effective. All
 * posture fields optional → degrade-safe (D5). Replaces the inline shape at App.tsx.
 */
export interface PendingActionView {
  actionId: string;
  capability: string;
  summary: string;
  /** The effective gate for `capability` after override → spotlight → global resolution. */
  effective_gate?: GateValue;
  effective_mode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  posture?: "OPEN" | "GUARDED" | "LOCKED";
  effective_gates?: CapabilityGateMap;
  /** null for global actions (set_global_permissions has no pane scope — D2). */
  pane_id?: string | null;
  /** The mode the operator asked for (structural, never parsed from the summary — R5). */
  requested_mode?: string;
  /**
   * Whether the GLOBAL mode (≠ Inherit) genuinely dominates the requested per-pane mode. Distinguishes
   * a real global override (rider: "global mode is X, this pane stays …") from a staged-not-yet-applied
   * mode change under Inherit (which will take effect on confirm — no divergence). See concern-3 fix.
   */
  global_override?: boolean;
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
    // Conservative Phase 2: a separate, modestly LARGER silence-to-idle timeout for
    // interactive_cli (agent) panes. Agents are forced to the fallback/quiescence path
    // (terminal.ts) where quiet != done, so a brief mid-turn pause can read as a premature
    // "done". Bumping their effective idle window above a shell pane's reduces that without
    // any new done-detection heuristic. Optional + env/setting-overridable; defaults to 3500.
    // Shell panes keep idleTimeoutMs (no regression).
    agentIdleTimeoutMs?: number;
    defaultShellCommand: string;
    globalPermissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";
    historyMaxCommands?: number;
    historyMaxOutputLength?: number;
    // Global default capability-gate matrix (design §3/§7). Absent/empty ⇒ all "Auto".
    capabilityGates?: CapabilityGateMap;
    // Janus Memory Synthesis P0a (advanced, all optional/additive). Tune the in-process
    // anti-rot brief: total char budget (~4 chars/token), and the decaying breadcrumb ring's
    // cap + max age. Absent ⇒ DEFAULT_MEMORY_CONFIG (4800 / 12 / 900000ms). See src/memory/types.ts.
    memoryBudgetChars?: number;   // default 4800
    breadcrumbMax?: number;       // default 12
    breadcrumbMaxAgeMs?: number;  // default 900000
    // Janus Memory Synthesis P0b (advanced, optional/additive). The Python Context Synthesizer
    // is a STRICT UPGRADE, never a dependency — disabling it (or its absence) silently falls
    // back to the in-process deterministic assembler. See docs/.../p0b-design.md (D1/D3).
    memoryPythonEnabled?: boolean;   // default true — master switch for the Python synthesizer
    memorySynthTimeoutMs?: number;   // default 150 — per-call race deadline before fallback
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


