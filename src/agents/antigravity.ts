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
//  - Session pin: none → CAPTURE the conversation id post-spawn as the newest
//    ~/.gemini/antigravity-cli/conversations/<uuid>.db that appeared after the pane spawned
//    (P5 VERIFIED, bead 1h0: that <uuid> is what `--conversation` resumes; implicit/<uuid>.pb
//    is NOT — agy ignores it). Baseline-diff at construction + sticky = per-pane id.
//  - Lossless resume: ALWAYS by explicit `--conversation=<uuid>` (a bare -c resumes the
//    most-recent globally-in-workspace → multi-pane hazard) + bypass re-arm.
//  - Bin: full path is a DEPLOY concern (not on PATH until `agy install`) → keep the bin
//    name configurable; default to the clean `agy` name.

import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AdapterConfig, AgentAdapter, Capabilities, ConvEntry, LaunchPlan, Mode, ModeStep, PlanModeChange } from "./index";

// agy's own bypass flag. (Coincidentally the same string as Claude's, but it is the
// adapter's OWN decision — the B2 fix is that this is no longer hardcoded globally.)
const SKIP_FLAG = "--dangerously-skip-permissions";
// (P5 VERIFIED: there is NO live permission-cycle key in agy v1.0.5 — the once-assumed
// shift+down ESC[1;2B does nothing in-session; /permissions is a rule editor, not a dial.)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// P5 VERIFIED (bead 1h0): agy persists each conversation as a SQLite trajectory store at
// ~/.gemini/antigravity-cli/conversations/<uuid>.db (mirrored by a brain/<uuid>/ dir). That
// <uuid> is EXACTLY the id `agy --conversation=<uuid>` resumes (log: "Resuming conversation
// <uuid>"). The implicit/<uuid>.pb files are NOT conversation ids — agy logs "not found,
// ignoring --conversation" for them. So the conversation id = newest conversations/<uuid>.db.
function defaultConvLister(): ConvEntry[] {
  const dir = join(homedir(), ".gemini", "antigravity-cli", "conversations");
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".db"))
      .map((f) => ({ id: f.slice(0, -3), mtimeMs: statSync(join(dir, f)).mtimeMs }))
      .filter((e) => UUID_RE.test(e.id));
  } catch {
    return []; // dir absent (agy never run) → nothing to capture
  }
}

export class AntigravityAdapter implements AgentAdapter {
  readonly preset = "Antigravity" as const;
  private readonly bin: string;
  private readonly listConvs: () => ConvEntry[];
  private readonly baseline: Set<string>;
  private captured: string | null = null;

  constructor(config: AdapterConfig = {}) {
    // Default to the clean `agy` name; a deploy may pin the full path (…\agy\bin\agy.exe).
    this.bin = (config.bin ?? "").trim() || "agy";
    this.listConvs = config.convLister ?? defaultConvLister;
    // Snapshot pre-existing conversations at pane construction (before spawn) so
    // captureSessionId can single out THIS pane's NEW conversation on its first turn.
    this.baseline = new Set(this.listConvs().map((c) => c.id));
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
    // ALWAYS resume by explicit --conversation=<uuid> (never a bare -c → multi-pane hazard)
    // + bypass re-arm. Guard on a real uuid: an empty/synthetic id is dropped (agy ignores an
    // unknown --conversation and silently starts a FRESH conversation — P5 observed), so the
    // pane relaunches clean rather than pretending to resume.
    const argv = [this.bin];
    if (UUID_RE.test(o.sessionId)) argv.push(`--conversation=${o.sessionId}`);
    argv.push(SKIP_FLAG);
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
    return this.captured;
  }

  // P5-VERIFIED capture (bead 1h0), two sources, sticky once captured so a Full-Auto
  // promotion's restart-resume re-attaches the SAME conversation via --conversation=<uuid>:
  //  1) PREFERRED — parse THIS pane's own stdout: agy prints "Resume: agy --conversation=<uuid>
  //     (or -c)". Per-pane and race-free (no shared-store ambiguity).
  //  2) FALLBACK — the newest conversations/<uuid>.db that appeared since the pane spawned
  //     (baseline diff). Exact for sequential/single-pane use; two panes first-turning
  //     concurrently in one workspace could race on "newest new" — hence the stdout source is
  //     tried first.
  captureSessionId(ctx: { ptyOutput: string; cwd: string }): string | null {
    if (this.captured) return this.captured; // sticky
    const printed = ctx.ptyOutput.match(/--conversation[ =]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (printed) { this.captured = printed[1].toLowerCase(); return this.captured; }
    const fresh = this.listConvs()
      .filter((c) => !this.baseline.has(c.id))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (fresh.length) this.captured = fresh[0].id;
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

  // BUG-006 residual — agy's in-session working markers are UNVERIFIED (parseCurrentMode is a null
  // stub; an agy session shows no mode pill and its status line is just "Gemini 3.x …"). Default
  // conservative: no marker ⇒ pure output-quiescence, no worse than today. Fill in behind the
  // multi-cli-live-switch-verification bead once captured live.
  isLikelyBusy(_recentTail: string): boolean {
    return false;
  }
}
