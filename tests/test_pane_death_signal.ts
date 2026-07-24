// tests/test_pane_death_signal.ts — bead res2 (PTY death handling): the PUSH exit edge.
//
// THE GAP (wsm-e2e-pinned-y09, confirmed still open pre-fix): the "exited" attention item /
// attention_updated broadcast / paneSignalBus publish were produced ONLY by
// src/observe/index.ts's onOutput-driven classifier (classifyTransition short-circuits to
// "exited" the moment it sees term.status === "Exited"). Because that classifier only ever runs
// from a PTY *output* chunk, a pane that dies with NO trailing output (e.g. an external SIGKILL)
// flipped term.status to "Exited" with zero downstream signal — the operator/model never learned.
//
// THE FIX: UniversalTerminal now exposes a public `onExit` hook, fired synchronously from the
// transport.onExit teardown (src/terminal.ts) the instant status flips to "Exited" — independent
// of any subsequent output chunk. OrchestratorManager fans it (wireTerminalCallbacks), and
// src/observe/index.ts's attachObserve wires a matching `onExit` handler that re-uses the EXACT
// SAME detectAndTriggerTransitions/classifyTransition/emitHighSeverityTransition path the
// onOutput chunk classifier already used — same attention item, same attention_updated broadcast,
// same paneSignalBus 'exited' publish, same lastStates edge-dedup.
//
// This suite covers three layers, deterministically (fake transports, no sleeps):
//   1. UniversalTerminal.onExit fires on a genuine transport exit with NO output chunk at all.
//   2. OrchestratorManager fans UniversalTerminal.onExit -> manager.onExit.
//   3. src/observe's attachObserve onExit handler produces the attention/broadcast/paneSignal
//      triad DIRECTLY off the exit hook, with zero onOutput calls in the test.
//
// Runner: npx tsx --test --test-force-exit tests/test_pane_death_signal.ts

import { test, describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { UniversalTerminal, OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { attachObserve } from "../src/observe";
import { AnnouncementBus, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "../src/announcementBus";
import { PaneSignalBus } from "../src/paneSignalBus";
import { InteractionLogger } from "../src/interactionLog";
import type { PtyTransport } from "../src/ptyTransport";
import type { OrchestratorManager as OM } from "../src/terminal";

function deleteScrollback(id: string): void {
  const p = `.janus_scrollback_${id}.log`;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// A minimal stub transport: never emits onData (models a silent external SIGKILL — the pane dies
// with NO trailing PTY output at all), and fires onExit only when explicitly driven.
class SilentDeathTransport implements PtyTransport {
  writes: string[] = [];
  pid: number | undefined = 4242;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  onData(_cb: (d: string) => void) { /* never fires — models a silent death */ }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCb = cb; }
  write(d: string) { this.writes.push(d); }
  resize() {}
  kill() {}
  /** Drive an unexpected exit (e.g. external SIGKILL) with no prior output. */
  emitExit() { this.exitCb?.({ exitCode: 137, signal: 9 }); }
}

function makeTerm(id: string, stub: SilentDeathTransport): UniversalTerminal {
  const term = new UniversalTerminal(
    id, ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined,
    () => ({ transport: stub, usingNodePty: true }),
  );
  (term as any).submitEnterDelayMs = 0;
  (term as any).killEscalationMs = 25; // don't ride the production 1000ms SIGKILL window on teardown
  return term;
}

describe("res2/y09: UniversalTerminal.onExit — the PUSH exit edge", () => {
  it("fires with the terminal id the instant the transport exits, with NO output chunk ever received", async () => {
    const stub = new SilentDeathTransport();
    const term = makeTerm("death-1", stub);
    const exits: string[] = [];
    (term as any).onExit = (id: string) => exits.push(id);
    try {
      term.start();
      assert.strictEqual(term.status, "Running", "boots to Running");
      assert.strictEqual(exits.length, 0, "no exit fired yet");

      stub.emitExit(); // silent death — no onData was ever called
      await tick();

      assert.strictEqual(term.status, "Exited", "status flips to Exited");
      assert.deepStrictEqual(exits, ["death-1"], "onExit fired exactly once with the terminal id");
    } finally {
      await term.stop();
      deleteScrollback("death-1");
    }
  });

  it("fires status===Exited to the observer BEFORE/AT the callback (classifiable immediately)", async () => {
    const stub = new SilentDeathTransport();
    const term = makeTerm("death-2", stub);
    let statusAtCallback: string | null = null;
    (term as any).onExit = () => { statusAtCallback = term.status; };
    try {
      term.start();
      stub.emitExit();
      await tick();
      assert.strictEqual(statusAtCallback, "Exited", "term.status is already Exited when onExit fires");
    } finally {
      await term.stop();
      deleteScrollback("death-2");
    }
  });

  it("a subscriber throw inside onExit is swallowed — does not corrupt the exit teardown", async () => {
    const stub = new SilentDeathTransport();
    const term = makeTerm("death-3", stub);
    (term as any).onExit = () => { throw new Error("boom"); };
    try {
      term.start();
      stub.emitExit();
      await tick();
      assert.strictEqual(term.status, "Exited", "teardown still completes despite the subscriber throw");
    } finally {
      await term.stop();
      deleteScrollback("death-3");
    }
  });
});

describe("res2/y09: OrchestratorManager fans UniversalTerminal.onExit -> manager.onExit", () => {
  it("manager.onExit fires with the terminal id on a silent death", async () => {
    const store = new JanusStore(":memory:");
    store.init();
    const manager = new OrchestratorManager({ ledger: store }) as OM;
    const exits: string[] = [];
    (manager as any).onExit = (id: string) => exits.push(id);

    const stub = new SilentDeathTransport();
    const term = makeTerm("death-mgr-1", stub);
    // Register + wire exactly as addTerminal's createConfiguredTerminal does, without spawning a
    // real OS process (this test injects the stub transport via the constructor seam instead).
    (manager as any).wireTerminalCallbacks(term);
    manager.terminals["death-mgr-1"] = term;

    try {
      term.start();
      stub.emitExit();
      await tick();
      assert.deepStrictEqual(exits, ["death-mgr-1"], "manager.onExit fanned exactly once");
    } finally {
      await term.stop();
      deleteScrollback("death-mgr-1");
    }
  });
});

// ── Layer 3: src/observe's attachObserve onExit handler — the operator-visible signal itself ──

function makeFakeManagerForExit(): { manager: OM; attentionQueue: any[] } {
  const attentionQueue: any[] = [];
  const manager = {
    terminals: {
      p1: { status: "Exited", runtimeType: "shell", lastCommand: "npm test" },
    },
    attentionQueue,
    // W5: observe push sites route through manager.pushAttention now (mirror the in-memory append).
    pushAttention: (item: any) => attentionQueue.push(item),
    settings: { secrets: {} },
    ledger: {
      watchRules: [] as any[],
      plans: [] as any[],
      activeProjectId: "proj_test",
      save: () => {},
    },
  } as unknown as OM;
  return { manager, attentionQueue };
}

function makeObserveDeps(broadcast: (msg: any) => void) {
  return {
    broadcast,
    announcementBus: new AnnouncementBus({
      broadcast: () => {},
      getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES,
    }),
    paneSignalBus: new PaneSignalBus(0),
    pruneAttention: () => {},
    interactionLog: new InteractionLogger({ sink: () => {} }),
    getLastInteractionId: () => null,
    redact: (s: string) => s,
    historyManager: {
      loadHistory: () => [],
      saveHistory: () => {},
      appendOutputToLastCommand: () => {},
    },
    ai: {} as any,
  };
}

// ── Wave 5b fixer review, finding 1 (major): stale lastStates dedup survives a restart ──
//
// THE GAP: detectAndTriggerTransitions dedups on lastStates[terminalId] and nothing ever reset
// that entry when a pane restarts. Once "exited" was stamped by a first death, a SECOND genuine
// silent death after a restart classified "exited" === previousState and was suppressed — no
// attention item, no attention_updated, no paneSignal. THE FIX: onRunning (the fresh-spawn edge)
// now deletes lastStates[terminalId], so a restarted pane's later death gets its own fresh edge.
describe("y09 follow-up: onRunning clears the stale lastStates edge so a restart re-arms the exit signal", () => {
  it("die -> restart (onRunning) -> silent die again produces a SECOND 'exited' attention item + paneSignal", () => {
    const frames: any[] = [];
    const signals: any[] = [];
    const { manager, attentionQueue } = makeFakeManagerForExit();
    const deps = makeObserveDeps((msg) => frames.push(msg));
    deps.paneSignalBus.subscribe((sig) => signals.push(sig));
    const { onExit, onRunning } = attachObserve(manager, deps);
    const term = (manager as any).terminals.p1;

    // Death #1: the pane is already Exited when onExit fires.
    term.status = "Exited";
    onExit("p1");
    assert.strictEqual(
      attentionQueue.filter((a: any) => a.type === "exited").length,
      1,
      "first death produces exactly one 'exited' attention item"
    );

    // Restart: the pane comes back Running. This is the fresh-spawn edge that must clear the
    // stale "exited" stamp from death #1.
    term.status = "Running";
    onRunning("p1");

    // Death #2: a genuine, independent silent death on the restarted pane.
    term.status = "Exited";
    onExit("p1");

    const exitedItems = attentionQueue.filter((a: any) => a.type === "exited");
    assert.strictEqual(exitedItems.length, 2, "the SECOND silent death after a restart is NOT suppressed");

    const exitedSignals = signals.filter((s: any) => s.kind === "exited");
    assert.strictEqual(exitedSignals.length, 2, "paneSignalBus published the 'exited' signal twice");
  });

  it("without an intervening onRunning, a second onExit on the SAME life is still deduped (no regression)", () => {
    const { manager, attentionQueue } = makeFakeManagerForExit();
    const deps = makeObserveDeps(() => {});
    const { onExit } = attachObserve(manager, deps);
    const term = (manager as any).terminals.p1;

    term.status = "Exited";
    onExit("p1");
    onExit("p1"); // same life, no restart in between — must still be deduped

    assert.strictEqual(
      attentionQueue.filter((a: any) => a.type === "exited").length,
      1,
      "repeated onExit calls on the same life stay deduped"
    );
  });
});

describe("res2/y09: attachObserve's onExit handler — the operator-visible signal, no onOutput required", () => {
  it("pushes an 'exited' attention item + attention_updated broadcast, with ZERO onOutput calls", () => {
    const frames: any[] = [];
    const { manager, attentionQueue } = makeFakeManagerForExit();
    const { onExit } = attachObserve(manager, makeObserveDeps((msg) => frames.push(msg)));

    // Deliberately never call onOutput — the whole point of the fix.
    onExit("p1");

    assert.strictEqual(attentionQueue.length, 1, "exactly one attention item pushed");
    assert.strictEqual(attentionQueue[0].type, "exited");
    assert.strictEqual(attentionQueue[0].terminalId, "p1");

    const updated = frames.find((f) => f.type === "attention_updated");
    assert.ok(updated, "attention_updated broadcast fired");

    const transition = frames.find((f) => f.type === "pane_transition");
    assert.ok(transition, "pane_transition broadcast fired");
    assert.strictEqual(transition.transition, "exited");
  });

  it("publishes an 'exited' paneSignalBus event (voice/push lane) — no audio earcon assertion (out of scope)", () => {
    const frames: any[] = [];
    const signals: any[] = [];
    const { manager } = makeFakeManagerForExit();
    const deps = makeObserveDeps((msg) => frames.push(msg));
    deps.paneSignalBus.subscribe((sig) => signals.push(sig));

    const { onExit } = attachObserve(manager, deps);
    onExit("p1");

    const exitedSignal = signals.find((s) => s.kind === "exited");
    assert.ok(exitedSignal, "an 'exited' pane signal is published");
    assert.strictEqual(exitedSignal.paneId, "p1");
  });

  it("is deduped against a PRIOR onOutput-driven classification of the SAME exit (no double-fire)", () => {
    const frames: any[] = [];
    const { manager, attentionQueue } = makeFakeManagerForExit();
    const { onOutput, onExit } = attachObserve(manager, makeObserveDeps((msg) => frames.push(msg)));

    // The output-chunk path classifies the exit first (e.g. a trailing error line arrived just
    // before the process died).
    onOutput("p1", "Fatal: process terminated\n");
    const afterOutput = attentionQueue.length;
    assert.ok(afterOutput >= 1, "the output-chunk path already raised at least one attention item");

    // The PUSH onExit hook then fires for the SAME underlying exit — lastStates dedup must not
    // double-push a second 'exited' attention item.
    onExit("p1");
    const exitedItems = attentionQueue.filter((a) => a.type === "exited");
    assert.strictEqual(exitedItems.length, 1, "the 'exited' edge is not double-fired");
  });

  it("does not throw when the pane is unknown to the manager (already torn down / never registered)", () => {
    const frames: any[] = [];
    const { manager } = makeFakeManagerForExit();
    const { onExit } = attachObserve(manager, makeObserveDeps((msg) => frames.push(msg)));
    assert.doesNotThrow(() => onExit("unknown-pane"));
  });
});

// ── Wave 5b fixer review, finding 2 (major): onExit fired on EVERY intentional stop ──
//
// THE GAP: the transport.onExit teardown in src/terminal.ts fired `this.onExit` unconditionally,
// so an operator-initiated respawn_pane / close_pane / archive / shutdown produced the SAME
// HIGH-SEVERITY triad (attention item, attention_updated broadcast, proactive announcement,
// paneSignalBus 'exited') as a genuine unexpected death. THE FIX: gate the fan on `ownExit`
// (already computed one line above) — true only when `this.transport` still equals the exiting
// transport (a genuine self-exit while live); an intentional stop() nulls `this.transport` BEFORE
// killing, so ownExit is false there and the fan stays quiet.
//
// A stub with MULTIPLE onExit listeners (unlike SilentDeathTransport's single-slot stub) is
// required here to faithfully model production node-pty, where BOTH the start()-installed
// teardown callback and _doStop's own `transport.onExit(done)` registration receive the exit
// event. kill() synchronously fires all registered listeners, modelling a SIGTERM-responsive
// child so no timers/sleeps are needed.
class MultiListenerTransport implements PtyTransport {
  writes: string[] = [];
  pid: number | undefined = 4242;
  private exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  onData(_cb: (d: string) => void) { /* no output in this suite */ }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCbs.push(cb); }
  write(d: string) { this.writes.push(d); }
  resize() {}
  /** A well-behaved child: SIGTERM kills it immediately, firing every registered exit listener. */
  kill() { this.emitExit(); }
  /** Drive an unexpected exit (e.g. external SIGKILL) directly, bypassing kill(). */
  emitExit() {
    const cbs = this.exitCbs;
    this.exitCbs = [];
    cbs.forEach((cb) => cb({ exitCode: 137, signal: 9 }));
  }
}

function makeMultiTerm(id: string, stub: MultiListenerTransport): UniversalTerminal {
  const term = new UniversalTerminal(
    id, ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined,
    () => ({ transport: stub, usingNodePty: true }),
  );
  (term as any).submitEnterDelayMs = 0;
  (term as any).killEscalationMs = 25;
  return term;
}

describe("Wave 5b finding 2: UniversalTerminal.onExit is gated on ownExit (self-exit only)", () => {
  it("an INTENTIONAL stop() does NOT fire onExit", async () => {
    const stub = new MultiListenerTransport();
    const term = makeMultiTerm("ownexit-stop-1", stub);
    const exits: string[] = [];
    (term as any).onExit = (id: string) => exits.push(id);

    term.start();
    assert.strictEqual(term.status, "Running", "boots to Running");

    await term.stop(); // intentional stop — kill() synchronously fires the exit listeners

    assert.strictEqual(term.status, "Exited", "status still flips to Exited on stop");
    assert.deepStrictEqual(exits, [], "onExit did NOT fire for an intentional stop (ownExit=false)");
    deleteScrollback("ownexit-stop-1");
  });

  it("a GENUINE unexpected death (self-exit while running) still fires onExit (ownExit=true)", async () => {
    const stub = new MultiListenerTransport();
    const term = makeMultiTerm("ownexit-death-1", stub);
    const exits: string[] = [];
    (term as any).onExit = (id: string) => exits.push(id);

    try {
      term.start();
      assert.strictEqual(term.status, "Running", "boots to Running");

      stub.emitExit(); // unexpected death — this.transport still equals the exiting transport

      assert.strictEqual(term.status, "Exited", "status flips to Exited");
      assert.deepStrictEqual(exits, ["ownexit-death-1"], "onExit fired for a genuine self-exit");
    } finally {
      await term.stop();
      deleteScrollback("ownexit-death-1");
    }
  });

  it("a RESTART (stop then start) does not fire onExit for the stop leg, and a later silent death on the NEW spawn still fires", async () => {
    const stub1 = new MultiListenerTransport();
    const stub2 = new MultiListenerTransport();
    let calls = 0;
    const stubs = [stub1, stub2];
    const term = new UniversalTerminal(
      "ownexit-restart-1", ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
      undefined,
      () => ({ transport: stubs[calls++], usingNodePty: true }),
    );
    (term as any).submitEnterDelayMs = 0;
    (term as any).killEscalationMs = 25;
    const exits: string[] = [];
    (term as any).onExit = (id: string) => exits.push(id);

    try {
      term.start(); // life #1 on stub1
      await term.stop(); // intentional — must NOT fire onExit
      assert.deepStrictEqual(exits, [], "intentional stop of life #1 did not fire onExit");

      term.start(); // life #2 on stub2 (fresh spawn)
      assert.strictEqual(term.status, "Running", "restarted pane is Running again");

      stub2.emitExit(); // genuine silent death of the NEW spawn
      assert.strictEqual(term.status, "Exited");
      assert.deepStrictEqual(exits, ["ownexit-restart-1"], "the restarted pane's genuine death DOES fire onExit");
    } finally {
      await term.stop();
      deleteScrollback("ownexit-restart-1");
    }
  });
});
