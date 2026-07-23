import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { SCORES } from "../src/voice/synthLane/scores";
import { createConductor, Command } from "../src/voice/synthLane/conductor";

test("purity check: conductor.ts source contains no Date.now", () => {
  const conductorPath = path.resolve("src/voice/synthLane/conductor.ts");
  const source = fs.readFileSync(conductorPath, "utf8");
  assert.equal(source.includes("Date.now"), false, "conductor.ts must not reference Date.now");
});

test("spike score transitions SPEAKING -> AWAIT_MODEL -> SCENARIO_DONE", () => {
  const conductor = createConductor(SCORES.spike, { quiescenceMs: 1200 });
  conductor.onClock(1000);

  // Step 1: START_UTTERANCE for initial say
  const cmd1 = conductor.step();
  assert.equal(cmd1.type, "START_UTTERANCE");
  assert.equal(cmd1.index, 0);

  // Step 2: Now in AWAIT_MODEL
  const cmd2 = conductor.step();
  assert.equal(cmd2.type, "WAIT");

  // Send Janus transcript and audio frame
  conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Hello there" });
  conductor.onFrame({ type: "audio" });
  conductor.onClock(1100);

  // Still within quiescence window (100ms since audio)
  assert.equal(conductor.step().type, "WAIT");

  // Advance clock beyond quiescenceMs (1100 + 1201 = 2301)
  conductor.onClock(2301);

  // Turn completes, scenario finishes
  const cmd3 = conductor.step();
  assert.equal(cmd3.type, "SCENARIO_DONE");

  const out = conductor.outcome();
  assert.equal(out.status, "DONE");
  assert.equal(out.janusTranscripts, 1);
  assert.equal(out.modelBubbles, 1);
});

test("turn-over detection: audio frames inside window prevent premature advance", () => {
  const conductor = createConductor(SCORES.dictation, { quiescenceMs: 1200 });
  conductor.onClock(1000);

  // Turn 0: say -> START_UTTERANCE
  assert.equal(conductor.step().type, "START_UTTERANCE");

  // AWAIT_MODEL
  conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Turn 1 response" });
  conductor.onFrame({ type: "audio" }); // at t=1000

  conductor.onClock(1800); // 800ms elapsed (<1200)
  assert.equal(conductor.step().type, "WAIT");

  // Another audio frame arrives at t=1800
  conductor.onFrame({ type: "audio" });

  conductor.onClock(2800); // 1000ms since last audio (<1200) -> stay AWAIT_MODEL
  assert.equal(conductor.step().type, "WAIT");

  conductor.onClock(3001); // 1201ms since last audio -> turn over! Advances to GAP
  const cmdGap = conductor.step();
  assert.equal(cmdGap.type, "WAIT"); // Waiting in GAP(500)

  conductor.onClock(3501); // 500ms elapsed in GAP -> ready for next turn
  const cmdNext = conductor.step();
  assert.equal(cmdNext.type, "START_UTTERANCE");
  assert.equal(cmdNext.index, 3);
});

test("barge-in score: BARGE_IN emitted only while audio flows, interrupted transitions to GAP", () => {
  const conductor = createConductor(SCORES.bargein, { quiescenceMs: 1200 });
  conductor.onClock(1000);

  // Turn 0: say
  assert.equal(conductor.step().type, "START_UTTERANCE");

  // Model starts speaking audio
  conductor.onClock(1100);
  conductor.onFrame({ type: "audio" });

  // Audio is flowing (100ms ago < 1200ms) -> BARGE_IN emitted
  const cmdBarge = conductor.step();
  assert.equal(cmdBarge.type, "BARGE_IN");

  // Server acknowledges barge-in
  conductor.onFrame({ type: "interrupted" });

  const outBefore = conductor.outcome();
  assert.equal(outBefore.interrupted, true);
  assert.equal(outBefore.interruptedCount, 1);

  // Advance clock beyond quiescence to finish final awaitTurnDone
  conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Stopped." });
  conductor.onClock(2500);

  assert.equal(conductor.step().type, "SCENARIO_DONE");
  assert.equal(conductor.outcome().status, "DONE");
});

test("approval score: emits say('approve') only after approval_pending, requires approval_resolved", () => {
  const conductor = createConductor(SCORES.approval, { quiescenceMs: 1200, maxTurnMs: 3000 });
  conductor.onClock(1000);

  // Turn 0: proposing say
  assert.equal(conductor.step().type, "START_UTTERANCE");

  // AWAIT_MODEL: model text arrives
  conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Proposing command delete production DB" });
  conductor.onFrame({ type: "audio" });

  // Without approval_pending frame, step returns WAIT for approve turn
  conductor.onClock(2300);
  assert.equal(conductor.step().type, "WAIT");

  // Now approval_pending frame arrives
  conductor.onFrame({ type: "approval_pending", command: "delete DB" });

  // Now step emits START_UTTERANCE for say("approve")
  const cmdApprove = conductor.step();
  assert.equal(cmdApprove.type, "START_UTTERANCE");
  assert.equal(cmdApprove.text, "approve");

  // Next: awaiting approval_resolved
  conductor.onClock(2400);
  conductor.onFrame({ type: "approval_resolved", outcome: "approved" });
  conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Command executed successfully" });

  conductor.onClock(3700); // 1300ms since audio/transcript
  assert.equal(conductor.step().type, "SCENARIO_DONE");

  const out = conductor.outcome();
  assert.equal(out.status, "DONE");
  assert.equal(out.approvalResolved, true);
  assert.equal(out.approvalResolvedCount, 1);
});

test("approval score: withheld approval_resolved eventually yields SCENARIO_FAILED via maxTurnMs", () => {
  const conductor = createConductor(SCORES.approval, { quiescenceMs: 1200, maxTurnMs: 2000 });
  conductor.onClock(1000);

  conductor.step(); // START_UTTERANCE
  conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Proposing..." });
  conductor.onFrame({ type: "approval_pending" });
  conductor.step(); // START_UTTERANCE approve

  // Withhold approval_resolved and advance clock beyond maxTurnMs (1000 + 2000 + 1 = 3001)
  conductor.onClock(3501);

  const cmdFail = conductor.step();
  assert.equal(cmdFail.type, "SCENARIO_FAILED");
  assert.equal(conductor.outcome().status, "FAILED");
});

// ── Review-fix regression pins (Fable adversarial pass, 2026-07-22) ──────────

test("cross-turn staleness: turn N's Janus transcript does NOT satisfy turn N+1's quiescence", () => {
  const conductor = createConductor(SCORES.dictation, { quiescenceMs: 1200 });
  conductor.onClock(1000);

  // Turn 0 completes normally: say -> respond -> quiesce -> gap.
  assert.equal(conductor.step().type, "START_UTTERANCE");
  conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Turn 1 response" });
  conductor.onFrame({ type: "audio" });
  conductor.onClock(2300); // quiescent
  assert.equal(conductor.step().type, "WAIT"); // enters GAP
  conductor.onClock(2900); // gap(500) elapsed

  // Turn 2's say fires...
  const cmd = conductor.step();
  assert.equal(cmd.type, "START_UTTERANCE");

  // ...and WITHOUT any new model frames, no amount of clock advance may complete the turn:
  // the stale turn-1 transcript/audio timestamps were reset at START_UTTERANCE.
  conductor.onClock(60_000);
  assert.equal(conductor.step().type, "WAIT", "turn must not complete on stale turn-1 signals");

  // A fresh Janus transcript + quiescence completes it properly.
  conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Turn 2 response" });
  conductor.onClock(61_300);
  assert.notEqual(conductor.step().type, "SCENARIO_FAILED");
  assert.equal(conductor.outcome().modelBubbles, 2);
});

test("BARGE_IN is emitted exactly once while audio keeps flowing", () => {
  const conductor = createConductor(SCORES.bargein, { quiescenceMs: 1200 });
  conductor.onClock(1000);
  assert.equal(conductor.step().type, "START_UTTERANCE");

  conductor.onClock(1100);
  conductor.onFrame({ type: "audio" });
  assert.equal(conductor.step().type, "BARGE_IN");

  // Audio still flowing, no `interrupted` yet: subsequent steps must NOT re-emit BARGE_IN.
  conductor.onClock(1200);
  conductor.onFrame({ type: "audio" });
  assert.equal(conductor.step().type, "WAIT");
  conductor.onClock(1300);
  assert.equal(conductor.step().type, "WAIT");

  conductor.onFrame({ type: "interrupted" });
  assert.equal(conductor.outcome().interruptedCount, 1);
});

test("wire fidelity: unknown/lowercase senders are ignored, never counted as Janus", () => {
  const conductor = createConductor(SCORES.spike, { quiescenceMs: 1200 });
  conductor.onClock(1000);
  assert.equal(conductor.step().type, "START_UTTERANCE");

  // The operator's own ASR echo (sender "User") and malformed senders must not
  // set the Janus-transcript timestamp — else turn-over fires off the echo.
  conductor.onFrame({ type: "transcript_text", sender: "User", text: "echo of my own words" });
  conductor.onFrame({ type: "transcript_text", sender: "user", text: "malformed" });
  conductor.onClock(60_000);
  assert.equal(conductor.step().type, "WAIT", "no Janus transcript yet => no turn-over");
  const out = conductor.outcome();
  assert.equal(out.userTranscripts, 1);
  assert.equal(out.janusTranscripts, 0);
});

test("epoch clock basis: Date.now()-scale clocks with maxTurnMs must not insta-fail the first turn", () => {
  // Keyed-run incident 2026-07-22: turnStartClockMs initialized to 0 while the runner feeds
  // epoch milliseconds — first checkTimeout saw elapsed ~= 1.78e12 and SCENARIO_FAILED before
  // a single frame. The basis must be the FIRST OBSERVED clock, whatever its scale.
  const conductor = createConductor(SCORES.spike, { quiescenceMs: 1200, maxTurnMs: 45_000 });
  const epoch = 1_784_703_153_127;
  conductor.onClock(epoch);
  const cmd = conductor.step();
  assert.equal(cmd.type, "START_UTTERANCE", `first step must start the utterance, got ${cmd.type}: ${cmd.reason ?? ""}`);
  // And the timeout still works, measured from the first observed clock:
  conductor.onClock(epoch + 46_000);
  assert.equal(conductor.step().type, "SCENARIO_FAILED");
});

test("pure-tool turn completes: action_activity + quiescence advances even with NO Janus transcript", () => {
  // Keyed-run incident 2026-07-22 (run 5): the model answered a dictation utterance by ACTING
  // (list_panes/switch_context/propose_command) — a real voice turn with tool activity but zero
  // spoken transcript. Turn-over must key off any model signal, not a Janus bubble, or it hangs.
  const conductor = createConductor(SCORES.dictation, { quiescenceMs: 1200, maxTurnMs: 45_000 });
  conductor.onClock(1000);
  assert.equal(conductor.step().type, "START_UTTERANCE"); // turn 0 say
  conductor.onFrame({ type: "transcript_text", sender: "User", text: "good morning" }); // operator ASR
  conductor.onFrame({ type: "action_activity" }); // model does tool work — NO Janus transcript
  conductor.onClock(1400);
  assert.equal(conductor.step().type, "WAIT", "still within quiescence of the tool activity");
  conductor.onClock(2700); // 1300ms since the last tool signal -> turn is over
  const cmd = conductor.step();
  assert.notEqual(cmd.type, "SCENARIO_FAILED", `pure-tool turn must not time out, got ${cmd.reason ?? cmd.type}`);
  assert.equal(conductor.outcome().janusTranscripts, 0, "no spoken bubble was produced");
});

test("incidental approval_pending does NOT block a score with no 'approve' ahead", () => {
  // Same incident: the stray propose->pending emitted approval_pending to the voice client. A
  // non-approval score must ignore it and complete on quiescence, not wait forever for an approve.
  const conductor = createConductor(SCORES.dictation, { quiescenceMs: 1200, maxTurnMs: 45_000 });
  conductor.onClock(1000);
  assert.equal(conductor.step().type, "START_UTTERANCE");
  conductor.onFrame({ type: "transcript_text", sender: "User", text: "good morning" });
  conductor.onFrame({ type: "action_activity" });
  conductor.onFrame({ type: "approval_pending" }); // incidental — this score never says "approve"
  conductor.onClock(2700);
  assert.equal(conductor.step().type, "WAIT", "advances into GAP, not blocked on the stray pending");
  conductor.onClock(3300); // gap(500) elapsed
  const cmd = conductor.step();
  assert.notEqual(cmd.type, "SCENARIO_FAILED", `stray pending must not hang the turn, got ${cmd.reason ?? cmd.type}`);
});

test("all four scores reduce to SCENARIO_DONE under well-formed frame sequences", () => {
  const names = Object.keys(SCORES) as Array<keyof typeof SCORES>;
  for (const name of names) {
    const score = SCORES[name];
    const conductor = createConductor(score, { quiescenceMs: 500, maxTurnMs: 10000 });
    let t = 1000;
    conductor.onClock(t);

    let maxSteps = 50;
    let done = false;

    while (maxSteps-- > 0 && !done) {
      const cmd = conductor.step();
      if (cmd.type === "SCENARIO_DONE") {
        done = true;
        break;
      }
      if (cmd.type === "START_UTTERANCE") {
        conductor.onFrame({ type: "transcript_text", sender: "User", text: cmd.text || "user msg" });
        t += 100;
        conductor.onClock(t);
        conductor.onFrame({ type: "audio" });
        conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "reply" });
        if (name === "approval" && cmd.text !== "approve") {
          conductor.onFrame({ type: "approval_pending" });
        }
        if (name === "approval" && cmd.text === "approve") {
          conductor.onFrame({ type: "approval_resolved", outcome: "approved" });
        }
      } else if (cmd.type === "BARGE_IN") {
        conductor.onFrame({ type: "interrupted" });
        t += 100;
        conductor.onClock(t);
      } else if (cmd.type === "WAIT") {
        t += 600; // pass quiescence / gap
        conductor.onClock(t);
      } else if (cmd.type === "SCENARIO_FAILED") {
        assert.fail(`Score ${name} unexpectedly failed: ${cmd.reason}`);
      }
    }

    assert.equal(done, true, `Score ${name} should reduce to SCENARIO_DONE`);
    assert.equal(conductor.outcome().status, "DONE");
  }
});
