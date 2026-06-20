// tests/test_approvalintent_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-
// complexity burndown refactor of src/approvalIntent.ts (the PURE voice approval-intent parser /
// targeting). These pin the CURRENT observable DECISIONS of the five over-limit functions so the
// behaviour-preserving refactor (extract helpers / guard clauses / typed dispatch tables / named
// predicates) can be proven not to change a single resolved intent, target, or hint.
//
// Written to be GREEN against the UNREFACTORED code FIRST (per D-6 of the spec), then kept green
// through the refactor. The existing suites (test_approvals_wse.ts, test_approval_defer.ts,
// test_voice_*.ts) already cover the happy paths richly; this file deliberately leans on the EDGE
// branches that those leave thin — exactly the lattice each high-CC function decomposes into:
//   - isDeferUtterance (CC25): every clause of the documented phrase table + negator suppression,
//     including the per-particle / per-unit Set membership and the short-"later" length guard.
//   - extractTargetHint (CC11): the longest-run fragment selection, ordinal-word precedence, and the
//     defer-vocabulary STOP words that must NOT leak into a by-name fragment.
//   - parseApprovalIntent (CC31): defer-first precedence, the bare-skip pin, the bare yes/no/clarify
//     block, the leading-negator reject directive (and its approve-domain exclusion), and the
//     weak-verb pairing / negation-window suppression in the main scan.
//   - selectApprovalTarget (CC13) + selectPendingAction (CC11): the empty/only short-circuits, the
//     fragment unique-vs-miss-vs-multi clarify posture, and the ordinal in/out-of-range branch.
//
// PURE: imports ../src/approvalIntent ONLY. No PTY, no session, no network.
//
// Runner: npx tsx --test --test-force-exit tests/test_approvalintent_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseApprovalIntent,
  selectApprovalTarget,
  selectPendingAction,
  normalizeUtterance,
} from "../src/approvalIntent";

// ═════════════════════════════════════════════════════════════════════════════
// 1. isDeferUtterance (CC25) — exercised through parseApprovalIntent's defer-first gate.
//    Every clause of the phrase table, plus the negator-suppression per phrase.
// ═════════════════════════════════════════════════════════════════════════════
describe("approvalIntent refactor — isDeferUtterance phrase-table clauses (via parseApprovalIntent)", () => {
  // (1) short utterance (<=3 tokens) containing "later".
  for (const u of ["later", "maybe later", "ok later"]) {
    it(`(1) short+later "${u}" -> defer`, () => assert.strictEqual(parseApprovalIntent(u).intent, "defer"));
  }
  // A "later" in a LONG (>3 token) utterance does NOT trip clause (1) — only an adjacency bigram could.
  it("(1) length guard: a 4+ token utterance with a lone 'later' is NOT a defer via clause 1", () => {
    // "think about it carefully later" — 5 tokens; "it later" IS a clause-2 bigram, so this DOES defer.
    // Use a phrasing where "later" has no clause-2 preceder: "later" preceded by "carefully".
    assert.strictEqual(parseApprovalIntent("we will handle everything carefully later").intent, "none",
      "a long utterance whose 'later' has no me|again|it|that|them|you preceder does not defer");
  });
  // (2) "<me|again|it|that|them|you> later" adjacency bigram (works in a long utterance too).
  for (const u of ["ask me later", "remind me later", "ask again later", "do it later", "handle that later", "tell them later"]) {
    it(`(2) bigram "${u}" -> defer`, () => assert.strictEqual(parseApprovalIntent(u).intent, "defer"));
  }
  it("(2) a non-preceder before 'later' does NOT trip the bigram (no defer from 'or later')", () => {
    // 'or' is not in DEFER_LATER_PRECEDERS, and this 6-token utterance exceeds the clause-1 length
    // guard, so 'later' does NOT defer. (The utterance resolves via the normal verb scan instead —
    // we assert only that it is NOT a defer, which is the branch under characterization.)
    assert.notStrictEqual(parseApprovalIntent("we will deploy now or later please").intent, "defer",
      "'or later' is not a defer bigram (preceder 'or' is not in the set)");
  });
  // (3) "not now" / "not yet" / "not right now".
  for (const u of ["not now", "not yet", "not right now"]) {
    it(`(3) "${u}" -> defer`, () => assert.strictEqual(parseApprovalIntent(u).intent, "defer"));
  }
  it("(3) 'not right then' is NOT clause 3 (third token must be 'now')", () => {
    assert.strictEqual(parseApprovalIntent("not right then").intent, "none");
  });
  // (4) "hold <on|off|that|it|them>" and "on hold".
  for (const u of ["hold on", "hold off", "hold that", "hold it", "hold them", "put it on hold"]) {
    it(`(4) "${u}" -> defer`, () => assert.strictEqual(parseApprovalIntent(u).intent, "defer"));
  }
  it("(4) bare 'hold' with no particle is NOT a defer", () => {
    assert.strictEqual(parseApprovalIntent("hold").intent, "none", "bare hold needs its particle");
  });
  it("(4) negator before 'hold <particle>' suppresses the defer", () => {
    assert.notStrictEqual(parseApprovalIntent("dont hold it").intent, "defer");
  });
  // (5) "in a <minute|moment|bit|second|sec|while|few>".
  for (const u of ["in a minute", "in a moment", "in a bit", "in a second", "in a sec", "in a while", "in a few"]) {
    it(`(5) "${u}" -> defer`, () => assert.strictEqual(parseApprovalIntent(u).intent, "defer"));
  }
  it("(5) 'in a hurry' is NOT clause 5 (unit not in the set)", () => {
    assert.strictEqual(parseApprovalIntent("in a hurry").intent, "none");
  });
  // (6) "for now" + any of {skip,hold,wait,leave,park,pass,not} anywhere.
  for (const u of ["skip for now", "skip that for now", "leave it for now", "wait for now", "park it for now", "pass for now", "not for now"]) {
    it(`(6) "${u}" -> defer`, () => assert.strictEqual(parseApprovalIntent(u).intent, "defer"));
  }
  it("(6) 'for now' WITHOUT a parking verb is NOT clause 6", () => {
    assert.strictEqual(parseApprovalIntent("approve it for now").intent, "approve",
      "'for now' with no skip/hold/wait/leave/park/pass/not stays in the approve lane");
  });
  it("the exact card scenario 'skip that for now, ask me later' -> defer (non-destructive wins)", () => {
    assert.strictEqual(parseApprovalIntent("skip that for now, ask me later").intent, "defer");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. extractTargetHint (CC11) — longest-run fragment + ordinal-word precedence + STOP leakage.
//    Exercised through parseApprovalIntent (the only caller path that surfaces the hint).
// ═════════════════════════════════════════════════════════════════════════════
describe("approvalIntent refactor — extractTargetHint (fragment / ordinal / STOP words)", () => {
  it("ordinal word wins and is captured as the ordinal (first match breaks the loop)", () => {
    const p = parseApprovalIntent("reject the second one");
    assert.strictEqual(p.intent, "reject");
    assert.strictEqual(p.targetHint?.ordinal, 2);
  });
  it("ordinal 'last'/'latest'/'previous' -> -1", () => {
    for (const w of ["last", "latest", "previous"]) {
      const p = parseApprovalIntent(`approve the ${w} one`);
      assert.strictEqual(p.targetHint?.ordinal, -1, `${w} -> -1`);
    }
  });
  it("fragment: the longest non-stopword run is chosen", () => {
    // "npm install" (2 toks) vs a lone earlier word — longest run wins.
    const p = parseApprovalIntent("approve the npm install command");
    assert.strictEqual(p.targetHint?.fragment, "npm install");
  });
  it("defer vocabulary ('later'/'hold'/'for'/'now'/'ask'/'me') is a STOP word — never leaks into a fragment", () => {
    const p = parseApprovalIntent("skip the npm install for now");
    assert.strictEqual(p.intent, "defer");
    assert.strictEqual(p.targetHint?.fragment, "npm install",
      "the by-name target is just 'npm install', not 'later'/'hold'/'for now'");
  });
  it("no fragment and no ordinal -> targetHint is undefined", () => {
    const p = parseApprovalIntent("approve it");
    // "it" is an OBJECT_TOKEN (stop word) and there is no ordinal/fragment -> no hint.
    assert.strictEqual(p.targetHint, undefined);
  });
  it("a later, LONGER run replaces an earlier shorter run (best-of tracking)", () => {
    // "a" then "docker compose up" — the 3-token run must win over the empty/short earlier ones.
    const p = parseApprovalIntent("approve the docker compose up command");
    assert.strictEqual(p.targetHint?.fragment, "docker compose up");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. parseApprovalIntent (CC31) — precedence ladder + main verb scan edges.
// ═════════════════════════════════════════════════════════════════════════════
describe("approvalIntent refactor — parseApprovalIntent precedence + scan", () => {
  it("empty / whitespace-only -> none", () => {
    assert.strictEqual(parseApprovalIntent("").intent, "none");
    assert.strictEqual(parseApprovalIntent("   ").intent, "none");
    assert.strictEqual(parseApprovalIntent("!!! ???").intent, "none");
  });
  it("defer is checked FIRST: a mixed 'no, later' resolves defer (non-destructive wins)", () => {
    assert.strictEqual(parseApprovalIntent("no, later").intent, "defer");
  });
  it("bare-skip pin: 'skip' / 'skip it|that|this' (<=2 toks, no 'for now') -> reject", () => {
    for (const u of ["skip", "skip it", "skip that", "skip this"]) {
      assert.strictEqual(parseApprovalIntent(u).intent, "reject", `${u} -> reject`);
    }
  });
  it("bare-skip pin does NOT fire for 3+ tokens or a non-it/that/this 2nd token", () => {
    // "skip the command" is 3 tokens -> falls through to the main scan (no bare-skip pin) -> reject via 'skip' weak?
    // 'skip' is REJECT_WEAK and "command" is an object token within window -> reject.
    assert.strictEqual(parseApprovalIntent("skip the command").intent, "reject");
    // "skip ahead" -> bare-skip pin requires it/that/this; 'ahead' is not an object token -> none.
    assert.strictEqual(parseApprovalIntent("skip ahead").intent, "none");
  });
  it("bare yes/no block (<=2 toks): yes->approve, no->reject, both->clarify", () => {
    assert.strictEqual(parseApprovalIntent("yes").intent, "approve");
    assert.strictEqual(parseApprovalIntent("yep").intent, "approve");
    assert.strictEqual(parseApprovalIntent("no").intent, "reject");
    assert.strictEqual(parseApprovalIntent("nope").intent, "reject");
    assert.strictEqual(parseApprovalIntent("yes no").intent, "clarify");
  });
  it("leading-negator reject DIRECTIVE: 'dont run'/'never go'/'dont execute' -> reject", () => {
    for (const u of ["dont run", "never go", "dont execute", "dont proceed"]) {
      assert.strictEqual(parseApprovalIntent(u).intent, "reject", `${u} -> reject directive`);
    }
  });
  it("leading-negator EXCLUDES the approve domain: 'dont approve'/'dont confirm' -> none (never an inferred reject)", () => {
    for (const u of ["dont approve", "dont confirm", "dont accept", "dont authorize"]) {
      assert.strictEqual(parseApprovalIntent(u).intent, "none", `${u} -> none`);
    }
  });
  it("the spelled 'do not run it' is NOT a directive (negation window suppresses the weak verb) -> none", () => {
    assert.strictEqual(parseApprovalIntent("do not run it").intent, "none");
  });
  it("STRONG verb resolves on its own; a NEGATED strong verb is suppressed", () => {
    assert.strictEqual(parseApprovalIntent("reject").intent, "reject", "lone strong reject resolves");
    assert.strictEqual(parseApprovalIntent("please reject").intent, "reject");
    assert.strictEqual(parseApprovalIntent("dont reject it").intent, "none",
      "a negated strong reject within the window is suppressed");
  });
  it("WEAK verb needs a nearby object AND >2 tokens: 'run it' (2 toks) -> none; 'run the command' -> approve", () => {
    assert.strictEqual(parseApprovalIntent("run it").intent, "none", "bare weak verb + lone pronoun is under-specified");
    assert.strictEqual(parseApprovalIntent("run the command").intent, "approve");
  });
  it("approve+reject both triggered -> clarify (NEVER default-approve)", () => {
    assert.strictEqual(parseApprovalIntent("approve but actually reject it").intent, "clarify");
  });
  it("negated reject leaves a surviving approve -> approve (no double-negative inference)", () => {
    assert.strictEqual(parseApprovalIntent("yes approve, no reject the command").intent, "approve");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. selectApprovalTarget (CC13) — short-circuits, fragment posture, ordinal range.
// ═════════════════════════════════════════════════════════════════════════════
describe("approvalIntent refactor — selectApprovalTarget branches", () => {
  const E = [
    { messageId: "m1", instruction: "npm install", terminalId: "pane_a" },
    { messageId: "m2", instruction: "rm -rf build", terminalId: "pane_b" },
    { messageId: "m3", instruction: "docker build .", terminalId: "pane_c" },
  ];
  it("empty list -> {} (no message, no ambiguous)", () => {
    assert.deepStrictEqual(selectApprovalTarget([], { fragment: "x" }, "anything"), {});
  });
  it("exactly one -> that one via 'only' (regardless of hint/lastAnnounced)", () => {
    const r = selectApprovalTarget([E[0]], { ordinal: 9 }, "ignored");
    assert.strictEqual(r.messageId, "m1");
    assert.strictEqual(r.via, "only");
  });
  it("fragment unique match -> that one via 'fragment'", () => {
    const r = selectApprovalTarget(E, { fragment: "docker" }, null);
    assert.strictEqual(r.messageId, "m3");
    assert.strictEqual(r.via, "fragment");
  });
  it("fragment ZERO matches with >1 pending -> ambiguous (never falls through to lastAnnounced)", () => {
    const r = selectApprovalTarget(E, { fragment: "kubernetes" }, "m3");
    assert.ok(r.ambiguous);
    assert.strictEqual(r.messageId, undefined);
  });
  it("fragment MULTI match -> ambiguous", () => {
    const r = selectApprovalTarget(E, { fragment: "build" }, null); // matches m2 (rm -rf build) and m3 (docker build)
    assert.ok(r.ambiguous);
  });
  it("multi-token fragment requires ALL tokens present in one entry", () => {
    const r = selectApprovalTarget(E, { fragment: "npm install" }, null);
    assert.strictEqual(r.messageId, "m1");
    assert.strictEqual(r.via, "fragment");
  });
  it("ordinal in range -> that index via 'ordinal'; -1 -> last", () => {
    assert.strictEqual(selectApprovalTarget(E, { ordinal: 2 }, null).messageId, "m2");
    assert.strictEqual(selectApprovalTarget(E, { ordinal: -1 }, null).messageId, "m3");
  });
  it("ordinal OUT of range -> ambiguous", () => {
    assert.ok(selectApprovalTarget(E, { ordinal: 9 }, null).ambiguous);
    assert.ok(selectApprovalTarget(E, { ordinal: 0 }, null).ambiguous, "0 -> idx -1 out of range");
  });
  it("no hint + lastAnnounced present in list -> that id via 'lastAnnounced'", () => {
    const r = selectApprovalTarget(E, undefined, "m2");
    assert.strictEqual(r.messageId, "m2");
    assert.strictEqual(r.via, "lastAnnounced");
  });
  it("no hint + lastAnnounced NOT in list -> ambiguous", () => {
    assert.ok(selectApprovalTarget(E, undefined, "ghost").ambiguous);
  });
  it("no hint + null lastAnnounced + >1 pending -> ambiguous", () => {
    assert.ok(selectApprovalTarget(E, undefined, null).ambiguous);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. selectPendingAction (CC11) — sibling targeting for staged actions.
// ═════════════════════════════════════════════════════════════════════════════
describe("approvalIntent refactor — selectPendingAction branches", () => {
  const A = { id: "a", summary: "Create pane A in proj" };
  const B = { id: "b", summary: "Set global permissions to Full Auto" };
  it("empty list -> {}", () => assert.deepStrictEqual(selectPendingAction([], { fragment: "x" }), {}));
  it("exactly one -> that one via 'only' (id + summary)", () => {
    const r = selectPendingAction([A], { ordinal: 9 });
    assert.deepStrictEqual({ id: r.id, summary: r.summary, via: r.via }, { id: "a", summary: A.summary, via: "only" });
  });
  it("ordinal precedes fragment: ordinal in range -> that index via 'ordinal'", () => {
    const r = selectPendingAction([A, B], { ordinal: 2 });
    assert.strictEqual(r.id, "b");
    assert.strictEqual(r.via, "ordinal");
  });
  it("ordinal -1 -> last; ordinal out of range -> ambiguous", () => {
    assert.strictEqual(selectPendingAction([A, B], { ordinal: -1 }).id, "b");
    assert.ok(selectPendingAction([A, B], { ordinal: 9 }).ambiguous);
  });
  it("fragment unique -> that one via 'fragment'; miss -> ambiguous", () => {
    assert.strictEqual(selectPendingAction([A, B], { fragment: "global permissions" }).id, "b");
    assert.ok(selectPendingAction([A, B], { fragment: "nonexistent" }).ambiguous);
    // "pane" appears only in summary A -> a UNIQUE match resolves it via 'fragment'.
    const uniq = selectPendingAction([A, B], { fragment: "pane" });
    assert.strictEqual(uniq.id, "a");
    assert.strictEqual(uniq.via, "fragment");
  });
  it(">1 with no hint -> ambiguous", () => {
    const r = selectPendingAction([A, B], undefined);
    assert.ok(r.ambiguous);
    assert.strictEqual(r.id, undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. normalizeUtterance — the shared tokenizer the targeting/fragment paths depend on.
// ═════════════════════════════════════════════════════════════════════════════
describe("approvalIntent refactor — normalizeUtterance invariants", () => {
  it("lowercases, strips every apostrophe variant, punctuation->space, collapses ws", () => {
    assert.strictEqual(normalizeUtterance("Don’t  RUN it!"), "dont run it");
    assert.strictEqual(normalizeUtterance("can`t  do  that"), "cant do that");
    assert.strictEqual(normalizeUtterance("  multiple   spaces  "), "multiple spaces");
  });
});
