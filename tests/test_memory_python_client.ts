import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPythonSynthClient, discoverPythonInterpreter, resolveSynthDir } from "../src/memory/pythonClient";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";

const FRAME = { role: "Janus", gatePosture: "Auto", prefs: [] };
const TIERS: MemoryTiers = { project: null, pane: null, board: [], frame: FRAME, breadcrumbs: [] };

// A fake child process: captures stdin writes, lets the test emit stdout lines + exit.
class FakeChild extends EventEmitter {
  stdin = { write: (s: string) => { this.written.push(s); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed = false;
  kill() { this.killed = true; }
  // helper: respond to the most recent request line with a given object (echoes its id)
  reply(obj: Record<string, unknown>) {
    const last = JSON.parse(this.written[this.written.length - 1]);
    this.stdout.emit("data", Buffer.from(JSON.stringify({ id: last.id, ...obj }) + "\n"));
  }
  lastReq() { return JSON.parse(this.written[this.written.length - 1]); }
}

function makeClient(child: FakeChild, over: Record<string, unknown> = {}) {
  return createPythonSynthClient({
    moduleDir: "/repo/src/memory",
    repoRoot: "/repo",
    timeoutMs: 50,
    existsSync: () => true,             // resolver: pretend python dir exists
    spawnImpl: (() => child) as any,    // ignore argv, hand back our fake
    log: () => {},
    ...over,
  });
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

test("discoverPythonInterpreter honors JANUS_PYTHON override first", () => {
  const cands = discoverPythonInterpreter({ JANUS_PYTHON: "/usr/bin/py3" } as any, "linux");
  assert.equal(cands[0].cmd, "/usr/bin/py3");
});

test("discoverPythonInterpreter Windows order is py -3, python, python3", () => {
  const cands = discoverPythonInterpreter({} as any, "win32");
  assert.deepEqual(cands.map((c) => `${c.cmd} ${c.baseArgs.join(" ")}`.trim()), ["py -3", "python", "python3"]);
});

test("discoverPythonInterpreter Linux order is python3, python", () => {
  const cands = discoverPythonInterpreter({} as any, "linux");
  assert.deepEqual(cands.map((c) => c.cmd), ["python3", "python"]);
});

test("resolveSynthDir prefers the override, then moduleDir/python, then repoRoot/python", () => {
  assert.equal(resolveSynthDir({ override: "/X", moduleDir: "/m", repoRoot: "/r" }, () => true), "/X");
  assert.equal(resolveSynthDir({ moduleDir: "/m", repoRoot: "/r" }, (p) => p.startsWith("/r")), "/r/python");
  assert.equal(resolveSynthDir({ moduleDir: "/m", repoRoot: "/r" }, () => false), null);
});

test("ping handshake marks the client available", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  // client spawns + sends a ping on construction; satisfy it
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  assert.equal(client.available(), true);
  client.dispose();
});

test("request correlates a response by id and returns the brief", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(child.lastReq().op, "synthesize");
  child.reply({ v: 1, ok: true, brief: { text: "PROJECT x", perTierChars: { project: 9 }, activePaneId: null } });
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.brief.text, "PROJECT x");
  client.dispose();
});

test("request resolves ok:false on a daemon error response", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: false, error: { code: "SYNTH_FAILED", message: "boom" } });
  const res = await p;
  assert.equal(res.ok, false);
  client.dispose();
});

test("request resolves ok:false when the daemon is silent (internal expiry, no leak)", async () => {
  const child = new FakeChild();
  const client = makeClient(child, { requestExpiryMs: 30 });
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  const res = await client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0); // never replied
  assert.equal(res.ok, false);
  client.dispose();
});

test("a v-mismatch ping leaves the client unavailable", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await new Promise((r) => setImmediate(r));
  child.reply({ v: 2, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  assert.equal(client.available(), false);
  client.dispose();
});

test("falls through to the next interpreter candidate when the first never pings (D4/I9)", async () => {
  const children: FakeChild[] = [];
  const client = createPythonSynthClient({
    moduleDir: "/m", repoRoot: "/r", existsSync: () => true, log: () => {},
    platform: "win32", pingTimeoutMs: 20, backoffBaseMs: 5, backoffMaxMs: 5,
    spawnImpl: (() => { const c = new FakeChild(); children.push(c); return c; }) as any,
  });
  // first candidate (py -3) spawns but never pings → ping-timeout advances to the next candidate
  assert.equal(await until(() => children.length >= 2), true, "should have spawned a second candidate after the ping-timeout");
  children[children.length - 1].reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await new Promise((r) => setImmediate(r));
  assert.equal(client.available(), true);
  client.dispose();
});
