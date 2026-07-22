import test from "node:test";
import assert from "node:assert/strict";

// We import from the module we are about to test (TDD RED step)
import {
  SCORES,
  say,
  awaitTurnDone,
  gap,
  bargeIn,
  validateScore,
  ScoreName,
  Score,
  Turn,
} from "../src/voice/synthLane/scores";

test("SCORES exports exactly four named scores", () => {
  const keys = Object.keys(SCORES).sort();
  assert.deepEqual(keys, ["approval", "bargein", "dictation", "spike"]);
});

test("each score in SCORES is a valid ordered Turn[]", () => {
  const scoreNames: ScoreName[] = ["spike", "dictation", "approval", "bargein"];
  for (const name of scoreNames) {
    const score = SCORES[name];
    assert.ok(Array.isArray(score), `${name} must be an array`);
    assert.ok(score.length > 0, `${name} must not be empty`);
    const validation = validateScore(score);
    assert.equal(validation.valid, true, `Score ${name} failed validation: ${validation.error}`);
  }
});

test("validateScore rejects say with empty/whitespace text", () => {
  const badSayEmpty: Score = [say(""), awaitTurnDone()];
  assert.equal(validateScore(badSayEmpty).valid, false);

  const badSayWhitespace: Score = [say("   \t\n "), awaitTurnDone()];
  assert.equal(validateScore(badSayWhitespace).valid, false);
});

test("validateScore rejects bargeIn with empty/whitespace text", () => {
  const badBargeEmpty: Score = [say("hello"), awaitTurnDone(), bargeIn("")];
  assert.equal(validateScore(badBargeEmpty).valid, false);

  const badBargeWhitespace: Score = [say("hello"), awaitTurnDone(), bargeIn("  ")];
  assert.equal(validateScore(badBargeWhitespace).valid, false);
});

test("validateScore rejects bargeIn with no preceding model-turn wait", () => {
  const noWait: Score = [bargeIn("stop")];
  assert.equal(validateScore(noWait).valid, false);

  const sayThenBargeWithoutWait: Score = [say("hello"), bargeIn("stop")];
  assert.equal(validateScore(sayThenBargeWithoutWait).valid, false);
});

test("approval score contains say('approve') occurring after proposing say", () => {
  const approvalScore = SCORES.approval;
  const sayIndices = approvalScore
    .map((turn, i) => (turn.type === "say" ? { text: turn.text, index: i } : null))
    .filter((x): x is { text: string; index: number } => x !== null);

  assert.ok(sayIndices.length >= 2, "approval score must have at least proposing say and approve say");
  const proposeIdx = sayIndices[0].index;
  const approveObj = sayIndices.find((s) => s.text === "approve");
  assert.ok(approveObj, "approval score must contain say('approve')");
  assert.ok(approveObj.index > proposeIdx, "say('approve') must occur after proposing say");
});

test("dictation score contains 2-3 dictation turns with awaitTurnDone + gap", () => {
  const dictationScore = SCORES.dictation;
  const sayTurns = dictationScore.filter((t) => t.type === "say");
  assert.ok(sayTurns.length >= 2 && sayTurns.length <= 3, "dictation score must have 2-3 dictation turns");
  const gapTurns = dictationScore.filter((t) => t.type === "gap");
  assert.ok(gapTurns.length >= 1, "dictation score must contain gap turns");
});

test("bargein score contains say, awaitTurnDone, and bargeIn", () => {
  const bargeinScore = SCORES.bargein;
  const hasSay = bargeinScore.some((t) => t.type === "say");
  const hasAwait = bargeinScore.some((t) => t.type === "awaitTurnDone");
  const hasBarge = bargeinScore.some((t) => t.type === "bargeIn");
  assert.ok(hasSay && hasAwait && hasBarge, "bargein score must contain say, awaitTurnDone, and bargeIn");
});
