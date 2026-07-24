import { describe, it } from "node:test";
import assert from "node:assert";
import { attachObserve } from "../src/observe";
import { AnnouncementBus, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "../src/announcementBus";
import { PaneSignalBus } from "../src/paneSignalBus";
import { InteractionLogger } from "../src/interactionLog";
import type { OrchestratorManager } from "../src/terminal";

/**
 * dec-2 (DBT5): focused unit for the extracted PTY observation/trigger pipeline (src/observe).
 *
 * Drives a fake PTY chunk through the `onOutput` handle returned by attachObserve and asserts the
 * `pane_transition` broadcast frame is emitted UNCHANGED — i.e. the behaviour-preserving carve out
 * of server.ts's startServer() closure produces the identical observation surface. The triggers only
 * SURFACE attention (no pane writes / no capability gate), so a fake manager + sinks fully exercise it.
 */

/** A throwaway manager that satisfies only the structural surface attachObserve reads. */
function makeFakeManager(termStatus: string, lastCommand = ""): { manager: OrchestratorManager; attentionQueue: any[] } {
  const attentionQueue: any[] = [];
  const manager = {
    terminals: {
      p1: { status: termStatus, runtimeType: "shell", lastCommand },
    },
    attentionQueue,
    // W5: the observe push sites route through manager.pushAttention now; the structural double
    // mirrors the real in-memory append so the existing attentionQueue assertions still hold.
    pushAttention: (item: any) => attentionQueue.push(item),
    settings: { secrets: {} },
    ledger: {
      watchRules: [] as any[],
      plans: [] as any[],
      activeProjectId: "proj_test",
      // attachObserve only calls ledger["save"](true) when a watch-rule/plan trigger fires; on the
      // plain transition path it is never reached, but provide it so the structural cast is honest.
      save: () => {},
    },
  } as unknown as OrchestratorManager;
  return { manager, attentionQueue };
}

function makeDeps(broadcast: (msg: any) => void) {
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
    setLastInteractionId: (_v: string | null) => {},
    redact: (s: string) => s,
    historyManager: {
      loadHistory: () => [],
      saveHistory: () => {},
      appendOutputToLastCommand: () => {},
    },
    ai: {} as any, // only the onIdle summarizer touches `ai`; the transition path never does
  };
}

describe("observe pipeline (dec-2)", () => {
  it("emits an unchanged pane_transition broadcast frame on an error chunk", () => {
    const frames: any[] = [];
    const { manager } = makeFakeManager("Running");

    const { onOutput } = attachObserve(manager, makeDeps((msg) => frames.push(msg)));

    // A chunk that classifyPaneOutput + detectAndTriggerTransitions both read as an error edge.
    onOutput("p1", "Error: something exploded\n");

    const transition = frames.find((f) => f.type === "pane_transition");
    assert.ok(transition, "a pane_transition frame is broadcast");
    assert.deepStrictEqual(transition, {
      type: "pane_transition",
      terminalId: "p1",
      transition: "error",
      message: "Pane p1 is now error.",
    });

    // The high-severity transition also pushes an attention item and re-broadcasts the queue.
    assert.ok(
      frames.some((f) => f.type === "attention_updated"),
      "an attention_updated frame follows the error transition"
    );

    // And the per-pane buffered stdout flushes as a stdout_chunk (after the 30ms coalesce window).
    // We do not advance timers here; asserting the transition frame is the behavioural anchor.
  });

  it("Phase 1 ears: onRunning publishes a 'running' pane signal AND a pane_status broadcast frame (detail redacted)", () => {
    const frames: any[] = [];
    const signals: any[] = [];
    const { manager } = makeFakeManager("Running", "deploy token AKIA1234567890ABCD99");

    const deps = makeDeps((msg) => frames.push(msg));
    // Use a redact that actually scrubs, so we can prove detail is redacted at the boundary.
    deps.redact = (s: string) => s.replace(/AKIA[0-9A-Z]{12,}/g, "[REDACTED_AWS_KEY]");
    deps.paneSignalBus.subscribe((sig) => signals.push(sig));

    const handlers = attachObserve(manager, deps) as any;
    assert.strictEqual(typeof handlers.onRunning, "function", "attachObserve returns an onRunning handle");

    handlers.onRunning("p1");

    // (a) a bus 'running' signal fanned to subscribers
    assert.strictEqual(signals.length, 1, "exactly one 'running' signal published");
    assert.strictEqual(signals[0].kind, "running");
    assert.strictEqual(signals[0].paneId, "p1");
    assert.ok(signals[0].detail, "detail derived from the pane's last command");
    assert.doesNotMatch(signals[0].detail, /AKIA1234567890ABCD99/, "raw secret must be redacted out of detail");
    assert.match(signals[0].detail, /REDACTED/, "detail carries the redaction marker");

    // (b) a real-time pane_status broadcast for the UI (fact [D])
    const statusFrame = frames.find((f) => f.type === "pane_status");
    assert.ok(statusFrame, "a pane_status frame is broadcast");
    assert.strictEqual(statusFrame.terminalId, "p1");
    assert.strictEqual(statusFrame.status, "Running");
  });

  it("Conservative Phase 2: onQuiescing publishes a 'quiescing' pane signal AND a pane_quiescing frame (detail redacted, no completion announcement)", () => {
    const frames: any[] = [];
    const signals: any[] = [];
    const announced: any[] = [];
    const { manager } = makeFakeManager("Running", "deploy token AKIA1234567890ABCD99");

    const deps = makeDeps((msg) => frames.push(msg));
    deps.redact = (s: string) => s.replace(/AKIA[0-9A-Z]{12,}/g, "[REDACTED_AWS_KEY]");
    deps.paneSignalBus.subscribe((sig) => signals.push(sig));
    // Spy the announcement bus so we can prove cooking does NOT enqueue a completion.
    (deps.announcementBus as any).enqueue = (a: any) => { announced.push(a); };

    const handlers = attachObserve(manager, deps) as any;
    assert.strictEqual(typeof handlers.onQuiescing, "function", "attachObserve returns an onQuiescing handle");

    handlers.onQuiescing("p1");

    // (a) a bus 'quiescing' signal fanned to subscribers (model channel)
    assert.strictEqual(signals.length, 1, "exactly one 'quiescing' signal published");
    assert.strictEqual(signals[0].kind, "quiescing");
    assert.strictEqual(signals[0].paneId, "p1");
    assert.doesNotMatch(signals[0].detail ?? "", /AKIA1234567890ABCD99/, "raw secret must be redacted out of detail");

    // (b) a lightweight pane_quiescing broadcast for the UI's humble label
    const frame = frames.find((f) => f.type === "pane_quiescing");
    assert.ok(frame, "a pane_quiescing frame is broadcast");
    assert.strictEqual(frame.terminalId, "p1");

    // (c) cooking is NOT 'done' — no completion announcement enqueued on this edge
    assert.strictEqual(
      announced.some((a) => a.kind === "completion"),
      false,
      "the quiescing edge must NOT enqueue a completion announcement"
    );
  });

  it("1C.2: the exited transition publishes an 'exited' pane signal to the voice lane", () => {
    // AUDIT (Phase 1 Track C): a crashed/ended pane went only to the attention queue + the
    // announcement bus — no PaneSignal ever reached the live-session observers, so the model
    // kept narrating a dead pane as healthy. The exited edge must fan out on the signal bus
    // exactly like the idle/running/quiescing edges do.
    const frames: any[] = [];
    const signals: any[] = [];
    const { manager } = makeFakeManager("Exited");

    const deps = makeDeps((msg) => frames.push(msg));
    deps.paneSignalBus.subscribe((sig) => signals.push(sig));

    const { onOutput } = attachObserve(manager, deps);
    onOutput("p1", "process finished\n");

    // Existing behavior preserved: the transition frame still broadcasts.
    const transition = frames.find((f) => f.type === "pane_transition");
    assert.ok(transition, "a pane_transition frame is broadcast");
    assert.strictEqual(transition.transition, "exited");

    // NEW: the voice lane hears it.
    const exited = signals.find((s) => s.kind === "exited");
    assert.ok(exited, "an 'exited' pane signal is published to bus observers");
    assert.strictEqual(exited.paneId, "p1");
  });

  it("dedupes: a second identical error chunk does not re-emit the transition", () => {
    const frames: any[] = [];
    const { manager } = makeFakeManager("Running");
    const { onOutput } = attachObserve(manager, makeDeps((msg) => frames.push(msg)));

    onOutput("p1", "Error: boom\n");
    onOutput("p1", "Error: boom again\n");

    const transitions = frames.filter((f) => f.type === "pane_transition");
    assert.strictEqual(
      transitions.length,
      1,
      "the lastStates edge-dedup fires the transition exactly once per genuine edge"
    );
  });
});
