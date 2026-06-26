// tests/test_pythonclient_discovery_budget.ts — Inc 2 task 2.4 (F7): interpreter DISCOVERY failures
// must not spend circuit-breaker budget the way RUNTIME crashes do. Cycling candidates to find a
// working python (py → python3 → …) is "wrong interpreter, try the next", not a fault; penalizing it
// per-candidate could trip the breaker right before the real interpreter is found (cold-start
// fallback-only for the whole cooldown). The contract:
//   • a mid-sweep candidate-advance spends NOTHING,
//   • a COMPLETED sweep (every candidate tried once) counts as ONE failure — and discovery sweeps do
//     NOT decay on the wall-clock window (a sweep spans cands.length × backoff and can exceed
//     breakerWindowMs; a wall-clock reset there would keep the breaker from EVER opening for a
//     genuinely-absent interpreter → a respawn loop forever),
//   • a post-handshake RUNTIME crash ALWAYS spends budget AND decays on the window (the breaker still
//     protects a crash-loop without over-reacting to isolated, time-spread crashes).
// Drives the generic core with a FRESH FakeChild per spawn (prod-faithful); failures are induced by
// emitting 'exit' BEFORE a pong (a discovery miss) or AFTER a pong (a runtime crash). Covers BOTH
// win32 (3 candidates) and linux (2 candidates) so the window-vs-sweep-cadence interaction is real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPythonModuleClient, type PythonModuleClientOpts } from "../src/memory/pythonClient";

class FakeChild extends EventEmitter {
  stdin = { write: (s: string) => { this.written.push(s); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  kill() { /* no-op */ }
  reply(obj: Record<string, unknown>) {
    const last = JSON.parse(this.written[this.written.length - 1]);
    this.stdout.emit("data", Buffer.from(JSON.stringify({ id: last.id, ...obj }) + "\n"));
  }
}
const PONG = { v: 1, ok: true, pong: true, synthVersion: "1.0.0" };
const tick = () => new Promise((r) => setImmediate(r));
const settle = () => new Promise((r) => setTimeout(r, 6)); // let the ~1ms backoff respawn fire

function spawn(overrides: Partial<PythonModuleClientOpts>) {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const core = createPythonModuleClient({
    moduleDir: "/repo/src/memory", repoRoot: "/repo", existsSync: () => true,
    platform: "linux", pingTimeoutMs: 100_000, // huge by default: the ping-timeout never fires; WE drive failures
    backoffBaseMs: 1, backoffMaxMs: 1, breakerThreshold: 2, breakerWindowMs: 100_000, cooldownMs: 100_000,
    spawnImpl: (() => { const c = new FakeChild(); children.push(c); return c; }) as any,
    log: (l: string) => logs.push(l),
    ...overrides,
  });
  return { core, children, logs };
}
const opened = (logs: string[]) => logs.some((l) => /circuit breaker OPEN/.test(l));

test("F7: a successful multi-candidate discovery spends ZERO budget (the cold-start win)", async () => {
  // threshold=1 makes candidate0's miss a REAL lock: PRE-fix that miss spent cf=1 ≥ 1 → breaker OPEN
  // → candidate1 never spawned. Post-fix the miss is free, so discovery reaches candidate1 and pongs.
  const { core, children, logs } = spawn({ platform: "linux", breakerThreshold: 1 });
  await tick(); // eager spawn -> children[0] (candidate0)
  children[0].emit("exit"); await settle(); // candidate0 missing (mid-sweep miss: must be FREE)
  assert.ok(children.length >= 2, "candidate0's miss must not trip the breaker; discovery must reach candidate1");
  children[1].reply(PONG); // candidate1 works
  await tick();
  assert.equal(core.available(), true, "the daemon connected on candidate1");
  assert.ok(!opened(logs), "a successful multi-candidate discovery must never open the breaker");
  core.dispose();
});

test("F7: a discovery SWEEP counts as one budget unit — mid-sweep advances are free", async () => {
  // linux = 2 candidates, threshold=2 => the breaker needs TWO full sweeps (4 misses), not two misses.
  const { core, children, logs } = spawn({ platform: "linux", breakerThreshold: 2 });
  const failOnce = async (i: number) => { children[i].emit("exit"); await settle(); };
  await tick();
  await failOnce(0); // candidate0 (mid-sweep: spends nothing)
  await failOnce(1); // candidate1 (sweep #1 complete: spends 1)
  assert.ok(!opened(logs), "one sweep (2 candidate misses) must NOT trip a threshold-2 breaker");
  await failOnce(2); // candidate0 again (mid-sweep: free)
  await failOnce(3); // candidate1 (sweep #2 complete: spends 2 -> OPEN)
  assert.ok(opened(logs), "two sweeps must open the breaker");
  core.dispose();
});

test("F7: an absent interpreter on win32 with the DEFAULT window still opens the breaker (no infinite loop)", async () => {
  // The regression this guards: per-sweep spends land cands.length × backoff apart, which can exceed
  // breakerWindowMs. If discovery spends DECAYED on the wall-clock window (the bug), the streak would
  // zero every sweep and the breaker would NEVER open on win32 (3 candidates) — a respawn loop forever.
  // Here the window (10ms) is deliberately narrower than a sweep's real-time span (3 misses × 6ms),
  // so a decaying implementation can never reach threshold; the correct (non-decaying) one opens.
  const { core, children, logs } = spawn({ platform: "win32", breakerThreshold: 2, breakerWindowMs: 10 });
  await tick();
  for (let i = 0; i < 6; i++) { children[i].emit("exit"); await settle(); } // 2 full sweeps of 3 candidates
  assert.ok(opened(logs), "discovery spends must NOT decay on the window; the breaker must open for an absent interpreter");
  core.dispose();
});

test("F7: post-handshake RUNTIME crashes ALWAYS spend budget (the breaker still protects)", async () => {
  const { core, children, logs } = spawn({ platform: "linux", breakerThreshold: 2 });
  await tick();
  children[0].reply(PONG); // handshake OK -> discovering=false (runtime regime)
  await tick();
  children[0].emit("exit"); await settle(); // runtime crash #1 -> spends budget (=1)
  children[1].emit("exit"); await settle(); // runtime crash #2, never re-ponged -> spends budget (=2 -> OPEN)
  assert.ok(opened(logs), "two consecutive runtime crashes must open a threshold-2 breaker");
  core.dispose();
});

test("F7: isolated RUNTIME crashes spread BEYOND the window do NOT open the breaker (decay preserved)", async () => {
  // The complement of the win32 test: runtime spends MUST still decay on the wall-clock window, so a
  // daemon that crashes occasionally (each crash > window apart, no pong between) doesn't accumulate.
  const { core, children, logs } = spawn({ platform: "linux", breakerThreshold: 2, breakerWindowMs: 5 });
  await tick();
  children[0].reply(PONG); // ready -> runtime regime
  await tick();
  children[0].emit("exit"); await settle(); // crash #1 (firstFailAt set, cf=1)
  await new Promise((r) => setTimeout(r, 12)); // wait past the 5ms window
  children[1].emit("exit"); await settle(); // crash #2 > window later -> decays -> cf back to 1, NOT 2
  assert.ok(!opened(logs), "runtime crashes spaced beyond breakerWindowMs must decay, not accumulate to OPEN");
  core.dispose();
});
