import type { AnnouncementTemplates } from "./announcementKinds";

// ─────────────────────────────────────────────────────────────────────────────
// Capability Gate Matrix (design §3/§7). A capability can only TIGHTEN, never
// loosen, the pane's effectiveMode (AND-veto). Absent matrix ⇒ all "Auto"
// (back-compat: today's implicit behavior).
// ─────────────────────────────────────────────────────────────────────────────
// F4 (wsm-e2e-pinned-lqb): the union is the WHOLE capability matrix (27 rows) — the 16 original
// gates PLUS the 6 promoted capabilities (read_pane / read_notes / focus_pane / compose_draft /
// archive_pane / clear_history) PLUS the 2 destructive deletes (delete_pane / delete_project) PLUS
// the 3 c55.10 tightened rest-write caps (send_keys / remove_watch_rule / delete_orchestrator_plan).
// Promotions default to today's effective behavior (Auto, except clear_history=Ask) so widening the
// type is behavior-preserving; the c55.10 caps default Ask (gate-tightening, strictly more
// restrictive). Kept in lockstep with CAPABILITY_DEFS (src/actions/capabilities.ts) — a test asserts
// ALL_CAPABILITIES === that id set.
export type CapabilityGate =
  | "write_to_pane" | "deliver_handoff" | "create_pane" | "close_pane"
  | "delete_pane" | "delete_project"
  | "restart_pane" | "set_pane_permissions" | "set_global_permissions"
  | "set_capability_gate" | "add_watch_rule" | "execute_plan"
  | "apply_recipe" | "create_project" | "update_metadata"
  | "switch_context" | "set_voice_mute" | "dismiss_attention"
  // ── promoted capabilities (Decision 6/9) — surfaced as individually-tunable matrix rows ──
  | "read_pane" | "read_notes" | "focus_pane"
  | "compose_draft" | "archive_pane" | "clear_history"
  // ── c55.10: rest-only writes tightened from ALWAYS_ALLOWED → Ask (send_keys is the raw-PTY
  //    keystroke twin of write_to_pane; remove_watch_rule mirrors add_watch_rule; delete_orchestrator_plan
  //    is destructive) ──
  | "send_keys" | "remove_watch_rule" | "delete_orchestrator_plan";

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
  delete_pane: "Ask",
  delete_project: "Ask",
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
  // 2S.1: CAPABILITY_DEFS declares clear_history defaultGate "Ask" (destructive: wipes a pane's
  // recorded history) but the default map omitted it, so it resolved through the permissive
  // fallback to Auto. Pin it here so map and matrix agree.
  clear_history: "Ask",
  // rm4: the remaining 5 promoted capabilities (read_pane, read_notes, focus_pane, compose_draft,
  // archive_pane) were ABSENT from this map and relied on resolveOne's `?? "Auto"` fallback,
  // which HAPPENED to match their CAPABILITY_DEFS declared default (all "Auto") — correct by
  // coincidence, not by declaration. Seed them explicitly so get_pane_gates/list_capabilities
  // report the DECLARED default rather than the resolver fallback. Values are IDENTICAL to the
  // prior fallback outcome (all "Auto") — a strict no-op for effective gating (test-pinned).
  read_pane: "Auto",
  read_notes: "Auto",
  focus_pane: "Auto",
  compose_draft: "Auto",
  archive_pane: "Auto",
  // c55.10: rest-only writes tightened from ungated → Ask (gate-tightening only).
  send_keys: "Ask",
  remove_watch_rule: "Ask",
  delete_orchestrator_plan: "Ask",
};

// ─────────────────────────────────────────────────────────────────────────────
// Posture profiles (f09.3) — named bundles of the GLOBAL capability-gate matrix
// (+ optional globalPermissionsMode) applied in one BoH tap or one voice phrase via
// apply_posture. A profile is pure DATA — applying it is a global-map REPLACEMENT with
// ZERO new gating semantics (it compiles down to the same settings.advanced.capabilityGates
// write set_capability_gate performs). Per operator decision (2026-07-06) applying a profile
// touches the GLOBAL layer ONLY — per-pane overrides persist untouched.
// ─────────────────────────────────────────────────────────────────────────────
export interface PostureProfile {
  /** Operator-facing name (seeds: "Heads-down" / "Demo" / "Locked"). Matched case/punct-insensitively. */
  name: string;
  /** Optional global autonomy mode to set alongside the matrix. Seeds leave this unset (matrix IS the posture). */
  globalPermissionsMode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";
  /** The GLOBAL capability-gate map this profile installs (replaces settings.advanced.capabilityGates). */
  capabilityGates: CapabilityGateMap;
}

/** Build a full matrix (every DEFAULT capability) pinned to one gate value — the Demo/Locked seeds. */
function allCapabilityGatesTo(v: GateValue): CapabilityGateMap {
  const out: CapabilityGateMap = {};
  for (const k of Object.keys(DEFAULT_CAPABILITY_GATES)) (out as Record<string, GateValue>)[k] = v;
  return out;
}

// The three SEED profiles (operator decision 2026-07-06: seed-only + save-current-as + delete; the
// matrix editor IS the profile editor — no dedicated editor UI). Each carries a FULL matrix so an
// applied posture is deterministic (an omitted capability would resolve to the permissive "Auto"
// fallback, which the voice loosen-check would read as a loosen — full maps avoid that surprise).
//   - Heads-down: the director is heads-down on their own work — let agents cook. Productive writes
//     loosen to Auto; everything else keeps its safe default. LOOSENS ⇒ defers on voice.
//   - Demo: predictable in front of an audience — nothing fires on its own; every capability asks
//     first. TIGHTENS-or-equal vs the default matrix ⇒ instant on voice.
//   - Locked: not in my kitchen — every gated capability is Off. Pure tighten ⇒ instant on voice.
export const SEED_POSTURE_PROFILES: readonly PostureProfile[] = [
  { name: "Heads-down", capabilityGates: { ...DEFAULT_CAPABILITY_GATES, write_to_pane: "Auto", deliver_handoff: "Auto" } },
  { name: "Demo", capabilityGates: allCapabilityGatesTo("Ask") },
  { name: "Locked", capabilityGates: allCapabilityGatesTo("Off") },
];

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
  // f09.2 (timed autonomy windows): epoch-ms expiry of a LIVE autonomy window on this pane, when one
  // is open. Server truth (posturePayloadForPane); the pane chip renders a countdown badge from it.
  // Absent ⇒ no live window (the normal ask-first posture). Optional so older payloads/mocks omit it.
  autonomy_until?: number;
}

/**
 * f09.2 (timed autonomy windows): a bounded, auto-reverting grant of FULL AUTO on ONE pane's
 * productive capabilities. It LOOSENS the safety matrix (Ask→Auto for `capabilities`) only while
 * live (`now < expires_at`), NEVER loosens an explicit Off or a STOP-ALL freeze, and NEVER survives
 * a server restart (revoked at boot, fail-closed). One live window per pane (a new grant replaces).
 */
export interface AutonomyWindow {
  id: string;
  pane_id: string;
  /** The capabilities the window loosens Ask→Auto (default: the productive writes). */
  capabilities: CapabilityGate[];
  granted_at: number;
  expires_at: number;
  /** Set once the spoken T-minus last-call warning has been narrated (so it fires exactly once). */
  warned_at?: number;
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

// Phase 3, Step 3.3 — the client-side projection of a pane's open InstructionEnvelope draft
// (docs/superpowers/specs/2026-07-09-instruction-routing.md §5). Additive, optional everywhere it
// is threaded: server truth only, mirrored one-way from the `exchange` field on the draft_updated
// WS frame and the GET /api/panes/:projectId/:paneId/draft response — src/exchanges/draftRegistry.ts's
// `viewOpenDraft` is the server-side serializer this shape mirrors structurally (kept as an
// independent declaration so the client bundle never imports the zod-backed exchanges module).
// `null`/absent whenever JANUS_INSTRUCTION_ENVELOPE is "off" (default) or the pane has no open
// draft — every existing PaneDraft-only surface is unaffected either way.
export type ExchangeReadiness =
  | { ready: true }
  | { ready: false; missing: "target" | "objective"; clarification: string };

export interface ExchangeDraftView {
  exchangeId: string;
  target: { projectId: string; paneId: string } | null;
  objective: string;
  relevantContext: string[];
  constraints: string[];
  requestedOutput: string | null;
  completionSignal: string | null;
  /** Bumps on every revise (voice field edit or typed hand-edit convergence) — spec §5. */
  draftVersion: number;
  /** Versions the exchange machinery has recorded as sent — stamped by the voice
   *  `send_instruction` verb; the Workbench REST send lane (step 3.5) now CLOSES the exchange
   *  server-side on delivery, so a surviving view with sentVersions implies a pending/blocked
   *  send, never a completed REST one. */
  sentVersions: number[];
  /** The draft version currently parked as a PENDING operator approval, or null/absent when none
   *  is outstanding (step 3.5) — distinguishes "awaiting approval" from "delivered" honestly. */
  pendingApprovalVersion?: number | null;
  readiness: ExchangeReadiness;
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

// ─────────────────────────────────────────────────────────────────────────────
// Voice UX trio (wave 3, spec 2026-07-02-voice-ux-trio-design.md). Operator-tunable knobs
// for the conversational SITREP shape, the focus-by-reference bind policy, and the spoken
// destructive-confirm window. Optional on SystemSettings so a persisted file without it keeps
// loading (shallow-merged with DEFAULT_VOICE_UX in terminal.ts loadSettings); every reader
// defaults via `manager.settings.voiceUx ?? DEFAULT_VOICE_UX`.
// ─────────────────────────────────────────────────────────────────────────────
export interface VoiceUxSettings {
  sitrepShape: "brief" | "walk" | "full";
  focusBindPolicy: "confirm" | "echo" | "tiered";
  confirmTimeoutMs: number;
  // Wave 4 (D6, docs/superpowers/specs/2026-07-02-cortex-cutover-design.md): the inject
  // gate's debounce floor — minimum ms since the last INJECTED brief before a changed-hash
  // event is allowed to inject again (session-start always bypasses). Reuses this block's
  // existing strip/validate idiom (VOICE_UX_KNOWN_KEYS + a dedicated validator in server.ts).
  contextInjectDebounceMs: number;
  // z5c design D7 (docs/superpowers/specs/2026-07-07-z5c-session-pool-design.md): the number
  // of ADDITIONAL hot-warm background sessions (beyond the one foreground session) the
  // per-project session pool holds open. 0 = handle-tier only (no background sockets), default
  // 1, capped at 3 (a quota guard against Gemini Live's concurrent-session limits). Read ONCE
  // at connect time (src/voice/sessionPool.ts's resolveHotSlotBudget) — per D10 this is
  // deliberately NOT hot-reloaded mid-session; a PUT here applies on the NEXT voice session,
  // same "Apply & Reconnect" idiom as voiceAi.systemPrompt/voiceAi.voice. Optional so a
  // persisted settings file from before this field existed keeps loading (shallow-merged with
  // DEFAULT_VOICE_UX, same as every other field in this block).
  sessionPoolHotSlots?: number;
}

export const DEFAULT_VOICE_UX: VoiceUxSettings = {
  sitrepShape: "brief",
  focusBindPolicy: "confirm",
  confirmTimeoutMs: 10_000,
  contextInjectDebounceMs: 3000,
  // z5c D7: sessionPoolHotSlots is deliberately ABSENT here (left undefined), not defaulted to 1 —
  // src/voice/sessionPool.ts's resolveHotSlotBudget() already treats "absent" as "default to 1", so
  // this constant's SHAPE stays byte-identical to every pre-z5c snapshot/round-trip test that
  // asserts DEFAULT_VOICE_UX's exact key set (tests/test_voice_ux_settings.ts, out of this task's
  // edit scope). Setting a literal value here would add a key those tests don't expect.
};

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
    // sa4: operator-editable Gemini voice system prompt. When unset/blank the builder
    // (src/voice/systemPrompt.ts) falls back to DEFAULT_SYSTEM_PROMPT. {{activeProjectId}} and
    // {{workspaces}} placeholders are substituted with live values at connect time. This is
    // CONFIG (persists to disk), NOT a secret.
    systemPrompt?: string;
    // BEAD tkd: the code-side "should-I-speak" silence gate. When TRUE, Janus's spoken AUDIO is
    // MUTED for a turn the gate judges HIGH-confidence thinking-aloud / human-to-human discussion
    // (the on-screen transcript still renders). DEFAULT FALSE — with it off, the gate hard-short-
    // circuits to speak (byte-for-byte today's audio path). Fails OPEN toward speaking. This is a
    // voiceAi SETTING (spoken-output axis), NOT a capability-gate matrix row. See src/voice/speakGate.ts.
    silenceGate?: boolean;
    // BEAD aqx: enable the Gemini Live BUILT-IN googleSearch grounding tool for the session. When TRUE,
    // buildVoiceTools() appends a { googleSearch: {} } entry to config.tools at connect time so Janus
    // can do grounded research; when FALSE/unset the tools array is the function-declarations entry ONLY
    // (today's path, byte-identical). DEFAULT FALSE. This is a connect-time boolean — NOT an Auto/Ask/Off
    // capability-gate row — because googleSearch is a server-side built-in with no per-call functionCall
    // hook to interpose an "Ask" on an individual search (only Off/Auto are real). It is CONFIG (persists
    // to disk via saveSettings), NOT a secret, so it flows to the client untouched. See src/voice/liveConfig.ts.
    groundingEnabled?: boolean;
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
    // f09.3: operator-saved posture profiles (the three seeds live in SEED_POSTURE_PROFILES as
    // constants; this array holds ONLY the operator's "save current as profile" additions). MUST
    // survive the SettingsDialog save/load round-trip (see preservePostureProfiles) — dropping it is
    // the same silent-erase data-loss class the capabilityGates round-trip guard pins.
    postureProfiles?: PostureProfile[];
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
  // Voice UX trio (wave 3): SITREP shape / focus bind policy / spoken-confirm timeout. Optional —
  // absent on settings persisted before this wave; loadSettings shallow-merges DEFAULT_VOICE_UX.
  voiceUx?: VoiceUxSettings;
}

export interface AttentionItem {
  id: string;
  // "idle" = informational completion (dispatch-group join, src/observe/index.ts) — consumers only
  // interpolate `type` into text, so the widening is display-safe.
  // "needs_input" (Phase 4, Step 4.2): an exchange-correlated agent question surfaced by the
  // exchange-aware attention sync (src/voice/sitrep.ts syncExchangeAttentionItems) — distinct from
  // "confirmation" (a co-pilot suggestion) because it names a REAL unanswered agent question.
  type: "approval" | "exited" | "error" | "build-failed" | "confirmation" | "idle" | "needs_input";
  terminalId: string;
  projectId: string;
  message: string;
  timestamp: string;
  dismissed: boolean;
  details?: any;
  /**
   * bead e7h: the id of the HELD gated request this item resolves (a PendingApproval.messageId).
   * Present ONLY for items that map to a real in-flight approval (e.g. a staged pane WRITE) — those
   * become genuinely ACTIONABLE from the inbox (Approve/Deny call the SAME POST /api/commands/approve
   * resolver voice uses). Absent for triage-only items (suggestions, dead/exited stations, idle
   * completions), which stay Open/Dismiss. The plumbing is ID-GATED: no messageId → no resolve.
   */
  messageId?: string;
  /**
   * bead 8xn: the RAW staged command (not the wrapped "<pane> needs your ok: <cmd>" display string in
   * `message`). Present ONLY on inbox-routed held approvals so the promote-to-modal path can rebuild the
   * PendingCommand with the real instruction — the ApprovalDialog must show the command, not the inbox
   * label. Absent for triage-only items.
   */
  rawCmd?: string;
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

// ── Prompt templates (journey-expansion: structured instruction inputs) ──────
// A named, parameterized instruction body. Slots use `{{slot_name}}` syntax and
// are DERIVED from the body (extractSlots in src/templates.ts) — never stored
// stale. Applying a template instantiates the body into a pane's WIP draft
// (compose-then-send), so the existing draft review + gated send path stays the
// single write choke-point.
export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  body: string;
  created_at: number;
  updated_at: number;
}

// ── Pane layouts (journey-expansion: "mise en place", split out of recipes) ──
// A snapshot of a project's pane formation: launch command, cwd, preset, and
// permission mode per pane. Pure furniture — NO orchestration logic and NO
// startup commands are ever auto-run. Applying a layout rides the same gates
// as applying a recipe (apply_recipe layout veto + per-pane create_pane).
export interface LayoutPane {
  id: string;
  name: string;
  command: string;
  cwd: string;
  preset: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
}

export interface PaneLayout {
  id: string;
  name: string;
  description?: string;
  /** The project the snapshot was taken from (informational; apply targets the active project). */
  sourceProjectId?: string;
  panes: LayoutPane[];
  created_at: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// hwu.7 — the action-activity WS frame. Broadcast ONCE per completed voice tool call so the
// read-only ActionPanel (a sibling region beside the KitchenRadio, NOT a replacement for the
// attention inbox) can re-key to the agent's most recent tool result while voice stays terse.
//
// `payload` is a PROJECTION of the ActionResult that has already passed redactDeep and a size cap
// (never the raw args): `output` for a kind:"ok" result, `summary` for a deferred kind:"pending",
// `reason` for a kind:"blocked" refusal, `message` for a kind:"error"/"clarify". `truncated` marks
// a payload whose `output` was replaced because it exceeded the cap. This shape is the ONLY thing
// that crosses the WS seam for this feature — the panel's name→view mapping is pure UI presentation.
// ─────────────────────────────────────────────────────────────────────────────
export interface ActionActivityPayload {
  /** The ActionResult discriminant: "ok" | "pending" | "clarify" | "blocked" | "error". */
  kind: string;
  /** kind:"ok" structured output (string prose OR an object like {notes}/{results}). Redacted. */
  output?: unknown;
  /** kind:"pending" deferred-write summary (renders an "awaiting approval" card, never a result). */
  summary?: string;
  /** kind:"blocked" refusal reason. */
  reason?: string;
  /** kind:"error"/"clarify" message text. */
  message?: string;
  /** True iff `output` was elided because the serialized payload exceeded the size cap. */
  truncated?: boolean;
}

export interface ActionActivityFrame {
  type: "action_activity";
  /** The dispatched tool name (drives the deterministic panel view lookup). */
  name: string;
  /** The Gemini functionCall id — the React re-key so the panel resets per completed call. */
  callId: string;
  /** Emission wall-clock (ms). */
  ts: number;
  payload: ActionActivityPayload;
}


