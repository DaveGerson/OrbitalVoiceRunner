// tests/test_pane_failure_narration.ts — bead wsm-e2e-pinned-mvjf: "a dead pane is NEVER spoken".
//
// THE GAP (confirmed): formatPaneSignal wraps every pane signal — including 'exited' — in "PANE
// STATUS UPDATE (context only — do not speak unless the operator asks)"; paneSignalClass buckets
// 'exited'/'error' into passive class 5; ONLY sig.kind==='idle' ever elects a spoken class-3
// completion narration (src/voice/index.ts's paneSignalBus.subscribe callback, the vc-C branch).
// A pane that dies or errors is background-framed forever — the model is told never to speak it
// unless asked. docs/roadmap/EXECUTION-PLAN-V2.md:258 expects a SPOKEN 'exited'.
//
// THE FIX: failureNarrationItem mirrors the idle branch's structure/priority-class discipline (same
// class 3, same shared arbiter queue) for the two FAILURE_TRANSITIONS kinds that actually reach the
// voice bus (src/observe/index.ts FAILURE_TRANSITIONS) — 'exited' and 'error' — WITHOUT touching
// paneSignalClass (still pinned at class 5 by tests/test_reconnect_quiet_threshold.ts:403-404) and
// WITHOUT reusing completionNarration's "finished" phrasing (a dead pane never "finished"). The
// caller-supplied `seen` map is the once-per-transition dedupe guard: a fresh non-failure kind for
// the pane clears it, so a genuinely NEW failure after a recovery narrates again, but a
// flapping/repeated signal for the SAME unresolved transition narrates only once (no spam).
//
// Runner: npx tsx --test --test-force-exit tests/test_pane_failure_narration.ts

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import * as voiceIndexModule from "../src/voice/index";

type AnyRec = Record<string, any>;
const voiceIndex = voiceIndexModule as AnyRec;
const T0 = 1_700_000_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ── pure decision core ──────────────────────────────────────────────────────────────────────────

test("failureNarrationItem: export exists", () => {
  assert.strictEqual(typeof voiceIndex.failureNarrationItem, "function",
    "wsm-e2e-pinned-mvjf feature absent: src/voice/index.ts must export failureNarrationItem(sig, seen)");
});

test("failureNarrationItem: 'exited' yields a class-3 item naming the pane, never 'finished'", () => {
  const seen = new Map<string, string>();
  const item = voiceIndex.failureNarrationItem({ paneId: "p1", kind: "exited" }, seen);
  assert.ok(item, "an 'exited' signal must produce a spoken item");
  assert.strictEqual(item.cls, 3);
  assert.strictEqual(item.paneId, "p1");
  assert.match(item.facts, /pane p1 exited/i);
  assert.doesNotMatch(item.facts, /finished/i, "a dead pane must never read as a clean completion");
});

test("failureNarrationItem: 'error' yields a class-3 item naming the pane and the error", () => {
  const seen = new Map<string, string>();
  const item = voiceIndex.failureNarrationItem({ paneId: "p2", kind: "error" }, seen);
  assert.ok(item);
  assert.strictEqual(item.cls, 3);
  assert.match(item.facts, /pane p2.*(error)/i);
});

test("failureNarrationItem: every other kind is a no-op (idle/prompt/running/quiescing/created/closed)", () => {
  const seen = new Map<string, string>();
  for (const kind of ["idle", "prompt", "running", "quiescing", "created", "closed"]) {
    assert.strictEqual(voiceIndex.failureNarrationItem({ paneId: "p3", kind }, seen), null,
      `"${kind}" must never elect a failure narration`);
  }
});

test("failureNarrationItem: does not spam — the SAME unresolved failure kind narrates only once per pane", () => {
  const seen = new Map<string, string>();
  const first = voiceIndex.failureNarrationItem({ paneId: "p4", kind: "exited" }, seen);
  assert.ok(first, "the first 'exited' signal narrates");
  const second = voiceIndex.failureNarrationItem({ paneId: "p4", kind: "exited" }, seen);
  assert.strictEqual(second, null, "a repeated 'exited' signal for the SAME unresolved transition must not renarrate");
  const third = voiceIndex.failureNarrationItem({ paneId: "p4", kind: "exited" }, seen);
  assert.strictEqual(third, null, "still deduped on a third repeat");
});

test("failureNarrationItem: a DIFFERENT failure kind on the same pane narrates again (exited then error)", () => {
  const seen = new Map<string, string>();
  const exited = voiceIndex.failureNarrationItem({ paneId: "p5", kind: "exited" }, seen);
  assert.ok(exited);
  const error = voiceIndex.failureNarrationItem({ paneId: "p5", kind: "error" }, seen);
  assert.ok(error, "a genuinely different failure kind on the same pane is new information — must narrate");
});

test("failureNarrationItem: a recovery signal (e.g. idle) clears the guard so a LATER failure renarrates", () => {
  const seen = new Map<string, string>();
  const first = voiceIndex.failureNarrationItem({ paneId: "p6", kind: "exited" }, seen);
  assert.ok(first);
  const dup = voiceIndex.failureNarrationItem({ paneId: "p6", kind: "exited" }, seen);
  assert.strictEqual(dup, null, "precondition: deduped before recovery");
  const recovered = voiceIndex.failureNarrationItem({ paneId: "p6", kind: "idle" }, seen);
  assert.strictEqual(recovered, null, "idle itself never narrates as a failure");
  const again = voiceIndex.failureNarrationItem({ paneId: "p6", kind: "exited" }, seen);
  assert.ok(again, "a fresh failure AFTER a recovery edge must narrate again — it is a new transition");
});

test("failureNarrationItem: distinct panes are tracked independently", () => {
  const seen = new Map<string, string>();
  const a1 = voiceIndex.failureNarrationItem({ paneId: "pa", kind: "exited" }, seen);
  const b1 = voiceIndex.failureNarrationItem({ paneId: "pb", kind: "exited" }, seen);
  assert.ok(a1);
  assert.ok(b1, "a different pane's first 'exited' signal must narrate regardless of pane A's state");
  const a2 = voiceIndex.failureNarrationItem({ paneId: "pa", kind: "exited" }, seen);
  assert.strictEqual(a2, null, "pane A stays deduped");
});

test("failureNarrationItem: a non-failure kind on a never-seen pane is a safe no-op (no throw)", () => {
  const seen = new Map<string, string>();
  assert.doesNotThrow(() => {
    const r = voiceIndex.failureNarrationItem({ paneId: "fresh-pane", kind: "prompt" }, seen);
    assert.strictEqual(r, null);
  });
});

// ── does not disturb the pinned classifier ─────────────────────────────────────────────────────

test("failureNarrationItem coexists with paneSignalClass — 'exited'/'error' stay class 5 (unchanged pin)", () => {
  assert.strictEqual(voiceIndex.paneSignalClass("exited"), 5,
    "tests/test_reconnect_quiet_threshold.ts:403-404 pins this — must NOT change");
  assert.strictEqual(voiceIndex.paneSignalClass("error"), 5,
    "tests/test_reconnect_quiet_threshold.ts:403-404 pins this — must NOT change");
});

// ── end to end through the REAL arbiter ────────────────────────────────────────────────────────

test("end to end: a failure item drains as a spoken class-3 narration through the REAL arbiter", () => {
  const arb = createTurnArbiter();
  const seen = new Map<string, string>();
  const item = voiceIndex.failureNarrationItem({ paneId: "p9", kind: "exited" }, seen);
  assert.ok(item);
  arb.submit(item);
  const d: AnyRec = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 3);
  assert.match(d.digest.headline.facts, /pane p9 exited/);
});

test("end to end: a failure headline outranks a same-tick clean success (severityRank discipline)", () => {
  // Mirrors completionPolicy's own "exceptions headline over clean successes within class 3 even
  // when submitted later (D2)" discipline — copied here so a dead pane is never buried in the tail.
  const arb = createTurnArbiter();
  const seen = new Map<string, string>();
  arb.submit({ facts: "pane clean finished", cls: 3, paneId: "clean", coalesceKey: "pane-completion", severityRank: 1 });
  const failureItem = voiceIndex.failureNarrationItem({ paneId: "p10", kind: "error" }, seen);
  arb.submit(failureItem);
  const d: AnyRec = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.match(d.digest.headline.facts, /pane p10.*error/i,
    "the failure must headline over the clean success even though it was submitted second");
});

// ── production wiring conformance (the idiom test_vcd_producer_completion.ts already uses) ──────

test("production wiring conformance: failureNarrationItem is defined AND consumed (directly or via its submit wrapper)", () => {
  const src = readFileSync(path.resolve(repoRoot, "src/voice/index.ts"), "utf-8");
  const calls = (src.match(/failureNarrationItem\(/g) ?? []).length;
  assert.ok(calls >= 2,
    `wsm-e2e-pinned-mvjf feature absent: failureNarrationItem needs a definition AND a call site ` +
      `(found ${calls})`);
});

test("production wiring conformance: the failure narration is wired into the SAME spoken subscriber the idle branch uses, through the SAME sharedArbiter", () => {
  const src = readFileSync(path.resolve(repoRoot, "src/voice/index.ts"), "utf-8");
  // The idle branch and the failure branch must both live inside the same
  // `paneSignalBus.subscribe(...)` callback — grab that whole callback body and check both markers
  // appear inside it (not just anywhere in the file). The complexity gates forced the failure
  // submit itself out into a small extracted helper (narrateFailureIfElected) — the call site here
  // is what must stay inside the subscriber, not the raw sharedArbiter.submit(...) text.
  const start = src.indexOf("const unsubscribeSpoken = paneSignalBus.subscribe(");
  assert.ok(start >= 0, "the spoken pane-signal subscriber must still exist under this exact name");
  const end = src.indexOf("state.unsubscribePaneSignals = ()", start);
  assert.ok(end > start, "could not bound the subscriber callback body for inspection");
  const body = src.slice(start, end);
  assert.match(body, /narrateFailureIfElected\(sig, narratedFailureKinds, sharedArbiter\)/,
    "the failure branch must live inside the spoken subscriber and be handed THIS connection's " +
      "own dedupe guard plus the SAME shared arbiter the idle completion above submits through");
  assert.match(body, /sig\.kind === "idle"/, "sanity: this is indeed the idle branch's home");

  // narrateFailureIfElected itself must actually submit the elected item through the arbiter it's
  // given — pin the helper's body, not just its call site, so a future edit can't hollow it out.
  const helperStart = src.indexOf("function narrateFailureIfElected(");
  assert.ok(helperStart >= 0, "narrateFailureIfElected must be defined");
  const helperEnd = src.indexOf("\n}", helperStart);
  const helperBody = src.slice(helperStart, helperEnd);
  assert.match(helperBody, /failureNarrationItem\(sig, seen\)/, "the helper must consult failureNarrationItem");
  assert.match(helperBody, /arbiter\.submit\(/, "the helper must submit the elected item through its injected arbiter");
});
