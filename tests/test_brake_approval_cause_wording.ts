// tests/test_brake_approval_cause_wording.ts — bead y9tj RED: a BRAKE-cancelled APPROVAL must be
// voiced with its real cause ("cancelled by stop-all"), never as a fabricated 5-minute timeout.
//
// THE DEFECT (J0 §4, utterance ⇄ state divergence — the "wrong cause" variant):
//   stopAllStage1Freeze's approvals loop (src/gating/index.ts:949) calls
//   applyResolution(id, "expire") for every pending approval, which lands in renderExpired
//   (src/gating/index.ts:1326) and voices:
//       "The command on pane t1 expired after 5 minutes; I cancelled it."
//   …even when the emergency brake killed the approval SECONDS after staging. Wrong CAUSE
//   (a timeout that never happened) plus a fabricated DURATION.
//
//   Meanwhile the SAME stop-all's ACTION leg already tells the truth (okes,
//   collapseBrakedActionLastCall, src/gating/index.ts:935):
//       "create_pane: Create pane x — cancelled by stop-all."
//   So ONE stop-all utterance currently narrates TWO different causes for two kinds of staged item.
//
// THE CONTRACT PINNED HERE (cosmetic/honesty only — the lifecycle is deliberately NOT restructured):
//   1. A brake-caused approval expire words the cancellation as "cancelled by stop-all", matching
//      the action leg, and claims NO duration/timeout.
//   2. It keeps the site-5 collapse IDENTITY exactly — cls 2, coalesceKey `last-call:<messageId>`,
//      paneId === the approval's terminalId (the approvals-leg sweep submits WITH a paneId, unlike
//      the actions leg; identityKey is `key-<coalesceKey>--pane-<paneId??''>`, so dropping it here
//      would mint a DIFFERENT identity and leave the stale still-actionable last-call alive), and
//      NO deadline (the overwrite must discard the stale expiresAt, never arm a new interrupt).
//   3. A GENUINE TTL expiry (the sweep's own reject leg) keeps its honest timeout wording — the fix
//      must be cause-threaded, not a global string swap.
//   4. The honest wording holds on BOTH egress channels: the injected arbiter AND the legacy
//      pushApprovalNarration slot (no arbiter injected).
//
// Harness: the sibling idiom from tests/test_turn_arbiter_deadlines.ts — the REAL createGating and
// the REAL createTurnArbiter with fake time; only true boundaries are faked (live session, store,
// broadcast sinks). A capture-stub arbiter pins the exact gating→arbiter submission shape.
//
// Runner: npx tsx --test --test-force-exit tests/test_brake_approval_cause_wording.ts

import { test } from "node:test";
import assert from "node:assert";
import { createGating } from "../src/gating";
import { APPROVAL_GRACE_MS } from "../src/pendingApprovals";
import { createTurnArbiter } from "../src/voice/turnArbiter";

type AnyRec = Record<string, any>;

const T0 = 1_700_000_000_000;
const TTL = 5 * 60 * 1000; // gating's APPROVAL_TTL_MS
const GRACE = APPROVAL_GRACE_MS; // 60s
const S1 = T0 + TTL + 1; // first sweep tick past the TTL — the last-call moment

/** The lie under test: any minute-count is a fabrication when the brake did the killing. */
const FABRICATED_DURATION = /\b\d+\s*minutes?\b/i;
/** The truth the ACTION leg already speaks (okes) — one stop-all, one cause. */
const BRAKE_CAUSE = /cancelled by stop-all/i;

// ── harness (mirrors tests/test_turn_arbiter_deadlines.ts makeHarness) ─────────────────────────

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
    activeLiveSession: session,
    clients: new Set(),
    activePaneId: null,
    frozen: false,
    lastStopAllFailed: [],
    setFrozen: (v: boolean) => { coreState.frozen = v; },
  };
  const deps: any = {
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
  const gating = createGating(deps);
  return { gating, narrations, broadcasts, session, coreState };
}

function addApproval(gating: AnyRec, session: AnyRec, id = "d1", ts = T0): void {
  gating.pendingApprovals.add(
    { messageId: id, instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: id, timestamp: ts } as any,
    session,
  );
}

/** Seam probe: records every submitted / removed item. */
function captureArbiter(pausedByKey: Record<string, number> = {}) {
  const submitted: AnyRec[] = [];
  const removed: string[] = [];
  return {
    submitted,
    removed,
    submit: (item: AnyRec) => { submitted.push(item); },
    remove: (k: string) => { removed.push(k); },
    floorPausedMs: (k: string) => pausedByKey[k] ?? 0,
  };
}

// ── (1) the observable utterance: what the operator actually HEARS after the brake ─────────────

test("y9tj — a brake-cancelled APPROVAL drains as 'cancelled by stop-all', never as a fabricated 5-minute timeout", async () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);

  // Queue the class-2 last-call under `last-call:d1` (stale deadline = S1 + GRACE).
  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(h.gating.pendingApprovals.get("d1")!.lastCallAt, S1, "precondition: last-call stamped");
  assert.strictEqual(
    arb.evaluate({ now: S1 + 100, floorHeld: true, turnClear: false }).action, "hold",
    "precondition: mid-floor, nothing drained yet — the queued last-call is still in the outbox",
  );

  // EMERGENCY BRAKE, ~1.7 seconds after the staging window opened its last-call. Nothing timed out.
  await h.gating.stopAll(false);
  assert.strictEqual(h.gating.pendingApprovals.has("d1"), false, "precondition: the brake cancelled the approval");
  assert.ok(h.narrations.some((n) => /stop-all engaged/i.test(n)), "precondition: the instant slot echo is untouched");

  // Drain BEFORE the stale deadline (S1 + GRACE) — this is the letter pulled from the outbox.
  const d: AnyRec = arb.evaluate({ now: S1 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "holds pre- and post-fix — the failure must be the FACTS, not the drain");
  const items = [d.digest.headline, ...d.digest.tail].filter((i: AnyRec) => (i.coalesceKey ?? "").includes("d1"));
  assert.strictEqual(items.length, 1,
    "exactly one d1 item — a duplicate means the brake wording changed the submit IDENTITY " +
      "(identityKey is key-<coalesceKey>--pane-<paneId??''>; the approvals-leg sweep submits WITH " +
      "paneId, so the brake variant must too, or the stale actionable last-call survives)");
  const spoken: string = items[0].facts;

  assert.doesNotMatch(spoken, FABRICATED_DURATION,
    "y9tj feature absent: the brake killed this approval seconds after staging, yet the spoken " +
      `line claims a duration — heard: ${JSON.stringify(spoken)}`);
  assert.match(spoken, BRAKE_CAUSE,
    "y9tj feature absent: a brake-cancelled approval must name STOP-ALL as the cause, matching the " +
      `ACTION leg's "<capability>: <summary> — cancelled by stop-all." — heard: ${JSON.stringify(spoken)}`);
  assert.doesNotMatch(spoken, /approve now/i, "a brake-killed approval must never still sound actionable");
  assert.match(spoken, /npm run deploy/,
    "told-more PARITY with the action leg (okes names the item: `create_pane: Create pane x — " +
      "cancelled by stop-all.`): the approval line must name the COMMAND, not just the pane. Naming " +
      "only the pane makes two brake-cancelled approvals on one pane read out as two byte-identical " +
      `lines, so the operator cannot tell which command died — heard: ${JSON.stringify(spoken)}`);
  assert.strictEqual(items[0].cls, 2, "still a class-2 deadline-family item — the lifecycle is NOT restructured");
});

// ── (2) one stop-all, ONE cause: the approval and action legs must agree ───────────────────────

test("y9tj — a single stop-all narrates ONE cause: the approval leg and the ACTION leg (okes) word the cancellation the same way", async () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);
  h.gating.pendingActions.add({ id: "act_1", capability: "create_pane", summary: "Create pane x", timestamp: T0, run: () => "ok" });

  h.gating.sweepExpiredApprovals(S1); // both legs queue their last-call
  await h.gating.stopAll(false);

  const d: AnyRec = arb.evaluate({ now: S1 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  const byKey = new Map<string, string>();
  for (const i of [d.digest.headline, ...d.digest.tail] as AnyRec[]) {
    if (i.coalesceKey) byKey.set(i.coalesceKey, i.facts);
  }
  const approvalLine = byKey.get("last-call:d1");
  const actionLine = byKey.get("last-call:act_1");
  assert.ok(approvalLine, "the brake-cancelled approval is still voiced (never silently dropped)");
  assert.ok(actionLine, "precondition (okes, on main): the brake-cancelled action is voiced");
  assert.match(actionLine!, BRAKE_CAUSE, "precondition (okes, on main): the ACTION leg already tells the truth");
  assert.match(approvalLine!, BRAKE_CAUSE,
    "y9tj feature absent: ONE stop-all narrates TWO different causes — the action leg says " +
      `${JSON.stringify(actionLine)} while the approval leg says ${JSON.stringify(approvalLine)}`);
});

// ── (3) the seam shape: honest facts, IDENTICAL collapse identity ─────────────────────────────

test("y9tj shape — the brake's approval expire submits cls-2 under the SAME identity (last-call:<id>, paneId t1, no deadline) with brake-caused facts", async () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1);
  assert.strictEqual(cap.submitted.length, 1, "precondition: the sweep last-call submitted");
  const lastCall = cap.submitted[0];

  await h.gating.stopAll(false);

  assert.strictEqual(cap.submitted.length, 2,
    "the brake's approvals loop still re-submits the honest notice under the last-call key (site-5 collapse)");
  const it = cap.submitted[1];
  assert.strictEqual(it.cls, 2);
  assert.strictEqual(it.coalesceKey, "last-call:d1",
    "SAME identity as sweepApprovalItem's last-call — latest-wins overwrite wipes the stale deadline");
  assert.strictEqual(it.paneId, lastCall.paneId,
    "MUST keep the approvals-leg paneId (t1) — the actions leg carries none, but copying that here " +
      "mints key-...--pane- instead of key-...--pane-t1 and leaves the stale last-call alive");
  assert.strictEqual(it.paneId, "t1", "…and that paneId is the approval's terminalId");
  assert.strictEqual(it.deadline, undefined,
    "NO deadline — the honest cancellation must never become a tickDeadlines interrupt candidate");
  assert.doesNotMatch(it.facts, FABRICATED_DURATION,
    `y9tj feature absent: the brake-leg submit fabricates a duration — ${JSON.stringify(it.facts)}`);
  assert.match(it.facts, BRAKE_CAUSE,
    `y9tj feature absent: the brake-leg submit must name stop-all as the cause — ${JSON.stringify(it.facts)}`);
  assert.doesNotMatch(it.facts, /approve now/i);
});

// ── (4) legacy channel (no arbiter injected): the SLOT must speak the same truth ───────────────

test("y9tj legacy channel — with NO arbiter injected, the brake's slot narration for the approval is brake-caused, not a timeout", async () => {
  const h = makeHarness(); // no arbiter: renderExpired falls back to pushApprovalNarration
  addApproval(h.gating, h.session);

  await h.gating.stopAll(false);

  assert.strictEqual(h.gating.pendingApprovals.has("d1"), false, "precondition: the brake cancelled the approval");
  const lied = h.narrations.find((n) => FABRICATED_DURATION.test(n));
  assert.strictEqual(lied, undefined,
    "y9tj feature absent: the legacy narration slot still claims a timeout duration for a " +
      `brake-cancelled approval — heard: ${JSON.stringify(lied)}`);
  const honest = h.narrations.find((n) => BRAKE_CAUSE.test(n) && /npm run deploy/.test(n));
  assert.ok(honest,
    "y9tj feature absent: on the legacy slot too, the brake-cancelled approval must be voiced as " +
      "cancelled by stop-all AND name the COMMAND — same told-more parity the arbiter leg pins. " +
      "Accepting a pane-only line here would let two brake-cancelled approvals on one pane read out " +
      `byte-identically — heard: ${JSON.stringify(h.narrations)}`);
});

// ── (5) NEGATIVE CONTROL: a genuine TTL expiry keeps its honest timeout wording ────────────────

test("y9tj negative — a GENUINE TTL expiry (sweep reject leg) still says it expired after 5 minutes and never blames stop-all", () => {
  const cap = captureArbiter();
  const h = makeHarness({ arbiter: cap });
  addApproval(h.gating, h.session);

  h.gating.sweepExpiredApprovals(S1);                 // last-call queued + stamped
  h.gating.sweepExpiredApprovals(S1 + GRACE + 1);     // grace elapsed -> applyResolution(id,"expire")
  assert.strictEqual(h.gating.pendingApprovals.has("d1"), false, "precondition: the genuine TTL expiry resolved it");
  assert.strictEqual(cap.submitted.length, 2, "precondition: the honest expiry notice collapsed the last-call");

  const it = cap.submitted[1];
  assert.strictEqual(it.coalesceKey, "last-call:d1");
  assert.match(it.facts, /expired after 5 minutes/i,
    "a REAL timeout must keep its real wording — the y9tj fix threads the brake CAUSE through, it " +
      "does not globally rewrite renderExpired");
  assert.doesNotMatch(it.facts, BRAKE_CAUSE, "no stop-all happened here — never blame the brake for a timeout");
  assert.strictEqual(h.coreState.frozen, false, "sanity: nothing froze the line in this scenario");
});

// ── (6) SCOPE GUARD: the lifecycle is unchanged — wording only ─────────────────────────────────

test("y9tj scope — the brake still resolves the approval exactly once as outcome 'expired' (wording-only fix, no lifecycle restructure)", async () => {
  const arb = createTurnArbiter();
  const h = makeHarness({ arbiter: arb as any });
  addApproval(h.gating, h.session);
  h.gating.sweepExpiredApprovals(S1);

  await h.gating.stopAll(false);

  const resolved = h.broadcasts.filter((b) => b.type === "approval_resolved" && b.messageId === "d1");
  assert.strictEqual(resolved.length, 1, "exactly one resolve frame — the claim gate is untouched");
  assert.strictEqual(resolved[0].outcome, "expired",
    "the RESOLUTION reason stays 'expired' (clients key on it); only the spoken CAUSE changes");
  assert.ok(h.broadcasts.some((b) => b.type === "command_blocked" && b.terminalId === "t1"),
    "the UI still hears the blocked frame for the cancelled command");
  assert.strictEqual(h.gating.pendingApprovals.has("d1"), false, "no actionable stale item survives either way");
});
