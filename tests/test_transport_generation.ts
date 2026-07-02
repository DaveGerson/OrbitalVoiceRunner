// tests/test_transport_generation.ts — Phase 3 Track P: transport generation tokens.
//
// CARD 3P.1 — the start()-installed transport.onData/onExit callbacks close over `this` with NO
// identity check. A child that ignores SIGTERM makes _doStop resolve via the killTimeout BEFORE the
// process dies; restart()'s new start() installs a NEW transport, and when the OLD process finally
// exits, the OLD transport's onExit marks the NEW pane "Exited" and clears the NEW pane's
// probe/idle/ready timers (stranding queued pendingInput). FIX: every per-spawn callback body is
// guarded on transport identity — a REPLACED (stale) generation must never mutate the current one.
//
// CARD 3P.3 — two overlapping restarts (`await term.stop(); term.start()` from two callers) both
// await the SAME _stopping promise then BOTH call start(): the second start() overwrites
// this.transport while the first spawn stays alive and wired (two live processes, one pane).
// FIX: start() self-defends — a live/leftover transport is best-effort killed and nulled first.
//
// CARD 3P.4 — a child that dies pre-spawn-ready leaves pendingInput queued; self-exit never nulls
// this.transport, and the restart path (`await stop(); start()`) DOES null it, so the dead session's
// queued commands replay into the fresh process. FIX: the (generation-guarded) onExit teardown
// clears pendingInput. The FIRST-SPAWN carve-out (input queued before any start) must keep working —
// test_async_pane_spawn pins it.
//
// Harness: stub-transport pattern from tests/test_async_pane_spawn.ts (factory closure swapping in
// fresh stubs per start). Stubs here MULTIPLEX onData/onExit (arrays) because both start() and
// _doStop subscribe to the same transport. The SIGTERM-ignorer path rides the (injectable,
// test-shortened) killEscalationMs stop window instead of the production 1000ms.
//
// Runner: npx tsx --test --test-force-exit tests/test_transport_generation.ts

import { test } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

function deleteScrollback(id: string): void {
  const p = `.janus_scrollback_${id}.log`;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// Multiplexing stub: BOTH the start()-installed lifecycle callbacks and _doStop's `done` subscribe
// to onExit, so callbacks are arrays (matching the real transports' multiplexing contract).
// `exitOnKill` models a cooperative child (kill -> immediate exit); false models a SIGTERM-ignorer
// (stop() must resolve via the killTimeout escalation window).
class StubTransport implements PtyTransport {
  writes: string[] = [];
  kills: (string | undefined)[] = [];
  pid: number | undefined = 4242;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  constructor(private exitOnKill = false) {}
  onData(cb: (d: string) => void) { this.dataCbs.push(cb); }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCbs.push(cb); }
  write(d: string) { this.writes.push(d); }
  resize() {}
  kill(signal?: string) {
    this.kills.push(signal);
    if (this.exitOnKill) this.emitExit();
  }
  becomeReady() { for (const cb of [...this.dataCbs]) cb("welcome\n"); }
  emitExit() { for (const cb of [...this.exitCbs]) cb({ exitCode: 0 }); }
}

/** Term whose factory returns `next()` — tests swap in fresh stubs per start(). */
function makeTerm(id: string, next: () => StubTransport): UniversalTerminal {
  const term = new UniversalTerminal(
    id, ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined,
    () => ({ transport: next(), usingNodePty: true }),
  );
  (term as any).submitEnterDelayMs = 0;     // deterministic synchronous flush
  (term as any).killEscalationMs = 25;      // don't ride the production 1000ms SIGKILL window
  return term;
}

// ---------------------------------------------------------------------------------------------
// CARD 3P.1 — a stale generation's late exit must not poison the freshly restarted pane.
// ---------------------------------------------------------------------------------------------
test("3P.1: OLD transport's late exit does not mark the NEW spawn Exited / clear its timers/queue", async () => {
  const id = "gen-3p1";
  let current = new StubTransport(/* exitOnKill */ false); // SIGTERM-ignorer
  const stub1 = current;
  const term = makeTerm(id, () => current);
  try {
    term.start();
    stub1.becomeReady();
    await tick();
    assert.strictEqual(term.status, "Running", "first boot reaches Running");

    // stop(): the child ignores SIGTERM -> stop resolves via the killEscalation window while the
    // OLD process is still dying.
    await term.stop();
    assert.ok(stub1.kills.length >= 1, "stop() signalled the old transport");

    // Restart: fresh transport; a follow-up command queues pre-ready on the NEW spawn.
    const stub2 = new StubTransport(true);
    current = stub2;
    term.start();
    term.writeInput("echo new-gen");
    assert.deepStrictEqual(
      (term as any).pendingInput,
      [{ kind: "submit", command: "echo new-gen" }],
      "pre-ready input queued on the new spawn",
    );
    assert.ok((term as any).readyFallbackTimer, "new spawn's readiness fallback is armed");
    assert.ok((term as any).probeTimer, "new spawn's probe interval is armed");

    // NOW the old SIGTERM-ignorer finally dies. Its stale callbacks must be inert.
    stub1.emitExit();

    assert.strictEqual(term.status, "Running", "stale exit must NOT mark the new spawn Exited");
    assert.ok((term as any).probeTimer, "stale exit must NOT clear the new spawn's probe timer");
    assert.ok((term as any).readyFallbackTimer, "stale exit must NOT clear the new spawn's readiness fallback");
    assert.deepStrictEqual(
      (term as any).pendingInput, [{ kind: "submit", command: "echo new-gen" }],
      "stale exit must NOT strand/clear the new spawn's queued input",
    );

    // Stale DATA is equally inert: it must not flip the new spawn's readiness.
    stub1.becomeReady();
    assert.strictEqual((term as any).spawnReady, false, "stale data must NOT mark the new spawn ready");
    assert.deepStrictEqual(stub2.writes, [], "stale data must NOT trigger a premature flush");

    // The new generation still works end-to-end.
    stub2.becomeReady();
    await tick();
    assert.deepStrictEqual(stub2.writes, ["echo new-gen", "\r"], "queued input flushes into the NEW transport");
    assert.strictEqual(term.status, "Running", "pane still Running after the readiness flush");
  } finally {
    await term.stop();
    deleteScrollback(id);
  }
});

// ---------------------------------------------------------------------------------------------
// CARD 3P.3 — overlapping restarts: start() self-defends so exactly ONE transport stays live.
// ---------------------------------------------------------------------------------------------
test("3P.3: two overlapping restarts leave exactly ONE live transport (orphan is killed)", async () => {
  const id = "gen-3p3";
  const spawned: StubTransport[] = [];
  const term = makeTerm(id, () => {
    const s = new StubTransport(true); // cooperative: kill -> exit, stops resolve fast
    spawned.push(s);
    return s;
  });
  try {
    term.start();
    spawned[0].becomeReady();
    await tick();
    assert.strictEqual(term.status, "Running", "boot reaches Running");

    // Two callers race the canonical restart sequence. Both await the SAME _stopping promise,
    // then BOTH call start().
    await Promise.all([
      (async () => { await term.stop(); term.start(); })(),
      (async () => { await term.stop(); term.start(); })(),
    ]);

    assert.strictEqual(spawned.length, 3, "stop+double-start spawned two new transports (3 total)");
    const orphan = spawned[1];
    const live = spawned[2];

    // The overwritten transport must have been killed, not left alive-and-wired.
    assert.ok(orphan.kills.length >= 1, "the orphaned transport got kill()ed by the second start()");

    // The orphan's wiring is inert: its data must not flip the live spawn's readiness.
    orphan.becomeReady();
    assert.strictEqual((term as any).spawnReady, false, "orphan data must NOT mark the live spawn ready");

    // Exactly ONE transport receives subsequent input.
    live.becomeReady();
    await tick();
    term.writeInput("echo solo");
    await tick();
    assert.deepStrictEqual(live.writes, ["echo solo", "\r"], "the live transport received the input");
    assert.deepStrictEqual(orphan.writes, [], "the orphaned transport received NOTHING");
  } finally {
    await term.stop();
    deleteScrollback(id);
  }
});

// ---------------------------------------------------------------------------------------------
// CARD 3P.4 — pendingInput hygiene: a dead session's queued input never replays into a fresh spawn.
// ---------------------------------------------------------------------------------------------
test("3P.4: input queued for a pane that died pre-ready is dropped, not replayed after restart", async () => {
  const id = "gen-3p4";
  let current = new StubTransport(true);
  const term = makeTerm(id, () => current);
  try {
    term.start();
    term.writeInput("echo doomed"); // queued pre-ready
    assert.deepStrictEqual(
      (term as any).pendingInput,
      [{ kind: "submit", command: "echo doomed" }],
      "input queued while not ready",
    );

    // The child dies BEFORE ever becoming ready (becomeReady never fires).
    current.emitExit();
    assert.strictEqual(term.status, "Exited", "self-exit marks the pane Exited");
    assert.deepStrictEqual(
      (term as any).pendingInput, [],
      "self-exit clears the dead session's queued input (no zombie replay payload)",
    );

    // The canonical restart path (`await stop(); start()`): the dead-session command must NOT
    // replay into the fresh process.
    await term.stop();
    const stub2 = new StubTransport(true);
    current = stub2;
    term.start();
    stub2.becomeReady();
    await tick();
    assert.ok(
      !stub2.writes.includes("echo doomed"),
      "dead-session input must NOT replay into the fresh process",
    );
  } finally {
    await term.stop();
    deleteScrollback(id);
  }
});

// The FIRST-SPAWN carve-out must survive 3P.4: input typed before any start() is still preserved
// across the deferred boot (test_async_pane_spawn pins the full matrix; this is the local guard).
test("3P.4 carve-out: pre-start input still survives the first start() and flushes on ready", async () => {
  const id = "gen-3p4-carveout";
  const stub = new StubTransport(true);
  const term = makeTerm(id, () => stub);
  try {
    term.writeInput("echo BEFORE"); // pre-start: no transport yet
    term.start();
    assert.deepStrictEqual(
      (term as any).pendingInput, [{ kind: "submit", command: "echo BEFORE" }],
      "pre-start input survives start()'s reset (first-spawn carve-out)",
    );
    stub.becomeReady();
    await tick();
    assert.deepStrictEqual(stub.writes, ["echo BEFORE", "\r"], "pre-start input flushed in order after boot");
  } finally {
    await term.stop();
    deleteScrollback(id);
  }
});
