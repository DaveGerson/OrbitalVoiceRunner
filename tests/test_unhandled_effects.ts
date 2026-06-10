// tests/test_unhandled_effects.ts — Card 1A.2: server-killer unhandled rejections.
//
// TWO process-killing failure modes pinned here:
//
//   (a) applyPaneMode's Ask→confirm replay: syncRun assigns
//       `executePromise = execute().then(...)` with NO rejection consumer. Under Auto the caller
//       awaits it, but on the deferred (Ask) path the gate invokes the run closure LATER (operator
//       confirm) and NOBODY awaits — a rejecting execute() becomes an unhandledRejection that
//       kills the process. The fix attaches a logging `.catch` as a SEPARATE derived promise, so
//       the Auto path's awaiter still observes the rejection unchanged.
//
//   (b) startServer's listen promise: `server.listen(...)` inside a Promise with no error path.
//       EADDRINUSE lands on the server's "error" event (swallowed by the QW1 process net), the
//       promise never settles, and the boot hangs silently forever. The fix wires
//       `server.once("error", reject)` before listen (removed on success) so the promise REJECTS.
//
// Runner: npx tsx --test --test-force-exit tests/test_unhandled_effects.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import net from "net";
import os from "os";
import fs from "fs";
import path from "path";
import { applyPaneMode, type PaneModeDeps, type PaneLike } from "../src/applyPaneMode";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { PendingActionStore } from "../src/pendingActions";
import type { MockLiveHandle } from "./helpers/mockLive";
import type { RunningServer } from "../server";

// Give the loop enough turns for Node to emit unhandledRejection (it fires at the end of the
// turn in which a rejected promise still has no handler).
const drainTurns = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

/** A pane whose execute() path REJECTS: the adapter explodes inside planModeChange. */
function makeExplodingPane(): PaneLike {
  return {
    adapter: {
      planModeChange() { throw new Error("boom: adapter exploded"); },
      parseCurrentMode() { return null; },
      pinnedSessionId() { return null; },
      buildResumeCommand() { return { argv: ["x"] }; },
    } as unknown as PaneLike["adapter"],
    permissionsMode: "Human-in-the-Loop",
    sessionId: "",
    shellCmd: "claude",
    writeRaw() {},
    getRecentOutput() { return ""; },
    async stop() {},
    start() {},
  };
}

function baseDeps(over: Partial<PaneModeDeps> = {}): PaneModeDeps {
  return {
    gateOrDefer: (_cap, _pane, _summary, run) => { run(); return { disposition: "run" }; },
    pendingApprovals: new PendingApprovalStore(null),
    pendingActions: new PendingActionStore(null),
    broadcast: () => {},
    persistMode: () => {},
    readAfterWriteTimeoutMs: 50,
    readAfterWritePollMs: 5,
    ...over,
  };
}

describe("applyPaneMode deferred run closure — rejection is consumed, never unhandled (1A.2.1)", () => {
  it("Ask→confirm replay of a REJECTING execute() does not raise unhandledRejection", async () => {
    // Stage the deferred action: the gate captures the run closure and reports "deferred".
    let capturedRun: (() => string) | null = null;
    const askGate: PaneModeDeps["gateOrDefer"] = (_cap, _pane, summary, run) => {
      capturedRun = run;
      return { disposition: "deferred", actionId: "act_boom", summary };
    };
    const res = await applyPaneMode("pane_boom", "Full Auto", "voice", makeExplodingPane(), baseDeps({ gateOrDefer: askGate }));
    assert.strictEqual(res.kind, "deferred", "the gate deferred the change (Ask)");
    assert.ok(capturedRun, "the gate captured the run closure for the confirm replay");

    // Operator confirm: the staged run closure fires with NO awaiter (exactly how the pending-action
    // replay invokes it). The rejecting execute() must be consumed, not become an unhandledRejection.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      capturedRun!();
      await drainTurns();
      assert.deepStrictEqual(
        rejections, [],
        `the deferred mode-change rejection leaked as unhandledRejection (process-killer): ${rejections.map(String).join("; ")}`,
      );
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("the Auto path's awaiter still sees the rejection unchanged", async () => {
    await assert.rejects(
      applyPaneMode("pane_boom_auto", "Full Auto", "voice", makeExplodingPane(), baseDeps()),
      /boom: adapter exploded/,
      "the side-consumer must NOT swallow the rejection for the awaiting Auto caller",
    );
  });
});

describe("startServer listen promise — EADDRINUSE rejects instead of hanging (1A.2.3)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let blocker: net.Server;
  let occupiedPort: number;
  let tmpDir: string;
  let prevCwd: string;
  let mock: MockLiveHandle;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-eaddrinuse-"));
    process.chdir(tmpDir);

    const { installMockLive } = await import("./helpers/mockLive");
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    mock = installMockLive();

    // Occupy a port first.
    blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const addr = blocker.address();
    occupiedPort = typeof addr === "object" && addr ? addr.port : 0;
    assert.ok(occupiedPort > 0, "blocker bound an ephemeral port");
  });

  after(async () => {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("startServer on an occupied port REJECTS with EADDRINUSE (does not hang forever)", async () => {
    const outcome = await Promise.race([
      startServer({ port: occupiedPort, bindHost: "127.0.0.1", enableVite: false }).then(
        () => ({ kind: "resolved" as const }),
        (e: unknown) => ({ kind: "rejected" as const, error: e }),
      ),
      // The buggy listen promise never settles — bound the wait so the RED run fails fast
      // instead of riding the suite timeout.
      new Promise<{ kind: "hung" }>((r) => setTimeout(() => r({ kind: "hung" }), 3000)),
    ]);
    assert.strictEqual(
      outcome.kind, "rejected",
      `startServer must reject on an occupied port; got "${outcome.kind}" (hung = the listen error was swallowed)`,
    );
    const err = (outcome as { kind: "rejected"; error: unknown }).error as NodeJS.ErrnoException;
    assert.strictEqual(err.code, "EADDRINUSE", `rejection carries the bind error, got: ${String(err)}`);
  });
});
