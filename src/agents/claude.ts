// ClaudeAdapter — Claude Code v2.1.158 (HIGH confidence). Multi-cli spec §5.
//
// Strategy (the §5 "Claude Code" column):
//  - Safe-but-ready launch: `claude --session-id <uuid> --allow-dangerously-skip-permissions
//    --permission-mode <map>` — the bypass is SEEDED in the ring but the launch is NOT hot
//    (--permission-mode picks the SAFE floor: plan/default; never bypassPermissions).
//  - Live → Full-Auto: ESC[Z (0x1b5b5a) ring steps, read-after-write.
//  - Session pin: deterministic --session-id <uuid>.
//  - Lossless resume: `claude --resume <uuid> --dangerously-skip-permissions`
//    (no --fork-session, no --session-id, never --no-session-persistence).

import { randomUUID } from "crypto";
import type { AdapterConfig, AgentAdapter, Capabilities, LaunchPlan, Mode, ModeStep, PlanModeChange } from "./index";

const SKIP_FLAG = "--dangerously-skip-permissions";
// Shift+Tab = ESC [ Z = 0x1b 0x5b 0x5a — Claude's live mode-cycle key.
const SHIFT_TAB = "\x1b\x5b\x5a";

// Janus Mode → Claude --permission-mode. The three modes map to DISTINCT Claude
// modes (no overlap). Full Auto launches SAFE (acceptEdits) with the bypass merely
// seeded in the ring — promotion to true bypass happens LIVE via ESC[Z, not at spawn.
const PERMISSION_MODE: Record<Mode, string> = {
  "Full Auto": "acceptEdits",
  "Human-in-the-Loop": "default",
  "Read-Only": "plan",
};

export class ClaudeAdapter implements AgentAdapter {
  readonly preset = "Claude Code" as const;
  private readonly bin: string;
  private pinned: string | null = null;

  constructor(config: AdapterConfig = {}) {
    this.bin = (config.bin ?? "").trim() || "claude";
  }

  resolveSpawnCommand(_cwd: string): { bin: string; onPath: boolean } {
    return { bin: this.bin, onPath: true };
  }

  generateSessionId(): string {
    const id = randomUUID();
    this.pinned = id;
    return id;
  }

  buildLaunchCommand(o: { mode: Mode; sessionId: string | null; cwd: string; seedPrompt?: string }): LaunchPlan {
    const sid = o.sessionId ?? this.generateSessionId();
    this.pinned = sid;
    // --allow-dangerously-skip-permissions SEEDS the bypass into the ring without
    // entering it; --permission-mode picks the safe launch floor.
    const argv = [
      this.bin,
      "--session-id",
      sid,
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      PERMISSION_MODE[o.mode],
    ];
    return { argv, bypassSeededInRing: true, launchWindowHot: false };
  }

  buildResumeCommand(o: { sessionId: string; mode: Mode; cwd: string }): { argv: string[] } {
    // --resume <uuid> + bypass re-arm. No --fork-session, no --session-id on resume.
    const argv = [this.bin, "--resume", o.sessionId, SKIP_FLAG];
    return { argv };
  }

  safeStartCycle(): ModeStep[] {
    // Launch is not hot (bypass only seeded) → nothing to cycle down.
    return [];
  }

  planModeChange(_from: Mode, _to: Mode): PlanModeChange {
    // Live mode switch over the ESC[Z ring, read-after-write.
    const steps: ModeStep[] = [{ bytes: SHIFT_TAB }];
    return { kind: "live-signal", steps };
  }

  modeCycleByte(): string {
    return SHIFT_TAB;
  }

  // TODO(multi-cli-live-switch-verification): pin against captured status-bar
  // strings. Only `acceptEdits`⇒`⏵⏵ accept edits on` is confirmed; rest TBD live.
  parseCurrentMode(ptyFrame: string): Mode | null {
    if (/accept edits on/i.test(ptyFrame)) return "Full Auto";
    return null; // keep reading — never blind-count.
  }

  pinnedSessionId(): string | null {
    return this.pinned;
  }

  // TODO(multi-cli-live-switch-verification): Claude pins via --session-id, so
  // post-spawn capture is unnecessary; left as a no-op for interface symmetry.
  captureSessionId(_ctx: { ptyOutput: string; cwd: string }): string | null {
    return this.pinned;
  }

  capabilities(): Capabilities {
    return {
      supportsLivePermissionSwitch: true,
      supportsSessionPin: true,
      supportsResume: true,
      modeSupport: true,
      readyForLiveCycle: true,
    };
  }

  bypassFlag(): string {
    return SKIP_FLAG;
  }
}
