// tests/test_turn_arbiter_completions.ts — Wave 3 RED: vc-C deterministic completion narration as
// arbiter class 3.
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md §3.3 row "vc-C completions",
// §4-W3; co-design spec §C (docs/superpowers/specs/2026-07-28-voice-coherence-codesign.md, branch
// docs/voice-coherence-codesign) — acceptance criteria 1-6 land here. LOCKED epic decisions pinned:
// `completionAnnounce` default `dispatched`, keyed off dispatch-intent (`hasExchange`), FOCUS-
// INDEPENDENT (the v1 `focused` tier is retired — Sam's walk-away pane and Maya's kitchen pane are
// the same signal). Outcome facts key off the SAME settled-exchange-outcome seam PR #152's
// completion_failed earcon uses (src/observe/index.ts completionKindFor) — REUSED, never re-derived.
//
// The module under test does NOT exist yet — every test fails "Wave-3 feature absent" until then.
// The Wave-1 arbiter (src/voice/turnArbiter.ts) and the Wave-2 correction ledger
// (src/voice/correctionLedger.ts) are REAL here; time is the caller-supplied fake.
//
// ── Pinned API (the implementer builds EXACTLY this surface) ────────────────────────────────────
//   // src/voice/completionPolicy.ts (new, PURE — no I/O, no exchange-service reads)
//   export type CompletionAnnounce = "off" | "exceptions" | "dispatched" | "all";
//   export const DEFAULT_COMPLETION_ANNOUNCE: CompletionAnnounce = "dispatched";
//   export function normalizeCompletionAnnounce(raw: unknown): CompletionAnnounce;
//   export function completionNarration(input: {
//     sig: { paneId: string; kind: string; detail?: string };   // the pane-signal edge
//     outcomeKind: "completion" | "completion_failed";           // completionKindFor's verdict — the
//                                                                // REUSED settled-outcome seam value
//     hasExchange: boolean;                                      // dispatch-intent (activeExchangeForPane)
//     policy: CompletionAnnounce;
//   }): { speak: false; reason: string }
//    | { speak: true; item: { facts: string; cls: 3; paneId: string; coalesceKey: string;
//                             severityRank?: number } }
//
//   // src/observe/index.ts — the reuse-don't-fork seam: ObserveHandlers gains
//   //   completionKindFor(terminalId: string): "completion" | "completion_failed"
//   // (the SAME closure the fikj.7 earcon enqueue uses at the onIdle edge, exposed on the handlers
//   // surface so the voice layer keys class-3 facts off it — one-signature change, no second
//   // implementation of the agent_failed/staleness-guard logic anywhere else).
//
// ── Pinned decision table (co-design §C, final — dispatch-intent keyed) ────────────────────────
//   policy=off                                        → never speak (earcon-only tier; the earcon +
//                                                       toast + visual stack are OUTSIDE this module
//                                                       and unchanged — not a silent-drop path)
//   exception (kind error/prompt, or outcomeKind completion_failed), ANY pane, policy≠off
//                                                     → speak, named-pane (fleet-wide, inviolable)
//   success + hasExchange + policy ∈ {dispatched,all} → speak (focused OR background — the persona fix)
//   success without hasExchange                       → speak only under policy=all (ambient opt-in);
//                                                       default `dispatched` NEVER amplifies an
//                                                       uncorroborated idle (false-done guard)
//   every speak:false decision returns a machine-readable `reason` (auditable told-more trail)
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_completions.ts

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";
import { attachObserve } from "../src/observe/index";

type AnyRec = Record<string, any>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const T0 = 1_700_000_000_000;

// Computed specifier: tsc must NOT resolve this while the module is unimplemented (lint stays
// green during RED); tsx resolves it at runtime exactly like the static test imports.
const POLICY_SPEC = ["..", "src", "voice", "completionPolicy"].join("/");

async function loadPolicy(): Promise<AnyRec> {
  try {
    return await import(POLICY_SPEC);
  } catch (e: any) {
    return assert.fail(
      "Wave-3 feature absent: src/voice/completionPolicy.ts is not implemented yet " +
        `(turn-arbiter spec §4-W3, co-design §C) — import failed: ${e?.message ?? e}`,
    );
  }
}

/** Build a completionNarration input with sane defaults; override per case. */
function narrInput(over: AnyRec = {}): AnyRec {
  return {
    sig: { paneId: "p2", kind: "idle", detail: "npm test finished", ...(over.sig ?? {}) },
    outcomeKind: "completion",
    hasExchange: true,
    policy: "dispatched",
    ...over,
  };
}

// ── surface + defaults ─────────────────────────────────────────────────────────────────────────

test("module exports the Wave-3 completion-policy surface with the LOCKED dispatched default", async () => {
  const mod = await loadPolicy();
  assert.strictEqual(typeof mod.completionNarration, "function", "completionNarration must be exported");
  assert.strictEqual(typeof mod.normalizeCompletionAnnounce, "function", "normalizeCompletionAnnounce must be exported");
  assert.strictEqual(mod.DEFAULT_COMPLETION_ANNOUNCE, "dispatched",
    "the LOCKED epic decision: completionAnnounce defaults to `dispatched` (hasExchange-keyed), NOT `focused`");
});

test("normalizeCompletionAnnounce: valid tiers pass through; absent/invalid/retired fall back to `dispatched`", async () => {
  const mod = await loadPolicy();
  for (const v of ["off", "exceptions", "dispatched", "all"]) {
    assert.strictEqual(mod.normalizeCompletionAnnounce(v), v, `valid tier ${v} passes through`);
  }
  assert.strictEqual(mod.normalizeCompletionAnnounce(undefined), "dispatched", "absent -> the default");
  assert.strictEqual(mod.normalizeCompletionAnnounce("focused"), "dispatched",
    "the RETIRED v1 tier name `focused` must not survive — the re-key to dispatch-intent is the " +
      "single biggest v1->final change (co-design §C) and a stale settings file must not resurrect it");
  assert.strictEqual(mod.normalizeCompletionAnnounce(42), "dispatched", "garbage -> the default, never a throw");
  assert.strictEqual(mod.normalizeCompletionAnnounce(null), "dispatched", "null -> the default");
});

// ── AC1/AC2: the persona fix — dispatched success speaks, focused OR background ────────────────

test("background dispatched success speaks: hasExchange + policy=dispatched elects a class-3 item naming the pane", async () => {
  const mod = await loadPolicy();
  const d = mod.completionNarration(narrInput());
  assert.strictEqual(d.speak, true,
    "the case v1's `focused` wrongly dropped: a walk-away dispatched pane MUST speak its close (co-design §C AC1)");
  assert.strictEqual(d.item.cls, 3, "completions are arbiter class 3");
  assert.strictEqual(d.item.paneId, "p2", "the item carries the pane identity");
  assert.ok(d.item.facts.includes("p2"), `facts name the pane (terse named close), got: ${d.item.facts}`);
  assert.ok(typeof d.item.coalesceKey === "string" && d.item.coalesceKey.includes("completion"),
    `coalesceKey groups pane completions for the D2 counted tail ("three panes finished"), got: ${JSON.stringify(d.item.coalesceKey)}`);
});

test("the decision is FOCUS-INDEPENDENT: focus/engagement flags change nothing (LOCKED epic decision)", async () => {
  const mod = await loadPolicy();
  // The pinned signature has no focus input at all; a caller passing legacy focus/engagement
  // extras must get byte-identical decisions — `hasExchange` is the ONLY keying signal.
  const focused = mod.completionNarration({ ...narrInput(), focused: true, isEngaged: true });
  const background = mod.completionNarration({ ...narrInput(), focused: false, isEngaged: false });
  assert.deepStrictEqual(focused, background,
    "dispatch-intent (hasExchange) is the keying signal; screen focus must never change the outcome");
});

// ── policy=off: earcon-only tier (never a spoken turn, decision still auditable) ───────────────

test("policy=off never speaks — success AND failure — and every silent decision carries a reason", async () => {
  const mod = await loadPolicy();
  const success = mod.completionNarration(narrInput({ policy: "off" }));
  assert.strictEqual(success.speak, false, "off is the earcon-only tier (co-design §C table row 1)");
  assert.ok(typeof success.reason === "string" && success.reason.length > 0,
    "a silent decision must say WHY (auditable told-more trail — the drop is deliberate, never accidental)");
  const failure = mod.completionNarration(narrInput({ policy: "off", outcomeKind: "completion_failed" }));
  assert.strictEqual(failure.speak, false, "off silences even failures — the earcon channel still fires (fikj.7)");
  assert.ok(typeof failure.reason === "string" && failure.reason.length > 0);
});

// ── AC5: exceptions speak fleet-wide, by name, hasExchange or not (inviolable) ─────────────────

test("exception kinds speak on ANY pane regardless of hasExchange — error, needs-input, failed outcome", async () => {
  const mod = await loadPolicy();
  const cases: Array<[AnyRec, string]> = [
    [narrInput({ sig: { paneId: "p9", kind: "error" }, hasExchange: false }), "error kind"],
    [narrInput({ sig: { paneId: "p9", kind: "prompt" }, hasExchange: false }), "needs-input (prompt) kind"],
    [narrInput({ sig: { paneId: "p9", kind: "idle" }, outcomeKind: "completion_failed", hasExchange: true }), "failed settled outcome"],
  ];
  for (const [input, label] of cases) {
    for (const policy of ["exceptions", "dispatched", "all"]) {
      const d = mod.completionNarration({ ...input, policy });
      assert.strictEqual(d.speak, true, `${label} under policy=${policy} must speak (never miss eyes-off)`);
      assert.strictEqual(d.item.cls, 3);
      assert.ok(d.item.facts.includes("p9"), `${label}: exception facts name the pane, got: ${d.item.facts}`);
    }
  }
});

test("policy=exceptions is the quiet tier: a clean dispatched success stays silent under it", async () => {
  const mod = await loadPolicy();
  const d = mod.completionNarration(narrInput({ policy: "exceptions" }));
  assert.strictEqual(d.speak, false, "under `exceptions` only errors/needs-input/failures speak");
  assert.ok(typeof d.reason === "string" && d.reason.length > 0);
});

// ── AC4/AC6: the false-done guard — ambient successes stay silent by default ───────────────────

test("success WITHOUT hasExchange: silent under dispatched (false-done guard), spoken only under all", async () => {
  const mod = await loadPolicy();
  const ambient = narrInput({ hasExchange: false });
  const underDefault = mod.completionNarration(ambient);
  assert.strictEqual(underDefault.speak, false,
    "a bare idle with no dispatched exchange never becomes a spoken 'done' under the default — " +
      "this module refuses to AMPLIFY an uncorroborated idle (idle accuracy stays x6oo's job)");
  assert.ok(typeof underDefault.reason === "string" && underDefault.reason.length > 0);
  assert.strictEqual(mod.completionNarration({ ...ambient, policy: "exceptions" }).speak, false);
  const underAll = mod.completionNarration({ ...ambient, policy: "all" });
  assert.strictEqual(underAll.speak, true, "`all` is the explicit loudest opt-in: ambient completions speak by name");
  assert.ok(underAll.item.facts.includes("p2"));
});

// ── the settled-outcome seam keys the FACTS (fikj.7's earcon truth, spoken) ────────────────────

test("outcome facts key off completionKindFor's verdict: completion_failed narrates failure, completion never does", async () => {
  const mod = await loadPolicy();
  // Same idle edge, same pane — ONLY the settled-outcome verdict differs. This is exactly how the
  // PR #152 earcon split "completion" vs "completion_failed": the exchange machine's own
  // agent_failed state, never the idle-time output text.
  const failed = mod.completionNarration(narrInput({ outcomeKind: "completion_failed" }));
  assert.strictEqual(failed.speak, true);
  assert.match(failed.item.facts, /fail/i,
    "a settled agent_failed outcome must be narrated AS a failure — a clean 'finished' would be the false-done lie");
  const clean = mod.completionNarration(narrInput());
  assert.strictEqual(clean.speak, true);
  assert.doesNotMatch(clean.item.facts, /fail/i,
    "a clean settled outcome must NOT be narrated as a failure (ambiguity fails toward plain completion upstream)");
});

// ── class-3 items ride the REAL arbiter: severity order, one drain, steered mode ───────────────

test("through the real arbiter: a failed completion headlines over an earlier success in ONE steered drain", async () => {
  const mod = await loadPolicy();
  const arb = createTurnArbiter();
  const ok = mod.completionNarration(narrInput({ sig: { paneId: "p1", kind: "idle" } }));
  const bad = mod.completionNarration(narrInput({ sig: { paneId: "p2", kind: "idle" }, outcomeKind: "completion_failed" }));
  assert.strictEqual(ok.speak, true);
  assert.strictEqual(bad.speak, true);
  arb.submit(ok.item);  // arrives FIRST
  arb.submit(bad.item); // arrives second — FIFO would wrongly headline the success
  const d: AnyRec = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.match(d.digest.headline.facts, /fail/i,
    "lead with the worst (D2/D3): the failed completion must headline via within-class severity rank");
  assert.ok(d.digest.headline.facts.includes("p2"));
  assert.strictEqual(d.digest.tailCount, 1, "the success rides the counted tail of the SAME single turn");
  assert.ok(d.digest.tail[0].facts.includes("p1"));
  assert.strictEqual(d.mode, "steered-digest", "class-3 default delivery mode is steered-digest (D4)");
  assert.strictEqual(arb.evaluate({ now: T0 + 1, floorHeld: false, turnClear: true }).action, "hold",
    "at most one spoken turn per turn-clear");
});

test("turn-gated, never dropped: a dispatched-success item defers mid-floor and drains intact at turn-clear", async () => {
  const mod = await loadPolicy();
  const arb = createTurnArbiter();
  const d0 = mod.completionNarration(narrInput());
  assert.strictEqual(d0.speak, true);
  arb.submit(d0.item);
  assert.strictEqual(arb.evaluate({ now: T0, floorHeld: true, turnClear: false }).action, "hold",
    "mid-utterance the completion DEFERS — no jump-over (co-design §C AC1: deferred, not dropped)");
  assert.strictEqual(arb.evaluate({ now: T0 + 8_000, floorHeld: true, turnClear: false }).action, "hold");
  const d: AnyRec = arb.evaluate({ now: T0 + 10_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "defer means LATER, never NEVER");
  assert.strictEqual(d.digest.headline.cls, 3);
  assert.strictEqual(d.digest.headline.facts, d0.item.facts, "the deferred completion speaks intact");
});

// ── co-design §D AC7 (deferred here from Wave 2): corrections ignore completionAnnounce ────────

test("corrections fire regardless of completionAnnounce: policy=off silences completions, never retractions", async () => {
  const mod = await loadPolicy();
  const arb = createTurnArbiter();
  const led = createCorrectionLedger({ arbiter: arb });
  // Under policy=off the completion tier is silent...
  const d0 = mod.completionNarration(narrInput({ policy: "off" }));
  assert.strictEqual(d0.speak, false, "off silences the completion narration tier");
  // ...but a previously-SPOKEN claim that flips is truth-plane, not verbosity — the ledger is
  // policy-blind and the class-0 correction still drains.
  led.record({ claimId: "c1", paneId: "p2", kind: "completion", assertedText: "Pane p2 finished.", assertedAt: T0, spoken: true });
  const dec = led.invalidate("c1", "pane p2 actually failed — the run did not complete");
  assert.strictEqual(dec.corrected, true, "the correction ledger never consults completionAnnounce (co-design §D AC7)");
  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 0, "the retraction drains as class 0 even with completions dialed off");
});

// ── use-case (d): the six-pane fleet valve — one turn, grouped tail, no pane lost ──────────────

test("six-pane fleet: three dispatched completions + one failure in one window coalesce into ONE grouped turn", async () => {
  const mod = await loadPolicy();
  const arb = createTurnArbiter();
  const items: any[] = [];
  for (const pane of ["p1", "p2", "p3"]) {
    const d = mod.completionNarration(narrInput({ sig: { paneId: pane, kind: "idle" } }));
    assert.strictEqual(d.speak, true, `dispatched success on ${pane} elects narration`);
    items.push(d.item);
  }
  const failed = mod.completionNarration(narrInput({ sig: { paneId: "p4", kind: "idle" }, outcomeKind: "completion_failed" }));
  assert.strictEqual(failed.speak, true);
  items.push(failed.item);
  for (const it of items) arb.submit(it);

  // The whole window lands while the operator holds the floor: NOTHING fires early.
  assert.strictEqual(arb.evaluate({ now: T0, floorHeld: true, turnClear: false }).action, "hold",
    "four completions mid-floor stay held — no machine-gun of four consecutive topic switches");

  const d: AnyRec = arb.evaluate({ now: T0 + 4_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.match(d.digest.headline.facts, /fail/i, "the one failure headlines the fleet drain (lead with the worst)");
  assert.ok(d.digest.headline.facts.includes("p4"));
  assert.strictEqual(d.digest.tailCount, 3,
    "the three successes ride the counted tail of the SAME single turn — the D2 pressure valve the director pre-approved");
  const spoken = [d.digest.headline, ...d.digest.tail].map((t: AnyRec) => t.facts).join(" | ");
  for (const pane of ["p1", "p2", "p3", "p4"]) {
    assert.ok(spoken.includes(pane),
      `told-more floor: pane ${pane}'s outcome must survive coalescing (the arbiter's identity is ` +
        `(coalesceKey, paneId) — sharing a key across panes loses nothing), got: ${spoken}`);
  }
  // The grouped-summary hook: "three panes finished" requires the successes to SHARE a coalesce
  // group. Per-pane keys (e.g. "completion:p1") would degrade the tail into ungrouped solo items —
  // "also three more things" instead of "three panes finished" (W1's canonical shared key is
  // "pane-completion"; D2's tailGroups exists exactly for this phrasing).
  assert.strictEqual(d.digest.tailGroups.length, 1,
    `use case (d): the success tail must form ONE coalesce group, got: ${JSON.stringify(d.digest.tailGroups)}`);
  assert.strictEqual(d.digest.tailGroups[0].count, 3);
  assert.strictEqual(arb.evaluate({ now: T0 + 4_001, floorHeld: false, turnClear: true }).action, "hold",
    "one spoken turn for the whole fleet window, not four");
});

// ── use-case (a) wiring: the election must RUN in production, keyed off the seam ───────────────

test("wiring: src/voice/index.ts consumes completionNarration and consults completionKindFor (a pure module nobody calls narrates nothing)", () => {
  // The operator reality this pins: a dispatched pane finishing while the operator talks to
  // another pane must ACTUALLY produce a class-3 item at the idle edge — and a failed run must be
  // narrated as failed from the SAME settled-outcome seam the earcon uses. A green pure-function
  // suite over a module no production path invokes (or a caller hardcoding outcomeKind) would let
  // both regress to silence/lies with zero test failures.
  const src = readFileSync(path.join(repoRoot, "src", "voice", "index.ts"), "utf8");
  const lines = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
  const narrMentions = lines.filter((l) => /\bcompletionNarration\b/.test(l)).length;
  assert.ok(narrMentions >= 2,
    "Wave-3 feature absent: src/voice/index.ts must import AND call completionNarration at the " +
      `pane-signal idle edge (spec §3.3 row 4 — vc-C is a PRODUCER, not a library) — found ${narrMentions} ` +
      "non-comment mention(s), need the import plus at least one call site");
  const seamMentions = lines.filter((l) => /\bcompletionKindFor\b/.test(l)).length;
  assert.ok(seamMentions >= 1,
    "Wave-3 feature absent: the voice layer must key the outcomeKind input off ObserveHandlers." +
      `completionKindFor (the reuse-don't-fork seam; discovery-pinned topology) — found ${seamMentions} ` +
      "non-comment mention(s); a caller inventing its own verdict would let the spoken outcome " +
      "disagree with the failure earcon (never-disagreeing surfaces, use case a)");
});

// ── the reuse-don't-fork seam: completionKindFor exposed on the observe handlers ───────────────

test("ObserveHandlers exposes completionKindFor — the ONE settled-outcome resolver, shared with the earcon", () => {
  const manager: AnyRec = { terminals: {} };
  const deps: AnyRec = {
    broadcast: () => {},
    announcementBus: { enqueue: () => true, stop: () => {} },
    paneSignalBus: { publish: () => {}, subscribe: () => () => {} },
    pruneAttention: () => {},
    interactionLog: { append: () => {}, log: () => {} },
    getLastInteractionId: () => null,
    redact: (s: string) => s,
    historyManager: { loadHistory: () => [], saveHistory: () => {}, appendOutputToLastCommand: () => {} },
    ai: {},
  };
  const handlers: AnyRec = attachObserve(manager as any, deps as any);
  assert.strictEqual(typeof handlers.completionKindFor, "function",
    "Wave-3 feature absent: attachObserve must expose completionKindFor on ObserveHandlers so the " +
      "voice layer keys class-3 facts off the SAME seam the fikj.7 earcon uses (reuse, do not fork)");
  assert.strictEqual(handlers.completionKindFor("no-such-pane"), "completion",
    "the seam's fail-open contract carries over: no correlated exchange -> plain completion, never a speculative failure");
});

test("anti-fork: completionPolicy consumes the seam's verdict and never re-derives it", () => {
  const p = path.join(repoRoot, "src", "voice", "completionPolicy.ts");
  assert.ok(existsSync(p),
    "Wave-3 feature absent: src/voice/completionPolicy.ts does not exist yet (spec §4-W3, co-design §C)");
  const src = readFileSync(p, "utf8");
  for (const banned of ["getExchangeService", "lastCommandBelongsToActiveExchange", "activeExchangeForPane"]) {
    assert.ok(!src.includes(banned),
      `completionPolicy.ts must stay PURE and take outcomeKind as an input — the settled-outcome ` +
        `logic (agent_failed + staleness guard) lives ONLY in src/observe/index.ts completionKindFor; ` +
        `found "${banned}" (a second implementation would drift from the earcon's truth)`);
  }
});
