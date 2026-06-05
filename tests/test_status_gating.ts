import { describe, it } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import { FallbackProbe } from "../src/statusProbe";
import type { StatusProbe, ProbeResult } from "../src/statusProbe";

/**
 * Direct tests for the runProbeTick / applyStatusEvent gating on a REAL
 * UniversalTerminal with an injected fake StatusProbe (closes the coverage gap
 * the accuracy review flagged). These never call start(), so no PTY is spawned;
 * they drive the private status methods directly and always tear timers down via
 * stop() so the suite exits cleanly.
 */

/** A StatusProbe whose answer is fully scripted (no real processes). */
class FakeProbe implements StatusProbe {
  public calls = 0;
  constructor(private result: ProbeResult) {}
  set(result: ProbeResult) { this.result = result; }
  probe(_shellPid: number): ProbeResult {
    this.calls++;
    return this.result;
  }
}

/** Build a terminal wired to a fake probe, with a fake root pid, WITHOUT spawning. */
function makeTerminal(
  toolPreset: "Custom" | "Claude Code",
  probe: StatusProbe
): UniversalTerminal {
  const term = new UniversalTerminal(
    `gate-${Math.random().toString(16).slice(2)}`,
    ".",
    "bash",
    toolPreset,
    "Human-in-the-Loop",
    "",
    "default_project",
    probe
  );
  // Simulate the part of start() the gating needs, without a transport.
  (term as any).shellPid = 1234;
  term.status = "Running";
  return term;
}

async function teardown(term: UniversalTerminal) {
  // stop() clears the probe + idle timers even with no transport, so nothing
  // keeps the event loop alive.
  await term.stop();
}

describe("runProbeTick / applyStatusEvent gating (real terminal, fake probe)", () => {
  it("interactive_cli (P0-1 gate): authoritative probe is NEVER consulted", async () => {
    // An agent-at-rest reads authoritative-busy forever; the gate must downgrade
    // every tick to a fallback no-child probe and never call the real probe.
    const probe = new FakeProbe({ hasRunningChild: true, confidence: "authoritative" });
    const term = makeTerminal("Claude Code", probe);
    assert.strictEqual(term.runtimeType, "interactive_cli");

    (term as any).runProbeTick();
    assert.strictEqual(probe.calls, 0, "authoritative probe must not be called for interactive_cli");
    // confidence recorded as fallback (drives quiescence idle), status unchanged.
    assert.strictEqual((term as any).lastConfidence, "fallback");
    await teardown(term);
  });

  it("shell pane DOES consult the authoritative probe (busy keeps Running)", async () => {
    const probe = new FakeProbe({ hasRunningChild: true, confidence: "authoritative" });
    const term = makeTerminal("Custom", probe);
    assert.strictEqual(term.runtimeType, "shell");

    (term as any).runProbeTick();
    assert.strictEqual(probe.calls, 1, "shell pane runs the authoritative probe");
    assert.strictEqual(term.status, "Running", "authoritative busy ⇒ Running");
    await teardown(term);
  });

  it("C1 analogue: shell pane whose probe reports resting-shell idle reaches Idle + onIdle", async () => {
    // The shell-aware Windows probe now returns hasRunningChild:false for a
    // resting `cmd.exe -> cmd.exe` tree. Drive the terminal with that result and a
    // short idle timeout; it must debounce to Idle and fire onIdle exactly once.
    const probe = new FakeProbe({ hasRunningChild: true, confidence: "authoritative" });
    const term = makeTerminal("Custom", probe);
    let idleFired = 0;
    term.onIdle = () => { idleFired++; };
    term.idleTimeoutMs = 30;

    // First a busy tick so there is genuine work since idle (sawWorkSinceIdle).
    (term as any).runProbeTick();
    assert.strictEqual(term.status, "Running");
    // Now the command finishes / shell rests ⇒ probe reports no running child.
    probe.set({ hasRunningChild: false, confidence: "authoritative" });
    (term as any).runProbeTick();
    // Wait out the (floored) idle debounce, then assert Idle + one onIdle.
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(term.status, "Idle", "no running child + debounce ⇒ Idle");
    assert.strictEqual(idleFired, 1, "exactly one onIdle on the genuine Running->Idle edge");
    await teardown(term);
  });

  it("C4: idleTimeoutMs < probeIntervalMs does not produce a spurious early onIdle", async () => {
    // With idleTimeoutMs (10) far below probeIntervalMs (500), the authoritative
    // debounce is floored at probeIntervalMs so a reappearing child has a chance
    // to re-confirm before "done" fires. Arm the idle timer with a no-child probe,
    // then BEFORE probeIntervalMs elapses, deliver a busy probe — no onIdle.
    const probe = new FakeProbe({ hasRunningChild: true, confidence: "authoritative" });
    const term = makeTerminal("Custom", probe);
    let idleFired = 0;
    term.onIdle = () => { idleFired++; };
    term.idleTimeoutMs = 10; // smaller than the 500ms probe interval

    (term as any).runProbeTick(); // busy ⇒ Running, work seen
    probe.set({ hasRunningChild: false, confidence: "authoritative" });
    (term as any).runProbeTick(); // arms the (floored) idle debounce

    // After 50ms (> the naive 10ms timeout, < the 500ms floor) the child reappears.
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(term.status, "Running", "must NOT have idled within the floored debounce");
    assert.strictEqual(idleFired, 0, "no spurious onIdle before the floor elapses");

    probe.set({ hasRunningChild: true, confidence: "authoritative" });
    (term as any).runProbeTick(); // re-confirm busy, cancels the pending idle timer
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(term.status, "Running", "re-confirmed busy stays Running");
    assert.strictEqual(idleFired, 0, "still no spurious onIdle");
    await teardown(term);
  });

  it("Phase 1 ears: onRunning fires EXACTLY ONCE on the Idle->Running edge, never on Running->Running ticks", async () => {
    // Mirror of the onIdle edge-once invariant (I3/I5), but for the symmetric "beginning"
    // edge. A shell pane starts Idle; an authoritative busy probe drives it INTO Running
    // (the genuine edge -> onRunning once). Subsequent busy ticks keep it Running and must
    // NOT re-fire onRunning (the bus debounce is a second line of defense, but the EDGE
    // itself must be exact so a long-running pane can't re-publish each debounce window).
    const probe = new FakeProbe({ hasRunningChild: false, confidence: "authoritative" });
    const term = makeTerminal("Custom", probe);
    term.status = "Idle"; // start from a non-Running prior status so the first busy tick is a real edge
    let runningFired = 0;
    term.onRunning = () => { runningFired++; };

    // No-child tick first: stays Idle, no edge.
    (term as any).runProbeTick();
    assert.strictEqual(term.status, "Idle", "no running child keeps it Idle");
    assert.strictEqual(runningFired, 0, "no onRunning without a Running edge");

    // Busy tick: Idle -> Running is the genuine edge -> onRunning once.
    probe.set({ hasRunningChild: true, confidence: "authoritative" });
    (term as any).runProbeTick();
    assert.strictEqual(term.status, "Running", "authoritative busy ⇒ Running");
    assert.strictEqual(runningFired, 1, "exactly one onRunning on the Idle->Running edge");

    // Two more busy ticks: Running -> Running is NOT an edge -> no re-fire.
    (term as any).runProbeTick();
    (term as any).runProbeTick();
    assert.strictEqual(runningFired, 1, "onRunning does NOT re-fire while the pane stays Running");
    await teardown(term);
  });

  it("Phase 1 ears: writeInput drives the Running edge so command dispatch fires onRunning once", async () => {
    // writeInput -> applyStatusEvent({kind:'input'}) -> Running. A pane sitting Idle that
    // receives a command is a beginning; assert the single edge emission covers dispatch too.
    const probe = new FakeProbe({ hasRunningChild: false, confidence: "fallback" });
    const term = makeTerminal("Custom", probe);
    term.status = "Idle";
    let runningFired = 0;
    term.onRunning = () => { runningFired++; };

    (term as any).applyStatusEvent({ kind: "input" });
    assert.strictEqual(term.status, "Running", "input optimistically marks Running (Tier A kick)");
    assert.strictEqual(runningFired, 1, "the input-driven Idle->Running edge fires onRunning once");

    // A second input while already Running is not a new edge.
    (term as any).applyStatusEvent({ kind: "input" });
    assert.strictEqual(runningFired, 1, "no re-fire on a Running->Running input");
    await teardown(term);
  });

  it("Conservative Phase 2: onQuiescing fires once on the armed-timer edge while STILL Running (no new idle)", async () => {
    // The "cooking…" overlay is a pure OBSERVATION of the pre-idle debounce window the state
    // machine already arms — it must NOT change WHEN idle is declared. For an interactive_cli
    // (fallback) pane: an output chunk arms the idle timer (status stays Running) and fires
    // onQuiescing exactly once synchronously, while onIdle has NOT fired and status is STILL
    // Running. Only after the (agent) timeout does onIdle fire exactly once and status become Idle.
    const probe = new FakeProbe({ hasRunningChild: false, confidence: "fallback" });
    const term = makeTerminal("Claude Code", probe);
    assert.strictEqual(term.runtimeType, "interactive_cli");
    term.status = "Idle";
    term.agentIdleTimeoutMs = 40; // short agent timeout so the test is fast
    let quiescingFired = 0;
    let idleFired = 0;
    term.onQuiescing = () => { quiescingFired++; };
    term.onIdle = () => { idleFired++; };

    // Output drives Running in fallback mode AND arms the idle (quiescence) timer => the
    // quiescing edge. Synchronously: cooking is observed, true idle is NOT yet declared.
    (term as any).applyStatusEvent({ kind: "output", text: "thinking..." });
    assert.strictEqual(term.status, "Running", "output keeps it Running — NOT idle yet");
    assert.strictEqual(quiescingFired, 1, "exactly one onQuiescing on the false->armed edge");
    assert.strictEqual(idleFired, 0, "true idle is NOT declared on the quiescing edge");
    assert.strictEqual((term as any).quiescing, true, "the quiescing flag is set while the timer is armed");

    // A second output chunk re-arms the SAME window (fallback re-arms each chunk) — must NOT
    // re-fire onQuiescing (still inside the one armed window).
    (term as any).applyStatusEvent({ kind: "output", text: "still thinking..." });
    assert.strictEqual(quiescingFired, 1, "onQuiescing does NOT re-fire while the window stays armed");

    // Wait out the agent timeout: NOW true idle fires exactly once and the cooking flag clears.
    await new Promise((r) => setTimeout(r, 90));
    assert.strictEqual(term.status, "Idle", "the timer eventually declares Idle (unchanged idle logic)");
    assert.strictEqual(idleFired, 1, "exactly one onIdle on the genuine Running->Idle edge");
    assert.strictEqual((term as any).quiescing, false, "the quiescing flag clears once Idle is declared");
    await teardown(term);
  });

  it("Conservative Phase 2: resumed work cancels quiescing (self-correcting), no spurious onIdle", async () => {
    // Arm the quiescing edge (output), then a busy authoritative probe before the timeout
    // resumes work: status returns to/stays Running, the quiescing flag clears, and NO idle.
    // Guards the self-correcting property (the next output republishes running).
    const probe = new FakeProbe({ hasRunningChild: false, confidence: "fallback" });
    const term = makeTerminal("Custom", probe); // shell pane (fallback output-driven)
    term.status = "Idle";
    term.idleTimeoutMs = 80;
    let quiescingFired = 0;
    let idleFired = 0;
    term.onQuiescing = () => { quiescingFired++; };
    term.onIdle = () => { idleFired++; };

    (term as any).applyStatusEvent({ kind: "output", text: "building..." });
    assert.strictEqual(quiescingFired, 1, "quiescing armed on first output");
    assert.strictEqual((term as any).quiescing, true);

    // Resumed work via an authoritative busy probe cancels the idle timer (setRunning =>
    // clearIdleTimer) => the cooking flag must clear.
    probe.set({ hasRunningChild: true, confidence: "authoritative" });
    (term as any).runProbeTick();
    assert.strictEqual(term.status, "Running", "busy probe keeps it Running");
    assert.strictEqual((term as any).quiescing, false, "quiescing clears when work resumes (timer cleared)");

    // Past the original idle window: no idle fired (work resumed), and a NEW quiescing window
    // can arm honestly on the next quiescence.
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(idleFired, 0, "no spurious onIdle — work resumed before the window elapsed");
    await teardown(term);
  });

  it("Conservative Phase 2 safeguard: interactive_cli uses a LARGER effective idle timeout than a shell pane", async () => {
    // The low-risk timing safeguard (fact [F]): agents are forced to the fallback path, where
    // quiet != done. Bump their effective fallback idle timeout above a shell pane's so a brief
    // agent pause is less likely to read as premature 'done'. Shell panes are UNCHANGED.
    // Measure the armed delay via a fake setTimeout so no real wall-clock is needed.
    function armedDelayFor(preset: "Custom" | "Claude Code", overrides?: (t: UniversalTerminal) => void): number {
      const probe = new FakeProbe({ hasRunningChild: false, confidence: "fallback" });
      const term = makeTerminal(preset, probe);
      term.status = "Idle";
      if (overrides) overrides(term);
      let captured = -1;
      const realSetTimeout = globalThis.setTimeout;
      (globalThis as any).setTimeout = (fn: any, ms?: number) => {
        captured = ms ?? 0;
        return realSetTimeout(() => {}, 100000) as any; // a real (cleanable) handle, never fires fn
      };
      try {
        (term as any).applyStatusEvent({ kind: "output", text: "x" });
      } finally {
        (globalThis as any).setTimeout = realSetTimeout;
      }
      // Clean the dummy timer the patched setTimeout created on the term.
      const t = (term as any).idleTimer;
      if (t) clearTimeout(t);
      return captured;
    }

    const shellDelay = armedDelayFor("Custom");
    const agentDelay = armedDelayFor("Claude Code");
    assert.strictEqual(shellDelay, 2000, "shell pane keeps the documented 2000ms idle timeout (no regression)");
    assert.ok(agentDelay > shellDelay, `interactive_cli idle timeout (${agentDelay}) must exceed the shell timeout (${shellDelay})`);
    assert.strictEqual(agentDelay, 3500, "interactive_cli default agentIdleTimeoutMs is the modest 3500ms bump");

    // And it is honored after an explicit override.
    const overridden = armedDelayFor("Claude Code", (t) => { t.agentIdleTimeoutMs = 5000; });
    assert.strictEqual(overridden, 5000, "an explicit agentIdleTimeoutMs override is honored on the fallback arm");
  });

  it("C2: a FallbackProbe never yields an authoritative busy signal (legacy-transport degrade)", async () => {
    // start() swaps in a FallbackProbe when usingNodePty is false, so the legacy
    // (script/cmd.exe) transport degrades to quiescence-driven idle rather than an
    // unvalidated authoritative probe. Verify the probe the swap installs reports
    // fallback confidence and no running child, and that a shell pane driven by it
    // idles purely on quiescence (output then silence ⇒ Idle + one onIdle).
    const fb = new FallbackProbe();
    const r = fb.probe(1234);
    assert.deepStrictEqual(r, { hasRunningChild: false, confidence: "fallback" });

    const term = makeTerminal("Custom", fb);
    term.status = "Idle";
    let idleFired = 0;
    term.onIdle = () => { idleFired++; };
    term.idleTimeoutMs = 30;

    // Fallback gating: a probe tick is a fallback no-child (NO authoritative busy).
    (term as any).runProbeTick();
    assert.strictEqual((term as any).lastConfidence, "fallback");
    // Output drives Running in fallback mode; then silence debounces to Idle.
    (term as any).applyStatusEvent({ kind: "output", text: "building..." });
    assert.strictEqual(term.status, "Running", "output drives Running in fallback mode");
    await new Promise((res) => setTimeout(res, 80));
    assert.strictEqual(term.status, "Idle", "quiescence drives Idle in fallback mode");
    assert.strictEqual(idleFired, 1, "exactly one onIdle on the output-driven completion (P0-2)");
    await teardown(term);
  });
});
