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
function makeFakeManager(termStatus: string): { manager: OrchestratorManager; attentionQueue: any[] } {
  const attentionQueue: any[] = [];
  const manager = {
    terminals: {
      p1: { status: termStatus, runtimeType: "shell" },
    },
    attentionQueue,
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
