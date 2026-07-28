// Agent-pane busy truth — BUG-006 residual (cluster W4, P0 #4).
//
// Shell panes are fixed (authoritative /proc process-tree probe → decideStatus).
// The residual: interactive_cli (agent) panes are HARD-DOWNGRADED in
// UniversalTerminal.runProbeTick (src/terminal.ts:811-814) to a blanket
// {hasRunningChild:false, confidence:"fallback"} probe. So a genuinely-thinking
// agent that emits no output for longer than agentIdleTimeoutMs (default 3500ms)
// false-flips to Idle — the exact "AI thinking pause" false-idle from the original
// P0.
//
// The fix (pinned here, RED until it lands):
//   (a) a per-CLI adapter busy heuristic  isLikelyBusy(recentTail: string): boolean
//       that recognizes each agent's live "working" markers (Claude Code: spinner
//       glyphs / "esc to interrupt"; Codex: its working glyph + interrupt hint);
//   (b) runProbeTick, for an interactive_cli pane, computes the recent tail and
//       when isLikelyBusy(tail) is true emits an AUTHORITATIVE BUSY probe
//       ({hasRunningChild:true, confidence:"authoritative"}) so decideStatus keeps
//       the pane Running across a long thinking gap; when NO marker is seen it
//       preserves today's quiescence path (a fallback no-child probe) so a truly
//       idle agent at its prompt still debounces to Idle at the agentIdleTimeoutMs
//       floor;
//   (c) the busy→idle recovery: once the agent quiets, the fallback no-child probe
//       re-arms the quiescence debounce so exactly one Running->Idle edge fires.
//
// See scratchpad/design/W4-agent-busy.md for the full seam design.
//
// Run:  npx tsx --test --test-force-exit tests/test_agent_busy_probe.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { createAdapter, type AgentAdapter } from "../src/agents";
import { decideStatus, type Status, type RuntimeType } from "../src/statusMachine";
import type { ProbeResult, StatusProbe } from "../src/statusProbe";
import { UniversalTerminal } from "../src/terminal";

// The planned adapter method under test. Cast through this shape so the tests
// transpile before the method exists (tsx/esbuild strips types); a missing method
// then surfaces as a clean behavioral/runtime RED, not a compile error.
type BusyCapable = AgentAdapter & { isLikelyBusy?: (recentTail: string) => boolean };
const busyOf = (a: AgentAdapter): BusyCapable => a as BusyCapable;

// ---------------------------------------------------------------------------
// Representative captured tails (the last rendered status line + prompt).
// These are what getRecentOutput(N) would return at probe time.
// ---------------------------------------------------------------------------

// Claude Code (v2.x) — the running-turn status line carries a spinner glyph and
// the interruptible hint "(esc to interrupt)". Both mean the turn is WORKING.
const CLAUDE_BUSY_SPINNER = "✹ Forging… (14s · ↓ 2.1k tokens · esc to interrupt)";
const CLAUDE_BUSY_BRAILLE = "⠋ Thinking… (esc to interrupt · ctrl+t to show todos)";
// A settled Claude pane: a mode PILL (not a working marker) and a bare composer.
const CLAUDE_IDLE_MODEPILL = "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents";
const CLAUDE_IDLE_PROMPT = "Here is the summary of the change.\n\n> ";
// The exact prompt shape that fooled the OLD prompt-regex (BUG-006) — NOT busy,
// but must also NOT be mistaken for busy by the new heuristic.
const CLAUDE_IDLE_DOLLAR = "user@host:~/proj$ ";

// Codex CLI — a working turn shows a spinner glyph + "Esc to interrupt".
const CODEX_BUSY_WORKING = "⠴ Working (8s • Esc to interrupt)";
const CODEX_BUSY_THINKING = "• Thinking…  Esc to interrupt";
const CODEX_IDLE_PROMPT = "Done. Applied the patch.\n› ";

// Claude Code (2026 CLI, bead q1kp — captured LIVE by scripts/smoke-completion-prompt.ts):
// the REST screen RETAINS a star glyph in the past-tense completion line, and the footer
// truncates long paths with an ellipsis. A bare star-glyph busy class therefore pins a rested
// pane Running forever (no idle edge ⇒ no idle-time exchange settlement). These frames pin the
// distinction: an ACTIVE verb frame ("✻ Ideating…", "thinking with xhigh effort") is busy; the
// past-tense rest line ("✻Cogitated for 7s") is NOT, even with its star and an ellipsis-truncated
// footer in the same tail window.
const CLAUDE_2026_BUSY_IDEATING = "✻ Ideating… (3s · thinking with xhigh effort)";
const CLAUDE_2026_BUSY_EFFORT = "✶ thinking with xhigh effort";
const CLAUDE_2026_IDLE_COGITATED =
  "✻Cogitated for 7s\n" +
  "────────────────────────\n" +
  "❯ \n" +
  "────────────────────────\n" +
  "⚠ Transcript saving is off — inherited marker · res…completion-smoke… ⏵⏵ bypass permissions on (shift+tab to cycle)";

describe("W4(a): AgentAdapter.isLikelyBusy — per-CLI working-marker tables", () => {
  it("ClaudeAdapter: spinner + 'esc to interrupt' tail reads BUSY", () => {
    const a = busyOf(createAdapter("Claude Code"));
    assert.strictEqual(a.isLikelyBusy!(CLAUDE_BUSY_SPINNER), true, "Claude spinner+interrupt hint is busy");
    assert.strictEqual(a.isLikelyBusy!(CLAUDE_BUSY_BRAILLE), true, "Claude braille spinner+interrupt hint is busy");
  });

  it("ClaudeAdapter: settled prompt / mode pill / $-prompt read NOT busy", () => {
    const a = busyOf(createAdapter("Claude Code"));
    assert.strictEqual(a.isLikelyBusy!(CLAUDE_IDLE_PROMPT), false, "a settled composer prompt is not busy");
    assert.strictEqual(a.isLikelyBusy!(CLAUDE_IDLE_MODEPILL), false, "a mode pill is not a working marker");
    assert.strictEqual(a.isLikelyBusy!(CLAUDE_IDLE_DOLLAR), false, "a $-ending prompt is not busy (kills the old regex trap)");
    assert.strictEqual(a.isLikelyBusy!(""), false, "an empty tail is not busy");
  });

  it("CodexAdapter: working spinner + 'Esc to interrupt' tail reads BUSY", () => {
    const a = busyOf(createAdapter("Codex"));
    assert.strictEqual(a.isLikelyBusy!(CODEX_BUSY_WORKING), true, "Codex working spinner+interrupt hint is busy");
    assert.strictEqual(a.isLikelyBusy!(CODEX_BUSY_THINKING), true, "Codex thinking+interrupt hint is busy");
  });

  it("CodexAdapter: settled prompt reads NOT busy", () => {
    const a = busyOf(createAdapter("Codex"));
    assert.strictEqual(a.isLikelyBusy!(CODEX_IDLE_PROMPT), false, "a settled Codex prompt is not busy");
    assert.strictEqual(a.isLikelyBusy!(""), false, "an empty tail is not busy");
  });

  it("Custom & Antigravity: interface-complete and false-safe on a settled prompt", () => {
    // Custom is runtimeType 'shell' (never hits the interactive_cli branch) but must
    // still satisfy the interface. Antigravity's live busy markers are unverified
    // (parseCurrentMode is a stub) so it defaults conservative: settled ⇒ not busy.
    const custom = busyOf(createAdapter("Custom"));
    const agy = busyOf(createAdapter("Antigravity"));
    assert.strictEqual(typeof custom.isLikelyBusy, "function", "Custom implements isLikelyBusy");
    assert.strictEqual(typeof agy.isLikelyBusy, "function", "Antigravity implements isLikelyBusy");
    assert.strictEqual(custom.isLikelyBusy!("anything\n$ "), false, "Custom has no agent working markers");
    assert.strictEqual(agy.isLikelyBusy!("? for shortcuts   Gemini 3.5 Flash"), false, "agy settled status line is not busy");
  });

  it("isLikelyBusy is a pure function of the tail (idempotent)", () => {
    const a = busyOf(createAdapter("Claude Code"));
    assert.strictEqual(a.isLikelyBusy!(CLAUDE_BUSY_SPINNER), a.isLikelyBusy!(CLAUDE_BUSY_SPINNER));
    assert.strictEqual(a.isLikelyBusy!(CLAUDE_IDLE_PROMPT), a.isLikelyBusy!(CLAUDE_IDLE_PROMPT));
  });

  it("ClaudeAdapter (2026 CLI, bead q1kp): active working frames read BUSY", () => {
    const a = busyOf(createAdapter("Claude Code"));
    assert.strictEqual(a.isLikelyBusy!(CLAUDE_2026_BUSY_IDEATING), true, "star glyph + active verb ellipsis is busy");
    assert.strictEqual(a.isLikelyBusy!(CLAUDE_2026_BUSY_EFFORT), true, "an effort-display thinking frame is busy");
    // Adversarial-review Finding 2: the spinner cycles through NON-star phase glyphs too
    // (observed live: "·✢*✶✻✽" frames). A frozen mid-gap frame led by one of them must still
    // read busy, or the 2-line bottom window idles the pane mid-turn.
    assert.strictEqual(a.isLikelyBusy!("·Architecting…101 tokens · "), true, "a '·'-phase spinner frame is busy");
    assert.strictEqual(a.isLikelyBusy!("✢Ideating…"), true, "a '✢'-phase spinner frame is busy");
  });

  it("ClaudeAdapter (bead q1kp, adversarial-review Finding 1): prose containing 'thinking' at the screen bottom reads NOT busy", () => {
    // The effort marker must match the CLI's frame shape ("thinking with <level> effort"), never
    // the common English word — response prose or a drafted composer line at rest would
    // otherwise re-pin the pane Running forever (the exact defect this bead kills).
    const a = busyOf(createAdapter("Claude Code"));
    assert.strictEqual(a.isLikelyBusy!("That is what I was thinking about.\n> "), false, "response prose mentioning 'thinking' is not busy");
    assert.strictEqual(a.isLikelyBusy!("❯ what were you thinking there"), false, "a drafted-but-unsent composer line is not busy");
  });

  it("ClaudeAdapter (bead q1kp, adversarial-review Findings 2+3): rest-shaped lines never match the phase-glyph rule", () => {
    const a = busyOf(createAdapter("Claude Code"));
    // '*' stays OUT of the phase class: a truncated markdown bullet at a rest bottom would
    // otherwise pin the pane (permanent-pin beats a rare missed '*' phase frame, which only
    // costs a self-correcting early idle).
    assert.strictEqual(a.isLikelyBusy!("* Updated tests and docs…\n❯ "), false, "a truncated markdown bullet is not busy");
    // Finding 3 (row-merge hardening): stripAnsiSequences can merge two visual rows into one
    // buffer line. A merged rest line ("✻Cogitated for 7s" + ellipsis-truncated footer) must not
    // resurrect the rest-screen pin — the ellipsis budget after the verb is deliberately short.
    assert.strictEqual(a.isLikelyBusy!("✻Cogitated for 7s · res…completion-smoke…"), false, "a merged rest+footer row is not busy");
  });

  it("ClaudeAdapter (2026 CLI, bead q1kp): the rest screen's retained star glyph reads NOT busy", () => {
    // The live-observed defect: '✻Cogitated for 7s' sits on the rest screen forever. If this
    // reads busy, the pane never idles, and the exchange spine's idle-time settlement is dead
    // for every real Claude pane.
    const a = busyOf(createAdapter("Claude Code"));
    assert.strictEqual(
      a.isLikelyBusy!(CLAUDE_2026_IDLE_COGITATED),
      false,
      "a past-tense rest line (star glyph, no active verb ellipsis) must NOT read busy",
    );
  });
});

// ---------------------------------------------------------------------------
// Seam replay harness (extends the tests/test_status_machine.ts idiom).
//
// It drives the PURE decideStatus() through a virtual timeline exactly as
// UniversalTerminal.applyStatusEvent does, PLUS it models the post-fix
// runProbeTick busy-check: on each probe tick for an interactive_cli pane it
// computes the current recent tail and asks the adapter isLikelyBusy(tail),
// synthesizing an AUTHORITATIVE BUSY probe when busy, else a fallback no-child
// probe. Output events carry the tail SNAPSHOT the terminal would have rendered
// (a thinking spinner keeps that tail "busy" through a silent gap until the
// answer/prompt renders).
//
// Faithful to terminal.ts: confidence bookkeeping, sawWorkSinceIdle, the P0-2
// output-driven-work rule, and effectiveIdleMs (authoritative floor vs the
// agentIdleTimeoutMs fallback floor for interactive_cli).
// ---------------------------------------------------------------------------

type Ev =
  | { kind: "output"; text: string } // text = the tail snapshot after this chunk
  | { kind: "probeTick" } // a 500ms probe tick (busy-ness computed from the tail)
  | { kind: "input" };

interface TimedEvent { t: number; event: Ev; }

interface ReplayOpts {
  adapter: AgentAdapter;
  runtimeType: RuntimeType;
  idleTimeoutMs: number;
  agentIdleTimeoutMs: number;
  probeIntervalMs: number;
}

interface ReplayResult {
  timeline: { t: number; status: Status }[];
  onIdleCount: number;
  finalStatus: Status;
}

function effectiveIdleMs(
  confidence: "authoritative" | "fallback",
  o: ReplayOpts,
): number {
  // Mirrors UniversalTerminal.effectiveIdleMs (terminal.ts:740-751).
  if (confidence === "authoritative") return Math.max(o.idleTimeoutMs, o.probeIntervalMs);
  return o.runtimeType === "interactive_cli" ? o.agentIdleTimeoutMs : o.idleTimeoutMs;
}

function replayAgent(events: TimedEvent[], o: ReplayOpts): ReplayResult {
  let status: Status = "Idle";
  let confidence: "authoritative" | "fallback" = "fallback";
  let sawWork = false;
  let idleTimerAt: number | null = null;
  let tail = "";
  const timeline: { t: number; status: Status }[] = [];
  let onIdleCount = 0;

  // The seam under test: mirror runProbeTick's interactive_cli branch. A missing
  // isLikelyBusy (method not yet implemented) degrades to "not busy" — i.e. today's
  // blanket fallback downgrade — so the false-idle RED reproduces behaviorally.
  const synthProbe = (): ProbeResult => {
    const b = busyOf(o.adapter);
    const busy = typeof b.isLikelyBusy === "function" ? b.isLikelyBusy(tail) : false;
    return busy
      ? { hasRunningChild: true, confidence: "authoritative" }
      : { hasRunningChild: false, confidence: "fallback" };
  };

  const applyMachine = (
    now: number,
    machineEvent: Parameters<typeof decideStatus>[0]["event"],
    outputText?: string,
  ) => {
    if (status === "Exited") return;
    if (machineEvent.kind === "output" && outputText !== undefined) tail = outputText;
    if (machineEvent.kind === "probe") confidence = machineEvent.probe.confidence;

    if (
      machineEvent.kind === "input" ||
      (machineEvent.kind === "probe" &&
        machineEvent.probe.confidence === "authoritative" &&
        machineEvent.probe.hasRunningChild)
    ) {
      sawWork = true;
    }

    const result = decideStatus({
      event: machineEvent,
      currentStatus: status,
      runtimeType: o.runtimeType,
      recentTail: tail,
      confidence,
      idleTimerArmed: idleTimerAt !== null,
    });

    // P0-2: an output-driven Running transition in fallback mode is genuine work.
    if (
      machineEvent.kind === "output" &&
      confidence === "fallback" &&
      result.status === "Running" &&
      status !== "Running"
    ) {
      sawWork = true;
    }

    if (result.clearIdleTimer) idleTimerAt = null;
    if (result.armIdleTimer) idleTimerAt = now + effectiveIdleMs(confidence, o);
    if (result.status !== status) status = result.status;
    if (result.fireOnIdle) {
      const done = sawWork;
      sawWork = false;
      if (done) onIdleCount++;
    }
  };

  const dispatch = (now: number, ev: Ev) => {
    if (ev.kind === "output") applyMachine(now, { kind: "output", text: ev.text }, ev.text);
    else if (ev.kind === "input") applyMachine(now, { kind: "input" });
    else applyMachine(now, { kind: "probe", probe: synthProbe() });
  };

  const queue = [...events].sort((a, b) => a.t - b.t);
  let i = 0;
  let clock = 0;
  while (i < queue.length || idleTimerAt !== null) {
    const nextEventT = i < queue.length ? queue[i].t : Infinity;
    const nextTimerT = idleTimerAt ?? Infinity;
    if (nextTimerT <= nextEventT && nextTimerT !== Infinity) {
      clock = nextTimerT;
      idleTimerAt = null;
      applyMachine(clock, { kind: "idleTimer" });
      timeline.push({ t: clock, status });
    } else if (nextEventT !== Infinity) {
      clock = queue[i].t;
      dispatch(clock, queue[i].event);
      timeline.push({ t: clock, status });
      i++;
    } else {
      break;
    }
  }

  return { timeline, onIdleCount, finalStatus: status };
}

const AGENT_OPTS = (adapter: AgentAdapter): ReplayOpts => ({
  adapter,
  runtimeType: "interactive_cli",
  idleTimeoutMs: 2000,
  agentIdleTimeoutMs: 3500,
  probeIntervalMs: 500,
});

describe("W4(c): interactive_cli busy truth across a >3500ms thinking gap", () => {
  it("a busy marker in the tail keeps the pane Running through the gap, then exactly one Idle", () => {
    // The agent emits a working status line at t=100, then THINKS silently until
    // t=5100 (a 5000ms gap > agentIdleTimeoutMs=3500). The busy marker stays in the
    // rendered tail throughout, so every 500ms probe re-confirms busy. Pre-fix
    // (isLikelyBusy absent ⇒ blanket fallback) the quiescence timer fires at
    // t≈3600 and false-idles mid-thought — the residual BUG-006 defect.
    const adapter = createAdapter("Claude Code");
    const events: TimedEvent[] = [
      { t: 0, event: { kind: "input" } },
      { t: 100, event: { kind: "output", text: CLAUDE_BUSY_SPINNER } },
      // ...long silent thinking gap (no output) from 100 → 5100...
      { t: 5100, event: { kind: "output", text: CLAUDE_IDLE_PROMPT } }, // turn finishes, tail quiets
    ];
    for (let t = 500; t <= 12000; t += 500) events.push({ t, event: { kind: "probeTick" } });

    const r = replayAgent(events, AGENT_OPTS(adapter));

    // Across the whole thinking gap (t in [100, 5100)) the pane must NEVER be Idle.
    for (const { t, status } of r.timeline) {
      if (t >= 100 && t < 5100) {
        assert.notStrictEqual(status, "Idle", `false Idle at t=${t} while the agent was thinking (BUG-006 residual)`);
      }
    }
    // After the turn finishes and the tail quiets, quiescence drives exactly one Idle.
    assert.strictEqual(r.finalStatus, "Idle", "agent must reach Idle after the turn finishes and quiets");
    assert.strictEqual(r.onIdleCount, 1, "exactly one Running->Idle edge for the finished turn (no mid-thought false idle)");
  });

  it("Codex: a working marker likewise holds the pane Running across the gap", () => {
    const adapter = createAdapter("Codex");
    const events: TimedEvent[] = [
      { t: 0, event: { kind: "input" } },
      { t: 100, event: { kind: "output", text: CODEX_BUSY_WORKING } },
      { t: 5100, event: { kind: "output", text: CODEX_IDLE_PROMPT } },
    ];
    for (let t = 500; t <= 12000; t += 500) events.push({ t, event: { kind: "probeTick" } });

    const r = replayAgent(events, AGENT_OPTS(adapter));
    for (const { t, status } of r.timeline) {
      if (t >= 100 && t < 5100) {
        assert.notStrictEqual(status, "Idle", `Codex false Idle at t=${t} mid-turn`);
      }
    }
    assert.strictEqual(r.finalStatus, "Idle");
    assert.strictEqual(r.onIdleCount, 1);
  });

  it("2026 CLI (bead q1kp): a turn that ends on the star-retaining rest screen still reaches Idle exactly once", () => {
    // The live-observed end-to-end failure shape: busy frame during the turn, then the pane
    // rests on '✻Cogitated for 7s' + prompt. Pre-fix the bare star class keeps every probe
    // authoritative-busy at rest, so the pane NEVER idles (observed: paneStatus=Running for a
    // full 120s window while an exchange sat at 'delivered').
    const adapter = createAdapter("Claude Code");
    const events: TimedEvent[] = [
      { t: 0, event: { kind: "input" } },
      { t: 100, event: { kind: "output", text: CLAUDE_2026_BUSY_IDEATING } },
      { t: 5100, event: { kind: "output", text: CLAUDE_2026_IDLE_COGITATED } }, // turn done, star retained
    ];
    for (let t = 500; t <= 15000; t += 500) events.push({ t, event: { kind: "probeTick" } });

    const r = replayAgent(events, AGENT_OPTS(adapter));
    for (const { t, status } of r.timeline) {
      if (t >= 100 && t < 5100) {
        assert.notStrictEqual(status, "Idle", `false Idle at t=${t} while the agent was thinking`);
      }
    }
    assert.strictEqual(r.finalStatus, "Idle", "the star-retaining rest screen must still debounce to Idle (bead q1kp)");
    assert.strictEqual(r.onIdleCount, 1, "exactly one Running->Idle edge for the finished turn");
  });

  it("the SAME pane with a quiet, prompt-like tail still goes Idle at the agentIdleTimeoutMs floor", () => {
    // A truly-idle agent: it answers, then rests at its prompt with NO working
    // marker. It must still debounce to Idle — and the debounce floor must stay
    // agentIdleTimeoutMs (3500ms), NOT be shortened. This guards the truly-idle
    // path AND the floor: emitting an authoritative no-child probe instead of a
    // fallback one would drop the floor to ~2000ms and idle too early.
    const adapter = createAdapter("Claude Code");
    const events: TimedEvent[] = [
      { t: 0, event: { kind: "input" } },
      { t: 100, event: { kind: "output", text: CLAUDE_IDLE_PROMPT } }, // answered, resting
    ];
    for (let t = 500; t <= 8000; t += 500) events.push({ t, event: { kind: "probeTick" } });

    const r = replayAgent(events, AGENT_OPTS(adapter));

    // Floor guard: the pane must NOT idle before ~agentIdleTimeoutMs after the last
    // output (100 + 3500 = 3600); anything earlier means the debounce floor regressed.
    for (const { t, status } of r.timeline) {
      if (t < 3000) {
        assert.notStrictEqual(status, "Idle", `idled too early at t=${t}: agentIdleTimeoutMs floor regressed`);
      }
    }
    assert.strictEqual(r.finalStatus, "Idle", "a resting agent must still reach Idle");
    assert.strictEqual(r.onIdleCount, 1, "exactly one Running->Idle edge for the resting agent");
  });
});

// ---------------------------------------------------------------------------
// W4(b): real-seam integration (drive the ACTUAL runProbeTick, not a replay).
//
// The W4(c) replay above calls the REAL decideStatus and the REAL adapter, but it
// REIMPLEMENTS runProbeTick's interactive_cli branch (synthProbe) and
// effectiveIdleMs. That is faithful to the test_status_machine.ts idiom, yet it
// means a broken PRODUCTION runProbeTick — one that never calls isLikelyBusy, uses
// the wrong tail window, emits the wrong confidence, or (the subtle one) emits an
// AUTHORITATIVE no-child probe that collapses the agent idle floor to ~2000ms —
// would still pass every W4(c) assertion (synthProbe hardcodes confidence:"fallback"
// on the not-busy path, so the replay structurally cannot see a floor collapse).
//
// These tests close that gap: they drive the REAL UniversalTerminal.runProbeTick →
// applyStatusEvent → effectiveIdleMs → decideStatus wiring, with the busy/quiet tail
// injected into the public outputBuffer that getRecentOutput(5) reads. No PTY is
// spawned (start() is never called); no wall-clock sleeps (the recovery-arm delay is
// captured via a patched setTimeout — the same idiom as test_status_gating.ts's
// armedDelayFor).
// ---------------------------------------------------------------------------

/** interactive_cli never consults the process probe (P0-1 gate); the ctor still needs one. */
class ScriptedProbe implements StatusProbe {
  probe(_shellPid: number): ProbeResult {
    return { hasRunningChild: false, confidence: "fallback" };
  }
}

/** A real interactive_cli UniversalTerminal, mid-turn (Running), WITHOUT spawning a PTY. */
function makeAgentTerminal(preset: "Claude Code" | "Codex"): UniversalTerminal {
  const term = new UniversalTerminal(
    `w4b-${Math.random().toString(16).slice(2)}`,
    ".",
    "bash",
    preset,
    "Human-in-the-Loop",
    "",
    "default_project",
    new ScriptedProbe(),
  );
  (term as any).shellPid = 1234; // runProbeTick early-returns without a shellPid
  term.status = "Running"; // a turn is in progress
  return term;
}

describe("W4(b): real UniversalTerminal.runProbeTick busy-check (integration)", () => {
  it("a busy tail makes the REAL runProbeTick emit an AUTHORITATIVE busy probe (Running)", async () => {
    // Exercises the actual seam: getRecentOutput(5) → adapter.isLikelyBusy → an
    // authoritative busy probe → decideStatus.setRunning. Pre-fix the interactive_cli
    // branch blindly emits {hasRunningChild:false, confidence:"fallback"}
    // (terminal.ts:811-814) REGARDLESS of the tail, so lastConfidence reads "fallback"
    // — the residual defect, observed at the production seam the replay cannot reach.
    const term = makeAgentTerminal("Claude Code");
    assert.strictEqual(term.runtimeType, "interactive_cli");
    term.outputBuffer = [CLAUDE_BUSY_SPINNER];

    (term as any).runProbeTick();

    assert.strictEqual(
      (term as any).lastConfidence,
      "authoritative",
      "a live busy tail must drive an AUTHORITATIVE probe, not the blanket fallback downgrade",
    );
    assert.strictEqual(term.status, "Running", "authoritative busy keeps the pane Running");
    assert.strictEqual((term as any).idleTimer, null, "an authoritative busy tick clears any pending idle timer");
    await term.stop();
  });

  it("2026 CLI (bead q1kp): a rested pane whose buffer RETAINS end-of-turn froth reads NOT busy at the seam", async () => {
    // Captured LIVE (scripts/smoke-completion-prompt.ts + debug probe): outputBuffer is
    // chunk-granular, and a rested pane appends NOTHING — so the busy window freezes on the last
    // turn's animation froth ("thinking with xhigh effort") and an OSC title chunk carrying a
    // star glyph, while the true screen bottom is the past-tense rest line + prompt. The seam
    // must judge the RENDERED SCREEN BOTTOM (last non-empty lines), not frozen froth chunks —
    // otherwise every real Claude pane is pinned Running forever after its first turn.
    const term = makeAgentTerminal("Claude Code");
    term.outputBuffer = [
      "·Architecting…101 tokens · ",
      "thinking with xhigh effort",
      "]0;✳ Respond with PONG",
      "✻Cogitated for 3s",
      "❯ ",
    ];

    (term as any).runProbeTick();

    assert.strictEqual(
      (term as any).lastConfidence,
      "fallback",
      "a rested pane (past-tense line + prompt at the screen bottom) must emit the fallback no-child probe even with frozen froth higher in the buffer",
    );
    await term.stop();
  });

  it("2026 CLI (bead q1kp): a frozen mid-gap thinking frame at the screen bottom still reads BUSY", async () => {
    // The converse guard: during a long silent thinking gap the NEWEST content is the frozen
    // effort frame itself — the screen bottom carries the working marker, and the pane must stay
    // authoritative-busy (the original BUG-006 protection).
    const term = makeAgentTerminal("Claude Code");
    term.outputBuffer = [
      "]0;✳ Respond with PONG",
      "✻ Ideating… (3s · thinking with xhigh effort)",
    ];

    (term as any).runProbeTick();

    assert.strictEqual(
      (term as any).lastConfidence,
      "authoritative",
      "a working frame at the screen bottom must keep the authoritative busy probe",
    );
    assert.strictEqual(term.status, "Running");
    await term.stop();
  });

  it("a quiet tail makes the REAL runProbeTick re-arm the quiescence debounce at exactly agentIdleTimeoutMs", async () => {
    // The not-busy path at the production seam: a fallback no-child probe whose
    // decideStatus recovery re-arms the quiescence debounce (once) on a Running
    // interactive_cli pane. The captured armed delay PINS THE FLOOR: it must equal
    // agentIdleTimeoutMs (3500ms). Pre-fix the fallback probe is ignored (decideStatus
    // NO_CHANGE), nothing arms, and the capture stays -1 (RED). A fix that instead
    // emitted an AUTHORITATIVE no-child probe would arm at
    // max(idleTimeoutMs, probeIntervalMs) ≈ 2000ms — this assertion catches that floor
    // collapse, which the W4(c) replay (synthProbe hardcodes fallback) cannot.
    const term = makeAgentTerminal("Claude Code");
    term.outputBuffer = ["Here is the summary of the change.", "> "]; // settled composer, no marker

    let captured = -1;
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: any, ms?: number) => {
      captured = ms ?? 0;
      return realSetTimeout(() => {}, 100000) as any; // a real, cleanable handle that never fires fn
    };
    try {
      (term as any).runProbeTick();
    } finally {
      (globalThis as any).setTimeout = realSetTimeout;
    }

    assert.strictEqual(term.status, "Running", "arming the debounce does not itself change status");
    assert.strictEqual((term as any).lastConfidence, "fallback", "no working marker ⇒ a fallback no-child probe");
    assert.strictEqual(
      captured,
      term.agentIdleTimeoutMs,
      `the quiescence debounce must re-arm at the agentIdleTimeoutMs floor (${term.agentIdleTimeoutMs}ms), not a shortened authoritative floor`,
    );
    await term.stop();
  });
});
