// tests/test_async_pane_spawn.ts — B1 ASYNC pane spawn: register synchronously, boot the PTY off the
// Gemini voice onmessage tick, and never drop pre-spawn input.
//
// THE B1 CORE the spec forbids violating: pane creation must NOT freeze the event loop. addTerminal
// registers the pane (slot exists, dup/replay guard fires) SYNCHRONOUSLY, then DEFERS the blocking
// term.start() to a setImmediate so the voice dispatch returns promptly and the pane boots
// asynchronously. A pre-spawn follow-up command ("open a pane then run X") must be BUFFERED across the
// deferred start, not dropped. A new manager-level `onReady` callback fires when the child actually
// attaches its PTY (markSpawnReady) — the phase-2 "ready" source.
//
// Harness: inject a transport via the constructor's transportFactory (arg 9). The fake captures
// onData and fires it only on becomeReady() — modeling the ConPTY child that hasn't attached its
// stdin reader yet. We NEVER wait on READY_FALLBACK_MS (750ms); readiness is driven explicitly.
//
// Runner: npx tsx --test --test-force-exit tests/test_async_pane_spawn.ts

// bead eoef: pin the settings file into a tmpdir for this whole file — constructing an
// OrchestratorManager (directly or via startServer) without this writes a cwd-relative
// .janus_settings.json into the repo root, which the run-unit cleanliness gate fails on.
import { pinSettingsPathToTmpdir } from "./helpers/settingsPath";
pinSettingsPathToTmpdir();

import { test } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { UniversalTerminal, OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import type { PtyTransport } from "../src/ptyTransport";

function deleteScrollback(id: string): void {
  const p = `.janus_scrollback_${id}.log`;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// A transport whose readiness edge (first onData) is captured-but-not-fired until becomeReady().
// Models the freshly spawned ConPTY child that has not yet attached its PTY/stdin reader.
class DeferredReadyTransport implements PtyTransport {
  writes: string[] = [];
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  pid: number | undefined = 4242;
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCb = cb; }
  write(d: string) { this.writes.push(d); }
  resize() {}
  kill() {}
  /** Drive the readiness edge: the child produced its first output. Defaults to benign output;
   *  pass launch-failure text to model a shell that died on its very first chunk (wsm-e2e-pinned-94fb). */
  becomeReady(text: string = "welcome\n") { this.dataCb?.(text); }
  emitExit() { this.exitCb?.({ exitCode: 0 }); }
}

function makeTerm(id: string, stub: DeferredReadyTransport): UniversalTerminal {
  const term = new UniversalTerminal(
    id, ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined,
    () => ({ transport: stub, usingNodePty: true }),
  );
  // Deterministic synchronous flush (gap behavior covered elsewhere).
  (term as any).submitEnterDelayMs = 0;
  return term;
}

// #4 — start() returns BEFORE the child is spawn-ready; readiness flips only on becomeReady().
test("start() returns before the child is spawn-ready", async () => {
  const stub = new DeferredReadyTransport();
  const term = makeTerm("b1-4", stub);
  try {
    term.start();
    assert.strictEqual((term as any).spawnReady, false, "not ready immediately after start()");
    stub.becomeReady();
    await tick();
    assert.strictEqual((term as any).spawnReady, true, "ready after the child attaches (first onData)");
  } finally {
    await term.stop();
    deleteScrollback("b1-4");
  }
});

// #6 — a pre-spawn follow-up command is BUFFERED, not dropped, and flushes in order after boot.
// HIGHEST-SIGNAL correctness test. Two sub-cases:
//   (a) writeInput BEFORE start()  -> must land in pendingInput AND survive start()'s reset (A4),
//   (b) writeInput AFTER start() but before becomeReady() -> queued, flushed in order on ready.
test("pre-spawn follow-up command is buffered, not dropped", async () => {
  // (a) BEFORE start(): no transport yet. Must buffer (A3), and the first-spawn start() reset must
  // NOT clobber it (A4).
  {
    const stub = new DeferredReadyTransport();
    const term = makeTerm("b1-6a", stub);
    try {
      term.writeInput("echo BEFORE"); // pre-start: transport === null
      assert.deepStrictEqual(
        (term as any).pendingInput,
        [{ kind: "submit", command: "echo BEFORE" }],
        "pre-start input buffered, not dropped",
      );
      term.start(); // first spawn: must PRESERVE the pre-spawn queue across the reset
      assert.deepStrictEqual(
        (term as any).pendingInput, [{ kind: "submit", command: "echo BEFORE" }],
        "pre-spawn input survives start()'s spawnReady/pendingInput reset (first-spawn carve-out)",
      );
      stub.becomeReady();
      await tick();
      assert.deepStrictEqual(stub.writes, ["echo BEFORE", "\r"], "pre-spawn input flushed in order after boot");
    } finally {
      await term.stop();
      deleteScrollback("b1-6a");
    }
  }
  // (b) AFTER start(), before ready: queued and flushed in order (today's gate behavior, must persist).
  {
    const stub = new DeferredReadyTransport();
    const term = makeTerm("b1-6b", stub);
    try {
      term.start();
      term.writeInput("echo X");
      assert.deepStrictEqual(
        (term as any).pendingInput,
        [{ kind: "submit", command: "echo X" }],
        "post-start pre-ready input queued",
      );
      stub.becomeReady();
      await tick();
      assert.deepStrictEqual(stub.writes, ["echo X", "\r"], "queued input flushed in order after boot");
    } finally {
      await term.stop();
      deleteScrollback("b1-6b");
    }
  }
});

// #5 — addTerminal registers SYNCHRONOUSLY and DEFERS the spawn (the loop is not frozen).
// The slot must exist the instant addTerminal returns; the actual start() runs on a later tick.
// A microtask/setImmediate liveness probe scheduled right after addTerminal must run BEFORE onReady.
test("addTerminal registers synchronously and defers the spawn (loop not frozen)", async () => {
  const store = new JanusStore(":memory:");
  store.init();
  const manager = new OrchestratorManager({ ledger: store });
  let readyFired = false;
  let livenessRanBeforeReady = false;
  (manager as any).onReady = () => { readyFired = true; };

  manager.addTerminal("b1-5", ".", "echo hi");
  // Registry slot exists synchronously — the dup/replay guard can fire on a replay immediately.
  assert.ok(manager.terminals["b1-5"], "pane registered synchronously");
  assert.strictEqual(readyFired, false, "spawn (and onReady) deferred — did NOT run inline");

  // A liveness probe scheduled now must get to run before the deferred start completes -> proves the
  // loop was never frozen by addTerminal.
  await new Promise<void>((resolve) => {
    setImmediate(() => { if (!readyFired) livenessRanBeforeReady = true; resolve(); });
  });
  assert.ok(livenessRanBeforeReady, "an event-loop turn ran before the deferred spawn finished");

  // Drain the deferred spawn, then tear down cleanly (mandatory before stop() on Windows ConPTY).
  await (manager as any).flushPendingSpawns();
  const term = manager.terminals["b1-5"];
  if (term) { await term.stop(); delete manager.terminals["b1-5"]; }
  deleteScrollback("b1-5");
});

// #7 — phase-2 "ready" fires ONCE, after spawn-ready, via the manager onReady hook (the gate is a
// separate pure unit, asserted in test_ack_gate.ts). A degraded pane never reaches markSpawnReady,
// so onReady must NOT fire until becomeReady().
test("phase-2 'ready' ack fires once, after spawn-ready, through the onReady hook", async () => {
  const stub = new DeferredReadyTransport();
  const term = makeTerm("b1-7", stub);
  let readyAcks: string[] = [];
  (term as any).onReady = (id: string) => { readyAcks.push(id); };
  try {
    term.start();
    assert.strictEqual(readyAcks.length, 0, "no ready ack before the child attaches");
    stub.becomeReady();
    await tick();
    assert.deepStrictEqual(readyAcks, ["b1-7"], "ready ack fired exactly once on spawn-ready");
    // Idempotent: a second onData chunk must not re-fire onReady.
    stub.becomeReady();
    await tick();
    assert.deepStrictEqual(readyAcks, ["b1-7"], "ready ack is idempotent — a second chunk does not re-fire");
  } finally {
    await term.stop();
    deleteScrollback("b1-7");
  }
});

// wsm-e2e-pinned-94fb: the FIRST PTY chunk must not be treated as ready-proof when it IS the
// wrapping shell's own launch-failure text (demo repro: a bad tool-preset binary made Windows
// cmd.exe emit "'antigravity' is not recognized as an internal or external command..." as its
// only line before exiting — the old code marked the pane ready/"created" off that chunk, a beat
// before the pane died). Content-gate: spawnReady must stay false and onReady must never fire.
test("a launch-failure first chunk does not mark spawn-ready or fire onReady", async () => {
  const stub = new DeferredReadyTransport();
  const term = makeTerm("b1-8", stub);
  let readyAcks: string[] = [];
  (term as any).onReady = (id: string) => { readyAcks.push(id); };
  try {
    term.start();
    stub.becomeReady(
      "'antigravity' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"
    );
    await tick();
    assert.strictEqual((term as any).spawnReady, false, "launch-failure text must not satisfy spawn-readiness");
    assert.deepStrictEqual(readyAcks, [], "onReady must not fire for a launch-failure first chunk");
    // The shell dies moments later — the pane must still reach "Exited" normally, and the
    // pre-existing readyFallbackTimer cancellation on exit must mean no LATE ready ever fires.
    stub.emitExit();
    await tick();
    assert.strictEqual((term as any).status, "Exited", "the dying shell still reaches Exited normally");
    assert.deepStrictEqual(readyAcks, [], "no ready ack fires even after the shell's own exit");
  } finally {
    await term.stop();
    deleteScrollback("b1-8");
  }
});

// Companion (paired with the launch-failure test above, and with test #7): normal first-chunk
// output for a DIFFERENT pane must still mark spawn-ready and fire onReady exactly once — the
// content-gate must not degrade the common case.
test("a normal (non-failure) first chunk still marks spawn-ready and fires onReady exactly once", async () => {
  const stub = new DeferredReadyTransport();
  const term = makeTerm("b1-9", stub);
  let readyAcks: string[] = [];
  (term as any).onReady = (id: string) => { readyAcks.push(id); };
  try {
    term.start();
    stub.becomeReady("Welcome to Claude Code\r\n");
    await tick();
    assert.strictEqual((term as any).spawnReady, true, "normal output still satisfies spawn-readiness");
    assert.deepStrictEqual(readyAcks, ["b1-9"], "onReady fires exactly once for normal first output");
  } finally {
    await term.stop();
    deleteScrollback("b1-9");
  }
});
