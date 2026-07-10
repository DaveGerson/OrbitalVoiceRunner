// tests/test_exchange_observation.ts
//
// AgentExchange spine — Phase 4, Step 4.1: exchange-aware OBSERVATION completion semantics,
// exercised through the REAL src/observe/index.ts pipeline (not just the pure ExchangeService),
// with the exchange spine and result-envelope flags genuinely ACTIVE.
//
// JANUS_EXCHANGE_SPINE / JANUS_AGENT_RESULT_ENVELOPE must be set BEFORE the first import of
// anything touching src/exchanges/flag.ts / src/exchanges/resultEnvelope.ts in THIS process — both
// cache their mode at module load (the established env-flag idiom). `node --test` runs each test
// FILE as its own process (see tests/test_exchange_recovery.ts's identical note for its real-boot
// suite), so this cannot leak into any sibling test file. Every module that needs to see the flags
// active is therefore imported DYNAMICALLY, inside `before()`, after `process.env` is set.
//
// Covers: each terminal edge -> the correct exchange transition against the ACTIVE delivery
// marker; unrelated/unknown-pane edges are a no-op; idle-alone never means agent_complete (pinned);
// needs_input stays sticky under repeated idle (no flapping back); the legacy finalResponse
// heuristic is conservative (only a literal "done" final line, only when correlated to the active
// exchange); a matched result envelope settles complete/failed/needs_input (mid-run chunk pass AND
// idle-time definitive pass); needs_operator:true overrides a declared status; a live pane exit
// settles agent_failed (spec's pinned `exited` mapping) while a process-restart-style "pane exit"
// (the OTHER reading of the term) quarantines an uncertain in-flight exchange to `interrupted`.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import type { OrchestratorManager } from "../src/terminal";

// ── dynamic, flag-gated imports (see file header) ──────────────────────────────────────────────

let attachObserve: typeof import("../src/observe").attachObserve;
let legacyCompletionEligible: typeof import("../src/observe").legacyCompletionEligible;
let AnnouncementBus: typeof import("../src/announcementBus").AnnouncementBus;
let DEFAULT_ANNOUNCEMENT_TEMPLATES: typeof import("../src/announcementBus").DEFAULT_ANNOUNCEMENT_TEMPLATES;
let PaneSignalBus: typeof import("../src/paneSignalBus").PaneSignalBus;
let InteractionLogger: typeof import("../src/interactionLog").InteractionLogger;
let ExchangeService: typeof import("../src/exchanges/service").ExchangeService;
let getExchangeService: typeof import("../src/exchanges/spine").getExchangeService;
let resetExchangeServiceForTests: typeof import("../src/exchanges/spine").resetExchangeServiceForTests;
let JanusStore: typeof import("../src/store/sqliteStore").JanusStore;

const prevEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  prevEnv[k] = process.env[k];
  process.env[k] = v;
}

before(async () => {
  setEnv("JANUS_EXCHANGE_SPINE", "shadow"); // active (writes), not authoritative — sufficient here.
  setEnv("JANUS_AGENT_RESULT_ENVELOPE", "accept");

  ({ attachObserve, legacyCompletionEligible } = await import("../src/observe"));
  ({ AnnouncementBus, DEFAULT_ANNOUNCEMENT_TEMPLATES } = await import("../src/announcementBus"));
  ({ PaneSignalBus } = await import("../src/paneSignalBus"));
  ({ InteractionLogger } = await import("../src/interactionLog"));
  ({ ExchangeService } = await import("../src/exchanges/service"));
  ({ getExchangeService, resetExchangeServiceForTests } = await import("../src/exchanges/spine"));
  ({ JanusStore } = await import("../src/store/sqliteStore"));
});

after(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ── harness (mirrors tests/test_observe_complexity_refactor.ts's fixture idiom) ────────────────

type FakeOpts = { status?: string; runtimeType?: string; lastCommand?: string };

function makeManager(id: string, opts: FakeOpts = {}) {
  const attentionQueue: any[] = [];
  const manager = {
    terminals: { [id]: { status: opts.status ?? "Running", runtimeType: opts.runtimeType ?? "shell", lastCommand: opts.lastCommand ?? "" } },
    attentionQueue,
    settings: { secrets: {} },
    ledger: {
      watchRules: [] as any[],
      plans: [] as any[],
      activeProjectId: "proj_test",
      save: () => {},
    },
  } as unknown as OrchestratorManager;
  return { manager, attentionQueue };
}

type HistoryEntry = { command: string; timestamp: string; output: string; finalResponse?: string };

function makeDeps(frames: any[], entries: HistoryEntry[] = []) {
  let current = entries;
  return {
    broadcast: (m: any) => frames.push(m),
    announcementBus: new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES }),
    paneSignalBus: new PaneSignalBus(0),
    pruneAttention: () => {},
    interactionLog: new InteractionLogger({ sink: () => {} }),
    getLastInteractionId: () => null,
    redact: (s: string) => s,
    historyManager: {
      loadHistory: () => current,
      saveHistory: (_id: string, hist: HistoryEntry[]) => { current = hist; },
      appendOutputToLastCommand: () => {},
    },
    ai: {} as any,
  };
}

/** Deliver a fresh exchange onto `paneId` via the REAL process-wide singleton (the same one
 *  observe/index.ts's `getExchangeService()` calls resolve to) — mirrors the identical helper in
 *  tests/test_exchange_correlation.ts and tests/test_agent_result_envelope.ts. */
function deliverExchange(paneId: string, instruction = "run tests"): string {
  const svc = getExchangeService();
  const snap = svc.createExchange({
    projectId: "proj-1", paneId,
    operatorUtterance: `please ${instruction}`, distilledInstruction: instruction,
  });
  assert.ok(svc.stageForDelivery(snap.exchangeId).ok);
  assert.ok(svc.recordDelivery(snap.exchangeId).ok);
  return snap.exchangeId;
}

function stateOf(id: string): string | undefined {
  return getExchangeService().get(id)?.state;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. Each terminal edge settles the ACTIVE exchange to the correct state.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("exchange observation: terminal edges -> correct transitions (active marker)", () => {
  it("onRunning: delivered -> running", () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    const { manager } = makeManager("p1", { status: "Running" });
    const { onRunning } = attachObserve(manager, makeDeps([]));
    onRunning("p1");
    assert.equal(stateOf(id), "running");
  });

  it("onOutput classifying 'error' -> agent_failed", () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    const { manager } = makeManager("p1", { status: "Running" });
    const { onOutput } = attachObserve(manager, makeDeps([]));
    onOutput("p1", "Error: something exploded\n");
    assert.equal(stateOf(id), "agent_failed");
  });

  it("onOutput classifying an Idle shell prompt -> needs_input, with the detected question text attached", () => {
    resetExchangeServiceForTests();
    const store = new JanusStore(":memory:");
    store.init();
    getExchangeService().attachStore(store);
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });

    const { manager } = makeManager("p1", { status: "Idle", runtimeType: "shell" });
    const { onOutput } = attachObserve(manager, makeDeps([]));
    onOutput("p1", "root@host:~$ ");

    assert.equal(stateOf(id), "needs_input");
    const events = store.listExchangeEvents(id);
    const needsInput = events.find((e) => e.event_type === "needs_input_detected");
    assert.ok(needsInput, "a needs_input_detected event is recorded");
    const payload = JSON.parse(needsInput!.payload_redacted_json);
    assert.equal(payload.detail, "root@host:~$", "the redacted+capped question text is attached");
    store.close();
  });

  it("onIdle: running -> terminal_idle (the genuine completion edge)", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const { onIdle } = attachObserve(manager, makeDeps([], [{ command: "npm test", timestamp: "t", output: "" }]));
    await onIdle("p1");
    assert.equal(stateOf(id), "terminal_idle");
  });

  it("onExit (live PTY death): the pinned exited -> agent_failed mapping (spec §1.4's 'exited' edge — the LIVE-pane reading of 'pane exit' in the return-channel vocabulary)", () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1", { status: "Exited" });
    const { onExit } = attachObserve(manager, makeDeps([]));
    onExit("p1");
    assert.equal(stateOf(id), "agent_failed");
  });

  it("a PROCESS-RESTART-style 'pane exit' (the other reading of the term) quarantines an uncertain in-flight exchange to interrupted", () => {
    // This is NOT the live onExit signal above (that settles agent_failed, pinned by spec §1.4 and
    // tests/test_exchange_correlation.ts). It's the OTHER thing "pane exit" can mean in the
    // broader return-channel vocabulary: the SERVER process boundary — panes boot INERT (CLAUDE.md),
    // so every previously-running PTY is simply gone on restart, and recoverOnBoot's quarantine
    // (spec §4) is the exchange-spine's answer to "the pane exited from under an in-flight
    // exchange without ever reporting an outcome". Exercised directly against the service, since
    // it is boot-time behavior, not an observe/index.ts pane-signal edge.
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const out = getExchangeService().recoverOnBoot();
    assert.ok(out.interrupted.includes(id));
    assert.equal(stateOf(id), "interrupted");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. Unrelated / unknown pane edges are a no-op.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("exchange observation: unrelated/unknown pane edges do nothing", () => {
  it("output on an UNRELATED pane never touches p1's active exchange", () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p2", { status: "Running" });
    // p1 also needs to exist structurally for attachObserve's onOutput guard on p2 alone; p2 is
    // the pane actually driven here.
    (manager.terminals as any).p1 = { status: "Running", runtimeType: "shell", lastCommand: "" };
    const { onOutput } = attachObserve(manager, makeDeps([]));
    onOutput("p2", "Error: boom on the wrong pane\n");
    assert.equal(stateOf(id), "running", "p1's exchange is untouched by p2's edge");
  });

  it("onIdle on a pane with no delivered exchange at all is a harmless no-op", async () => {
    resetExchangeServiceForTests();
    const { manager } = makeManager("p-ghost");
    const { onIdle } = attachObserve(manager, makeDeps([], [{ command: "x", timestamp: "t", output: "" }]));
    await onIdle("p-ghost"); // must not throw
    assert.equal(getExchangeService().activeExchangeForPane("p-ghost"), undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. idle != complete (pinned), needs_input stickiness (no flapping back).
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("exchange observation: idle never means completion; needs_input is sticky", () => {
  it("a plain idle edge with an ordinary summary NEVER settles agent_complete", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const entries: HistoryEntry[] = [{ command: "npm test", timestamp: "t", output: "", finalResponse: "142 passing (3.2s)" }];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "terminal_idle", "idle alone is NEVER agent_complete");
  });

  it("needs_input stays sticky under REPEATED idle edges (no flapping back to terminal_idle)", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "prompt", detail: "continue? y/n" });
    assert.equal(stateOf(id), "needs_input");

    const { manager } = makeManager("p1");
    const entries: HistoryEntry[] = [{ command: "npm test", timestamp: "t", output: "", finalResponse: "still waiting" }];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "needs_input", "first repeated idle: still sticky");
    await onIdle("p1");
    await onIdle("p1");
    assert.equal(stateOf(id), "needs_input", "further repeats: still sticky, never flaps to terminal_idle");

    // The only way off needs_input via observation is a genuine 'running' edge.
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    assert.equal(stateOf(id), "running");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. The conservative legacy finalResponse heuristic.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("exchange observation: legacy finalResponse heuristic (conservative)", () => {
  it("a literal final 'Done: ...' line settles agent_complete, correlated to the active exchange", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    // Real agent output behind the report (4.5 review fix: the heuristic requires non-empty real
    // output — a done-line with NOTHING behind it never settles; see the hazard battery below).
    const entries: HistoryEntry[] = [{ command: "npm test", timestamp: "t", output: "142 passing\nall suites green\n", finalResponse: "Done: build succeeded." }];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "agent_complete");
    assert.equal(getExchangeService().get(id)!.resultSummary, "Done: build succeeded.");
  });

  it("a 'done' mid-sentence (not a final line) does NOT trigger completion", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    // Real output present, so the 4.5 non-empty-output guard is NOT what blocks this — the
    // line-shape rule itself is what's under test here.
    const entries: HistoryEntry[] = [{ command: "npm test", timestamp: "t", output: "running suite 2 of 5\n", finalResponse: "not done yet, still 3 tests to go" }];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "terminal_idle", "a loose mention of 'done' must not complete the exchange");
  });

  it("with NO active exchange on the pane, a 'Done' line is a harmless no-op (never adopted)", async () => {
    resetExchangeServiceForTests();
    const { manager } = makeManager("p-ghost");
    const entries: HistoryEntry[] = [{ command: "npm test", timestamp: "t", output: "", finalResponse: "Done: whatever." }];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p-ghost"); // must not throw
    assert.equal(getExchangeService().activeExchangeForPane("p-ghost"), undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4b. Phase 4.5 (adversarial review) — the idle-summary hazard: computeIdleSummary's synthesized
// fallbacks ("finished", "`<command>` finished") match LEGACY_DONE_LINE_RE, and pre-fix could
// settle agent_complete with ZERO real agent output. legacyCompletionEligible now requires real
// output, an at-rest exchange, an agent-authored line, and never the instruction's own PTY echo.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("exchange observation: idle-summary hazard — synthesized/echoed text never settles (4.5 review)", () => {
  it("EMPTY history at idle (the bare synthesized 'finished' summary) never settles agent_complete", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const { onIdle } = attachObserve(manager, makeDeps([], [])); // no history entries at all
    await onIdle("p1");
    assert.equal(stateOf(id), "terminal_idle", "the synthesized 'finished' fallback must never read as a completion report");
  });

  it("the synthesized '<command> finished' fallback for an instruction STARTING with a completion token never settles", async () => {
    // Instruction "complete the deploy" + empty output + no finalResponse -> computeIdleSummary
    // synthesizes "complete the deploy finished", which matches the done-line prefix. Pre-fix
    // this settled agent_complete off Orbital's OWN synthesized string with zero real output.
    resetExchangeServiceForTests();
    const id = deliverExchange("p1", "complete the deploy");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const entries: HistoryEntry[] = [{ command: "complete the deploy", timestamp: "t", output: "" }];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "terminal_idle");
  });

  it("the pane's ECHO of the delivered instruction (echo-only output) never settles", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1", "complete the deploy");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const entries: HistoryEntry[] = [
      { command: "complete the deploy", timestamp: "t", output: "complete the deploy\n", finalResponse: "no summary available" },
    ];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "terminal_idle", "the instruction's own echo must never settle the exchange it delivered");
  });

  it("...but a REAL agent done-line after the echo still settles (the echo guard never overblocks)", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1", "complete the deploy");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const entries: HistoryEntry[] = [
      { command: "complete the deploy", timestamp: "t", output: "complete the deploy\nDeploying...\nDone.\n", finalResponse: "deploy went out" },
    ];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "agent_complete");
    assert.equal(getExchangeService().get(id)!.resultSummary, "deploy went out");
  });

  it("a completion token followed by failure language ('Completed with errors.') never settles", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1", "run the build");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const entries: HistoryEntry[] = [
      { command: "run the build", timestamp: "t", output: "building...\nCompleted with errors.\n", finalResponse: "build had problems" },
    ];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "terminal_idle", "a self-contradicting 'completion' line must never present as success");
  });

  it("legacyCompletionEligible (pure): refuses a non-at-rest exchange — a pane that RESUMED during the async summary's await gap", () => {
    const base = { command: "npm test", output: "Done.", finalResponse: "" };
    assert.equal(legacyCompletionEligible({ ...base, exchangeState: "running" }), false, "resumed mid-await -> the idle behind this summary is stale");
    assert.equal(legacyCompletionEligible({ ...base, exchangeState: "delivered" }), false);
    assert.equal(legacyCompletionEligible({ ...base, exchangeState: undefined }), false);
    assert.equal(legacyCompletionEligible({ ...base, exchangeState: "terminal_idle" }), true);
    assert.equal(legacyCompletionEligible({ ...base, exchangeState: "needs_input" }), true, "an explicit final done-line is the stronger evidence the stickiness guard reserves room for");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. Result-envelope integration at the observation seam (mid-run chunk pass + idle-time pass).
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("exchange observation: result envelope integration", () => {
  it("mid-run chunk pass: a matched 'failed' envelope settles agent_failed immediately (no idle needed)", () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1", { status: "Running" });
    const { onOutput } = attachObserve(manager, makeDeps([]));
    const chunk = `still running...\n${JSON.stringify({ exchange_id: id, status: "failed", summary: "build broke" })}\nmore output\n`;
    onOutput("p1", chunk);
    assert.equal(stateOf(id), "agent_failed");
  });

  it("mid-run chunk pass: needs_operator:true overrides a 'complete' status -> needs_input, not agent_complete", () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1", { status: "Running" });
    const { onOutput } = attachObserve(manager, makeDeps([]));
    const chunk = JSON.stringify({ exchange_id: id, status: "complete", summary: "mostly done", needs_operator: true });
    onOutput("p1", chunk);
    assert.equal(stateOf(id), "needs_input", "needs_operator:true always wins over a declared 'complete' status");
  });

  it("mid-run chunk pass: a bare 'complete' envelope (no needs_operator) is DEFERRED — the pane must actually go idle first", () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1", { status: "Running" });
    const { onOutput } = attachObserve(manager, makeDeps([]));
    onOutput("p1", JSON.stringify({ exchange_id: id, status: "complete", summary: "done already?" }));
    assert.equal(stateOf(id), "running", "a self-reported 'complete' alone must not settle without idle corroboration");
  });

  it("idle-time pass: the deferred 'complete' envelope settles once the terminal genuinely goes idle", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const envelopeText = JSON.stringify({ exchange_id: id, status: "complete", summary: "all green" });
    const entries: HistoryEntry[] = [{ command: "npm test", timestamp: "t", output: `142 passing\n${envelopeText}\n` }];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "agent_complete");
    assert.equal(getExchangeService().get(id)!.resultSummary, "all green");
  });

  it("idle-time pass: a MISMATCHED exchange_id in the accumulated output is ignored, falling back to terminal_idle", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const envelopeText = JSON.stringify({ exchange_id: "exch_someone_else", status: "complete", summary: "not for you" });
    const entries: HistoryEntry[] = [{ command: "npm test", timestamp: "t", output: envelopeText }];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    assert.equal(stateOf(id), "terminal_idle", "an uncorrelated envelope must never settle this exchange");
  });

  it("the envelope's redacted result_envelope_json is persisted on the exchange row", async () => {
    resetExchangeServiceForTests();
    const store = new JanusStore(":memory:");
    store.init();
    getExchangeService().attachStore(store);
    const id = deliverExchange("p1");
    getExchangeService().onPaneSignal({ paneId: "p1", kind: "running" });
    const { manager } = makeManager("p1");
    const envelopeText = JSON.stringify({ exchange_id: id, status: "complete", summary: "all green" });
    const entries: HistoryEntry[] = [{ command: "npm test", timestamp: "t", output: envelopeText }];
    const { onIdle } = attachObserve(manager, makeDeps([], entries));
    await onIdle("p1");
    const row = store.getExchange(id)!;
    assert.equal(row.state, "agent_complete");
    assert.ok(row.result_envelope_json, "the row carries the redacted envelope JSON");
    const parsed = JSON.parse(row.result_envelope_json!);
    assert.equal(parsed.exchange_id, id);
    assert.equal(parsed.status, "complete");
    store.close();
  });
});
