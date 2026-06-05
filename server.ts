import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";
import crypto from "crypto";
import { OrchestratorManager, UniversalTerminal, stripAnsiSequences, redactSecrets, classifySecrets, normalizePreset, presetCommand } from "./src/terminal";
import { PaneSignalBus } from "./src/paneSignalBus";
import { formatPaneSignal } from "./src/paneSignals";
import { AnnouncementBus, pruneAttentionQueue, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "./src/announcementBus";
import {
  PendingApprovalStore,
  decideProposal,
  isLoosening,
  isStagedStale,
  inferKind,
  serializePending,
  type ApprovalKind,
  type PendingApproval,
} from "./src/pendingApprovals";
import { parseApprovalIntent, selectApprovalTarget } from "./src/approvalIntent";
import { shouldRouteUtterance, resolvePendingActionByVoice } from "./src/voiceApprovalRouting";
import { isPaneActiveForWrite, inactivePaneClarify } from "./src/activePane";
import { JanusStore } from "./src/store/sqliteStore";
import { deliverOutcomeToHandoff } from "./src/handoffFlow";
import { restGateOutcome } from "./src/restGate";
import { planRecipeApply } from "./src/recipeApply";
import { migrateOnBootIfNeeded } from "./src/store/migrate";
import type { CapabilityGate, CapabilityGateMap } from "./src/types";
import { resolveProjectDir, isBadProjectDir } from "./src/projectDir";
import { REGISTRY, actionSchemaHash } from "./src/actions/registry";
import { runAction, resultToToolResponse, toGeminiDeclarations } from "./src/actions/gemini";
import type { ActionContext } from "./src/actions/types";
import { mountRestRoutes, type RestApp, type RestRequest } from "./src/actions/rest";
import { InteractionLogger, createFileInteractionSink, NOOP_SINK } from "./src/interactionLog";
import { resolveResumeHandleTtlMs, shouldClearHandleOnClose, wrapHandleForPersist, readFreshHandle, isInvalidKeyClose, isBlankApiKey } from "./src/voiceResumption";
import { extractTranscripts } from "./src/liveTranscripts";
import { createCoreState } from "./src/core/coreState";
import { attachObserve } from "./src/observe";
import { createGating } from "./src/gating";
import { attachVoiceSession, pushApprovalNarration } from "./src/voice";

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

// ── Correlated interaction log (Issue #1 instrumentation + "capture voice/thinking/actions/system,
// analyzed together") ───────────────────────────────────────────────────────────────────────────
// Append-only JSONL: every leg of an operator TURN (voice_in -> gemini_thinking/text -> tool_call ->
// action_result -> approval -> pty) is one redacted line keyed by a shared interaction_id, so a whole
// turn is reconstructable (scripts/analyze-interactions.ts) — and the approve→dispatch lag of Issue #1
// becomes visible in the per-leg timestamps. Always on; JANUS_INTERACTION_LOG=off disables, or set a
// path to relocate. JANUS_DEBUG_VOICE additionally echoes legs to stderr AND enables the (higher-
// volume) pty leg.
const INTERACTION_LOG_PATH = process.env.JANUS_INTERACTION_LOG ?? ".janus_interaction_log.jsonl";
const VOICE_TRACE = !!process.env.JANUS_DEBUG_VOICE && process.env.JANUS_DEBUG_VOICE !== "0";
const interactionSink =
  INTERACTION_LOG_PATH.toLowerCase() === "off" ? NOOP_SINK : createFileInteractionSink(INTERACTION_LOG_PATH);
const interactionLog = new InteractionLogger({
  sink: (line) => {
    interactionSink(line);
    if (VOICE_TRACE) console.error("[VOICE-TRACE]", line);
  },
  redact: redactSecrets,
});
// Best-effort PTY attribution: the active turn's id, mirrored to module scope so manager.onOutput
// (server-scope, not per-connection) can tag terminal output with the turn it most likely belongs to.
let lastInteractionId: string | null = null;

// Automatic session secret token loaded from env or generated cryptographically fresh on boot.
// Exported so in-process integration tests can authenticate without guessing the token.
export const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || crypto.randomBytes(32).toString("hex");

// The Gemini Live session is created through this seam so tests and the offline
// simulator can swap in a fake session (no API key, no microphone) that still
// drives the real tool-dispatch / approval code paths in this file.
export type LiveConnector = (ai: GoogleGenAI, params: any) => Promise<any>;
let liveConnector: LiveConnector = (ai, params) => ai.live.connect(params);
export function setLiveConnector(fn: LiveConnector) {
  liveConnector = fn;
}

// PLM4 (Finding A): the per-session GoogleGenAI client (built from the operator's key) is constructed
// through this seam so a test can simulate the PRE-TRY setup throwing (e.g. a malformed-but-present
// key making `new GoogleGenAI(...)` throw) BEFORE connectLiveSession's own try — the never-throw hole
// the initial-connect wrap now closes. Prod default just constructs the real client. Returns the
// SDK client to use; `fallback` is the server's shared `ai` (used when there is no per-session key).
export type SessionAiFactory = (key: string, fallback: GoogleGenAI) => GoogleGenAI;
let sessionAiFactory: SessionAiFactory = (key, fallback) =>
  key
    ? new GoogleGenAI({ apiKey: key, httpOptions: { headers: { "User-Agent": "aistudio-build" } } })
    : fallback;
export function setSessionAiFactory(fn: SessionAiFactory) {
  sessionAiFactory = fn;
}
/** Restore the default (real) session-AI factory. Tests call this in their teardown. */
export function resetSessionAiFactory() {
  sessionAiFactory = (key, fallback) =>
    key
      ? new GoogleGenAI({ apiKey: key, httpOptions: { headers: { "User-Agent": "aistudio-build" } } })
      : fallback;
}
console.log("-----------------------------------------------------------------");
console.log(`[SECURITY] Session API Authentication Token generated.`);
console.log("-----------------------------------------------------------------");

function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const parts = cookie.trim().split("=");
    if (parts[0] === name) {
      return parts.slice(1).join("=");
    }
  }
  return null;
}

// Returns a deep copy of `settings` with the Gemini API key masked, safe to send to
// any client (REST response or WS broadcast). The masking matches GET /api/settings so
// the key is never shipped in plaintext over the `settings_updated` broadcast. PUT
// restores the real key server-side when it sees a masked/blank value coming back.
function sanitizeSettingsForClient<T extends { secrets?: { geminiApiKey?: string } }>(settings: T): T {
  const sanitized = JSON.parse(JSON.stringify(settings)) as T;
  const key = sanitized.secrets?.geminiApiKey;
  if (key && key !== "CONFIGURED_IN_ENV" && key.length > 8) {
    sanitized.secrets!.geminiApiKey = key.substring(0, 6) + "••••••••" + key.substring(key.length - 4);
  }
  return sanitized;
}

export interface HistoryEntry {
  command: string;
  timestamp: string;
  output: string;
  finalResponse?: string;
}

export class HistoryManager {
  private static instance: HistoryManager;

  private constructor() {}

  public static getInstance(): HistoryManager {
    if (!HistoryManager.instance) {
      HistoryManager.instance = new HistoryManager();
    }
    return HistoryManager.instance;
  }

  private getFilePath(): string {
    return path.join(process.cwd(), ".janus_history.json");
  }

  private getLimits() {
    const maxCmds = manager.settings?.advanced?.historyMaxCommands ?? 50;
    const maxOutput = manager.settings?.advanced?.historyMaxOutputLength ?? 5000;
    return { maxCmds, maxOutput };
  }

  public loadHistory(terminalId: string): HistoryEntry[] {
    const filePath = this.getFilePath();
    const { maxCmds } = this.getLimits();
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const list = parsed[terminalId];
          if (Array.isArray(list)) {
            return list.slice(-maxCmds);
          }
        }
      }
    } catch (e) {
      // Return empty if file not found or corrupted
    }
    return [];
  }

  public saveHistory(terminalId: string, history: HistoryEntry[]): void {
    const filePath = this.getFilePath();
    const { maxCmds, maxOutput } = this.getLimits();
    try {
      const pruned = history.slice(-maxCmds).map(entry => ({
        ...entry,
        output: (entry.output || "").slice(-maxOutput)
      }));

      let allHistory: Record<string, HistoryEntry[]> = {};
      if (fs.existsSync(filePath)) {
        try {
          const data = fs.readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            allHistory = parsed;
          }
        } catch (e) {}
      }
      allHistory[terminalId] = pruned;
      fs.writeFileSync(filePath, JSON.stringify(allHistory, null, 2), "utf-8");
    } catch (e) {
      console.warn(`[HistoryManager] Failed to save history to ${filePath}:`, e);
    }
  }

  public addCommand(terminalId: string, command: string) {
    const history = this.loadHistory(terminalId);
    const newEntry: HistoryEntry = {
      command,
      timestamp: new Date().toISOString(),
      output: ""
    };
    history.push(newEntry);
    this.saveHistory(terminalId, history);
  }

  public appendOutputToLastCommand(terminalId: string, chunk: string) {
    const history = this.loadHistory(terminalId);
    if (history.length > 0) {
      const lastEntry = history[history.length - 1];
      const { maxOutput } = this.getLimits();
      lastEntry.output = ((lastEntry.output || "") + chunk).slice(-maxOutput);
      this.saveHistory(terminalId, history);
    }
  }
}

// WS-M/Handoffs: the persistent JanusStore (SQLite). better-sqlite3 loads cleanly under tsx
// (confirmed by the store unit tests + smoke), so a static import is fine here — unlike node-pty
// which the transport layer loads via createRequire. init() applies migrations (idempotent);
// bootMaintenance() prunes stale rows/scrollback. Created BEFORE the manager so it can serve as
// the manager's ledger backend when the cutover flag is on.
let store: JanusStore | null = null;
try {
  store = new JanusStore(process.env.JANUS_DB || ".janus.db");
  store.init();
  store.bootMaintenance({
    now: Date.now(),
    eventsTtlDays: 30,
    archiveTtlDays: 14,
    scrollbackDirs: [process.cwd()],
  });
  console.log("[STORE] JanusStore initialized (handoffs + capability-gate audit).");

  // One-shot, gated, reversible JSON→SQLite ledger migration. Runs at most once
  // (guarded by an in-DB marker), only if a legacy .janus_ledger.json exists, and
  // renames the originals to .bak so the operator can verify/rollback. Idempotent
  // across restarts even though .janus.db already exists for the handoff store.
  try {
    const migrated = migrateOnBootIfNeeded(store, {
      ledgerPath: process.env.JANUS_LEDGER_PATH || ".janus_ledger.json",
      settingsPath: ".janus_settings.json",
      historyPath: ".janus_history.json",
    });
    if (migrated) console.log("[STORE] Migrated legacy JSON ledger → SQLite (originals renamed to .bak).");
  } catch (e) {
    console.error("[STORE] Ledger migration skipped (import failed; legacy JSON left intact):", e);
  }
} catch (e) {
  console.error("[STORE] Failed to initialize JanusStore — handoff persistence disabled:", e);
  store = null;
}

// WS-M cutover seam (design §5.3). The store satisfies LedgerLike, so it IS the
// manager's ledger — making drafts/context/approvals/etc. durable across restart.
// DEFAULT: SQLite (when the store booted). Escape hatch: JANUS_LEDGER_BACKEND=legacy
// forces the in-memory/JSON Ledger. If the store failed to boot, we fall back to
// legacy automatically so the app still runs.
const forceLegacy = process.env.JANUS_LEDGER_BACKEND === "legacy";
const useSqliteLedger = store !== null && !forceLegacy;
export const manager = new OrchestratorManager(useSqliteLedger ? { ledger: store! } : undefined);
console.log(useSqliteLedger
  ? "[STORE] OrchestratorManager ledger backend: SQLite (durable). Set JANUS_LEDGER_BACKEND=legacy to opt out."
  : `[STORE] OrchestratorManager ledger backend: legacy JSON Ledger${forceLegacy ? " (JANUS_LEDGER_BACKEND=legacy)" : " (store unavailable)"}.`);

// `store` is a process-wide singleton: created once here at import and SHARED by every
// startServer() call. Releasing it is therefore a PROCESS-level concern, not a per-server one —
// closing it inside an individual server's close() would pull the shared DB handle out from under
// any sibling server still running in the same process (e.g. multiple in-process test suites under
// `tsx --test`, which previously made test_live_harness flake at the file level). We close it
// exactly once, synchronously, on process exit: better-sqlite3 writes are already durable
// per-statement, so this is pure handle cleanup, and a synchronous close in the 'exit' handler
// finishes before teardown — avoiding the UV_HANDLE_CLOSING abort that a still-in-flight close hit.
process.once("exit", () => { try { store?.close(); } catch { /* best-effort handle cleanup */ } });

// QW1 — process-level error net (bead qw1). This orchestrator drives PTYs and a Gemini Live
// socket; a throw at an async edge (a PTY data event, a Gemini callback) surfaces here as an
// uncaughtException, and a dropped promise as an unhandledRejection. Without a net, either one
// tears the whole voice channel down. This is a GUARD, not a framework: structured-log and keep
// running. We do NOT force a crash exit on a recoverable rejection — the existing
// process.once("exit") already closes the store, so this is best-effort. Installed ONCE at module
// scope (not inside startServer, which is re-invoked per in-process test server and would otherwise
// accumulate listeners and trip Node's MaxListeners warning).
export const __processSafety = { unhandledRejections: 0, uncaughtExceptions: 0 };
let __processNetInstalled = false;
function installProcessErrorNet(): void {
  if (__processNetInstalled) return;
  __processNetInstalled = true;
  process.on("unhandledRejection", (reason: unknown) => {
    __processSafety.unhandledRejections++;
    console.error("[PROCESS-SAFETY] unhandledRejection (recovered, not exiting):", reason);
    // Best-effort net: do NOT process.exit() — a dropped promise must not kill the voice channel.
  });
  process.on("uncaughtException", (err: unknown) => {
    __processSafety.uncaughtExceptions++;
    console.error("[PROCESS-SAFETY] uncaughtException (recovered, not crashing):", err);
    // Best-effort net: keep the loop alive. The process.once("exit") handler closes the store on a
    // real exit; we deliberately do not force one here on a single recoverable throw.
  });
}
installProcessErrorNet();
// Test-only seam: re-attach the net after a suite has temporarily detached process listeners to
// isolate the handler under test. Idempotent — only attaches handlers that are not already present.
export function __installProcessErrorNetForTest(): void {
  __processNetInstalled = false;
  installProcessErrorNet();
}

// Prompt-composer refactor (step 6): the single global prompt buffer is gone. Each pane now keeps
// its OWN persistent WIP draft in the ledger (PaneMeta.draft), composed against the active pane.

export interface StartServerOptions {
  /** Port to bind. Use 0 for an ephemeral port (handy in tests). Defaults to PORT (3000). */
  port?: number;
  /** Host to bind. Defaults to 0.0.0.0 in production, 127.0.0.1 otherwise. */
  bindHost?: string;
  /** Mount the Vite dev middleware. Defaults to true outside production. Disable in tests. */
  enableVite?: boolean;
  /** Actually call server.listen(). Defaults to true. */
  listen?: boolean;
}

export interface RunningServer {
  app: express.Express;
  server: http.Server;
  wss: WebSocketServer;
  manager: OrchestratorManager;
  /** The actually-bound port (resolved even when port 0 was requested). */
  port: number;
  /** Stop the HTTP/WS servers and tear down all live terminals. */
  close: () => Promise<void>;
  /** QW3 test seam: read the hoisted live session (null === no voice channel). NOT for prod use. */
  _testActiveLiveSession?: () => any;
  /** QW3 test seam: read the pending-approval store (for survivor/detach assertions). */
  _testPendingApprovals?: () => PendingApprovalStore;
  /** QW6 test seam: the broadcast client set (for dead-socket pruning assertions). NOT for prod use. */
  _testClients?: () => Set<any>;
}

async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const enableVite = options.enableVite ?? process.env.NODE_ENV !== "production";
  const shouldListen = options.listen ?? true;

  // Snapshot the live-session connector for THIS server instance. `liveConnector` is a module-level
  // seam (setLiveConnector); reading it late, at WS-connect time, let a sibling in-process server's
  // installMockLive() clobber the global between this server's boot and a client connecting — so a
  // session created here would be recorded into the WRONG mock handle, and that suite's
  // `waitFor(mock.latest())` would time out (the test_live_harness file-level flake under parallel
  // `tsx --test`). Binding it synchronously at startServer() time — there is no await between a
  // suite's installMockLive() and its startServer() call — pins each server to its own connector.
  const boundLiveConnector = liveConnector;
  // PLM4 (Finding A): snapshot the session-AI factory for THIS server too (same pinning rationale as
  // boundLiveConnector) so a sibling test server cannot redirect our pre-try client construction.
  const boundSessionAiFactory = sessionAiFactory;

  const app = express();
  app.use(express.json());

  // Automatically seed the httpOnly SameSite API cookie on core layout/page renders
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api") && !req.path.startsWith("/live")) {
      const currentToken = getCookie(req.headers.cookie, "auth_token");
      if (currentToken !== API_AUTH_TOKEN) {
        res.cookie("auth_token", API_AUTH_TOKEN, {
          httpOnly: true,
          sameSite: "strict",
          secure: process.env.NODE_ENV === "production"
        });
      }
    }
    next();
  });

  const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const tokenFromCookie = getCookie(req.headers.cookie, "auth_token");
    const tokenFromHeader = req.headers["x-api-token"]?.toString() || req.headers["authorization"]?.toString().replace(/^Bearer\s+/, "");
    
    if (tokenFromCookie === API_AUTH_TOKEN || tokenFromHeader === API_AUTH_TOKEN) {
      next();
    } else {
      res.status(401).json({ error: "Unauthorized: Invalid or missing API security token. Reload your interface." });
    }
  };

  app.use("/api", authMiddleware);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/live" });

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  // Push-observation: one bus per server; each /live connection subscribes its session.
  const paneSignalBus = new PaneSignalBus();

  // dec-2 (DBT5): the PTY observation/trigger pipeline (summarizeCommandOutcome, onIdle,
  // handleWatchRulesTrigger, handlePlansTrigger, detectAndTriggerTransitions, onOutput) moved to
  // src/observe/index.ts. attachObserve(...) is invoked below — AFTER broadcast / announcementBus /
  // pruneAttention are constructed — and its returned handlers are assigned to manager.onOutput /
  // manager.onIdle there. (The handlers are late-bound closures, exactly as the inline assignments
  // were, so the call must follow the deps it captures.)

  // dec-1 (DBT5): the shared mutable runtime state — coreState.activeFrontendWs, coreState.activeLiveSession, the broadcast
  // client set, coreState.activePaneId (the single write-target source of truth), the STOP-ALL `frozen` freeze
  // (durably persisted, restored from the kv on construction), and coreState.lastStopAllFailed — hoisted into ONE
  // shared object so the domains later carved out of this file (observe/gating/voice) mutate the SAME
  // cells via their injected deps bag rather than closing over server-local `let`s. Mutate `frozen`
  // ONLY via coreState.setFrozen so persistence stays coupled. See src/core/coreState.ts.
  const coreState = createCoreState(store);

  // `DispatchOutcome` is the single-sourced result shape returned by `dispatchProposal` (below).
  // Prompt-composer refactor: there is no longer an `activePlanGate`. Plans never auto-advance by
  // writing into a pane (architecture §5), so the outer-scope step engine no longer needs a handle
  // back into the live session's dispatch path.
  type DispatchOutcome =
    | { kind: "executed"; text: string }
    | { kind: "blocked"; text: string }
    | { kind: "error"; text: string }
    | { kind: "clarify"; text: string }
    | { kind: "pending"; text: string };

  function broadcast(msg: any) {
    const data = JSON.stringify(msg);
    for (const client of coreState.clients) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(data);
        } catch (e) {
          // QW6 (bead qw6): a send that throws means the socket is dead. Drop it from the set so the
          // next broadcast doesn't re-throw on the same corpse (and the set doesn't leak); the
          // matching clientWs.on("close") cleanup may never have fired for an abrupt break.
          console.error("Failed to send socket broadcast:", e);
          coreState.clients.delete(client);
        }
      }
    }
  }

  // Step 6 (the Workbench): per-pane WIP draft helpers. The draft is composed against the ACTIVE
  // pane (single source of truth, step 5); composing/editing it is not a CLI write and is ungated.
  function activeDraftTarget(): { projectId: string; paneId: string } | null {
    if (!coreState.activePaneId) return null;
    return { projectId: manager.ledger.activeProjectId || "default_project", paneId: coreState.activePaneId };
  }
  function broadcastDraft(projectId: string, paneId: string) {
    const draft = manager.ledger.getDraft(projectId, paneId) ?? { text: "", updatedAt: new Date().toISOString() };
    broadcast({ type: "draft_updated", projectId, paneId, draft });
  }
  function appendActiveDraft(line: string, updatedBy: "janus" | "operator") {
    const t = activeDraftTarget();
    if (!t) return; // no active pane -> nowhere to compose (step 5)
    manager.ledger.appendDraft(t.projectId, t.paneId, line, updatedBy);
    broadcastDraft(t.projectId, t.paneId);
  }

  // WS-D (BUG-024): proactive feedback controller. Per the maintainer decision this drives
  // earcons + a coalescing on-screen notification stack (Seam B / broadcast) — NOT in-voice
  // spoken turns. It owns the per-pane debounce, coalescing window, and token-bucket rate
  // limit so the event path below stays thin (just enqueue).
  const announcementBus = new AnnouncementBus({
    broadcast,
    getTemplates: () => manager.settings.announcements || DEFAULT_ANNOUNCEMENT_TEMPLATES,
  });

  // BUG-035: keep the attentionQueue bounded + TTL-evicted wherever it is mutated.
  function pruneAttention() {
    pruneAttentionQueue(manager.attentionQueue);
  }

  // dec-2 (DBT5): attach the PTY observation/trigger pipeline (src/observe/index.ts). This is invoked
  // HERE — after broadcast / announcementBus / pruneAttention / paneSignalBus are constructed — and the
  // returned handlers are bound onto the manager, exactly mirroring the inline `manager.onOutput = ...`
  // / `manager.onIdle = ...` assignments this replaced. The pipeline's private state (lastStates,
  // outputBuffers, flushTimeout) lives as locals inside attachObserve, scoped to this server instance.
  const { onOutput, onIdle } = attachObserve(manager, {
    broadcast,
    announcementBus,
    paneSignalBus,
    pruneAttention,
    interactionLog,
    getLastInteractionId: () => lastInteractionId,
    setLastInteractionId: (v) => { lastInteractionId = v; },
    redact: redactSecrets,
    historyManager: HistoryManager.getInstance(),
    ai,
  });
  manager.onOutput = onOutput;
  manager.onIdle = onIdle;

  function broadcastLedgerUpdate() {
    broadcast({
      type: "ledger_updated",
      ledger: manager.ledger.workspaces
    });
  }

  // dec-5 (DBT5): pushApprovalNarration — narrate a SYSTEM EVENT into the live session so the model
  // speaks it to the operator — now lives in src/voice (it is voice egress) and is imported above. It
  // is a pure standalone function (session + text, no closure state), so gating can inject the SAME
  // identity here while STILL never importing voice (gating imports nothing from voice; server.ts wires
  // the dependency). Passed into createGating AND attachVoiceSession unchanged.

  // dec-4 (DBT5): the SHARED GATING / SAFETY CORE — the capability-gate resolver, the deferred-action +
  // pending-approval stores (with their durable boot hydration), the effective-posture surface, the
  // single resolve choke-point (applyResolution), the TWO-STAGE EMERGENCY STOP-ALL brake, and the TTL
  // sweep — moved to src/gating/index.ts. Constructed HERE (before the REST mount + the WS/voice block)
  // so every surface injects the SAME pending stores. pushApprovalNarration is an INJECTED slot so
  // gating never imports voice. See src/gating/index.ts.
  const gating = createGating({
    manager,
    store,
    broadcast,
    broadcastLedgerUpdate,
    coreState,
    announcementBus,
    pushApprovalNarration,
    redact: redactSecrets,
    sanitizeSettingsForClient,
    addCommand: (terminalId, command) => HistoryManager.getInstance().addCommand(terminalId, command),
  });
  // Destructure the gating seam so the existing inline call sites across the REST + WS surfaces keep
  // referencing these by name. ONE shared object by reference — the pending stores + the posture
  // surface read coreState.frozen/activePaneId across the boundary, so a WS write is immediately seen.
  // dec-5 (DBT5): the voice-only gating consumers (effectiveModeFor / reannounceSurvivors /
  // shellAllowlist / APPROVAL_TTL_MS) are no longer destructured here — attachVoiceSession receives the
  // whole `gating` object and destructures them inside src/voice. server.ts keeps only the names its
  // REST surface + REST ctxFactory still reference.
  const {
    effectiveCapabilityGateFor,
    gateCapability,
    gateOrDefer,
    posturePayloadForPane,
    broadcastTerminalsUpdated,
    runningPaneIds,
    stopAll,
    releaseStopAll,
    applyResolution,
    pendingApprovals,
    pendingActions,
  } = gating;

  // Web API to get terminals state
  app.get("/api/terminals", (req, res) => {
    const list = Object.keys(manager.terminals).map((id) => {
      const term = manager.terminals[id];
      // bead 8sq: include the SERVER-resolved effective posture (16 gate values + posture word)
      // so the per-pane chip renders from server truth — no client policy re-derivation (spec §5).
      const posture = posturePayloadForPane(id);
      return {
        id,
        cwd: term.cwd,
        command: term.shellCmd,
        // Display lane: raw bytes (escape sequences intact) for xterm to render
        // exactly. `output` stays ANSI-stripped for the pane-card text previews.
        backfill: term.getRawBackfill(),
        output: term.getRecentOutput(20),
        status: term.status,
        permissions_mode: term.permissionsMode,
        tool_preset: term.toolPreset,
        session_id: term.sessionId,
        context_size: term.contextSize,
        effective_gates: posture.effective_gates,
        posture: posture.posture,
      };
    });
    res.json(list);
  });

  app.get("/api/ledger", (req, res) => {
    res.json(manager.ledger.workspaces);
  });

  // Web API to create a terminal manually
  app.post("/api/terminals", (req, res) => {
    const { terminalId, cwd, command: clientCommand, toolPreset, permissionsMode, sessionId, projectId } = req.body;
    if (!terminalId) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    // KS (17d): DERIVE the launch command server-side from tool_preset via the SAME single
    // home the voice create_pane handler uses (presetCommand(normalizePreset(...))), so voice
    // and REST produce an IDENTICAL launch. A client-supplied `command` is honored ONLY for a
    // Custom preset (the documented free-form escape hatch, 17c); for any agent preset the
    // client string is IGNORED — the preset is the single source of truth. (Command is now
    // derived, so a non-Custom create no longer needs a client `command`.)
    const preset = normalizePreset(toolPreset);
    const derivedCommand = presetCommand(preset, manager.settings.presets, manager.settings.advanced?.defaultShellCommand);
    const command = preset === "Custom" && typeof clientCommand === "string" && clientCommand.trim()
      ? clientCommand
      : derivedCommand;
    // Resolve the working directory: an empty, "." , or non-existent cwd falls back
    // to the active project's directory (or the server cwd). Passing a bad path to
    // spawn() is what produced the cryptic "The system cannot find the path specified."
    const activeProj = manager.ledger.getActiveProject();
    let resolvedCwd = (cwd && cwd.trim() && cwd.trim() !== ".") ? cwd.trim() : (activeProj?.directory || process.cwd());
    try {
      if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
        resolvedCwd = activeProj?.directory || process.cwd();
      }
    } catch {
      resolvedCwd = process.cwd();
    }
    // ensure the active projectId is synced with this new terminal if requested
    if (projectId) {
      manager.ledger.activeProjectId = projectId;
      // also ensure the project exists, just in case
      if (!manager.ledger.getProject(projectId)) {
        manager.ledger.addProject(projectId, resolvedCwd, "", []);
      }
    }
    // G6: route the PTY spawn through the SAME capability gate the voice `create_pane` handler uses.
    // The broadcasts MOVE INSIDE spawnEffect so a deferred-then-confirmed spawn still repaints the UI
    // (the effect runs once via POST /api/actions/:id/confirm). Off -> 403, Ask -> 202+actionId,
    // Auto -> 200 + addTerminal result. (The projectId ledger-sync above stays before the gate,
    // matching the voice handler's "ensure the project exists" behavior — it mutates metadata, not a PTY.)
    const spawnEffect = (): string => {
      // Pass the NORMALIZED preset (not the raw client value) so runtimeType + the
      // --dangerously-skip-permissions append are decided identically to the voice path.
      const result = manager.addTerminal(terminalId, resolvedCwd, command, preset, permissionsMode, sessionId, projectId || "");
      broadcastLedgerUpdate();
      broadcast({ type: "terminals_updated" });
      return String(result);
    };
    const g = gateOrDefer("create_pane", terminalId, `Create pane ${terminalId} (${command})`, spawnEffect,
      // kzt: origin:"rest" -> the rebuild returns String(result) verbatim, matching spawnEffect above.
      // Persist the ALREADY-RESOLVED cwd so a confirm-after-restart lands the pane in the same dir.
      // The intent carries the DERIVED command + NORMALIZED preset for restart parity (matches voice).
      // PLM3: stamp the action identity+schema hash so a boot can quarantine a drifted def.
      { actionName: "create_pane", schemaHash: actionSchemaHash("create_pane") ?? undefined, origin: "rest", paneId: terminalId, cwd: resolvedCwd, command, toolPreset: preset, permissionsMode, sessionId, projectId: projectId || "" });
    const out = restGateOutcome(g);
    if (g.disposition === "run") out.body.result = spawnEffect(); // Auto: run now, return its result
    res.status(out.status).json(out.body);
  });

  // Web API to restart terminal node
  app.post("/api/terminals/:id/restart", async (req, res) => {
    const { id } = req.params;
    const term = manager.terminals[id];
    if (term) {
      // stop() is async (SIGTERM→SIGKILL escalation); await it so the dying PTY's onExit
      // fires BEFORE start() spawns the replacement, otherwise the late exit flips the
      // freshly-restarted pane to Exited and tears down its probe timer (zombie pane).
      await term.stop();
      term.start();
      broadcastLedgerUpdate();
      broadcastTerminalsUpdated();
      res.json({ success: true, message: `Terminal ${id} restarted.` });
    } else {
      const activeProject = manager.ledger.getActiveProject();
      const pane = activeProject?.panes[id];
      if (pane) {
        // U4 (wsm-e2e-pinned-ckf): derive the restart command from the persisted union via the
        // SAME presetCommand() helper the voice create_pane handler uses — one source of truth.
        // This kills the 'Claude Code'/'Codex'/'Antigravity' literal comparisons (the spot most
        // exposed to the id/name drift) and the hardcoded "bash" default; a director-renamed
        // binary (settings.presets[].command) is honored, and Custom -> the configured shell.
        const preset = normalizePreset(pane.tool_preset);
        const cmd = presetCommand(preset, manager.settings.presets, manager.settings.advanced?.defaultShellCommand);

        manager.addTerminal(id, activeProject!.directory || process.cwd(), cmd, preset, pane.permissions_mode, pane.session_id);
        broadcastLedgerUpdate();
        broadcastTerminalsUpdated();
        res.json({ success: true, message: `Terminal ${id} restored and started.` });
      } else {
        res.status(404).json({ error: "Terminal not found" });
      }
    }
  });

  // TWO-STAGE EMERGENCY STOP-ALL (bead 8sq, spec §2.C). Auth is enforced by
  // app.use("/api", authMiddleware) — the single shared director token. Always-allowed
  // (see stopAll/releaseStopAll): an emergency brake is never gated.
  //   POST /api/stop-all          -> Stage 1 (freeze + cancel in-flight; panes keep running).
  //   POST /api/stop-all/confirm  -> Stage 2 (hold-to-fire kill of running PTYs; only when frozen).
  //   POST /api/stop-all/release  -> clear the freeze (clean restore; matrix was never mutated).
  // GET the current freeze state so the client can restore the FROZEN banner on a fresh page load
  // (spec §2.C/§10.3 — "frozen survives a restart"; the flag is persisted in the durable kv).
  app.get("/api/stop-all/status", (_req, res) => {
    res.json({ frozen: coreState.frozen, running: coreState.frozen ? runningPaneIds() : [] });
  });
  app.post("/api/stop-all", async (_req, res) => {
    const running = await stopAll(false);
    res.json({ success: true, frozen: true, running });
  });
  app.post("/api/stop-all/confirm", async (_req, res) => {
    if (!coreState.frozen) {
      res.status(409).json({ success: false, error: "Not frozen — Stage 2 kill requires a prior Stage 1 freeze (POST /api/stop-all)." });
      return;
    }
    // QW4: await the kills so `killed` names panes that ACTUALLY stopped; `failed` (read right after
    // the await — single-threaded, no race) surfaces any kill that rejected.
    const killed = await stopAll(true);
    res.json({ success: true, killed, failed: coreState.lastStopAllFailed });
  });
  app.post("/api/stop-all/release", (_req, res) => {
    releaseStopAll();
    res.json({ success: true, frozen: false });
  });

  // Web API to write input command directly to terminal node (for broadcast or target manipulation)
  app.post("/api/terminals/:id/input", (req, res) => {
    const { id } = req.params;
    const { command } = req.body;
    if (command === undefined) {
      res.status(400).json({ error: "Missing command body parameter" });
      return;
    }
    const term = manager.terminals[id];
    if (term) {
      HistoryManager.getInstance().addCommand(id, command);
      term.writeInput(command);
      broadcastLedgerUpdate();
      res.json({ success: true, message: `Command successfully dispatched to terminal ${id}.` });
    } else {
      res.status(404).json({ error: "Terminal not found or offline" });
    }
  });

  // Web API to sync a pane's PTY grid to the operator's xterm viewport. The
  // program inside wraps to the PTY's column count, so this MUST track the
  // display or line wrapping diverges from a real terminal.
  app.post("/api/terminals/:id/resize", (req, res) => {
    const { id } = req.params;
    const cols = Number(req.body?.cols);
    const rows = Number(req.body?.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
      res.status(400).json({ error: "cols and rows must be positive numbers" });
      return;
    }
    const term = manager.terminals[id];
    if (!term) {
      res.status(404).json({ error: "Terminal not found or offline" });
      return;
    }
    manager.resize(id, cols, rows);
    res.json({ success: true });
  });

  // Web API to get terminal history
  app.get("/api/terminals/:id/history", (req, res) => {
    const { id } = req.params;
    const history = HistoryManager.getInstance().loadHistory(id);
    res.json(history);
  });

  // Web API to clear terminal history
  app.post("/api/terminals/:id/history/clear", (req, res) => {
    const { id } = req.params;
    HistoryManager.getInstance().saveHistory(id, []);
    res.json({ success: true, history: [] });
  });

  // Project and Pane management endpoints
  app.post("/api/projects", (req, res) => {
    const { id, directory, summary, keyTerms, name } = req.body;
    if (!id) {
      res.status(400).json({ error: "Missing required field: id" });
      return;
    }
    // G5: validate the caller-supplied directory before persisting it. A non-blank
    // dir that does not exist (or is a file) is rejected — storing it would later
    // taint a child pane's cwd and make node-pty throw "path not found". Blank/"."
    // resolves to the server cwd (valid intent preserved), never the literal ".".
    if (isBadProjectDir(directory)) {
      res.status(400).json({ error: `Project directory does not exist: ${String(directory).trim()}` });
      return;
    }
    const terms = Array.isArray(keyTerms) ? keyTerms : [];
    manager.ledger.addProject(id, resolveProjectDir(directory), summary || "", terms);
    if (name) {
      manager.ledger.renameProject(id, name);
    }
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  app.put("/api/projects/:id", (req, res) => {
    const { id } = req.params;
    const { directory, summary, keyTerms, name } = req.body;
    const ws = manager.ledger.getProject(id);
    if (ws) {
      if (directory !== undefined) ws.directory = directory;
      if (summary !== undefined) ws.summary = summary;
      if (keyTerms !== undefined) ws.keyTerms = Array.isArray(keyTerms) ? keyTerms : [];
      if (name !== undefined) ws.name = name;
      manager.ledger["save"](true);
      broadcastLedgerUpdate();
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Project context not found" });
    }
  });

  app.put("/api/projects/:id/rename", (req, res) => {
    const { name } = req.body;
    manager.ledger.renameProject(req.params.id, name);
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  app.post("/api/projects/:id/notes", (req, res) => {
    const { note } = req.body;
    manager.ledger.addNote(req.params.id, note);
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  // bead bjm: id-bearing notes feed for the UI (Node Chronicle delete/amend controls). This is a
  // DOM-render-only, operator-facing feed (server -> the trusted operator's browser), so it is NOT
  // redacted — redaction is a MODEL-egress guard; the VOICE tools redact, this feed does not. Do not
  // forward this raw text to the live session.
  app.get("/api/projects/:id/notes", (req, res) => {
    res.json({ notes: manager.ledger.getNotes({ projectId: req.params.id }) });
  });

  // bead bjm: operator-direct note edit/delete from the UI. Ungated (operator intent in their own
  // UI), consistent with the ungated POST note path above; the GATED path is the voice amend_note /
  // delete_note tools (which route through update_metadata).
  app.put("/api/notes/:id", (req, res) => {
    const { text } = req.body;
    if (typeof text !== "string") { res.status(400).json({ error: "Missing text" }); return; }
    manager.ledger.amendNote(req.params.id, text);
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  app.delete("/api/notes/:id", (req, res) => {
    manager.ledger.deleteNote(req.params.id);
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  app.put("/api/projects/:projectId/panes/:paneId/rename", (req, res) => {
    const { name } = req.body;
    manager.ledger.renamePane(req.params.projectId, req.params.paneId, name);
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  app.post("/api/projects/:projectId/panes/:paneId/notes", (req, res) => {
    const { note } = req.body;
    manager.ledger.addPaneNote(req.params.projectId, req.params.paneId, note);
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  // Step 6 / §4: add a layered context entry to a pane. Operator-typed entries land in the human
  // layer (authoritative steering); this is not a CLI write and is never gated.
  app.post("/api/projects/:projectId/panes/:paneId/context", (req, res) => {
    const { text, layer } = req.body;
    if (!text || typeof text !== "string") { res.status(400).json({ error: "Missing text" }); return; }
    const ok = layer === "model"
      ? manager.ledger.addModelContext(req.params.projectId, req.params.paneId, text, "operator-ui")
      : manager.ledger.addHumanContext(req.params.projectId, req.params.paneId, text);
    if (!ok) { res.status(404).json({ error: "Pane not found" }); return; }
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  app.put("/api/projects/:projectId/panes/:paneId/permissions", (req, res) => {
    const { permissions } = req.body;
    const { projectId, paneId } = req.params;
    
    // Update live terminal config
    const term = manager.terminals[paneId];
    if (term) {
      term.setPermissionsMode(permissions);
    }
    
    // Update ledger pane
    const ws = manager.ledger.getProject(projectId);
    if (ws && ws.panes[paneId]) {
      ws.panes[paneId].permissions_mode = permissions;
      manager.ledger["save"](); // use string to bypass bracket checks if needed
    }
    
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  // bead 8sq (spec §2.B / §5): set the per-pane capability-gate OVERRIDE map from the matrix editor's
  // per-pane scope. This is the UI sibling of the voice `set_capability_gate` tool, but the UI is the
  // deliberate place where LOOSENING is allowed (voice may only tighten — see the tool handler), so
  // this endpoint writes the operator-chosen map verbatim. Body: { capabilityGates: CapabilityGateMap }
  // (a full or partial override map; keys absent fall through to global). Persists to the ledger pane
  // and re-broadcasts so chips repaint from the new server-resolved posture.
  app.put("/api/projects/:projectId/panes/:paneId/capability-gates", (req, res) => {
    const { projectId, paneId } = req.params;
    const incoming = req.body?.capabilityGates;
    const ws = manager.ledger.getProject(projectId);
    const pane = ws?.panes?.[paneId];
    if (!pane) { res.status(404).json({ error: "Pane not found" }); return; }
    // Normalize: only valid {Auto|Ask|Off} entries survive; an empty map clears the override
    // (so the pane falls back to the global default rather than persisting a masking `{}`).
    const clean: CapabilityGateMap = {};
    let any = false;
    if (incoming && typeof incoming === "object") {
      for (const [k, v] of Object.entries(incoming)) {
        if (v === "Auto" || v === "Ask" || v === "Off") { (clean as any)[k] = v; any = true; }
      }
    }
    pane.capabilityGates = any ? clean : undefined;
    // Persist via updatePane (the durable path for BOTH backends): legacy Ledger keeps the full
    // PaneMeta in its JSON-backed map; the SQLite store writes the capability_gates column (schema
    // v4). A bare ledger.save() would be a SQLite no-op and silently drop the override.
    manager.ledger.updatePane(projectId, pane, true);
    if (store) {
      try {
        store.recordActivity({
          type: "permission_changed",
          project_id: projectId,
          pane_id: paneId,
          summary: `UI set per-pane gates for ${paneId} (${any ? Object.keys(clean).length : 0} override(s))`,
          payload: { action: "set_pane_gates", capabilityGates: any ? clean : null },
        });
      } catch { /* store optional */ }
    }
    broadcastLedgerUpdate();
    broadcastTerminalsUpdated();
    res.json({ success: true, capabilityGates: pane.capabilityGates ?? null });
  });

  app.post("/api/projects/:id/switch", (req, res) => {
    const { id } = req.params;
    manager.ledger.switchContext(id);
    manager.settings.projects.activeContext = id;
    const wsPath = manager.ledger.workspaces[id]?.directory || process.cwd();
    manager.settings.projects.localWorkspacePath = wsPath;
    manager.saveSettings();
    broadcastLedgerUpdate();
    res.json({ success: true, activeProjectId: manager.ledger.activeProjectId });
  });

  app.delete("/api/projects/:id", (req, res) => {
    const { id } = req.params;
    if (manager.ledger.workspaces[id]) {
      delete manager.ledger.workspaces[id];
      const remainingIds = Object.keys(manager.ledger.workspaces);
      if (manager.ledger.activeProjectId === id) {
        const nextId = remainingIds[0] || "default_project";
        if (!manager.ledger.workspaces[nextId]) {
          manager.ledger.addProject(nextId, process.cwd(), "Default workspace");
        }
        manager.ledger.switchContext(nextId);
        manager.settings.projects.activeContext = nextId;
        manager.settings.projects.localWorkspacePath = manager.ledger.workspaces[nextId]?.directory || process.cwd();
        manager.saveSettings();
      }
      manager.ledger["save"]();
      broadcastLedgerUpdate();
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Project workspace not found" });
    }
  });

  app.delete("/api/projects/:projectId/panes/:paneId", (req, res) => {
    const { projectId, paneId } = req.params;
    const term = manager.terminals[paneId];
    if (term) {
      term.stop();
      delete manager.terminals[paneId];
    }
    const ws = manager.ledger.getProject(projectId);
    if (ws && ws.panes[paneId]) {
      delete ws.panes[paneId];
      manager.ledger["save"]();
    }
    broadcastLedgerUpdate();
    broadcastTerminalsUpdated();
    res.json({ success: true });
  });

  // --- Terminal archive (recoverable "clear exited") ---

  // Archive all Exited panes in the active project (recoverable, not a hard delete).
  app.post("/api/terminals/clear-exited", (req, res) => {
    const activeId = manager.ledger.activeProjectId || undefined;
    // Stop+drop any live terminal objects for panes about to be archived.
    const ws = activeId ? manager.ledger.getProject(activeId) : null;
    if (ws) {
      for (const paneId of Object.keys(ws.panes)) {
        if (!ws.panes[paneId].alive && manager.terminals[paneId]) {
          manager.terminals[paneId].stop();
          delete manager.terminals[paneId];
        }
      }
    }
    const archived = manager.ledger.archiveExitedPanes(activeId);
    broadcastLedgerUpdate();
    broadcastTerminalsUpdated();
    res.json({ success: true, archived });
  });

  app.get("/api/archive", (req, res) => {
    const archived = manager.ledger.listArchived().map(a => ({
      pane_id: a.pane.pane_id,
      name: a.pane.name,
      project_id: a.project_id,
      tool_preset: a.pane.tool_preset,
      last_command: a.pane.last_command || "",
      archived_at: a.archived_at
    }));
    res.json({ archived });
  });

  app.post("/api/archive/:paneId/restore", (req, res) => {
    const { paneId } = req.params;
    const entry = manager.ledger.restoreArchivedPane(paneId);
    if (!entry) {
      res.status(404).json({ error: "Archived pane not found" });
      return;
    }
    broadcastLedgerUpdate();
    broadcastTerminalsUpdated();
    res.json({ success: true });
  });

  app.delete("/api/archive/:paneId", (req, res) => {
    const { paneId } = req.params;
    const ok = manager.ledger.deleteArchivedPane(paneId);
    if (!ok) {
      res.status(404).json({ error: "Archived pane not found" });
      return;
    }
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  // --- ORCHESTRATION PIPELINES & AUTOMATIONS ENDPOINTS ---
  const recipes = [
    {
      id: "full-stack-web",
      name: "Full-Stack Web App Suite",
      description: "Vite SPA client, Express backend router, and test watcher setup.",
      // startupCommand is SUGGESTED, not auto-run: panes always open a bare shell
      // (see /api/recipes/apply). The operator runs the suggestion explicitly so a
      // pane never starts doing work on its own ("always bare shell, never auto-run").
      panes: [
        { id: "pane_frontend", name: "SPA Frontend (Vite)", startupCommand: "npm run dev", preset: "Custom" as const, permissionsMode: "Human-in-the-Loop" as const },
        { id: "pane_api", name: "Proxy Router (Express Server)", startupCommand: "node server.ts", preset: "Custom" as const, permissionsMode: "Full Auto" as const },
        { id: "pane_tests", name: "Vitest Live Suite", startupCommand: "npm run test", preset: "Custom" as const, permissionsMode: "Read-Only" as const }
      ]
    },
    {
      id: "python-worker",
      name: "SQL Pipeline & background Queue",
      description: "FastAPI Web Engine with an RQ asynchronous background worker.",
      panes: [
        { id: "pane_fastapi", name: "Microservice Host (Uvicorn)", startupCommand: "uvicorn main:app --reload", preset: "Custom" as const, permissionsMode: "Human-in-the-Loop" as const },
        { id: "pane_worker", name: "Asynchronous Poll Task Queue", startupCommand: "python -m rq worker tasks_queue", preset: "Custom" as const, permissionsMode: "Full Auto" as const }
      ]
    }
  ];

  // 1. Attention alerting queue
  app.get("/api/attention", (req, res) => {
    res.json(manager.attentionQueue);
  });

  app.post("/api/attention/:id/dismiss", (req, res) => {
    const item = manager.attentionQueue.find(i => i.id === req.params.id);
    if (item) {
      item.dismissed = true;
      broadcast({ type: "attention_updated", queue: manager.attentionQueue });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Attention item not found" });
    }
  });

  app.post("/api/attention/clear", (req, res) => {
    manager.attentionQueue.forEach(i => i.dismissed = true);
    broadcast({ type: "attention_updated", queue: manager.attentionQueue });
    res.json({ success: true });
  });

  // 2. Watch automation rules
  app.get("/api/watch-rules", (req, res) => {
    res.json(manager.ledger.watchRules);
  });

  app.post("/api/watch-rules", (req, res) => {
    const { triggerTerminalId, triggerTransition, actionTerminalId, actionCommand, oneShot } = req.body;
    if (!triggerTerminalId || !triggerTransition || !actionTerminalId || !actionCommand) {
      res.status(400).json({ error: "Missing required rule parameters." });
      return;
    }
    const newRule = {
      id: "rule_" + Math.random().toString(36).substring(2, 11),
      triggerTerminalId,
      triggerTransition,
      actionTerminalId,
      actionCommand,
      enabled: true,
      oneShot: oneShot !== undefined ? oneShot : true
    };
    manager.ledger.watchRules.push(newRule);
    manager.ledger["save"](true);
    broadcast({ type: "watch_rules_updated", watchRules: manager.ledger.watchRules });
    res.json({ success: true, rule: newRule });
  });

  app.delete("/api/watch-rules/:id", (req, res) => {
    const idx = manager.ledger.watchRules.findIndex(r => r.id === req.params.id);
    if (idx !== -1) {
      manager.ledger.watchRules.splice(idx, 1);
      manager.ledger["save"](true);
      broadcast({ type: "watch_rules_updated", watchRules: manager.ledger.watchRules });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Rule not found." });
    }
  });

  // 3. Multi-step sequenced resumable plans
  app.get("/api/plans", (req, res) => {
    res.json(manager.ledger.plans);
  });

  app.post("/api/plans", (req, res) => {
    const { name, steps } = req.body;
    if (!name || !Array.isArray(steps)) {
      res.status(400).json({ error: "Missing name or steps checklist." });
      return;
    }
    const formattedSteps = steps.map((s: any, idx: number) => ({
      id: "step_" + idx,
      terminalId: s.terminalId,
      command: s.command,
      expectedTransition: s.expectedTransition || "idle",
      status: "pending" as const
    }));
    const newPlan = {
      id: "plan_" + Math.random().toString(36).substring(2, 11),
      name,
      steps: formattedSteps,
      currentStepIndex: 0,
      status: "idle" as const
    };
    manager.ledger.plans.push(newPlan);
    manager.ledger["save"](true);
    broadcast({ type: "plans_updated", plans: manager.ledger.plans });
    res.json({ success: true, plan: newPlan });
  });

  app.post("/api/plans/:id/execute", (req, res) => {
    const plan = manager.ledger.plans.find(p => p.id === req.params.id);
    if (plan) {
      plan.status = "running";
      plan.currentStepIndex = 0;
      plan.steps.forEach((s, idx) => s.status = idx === 0 ? "running" : "pending");
      const currentStep = plan.steps[0];
      
      const targetTerm = manager.terminals[currentStep.terminalId];
      if (targetTerm) {
        HistoryManager.getInstance().addCommand(currentStep.terminalId, currentStep.command);
        targetTerm.writeInput(currentStep.command);
        manager.ledger["save"](true);
        broadcast({ type: "plans_updated", plans: manager.ledger.plans });
        res.json({ success: true, message: `Running step 1 command on '${currentStep.terminalId}'.` });
      } else {
        plan.status = "paused";
        currentStep.status = "failed";
        manager.ledger["save"](true);
        broadcast({ type: "plans_updated", plans: manager.ledger.plans });
        res.status(400).json({ error: `Selected node '${currentStep.terminalId}' is currently offline.` });
      }
    } else {
      res.status(404).json({ error: "Plan not found." });
    }
  });

  app.delete("/api/plans/:id", (req, res) => {
    const idx = manager.ledger.plans.findIndex(p => p.id === req.params.id);
    if (idx !== -1) {
      manager.ledger.plans.splice(idx, 1);
      manager.ledger["save"](true);
      broadcast({ type: "plans_updated", plans: manager.ledger.plans });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Plan not found." });
    }
  });

  // 4. Recipes and templates
  app.get("/api/recipes", (req, res) => {
    res.json(recipes);
  });

  app.post("/api/recipes/apply", (req, res) => {
    const { recipeId } = req.body;
    const activeProjectId = manager.ledger.activeProjectId || "default_project";
    const proj = manager.ledger.getProject(activeProjectId);
    if (!proj) {
      res.status(404).json({ error: "No active workspace is registered." });
      return;
    }
    const recipe = recipes.find(r => r.id === recipeId);
    if (!recipe) {
      res.status(404).json({ error: "Recipe layout not found." });
      return;
    }
    // G6 + bri: mirror the voice `apply_orchestration_recipe` gate semantics EXACTLY by sharing the
    // pure planner (planRecipeApply). Off on apply_recipe forbids the WHOLE layout (403); otherwise
    // each spawn rides create_pane (Off -> blocked, Ask -> deferred, Auto -> spawn now). Each pane's
    // broadcast lives INSIDE spawnPane so a deferred-confirm repaints. Voice and REST now consume the
    // same planner so the Ask-tier behavior cannot drift again (the WF-2 divergence).
    // Keep one gateCapability call for the layout-level `apply_recipe` audit row (the planner is a pure
    // decision fn and emits none); its boolean veto is authoritative via plan.layoutForbidden below.
    gateCapability("apply_recipe", null);
    const plan = planRecipeApply(
      recipe.panes,
      new Set(Object.keys(manager.terminals)),
      () => effectiveCapabilityGateFor(null, "apply_recipe"),
      (id) => effectiveCapabilityGateFor(id, "create_pane"),
    );
    if (plan.layoutForbidden) {
      res.status(403).json({ error: "apply_recipe is gated Off; spawning template layouts is forbidden by policy.", capability: "apply_recipe" });
      return;
    }
    const paneById = new Map(recipe.panes.map(p => [p.id, p]));
    const spawned: string[] = [];
    const deferred: { paneId: string; actionId: string }[] = [];
    const blocked: string[] = [];
    for (const planned of plan.panes) {
      if (planned.disposition === "skip-existing") continue;
      if (planned.disposition === "block") { blocked.push(planned.paneId); continue; }
      const p = paneById.get(planned.paneId)!;
      // KS (§5.4): derive the recipe pane's launch command from its preset via the SAME single
      // home (presetCommand(normalizePreset(...))) instead of a hardcoded bare shell, so a
      // recipe-spawned agent pane inherits the same launch as voice/REST create_pane. The
      // startupCommand is still NEVER auto-run — only recorded as an auditable pane note.
      const panePreset = normalizePreset(p.preset);
      const paneCommand = presetCommand(panePreset, manager.settings.presets, manager.settings.advanced?.defaultShellCommand);
      const spawnPane = (): string => {
        manager.addTerminal(p.id, proj.directory || process.cwd(), paneCommand, panePreset, p.permissionsMode as any, "", activeProjectId);
        // Record the suggested startup command as a pane note so the operator can
        // run it explicitly (auditable), rather than baking it into the spawn.
        if (p.startupCommand) {
          manager.ledger.addPaneNote(activeProjectId, p.id, `Suggested startup command: ${p.startupCommand}`);
        }
        broadcastLedgerUpdate();
        broadcast({ type: "terminals_updated" });
        return p.id;
      };
      if (planned.disposition === "defer") {
        const g = gateOrDefer("create_pane", p.id, `Create pane ${p.id} (recipe ${recipe.id})`, spawnPane,
          // kzt: origin:"recipe" -> the rebuild returns the bare pane id, matching spawnPane above.
          // PLM3: stamp the action identity+schema hash so a boot can quarantine a drifted def.
          { actionName: "create_pane", schemaHash: actionSchemaHash("create_pane") ?? undefined, origin: "recipe", paneId: p.id, cwd: proj.directory || process.cwd(), command: paneCommand, toolPreset: panePreset, permissionsMode: p.permissionsMode, startupCommand: p.startupCommand, projectId: activeProjectId });
        if (g.disposition === "forbidden") blocked.push(p.id);
        else if (g.disposition === "deferred") deferred.push({ paneId: p.id, actionId: g.actionId });
        else { spawnPane(); spawned.push(p.id); }
      } else {
        spawnPane();
        spawned.push(p.id);
      }
    }
    res.json({ success: true, spawned, deferred, blocked });
  });

  // 5. Cross-pane context handoff
  app.post("/api/handoff", (req, res) => {
    const { sourcePaneId, targetPaneId, contextNotes } = req.body;
    const sourceTerm = manager.terminals[sourcePaneId];
    const targetTerm = manager.terminals[targetPaneId];
    if (!sourceTerm || !targetTerm) {
      res.status(400).json({ error: "Both source and target terminals must be active." });
      return;
    }
    const sourceHistory = HistoryManager.getInstance().loadHistory(sourcePaneId);
    const lastFiveOutlines = sourceHistory.map(h => `${h.command} -> ${h.finalResponse || "executed"}`).slice(-5).join(" | ");
    
    const activeProjectId = manager.ledger.activeProjectId || "default_project";
    const handoffNote = `Handoff from [${sourcePaneId}] with notes: ${contextNotes}. Last events: ${lastFiveOutlines}`;

    // Prompt-composer refactor: handoff carries CONTEXT, not commands. It writes to the target
    // pane's model-context layer (ungated, not a CLI write) and never injects into the target
    // pane's stdin. (architecture §5: Remove handoff stdin injection.)
    manager.ledger.addModelContext(activeProjectId, targetPaneId, handoffNote, "handoff");

    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  // Step 6 (the Workbench): per-pane WIP draft REST. Composing/editing a draft is not a CLI write.
  app.get("/api/panes/:projectId/:paneId/draft", (req, res) => {
    const draft = manager.ledger.getDraft(req.params.projectId, req.params.paneId)
      ?? { text: "", updatedAt: new Date().toISOString() };
    res.json({ draft });
  });

  app.put("/api/panes/:projectId/:paneId/draft", (req, res) => {
    const { text } = req.body;
    if (text === undefined) { res.status(400).json({ error: "Missing text field" }); return; }
    const ok = manager.ledger.setDraft(req.params.projectId, req.params.paneId, text, "operator");
    if (!ok) { res.status(404).json({ error: "Pane not found" }); return; }
    broadcastDraft(req.params.projectId, req.params.paneId);
    res.json({ success: true });
  });

  // The WIP register (the scalable part of "B"): every pane in a project with a non-empty draft,
  // so work composed for one pane is never lost when the operator switches to another.
  app.get("/api/projects/:projectId/drafts", (req, res) => {
    res.json({ drafts: manager.ledger.listDrafts(req.params.projectId) });
  });

  // Send the draft to its pane. This is an OPERATOR-DIRECT write (the operator is above the gate,
  // architecture §2): clicking Send IS the approval, so it writes immediately. The draft is then
  // cleared. Janus never calls this — it only fills the draft for the operator to send.
  app.post("/api/panes/:projectId/:paneId/draft/send", (req, res) => {
    const { projectId, paneId } = req.params;
    const text = (manager.ledger.getDraft(projectId, paneId)?.text ?? "").trim();
    if (!text) { res.status(400).json({ error: "Draft is empty." }); return; }
    const term = manager.terminals[paneId];
    if (!term) { res.status(400).json({ error: `Pane '${paneId}' is not live.` }); return; }
    HistoryManager.getInstance().addCommand(paneId, text);
    term.writeInput(text);
    broadcast({ type: "command_auto_executed", terminalId: paneId, cmd: redactSecrets(text) });
    manager.ledger.setDraft(projectId, paneId, "", "operator");
    broadcastDraft(projectId, paneId);
    res.json({ success: true });
  });

  app.get("/api/settings", (req, res) => {
    res.json(sanitizeSettingsForClient(manager.settings));
  });

  app.put("/api/settings", (req, res) => {
    const newSettings = req.body;
    if (newSettings.secrets && (newSettings.secrets.geminiApiKey?.includes("••••") || newSettings.secrets.geminiApiKey === "CONFIGURED_IN_ENV" || !newSettings.secrets.geminiApiKey)) {
      newSettings.secrets.geminiApiKey = manager.settings.secrets.geminiApiKey;
    }
    manager.updateSettings(newSettings);
    broadcast({
      type: "settings_updated",
      globalPermissionsMode: manager.globalPermissionsMode,
      settings: sanitizeSettingsForClient(manager.settings)
    });
    res.json({ success: true, settings: sanitizeSettingsForClient(manager.settings), globalPermissionsMode: manager.globalPermissionsMode });
  });

  // dec-4 (DBT5): the WS-E pending-approval store + the deferred-action store + their durable boot
  // hydration, effectiveModeFor / effectiveCapabilityGateFor / gateCapability / gateOrDefer, the
  // effective-posture surface (effectiveGatesForPane / posturePayloadForPane / allPanePostures /
  // broadcastTerminalsUpdated), the TWO-STAGE STOP-ALL brake (runningPaneIds / stopAll / killAllPanes /
  // releaseStopAll), reannounceSurvivors, the WS_EVT literals, flipHandoffOnResolve, and the single
  // resolve choke-point applyResolution all moved to src/gating/index.ts (constructed as `gating`
  // above; the bindings are destructured there). The REST approval/action routes below consume the
  // SAME pending stores via those destructured bindings.

  app.get("/api/commands/pending", (req, res) => {
    res.json(pendingApprovals.all().map((p) => serializePending(p)));
  });

  // G1: pending NON-PTY deferred actions (gated Ask) — list / confirm / cancel.
  app.get("/api/actions/pending", (_req, res) => {
    res.json(pendingActions.all().map((a) => ({ id: a.id, capability: a.capability, summary: a.summary, ageSeconds: Math.max(0, Math.floor((Date.now() - a.timestamp) / 1000)) })));
  });

  app.post("/api/actions/:id/confirm", (req, res) => {
    const { id } = req.params;
    if (!pendingActions.has(id)) { res.status(404).json({ error: "Pending action not found" }); return; }
    try {
      const result = pendingActions.confirm(id);
      if (result.reason === "lost_race") { res.json({ success: true, already: true }); return; }
      if (result.reason === "not_found") { res.status(404).json({ error: "Pending action not found" }); return; }
      broadcast({ type: "action_resolved", actionId: id, outcome: "confirmed" });
      res.json({ success: true, output: result.output });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/actions/:id/cancel", (req, res) => {
    const { id } = req.params;
    if (!pendingActions.has(id)) { res.status(404).json({ error: "Pending action not found" }); return; }
    const result = pendingActions.cancel(id);
    broadcast({ type: "action_resolved", actionId: id, outcome: "cancelled" });
    res.json({ success: true, already: result.reason === "lost_race" });
  });

  app.post("/api/commands/approve", (req, res) => {
    const { messageId, approved } = req.body;
    if (!pendingApprovals.has(messageId)) {
      res.status(404).json({ error: "Pending command not found" });
      return;
    }
    const action = applyResolution(messageId, approved ? "approve" : "reject");
    switch (action.reason) {
      case "not_found":
        res.status(404).json({ error: "Pending command not found" });
        return;
      case "dead_pane":
        res.status(422).json({ success: false, error: "target pane missing" });
        return;
      case "lost_race":
        res.json({ success: true, already: true });
        return;
      default:
        res.json({ success: true });
    }
  });

  // dec-4 (DBT5): sweepExpiredApprovals moved to src/gating/index.ts. Arm its TTL sweep interval here
  // (the inline `setInterval(sweepExpiredApprovals, APPROVAL_SWEEP_MS)` + .unref() this replaces) and
  // keep the returned handle so the close() handler can clearInterval it.
  const approvalSweepTimer = gating.startSweepTimer();

  // dec-5 (DBT5): the GEMINI LIVE VOICE SESSION — the entire `wss.on("connection", ...)` envelope
  // (the resumption-token persist/rehydrate, the per-connection live-session lifecycle, the gated
  // voice approval/dispatch path, the per-call ActionContext factory, the bounded auto-reconnect, and
  // the clientWs message/close handlers) — moved to src/voice/index.ts. attachVoiceSession wires the
  // connection handler onto `wss`; the ~20 per-connection mutable lets are an explicit per-connection
  // VoiceSessionState INSIDE the connection callback (never shared across connections). The whole
  // `gating` object is injected so voice destructures the SAME pending stores + resolver it shares with
  // the REST surface; pushApprovalNarration is the pure imported voice egress (gating gets the same one).
  attachVoiceSession(wss, {
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
    redact: redactSecrets,
    addCommand: (terminalId, command) => HistoryManager.getInstance().addCommand(terminalId, command),
    ai,
    boundLiveConnector,
    boundSessionAiFactory,
    gating,
    setLastInteractionId: (v) => { lastInteractionId = v; },
    pushApprovalNarration,
    REGISTRY,
    runAction,
    resultToToolResponse,
    toGeminiDeclarations,
    API_AUTH_TOKEN,
    getCookie,
  });

  // ── REST surface, DERIVED from the registry (cv/PLM2). One ActionContext per request, session:null
  // (the result maps to HTTP, not a Gemini sendToolResponse). The pane-WRITE choke-point
  // (dispatchProposal) is connection-scoped and intentionally a refusing stub here — the only routes
  // we mount are read-only observability tools, which never call it. The `only` allow-set scopes the
  // mount so it never collides with the existing hand-written routes; it grows as cv1 converges reads.
  function buildRestActionContext(req: RestRequest): ActionContext {
    // PLM4 (3): synthesize a STABLE per-request idempotency key for the REST surface (REST has no
    // Gemini call.id). The key is a hash of the action name + the request shape (params/query/body),
    // so an identical retried request maps to the same key while distinct requests stay unique. Pure
    // + best-effort: a hashing fault falls back to null (no key recorded, never blocks the request).
    const restIdempotencyKey = (name: string): string | null => {
      try {
        const material = JSON.stringify({ name, params: req.params ?? {}, query: req.query ?? {}, body: req.body ?? {} });
        return "rest:" + crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
      } catch { return null; }
    };
    return {
      manager,
      session: null,
      callId: undefined,
      trigger: "rest",
      surface: "rest",                          // explicit dispatch-surface token (action_log)
      userUtterance: "",
      broadcast,
      broadcastLedgerUpdate,
      gateOrDefer,
      dispatchProposal: (() => ({ kind: "error", text: "pane-write is not available on the REST surface" })) as ActionContext["dispatchProposal"],
      gateCapability,
      redact: redactSecrets,
      getActivePaneId: () => coreState.activePaneId,
      setActivePane: (id) => { coreState.activePaneId = id; },
      activeDraftTarget,
      broadcastDraft,
      broadcastTerminalsUpdated,
      effectiveCapabilityGateFor,
      pruneAttention,
      pendingApprovals,
      applyResolution,
      store,
      sanitizeSettingsForClient,
      recipes: recipes as ActionContext["recipes"],
      stopAll,
      releaseStopAll,
      isFrozen: () => coreState.frozen,
      audit: (row) => {
        if (!store) return;
        let argsRedacted: string | null = null;
        try { argsRedacted = row.args === undefined ? null : redactSecrets(JSON.stringify(row.args)); }
        catch { argsRedacted = null; }
        try {
          store.recordAction({
            name: row.name, capability: row.capability, result_kind: row.resultKind,
            ms: row.ms, args_redacted: argsRedacted, surface: row.surface ?? "rest",
            idempotency_key: restIdempotencyKey(row.name),
          });
        } catch { /* best-effort */ }
      },
    };
  }
  // Mount the registry-derived REST twins. cv1 adds the six session-independent read twins
  // (collision-free new paths) alongside the observability reads (/api/action-log + /api/health):
  //   get_pane_summary -> GET /api/panes/:pane_id/summary
  //   get_pane_command_history -> GET /api/panes/:pane_id/history
  //   get_pane_gates -> GET /api/panes/:pane_id/gates
  //   list_capabilities -> GET /api/capabilities
  //   list_handoffs -> GET /api/handoffs
  //   read_handoff -> GET /api/handoffs/:handoff_id
  mountRestRoutes(app as unknown as RestApp, REGISTRY, buildRestActionContext, {
    only: new Set([
      "get_action_log",
      "get_health",
      "get_pane_summary",
      "get_pane_command_history",
      "get_pane_gates",
      "list_capabilities",
      "list_handoffs",
      "read_handoff",
    ]),
  });

  // Vite middleware for development (dynamically imported so tests / production
  // bundles that disable it don't need vite resolvable at module load).
  if (enableVite) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (process.env.NODE_ENV === "production") {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const close = async (): Promise<void> => {
    announcementBus.stop(); // WS-D: clear coalescing/rate-limit timers
    clearInterval(approvalSweepTimer); // WS-E.3: clear the TTL sweep
    for (const term of Object.values(manager.terminals)) {
      try {
        await term.stop();
      } catch (err) {
        console.error(`Error stopping terminal ${term.terminalId}:`, err);
      }
    }
    // Force every live WS client + lingering keep-alive socket to CLOSED before we
    // resolve. Otherwise wss/server.close() leave half-closed libuv handles in the
    // CLOSING state; a subsequent process.exit (e.g. the unit runner's
    // --test-force-exit) then double-closes them and aborts (UV_HANDLE_CLOSING).
    for (const ws of wss.clients) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // NOTE: we deliberately do NOT close the JanusStore here. It is a process-wide singleton shared
    // by every startServer() call (see the `process.once("exit", ...)` handler near its creation);
    // closing it per-server would break sibling in-process servers (the test_live_harness flake).
  };

  const shutdown = async () => {
    console.log("Shutting down cleanly, stopping all terminals...");
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const bindHost = options.bindHost ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  const requestedPort = options.port ?? PORT;

  if (shouldListen) {
    await new Promise<void>((resolve) => {
      server.listen(requestedPort, bindHost, () => {
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : requestedPort;
        console.log(`Server running on http://${bindHost}:${boundPort}`);
        resolve();
      });
    });
  }

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : requestedPort;

  return {
    app, server, wss, manager, port, close,
    _testActiveLiveSession: () => coreState.activeLiveSession,
    _testPendingApprovals: () => pendingApprovals,
    _testClients: () => coreState.clients,
  };
}

export { startServer };

// Auto-start when run as the entrypoint (`tsx server.ts` in dev or
// `node dist/server.cjs` in prod). Tests and the offline simulator set
// JANUS_NO_AUTOSTART=1 before importing so they can own the server lifecycle.
// (An env flag rather than import.meta/require.main detection because esbuild
// bundles this to CJS, where import.meta is empty.)
if (process.env.JANUS_NO_AUTOSTART !== "1") {
  startServer().catch(console.error);
}
