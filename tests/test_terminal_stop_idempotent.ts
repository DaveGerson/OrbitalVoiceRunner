// UniversalTerminal.stop() idempotency-latch regression suite.
//
// stop() dedupes a re-entrant/racing teardown via a `_stopping` promise latch (so node-pty's
// ConPTY kill() runs at most once per pty — a double conout-worker dispose aborts at
// src\win\async.c:76). That latch MUST be cleared once the teardown settles, because a pane can be
// restarted on the SAME instance: POST /api/terminals/:id/restart does `await term.stop();
// term.start()`. If the latch were never reset, every subsequent stop() (server shutdown, stop-all
// stage-2, close_pane) would return the stale resolved promise and the RESTARTED pty would never be
// killed (leaked agent process). This suite pins both halves deterministically with a stub
// transport — no real ConPTY, so it is Windows-safe and fast.

import { describe, it } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

// Minimal PtyTransport stub: records kill() calls and resolves the stop() wait by firing onExit
// synchronously on kill (simulating a pty that exits immediately when signalled).
class StubTransport implements PtyTransport {
  pid: number | undefined = 4321;
  killCount = 0;
  private exitCb: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  onData(_cb: (data: string) => void): void { /* no output in the stub */ }
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb; }
  write(_data: string): void { /* no-op */ }
  resize(_cols: number, _rows: number): void { /* no-op */ }
  kill(_signal?: string): void { this.killCount++; this.exitCb?.({ exitCode: 0 }); }
  async drainTeardown(): Promise<void> { /* stub has no native handle to drain */ }
}

describe("UniversalTerminal.stop() idempotency latch", () => {
  function makeTerm(): UniversalTerminal {
    // Construct WITHOUT start() so no real pty spawns; we inject the transport directly.
    return new UniversalTerminal("t-stop", ".", "echo hi", "Custom", "Human-in-the-Loop", "", "default_project");
  }

  it("re-entrant stop() during one teardown kills the pty at most once", async () => {
    const term = makeTerm();
    const stub = new StubTransport();
    (term as any).transport = stub;

    // Three overlapping stop() calls must share ONE teardown (kill once).
    await Promise.all([term.stop(), term.stop(), term.stop()]);
    assert.strictEqual(stub.killCount, 1, "node-pty kill runs at most once per teardown");
    assert.strictEqual((term as any)._stopping, null, "latch is cleared after the teardown settles");
  });

  it("REGRESSION: a stop() after a completed teardown runs a FRESH teardown (restart path)", async () => {
    const term = makeTerm();

    const stub1 = new StubTransport();
    (term as any).transport = stub1;
    await term.stop();
    assert.strictEqual(stub1.killCount, 1, "first stop killed the first pty");
    assert.strictEqual((term as any)._stopping, null, "latch cleared once the first teardown settles");

    // Simulate start() reusing the SAME instance with a fresh transport (the restart endpoint).
    const stub2 = new StubTransport();
    (term as any).transport = stub2;
    await term.stop();
    // Without the latch reset this second stop() would return the stale resolved promise and
    // stub2.killCount would stay 0 — the restarted pty would leak.
    assert.strictEqual(stub2.killCount, 1, "the restarted pty IS killed by the post-restart stop()");
  });
});
