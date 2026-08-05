// tests/test_completion_failed_earcon.ts
//
// WS1 (fikj.7?/voice-followups): a run that FAILS currently plays the SAME success chime as a
// clean pass — a pane that just blew up gets the identical "ta-da" tone (and the plain "completion"
// notification bucket) as a genuinely finished pane. Fix: OUTCOME-KEYED completion announcements.
//
// REQUIRED (post-fix) behavior pinned here — all RED today:
//   1. src/announcementKinds.ts (the compiler-enforced single source of truth, KIND_META :67) gains
//      a new AnnouncementKind "completion_failed" with: a NEW distinct EarconType "failure",
//      severity "high" (the high-severity notification bucket is the VISUAL indicator), a priority
//      ranking ABOVE the approval kinds but BELOW error/build-failed/exited, and a new TemplateKey
//      "completionFailed" — plus its DEFAULT_ANNOUNCEMENT_TEMPLATES entry and its
//      ANNOUNCEMENT_TEMPLATE_FIELDS (Settings) row.
//   2. src/utils/earcon.ts's client tone vocabulary gains "failure": accepted by isEarconType, and a
//      TONE_TABLE entry that is ACOUSTICALLY DISTINCT from every existing tone (esp. alert's
//      440->330 and blocked's 330->220) — exercised indirectly through the real playEarcon (the
//      table itself is module-private) via a fake WebAudio surface that records the oscillator
//      frequencies actually scheduled.
//   3. src/observe/index.ts keys BOTH enqueue sites on the run's outcome:
//      (a) settleDispatchJoin — a settled dispatch-join group with any failed member (the "failed"
//          count already computed there) announces "completion_failed", not the plain "completion".
//      (b) onIdle — a genuine Running->Idle edge whose settled exchange outcome is agent_failed
//          announces "completion_failed"; a clean/complete outcome, an UNCORRELATED pane (no
//          delivered exchange at all), and an UNKNOWN outcome (still terminal_idle — neither
//          complete nor failed) all keep the plain "completion" announcement — the announcement
//          itself must NEVER be suppressed (design through-line: "told-more beats silently-missed").
//
// Runner: npx tsx --test --test-force-exit tests/test_completion_failed_earcon.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KIND_META,
  DEFAULT_ANNOUNCEMENT_TEMPLATES,
  ANNOUNCEMENT_TEMPLATE_FIELDS,
  templateFor,
  type AnnouncementKind,
} from "../src/announcementKinds";
import { isEarconType, playEarcon, type EarconType } from "../src/utils/earcon";
import { dispatchJoinTracker } from "../src/dispatch/joinTracker";
import type { OrchestratorManager } from "../src/terminal";

// ── dynamic, flag-gated imports ────────────────────────────────────────────────────────────────
// JANUS_EXCHANGE_SPINE must be set BEFORE the first import of anything touching src/exchanges/
// (it caches its mode at module load — see tests/test_exchange_observation.ts's identical note).
// `node --test` runs each test FILE as its own process, so this can't leak into a sibling file.
let attachObserve: typeof import("../src/observe").attachObserve;
let AnnouncementBus: typeof import("../src/announcementBus").AnnouncementBus;
let PaneSignalBus: typeof import("../src/paneSignalBus").PaneSignalBus;
let InteractionLogger: typeof import("../src/interactionLog").InteractionLogger;
let getExchangeService: typeof import("../src/exchanges/spine").getExchangeService;
let resetExchangeServiceForTests: typeof import("../src/exchanges/spine").resetExchangeServiceForTests;

const prevEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  prevEnv[k] = process.env[k];
  process.env[k] = v;
}

before(async () => {
  setEnv("JANUS_EXCHANGE_SPINE", "record"); // active (writes), sufficient for these settlement tests.
  ({ attachObserve } = await import("../src/observe"));
  ({ AnnouncementBus } = await import("../src/announcementBus"));
  ({ PaneSignalBus } = await import("../src/paneSignalBus"));
  ({ InteractionLogger } = await import("../src/interactionLog"));
  ({ getExchangeService, resetExchangeServiceForTests } = await import("../src/exchanges/spine"));
});

after(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. announcementKinds.ts — the new "completion_failed" kind's static shape.
// ═════════════════════════════════════════════════════════════════════════════════════════════

// "completion_failed" is not yet a member of the AnnouncementKind union, so KIND_META has no typed
// property for it — index through an any-cast (per the RED-phase convention: this is exactly the
// spot the implementer completes by adding the union member + KIND_META entry).
type LooseKindMeta = { earcon: string; severity: string; priority: number; templateKey: string } | undefined;
const anyKindMeta = KIND_META as unknown as Record<string, LooseKindMeta>;

describe("announcementKinds — new 'completion_failed' AnnouncementKind (WS1)", () => {
  it("KIND_META defines 'completion_failed'", () => {
    const meta = anyKindMeta["completion_failed"];
    assert.ok(meta, "a run that FAILED must not share the plain 'completion' kind — KIND_META needs a 'completion_failed' entry");
  });

  it("'completion_failed' carries a NEW distinct earcon 'failure' (never reusing an existing tone)", () => {
    const meta = anyKindMeta["completion_failed"];
    assert.ok(meta, "precondition: completion_failed must exist");
    assert.equal(meta!.earcon, "failure");
  });

  it("'completion_failed' is HIGH severity (the visual high-severity bucket the spec calls out)", () => {
    const meta = anyKindMeta["completion_failed"];
    assert.ok(meta, "precondition: completion_failed must exist");
    assert.equal(meta!.severity, "high");
  });

  it("'completion_failed' templateKey is 'completionFailed'", () => {
    const meta = anyKindMeta["completion_failed"];
    assert.ok(meta, "precondition: completion_failed must exist");
    assert.equal(meta!.templateKey, "completionFailed");
  });

  it("'completion_failed' priority ranks ABOVE the approval kinds but BELOW error/build-failed/exited", () => {
    const meta = anyKindMeta["completion_failed"];
    assert.ok(meta, "precondition: completion_failed must exist");
    const p = meta!.priority;
    assert.ok(p > KIND_META.approval_pending.priority, `completion_failed (${p}) must outrank approval_pending (${KIND_META.approval_pending.priority})`);
    assert.ok(p > KIND_META.approval_expired.priority, `completion_failed (${p}) must outrank approval_expired (${KIND_META.approval_expired.priority})`);
    assert.ok(p > KIND_META.plan_paused.priority, `completion_failed (${p}) must outrank plan_paused (${KIND_META.plan_paused.priority})`);
    assert.ok(p < KIND_META.exited.priority, `completion_failed (${p}) must rank BELOW exited (${KIND_META.exited.priority})`);
    assert.ok(p < KIND_META.error.priority, `completion_failed (${p}) must rank BELOW error (${KIND_META.error.priority})`);
    assert.ok(p < KIND_META["build-failed"].priority, `completion_failed (${p}) must rank BELOW build-failed (${KIND_META["build-failed"].priority})`);
  });

  it("'completion_failed' priority is still ABOVE the plain 'completion' kind (a failure must never rank below a plain finish)", () => {
    const meta = anyKindMeta["completion_failed"];
    assert.ok(meta, "precondition: completion_failed must exist");
    assert.ok(meta!.priority > KIND_META.completion.priority, `completion_failed (${meta!.priority}) must outrank plain completion (${KIND_META.completion.priority})`);
  });
});

describe("announcementKinds — the 'completionFailed' template surface (WS1)", () => {
  const anyDefaults = DEFAULT_ANNOUNCEMENT_TEMPLATES as unknown as Record<string, string | undefined>;

  it("DEFAULT_ANNOUNCEMENT_TEMPLATES has a failure-flavored 'completionFailed' default", () => {
    const tpl = anyDefaults["completionFailed"];
    assert.ok(tpl, "a default completionFailed template must exist");
    assert.match(tpl!, /\{pane\}/, "must interpolate the pane name");
    assert.match(tpl!, /\{summary\}/, "must interpolate the summary");
    assert.match(tpl!, /fail/i, "the default copy must read as a FAILURE, not a plain finish");
  });

  it("the 'completionFailed' default is NOT byte-identical to the plain 'completion' default", () => {
    const tpl = anyDefaults["completionFailed"];
    assert.ok(tpl, "precondition: completionFailed default must exist");
    assert.notEqual(tpl, DEFAULT_ANNOUNCEMENT_TEMPLATES.completion, "a failed run must read differently from a clean finish");
  });

  it("ANNOUNCEMENT_TEMPLATE_FIELDS (Settings surface) includes a 'completionFailed' row", () => {
    const row = (ANNOUNCEMENT_TEMPLATE_FIELDS as ReadonlyArray<readonly [string, string]>).find(([key]) => key === "completionFailed");
    assert.ok(row, "Settings must expose an editable field for the completionFailed template");
  });

  it("templateFor renders the completionFailed default for the new kind", () => {
    const meta = anyKindMeta["completion_failed"];
    assert.ok(meta, "precondition: completion_failed must exist in KIND_META before templateFor can resolve it");
    const rendered = templateFor("completion_failed" as AnnouncementKind, DEFAULT_ANNOUNCEMENT_TEMPLATES);
    assert.match(rendered, /fail/i, "the rendered default must read as a failure");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. src/utils/earcon.ts — the new "failure" tone vocabulary.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("src/utils/earcon.ts — 'failure' is a real EarconType (WS1)", () => {
  it("isEarconType accepts 'failure'", () => {
    assert.equal(isEarconType("failure"), true, "'failure' must be a real EarconType (a run that failed needs its own tone)");
  });

  it("still accepts every pre-existing earcon (additive — no regression)", () => {
    for (const t of ["completion", "alert", "success", "execute", "chime", "reconnect", "blocked", "permission", "note"]) {
      assert.equal(isEarconType(t), true, `${t} must still be accepted`);
    }
  });

  it("still rejects arbitrary strings and non-strings", () => {
    for (const v of ["bogus", "", "FAILURE", "failures", null, undefined, 3, {}]) {
      assert.equal(isEarconType(v), false, `${JSON.stringify(v)} must be rejected`);
    }
  });
});

// TONE_TABLE is module-private inside earcon.ts — the only production call site is playEarcon, so
// exercise the real table INDIRECTLY: install a fake WebAudio surface under `globalThis.window` and
// record the oscillator frequencies playEarcon actually schedules. This is the only runtime-checkable
// way to pin "a tone tuple acoustically DISTINCT from every existing entry" without exporting the
// private table (which would be a production-code change this RED-phase pass must not make).
interface FakeOscillator {
  type: string;
  frequency: { setValueAtTime: (freq: number, t: number) => void };
  connect: () => void;
  start: () => void;
  stop: () => void;
}

function captureTone(type: EarconType): number[] {
  const freqs: number[] = [];
  class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    createOscillator(): FakeOscillator {
      return {
        type: "",
        frequency: { setValueAtTime: (freq: number) => { freqs.push(freq); } },
        connect: () => {},
        start: () => {},
        stop: () => {},
      };
    }
    createGain() {
      return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} };
    }
    resume(): Promise<void> { return Promise.resolve(); }
    close(): void {}
  }
  const prevWindow = (globalThis as unknown as { window?: unknown }).window;
  (globalThis as unknown as { window: unknown }).window = { AudioContext: FakeAudioContext };
  try {
    playEarcon(type);
  } finally {
    if (prevWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
    else (globalThis as unknown as { window: unknown }).window = prevWindow;
  }
  return freqs;
}

describe("src/utils/earcon.ts — TONE_TABLE['failure'] is real and acoustically distinct (WS1)", () => {
  it("playEarcon('failure') actually schedules oscillator tone(s) — TONE_TABLE has a 'failure' entry", () => {
    const freqs = captureTone("failure" as EarconType);
    assert.ok(freqs.length > 0, "TONE_TABLE['failure'] must exist and produce at least one tone (playEarcon degrades silently when the entry is missing)");
  });

  it("the 'failure' tone's frequencies are DISTINCT from EVERY existing earcon (esp. alert 440->330 and blocked 330->220)", () => {
    const failure = captureTone("failure" as EarconType);
    assert.ok(failure.length > 0, "must have a real 'failure' tone to compare (see the previous test)");
    // Sanity-pin the two nearest neighbours the spec singles out (they are the documented tuples).
    assert.deepEqual(captureTone("alert"), [440, 330], "sanity: alert is the documented 440->330 falling tone");
    assert.deepEqual(captureTone("blocked"), [330, 220], "sanity: blocked is the documented 330->220 falling tone");
    // VERIFIER PATCH: the spec says distinct from EVERY existing entry, not just alert/blocked —
    // reusing e.g. completion's C5->G5 "ta-da" for the failure tone would be the EXACT bug this
    // workstream exists to kill (a failed run ringing the success chime) yet passed the original
    // alert/blocked-only comparison. Compare against every pre-existing tone.
    const existing: EarconType[] = ["completion", "alert", "success", "execute", "chime", "reconnect", "blocked", "permission", "note"];
    for (const t of existing) {
      assert.notDeepEqual(
        captureTone(t), failure,
        `'failure' must NOT reuse '${t}'s frequency tuple — the failure tone must be acoustically distinct from EVERY existing earcon`,
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2b. src/classic/hooks/useEarcons.ts — the CLASSIC client's oscillator player must also know
//     "failure". REVIEWER ATTACK: the classic playEarcon is an if/else-if chain (not the kitchen's
//     Record table), so a token with no branch falls through and plays NOTHING — the completion_failed
//     earcon would be a silent no-op in the classic UI, the exact forbidden silent-drop path
//     ("told-more beats silently-missed"; UX_BRIEF §4: eyes-off, a quiet state change is a bug).
//     BUG-018 precedent: blocked/permission each got a classic branch mirroring the kitchen tuple
//     ("so the two UIs sound the same"). The player is a React hook (useState-coupled), so this is
//     pinned by source inspection — the same content-anchored technique tests/test_answer_first_ordering.ts
//     already uses for closure-bound send sites.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("src/classic/hooks/useEarcons.ts — the classic player has a 'failure' branch mirroring the kitchen tone (WS1)", () => {
  const classicSource = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "classic", "hooks", "useEarcons.ts"),
    "utf8",
  );

  it("playEarcon handles type === 'failure' (no silent fall-through)", () => {
    assert.ok(
      /type === "failure"/.test(classicSource),
      "classic playEarcon must branch on 'failure' — without it the completion_failed earcon is a SILENT no-op in the classic UI",
    );
  });

  it("the classic 'failure' branch mirrors the kitchen tuple (D4 293.66 -> G3 196)", () => {
    assert.ok(
      classicSource.includes("293.66") && /\b196\b/.test(classicSource),
      "the classic failure tone must mirror src/utils/earcon.ts TONE_TABLE.failure (293.66 -> 196) so the two UIs sound the same (BUG-018 precedent)",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3a. src/observe/index.ts — settleDispatchJoin: a group with a FAILED member announces
//     completion_failed. Harness idiom lifted from tests/test_exchange_observation.ts /
//     tests/test_plan_parallel_group.ts.
// ═════════════════════════════════════════════════════════════════════════════════════════════

type HistoryEntry = { command: string; timestamp: string; output: string; finalResponse?: string };

function makeManager(paneIds: string[]): { manager: OrchestratorManager; attentionQueue: unknown[] } {
  const attentionQueue: unknown[] = [];
  const terminals: Record<string, unknown> = {};
  for (const id of paneIds) {
    terminals[id] = { status: "Running", runtimeType: "shell", lastCommand: "" };
  }
  const manager = {
    terminals,
    attentionQueue,
    pushAttention: (item: unknown) => attentionQueue.push(item),
    settings: { secrets: {} },
    ledger: {
      watchRules: [] as unknown[],
      plans: [] as unknown[],
      activeProjectId: "proj_test",
      save: () => {},
    },
  } as unknown as OrchestratorManager;
  return { manager, attentionQueue };
}

function makeDeps(bus: InstanceType<typeof AnnouncementBus>, entries: HistoryEntry[] = []) {
  let current = entries;
  return {
    broadcast: (_m: unknown) => {},
    announcementBus: bus,
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
    ai: {} as never,
  };
}

/** The dispatch-join announcement's summary always starts with "Dispatch '<name>'" — isolates it
 *  from onIdle's OWN per-pane completion announcement (a separate enqueue on the same edge). */
const isJoinSummary = (item: { summary?: string }): boolean => /^Dispatch '/.test(item.summary ?? "");

describe("settleDispatchJoin — a group with a FAILED member announces completion_failed (WS1)", () => {
  it("failed>0 in the settled group -> kind 'completion_failed' (not the plain success chime)", async () => {
    const paneA = "wsf_a1";
    const paneB = "wsf_b1";
    dispatchJoinTracker.create("WS1 group", "run tests", [paneA, paneB]);
    dispatchJoinTracker.noteRunning(paneA);
    dispatchJoinTracker.noteRunning(paneB);

    const enqueued: Array<{ kind: string; terminalId: string; summary?: string }> = [];
    const bus = new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES });
    bus.onEnqueue((item) => enqueued.push(item as { kind: string; terminalId: string; summary?: string }));
    const { manager } = makeManager([paneA, paneB]);
    const { onOutput, onIdle } = attachObserve(manager, makeDeps(bus));

    onOutput(paneA, "Error: something exploded\n"); // paneA errors; paneB still running -> group not complete
    assert.ok(!enqueued.some(isJoinSummary), "the group must not settle until every member reaches a terminal status");

    await onIdle(paneB); // the LAST member settles -> the group completes here

    const joinItems = enqueued.filter(isJoinSummary);
    assert.strictEqual(joinItems.length, 1, "the group settles exactly once, on the last member's edge");
    assert.strictEqual(joinItems[0].kind, "completion_failed", "a group with a failed member must announce completion_failed, never the plain success chime");
  });

  it("a CLEAN group (no failed members) still announces plain 'completion' (additive — no regression)", async () => {
    const paneA = "wsf_a2";
    const paneB = "wsf_b2";
    dispatchJoinTracker.create("WS1 clean group", "run tests", [paneA, paneB]);
    dispatchJoinTracker.noteRunning(paneA);
    dispatchJoinTracker.noteRunning(paneB);

    const enqueued: Array<{ kind: string; terminalId: string; summary?: string }> = [];
    const bus = new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES });
    bus.onEnqueue((item) => enqueued.push(item as { kind: string; terminalId: string; summary?: string }));
    const { manager } = makeManager([paneA, paneB]);
    const { onIdle } = attachObserve(manager, makeDeps(bus));

    await onIdle(paneA); // first member settles -> group not complete yet (paneB still running)
    await onIdle(paneB); // last member settles -> group completes here, failed===0

    const joinItems = enqueued.filter(isJoinSummary);
    assert.strictEqual(joinItems.length, 1, "the group settles exactly once");
    assert.strictEqual(joinItems[0].kind, "completion", "a fully clean group keeps the plain completion kind");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3b. src/observe/index.ts — onIdle: the genuine Running->Idle announcement is keyed off the
//     pane's SETTLED exchange outcome (via the exchange spine, active for this whole file).
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Deliver a fresh exchange onto `paneId` via the REAL process-wide singleton — mirrors the
 *  identical helper in tests/test_exchange_observation.ts. */
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

describe("onIdle — outcome-keyed completion announcement via the exchange spine (WS1)", () => {
  it("a FAILED settled outcome (agent_failed via a matched result envelope) -> announces completion_failed", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("wsf_fail1");
    getExchangeService().onPaneSignal({ paneId: "wsf_fail1", kind: "running" });
    const { manager } = makeManager(["wsf_fail1"]);
    const envelopeText = JSON.stringify({ exchange_id: id, status: "failed", summary: "build broke" });
    const entries: HistoryEntry[] = [{ command: "run tests", timestamp: "t", output: envelopeText }];

    const enqueued: Array<{ kind: string; terminalId: string }> = [];
    const bus = new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES });
    bus.onEnqueue((item) => enqueued.push(item as { kind: string; terminalId: string }));
    const { onIdle } = attachObserve(manager, makeDeps(bus, entries));
    await onIdle("wsf_fail1");

    assert.strictEqual(getExchangeService().get(id)?.state, "agent_failed", "precondition: the envelope settled the exchange as failed");
    const own = enqueued.filter((i) => i.terminalId === "wsf_fail1");
    assert.strictEqual(own.length, 1, "exactly one onIdle announcement for this pane");
    assert.strictEqual(own[0].kind, "completion_failed", "a FAILED settled outcome must announce completion_failed, never the plain success chime");
  });

  it("a CLEAN settled outcome (agent_complete via the legacy done-line heuristic) -> stays plain 'completion' (regression)", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("wsf_ok1");
    getExchangeService().onPaneSignal({ paneId: "wsf_ok1", kind: "running" });
    const { manager } = makeManager(["wsf_ok1"]);
    const entries: HistoryEntry[] = [{ command: "run tests", timestamp: "t", output: "142 passing\nall suites green\n", finalResponse: "Done: build succeeded." }];

    const enqueued: Array<{ kind: string; terminalId: string }> = [];
    const bus = new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES });
    bus.onEnqueue((item) => enqueued.push(item as { kind: string; terminalId: string }));
    const { onIdle } = attachObserve(manager, makeDeps(bus, entries));
    await onIdle("wsf_ok1");

    assert.strictEqual(getExchangeService().get(id)?.state, "agent_complete", "precondition: the legacy heuristic settled a clean completion");
    const own = enqueued.filter((i) => i.terminalId === "wsf_ok1");
    assert.strictEqual(own.length, 1);
    assert.strictEqual(own[0].kind, "completion", "a clean completion must NOT be keyed as completion_failed");
  });

  it("CRITICAL: a pane with NO exchange correlation at all still announces plain 'completion' — never suppressed, even when the output LOOKS failed", async () => {
    resetExchangeServiceForTests();
    const { manager } = makeManager(["wsf_ghost"]);
    // VERIFIER PATCH: the history is deliberately FAILURE-FLAVORED. The spec's negative case is
    // "never key failure off the idle heuristic alone" — a lazy implementation that scans the
    // output/summary text for /fail|error/i (instead of reading the SETTLED exchange outcome)
    // would announce completion_failed here, and the original empty-output fixture could not
    // catch it. finalResponse is pre-set so computeIdleSummary returns it directly (no AI call).
    const entries: HistoryEntry[] = [{
      command: "npm test", timestamp: "t",
      output: "Error: Cannot find module 'left-pad'\nnpm ERR! Test failed.  See above for more details.\n",
      finalResponse: "The test run failed: missing module left-pad (exit code 1).",
    }];

    const enqueued: Array<{ kind: string; terminalId: string }> = [];
    const bus = new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES });
    bus.onEnqueue((item) => enqueued.push(item as { kind: string; terminalId: string }));
    const { onIdle } = attachObserve(manager, makeDeps(bus, entries));
    await onIdle("wsf_ghost");

    assert.strictEqual(getExchangeService().activeExchangeForPane("wsf_ghost"), undefined, "precondition: no delivered exchange on this pane");
    const own = enqueued.filter((i) => i.terminalId === "wsf_ghost");
    assert.strictEqual(own.length, 1, "the announcement must never be silently dropped for an uncorrelated pane (told-more beats silently-missed)");
    assert.strictEqual(own[0].kind, "completion", "no correlation -> plain completion, never completion_failed off the idle heuristic alone");
  });

  it("REVIEWER ATTACK (stale-failure relabel): a LATER manual run on a pane whose settled exchange failed must announce plain 'completion', not re-ring the failure buzz", async () => {
    // `paneActive` keeps pointing at a SETTLED exchange until the next delivery supersedes it
    // (ExchangeService.completeDelivery / recoverOnBoot are the only unbinding paths). Without a
    // staleness guard, completionKindFor reads that parked agent_failed forever: every subsequent
    // manual run's clean Running->Idle edge on the same pane would announce completion_failed.
    resetExchangeServiceForTests();
    const paneId = "wsf_stale1";
    const id = deliverExchange(paneId);
    getExchangeService().onPaneSignal({ paneId, kind: "running" });
    const { manager } = makeManager([paneId]);

    // Run 1: the exchange's own run FAILS via a matched envelope -> completion_failed (correct).
    const envelopeText = JSON.stringify({ exchange_id: id, status: "failed", summary: "build broke" });
    const enqueued: Array<{ kind: string; terminalId: string }> = [];
    const bus = new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES });
    bus.onEnqueue((item) => enqueued.push(item as { kind: string; terminalId: string }));
    const { onIdle } = attachObserve(manager, makeDeps(bus, [{ command: "run tests", timestamp: "t", output: envelopeText }]));
    await onIdle(paneId);
    assert.strictEqual(getExchangeService().get(id)?.state, "agent_failed", "precondition: run 1 settled the exchange as failed");
    assert.strictEqual(enqueued.filter((i) => i.terminalId === paneId)[0]?.kind, "completion_failed", "precondition: run 1 announced the failure");

    // Run 2: the operator types a MANUAL command into the same pane (exchangeId null in the
    // command log — spec §5), it completes CLEANLY. The parked agent_failed exchange is stale
    // history: keying failure off it here would mislabel an unrelated clean run.
    getExchangeService().recordManualCommand(paneId, "ls");
    const enqueued2: Array<{ kind: string; terminalId: string }> = [];
    const bus2 = new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES });
    bus2.onEnqueue((item) => enqueued2.push(item as { kind: string; terminalId: string }));
    const { onIdle: onIdle2 } = attachObserve(manager, makeDeps(bus2, [{
      command: "ls", timestamp: "t2", output: "README.md\npackage.json\n", finalResponse: "Listed 2 files.",
    }]));
    await onIdle2(paneId);

    const own = enqueued2.filter((i) => i.terminalId === paneId);
    assert.strictEqual(own.length, 1, "the manual run still gets its own announcement (never suppressed)");
    assert.strictEqual(
      own[0].kind, "completion",
      "a clean manual run must NOT inherit a stale agent_failed verdict from a PREVIOUS run's exchange — " +
        "failure is only attributable when the pane's last command was the active exchange's own delivery",
    );
  });

  it("an exchange whose outcome is still UNKNOWN at idle time (no envelope, no done-line) stays plain 'completion'", async () => {
    resetExchangeServiceForTests();
    const id = deliverExchange("wsf_unknown1");
    getExchangeService().onPaneSignal({ paneId: "wsf_unknown1", kind: "running" });
    const { manager } = makeManager(["wsf_unknown1"]);
    // An ordinary summary with no envelope and no literal done-line: the exchange stays at
    // terminal_idle (neither agent_complete nor agent_failed) — pinned by
    // tests/test_exchange_observation.ts's "idle never means completion" suite.
    // VERIFIER PATCH: the text is deliberately FAILURE-FLAVORED ("failing") while the SETTLED
    // outcome stays unknown — a lazy implementation keying completion_failed off /fail/i in the
    // output/summary (the idle heuristic alone) announces completion_failed here and is caught;
    // the outcome-keyed implementation correctly stays plain. The failure wording also can't
    // mis-settle the exchange: LEGACY_DONE_LINE_VETO_RE vetoes any done-line naming a failure,
    // so the terminal_idle precondition below still holds.
    const entries: HistoryEntry[] = [{
      command: "run tests", timestamp: "t",
      output: "3 failing\n142 passing\n",
      finalResponse: "Test run hit 3 failing specs (exit code 1).",
    }];

    const enqueued: Array<{ kind: string; terminalId: string }> = [];
    const bus = new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES });
    bus.onEnqueue((item) => enqueued.push(item as { kind: string; terminalId: string }));
    const { onIdle } = attachObserve(manager, makeDeps(bus, entries));
    await onIdle("wsf_unknown1");

    assert.strictEqual(getExchangeService().get(id)?.state, "terminal_idle", "precondition: idle alone never settles complete or failed");
    const own = enqueued.filter((i) => i.terminalId === "wsf_unknown1");
    assert.strictEqual(own.length, 1);
    assert.strictEqual(own[0].kind, "completion", "an UNKNOWN outcome must never be speculatively announced as completion_failed");
  });
});
