import { Ledger, PaneMeta, type LedgerLike } from "./ledger";
import fs from "fs";
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

export class UniversalTerminal {
  public terminalId: string;
  public cwd: string;
  public shellCmd: string;
  // WS-C: the active PTY transport (node-pty preferred, legacy fallback).
  private transport: PtyTransport | null = null;
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
  public sessionId: string;
  public onOutput: ((terminalId: string, chunk: string) => void) | null = null;
  public onIdle?: (terminalId: string) => void;
  public projectId: string;
  private idleTimer: NodeJS.Timeout | null = null;
  private cachedCpu = 0.0;
  // Silence-to-idle timeout (ms). Honors advanced.idleTimeoutMs; defaults to the
  // documented 2000ms rather than the previously hardcoded 1000ms (BUG-034).
  public idleTimeoutMs = 2000;

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
    statusProbe?: StatusProbe
  ) {
    this.terminalId = terminalId;
    this.cwd = cwd;
    this.toolPreset = toolPreset;
    this.permissionsMode = permissionsMode;
    this.projectId = projectId;
    this.runtimeType = toolPreset === "Custom" ? "shell" : "interactive_cli";
    // Injectable for tests; defaults to the platform-selected probe (design §2.0).
    this.statusProbe = statusProbe ?? selectProbe();

    let cmd = shellCmd;
    if (toolPreset !== "Custom") {
      const skipFlag = "--dangerously-skip-permissions";
      if (permissionsMode === "Full Auto") {
        if (!cmd.includes(skipFlag)) {
          cmd = `${cmd} ${skipFlag}`;
        }
      } else {
        cmd = cmd.replace(` ${skipFlag}`, "");
      }
    }
    this.shellCmd = cmd;
    
    if (sessionId) {
      this.sessionId = sessionId;
    } else if (toolPreset !== "Custom") {
      // Synthetic "<tool>-session-<hex>" id is for internal tracking/display ONLY.
      // It is intentionally never passed to the CLI --resume flag, which requires a
      // real UUID. Real session UUIDs are captured later by checkForSessionId() once
      // the CLI prints them. start() guards on UUID format before appending --resume.
      const toolLower = toolPreset.toLowerCase().replace(/\s+/g, "-");
      const randomId = Math.random().toString(16).substring(2, 10);
      this.sessionId = `${toolLower}-session-${randomId}`;
    } else {
      this.sessionId = "";
    }
  }

  public setPermissionsMode(mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only") {
    this.permissionsMode = mode;
    if (this.toolPreset !== "Custom") {
      const skipFlag = "--dangerously-skip-permissions";
      if (mode === "Full Auto") {
        if (!this.shellCmd.includes(skipFlag)) {
          this.shellCmd = `${this.shellCmd} ${skipFlag}`;
        }
      } else {
        this.shellCmd = this.shellCmd.replace(` ${skipFlag}`, "");
      }
    }
  }

  get contextSize(): number {
    return this.outputBuffer.join('\n').length;
  }

  private checkForSessionId(text: string) {
    if (this.sessionId && this.sessionId.includes("-session-") && this.toolPreset !== "Custom") {
      // Keep preset/simulated unless a more granular one is found in output
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

    if (result.clearIdleTimer && this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (result.armIdleTimer) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      // C4: in authoritative mode the idle debounce must outlast at least one
      // probe interval, otherwise an idleTimeoutMs < probeIntervalMs can fire
      // "done" before the next authoritative tick has a chance to re-confirm a
      // reappearing child — a spurious onIdle. Floor the effective debounce at
      // probeIntervalMs there. Fallback mode is pure quiescence, so it keeps the
      // configured timeout verbatim.
      const effectiveIdleMs =
        this.lastConfidence === "authoritative"
          ? Math.max(this.idleTimeoutMs, this.probeIntervalMs)
          : this.idleTimeoutMs;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.applyStatusEvent({ kind: "idleTimer" });
      }, effectiveIdleMs);
    }

    if (result.status !== this.status) {
      this.status = result.status;
      this.lastStatusChangeAt = Date.now();
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

  private appendScrollback(chunk: string) {
    const file = `.janus_scrollback_${this.terminalId}.log`;
    try {
      fs.appendFileSync(file, chunk);
      const stat = fs.statSync(file);
      if (stat.size > 1024 * 512) { // 512KB limit
        const data = fs.readFileSync(file, "utf-8");
        const lines = data.split(/\r?\n/).filter(l => l.trim() !== "");
        const pruned = lines.slice(-this.maxBufferLines).join("\n") + "\n";
        fs.writeFileSync(file, pruned, "utf-8");
      }
    } catch (e) {
      // ignore
    }
  }

  start() {
    let finalCommand = this.shellCmd;
    if (this.toolPreset !== "Custom" && this.sessionId) {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const alreadyHasResume = /--resume\b|--session\b/.test(finalCommand);
      // Only resume a genuine prior session: the CLI requires a real UUID. A synthetic
      // tracking id (e.g. "claude-code-session-<hex>") is NOT resumable — launch fresh.
      if (!alreadyHasResume && UUID_RE.test(this.sessionId)) {
        finalCommand = `${finalCommand} --resume ${this.sessionId}`;
      }
    }

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
    const { transport, usingNodePty } = createPtyTransport(finalCommand, {
      cwd: this.cwd,
      env: childEnv,
      cols: this.cols,
      rows: this.rows,
    });
    this.transport = transport;
    this.usingNodePty = usingNodePty;
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

  writeInput(command: string) {
    // Record the most recent command and optimistically mark Running — an input
    // means a turn is starting (Tier A kick, design §5).
    this.lastCommand = command;
    this.applyStatusEvent({ kind: "input" });
    if (this.transport) {
      // CR (\r), not LF — a ConPTY-hosted TUI agent submits on Enter (carriage return); LF leaves the prompt staged-but-unsubmitted (G1).
      this.transport.write(command + "\r");
    }
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
  }
}

export class OrchestratorManager {
  public terminals: Record<string, UniversalTerminal> = {};
  public activeId: string | null = null;
  public ledger: LedgerLike;
  public attentionQueue: AttentionItem[] = [];
  public onOutput: ((terminalId: string, chunk: string) => void) | null = null;
  public onIdle?: (terminalId: string) => void;
  public globalPermissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit" = "Inherit";
  public settings!: SystemSettings;
  private settingsFilePath = ".janus_settings.json";

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
        isMicMuted: false
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
      fs.writeFileSync(this.settingsFilePath, JSON.stringify(this.settings, null, 2), "utf-8");
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
    }
    if (newSettings.secrets) {
      this.settings.secrets = { ...this.settings.secrets, ...newSettings.secrets };
    }
    this.saveSettings();
  }

  constructor(opts?: { ledger?: LedgerLike }) {
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
    term.onOutput = (tid, chunk) => {
      if (this.onOutput) this.onOutput(tid, chunk);
    };
    term.onIdle = (tid) => {
      if (this.onIdle) this.onIdle(tid);
    };
    term.start();
    this.terminals[terminalId] = term;
    if (!this.activeId) {
      this.activeId = terminalId;
    }
    this.syncLedger();
    return `Created terminal '${terminalId}' executing '${command}' at '${cwd}'.`;
  }

  /** Resize a pane's PTY grid to match the operator's xterm viewport. Unknown
   *  ids are a safe no-op (a stale client may resize a pane that just exited). */
  resize(terminalId: string, cols: number, rows: number) {
    const term = this.terminals[terminalId];
    if (!term) return;
    term.resize(cols, rows);
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
          permissions_mode: term.permissionsMode,
          tool_preset: term.toolPreset,
          session_id: term.sessionId || existingPane?.session_id || "",
          context_size: term.contextSize,
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
