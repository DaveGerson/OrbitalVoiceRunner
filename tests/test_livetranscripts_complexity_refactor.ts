// tests/test_livetranscripts_complexity_refactor.ts
//
// Pins the CURRENT observable behavior of extractTranscripts() before/after the CC<=10
// extraction refactor. Exhaustively covers every branch: inputTranscription present/absent/
// empty/non-string, legacy turn/userTurn accumulation + fallback precedence, modelTurn parts,
// outputTranscription string/non-string, and malformed/null/undefined inputs. Behavior must be
// byte-identical across the refactor.
//
// Runner: npx tsx --test --test-force-exit tests/test_livetranscripts_complexity_refactor.ts

import { test } from "node:test";
import assert from "node:assert";
import { extractTranscripts } from "../src/liveTranscripts";

// ---- operator: inputTranscription is the primary channel ----

test("operator: inputTranscription.text used when non-empty string", () => {
  assert.strictEqual(extractTranscripts({ serverContent: { inputTranscription: { text: "hello there" } } }).operator, "hello there");
});

test("operator: empty-string inputTranscription falls back to legacy casts", () => {
  const r = extractTranscripts({
    serverContent: { inputTranscription: { text: "" }, turn: { parts: [{ text: "fb" }] } },
  });
  assert.strictEqual(r.operator, "fb");
});

test("operator: non-string inputTranscription (number) falls back to legacy casts", () => {
  const r = extractTranscripts({
    serverContent: { inputTranscription: { text: 123 as any }, userTurn: { parts: [{ text: "num-fb" }] } },
  });
  assert.strictEqual(r.operator, "num-fb");
});

test("operator: missing inputTranscription object falls back to legacy casts", () => {
  assert.strictEqual(extractTranscripts({ serverContent: { turn: { parts: [{ text: "x" }] } } }).operator, "x");
});

// ---- operator: legacy fallback accumulation ----

test("operator fallback: turn.parts concatenated in order, text-less parts skipped", () => {
  const r = extractTranscripts({
    serverContent: { turn: { parts: [{ text: "a" }, { foo: 1 }, { text: "b" }, { text: "" }, { text: "c" }] } },
  });
  assert.strictEqual(r.operator, "abc");
});

test("operator fallback: turn.parts THEN userTurn.parts concatenated together", () => {
  const r = extractTranscripts({
    serverContent: { turn: { parts: [{ text: "T1" }, { text: "T2" }] }, userTurn: { parts: [{ text: "U1" }] } },
  });
  assert.strictEqual(r.operator, "T1T2U1");
});

test("operator fallback: only userTurn present", () => {
  assert.strictEqual(extractTranscripts({ serverContent: { userTurn: { parts: [{ text: "only-u" }] } } }).operator, "only-u");
});

test("operator: inputTranscription WINS, legacy casts NOT appended", () => {
  const r = extractTranscripts({
    serverContent: {
      inputTranscription: { text: "WIN" },
      turn: { parts: [{ text: "nope" }] },
      userTurn: { parts: [{ text: "nope2" }] },
    },
  });
  assert.strictEqual(r.operator, "WIN");
});

// ---- model: modelTurn.parts ----

test("model: modelTurn.parts concatenated in order, text-less/empty skipped", () => {
  const r = extractTranscripts({
    serverContent: { modelTurn: { parts: [{ text: "He" }, { x: 0 }, { text: "llo" }, { text: "" }] } },
  });
  assert.strictEqual(r.model, "Hello");
});

test("model: missing modelTurn yields empty model string", () => {
  assert.strictEqual(extractTranscripts({ serverContent: {} }).model, "");
});

// ---- modelThinking: outputTranscription ----

test("modelThinking: outputTranscription.text used when string (incl. empty string)", () => {
  assert.strictEqual(extractTranscripts({ serverContent: { outputTranscription: { text: "thinking" } } }).modelThinking, "thinking");
  assert.strictEqual(extractTranscripts({ serverContent: { outputTranscription: { text: "" } } }).modelThinking, "");
});

test("modelThinking: non-string outputTranscription yields empty string", () => {
  assert.strictEqual(extractTranscripts({ serverContent: { outputTranscription: { text: 5 as any } } }).modelThinking, "");
  assert.strictEqual(extractTranscripts({ serverContent: { outputTranscription: {} } }).modelThinking, "");
});

// ---- malformed / nullish ----

test("malformed: empty object, empty serverContent, null, undefined => all empty", () => {
  const empty = { operator: "", model: "", modelThinking: "" };
  assert.deepStrictEqual(extractTranscripts({}), empty);
  assert.deepStrictEqual(extractTranscripts({ serverContent: {} }), empty);
  assert.deepStrictEqual(extractTranscripts(null), empty);
  assert.deepStrictEqual(extractTranscripts(undefined), empty);
});

test("malformed: parts arrays present but null/non-array-safe shapes do not throw", () => {
  assert.deepStrictEqual(extractTranscripts({ serverContent: { turn: {} } }), { operator: "", model: "", modelThinking: "" });
  assert.deepStrictEqual(extractTranscripts({ serverContent: { modelTurn: {} } }), { operator: "", model: "", modelThinking: "" });
});

// ---- combined realistic frame ----

test("combined: operator + model + thinking all populated independently", () => {
  const r = extractTranscripts({
    serverContent: {
      inputTranscription: { text: "approve that" },
      modelTurn: { parts: [{ text: "Sure" }, { text: ", done." }] },
      outputTranscription: { text: "I should list panes first" },
    },
  });
  assert.deepStrictEqual(r, { operator: "approve that", model: "Sure, done.", modelThinking: "I should list panes first" });
});
