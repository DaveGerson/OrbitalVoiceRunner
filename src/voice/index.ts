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

import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import type { WebSocketServer } from "ws";
import { redactSecrets, type OrchestratorManager } from "../terminal";
import { formatPaneSignal, type PaneSignal } from "../paneSignals";
import { parseApprovalIntent, selectApprovalTarget } from "../approvalIntent";
import { shouldSpeak } from "./speakGate";
import { buildVoiceTools } from "./liveConfig";
import { shouldRouteUtterance, resolvePendingActionByVoice } from "../voiceApprovalRouting";
import { isPaneActiveForWrite, inactivePaneClarify } from "../activePane";
import { decideProposal, inferKind, type ApprovalKind, type PendingApproval } from "../pendingApprovals";
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
import { shouldSpeakOpeningAck, shouldSpeakReadyAck, OPERATOR_HOLD_MS } from "../voiceAckGate";
import { actionSchemaHash } from "../actions/registry";
import type { ActionContext } from "../actions/types";
import type { CapabilityGate } from "../types";
import type { JanusStore } from "../store/sqliteStore";
import type { CoreState } from "../core/coreState";
import type { Gating } from "../gating";
import type { CreatedMemory } from "../memory";
import { briefIsForActivePane } from "../memory";

/**
 * narrate a SYSTEM EVENT into the live session so the model speaks it to the operator. Pure (no
 * closure state) — exported so gating injects the SAME identity server.ts feeds into attachVoiceSession,
 * keeping gating free of any voice import. The definition moved here from server.ts (dec-5).
 */
export function pushApprovalNarration(session: any, text: string): void {
  try {
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: `SYSTEM EVENT (say this to the operator, then stop): ${text}` }] }],
      turnComplete: true,
    });
  } catch (e) {
    console.error("Failed to push approval narration to session:", e);
  }
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

/** The single-sourced result shape returned by `dispatchProposal` (was a server-local `type`). */
type DispatchOutcome =
  | { kind: "executed"; text: string }
  | { kind: "blocked"; text: string }
  | { kind: "error"; text: string }
  | { kind: "clarify"; text: string }
  | { kind: "pending"; text: string };

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
  boundLiveConnector: (ai: GoogleGenAI, params: any) => Promise<any>;
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
}

/**
 * The explicit per-connection state — the ~20 mutable `let`s that were connection-scoped closures
 * inside the inline wss.on("connection") callback. Instantiated ONCE per connection (NOT shared), so
 * a second client gets a fresh, independent session lifecycle (no latent cross-client bleed).
 */
interface VoiceSessionState {
  session: any;
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
  deferredReady: PaneSignal[];
  readyDrainTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stableResetTimer: ReturnType<typeof setTimeout> | null;
  connectGeneration: number;
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

  wss.on("connection", async (clientWs, req) => {
    const tokenFromCookie = getCookie(req.headers.cookie, "auth_token");
    if (tokenFromCookie !== API_AUTH_TOKEN) {
      console.warn("[SECURITY] Blocked unauthorized WebSocket connection attempt.");
      clientWs.send(JSON.stringify({ type: "error", message: "Unauthorized WebSocket access. Please reload the interface." }));
      clientWs.close(4001, "Unauthorized");
      return;
    }

    coreState.activeFrontendWs = clientWs;
    coreState.clients.add(clientWs);
    console.log("Client connected to WebSocket");

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
    }): DispatchOutcome {
      const { sess, callId, targetId, instruction } = opts;
      const pendingId = opts.pendingId ?? callId;
      const capability: CapabilityGate = opts.capability ?? "write_to_pane";
      const term = manager.terminals[targetId];
      const wsProj = manager.ledger.getActiveProject();
      const paneExists = !!term || !!(wsProj && wsProj.panes[targetId]);

      // Step 5 (single active pane): Janus may only propose to the pane the operator has open, so
      // the operator can SEE and improve the command before it lands (HiTL). A proposal for any
      // other pane is refused here — never written, in ANY policy mode — and Janus is told to ask
      // for a switch. This sits ABOVE the effective-mode gate on purpose. (architecture step 5.)
      if (!isPaneActiveForWrite(coreState.activePaneId, targetId)) {
        return { kind: "clarify", text: inactivePaneClarify(coreState.activePaneId, targetId) };
      }
      const runtimeType = term?.runtimeType;
      const kind = inferKind(opts.explicitKind, runtimeType);

      // M3: single-source effective-mode resolver (global-first, then pane, then HiTL default).
      const effectiveMode = effectiveModeFor(targetId);
      // §3 AND-veto: resolve the per-capability gate and AND-compose it with effectiveMode.
      const gate = effectiveCapabilityGateFor(targetId, capability);

      const decision = decideProposal({ kind, instruction, effectiveMode, runtimeType, paneExists, allowlist: shellAllowlist, capability, gate });
      const safeInstr = redactSecrets(instruction);

      switch (decision.type) {
        case "error_no_pane":
          return { kind: "error", text: `Error: pane ${targetId} not found.` };
        case "error_kind_mismatch":
          return { kind: "error", text: decision.reason };
        case "clarify_shell":
          // Non-blocking re-route (never a dead-end, never execution).
          return { kind: "clarify", text: decision.reason };
        case "capability_forbidden":
          broadcast({ type: "command_blocked", terminalId: targetId, cmd: safeInstr, reason: `Capability '${capability}' is set to Off.` });
          return { kind: "blocked", text: `Error: the '${capability}' capability is gated Off for pane ${targetId}; this action is forbidden by policy.` };
        case "blocked_read_only":
          broadcast({ type: "command_blocked", terminalId: targetId, cmd: safeInstr, reason: "Read-Only policy enforced." });
          return { kind: "blocked", text: `Error: Write execution block is active. Pane ${targetId} is Read-Only.` };
        case "auto_execute":
          // Inert boot (feat/local-testing) means a pane can exist in the ledger without a live
          // process until it is restarted. `paneExists` is true for such a pane, so guard the
          // immediate Full-Auto write: if there is no live terminal, refuse instead of crashing on
          // `term!.writeInput`. (The pending-approval path re-checks liveness at resolve time.)
          if (!term) {
            return { kind: "error", text: `Pane ${targetId} is not running. Start it first (restart the pane), then try again.` };
          }
          addCommand(targetId, instruction);
          term.writeInput(instruction);
          broadcast({ type: "command_auto_executed", terminalId: targetId, cmd: safeInstr });
          return { kind: "executed", text: `Command executed automatically on pane ${targetId}: "${safeInstr}"` };
        case "pending_approval": {
          // WS-E.1 two-phase: store a serializable pending entry + the session in the side-map,
          // mark it announced for targeting, and let the caller answer call.id NON-BLOCKINGLY.
          const pSummary = redactSecrets(manager.getPaneSummary(targetId, 5));
          const rationale = { trigger: redactSecrets(opts.trigger), summary: pSummary };
          const record: PendingApproval = { messageId: pendingId, instruction, kind, terminalId: targetId, callId, rationale, timestamp: Date.now(), capability };
          pendingApprovals.add(record, sess, {
            workspaceId: manager.ledger.activeProjectId || "default_project",
            ttlMs: APPROVAL_TTL_MS,
          });
          // WS-D path: approval arrival is a high-severity attention source (earcon + stack).
          announcementBus.enqueue({ kind: "exited", terminalId: targetId, summary: "Awaiting your approval." });
          // rbh: enrich the approval frame with the TARGET pane's EFFECTIVE posture so the dialog can
          // show "into what posture am I approving this write?". posturePayloadForPane is frozen-aware
          // on main, so the approval path needs no separate frozen fix (only the action path did).
          // All additive optional fields — older clients ignore them; the harness-fed e2e specs degrade.
          const approvalPosture = posturePayloadForPane(targetId);
          clientWs.send(JSON.stringify({
            type: "approval_pending", messageId: pendingId, cmd: safeInstr, instruction: safeInstr, kind, terminalId: targetId, rationale,
            effective_gates: approvalPosture.effective_gates,
            posture: approvalPosture.posture,
            effective_mode: effectiveMode,
            capability,
          }));
          const verb = kind === "agent_instruction" ? "direct pane" : "run on pane";
          return { kind: "pending", text: `Pending approval: ${verb} ${targetId} — "${safeInstr}". Read it back to the operator and ask them to approve or reject.` };
        }
      }
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
      sessionDead = true;
      if (state.session) {
        const detached = pendingApprovals.detachSession(state.session);
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
        broadcast({ type: "voice_channel_lost", reason: blank ? "no_api_key" : "invalid_api_key" });
        return;
      }
      broadcast({ type: "voice_channel_lost", reason });
      // PLM4 (2): try to bring the voice channel back, bounded. No-op if the operator already left.
      scheduleReconnect();
    };

      const sessionKey = (manager.settings.secrets?.geminiApiKey && manager.settings.secrets.geminiApiKey !== "CONFIGURED_IN_ENV")
        ? manager.settings.secrets.geminiApiKey
        : (process.env.GEMINI_API_KEY || "");

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

      // Initialize Gemini Live session (through the injectable seam so tests /
      // the offline simulator can substitute a fake session). Uses the per-server snapshot
      // (boundLiveConnector) so a sibling test server's setLiveConnector cannot redirect us.
      state.session = await boundLiveConnector(sessionAi, {
        model: liveModel,
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            const session = state.session;
            // Check for sessionResumption update. Gemini Live emits a fresh handle on
            // (nearly) every turn; only log when it actually changes, else a single
            // session floods the log with dozens of near-identical lines (bug E).
            // Also ignore the SDK's final post-close token flush (wsClosed): writing it
            // would overwrite the live handle with a stale one from a dead session and
            // poison the next reconnect's resume attempt.
            if ((message as any).sessionResumptionUpdate && !state.wsClosed && !sessionDead) {
              const prevHandle = lastSessionResumptionToken?.newHandle;
              lastSessionResumptionToken = (message as any).sessionResumptionUpdate;
              if (lastSessionResumptionToken?.newHandle !== prevHandle) {
                // Don't log the handle value — it's a session-resumption token (mildly sensitive) and
                // rotates almost every turn (log spam). It's persisted to KV for debugging if needed.
                console.log("[SESSION RESUMPTION] Handle rotated.");
                // PLM4 (1): persist the fresh handle so a process restart can resume. Best-effort,
                // never-throw; guarded for store === null inside persistResumptionToken.
                persistResumptionToken(lastSessionResumptionToken);
              }
            }

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
            }

            if (userUtterance) {
              state.currentSessionUserUtterance = userUtterance;
              interactionLog.log({ interactionId: onOperatorSpeech(), kind: "voice_in", text: userUtterance, data: { source: "operator" } });

              // BEAD tkd (should-I-speak gate): decide ONCE per operator turn whether Janus's spoken
              // AUDIO for the model's reply should be muted. DEFAULT OFF (silenceGate:false) =>
              // shouldSpeak short-circuits to {speak:true}, so this is a no-op and the audio path is
              // byte-for-byte today's. When ON it mutes ONLY at high confidence the director is
              // thinking-aloud (fail-open). The decision is LATCHED on state for this turn's audio and
              // logged so a mute is auditable (guards a silent dead-voice regression). Decision logic
              // lives ENTIRELY in speakGate.ts — here we only read the boolean.
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
              if (shouldRouteUtterance(cleanUtter)) {
                // A4: route any utterance with non-whitespace content so bare votes ("no"/"ok", 2
                // chars) reach the parser (was `cleanUtter.length > 2`, which amputated them before
                // parseApprovalIntent — which already resolves bare yes/no). Empty/whitespace drops.
                // Step 6: capture dictation into the ACTIVE pane's WIP draft (raw material the
                // operator refines before sending). No-op if no pane is open.
                appendActiveDraft(`* **User Dictation**: ${cleanUtter}`, "operator");

                // WS-E.2 (BUG-007/008): hands-free voice approvals via the PURE intent parser
                // + most-recently-announced targeting (NOT FIFO, NOT substring matching).
                const parsed = parseApprovalIntent(cleanUtter);
                if (parsed.intent !== "none") {
                  interactionLog.log({ interactionId: turnId(), kind: "approval", data: { intent: parsed.intent, targetHint: parsed.targetHint } });
                  const entries = pendingApprovals.forSession(session);
                  if (entries.length > 0) {
                    // Collision/ambiguity in the utterance itself -> clarify, never approve.
                    if (parsed.intent === "clarify") {
                      pushApprovalNarrationDep(session, `I heard both approve and reject — which did you mean for the ${entries.length} pending command${entries.length === 1 ? "" : "s"}?`);
                    } else {
                      const target = selectApprovalTarget(
                        entries.map((e) => ({ messageId: e.messageId, instruction: e.instruction, terminalId: e.terminalId })),
                        parsed.targetHint,
                        pendingApprovals.lastAnnouncedFor(session)
                      );
                      if (target.ambiguous || !target.messageId) {
                        // >1 pending and nothing disambiguates -> clarify, list them.
                        const list = entries.map((e, i) => `${i + 1}. "${redactSecrets(e.instruction)}" on pane ${e.terminalId}`).join("; ");
                        pushApprovalNarrationDep(session, `I have ${entries.length} pending: ${list}. Which one?`);
                      } else {
                        resolveApprovalByVoice(session, target.messageId, parsed.intent === "approve");
                      }
                    }
                  } else {
                    // U1 (bead wsm-e2e-pinned-9fe): no pending pane-WRITE approval for this session,
                    // but a gated NON-PTY mutator (create_pane / set_*_permissions) may be staged in
                    // the GLOBAL pendingActions store (gateOrDefer Ask branch, server.ts:1407).
                    // Resolve it by voice, MIRRORING the REST handlers (server.ts:1560-1580) so the
                    // claim() seam keeps exactly-once across a REST+voice race.
                    // NOTE: pendingActions is GLOBAL (not session-scoped like pendingApprovals) — a
                    // sharp edge in multi-session setups; here the single live session owns the queue.
                    // Precedence is preserved by being the `else` of `entries.length > 0`: a session
                    // with BOTH a pending approval and a staged action resolves the APPROVAL first.
                    resolvePendingActionByVoice(cleanUtter, pendingActions, {
                      broadcast,
                      narrate: (t) => pushApprovalNarrationDep(session, t),
                      redact: redactSecrets,
                    });
                  }
                }
              }
            }
            if (modelUtterance) {
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
            }

            // BEAD aqx (build-out): when grounded web search informed this turn, Gemini returns the
            // queries it ran + the web sources on serverContent.groundingMetadata. Surface them so a
            // grounded answer SHOWS where it came from (transcript chip + interaction log). This is a
            // strict no-op when grounding is OFF: the model never populates groundingMetadata, so
            // extractGrounding() returns empty and nothing is sent. Pure reader; never throws.
            const grounding = extractGrounding(message);
            if (hasGrounding(grounding)) {
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
            }

            // Pass audio back to client. This is the SINGLE spoken-output choke point — the only
            // place model audio reaches the operator (responseModalities is [AUDIO]-only).
            // BEAD tkd: if the should-I-speak gate latched a MUTE for this turn, suppress the AUDIO
            // here (and only here). The transcript_text frame above stays UNCONDITIONAL — a muted
            // turn is still visible on-screen (graceful, debuggable, NOT dead voice). With the flag
            // off, muteCurrentModelTurn is always false, so this is byte-for-byte today's path.
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audio) {
            if (!state.muteCurrentModelTurn) {
              clientWs.send(JSON.stringify({ type: "audio", audio }));
            }
          }
          if (message.serverContent?.interrupted) {
            clientWs.send(JSON.stringify({ type: "interrupted", interrupted: true }));
            // B1 (turn-aware ack): a barge-in means the operator seized the turn. Latch it (so an
            // async-spawn ack SUPPRESSES rather than speaks over them) and stamp recency. Cleared
            // when the model next takes the turn (setModelTurn) or on the next operator transcript.
            state.lastInterrupted = true;
            state.lastOperatorSpeechAt = Date.now();
          }
          // BEAD tkd: clear the speak-gate mute latch at the model turn boundary so it can NEVER bleed
          // past one turn. (Also cleared at the START of the next operator turn in onOperatorSpeech.)
          if (message.serverContent?.turnComplete || (message.serverContent as any)?.generationComplete) {
            state.muteCurrentModelTurn = false;
          }

          // Handle Tool Calls
          if (message.toolCall) {
            for (const call of message.toolCall.functionCalls || []) {
              const name = call.name;
              const args = call.args as Record<string, any>;
              const ixnId = turnId();
              setModelTurn(); // B1: entering the toolCall loop is a model turn -> clear barge-in latch.
              interactionLog.log({ interactionId: ixnId, kind: "tool_call", data: { name, callId: call.id, args: args ?? {} } });

              // Guard every tool handler: an uncaught throw here would escape the Gemini SDK
              // onmessage callback, leave this call.id unanswered, and stall the conversation.
              try {
              // REG1 phase-C: the entire if (name === ...) dispatch chain is REPLACED by the unified
              // registry. runAction parses args, runs the handler-owned gate, redacts readOnly results,
              // and NEVER throws; resultToToolResponse answers call.id exactly once (§9 voice column).
              //
              // Unified dispatch — EVERY tool (incl. the always-allowed emergency-brake trio, now wired
              // to the real stopAll/releaseStopAll/isFrozen closures via ActionContext) routes through
              // the registry. runAction is itself try/caught + never throws; the outer catch is belt-and-
              // suspenders. The Gemini declarations come from the SAME REGISTRY (toGeminiDeclarations).
              // PLM4 (3): PER-DISPATCH IDEMPOTENCY / replay guard. A tool call RE-DELIVERED after a
              // reconnect (Gemini may replay the same functionCall id on a resumed session) must NOT
              // double-apply a SIDE-EFFECTING (non-readOnly) action. If this idempotency_key (the
              // Gemini call.id, unique per dispatch) already has a SUCCEEDED action_log row, answer the
              // model it was already done and DO NOT re-run the handler. Reads (readOnly) are exempt —
              // replaying a read is harmless. The store lookup is best-effort: any fault falls through
              // to normal dispatch (the guard NEVER blocks the never-throw path).
              const replayDef = REGISTRY.find((d: any) => d.name === name);
              let replayShortCircuit = false;
              if (store && call.id && replayDef && !replayDef.readOnly) {
                try {
                  if (store.hasSucceededIdempotencyKey(call.id)) replayShortCircuit = true;
                } catch { /* store fault -> proceed; the guard must never block dispatch. */ }
              }
              if (replayShortCircuit) {
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Already handled (${name} was applied on a prior delivery of this request).` } }],
                });
              } else {
                const actionCtx: ActionContext = buildActionContext(call.id!, name);
                const result = await runAction(REGISTRY, name!, (args ?? {}) as Record<string, unknown>, actionCtx);
                interactionLog.log({ interactionId: ixnId, kind: "action_result", data: { name, callId: call.id, resultKind: (result as { kind?: string })?.kind } });
                resultToToolResponse(result, session, name!, call.id!);
                // B1 (phase-1 ack): an AUTO-created pane now boots asynchronously, so confirm "opening"
                // immediately — BUT only when it will not speak over the operator (turn-aware gate).
                // Placed on the NON-replay path (replay short-circuits above), so a reconnect-replayed
                // create_pane never double-narrates. The `startsWith("Pane ")` check matches ONLY the
                // Auto-created success string (panes_write.ts) — NOT the gated-Ask "needs operator
                // confirmation" / forbidden "Error" strings — so a deferred create gets no false ack
                // (its phase-2 fires later, after the operator confirms and the pane truly boots).
                if (
                  name === "create_pane" &&
                  (result as any)?.kind === "ok" &&
                  typeof (result as any).output === "string" &&
                  (result as any).output.startsWith("Pane ") &&
                  shouldSpeakOpeningAck(ackState()) === "speak"
                ) {
                  pushAck(session, "Opening the pane now.");
                }
              }
              } catch (toolErr) {
                console.error(`[TOOL] Handler for "${name}" threw:`, toolErr);
                try {
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: `Internal error while handling ${name}: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}` } }]
                  });
                } catch { /* session already torn down; nothing more we can do */ }
              }
            }
          }
        },
        // QW3 (bead qw3): the Gemini Live socket can die WITHOUT the client WS closing — a network
        // reset, a server-side close, an SDK error. With only `onmessage`, nothing fired:
        // coreState.activeLiveSession kept a dead handle and the frontend was never told. These siblings mirror
        // the WS-close teardown (see clientWs.on("close")): DETACH (keep survivors for re-announce),
        // null coreState.activeLiveSession behind the identity guard so a stale callback can't clobber a newer
        // session, and broadcast a NEW voice_channel_lost frame. NO reconnect logic (that is PLM4).
        onerror: (err: any) => {
          // Log only the message, NOT the raw error/socket — the live WebSocket's URL carries the API
          // key (?key=…), so dumping the object leaks the key into logs (security hazard).
          console.error("[VOICE] Gemini Live session error — voice channel lost:", err instanceof Error ? err.message : String(err?.message ?? "error"));
          handleSessionLost("error");
        },
        onclose: (info: any) => {
          // Log only code/reason, NOT the raw CloseEvent — its kTarget is the live WebSocket whose URL
          // contains the API key (?key=…). Dumping the object leaks the key into logs (security hazard).
          console.warn(`[VOICE] Gemini Live session closed — voice channel lost (code=${info?.code ?? "n/a"}, reason=${info?.reason || "n/a"}).`);
          handleSessionLost("closed", typeof info?.code === "number" ? info.code : undefined);
        },
      },
      config: {
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
      },
    });

      // PLM4 (2): IDENTITY GUARD on the just-resolved connect. The async connect could have raced the
      // operator leaving (wsClosed) or a newer session winning the hoist. If so, this freshly-minted
      // session is stale — close it and bail WITHOUT clobbering the live channel. (`session` is the
      // connection-scope let; on a reconnect a newer attempt could already have overwritten it, but
      // last-write-wins here is fine: we only proceed if NOTHING newer has hoisted.)
      const justConnected = state.session;
      if (state.wsClosed || myGeneration !== state.connectGeneration) {
        // Operator left during the await, OR a newer connect attempt has superseded this one. Either
        // way this session is stale: close it and bail WITHOUT clobbering the live channel.
        try { justConnected?.close?.(); } catch { /* best-effort */ }
        return;
      }

      // WS-F (spec §6.2): the live session is now established. Hoist it for the action last-call,
      // then re-attach every staged survivor that outlived the prior disconnect (or a process
      // restart) to THIS session and speak ONE batched resumption digest — "welcome back, here's
      // your queue" — re-requiring explicit approval. Runs exactly once per (re)connect, AFTER the
      // connect promise resolves so `session` is live.
      coreState.activeLiveSession = justConnected;
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
            turnComplete: true,
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
          const still: PaneSignal[] = [];
          for (const sig of state.deferredReady) {
            const age = now - ((sig as any).__deferredAt ?? now);
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
            (sig as any).__deferredAt = Date.now();
            state.deferredReady.push(sig);
            armReadyDrain();
            return;
          }
        }
        pushSignal(sig);
      });
    } catch (err: any) {
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

    clientWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "audio" && msg.audio) {
          // Feed user mic to Gemini
          if (state.session) {
            try {
              state.session.sendRealtimeInput({
                audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
              });
            } catch (e) {
              console.error("Error feeding user mic:", e);
            }
          }
        } else if (msg.type === "draft_edit" && msg.text !== undefined) {
          // Step 6: operator editing a pane's WIP draft. Defaults to the active pane when the
          // client doesn't name one. Not a CLI write — ungated.
          const projectId = msg.projectId || manager.ledger.activeProjectId || "default_project";
          const paneId = msg.paneId || coreState.activePaneId;
          if (paneId && manager.ledger.setDraft(projectId, paneId, msg.text, "operator")) {
            broadcastDraft(projectId, paneId);
          }
        } else if (msg.type === "set_active_pane") {
          // Step 5: the UI is the source of truth for the active pane. Whatever the operator has
          // open (or null if nothing is open) is recorded here and gates every Janus write.
          coreState.activePaneId = typeof msg.paneId === "string" ? msg.paneId : null;
          // Memory Synthesis P0a (freshness trigger #1, the acute rot case): the operator switched
          // the open pane — re-focus the live brief on it (the prior pane demotes to a breadcrumb).
          // Non-blocking + self-guarded.
          injectMemoryBrief(state.session, coreState.activePaneId);
        } else if (msg.type === "stop_all") {
          // TWO-STAGE EMERGENCY BRAKE from the UI (bead 8sq). Always allowed — never gated.
          // Stage 1 (default / kill=false): freeze + cancel in-flight; panes keep running.
          // Stage 2 (kill=true): hold-to-fire kill of running PTYs, only when already frozen.
          // stopAll broadcasts {type:'frozen'}/{type:'stop_all'} to ALL clients; this is the
          // per-client ack so the requesting UI can confirm completion.
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
