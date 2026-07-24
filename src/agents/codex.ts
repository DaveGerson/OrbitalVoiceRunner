// CodexAdapter — Codex CLI (LOW confidence; binary not installed locally). Spec §5.
//
// Strategy (the §5 "Codex" column):
//  - Safe-but-ready launch: `codex --sandbox <map> --ask-for-approval <map>` — safety
//    is set by launch FLAGS, NOT by Claude's --dangerously-skip-permissions (B2 fix).
//  - Live → Full-Auto: `/permissions` picker only (Shift+Tab is Plan/Default, NOT the
//    perms axis) → restart-resume until verified.
//  - Session pin: none → capture newest ~/.codex/sessions/.../rollout-*.jsonl UUID.
//  - Lossless resume: `codex resume <id> --dangerously-bypass-approvals-and-sandbox`.

import type { AdapterConfig, AgentAdapter, Capabilities, LaunchPlan, Mode, ModeStep, PlanModeChange } from "./index";

// Codex's TRUE permission bypass — explicitly NOT --dangerously-skip-permissions.
const BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

// Janus Mode → (sandbox, approval) launch flags. Distinct per mode (no overlap).
const SANDBOX: Record<Mode, string> = {
  "Full Auto": "danger-full-access",
  "Human-in-the-Loop": "workspace-write",
  "Read-Only": "read-only",
};
const APPROVAL: Record<Mode, string> = {
  "Full Auto": "never",
  "Human-in-the-Loop": "on-request",
  "Read-Only": "on-request",
};

// BUG-006 residual — Codex "working"/"thinking" markers (LOW confidence, like parseCurrentMode:
// binary not local; finalize against a live capture behind the multi-cli verification bead). A
// working turn shows a braille spinner glyph + "Esc to interrupt" and a "Working"/"Thinking" status
// word. This adapter OWNS this list (per-CLI, not one global regex).
const CODEX_BUSY_MARKERS: RegExp[] = [
  /esc to interrupt/i,
  /[⠀-⣿]/, // braille spinner
  /\bWorking\b/,
  /\bThinking\b/,
];

export class CodexAdapter implements AgentAdapter {
  readonly preset = "Codex" as const;
  private readonly bin: string;
  private captured: string | null = null;

  constructor(config: AdapterConfig = {}) {
    this.bin = (config.bin ?? "").trim() || "codex";
  }

  resolveSpawnCommand(_cwd: string): { bin: string; onPath: boolean } {
    return { bin: this.bin, onPath: false }; // absent locally
  }

  generateSessionId(): null {
    return null; // capture post-spawn
  }

  buildLaunchCommand(o: { mode: Mode; sessionId: string | null; cwd: string; seedPrompt?: string }): LaunchPlan {
    const argv = [this.bin, "--sandbox", SANDBOX[o.mode], "--ask-for-approval", APPROVAL[o.mode]];
    // Safety set by launch flags → never a hot bypass window, never Claude's flag.
    return { argv, bypassSeededInRing: false, launchWindowHot: false };
  }

  buildResumeCommand(o: { sessionId: string; mode: Mode; cwd: string }): { argv: string[] } {
    const argv = [this.bin, "resume", o.sessionId, BYPASS_FLAG];
    return { argv };
  }

  safeStartCycle(): ModeStep[] {
    return [];
  }

  planModeChange(_from: Mode, _to: Mode): PlanModeChange {
    // /permissions picker only; Shift+Tab ≠ perms axis → safe restart-resume floor.
    return { kind: "restart-resume" };
  }

  modeCycleByte(): null {
    return null; // Shift+Tab is NOT the permission axis on Codex.
  }

  // TODO(multi-cli-live-switch-verification): footer + /status markers TBD live.
  parseCurrentMode(_ptyFrame: string): Mode | null {
    return null;
  }

  pinnedSessionId(): string | null {
    return null; // no deterministic pin
  }

  // TODO(multi-cli-live-switch-verification): watch newest rollout-*.jsonl UUID.
  captureSessionId(_ctx: { ptyOutput: string; cwd: string }): string | null {
    return this.captured;
  }

  capabilities(): Capabilities {
    return {
      supportsLivePermissionSwitch: false,
      supportsSessionPin: false,
      supportsResume: true,
      modeSupport: true,
      readyForLiveCycle: false,
    };
  }

  bypassFlag(): string {
    return BYPASS_FLAG;
  }

  isLikelyBusy(recentTail: string): boolean {
    return CODEX_BUSY_MARKERS.some((re) => re.test(recentTail));
  }
}
