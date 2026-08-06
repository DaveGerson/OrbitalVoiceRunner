// tests/test_action_defer_lastcall_retraction.ts — bead 3tx3 RED: the staged-ACTION defer leg must
// retract its already-queued arbiter last-call, exactly as the APPROVAL leg now does (p19o).
//
// ── The defect (J0, JOURNEYS_DESIGN.md §4 "utterance ⇄ state divergence") ──────────────────────
// The sweep (src/gating/index.ts sweepActionItem) queues a class-2 last-call for a staged action
// under coalesceKey `last-call:<actionId>` carrying deadline { expiresAt: S1 + APPROVAL_GRACE_MS,
// onExpirySwap: "<capability>: <summary> — this expired; I cancelled it." }.
// The operator then says "hold that". handleDefer (src/voiceApprovalRouting.ts:78) re-arms the
// record's TTL window IN PLACE (rec.timestamp = Date.now(); rec.lastCallAt = undefined) and speaks
// the instant "Holding it" echo — but it has NO arbiter seam, so the queued letter keeps its STALE
// deadline. Past S1 + GRACE the factsForDrain swap (src/voice/turnArbiter.ts:222) speaks
// "…this expired; I cancelled it" for an action that is HELD, still staged, and still runnable.
// The ledger is right; the speech is a lie.
//
// ── The invariant (p19o / okes, both on main) ──────────────────────────────────────────────────
// Any path that re-arms, cancels or resolves a staged item MUST also retract or re-word the
// already-queued arbiter utterance for it. The APPROVAL leg's reference implementation is
// removeStaleLastCallOnTtlReset (src/gating/index.ts:1076), called from applyDeferral's deferred
// branch (:1502). This file is that fix's ACTION-leg sibling.
//
// ── Pinned contract (the implementer builds EXACTLY this seam) ─────────────────────────────────
//   VoiceApprovalDeps gains ONE new OPTIONAL member:
//     onDeferred?: (actionId: string) => void
//   • fired ONLY from handleDefer's SUCCESSFUL re-arm branch, exactly once per hold, AFTER the
//     record's window is re-armed;
//   • NOT fired on the defer_limit branch (that branch leaves the window untouched, so the queued
//     last-call and its expiry swap are still TRUE facts — retracting there would eat a true fact
//     and break never-drop), NOR on approve/reject (PendingActionStore's own `onResolved` hook
//     already removes `last-call:<id>` at the confirm/cancel settle point — src/pendingActions.ts:97,
//     wired at src/gating/index.ts:275), NOR on clarify/ambiguous/none (nothing was re-armed);
//   • OPTIONAL: callers that don't pass it (the existing suites) keep byte-identical behavior;
//   • wired in src/voice/index.ts (routeApprovalIntent, ~:2171) to
//       onDeferred: (actionId) => turnArbiter?.remove?.(`last-call:${actionId}`)
//     i.e. the SAME identity sweepActionItem submitted under (no paneId — identityKey is
//     `key-<coalesceKey>--pane-<paneId ?? "">`, and the sweep's action submit carries no paneId).
//
// Real code under test: the real createGating + the real createTurnArbiter + the real
// PendingActionStore + the real resolvePendingActionByVoice, on a REAL clock anchor (handleDefer
// re-arms with Date.now(), so the timeline is anchored at Date.now() rather than a synthetic epoch;
// every observation instant is still explicitly passed in). Only true boundaries are faked (live
// session, store, broadcast/narration sinks) — the harness mirrors tests/test_turn_arbiter_deadlines.ts.
//
// Runner: npx tsx --test --test-force-exit tests/test_action_defer_lastcall_retraction.ts

import { test } from "node:test";
import assert from "node:assert";
import { createGating } from "../src/gating";
import { APPROVAL_GRACE_MS } from "../src/pendingApprovals";
import { PendingActionStore } from "../src/pendingActions";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { resolvePendingActionByVoice } from "../src/voiceApprovalRouting";
import { MAX_DEFERRALS } from "../src/approvalIntent";

type AnyRec = Record<string, any>;

const TTL = 5 * 60 * 1000; // gating's APPROVAL_TTL_MS (the sweep measures actions off it too)
const GRACE = APPROVAL_GRACE_MS; // 60s

// ── harness: real gating, fake boundaries, injected arbiter ────────────────────────────────────
// Mirrors makeHarness in tests/test_turn_arbiter_deadlines.ts (a file-local helper there, so it is
// re-stated rather than imported — keep the two in step if that one moves).
function makeHarness(opts: { arbiter?: AnyRec } = {}) {
  const narrations: string[] = [];
  const broadcasts: AnyRec[] = [];
  const session = { sendClientContent: () => {} };
  const manager: AnyRec = {
    globalPermissionsMode: "Inherit",
    terminals: { t1: { status: "Running", writeInput: () => {}, stop: async () => {} } },
    settings: { advanced: { capabilityGates: {} } },
    ledger: {
      activeProjectId: "default_project",
      getActiveProject: () => undefined,
      plans: [],
      watchRules: [],
      save: () => {},
    },
  };
  const coreState: AnyRec = {
    activeFrontendWs: null,
    activeLiveSession: session, // the pending-action sweep leg gates on this ref
    clients: new Set(),
    activePaneId: null,
    frozen: false,
    lastStopAllFailed: [],
    setFrozen: () => {},
  };
  const deps: AnyRec = {
    manager,
    store: null,
    broadcast: (m: AnyRec) => broadcasts.push(m),
    broadcastLedgerUpdate: () => {},
    broadcastDraft: () => {},
    coreState,
    announcementBus: { enqueue: () => true, stop: () => {} },
    pushApprovalNarration: (_s: any, text: string) => { narrations.push(text); return true; },
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
    ...(opts.arbiter ? { turnArbiter: opts.arbiter } : {}),
  };
  return { gating: createGating(deps as any), narrations, broadcasts, session, coreState };
}

/**
 * The production wiring is `onDeferred: (actionId) => turnArbiter.remove(`last-call:${actionId}`)`.
 * Normalize so this suite pins the END behavior (no stale last-call survives a hold) and the exact
 * arbiter identity — not the argument spelling: a sink handed the full coalesceKey is accepted too.
 */
function retractionKey(arg: string): string {
  return arg.startsWith("last-call:") ? arg : `last-call:${arg}`;
}

/**
 * The voice-routing deps, shaped as src/voice/index.ts shapes them, plus the 3tx3 retraction sink.
 * `deps` is `any` on purpose (the test_turn_arbiter_deadlines.ts idiom): `onDeferred` does not
 * exist on VoiceApprovalDeps until 3tx3 lands, so typing it loosely keeps `tsc --noEmit` green in
 * BOTH the red and the green state and makes the failure purely behavioral.
 */
function makeVoiceDeps(arb?: AnyRec) {
  const narrations: string[] = [];
  const broadcasts: AnyRec[] = [];
  const retracted: string[] = [];
  const deps: any = {
    broadcast: (m: AnyRec) => broadcasts.push(m),
    narrate: (t: string) => narrations.push(t),
    redact: (s: string) => s,
    onDeferred: (actionId: string) => {
      retracted.push(actionId);
      arb?.remove?.(retractionKey(actionId));
    },
  };
  return { deps, narrations, broadcasts, retracted };
}

/** Everything the operator would HEAR from one arbiter decision (empty when nothing drains). */
function spokenLines(decision: AnyRec): string[] {
  if (!decision.digest) return [];
  return [decision.digest.headline.facts, ...decision.digest.tail.map((i: AnyRec) => i.facts)];
}

function stageAction(store: PendingActionStore, timestamp: number, id = "act_1"): void {
  store.add({ id, capability: "create_pane", summary: "Create pane claude_new", timestamp, run: () => "ok" });
}

// ── (1) the observable failure: a HELD action must never be spoken of as cancelled ─────────────

test("3tx3 — a HELD staged action never drains the stale 'this expired; I cancelled it' lie, and the re-armed window re-earns a fresh last-call under the same key", () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as AnyRec });
  const NOW = Date.now();
  stageAction(h.gating.pendingActions, NOW - TTL - 1_000); // already past its TTL at NOW

  // (a) the sweep queues the class-2 action last-call: deadline NOW + GRACE, swap = "expired…".
  h.gating.sweepExpiredApprovals(NOW);
  assert.strictEqual(h.gating.pendingActions.get("act_1")!.lastCallAt, NOW,
    "precondition: the sweep stamped + queued the action last-call");
  assert.strictEqual(h.narrations.length, 0,
    "precondition: the timer lane went to the arbiter, not a forced turn through the slot");

  // (b) "hold that" — the REAL voice routing, with the retraction sink wired as production must.
  const voice = makeVoiceDeps(arb as AnyRec);
  resolvePendingActionByVoice("hold that", h.gating.pendingActions, voice.deps);

  const rec = h.gating.pendingActions.get("act_1");
  assert.ok(rec, "the hold NEVER resolves the action — it stays staged and runnable");
  assert.ok(!rec!.claimed, "the hold never claims the record");
  assert.ok(rec!.timestamp >= NOW, "precondition: the hold re-armed the TTL window in place");
  assert.strictEqual(rec!.lastCallAt, undefined, "precondition: the re-arm cleared the last-call transient");
  assert.ok(voice.narrations.some((n) => /Holding it/i.test(n)),
    "the instant defer echo rides the operator slot (invariant: never the arbiter)");

  // (c) THE OBSERVATION: past the STALE deadline (NOW + GRACE) but deep inside the re-armed
  // window (which runs to ~NOW + TTL). Nothing is true to say about act_1 — it is HELD.
  const heard = spokenLines(arb.evaluate({ now: NOW + GRACE + 2_000, floorHeld: false, turnClear: true }));
  assert.deepStrictEqual(heard, [],
    "3tx3 feature absent: the hold re-armed the TTL but left the queued last-call in the outbox " +
      "with its STALE deadline, so the factsForDrain swap speaks a cancellation for an action that " +
      "is HELD and still live. handleDefer's successful branch must retract 'last-call:<actionId>' " +
      "(the ACTION-leg mirror of removeStaleLastCallOnTtlReset / p19o)");

  // (d) never-drop: the retraction kills only the STALE letter. The re-armed window still earns a
  // fresh, honest last-call under the SAME key once it crosses TTL.
  const S2 = NOW + TTL + 5_000;
  h.gating.sweepExpiredApprovals(S2);
  assert.strictEqual(h.gating.pendingActions.get("act_1")!.lastCallAt, S2,
    "the re-armed window re-earns a last-call — the retraction must not drop the item forever");
  const d2: AnyRec = arb.evaluate({ now: S2 + 1, floorHeld: false, turnClear: true });
  assert.strictEqual(d2.action, "drain", "the fresh last-call drains at turn-clear");
  assert.strictEqual(d2.digest.headline.coalesceKey, "last-call:act_1",
    "the sweep re-earns the SAME arbiter identity");
  assert.match(d2.digest.headline.facts, /approve now/i,
    "the fresh last-call is a live actionable ask, not the expiry swap");
  assert.match(d2.digest.headline.facts, /create_pane|Create pane claude_new/,
    "and it still names the action (told-more, not a generic line)");
});

// ── (2) the seam: exactly-once per successful hold, on the exact arbiter identity ───────────────

test("3tx3 seam — every SUCCESSFUL hold retracts 'last-call:<actionId>' exactly once, after the re-arm; the defer_limit branch never retracts", () => {
  const store = new PendingActionStore();
  const NOW = Date.now();
  const STAGED = NOW - 60_000;
  stageAction(store, STAGED);
  store.get("act_1")!.lastCallAt = NOW - 1_000; // a last-call HAS already been queued for it
  const v = makeVoiceDeps();

  resolvePendingActionByVoice("hold that", store, v.deps);

  // The 4D.3 defer semantics are unchanged — the retraction is ADDITIVE, not a replacement.
  assert.ok(store.has("act_1"), "the hold never cancels/claims the action");
  assert.ok(!store.get("act_1")!.claimed, "record stays unclaimed");
  assert.ok(store.get("act_1")!.timestamp > STAGED, "TTL window re-armed in place");
  assert.strictEqual(store.get("act_1")!.lastCallAt, undefined, "lastCallAt cleared by the re-arm");
  assert.deepStrictEqual(v.broadcasts, [], "no action_resolved frame — nothing resolved");
  assert.match(v.narrations.at(-1) ?? "", /Holding it/, "the instant hold echo is untouched");

  assert.strictEqual(v.retracted.length, 1,
    "3tx3 feature absent: a successful hold must fire the retraction sink exactly once — the " +
      "re-armed TTL invalidated the queued last-call's deadline (same TTL-reset shape as p19o's " +
      "applyDeferral -> removeStaleLastCallOnTtlReset on the approvals leg)");
  assert.strictEqual(retractionKey(v.retracted[0]), "last-call:act_1",
    "the retraction must name the arbiter identity sweepActionItem submitted under " +
      "(`last-call:<actionId>`, no paneId) — anything else leaves the stale letter in the outbox");

  // Drive to the cap (MAX_DEFERRALS = 3): each successful hold retracts.
  resolvePendingActionByVoice("not now", store, v.deps);
  resolvePendingActionByVoice("later", store, v.deps);
  assert.strictEqual(v.retracted.length, MAX_DEFERRALS, "each successful hold fires the retraction");
  assert.ok(v.retracted.every((k) => retractionKey(k) === "last-call:act_1"), "always the same key");

  // defer_limit: the window is left UNTOUCHED, so the queued last-call and its honest expiry swap
  // are still TRUE facts. Retracting here would eat a true fact (never-drop).
  const armed = store.get("act_1")!.timestamp;
  resolvePendingActionByVoice("not now", store, v.deps);
  assert.strictEqual(store.get("act_1")!.timestamp, armed, "the 4th hold leaves the window untouched");
  assert.match(v.narrations.at(-1) ?? "", /already held/i, "the operator hears the hold cap");
  assert.strictEqual(v.retracted.length, MAX_DEFERRALS,
    "defer_limit must NEVER retract — it re-arms nothing, so the queued last-call is still true");
});

// ── (3) negatives: only a re-arm invalidates a letter ──────────────────────────────────────────

test("3tx3 negatives — approve, reject, ambient speech and an ambiguous hold never fire the defer retraction", () => {
  // approve: PendingActionStore's own onResolved hook owns the resolution-time retraction.
  const a = new PendingActionStore();
  stageAction(a, Date.now());
  const va = makeVoiceDeps();
  resolvePendingActionByVoice("approve", a, va.deps);
  assert.strictEqual(a.has("act_1"), false, "precondition: approve resolved the action");
  assert.deepStrictEqual(va.retracted, [],
    "approve must not fire the DEFER sink — the store's onResolved settle-point hook already " +
      "removes last-call:<id> (src/pendingActions.ts:97 / src/gating/index.ts:275)");

  // reject: same settle point.
  const r = new PendingActionStore();
  stageAction(r, Date.now());
  const vr = makeVoiceDeps();
  resolvePendingActionByVoice("reject", r, vr.deps);
  assert.strictEqual(r.has("act_1"), false, "precondition: reject cancelled the action");
  assert.deepStrictEqual(vr.retracted, [], "reject must not fire the DEFER sink");

  // ambient speech (intent "none"): nothing is re-armed, nothing is retracted.
  const n = new PendingActionStore();
  stageAction(n, Date.now());
  const vn = makeVoiceDeps();
  resolvePendingActionByVoice("the weather is nice today", n, vn.deps);
  assert.ok(n.has("act_1"), "precondition: ambient speech resolves nothing");
  assert.deepStrictEqual(vn.retracted, [], "a non-defer utterance must never retract");

  // ambiguous hold: >1 staged, no disambiguator -> read-back, NO re-arm, so NO retraction (and in
  // particular never a retraction of the wrong action's letter).
  const m = new PendingActionStore();
  const T = Date.now();
  stageAction(m, T, "act_1");
  m.add({ id: "act_2", capability: "set_pane_permissions", summary: "Set pane t1 to Auto", timestamp: T, run: () => "ok" });
  const vm = makeVoiceDeps();
  resolvePendingActionByVoice("later", m, vm.deps);
  assert.match(vm.narrations.at(-1) ?? "", /Which one\?/, "precondition: the ambiguous read-back ran");
  assert.strictEqual(m.get("act_1")!.timestamp, T, "precondition: no window was re-armed");
  assert.strictEqual(m.get("act_2")!.timestamp, T, "precondition: no window was re-armed");
  assert.deepStrictEqual(vm.retracted, [], "an ambiguous hold re-arms nothing, so it retracts nothing");
});

// ── (4) the sink is OPTIONAL: every existing caller keeps working unchanged ────────────────────

test("3tx3 optionality — deps WITHOUT a retraction sink still hold the action (existing callers/tests unchanged)", () => {
  const store = new PendingActionStore();
  const STAGED = Date.now() - 60_000;
  stageAction(store, STAGED);
  const narrations: string[] = [];
  // The EXACT shape every pre-3tx3 caller/test passes (no sink) — this must keep compiling and working.
  const legacyDeps = { broadcast: () => {}, narrate: (t: string) => { narrations.push(t); }, redact: (s: string) => s };

  assert.doesNotThrow(() => resolvePendingActionByVoice("hold that", store, legacyDeps),
    "onDeferred is OPTIONAL — a caller that omits it must not throw");
  assert.ok(store.has("act_1"), "still staged");
  assert.ok(store.get("act_1")!.timestamp > STAGED, "still re-armed");
  assert.strictEqual(store.get("act_1")!.lastCallAt, undefined, "last-call transient still cleared");
  assert.match(narrations.at(-1) ?? "", /Holding it/, "and the operator still hears the hold echo");
});


// ── wiring: the production key spelling ────────────────────────────────────────────────────────
//
// Verifier finding: the ENTIRE value of this bead lives in one production line
// (src/voice/index.ts's `onDeferred` sink). The behavioural tests above deliberately normalize the
// sink argument, so they pin only that a sink FIRES with the action id — never how production spells
// the arbiter identity. A typo (`lastcall:${actionId}`, or a stray paneId) would leave the stale
// letter in the outbox and every test above would still be green. The p19o counterpart has no such
// gap because its retraction lives inside createGating and is driven end-to-end.
//
// Same source-scan idiom the repo already uses for un-drivable wiring lines
// (tests/test_turn_arbiter_journeys.ts sliceBetween/nonCommentLines).

test("3tx3 wiring — src/voice/index.ts passes onDeferred and retracts the EXACT `last-call:<actionId>` identity", async () => {
  const { readFileSync } = await import("node:fs");
  const voiceSource = readFileSync(new URL("../src/voice/index.ts", import.meta.url), "utf8");
  const live = voiceSource
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
    .join("\n");

  const start = live.indexOf("resolvePendingActionByVoice(");
  assert.ok(start >= 0, "3tx3 wiring: src/voice/index.ts must call resolvePendingActionByVoice");
  const block = live.slice(start, live.indexOf("});", start) + 3);

  assert.match(block, /onDeferred\s*:/,
    "3tx3 wiring: the resolvePendingActionByVoice deps in src/voice/index.ts must pass an `onDeferred` " +
      "sink — without it handleDefer re-arms the TTL and the stale queued last-call keeps its dead " +
      "deadline, which is the whole defect this bead fixes.");

  assert.match(block, /remove\?\.\(`last-call:\$\{actionId\}`\)/,
    "3tx3 wiring: the sink must retract the arbiter identity spelled EXACTLY `last-call:${actionId}` " +
      "(template literal, no paneId — the sweep submits the action last-call without one, and " +
      "turnArbiter.remove matches on coalesceKey alone). Any other spelling is a silent no-op that no " +
      "behavioural test in this file can catch.");
});
