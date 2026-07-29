// tests/test_turn_arbiter_journeys.ts — Wave 4 RED: T3 journey replays (the three canonical
// collisions) + the D3 "[7. VOICE OUTPUT RULES]" narration-guidance block + the drain renderer /
// production wiring that turns Waves 1-3's submit-only seams into an audible end-to-end path.
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md §3.1 (Rendering, D3), §3.3, §4-W4,
// §5-T3; audit docs/design/2026-07-29-comm-flow-smoothness-audit.md §2.1/§2.4/§2.5.
//
// Journey idiom: follows tests/test_return_channel_journeys.ts (describe-per-journey, REAL modules
// composed end to end, exactly-once counting at every notification-bearing edge) — but NOT its full
// server boot: the collisions under test are driven by the gating TTL sweep (5-minute TTLs) and the
// ack-state floor, both of which are only reachable deterministically through the caller-supplied
// `now` seams Waves 1-3 pinned (`sweepExpiredApprovals(now)`, `reannounceSurvivors(session, now)`,
// `evaluate({ now, ... })`). A mockLive server boot cannot advance those clocks. So each journey
// exercises the REAL createGating + the REAL createTurnArbiter + the REAL pure voice modules
// (completionPolicy, paneSignalClass, formatPaneSignal, renderArbiterDigest) and fakes ONLY true
// boundaries: time (caller-supplied now), live sessions, store, broadcast sinks — exactly the
// harness tests/test_turn_arbiter_deadlines.ts and tests/test_reconnect_quiet_threshold.ts built.
//
// ── Pinned Wave-4 contract (the implementer builds EXACTLY this seam) ──────────────────────────
//  1. src/voice/index.ts exports a PURE drain renderer (same home + style as composeBriefEnvelope):
//       renderArbiterDigest(digest: Digest, mode: DeliveryMode): { text: string; turnComplete: boolean }
//     - The text is a STRUCTURED digest injection (D3: facts, not a scripted sentence): the
//       headline item's `facts` appear VERBATIM and FIRST — before any tail content.
//     - tailCount > 0 → the text carries the tail: the COUNT (digit form) is present, each tail
//       item's `facts` ride along as context (so the model can actually answer "give me the
//       rundown" — D2 told-more floor), and the text offers the rundown (the spec's own word:
//       "ask for the rundown").
//     - tailCount === 0 → no counted-tail scaffolding and no rundown offer (nothing to run down).
//     - mode forced-turn | steered-digest → turnComplete: true (the injection completes the turn;
//       the model MUST speak — its words, our timing).
//     - mode passive-context → turnComplete: false AND the text is BACKGROUND-framed by REUSING
//       applyBackgroundFraming (fikj.8 Leg B machinery, verbatim — spec §3.1 D3).
//  2. src/voice/index.ts consumes the renderer on its drain path (a renderer nobody calls renders
//     nothing): >= 2 non-comment mentions (definition + call site).
//  3. server.ts wires ONE shared arbiter into production (the gap that keeps today's prod behavior
//     the audit's §2.1 forced mid-answer hijack): createTurnArbiter(...) is constructed and passed
//     as `turnArbiter` into BOTH the createGating deps AND the attachVoiceSession deps (both sides
//     already declare the optional member — src/gating/index.ts GatingDeps, src/voice/index.ts
//     VoiceDeps).
//  4. DEFAULT_SYSTEM_PROMPT's "[7. VOICE OUTPUT RULES]" gains the D3 narration-guidance block:
//     lead with the worst, headline + counted tail, offer the rundown. Phrasing stays the model's
//     (no verbatim scripts) — these are content-invariants in the tests/test_answer_first_ordering.ts
//     style, not byte pins.
//  The +14d watch bead is the ORCHESTRATOR's at land — deliberately NOT created or asserted here.
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_journeys.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGating } from "../src/gating";
import { APPROVAL_GRACE_MS } from "../src/pendingApprovals";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { completionNarration, DEFAULT_COMPLETION_ANNOUNCE } from "../src/voice/completionPolicy";
import { formatPaneSignal } from "../src/paneSignals";
import { buildSystemInstruction } from "../src/voice/systemPrompt";
// Namespace import (the tests/test_answer_first_ordering.ts idiom): a static named import of the
// not-yet-existing renderArbiterDigest would be a hard module-link crash taking down every test in
// this file. The namespace object always resolves; the missing export reads back as `undefined`,
// which each test asserts on explicitly (a clean, diagnosable per-test failure).
import * as voiceIndexModule from "../src/voice/index";

type AnyRec = Record<string, any>;

const voiceIndex = voiceIndexModule as AnyRec;
const renderArbiterDigest = voiceIndex.renderArbiterDigest as
  | ((digest: AnyRec, mode: string) => { text: string; turnComplete: boolean })
  | undefined;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const T0 = 1_700_000_000_000;
const TTL = 5 * 60 * 1000; // gating's APPROVAL_TTL_MS (pinned by the existing gating suite)
const GRACE = APPROVAL_GRACE_MS; // 60s
const S1 = T0 + TTL + 1; // the first sweep tick past the TTL — the last-call moment
const QUIET = 30_000; // RECONNECT_QUIET_MS (exported + pinned by tests/test_reconnect_quiet_threshold.ts)
const AWAY_KV = "gating.lastDetachAt"; // the 4D.1 KV mirror key

// ── harness: real gating, real arbiter, fake boundaries (deadlines/reconnect-suite idiom) ──────

/** Minimal store fake with a REAL observable KV map (the away-window stamp lives there). */
function fakeStore() {
  const kv = new Map<string, string>();
  return {
    kv,
    getKV: (k: string) => kv.get(k),
    setKV: (k: string, v: string) => { kv.set(k, v); },
    recordActivity: () => {},
    getEvents: () => [] as AnyRec[],
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

/** MockLiveSession-shaped capture stub: same `clientContents` surface the return-channel journeys
 *  assert against, no real socket. */
function fakeLiveSession() {
  const clientContents: AnyRec[] = [];
  return { clientContents, sendClientContent: (c: AnyRec) => { clientContents.push(c); } };
}

function makeHarness(opts: { arbiter?: AnyRec; store?: AnyRec } = {}) {
  const narrations: string[] = [];
  const broadcasts: AnyRec[] = [];
  const session = fakeLiveSession();
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
    setFrozen: () => {},
  };
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
  const gating: AnyRec = createGating(deps) as AnyRec;
  return { gating, narrations, broadcasts, session, coreState };
}

function addApproval(gating: AnyRec, session: AnyRec, id = "d1", ts = T0): void {
  gating.pendingApprovals.add(
    { messageId: id, instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: id, timestamp: ts } as any,
    session,
  );
}

function sliceBetween(content: string, startMarker: string, endMarker: string): string {
  const startIdx = content.indexOf(startMarker);
  assert.ok(startIdx >= 0, `expected to find anchor ${JSON.stringify(startMarker)}`);
  const endIdx = content.indexOf(endMarker, startIdx + startMarker.length);
  assert.ok(endIdx >= 0, `expected to find anchor ${JSON.stringify(endMarker)} after the start anchor`);
  return content.slice(startIdx, endIdx);
}

function nonCommentLines(source: string): string[] {
  return source.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
}

const RED_RENDERER_MSG =
  "Wave-4 feature absent: src/voice/index.ts must export the pure drain renderer " +
  "renderArbiterDigest(digest, mode) -> { text, turnComplete } (spec §3.1 Rendering/D3; same " +
  "pure-exported home as composeBriefEnvelope/applyBackgroundFraming)";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Journey 0 — the production wiring gap. Waves 1-3 built submit-capable seams that server.ts never
// injects: in PROD today the sweep still forces "SYSTEM EVENT (say this...)" turns mid-answer
// (legacy fallback), completions submit into `undefined`, and the pane-ack arbiter is a private
// per-closure instance. W4 closes the loop: ONE shared arbiter, wired everywhere, drained through
// the renderer. Source-anchored (the closures are unreachable from a unit test) — the same
// technique tests/test_answer_first_ordering.ts uses for its send-site wiring pins.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("journey 0: ONE shared arbiter is wired into production (server.ts) and drained through the renderer", () => {
  const serverSource = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
  const voiceSource = fs.readFileSync(path.join(repoRoot, "src", "voice", "index.ts"), "utf8");

  it("server.ts constructs a shared turn arbiter (createTurnArbiter) at boot", () => {
    const hits = nonCommentLines(serverSource).filter((l) => l.includes("createTurnArbiter(")).length;
    assert.ok(hits >= 1,
      "Wave-4 feature absent: server.ts must construct ONE shared createTurnArbiter(...) instance " +
        "at boot (spec §3.3 — one module owns every model-bound send; audit §2.5). Today no arbiter " +
        `exists in production wiring at all — found ${hits} non-comment mention(s)`);
  });

  it("the createGating deps in server.ts inject the shared arbiter (the five timer call-sites divert)", () => {
    const block = sliceBetween(serverSource, "const gating = createGating({", "});");
    assert.ok(/\bturnArbiter\b/.test(block),
      "Wave-4 feature absent: server.ts's createGating deps must pass `turnArbiter` — without it " +
        "the Wave-2 re-route is dead code and every sweep last-call still lands as a forced " +
        "mid-answer turn in production (audit §2.1, the highest-severity jump-over)");
  });

  it("the attachVoiceSession deps in server.ts inject the SAME shared arbiter (completions/acks join the one queue)", () => {
    const block = sliceBetween(serverSource, "attachVoiceSession(wss, {", "});");
    assert.ok(/\bturnArbiter\b/.test(block),
      "Wave-4 feature absent: server.ts's attachVoiceSession deps must pass `turnArbiter` — " +
        "without it vc-C class-3 completions submit into undefined and the pane-ack fold keeps a " +
        "PRIVATE per-connection arbiter, resurrecting the cross-queue wall-clock accident the " +
        "program exists to kill (audit §2.5)");
  });

  it("src/voice/index.ts defines AND calls renderArbiterDigest on its drain path", () => {
    const mentions = nonCommentLines(voiceSource).filter((l) => /\brenderArbiterDigest\b/.test(l)).length;
    assert.ok(mentions >= 2,
      "Wave-4 feature absent: src/voice/index.ts must define renderArbiterDigest AND consume it " +
        "where a DrainDecision becomes a sendClientContent (a renderer nobody calls renders " +
        `nothing) — found ${mentions} non-comment mention(s), need the definition plus a call site`);
  });

  it("src/voice/index.ts defines AND calls digestSendPlan on its drain path (the interrupt arm is handled, not dropped)", () => {
    // Adversarial-review regression (never-drop): the drain tick used to send ONLY on
    // decision.action === "drain", silently discarding "interrupt-at-phrase-boundary" — whose item
    // the arbiter has ALREADY dequeued (exactly-once), so the cap-consumed last-call vanished
    // without ever being spoken (D1 cap defeated + a silent-drop path). digestSendPlan is the pure
    // mapper that makes both deliverable arms unskippable; it must be consumed on the tick.
    const mentions = nonCommentLines(voiceSource).filter((l) => /\bdigestSendPlan\b/.test(l)).length;
    assert.ok(mentions >= 2,
      "src/voice/index.ts must define digestSendPlan AND consume it on the drain tick — found " +
        `${mentions} non-comment mention(s), need the definition plus a call site`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// digestSendPlan — the pure DrainDecision -> send mapper (adversarial-review regression pin).
// An "interrupt-at-phrase-boundary" decision carries an item the arbiter ALREADY dequeued; a
// caller that only handles "drain" vanishes it. The plan must deliver it as a forced turn.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("digestSendPlan: every deliverable DrainDecision arm is sent — the D1 interrupt is never dropped", () => {
  const digestSendPlan = voiceIndex.digestSendPlan as
    | ((decision: AnyRec) => { send: false } | { send: true; digest: AnyRec; mode: string })
    | undefined;

  it("hold -> no send; drain -> the digest in its own mode", () => {
    assert.strictEqual(typeof digestSendPlan, "function",
      "src/voice/index.ts must export digestSendPlan (the pure drain-tick decision mapper)");
    assert.deepStrictEqual(digestSendPlan!({ action: "hold" }), { send: false });
    const digest = { headline: { facts: "f", cls: 5, forVisualStack: false }, tail: [], tailCount: 0, tailGroups: [] };
    const drained = digestSendPlan!({ action: "drain", digest, mode: "passive-context" });
    assert.deepStrictEqual(drained, { send: true, digest, mode: "passive-context" });
  });

  it("interrupt-at-phrase-boundary -> SENT, as a forced turn (the cap-consumed last-call must be spoken, exactly once)", () => {
    assert.strictEqual(typeof digestSendPlan, "function",
      "src/voice/index.ts must export digestSendPlan (the pure drain-tick decision mapper)");
    // End-to-end with the REAL arbiter: consume the cap, get the interrupt, and prove the plan
    // delivers the very item the arbiter dequeued (told-more beats silently-missed).
    const arb = createTurnArbiter();
    arb.submit({
      facts: "approve the deploy now or I'll drop it", cls: 2, coalesceKey: "last-call:d9",
      deadline: { expiresAt: T0 + 1_000, onExpirySwap: "the deploy approval expired — I cancelled it" },
    });
    arb.evaluate({ now: T0, floorHeld: true, turnClear: false });
    const intr: AnyRec = arb.evaluate({ now: T0 + 61_000, floorHeld: true, turnClear: false });
    assert.strictEqual(intr.action, "interrupt-at-phrase-boundary", "precondition: the D1 cap interrupt fired");
    const plan = digestSendPlan!(intr);
    assert.ok(plan.send, "the interrupt decision must be SENT — the arbiter already dequeued the item (exactly-once)");
    assert.strictEqual((plan as AnyRec).mode, "forced-turn",
      "an interrupt completes the turn — the deadline stopped waiting (D1 cap)");
    assert.strictEqual((plan as AnyRec).digest.headline.coalesceKey, "last-call:d9",
      "the delivered digest is the dequeued last-call itself");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Journey 1 — canonical collision 1 (spec §4-W4): a last-call fires while the operator holds the
// floor mid-answer. It must DEFER (no forced turn), its TTL must PAUSE (D1 — the deadline waits
// for you), and at turn-clear it drains as the HEADLINE of one forced-turn digest.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("journey 1: mid-answer last-call — defers with paused TTL, then headlines at turn-clear", () => {
  it("sweep mid-floor -> silent defer + TTL pause; turn-clear -> ONE forced-turn digest headlined by the last-call; approval still alive", () => {
    const arb = createTurnArbiter();
    const h = makeHarness({ arbiter: arb as any });
    addApproval(h.gating, h.session);

    // The sweep last-call fires while the operator is mid-answer: NO immediate forced turn.
    h.gating.sweepExpiredApprovals(S1);
    assert.strictEqual(h.narrations.length, 0,
      "the timer last-call must divert through the arbiter, never the immediate slot (W2 seam, " +
        "exercised here as journey glue)");

    // The operator holds the floor for 20s — the arbiter defers AND accrues the D1 pause.
    assert.strictEqual(arb.evaluate({ now: S1, floorHeld: true, turnClear: false }).action, "hold",
      "mid-floor the last-call DEFERS — no jump-over");
    assert.strictEqual(arb.evaluate({ now: S1 + 20_000, floorHeld: true, turnClear: false }).action, "hold");
    assert.strictEqual(arb.floorPausedMs("last-call:d1"), 20_000, "the pause clock tracked the held floor");

    // Grace alone has elapsed — but 20s of it was the operator's. The deadline waited (D1).
    h.gating.sweepExpiredApprovals(S1 + GRACE + 1);
    assert.ok(h.gating.pendingApprovals.has("d1"),
      "D1: the sweep consults floorPausedMs — the paused span extends the approval's life");

    // Turn-clear: exactly ONE drain, headlined by the still-actionable last-call.
    const d: AnyRec = arb.evaluate({ now: S1 + GRACE + 2_000, floorHeld: false, turnClear: true });
    assert.strictEqual(d.action, "drain", "the deferred last-call drains at the first turn-clear");
    assert.strictEqual(d.digest.headline.cls, 2, "deadline narrations headline (class 2)");
    assert.strictEqual(d.digest.headline.coalesceKey, "last-call:d1");
    assert.match(d.digest.headline.facts, /approve|drop/i,
      "inside the extended grace the operator hears the ACTIONABLE last-call, not a premature expiry");
    assert.strictEqual(d.mode, "forced-turn", "class-2 headlines drain forced-turn by default (D4 matrix)");

    // The Wave-4 spoken edge: the digest renders to ONE turn-completing injection.
    assert.strictEqual(typeof renderArbiterDigest, "function", RED_RENDERER_MSG);
    const rendered = renderArbiterDigest!(d.digest, d.mode);
    assert.strictEqual(rendered.turnComplete, true,
      "forced-turn mode completes the turn — the model MUST speak (its words, our timing — D3)");
    assert.ok(rendered.text.includes(d.digest.headline.facts),
      "the headline facts ride the injection VERBATIM (D3: structured facts, the model does the phrasing)");
    assert.ok(!/rundown/i.test(rendered.text),
      "an empty tail offers no rundown — there is nothing to run down");

    // Exactly-once: the drain consumed the queue; nothing re-drains, nothing was duplicated.
    assert.strictEqual(arb.evaluate({ now: S1 + GRACE + 2_001, floorHeld: false, turnClear: true }).action, "hold",
      "one spoken turn per turn-clear — the last-call never replays");
    assert.ok(h.gating.pendingApprovals.has("d1"),
      "the operator HEARD the last-call and the approval is still actionable — the deadline waited");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Journey 2 — canonical collision 2 (spec §4-W4, yg1w): a transient socket blip mid-conversation.
// Sub-threshold: ZERO spoken ceremony, zero arbiter traffic, no event loss. The deferred ceremony
// then lands after a GENUINE absence as ONE prioritized digest (survivors headline, away-digest
// truth in the counted tail) — told-more beats silently-missed, end to end.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("journey 2: transient blip stays silent — the deferred ceremony lands as ONE digest at the next turn-clear", () => {
  it("5s blip -> silence + nothing queued; genuine absence -> survivors headline + away failure in the tail, rendered once", () => {
    const arb = createTurnArbiter();
    const store = fakeStore();
    // A pane FAILED during the absence — the durable row the away digest replays. Without it a
    // quiet path could silently eat real news and this journey would prove nothing about loss.
    (store as AnyRec).getEvents = (f: AnyRec) => (f?.type === "status_transition"
      ? [{ ts: T0 + 1_000, type: "status_transition", project_id: "default_project", pane_id: "p7",
           summary: "completion_failed", payload: { transition: "completion_failed" } }]
      : []);
    const h = makeHarness({ arbiter: arb as any, store });
    const sA = fakeLiveSession();
    const sB = fakeLiveSession();
    const sC = fakeLiveSession();

    // Detach mid-flight with a survivor pending.
    addApproval(h.gating, sA, "d1", T0 - 60_000);
    h.gating.pendingApprovals.detachSession(sA);
    h.gating.noteSessionDetached(T0);

    // ── The blip: 5 seconds the operator never perceived. ──
    h.gating.reannounceSurvivors(sB, T0 + 5_000);
    assert.strictEqual(h.narrations.length, 0, "no 'Welcome back' mid-flow (audit §2.4)");
    assert.strictEqual(arb.evaluate({ now: T0 + 6_000, floorHeld: false, turnClear: true }).action, "hold",
      "silent means SILENT: the quiet path queued NOTHING in the arbiter either");
    assert.ok(h.broadcasts.length >= 1, "the mechanics still ran — chips repopulate (UI is not the spoken channel)");
    assert.strictEqual(store.kv.get(AWAY_KV), String(T0),
      "the away window is NOT consumed by a quiet re-attach — nothing is lost, only deferred");

    // ── The genuine absence: >= RECONNECT_QUIET_MS from the ORIGINAL detach. ──
    h.gating.pendingApprovals.detachSession(sB);
    h.gating.reannounceSurvivors(sC, T0 + QUIET + 1_000);
    assert.strictEqual(h.narrations.length, 0,
      "the ceremony routes as arbiter submissions, never an immediate forced turn (spec §3.3 row 7)");

    // ONE drain at turn-clear: survivors digest headlines (class 2), the away failure rides the tail.
    const d: AnyRec = arb.evaluate({ now: T0 + QUIET + 2_000, floorHeld: false, turnClear: true });
    assert.strictEqual(d.action, "drain", "the deferred ceremony drains at the first turn-clear");
    assert.strictEqual(d.digest.headline.cls, 2, "the survivors digest is the actionable headline");
    assert.match(d.digest.headline.facts, /npm run deploy|t1/, "the headline names the waiting command/pane");
    const tailFacts = d.digest.tail.map((t: AnyRec) => t.facts).join("\n");
    assert.match(tailFacts, /p7/,
      "told-more floor: the pane that failed DURING the absence surfaces in the same single digest's tail");

    // The Wave-4 spoken edge: one rendered injection — headline first, tail counted, rundown offered.
    assert.strictEqual(typeof renderArbiterDigest, "function", RED_RENDERER_MSG);
    const rendered = renderArbiterDigest!(d.digest, d.mode);
    assert.strictEqual(rendered.turnComplete, true, "a class-2 headline digest completes the turn");
    assert.ok(rendered.text.includes(d.digest.headline.facts), "headline facts ride the injection verbatim");
    const headlineAt = rendered.text.indexOf(d.digest.headline.facts);
    const tailAt = rendered.text.indexOf("p7");
    assert.ok(tailAt >= 0, "the tail facts ride the injection as context (the model can answer a rundown ask)");
    assert.ok(headlineAt >= 0 && headlineAt < tailAt,
      "the headline LEADS — tail content never precedes it (answer-first drain unity)");
    assert.ok(rendered.text.includes(String(d.digest.tailCount)),
      "the tail is COUNTED in the injection (D2 headline + counted tail)");
    assert.match(rendered.text, /rundown/i, "the injection offers the rundown (D2/D3)");

    // Exactly-once, and never twice across reconnect flaps.
    assert.strictEqual(arb.evaluate({ now: T0 + QUIET + 2_001, floorHeld: false, turnClear: true }).action, "hold",
      "one ceremony, one drain — a reconnect flap never replays the same news");
    assert.strictEqual(store.kv.get(AWAY_KV), "", "the genuine ceremony consumed the away window");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Journey 3 — canonical collision 3 (spec §4-W4): a single turn-clear instant with a deferred
// last-call, TWO completions (one failed, one clean), a pane ack, and passive context all pending.
// Pre-arbiter this was four consecutive topic switches in wall-clock order (audit §2.5); now it
// must drain ONCE, severity-ordered, as one headline + counted tail.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("journey 3: multi-item turn-clear drains ONCE, priority-ordered", () => {
  it("cls 2+3+3+4+5 pending -> ONE drain (2 headlines; failed-3 before clean-3; 4 then 5 in the tail), ONE rendered injection, then hold", () => {
    const arb = createTurnArbiter();
    const h = makeHarness({ arbiter: arb as any });
    addApproval(h.gating, h.session);

    // Producer 1 (REAL gating): the sweep last-call — class 2.
    h.gating.sweepExpiredApprovals(S1);
    assert.strictEqual(h.narrations.length, 0, "the timer lane diverts through the arbiter");

    // Producer 2 (REAL completionPolicy, vc-C): a CLEAN dispatched success first...
    const ok: AnyRec = completionNarration({
      sig: { paneId: "p3", kind: "idle" }, outcomeKind: "completion",
      hasExchange: true, policy: DEFAULT_COMPLETION_ANNOUNCE,
    });
    assert.strictEqual(ok.speak, true, "dispatched success speaks under the locked `dispatched` default");
    arb.submit(ok.item);
    // ...then a FAILED completion, submitted LATER — severity must still outrank arrival order.
    const failed: AnyRec = completionNarration({
      sig: { paneId: "p2", kind: "idle" }, outcomeKind: "completion_failed",
      hasExchange: true, policy: DEFAULT_COMPLETION_ANNOUNCE,
    });
    assert.strictEqual(failed.speak, true, "a failed settled outcome always speaks (inviolable exception)");
    arb.submit(failed.item);

    // Producer 3 (REAL paneSignalClass + formatPaneSignal): a created-pane ack — class 4.
    assert.strictEqual(voiceIndex.paneSignalClass("created"), 4);
    const ackSig = { paneId: "p6", kind: "created" } as any;
    arb.submit({ facts: formatPaneSignal(ackSig), cls: 4, paneId: "p6", coalesceKey: "ready-ack:p6:created" });

    // Producer 4: passive context — class 5.
    const idleSig = { paneId: "p4", kind: "idle" } as any;
    arb.submit({ facts: formatPaneSignal(idleSig), cls: 5, paneId: "p4" });

    // Mid-floor: EVERYTHING holds — no wall-clock leak from any of the four producers.
    assert.strictEqual(arb.evaluate({ now: S1 + 1_000, floorHeld: true, turnClear: false }).action, "hold",
      "five pending items across four producers and NOT ONE speaks over the operator");

    // Turn-clear: ONE drain, severity-ordered.
    const d: AnyRec = arb.evaluate({ now: S1 + 3_000, floorHeld: false, turnClear: true });
    assert.strictEqual(d.action, "drain");
    assert.strictEqual(d.digest.headline.cls, 2, "the deadline narration headlines the digest");
    assert.strictEqual(d.digest.headline.coalesceKey, "last-call:d1");
    assert.strictEqual(d.digest.tailCount, 4, "every other pending item rides the SAME single drain");
    assert.deepStrictEqual(d.digest.tail.map((t: AnyRec) => t.cls), [3, 3, 4, 5],
      "the tail is severity-ordered: completions, then acks, then passive context");
    assert.match(d.digest.tail[0].facts, /p2/,
      "within class 3 the FAILED completion outranks the clean success (severityRank), despite arriving later");
    assert.match(d.digest.tail[1].facts, /p3/);
    const completionGroup = d.digest.tailGroups.find((g: AnyRec) => g.coalesceKey === "pane-completion");
    assert.strictEqual(completionGroup?.count, 2,
      "the two completions share ONE counted tail group ('two panes finished' — D2 phrasing hook)");

    // The Wave-4 spoken edge: ONE injection — headline first, tail counted + present, rundown offered.
    assert.strictEqual(typeof renderArbiterDigest, "function", RED_RENDERER_MSG);
    const rendered = renderArbiterDigest!(d.digest, d.mode);
    assert.strictEqual(rendered.turnComplete, true);
    const headlineAt = rendered.text.indexOf(d.digest.headline.facts);
    assert.ok(headlineAt >= 0, "headline facts verbatim in the injection");
    for (const t of d.digest.tail) {
      const at = rendered.text.indexOf(t.facts);
      assert.ok(at >= 0, `tail facts must ride the injection as context (told-more): ${t.facts}`);
      assert.ok(headlineAt < at, `the headline leads; tail item must not precede it: ${t.facts}`);
    }
    assert.ok(rendered.text.includes("4"), "the tail count (4) is stated in the injection");
    assert.match(rendered.text, /rundown/i, "the injection offers the rundown");

    // Drains ONCE: the queue is empty; a second turn-clear says nothing.
    assert.strictEqual(arb.evaluate({ now: S1 + 3_001, floorHeld: false, turnClear: true }).action, "hold",
      "at most one spoken turn per turn-clear — the four-consecutive-topic-switch accident is dead");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Renderer contract — the passive arm (D3): a passive-context digest lands as BACKGROUND-framed
// context (turnComplete:false), reusing the fikj.8 Leg-B machinery VERBATIM.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("renderArbiterDigest: passive-context digests are BACKGROUND-framed context, never a turn", () => {
  it("a class-5-only drain renders turnComplete:false with the applyBackgroundFraming preamble, idempotently", () => {
    const arb = createTurnArbiter(); // default matrix: class 5 -> passive-context
    arb.submit({ facts: formatPaneSignal({ paneId: "p9", kind: "idle" } as any), cls: 5, paneId: "p9" });
    const d: AnyRec = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
    assert.strictEqual(d.action, "drain");
    assert.strictEqual(d.mode, "passive-context", "a class-5 headline drains passive by default (D4)");

    assert.strictEqual(typeof renderArbiterDigest, "function", RED_RENDERER_MSG);
    const rendered = renderArbiterDigest!(d.digest, d.mode);
    assert.strictEqual(rendered.turnComplete, false,
      "passive-context injects context only — it must never complete a turn (spec §3.1 D3)");
    assert.match(rendered.text, /^BACKGROUND\b/,
      "the passive arm REUSES applyBackgroundFraming (fikj.8 Leg B, verbatim) — the preamble leads");
    assert.ok(rendered.text.includes(d.digest.headline.facts), "the facts still land in full (told-more)");
    // Idempotence rides applyBackgroundFraming's own contract: re-framing never doubles the preamble.
    const reframed = voiceIndex.applyBackgroundFraming(rendered.text, false);
    assert.strictEqual(reframed, rendered.text, "no double BACKGROUND preamble on re-injection");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D3 — the "[7. VOICE OUTPUT RULES]" narration-guidance block. Content-invariants in the
// tests/test_answer_first_ordering.ts style (rendered DEFAULT, not byte pins): the model's words
// stay its own (NO verbatim scripts), but the guidance must exist — lead with the worst, headline
// + counted tail, offer the rundown.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("[7. VOICE OUTPUT RULES] carries the D3 narration-guidance block", () => {
  const SAMPLE_ACTIVE_PROJECT_ID = "alpha-proj";
  const SAMPLE_WORKSPACES = "alpha-proj (Alpha), beta-proj (Beta)";

  /** Extract just the section-7 body so assertions can't match unrelated prose elsewhere. */
  function section7Of(rendered: string): string {
    const startIdx = rendered.indexOf("[7. VOICE OUTPUT RULES]");
    assert.ok(startIdx >= 0, "expected the '[7. VOICE OUTPUT RULES]' section header");
    const endIdx = rendered.indexOf("[8. EXAMPLES]", startIdx);
    assert.ok(endIdx >= 0, "expected the '[8. EXAMPLES]' header after section 7");
    return rendered.slice(startIdx, endIdx);
  }

  function renderedSection7(): string {
    return section7Of(buildSystemInstruction({
      activeProjectId: SAMPLE_ACTIVE_PROJECT_ID,
      workspaces: SAMPLE_WORKSPACES,
    }));
  }

  it("instructs the model to LEAD WITH THE WORST item when several updates land at once (answer-first rule intact)", () => {
    const section7 = renderedSection7();
    // Regression guard first (green today, must STAY green through W4): the fikj.8 answer-first
    // rule is not displaced by the new block.
    assert.ok(/answer[\s\S]{0,100}first/i.test(section7),
      "the existing answer-first rule must remain in section 7");
    assert.ok(/(lead|open|start)[\s\S]{0,60}(worst|most severe|most urgent)/i.test(section7),
      "Wave-4 feature absent: section 7 must tell the model to lead with the worst/most severe " +
        "item when a digest carries several (D3 — current section 7 has no such guidance)");
  });

  it("instructs headline + COUNTED tail — speak the top item, count the rest, don't read them all", () => {
    const section7 = renderedSection7();
    assert.ok(/count/i.test(section7),
      "Wave-4 feature absent: section 7 must tell the model to COUNT the remaining items " +
        "(D2/D3 headline + counted tail — 'count' never appears in today's section 7)");
    assert.ok(/(rest|others|remaining|more)/i.test(section7),
      "the counted-tail guidance must refer to the REST of the items (the tail), not just the headline");
  });

  it("instructs the model to OFFER THE RUNDOWN so the counted tail stays reachable by voice", () => {
    const section7 = renderedSection7();
    assert.ok(/rundown/i.test(section7),
      "Wave-4 feature absent: section 7 must tell the model to offer the rundown (spec D2's own " +
        "phrasing hook: 'also, three panes finished — ask for the rundown') — 'rundown' never " +
        "appears in today's section 7");
  });
});
