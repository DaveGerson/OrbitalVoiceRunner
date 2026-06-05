// CustomAdapter — identity passthrough (user-supplied bare shell/argv). Spec §5.
//
// A Custom pane has NO permission model: the orchestrator hides the mode dial
// (modeSupport=false) and never injects flags or a uuid. planModeChange is
// unsupported. This is the fail-safe leg — a bare shell is harmless.

import type { AdapterConfig, AgentAdapter, Capabilities, LaunchPlan, Mode, ModeStep, PlanModeChange } from "./index";

export class CustomAdapter implements AgentAdapter {
  readonly preset = "Custom" as const;
  private readonly bin: string;

  constructor(config: AdapterConfig = {}) {
    this.bin = (config.bin ?? "").trim();
  }

  resolveSpawnCommand(_cwd: string): { bin: string; onPath: boolean } {
    return { bin: this.bin, onPath: true };
  }

  generateSessionId(): null {
    return null; // no session model
  }

  buildLaunchCommand(o: { mode: Mode; sessionId: string | null; cwd: string; seedPrompt?: string }): LaunchPlan {
    // Identity: verbatim argv, no flags, no uuid.
    const argv = this.bin ? [this.bin] : [];
    return { argv, bypassSeededInRing: false, launchWindowHot: false };
  }

  buildResumeCommand(o: { sessionId: string; mode: Mode; cwd: string }): { argv: string[] } {
    // Cold respawn — Custom has no resume; return the bare bin (if any).
    return { argv: this.bin ? [this.bin] : [] };
  }

  safeStartCycle(): ModeStep[] {
    return [];
  }

  planModeChange(_from: Mode, _to: Mode): PlanModeChange {
    return { kind: "unsupported" };
  }

  modeCycleByte(): null {
    return null;
  }

  parseCurrentMode(_ptyFrame: string): Mode | null {
    return null;
  }

  pinnedSessionId(): null {
    return null;
  }

  captureSessionId(_ctx: { ptyOutput: string; cwd: string }): null {
    return null;
  }

  capabilities(): Capabilities {
    return {
      supportsLivePermissionSwitch: false,
      supportsSessionPin: false,
      supportsResume: false,
      modeSupport: false,
      readyForLiveCycle: false,
    };
  }

  bypassFlag(): null {
    return null;
  }
}
