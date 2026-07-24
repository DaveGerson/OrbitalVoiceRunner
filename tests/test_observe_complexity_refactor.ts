// tests/test_observe_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-complexity
// burndown refactor of src/observe/index.ts (the PTY OBSERVATION / TRIGGER pipeline). These pin the
// CURRENT observable behaviour — the transition CLASSIFICATION ladder, the lastStates edge-dedup, the
// watch-rule / plan-step trigger side effects, and the onIdle/onOutput broadcast surface — so the
// behaviour-preserving refactor (extract the keyword-classifier, the high-severity attention emitter,
// the plan-advance vs plan-fail arms, the per-step onOutput guards) changes nothing observable.
//
// Written to be GREEN against the UNREFACTORED code FIRST (per D-6). The module is purely observation
// + notification (NO pane writes, NO capability gate — the cleanest carve), so a fake manager + fake
// sinks fully exercise it. This file deliberately leans on the EDGE branches the existing 18 observe
// suites leave thin: the build-failed-vs-error keyword PRECEDENCE, the shell-prompt refinement of an
// Idle pane, the Exited short-circuit, the plan-step advance/complete/fail ladder, and the per-step
// try/catch isolation in onOutput.
//
// Runner: npx tsx --test --test-force-exit tests/test_observe_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { attachObserve } from "../src/observe";
import { AnnouncementBus, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "../src/announcementBus";
import { PaneSignalBus } from "../src/paneSignalBus";
import { InteractionLogger } from "../src/interactionLog";
import type { OrchestratorManager } from "../src/terminal";

// ─────────────────────────────────────────────────────────────────────────────
// Harness — a structural manager + recording sinks. lastStates lives inside attachObserve, so each
// test gets a FRESH pipeline (its own dedup memory) by calling attachObserve per test.
// ─────────────────────────────────────────────────────────────────────────────
type FakeOpts = {
  status?: string;
  runtimeType?: string;
  lastCommand?: string;
  watchRules?: any[];
  plans?: any[];
};
function makeManager(opts: FakeOpts = {}) {
  const attentionQueue: any[] = [];
  const saved: boolean[] = [];
  const manager = {
    terminals: { p1: { status: opts.status ?? "Running", runtimeType: opts.runtimeType ?? "shell", lastCommand: opts.lastCommand ?? "" } },
    attentionQueue,
    // W5: the observe push sites route through manager.pushAttention now; the structural double
    // mirrors the real in-memory append so the existing attentionQueue assertions still hold.
    pushAttention: (item: any) => attentionQueue.push(item),
    settings: { secrets: {} },
    ledger: {
      watchRules: opts.watchRules ?? [],
      plans: opts.plans ?? [],
      activeProjectId: "proj_test",
      save: (force?: boolean) => { saved.push(force === true); },
    },
  } as unknown as OrchestratorManager;
  return { manager, attentionQueue, saved };
}

function makeDeps(frames: any[], extra: Partial<any> = {}) {
  return {
    broadcast: (m: any) => frames.push(m),
    announcementBus: new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES }),
    paneSignalBus: new PaneSignalBus(0),
    pruneAttention: () => {},
    interactionLog: new InteractionLogger({ sink: () => {} }),
    getLastInteractionId: () => null,
    setLastInteractionId: (_v: string | null) => {},
    redact: (s: string) => s,
    historyManager: { loadHistory: () => [], saveHistory: () => {}, appendOutputToLastCommand: () => {} },
    ai: {} as any,
    ...extra,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. detectAndTriggerTransitions (CC29) — the classification ladder + edge-dedup.
// ═════════════════════════════════════════════════════════════════════════════
describe("observe refactor — transition classification ladder", () => {
  function transitionFor(opts: FakeOpts, chunk: string): string | undefined {
    const frames: any[] = [];
    const { manager } = makeManager(opts);
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", chunk);
    return frames.find((f) => f.type === "pane_transition")?.transition;
  }

  it("Exited status SHORT-CIRCUITS to 'exited' regardless of chunk content", () => {
    assert.strictEqual(transitionFor({ status: "Exited" }, "Error: ignored because exited\n"), "exited");
  });

  it("build-failed keyword family (lowercased) -> 'build-failed'", () => {
    for (const c of [
      "Failed to compile", "Build failed", "ModuleNotFoundError: x", "compile error here",
      "npm ERR! something", "Failed to build", "Error: command failed", "Error: not found",
    ]) {
      assert.strictEqual(transitionFor({ status: "Running" }, c + "\n"), "build-failed", `"${c}"`);
    }
  });

  it("build-failed takes PRECEDENCE over the error family when both could match", () => {
    // "npm ERR!" (build-failed family) co-occurs with "Error:" (error family); build-failed wins
    // because it is checked first in the ladder.
    assert.strictEqual(transitionFor({ status: "Running" }, "npm ERR! Error: boom\n"), "build-failed");
  });

  it("error family (case-sensitive markers + lowercased traceback/fatal) -> 'error'", () => {
    for (const c of ["Error: boom", "Exception: x", "Stderr: y", "Traceback (most recent call last)", "fatal: not a git repo"]) {
      assert.strictEqual(transitionFor({ status: "Running" }, c + "\n"), "error", `"${c}"`);
    }
  });

  it("a Running pane with benign output produces NO transition", () => {
    assert.strictEqual(transitionFor({ status: "Running" }, "all good, tests passing\n"), undefined);
  });

  it("an Idle SHELL pane whose tail looks like a prompt -> 'prompt'", () => {
    assert.strictEqual(transitionFor({ status: "Idle", runtimeType: "shell" }, "user@host:~/proj$ "), "prompt");
  });

  it("an Idle SHELL pane with non-prompt output -> 'idle'", () => {
    assert.strictEqual(transitionFor({ status: "Idle", runtimeType: "shell" }, "some lingering line\n"), "idle");
  });

  it("an Idle NON-shell (interactive_cli) pane never refines to 'prompt' -> 'idle'", () => {
    assert.strictEqual(transitionFor({ status: "Idle", runtimeType: "interactive_cli" }, "> "), "idle");
  });

  it("lastStates edge-dedup: a second identical-class chunk does NOT re-emit the transition", () => {
    const frames: any[] = [];
    const { manager } = makeManager({ status: "Running" });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "Error: boom\n");
    onOutput("p1", "Error: boom again\n");
    assert.strictEqual(frames.filter((f) => f.type === "pane_transition").length, 1);
  });

  it("a high-severity transition pushes an attention item + attention_updated; 'exited' also publishes the voice signal", () => {
    const frames: any[] = [];
    const signals: any[] = [];
    const { manager, attentionQueue } = makeManager({ status: "Exited" });
    const deps = makeDeps(frames);
    deps.paneSignalBus.subscribe((s: any) => signals.push(s));
    const { onOutput } = attachObserve(manager, deps);
    onOutput("p1", "process ended\n");
    assert.strictEqual(attentionQueue.length, 1, "one attention item pushed");
    assert.strictEqual(attentionQueue[0].type, "exited");
    assert.ok(frames.some((f) => f.type === "attention_updated"));
    assert.ok(signals.some((s) => s.kind === "exited"), "exited publishes to the voice lane");
  });

  it("an unknown pane id is a silent no-op (no frames)", () => {
    const frames: any[] = [];
    const { manager } = makeManager({ status: "Running" });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("ghost", "Error: boom\n");
    assert.strictEqual(frames.filter((f) => f.type === "pane_transition").length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. handlePlansTrigger (CC14) — step advance / plan complete / step fail.
//    Driven via the onOutput->detectAndTriggerTransitions edge that calls it.
// ═════════════════════════════════════════════════════════════════════════════
describe("observe refactor — handlePlansTrigger arms", () => {
  function planWith(steps: any[], currentStepIndex = 0) {
    return { id: "plan1", name: "Deploy", status: "running", currentStepIndex, steps };
  }

  it("step matches its expectedTransition with a NEXT step -> advance: mark completed, pause, suggest next, save", () => {
    const frames: any[] = [];
    const plan = planWith([
      { id: "s0", status: "running", terminalId: "p1", expectedTransition: "exited", command: "build" },
      { id: "s1", status: "pending", terminalId: "p1", command: "deploy" },
    ]);
    const { manager, saved } = makeManager({ status: "Exited", plans: [plan] });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "done\n"); // Exited -> "exited" == s0.expectedTransition

    assert.strictEqual(plan.steps[0].status, "completed", "matched step completed");
    assert.strictEqual(plan.currentStepIndex, 1, "advanced to the next step");
    assert.strictEqual(plan.steps[1].status, "pending", "next step set pending");
    assert.strictEqual(plan.status, "paused", "plan paused awaiting the operator");
    assert.ok(frames.some((f) => f.type === "plan_step_completed" && f.planId === "plan1"));
    assert.ok(manager.attentionQueue.some((a: any) => a.details?.kind === "plan_step_suggestion"));
    assert.deepStrictEqual(saved, [true], "force-persist fired once for the plan change");
  });

  it("step matches expectedTransition and is the LAST step -> plan completed", () => {
    const frames: any[] = [];
    const plan = planWith([{ id: "s0", status: "running", terminalId: "p1", expectedTransition: "exited", command: "build" }]);
    const { manager } = makeManager({ status: "Exited", plans: [plan] });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "done\n");
    assert.strictEqual(plan.status, "completed");
    assert.ok(frames.some((f) => f.type === "plan_completed" && f.planId === "plan1"));
  });

  it("a FAILURE transition (error/build-failed/exited) on the running step -> step failed, plan paused", () => {
    const frames: any[] = [];
    // expectedTransition is "idle" so the "error" edge does NOT match the advance arm; it takes the fail arm.
    const plan = planWith([{ id: "s0", status: "running", terminalId: "p1", expectedTransition: "idle", command: "build" }]);
    const { manager } = makeManager({ status: "Running", plans: [plan] });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "Error: boom\n"); // -> "error"
    assert.strictEqual(plan.steps[0].status, "failed");
    assert.strictEqual(plan.status, "paused");
    assert.ok(manager.attentionQueue.some((a: any) => a.type === "build-failed"));
    assert.ok(frames.some((f) => f.type === "plan_paused"));
  });

  it("a non-running plan is untouched", () => {
    const frames: any[] = [];
    const plan = { id: "p", name: "X", status: "completed", currentStepIndex: 0, steps: [{ id: "s0", status: "running", terminalId: "p1", expectedTransition: "exited" }] };
    const { manager } = makeManager({ status: "Exited", plans: [plan] });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "done\n");
    assert.strictEqual(plan.steps[0].status, "running", "completed plan's step is not mutated");
  });

  it("a step on a DIFFERENT terminal is not advanced by this pane's edge", () => {
    const frames: any[] = [];
    const plan = planWith([{ id: "s0", status: "running", terminalId: "OTHER", expectedTransition: "exited", command: "build" }]);
    const { manager } = makeManager({ status: "Exited", plans: [plan] });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "done\n");
    assert.strictEqual(plan.steps[0].status, "running", "a step bound to another terminal is untouched");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. handleWatchRulesTrigger — surfaced via the same transition edge (rides nearby in CC budget).
// ═════════════════════════════════════════════════════════════════════════════
describe("observe refactor — handleWatchRulesTrigger", () => {
  it("a matching enabled rule SURFACES a suggestion (never writes) + watch_rule_suggested frame", () => {
    const frames: any[] = [];
    const rule = { id: "r1", enabled: true, triggerTerminalId: "p1", triggerTransition: "error", actionCommand: "npm test", actionTerminalId: "p2", oneShot: false };
    const { manager } = makeManager({ status: "Running", watchRules: [rule] });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "Error: boom\n");
    assert.ok(manager.attentionQueue.some((a: any) => a.details?.kind === "watch_rule_suggestion" && a.details.ruleId === "r1"));
    assert.ok(frames.some((f) => f.type === "watch_rule_suggested" && f.ruleId === "r1"));
  });

  it("a oneShot rule disables itself and force-persists the watchRules change (wsm-e2e-pinned-33c.4: no watch_rules_updated frame — no client consumes it)", () => {
    const frames: any[] = [];
    const rule = { id: "r1", enabled: true, triggerTerminalId: "p1", triggerTransition: "error", actionCommand: "x", actionTerminalId: "p2", oneShot: true };
    const { manager, saved } = makeManager({ status: "Running", watchRules: [rule] });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "Error: boom\n");
    assert.strictEqual(rule.enabled, false, "oneShot rule disabled after firing");
    assert.deepStrictEqual(saved, [true], "force-persist fired for the rule change");
    assert.ok(!frames.some((f) => f.type === "watch_rules_updated"), "watch_rules_updated broadcast is PRUNED");
  });

  it("a rule whose transition does NOT match is left alone (no suggestion)", () => {
    const frames: any[] = [];
    const rule = { id: "r1", enabled: true, triggerTerminalId: "p1", triggerTransition: "idle", actionCommand: "x", actionTerminalId: "p2", oneShot: false };
    const { manager } = makeManager({ status: "Running", watchRules: [rule] });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "Error: boom\n"); // -> "error", not "idle"
    assert.ok(!manager.attentionQueue.some((a: any) => a.details?.kind === "watch_rule_suggestion"));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. onIdle (CC12) + onOutput (CC11) — the completion edge + the buffering tail.
// ═════════════════════════════════════════════════════════════════════════════
describe("observe refactor — onIdle completion edge", () => {
  it("onIdle on a known pane with NO history -> announces a 'finished' completion + idle signal", async () => {
    const frames: any[] = [];
    const signals: any[] = [];
    const announced: any[] = [];
    const { manager } = makeManager({ status: "Idle" });
    const deps = makeDeps(frames);
    deps.paneSignalBus.subscribe((s: any) => signals.push(s));
    (deps.announcementBus as any).enqueue = (a: any) => { announced.push(a); return true; };
    const { onIdle } = attachObserve(manager, deps);
    await onIdle("p1");
    assert.ok(announced.some((a) => a.kind === "completion" && a.terminalId === "p1"), "completion enqueued");
    assert.ok(signals.some((s) => s.kind === "idle" && s.paneId === "p1"), "idle pane signal published");
  });

  it("onIdle uses an existing redacted finalResponse as the summary (no re-summarization)", async () => {
    const frames: any[] = [];
    const announced: any[] = [];
    const { manager } = makeManager({ status: "Idle" });
    const deps = makeDeps(frames, {
      historyManager: {
        loadHistory: () => [{ command: "npm test", timestamp: "t", output: "x", finalResponse: "All 12 tests passed." }],
        saveHistory: () => {},
        appendOutputToLastCommand: () => {},
      },
    });
    (deps.announcementBus as any).enqueue = (a: any) => { announced.push(a); return true; };
    const { onIdle } = attachObserve(manager, deps);
    await onIdle("p1");
    assert.ok(announced.some((a) => a.summary === "All 12 tests passed."), "reuses the existing finalResponse");
  });

  it("onIdle on an UNKNOWN pane is a no-op (no announcement)", async () => {
    const frames: any[] = [];
    const announced: any[] = [];
    const { manager } = makeManager({ status: "Idle" });
    const deps = makeDeps(frames);
    (deps.announcementBus as any).enqueue = (a: any) => { announced.push(a); return true; };
    const { onIdle } = attachObserve(manager, deps);
    await onIdle("ghost");
    assert.strictEqual(announced.length, 0);
  });

  it("onBreadcrumb (when wired) drops a redacted 'finished' one-liner on the idle edge", async () => {
    const crumbs: any[] = [];
    const frames: any[] = [];
    const { manager } = makeManager({ status: "Idle" });
    const deps = makeDeps(frames, { onBreadcrumb: (b: any) => crumbs.push(b) });
    const { onIdle } = attachObserve(manager, deps);
    await onIdle("p1");
    assert.ok(crumbs.some((c) => c.paneId === "p1" && /finished/.test(c.text)));
  });
});

describe("observe refactor — onOutput buffering + per-step isolation", () => {
  it("onOutput buffers the chunk and flushes a stdout_chunk after the 30ms coalesce window", async () => {
    const frames: any[] = [];
    const { manager } = makeManager({ status: "Running" });
    const { onOutput } = attachObserve(manager, makeDeps(frames));
    onOutput("p1", "hello ");
    onOutput("p1", "world\n");
    await new Promise((r) => setTimeout(r, 45));
    const flush = frames.find((f) => f.type === "stdout_chunk" && f.terminalId === "p1");
    assert.ok(flush, "a coalesced stdout_chunk is broadcast");
    assert.strictEqual(flush.chunk, "hello world\n", "chunks are concatenated in order");
  });

  it("a throw from the history step does NOT blind the buffering tail (per-step try/catch net)", async () => {
    const frames: any[] = [];
    const { manager } = makeManager({ status: "Running" });
    const deps = makeDeps(frames, {
      historyManager: {
        loadHistory: () => [],
        saveHistory: () => {},
        appendOutputToLastCommand: () => { throw new Error("history boom"); },
      },
    });
    const { onOutput } = attachObserve(manager, deps);
    assert.doesNotThrow(() => onOutput("p1", "still buffered\n"));
    await new Promise((r) => setTimeout(r, 45));
    assert.ok(frames.some((f) => f.type === "stdout_chunk" && f.chunk === "still buffered\n"),
      "the buffering/broadcast tail still runs after a failing observation step");
  });
});
