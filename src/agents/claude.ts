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

// BUG-006 residual — Claude Code "working"/"thinking" markers. The interruptible turn shows
// "(esc to interrupt)" for its whole duration and a spinner glyph that updates on the status line.
// The braille range (U+2800–U+28FF) is the animated spinner; the star glyphs are Claude's own
// working glyphs. Deliberately EXCLUDES the mode pill "⏵⏵" (U+23F5) so a settled accept-edits pill
// reads NOT busy. This adapter OWNS this list (per-CLI, not one global regex).
//
// bead q1kp (2026 CLI, observed live): the REST screen retains a star glyph in the past-tense
// completion line ("✻Cogitated for 7s"), so a BARE star-glyph class pins a rested pane Running
// forever — no idle edge, no idle-time exchange settlement. The glyph class therefore requires an
// ACTIVE verb frame: a spinner-phase glyph LEADING the line ("·✢✶✻✽…" phases, observed live),
// followed by a word carrying the working ellipsis within a SHORT budget ("✻ Ideating…",
// "·Architecting…"). Three deliberate narrowings (adversarial review, 2026-07-28):
//   - line-anchored: a mid-line glyph (OSC title residue "]0;✳ …", footer "· res…") never counts;
//   - '*' stays OUT of the phase class even though the spinner cycles through it — a truncated
//     markdown bullet at a rest bottom ("* Updated tests…") would permanently pin the pane,
//     which is strictly worse than the rare missed '*' frame (a self-correcting early idle);
//   - the {0,16} ellipsis budget keeps a stripAnsiSequences ROW-MERGE ("✻Cogitated for 7s · res…"
//     — two visual rows fused into one buffer line) from resurrecting the rest-screen pin, while
//     covering every observed working verb (longest: "Orchestrating…" = 13).
// Long effort-display thinking gaps show "thinking with <level> effort" (no ellipsis) — matched
// as that exact frame shape, NEVER the bare word "thinking" (response prose / a drafted composer
// line at rest would re-pin the pane).
const CLAUDE_BUSY_MARKERS: RegExp[] = [
  /esc to interrupt/i,
  /[⠀-⣿]/, // braille spinner
  /^[✳✱✶✷✴✽✻✹·✢][^\S\n]*[A-Za-z][^\n]{0,16}(…|\.{3})/m, // line-leading spinner-phase glyph + active verb ellipsis
  /\bthinking with \w+ effort\b/i, // the effort-display frame shape, not the common word
];

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

  // Read-after-write mode markers — pinned to the LIVE status-bar strings captured
  // in P5 (bead wsm-e2e-pinned-8sw, Claude v2.x over ConPTY). Observed ring:
  //   default(NO pill) → "⏵⏵ accept edits on" → "⏸ plan mode on" → "⏵⏵ auto mode on".
  // Only the three Janus modes are recognized; everything else returns null so the
  // read-after-write loop keeps cycling (never blind-counts). NOTE: accept-edits is a
  // MID tier — it must NOT read as Full Auto, or a promotion that stalled at
  // accept-edits would be falsely confirmed (the original §5 bug).
  parseCurrentMode(ptyFrame: string): Mode | null {
    if (/plan mode on/i.test(ptyFrame)) return "Read-Only";
    // Full Auto = "auto mode on" (cycle-reachable top) OR "bypass permissions on"
    // (present only when --allow-dangerously-skip-permissions seeds the ring).
    if (/auto mode on/i.test(ptyFrame) || /bypass permissions on/i.test(ptyFrame)) return "Full Auto";
    // accept-edits (mid tier) and default/HITL (no pill) have no Janus mode → null.
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

  isLikelyBusy(recentTail: string): boolean {
    return CLAUDE_BUSY_MARKERS.some((re) => re.test(recentTail));
  }
}
