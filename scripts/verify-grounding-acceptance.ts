/**
 * scripts/verify-grounding-acceptance.ts — bead qkyr: does the live Gemini model ACCEPT a
 * googleSearch Tool entry alongside the FULL registry-derived functionDeclarations set in one
 * Live session?
 *
 * src/voice/liveConfig.ts documents this as a model-level caveat the SDK types do not encode:
 * historically the Live API rejected the combo for 2.0/2.5-era models, relaxed unevenly in later
 * previews. The off-by-default design keeps production safe either way, but the answer had never
 * been observed. This one-shot probe records it:
 *
 *   A (baseline)  — the exact off-path tools array (functionDeclarations only) connects and
 *                   answers a text turn. Proves the key/model/config are good, so a B rejection
 *                   is attributable to the googleSearch entry, not the harness.
 *   B (connect)   — the exact on-path tools array (buildVoiceTools groundingEnabled:true — the
 *                   same full declarations FIRST plus { googleSearch: {} }). Observes accept or
 *                   reject AT CONNECT (onopen vs onerror/onclose with the server's reason).
 *   C (mid-turn)  — only if B accepted: a search-inviting text turn on the combo session.
 *                   Observes whether the session survives mid-turn (some rejections only
 *                   surface when the model would actually invoke the tool) and whether
 *                   groundingMetadata / a coherent answer comes back.
 *
 * The config mirrors production's buildLiveConfig (src/voice/index.ts): AUDIO modality, both
 * transcription channels on — so the observed acceptance is the production shape's, not a
 * simplified TEXT-mode proxy.
 *
 * COST WARNING: real, metered Gemini Live API calls (up to 3 short sessions). Opt-in only.
 * Run:  node scripts/local/with-secrets.mjs npm run verify:grounding   (key via Credential Manager)
 * Exit: 0 = decisive observation recorded (accept OR reject — both are answers; see stdout).
 *       1 = no GEMINI_API_KEY, or a harness fault that prevented a decisive observation.
 *
 * After a run: record the verdict in src/voice/liveConfig.ts's MODEL-LEVEL caveat header and
 * docs/runbooks/live-voice-verify.md (bead qkyr).
 */
import { GoogleGenAI, Modality } from "@google/genai";
import { REGISTRY } from "../src/actions/registry";
import { toGeminiDeclarations } from "../src/actions/gemini";
import { buildVoiceTools } from "../src/voice/liveConfig";

const MODEL = process.env.JANUS_VERIFY_MODEL || "gemini-3.1-flash-live-preview";
const CONNECT_VERDICT_MS = 15000;
const MIDTURN_VERDICT_MS = 30000;

function log(...a: unknown[]) { console.log("[verify:grounding]", ...a); }

interface ProbeResult {
  opened: boolean;
  errors: string[];
  closes: { code?: number; reason?: string }[];
  messages: number;
  sawGroundingMetadata: boolean;
  outputTranscript: string;
}

/** True when the message carries groundingMetadata at the serverContent or part level. */
function messageHasGroundingMetadata(m: any): boolean {
  if (m?.serverContent?.groundingMetadata) return true;
  const parts = m?.serverContent?.modelTurn?.parts;
  return Array.isArray(parts) && parts.some((p: any) => p?.groundingMetadata);
}

/** Fold one server message into the running probe record (split from the onmessage callback for
 *  the complexity gate). Returns true when the message carried turnComplete — the decisive
 *  mid-turn survival signal the caller uses to stop waiting early. */
function recordServerMessage(result: ProbeResult, m: any): boolean {
  result.messages++;
  if (messageHasGroundingMetadata(m)) result.sawGroundingMetadata = true;
  const t = m?.serverContent?.outputTranscription?.text;
  if (typeof t === "string") result.outputTranscript += t;
  return m?.serverContent?.turnComplete === true;
}

/** Open one live session with `tools`, optionally send a text turn, and record everything the
 *  server does for up to `windowMs` after the last stimulus. Never throws — a connect() rejection
 *  is recorded as an error (that IS a verdict, not a fault). */
async function probeSession(ai: GoogleGenAI, tools: unknown[], turnText: string | null, windowMs: number): Promise<ProbeResult> {
  const result: ProbeResult = { opened: false, errors: [], closes: [], messages: 0, sawGroundingMetadata: false, outputTranscript: "" };
  let settle!: () => void;
  const done = new Promise<void>((r) => { settle = r; });
  let timer: NodeJS.Timeout | undefined;
  const bump = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(settle, ms); };

  let session: any = null;
  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: "You are a terse verification probe. Answer in one short sentence.",
        tools,
      } as any,
      callbacks: {
        onopen: () => { result.opened = true; },
        onmessage: (m: any) => { if (recordServerMessage(result, m)) bump(1500); },
        onerror: (e: any) => { result.errors.push(String(e?.message ?? e)); bump(1500); },
        onclose: (e: any) => { result.closes.push({ code: e?.code, reason: e?.reason }); bump(1500); },
      },
    });
  } catch (e) {
    result.errors.push(`connect() rejected: ${(e as Error).message}`);
    return result;
  }

  bump(windowMs);
  if (turnText) {
    // Give the open/reject verdict a moment to land before the stimulus.
    await new Promise((r) => setTimeout(r, 2500));
    if (result.errors.length === 0 && result.closes.length === 0) {
      try {
        session.sendClientContent({ turns: [{ role: "user", parts: [{ text: turnText }] }], turnComplete: true });
        bump(windowMs);
      } catch (e) {
        result.errors.push(`sendClientContent threw: ${(e as Error).message}`);
      }
    }
  }
  await done;
  if (timer) clearTimeout(timer);
  try { session.close(); } catch { /* already closed */ }
  return result;
}

function verdictLine(label: string, r: ProbeResult): string {
  const rejected = r.errors.length > 0 || r.closes.some((c) => c.code !== undefined && c.code !== 1000);
  return `${label}: opened=${r.opened} messages=${r.messages} errors=${JSON.stringify(r.errors)} closes=${JSON.stringify(r.closes)} ` +
    `grounding_metadata=${r.sawGroundingMetadata} transcript=${JSON.stringify(r.outputTranscript.slice(0, 200))} → ${rejected ? "REJECTED/DEGRADED" : "ACCEPTED"}`;
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    log("MISSING GEMINI_API_KEY — run via: node scripts/local/with-secrets.mjs npm run verify:grounding");
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: key });
  const declarations = toGeminiDeclarations(REGISTRY);
  log(`model=${MODEL} functionDeclarations=${declarations.length}`);

  log("A) baseline — full functionDeclarations, grounding OFF …");
  const a = await probeSession(ai, buildVoiceTools({ groundingEnabled: false, declarations }) as unknown[], "Reply with the single word BASELINE.", CONNECT_VERDICT_MS);
  log(verdictLine("A baseline", a));
  if (!a.opened || a.errors.length > 0) {
    log("baseline probe did not hold a healthy session — cannot attribute a combo rejection. Aborting.");
    process.exit(1);
  }

  log("B) combo at connect — full functionDeclarations + googleSearch …");
  const b = await probeSession(ai, buildVoiceTools({ groundingEnabled: true, declarations }) as unknown[], null, CONNECT_VERDICT_MS);
  log(verdictLine("B combo connect", b));

  const bRejected = b.errors.length > 0 || b.closes.some((c) => c.code !== undefined && c.code !== 1000);
  if (bRejected) {
    log("VERDICT: the live model REJECTS googleSearch alongside the full functionDeclarations set at connect.");
    log("Record in liveConfig.ts header + docs/runbooks/live-voice-verify.md: combo REJECTED at connect (evidence above).");
    process.exit(0);
  }

  log("C) mid-turn on the combo session — search-inviting turn …");
  const c = await probeSession(
    ai,
    buildVoiceTools({ groundingEnabled: true, declarations }) as unknown[],
    "Using web search if you can: what is one major news headline today? One short sentence.",
    MIDTURN_VERDICT_MS,
  );
  log(verdictLine("C combo mid-turn", c));

  const cRejected = c.errors.length > 0 || c.closes.some((x) => x.code !== undefined && x.code !== 1000);
  log(
    cRejected
      ? "VERDICT: combo ACCEPTED at connect but DEGRADED mid-turn (evidence above)."
      : `VERDICT: combo ACCEPTED at connect AND survived a mid-turn ${c.sawGroundingMetadata ? "WITH" : "without observed"} groundingMetadata.`,
  );
  log("Record in liveConfig.ts header + docs/runbooks/live-voice-verify.md (bead qkyr).");
  process.exit(0);
}

main().catch((e) => { console.error("[verify:grounding] harness error:", e); process.exit(1); });
