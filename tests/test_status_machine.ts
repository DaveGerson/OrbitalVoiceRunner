import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  decideStatus,
  Status,
  RuntimeType,
} from "../src/statusMachine";
import type { ProbeResult } from "../src/statusProbe";

/**
 * Replay harness (design §7.1, closes BUG-038). Feeds a timeline of
 * output-chunk / probe / input events through the PURE decideStatus() function,
 * faithfully simulating the terminal's timer + bookkeeping (confidence,
 * idleTimerArmed, sawWorkSinceIdle, and the debounced idleTimer firing on a
 * virtual clock). Asserts the resulting status timeline and the onIdle count.
 *
 * This mirrors UniversalTerminal.applyStatusEvent exactly so the replay is a
 * true test of production behavior, not a parallel reimplementation of policy.
 */

type Ev =
  | { kind: "output"; text: string }
  | { kind: "probe"; probe: ProbeResult }
  | { kind: "input" }
  | { kind: "idleTimer" };

interface TimedEvent {
  t: number;
  event: Ev;
}

interface ReplayResult {
  timeline: { t: number; status: Status }[];
  onIdleCount: number;
  finalStatus: Status;
}

function replay(
  events: TimedEvent[],
  opts: { runtimeType: RuntimeType; idleTimeoutMs: number; recentTail?: () => string }
): ReplayResult {
  let status: Status = "Idle";
  let confidence: "authoritative" | "fallback" = "fallback";
  let sawWorkSinceIdle = false;
  // virtual idle timer: the absolute virtual time it is scheduled to fire, or null.
  let idleTimerAt: number | null = null;
  const timeline: { t: number; status: Status }[] = [];
  let onIdleCount = 0;
  const tail = opts.recentTail ?? (() => "");

  const apply = (now: number, event: Ev) => {
    if (status === "Exited") return;
    if (event.kind === "probe") confidence = event.probe.confidence;
    if (
      event.kind === "input" ||
      (event.kind === "probe" &&
        event.probe.confidence === "authoritative" &&
        event.probe.hasRunningChild)
    ) {
      sawWorkSinceIdle = true;
    }

    const result = decideStatus({
      event,
      currentStatus: status,
      runtimeType: opts.runtimeType,
      recentTail: tail(),
      confidence,
      idleTimerArmed: idleTimerAt !== null,
    });

    // P0-2: mirror UniversalTerminal — an output-driven Running transition (from a
    // non-Running state) in fallback mode counts as genuine work so the eventual
    // Running->Idle edge fires onIdle (the legacy transport + post-P0-1 agents).
    if (
      event.kind === "output" &&
      confidence === "fallback" &&
      result.status === "Running" &&
      status !== "Running"
    ) {
      sawWorkSinceIdle = true;
    }

    if (result.clearIdleTimer) idleTimerAt = null;
    if (result.armIdleTimer) idleTimerAt = now + opts.idleTimeoutMs;

    if (result.status !== status) {
      status = result.status;
    }
    if (result.fireOnIdle) {
      const realDone = sawWorkSinceIdle;
      sawWorkSinceIdle = false;
      if (realDone) onIdleCount++;
    }
  };

  // Merge scripted events with virtual idleTimer fires, processed in time order.
  const queue = [...events].sort((a, b) => a.t - b.t);
  let i = 0;
  let clock = 0;
  const lastT = queue.length ? queue[queue.length - 1].t : 0;
  // Drive the clock forward, firing the idle timer whenever it elapses.
  while (i < queue.length || (idleTimerAt !== null && idleTimerAt <= lastT + opts.idleTimeoutMs)) {
    const nextEventT = i < queue.length ? queue[i].t : Infinity;
    const nextTimerT = idleTimerAt ?? Infinity;
    if (nextTimerT <= nextEventT && nextTimerT !== Infinity) {
      clock = nextTimerT;
      idleTimerAt = null;
      apply(clock, { kind: "idleTimer" });
      timeline.push({ t: clock, status });
    } else if (nextEventT !== Infinity) {
      clock = queue[i].t;
      apply(clock, queue[i].event);
      timeline.push({ t: clock, status });
      i++;
    } else {
      break;
    }
  }

  return { timeline, onIdleCount, finalStatus: status };
}

function loadFixture(name: string): TimedEvent[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(__dirname, "fixtures", "status", name);
  return fs
    .readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .filter((o) => o.event) // skip the _comment line
    .map((o) => ({ t: o.t, event: o.event }));
}

describe("status state machine replay (BUG-038)", () => {
  it("BUG-006: long-silent build with probe=busy stays Running, then exactly one Running->Idle", () => {
    const events = loadFixture("bug006_silent_build.jsonl");
    const r = replay(events, { runtimeType: "shell", idleTimeoutMs: 2000 });

    // Through the silent build (t<4000) the status must NEVER be Idle.
    for (const { t, status } of r.timeline) {
      if (t < 4000) {
        assert.notStrictEqual(status, "Idle", `false Idle at t=${t} during a running build (BUG-006)`);
      }
    }
    // The child exits at t=4000 (probe=false); after idleTimeout (2000ms) => Idle.
    assert.strictEqual(r.finalStatus, "Idle", "must reach Idle after the build finishes");
    assert.strictEqual(r.onIdleCount, 1, "exactly one onIdle on the genuine Running->Idle edge (I3)");
  });

  it("a line ending in `$`/`?` while probe=busy stays Running (kills the over-broad :229 regex)", () => {
    // The exact prompt-looking output that previously flipped to Idle.
    const events: TimedEvent[] = [
      { t: 0, event: { kind: "input" } },
      { t: 100, event: { kind: "probe", probe: { hasRunningChild: true, confidence: "authoritative" } } },
      { t: 200, event: { kind: "output", text: "Building project... done? $" } },
      { t: 300, event: { kind: "probe", probe: { hasRunningChild: true, confidence: "authoritative" } } },
      { t: 400, event: { kind: "output", text: "still compiling > " } },
      { t: 500, event: { kind: "probe", probe: { hasRunningChild: true, confidence: "authoritative" } } },
    ];
    const r = replay(events, {
      runtimeType: "shell",
      idleTimeoutMs: 2000,
      recentTail: () => "Building project... done? $",
    });
    assert.ok(r.timeline.every((x) => x.status === "Running"), "must stay Running on $/?-ending output while busy");
    assert.strictEqual(r.onIdleCount, 0);
  });

  it("probe -> not-busy + idleTimeout => exactly one Running->Idle + one onIdle (I3)", () => {
    const events: TimedEvent[] = [
      { t: 0, event: { kind: "input" } },
      { t: 100, event: { kind: "probe", probe: { hasRunningChild: true, confidence: "authoritative" } } },
      { t: 600, event: { kind: "probe", probe: { hasRunningChild: true, confidence: "authoritative" } } },
      { t: 1100, event: { kind: "probe", probe: { hasRunningChild: false, confidence: "authoritative" } } },
      { t: 1600, event: { kind: "probe", probe: { hasRunningChild: false, confidence: "authoritative" } } },
      { t: 2100, event: { kind: "probe", probe: { hasRunningChild: false, confidence: "authoritative" } } },
    ];
    const r = replay(events, { runtimeType: "shell", idleTimeoutMs: 1000 });
    const idleEdges = r.timeline.filter((x, idx) => x.status === "Idle" && (idx === 0 || r.timeline[idx - 1].status !== "Idle"));
    assert.strictEqual(idleEdges.length, 1, "exactly one Running->Idle edge");
    assert.strictEqual(r.onIdleCount, 1, "exactly one onIdle");
    assert.strictEqual(r.finalStatus, "Idle");
  });

  it("repeated 'no child' probes do not keep re-arming the timer (it actually fires)", () => {
    // idleTimeout 1000ms, probes every 200ms reporting no-child. Naive re-arm
    // would never let the 1000ms timer elapse; here it must fire.
    const events: TimedEvent[] = [
      { t: 0, event: { kind: "input" } },
      { t: 100, event: { kind: "probe", probe: { hasRunningChild: true, confidence: "authoritative" } } },
    ];
    for (let t = 300; t <= 2000; t += 200) {
      events.push({ t, event: { kind: "probe", probe: { hasRunningChild: false, confidence: "authoritative" } } });
    }
    const r = replay(events, { runtimeType: "shell", idleTimeoutMs: 1000 });
    assert.strictEqual(r.finalStatus, "Idle", "the debounced timer must eventually fire");
    assert.strictEqual(r.onIdleCount, 1);
  });

  it("interactive_cli never Idles on a prompt-looking line in fallback mode (I4)", () => {
    // Fallback confidence (no authoritative probe). A prompt-looking line must
    // not, by itself, idle an interactive_cli pane — only quiescence (debounced)
    // can, and never via the prompt regex.
    const events: TimedEvent[] = [
      { t: 0, event: { kind: "input" } },
      { t: 100, event: { kind: "output", text: "agent> $ " } },
      { t: 200, event: { kind: "probe", probe: { hasRunningChild: false, confidence: "fallback" } } },
    ];
    const r = replay(events, {
      runtimeType: "interactive_cli",
      idleTimeoutMs: 2000,
      recentTail: () => "agent> $ ",
    });
    // Immediately after the prompt-looking line, while output is still recent, it
    // must NOT already be Idle (the over-broad regex would have idled here).
    const atPrompt = r.timeline.find((x) => x.t === 100);
    assert.strictEqual(atPrompt?.status, "Running", "prompt-looking line must not flip interactive_cli to Idle");
  });

  it("agent-at-rest (interactive_cli, P0-1 gate): output then quiescence reaches Idle + onIdle once", () => {
    // After the P0-1 gate, an interactive_cli pane only ever receives
    // {hasRunningChild:false, confidence:"fallback"} probes — it NEVER sees an
    // authoritative busy probe. A turn is driven by OUTPUT (not necessarily a
    // preceding writeInput): the agent emits its answer, then goes quiet. With
    // the P0-2 fix, that output-driven Running transition counts as work, so the
    // quiescence (idleTimer) Running->Idle edge must fire onIdle exactly once.
    const events: TimedEvent[] = [
      // The probe gate downgrades every agent tick to a fallback no-child probe.
      { t: 0, event: { kind: "probe", probe: { hasRunningChild: false, confidence: "fallback" } } },
      // The agent streams its turn output (no writeInput drove it).
      { t: 100, event: { kind: "output", text: "Thinking..." } },
      { t: 300, event: { kind: "output", text: "Here is the answer." } },
      // Another gated probe tick mid-turn — still fallback no-child, must not idle early.
      { t: 400, event: { kind: "probe", probe: { hasRunningChild: false, confidence: "fallback" } } },
      // ...then the agent goes quiet at its own prompt.
    ];
    const r = replay(events, {
      runtimeType: "interactive_cli",
      idleTimeoutMs: 2000,
      recentTail: () => "Here is the answer.",
    });
    // Once the turn's output starts (t>=100) and until quiescence elapses
    // (last output 300 + 2000 = 2300), the pane must read Running, never Idle.
    // (Before any output the pane is legitimately at rest = the initial Idle.)
    for (const { t, status } of r.timeline) {
      if (t >= 100 && t < 2300) {
        assert.notStrictEqual(status, "Idle", `agent must not idle mid-turn at t=${t}`);
      }
    }
    assert.strictEqual(r.finalStatus, "Idle", "agent must reach Idle after quiescence");
    assert.strictEqual(r.onIdleCount, 1, "exactly one onIdle for the agent's finished turn (P0-1 + P0-2)");
  });

  it("fallback-mode shell (P0-2): output then quiescence => Idle + exactly one onIdle", () => {
    // Legacy script/cmd.exe transport path (I5): work arrives as OUTPUT with no
    // preceding writeInput and no authoritative probe. Pre-P0-2 the idleTimer
    // would fire with sawWorkSinceIdle=false and SWALLOW onIdle (worse than
    // today). P0-2 makes the output-driven Running transition count as work.
    const events: TimedEvent[] = [
      { t: 0, event: { kind: "output", text: "$ ./run.sh" } },
      { t: 200, event: { kind: "output", text: "building..." } },
      { t: 500, event: { kind: "output", text: "done" } },
      // then silence -> idleTimer fires after idleTimeoutMs.
    ];
    const r = replay(events, {
      runtimeType: "shell",
      idleTimeoutMs: 1000,
      recentTail: () => "done\nuser@host:~$ ",
    });
    assert.strictEqual(r.finalStatus, "Idle", "fallback shell must reach Idle on quiescence");
    assert.strictEqual(r.onIdleCount, 1, "exactly one onIdle on output-driven completion (encodes P0-2)");
    // Sanity: it was Running while output was streaming.
    const atFirstOutput = r.timeline.find((x) => x.t === 0);
    assert.strictEqual(atFirstOutput?.status, "Running", "output drives Running in fallback mode");
  });

  it("Exited is terminal and immune to lower tiers (Tier 0)", () => {
    // Simulate reaching Exited, then ensure a later probe cannot revive it.
    let status: Status = "Exited";
    const res = decideStatus({
      event: { kind: "probe", probe: { hasRunningChild: true, confidence: "authoritative" } },
      currentStatus: status,
      runtimeType: "shell",
      recentTail: "",
      confidence: "authoritative",
      idleTimerArmed: false,
    });
    assert.strictEqual(res.status, "Exited");
  });
});
