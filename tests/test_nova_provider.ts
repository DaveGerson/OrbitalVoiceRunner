// Nova Sonic 2 provider — pure-logic coverage (no AWS, no socket). Pins the two seams that make the
// integration "like-for-like": (1) the Nova OUTPUT-event → Gemini LiveServerMessage translation the
// voice loop's onmessage handler consumes, and (2) the registry-derived Gemini declaration → Nova
// toolSpec conversion. Plus the voice-id mapping and the input-event builders.
//
// Runner: npx tsx --test --test-force-exit tests/test_nova_provider.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  translateNovaEvent,
  voiceNameToNovaVoiceId,
  buildPromptStartEvent,
  buildAudioInput,
  buildToolResult,
  buildToolContentStart,
} from "../src/voice/novaSonic";
import { toNovaToolSpecs, geminiSchemaToJsonSchema } from "../src/actions/nova";
import { extractTranscripts } from "../src/liveTranscripts";
import { Type } from "@google/genai";

// ── translateNovaEvent ────────────────────────────────────────────────────────────────────────

test("translateNovaEvent: malformed / empty input never throws and yields nothing", () => {
  assert.deepStrictEqual(translateNovaEvent(null), []);
  assert.deepStrictEqual(translateNovaEvent(undefined), []);
  assert.deepStrictEqual(translateNovaEvent({}), []);
  assert.deepStrictEqual(translateNovaEvent({ event: {} }), []);
});

test("translateNovaEvent: audioOutput maps to the Gemini modelTurn inlineData audio path", () => {
  const [msg] = translateNovaEvent({ event: { audioOutput: { content: "BASE64AUDIO" } } });
  assert.strictEqual(msg.serverContent.modelTurn.parts[0].inlineData.data, "BASE64AUDIO");
});

test("translateNovaEvent: operator ASR (textOutput role USER) lands on inputTranscription so extractTranscripts reads it", () => {
  const [msg] = translateNovaEvent({ event: { textOutput: { content: "open pane two", role: "USER" } } });
  assert.strictEqual(msg.serverContent.inputTranscription.text, "open pane two");
  // The existing extractTranscripts must pull it as the operator utterance (the approval/dictation source).
  assert.strictEqual(extractTranscripts(msg).operator, "open pane two");
});

test("translateNovaEvent: assistant text (textOutput role ASSISTANT) lands on modelTurn parts (shown as Janus)", () => {
  const [msg] = translateNovaEvent({ event: { textOutput: { content: "Relayed to pane 2.", role: "ASSISTANT" } } });
  assert.strictEqual(extractTranscripts(msg).model, "Relayed to pane 2.");
});

test("translateNovaEvent: SPECULATIVE partial text is dropped (only FINAL surfaces)", () => {
  const spec = translateNovaEvent({
    event: { textOutput: { content: "partial…", role: "ASSISTANT", additionalModelFields: JSON.stringify({ generationStage: "SPECULATIVE" }) } },
  });
  assert.deepStrictEqual(spec, []);
  const fin = translateNovaEvent({
    event: { textOutput: { content: "final.", role: "ASSISTANT", additionalModelFields: JSON.stringify({ generationStage: "FINAL" }) } },
  });
  assert.strictEqual(fin[0].serverContent.modelTurn.parts[0].text, "final.");
});

test("translateNovaEvent: barge-in sentinel maps to serverContent.interrupted (and is NOT shown as text)", () => {
  const [msg] = translateNovaEvent({ event: { textOutput: { content: '{ "interrupted" : true }', role: "ASSISTANT" } } });
  assert.strictEqual(msg.serverContent.interrupted, true);
  assert.strictEqual(msg.serverContent.modelTurn, undefined);
});

test("translateNovaEvent: toolUse maps to a Gemini functionCall with parsed args", () => {
  const [msg] = translateNovaEvent({
    event: { toolUse: { toolName: "propose_command", toolUseId: "tu-1", content: JSON.stringify({ pane_id: "2", kind: "agent_instruction" }) } },
  });
  assert.deepStrictEqual(msg.toolCall.functionCalls[0], {
    name: "propose_command",
    id: "tu-1",
    args: { pane_id: "2", kind: "agent_instruction" },
  });
});

test("translateNovaEvent: toolUse with non-JSON content degrades to empty args (never throws)", () => {
  const [msg] = translateNovaEvent({ event: { toolUse: { toolName: "list_panes", toolUseId: "tu-2", content: "not json" } } });
  assert.deepStrictEqual(msg.toolCall.functionCalls[0].args, {});
});

test("translateNovaEvent: contentEnd stopReason maps END_TURN→turnComplete, INTERRUPTED→interrupted", () => {
  assert.strictEqual(translateNovaEvent({ event: { contentEnd: { stopReason: "END_TURN" } } })[0].serverContent.turnComplete, true);
  assert.strictEqual(translateNovaEvent({ event: { contentEnd: { stopReason: "INTERRUPTED" } } })[0].serverContent.interrupted, true);
  assert.deepStrictEqual(translateNovaEvent({ event: { contentEnd: { stopReason: "PARTIAL_TURN" } } }), []);
});

// ── voice-id mapping ──────────────────────────────────────────────────────────────────────────

test("voiceNameToNovaVoiceId: passes a real Nova voice through, maps a Gemini name, defaults otherwise", () => {
  assert.strictEqual(voiceNameToNovaVoiceId("tiffany"), "tiffany");      // already Nova
  assert.strictEqual(voiceNameToNovaVoiceId("Zephyr"), "matthew");       // Gemini default → Nova alias
  assert.strictEqual(voiceNameToNovaVoiceId(""), "matthew");             // blank → fallback
  assert.strictEqual(voiceNameToNovaVoiceId("Unknownish"), "matthew");   // unknown → fallback
});

// ── tool conversion (registry-derived parity) ───────────────────────────────────────────────────

test("geminiSchemaToJsonSchema: lowercases the Type enum and stringify-ready nests properties/required", () => {
  const js = geminiSchemaToJsonSchema({
    type: Type.OBJECT,
    properties: {
      pane_id: { type: Type.STRING },
      count: { type: Type.NUMBER },
      mode: { type: Type.STRING, enum: ["a", "b"] },
      tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: ["pane_id"],
  });
  assert.strictEqual(js.type, "object");
  assert.strictEqual(js.properties!.pane_id.type, "string");
  assert.strictEqual(js.properties!.count.type, "number");
  assert.deepStrictEqual(js.properties!.mode.enum, ["a", "b"]);
  assert.strictEqual(js.properties!.tags.type, "array");
  assert.strictEqual(js.properties!.tags.items!.type, "string");
  assert.deepStrictEqual(js.required, ["pane_id"]);
});

test("toNovaToolSpecs: wraps each declaration in a toolSpec with a STRING inputSchema.json", () => {
  const specs = toNovaToolSpecs([
    { name: "list_panes", description: "list", parameters: { type: Type.OBJECT, properties: {} } },
  ]);
  assert.strictEqual(specs.length, 1);
  assert.strictEqual(specs[0].toolSpec.name, "list_panes");
  assert.strictEqual(specs[0].toolSpec.description, "list");
  // inputSchema.json must be a STRING (Bedrock requirement), parseable back to a JSON-Schema object.
  assert.strictEqual(typeof specs[0].toolSpec.inputSchema.json, "string");
  const parsed = JSON.parse(specs[0].toolSpec.inputSchema.json);
  assert.strictEqual(parsed.type, "object");
});

// ── input-event builders ────────────────────────────────────────────────────────────────────────

test("buildPromptStartEvent: attaches tool config only when there are tools; always sets the 24kHz audio out + voiceId", () => {
  const withTools = buildPromptStartEvent("p1", "matthew", [
    { toolSpec: { name: "x", description: "d", inputSchema: { json: "{}" } } },
  ]);
  assert.strictEqual(withTools.event.promptStart.audioOutputConfiguration.sampleRateHertz, 24000);
  assert.strictEqual(withTools.event.promptStart.audioOutputConfiguration.voiceId, "matthew");
  assert.ok(withTools.event.promptStart.toolConfiguration);
  assert.strictEqual(withTools.event.promptStart.toolConfiguration.tools.length, 1);

  const noTools = buildPromptStartEvent("p1", "matthew", []);
  assert.strictEqual(noTools.event.promptStart.toolConfiguration, undefined);
});

test("buildAudioInput / buildToolResult / buildToolContentStart carry the promptName + content through", () => {
  assert.deepStrictEqual(buildAudioInput("p1", "c1", "AUDIO"), { event: { audioInput: { promptName: "p1", contentName: "c1", content: "AUDIO" } } });
  assert.strictEqual(buildToolContentStart("p1", "c2", "tu-9").event.contentStart.toolResultInputConfiguration.toolUseId, "tu-9");
  assert.deepStrictEqual(buildToolResult("p1", "c2", '{"output":"ok"}'), { event: { toolResult: { promptName: "p1", contentName: "c2", content: '{"output":"ok"}' } } });
});
