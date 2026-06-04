// tests/test_live_transcripts.ts — operator/model transcript extraction from a Gemini LiveServerMessage.
//
// ROOT CAUSE THIS LOCKS (proven by the 2026-06 live capture): the operator's spoken words arrive on
// `serverContent.inputTranscription.text` (the ASR channel, enabled via inputAudioTranscription), NOT
// on the speculative `serverContent.turn/userTurn.parts` casts the server used to read. With the parser
// fed an empty field, hands-free "approve"/"reject" + dictation never fired and the whole server-side
// voice path was dormant. extractTranscripts() reads inputTranscription as the operator source (legacy
// casts kept as a fallback) so the approval router + dictation + transcript frame see the real words.
//
// Runner: npx tsx --test --test-force-exit tests/test_live_transcripts.ts

import { test } from "node:test";
import assert from "node:assert";
import { extractTranscripts } from "../src/liveTranscripts";

test("operator transcript comes from serverContent.inputTranscription (the real ASR channel)", () => {
  const r = extractTranscripts({ serverContent: { inputTranscription: { text: "approve that" } } });
  assert.strictEqual(r.operator, "approve that");
});

test("model spoken text from modelTurn.parts; thinking/narration from outputTranscription", () => {
  const r = extractTranscripts({
    serverContent: {
      modelTurn: { parts: [{ text: "Sure" }, { text: ", done." }] },
      outputTranscription: { text: "I should list panes first" },
    },
  });
  assert.strictEqual(r.model, "Sure, done.");
  assert.strictEqual(r.modelThinking, "I should list panes first");
});

test("legacy turn / userTurn casts still feed operator (fallback for models that populate them)", () => {
  assert.strictEqual(extractTranscripts({ serverContent: { turn: { parts: [{ text: "no" }] } } }).operator, "no");
  assert.strictEqual(extractTranscripts({ serverContent: { userTurn: { parts: [{ text: "yes" }] } } }).operator, "yes");
});

test("a bare short vote on inputTranscription is preserved (composes with A4's shouldRouteUtterance)", () => {
  assert.strictEqual(extractTranscripts({ serverContent: { inputTranscription: { text: "no" } } }).operator, "no");
});

test("inputTranscription WINS over legacy turn/userTurn when both are present (fallback, not accumulate)", () => {
  // Gemini Live populates one channel per message today, but the contract is fallback: inputTranscription
  // is authoritative; the legacy casts must NOT be concatenated onto it (that would yield "approve extra").
  const r = extractTranscripts({
    serverContent: {
      inputTranscription: { text: "approve" },
      turn: { parts: [{ text: " extra" }] },
      userTurn: { parts: [{ text: " more" }] },
    },
  });
  assert.strictEqual(r.operator, "approve");
});

test("empty / malformed messages yield empty strings without throwing", () => {
  assert.deepStrictEqual(extractTranscripts({}), { operator: "", model: "", modelThinking: "" });
  assert.deepStrictEqual(extractTranscripts({ serverContent: {} }), { operator: "", model: "", modelThinking: "" });
  assert.deepStrictEqual(extractTranscripts(null), { operator: "", model: "", modelThinking: "" });
  assert.deepStrictEqual(extractTranscripts(undefined), { operator: "", model: "", modelThinking: "" });
});
