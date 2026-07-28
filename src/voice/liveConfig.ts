/**
 * src/voice/liveConfig.ts — BEAD aqx: the pure Gemini Live `config.tools` builder.
 *
 * WHY a separate module: the live `config.tools` array was an inline object literal buried inside
 * the `boundLiveConnector(sessionAi, {...})` connect call (src/voice/index.ts). That made the tools
 * shape untestable without a live connect. Carving it into a pure, total function lets us pin — as a
 * unit, no API key, no socket — the bead's load-bearing invariant: the existing full registry-derived
 * functionDeclarations path is BYTE-IDENTICAL when grounding is off, and gains a sibling googleSearch
 * Tool entry (never replacing functionDeclarations) when grounding is on.
 *
 * GROUNDING = the Gemini Live BUILT-IN googleSearch tool. Unlike a Janus ActionDef, googleSearch has
 * NO per-call functionCall delivered to us — the model invokes it server-side mid-turn. So it cannot
 * route through the capability-gate matrix (no hook to interpose an "Ask"): only Off (omit at connect)
 * and Auto (include at connect) are achievable. It is therefore surfaced as a connect-time boolean
 * (voiceAi.groundingEnabled), DEFAULT FALSE — mirroring voiceAi.systemPrompt's connect-time read, not
 * a capability-gate row. See the bead aqx decisionsMade for the flag-vs-row rationale.
 *
 * SDK shape (CONFIRMED, @google/genai v2.6.0): `Tool` (node.d.ts:11016) carries BOTH
 * `functionDeclarations?` (11035) and `googleSearch?: GoogleSearch` (11026) as sibling optional fields,
 * and `LiveConnectConfig.tools` is `ToolListUnion` (an array of Tool). So `[{ functionDeclarations },
 * { googleSearch: {} }]` is type-valid. `googleSearch: {}` (empty GoogleSearch, node.d.ts:5750) enables
 * default web search.
 *
 * MODEL-LEVEL caveat (NOT enforced here): whether gemini-3.1-flash-live-preview ACCEPTS googleSearch
 * alongside a full registry-derived functionDeclarations set in one Live session is a server-side rule the SDK types
 * do not encode (historically the Live API rejected this combo for 2.0/2.5-era models; relaxed
 * unevenly in later previews). The off-by-default + gated design makes this safe regardless: the
 * off-path is untouched until an explicit enable, at which point model acceptance is observable before
 * any default flips.
 *
 * VERIFIED LIVE 2026-07-28 (bead qkyr, `npm run verify:grounding` via the Credential Manager key
 * loader): gemini-3.1-flash-live-preview ACCEPTED the combo — full 73-declaration registry set +
 * googleSearch — at connect AND across a mid-turn search-inviting exchange (session stayed open,
 * topical current-events answer returned). No `groundingMetadata` was observed on the response
 * frames, so citation surfacing cannot be assumed; re-verify with the same script on any model
 * bump before relying on this.
 */

import type { GeminiFunctionDeclaration } from "../actions/gemini";

/**
 * Structural type for a Gemini Live `Tool` entry as we construct it. Deliberately a local shape (not
 * the SDK's `Tool`) so this module stays dependency-light and the unit test can assert exact contents;
 * it is a strict subset of `@google/genai`'s `Tool` (functionDeclarations + googleSearch are sibling
 * optional fields there), so the produced array is assignable to `ToolListUnion` at the connect site.
 */
export interface VoiceTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  googleSearch?: Record<string, never>;
}

export interface BuildVoiceToolsOpts {
  /** voiceAi.groundingEnabled — when true, append the built-in googleSearch Tool entry. */
  groundingEnabled: boolean;
  /** The Janus function-calling surface (toGeminiDeclarations(REGISTRY)). */
  declarations: GeminiFunctionDeclaration[];
}

/**
 * Build the Gemini Live `config.tools` array.
 *
 * OFF (default): `[{ functionDeclarations }]` — identical to the former inline literal, so the
 * function-calling path is untouched.
 *
 * ON: `[{ functionDeclarations }, { googleSearch: {} }]` — the SAME functionDeclarations entry stays
 * FIRST (so any consumer keying off tools[0] is unaffected), with the grounding built-in appended.
 */
export function buildVoiceTools(opts: BuildVoiceToolsOpts): VoiceTool[] {
  const fnEntry: VoiceTool = { functionDeclarations: opts.declarations };
  if (!opts.groundingEnabled) return [fnEntry];
  // `{}` = default GoogleSearch (web search enabled). Appended as a sibling Tool; never merged into the
  // functionDeclarations entry, so the off-path golden (tools[0].functionDeclarations) is preserved.
  return [fnEntry, { googleSearch: {} }];
}
