// tests/test_reconnect_quiet_threshold.ts — Wave 3 RED: yg1w reconnect quiet threshold + the
// pane-signal private-queue fold.
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md §3.3 rows 6-7, §4-W3;
// audit docs/design/2026-07-29-comm-flow-smoothness-audit.md §2.4 (the reconnect burst) and §2.5
// (producer proliferation / private queues). The Wave-1 arbiter and the real createGating are
// exercised directly; only true boundaries are faked (live session, store, broadcast sinks, time —
// caller-supplied `now`).
//
// ── Pinned Wave-3 contract (the implementer builds EXACTLY this seam) ──────────────────────────
//   src/gating/index.ts gains:
//     export const RECONNECT_QUIET_MS = 30_000;
//     reannounceSurvivors(session, now?: number)   // now defaults Date.now() — caller-supplied for tests
//   Threshold semantics (audit §2.4 — "a 4-second blip and a 4-hour absence must not replay
//   identically"):
//     • lastDetachAt !== null && now - lastDetachAt < RECONNECT_QUIET_MS  →  QUIET RE-ATTACH:
//       orphans re-attach (fresh TTL) and the UI chips repopulate exactly as today, but there is
//       ZERO spoken ceremony — no narration-slot push AND no arbiter submission — and the away
//       window is NOT consumed (in-memory + KV stamp preserved), so nothing is ever lost: the
//       events land in the next catch-up / next genuine-absence digest.
//     • otherwise (lastDetachAt === null — a FIRST connect — or the absence reached the
//       threshold) → the ceremony runs; with an injected turnArbiter it routes as submissions
//       (survivors digest = class 2, actionable deadline-carrying truth; away digest = class 5,
//       passive context), never an immediate forced turn; with NO arbiter (legacy) the slot pushes
//       stay byte-identical to today.
//     • The threshold gates the CEREMONY, not the mechanics — and it applies with or without an
//       arbiter injected (a blip is a blip in legacy harnesses too).
//   src/voice/index.ts:
//     • The pushSignal private queue is DELETED — `deferredReady`, `armReadyDrain`,
//       `readyDrainTimer`, `READY_DEFER_MAX_MS` all fold into the arbiter (audit §2.5: no more
//       cross-queue wall-clock accidents). Deferral/coalescing now live in ONE place.
//     • export function paneSignalClass(kind: string): 4 | 5 — "created"/"closed" (the
//       operator-facing acks the old trichotomy gated) are class 4; every other signal kind
//       (idle/error/prompt/exited/running/quiescing) is class 5 passive context.
//       NOTE the deliberate semantic change: the old queue DROPPED a >10s-stale ready and
//       SUPPRESSED on barge-in; the arbiter never drops (core invariant) — staleness/noise is
//       handled by D2's headline + counted tail + the visual stack instead.
//
// Runner: npx tsx --test --test-force-exit tests/test_reconnect_quiet_threshold.ts

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGating } from "../src/gating";
import * as gatingModule from "../src/gating";
import * as voiceIndexModule from "../src/voice/index";
import { createTurnArbiter } from "../src/voice/turnArbiter";

type AnyRec = Record<string, any>;

const gatingMod = gatingModule as AnyRec;
const voiceIndex = voiceIndexModule as AnyRec;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const T0 = 1_700_000_000_000;
const QUIET = 30_000; // the pinned RECONNECT_QUIET_MS value (export asserted below)
const AWAY_KV = "gating.lastDetachAt"; // the existing 4D.1 KV mirror key (src/gating/index.ts)

// ── harness: real gating, fake boundaries, optional injected arbiter, KV-observable store ──────

/** Minimal store fake: KV is a real observable map (the away-window stamp lives there); every
 *  other surface gating touches on these paths is an inert stub. */
function fakeStore() {
  const kv = new Map<string, string>();
  return {
    kv,
    getKV: (k: string) => kv.get(k),
    setKV: (k: string, v: string) => { kv.set(k, v); },
    recordActivity: () => {},
    getEvents: () => [],
    getExpiredApprovals: () => [],
    insertPendingApproval: () => {},
    deletePendingApproval: () => {},
    claimApproval: () => true,
    getPendingActions: () => [],
    insertPendingAction: () => {},
    deletePendingAction: () => {},
    claimAction: () => true,
  };
}

function makeHarness(opts: { arbiter?: AnyRec; store?: AnyRec } = {}) {
  const narrations: string[] = [];
  const broadcasts: AnyRec[] = [];
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
    activeLiveSession: null,
    clients: new Set(),
    activePaneId: null,
    frozen: false,
    lastStopAllFailed: [],
    setFrozen: () => {},
  };
  // deps is `any` on purpose: `turnArbiter` is the Wave-2 optional member.
  const deps: any = {
    manager,
    store: opts.store ?? null,
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
  // AnyRec on purpose: the pinned Wave-3 `reannounceSurvivors(session, now?)` widening does not
  // exist on today's Gating type yet — the cast keeps tsc green while the suite is RED.
  const gating: AnyRec = createGating(deps) as AnyRec;
  return { gating, narrations, broadcasts, coreState };
}

/** Seam probe: records every submitted item. */
function captureArbiter() {
  const submitted: AnyRec[] = [];
  return { submitted, submit: (item: AnyRec) => { submitted.push(item); }, floorPausedMs: () => 0 };
}

function addApproval(gating: AnyRec, session: AnyRec, id = "d1", ts = T0 - 60_000): void {
  gating.pendingApprovals.add(
    { messageId: id, instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: id, timestamp: ts } as any,
    session,
  );
}

/** Stage a detached-mid-flight survivor: an approval bound to the OLD session, then a detach. */
function stageBlip(h: AnyRec, oldSession: AnyRec, detachAt: number): void {
  addApproval(h.gating, oldSession);
  h.gating.pendingApprovals.detachSession(oldSession);
  h.gating.noteSessionDetached(detachAt);
}

// ── the pinned constant ────────────────────────────────────────────────────────────────────────

test("W3 yg1w — RECONNECT_QUIET_MS is exported from src/gating and pinned at 30s", () => {
  assert.strictEqual(gatingMod.RECONNECT_QUIET_MS, 30_000,
    "Wave-3 feature absent: src/gating/index.ts must export RECONNECT_QUIET_MS = 30_000 " +
      "(spec §3.3 row 7 — the away-duration notion the reconnect pipeline lacks today)");
});

// ── sub-threshold: silent re-attach, nothing spoken, nothing lost ──────────────────────────────

test("W3 yg1w — a sub-threshold blip re-attaches silently: no ceremony, chips repopulate, window preserved", () => {
  const cap = captureArbiter();
  const store = fakeStore();
  const h = makeHarness({ arbiter: cap, store });
  const sA = { sendClientContent: () => {} };
  const sB = { sendClientContent: () => {} };
  stageBlip(h, sA, T0);
  assert.strictEqual(store.kv.get(AWAY_KV), String(T0), "precondition: the detach stamped the away window");

  h.gating.reannounceSurvivors(sB, T0 + 5_000); // a 5s blip the operator never perceived

  assert.strictEqual(h.narrations.length, 0,
    "Wave-3 feature absent: a sub-threshold reconnect must produce ZERO spoken ceremony — no " +
      "'Welcome back' mid-flow (audit §2.4; spec §4-W3 acceptance)");
  assert.strictEqual(cap.submitted.length, 0,
    "silent means SILENT: the quiet path submits nothing to the arbiter either — the events ride " +
      "the next catch-up/digest instead");
  assert.notStrictEqual(h.gating.pendingApprovals.sessionFor("d1"), undefined,
    "the MECHANICS still run: the orphan re-attaches to the fresh session (fresh TTL window)");
  assert.ok(h.broadcasts.length >= 1, "chips still repopulate (the UI is not the spoken channel)");
  assert.strictEqual(store.kv.get(AWAY_KV), String(T0),
    "told-more floor: the away window is NOT consumed by a quiet re-attach — a later genuine " +
      "digest still covers everything since the ORIGINAL detach (never lost, only deferred)");

  // Just under the line is still quiet (strict <).
  h.gating.pendingApprovals.detachSession(sB);
  h.gating.reannounceSurvivors(sB, T0 + QUIET - 1);
  assert.strictEqual(h.narrations.length, 0, "29.999s is still a blip");
  assert.strictEqual(cap.submitted.length, 0);
});

// ── at/above threshold: the ceremony routes through the arbiter as class-2/5 submissions ───────

test("W3 yg1w — a genuine absence (>= threshold) runs the ceremony via arbiter submissions, never a forced turn", () => {
  const cap = captureArbiter();
  const store = fakeStore();
  const h = makeHarness({ arbiter: cap, store });
  const sA = { sendClientContent: () => {} };
  const sB = { sendClientContent: () => {} };
  stageBlip(h, sA, T0);

  h.gating.reannounceSurvivors(sB, T0 + QUIET); // exactly the threshold: genuine absence

  assert.strictEqual(h.narrations.length, 0,
    "Wave-3 feature absent: with an arbiter injected the ceremony must SUBMIT, not force an " +
      "immediate spoken turn through the slot (spec §3.3 row 7 — 'ceremony via class 2/5 submissions')");
  assert.ok(cap.submitted.length >= 1, "the ceremony reached the arbiter");
  const survivor = cap.submitted.find((it) => /npm run deploy|t1/.test(it.facts ?? ""));
  assert.ok(survivor, `one submission carries the survivors digest naming the waiting command/pane, got: ${JSON.stringify(cap.submitted.map((i) => i.facts))}`);
  assert.strictEqual(survivor!.cls, 2,
    "the survivors digest is actionable deadline-carrying truth — class 2 (approvals re-opened a fresh TTL window)");
  assert.match(survivor!.facts, /welcome|waiting|still/i, "facts convey the welcome-back resumption");
  assert.ok(cap.submitted.every((it) => it.cls === 2 || it.cls === 5),
    "every ceremony submission is class 2 (actionable) or class 5 (away-digest passive context)");
  assert.notStrictEqual(h.gating.pendingApprovals.sessionFor("d1"), undefined, "re-attach unchanged");
  assert.strictEqual(store.kv.get(AWAY_KV), "",
    "a GENUINE ceremony consumes the away window exactly as today (a flapping reconnect never replays the same news)");
});

// ── blip then genuine absence: the deferred ceremony still happens — never lost ────────────────

test("W3 yg1w — a quiet blip DEFERS the ceremony; a later genuine reconnect (from the ORIGINAL detach) still delivers it", () => {
  const cap = captureArbiter();
  const store = fakeStore();
  const h = makeHarness({ arbiter: cap, store });
  const sA = { sendClientContent: () => {} };
  const sB = { sendClientContent: () => {} };
  const sC = { sendClientContent: () => {} };
  stageBlip(h, sA, T0);

  // Blip at +5s: silent, window stays open.
  h.gating.reannounceSurvivors(sB, T0 + 5_000);
  assert.strictEqual(h.narrations.length, 0,
    "Wave-3 feature absent: the sub-threshold reconnect must be silent (see the quiet-path test)");
  assert.strictEqual(cap.submitted.length, 0);

  // A second drop at +6s must not shrink the window (earliest-detach-wins is existing 4D.1 law).
  h.gating.pendingApprovals.detachSession(sB);
  h.gating.noteSessionDetached(T0 + 6_000);
  assert.strictEqual(store.kv.get(AWAY_KV), String(T0), "earliest detach wins — the window anchors at the ORIGINAL blip");

  // Genuine reconnect at +31s FROM THE ORIGINAL DETACH: the deferred ceremony fires now.
  h.gating.reannounceSurvivors(sC, T0 + 31_000);
  assert.strictEqual(h.narrations.length, 0, "still no forced turn — submissions only");
  const survivor = cap.submitted.find((it) => it.cls === 2 && /npm run deploy|t1/.test(it.facts ?? ""));
  assert.ok(survivor,
    "told-more beats silently-missed: the blip only DEFERRED the ceremony — the genuine absence " +
      `must still surface the waiting approval, got: ${JSON.stringify(cap.submitted.map((i) => i.facts))}`);
  assert.strictEqual(store.kv.get(AWAY_KV), "", "and only the genuine ceremony consumes the window");
});

// ── a FIRST connect is not a blip: null lastDetachAt keeps today's full ceremony ───────────────

test("W3 yg1w — first connect (no prior detach) is NEVER treated as quiet: survivors are announced", () => {
  const cap = captureArbiter();
  const store = fakeStore();
  const h = makeHarness({ arbiter: cap, store });
  const sB = { sendClientContent: () => {} };
  // A restart-hydrated survivor: no session ever attached (orphan-shaped), no detach ever noted.
  addApproval(h.gating, undefined as any);

  h.gating.reannounceSurvivors(sB, T0);

  assert.strictEqual(h.narrations.length, 0,
    "Wave-3 feature absent: the ceremony must route through the injected arbiter (no forced turn)");
  const survivor = cap.submitted.find((it) => it.cls === 2 && /npm run deploy|t1/.test(it.facts ?? ""));
  assert.ok(survivor,
    "lastDetachAt === null means 'first connect', NOT 'quiet blip' — a cold boot with waiting " +
      "approvals must still speak its resumption digest");
});

// ── the threshold is arbiter-independent: legacy harnesses get the quiet path too ──────────────

test("W3 yg1w — legacy (no arbiter): a blip is silent, a genuine absence keeps today's slot ceremony byte-identical", () => {
  const store = fakeStore();
  const h = makeHarness({ store }); // NO turnArbiter injected
  const sA = { sendClientContent: () => {} };
  const sB = { sendClientContent: () => {} };
  stageBlip(h, sA, T0);

  h.gating.reannounceSurvivors(sB, T0 + 5_000);
  assert.strictEqual(h.narrations.length, 0,
    "Wave-3 feature absent: the quiet threshold gates the ceremony in LEGACY mode too — a 5s blip " +
      "must not replay 'Welcome back' just because no arbiter is wired");
  assert.strictEqual(store.kv.get(AWAY_KV), String(T0), "window preserved in legacy mode as well");

  // Genuine absence: the legacy slot ceremony is unchanged (fallback parity, spec §3.4 spirit).
  h.gating.pendingApprovals.detachSession(sB);
  h.gating.reannounceSurvivors(sB, T0 + 31_000);
  assert.ok(h.narrations.some((n) => /welcome back/i.test(n) && /npm run deploy|t1/.test(n)),
    "with no arbiter injected the genuine-absence ceremony still speaks through the legacy slot");
});

// ── use-case (b) told-more floor: away-digest TRUTH survives the quiet path, exactly once ──────

test("W3 yg1w — a pane failure during the absence reaches the operator exactly once: not on the blip, on the genuine reconnect, never twice", () => {
  const cap = captureArbiter();
  const store = fakeStore();
  // A run FAILED while the operator was away (ts inside the away window) — the durable row the
  // 4D.1 away digest replays. Every other reconnect test uses an empty-events store, which lets an
  // implementation route only the SURVIVORS digest through the arbiter and silently drop
  // composeAwayDigest — the exact "silently-missed" defect this program forbids.
  const rows = [{
    ts: T0 + 1_000,
    type: "status_transition",
    project_id: "default_project",
    pane_id: "p7",
    summary: "completion_failed",
    payload: { transition: "completion_failed" },
  }];
  (store as AnyRec).getEvents = (f: AnyRec) => rows.filter((r) => r.type === f?.type);
  const h = makeHarness({ arbiter: cap, store });
  const sA = { sendClientContent: () => {} };
  const sB = { sendClientContent: () => {} };
  const sC = { sendClientContent: () => {} };
  stageBlip(h, sA, T0);

  // Quiet blip at +5s: the failure is NOT narrated now — and not lost either.
  h.gating.reannounceSurvivors(sB, T0 + 5_000);
  assert.strictEqual(h.narrations.length, 0,
    "Wave-3 feature absent: the sub-threshold reconnect must be silent (audit §2.4)");
  assert.strictEqual(cap.submitted.length, 0, "the away failure must NOT leak through the quiet path");

  // Genuine reconnect at +31s: the DEFERRED away digest carries the failure as class-5 context.
  h.gating.pendingApprovals.detachSession(sB);
  h.gating.reannounceSurvivors(sC, T0 + 31_000);
  assert.strictEqual(h.narrations.length, 0, "ceremony routes as submissions, never a forced turn");
  const away = cap.submitted.find((it) => it.cls === 5 && /p7/.test(it.facts ?? "") && /error/i.test(it.facts ?? ""));
  assert.ok(away,
    "use case (b): a pane that FAILED during the absence must surface in the away digest after a " +
      "real absence — quiet re-attach defers the news, it never eats it (told-more floor), got: " +
      JSON.stringify(cap.submitted.map((i) => [i.cls, i.facts])));

  // And never twice: after the genuine ceremony consumed the window, a later real absence starts a
  // FRESH window that excludes the old row — a flapping reconnect never replays the same news.
  const before = cap.submitted.length;
  h.gating.pendingApprovals.detachSession(sC);
  h.gating.noteSessionDetached(T0 + 40_000);
  h.gating.reannounceSurvivors(sC, T0 + 80_000);
  const replayed = cap.submitted.slice(before).find((it) => /p7/.test(it.facts ?? ""));
  assert.strictEqual(replayed, undefined,
    `the consumed window must never replay pane p7's failure, got: ${JSON.stringify(replayed)}`);
});

// ── the private-queue fold: deferredReady/armReadyDrain die; the arbiter owns deferral ─────────

test("W3 fold — the pushSignal private queue is deleted from src/voice/index.ts", () => {
  const src = readFileSync(path.join(repoRoot, "src", "voice", "index.ts"), "utf8");
  const lines = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
  for (const banned of ["deferredReady", "armReadyDrain", "readyDrainTimer", "READY_DEFER_MAX_MS"]) {
    const hits = lines.filter((l) => l.includes(banned)).length;
    assert.strictEqual(hits, 0,
      `Wave-3 feature absent: the pane-signal private queue must FOLD into the arbiter (spec §3.3 ` +
        `row 6; audit §2.5 — no more private hold-queues) — "${banned}" still appears on ${hits} ` +
        "non-comment line(s) of src/voice/index.ts");
  }
});

test("W3 fold — paneSignalClass maps created/closed to class 4 (acks) and every other kind to class 5", () => {
  assert.strictEqual(typeof voiceIndex.paneSignalClass, "function",
    "Wave-3 feature absent: src/voice/index.ts must export paneSignalClass(kind) — the ONE " +
      "classifier deciding which arbiter class a pane signal submits as (spec §3.3 row 6)");
  for (const kind of ["created", "closed"]) {
    assert.strictEqual(voiceIndex.paneSignalClass(kind), 4, `"${kind}" is an operator-facing ack — class 4`);
  }
  for (const kind of ["idle", "error", "prompt", "exited", "running", "quiescing"]) {
    assert.strictEqual(voiceIndex.paneSignalClass(kind), 5, `"${kind}" is passive context — class 5`);
  }
});

test("W3 fold — wiring: pushSignal actually routes through paneSignalClass (a classifier nobody calls gates nothing)", () => {
  // The operator reality this pins: deleting deferredReady/armReadyDrain WITHOUT routing pane
  // signals through the classifier+arbiter would regress created/closed acks to ungated immediate
  // pushes (the original mid-utterance jump-over) — or drop them outright — while the export-shape
  // and queue-deletion tests above stay green. The classifier must be consumed, not decorative.
  const src = readFileSync(path.join(repoRoot, "src", "voice", "index.ts"), "utf8");
  const lines = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
  const mentions = lines.filter((l) => /\bpaneSignalClass\b/.test(l)).length;
  assert.ok(mentions >= 2,
    "Wave-3 feature absent: src/voice/index.ts must define paneSignalClass AND call it on the " +
      `pushSignal path (spec §3.3 row 6) — found ${mentions} non-comment mention(s), need the ` +
      "definition plus at least one call site");
});

test("W3 fold — folded signals ride the arbiter: acks defer mid-utterance, never staleness-drop, one drain", () => {
  const clsAck = voiceIndex.paneSignalClass?.("created");
  const clsCtx = voiceIndex.paneSignalClass?.("idle");
  assert.strictEqual(clsAck, 4,
    "Wave-3 feature absent: paneSignalClass must exist before the fold behavior can be exercised");
  assert.strictEqual(clsCtx, 5);

  const arb = createTurnArbiter();
  arb.submit({ facts: "pane p1 is up and ready", cls: clsAck, paneId: "p1", coalesceKey: "ready-ack:p1" });
  arb.submit({ facts: "context: pane p3 went idle", cls: clsCtx, paneId: "p3" });

  // Mid-utterance: everything holds — the old queue's job, now the arbiter's.
  assert.strictEqual(arb.evaluate({ now: T0, floorHeld: true, turnClear: false }).action, "hold");
  // 12s later (beyond the old READY_DEFER_MAX_MS=10s): the arbiter NEVER staleness-drops — the
  // old queue's silent drop is replaced by D2's counted tail + the visual stack (told-more floor).
  assert.strictEqual(arb.evaluate({ now: T0 + 12_000, floorHeld: true, turnClear: false }).action, "hold");

  const d: AnyRec = arb.evaluate({ now: T0 + 15_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "turn-clear drains — deferred means later, never never");
  assert.strictEqual(d.digest.headline.cls, 4, "the ack (class 4) headlines over passive context (class 5)");
  assert.ok(d.digest.headline.facts.includes("p1"));
  assert.deepStrictEqual(d.digest.tail.map((t: AnyRec) => t.facts), ["context: pane p3 went idle"],
    "the idle context rides the counted tail of the SAME single spoken turn");
  assert.strictEqual(arb.evaluate({ now: T0 + 15_001, floorHeld: false, turnClear: true }).action, "hold",
    "one spoken turn per turn-clear — the cross-queue wall-clock accident is dead");
});
