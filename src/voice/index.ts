/**
 * src/voice/index.ts — the GEMINI LIVE VOICE SESSION (DBT5 / dec-5).
 *
 * This is the behaviour-preserving carve of the ENTIRE `wss.on("connection", ...)` envelope out of
 * `startServer()` — the highest-risk / largest block in server.ts. It owns: the resumption-token
 * persist/rehydrate, the per-connection live-session lifecycle (connect, the LiveServerMessage
 * onmessage/onerror/onclose callbacks, the Gemini Live config, the post-connect hoist + paneSignal
 * subscribe, the bounded auto-reconnect, the initial connect), the gated voice approval/dispatch
 * path (resolveApprovalByVoice / dispatchProposal), the per-call ActionContext factory, and the
 * clientWs message/close handlers.
 *
 * Coupling flows ONLY through the injected `deps` bag. This module imports the pure helpers it already
 * used (live transcripts, approval intent, voice routing, voice resumption, active-pane, pending
 * approvals, the registry/gemini dispatch surface) and the concrete types of its deps — NEVER server.ts.
 *
 * INVARIANTS preserved verbatim:
 *  - The ~20 per-connection mutable `let`s are now an explicit `VoiceSessionState` object instantiated
 *    INSIDE the wss.on("connection") callback — NOT module/server scope. Sharing any of these across
 *    connections is a latent multi-client bug, so each connection gets its own state object.
 *  - The identity guards (connectGeneration + `coreState.activeLiveSession === session`) are intact.
 *  - dispatchProposal STAYS connection-scoped (over clientWs + the session); the REST ctxFactory keeps
 *    its OWN refusing-stub dispatchProposal (server.ts) — voice never touches the REST stub.
 *  - coreState owns activeFrontendWs / activeLiveSession / activePaneId / clients (mutated by reference).
 *  - pushApprovalNarration is a pure standalone export (no closure state) so gating can inject the SAME
 *    function server.ts feeds into attachVoiceSession — gating still never imports voice.
 */

import { GoogleGenAI, LiveServerMessage, Modality, type Session } from "@google/genai";
import type { WebSocketServer } from "ws";
import { redactSecrets, type OrchestratorManager } from "../terminal";
import { formatPaneSignal, type PaneSignal } from "../paneSignals";
import { parseApprovalIntent } from "../approvalIntent";
import { parseApprovalIntentShadowed, isApprovalPythonPrimary, resolveApprovalIntent } from "../approvalShadow";
import { shouldSpeak } from "./speakGate";
import { buildVoiceTools } from "./liveConfig";
import { shouldRouteUtterance, resolvePendingActionByVoice, resolveHeldCommandByVoice } from "../voiceApprovalRouting";
import { isPaneActiveForWrite } from "../activePane";
import { decideProposal, inferKind, type ApprovalKind } from "../pendingApprovals";
import { applyDispatchDecision } from "../dispatch/paneWrite";
import {
  resolveResumeHandleTtlMs,
  shouldClearHandleOnClose,
  wrapHandleForPersist,
  readFreshHandle,
  isInvalidKeyClose,
  isBlankApiKey,
} from "../voiceResumption";
import { extractTranscripts } from "../liveTranscripts";
import { extractGrounding, hasGrounding } from "../liveGrounding";
import { buildSystemInstruction } from "./systemPrompt";
import { applyPaneInputFrame } from "./paneInputFrame";
import { shouldSpeakOpeningAck, shouldSpeakReadyAck, OPERATOR_HOLD_MS } from "../voiceAckGate";
import { actionSchemaHash } from "../actions/registry";
import type { ActionContext, DispatchOutcome } from "../actions/types";
import type { CapabilityGate } from "../types";
import type { JanusStore } from "../store/sqliteStore";
import type { CoreState } from "../core/coreState";
import type { Gating } from "../gating";
import { findPaneOwningProject } from "../paneOwnership";
import type { CreatedMemory } from "../memory";
import { briefIsForActivePane } from "../memory";

/**
 * narrate a SYSTEM EVENT into the live session so the model speaks it to the operator. Pure (no
 * closure state) — exported so gating injects the SAME identity server.ts feeds into attachVoiceSession,
 * keeping gating free of any voice import. The definition moved here from server.ts (dec-5).
 *
 * 3V.3: returns whether the push actually went out. The exception stays SWALLOWED (a narration
 * failure must never break a sweep tick or a dispatch), but callers that gate state transitions on
 * the operator having HEARD the line (the sweep's last-call -> grace -> reject) now get the truth:
 * `false` = the send threw, nobody heard it. Fire-and-forget callers simply ignore the return.
 */
export function pushApprovalNarration(session: any, text: string): boolean {
  try {
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: `SYSTEM EVENT (say this to the operator, then stop): ${text}` }] }],
      turnComplete: true,
    });
    return true;
  } catch (e) {
    console.error("Failed to push approval narration to session:", e);
    return false;
  }
}

// ── 3V.2: WS keepalive + half-open cleanup ─────────────────────────────────────────────────────
// There was NO ping/pong anywhere: a half-open client (network drop without a TCP FIN) buffered
// broadcasts unboundedly, pinned coreState.activeFrontendWs/activePaneId, and kept the Gemini
// session alive forever. Standard ws keepalive: mark isAlive=true on accept + on every pong; ONE
// shared unref'd interval per WebSocketServer (armed in attachVoiceSession, cleared on wss close)
// sweeps all clients via sweepHeartbeats below. terminate() destroys the socket, which makes ws
// emit the connection's 'close' event — so the EXISTING per-connection cleanup paths (broadcast-set
// removal, activeFrontendWs/activePaneId nulling, Gemini session close, reconnect-timer cancel)
// run exactly as on a graceful close.

/** The keepalive cadence: ping every 30s; a client that missed the previous pong is terminated. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** The structural slice of a ws WebSocket the sweep touches (fakeable in unit tests). */
export interface HeartbeatClient {
  /** true = ponged since the last sweep (or just accepted); false = missed the previous ping. */
  isAlive?: boolean;
  ping: () => void;
  terminate: () => void;
}

/**
 * One keepalive sweep over `clients` (pure decision logic, extracted for unit coverage — the
 * interval wiring lives in attachVoiceSession). A client whose isAlive is STRICTLY false missed the
 * previous ping's pong window → terminate() it (best-effort; the socket may already be destroyed).
 * Every other client (true, or undefined = not yet enrolled) is flipped to isAlive=false and pinged;
 * its 'pong' handler re-sets isAlive=true before the next sweep. Per-client faults are swallowed so
 * one broken socket never starves its siblings of their keepalive. Returns the terminated clients.
 */
export function sweepHeartbeats(clients: Iterable<HeartbeatClient>): HeartbeatClient[] {
  const terminated: HeartbeatClient[] = [];
  for (const ws of clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* already destroyed — its 'close' already ran */ }
      terminated.push(ws);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket torn down mid-sweep; the next sweep terminates it */ }
  }
  return terminated;
}

/** A PaneSignal queued on the phase-2 "ready" defer path, tagged with the wall-clock time it was
 *  deferred so the drain can age it out (READY_DEFER_MAX_MS). The tag lives on a CLONE, never the
 *  shared bus payload — see stampDeferred. */
export type DeferredPaneSignal = PaneSignal & { __deferredAt: number };

/**
 * bead ykr: the PaneSignalBus hands the SAME PaneSignal object reference to every observer. Stamping
 * the defer timestamp in-place would mutate the shared payload that every other observer (and the bus
 * caller) holds. Clone first, then stamp — the queue gets its own tagged copy, the shared signal is
 * left untouched. Pure (exported for unit coverage).
 */
export function stampDeferred(sig: PaneSignal, now: number): DeferredPaneSignal {
  return { ...sig, __deferredAt: now };
}

/**
 * B1 (async spawn): a lighter sibling of pushApprovalNarration for the two-phase spawn acks. No
 * "SYSTEM EVENT" framing — these are natural-cadence confirmations ("Opening the pane now.") the
 * model speaks then stops. Additive + own try/catch: a failed ack push NEVER breaks dispatch (the
 * tool response was already answered before this runs). Caller gates speak/defer/suppress upstream.
 */
function pushAck(session: any, text: string): void {
  try {
    session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
  } catch (e) {
    console.error("Failed to push ack:", e);
  }
}

/**
 * Apply a `draft_edit` WS frame (operator editing a pane's WIP draft — ungated, not a CLI write).
 * Defaults the project to the ledger's active project and the pane to the active pane when the frame
 * names neither. Persists via `manager.ledger.setDraft` and, on a successful write, broadcasts
 * `draft_updated` for that pane. Behaviour-preserving extraction of the byte-identical inline blocks
 * that lived in BOTH the observe-socket and the voice clientWs message handlers (Phase 7 CC refactor).
 */
function applyDraftEditFrame(
  msg: any,
  manager: OrchestratorManager,
  coreState: CoreState,
  broadcastDraft: (projectId: string, paneId: string) => void,
): void {
  const projectId = msg.projectId || manager.ledger.activeProjectId || "default_project";
  const paneId = msg.paneId || coreState.activePaneId;
  if (paneId && manager.ledger.setDraft(projectId, paneId, msg.text, "operator")) {
    broadcastDraft(projectId, paneId);
  }
}

// DispatchOutcome (the result shape returned by `dispatchProposal`) is the single canonical type in
// ../actions/types — imported above. The byte-identical local duplicate that used to live here was
// removed in c55.16 (tech_debt_dispatchoutcome_dedup); both arms were always kept in lockstep by hand.

/**
 * The voice session's injected dependency bag — everything the moved closures used from `startServer()`
 * scope, threaded explicitly so the SAME shared cells are mutated across the boundary.
 */
export interface VoiceDeps {
  manager: OrchestratorManager;
  store: JanusStore | null;
  broadcast: (msg: any) => void;
  broadcastLedgerUpdate: () => void;
  broadcastDraft: (projectId: string, paneId: string) => void;
  appendActiveDraft: (line: string, updatedBy: "janus" | "operator") => void;
  activeDraftTarget: () => { projectId: string; paneId: string } | null;
  sanitizeSettingsForClient: (settings: any) => any;
  coreState: CoreState;
  paneSignalBus: { subscribe: (fn: (sig: any) => void) => () => void };
  announcementBus: { enqueue: (item: any) => void };
  pruneAttention: () => void;
  interactionLog: {
    mint: () => string;
    log: (entry: any) => void;
  };
  recipes: any;
  /** record a command in the HistoryManager singleton (server.ts-internal; passed in, not imported) —
   *  used by the dispatchProposal auto-execute path exactly as the inline HistoryManager.addCommand was. */
  addCommand: (terminalId: string, command: string) => void;
  ai: GoogleGenAI;
  boundLiveConnector: (ai: GoogleGenAI, params: any, key?: string | null) => Promise<any>;
  boundSessionAiFactory: (key: string, fallback: GoogleGenAI) => GoogleGenAI;
  /** The shared gating/safety core (dec-4). The voice path consumes the SAME pending stores + resolver. */
  gating: Gating;
  /** Memory Synthesis P0a: the in-process anti-rot memory service (synthesize + breadcrumb feed).
   *  The voice path injects a fresh situational brief on (a) session start and (b) pane switch via
   *  the existing sendClientContent channel. */
  memory: CreatedMemory;
  /** mirror the active turn's id to server module scope so manager.onOutput can tag PTY output. */
  setLastInteractionId: (v: string | null) => void;
  /** narrate a system event into the live session (the pure export above; injected for symmetry / overridability). */
  pushApprovalNarration: (session: any, text: string) => void;
  // ── Imported registry/dispatch surface (passed in, not imported, per the dec-5 seam contract) ──
  REGISTRY: any;
  runAction: (registry: any, name: string, args: Record<string, unknown>, ctx: ActionContext) => Promise<any>;
  resultToToolResponse: (result: any, session: any, name: string, callId: string) => void;
  toGeminiDeclarations: (registry: any) => any;
  // ── Auth seam (the WS connection guard) ──
  API_AUTH_TOKEN: string;
  getCookie: (cookieHeader: string | undefined, name: string) => string | null;
  /** bead 9fz: register THIS connection's reconnect-nudge closure with server module scope so the
   *  settings PUT (which sets a real Gemini key) can ask the live session to (re)connect. Optional so
   *  existing test harnesses that build deps inline need not supply it.
   *  bead 53q: pass an `owner` token (this connection's state object) on BOTH register and clear so a
   *  stale/foreign connection's close cannot clear the SURVIVING connection's nudge (identity guard). */
  registerReconnectNudge?: (fn: (() => void) | null, owner?: unknown) => void;
}

/**
 * The explicit per-connection state — the ~20 mutable `let`s that were connection-scoped closures
 * inside the inline wss.on("connection") callback. Instantiated ONCE per connection (NOT shared), so
 * a second client gets a fresh, independent session lifecycle (no latent cross-client bleed).
 */
interface VoiceSessionState {
  // The live Gemini handle (the SDK `Session`) for THIS connection, or null before the first
  // successful connect / after teardown. bead ec8: PR #89's as-any sweep typed the `message`
  // envelope on the onmessage seam but left this (and the toolCall dispatch param) as `any`.
  session: Session | null;
  unsubscribePaneSignals: (() => void) | null;
  wsClosed: boolean;
  currentSessionUserUtterance: string;
  currentSessionModelUtterance: string;
  currentInteractionId: string | null;
  lastSpeaker: "operator" | "model" | null;
  // B1 (turn-aware ack): the async-spawn acks must NOT speak over the operator. Tracked from the
  // SAME live Gemini signals the loop reads — `lastOperatorSpeechAt` (inputTranscription recency,
  // stamped in onOperatorSpeech) and `lastInterrupted` (the serverContent.interrupted barge-in latch).
  lastOperatorSpeechAt: number;
  lastInterrupted: boolean;
  // BEAD tkd (should-I-speak gate): per-TURN latch. Computed once when the operator transcript lands
  // (shouldSpeak on the input transcript); when TRUE the model's spoken AUDIO for this turn is
  // suppressed at the single audio choke point. Cleared at the start of each operator turn
  // (onOperatorSpeech) and on turnComplete/generationComplete so it can NEVER bleed past one turn.
  // Default false (off => never set true). The on-screen transcript_text stays unconditional.
  muteCurrentModelTurn: boolean;
  // B1 (phase-2 defer): a "ready" pane signal arriving mid-utterance is QUEUED here and re-tried at
  // the next safe gap (armReadyDrain) instead of speaking over the operator. The drain timer is
  // unref'd (force-exit hygiene) and cleared on socket close.
  deferredReady: DeferredPaneSignal[];
  readyDrainTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stableResetTimer: ReturnType<typeof setTimeout> | null;
  connectGeneration: number;
  // 2S.5: armed wherever a voice_channel_lost frame is broadcast for THIS client connection;
  // disarmed by the next successful hoist, which then broadcasts voice_channel_restored. A FIRST
  // connect (no prior loss) must NOT announce "restored" — that is exactly what this flag encodes.
  voiceLostSinceLastRestore: boolean;
}

/**
 * attachVoiceSession(wss, deps) — wire the live-voice connection handler onto the WebSocketServer.
 * Mirrors the inline `wss.on("connection", ...)` exactly; the resumption-token persist/rehydrate state
 * is per-server (one boot rehydrate, shared across this server's connections — identical to the inline
 * `let lastSessionResumptionToken` it replaced).
 */
export function attachVoiceSession(wss: WebSocketServer, deps: VoiceDeps): void {
  const {
    manager,
    store,
    broadcast,
    broadcastLedgerUpdate,
    broadcastDraft,
    appendActiveDraft,
    activeDraftTarget,
    sanitizeSettingsForClient,
    coreState,
    paneSignalBus,
    announcementBus,
    pruneAttention,
    interactionLog,
    recipes,
    addCommand,
    ai,
    boundLiveConnector,
    boundSessionAiFactory,
    gating,
    memory,
    setLastInteractionId,
    pushApprovalNarration: pushApprovalNarrationDep,
    REGISTRY,
    runAction,
    resultToToolResponse,
    toGeminiDeclarations,
    API_AUTH_TOKEN,
    getCookie,
    registerReconnectNudge,
  } = deps;

  // Destructure the gating seam so the moved inline call sites keep referencing these by name. ONE
  // shared object by reference — the pending stores + the posture surface read coreState.frozen /
  // activePaneId across the boundary, so a WS write is immediately seen.
  const {
    effectiveModeFor,
    effectiveCapabilityGateFor,
    gateOrDefer,
    gateCapability,
    applyResolution,
    applyDeferral,
    noteSessionDetached,
    applyPaneMode,
    reannounceSurvivors,
    pendingApprovals,
    pendingActions,
    shellAllowlist,
    APPROVAL_TTL_MS,
    posturePayloadForPane,
    broadcastTerminalsUpdated,
    stopAll,
    releaseStopAll,
    runningPaneIds,
  } = gating;

  // PLM4 (1): RESUMPTION-TOKEN PERSISTENCE. The Gemini Live resume handle was in-memory only, so a
  // process restart lost it and the next connect could not resume the conversation. Persist the FULL
  // sessionResumptionUpdate to the durable KV whenever it changes, and rehydrate it at boot. Guarded
  // for store === null (legacy backend) — the in-memory value is then the only source, exactly as
  // before. The same KV the `frozen` flag uses (store.setKV / getKV).
  //
  // RESILIENCE (bead wsm-e2e-pinned-aiu): the persisted value is now AGE-STAMPED (wrapHandleForPersist)
  // and rehydrate refuses a handle older than JANUS_RESUME_HANDLE_TTL_MS (default 1h) — a stale handle
  // from a long-gone session would otherwise be re-fed and rejected with code=1008 "session expired".
  // A discarded/legacy/garbage row is deleted so it can never be re-read. The matching onclose
  // self-heal in handleSessionLost clears a handle that 1008s despite passing the age guard.
  const VOICE_RESUMPTION_KV = "voiceResumptionToken";
  const RESUME_HANDLE_TTL_MS = resolveResumeHandleTtlMs(process.env);
  function rehydrateResumptionToken(): any {
    if (!store) return null;
    try {
      const raw = store.getKV(VOICE_RESUMPTION_KV);
      const fresh = readFreshHandle(raw, Date.now(), RESUME_HANDLE_TTL_MS);
      if (!fresh) {
        // Stale (past TTL), legacy (no age stamp), or malformed → purge so it can never be re-fed.
        if (raw) {
          store.deleteKV(VOICE_RESUMPTION_KV);
          console.warn("[SESSION RESUMPTION] discarded a stale/unstamped persisted handle at boot — connecting fresh.");
        }
        return null;
      }
      return fresh.token;
    } catch (e) {
      console.error("[SESSION RESUMPTION] failed to rehydrate persisted token:", e);
      return null;
    }
  }
  function persistResumptionToken(token: any): void {
    if (!store) return;
    try {
      if (token == null) store.deleteKV(VOICE_RESUMPTION_KV);
      else store.setKV(VOICE_RESUMPTION_KV, wrapHandleForPersist(token, Date.now()));
    } catch (e) {
      console.error("[SESSION RESUMPTION] failed to persist token:", e);
    }
  }
  // Boot rehydrate: a restart resumes from the last persisted handle.
  let lastSessionResumptionToken: any = rehydrateResumptionToken();

  // 3V.2: ONE shared keepalive interval per WebSocketServer (NOT per connection). Unref'd (force-exit
  // hygiene, same as every other timer here) and cleared when the wss closes so a torn-down test
  // server never keeps sweeping. terminate() on a missed pong fires the connection's own 'close'
  // handler below — the existing half-open cleanup (broadcast set, activeFrontendWs, Gemini session).
  const heartbeatTimer = setInterval(
    () => sweepHeartbeats(wss.clients as unknown as Iterable<HeartbeatClient>),
    HEARTBEAT_INTERVAL_MS,
  );
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  wss.on("close", () => clearInterval(heartbeatTimer));

  wss.on("connection", async (clientWs, req) => {
    const tokenFromCookie = getCookie(req.headers.cookie, "auth_token");
    if (tokenFromCookie !== API_AUTH_TOKEN) {
      console.warn("[SECURITY] Blocked unauthorized WebSocket connection attempt.");
      clientWs.send(JSON.stringify({ type: "error", message: "Unauthorized WebSocket access. Please reload the interface." }));
      clientWs.close(4001, "Unauthorized");
      return;
    }

    // 3V.2: enroll this connection into the keepalive — alive on accept, re-alive on every pong.
    // Marked BEFORE the observe-only early-return below so BOTH lanes (observe + voice) are swept.
    (clientWs as unknown as HeartbeatClient).isAlive = true;
    clientWs.on("pong", () => { (clientWs as unknown as HeartbeatClient).isAlive = true; });

    coreState.activeFrontendWs = clientWs;
    coreState.clients.add(clientWs);
    console.log("Client connected to WebSocket");

    // ── Read-only OBSERVE socket (the Orbital Kitchen burner) ───────────────
    // The kitchen streams live PTY output + board updates over /live WITHOUT a
    // voice session: connect with `?observe=1` and the socket joins the broadcast
    // set (so stdout_chunk / ledger_updated / settings_updated / frozen / pane_status
    // reach it) and may set the active pane (so operator raw-input + draft writes
    // target the right pane through the gate). Crucially it RETURNS before any of
    // the per-connection voice machinery below — NO Gemini Live session is started
    // (no mic, no model, no token cost, no auto-reconnect). This is the mic-free
    // read lane the classic app's connectLive() never had: connecting there always
    // eagerly opened a live session. The cookie auth above still applies.
    //
    // Extracted whole into setupObserveConnection (Phase 7 CC refactor): it returns TRUE when this is
    // an observe socket (caller short-circuits before any voice machinery), FALSE for a voice client.
    // Behaviour is byte-identical to the inline block — same observe-flag parse, same message/close
    // handlers, same early return.
    const setupObserveConnection = (): boolean => {
      let observeOnly = false;
      try {
        observeOnly = new URLSearchParams((req.url || "").split("?")[1] || "").get("observe") === "1";
      } catch { observeOnly = false; }
      if (!observeOnly) return false;
      console.log("Client connected to WebSocket (observe-only — no voice session)");
      clientWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "set_active_pane") {
            // The kitchen is the source of truth for the open pane (mirrors the voice handler). Recording
            // it lets operator raw-input / draft writes target the correct pane through the gate.
            coreState.activePaneId = typeof msg.paneId === "string" ? msg.paneId : null;
          } else if (msg.type === "draft_edit" && msg.text !== undefined) {
            // Per-pane WIP draft edit (ungated — composing is not a CLI write). Defaults to the active pane.
            applyDraftEditFrame(msg, manager, coreState, broadcastDraft);
          } else if (msg.type === "pane_input") {
            // Operator typing directly into a focused pane — ungated (above the gate) but scoped to the
            // active pane inside the helper (isPaneActiveForWrite), like the raw-input control-key route.
            // The helper validates data/pane internally (no dispatch-site precondition — keeps this
            // already-maxed handler at CC<=10).
            applyPaneInputFrame(msg, manager, coreState);
          }
        } catch (err) {
          console.warn("Received malformed observe-socket frame, skipping:", err);
        }
      });
      clientWs.on("close", () => {
        coreState.clients.delete(clientWs);
        if (coreState.activeFrontendWs === clientWs) {
          coreState.activeFrontendWs = null;
          coreState.activePaneId = null; // no UI connected -> no source of truth -> no write permitted.
        }
        console.log("Client WS closed (observe-only)");
      });
      return true;
    };
    if (setupObserveConnection()) return;

    // Step 6: drafts are per-pane now; the client fetches the active pane's draft once it has told
    // us which pane is open (set_active_pane). No global buffer to push on connect.

    // dec-5 (DBT5): the ~20 per-connection mutable `let`s are an explicit per-connection state object
    // (NOT module/server scope — sharing any of these across connections is a latent multi-client bug).
    // `session`, `unsubscribePaneSignals`, `wsClosed`, the utterance buffers, the turn id + lastSpeaker,
    // and the PLM4 reconnect budget + timers + connectGeneration all live here, scoped to THIS connection.
    const state: VoiceSessionState = {
      session: null,
      unsubscribePaneSignals: null,
      // `wsClosed` is now STRICTLY "the operator's client WS has closed" (set in clientWs.on("close")).
      // It is the reconnect kill-switch: a scheduled reconnect aborts if the operator already left.
      // A dead Gemini live session is tracked SEPARATELY by a per-attempt `sessionDead` flag inside
      // connectLiveSession (so a stale session's post-close flush can't poison the token WITHOUT also
      // blocking a fresh reconnect — the two used to share `wsClosed`, which would have defeated PLM4).
      wsClosed: false,
      currentSessionUserUtterance: "",
      currentSessionModelUtterance: "",
      // Correlated interaction log: one interaction_id per operator TURN. `lastSpeaker` flips the turn —
      // when the operator speaks after the model, mint a fresh id; the model's response + tool calls +
      // result + pty all share it. turnId() lazily mints for model-first events (e.g. a greeting).
      currentInteractionId: null,
      lastSpeaker: null,
      // B1 (turn-aware ack): 0 = the operator has never spoken; no barge-in latched yet.
      lastOperatorSpeechAt: 0,
      lastInterrupted: false,
      // BEAD tkd: no turn muted yet. Set per-turn from shouldSpeak when the operator transcript lands.
      muteCurrentModelTurn: false,
      // B1 (phase-2 defer): empty queue, no drain timer in flight.
      deferredReady: [],
      readyDrainTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      // PLM4 (Finding: flap): one-shot timer armed on each successful hoist; it resets the retry budget
      // ONLY once the session has been live for RECONNECT_STABLE_UPTIME_MS. Cleared if the session drops
      // (or the operator leaves) before then, so a flapping session never refreshes its budget.
      stableResetTimer: null,
      // PLM4 (2): monotonic connect generation. Each connectLiveSession() invocation bumps it and
      // captures its own number; when its async connect resolves it bails if a NEWER connect has since
      // started (so a slow stale connect can never clobber a newer live session). Mirrors the QW3
      // `coreState.activeLiveSession === session` identity guard for the in-flight (not-yet-hoisted) window.
      connectGeneration: 0,
      // 2S.5: no loss announced yet on this fresh connection — the first hoist stays silent.
      voiceLostSinceLastRestore: false,
    };

    const turnId = (): string => {
      if (state.currentInteractionId == null) state.currentInteractionId = interactionLog.mint();
      setLastInteractionId(state.currentInteractionId);
      return state.currentInteractionId;
    };
    const onOperatorSpeech = (): string => {
      if (state.lastSpeaker !== "operator") state.currentInteractionId = interactionLog.mint();
      state.lastSpeaker = "operator";
      state.lastOperatorSpeechAt = Date.now(); // B1: stamp recency for the turn-aware ack gate.
      state.lastInterrupted = false;           // B1: a fresh operator transcript clears a stale barge-in latch.
      state.muteCurrentModelTurn = false;      // BEAD tkd: a new operator turn clears the speak-gate latch (recomputed below).
      setLastInteractionId(state.currentInteractionId);
      return state.currentInteractionId!;
    };
    // B1 (turn-aware ack): a pure snapshot of the turn state for the gate (src/voiceAckGate.ts).
    const ackState = () => ({
      lastOperatorSpeechAt: state.lastOperatorSpeechAt,
      interrupted: state.lastInterrupted,
      now: Date.now(),
    });
    // B1: centralize the "model took the turn" transition so every site that sets lastSpeaker="model"
    // also clears a stale barge-in latch (a barge-in is consumed once the model is talking again).
    const setModelTurn = () => { state.lastSpeaker = "model"; state.lastInterrupted = false; };
    const voiceName = manager.settings.voiceAi?.voice || "Zephyr";

    // Memory Synthesis P0a (anti-rot injection): synthesize a FRESH situational brief for the
    // now-active pane and inject it into the live session via the SAME sendClientContent channel the
    // ears use. Wrapped in try/catch and fully NON-BLOCKING — a synthesis/inject failure must NEVER
    // throw into the live loop (the brief is best-effort context, not a turn the model owes a reply).
    // `now` is the Node runtime epoch-ms clock. Called on (a) session start and (b) pane switch.
    const injectMemoryBrief = async (sess: any, activeId: string | null): Promise<void> => {
      try {
        if (!sess) return;
        // Inc 4 slice 1 (SHADOW): fire-and-forget cortex OBSERVATION — logs what it WOULD curate for
        // this trigger, applies nothing. Synchronous void; never blocks or alters the brief below
        // (parity invariants I-P1..I-P3). Spec: docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md
        memory.service.observeCortexShadow(activeId, Date.now());
        // P0b: race the Python synthesizer (≤memorySynthTimeoutMs) against the in-process floor.
        // synthesizeAsync owns the race + `source` authority and NEVER rejects.
        const brief = await memory.service.synthesizeAsync(activeId, Date.now());
        // Latest-wins (invariant I3): compare the requested pane id against the current focus — if
        // the operator switched panes while we awaited, DROP this brief rather than inject stale
        // context for a backgrounded pane. Using activeId (not brief.activePaneId) means a pane
        // with no tier yet (brief.activePaneId null) is still correctly injected.
        if (!briefIsForActivePane(activeId, coreState.activePaneId)) return;
        if (brief.text.trim()) {
          sess.sendClientContent({
            turns: [{ role: "user", parts: [{ text: `CONTEXT (situational, do not read aloud):\n${brief.text}` }] }],
            turnComplete: true,
          });
        }
      } catch (e) {
        // The whole body is guarded so the returned promise NEVER rejects — the three fire-and-forget
        // call sites ignore it, and an unhandled rejection must never escape into the live loop.
        console.error("[memory] brief injection failed:", e);
      }
    };

    // PLM4 (2): AUTO-RECONNECT with BOUNDED exponential backoff. On a Gemini Live session loss we
    // schedule connectLiveSession() again with a capped attempt count AND a capped delay — NO storm.
    // The timer is cleared on operator WS close (no reconnect after the operator leaves). The three
    // tunables read optional env overrides so the reconnect suite can shrink the delays + attempt cap
    // to run deterministically fast (prod defaults: 6 attempts, 500ms base, 30s ceiling).
    const RECONNECT_MAX_ATTEMPTS = Number(process.env.JANUS_RECONNECT_MAX_ATTEMPTS) || 6;
    const RECONNECT_BASE_DELAY_MS = Number(process.env.JANUS_RECONNECT_BASE_DELAY_MS) || 500;
    const RECONNECT_MAX_DELAY_MS = Number(process.env.JANUS_RECONNECT_MAX_DELAY_MS) || 30000;
    // PLM4 (Finding: flap-unbounded backoff): the bounded-retry budget is only refreshed after a
    // session has stayed CONTINUOUSLY live for this long. A session that connects then immediately
    // drops in a loop never reaches the threshold, so its budget keeps depleting and it gives up at
    // the cap (permanent loss frame) instead of reconnecting forever at the base delay. Env-tunable so
    // the flap suite can shrink it (prod default: 30s of continuous uptime counts as a stable session).
    const RECONNECT_STABLE_UPTIME_MS = Number(process.env.JANUS_RECONNECT_STABLE_UPTIME_MS) || 30000;
    function clearStableResetTimer(): void {
      if (state.stableResetTimer) { clearTimeout(state.stableResetTimer); state.stableResetTimer = null; }
    }
    function clearReconnectTimer(): void {
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    }

    // WS-E.2/E.3: resolve a single targeted approval by voice. Speaks a pane+instruction
    // read-back at resolution (R3 push), claims atomically (BUG-013/N-1 seam), and reports a
    // spoken error on a dead pane (BUG-020) instead of unconditional success.
    function resolveApprovalByVoice(_sess: any, messageId: string, approve: boolean) {
      // The shared single choke-point renders narration + broadcast through the mandatory claim
      // gate (exactly-once, dead-pane, redaction all inside). `vocal:true` tags the WS payloads.
      applyResolution(messageId, approve ? "approve" : "reject", { vocal: true });
    }

    // WS-E.1 + R1/R2/R4: the SINGLE gated dispatch path. Used by both `propose_command` and
    // `execute_plan` so plan steps respect the effective-mode gate (R4 closes the bypass).
    // Returns the model-facing outcome text; the HiTL case stores a non-blocking pending entry
    // (Janus is NOT muted — BUG-001) and the caller answers call.id with `pending_approval`.
    function dispatchProposal(opts: {
      sess: any;
      callId: string;
      /** Pending-entry key; defaults to callId. Plan steps use a synthetic id so they do
       *  not collide with the execute_plan functionCall id. */
      pendingId?: string;
      targetId: string;
      instruction: string;
      explicitKind?: ApprovalKind;
      trigger: string;
      /** The capability this write rides (design §3). Defaults to "write_to_pane". The handoff
       *  delivery path passes "deliver_handoff". The gate AND-composes with effectiveMode. */
      capability?: CapabilityGate;
      /** Fan-out staging (dispatch_to_panes): never auto-execute; off-focus targets allowed
       *  because every write is parked as a pending approval first (see paneWrite.ts). */
      forceStage?: boolean;
    }): DispatchOutcome {
      // c55.9 (A3-min): dispatchProposal is now a THIN WRAPPER over the shared dispatch core
      // (applyDispatchDecision, src/dispatch/paneWrite.ts). It resolves the gate EXACTLY as before
      // (the pure [decide] half) and binds the THREE connection-bound values: the live session, the
      // pending-notify sink = clientWs.send (the one originating socket), the active-pane guard ON
      // (Janus may only propose into the operator's open pane), and origin "voice". Behavior is
      // BYTE-IDENTICAL to the pre-extraction inline switch (pinned by tests/test_approvals_wse.ts).
      const { sess, callId, targetId, instruction } = opts;
      const pendingId = opts.pendingId ?? callId;
      const capability: CapabilityGate = opts.capability ?? "write_to_pane";
      const term = manager.terminals[targetId];
      // Owning-project lookup (paneOwnership.ts), in lockstep with restDispatchProposal: a
      // ledger pane in a NON-active project must not resolve to "pane not found".
      const paneExists = !!term || !!findPaneOwningProject(manager, targetId);

      const runtimeType = term?.runtimeType;
      const kind = inferKind(opts.explicitKind, runtimeType);

      // M3: single-source effective-mode resolver (global-first, then pane, then HiTL default).
      const effectiveMode = effectiveModeFor(targetId);
      // §3 AND-veto: resolve the per-capability gate and AND-compose it with effectiveMode.
      const gate = effectiveCapabilityGateFor(targetId, capability);

      const decision = decideProposal({ kind, instruction, effectiveMode, runtimeType, paneExists, allowlist: shellAllowlist, capability, gate });

      return applyDispatchDecision(
        decision,
        {
          manager,
          pendingApprovals,
          broadcast,
          addCommand,
          redactSecrets,
          getPaneSummary: (paneId, lines) => manager.getPaneSummary(paneId, lines),
          posturePayloadForPane,
          announcementBus,
          approvalTtlMs: APPROVAL_TTL_MS,
          getActivePaneId: () => coreState.activePaneId,
          isPaneActiveForWrite,
          targetId,
          instruction,
          capability,
          kind,
          trigger: opts.trigger,
          effectiveMode,
          pendingId,
          callId,
          term,
          forceStage: opts.forceStage === true,
        },
        {
          // Step 5 (single active pane): Janus may only propose to the pane the operator has open, so
          // the operator can SEE and improve the command before it lands (HiTL). Enforced on voice.
          sess,
          notifyPending: (frame) => clientWs.send(JSON.stringify(frame)),
          enforceActivePaneGuard: true,
          origin: "voice",
        }
      );
    }

    // PLM4 (2): the session-establish logic, extracted into a reusable closure callable on BOTH the
    // initial connect AND every bounded reconnect attempt. On the reconnect path the resumption token
    // (config.sessionResumption below) lets the conversation resume, and reannounceSurvivors(session)
    // re-announces the surviving approvals for free (PLM4 (4)). The per-attempt `sessionDead` flag
    // gates that attempt's stale post-close resumption flush WITHOUT touching `wsClosed` (so a dead
    // session never blocks the next reconnect). identity guards mirror the QW3 teardown.
    async function connectLiveSession(isReconnect: boolean): Promise<void> {
    // Claim a fresh generation; a later invocation bumps this and our post-connect guard then bails.
    const myGeneration = ++state.connectGeneration;
    // This attempt's dead flag (the QW3 post-close-flush gate, now per-session, not shared on wsClosed).
    let sessionDead = false;
    // QW3 (bead qw3) + PLM4 (2): teardown for a Gemini Live socket that dies WITHOUT the client WS
    // closing. Detach (keep survivors for re-announce), null coreState.activeLiveSession behind the identity
    // guard so a stale callback can't clobber a newer session, broadcast voice_channel_lost, THEN
    // (PLM4) schedule a bounded reconnect. Idempotent-ish: onerror + onclose can both fire for one
    // drop — `sessionDead` makes the second call a no-op so we schedule exactly one reconnect.
    const handleSessionLost = (reason: "error" | "closed", closeCode?: number) => {
      if (sessionDead) return; // already torn down this attempt — don't double-schedule a reconnect.
      // 3V.1 (b): STALE-ATTEMPT GUARD — extend the identity principle (the activeLiveSession-nulling
      // guard below) to the WHOLE teardown. If a NEWER connectLiveSession has bumped the generation,
      // THIS attempt's session is stale (it was, or is about to be, closed by the post-connect
      // generation guard) and its late onerror/onclose must be a complete no-op: its detachSession
      // would detach the LIVE session's approvals (state.session already points at the newer
      // session), its voice_channel_lost would be a lie, and its scheduleReconnect would hoist a
      // THIRD session over the healthy one without closing it. The CURRENT generation's own
      // callbacks own the real teardown. Mark this attempt dead so a paired onerror+onclose for the
      // same stale drop stays idempotent.
      if (myGeneration !== state.connectGeneration) { sessionDead = true; return; }
      sessionDead = true;
      if (state.session) {
        const detached = pendingApprovals.detachSession(state.session);
        // 4D.1: open the "while you were away" window — the next reconnect digests the durable
        // activity rows recorded between this moment and the reconnect.
        noteSessionDetached();
        if (detached.length) console.log(`[VOICE] kept ${detached.length} approval survivor(s) after voice channel ${reason}.`);
        // Identity guard (NOT the double-fire guard): the per-attempt `sessionDead` flag above is what
        // makes a double onerror+onclose for ONE drop fire exactly once. THIS guard does a DIFFERENT
        // job — it only nulls the hoisted handle if it still points at THIS session, so a LATE stale
        // callback (whose `session` was overwritten by a newer reconnect) can't null the newer live
        // session. `session` is the mutated connection-scope let, so the comparison is by reference
        // against whatever is currently hoisted (copied from WS-close).
        if (coreState.activeLiveSession === state.session) {
          coreState.activeLiveSession = null;
          // PLM4 (Finding: flap): the currently-live session dropped — cancel its pending stable-reset
          // timer so a flapping session never refreshes its bounded-retry budget. Gated by the same
          // identity guard so a LATE stale callback can't cancel a NEWER session's freshly-armed timer.
          clearStableResetTimer();
        }
      }
      // RESILIENCE (bead wsm-e2e-pinned-aiu): a handle-fed session that CLOSES with 1008 "session
      // expired" means the resume handle is poisoned. The pre-existing self-heal only ran in the
      // connect-THROW catch; a 1008 is an async close (no throw), so the poison was re-fed on every
      // reconnect AND re-seeded from the durable KV on restart. Clear it HERE, before scheduleReconnect,
      // so the next bounded attempt connects FRESH — bounding any handle-induced wedge to one attempt.
      if (shouldClearHandleOnClose(closeCode, attemptUsedHandle)) {
        console.warn("[SESSION RESUMPTION] handle-fed session closed with code=1008 — clearing the poisoned handle so the next attempt connects fresh.");
        lastSessionResumptionToken = null;
        persistResumptionToken(null);
      }
      // Issue A: a 1007 "API key not valid" close is a CONFIG error, not a transient drop. Retrying
      // with the SAME unresolved key can only 1007 again, so it must NOT spend a bounded reconnect
      // attempt — that silently drains the budget (the boot-time 1007 cascade burned 3/6 attempts
      // before recovering only on a reload). Broadcast a distinct key-problem loss and STOP; recovery
      // comes from the next client connect once a valid key is set in Settings. isBlankApiKey
      // distinguishes "no key configured" from "key configured but rejected" for a precise reason.
      // (`sessionKey` is the later-declared const in this same scope, safely captured by this closure
      // because handleSessionLost only ever fires AFTER the connect — same pattern as attemptUsedHandle.)
      if (isInvalidKeyClose(closeCode)) {
        const blank = isBlankApiKey(sessionKey);
        console.warn(`[VOICE] Gemini Live closed with code=1007 (API key not valid) — ${blank ? "no Gemini API key is configured" : "the configured Gemini key was rejected"}. NOT consuming the reconnect budget; set a valid key in Settings and the voice channel will reconnect on the next connect.`);
        state.voiceLostSinceLastRestore = true; // 2S.5: a later successful connect announces recovery.
        broadcast({ type: "voice_channel_lost", reason: blank ? "no_api_key" : "invalid_api_key" });
        return;
      }
      state.voiceLostSinceLastRestore = true; // 2S.5: arm the restored announcement for the reconnect.
      broadcast({ type: "voice_channel_lost", reason });
      // PLM4 (2): try to bring the voice channel back, bounded. No-op if the operator already left.
      scheduleReconnect();
    };

      // Resolve the Gemini key: a real configured secret wins; the "CONFIGURED_IN_ENV" sentinel and a
      // missing secret both fall back to GEMINI_API_KEY (then ""). Extracted from the inline ternary
      // (Phase 7 CC refactor) so its `?.`/`&&`/`||` reads don't load connectLiveSession's own count.
      // Byte-identical resolution to the former inline expression.
      function resolveSessionKey(): string {
        const secret = manager.settings.secrets?.geminiApiKey;
        if (secret && secret !== "CONFIGURED_IN_ENV") return secret;
        return process.env.GEMINI_API_KEY || "";
      }
      const sessionKey = resolveSessionKey();

      // PLM4 (Finding A): constructed through the per-server factory seam (default = `new GoogleGenAI`).
      // This sits OUTSIDE the inner try below, so a throw here escapes connectLiveSession; on the
      // INITIAL connect the wrap around `await connectLiveSession(false)` now catches it (mirrors the
      // inner catch's initial-failure frame) and falls through so the WS listeners still register.
      const sessionAi = boundSessionAiFactory(sessionKey, ai);

      const liveModel = manager.settings.voiceAi?.model || "gemini-3.1-flash-live-preview";

      // PLM4 (Finding B2) STALE-HANDLE SELF-HEAL: capture whether THIS attempt will feed a persisted
      // resume handle. A persisted handle can be expired/invalid (a prior crash, a server-side expiry)
      // and would otherwise wedge reconnect forever — every bounded attempt would re-feed the same
      // poison and fail. If a connect that USED a handle fails (inner catch below), we null the handle
      // AND delete the persisted KV before the next attempt, so the retry connects FRESH and recovers.
      // Net: a bad handle costs at most one failed attempt, never a permanent wedge.
      const attemptUsedHandle = !!lastSessionResumptionToken?.newHandle;

      try {
      // REG1 phase-C: assemble the ActionContext for the unified registry dispatch. Every field is a
      // live closure/binding in THIS connection scope (or a module-level value), injected by reference
      // so the migrated handlers in src/actions/* stay thin and never reach into server.ts state. One
      // fresh ctx per tool call (callId-bound); everything else is shared by reference.
      function buildActionContext(callId: string, actionName?: string): ActionContext {
        const interactionIdForCall = state.currentInteractionId; // stamp the active turn onto this dispatch's audit row
        return {
          manager,
          session: state.session,               // the live Gemini session in this scope
          callId,
          // PLM3 version stamp for THIS dispatch — the deferring handlers spread it into the intent
          // params they persist via gateOrDefer, so a later boot can quarantine a drifted def.
          versionStamp: actionName ? { actionName, schemaHash: actionSchemaHash(actionName) ?? undefined } : undefined,
          trigger: state.currentSessionUserUtterance || "voice",
          surface: "voice",                     // explicit dispatch-surface token (action_log)
          userUtterance: state.currentSessionUserUtterance,
          broadcast,
          broadcastLedgerUpdate,
          gateOrDefer,
          dispatchProposal: dispatchProposal as ActionContext["dispatchProposal"],
          gateCapability,
          redact: redactSecrets,
          getActivePaneId: () => coreState.activePaneId,
          setActivePane: (id) => {
            coreState.activePaneId = id;
            // Memory Synthesis P0a (freshness trigger #1, the acute rot case): the active pane just
            // changed — re-focus the live brief on the new pane (the previous pane's detail demotes
            // to a breadcrumb). Non-blocking + self-guarded.
            injectMemoryBrief(state.session, id);
          },
          // Memory Synthesis P0a: the "catch me up" path — switch_context calls this AFTER its live
          // ledger sync to inject a fresh brief for the now-active pane (orient.ts).
          injectMemoryBrief: () => injectMemoryBrief(state.session, coreState.activePaneId),
          activeDraftTarget,
          broadcastDraft,
          broadcastTerminalsUpdated,
          effectiveCapabilityGateFor,
          pruneAttention,
          pendingApprovals,
          pendingActions,                       // c55.15: the converged approvals/pending REST defs read it
          applyResolution,
          applyPaneMode,
          store,
          sanitizeSettingsForClient,
          recipes: recipes as ActionContext["recipes"],
          // Emergency brake — the real connection-scoped closures (they broadcast their own frames).
          stopAll,
          releaseStopAll,
          isFrozen: () => coreState.frozen,
          // c55 Batch F: the running-pane set + frozen-aware per-pane posture (server truth). list_panes
          // builds its flat REST array from posturePayloadForPane; get_stop_all_status reads runningPaneIds.
          runningPaneIds,
          posturePayloadForPane,
          // PLM2 (F1): per-action audit seam -> durable action_log. runAction calls this once per
          // dispatch (best-effort, never-throw). Args are redacted to a JSON string before persistence
          // (NEVER raw). The store stamps the timestamp. A store failure must not break the tool call.
          // PLM4 (3): stamp idempotency_key = ctx.callId (the Gemini call.id, unique per dispatch) so a
          // re-delivered tool call after a reconnect can be detected by the replay guard above.
          audit: (row) => {
            if (!store) return;
            let argsRedacted: string | null = null;
            try { argsRedacted = row.args === undefined ? null : redactSecrets(JSON.stringify(row.args)); }
            catch { argsRedacted = null; }
            try {
              store.recordAction({
                name: row.name,
                capability: row.capability,
                result_kind: row.resultKind,
                ms: row.ms,
                args_redacted: argsRedacted,
                surface: row.surface ?? "voice",
                idempotency_key: callId ?? null,
                interaction_id: interactionIdForCall ?? null,
              });
            } catch { /* audit is best-effort; never break the dispatch */ }
          },
        };
      }

      // Build the Gemini Live `config` payload (responseModalities, ASR channels, voice, system prompt,
      // the resume-handle spread, and the tools array). Extracted from the inline connect call (Phase 7
      // CC refactor) so its handful of `?.`/`||`/ternary reads do not load connectLiveSession's own
      // cyclomatic count. Byte-identical to the former inline object — same fields, same env/settings
      // reads, same resume-handle key (`handle: newHandle`) and grounding-enabled toggle.
      function buildLiveConfig(): any {
        return {
          responseModalities: [Modality.AUDIO],
          // Correlated log: capture operator ASR + the model's spoken transcription ("thinking"/
          // narration) so the voice_in + gemini_thinking legs carry real content. Additive (the existing
          // modelTurn parsing is untouched); an empty object enables each channel.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          },
          // sa4: the system prompt is now operator-editable (voiceAi.systemPrompt, Settings UI). Read it
          // at connect time so an edited prompt is picked up on the next session (the existing Apply &
          // Reconnect path). Behavior-preserving: with no custom template, buildSystemInstruction()
          // renders DEFAULT_SYSTEM_PROMPT — byte-identical to the former inline literal — substituting
          // the SAME two live values this block used before.
          systemInstruction: buildSystemInstruction({
            template: manager.settings.voiceAi?.systemPrompt,
            activeProjectId: manager.ledger.activeProjectId || "None",
            workspaces: Object.keys(manager.ledger.workspaces).map((pId: string) => pId + " (" + manager.ledger.workspaces[pId].name + ")").join(", "),
          }),
          ...({
            // PLM4 (Finding B1): feed the REAL resume handle under the SDK's actual config key. The
            // @google/genai `SessionResumptionConfig` field is `handle` (node.d.ts:10236-10243), NOT
            // `token`, and the persisted update's handle is `newHandle` (LiveServerSessionResumptionUpdate,
            // node.d.ts:7968-7979) — NOT `token`. The previous `{ token: …token }` mismatched on BOTH, so
            // resume was always `{}` (a fresh session every reconnect) and PLM4's persistence bought
            // nothing. Empty object => start a brand-new session (the SDK treats an absent handle as new).
            sessionResumption: lastSessionResumptionToken?.newHandle
              ? { handle: lastSessionResumptionToken.newHandle }
              : {},
            contextWindowCompression: {
              triggerTokens: 25000,
              slidingWindow: { targetTokens: 16000 }
            }
          } as any),
          // BEAD aqx: the live tools array is now built by buildVoiceTools(). With grounding OFF (the
          // default) it is EXACTLY [{ functionDeclarations: toGeminiDeclarations(REGISTRY) }] — byte-for-
          // byte the former inline literal. With voiceAi.groundingEnabled ON it appends the built-in
          // { googleSearch: {} } grounding tool as a sibling entry (functionDeclarations stays FIRST, so
          // the function-calling path and the tools[0] golden are untouched). The flag is read HERE at
          // connect time (same next-session semantics as voiceAi.systemPrompt / voiceAi.voice), so toggling
          // it takes effect on the next session via the existing Apply & Reconnect path.
          tools: buildVoiceTools({
            groundingEnabled: !!manager.settings.voiceAi?.groundingEnabled,
            declarations: toGeminiDeclarations(REGISTRY),
          }),
        };
      }

      // Initialize Gemini Live session (through the injectable seam so tests /
      // the offline simulator can substitute a fake session). Uses the per-server snapshot
      // (boundLiveConnector) so a sibling test server's setLiveConnector cannot redirect us.
      // bead 9fz: pass the RESOLVED sessionKey so the REAL connector can pre-validate a blank key and
      // short-circuit BEFORE a keyless ai.live.connect() (1007). The mock connector ignores this arg.
      // 3V.1 (a): connect into a LOCAL — `state.session` is assigned ONLY after the generation guard
      // below passes. The pre-fix code assigned BEFORE guarding, so an overlapping connect resolving
      // LAST overwrote state.session with a handle the guard then closed: mic frames (clientWs
      // "audio" -> state.session.sendRealtimeInput) fed a DEAD session while coreState.activeLiveSession
      // still pointed at the healthy one.
      // ── onmessage sub-handlers (Phase 7 CC refactor) ──────────────────────────────────────────
      // The Gemini onmessage callback (formerly CC=57) is decomposed into these per-concern nested
      // helpers, each invoked once per message. Every helper does its OWN guard and closes over the
      // same connection-scoped state/session the inline blocks read, so ordering, side-effects, and
      // the swallowed-error semantics are byte-identical to the former single body. They live in
      // connectLiveSession scope (NOT inside the object literal) and are referenced by the onmessage
      // arrow passed to boundLiveConnector below.

      // Persist a rotated session-resumption handle (best-effort; ignored after WS-close or once the
      // session is dead, so a post-close flush can't poison the next reconnect's resume).
      const handleResumptionUpdate = (message: any): void => {
            if (!(message.sessionResumptionUpdate && !state.wsClosed && !sessionDead)) return;
            const prevHandle = lastSessionResumptionToken?.newHandle;
            lastSessionResumptionToken = message.sessionResumptionUpdate;
            if (lastSessionResumptionToken?.newHandle !== prevHandle) {
              // Don't log the handle value — it's a session-resumption token (mildly sensitive) and
              // rotates almost every turn (log spam). It's persisted to KV for debugging if needed.
              console.log("[SESSION RESUMPTION] Handle rotated.");
              // PLM4 (1): persist the fresh handle so a process restart can resume. Best-effort,
              // never-throw; guarded for store === null inside persistResumptionToken.
              persistResumptionToken(lastSessionResumptionToken);
            }
          };

          // Resolve a hands-free approval/defer utterance (parseApprovalIntent already ran -> non-none
          // intent). Precedence: a pane-WRITE approval for this session wins; else fall back to a staged
          // GLOBAL pending action. Byte-identical to the former inline `if (parsed.intent !== "none")` body.
          const routeApprovalIntent = (parsed: ReturnType<typeof parseApprovalIntent>, cleanUtter: string, session: any): void => {
            interactionLog.log({ interactionId: turnId(), kind: "approval", data: { intent: parsed.intent, targetHint: parsed.targetHint } });
            const entries = pendingApprovals.forSession(session);
            if (entries.length === 0) {
              // U1 (bead wsm-e2e-pinned-9fe): no pending pane-WRITE approval for this session, but a gated
              // NON-PTY mutator (create_pane / set_*_permissions) may be staged in the GLOBAL pendingActions
              // store (gateOrDefer Ask branch). Resolve it by voice, MIRRORING the REST handlers so the
              // claim() seam keeps exactly-once across a REST+voice race. pendingActions is GLOBAL (not
              // session-scoped) — a sharp edge in multi-session setups; here the single live session owns it.
              // Precedence is preserved by being the `else` of entries.length>0: a session with BOTH resolves
              // the APPROVAL first.
              resolvePendingActionByVoice(cleanUtter, pendingActions, {
                broadcast,
                narrate: (t) => pushApprovalNarrationDep(session, t),
                redact: redactSecrets,
              });
              return;
            }
            // bead 8xn: the held-entries routing (clarify / disambiguate / defer / approve-reject) is now
            // the pure `resolveHeldCommandByVoice` (the sibling of resolvePendingActionByVoice above), so
            // the server and tests run the SAME code. The PTY/store/broadcast effects bind here as sinks:
            // onResolve -> resolveApprovalByVoice (applyResolution's claim+redaction+broadcast choke-point),
            // onDefer -> applyDeferral (4D.3 TTL re-arm + cap). narrate/redact mirror the global path.
            // Behavior is byte-identical to the former inline block (pinned by test_approvals_wse.ts +
            // test_voice_approval_routing.ts).
            resolveHeldCommandByVoice(cleanUtter, entries, pendingApprovals.lastAnnouncedFor(session), {
              narrate: (t) => pushApprovalNarrationDep(session, t),
              redact: redactSecrets,
              onResolve: (messageId, approve) => resolveApprovalByVoice(session, messageId, approve),
              onDefer: (messageId) => applyDeferral(messageId),
            });
          };

          // Process an operator ASR transcript: latch the speak-gate, emit the User transcript frame,
          // capture dictation, and route any approval intent. Byte-identical to the former `if (userUtterance)`.
          const handleOperatorUtterance = (userUtterance: string, session: any): void => {
            state.currentSessionUserUtterance = userUtterance;
            interactionLog.log({ interactionId: onOperatorSpeech(), kind: "voice_in", text: userUtterance, data: { source: "operator" } });

            // BEAD tkd (should-I-speak gate): decide ONCE per operator turn whether Janus's spoken AUDIO
            // for the model's reply should be muted. DEFAULT OFF (silenceGate:false) => shouldSpeak
            // short-circuits to {speak:true}, a no-op (audio path byte-for-byte today's). When ON it mutes
            // ONLY at high confidence the director is thinking-aloud (fail-open). LATCHED on state for this
            // turn's audio + logged so a mute is auditable. Decision logic lives entirely in speakGate.ts.
            const gate = shouldSpeak(userUtterance.trim(), { enabled: !!manager.settings.voiceAi?.silenceGate });
            state.muteCurrentModelTurn = !gate.speak;
            if (!gate.speak) {
              interactionLog.log({
                interactionId: turnId(),
                kind: "system",
                data: { tag: "speak_gate", speak: gate.speak, reason: gate.reason, confidence: gate.confidence },
              });
            }

            clientWs.send(JSON.stringify({
              type: "transcript_text",
              sender: "User",
              text: userUtterance
            }));

            const cleanUtter = userUtterance.trim();
            if (!shouldRouteUtterance(cleanUtter)) return;
            // A4: route any utterance with non-whitespace content so bare votes ("no"/"ok", 2 chars) reach
            // the parser. Empty/whitespace drops. Step 6: capture dictation into the ACTIVE pane's WIP
            // draft (raw material the operator refines before sending). No-op if no pane is open.
            appendActiveDraft(`* **User Dictation**: ${cleanUtter}`, "operator");

            // WS-E.2 (BUG-007/008): hands-free voice approvals via the PURE intent parser + most-recently-
            // announced targeting (NOT FIFO, NOT substring matching).
            // Seam Inc 1 (task 1.6) / Inc 2 (task 2.1, the FLIP): the single production entry to approval
            // parsing. In SHADOW (default) this is the SYNCHRONOUS, byte-identical shadow tap — Python
            // observes every routed utterance fire-and-forget while TS stays authoritative. In FLIP mode
            // (JANUS_APPROVAL_PYTHON_PRIMARY) Python is PRIMARY with the TS twin as the fail-closed floor;
            // resolution is async (await Python, fall to the floor on miss/timeout), so route the result
            // from a microtask. resolveApprovalIntent NEVER rejects and NEVER fails open.
            // Rollout note (reviewed): deferring up to the budget can REORDER routing of rapid-fire votes
            // vs arrival, but the reorder lands two SYNCHRONOUS resolveDecision calls on one messageId, and
            // the atomic claim() gate (pendingApprovals.ts resolveDecision:394-397 / claim:679-692 — durable
            // SQL `UPDATE...WHERE claimed=0 => changes===1`, single-winner) is ORDER-INDEPENDENT: exactly one
            // resolve writes, the loser is lost_race/not_found. selectApprovalTarget reads the LIVE entries
            // post-await and CLARIFIES on ambiguity, so a stale second vote is at worst a not_found no-op or a
            // clarify — never a double-act or wrong-pane resolve. Benign delta, NOT a fail-open. This is the
            // same exactly-once invariant locked by tests/test_approvals_wse.ts (two resolves on one id =>
            // one write) and the resolveDecision/claim() unit locks — a flip-specific test would only
            // re-exercise the identical synchronous gate (triage: flip-vote-order, accept-as-designed).
            if (isApprovalPythonPrimary()) {
              void resolveApprovalIntent(cleanUtter)
                .then((parsed) => { if (parsed.intent !== "none") routeApprovalIntent(parsed, cleanUtter, session); })
                .catch(() => { /* resolveApprovalIntent is fail-closed; never let a stray throw escape the loop */ });
              return;
            }
            const parsed = parseApprovalIntentShadowed(cleanUtter);
            if (parsed.intent === "none") return;
            routeApprovalIntent(parsed, cleanUtter, session);
          };

          // Process a model spoken-text transcript: emit the Janus transcript frame + capture the thought.
          const handleModelUtterance = (modelUtterance: string): void => {
            state.currentSessionModelUtterance = modelUtterance;
            interactionLog.log({ interactionId: turnId(), kind: "gemini_text", text: modelUtterance });
            setModelTurn(); // B1: model retook the turn -> clear any stale barge-in latch.
            clientWs.send(JSON.stringify({
              type: "transcript_text",
              sender: "Janus",
              text: modelUtterance
            }));
            // Step 6: capture Janus's spoken thought into the ACTIVE pane's WIP draft.
            const cleanUtter = modelUtterance.trim();
            if (cleanUtter.length > 2) {
              appendActiveDraft(`* **Agentic Thought**: *${cleanUtter}*`, "janus");
            }
          };

          // Surface Google-Search grounding (queries + sources) when this turn used it. Strict no-op when
          // grounding is OFF (the model never populates groundingMetadata -> extractGrounding returns empty).
          const handleGrounding = (message: any): void => {
            const grounding = extractGrounding(message);
            if (!hasGrounding(grounding)) return;
            interactionLog.log({
              interactionId: turnId(),
              kind: "system",
              data: { tag: "grounding", queries: grounding.queries, sources: grounding.sources },
            });
            clientWs.send(JSON.stringify({
              type: "grounding",
              queries: grounding.queries,
              sources: grounding.sources,
            }));
          };

          // Pass model audio back to the client — the SINGLE spoken-output choke point (responseModalities
          // is [AUDIO]-only). BEAD tkd: suppress the AUDIO when the speak-gate latched a mute for this turn
          // (the transcript_text frame stays unconditional). With the flag off, muteCurrentModelTurn is
          // always false, so this is byte-for-byte today's path.
          const relayModelAudio = (message: any): void => {
            const parts = message.serverContent?.modelTurn?.parts;
            if (!parts || state.muteCurrentModelTurn) return;
            for (const part of parts) {
              const audio = part?.inlineData?.data;
              if (audio) {
                clientWs.send(JSON.stringify({ type: "audio", audio }));
              }
            }
          };

          // Relay a barge-in to the client + latch it, and clear the speak-gate mute latch at the turn
          // boundary so it can NEVER bleed past one turn. Byte-identical to the former inline barge-in /
          // turn-complete handling.
          const relayInterruptAndTurnState = (message: any): void => {
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ type: "interrupted", interrupted: true }));
              // B1 (turn-aware ack): a barge-in means the operator seized the turn. Latch it (so an async-
              // spawn ack SUPPRESSES rather than speaks over them) and stamp recency. Cleared when the model
              // next takes the turn (setModelTurn) or on the next operator transcript.
              state.lastInterrupted = true;
              state.lastOperatorSpeechAt = Date.now();
            }
            // BEAD tkd: clear the speak-gate mute latch at the model turn boundary. (Also cleared at the
            // START of the next operator turn in onOperatorSpeech.)
            if (message.serverContent?.turnComplete || (message.serverContent as any)?.generationComplete) {
              state.muteCurrentModelTurn = false;
            }
          };

          // Run ONE tool call through the registry (idempotency replay-guard, dispatch, the create_pane
          // opening ack), guarded so a handler throw can't escape onmessage. Byte-identical to the inline
          // per-call body of the toolCall loop.

          // L2: content-level idempotency guard for propose_command — collapses duplicate
          // same-instruction dispatches that arrive with different callIds within a turn.
          const recentProposals = new Map<string, number>();
          const PROPOSAL_DEDUP_WINDOW_MS = 5000;

          const isProposalDuplicate = (name: string, args: Record<string, any>): boolean => {
            if (name !== "propose_command" || !args) return false;
            const dedupKey = `${args.pane_id}:${(args.instruction ?? args.command ?? "").trim().toLowerCase()}`;
            const lastAt = recentProposals.get(dedupKey);
            const now = Date.now();
            if (lastAt && now - lastAt < PROPOSAL_DEDUP_WINDOW_MS) return true;
            recentProposals.set(dedupKey, now);
            for (const [k, t] of recentProposals) {
              if (now - t > PROPOSAL_DEDUP_WINDOW_MS * 2) recentProposals.delete(k);
            }
            return false;
          };

          // PLM4 (3): PER-DISPATCH IDEMPOTENCY / replay guard. A tool call RE-DELIVERED after a reconnect
          // (Gemini may replay the same functionCall id on a resumed session) must NOT double-apply a
          // SIDE-EFFECTING action. TRUE => this idempotency_key already has a SUCCEEDED action_log row, so
          // answer "already done" and DO NOT re-run. Reads (readOnly) are exempt. The store lookup is
          // best-effort: any fault returns false (falls through to normal dispatch — never blocks it).
          // Extracted from runToolCall (Phase 7 CC refactor) — byte-identical predicate.
          const isReplayShortCircuit = (call: any, name: string): boolean => {
            const replayDef = REGISTRY.find((d: any) => d.name === name);
            if (!(store && call.id && replayDef && !replayDef.readOnly)) return false;
            try {
              return store.hasSucceededIdempotencyKey(call.id);
            } catch {
              return false; // store fault -> proceed; the guard must never block dispatch.
            }
          };

          // B1 (phase-1 ack): an AUTO-created pane boots asynchronously, so confirm "opening" immediately —
          // BUT only when it will not speak over the operator (turn-aware gate). Called on the NON-replay
          // path so a reconnect-replayed create_pane never double-narrates. The startsWith("Pane ") check
          // matches ONLY the Auto-created success string — NOT the gated-Ask "needs operator confirmation" /
          // forbidden "Error" strings — so a deferred create gets no false ack (its phase-2 fires later).
          // Extracted from runToolCall (Phase 7 CC refactor) — byte-identical condition + ack text.
          const maybeSpeakCreatePaneAck = (name: string, result: any, session: any): void => {
            if (
              name === "create_pane" &&
              result?.kind === "ok" &&
              typeof result.output === "string" &&
              result.output.startsWith("Pane ") &&
              shouldSpeakOpeningAck(ackState()) === "speak"
            ) {
              pushAck(session, "Opening the pane now.");
            }
          };

          const runToolCall = async (call: any, ixnId: string, session: any): Promise<void> => {
            const name = call.name;
            const args = call.args as Record<string, any>;
            try {
              // REG1 phase-C: unified registry dispatch. runAction is itself try/caught + never throws; the
              // outer catch here is belt-and-suspenders. A re-delivered side-effecting call short-circuits.
              if (isReplayShortCircuit(call, name)) {
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Already handled (${name} was applied on a prior delivery of this request).` } }],
                });
              } else if (isProposalDuplicate(name, args)) {
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Duplicate proposal suppressed (same instruction was just dispatched to this pane).` } }],
                });
              } else {
                const actionCtx: ActionContext = buildActionContext(call.id!, name);
                const result = await runAction(REGISTRY, name!, (args ?? {}) as Record<string, unknown>, actionCtx);
                interactionLog.log({ interactionId: ixnId, kind: "action_result", data: { name, callId: call.id, resultKind: (result as { kind?: string })?.kind } });
                resultToToolResponse(result, session, name!, call.id!);
                maybeSpeakCreatePaneAck(name!, result, session);
              }
            } catch (toolErr) {
              console.error(`[TOOL] Handler for "${name}" threw:`, toolErr);
              try {
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Internal error while handling ${name}: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}` } }]
                });
              } catch { /* session already torn down; nothing more we can do */ }
            }
          };

          // Dispatch every functionCall in a toolCall message through runToolCall (mints/stamps the turn id
          // and clears the barge-in latch per call, as the inline loop did).
          const handleToolCalls = async (message: LiveServerMessage, session: Session): Promise<void> => {
            if (!message.toolCall) return;
            for (const call of message.toolCall.functionCalls || []) {
              const ixnId = turnId();
              setModelTurn(); // B1: entering the toolCall loop is a model turn -> clear barge-in latch.
              interactionLog.log({ interactionId: ixnId, kind: "tool_call", data: { name: call.name, callId: call.id, args: call.args ?? {} } });
              // Guard every tool handler: an uncaught throw here would escape the Gemini SDK onmessage
              // callback, leave this call.id unanswered, and stall the conversation.
              await runToolCall(call, ixnId, session);
            }
          };

      const justConnected = await boundLiveConnector(sessionAi, {
        model: liveModel,
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            const session = state.session;
            // Thin dispatcher (Phase 7 CC refactor): each concern is handled by a nested helper above,
            // invoked in the SAME order the inline body ran them. The helpers own their own guards, so
            // this body is a flat sequence with no branching — behaviour is byte-identical to the former
            // single onmessage block (resumption persist, transcripts, grounding, audio/turn-state, tools).
            handleResumptionUpdate(message);

            // Extract operator + model transcripts. The operator's words arrive on
            // serverContent.inputTranscription (the REAL ASR channel, enabled in the config below); the
            // legacy serverContent.turn/userTurn casts are a fallback. Feeding inputTranscription into
            // userUtterance is THE fix for "spoken approve/commands never reached the parser" — the
            // approval router + dictation + transcript frame all read userUtterance. (The 2026-06 live
            // capture showed every operator utterance on inputTranscription while userUtterance was empty.)
            const { operator: userUtterance, model: modelUtterance, modelThinking } = extractTranscripts(message);

            if (modelThinking) {
              interactionLog.log({ interactionId: turnId(), kind: "gemini_thinking", text: modelThinking, data: { source: "outputTranscription" } });
              setModelTurn(); // B1: model retook the turn -> clear any stale barge-in latch.
              // B2: In audio-only mode, modelTurn.parts carries audio (not text), so modelUtterance
              // is empty. Surface the outputTranscription as the visible transcript text.
              if (!modelUtterance) handleModelUtterance(modelThinking);
            }

            if (userUtterance) handleOperatorUtterance(userUtterance, session);
            if (modelUtterance) handleModelUtterance(modelUtterance);
            handleGrounding(message);
            relayModelAudio(message);
            relayInterruptAndTurnState(message);
            // `session` is the live handle that delivered this message, so it is non-null here; the
            // guard narrows `Session | null` -> `Session` for the typed dispatch seam (bead ec8).
            if (session) await handleToolCalls(message, session);
          },
        // QW3 (bead qw3): the Gemini Live socket can die WITHOUT the client WS closing — a network
        // reset, a server-side close, an SDK error. With only `onmessage`, nothing fired:
        // coreState.activeLiveSession kept a dead handle and the frontend was never told. These siblings mirror
        // the WS-close teardown (see clientWs.on("close")): DETACH (keep survivors for re-announce),
        // null coreState.activeLiveSession behind the identity guard so a stale callback can't clobber a newer
        // session, and broadcast a NEW voice_channel_lost frame. NO reconnect logic (that is PLM4).
        onerror: (err: ErrorEvent) => {
          // Log only the message, NOT the raw error/socket — the live WebSocket's URL carries the API
          // key (?key=…), so dumping the object leaks the key into logs (security hazard).
          console.error("[VOICE] Gemini Live session error — voice channel lost:", err instanceof Error ? err.message : String(err?.message ?? "error"));
          handleSessionLost("error");
        },
        onclose: (info: CloseEvent) => {
          // Log only code/reason, NOT the raw CloseEvent — its kTarget is the live WebSocket whose URL
          // contains the API key (?key=…). Dumping the object leaks the key into logs (security hazard).
          console.warn(`[VOICE] Gemini Live session closed — voice channel lost (code=${info?.code ?? "n/a"}, reason=${info?.reason || "n/a"}).`);
          handleSessionLost("closed", typeof info?.code === "number" ? info.code : undefined);
        },
      },
      config: buildLiveConfig(),
    }, sessionKey); // bead 9fz: 3rd arg = resolved key; the REAL connector short-circuits if blank.

      // PLM4 (2) + 3V.1 (a): IDENTITY GUARD on the just-resolved connect. The async connect could have
      // raced the operator leaving (wsClosed) or a newer connect attempt superseding this one. If so,
      // this freshly-minted session is stale — close it and bail WITHOUT touching ANY connection state
      // (state.session in particular still points at whatever the CURRENT generation hoisted).
      if (state.wsClosed || myGeneration !== state.connectGeneration) {
        // Operator left during the await, OR a newer connect attempt has superseded this one. Either
        // way this session is stale: close it and bail WITHOUT clobbering the live channel.
        try { justConnected?.close?.(); } catch { /* best-effort */ }
        return;
      }
      // The guard passed: THIS attempt owns the current generation — only now may it publish its
      // session into the connection-scoped state the mic path / tool dispatch / WS-close read.
      //
      // hoistAndSubscribe (Phase 7 CC refactor): the entire post-guard "publish + announce + arm the
      // stable-reset timer + (re)subscribe pane signals" block, hoisted verbatim into a nested helper so
      // its branches stop loading connectLiveSession's own cyclomatic count. Ordering and side-effects
      // are byte-identical to the inline block — it still runs exactly once per (re)connect, AFTER the
      // generation guard passed and `justConnected` was confirmed current.
      const hoistAndSubscribe = (): void => {
        state.session = justConnected;

        // WS-F (spec §6.2): the live session is now established. Hoist it for the action last-call,
        // then re-attach every staged survivor that outlived the prior disconnect (or a process
        // restart) to THIS session and speak ONE batched resumption digest — "welcome back, here's
        // your queue" — re-requiring explicit approval. Runs exactly once per (re)connect, AFTER the
        // connect promise resolves so `session` is live.
        coreState.activeLiveSession = justConnected;
        // 2S.5: announce recovery — ONLY when this connect follows a broadcast loss on this same
        // client connection (the flag is armed exactly where voice_channel_lost is broadcast, so a
        // FIRST connect never says "restored"). Frame name is the kitchen-client contract:
        // exactly `voice_channel_restored`.
        if (state.voiceLostSinceLastRestore) {
          state.voiceLostSinceLastRestore = false;
          broadcast({ type: "voice_channel_restored" });
        }
        clearReconnectTimer();
        // PLM4 (Finding: flap-unbounded backoff): do NOT refresh the bounded-retry budget eagerly on
        // hoist — a flapping session (connect -> immediate drop -> reconnect -> …) would then reset
        // `reconnectAttempts` every cycle and reconnect forever at the base delay. Instead arm a one-shot
        // timer that refreshes the budget ONLY after the session has stayed continuously live for
        // RECONNECT_STABLE_UPTIME_MS. A drop before then (handleSessionLost) clears this timer, so the
        // budget keeps depleting and a flapping session exhausts the cap and gives up (permanent loss).
        clearStableResetTimer();
        state.stableResetTimer = setTimeout(() => {
          state.stableResetTimer = null;
          if (state.wsClosed) return; // operator already left.
          // Only the CURRENTLY-live session earns the refresh; a stale callback can't credit a newer one.
          if (coreState.activeLiveSession === justConnected) {
            state.reconnectAttempts = 0;
            console.log(`[VOICE] session stable for ${RECONNECT_STABLE_UPTIME_MS}ms — reconnect budget refreshed.`);
          }
        }, RECONNECT_STABLE_UPTIME_MS);
        if (typeof state.stableResetTimer.unref === "function") state.stableResetTimer.unref();
        // PLM4 (4): reannounceSurvivors runs on the reconnect path too (this closure IS the reconnect
        // path), so the surviving approvals are re-attached + re-announced for free on every (re)connect.
        reannounceSurvivors(justConnected);

        // Memory Synthesis P0a (freshness trigger #2): never hand a fresh/resumed live client a stale
        // brief — synthesize + inject the current situational context once, right after the hoist.
        // Non-blocking + self-guarded (injectMemoryBrief owns its try/catch).
        injectMemoryBrief(justConnected, coreState.activePaneId);

        // Push-observation: bridge global pane signals into THIS live session. The bus owns
        // debounce; we forward each signal as a user-role nudge (same convention as approval
        // narration the model already speaks). Unsubscribed on socket close.
        if (state.unsubscribePaneSignals) { state.unsubscribePaneSignals(); state.unsubscribePaneSignals = null; }
        // B1 (phase-2 defer): reset the queue for this fresh session — its `sig` payloads + timer belong
        // to the prior session's closure; a survivor "ready" is re-published by the bus, not replayed.
        state.deferredReady = [];
        if (state.readyDrainTimer) { clearTimeout(state.readyDrainTimer); state.readyDrainTimer = null; }

        // B1 (phase-2 defer): stale ceiling — a "ready" older than this is dropped on drain (the UI
        // already shows the pane, so a 10s-late "it's up" is pure noise).
        const READY_DEFER_MAX_MS = 10_000;

        // Raw send of a single signal to THIS session (unchanged behavior for non-`created` kinds).
        const pushSignal = (sig: PaneSignal) => {
          try {
            justConnected.sendClientContent({
              turns: [{ role: "user", parts: [{ text: formatPaneSignal(sig) }] }],
              turnComplete: false, // L1 fix: inject as passive context, not a forced spoken turn
            });
          } catch (e) {
            console.error("Failed to push pane signal to session:", e);
          }
        };

        // B1 (phase-2 defer): re-evaluate the queued "ready" signals at the next safe gap. Single unref'd
        // timer (re-armed if still mid-utterance); each queued sig is dropped once stale or suppressed on
        // a barge-in, spoken when the turn is clear.
        const armReadyDrain = () => {
          if (state.readyDrainTimer) return; // one timer in flight; it re-arms itself if needed.
          state.readyDrainTimer = setTimeout(() => {
            state.readyDrainTimer = null;
            const now = Date.now();
            const still: DeferredPaneSignal[] = [];
            for (const sig of state.deferredReady) {
              const age = now - (sig.__deferredAt ?? now);
              if (age > READY_DEFER_MAX_MS) continue; // stale -> drop (UI already reflects the pane).
              const d = shouldSpeakReadyAck(ackState());
              if (d === "speak") { pushSignal(sig); }
              else if (d === "suppress") { /* barge-in -> drop */ }
              else { still.push(sig); } // defer again
            }
            state.deferredReady = still;
            if (state.deferredReady.length > 0) armReadyDrain();
          }, OPERATOR_HOLD_MS);
          if (state.readyDrainTimer.unref) state.readyDrainTimer.unref();
        };

        state.unsubscribePaneSignals = paneSignalBus.subscribe((sig: PaneSignal) => {
          // B1 (phase-2 gate): the async-spawn "ready" ("created") AND the operator-initiated exit+
          // archive completion ("closed", wsm-e2e-pinned-5h0) are turn-gated — both are follow-ups that
          // must never talk over the operator. All other kinds (idle/error/prompt/exited) keep today's
          // immediate-push behavior verbatim.
          if (sig.kind === "created" || sig.kind === "closed") {
            const d = shouldSpeakReadyAck(ackState());
            if (d === "suppress") return;                       // barge-in -> drop the "ready".
            if (d === "defer") {                                // mid-utterance -> queue + re-arm.
              // bead ykr: clone before stamping — the bus shares ONE signal object across all observers,
              // so we must NOT mutate the shared payload. The queue owns its tagged copy.
              state.deferredReady.push(stampDeferred(sig, Date.now()));
              armReadyDrain();
              return;
            }
          }
          pushSignal(sig);
        });
      };
      hoistAndSubscribe();
    } catch (err: any) {
      handleConnectFailure(err);
    }

    // The connect threw (a real fault, not an async close). Extracted from the inline catch (Phase 7 CC
    // refactor): same poisoned-handle self-heal, then the reconnect-vs-initial branch — byte-identical
    // to the former catch body. Defined as a nested function so its branches do not load
    // connectLiveSession's own cyclomatic count.
    function handleConnectFailure(err: any): void {
      console.error(`Failed to establish Gemini Live session${isReconnect ? " (reconnect attempt)" : ""}:`, err);
      // PLM4 (Finding B2) STALE-HANDLE SELF-HEAL: this attempt fed a persisted resume handle and still
      // failed — treat the handle as poisoned. Null the in-memory token AND delete the persisted KV so
      // the NEXT bounded attempt (scheduled below, or the next initial connect) starts a FRESH session
      // instead of re-feeding the same bad handle. Best-effort + never-throw (persistResumptionToken
      // swallows store faults). A bad handle thus costs at most ONE failed attempt, never a wedge.
      if (attemptUsedHandle) {
        console.warn("[SESSION RESUMPTION] connect with a persisted handle failed — clearing the poisoned handle so the next attempt connects fresh.");
        lastSessionResumptionToken = null;
        persistResumptionToken(null);
      }
      if (isReconnect) {
        // PLM4 (2) NEVER-THROW: a failed reconnect attempt schedules the next bounded attempt (or
        // gives up with a final voice_channel_lost), and must NOT escape this async callback.
        scheduleReconnect();
      } else {
        clientWs.send(JSON.stringify({
          type: "error",
          message: "Gemini Live Voice Connection Failed. Please verify your Gemini API Key in Settings."
        }));
      }
    }
    }

    // PLM4 (2): schedule ONE bounded, identity-guarded reconnect attempt. Caps BOTH the attempt count
    // and the delay (exponential, ceilinged) — NO unbounded loop / no storm. Aborts (no-op) if the
    // operator's WS already closed. On exhaustion, broadcasts a final "could not reconnect" frame.
    // NEVER throws: the inner connectLiveSession is try/caught; a scheduling fault is swallowed.
    function scheduleReconnect(): void {
      if (state.wsClosed) return;                 // operator left — no reconnect.
      if (state.reconnectTimer) return;           // one in flight already.
      if (state.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        console.warn(`[VOICE] reconnect giving up after ${state.reconnectAttempts} attempts.`);
        state.voiceLostSinceLastRestore = true; // 2S.5: a later connect (new client action) still announces recovery.
        broadcast({ type: "voice_channel_lost", reason: "reconnect_failed", permanent: true });
        return;
      }
      const attempt = state.reconnectAttempts++;
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        if (state.wsClosed) return;               // re-check at fire time: operator may have left during the wait.
        // connectLiveSession is itself try/caught (initial + reconnect arms); it never throws. We add a
        // .catch belt as defense-in-depth so a rejected promise can never escape this timer callback.
        Promise.resolve(connectLiveSession(true)).catch((e) => {
          console.error("[VOICE] reconnect attempt threw (unexpected):", e);
          scheduleReconnect();
        });
      }, delay);
      if (typeof state.reconnectTimer.unref === "function") state.reconnectTimer.unref();
      console.log(`[VOICE] scheduled reconnect attempt ${attempt + 1}/${RECONNECT_MAX_ATTEMPTS} in ${delay}ms.`);
    }

    // PLM4 (2): the INITIAL connect. Same closure the reconnect path re-enters.
    // PLM4 (Finding A) NEVER-THROW: connectLiveSession's PRE-TRY setup (sessionKey / the GoogleGenAI
    // client construction via boundSessionAiFactory) sits OUTSIDE its own inner try, so a throw there
    // (e.g. a malformed-but-present key) would escape connectLiveSession. On the INITIAL connect that
    // would become an unhandled rejection in this `async` connection handler — the error frame would
    // never reach the client and the message/close listeners below would never register. Wrap it,
    // mirror the inner catch's initial-failure behavior, and FALL THROUGH so the listeners still bind.
    // The inner catch (initial path) already sends the frame and RETURNS (no rethrow), so this outer
    // catch only fires on a pre-try throw — there is no double error-frame.
    //
    // Extracted into doInitialConnect (Phase 7 CC refactor): the two nested try/catch frames (the
    // outer pre-try guard + the inner client-gone send guard) lived directly in the connection handler.
    // Hoisting them into this awaited nested helper keeps the SAME ordering and the SAME swallow-on-
    // failure semantics while moving their decision points out of the connection handler's own count.
    const doInitialConnect = async (): Promise<void> => {
      try {
        await connectLiveSession(false);
      } catch (err: any) {
        console.error("Failed to establish Gemini Live session (initial setup):", err);
        try {
          clientWs.send(JSON.stringify({
            type: "error",
            message: "Gemini Live Voice Connection Failed. Please verify your Gemini API Key in Settings.",
          }));
        } catch { /* client gone */ }
      }
    };
    await doInitialConnect();

    // bead 9fz (part 2): register THIS connection's reconnect-nudge so a settings PUT that sets a real
    // Gemini key can resume voice WITHOUT a page reload. Recovery only — if a session is already live
    // there is nothing to do. Otherwise reset the bounded-retry budget (a fresh key is a fresh chance,
    // not a continuation of the failed attempts) and schedule one immediate connect. No-op if the
    // operator already left (scheduleReconnect re-checks wsClosed).
    registerReconnectNudge?.(() => {
      if (state.wsClosed) return;
      if (coreState.activeLiveSession) return; // already connected — no nudge needed.
      state.reconnectAttempts = 0;
      // (53q owner token = this connection's `state`, supplied below as the 2nd arg.)
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
      scheduleReconnect();
    }, state); // bead 53q: this connection's state object is the owner token (guards the clear path).

    // Step 6: feed an operator mic frame to the live session (best-effort; a dead/torn-down session
    // simply drops it). Extracted from the clientWs message dispatch (Phase 7 CC refactor) — behaviour-
    // preserving: same guard (state.session present) + same PCM mimeType + same swallowed send error.
    const handleVoiceAudioFrame = (msg: any): void => {
      if (state.session) {
        try {
          state.session.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
          });
        } catch (e) {
          console.error("Error feeding user mic:", e);
        }
      }
    };

    // Step 5: the UI just told us which pane is open. Record it (null = nothing open) and re-focus the
    // live memory brief on the new pane. Extracted from the dispatch (Phase 7); byte-identical effects.
    const handleSetActivePaneFrame = (msg: any): void => {
      coreState.activePaneId = typeof msg.paneId === "string" ? msg.paneId : null;
      // Memory Synthesis P0a (freshness trigger #1, the acute rot case): the operator switched the open
      // pane — re-focus the live brief on it (the prior pane demotes to a breadcrumb). Non-blocking.
      injectMemoryBrief(state.session, coreState.activePaneId);
    };

    // TWO-STAGE EMERGENCY BRAKE from the UI (bead 8sq). Always allowed — never gated. Stage 1
    // (kill=false): freeze + cancel in-flight; panes keep running. Stage 2 (kill=true): hold-to-fire
    // kill of running PTYs, only when already frozen. stopAll broadcasts {type:'frozen'}/{type:'stop_all'}
    // to ALL clients; this is the per-client ack so the requesting UI can confirm completion. Extracted
    // from the dispatch (Phase 7 CC refactor) — control flow + acks are byte-identical to the inline form.
    const handleStopAllFrame = async (msg: any): Promise<void> => {
      if (msg.kill === true) {
        if (!coreState.frozen) {
          clientWs.send(JSON.stringify({ type: "stop_all_done", error: "not_frozen" }));
        } else {
          const killed = await stopAll(true);
          clientWs.send(JSON.stringify({ type: "stop_all_done", stage: 2, killed, failed: coreState.lastStopAllFailed }));
        }
      } else {
        const running = await stopAll(false);
        clientWs.send(JSON.stringify({ type: "stop_all_done", stage: 1, frozen: true, running }));
      }
    };

    clientWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "audio" && msg.audio) {
          handleVoiceAudioFrame(msg);
        } else if (msg.type === "draft_edit" && msg.text !== undefined) {
          // Step 6: operator editing a pane's WIP draft (ungated). Defaults to the active pane.
          applyDraftEditFrame(msg, manager, coreState, broadcastDraft);
        } else if (msg.type === "pane_input") {
          // Operator typing directly into a focused pane — ungated (above the gate) but scoped to the
          // active pane inside the helper (isPaneActiveForWrite), like the raw-input control-key route.
          // The helper validates data/pane internally (no dispatch-site precondition — keeps this
          // already-maxed handler at CC<=10).
          applyPaneInputFrame(msg, manager, coreState);
        } else if (msg.type === "set_active_pane") {
          handleSetActivePaneFrame(msg);
        } else if (msg.type === "stop_all") {
          await handleStopAllFrame(msg);
        } else if (msg.type === "release_stop_all") {
          // Clear the freeze from the UI (bead 8sq). Always allowed.
          releaseStopAll();
          clientWs.send(JSON.stringify({ type: "stop_all_done", stage: 0, frozen: false }));
        }
      } catch (err) {
        console.warn("Received malformed or non-JSON WebSocket frame, skipping:", err);
      }
    });

    clientWs.on("close", () => {
      state.wsClosed = true; // gate out the SDK's post-close resumption-token flush + the reconnect loop
      // bead 9fz: the operator left — unregister this connection's reconnect-nudge so a later settings
      // PUT can't poke a dead connection's scheduler. (A fresh connection re-registers its own.)
      // bead 53q: pass THIS connection's `state` as the owner token. The module guards the clear so a
      // stale connection (already overwritten by a newer one) is a no-op here — it cannot clear the
      // SURVIVING connection's active nudge.
      registerReconnectNudge?.(null, state);
      // PLM4 (2): the operator left — cancel any pending reconnect attempt (no reconnect storm after
      // the WS closes). scheduleReconnect also re-checks wsClosed, so this is belt-and-suspenders.
      clearReconnectTimer();
      clearStableResetTimer(); // PLM4 (Finding: flap): no budget-refresh timer should outlive the WS.
      if (state.unsubscribePaneSignals) { state.unsubscribePaneSignals(); state.unsubscribePaneSignals = null; }
      // B1 (phase-2 defer): no queued-ack drain timer should outlive the operator's WS.
      if (state.readyDrainTimer) { clearTimeout(state.readyDrainTimer); state.readyDrainTimer = null; }
      state.deferredReady = [];
      coreState.clients.delete(clientWs);
      if (coreState.activeFrontendWs === clientWs) {
        coreState.activeFrontendWs = null;
        coreState.activePaneId = null; // Step 5: no UI connected -> no source of truth -> no write permitted.
      }
      if (state.session) {
        // WS-F (spec §6.1): disconnect = DETACH, not purge. Drop the dead live-session handle but
        // KEEP each staged approval (record + order + durable row) so the survivors re-announce on
        // reconnect (reannounceSurvivors). The clock is paused while detached (the sweep skips items
        // with no session), so nothing the operator stepped away from is silently dropped.
        // pendingActions needs nothing here — it is not session-bound and survives in-process.
        const detached = pendingApprovals.detachSession(state.session);
        // 4D.1: the operator left — open the away window (no-op if handleSessionLost already did).
        noteSessionDetached();
        if (detached.length) console.log(`[DETACH] kept ${detached.length} survivor(s) for re-announce on reconnect.`);
        // Drop the hoisted live-session ref if it points at this (now dead) session, so the action
        // last-call doesn't narrate into a torn-down channel. The action clock also pauses now
        // (coreState.activeFrontendWs went null above), matching the approval clock-pause-while-away.
        if (coreState.activeLiveSession === state.session) coreState.activeLiveSession = null;
        try {
          state.session.close();
        } catch (e) {
          console.error("Error closing Gemini session on socket close:", e);
        }
      }
      console.log("Client WS closed");
    });
  });
}
