// Characterization tests pinning the CURRENT observable behavior of the functions touched by the
// cyclomatic-complexity burndown in src/memory/pythonClient.ts: onLine (line framing / id
// correlation / ping handshake), spawnDaemon (spawn → buffering → handshake → error paths) and
// the createPythonSynthClient surface. These must stay GREEN before AND after the refactor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPythonSynthClient } from "../src/memory/pythonClient";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";

const FRAME = { role: "Janus", gatePosture: "Auto", prefs: [] };
const TIERS: MemoryTiers = { project: null, pane: null, board: [], frame: FRAME, breadcrumbs: [] };

class FakeChild extends EventEmitter {
  stdin = { write: (s: string) => { this.written.push(s); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed = false;
  unrefCalls = 0;
  kill() { this.killed = true; }
  unref() { this.unrefCalls++; }
  emitData(s: string) { this.stdout.emit("data", Buffer.from(s)); }
  reply(obj: Record<string, unknown>) {
    const last = JSON.parse(this.written[this.written.length - 1]);
    this.emitData(JSON.stringify({ id: last.id, ...obj }) + "\n");
  }
  lastReq() { return JSON.parse(this.written[this.written.length - 1]); }
}

function makeClient(child: FakeChild, over: Record<string, unknown> = {}) {
  return createPythonSynthClient({
    moduleDir: "/repo/src/memory",
    repoRoot: "/repo",
    timeoutMs: 50,
    existsSync: () => true,
    spawnImpl: (() => child) as any,
    log: () => {},
    ...over,
  });
}

const tick = () => new Promise((r) => setImmediate(r));

async function ponged(child: FakeChild) {
  await tick();
  child.reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await tick();
}

// ── spawnDaemon: eager pre-warm spawns, unrefs, and writes a ping frame on construction ──
test("construction eagerly spawns, unrefs the child, and writes a ping frame", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await tick();
  assert.ok(child.unrefCalls >= 1, "child.unref() should be called");
  const ping = JSON.parse(child.written[0]);
  assert.equal(ping.id, "__ping__");
  assert.equal(ping.op, "ping");
  assert.equal(ping.v, 1);
  assert.equal(child.written[0].endsWith("\n"), true, "ping frame is newline-terminated");
  client.dispose();
});

// ── onLine: ping handshake success flips available() and synthesizerState() ──
test("valid pong marks available() and synthesizerState() python", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await ponged(child);
  assert.equal(client.available(), true);
  assert.equal(client.synthesizerState(), "python");
  client.dispose();
});

// ── onLine: blank / whitespace-only lines are ignored (no crash, stays unavailable) ──
test("blank and whitespace-only stdout lines are ignored", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await tick();
  child.emitData("\n");
  child.emitData("   \n");
  await tick();
  assert.equal(client.available(), false);
  client.dispose();
});

// ── onLine: malformed JSON is skipped without throwing or marking ready ──
test("unparseable stdout line is skipped and does not mark ready", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await tick();
  child.emitData("{not json\n");
  await tick();
  assert.equal(client.available(), false);
  client.dispose();
});

// ── onLine: a ping with a wire-version mismatch leaves the client unavailable ──
test("v-mismatch ping leaves client unavailable", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await tick();
  child.reply({ v: 2, ok: true, pong: true, synthVersion: "1.0.0" });
  await tick();
  assert.equal(client.available(), false);
  client.dispose();
});

// ── onLine + framing: a single chunk carrying MULTIPLE newline-delimited objects ──
test("multiple objects in one stdout chunk are each processed", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await ponged(child);
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await tick();
  const id = child.lastReq().id;
  // Two objects in ONE data event: an unrelated id, then the real reply.
  const f1 = JSON.stringify({ id: "stranger", v: 1, ok: true, brief: { text: "X", perTierChars: {}, activePaneId: null } });
  const f2 = JSON.stringify({ id, v: 1, ok: true, brief: { text: "REAL", perTierChars: { project: 4 }, activePaneId: null } });
  child.emitData(f1 + "\n" + f2 + "\n");
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.brief.text, "REAL");
  client.dispose();
});

// ── framing: a response split ACROSS two chunks (partial line) is buffered then completed ──
test("a response split across two stdout chunks is reassembled", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await ponged(child);
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await tick();
  const id = child.lastReq().id;
  const full = JSON.stringify({ id, v: 1, ok: true, brief: { text: "SPLIT", perTierChars: { project: 5 }, activePaneId: null } });
  const cut = Math.floor(full.length / 2);
  child.emitData(full.slice(0, cut));        // no newline yet → buffered, request still pending
  await tick();
  child.emitData(full.slice(cut) + "\n");     // completes the line
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.brief.text, "SPLIT");
  client.dispose();
});

// ── onLine: a daemon error response (ok:false) resolves ok:false ──
test("daemon ok:false error response resolves ok:false", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await ponged(child);
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await tick();
  child.reply({ v: 1, ok: false, error: { code: "SYNTH_FAILED", message: "boom" } });
  const res = await p;
  assert.equal(res.ok, false);
  client.dispose();
});

// ── onLine: a malformed-but-parseable brief (schema reject) resolves ok:false ──
test("a parseable response that fails the schema resolves ok:false", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await ponged(child);
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await tick();
  child.reply({ v: 1, ok: true, brief: { text: 123 /* wrong type */ } });
  const res = await p;
  assert.equal(res.ok, false);
  client.dispose();
});

// ── onLine: a response with an unknown / already-settled id is ignored defensively ──
test("a response for an unknown id is ignored (no throw)", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await ponged(child);
  child.emitData(JSON.stringify({ id: "ghost", v: 1, ok: true, brief: { text: "x", perTierChars: {}, activePaneId: null } }) + "\n");
  await tick();
  assert.equal(client.available(), true); // still healthy, nothing crashed
  client.dispose();
});

// ── request correlation: returns the brief on a matching-id reply ──
test("request correlates by id and returns the brief", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await ponged(child);
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await tick();
  assert.equal(child.lastReq().op, "synthesize");
  child.reply({ v: 1, ok: true, brief: { text: "PROJECT x", perTierChars: { project: 9 }, activePaneId: null } });
  const res = await p;
  assert.equal(res.ok && res.brief.text, "PROJECT x");
  client.dispose();
});

// ── request: silent daemon → internal expiry resolves ok:false (no id leak) ──
test("silent daemon resolves ok:false via internal expiry", async () => {
  const child = new FakeChild();
  const client = makeClient(child, { requestExpiryMs: 25 });
  await ponged(child);
  const res = await client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  assert.equal(res.ok, false);
  client.dispose();
});

// ── request: before ready / when not available resolves ok:false synchronously ──
test("request before a pong resolves ok:false", async () => {
  const child = new FakeChild();
  const client = makeClient(child);
  await tick();
  const res = await client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  assert.equal(res.ok, false);
  client.dispose();
});

// ── spawnDaemon error path: child "exit" tears down (available() false) and respawns ──
test("child exit marks the client unavailable", async () => {
  const child = new FakeChild();
  const client = makeClient(child, { backoffBaseMs: 1000, backoffMaxMs: 1000 });
  await ponged(child);
  assert.equal(client.available(), true);
  child.emit("exit");
  await tick();
  assert.equal(client.available(), false);
  client.dispose();
});

// ── spawnDaemon error path: child "error" tears down too ──
test("child error event marks the client unavailable", async () => {
  const child = new FakeChild();
  const client = makeClient(child, { backoffBaseMs: 1000, backoffMaxMs: 1000 });
  await ponged(child);
  child.emit("error", new Error("nope"));
  await tick();
  assert.equal(client.available(), false);
  client.dispose();
});

// ── spawnDaemon: a spawnImpl that throws degrades gracefully (no throw, stays fallback) ──
test("spawnImpl throwing degrades to fallback without throwing", async () => {
  const client = createPythonSynthClient({
    moduleDir: "/m", repoRoot: "/r", existsSync: () => true, log: () => {},
    backoffBaseMs: 1000, backoffMaxMs: 1000,
    spawnImpl: (() => { throw new Error("ENOENT"); }) as any,
  });
  await tick();
  assert.equal(client.available(), false);
  assert.equal(client.synthesizerState(), "fallback");
  client.dispose();
});

// ── spawnDaemon: no synth dir (existsSync false) → never spawns, stays fallback ──
test("missing synth dir means no spawn and fallback state", async () => {
  let spawned = 0;
  const client = createPythonSynthClient({
    moduleDir: "/m", repoRoot: "/r", existsSync: () => false, log: () => {},
    spawnImpl: (() => { spawned++; return new FakeChild(); }) as any,
  });
  await tick();
  assert.equal(spawned, 0);
  assert.equal(client.available(), false);
  client.dispose();
});

// ── spawnDaemon: stdin write failing during ping degrades (stays unavailable) ──
test("a ping stdin-write failure degrades to fallback", async () => {
  const child = new FakeChild();
  child.stdin = { write: () => { throw new Error("EPIPE"); } } as any;
  const client = makeClient(child, { backoffBaseMs: 1000, backoffMaxMs: 1000 });
  await tick();
  assert.equal(child.killed, true, "child should be killed on stdin-write-failed teardown");
  assert.equal(client.available(), false);
  client.dispose();
});

// ── dispose: idempotent, settles pending ok:false, kills child ──
test("dispose settles a pending request ok:false and kills the child", async () => {
  const child = new FakeChild();
  const client = makeClient(child, { requestExpiryMs: 10_000 });
  await ponged(child);
  const p = client.request(TIERS, DEFAULT_MEMORY_CONFIG, 0);
  await tick();
  client.dispose();
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(child.killed, true);
  client.dispose(); // idempotent
});

// ── discovery fallthrough: first candidate never pings → advances to a second spawn (D4) ──
test("first candidate ping-timeout advances to a second candidate", async () => {
  const children: FakeChild[] = [];
  const client = createPythonSynthClient({
    moduleDir: "/m", repoRoot: "/r", existsSync: () => true, log: () => {},
    platform: "win32", pingTimeoutMs: 20, backoffBaseMs: 5, backoffMaxMs: 5,
    spawnImpl: (() => { const c = new FakeChild(); children.push(c); return c; }) as any,
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(children.length >= 2, "should have spawned a second candidate");
  children[children.length - 1].reply({ v: 1, ok: true, pong: true, synthVersion: "1.0.0" });
  await tick();
  assert.equal(client.available(), true);
  client.dispose();
});
