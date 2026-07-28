// tests/test_pane_lifecycle_lock.ts — bead wsm-e2e-pinned-kcc0.
//
// Two layers:
//   1. Unit tests of the mutex primitive itself (src/lifecycleLock.ts): synchronous-when-uncontended
//      invocation (the property kdtu's fix depends on — see the module doc), serialization of
//      overlapping calls on the SAME pane id, independence across DIFFERENT pane ids, error safety
//      (a rejecting fn releases the lock instead of wedging it), and no leaked queue state.
//   2. Integration tests against the REAL production mutators the lock now wraps:
//        - concurrent respawn_pane + respawn_pane on ONE pane -> exactly one final live PTY,
//          deterministic (no interleaved stop/start windows). Uses runAction against the REAL
//          respawn_pane def (src/actions/defs/panes_rest.ts) with a controllable fake term — no sleeps,
//          only manually-released gates + a microtask flush (the SAME idiom test_panes_rest_c55.ts's
//          pinned kdtu ordering tests already use).
//        - concurrent archive + respawn on ONE pane still resolves per kdtu semantics (no ghost
//          respawn) with the lock in place. Uses the REAL OrchestratorManager.stopAndArchivePane
//          (src/terminal.ts) racing the REAL respawn_pane continuation on a shared manager, mirroring
//          tests/test_pane_exit_archive.ts's override-`.stop`-directly pattern.

// bead eoef: pin the settings file into a tmpdir for this whole file — constructing an
// OrchestratorManager (directly or via startServer) without this writes a cwd-relative
// .janus_settings.json into the repo root, which the run-unit cleanliness gate fails on.
import { pinSettingsPathToTmpdir } from "./helpers/settingsPath";
pinSettingsPathToTmpdir();

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";

import { withPaneLifecycleLock } from "../src/lifecycleLock";
import { OrchestratorManager, UniversalTerminal } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import type { ActionContext, GateDisposition } from "../src/actions/types";

// ── 1. the mutex primitive ─────────────────────────────────────────────────────────────────────────

describe("withPaneLifecycleLock (kcc0) — the primitive", () => {
  it("runs fn SYNCHRONOUSLY when the pane is uncontended (no added microtask hop)", async () => {
    let ran = false;
    const p = withPaneLifecycleLock("sync-check", async () => { ran = true; return 1; });
    assert.strictEqual(ran, true, "fn must start executing in the SAME tick when the pane is free");
    await p;
  });

  it("serializes two overlapping calls on the SAME pane id — the second waits for the first to settle", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const p1 = withPaneLifecycleLock("serialize", async () => { order.push("1-start"); await gate; order.push("1-end"); });
    const p2 = withPaneLifecycleLock("serialize", async () => { order.push("2-start"); order.push("2-end"); });
    assert.deepStrictEqual(order, ["1-start"], "fn2 must NOT start until fn1 settles");
    releaseFirst();
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, ["1-start", "1-end", "2-start", "2-end"]);
  });

  it("different pane ids never wait on each other (keyed, not global)", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const pA = withPaneLifecycleLock("pane-a", async () => { await gateA; });
    let ranB = false;
    const pB = withPaneLifecycleLock("pane-b", async () => { ranB = true; });
    assert.strictEqual(ranB, true, "pane-b's fn must run immediately, unblocked by pane-a's in-flight op");
    releaseA();
    await Promise.all([pA, pB]);
  });

  it("a rejecting fn releases the lock (does not wedge the pane) — a queued caller still gets its turn", async () => {
    const p1 = withPaneLifecycleLock("wedge-check", async () => { throw new Error("boom"); });
    let ran2 = false;
    const p2 = withPaneLifecycleLock("wedge-check", async () => { ran2 = true; });
    await assert.rejects(p1, /boom/);
    await p2;
    assert.strictEqual(ran2, true);
  });

  it("propagates fn's resolved value to ITS OWN caller (not swallowed by internal bookkeeping)", async () => {
    const out = await withPaneLifecycleLock("value-check", async () => 42);
    assert.strictEqual(out, 42);
  });

  it("releases the pane slot once settled — a LATER call on the same pane runs uncontended again", async () => {
    await withPaneLifecycleLock("release-check", async () => {});
    let ranImmediately = false;
    const p = withPaneLifecycleLock("release-check", async () => { ranImmediately = true; });
    assert.strictEqual(
      ranImmediately, true,
      "a call issued after the prior one already settled must NOT queue — proves the map entry was cleaned up"
    );
    await p;
  });
});

// ── 2a. integration: concurrent respawn_pane + respawn_pane on ONE pane ───────────────────────────

interface GatedTerm {
  stop: () => Promise<void>;
  start: () => void;
  stopCount: number;
  startCount: number;
  events: string[];
  releaseNextStop: () => void;
}

function makeGatedTerm(): GatedTerm {
  const releases: Array<() => void> = [];
  const events: string[] = [];
  const t = {
    stopCount: 0,
    startCount: 0,
    events,
    stop: (): Promise<void> => new Promise<void>((resolve) => {
      t.stopCount++;
      const n = t.stopCount;
      events.push(`stop-begin-${n}`);
      releases.push(() => { events.push(`stop-end-${n}`); resolve(); });
    }),
    start: (): void => { t.startCount++; events.push(`start-${t.startCount}`); },
    releaseNextStop: (): void => { const r = releases.shift(); if (r) r(); },
  };
  return t;
}

function makeMinimalRespawnCtx(term: unknown): { ctx: ActionContext; manager: Record<string, unknown> } {
  const manager: Record<string, unknown> = {
    terminals: { p1: term },
    archivingPanes: new Set<string>(),
    settings: { presets: undefined, advanced: { defaultShellCommand: "" } },
    ledger: {
      activeProjectId: null,
      getActiveProject: () => null,
      getProject: () => null,
    },
  };
  const ctx = {
    manager,
    session: null,
    redact: (s: string) => s,
    isFrozen: () => false,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    broadcastTerminalsUpdated: () => {},
    gateOrDefer: (_capability: string, _paneId: string | null, _summary: string, run: () => string): GateDisposition => {
      void run; // Auto: the caller runs the effect, mirrors the real gateOrDefer contract.
      return { disposition: "run" as const };
    },
  } as unknown as ActionContext;
  return { ctx, manager };
}

describe("kcc0 integration — concurrent respawn_pane + respawn_pane on one pane", () => {
  it("results in exactly one final live PTY, deterministically — no interleaved stop/start windows", async () => {
    const term = makeGatedTerm();
    const { ctx } = makeMinimalRespawnCtx(term);

    // Two overlapping REST respawn calls on the same pane, issued back-to-back (no await between).
    const r1 = runAction(REGISTRY, "respawn_pane", { pane_id: "p1" }, ctx);
    const r2 = runAction(REGISTRY, "respawn_pane", { pane_id: "p1" }, ctx);
    const [res1, res2] = await Promise.all([r1, r2]);
    assert.strictEqual(res1.kind, "ok");
    assert.strictEqual(res2.kind, "ok");

    // Both acks return eagerly (unchanged contract); only ONE stop() has actually run so far — the
    // lock is what stops the second call's stop() from firing concurrently with the first's.
    assert.strictEqual(term.stopCount, 1, "the second respawn is queued behind the lock — its stop() has not fired yet");
    assert.strictEqual(term.startCount, 0, "still parked in the stop->start gap");

    term.releaseNextStop(); // resolve call #1's stop()
    await new Promise((r) => setImmediate(r)); // flush call #1's continuation (ownership check + start())

    assert.strictEqual(term.startCount, 1, "the first respawn completed its start()");
    assert.strictEqual(term.stopCount, 2, "the second respawn's stop() only fires AFTER the first's start()");

    term.releaseNextStop(); // resolve call #2's stop()
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(term.startCount, 2, "the second respawn completed its start()");
    // The load-bearing proof: fully sequential, never interleaved (no stop-begin-2 before start-1).
    assert.deepStrictEqual(term.events, [
      "stop-begin-1", "stop-end-1", "start-1",
      "stop-begin-2", "stop-end-2", "start-2",
    ], `expected fully sequential lifecycle events, got: ${JSON.stringify(term.events)}`);
  });
});

// ── 2b. integration: concurrent archive + respawn on ONE pane still resolves per kdtu semantics ──

function cleanupKcc0Fixtures(paneId: string): void {
  try { fs.unlinkSync(`.janus_scrollback_${paneId}.log`); } catch { /* already gone */ }
}

describe("kcc0 integration — concurrent archive + respawn on one pane", () => {
  it("archive marked mid-flight -> the queued respawn continuation still sees archivingPanes and aborts (no ghost); archive still completes correctly", async () => {
    cleanupKcc0Fixtures("p-kcc0");
    const store = new JanusStore(":memory:");
    store.init();
    const manager = new OrchestratorManager({ ledger: store });
    const paneId = "p-kcc0";
    const projectId = "default_project";
    const term = new UniversalTerminal(paneId, ".", "echo hi", "Custom", "Human-in-the-Loop", "", projectId);

    // Override stop()/start() directly on the REAL UniversalTerminal instance — the SAME pattern
    // tests/test_pane_exit_archive.ts uses to control the stop->start gap without a real PTY spawn.
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((r) => { releaseStop = r; });
    let stopCalls = 0;
    let startCalls = 0;
    (term as unknown as { stop: () => Promise<void> }).stop = async () => { stopCalls++; await stopGate; };
    (term as unknown as { start: () => void }).start = () => { startCalls++; };
    term.status = "Idle";
    manager.terminals[paneId] = term;
    (manager as unknown as { syncLedger: () => void }).syncLedger();

    // Minimal ActionContext wired to the REAL manager — respawn_pane only needs these members.
    const ctx = {
      manager,
      session: null,
      redact: (s: string) => s,
      isFrozen: () => false,
      broadcast: () => {},
      broadcastLedgerUpdate: () => {},
      broadcastTerminalsUpdated: () => {},
      gateOrDefer: (_capability: string, _paneId: string | null, _summary: string, run: () => string): GateDisposition => {
        void run;
        return { disposition: "run" as const };
      },
    } as unknown as ActionContext;

    // 1) Kick off the respawn: uncontended lock -> its fn runs synchronously up to `await term.stop()`.
    const respawnResult = await runAction(REGISTRY, "respawn_pane", { pane_id: paneId }, ctx);
    assert.strictEqual(respawnResult.kind, "ok");
    assert.strictEqual(stopCalls, 1, "respawn began: stop() was invoked");
    assert.strictEqual(startCalls, 0, "still parked in the stop->start gap");

    // 2) One-tap 86 in the gap: the REAL stopAndArchivePane. archivingPanes is marked SYNCHRONOUSLY
    //    regardless of the lock (kdtu's property, preserved) — its actual WORK queues behind the
    //    respawn's in-flight lock hold.
    const archivePromise = manager.stopAndArchivePane(projectId, paneId);
    assert.ok(
      manager.archivingPanes.has(paneId),
      "archive intent is visible synchronously even while the archive's WORK is queued behind the lock"
    );

    // 3) Release the shared stop() gate: the respawn's continuation (registered first) resumes FIRST
    //    and must see the archive intent and abort — no ghost respawn.
    releaseStop();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(startCalls, 0, "the in-flight respawn must NOT ghost-respawn an archived pane");

    // 4) The archive's queued work now runs to completion.
    const archived = await archivePromise;
    assert.strictEqual(archived, true, "the pane is still archived correctly despite the interleaved respawn");
    assert.strictEqual(manager.terminals[paneId], undefined, "the live slot is dropped");
    assert.strictEqual(manager.archivingPanes.has(paneId), false, "archive mark cleaned up after completion");

    cleanupKcc0Fixtures(paneId);
    store.close();
  });
});
