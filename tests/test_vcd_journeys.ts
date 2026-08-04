// tests/test_vcd_journeys.ts — fikj.11: (a) server.ts wiring conformance (the
// test_turn_arbiter_journeys item-3 idiom — the shared instance must reach every producer seam or
// record()/invalidate() silently never fire in production, the exact fikj.11 gap), and (b) the
// cross-producer journey (Task 10): all three producers against ONE real ledger + ONE real
// arbiter, ending in exactly one truthful class-0 retraction.
// Runner: npx tsx --test --test-force-exit tests/test_vcd_journeys.ts
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGating } from "../src/gating";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";
import { respawnPane } from "../src/actions/defs/panes_rest";
import * as voiceIndexModule from "../src/voice/index";

type AnyRec = Record<string, any>;
const voiceIndex = voiceIndexModule as AnyRec;
const T0 = 1_700_000_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

test("server.ts constructs ONE correction ledger on the shared arbiter and threads it into every producer seam", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "server.ts"), "utf-8");
  assert.ok(src.includes("createCorrectionLedger({ arbiter: turnArbiter })"),
    "fikj.11 feature absent: server.ts must construct the ledger on the SHARED arbiter (class-0 submissions only — no new send site)");
  const passthroughs = (src.match(/^\s*correctionLedger,\s*$/gm) ?? []).length;
  assert.ok(passthroughs >= 3,
    `correctionLedger must be threaded into createGating, attachVoiceSession, AND buildRestActionContext (found ${passthroughs} pass-throughs)`);

  // ── SAME-INSTANCE pins (Task 8 review rider): presence alone can't prove the ledger wraps the
  // ONE shared arbiter. If it wrapped a different arbiter, class-0 corrections would submit into a
  // queue no session drains: permanent silence. Pin (1) exactly one arbiter construction, (2)
  // exactly one ledger construction, (3) source order — the ledger line sits AFTER the boot
  // arbiter line, so `turnArbiter` in its deps bag can only bind the shared boot instance.
  const arbiterCalls = (src.match(/createTurnArbiter\(/g) ?? []).length;
  assert.strictEqual(arbiterCalls, 1,
    `server.ts must call createTurnArbiter( EXACTLY once (found ${arbiterCalls}) — a second arbiter would give the ledger a queue no session drains`);
  const ledgerCalls = (src.match(/createCorrectionLedger\(/g) ?? []).length;
  assert.strictEqual(ledgerCalls, 1,
    `server.ts must call createCorrectionLedger( EXACTLY once (found ${ledgerCalls}) — TWO ledgers would split the truth plane (supersession/resolution would miss claims recorded on the other instance)`);
  const arbiterAt = src.indexOf("const turnArbiter = createTurnArbiter(");
  assert.ok(arbiterAt !== -1,
    "boot anchor missing: `const turnArbiter = createTurnArbiter(` — the shared-arbiter construction the ledger must bind to");
  const ledgerAt = src.indexOf("createCorrectionLedger({ arbiter: turnArbiter })");
  assert.ok(ledgerAt > arbiterAt,
    "the ledger construction must appear AFTER the shared boot-arbiter construction in source order — otherwise `turnArbiter` cannot be the drained instance");
});

// ── the cross-producer journey: three producers, one ledger, one arbiter, truthful retraction ──

const tick = () => new Promise<void>(r => setImmediate(() => setImmediate(() => r())));

function makeGatingHarness(arbiter: AnyRec, ledger: AnyRec) {
  const narrations: string[] = [];
  const session = { sendClientContent: () => {} };
  const manager: AnyRec = {
    globalPermissionsMode: "Inherit",
    terminals: { t1: { status: "Running", writeInput: () => {}, stop: async () => {} } },
    settings: { advanced: { capabilityGates: {} } },
    ledger: {
      activeProjectId: "default_project", getActiveProject: () => undefined,
      getDraft: () => undefined, setDraft: () => {}, plans: [], watchRules: [], save: () => {},
    },
  };
  const coreState: AnyRec = {
    activeFrontendWs: null, activeLiveSession: session, clients: new Set(),
    activePaneId: null, frozen: false, lastStopAllFailed: [], setFrozen: () => {},
  };
  const gating: AnyRec = createGating({
    manager, store: null, broadcast: () => {}, broadcastLedgerUpdate: () => {}, broadcastDraft: () => {},
    coreState, announcementBus: { enqueue: () => true, stop: () => {} },
    pushApprovalNarration: (_s: any, text: string) => { narrations.push(text); return true; },
    sanitizeSettingsForClient: (s: any) => s, addCommand: () => {},
    turnArbiter: arbiter, correctionLedger: ledger,
  } as any);
  return { gating, narrations, session, manager };
}

test("journey: dispatch + completion + failed restart against ONE ledger -> exactly the TRUE retractions, coalesced", async () => {
  const arb: AnyRec = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb as any });

  // Producer 1 (real gating): approve -> spoken dispatch claim on t1.
  const h = makeGatingHarness(arb, led);
  h.gating.pendingApprovals.add(
    { messageId: "d1", instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: "d1", timestamp: T0 } as any,
    h.session,
  );
  h.gating.applyResolution("d1", "approve");
  assert.ok(h.narrations.some((n: string) => n.includes("Dispatching now")));

  // Producer 3 (drain-sink helper, as wired): a spoken SUCCESS completion claim on pane p9
  // (completionSuccess: true mirrors the real producer's post-fix-2 item stamp — only
  // asserted-success claims are electable by the contradiction guard).
  voiceIndex.recordSpokenCompletionClaims(
    { headline: { facts: "pane p9 finished", cls: 3, paneId: "p9", forVisualStack: false, completionSuccess: true }, tail: [], tailCount: 0, tailGroups: [] },
    true, led, T0,
  );

  // Producer 2 (real action handler): a restart of t1 whose stop() fails -> retraction.
  const term: AnyRec = { projectId: "p1", stop: async () => { throw new Error("boom"); }, start: () => {} };
  const ctx: AnyRec = {
    manager: {
      terminals: { t1: term }, archivingPanes: new Set(),
      ledger: { getProject: () => ({ id: "p1", panes: { t1: { id: "t1" } } }), getActiveProject: () => undefined },
      settings: { advanced: {} },
    },
    correctionLedger: led,
    gateOrDefer: () => ({ disposition: "run" }),
    broadcastLedgerUpdate: () => {}, broadcastTerminalsUpdated: () => {}, broadcast: () => {},
  };
  respawnPane.handler({ pane_id: "t1" } as any, ctx as any);
  await tick();

  // A contradicting error signal against p9's completion claim (within the window).
  const hit = voiceIndex.completionContradiction({ paneId: "p9", kind: "error" }, led, T0 + 2_000);
  assert.ok(hit, "the completion contradiction elects");
  led.invalidate(hit.claimId, hit.groundTruth, { severity: "exception" });

  // The SAME signal shape against t1 must NOT elect (its latest spoken claim is the RESTART claim,
  // already corrected — and before that a dispatch claim; neither is a completion): no false correction.
  assert.strictEqual(voiceIndex.completionContradiction({ paneId: "t1", kind: "error" }, led, T0 + 2_000), null,
    "kind-scoping shields dispatch/restart claims from the completion guard");

  // Drain: BOTH pending corrections (restart failure + false-done) ride ONE class-0 digest.
  const d: AnyRec = arb.evaluate({ now: T0 + 5_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 0);
  const all = [d.digest.headline, ...d.digest.tail];
  assert.strictEqual(all.filter((i: AnyRec) => i.cls === 0).length, 2, "coalescing: one spoken turn, two retractions");
  assert.ok(all.some((i: AnyRec) => i.facts.includes("t1")) && all.some((i: AnyRec) => i.facts.includes("p9")));
  // …and nothing about the DISPATCH claim (its ground truth never flipped).
  assert.ok(!all.some((i: AnyRec) => /dispatch/i.test(i.facts)), "no false correction for the un-flipped dispatch claim");
  // One turn per turn-clear; nothing re-fires.
  assert.strictEqual(arb.evaluate({ now: T0 + 5_001, floorHeld: false, turnClear: true }).action, "hold");
});

test("journey: corrections fire regardless of completionAnnounce AND under a hostile dial (floor)", () => {
  // completionAnnounce=off silences COMPLETIONS (no claim is even recorded, so no correction can
  // false-fire) — but an already-recorded spoken claim still retracts under any dial (D4 floor).
  const arb: AnyRec = createTurnArbiter({ matrix: { 0: "passive-context" } }); // hostile — clamps
  const led: AnyRec = createCorrectionLedger({ arbiter: arb as any });
  led.record({ claimId: "c1", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0, spoken: true });
  assert.strictEqual(led.invalidate("c1", "it did not finish").corrected, true);
  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.notStrictEqual(d.mode, "passive-context", "the never-silent floor holds end to end");
});

// ── rider (fikj.11 hardening): the restart-shadowing interplay ──
// A restart ack recorded AFTER a completion claim becomes the newest spoken claim on the pane
// (latestSpokenByPane), so a subsequent exited signal cannot false-retract the stale completion.
// Production has TWO protective layers against that false correction:
//   (1) the ownExit gate — a pane the system itself restarted emits an INTENTIONAL exit, which the
//       signal path suppresses before the contradiction guard ever runs;
//   (2) KIND-scoped shadowing — latestSpokenClaim(pX) now returns the RESTART claim, and
//       completionContradiction elects only when the newest spoken claim is a COMPLETION.
// This test pins layer (2), which must hold even if layer (1) ever regresses.
test("journey: a restart ack SHADOWS a prior completion claim — an exited signal elects NO retraction", async () => {
  const arb: AnyRec = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb as any });

  // A spoken completion claim on pX (the drain-sink helper, as wired; injected T0 clock).
  voiceIndex.recordSpokenCompletionClaims(
    { headline: { facts: "pane pX finished", cls: 3, paneId: "pX", forVisualStack: false }, tail: [], tailCount: 0, tailGroups: [] },
    true, led, T0,
  );

  // A restart of pX through the REAL handler (stop succeeds): the ack claim (spoken:true, REAL
  // clock — the handler stamps Date.now()) shadows the completion in latestSpokenByPane.
  const term: AnyRec = { projectId: "p1", stop: async () => {}, start: () => {} };
  const ctx: AnyRec = {
    manager: {
      terminals: { pX: term }, archivingPanes: new Set(),
      ledger: { getProject: () => ({ id: "p1", panes: { pX: { id: "pX" } } }), getActiveProject: () => undefined },
      settings: { advanced: {} },
    },
    correctionLedger: led,
    gateOrDefer: () => ({ disposition: "run" }),
    broadcastLedgerUpdate: () => {}, broadcastTerminalsUpdated: () => {}, broadcast: () => {},
  };
  respawnPane.handler({ pane_id: "pX" } as any, ctx as any);
  await tick();

  // Mixed clocks are safe HERE by design: the negative relies on KIND-scoping (restart ≠
  // completion), never on recency arithmetic against the real-clock restart ack.
  assert.strictEqual(voiceIndex.completionContradiction({ paneId: "pX", kind: "exited" }, led, T0 + 2_000), null,
    "the shadowing restart claim shields the stale completion from a false retraction");
});
