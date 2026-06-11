/**
 * src/voice/novaSonic.ts — the Amazon Nova Sonic 2 connector + session ADAPTER.
 *
 * GOAL (the "like-for-like" mandate): make Nova Sonic 2 a drop-in alternative to Gemini Live behind
 * the EXISTING injectable connector seam (server.ts `LiveConnector` / `boundLiveConnector`), so that
 * NOTHING in the per-connection voice loop (src/voice/index.ts) has to change. The voice loop calls
 * `boundLiveConnector(ai, params, key)` and then drives whatever it gets back via four methods —
 * `sendRealtimeInput`, `sendToolResponse`, `sendClientContent`, `close` — and reacts to
 * `params.callbacks.onmessage(message)` where `message` is a Gemini `LiveServerMessage`.
 *
 * This module supplies BOTH halves of that contract for Nova Sonic:
 *
 *   1) A session object (`NovaLiveSession`) exposing the SAME four methods. Each maps to the Nova
 *      Sonic bidirectional-stream INPUT events (audioInput / toolResult / textInput / teardown).
 *
 *   2) A translator (`translateNovaEvent`) that turns each Nova Sonic OUTPUT event into the Gemini
 *      `LiveServerMessage` shape the loop already parses:
 *        - audioOutput            -> serverContent.modelTurn.parts[0].inlineData.data  (spoken audio)
 *        - textOutput role USER   -> serverContent.inputTranscription.text             (operator ASR)
 *        - textOutput role ASST.  -> serverContent.modelTurn.parts[0].text             (Janus text)
 *        - toolUse                -> toolCall.functionCalls[0] = { name, id, args }
 *        - barge-in sentinel      -> serverContent.interrupted = true
 *        - contentEnd END_TURN    -> serverContent.turnComplete = true
 *
 * Because the audio formats already match the app's pipeline (16 kHz PCM in, 24 kHz PCM out — see
 * App.tsx capture/playback AudioContexts) and the tool surface is derived from the SAME registry
 * (src/actions/nova.ts re-projects toGeminiDeclarations(REGISTRY)), the entire dispatch / approval /
 * transcript / draft machinery downstream is untouched.
 *
 * Event protocol confirmed against the AWS `amazon-nova-2-sonic` samples + bidirectional-streaming
 * docs. Model id: `amazon.nova-2-sonic-v1:0` (a.k.a. "Nova Sonic 2"). See docs/integration/NOVA_SONIC_INTEGRATION.md
 * for the tradeoffs (no cross-process session-resumption handle; in-session context is model-managed).
 */

import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "node:crypto";
import { toNovaToolSpecs, type NovaToolSpec } from "../actions/nova";
import type { GeminiFunctionDeclaration } from "../actions/gemini";

// ── Auth / connect inputs ──────────────────────────────────────────────────────────────────────

/** The AWS credentials + region needed to open a Nova Sonic bidirectional stream. */
export interface NovaAuth {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional STS session token (for temporary credentials). */
  sessionToken?: string;
}

/**
 * The subset of the Gemini-shaped `params` (the object the voice loop passes to boundLiveConnector)
 * that the Nova connector reads. We deliberately accept the SAME object so the call site in
 * src/voice/index.ts is unchanged; Gemini-only fields (sessionResumption, contextWindowCompression,
 * inputAudioTranscription, …) are simply ignored here.
 */
export interface NovaConnectParams {
  /** The Nova model id, e.g. "amazon.nova-2-sonic-v1:0". */
  model: string;
  callbacks: {
    onmessage: (message: any) => void | Promise<void>;
    onerror?: (err: any) => void;
    onclose?: (info: any) => void;
  };
  config: {
    /** The system instruction string (buildSystemInstruction output). */
    systemInstruction?: string;
    /** Gemini speechConfig — we read voiceConfig.prebuiltVoiceConfig.voiceName and map it to a Nova voiceId. */
    speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } } };
    /** The Gemini tools array (buildVoiceTools output). We pull tools[0].functionDeclarations. */
    tools?: Array<{ functionDeclarations?: GeminiFunctionDeclaration[] }>;
  };
}

// ── Voice mapping ──────────────────────────────────────────────────────────────────────────────

/**
 * Gemini prebuilt voice names (Zephyr, Puck, …) do not exist on Nova Sonic, which has its own voiceId
 * set (matthew, tiffany, amy, …). When the operator has selected a real Nova voiceId we pass it
 * through; otherwise we fall back to a sensible default. A small alias map gives the common Gemini
 * defaults a reasonable Nova equivalent so an un-migrated `voiceAi.voice` still yields a valid voice.
 */
export const NOVA_VOICE_IDS = new Set([
  "matthew", "tiffany", "amy", "lupe", "carlos", "ambre", "florian", "beatrice", "lorenzo", "greta", "lennart",
]);
const GEMINI_TO_NOVA_VOICE: Record<string, string> = {
  // Gemini defaults → nearest Nova timbre (best-effort; operators can pick an explicit Nova voice in Settings).
  zephyr: "matthew", puck: "matthew", charon: "lennart", kore: "tiffany",
  fenrir: "carlos", aoede: "amy", leda: "greta", orus: "lorenzo",
};
export function voiceNameToNovaVoiceId(voiceName: string | undefined, fallback = "matthew"): string {
  const v = (voiceName ?? "").trim();
  if (!v) return fallback;
  if (NOVA_VOICE_IDS.has(v)) return v;                 // already a Nova voiceId
  const mapped = GEMINI_TO_NOVA_VOICE[v.toLowerCase()]; // a known Gemini name → Nova alias
  return mapped ?? fallback;
}

// ── Pure output-event translation (unit-tested without AWS) ───────────────────────────────────────

/** A Nova Sonic output event is `{ event: { <eventName>: {...} } }`. */
type NovaOutputEvent = { event?: Record<string, any> } | null | undefined;

/**
 * Translate ONE parsed Nova Sonic output event into zero or more Gemini-shaped LiveServerMessages the
 * voice loop's onmessage handler already understands. Pure; never throws on malformed input.
 *
 * Notes:
 *  - Nova emits SPECULATIVE (revisable) then FINAL text. We surface only non-SPECULATIVE text so the
 *    on-screen transcript is not flooded with partials that get rewritten.
 *  - Barge-in arrives as a textOutput whose content is the JSON sentinel `{ "interrupted" : true }`
 *    (per the AWS sample); we map it to serverContent.interrupted and do NOT show it as transcript.
 *  - contentEnd carries a stopReason; END_TURN closes the model's spoken turn (-> turnComplete),
 *    INTERRUPTED is a barge-in (-> interrupted).
 */
export function translateNovaEvent(raw: NovaOutputEvent): any[] {
  const event = raw?.event;
  if (!event || typeof event !== "object") return [];

  // audioOutput → spoken model audio (base64 PCM 24 kHz), at the SAME path Gemini uses.
  if (event.audioOutput?.content) {
    return [{ serverContent: { modelTurn: { parts: [{ inlineData: { data: event.audioOutput.content } }] } } }];
  }

  // textOutput → either operator ASR (role USER), Janus text (role ASSISTANT), or a barge-in sentinel.
  if (event.textOutput) {
    const { content, role, additionalModelFields } = event.textOutput;
    // Barge-in sentinel — content is the JSON string `{ "interrupted" : true }`.
    if (typeof content === "string" && isInterruptionSentinel(content)) {
      return [{ serverContent: { interrupted: true } }];
    }
    // Drop SPECULATIVE partials (kept being revised) — surface FINAL / unstamped text only.
    if (isSpeculative(additionalModelFields)) return [];
    const text = typeof content === "string" ? content : "";
    if (!text) return [];
    if (String(role).toUpperCase() === "USER") {
      return [{ serverContent: { inputTranscription: { text } } }];
    }
    // ASSISTANT (or any non-USER) text → the model's spoken text, shown as "Janus" in the transcript.
    return [{ serverContent: { modelTurn: { parts: [{ text }] } } }];
  }

  // toolUse → a Gemini functionCall. `content` is a JSON STRING of the tool arguments.
  if (event.toolUse) {
    const { toolName, toolUseId, content } = event.toolUse;
    let args: Record<string, unknown> = {};
    try { args = content ? JSON.parse(content) : {}; } catch { args = {}; }
    return [{ toolCall: { functionCalls: [{ name: toolName, id: toolUseId, args }] } }];
  }

  // contentEnd → close-of-turn / interruption signalling.
  if (event.contentEnd) {
    const stop = String(event.contentEnd.stopReason ?? "").toUpperCase();
    if (stop === "INTERRUPTED") return [{ serverContent: { interrupted: true } }];
    if (stop === "END_TURN") return [{ serverContent: { turnComplete: true } }];
    return [];
  }

  // contentStart / completionStart / completionEnd / usageEvent — no UI-bearing payload for the loop.
  return [];
}

function isInterruptionSentinel(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return !!parsed && parsed.interrupted === true;
  } catch {
    return false;
  }
}
function isSpeculative(additionalModelFields: unknown): boolean {
  if (typeof additionalModelFields !== "string") return false;
  try {
    const parsed = JSON.parse(additionalModelFields);
    return parsed?.generationStage === "SPECULATIVE";
  } catch {
    return false;
  }
}

// ── Input-event builders (pure; unit-tested) ──────────────────────────────────────────────────────

export function buildSessionStartEvent() {
  return { event: { sessionStart: { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 } } } };
}

export function buildPromptStartEvent(promptName: string, voiceId: string, tools: NovaToolSpec[]) {
  const promptStart: Record<string, any> = {
    promptName,
    textOutputConfiguration: { mediaType: "text/plain" },
    audioOutputConfiguration: {
      mediaType: "audio/lpcm",
      sampleRateHertz: 24000,
      sampleSizeBits: 16,
      channelCount: 1,
      voiceId,
      encoding: "base64",
      audioType: "SPEECH",
    },
  };
  // Only attach tool config when there are tools — Nova rejects an empty/odd toolConfiguration on some
  // model revisions, and the function surface always has entries in practice.
  if (tools.length) {
    promptStart.toolUseOutputConfiguration = { mediaType: "application/json" };
    promptStart.toolConfiguration = { tools };
  }
  return { event: { promptStart } };
}

export function buildTextContentStart(promptName: string, contentName: string, role: "SYSTEM" | "USER") {
  return {
    event: {
      contentStart: {
        promptName, contentName, type: "TEXT", role, interactive: false,
        textInputConfiguration: { mediaType: "text/plain" },
      },
    },
  };
}
export function buildTextInput(promptName: string, contentName: string, content: string) {
  return { event: { textInput: { promptName, contentName, content } } };
}
export function buildAudioContentStart(promptName: string, contentName: string) {
  return {
    event: {
      contentStart: {
        promptName, contentName, type: "AUDIO", interactive: true, role: "USER",
        audioInputConfiguration: {
          mediaType: "audio/lpcm", sampleRateHertz: 16000, sampleSizeBits: 16,
          channelCount: 1, audioType: "SPEECH", encoding: "base64",
        },
      },
    },
  };
}
export function buildAudioInput(promptName: string, contentName: string, base64: string) {
  return { event: { audioInput: { promptName, contentName, content: base64 } } };
}
export function buildToolContentStart(promptName: string, contentName: string, toolUseId: string) {
  return {
    event: {
      contentStart: {
        promptName, contentName, interactive: false, type: "TOOL", role: "TOOL",
        toolResultInputConfiguration: {
          toolUseId, type: "TEXT", textInputConfiguration: { mediaType: "text/plain" },
        },
      },
    },
  };
}
export function buildToolResult(promptName: string, contentName: string, content: string) {
  return { event: { toolResult: { promptName, contentName, content } } };
}
export function buildContentEnd(promptName: string, contentName: string) {
  return { event: { contentEnd: { promptName, contentName } } };
}
export function buildPromptEnd(promptName: string) {
  return { event: { promptEnd: { promptName } } };
}
export function buildSessionEnd() {
  return { event: { sessionEnd: {} } };
}

// ── Async input queue (drives the bidirectional stream `body`) ────────────────────────────────────

/**
 * A minimal single-consumer async queue. The session adapter PUSHES Nova input events onto it; the
 * Bedrock command CONSUMES it as the request `body` (an async iterable). `end()` closes the stream.
 */
class AsyncEventQueue<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  end(): void {
    if (this.done) return;
    this.done = true;
    let w: ((r: IteratorResult<T>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as any, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// ── The session adapter ───────────────────────────────────────────────────────────────────────────

/**
 * Implements the four methods the voice loop calls on a live session. Translates each to Nova Sonic
 * input events pushed onto the bidirectional stream. Mirrors the Gemini Live `Session` surface so
 * src/voice/index.ts cannot tell the difference.
 */
export class NovaLiveSession {
  private readonly queue: AsyncEventQueue<any>;
  private readonly promptName: string;
  private readonly audioContentName: string;
  private closed = false;

  constructor(queue: AsyncEventQueue<any>, promptName: string, audioContentName: string) {
    this.queue = queue;
    this.promptName = promptName;
    this.audioContentName = audioContentName;
  }

  /** Gemini parity: session.sendRealtimeInput({ audio: { data, mimeType } }) → Nova audioInput. */
  sendRealtimeInput(input: { audio?: { data?: string; mimeType?: string } }): void {
    const data = input?.audio?.data;
    if (!data || this.closed) return;
    this.queue.push(buildAudioInput(this.promptName, this.audioContentName, data));
  }

  /** Gemini parity: session.sendToolResponse({ functionResponses: [{ name, id, response }] }). */
  sendToolResponse(payload: { functionResponses: Array<{ name: string; id?: string; response: Record<string, unknown> }> }): void {
    if (this.closed) return;
    for (const fr of payload?.functionResponses ?? []) {
      const toolUseId = fr.id ?? randomUUID();
      const contentName = randomUUID();
      this.queue.push(buildToolContentStart(this.promptName, contentName, toolUseId));
      this.queue.push(buildToolResult(this.promptName, contentName, JSON.stringify(fr.response ?? {})));
      this.queue.push(buildContentEnd(this.promptName, contentName));
    }
  }

  /**
   * Gemini parity: session.sendClientContent({ turns: [{ role, parts: [{ text }] }], turnComplete }).
   * Used for system-event narration (pushApprovalNarration/pushAck), situational/memory-brief injection,
   * and switch_context. Each text turn becomes a transient USER text content block, which prompts Nova
   * to respond — i.e. it speaks the narration, exactly like the Gemini path.
   */
  sendClientContent(payload: { turns?: Array<{ role?: string; parts?: Array<{ text?: string }> }> }): void {
    if (this.closed) return;
    for (const turn of payload?.turns ?? []) {
      const text = (turn?.parts ?? []).map((p) => p?.text ?? "").join("");
      if (!text) continue;
      const contentName = randomUUID();
      // Inject as USER text (Nova has no API to make the assistant utter an arbitrary string directly;
      // a USER turn that instructs it to "say this" is the same mechanism the Gemini narration uses).
      this.queue.push(buildTextContentStart(this.promptName, contentName, "USER"));
      this.queue.push(buildTextInput(this.promptName, contentName, text));
      this.queue.push(buildContentEnd(this.promptName, contentName));
    }
  }

  /** Tear the prompt + session down cleanly, then close the input stream. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.queue.push(buildContentEnd(this.promptName, this.audioContentName)); // close the audio block
      this.queue.push(buildPromptEnd(this.promptName));
      this.queue.push(buildSessionEnd());
    } finally {
      this.queue.end();
    }
  }
}

// ── The connector ───────────────────────────────────────────────────────────────────────────────

/**
 * connectNovaSonic(params, auth) — open a Nova Sonic 2 bidirectional stream and return a session that
 * the voice loop drives exactly like a Gemini Live session. Rejects (so the loop's connect-catch can
 * render a clean "set credentials" error frame) when credentials are missing. Runtime stream faults
 * route to params.callbacks.onerror + onclose, mirroring the Gemini onerror/onclose siblings.
 */
export async function connectNovaSonic(params: NovaConnectParams, auth: NovaAuth): Promise<NovaLiveSession> {
  if (!auth?.accessKeyId || !auth?.secretAccessKey || !auth?.region) {
    throw new Error("No AWS credentials are configured — set an AWS access key, secret key, and region in Settings to start Nova Sonic voice.");
  }

  const client = new BedrockRuntimeClient({
    region: auth.region,
    credentials: {
      accessKeyId: auth.accessKeyId,
      secretAccessKey: auth.secretAccessKey,
      ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
    },
  });

  const promptName = randomUUID();
  const audioContentName = randomUUID();
  const queue = new AsyncEventQueue<any>();
  const encoder = new TextEncoder();

  // The request body: each queued Nova event JSON wrapped as a bidirectional input chunk.
  const body = (async function* () {
    for await (const evt of queue) {
      yield { chunk: { bytes: encoder.encode(JSON.stringify(evt)) } };
    }
  })();

  // Prime the session: sessionStart → promptStart(tools+voice) → SYSTEM prompt block → open the audio block.
  const voiceId = voiceNameToNovaVoiceId(params.config?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName);
  const tools = toNovaToolSpecs(params.config?.tools?.[0]?.functionDeclarations ?? []);
  queue.push(buildSessionStartEvent());
  queue.push(buildPromptStartEvent(promptName, voiceId, tools));
  const sysPrompt = params.config?.systemInstruction;
  if (sysPrompt && sysPrompt.trim()) {
    const sysContentName = randomUUID();
    queue.push(buildTextContentStart(promptName, sysContentName, "SYSTEM"));
    queue.push(buildTextInput(promptName, sysContentName, sysPrompt));
    queue.push(buildContentEnd(promptName, sysContentName));
  }
  queue.push(buildAudioContentStart(promptName, audioContentName));

  // Open the stream. A failure here (bad creds, throttling, model access) rejects the connect promise,
  // which the voice loop's connect-catch turns into a clean error frame (never a silent reconnect storm).
  const response = await client.send(new InvokeModelWithBidirectionalStreamCommand({
    modelId: params.model,
    body,
  }));

  const session = new NovaLiveSession(queue, promptName, audioContentName);

  // Pump output events → translate → onmessage. Runs detached; a fault becomes onerror + onclose. The
  // SDK secures the stream over HTTP/2; the response.body is an async iterable of chunk members.
  void (async () => {
    try {
      for await (const member of response.body as AsyncIterable<any>) {
        const bytes = member?.chunk?.bytes;
        if (!bytes) continue;
        let parsed: any;
        try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { continue; } // skip an undecodable frame rather than tearing the session down
        for (const message of translateNovaEvent(parsed)) {
          try { await params.callbacks.onmessage(message); }
          catch (e) { console.error("[NOVA] onmessage handler threw (ignored):", e instanceof Error ? e.message : String(e)); }
        }
      }
      // Clean end of the model stream — surface as a close so the loop can re-announce / reconnect.
      params.callbacks.onclose?.({ code: 1000, reason: "nova stream ended" });
    } catch (err) {
      // Do NOT log the raw error object (it can carry request metadata). Message only.
      params.callbacks.onerror?.(err instanceof Error ? err : new Error(String(err)));
      params.callbacks.onclose?.({ code: undefined, reason: "nova stream error" });
    } finally {
      try { client.destroy(); } catch { /* best-effort */ }
    }
  })();

  return session;
}
