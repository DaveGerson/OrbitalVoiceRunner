// AntigravityAdapter — `agy` v1.0.4 (LOW confidence). Spec §5.
//
// Strategy (the §5 "Antigravity" column):
//  - Safe-but-ready launch: `agy --dangerously-skip-permissions -i "<seed>"`. agy's OWN
//    bypass flag IS --dangerously-skip-permissions (this is CORRECT for agy — distinct
//    from Codex). agy has NO --allow- equivalent → the launch window is HOT under
//    Full Auto (assert safe-mode before dispatch; spec §15 hot-launch risk).
//  - Live → Full-Auto: shift+down (ESC[1;2B) cycle is an UNVERIFIED axis → restart-resume.
//  - Session pin: none → capture quit-msg / newest ~/.gemini/antigravity-cli/brain/<uuid>/.
//  - Lossless resume: ALWAYS by explicit `--conversation=<uuid>` (a bare -c resumes the
//    most-recent globally-in-workspace → multi-pane hazard) + bypass re-arm.
//  - Bin: full path is a DEPLOY concern (not on PATH until `agy install`) → keep the bin
//    name configurable; default to the clean `agy` name.

import type { AdapterConfig, AgentAdapter, Capabilities, LaunchPlan, Mode, ModeStep, PlanModeChange } from "./index";

// agy's own bypass flag. (Coincidentally the same string as Claude's, but it is the
// adapter's OWN decision — the B2 fix is that this is no longer hardcoded globally.)
const SKIP_FLAG = "--dangerously-skip-permissions";
// shift+down = ESC [ 1 ; 2 B (unverified permission axis).
const SHIFT_DOWN = "\x1b[1;2B";

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
    // ESC[1;2B axis unverified → safe restart-resume floor until the verification bead.
    return { kind: "restart-resume" };
  }

  modeCycleByte(): string {
    // Returned for completeness; the orchestrator does NOT cycle live until verified
    // (capabilities().readyForLiveCycle === false gates that).
    return SHIFT_DOWN;
  }

  // TODO(multi-cli-live-switch-verification): tokens request-review|proceed-in-sandbox|
  // always-proceed|strict, customizable via /statusline.
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
