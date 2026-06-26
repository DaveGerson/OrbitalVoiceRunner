// tests/test_daemon_state_callback.ts — Inc 2 task 2.2 observability: the onStateChange transition
// callback on createPythonModuleClient. Drives the GENERIC core directly with a FakeChild harness
// (ported from tests/test_memory_python_client.ts) and an onStateChange spy collecting [state,reason]
// tuples. Proves: one emit per REAL flip (debounced — no repeats / no down-while-down spam), and a
// throwing callback can NEVER escape into the daemon state machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPythonModuleClient } from "../src/memory/pythonClient";

// A fake child process: captures stdin writes, lets the test emit stdout lines + exit.
class FakeChild extends EventEmitter {
  stdin = { write: (s: string) => { this.written.push(s); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed = false;
  kill() { this.killed = true; }
  // helper: respond to the most recent request line with a given object (echoes its id — so a ping
  // reply carries id "__ping__", which handlePong routes to PingResponseSchema).
  reply(obj: Record<string, unknown>) {
    const last = JSON.parse(this.written[this.written.length - 1]);
    this.stdout.emit("data", Buffer.from(JSON.stringify({ id: last.id, ...obj }) + "\n"));
  }
}

const PONG = { v: 1, ok: true, pong: true, synthVersion: "1.0.0" };
const tick = () => new Promise((r) => setImmediate(r));

type Spy = Array<[string, string]>;
function makeCore(child: FakeChild, onStateChange?: (s: "python" | "fallback", r: string) => void) {
  return createPythonModuleClient({
    moduleDir: "/repo/src/memory",
    repoRoot: "/repo",
    existsSync: () => true,             // resolver: pretend python dir exists
    spawnImpl: (() => child) as any,    // ignore argv, hand back our fake
    log: () => {},
    onStateChange,
  });
}

test("onStateChange fires exactly one ['python','ping-ok'] on a ping handshake", async () => {
  const child = new FakeChild();
  const spy: Spy = [];
  const core = makeCore(child, (s, r) => { spy.push([s, r]); });
  await tick();
  child.reply(PONG); // id "__ping__" → handlePong success → emitState("ping-ok")
  await tick();
  assert.deepEqual(spy, [["python", "ping-ok"]]);
  assert.equal(core.available(), true);
  core.dispose();
});

test("a SECOND pong does NOT re-fire python (up-edge debounce)", async () => {
  const child = new FakeChild();
  const spy: Spy = [];
  const core = makeCore(child, (s, r) => { spy.push([s, r]); });
  await tick();
  child.reply(PONG);
  await tick();
  child.reply(PONG); // already "python" — debounced, no second emit
  await tick();
  assert.equal(spy.length, 1, "lastState already 'python' must swallow the repeat");
  core.dispose();
});

test("exit after a successful ping fires exactly one ['fallback','exit'] (real flip)", async () => {
  const child = new FakeChild();
  const spy: Spy = [];
  const core = makeCore(child, (s, r) => { spy.push([s, r]); });
  await tick();
  child.reply(PONG);
  await tick();
  child.emit("exit"); // onDown("exit") → child nulled → emitState("fallback")
  await tick();
  assert.deepEqual(spy, [["python", "ping-ok"], ["fallback", "exit"]]);
  core.dispose();
});

test("no fallback frame while already down — at most one 'fallback' per real flip (no spam)", async () => {
  const child = new FakeChild();
  const spy: Spy = [];
  // never-ponging child + tiny backoff: ping-timeout fires onDown, then respawn re-spawns the SAME
  // fake which times out again → repeated onDown calls while already "fallback".
  const core = createPythonModuleClient({
    moduleDir: "/repo/src/memory", repoRoot: "/repo", existsSync: () => true,
    platform: "linux", pingTimeoutMs: 10, backoffBaseMs: 5, backoffMaxMs: 5,
    spawnImpl: (() => child) as any, log: () => {},
    onStateChange: (s, r) => { spy.push([s, r]); },
  });
  await new Promise((r) => setTimeout(r, 60)); // let several ping-timeout/respawn cycles run
  const fallbacks = spy.filter(([s]) => s === "fallback");
  assert.ok(fallbacks.length <= 1, `expected <=1 fallback emit, got ${fallbacks.length}: ${JSON.stringify(spy)}`);
  // and we never spuriously emitted "python" (it never ponged)
  assert.equal(spy.filter(([s]) => s === "python").length, 0);
  core.dispose();
});

test("recovery: a second 'python' fires after a 'fallback' (debounce is not a one-shot latch)", async () => {
  // The operationally most important transition: the daemon dropped, then RECOVERED. The debounce must
  // re-compare state on every flip (not latch on the first), so fallback->python re-emits "python".
  const child = new FakeChild();
  const spy: Spy = [];
  const core = createPythonModuleClient({
    moduleDir: "/repo/src/memory", repoRoot: "/repo", existsSync: () => true,
    platform: "linux", pingTimeoutMs: 1000, backoffBaseMs: 5, backoffMaxMs: 5,
    spawnImpl: (() => child) as any, log: () => {},
    onStateChange: (s, r) => { spy.push([s, r]); },
  });
  await tick();
  child.reply(PONG);  // up
  await tick();
  child.emit("exit"); // down → schedules a 5ms backoff respawn (re-spawns the same fake + re-pings)
  await tick();
  await new Promise((r) => setTimeout(r, 25)); // wait out the backoff so the respawn re-arms the handshake
  child.reply(PONG);  // up again (recovery)
  await tick();
  assert.deepEqual(spy, [["python", "ping-ok"], ["fallback", "exit"], ["python", "ping-ok"]]);
  core.dispose();
});

test("a THROWING onStateChange never escapes and the core stays usable", async () => {
  const child = new FakeChild();
  let fired = 0;
  const core = makeCore(child, () => { fired++; throw new Error("boom from callback"); });
  await tick();
  // drive the up-edge: if emitState's try/catch leaked, this would reject the test
  child.reply(PONG);
  await tick();
  assert.equal(fired, 1, "callback was invoked");
  assert.equal(core.available(), true, "throwing callback must not break the ready flip");
  // drive the down-edge too — also wrapped
  child.emit("exit");
  await tick();
  assert.equal(fired, 2);
  // core still usable: request() resolves null (daemon down) without throwing
  const res = await core.request("synthesize", {});
  assert.equal(res, null);
  core.dispose();
});

test("absent onStateChange is a safe no-op across ping + exit", async () => {
  const child = new FakeChild();
  const core = makeCore(child); // no callback
  await tick();
  child.reply(PONG);
  await tick();
  assert.equal(core.available(), true);
  child.emit("exit");
  await tick();
  assert.equal(core.available(), false);
  core.dispose();
});
