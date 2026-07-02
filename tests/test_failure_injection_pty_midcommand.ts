// tests/test_failure_injection_pty_midcommand.ts — bead res5, injection family (b): the PTY transport
// dies MID-COMMAND — after writeInput()/deliverSubmit() has flushed the body + CR to the child, but
// BEFORE any response/prompt chunk comes back.
//
// THE GENUINE GAP (recon): existing transport-exit suites (tests/test_restart_status.ts,
// tests/test_transport_generation.ts) drive `onExit` around RESTART races (stop -> Exited -> start,
// stale-generation guards) — never around an in-flight COMMAND. tests/test_pane_death_signal.ts (res2/
// y09) proves the onExit push signal fires with ZERO onOutput calls, but never issues a writeInput
// first. Neither exercises the THIRD leg: a follow-up write attempt against the now-dead-in-place pane
// being BLOCKED (src/dispatch/paneWrite.ts's res2 `term.status === "Exited"` guard) rather than
// silently no-oping into a dead PTY.
//
// This suite chains all three, against REAL production code (UniversalTerminal, OrchestratorManager,
// attachObserve, applyDispatchDecision) with ONE controllable fake transport (per the task's "fake/
// controllable transports for PTY death" idiom — no real PTY spawn):
//   1. writeInput() flushes the full submit (body + CR) to the transport — the command IS in flight.
//   2. The transport exits with NO further output (a silent kill mid-command, e.g. external SIGKILL
//      before the child ever answered). No orphaned pendingInput: the queue is empty both because the
//      submit already flushed (spawnReady) and because the res2/3P.4 exit-teardown clears it.
//   3. The res2/y09 death signal fires off the SAME onExit hook, with zero onOutput calls: an 'exited'
//      attention item + attention_updated broadcast + paneSignalBus 'exited' publish.
//   4. A follow-up auto-execute write against the SAME (still-registered) pane is BLOCKED
//      (kind:'error'), not silently swallowed into a dead PTY as a false-positive 'executed'.
//
// Runner: npx tsx --test --test-force-exit tests/test_failure_injection_pty_midcommand.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { UniversalTerminal, OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { attachObserve } from "../src/observe";
import { AnnouncementBus, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "../src/announcementBus";
import { PaneSignalBus } from "../src/paneSignalBus";
import { InteractionLogger } from "../src/interactionLog";
import { applyDispatchDecision, type DispatchDeps, type DispatchConn } from "../src/dispatch/paneWrite";
import { isPaneActiveForWrite } from "../src/activePane";
import { inferKind } from "../src/pendingApprovals";
import type { PtyTransport } from "../src/ptyTransport";
import type { OrchestratorManager as OM } from "../src/terminal";

function deleteScrollback(id: string): void {
  const p = `.janus_scrollback_${id}.log`;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** A controllable transport: records every write (the submit body/CR), lets the test drive an initial
 *  prompt chunk (to reach spawn-ready) and an unexpected exit with NO trailing output at all — the
 *  "external SIGKILL mid-command" shape. */
class MidCommandDeathTransport implements PtyTransport {
  writes: string[] = [];
  pid: number | undefined = 4343;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCb = cb; }
  write(d: string) { this.writes.push(d); }
  resize() {}
  kill() {}
  /** Simulate an initial prompt chunk so the terminal reaches spawn-ready. */
  emitData(chunk: string) { this.dataCb?.(chunk); }
  /** Kill the child with NO further output — the mid-command death. */
  emitExit() { this.exitCb?.({ exitCode: 137, signal: 9 }); }
}

function makeTerm(id: string, stub: MidCommandDeathTransport): UniversalTerminal {
  const term = new UniversalTerminal(
    id, ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined,
    () => ({ transport: stub, usingNodePty: true }),
  );
  (term as any).submitEnterDelayMs = 0; // synchronous body+CR flush — deterministic, no timer races.
  (term as any).killEscalationMs = 25;
  return term;
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

function restConn(rec: { notifies: any[] }): DispatchConn {
  return {
    sess: null,
    notifyPending: (frame: any) => rec.notifies.push(frame),
    enforceActivePaneGuard: false,
    origin: "rest",
  };
}

function makeAutoExecuteDeps(term: UniversalTerminal, targetId: string): DispatchDeps {
  return {
    manager: { ledger: { activeProjectId: "default_project" } } as unknown as DispatchDeps["manager"],
    pendingApprovals: { add: () => {} } as unknown as DispatchDeps["pendingApprovals"],
    broadcast: () => {},
    addCommand: () => {},
    redactSecrets: (s: string) => s,
    getPaneSummary: () => "",
    posturePayloadForPane: () => ({ id: targetId, effective_gates: {} as any, posture: "auto" }),
    announcementBus: { enqueue: () => {} },
    approvalTtlMs: 5 * 60 * 1000,
    getActivePaneId: () => targetId,
    isPaneActiveForWrite,
    targetId,
    instruction: "echo follow-up",
    capability: "write_to_pane",
    kind: inferKind(undefined, undefined),
    trigger: "res5(b) follow-up write",
    effectiveMode: "Full Auto",
    pendingId: "call-follow-up",
    callId: "call-follow-up",
    // The REAL, still-registered UniversalTerminal — not a mock. Its `.status` is already "Exited".
    term: term as unknown as DispatchDeps["term"],
  };
}

describe("res5(b): PTY transport exits MID-COMMAND — clean pending state, death signal, blocked follow-up write", () => {
  it("no orphaned pendingInput, the res2 death signal fires, and a follow-up write is blocked (not a false-positive success)", async () => {
    const store = new JanusStore(":memory:");
    store.init();
    const manager = new OrchestratorManager({ ledger: store }) as OM;
    const frames: any[] = [];
    const signals: any[] = [];
    const observeDeps = makeObserveDeps((msg) => frames.push(msg));
    observeDeps.paneSignalBus.subscribe((sig) => signals.push(sig));
    const { onExit } = attachObserve(manager, observeDeps);
    manager.onExit = onExit;

    const stub = new MidCommandDeathTransport();
    const term = makeTerm("midcmd-1", stub);
    (manager as any).wireTerminalCallbacks(term);
    manager.terminals["midcmd-1"] = term;

    try {
      term.start();
      assert.strictEqual(term.status, "Running", "boots to Running");

      // Reach spawn-ready via an initial prompt chunk (no writeInput has happened yet, so this can't
      // itself be mistaken for the command's response).
      stub.emitData("$ ");
      assert.strictEqual((term as any).spawnReady, true, "spawn-ready after the first output chunk");

      // Issue the command. deliverSubmit (submitEnterDelayMs=0) flushes body+CR SYNCHRONOUSLY — the
      // command IS in flight against the transport now.
      term.writeInput("run-the-thing");
      assert.deepStrictEqual(stub.writes, ["run-the-thing", "\r"], "the full submit (body+CR) landed on the transport");
      assert.deepStrictEqual((term as any).pendingInput, [], "nothing queued — writeInput flushed straight through (already spawn-ready)");

      // Kill the child with NO further output at all — the pane never answered.
      stub.emitExit();
      await tick();

      // (1) Clean status + no orphaned pendingInput.
      assert.strictEqual(term.status, "Exited", "status flips to Exited");
      assert.deepStrictEqual((term as any).pendingInput, [], "no orphaned pendingInput after the mid-command death");

      // (2) The res2/y09 death signal fired off the onExit hook — zero onOutput calls anywhere in
      // this test, proving it does not depend on a trailing output chunk.
      const exitedAttention = manager.attentionQueue.filter((a: any) => a.type === "exited" && a.terminalId === "midcmd-1");
      assert.strictEqual(exitedAttention.length, 1, "exactly one 'exited' attention item pushed");
      assert.ok(frames.some((f) => f.type === "attention_updated"), "attention_updated broadcast fired");
      assert.ok(frames.some((f) => f.type === "pane_transition" && f.transition === "exited"), "pane_transition('exited') broadcast fired");
      assert.ok(signals.some((s) => s.kind === "exited" && s.paneId === "midcmd-1"), "paneSignalBus published the 'exited' voice/push signal");

      // (3) A follow-up auto-execute write against the SAME still-registered (now dead-in-place) pane
      // is BLOCKED — not a silent false-positive 'executed' swallowed into a dead PTY.
      const rec = { notifies: [] as any[] };
      const outcome = applyDispatchDecision(
        { type: "auto_execute" },
        makeAutoExecuteDeps(term, "midcmd-1"),
        restConn(rec),
      );
      assert.strictEqual(outcome.kind, "error", "the follow-up write is refused, not silently executed");
      assert.match((outcome as { text: string }).text, /not running/i, "the refusal names the dead pane, not a generic error");
      assert.deepStrictEqual(stub.writes, ["run-the-thing", "\r"], "the blocked follow-up never reached the dead transport");
    } finally {
      await term.stop();
      deleteScrollback("midcmd-1");
    }
  });
});
