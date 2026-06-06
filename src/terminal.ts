import { Ledger, PaneMeta, type LedgerLike } from "./ledger";
import fs from "fs";
import path from "path";
import { SystemSettings, CliPreset, AttentionItem, DEFAULT_CAPABILITY_GATES } from "./types";
import { preservePresetGates } from "./settingsGatesRoundTrip";
import { DEFAULT_ANNOUNCEMENT_TEMPLATES } from "./announcementBus";
import { StatusProbe, ProbeResult, selectProbe, FallbackProbe } from "./statusProbe";
import { PtyTransport, createPtyTransport } from "./ptyTransport";
import {
  decideStatus,
  Status as MachineStatus,
  RuntimeType,
} from "./statusMachine";
import { AgentAdapter, createAdapter } from "./agents";

export function parsePresetsSafe(input: any): CliPreset[] {
  if (Array.isArray(input)) {
    // bead 8sq: preservePresetGates carries per-preset capabilityGates through the field-by-field
    // rebuild. This is the SERVER-SIDE persistence choke-point (updateSettings -> here); without it
    // a saved preset's gate matrix was silently erased even when the client sent it.
    return input.map((item: any) => preservePresetGates({
      id: String(item?.id || ""),
      name: String(item?.name || ""),
      command: String(item?.command || ""),
      enabled: Boolean(item?.enabled ?? true),
      permissionsMode: item?.permissionsMode || "Human-in-the-Loop",
      windowMode: item?.windowMode || "Standard Split-Pane",
      visualTheme: item?.visualTheme || "Default Green Mono",
      persistentRestore: Boolean(item?.persistentRestore ?? false),
      dangerouslySkipPermissions: Boolean(item?.dangerouslySkipPermissions ?? false),
      sessionResume: Boolean(item?.sessionResume ?? true),
      portOffset: item?.portOffset !== undefined ? String(item.portOffset) : "",
      customEnvVars: item?.customEnvVars !== undefined ? String(item.customEnvVars) : ""
    }, item));
  }
  if (input && typeof input === "object") {
    return Object.entries(input).map(([key, val]: [string, any]) => {
      let displayName = key;
      if (key === "claudeCode") displayName = "Claude Code";
      else if (key === "codex") displayName = "Codex CLI";
      else if (key === "antigravity") displayName = "Antigravity Agent";
      else {
        displayName = key.charAt(0).toUpperCase() + key.slice(1);
      }
      return preservePresetGates({
        id: key,
        name: val?.name || displayName,
        command: String(val?.command || ""),
        enabled: Boolean(val?.enabled ?? true),
        permissionsMode: val?.permissionsMode || "Human-in-the-Loop",
        windowMode: val?.windowMode || "Standard Split-Pane",
        visualTheme: val?.visualTheme || "Default Green Mono",
        persistentRestore: Boolean(val?.persistentRestore ?? false),
        dangerouslySkipPermissions: Boolean(val?.dangerouslySkipPermissions ?? false),
        sessionResume: Boolean(val?.sessionResume ?? true),
        portOffset: val?.portOffset !== undefined ? String(val.portOffset) : "",
        customEnvVars: val?.customEnvVars !== undefined ? String(val.customEnvVars) : ""
      // bead 8sq: carry per-preset capabilityGates through (server-side persistence path).
      }, val);
    });
  }
  return [
    { id: "claudeCode", name: "Claude Code", command: "claude", enabled: true, permissionsMode: "Human-in-the-Loop", windowMode: "Standard Split-Pane", visualTheme: "Royal Purple", persistentRestore: true, dangerouslySkipPermissions: false, sessionResume: true, portOffset: "", customEnvVars: "" },
    { id: "codex", name: "Codex CLI", command: "codex", enabled: true, permissionsMode: "Human-in-the-Loop", windowMode: "Standard Split-Pane", visualTheme: "Amber Slop-Shield", persistentRestore: false, dangerouslySkipPermissions: false, sessionResume: true, portOffset: "", customEnvVars: "" },
    { id: "antigravity", name: "Antigravity Agent", command: "antigravity", enabled: true, permissionsMode: "Full Auto", windowMode: "Standard Split-Pane", visualTheme: "Cosmic Slate", persistentRestore: true, dangerouslySkipPermissions: true, sessionResume: true, portOffset: "", customEnvVars: "" }
  ];
}

// ---------------------------------------------------------------------------
// U4 (wsm-e2e-pinned-ckf): deterministic create_pane — preset is the single
// source of truth. The voice tool no longer exposes a free-form `command`; the
// server derives the command from the (normalized) tool_preset via the two pure
// helpers below, reused by the voice handler AND the restart path.
// ---------------------------------------------------------------------------

/** The voice/restart tool-preset union (also UniversalTerminal.toolPreset / addTerminal). */
export type ToolPresetUnion = "Claude Code" | "Codex" | "Antigravity" | "Custom";

// Canonical id for each non-Custom union member. Codex/Antigravity .name on the
// seeded presets is "Codex CLI"/"Antigravity Agent" — NOT the union — so we key
// preset lookup on the .id, never the .name (the documented blocker).
const PRESET_ID_BY_UNION: Record<Exclude<ToolPresetUnion, "Custom">, string> = {
  "Claude Code": "claudeCode",
  Codex: "codex",
  Antigravity: "antigravity",
};

// Fallback binary when settings.presets carries no override for the id.
const PRESET_FALLBACK_CMD: Record<Exclude<ToolPresetUnion, "Custom">, string> = {
  "Claude Code": "claude",
  Codex: "codex",
  Antigravity: "antigravity",
};

/**
 * Collapse whatever the model emitted for tool_preset (a preset .id like "codex",
 * a display .name like "Codex CLI", or an already-union value like "Codex") onto
 * the addTerminal union. Unknown / empty -> "Custom" (fail-safe: a bare shell is
 * harmless; a mis-spawned agent under Full Auto is not).
 */
export function normalizePreset(raw: string | undefined | null): ToolPresetUnion {
  const v = (raw ?? "").trim();
  switch (v) {
    case "claudeCode":
    case "Claude Code":
      return "Claude Code";
    case "codex":
    case "Codex CLI":
    case "Codex":
      return "Codex";
    case "antigravity":
    case "Antigravity Agent":
    case "Antigravity":
      return "Antigravity";
    case "Custom":
      return "Custom";
    default:
      return "Custom";
  }
}

/**
 * Map a normalized tool-preset union value to the command line to launch. Single
 * source of truth for "preset -> command", reused by the voice create_pane handler
 * AND the restart path. Custom -> the configured bare shell
 * (advanced.defaultShellCommand), else the platform default (cmd.exe / bash).
 *
 * For an agent preset we resolve the command from the matching settings.presets[].command
 * (so a director who renamed the binary is honored), falling back to the canonical name.
 */
export function presetCommand(
  preset: ToolPresetUnion,
  presets: CliPreset[] | undefined,
  defaultShellCommand: string | undefined,
): string {
  if (preset === "Custom") {
    const shell = (defaultShellCommand ?? "").trim();
    return shell || (process.platform === "win32" ? "cmd.exe" : "bash");
  }
  const id = PRESET_ID_BY_UNION[preset];
  const match = (presets ?? []).find((p) => p.id === id);
  const override = (match?.command ?? "").trim();
  return override || PRESET_FALLBACK_CMD[preset];
}


/**
 * Pure launch-string builder (BUG-032 regression surface). Given a fully-built
 * base command (already carrying any --dangerously-skip-permissions mutation from
 * the constructor — that is NOT this function's concern), decide whether to append
 * a `--session-id <id>` (fresh pin) or `--resume <id>` (re-attach) flag.
 *
 * Invariants (pinned in tests/test_launch_command.ts + tests/test_session_pinning.ts):
 *  - Custom panes are never touched (no session flag ever).
 *  - The flag is appended ONLY when sessionId is a real UUID. A synthetic tracking
 *    id (e.g. "claude-code-session-<hex>") is NOT pinnable/resumable — launch bare.
 *  - B3 fix (spec §9): a FRESH pinned session (isFreshPin && supportsSessionPin)
 *    launches with --session-id <uuid> (the deterministic pin). A resume launches
 *    with --resume <uuid>. The two are mutually exclusive in one invocation.
 *  - Never double-append: if the command already carries --resume / --session(-id),
 *    leave it alone.
 *  - The base command is returned verbatim otherwise (no invented flags, no npx).
 */
export function buildLaunchCommand(
  shellCmd: string,
  toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom",
  sessionId: string,
  isFreshPin = false
): string {
  let finalCommand = shellCmd;
  // Delegate the per-preset session model to the adapter (B5): supportsSessionPin
  // (Claude → deterministic --session-id) and supportsResume (agents → --resume).
  const caps = createAdapter(toolPreset).capabilities();
  if ((caps.supportsResume || caps.supportsSessionPin) && sessionId) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const alreadyHasSession = /--resume\b|--session\b/.test(finalCommand);
    // Only act on a genuine UUID: the CLI requires a real UUID. A synthetic tracking
    // id (e.g. "claude-code-session-<hex>") is NOT pinnable/resumable — launch bare.
    if (!alreadyHasSession && UUID_RE.test(sessionId)) {
      // FRESH pinned launch (spec §9): pin the orchestrator-generated id via
      // --session-id. Otherwise re-attach a prior session via --resume.
      const flag = isFreshPin && caps.supportsSessionPin ? "--session-id" : "--resume";
      finalCommand = `${finalCommand} ${flag} ${sessionId}`;
    }
  }
  return finalCommand;
}

/**
 * Add or strip the adapter's OWN permission-bypass flag on a command string per the
 * target mode. The single choke point used by the constructor AND setPermissionsMode,
 * so the add/remove paths always agree on which flag string to touch. Custom (and any
 * adapter whose bypassFlag() is null) is left untouched. B2 fix: Codex/agy get their
 * own flag, NOT Claude's Anthropic-only --dangerously-skip-permissions.
 */
function applyBypassFlag(
  shellCmd: string,
  adapter: AgentAdapter,
  mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only"
): string {
  const flag = adapter.bypassFlag();
  if (!flag) return shellCmd;
  if (mode === "Full Auto") {
    return shellCmd.includes(flag) ? shellCmd : `${shellCmd} ${flag}`;
  }
  return shellCmd.replace(` ${flag}`, "");
}


/**
 * Append `chunk` to a raw display-backfill buffer, keeping at most the most
 * recent `max` characters. Pure. Unlike the model-bound outputBuffer this keeps
 * escape sequences INTACT (no ANSI stripping) — xterm needs the raw bytes to
 * reconstruct colors/cursor on a freshly-opened pane. The cap is by length so
 * the buffer cannot grow unbounded; xterm owns the authoritative live scrollback.
 */
export function appendRawCapped(existing: string, chunk: string, max: number): string {
  const combined = existing + chunk;
  return combined.length > max ? combined.slice(combined.length - max) : combined;
}

export function stripAnsiSequences(text: string): string {
  // Matches ANSI color/style escape sequences
  const ansiEscape = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  return text.replace(ansiEscape, '');
}

/**
 * Redacts known secret patterns from terminal output before it is sent to any
 * model-bound sink (Gemini Live session, summarizer, history fallback).
 *
 * Redaction is ADDITIVE and runs AFTER ANSI stripping. It is a pure function
 * with no side-effects or state. Structured patterns (JWT, PEM, AKIA, AIza,
 * GitHub/Slack tokens) are matched before the generic key=value catch-all so
 * the more specific labels appear in the replacement token.
 */
export function redactSecrets(text: string): string {
  // 1. PEM private-key blocks (multiline, dot-all). The optional algorithm prefix
  //    (RSA/EC/OPENSSH/DSA…) means this also matches bare PKCS#8 "BEGIN PRIVATE KEY".
  text = text.replace(
    /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
    "[REDACTED:private-key]"
  );

  // 2. JWTs: three base64url segments separated by dots
  text = text.replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    "[REDACTED:jwt]"
  );

  // 3. AWS access key IDs
  text = text.replace(
    /\bAKIA[0-9A-Z]{16}\b/g,
    "[REDACTED:aws-key]"
  );

  // 4. AWS secret access key assignments
  text = text.replace(
    /\baws_secret_access_key\s*[=:]\s*["\']?([A-Za-z0-9/+]{40})["\']?/gi,
    "aws_secret_access_key=[REDACTED:aws-key]"
  );

  // 5. Google API keys
  text = text.replace(
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    "[REDACTED:google-api-key]"
  );

  // 6. GitHub tokens (ghp_, gho_, ghs_, ghr_)
  text = text.replace(
    /\bgh[posr]_[A-Za-z0-9]{36,}\b/g,
    "[REDACTED:github-token]"
  );

  // 7. Slack tokens
  text = text.replace(
    /\bxox[baprs]-[A-Za-z0-9-]+/g,
    "[REDACTED:slack-token]"
  );

  // 8. Generic env/secret assignments — redact VALUE only, keep key name
  //    Matches: api_key=secret, TOKEN: "abc123", password=\'hunter2\'
  text = text.replace(
    /\b(api[_-]?key|secret|token|password|passwd|bearer|access[_-]?key)\b(\s*[=:]\s*)["\']?([^\s"\']{6,})["\']?/gi,
    (_match: string, key: string, sep: string, _val: string) => `${key}${sep}[REDACTED:secret]`
  );

  return text;
}

/**
 * Secret classification for a COMPOSED PROMPT before it is delivered to a pane (director
 * posture 2026-06-01: "prompts must never contain secrets"). Unlike redactSecrets (which
 * scrubs OUTPUT bound for the model), this CLASSIFIES a candidate prompt by confidence so the
 * delivery path can BLOCK high-confidence leaks and WARN on ambiguous ones — never silently
 * mutate the verbatim prompt the PTY needs.
 *
 *   - high: recognized secret FORMATS (private key, JWT, AWS/Google/GitHub/Slack keys). These
 *     are near-certain leaks -> the delivery path hard-blocks.
 *   - low:  ambiguous "key = value" assignments (api_key=…, token:…). Could be a real secret or
 *     an innocuous token-shaped string -> the delivery path delivers WITH A WARNING.
 *
 * Pure, no side effects. `labels` lists the matched detector names for operator-facing messages.
 */
export type SecretConfidence = "none" | "low" | "high";
export interface SecretScan {
  confidence: SecretConfidence;
  labels: string[];
}
const HIGH_CONFIDENCE_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/, "private-key"],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, "jwt"],
  [/\bAKIA[0-9A-Z]{16}\b/, "aws-access-key-id"],
  [/\baws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+]{40})["']?/i, "aws-secret-key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "google-api-key"],
  [/\bgh[posr]_[A-Za-z0-9]{36,}\b/, "github-token"],
  [/\bxox[baprs]-[A-Za-z0-9-]+/, "slack-token"],
];
const LOW_CONFIDENCE_SECRET_PATTERN =
  /\b(api[_-]?key|secret|token|password|passwd|bearer|access[_-]?key)\b\s*[=:]\s*["']?([^\s"']{6,})["']?/i;

export function classifySecrets(text: string): SecretScan {
  const labels: string[] = [];
  for (const [re, label] of HIGH_CONFIDENCE_SECRET_PATTERNS) {
    if (re.test(text)) labels.push(label);
  }
  if (labels.length > 0) return { confidence: "high", labels };
  if (LOW_CONFIDENCE_SECRET_PATTERN.test(text)) return { confidence: "low", labels: ["generic-assignment"] };
  return { confidence: "none", labels: [] };
}

/**
 * Issue B: default gap (ms) between writing a submitted command's BODY and its terminating CR, so a
 * ConPTY-hosted TUI (Claude Code) reads the CR as a DISCRETE Enter keypress rather than absorbing it
 * into a paste burst. A combined `body + "\r"` write submits SHORT prompts fine, but for longer /
 * multi-clause instructions Claude's paste-burst detector treats the whole chunk (incl. the trailing
 * CR) as pasted text, so the CR lands as a literal newline in the composer and the prompt sits
 * staged-but-unsubmitted (reproduced via smoke:claude with a ~280-char prompt). 0 disables the gap
 * (synchronous two-write). Override via JANUS_PTY_SUBMIT_DELAY_MS.
 */
const DEFAULT_PTY_SUBMIT_DELAY_MS = (() => {
  const n = Number(process.env.JANUS_PTY_SUBMIT_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 20;
})();

export class UniversalTerminal {
  public terminalId: string;
  public cwd: string;
  public shellCmd: string;
  // WS-C: the active PTY transport (node-pty preferred, legacy fallback).
  private transport: PtyTransport | null = null;
  // G3: stdin/TTY readiness gate. A freshly spawned ConPTY child has not yet
  // attached its stdin reader, so the earliest writeInput() bytes are lost and the
  // agent CLI prints "Warning: no stdin data received in 3s". We buffer input until
  // the child proves itself ready (first onData) or a short fallback timer fires.
  private spawnReady = false;
  private pendingInput: string[] = [];
  private readyFallbackTimer: NodeJS.Timeout | null = null;
  private static readonly READY_FALLBACK_MS = 750;
  // Issue B: gap (ms) between writing a submitted command's BODY and its terminating CR (see
  // deliverSubmit). Default from env via DEFAULT_PTY_SUBMIT_DELAY_MS; tests set it to 0 for
  // deterministic synchronous byte assertions. submitChain serializes the (body, gap, CR) pairs so
  // rapid back-to-back submits stay ordered body,CR,body,CR instead of interleaving body,body,CR,CR.
  private submitEnterDelayMs = DEFAULT_PTY_SUBMIT_DELAY_MS;
  private submitChain: Promise<void> = Promise.resolve();
  // Injectable spawn seam (tests inject a fake transport; prod uses node-pty/legacy).
  private transportFactory: typeof createPtyTransport = createPtyTransport;
  public outputBuffer: string[] = [];
  public maxBufferLines = 100;
  // Push-observation delta cursor. `totalLines` is monotonic (never decremented by
  // the buffer cap splice); `modelCursor` is the absolute line index the model has
  // consumed up to. Together they yield only-new-since-last-read deltas.
  public totalLines = 0;
  private modelCursor = 0;
  // PTY grid, kept in sync with the operator's xterm viewport via resize(). The
  // program inside wraps lines to THIS width, so it must match the display or
  // wrapping looks wrong. Defaults match the node-pty spawn defaults (80x30).
  public cols = 80;
  public rows = 30;
  // Raw display-backfill buffer (escape sequences intact). Distinct from the
  // ANSI-stripped, line-capped `outputBuffer` (model lane). Seeds xterm when a
  // pane is (re)opened so scrollback renders with correct colors/layout.
  private rawBackfill = "";
  public maxRawBackfillChars = 200_000;
  public status: "Running" | "Exited" | "Idle" = "Idle";
  public permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  public toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  // The per-CLI adapter (multi-cli spec §4). Owns every preset-conditional decision
  // (bypass flag, launch/resume argv, live mode-switch disposition, capabilities),
  // retiring the inline `if (toolPreset !== "Custom")` branches (B5) and correcting
  // B2 (Codex/agy no longer inherit Claude's Anthropic-only skip flag).
  public adapter: AgentAdapter;
  public sessionId: string;
  // True until the FIRST launch of a freshly-pinned session (spec §9): drives the
  // start() decision to emit --session-id <uuid> (pin) vs --resume <uuid> (re-attach).
  // Set by the ctor (fresh-pin true; supplied/resume false) and flipped to false once
  // start() has launched, so an in-process restart (stop(); start()) resumes correctly.
  private sessionIsFresh = false;
  public onOutput: ((terminalId: string, chunk: string) => void) | null = null;
  public onIdle?: (terminalId: string) => void;
  // Phase 1 "ears": the symmetric BEGINNING edge to onIdle. Fires once when the pane
  // transitions INTO Running from a non-Running status (an input kick or an authoritative
  // busy probe). Unlike onIdle it is NOT gated on sawWorkSinceIdle — a beginning has no
  // spurious-done concern, and the PaneSignalBus debounce coalesces a chatty edge.
  public onRunning?: (terminalId: string) => void;
  // Conservative Phase 2: the HUMBLE pre-idle "cooking…" edge. Fires exactly once when the idle
  // debounce timer is armed (the existing 'last output -> waiting out quiescence' window) while
  // the pane is STILL Running — i.e. it OBSERVES a window the state machine already has, adding
  // NO new idle decision. Cancelled/reset when work resumes (clearIdleTimer / Running edge) or
  // once true Idle is declared. Distinct from onIdle (which is the authoritative completion edge).
  public onQuiescing?: (terminalId: string) => void;
  // True while inside one armed pre-idle window. Drives the once-guard for onQuiescing (fire only
  // on the false->armed transition; the fallback path re-arms on every output chunk) and the
  // UI's humble "cooking…" overlay (server snapshot reads this).
  public quiescing = false;
  // B1 (async spawn): fired ONCE when the child actually attaches its PTY (first onData /
  // markSpawnReady) — the phase-2 "ready" source. A degraded-Exited spawn never reaches
  // markSpawnReady, so it correctly never emits a false "ready".
  public onReady?: (terminalId: string) => void;
  public projectId: string;
  private idleTimer: NodeJS.Timeout | null = null;
  private cachedCpu = 0.0;
  // Silence-to-idle timeout (ms). Honors advanced.idleTimeoutMs; defaults to the
  // documented 2000ms rather than the previously hardcoded 1000ms (BUG-034).
  public idleTimeoutMs = 2000;
  // Conservative Phase 2 safeguard (fact [F]): a modestly LARGER silence-to-idle timeout used
  // ONLY for interactive_cli (agent) panes on the fallback/quiescence path, where quiet != done.
  // Defaults a touch above the shell idleTimeoutMs so a brief agent pause is less likely to read
  // as premature 'done'. Shell panes ignore this and keep idleTimeoutMs. Setting-overridable.
  public agentIdleTimeoutMs = 3500;

  // WS-C status-detection state (design §5).
  public statusProbe: StatusProbe;
  private probeTimer: NodeJS.Timeout | null = null;
  private probeIntervalMs = 500;
  // In-flight teardown promise. stop() is idempotent: a re-entrant call returns the
  // same promise so the SIGTERM→SIGKILL escalation, a double stop(), and the
  // onExit-driven resolve can never drive node-pty's ConPTY teardown more than once
  // (the conout-worker double-dispose that aborts at src\win\async.c:76).
  private _stopping: Promise<void> | null = null;
  public lastStatusChangeAt: number = Date.now();
  public lastCommand = "";
  // runtime_type drives the prompt-regex gating (I4): Custom preset ⇒ "shell";
  // agent CLIs (Claude Code/Codex/Antigravity) ⇒ "interactive_cli".
  public runtimeType: RuntimeType;
  // The PTY shell/agent root pid captured at start for the probe.
  private shellPid: number | undefined;
  // True if the active transport is node-pty (vs the legacy fallback). When this
  // is false the authoritative process-tree probe is unvalidated (the legacy path
  // roots the tree at `script`/`cmd.exe`, not a real shell-rooted PTY), so start()
  // swaps in a FallbackProbe and quiescence drives idle instead (design §6, R1).
  public usingNodePty = false;
  // Confidence of the most recent probe (drives output→idle behavior).
  private lastConfidence: "authoritative" | "fallback" = "fallback";
  // Whether genuine work (input, output, or a running-child probe) has been seen
  // since the last Idle. Gates onIdle so a freshly-spawned interactive shell
  // settling to its prompt does not fire a spurious "done" (I1).
  private sawWorkSinceIdle = false;

  constructor(
    terminalId: string,
    cwd: string,
    shellCmd: string,
    toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom" = "Custom",
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop",
    sessionId = "",
    projectId = "default_project",
    statusProbe?: StatusProbe,
    transportFactory?: typeof createPtyTransport
  ) {
    this.terminalId = terminalId;
    this.cwd = cwd;
    this.toolPreset = toolPreset;
    this.permissionsMode = permissionsMode;
    this.projectId = projectId;
    this.runtimeType = toolPreset === "Custom" ? "shell" : "interactive_cli";
    // The pane's per-CLI adapter (spec §4). All preset-conditional decisions below
    // delegate here instead of branching inline on the preset string.
    this.adapter = createAdapter(toolPreset);
    // Injectable for tests; defaults to the platform-selected probe (design §2.0).
    this.statusProbe = statusProbe ?? selectProbe();
    // G3: injectable spawn seam (optional + last so no existing call site changes).
    if (transportFactory) this.transportFactory = transportFactory;

    // Flag injection: the adapter owns its OWN bypass flag (Claude/agy
    // --dangerously-skip-permissions; Codex --dangerously-bypass-approvals-and-sandbox;
    // Custom none). B2 fix: we no longer hardcode Claude's flag for every agent.
    this.shellCmd = applyBypassFlag(shellCmd, this.adapter, permissionsMode);

    if (sessionId) {
      // A supplied id means we are RESUMING a prior session (spec §9): the launch
      // re-attaches via --resume <uuid>, never a fresh --session-id pin.
      this.sessionId = sessionId;
      this.sessionIsFresh = false;
    } else if (this.adapter.capabilities().supportsSessionPin) {
      // B3 fix (spec §9): Claude pins a DETERMINISTIC, orchestrator-generated UUID
      // and passes it as --session-id at first launch. No stdout scrape — Claude
      // never prints the id. start() emits --session-id <uuid> while sessionIsFresh.
      this.sessionId = this.adapter.generateSessionId() ?? "";
      this.sessionIsFresh = true;
    } else if (this.adapter.capabilities().supportsResume) {
      // Codex/agy have no pin flag → capture the id post-spawn. The synthetic
      // "<tool>-session-<hex>" id is for internal tracking/display ONLY; it is never
      // passed to --resume (which requires a real UUID). Real ids arrive later via
      // captureSessionId(); start() guards on UUID format before appending --resume.
      const toolLower = toolPreset.toLowerCase().replace(/\s+/g, "-");
      const randomId = Math.random().toString(16).substring(2, 10);
      this.sessionId = `${toolLower}-session-${randomId}`;
      this.sessionIsFresh = false;
    } else {
      this.sessionId = "";
      this.sessionIsFresh = false;
    }
  }

  public setPermissionsMode(mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only") {
    this.permissionsMode = mode;
    // Mutate the NEXT spawn's command string via the adapter's OWN bypass flag.
    // (This only affects the next launch — bead 1y8/applyPaneMode reaches a LIVE
    // process; that is P4 and out of this wave's scope.)
    this.shellCmd = applyBypassFlag(this.shellCmd, this.adapter, mode);
  }

  get contextSize(): number {
    return this.outputBuffer.join('\n').length;
  }

  private checkForSessionId(text: string) {
    // B3 fix (spec §9): route session capture through the adapter. A pinned-session
    // CLI (Claude) returns its DETERMINISTIC UUID and never scrapes stdout — Claude
    // never prints the id, so the legacy scrape below would only ever match noise and
    // CLOBBER the pinned uuid, breaking --resume. captureSessionId(ptyOutput) returns
    // the pinned id for Claude; we adopt it and short-circuit the scrape.
    if (this.adapter.capabilities().supportsSessionPin) {
      const pinned = this.adapter.captureSessionId({ ptyOutput: text, cwd: this.cwd });
      if (pinned) this.sessionId = pinned;
      return; // never run the free-form scrape against a pinned-session CLI
    }
    if (this.adapter.capabilities().supportsResume) {
      // Codex/agy do NOT print a resumable id in stdout. Route capture through the adapter's
      // on-disk store instead — agy reads the newest conversations/<uuid>.db that appeared
      // since spawn (bead 1h0), so a restart-resume promotion re-attaches the SAME conversation
      // via --conversation=<uuid>. Adopt a real uuid when available; ALWAYS short-circuit the
      // free-form matchers below (TUI noise would clobber the captured/synthetic id).
      const captured = this.adapter.captureSessionId({ ptyOutput: text, cwd: this.cwd });
      if (captured) this.sessionId = captured;
      return;
    }
    const matchers = [
      /(?:session[_-]?id|session)[ :="']{1,3}([a-zA-Z0-9_\-]{8,})/i,
      /(?:claude|codex|antigravity)[_-]session[_-]?([a-zA-Z0-9_\-]+)/i,
      /Session established:[ ]*([a-zA-Z0-9_\-]+)/i,
      /Session ID:[ ]*([a-zA-Z0-9_\-]+)/i,
      /session_id[ :="']{1,3}([a-zA-Z0-9_\-]{6,})/i
    ];
    for (const regex of matchers) {
      const match = text.match(regex);
      if (match && match[1]) {
        this.sessionId = match[1];
        break;
      }
    }
  }

  /**
   * WS-C status state machine (design §3). The DECISION is the pure
   * `decideStatus()`; this method owns the side effects (timers, status stamp,
   * onIdle edge). Busy-biased (I2): a positive probe wins; Idle requires the
   * authoritative probe to report no running child (debounced), or — in fallback
   * mode — quiescence + a narrowed prompt for shell panes (I4/I5).
   */
  private applyStatusEvent(
    event:
      | { kind: "output"; text: string }
      | { kind: "probe"; probe: ProbeResult }
      | { kind: "input" }
      | { kind: "idleTimer" }
  ) {
    if (this.status === "Exited") return;

    // Track the confidence of the latest probe so output/idleTimer events know
    // which mode (authoritative vs fallback) drives idle.
    if (event.kind === "probe") {
      this.lastConfidence = event.probe.confidence;
    }

    // Record whether genuine work occurred (gates the onIdle edge below). Raw
    // output is deliberately EXCLUDED: a shell rendering its prompt at startup
    // emits output but is not a running command, so counting it would fire a
    // spurious "done". Work = an input was sent, or an authoritative probe saw a
    // running child.
    if (
      event.kind === "input" ||
      (event.kind === "probe" &&
        event.probe.confidence === "authoritative" &&
        event.probe.hasRunningChild)
    ) {
      this.sawWorkSinceIdle = true;
    }

    const recentTail = stripAnsiSequences(this.getRecentOutput(5));
    const result = decideStatus({
      event,
      currentStatus: this.status as MachineStatus,
      runtimeType: this.runtimeType,
      recentTail,
      confidence: this.lastConfidence,
      idleTimerArmed: this.idleTimer !== null,
    });

    // P0-2: in fallback mode there is no authoritative busy probe, so genuine
    // work driven purely by OUTPUT (the legacy script/cmd.exe transport, and every
    // interactive_cli pane after the P0-1 gate whose turns are not all driven via
    // writeInput) would otherwise reach the idleTimer with sawWorkSinceIdle=false
    // and the onIdle edge would be suppressed — worse than today (violates I5).
    // Count an output-driven Running transition (from a non-Running state) in
    // fallback mode as real work so the eventual Running->Idle edge fires onIdle.
    if (
      event.kind === "output" &&
      this.lastConfidence === "fallback" &&
      result.status === "Running" &&
      this.status !== "Running"
    ) {
      this.sawWorkSinceIdle = true;
    }

    if (result.clearIdleTimer) {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      // Conservative Phase 2: work resumed (the state machine cancelled the pre-idle window) —
      // the pane is no longer "wrapping up". Clear the humble cooking overlay so a stale label
      // can't linger (self-correcting: the next quiescence honestly re-arms it). No signal is
      // emitted on cancel; the Running edge (onRunning) / next snapshot already speak for it.
      this.quiescing = false;
    }
    if (result.armIdleTimer) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      // C4: in authoritative mode the idle debounce must outlast at least one
      // probe interval, otherwise an idleTimeoutMs < probeIntervalMs can fire
      // "done" before the next authoritative tick has a chance to re-confirm a
      // reappearing child — a spurious onIdle. Floor the effective debounce at
      // probeIntervalMs there. Fallback mode is pure quiescence, so it keeps the
      // configured timeout verbatim — except interactive_cli (agent) panes, which
      // use the modestly larger agentIdleTimeoutMs so a brief mid-turn pause is less
      // likely to read as premature 'done' (Conservative Phase 2 safeguard, fact [F]).
      const fallbackIdleMs =
        this.runtimeType === "interactive_cli" ? this.agentIdleTimeoutMs : this.idleTimeoutMs;
      const effectiveIdleMs =
        this.lastConfidence === "authoritative"
          ? Math.max(this.idleTimeoutMs, this.probeIntervalMs)
          : fallbackIdleMs;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.applyStatusEvent({ kind: "idleTimer" });
      }, effectiveIdleMs);
      // Conservative Phase 2: this is the pre-idle "cooking…" edge. The state machine just
      // armed the debounce while the pane is still Running — fire onQuiescing exactly once on
      // the false->armed transition (the fallback path re-arms on every chunk, so the once-guard
      // prevents flapping; the PaneSignalBus 3s debounce is a second backstop on the model leg).
      // This adds NO new judgement about doneness — it only observes the window idle already owns.
      if (!this.quiescing) {
        this.quiescing = true;
        if (this.onQuiescing) this.onQuiescing(this.terminalId);
      }
    }

    if (result.status !== this.status) {
      // Phase 1 "ears": capture the PRIOR status so the Running edge is exact. A transition
      // INTO Running from any non-Running status (Idle or Exited won't reach here — Exited
      // returns early at the top of applyStatusEvent) is a genuine "beginning" — fire
      // onRunning exactly once on the edge. Running->Running probe/output ticks never reach
      // this block (result.status === this.status), so there is no re-fire. NOT gated on
      // sawWorkSinceIdle (unlike onIdle): a beginning has no spurious-done risk.
      const prevStatus = this.status;
      this.status = result.status;
      this.lastStatusChangeAt = Date.now();
      if (result.status === "Running" && prevStatus !== "Running" && this.onRunning) {
        this.onRunning(this.terminalId);
      }
    }
    if (result.fireOnIdle) {
      // Only a Running→Idle edge that followed genuine work is a real "done".
      const realDone = this.sawWorkSinceIdle;
      this.sawWorkSinceIdle = false;
      if (realDone && this.onIdle) {
        this.onIdle(this.terminalId);
      }
    }
  }

  /** Run one probe tick and feed it through the state machine. */
  private runProbeTick() {
    if (this.status === "Exited") return;
    if (this.shellPid === undefined) return;
    // P0-1: interactive_cli (agent) panes have no resting-shell signal — an agent
    // at its prompt is process-indistinguishable from an agent mid-turn (both are
    // one blocked process with no foreground child-shell). The busy-biased
    // authoritative probe would therefore report them "Running" forever and never
    // fire onIdle. Never run the authoritative probe for them; downgrade to a
    // fallback probe so output quiescence drives idle (decideStatus fallback path).
    if (this.runtimeType === "interactive_cli") {
      this.applyStatusEvent({ kind: "probe", probe: { hasRunningChild: false, confidence: "fallback" } });
      return;
    }
    let probe: ProbeResult;
    try {
      probe = this.statusProbe.probe(this.shellPid);
    } catch {
      probe = { hasRunningChild: false, confidence: "fallback" };
    }
    this.applyStatusEvent({ kind: "probe", probe });
  }

  private clearProbeTimer() {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private loadScrollback() {
    const file = `.janus_scrollback_${this.terminalId}.log`;
    try {
      if (fs.existsSync(file)) {
        const data = fs.readFileSync(file, "utf-8");
        const lines = data.split(/\r?\n/).filter(l => l.trim() !== "");
        this.outputBuffer = lines.slice(-this.maxBufferLines);
      }
    } catch (e) {
      console.warn("Failed to load scrollback:", e);
    }
  }

  // Ordered async scrollback writer. The previous per-chunk fs.appendFileSync ran on the
  // SAME event loop as the Gemini voice callback, so every PTY output burst injected a
  // synchronous disk write that widened the pane-open stall (B2). Writes now queue on a
  // single in-flight promise-chain — async (off the hot path) yet strictly ordered, so
  // appends can't race or reorder. flushScrollback() awaits the chain for durability.
  private scrollbackChain: Promise<void> = Promise.resolve();

  private appendScrollback(chunk: string) {
    const file = `.janus_scrollback_${this.terminalId}.log`;
    this.scrollbackChain = this.scrollbackChain.then(async () => {
      try {
        await fs.promises.appendFile(file, chunk);
        const stat = await fs.promises.stat(file);
        if (stat.size > 1024 * 512) { // 512KB limit
          const data = await fs.promises.readFile(file, "utf-8");
          const lines = data.split(/\r?\n/).filter(l => l.trim() !== "");
          const pruned = lines.slice(-this.maxBufferLines).join("\n") + "\n";
          await fs.promises.writeFile(file, pruned, "utf-8");
        }
      } catch {
        // best-effort: scrollback is a convenience cache, not the ledger
      }
    });
  }

  /** Await all pending async scrollback writes. Called on teardown so a restarted pane
   *  (stop() -> start() -> loadScrollback) observes everything written before the stop. */
  public flushScrollback(): Promise<void> {
    return this.scrollbackChain;
  }

  start() {
    const finalCommand = buildLaunchCommand(this.shellCmd, this.toolPreset, this.sessionId, this.sessionIsFresh);
    // After the first launch the pinned session EXISTS on disk → a subsequent
    // in-process restart (stop(); start()) must re-attach via --resume, not re-pin.
    this.sessionIsFresh = false;

    // Populate historical output buffer from persistent scrollback log
    this.loadScrollback();

    // Build the child env, stripping nested-agent markers. If the SERVER itself was
    // launched from inside a Claude Code session (CLAUDECODE=1 etc. inherited via
    // process.env), a pane's `claude` would detect nesting and exit immediately —
    // so a pane never becomes a live session. Remove those markers so every pane
    // launches as a clean, top-level agent regardless of how the server was started.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_ENTRYPOINT;
    delete childEnv.CLAUDE_CODE_SSE_PORT;
    delete childEnv.CLAUDE_AGENT_SDK_VERSION;

    // WS-C: spawn through the PtyTransport (node-pty preferred, legacy fallback).
    // QW2: pty.spawn throws SYNCHRONOUSLY on native/ENOENT failures and propagates
    // out through createPtyTransport. Guard the single spawn chokepoint so a failed
    // spawn DEGRADES (status="Exited") instead of crashing the process. Mirror the
    // transport.onExit teardown below (no new "Error" status; reuse "Exited").
    let transport: PtyTransport;
    let usingNodePty: boolean;
    try {
      ({ transport, usingNodePty } = this.transportFactory(finalCommand, {
        cwd: this.cwd,
        env: childEnv,
        cols: this.cols,
        rows: this.rows,
      }));
    } catch (e) {
      console.warn(
        `[terminal] PTY spawn failed for ${this.terminalId} — pane degraded to Exited (not a crash):`,
        e
      );
      // Half-assigned-state hazard: on first boot this.transport is null; on /restart
      // it is a STALE dead transport and shellPid the old pid — explicitly reset both.
      this.transport = null;
      this.shellPid = undefined;
      this.status = "Exited";
      this.lastStatusChangeAt = Date.now();
      this.clearProbeTimer();
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      if (this.readyFallbackTimer) {
        clearTimeout(this.readyFallbackTimer);
        this.readyFallbackTimer = null;
      }
      return;
    }
    // B1 (async spawn): on a FIRST async spawn the operator may have already issued a follow-up
    // command (writeInput) BEFORE the deferred start() ran — it sits in pendingInput. Snapshot it so
    // the reset below preserves it instead of dropping it on the floor.
    //
    // The `transport === null` test does NOT distinguish first-spawn from /restart — stop() nulls
    // this.transport before restart calls start(), so BOTH paths enter here with transport === null.
    // That is fine: this carve-out is safe in both cases because pendingInput is only ever non-empty
    // in the genuine first-spawn-before-start window. After ANY successful boot, markSpawnReady
    // drains pendingInput to []; so on /restart the slice is [] (nothing stale carried), while a
    // command typed during a stop→start gap is legitimately preserved and delivered to the new
    // process. (Empirically confirmed: transport===null, spawnReady===true, pendingInput===[] at
    // restart entry.) If you ever need to truly branch on first-spawn, key on an explicit flag — not
    // on transport.
    const preSpawn = this.transport ? [] : this.pendingInput.slice();
    this.transport = transport;
    this.usingNodePty = usingNodePty;
    // G3: re-enter the gated state for THIS (re)spawn — a /restart must not inherit
    // a stale spawnReady===true or a queue from the prior process. B1: re-append the
    // first-spawn pre-spawn snapshot so live follow-up input is preserved (respawn: empty).
    this.spawnReady = false;
    this.pendingInput = preSpawn;
    this.armReadyFallback();
    // C2: the legacy (non-node-pty) transport roots the process tree at `script`
    // (Linux/macOS) or a separate `cmd.exe` (Windows), whose tree shape is NOT what
    // the authoritative probe was validated against. Degrade to quiescence-driven
    // idle on that path rather than running an unvalidated authoritative probe.
    if (!usingNodePty) {
      this.statusProbe = new FallbackProbe();
    }
    // Capture the PTY root pid for the probe (design §5).
    this.shellPid = transport.pid;

    // Set initial running state and stamp the transition.
    if (this.status !== "Exited") {
      this.status = "Running";
      this.lastStatusChangeAt = Date.now();
    }

    // Merged stdout/stderr stream from the transport.
    transport.onData((decoded: string) => {
      // G3: first data out == the child is alive and has attached its PTY. Flush
      // any queued input BEFORE this chunk advances the status machine, so our
      // queued command causally precedes the child's response to it.
      if (!this.spawnReady) this.markSpawnReady();
      this.appendScrollback(decoded);
      // Display lane: keep raw bytes (escape sequences intact) for xterm backfill.
      this.rawBackfill = appendRawCapped(this.rawBackfill, decoded, this.maxRawBackfillChars);
      this.applyStatusEvent({ kind: "output", text: decoded });
      this.checkForSessionId(decoded);
      if (this.onOutput) {
        this.onOutput(this.terminalId, decoded);
      }
      const cleanLines = stripAnsiSequences(decoded).split(/\r?\n/).filter((l: string) => l.trim() !== '');
      this.outputBuffer.push(...cleanLines);
      this.totalLines += cleanLines.length;
      if (this.outputBuffer.length > this.maxBufferLines) {
        this.outputBuffer.splice(0, this.outputBuffer.length - this.maxBufferLines);
      }
    });

    // Lifecycle (Tier 0, design §3) — kept verbatim in semantics: a real exit
    // maps to status="Exited" and tears down the probe/idle timers.
    transport.onExit(() => {
      this.status = "Exited";
      this.lastStatusChangeAt = Date.now();
      this.clearProbeTimer();
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      // G3: cancel the readiness fallback so it never flushes into a dead transport.
      if (this.readyFallbackTimer) {
        clearTimeout(this.readyFallbackTimer);
        this.readyFallbackTimer = null;
      }
    });

    // Run the ~500ms process-state probe (Tier A, design §3).
    this.clearProbeTimer();
    this.probeTimer = setInterval(() => this.runProbeTick(), this.probeIntervalMs);
    if (this.probeTimer.unref) this.probeTimer.unref();
  }

  /** Sync the PTY grid to the operator's xterm viewport. Idempotent; crash-safe
   *  (transport.resize is guarded) so a resize after process exit is a harmless
   *  no-op. Dims are stored even before/without a live transport so the next
   *  start() spawns at the right size. */
  resize(cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols < 1 || rows < 1) return;
    this.cols = Math.floor(cols);
    this.rows = Math.floor(rows);
    if (this.transport) {
      this.transport.resize(this.cols, this.rows);
    }
  }

  /** Raw display backfill (escape sequences intact) seeding xterm on (re)open. */
  getRawBackfill(): string {
    return this.rawBackfill;
  }

  /** Arm the belt-and-suspenders fallback: if no data arrives, still flush soon so a
   *  silent child does not strand queued input. unref'd so it never holds the loop. */
  private armReadyFallback() {
    if (this.readyFallbackTimer) clearTimeout(this.readyFallbackTimer);
    this.readyFallbackTimer = setTimeout(
      () => this.markSpawnReady(),
      UniversalTerminal.READY_FALLBACK_MS
    );
    if (this.readyFallbackTimer.unref) this.readyFallbackTimer.unref();
  }

  /** Mark the child ready and flush any queued input IN ORDER. Idempotent. */
  private markSpawnReady() {
    if (this.spawnReady) return;
    this.spawnReady = true;
    if (this.readyFallbackTimer) {
      clearTimeout(this.readyFallbackTimer);
      this.readyFallbackTimer = null;
    }
    const queued = this.pendingInput;
    this.pendingInput = [];
    for (const command of queued) {
      this.deliverSubmit(command);
    }
    // B1 (async spawn): the child has attached its PTY — emit the phase-2 "ready" edge. Guarded by
    // the early `if (this.spawnReady) return` above, so this fires AT MOST ONCE per (re)spawn. Wrapped
    // so a faulty subscriber can never break the input-flush / never-throw contract.
    try {
      this.onReady?.(this.terminalId);
    } catch (e) {
      console.warn(`[terminal] onReady subscriber threw (ignored):`, e);
    }
  }

  writeInput(command: string) {
    // Record the most recent command and optimistically mark Running — an input
    // means a turn is starting (Tier A kick, design §5).
    this.lastCommand = command;
    this.applyStatusEvent({ kind: "input" });
    // B1 (async spawn): the PTY now boots on a deferred tick, so writeInput can land BEFORE start()
    // assigns a transport (an "open a pane then run X" follow-up). Buffer it onto the SAME
    // pendingInput queue markSpawnReady drains in order, instead of dropping it on the floor.
    if (!this.transport) { this.pendingInput.push(command); return; }
    // G3: a freshly spawned ConPTY child has not attached its stdin reader yet, so
    // a synchronous write here is dropped on the floor. Queue the RAW command until
    // spawn-ready (first onData / fallback timer), then flush in submission order
    // through deliverSubmit (so the queued path gets the same body/Enter split).
    if (this.spawnReady) {
      this.deliverSubmit(command);
    } else {
      this.pendingInput.push(command);
    }
  }

  /**
   * Issue B: submit a command by writing the BODY and the terminating ENTER as TWO writes — the CR
   * after `submitEnterDelayMs` — so a ConPTY-hosted Ink TUI (Claude Code) registers the CR as a
   * DISCRETE Enter keypress instead of absorbing `body + "\r"` as a single PASTE burst. A combined
   * write submitted SHORT prompts fine, but for longer / multi-clause instructions Claude's
   * paste-burst detector treated the whole chunk (incl. the trailing CR) as pasted text, so the CR
   * became a literal newline in the multiline composer and the prompt sat staged-but-unsubmitted
   * (the operator's "I can see the terminal but it's not doing anything"; reproduced via smoke:claude
   * with a ~280-char prompt). CR (\r), not LF — a TUI agent submits on Enter (carriage return); LF
   * only inserts a newline (G1).
   *
   * When the gap is 0 (tests / opt-out) the two writes are SYNCHRONOUS and ordering is trivial. When
   * > 0 the (body, CR) pairs are SERIALIZED through `submitChain` so multiple rapid submits stay
   * ordered body,CR,body,CR rather than interleaving as body,body,CR,CR.
   */
  private deliverSubmit(command: string): void {
    if (!this.transport) return;
    if (this.submitEnterDelayMs <= 0) {
      this.transport.write(command);
      this.transport.write("\r");
      return;
    }
    this.submitChain = this.submitChain.then(
      () =>
        new Promise<void>((resolve) => {
          if (!this.transport) { resolve(); return; }
          this.transport.write(command);
          setTimeout(() => {
            if (this.transport) this.transport.write("\r");
            resolve();
          }, this.submitEnterDelayMs);
        }),
    );
  }

  /**
   * Raw control-byte passthrough (multi-cli adapter spec §7) — the sole RAW path. Unlike
   * writeInput/deliverSubmit (SUBMIT semantics: a separate CR, paste-burst split, optimistic
   * Running, history), writeRaw writes the bytes VERBATIM in a single transport.write with NO
   * appended \r and no split. It is the ONE primitive behind the raw-input endpoint and the GUI
   * control-key bar (a Shift+Tab button writes ESC[Z verbatim). No-op on an inert/un-spawned pane
   * (transport === null) — the REST caller surfaces a 409.
   */
  writeRaw(bytes: string): void {
    if (!this.transport) return;
    this.transport.write(bytes);
  }

  getRecentOutput(linesCount = 10): string {
    return this.outputBuffer.slice(-linesCount).join('\n');
  }

  /** Only-new-since-last-read lines (model lane). Advances the model cursor.
   *  `dropped` counts unread lines the buffer cap evicted before this read. */
  consumeDelta(): { lines: string; dropped: number } {
    const bufStart = this.totalLines - this.outputBuffer.length; // absolute idx of buffer[0]
    let from = this.modelCursor;
    let dropped = 0;
    if (from < bufStart) { dropped = bufStart - from; from = bufStart; }
    const lines = this.outputBuffer.slice(from - bufStart).join("\n");
    this.modelCursor = this.totalLines;
    return { lines, dropped };
  }

  public async stop(): Promise<void> {
    // Idempotent FOR ONE teardown: re-entrant stop() (or a stop() racing the onExit-driven
    // teardown) returns the in-flight promise instead of re-killing — node-pty's ConPTY kill()
    // must run at most once per pty or its conout worker double-disposes. The latch is CLEARED
    // once that teardown settles so a later stop() runs a FRESH teardown: a pane can be restarted
    // on the SAME instance (POST /api/terminals/:id/restart does `await term.stop(); term.start()`),
    // after which shutdown / stop-all stage-2 / close_pane must still actually kill the new pty.
    // (Without the reset, every post-restart stop() returned this stale resolved promise and the
    // restarted PTY leaked.)
    if (this._stopping) return this._stopping;
    this._stopping = this._doStop().finally(() => { this._stopping = null; });
    return this._stopping;
  }

  private async _doStop(): Promise<void> {
    // Clear both timers up front so a stopped pane never leaves work alive
    // (prevents the runner from hanging on lingering intervals).
    this.clearProbeTimer();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // G3: cancel the readiness fallback so a stopped pane leaves no timer that could
    // fire a flush into a killed transport.
    if (this.readyFallbackTimer) {
      clearTimeout(this.readyFallbackTimer);
      this.readyFallbackTimer = null;
    }

    const transport = this.transport;
    if (!transport || transport.pid === undefined) {
      this.transport = null;
      return;
    }
    this.transport = null;

    await new Promise<void>((resolve) => {
      let resolved = false;
      // P2: declared BEFORE done() to avoid a temporal-dead-zone ReferenceError if
      // onExit fires synchronously or transport.kill() throws (already-dead pid) —
      // both paths call done() before the timer is assigned below.
      let killTimeout: NodeJS.Timeout | undefined;
      const done = () => {
        if (!resolved) {
          resolved = true;
          if (killTimeout) clearTimeout(killTimeout);
          resolve();
        }
      };

      // Map a real exit/close to resolution; the transport multiplexes onExit.
      transport.onExit(done);

      // SIGTERM → SIGKILL escalation semantics, preserved from the legacy stop().
      try {
        transport.kill("SIGTERM");
      } catch {
        done();
        return;
      }

      killTimeout = setTimeout(() => {
        try {
          transport.kill("SIGKILL");
        } catch {
          // already dead
        }
        done();
      }, 1000);
      if (killTimeout.unref) killTimeout.unref();
    });

    // Windows ConPTY: block until node-pty's delayed conout-worker teardown
    // (a libuv uv_async_t) has fully completed, so a subsequent process.exit
    // (the unit runner's --test-force-exit) can't uv_close() it mid-terminate
    // (the src\win\async.c:76 abort). No-op on POSIX / legacy / stub transports.
    try {
      await transport.drainTeardown?.();
    } catch {
      // best-effort drain
    }

    // Flush queued async scrollback writes so a restart's loadScrollback() sees output
    // written before this stop (the writer is now async/ordered — B2).
    try { await this.scrollbackChain; } catch { /* best-effort */ }
  }
}

export class OrchestratorManager {
  public terminals: Record<string, UniversalTerminal> = {};
  public activeId: string | null = null;
  public ledger: LedgerLike;
  public attentionQueue: AttentionItem[] = [];
  public onOutput: ((terminalId: string, chunk: string) => void) | null = null;
  public onIdle?: (terminalId: string) => void;
  // Phase 1 "ears": the manager-level fan of UniversalTerminal.onRunning (mirrors onIdle).
  // server.ts assigns this to the observe pipeline's onRunning handler.
  public onRunning?: (terminalId: string) => void;
  // Conservative Phase 2: the manager-level fan of UniversalTerminal.onQuiescing (mirrors onIdle).
  // server.ts assigns this to the observe pipeline's onQuiescing handler.
  public onQuiescing?: (terminalId: string) => void;
  // B1 (async spawn): fired AFTER the deferred start() returns (transport assigned OR degraded to
  // Exited). NOT the spawn-ready signal — use onReady for that. onSpawned exists for the fast-fail
  // UI repaint (a degraded pane flips Running->Exited here) and the test flush seam.
  public onSpawned?: (terminalId: string) => void;
  // B1 (async spawn): forwarded from UniversalTerminal.onReady — fires once when the child attaches
  // its PTY (markSpawnReady). The phase-2 "ready" publish source.
  public onReady?: (terminalId: string) => void;
  // wsm-e2e-pinned-5h0 (A-voice): fires once after stopAndArchivePane terminates + archives a pane.
  // server.ts wires it to publish a turn-gated "closed" pane signal — the completion ack that confirms
  // the exit by voice only when it won't talk over the operator (same phase-2 gate as the create ack).
  public onClosed?: (terminalId: string) => void;
  // B1 (async spawn): in-flight deferred starts (one per scheduleStart). flushPendingSpawns() awaits
  // them — the mandatory test/teardown seam so a real ConPTY spawn never outlives the test.
  private pendingStarts = new Set<Promise<void>>();
  public globalPermissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit" = "Inherit";
  public settings!: SystemSettings;
  // BEAD kqy — settings-path anchor. The settings file used to be a BARE relative
  // string (".janus_settings.json"), so loadSettings/saveSettings resolved it against
  // process.cwd(). Launching the server from a cwd other than the repo root therefore
  // silently read a DIFFERENT/missing file -> no Gemini key -> voice dead (CONFIRMED
  // 2026-06-04). Resolve it ONCE at construction via resolveSettingsPath(): honor the
  // JANUS_SETTINGS_PATH env override (a stable, portable anchor that works under both
  // tsx-dev and the bundled dist/server.cjs, where __dirname differs), else fall back
  // to the cwd-relative default for back-compat.
  private settingsFilePath: string = OrchestratorManager.resolveSettingsPath();

  /** Resolve the settings file to an absolute, stable path. JANUS_SETTINGS_PATH wins
   *  (resolved to absolute); otherwise the legacy cwd-relative ".janus_settings.json"
   *  is preserved so a server started from the repo root behaves exactly as before. */
  private static resolveSettingsPath(): string {
    const override = process.env.JANUS_SETTINGS_PATH;
    if (override && override.trim()) {
      return path.resolve(override.trim());
    }
    return ".janus_settings.json";
  }

  /** Public read accessor for the resolved settings file path (test/observability seam). */
  public getSettingsFilePath(): string {
    return this.settingsFilePath;
  }

  private getDefaultSettings(): SystemSettings {
    return {
      server: {
        port: 3000,
        host: "0.0.0.0",
        appUrl: process.env.APP_URL || "http://localhost:3000"
      },
      voiceAi: {
        model: "gemini-3.1-flash-live-preview",
        voice: "Zephyr",
        voiceStyle: "Creative",
        volume: 80,
        speechSpeed: 1.0,
        isMicMuted: false,
        // sa4: unset by default => buildSystemInstruction() falls back to DEFAULT_SYSTEM_PROMPT.
        // This is config (persists to disk via saveSettings), NOT a secret.
        systemPrompt: undefined,
        // BEAD tkd: the should-I-speak silence gate is DEFAULT OFF. Off => speakGate() short-circuits
        // to speak (byte-for-byte today's audio path). Settable via .janus_settings.json; loadSettings
        // shallow-merges voiceAi so a persisted file without this key degrades to false.
        silenceGate: false,
        // BEAD aqx: the Gemini googleSearch grounding tool is DEFAULT OFF. Off => buildVoiceTools()
        // emits ONLY the function-declarations entry (byte-for-byte today's tools array). Settable via
        // .janus_settings.json / Settings UI; loadSettings shallow-merges voiceAi so a persisted file
        // without this key degrades to false. CONFIG (persists to disk), NOT a secret.
        groundingEnabled: false
      },
      projects: {
        activeContext: "default_project",
        localWorkspacePath: process.cwd()
      },
      presets: [
        { id: "claudeCode", name: "Claude Code", command: "claude", enabled: true },
        { id: "codex", name: "Codex CLI", command: "codex", enabled: true },
        { id: "antigravity", name: "Antigravity Agent", command: "antigravity", enabled: true }
      ],
      announcements: { ...DEFAULT_ANNOUNCEMENT_TEMPLATES },
      advanced: {
        webSocketUrl: "",
        latencyMode: "Balanced",
        throughputBps: 16000,
        audioBufferSize: 1024,
        debugLogging: false,
        connectionTimeoutMs: 10000,
        rateLimitRequestsPerMin: 60,
        maxBufferLines: 100,
        idleTimeoutMs: 2000,
        defaultShellCommand: process.platform === "win32" ? "cmd.exe" : "bash",
        globalPermissionsMode: "Inherit",
        historyMaxCommands: 50,
        historyMaxOutputLength: 5000,
        capabilityGates: { ...DEFAULT_CAPABILITY_GATES }
      },
      secrets: {
        geminiApiKey: process.env.GEMINI_API_KEY ? "CONFIGURED_IN_ENV" : ""
      }
    };
  }

  public loadSettings() {
    try {
      if (fs.existsSync(this.settingsFilePath)) {
        const raw = fs.readFileSync(this.settingsFilePath, "utf-8");
        const parsed = JSON.parse(raw);
        this.settings = {
          ...this.getDefaultSettings(),
          ...parsed,
          server: { ...this.getDefaultSettings().server, ...parsed.server },
          voiceAi: { ...this.getDefaultSettings().voiceAi, ...parsed.voiceAi },
          projects: { ...this.getDefaultSettings().projects, ...parsed.projects },
          presets: parsePresetsSafe(parsed.presets ? parsed.presets : this.getDefaultSettings().presets),
          announcements: { ...this.getDefaultSettings().announcements!, ...parsed.announcements },
          advanced: {
            ...this.getDefaultSettings().advanced,
            ...parsed.advanced,
            // Deep-merge the capability matrix so a settings file that overrides ONE gate does
            // not silently drop the other sharp-edge defaults to "Auto" (fail-open). Director
            // overrides layer ON TOP of the defaults.
            capabilityGates: {
              ...DEFAULT_CAPABILITY_GATES,
              ...(parsed.advanced?.capabilityGates ?? {}),
            },
          },
          secrets: { ...this.getDefaultSettings().secrets, ...parsed.secrets }
        };
      } else {
        this.settings = this.getDefaultSettings();
        this.saveSettings();
      }
    } catch (e) {
      console.error("Failed to load settings, using defaults:", e);
      this.settings = this.getDefaultSettings();
    }
    this.globalPermissionsMode = this.settings.advanced.globalPermissionsMode || "Inherit";
  }

  public saveSettings() {
    try {
      // Secrets-at-rest hardening (director decision 2026-06-05): the Gemini API key is an
      // IN-MEMORY-ONLY secret. It stays in this.settings.secrets for the running session (so voice
      // works once the operator enters it in the UI) but is NEVER written to disk — a restart drops
      // it and the operator re-enters it. Persist a copy with the live secret blanked; everything
      // else (gates, presets, voiceAi, etc.) persists unchanged.
      const persisted = { ...this.settings, secrets: { ...this.settings.secrets, geminiApiKey: "" } };
      fs.writeFileSync(this.settingsFilePath, JSON.stringify(persisted, null, 2), "utf-8");
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }

  public updateSettings(newSettings: Partial<SystemSettings>) {
    if (newSettings.server) this.settings.server = { ...this.settings.server, ...newSettings.server };
    if (newSettings.voiceAi) this.settings.voiceAi = { ...this.settings.voiceAi, ...newSettings.voiceAi };
    if (newSettings.projects) this.settings.projects = { ...this.settings.projects, ...newSettings.projects };
    if (newSettings.presets) this.settings.presets = parsePresetsSafe(newSettings.presets);
    if (newSettings.announcements) {
      this.settings.announcements = {
        ...(this.settings.announcements || DEFAULT_ANNOUNCEMENT_TEMPLATES),
        ...newSettings.announcements
      };
    }
    if (newSettings.advanced) {
      this.settings.advanced = { ...this.settings.advanced, ...newSettings.advanced };
      this.globalPermissionsMode = this.settings.advanced.globalPermissionsMode;
      if (newSettings.advanced.maxBufferLines !== undefined) {
        for (const term of Object.values(this.terminals)) {
          term.maxBufferLines = newSettings.advanced.maxBufferLines;
        }
      }
      if (newSettings.advanced.idleTimeoutMs !== undefined) {
        for (const term of Object.values(this.terminals)) {
          term.idleTimeoutMs = newSettings.advanced.idleTimeoutMs;
        }
      }
      // Conservative Phase 2: propagate the agent idle-timing safeguard to live terminals
      // (only interactive_cli panes consume it on the fallback arm; shell panes ignore it).
      if (newSettings.advanced.agentIdleTimeoutMs !== undefined) {
        for (const term of Object.values(this.terminals)) {
          term.agentIdleTimeoutMs = newSettings.advanced.agentIdleTimeoutMs;
        }
      }
    }
    if (newSettings.secrets) {
      this.settings.secrets = { ...this.settings.secrets, ...newSettings.secrets };
    }
    this.saveSettings();
  }

  constructor(opts?: { ledger?: LedgerLike }) {
    // BEAD kqy — log the RESOLVED ABSOLUTE settings path once at boot so a cwd
    // mismatch is obvious in the logs (the file that silently held NO Gemini key
    // was indistinguishable from the right one before this line). SECRET INVARIANT:
    // we log only the PATH — never the key (secrets stay in-memory, strip-on-save).
    console.log(`[settings] resolved settings file: ${path.resolve(this.settingsFilePath)}`);
    this.loadSettings();
    // WS-M cutover seam: a LedgerLike backend may be injected (e.g. JanusStore for
    // durable SQLite state). Default stays the legacy JSON Ledger so existing
    // behavior is unchanged unless the caller opts in.
    this.ledger = opts?.ledger ?? new Ledger();

    // Set activeProjectId from ledger or settings
    const activeCtx = this.ledger.activeProjectId || this.settings.projects?.activeContext || "default_project";
    const workspacePath = this.settings.projects?.localWorkspacePath || process.cwd();
    
    // Ensure the active project is registered on the ledger
    this.ledger.addProject(activeCtx, workspacePath, "Default workspace");
    this.ledger.switchContext(activeCtx);

    // Restore pane records as INERT metadata only — do NOT auto-spawn on boot.
    // Auto-spawning every persisted pane launched N real agent processes (and, on the
    // legacy non-node-pty transport, N visible console windows) on every boot/reconnect,
    // compounding into a runaway ("a million terminals"). Panes are now reconciled to a
    // not-running state on load; the operator starts one explicitly via
    // POST /api/terminals/:id/restart (which creates + starts it on demand).
    const project = this.ledger.getProject(activeCtx);
    if (project && project.panes) {
      for (const pane of Object.values(project.panes)) {
        pane.alive = false;
        pane.is_busy = false;
        pane.last_known_state = "Exited";
      }
      this.ledger.save(true);
    }
  }

  addTerminal(
    terminalId: string,
    cwd: string,
    command: string,
    toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom" = "Custom",
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop",
    sessionId = "",
    projectId = ""
  ): string {
    if (this.terminals[terminalId]) {
      return `Terminal '${terminalId}' already exists.`;
    }
    const realProjId = projectId || this.ledger.activeProjectId || "default_project";
    const term = new UniversalTerminal(terminalId, cwd, command, toolPreset, permissionsMode, sessionId, realProjId);
    term.idleTimeoutMs = this.settings?.advanced?.idleTimeoutMs ?? term.idleTimeoutMs;
    // Conservative Phase 2: seed the agent (interactive_cli) idle-timing safeguard from settings.
    term.agentIdleTimeoutMs = this.settings?.advanced?.agentIdleTimeoutMs ?? term.agentIdleTimeoutMs;
    term.onOutput = (tid, chunk) => {
      if (this.onOutput) this.onOutput(tid, chunk);
    };
    term.onIdle = (tid) => {
      if (this.onIdle) this.onIdle(tid);
    };
    term.onRunning = (tid) => {
      if (this.onRunning) this.onRunning(tid);
    };
    term.onQuiescing = (tid) => {
      if (this.onQuiescing) this.onQuiescing(tid);
    };
    // B1 (async spawn): forward the per-pane spawn-ready edge up to the manager-level onReady
    // (the server publishes the phase-2 "ready" pane signal from there).
    term.onReady = (tid) => {
      if (this.onReady) this.onReady(tid);
    };
    // B1 (async spawn): REGISTER SYNCHRONOUSLY, then DEFER the blocking start(). The slot insert,
    // active-pane election, and ledger sync ALL stay synchronous so (a) the dup/replay guard above
    // still fires on a rapid replay BEFORE any double-spawn can occur, and (b) create -> active ->
    // follow-up-command ordering is preserved by callers. Only the PTY boot moves off this tick.
    this.terminals[terminalId] = term;
    if (!this.activeId) {
      this.activeId = terminalId;
    }
    this.syncLedger();
    this.scheduleStart(term);
    return `Created terminal '${terminalId}' executing '${command}' at '${cwd}'.`;
  }

  /**
   * B1 (async spawn): defer the blocking term.start() (PTY/ConPTY spawn) off the current tick so the
   * Gemini voice onmessage handler is NEVER frozen during pane creation. start() never-throws
   * internally; the try/catch here is belt-and-suspenders so a deferred throw can't escape into an
   * unhandled rejection. onSpawned fires after start() returns (transport assigned OR degraded-Exited)
   * for the fast-fail UI repaint; the spawn-READY edge (phase-2) is the separate onReady path.
   */
  private scheduleStart(term: UniversalTerminal): void {
    const p = new Promise<void>((resolve) => {
      const t = setImmediate(() => {
        try {
          term.start();
        } catch (e) {
          console.warn(`[terminal] deferred start threw (pane degraded, not a crash):`, e);
        } finally {
          try {
            if (this.onSpawned) this.onSpawned(term.terminalId);
          } catch (e) {
            console.warn(`[terminal] onSpawned subscriber threw (ignored):`, e);
          }
          this.pendingStarts.delete(p);
          resolve();
        }
      });
      // Force-exit hygiene: the deferred-start handle must never hold the loop open on its own.
      if (typeof (t as any)?.unref === "function") (t as any).unref();
    });
    this.pendingStarts.add(p);
  }

  /** TEST/TEARDOWN SEAM: await every scheduled deferred spawn so a real ConPTY spawn never
   *  outlives the test (Windows --test-force-exit / uv_close-on-CLOSING hazard). */
  async flushPendingSpawns(): Promise<void> {
    await Promise.all([...this.pendingStarts]);
  }

  /** Resize a pane's PTY grid to match the operator's xterm viewport. Unknown
   *  ids are a safe no-op (a stale client may resize a pane that just exited). */
  resize(terminalId: string, cols: number, rows: number) {
    const term = this.terminals[terminalId];
    if (!term) return;
    term.resize(cols, rows);
  }

  /** Phase 1 "ears": force a live PTY->ledger sync without building the listPanes payload.
   *  switch_context calls this immediately before getProjectBriefing so the catch-up briefing
   *  reflects the current term.status (fact [E]). syncLedger() is private; this is the public
   *  seam. (listPanes() also calls syncLedger() — this just avoids the payload allocation.) */
  refreshLedger() {
    this.syncLedger();
  }

  listPanes() {
    this.syncLedger();
    const result: any[] = [];
    for (const [projId, ws] of Object.entries(this.ledger.workspaces)) {
      result.push({
        project_id: projId,
        panes: Object.values(ws.panes)
      });
    }
    return result;
  }

  /** Graceful per-pane EXIT: kill the pane's PTY and move it into the RECOVERABLE
   *  archive, preserving the ledger record (restorable). The non-destructive middle
   *  between DELETE /panes/:id (hard delete — erases the record) and the reactive
   *  "Clear Exited". Returns true if a pane was archived. Backend-agnostic: archives via
   *  the shared archiveExitedPanes interface method, so it holds for legacy + SQLite.
   *  Note: like "Clear Exited", this also sweeps any already-Exited sibling panes in the
   *  project into the archive. */
  async stopAndArchivePane(projectId: string, paneId: string): Promise<boolean> {
    const term = this.terminals[paneId];
    if (term) {
      await term.stop();        // SIGTERM->SIGKILL; awaits full ConPTY teardown + scrollback flush
      term.status = "Exited";   // deterministic: a stopped pane is Exited (don't rely on the onExit race)
      this.syncLedger();        // persist alive=false to the ledger/store via updatePane
      delete this.terminals[paneId];
    }
    const realProj = projectId || this.ledger.activeProjectId || "default_project";
    const archived = this.ledger.archiveExitedPanes(realProj) > 0;
    // Completion edge: publish the turn-gated "closed" ack source (server wires onClosed -> bus).
    // Best-effort + never-throw — a failed ack must not fail the close.
    try { this.onClosed?.(paneId); } catch (e) { console.warn(`[terminal] onClosed subscriber threw (ignored):`, e); }
    return archived;
  }

  // Synchronize actual terminal state to ledger
  private syncLedger() {
    for (const [id, term] of Object.entries(this.terminals)) {
      const pId = term.projectId || "default_project";
      let project = this.ledger.getProject(pId);
      if (!project) {
        this.ledger.addProject(pId, term.cwd, "Auto-created project");
        project = this.ledger.getProject(pId);
      }
      if (project) {
        const existingPane = project.panes[id];
        const meta: PaneMeta = {
          pane_id: id,
          name: existingPane?.name || id,
          runtime_type: existingPane?.runtime_type || term.runtimeType,
          last_known_state: term.status === "Running" ? "Running active command" : term.status === "Idle" ? "Idle" : "Exited",
          is_busy: term.status === "Running",
          alive: term.status !== "Exited",
          notes: existingPane?.notes || [],
          // BEAD gpd — PERSIST-WINS: a sync reflects only the LIVE FACTS (status / busy /
          // alive / session). Operator INTENT — the permission mode and the per-pane
          // capability-gate override — is authoritative in the ledger and must NOT be
          // clobbered by whatever the live process happens to hold. Prefer the persisted
          // value; fall back to the live term only on first registration (no existing
          // record yet). Covers BOTH permissions_mode AND capabilityGates.
          permissions_mode: existingPane?.permissions_mode ?? term.permissionsMode,
          tool_preset: term.toolPreset,
          session_id: term.sessionId || existingPane?.session_id || "",
          context_size: term.contextSize,
          capabilityGates: existingPane?.capabilityGates,
          // WS-C status-detection fields (design §4.2).
          last_status_change_at: new Date(term.lastStatusChangeAt).toISOString(),
          last_command: term.lastCommand || existingPane?.last_command || "",
          elapsed_ms: Date.now() - term.lastStatusChangeAt
        };
        this.ledger.updatePane(pId, meta, false);
      }
    }
    this.ledger.save(false);
  }

  getPaneSummary(paneId: string, limit = 20) {
    if (!this.terminals[paneId]) {
      return `Error: Pane ${paneId} does not exist.`;
    }
    const recentOut = this.terminals[paneId].getRecentOutput(limit);
    // WS-B: redactSecrets runs AFTER ANSI stripping (getRecentOutput already strips ANSI).
    // This covers both the standard get_pane_summary tool response and the HiTL rationale
    // snapshot (server.ts calls manager.getPaneSummary(targetId, 5) for approval rationale).
    const safeOut = redactSecrets(recentOut || "[No new output]");
    return `\`\`\`\n${safeOut}\n\`\`\``;
  }

  /** Push-observation pull side: only-new lines since the model last read this pane,
   *  ANSI already stripped (model lane) and secret-redacted. */
  getPaneDelta(paneId: string): string {
    const term = this.terminals[paneId];
    if (!term) {
      return `Error: Pane ${paneId} does not exist.`;
    }
    const { lines, dropped } = term.consumeDelta();
    if (!lines) {
      return "[No new output since last read]";
    }
    const note = dropped > 0 ? `[... ${dropped} earlier line(s) evicted from buffer ...]\n` : "";
    return "```\n" + note + redactSecrets(lines) + "\n```";
  }
}
