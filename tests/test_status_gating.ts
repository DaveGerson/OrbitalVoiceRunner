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
