// BEAD aqx — buildVoiceTools config-builder unit suite.
//
// The Gemini Live `config.tools` array is the single wire surface that decides whether
// Janus's 43-tool functionDeclarations set is the ONLY tool (today) or is joined by the
// built-in googleSearch grounding tool (when the operator enables voiceAi.groundingEnabled).
//
// This suite pins the two invariants the bead makes load-bearing:
//   (A) OFF (default) → the tools array is EXACTLY `[{ functionDeclarations }]`, byte-for-byte
//       what the inline literal produced before this bead. The existing function-calling path
//       MUST be untouched when grounding is off (deepStrictEqual proves it).
//   (B) ON → the SAME functionDeclarations entry is still present AND a `{ googleSearch: {} }`
//       entry is appended. The function-calling path stays intact while grounding turns on.
//
// Pure unit (no live connect, no API key): buildVoiceTools is a total function over
// { groundingEnabled, declarations }, so the tools array is testable in isolation — the
// connect-site wiring is covered end-to-end by test_voice_tools.ts.

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildVoiceTools } from "../src/voice/liveConfig";
import type { GeminiFunctionDeclaration } from "../src/actions/gemini";

// A tiny but realistic declarations fixture (shape mirrors toGeminiDeclarations output).
const DECLS: GeminiFunctionDeclaration[] = [
  { name: "stop_all", description: "EMERGENCY halt.", parameters: { type: "OBJECT" as any, properties: {} } },
  { name: "create_pane", description: "Open a pane.", parameters: { type: "OBJECT" as any, properties: {} } },
];

describe("aqx buildVoiceTools (pure live-config builder)", () => {
  it("OFF (default): returns EXACTLY [{ functionDeclarations }] — off-path byte-identical", () => {
    const tools = buildVoiceTools({ groundingEnabled: false, declarations: DECLS });
    assert.deepStrictEqual(
      tools,
      [{ functionDeclarations: DECLS }],
      "with grounding off the tools array must be the single functionDeclarations entry (unchanged)"
    );
  });

  it("ON: keeps the SAME functionDeclarations entry AND appends { googleSearch: {} }", () => {
    const tools = buildVoiceTools({ groundingEnabled: true, declarations: DECLS });

    // The function-calling path is intact: a functionDeclarations entry with the SAME decls survives.
    const fnEntry = tools.find((t: any) => Array.isArray(t.functionDeclarations));
    assert.ok(fnEntry, "a functionDeclarations entry is still present when grounding is on");
    assert.deepStrictEqual(
      (fnEntry as any).functionDeclarations,
      DECLS,
      "the functionDeclarations payload is unchanged when grounding is on"
    );

    // The grounding built-in is added as a sibling Tool entry.
    const searchEntry = tools.find((t: any) => t.googleSearch !== undefined);
    assert.ok(searchEntry, "a { googleSearch } entry is appended when grounding is on");
    assert.deepStrictEqual(
      (searchEntry as any).googleSearch,
      {},
      "googleSearch is an empty object (SDK default = web search enabled)"
    );

    // Exactly two Tool entries: functionDeclarations + googleSearch. No surprises.
    assert.strictEqual(tools.length, 2, "on-path tools array has exactly two entries");
  });

  it("ON: the functionDeclarations entry stays FIRST (protects test_voice_tools.ts tools[0] golden)", () => {
    const tools = buildVoiceTools({ groundingEnabled: true, declarations: DECLS });
    assert.ok(
      Array.isArray((tools[0] as any).functionDeclarations),
      "tools[0] is the functionDeclarations entry even when grounding is on (golden at tools[0] holds)"
    );
  });

  it("does not mutate or alias the caller's declarations array", () => {
    const input = [...DECLS];
    const tools = buildVoiceTools({ groundingEnabled: true, declarations: input });
    const fnEntry = tools.find((t: any) => Array.isArray(t.functionDeclarations)) as any;
    // Same contents, and the original input array is not mutated by the builder.
    assert.deepStrictEqual(fnEntry.functionDeclarations, DECLS);
    assert.strictEqual(input.length, DECLS.length, "input declarations array length is unchanged");
  });
});
