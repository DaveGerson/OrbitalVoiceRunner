// Phase 4 Track E — Card 4E.2: async status probes.
//
// FINDING (verified): MacPsProbe / WindowsProbe ran execSync full-process-list scans on
// the 500ms probe interval per pane — 0.5-2s of blocked event loop per tick on a cold
// Windows CIM query. The platform probes are now promise-based (execFile / fs.promises),
// and UniversalTerminal.runProbeTick is async-safe:
//  - a tick is SKIPPED while a probe is still in flight (slow probes never stack);
//  - a probe rejection never throws out of the tick (it degrades to a fallback result);
//  - a SYNC probe result (every injected test probe, and the post-stop FallbackProbe)
//    still applies synchronously — the status-machine suites' timing is untouched.
//
// Mirrors tests/test_status_gating.ts: a REAL UniversalTerminal with an injected fake
// probe and a fake root pid, no transport spawned.

import { describe, it } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import { LinuxProcProbe } from "../src/statusProbe";
import type { StatusProbe, ProbeResult } from "../src/statusProbe";

class SlowProbe implements StatusProbe {
  public calls = 0;
  constructor(private result: ProbeResult, private delayMs: number) {}
  probe(_shellPid: number): Promise<ProbeResult> {
    this.calls++;
    return new Promise((resolve) => setTimeout(() => resolve(this.result), this.delayMs));
  }
}

class RejectingProbe implements StatusProbe {
  public calls = 0;
  probe(_shellPid: number): Promise<ProbeResult> {
    this.calls++;
    return Promise.reject(new Error("process scan blew up"));
  }
}

class SyncProbe implements StatusProbe {
  public calls = 0;
  constructor(private result: ProbeResult) {}
  probe(_shellPid: number): ProbeResult {
    this.calls++;
    return this.result;
  }
}

/** Build a shell terminal wired to a fake probe, with a fake root pid, WITHOUT spawning. */
function makeTerminal(probe: StatusProbe): UniversalTerminal {
  const term = new UniversalTerminal(
    `probe-${Math.random().toString(16).slice(2)}`,
    ".",
    "bash",
    "Custom",
    "Human-in-the-Loop",
    "",
    "default_project",
    probe,
  );
  (term as any).shellPid = 1234;
  term.status = "Idle";
  return term;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("4E.2 async status probes (in-flight skip, rejection safety, sync parity)", () => {
  it("overlapping ticks are skipped while an async probe is in flight (no stacking)", async () => {
    const probe = new SlowProbe({ hasRunningChild: true, confidence: "authoritative" }, 120);
    const term = makeTerminal(probe);

    (term as any).runProbeTick();
    (term as any).runProbeTick(); // would stack pre-fix
    (term as any).runProbeTick();
    assert.strictEqual(probe.calls, 1, "ticks during an in-flight probe must be skipped, not stacked");

    await sleep(200); // let the slow probe resolve and apply
    assert.strictEqual(term.status, "Running", "the resolved busy probe still drives the state machine");
    assert.strictEqual((term as any).lastConfidence, "authoritative");

    (term as any).runProbeTick(); // in-flight flag must be released after settle
    assert.strictEqual(probe.calls, 2, "after the probe settles, the next tick probes again");

    await sleep(150);
    await term.stop();
  });

  it("a probe rejection does not throw out of the tick and degrades to fallback", async () => {
    const probe = new RejectingProbe();
    const term = makeTerminal(probe);

    assert.doesNotThrow(() => (term as any).runProbeTick(), "a rejecting probe must not throw out of the tick");
    await sleep(30); // let the rejection settle (pre-fix: unhandled rejection crashes the run)
    assert.strictEqual(probe.calls, 1);
    assert.strictEqual(
      (term as any).lastConfidence,
      "fallback",
      "a failed probe applies as a fallback result (busy-biased semantics preserved)",
    );

    // The in-flight flag is released on rejection too.
    (term as any).runProbeTick();
    assert.strictEqual(probe.calls, 2, "rejection releases the in-flight gate");
    await sleep(30);
    await term.stop();
  });

  it("a SYNC probe result still applies synchronously (status-machine timing parity)", async () => {
    const probe = new SyncProbe({ hasRunningChild: true, confidence: "authoritative" });
    const term = makeTerminal(probe);

    (term as any).runProbeTick();
    // No await: the synchronous path must have applied already.
    assert.strictEqual(probe.calls, 1);
    assert.strictEqual(term.status, "Running", "sync probe results apply before the tick returns");
    assert.strictEqual((term as any).lastConfidence, "authoritative");
    await term.stop();
  });

  it("the Linux platform probe is promise-based and reports authoritative", async (t) => {
    if (process.platform !== "linux") {
      t.skip("platform probe smoke runs on linux only");
      return;
    }
    const probe = new LinuxProcProbe();
    const pending = probe.probe(process.pid);
    assert.strictEqual(typeof (pending as any)?.then, "function", "platform probes return a Promise (no sync /proc scan on the loop)");
    const result = await pending;
    assert.strictEqual(result.confidence, "authoritative");
    assert.strictEqual(typeof result.hasRunningChild, "boolean");
  });
});
