// tests/test_restart_status.ts — Card 1A.1: the restart wedge.
//
// THE BUG: restart reuses the SAME UniversalTerminal instance (panes_rest.ts restartEffect does
// `await term.stop(); term.start()`; applyPaneMode's restart-resume leg does the same). During the
// stop, transport onExit flips status to "Exited". start() then REFUSED to reset it:
// `if (this.status !== "Exited") { this.status = "Running" }` — and applyStatusEvent /
// runProbeTick both early-return on "Exited". No other path ever sets status = "Running", so a
// restarted pane is a LIVE process with a permanently dead status machine (probe ticks, input
// kicks, output events: all ignored forever).
//
// THE FIX: start() sets status = "Running" + stamps lastStatusChangeAt UNCONDITIONALLY (the
// degraded-spawn catch returns early before that line, so the old guard protected nothing).
//
// Harness: the stub-transport pattern from tests/test_async_pane_spawn.ts — inject a
// DeferredReadyTransport via the constructor's transportFactory (arg 9); readiness/exit edges are
// driven explicitly, never by wall-clock.
//
// Runner: npx tsx --test --test-force-exit tests/test_restart_status.ts

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

// Same shape as test_async_pane_spawn's DeferredReadyTransport, plus: kill() emits the exit edge
// so `await term.stop()` resolves immediately instead of riding the 1000ms SIGKILL escalation.
class StubTransport implements PtyTransport {
  writes: string[] = [];
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  pid: number | undefined = 4242;
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCb = cb; }
  write(d: string) { this.writes.push(d); }
  resize() {}
  kill() { this.exitCb?.({ exitCode: 0 }); }
  /** Drive the readiness edge: the child produced its first output. */
  becomeReady() { this.dataCb?.("welcome\n"); }
  /** Drive the lifecycle exit edge (the start()-registered onExit → status "Exited"). */
  emitExit() { this.exitCb?.({ exitCode: 0 }); }
}

test("restart on the same instance un-wedges the status machine (stop -> Exited -> start -> Running)", async () => {
  const id = "restart-wedge-1";
  let current = new StubTransport();
  const term = new UniversalTerminal(
    id, ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined,
    () => ({ transport: current, usingNodePty: true }),
  );
  (term as any).submitEnterDelayMs = 0;
  try {
    // First boot: Running.
    term.start();
    current.becomeReady();
    await tick();
    assert.strictEqual(term.status, "Running", "first boot reaches Running");

    // The child exits (the start()-registered onExit fires) — status flips to Exited.
    current.emitExit();
    assert.strictEqual(term.status, "Exited", "the exit edge flips status to Exited");

    // The restart sequence every caller uses: await stop(); start() — SAME instance.
    await term.stop();
    const stampBefore = (term as any).lastStatusChangeAt as number;
    current = new StubTransport(); // fresh transport for the respawn
    term.start();

    // THE WEDGE: with the buggy guard, status stays "Exited" forever here.
    assert.strictEqual(
      term.status, "Running",
      "start() after a stop() MUST reset status to Running (restart wedge)",
    );
    assert.ok(
      ((term as any).lastStatusChangeAt as number) >= stampBefore,
      "start() stamps lastStatusChangeAt on the restart transition",
    );

    // The status machine is ALIVE again: an input event (applyStatusEvent kind:"input") must not
    // early-return, and the pre-ready queue must flush on the readiness edge.
    term.writeInput("echo after-restart");
    assert.strictEqual(term.status, "Running", "an input event keeps the restarted pane Running (no Exited early-return)");
    current.becomeReady();
    await tick();
    assert.deepStrictEqual(
      current.writes, ["echo after-restart", "\r"],
      "pendingInput flushes into the NEW transport after the restart (machine not wedged)",
    );
    assert.strictEqual(term.status, "Running", "still Running after the readiness flush");
  } finally {
    await term.stop();
    deleteScrollback(id);
  }
});
