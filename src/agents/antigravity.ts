// AntigravityAdapter — `agy` v1.0.5 (P5 VERIFIED 2026-06-05). Spec §5.
//
// Strategy (the §5 "Antigravity" column):
//  - Safe-but-ready launch: `agy --dangerously-skip-permissions -i "<seed>"`. agy's OWN
//    bypass flag IS --dangerously-skip-permissions (this is CORRECT for agy — distinct
//    from Codex). agy has NO --allow- equivalent → the launch window is HOT under
//    Full Auto (assert safe-mode before dispatch; spec §15 hot-launch risk).
//  - Live → Full-Auto: NONE. P5 live verification (bead 8sw, authed agy session over
//    ConPTY) DISPROVED the assumed shift+down (ESC[1;2B) cycle axis — neither shift+down
//    nor shift+tab moves anything in-session. agy v1.0.5's `/permissions` is a
//    "Permission Config Editor" (scope picker: Project / Shared with Antigravity / Global
//    → persistent rule editing), NOT a session-mode dial. So there is no live in-session
//    permission switch: Full-Auto is reachable ONLY by relaunching with
//    --dangerously-skip-permissions → planModeChange = restart-resume, readyForLiveCycle
//    = false are VERIFIED-correct (not provisional). Re-probe: `npm run verify:modeswitch:agy`.
//  - Session pin: none → capture quit-msg / newest ~/.gemini/antigravity-cli/brain/<uuid>/.
//  - Lossless resume: ALWAYS by explicit `--conversation=<uuid>` (a bare -c resumes the
//    most-recent globally-in-workspace → multi-pane hazard) + bypass re-arm.
//  - Bin: full path is a DEPLOY concern (not on PATH until `agy install`) → keep the bin
//    name configurable; default to the clean `agy` name.

import type { AdapterConfig, AgentAdapter, Capabilities, LaunchPlan, Mode, ModeStep, PlanModeChange } from "./index";

// agy's own bypass flag. (Coincidentally the same string as Claude's, but it is the
// adapter's OWN decision — the B2 fix is that this is no longer hardcoded globally.)
const SKIP_FLAG = "--dangerously-skip-permissions";
// (P5 VERIFIED: there is NO live permission-cycle key in agy v1.0.5 — the once-assumed
// shift+down ESC[1;2B does nothing in-session; /permissions is a rule editor, not a dial.)

export class AntigravityAdapter implements AgentAdapter {
  readonly preset = "Antigravity" as const;
  private readonly bin: string;
  private captured: string | null = null;

  constructor(config: AdapterConfig = {}) {
    // Default to the clean `agy` name; a deploy may pin the full path (…\agy\bin\agy.exe).
    this.bin = (config.bin ?? "").trim() || "agy";
  }

  resolveSpawnCommand(_cwd: string): { bin: string; onPath: boolean } {
    return { bin: this.bin, onPath: false }; // not on PATH until `agy install`
  }

  generateSessionId(): null {
    return null; // capture post-spawn
  }

  buildLaunchCommand(o: { mode: Mode; sessionId: string | null; cwd: string; seedPrompt?: string }): LaunchPlan {
    const argv = [this.bin];
    const hot = o.mode === "Full Auto";
    if (hot) argv.push(SKIP_FLAG); // no --allow- equivalent → seeding == entering (HOT)
    if (o.seedPrompt) argv.push("-i", o.seedPrompt);
    return { argv, bypassSeededInRing: hot, launchWindowHot: hot };
  }

  buildResumeCommand(o: { sessionId: string; mode: Mode; cwd: string }): { argv: string[] } {
    // ALWAYS resume by explicit --conversation=<uuid> (never a bare -c) + bypass re-arm.
    const argv = [this.bin, `--conversation=${o.sessionId}`, SKIP_FLAG];
    return { argv };
  }

  safeStartCycle(): ModeStep[] {
    // Hot launch under Full Auto has no documented safe-down cycle yet.
    // TODO(multi-cli-live-switch-verification): confirm the cycle-down axis.
    return [];
  }

  planModeChange(_from: Mode, _to: Mode): PlanModeChange {
    // P5 VERIFIED: agy v1.0.5 has no live in-session permission switch (no key-cycle axis;
    // /permissions is a rule editor, not a mode dial). Full-Auto ⇒ relaunch with the bypass
    // flag, re-attaching the conversation. So restart-resume is the correct, only path.
    return { kind: "restart-resume" };
  }

  modeCycleByte(): string | null {
    // P5 VERIFIED: the assumed shift+down (ESC[1;2B) axis does NOT cycle anything in an
    // agy session, and there is no alternative live cycle key. There is no cycle byte.
    return null;
  }

  // P5 VERIFIED: an agy session shows no in-session permission-mode pill (the model/status
  // line is just "Gemini 3.x …"; /permissions opens a separate Config Editor). There is no
  // status-bar mode marker to read back → always null. read-after-write does not apply.
  parseCurrentMode(_ptyFrame: string): Mode | null {
    return null;
  }

  pinnedSessionId(): string | null {
    return null;
  }

  // TODO(multi-cli-live-switch-verification): scrape quit-msg / newest brain/<uuid>/.
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
    return SKIP_FLAG;
  }
}
