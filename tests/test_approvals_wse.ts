import { describe, it } from "node:test";
import assert from "node:assert";

import {
  parseApprovalIntent,
  selectApprovalTarget,
  normalizeUtterance,
} from "../src/approvalIntent";
import {
  PendingApprovalStore,
  decideProposal,
  inferKind,
  isShellAllowed,
  firstShellToken,
  loadShellAllowlist,
  serializePending,
  type PendingApproval,
} from "../src/pendingApprovals";

/**
 * WS-E — Spoken, targeted, safe approvals. Tests for the PURE, framework-free pieces
 * (parser/targeting/gate-decision/store) plus a gate-path integration sim driving the
 * real store + a fake terminal + a fake session that records sendToolResponse/writeInput.
 * No PTY, no Gemini, no network — the suite must exit clean (no timers armed here).
 */

// ---------------------------------------------------------------------------
// WS-E.2 — parseApprovalIntent (BUG-008): negation / apostrophe / collision table
// ---------------------------------------------------------------------------
describe("parseApprovalIntent (BUG-008)", () => {
  const cases: Array<[string, string]> = [
    // negation window (3 tokens): the trigger verb is negated -> no resolution
    ["I don't want to cancel the build", "none"],
    ["do not run it", "none"],
    ["no, don't approve that command", "none"],
    // apostrophe drop (ASR): "dont run it" -> reject ("dont" normalizes, pairs with "it")
    ["dont run it", "reject"],
    ["cant approve that", "none"], // "cant" negates approve -> none
    // collision -> clarify, NEVER default-approve
    ["approve but actually reject it", "clarify"],
    // "no reject" negates the reject -> only the explicit approve survives (no double-negative inference)
    ["yes approve, no reject the command", "approve"],
    // bare ambient speech (no explicit pairing) -> none
    ["we execute carefully here", "none"],
    ["let me think about cancelling later maybe", "none"],
    // explicit pairing -> approve / reject
    ["approve command", "approve"],
    ["approve the npm install one", "approve"],
    ["reject the docker command", "reject"],
    ["cancel that command", "reject"],
    // short whole-utterance affirmations
    ["yes", "approve"],
    ["no", "reject"],
  ];
  for (const [utter, expected] of cases) {
    it(`"${utter}" -> ${expected}`, () => {
      assert.strictEqual(parseApprovalIntent(utter).intent, expected);
    });
  }

  it("normalizeUtterance drops apostrophes and lowercases", () => {
    assert.strictEqual(normalizeUtterance("Don’t RUN it!"), "dont run it");
  });

  it("extracts a fragment target hint", () => {
    const p = parseApprovalIntent("approve the npm install command");
    assert.strictEqual(p.intent, "approve");
    assert.ok(p.targetHint?.fragment?.includes("npm install"));
  });

  it("extracts an ordinal target hint", () => {
    const p = parseApprovalIntent("reject the second one");
    assert.strictEqual(p.intent, "reject");
    assert.strictEqual(p.targetHint?.ordinal, 2);
  });
});

// ---------------------------------------------------------------------------
// WS-E.2 — targeting (BUG-007): 3 pending, fragment/ordinal, ambiguity -> clarify
// ---------------------------------------------------------------------------
describe("selectApprovalTarget (BUG-007)", () => {
  const entries = [
    { messageId: "m1", instruction: "npm install", terminalId: "pane_a" },
    { messageId: "m2", instruction: "rm -rf build", terminalId: "pane_b" },
    { messageId: "m3", instruction: "docker build .", terminalId: "pane_c" },
  ];

  it("fragment 'npm install' resolves m1 (not FIFO/oldest collision)", () => {
    const r = selectApprovalTarget(entries, { fragment: "npm install" }, null);
    assert.strictEqual(r.messageId, "m1");
    assert.strictEqual(r.via, "fragment");
  });

  it("fragment matching a pane id resolves it", () => {
    const r = selectApprovalTarget(entries, { fragment: "pane_c" }, null);
    assert.strictEqual(r.messageId, "m3");
  });

  it("ordinal 'second' resolves m2 in announced order", () => {
    const r = selectApprovalTarget(entries, { ordinal: 2 }, null);
    assert.strictEqual(r.messageId, "m2");
    assert.strictEqual(r.via, "ordinal");
  });

  it("ordinal 'last' resolves m3", () => {
    const r = selectApprovalTarget(entries, { ordinal: -1 }, null);
    assert.strictEqual(r.messageId, "m3");
  });

  it("no hint + lastAnnounced binds to that id, not [0]", () => {
    const r = selectApprovalTarget(entries, undefined, "m3");
    assert.strictEqual(r.messageId, "m3");
    assert.strictEqual(r.via, "lastAnnounced");
  });

  it("ambiguous (>1 pending, no hint, no lastAnnounced) -> clarify, never resolve", () => {
    const r = selectApprovalTarget(entries, undefined, null);
    assert.ok(r.ambiguous);
    assert.strictEqual(r.messageId, undefined);
  });

  it("single pending resolves directly", () => {
    const r = selectApprovalTarget([entries[0]], undefined, null);
    assert.strictEqual(r.messageId, "m1");
    assert.strictEqual(r.via, "only");
  });
});

// ---------------------------------------------------------------------------
// R1/R2 — kind discriminator + back-compat inference + non-allowlisted-shell clarify
// ---------------------------------------------------------------------------
describe("decideProposal — kind / allowlist / mode gate (R1/R2)", () => {
  const allow = loadShellAllowlist("git,ls,cat,pwd");

  it("inferKind: explicit wins; shell pane -> shell; cli pane -> agent_instruction", () => {
    assert.strictEqual(inferKind("shell", "interactive_cli"), "shell");
    assert.strictEqual(inferKind(undefined, "shell"), "shell");
    assert.strictEqual(inferKind(undefined, "interactive_cli"), "agent_instruction");
    assert.strictEqual(inferKind(undefined, undefined), "agent_instruction");
  });

  it("firstShellToken / isShellAllowed", () => {
    assert.strictEqual(firstShellToken("git status --short"), "git");
    assert.ok(isShellAllowed("git status", allow));
    assert.ok(!isShellAllowed("rm -rf /", allow));
  });

  it("agent_instruction on interactive_cli + HiTL -> pending_approval", () => {
    const d = decideProposal({ kind: "agent_instruction", instruction: "add a retry", effectiveMode: "Human-in-the-Loop", runtimeType: "interactive_cli", paneExists: true, allowlist: allow });
    assert.strictEqual(d.type, "pending_approval");
  });

  it("agent_instruction on a raw shell pane -> error_kind_mismatch", () => {
    const d = decideProposal({ kind: "agent_instruction", instruction: "do the thing", effectiveMode: "Human-in-the-Loop", runtimeType: "shell", paneExists: true, allowlist: allow });
    assert.strictEqual(d.type, "error_kind_mismatch");
  });

  it("allowlisted shell + Full Auto -> auto_execute", () => {
    const d = decideProposal({ kind: "shell", instruction: "git status", effectiveMode: "Full Auto", runtimeType: "shell", paneExists: true, allowlist: allow });
    assert.strictEqual(d.type, "auto_execute");
  });

  it("NON-allowlisted shell -> clarify (re-route), NEVER executes — even in Full Auto", () => {
    const d = decideProposal({ kind: "shell", instruction: "npm run build", effectiveMode: "Full Auto", runtimeType: "shell", paneExists: true, allowlist: allow });
    assert.strictEqual(d.type, "clarify_shell");
  });

  it("Read-Only blocks both kinds", () => {
    const d = decideProposal({ kind: "shell", instruction: "git status", effectiveMode: "Read-Only", runtimeType: "shell", paneExists: true, allowlist: allow });
    assert.strictEqual(d.type, "blocked_read_only");
  });

  it("missing pane -> error_no_pane", () => {
    const d = decideProposal({ kind: "agent_instruction", instruction: "x", effectiveMode: "Human-in-the-Loop", runtimeType: undefined, paneExists: false, allowlist: allow });
    assert.strictEqual(d.type, "error_no_pane");
  });
});

// ---------------------------------------------------------------------------
// Store: serializable shape, session side-map, ordered index, claim, TTL, purge
// ---------------------------------------------------------------------------
function mkRecord(id: string, terminalId: string, instruction: string, ts = Date.now()): PendingApproval {
  return { messageId: id, instruction, kind: "agent_instruction", terminalId, callId: id, timestamp: ts };
}

describe("PendingApprovalStore", () => {
  it("keeps announced order, scopes by session, exposes lastAnnounced", () => {
    const store = new PendingApprovalStore();
    const s1 = { id: "s1" }, s2 = { id: "s2" };
    store.add(mkRecord("a", "p1", "one"), s1);
    store.add(mkRecord("b", "p2", "two"), s2);
    store.add(mkRecord("c", "p3", "three"), s1);
    assert.deepStrictEqual(store.forSession(s1).map((r) => r.messageId), ["a", "c"]);
    assert.strictEqual(store.lastAnnouncedFor(s1), "c");
    assert.strictEqual(store.forSession(s2).length, 1);
  });

  it("claim() is single-winner (WS-F double-dispatch seam)", () => {
    const store = new PendingApprovalStore();
    store.add(mkRecord("a", "p1", "one"), {});
    assert.strictEqual(store.claim("a"), true);
    assert.strictEqual(store.claim("a"), false); // a 2nd approver loses
  });

  it("expired() returns TTL-aged unclaimed entries; serialize redacts + ages", () => {
    const store = new PendingApprovalStore();
    const now = 1_000_000;
    store.add(mkRecord("old", "p1", "stale cmd", now - 10 * 60 * 1000), {});
    store.add(mkRecord("new", "p2", "fresh cmd", now), {});
    const expired = store.expired(5 * 60 * 1000, now);
    assert.deepStrictEqual(expired.map((e) => e.messageId), ["old"]);
    const ser = serializePending(store.get("old")!);
    assert.strictEqual(ser.cmd, "stale cmd"); // back-compat alias present
    assert.ok(typeof ser.ageSeconds === "number");
  });

  it("redacts secrets in the serialized instruction/cmd", () => {
    const store = new PendingApprovalStore();
    store.add(mkRecord("s", "p1", "deploy with AKIAABCDEFGHIJKLMNOP"), {});
    const ser = serializePending(store.get("s")!);
    assert.ok(!ser.instruction.includes("AKIA"));
    assert.ok(ser.instruction.includes("[REDACTED"));
  });

  it("purgeSession removes only that session's entries", () => {
    const store = new PendingApprovalStore();
    const s1 = {}, s2 = {};
    store.add(mkRecord("a", "p1", "x"), s1);
    store.add(mkRecord("b", "p2", "y"), s2);
    const purged = store.purgeSession(s1);
    assert.deepStrictEqual(purged, ["a"]);
    assert.strictEqual(store.has("a"), false);
    assert.strictEqual(store.has("b"), true);
  });
});

// ---------------------------------------------------------------------------
// Gate-path integration sim (closes part of BUG-038): real store + fake term/session.
// Mirrors the server's dispatch/resolve flow without the Live closure.
// ---------------------------------------------------------------------------
class FakeTerm {
  public writes: string[] = [];
  constructor(public runtimeType: "shell" | "interactive_cli", public permissionsMode: string) {}
  writeInput(s: string) { this.writes.push(s); }
}
class FakeSession {
  public toolResponses: any[] = [];
  public clientContents: any[] = [];
  sendToolResponse(r: any) { this.toolResponses.push(r); }
  sendClientContent(c: any) { this.clientContents.push(c); }
}

/** A trimmed re-implementation of the server's dispatch+resolve wiring over the real
 *  store/decision modules, so the two-phase + targeting + dead-pane + plan-no-autoexec
 *  invariants are asserted on the real logic. */
function makeHarness() {
  const store = new PendingApprovalStore();
  const allow = loadShellAllowlist("git,ls,cat,pwd");
  const terms: Record<string, FakeTerm> = {};

  function dispatch(session: FakeSession, callId: string, pendingId: string, paneId: string, instruction: string, kind: any, globalMode = "Inherit") {
    const term = terms[paneId];
    const paneExists = !!term;
    const runtimeType = term?.runtimeType as any;
    const effectiveMode = (globalMode === "Inherit" ? (term ? term.permissionsMode : "Human-in-the-Loop") : globalMode) as any;
    const k = inferKind(kind, runtimeType);
    const d = decideProposal({ kind: k, instruction, effectiveMode, runtimeType, paneExists, allowlist: allow });
    if (d.type === "auto_execute") {
      term!.writeInput(instruction);
      session.sendToolResponse({ functionResponses: [{ name: "propose_command", id: callId, response: { output: "executed" } }] });
      return "executed";
    }
    if (d.type === "pending_approval") {
      store.add({ messageId: pendingId, instruction, kind: k, terminalId: paneId, callId, timestamp: Date.now() }, session);
      session.sendToolResponse({ functionResponses: [{ name: "propose_command", id: callId, response: { status: "pending_approval" } }] });
      return "pending";
    }
    if (d.type === "clarify_shell") {
      session.sendToolResponse({ functionResponses: [{ name: "propose_command", id: callId, response: { status: "clarify" } }] });
      return "clarify";
    }
    session.sendToolResponse({ functionResponses: [{ name: "propose_command", id: callId, response: { output: d.type } }] });
    return d.type;
  }

  // P0-1/R3: resolution mirrors production — `call.id` was already answered ONCE by the
  // non-blocking `pending_approval` response at proposal time, so resolution NEVER sends a
  // second `sendToolResponse`. The model-facing outcome is delivered ONLY via the
  // `sendClientContent` push (the read-back/narration).
  function resolve(session: FakeSession, messageId: string, approve: boolean) {
    const p = store.get(messageId);
    if (!p) return;
    if (approve) {
      const term = terms[p.terminalId];
      if (!term) { // BUG-020 dead pane -> error via push, no write, no 2nd tool response
        store.delete(messageId);
        session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "Error: pane gone" }] }], turnComplete: true });
        return;
      }
      if (!store.claim(messageId)) return;
      term.writeInput(p.instruction);
      session.sendClientContent({ turns: [{ role: "user", parts: [{ text: `Operator approved; dispatched to ${p.terminalId}.` }] }], turnComplete: true });
    } else {
      session.sendClientContent({ turns: [{ role: "user", parts: [{ text: `Operator rejected on ${p.terminalId}.` }] }], turnComplete: true });
    }
    store.delete(messageId);
  }

  // P0-3: a trimmed model of `handlePlansTrigger` advancement — step completion routes the
  // NEXT step's write through the SAME gated `dispatch` (never an un-gated writeInput).
  function advancePlan(session: FakeSession, planId: string, nextIndex: number, paneId: string, command: string, kind: any) {
    return dispatch(session, `plan__${planId}__step${nextIndex}`, `plan__${planId}__step${nextIndex}`, paneId, command, kind);
  }

  return { store, terms, dispatch, resolve, advancePlan };
}

describe("WS-E gate path integration (BUG-001/BUG-038)", () => {
  it("HiTL proposal sends a NON-BLOCKING pending_approval (Janus not muted) and does NOT write", () => {
    const h = makeHarness();
    h.terms["pane_a"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    const sess = new FakeSession();
    const r = h.dispatch(sess, "call1", "call1", "pane_a", "add a retry", undefined);
    assert.strictEqual(r, "pending");
    assert.strictEqual(sess.toolResponses.length, 1, "call.id answered exactly once");
    assert.strictEqual(sess.toolResponses[0].functionResponses[0].response.status, "pending_approval");
    assert.strictEqual(h.terms["pane_a"].writes.length, 0, "nothing executed before approval");
  });

  it("a subsequent approve writes exactly once and the claim blocks a double-dispatch", () => {
    const h = makeHarness();
    h.terms["pane_a"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    const sess = new FakeSession();
    h.dispatch(sess, "call1", "call1", "pane_a", "run the tests", undefined);
    // race: REST + voice approve the same id
    h.resolve(sess, "call1", true);
    h.resolve(sess, "call1", true);
    assert.deepStrictEqual(h.terms["pane_a"].writes, ["run the tests"]);
  });

  it("P0-1: approve answers call.id EXACTLY ONCE (the pending response); outcome via push", () => {
    const h = makeHarness();
    h.terms["pane_a"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    const sess = new FakeSession();
    h.dispatch(sess, "call1", "call1", "pane_a", "run the tests", undefined);
    h.resolve(sess, "call1", true);
    // The functionCall id was answered ONCE (the non-blocking pending_approval); resolution
    // must NOT add a second tool response — it narrates via sendClientContent.
    const answersForCall = sess.toolResponses.filter(
      (tr) => tr.functionResponses?.[0]?.id === "call1"
    );
    assert.strictEqual(answersForCall.length, 1, "call.id answered exactly once");
    assert.strictEqual(answersForCall[0].functionResponses[0].response.status, "pending_approval");
    assert.ok(sess.clientContents.length >= 1, "outcome delivered via sendClientContent push");
  });

  it("P0-1: reject also answers call.id exactly once and narrates via push", () => {
    const h = makeHarness();
    h.terms["pane_a"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    const sess = new FakeSession();
    h.dispatch(sess, "callR", "callR", "pane_a", "deploy", undefined);
    h.resolve(sess, "callR", false);
    const answers = sess.toolResponses.filter((tr) => tr.functionResponses?.[0]?.id === "callR");
    assert.strictEqual(answers.length, 1, "call.id answered exactly once on reject");
    assert.strictEqual(h.terms["pane_a"].writes.length, 0, "reject writes nothing");
    assert.ok(sess.clientContents.length >= 1, "reject narrated via push");
  });

  it("kind:'shell' non-allowlisted -> clarify, no dispatch (even Full Auto)", () => {
    const h = makeHarness();
    h.terms["sh"] = new FakeTerm("shell", "Full Auto");
    const sess = new FakeSession();
    const r = h.dispatch(sess, "c", "c", "sh", "npm run build", "shell", "Full Auto");
    assert.strictEqual(r, "clarify");
    assert.strictEqual(h.terms["sh"].writes.length, 0);
  });

  it("BUG-020: approving a dead pane -> spoken error via push, no write, no 2nd tool response", () => {
    const h = makeHarness();
    h.terms["pane_a"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    const sess = new FakeSession();
    h.dispatch(sess, "call1", "call1", "pane_a", "deploy", undefined);
    delete h.terms["pane_a"]; // pane killed before approval
    h.resolve(sess, "call1", true);
    // call.id still answered exactly once (the pending response); the dead-pane error is a push.
    const answers = sess.toolResponses.filter((tr) => tr.functionResponses?.[0]?.id === "call1");
    assert.strictEqual(answers.length, 1, "no second tool response on dead-pane approve");
    const lastPush = sess.clientContents[sess.clientContents.length - 1].turns[0].parts[0].text;
    assert.ok(String(lastPush).includes("pane gone"));
    assert.strictEqual(h.store.has("call1"), false);
  });

  it("targeting: 3 pending, 'approve the npm install' dispatches ONLY that, to its pane", () => {
    const h = makeHarness();
    h.terms["pane_a"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    h.terms["pane_b"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    h.terms["pane_c"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    const sess = new FakeSession();
    h.dispatch(sess, "c1", "c1", "pane_a", "npm install", undefined);
    h.dispatch(sess, "c2", "c2", "pane_b", "rm -rf build", undefined);
    h.dispatch(sess, "c3", "c3", "pane_c", "docker build .", undefined);

    const parsed = parseApprovalIntent("approve the npm install one");
    const entries = h.store.forSession(sess).map((e) => ({ messageId: e.messageId, instruction: e.instruction, terminalId: e.terminalId }));
    const target = selectApprovalTarget(entries, parsed.targetHint, h.store.lastAnnouncedFor(sess));
    assert.strictEqual(parsed.intent, "approve");
    assert.strictEqual(target.messageId, "c1");
    h.resolve(sess, target.messageId!, true);

    assert.deepStrictEqual(h.terms["pane_a"].writes, ["npm install"]);
    assert.strictEqual(h.terms["pane_b"].writes.length, 0, "destructive sibling untouched");
    assert.strictEqual(h.terms["pane_c"].writes.length, 0);
  });

  it("R4: a HiTL plan step does NOT auto-execute (becomes a pending approval)", () => {
    // The execute_plan path routes its step through the SAME dispatch as propose_command,
    // with a synthetic pendingId, so in HiTL the step is held, not written.
    const h = makeHarness();
    h.terms["build"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    const sess = new FakeSession();
    const r = h.dispatch(sess, "planCall", "planCall__plan1__step0", "build", "npm run build", undefined);
    assert.strictEqual(r, "pending");
    assert.strictEqual(h.terms["build"].writes.length, 0, "HiTL plan step must NOT auto-run");
    assert.ok(h.store.has("planCall__plan1__step0"));
  });

  it("Full Auto plan step DOES run immediately", () => {
    const h = makeHarness();
    h.terms["build"] = new FakeTerm("interactive_cli", "Full Auto");
    const sess = new FakeSession();
    const r = h.dispatch(sess, "planCall", "planCall__plan1__step0", "build", "npm run build", undefined, "Full Auto");
    assert.strictEqual(r, "executed");
    assert.deepStrictEqual(h.terms["build"].writes, ["npm run build"]);
  });

  it("P0-3: a HiTL multi-step plan does NOT auto-execute steps 2..N (advancement is gated)", () => {
    // Step 1 ran; step 1 completes -> the orchestrator advances to step 2. That advancement
    // MUST route the NEXT step's write through the gate (a pending approval in HiTL), NOT a
    // bare un-gated writeInput. This is the least-authority hole P0-3 closes.
    const h = makeHarness();
    h.terms["s1"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    h.terms["s2"] = new FakeTerm("interactive_cli", "Human-in-the-Loop");
    const sess = new FakeSession();

    // step 0 proposed (HiTL pending), then operator approves it -> it runs on s1.
    h.dispatch(sess, "planCall", "plan__plan1__step0", "s1", "build", undefined);
    h.resolve(sess, "plan__plan1__step0", true);
    assert.deepStrictEqual(h.terms["s1"].writes, ["build"], "step 1 ran after approval");

    // step 1 completes -> advancement to step 2 (index 1) must be GATED, not auto-written.
    const adv = h.advancePlan(sess, "plan1", 1, "s2", "deploy", undefined);
    assert.strictEqual(adv, "pending", "step 2 must become a pending approval, not auto-run");
    assert.strictEqual(h.terms["s2"].writes.length, 0, "step 2 must NOT auto-execute");
    assert.ok(h.store.has("plan__plan1__step1"), "step 2 held as a pending approval");
  });

  it("P0-3: Full Auto plan advancement runs the next step immediately (still through the gate)", () => {
    const h = makeHarness();
    h.terms["s2"] = new FakeTerm("interactive_cli", "Full Auto");
    const sess = new FakeSession();
    const adv = h.advancePlan(sess, "plan1", 1, "s2", "deploy", undefined);
    assert.strictEqual(adv, "executed");
    assert.deepStrictEqual(h.terms["s2"].writes, ["deploy"]);
  });

  it("P0-3: Read-Only plan advancement is blocked (no write)", () => {
    const h = makeHarness();
    h.terms["s2"] = new FakeTerm("interactive_cli", "Read-Only");
    const sess = new FakeSession();
    const adv = h.advancePlan(sess, "plan1", 1, "s2", "deploy", undefined);
    assert.strictEqual(adv, "blocked_read_only");
    assert.strictEqual(h.terms["s2"].writes.length, 0);
  });
});
