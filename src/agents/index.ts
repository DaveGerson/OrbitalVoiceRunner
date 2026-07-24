// src/agents — the polymorphic AgentAdapter (multi-cli adapter spec §4, §5).
//
// One adapter instance per pane, selected by tool_preset, owns EVERY per-CLI
// difference behind one interface: spawn flags, the bypass flag, the launch/resume
// argv, the live permission-mode-switch disposition, session pinning, and the
// capability flags the orchestrator uses to hide/fall back per CLI. This retires
// the six inline `if (toolPreset !== "Custom")` branches in src/terminal.ts (B5)
// and corrects B2 (Codex/agy must NOT receive Claude's Anthropic-only
// --dangerously-skip-permissions).
//
// NOTE (verification bead `multi-cli-live-switch-verification`): parseCurrentMode
// and captureSessionId are intentionally MINIMAL stubs here — the live status-bar
// markers and on-disk session-capture races can only be pinned against real CLIs.
// The spawn/launch/resume/plan/capability surface below is fully encoded NOW.

export type Mode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";

/** One read-after-write cycle step for a live mode change (never blind-count). */
export type ModeStep = { bytes: string; expectMarker?: RegExp };

export type PlanModeChange =
  | { kind: "live-signal"; steps: ModeStep[] }
  | { kind: "restart-resume" }
  | { kind: "unsupported" };

export type Capabilities = {
  supportsLivePermissionSwitch: boolean;
  supportsSessionPin: boolean;
  supportsResume: boolean;
  modeSupport: boolean; // false for Custom → hide the mode dial
  readyForLiveCycle: boolean; // false for Codex/agy until the verification bead flips it
};

export type LaunchPlan = { argv: string[]; bypassSeededInRing: boolean; launchWindowHot: boolean };

export interface AgentAdapter {
  readonly preset: "Claude Code" | "Codex" | "Antigravity" | "Custom";

  // — spawn —
  resolveSpawnCommand(cwd: string): { bin: string; onPath: boolean };
  generateSessionId(): string | null; // Claude: UUID; others: null (capture post-spawn)
  buildLaunchCommand(o: { mode: Mode; sessionId: string | null; cwd: string; seedPrompt?: string }): LaunchPlan;
  buildResumeCommand(o: { sessionId: string; mode: Mode; cwd: string }): { argv: string[] };
  safeStartCycle(): ModeStep[]; // steps to cycle DOWN from a hot launch (empty if not hot)

  // — live permission mode —
  planModeChange(from: Mode, to: Mode): PlanModeChange;
  modeCycleByte(): string | null; // Claude ESC[Z; Codex null; agy null (P5: no live axis)
  parseCurrentMode(ptyFrame: string): Mode | null; // read-after-write status-bar parser (null = keep reading)

  // — session continuity —
  pinnedSessionId(): string | null;
  captureSessionId(ctx: { ptyOutput: string; cwd: string }): string | null;

  // — feature flags —
  capabilities(): Capabilities;

  /**
   * True when `recentTail` (the last N rendered output lines, ANSI-stripped) carries a live
   * "working"/"thinking" marker for THIS CLI — i.e. a turn is in progress and the pane must read
   * Running even if output has paused (BUG-006 residual: the agent "thinking pause" false-idle).
   * Pure, data-driven per adapter (each owns its own marker list); NOT one global regex. Must
   * return false on an empty/settled tail (a bare prompt, a mode pill) so a resting agent still
   * debounces to Idle. No side effects.
   */
  isLikelyBusy(recentTail: string): boolean;

  /**
   * The per-CLI permission-BYPASS flag (Full-Auto string mutation). Claude/agy use
   * --dangerously-skip-permissions; Codex uses --dangerously-bypass-approvals-and-sandbox;
   * Custom has none. Returned so src/terminal.ts's flag-injection choke point can be
   * preset-agnostic (the B2 fix: stop hardcoding Claude's flag for every agent).
   */
  bypassFlag(): string | null;
}

export type PresetUnion = AgentAdapter["preset"];

/** One entry in an on-disk conversation store (agy: conversations/<id>.db). */
export type ConvEntry = { id: string; mtimeMs: number };

/** Optional per-adapter config (e.g. agy bin path is a deploy concern). */
export type AdapterConfig = {
  bin?: string;
  /** Injectable conversation-store reader (agy session capture); tests stub this. */
  convLister?: () => ConvEntry[];
};

import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { AntigravityAdapter } from "./antigravity";
import { CustomAdapter } from "./custom";

/** Select the adapter for a (normalized) tool-preset union value. */
export function createAdapter(preset: PresetUnion, config: AdapterConfig = {}): AgentAdapter {
  switch (preset) {
    case "Claude Code":
      return new ClaudeAdapter(config);
    case "Codex":
      return new CodexAdapter(config);
    case "Antigravity":
      return new AntigravityAdapter(config);
    case "Custom":
    default:
      return new CustomAdapter(config);
  }
}
