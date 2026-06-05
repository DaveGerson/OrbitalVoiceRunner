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
  resolveDecision,
  resolveCapabilityGateWithContext,
  isLoosening,
  isStagedStale,
  inferKind,
  loadShellAllowlist,
  serializePending,
  decideSweepAction,
  renderResumptionLine,
  applyFrozenShortCircuit,
  APPROVAL_GRACE_MS,
  type ApprovalKind,
  type EffectiveMode,
  type PendingApproval,
  type ResolveMode,
  type ResolveReason,
} from "./src/pendingApprovals";
import { parseApprovalIntent, selectApprovalTarget } from "./src/approvalIntent";
import { shouldRouteUtterance, resolvePendingActionByVoice } from "./src/voiceApprovalRouting";
import { isPaneActiveForWrite, inactivePaneClarify } from "./src/activePane";
import { JanusStore } from "./src/store/sqliteStore";
import { deliverOutcomeToHandoff, applyHandoffFlipOnResolve, type HandoffResolveReason } from "./src/handoffFlow";
import { PendingActionStore } from "./src/pendingActions";
import { buildActionRun, checkActionVersion } from "./src/actionEffects";
import { resolveActionPendingPosture, type GlobalMode } from "./src/actionPendingPayload";
import { restGateOutcome } from "./src/restGate";
import { planRecipeApply } from "./src/recipeApply";
import { migrateOnBootIfNeeded } from "./src/store/migrate";
import type { GateValue, CapabilityGate, CapabilityGateMap } from "./src/types";
import { deriveEffectiveGates, derivePostureWord, ALL_CAPABILITIES, type EffectiveMode as GateSurfaceMode } from "./src/gateSurface";
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

  // WS-E: the spoken/targeted/safe pending-approval store. The serializable record +
  // session side-map + ordered index + claim flag live in PendingApprovalStore so WS-F can
  // add durability/atomicity without a rewrite (see src/pendingApprovals.ts §8).
  // WS-M (bead wsm-e2e-pinned-nzt): inject the durable JanusStore so pending approvals SURVIVE a
  // process restart, while the N-1 atomic-claim gate is backed by the durable SQL claim. When the
  // store is null (JANUS_LEDGER_BACKEND=legacy or store init failed) the class is pure in-memory,
  // byte-for-byte as before — no behavioral change on the legacy path.
  const pendingApprovals = new PendingApprovalStore(store);
  // G1: deferred execution for gated NON-PTY mutators (create_pane / set_*_permissions /
  // update_metadata). On the Ask tier these stage a side-effect here and run exactly once on operator
  // confirm — separate from the pane-write PendingApprovalStore so the two never entangle.
  // (src/pendingActions.)
  // kzt (wsm-e2e-pinned-kzt): inject the durable JanusStore so a deferred action SURVIVES a process
  // restart. The run() closure is non-serializable, so add() persists the action's INTENT
  // (capability + params); the boot loop below rebuilds run() via buildActionRun. store===null
  // (JANUS_LEDGER_BACKEND=legacy / store init failed) => pure in-memory, byte-for-byte as before.
  const pendingActions = new PendingActionStore(store);
  let pendingActionSeq = 0;

  // kzt: rebuild deferred-action survivors from durable intent. The run() closure is non-serializable,
  // so we persisted the INTENT (capability+params) and rebuild it here, bound to the LIVE manager/
  // broadcast (a deserialized closure could never re-bind them — they are fresh in this startServer()
  // closure). Re-staging via add() carries the existing durable row (INSERT OR REPLACE is a no-op
  // rewrite) and makes the survivor confirmable/cancellable exactly as before the restart. Hydration
  // only REBUILDS + re-stages run; it never INVOKES it (effects run on explicit confirm only). This
  // runs AFTER manager + pendingActions are built and BEFORE the first WS connection / sweep tick.
  for (const row of pendingActions.hydrateIntents()) {
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(row.params); } catch { /* corrupt -> empty params; run() degrades gracefully */ }
    const versionCheck = checkActionVersion({
      actionName: (params as { actionName?: string }).actionName,
      schemaHash: (params as { schemaHash?: string }).schemaHash,
    });
    if (!versionCheck.ok) {
      // PLM3: the staged def drifted (renamed/moved/reshaped) or is unstamped/legacy -> do NOT blindly
      // rebuild+replay it against a possibly-mismatched effect. Quarantine: skip re-staging; record it
      // so the operator can re-issue. (A future boot-prune sweep removes quarantined rows.)
      if (store) {
        try {
          store.recordActivity({
            type: "permission_changed", project_id: "default_project", pane_id: null,
            summary: `QUARANTINED deferred ${row.capability} (${versionCheck.reason}): ${row.summary}`,
            payload: { capability: row.capability, action: "quarantined", reason: versionCheck.reason, action_id: row.id },
          });
        } catch { /* audit best-effort */ }
      }
      continue;
    }
    const run = buildActionRun(
      { capability: row.capability, params },
      { manager, broadcast, broadcastLedgerUpdate, sanitizeSettingsForClient },
    );
    pendingActions.add({
      id: row.id, capability: row.capability, summary: row.summary, params,
      timestamp: row.timestamp, run, ttlMs: Math.max(0, row.expires_at - row.timestamp),
    });
    if (store) {
      try {
        store.recordActivity({
          type: "permission_changed", project_id: "default_project", pane_id: null,
          summary: `REHYDRATED deferred ${row.capability}: ${row.summary}`,
          payload: { capability: row.capability, action: "rehydrated", action_id: row.id },
        });
      } catch { /* audit is best-effort */ }
    }
  }
  // R1/R2: read-only first-token allowlist for kind:"shell" (operator-overridable via env).
  const shellAllowlist = loadShellAllowlist();
  // WS-E.3 (BUG-019): TTL for an unresolved approval before it auto-rejects.
  const APPROVAL_TTL_MS = 5 * 60 * 1000;
  const APPROVAL_SWEEP_MS = 30 * 1000;

  // R3: a fresh client-content push delivers the spoken read-back / resolution result. The
  // original call.id is consumed once by the non-blocking pending_approval response, so the
  // outcome cannot be a 2nd sendToolResponse — it is an ephemeral interactive turn.
  // M3: single-source effective-mode resolution. `globalPermissionsMode === "Inherit"` defers to
  // the pane's own mode (HiTL default when the pane is unknown); otherwise the global override
  // wins. Used by EVERY write path (dispatchProposal + handoff_context) so "gate a new write" =
  // resolve the mode here, never re-derive it inline.
  function effectiveModeFor(targetId: string): EffectiveMode {
    if (manager.globalPermissionsMode === "Inherit") {
      const term = manager.terminals[targetId];
      return (term ? term.permissionsMode : "Human-in-the-Loop") as EffectiveMode;
    }
    return manager.globalPermissionsMode as EffectiveMode;
  }

  // Capability-gate resolution (design §3) with the SPOTLIGHT (director posture 2026-06-01:
  // "trust follows focus"). Precedence: explicit per-pane override > spotlight (active pane +
  // productive capability => Auto) > global default > Auto. The gate is AND-composed with
  // effectiveMode inside decideProposal (a gate only TIGHTENS the mode). Resolution itself is the
  // pure, unit-tested resolveCapabilityGateWithContext — keep this in lockstep with that function.
  function effectiveCapabilityGateFor(paneId: string | null | undefined, capability: CapabilityGate): GateValue {
    const globalGates = manager.settings.advanced?.capabilityGates;
    let paneGate: GateValue | undefined;
    if (paneId) {
      const proj = manager.ledger.getActiveProject();
      paneGate = proj?.panes?.[paneId]?.capabilityGates?.[capability];
    }
    const isActivePane = !!paneId && coreState.activePaneId === paneId;
    const resolved = resolveCapabilityGateWithContext(paneGate, globalGates?.[capability], capability, isActivePane);
    // STOP-ALL Stage-1: the ONE place the `frozen` short-circuit is applied. While frozen every
    // capability resolves Off; the matrix above is untouched, so Release re-exposes it exactly.
    return applyFrozenShortCircuit(coreState.frozen, resolved);
  }

  // Lightweight capability guard for mutating handlers that do NOT write to a pane PTY
  // (create_pane, set_pane_permissions, set_global_permissions, add_watch_rule, apply_recipe).
  // These have no in-flight writeInput to defer, so the gate semantics are:
  //   Off  -> forbidden (the safety-critical veto): returns a blocked result, no side effect.
  //   Ask  -> proceed but flag `requiresConfirm` so the handler narrates "confirm?" to the
  //           operator (v1: the side effect is applied and audited; full deferred-execution is
  //           WS-F — see openQuestions). Off is the hard guarantee here.
  //   Auto -> proceed silently.
  // Returns null when allowed (caller proceeds), or a {forbidden} object the caller renders.
  function gateCapability(capability: CapabilityGate, paneId: string | null): { forbidden: boolean; gate: GateValue } {
    const gate = effectiveCapabilityGateFor(paneId, capability);
    if (store) {
      const activeProjectId = manager.ledger.activeProjectId || "default_project";
      try {
        store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: paneId ?? null, summary: `capability ${capability} gate=${gate}`, payload: { capability, gate, action: "exercise" } });
      } catch { /* audit is best-effort */ }
    }
    return { forbidden: gate === "Off", gate };
  }

  // G1: gate a NON-PTY mutator with full Auto/Ask/Off semantics. Unlike gateCapability (which only
  // enforced the Off veto and let Ask proceed), this DEFERS the side effect on Ask by staging
  // `run` in pendingActions; the operator confirms via POST /api/actions/:id/confirm and the effect
  // runs exactly once. Returns the disposition so the handler can answer the model appropriately.
  //   { disposition: "run" }      -> Auto: caller invokes the effect now.
  //   { disposition: "forbidden"} -> Off:  caller refuses.
  //   { disposition: "deferred", actionId, summary } -> Ask: effect staged; caller tells the model
  //                                it is awaiting operator confirmation (no side effect yet).
  function gateOrDefer(
    capability: CapabilityGate,
    paneId: string | null,
    summary: string,
    run: () => string,
    // kzt (wsm-e2e-pinned-kzt): the serializable INTENT params the `run` closure captured. When
    // present (and a durable store is wired), pendingActions.add() persists them so the deferred
    // action survives a restart; the boot loop rebuilds `run` from them via buildActionRun. Keep
    // these keys in LOCKSTEP with the per-capability param shapes in src/actionEffects.ts.
    params?: Record<string, unknown>,
    // rbh (wsm-e2e-pinned-rbh): the mode the operator asked for, passed STRUCTURALLY by the two
    // permission handlers (never parsed from the summary — R5). Forwarded to the confirm dialog as
    // `requested_mode` so it can render a divergence "heads up" when the engine resolves tighter.
    // Non-permission capabilities (create_pane) pass nothing → no mode rider.
    requestedMode?: string
  ): { disposition: "run" } | { disposition: "forbidden" } | { disposition: "deferred"; actionId: string; summary: string } {
    const gate = effectiveCapabilityGateFor(paneId, capability);
    const activeProjectId = manager.ledger.activeProjectId || "default_project";
    if (gate === "Off") {
      if (store) { try { store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: paneId ?? null, summary: `FORBIDDEN ${capability}: ${summary}`, payload: { capability, gate, action: "forbidden" } }); } catch {} }
      return { disposition: "forbidden" };
    }
    if (gate === "Ask") {
      const actionId = `act_${Date.now()}_${pendingActionSeq++}`;
      pendingActions.add({ id: actionId, capability, summary, params, timestamp: Date.now(), run });
      if (store) { try { store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: paneId ?? null, summary: `DEFERRED ${capability} (await confirm): ${summary}`, payload: { capability, gate, action: "deferred", action_id: actionId } }); } catch {} }
      // rbh: enrich the confirm-dialog payload with the EFFECTIVE posture the engine WILL apply, not
      // the nominal summary. paneId may be null for global actions (D2) — then we surface the resolved
      // global mode + the global effective gate, no per-pane chip. The RESOLUTION is the pure
      // resolveActionPendingPosture (src/actionPendingPayload) — the same override→spotlight→global
      // precedence the chip uses (D1, server is the only authority), frozen-overlaid so the dialog
      // matches the chip while STOP-ALL is engaged. It is extracted so the divergence truth (global
      // Read-Only + pane Full Auto ⇒ LOCKED/Read-Only) is asserted at its SOURCE in
      // tests/test_action_pending_payload.ts, not just rendered from a hand-fed mock.
      const proj = manager.ledger.getActiveProject();
      const targetTerm = paneId ? manager.terminals[paneId] : undefined;
      const posture = resolveActionPendingPosture({
        paneId,
        capability,
        globalMode: manager.globalPermissionsMode as GlobalMode,
        paneMode: targetTerm ? (targetTerm.permissionsMode as EffectiveMode) : undefined,
        paneGates: paneId ? proj?.panes?.[paneId]?.capabilityGates : undefined,
        globalGates: manager.settings.advanced?.capabilityGates,
        isActivePane: !!paneId && coreState.activePaneId === paneId,
        frozen: coreState.frozen,
      });
      broadcast({
        type: "action_pending", actionId, capability, summary,
        pane_id: paneId,
        effective_gate: posture.effective_gate,
        effective_mode: posture.effective_mode,
        ...(posture.posture ? { posture: posture.posture } : {}),
        ...(posture.effective_gates ? { effective_gates: posture.effective_gates } : {}),
        ...(requestedMode ? { requested_mode: requestedMode } : {}),
        global_override: manager.globalPermissionsMode !== "Inherit",
      });
      return { disposition: "deferred", actionId, summary };
    }
    // Auto
    return { disposition: "run" };
  }

  // ── EFFECTIVE-POSTURE SERVER TRUTH (bead 8sq, spec §3 item 1 / §5) ─────────────────────────────
  // The chips + popover render from SERVER truth — never client policy re-derivation. We resolve
  // the 16 effective gate values + the derived posture word per pane here (reusing the pure
  // gateSurface) and expose them in /api/terminals AND the terminals_updated broadcast. The frozen
  // short-circuit is reflected because effectiveCapabilityGateFor (which deriveEffectiveGates mirrors)
  // already returns Off while frozen — but deriveEffectiveGates is pure (no `frozen` arg), so we
  // overlay the same applyFrozenShortCircuit here to keep the surface in lockstep with the resolver.
  function effectiveGatesForPane(paneId: string): Record<CapabilityGate, GateValue> {
    const globalGates = manager.settings.advanced?.capabilityGates;
    const proj = manager.ledger.getActiveProject();
    const paneGates = proj?.panes?.[paneId]?.capabilityGates;
    const isActivePane = coreState.activePaneId === paneId;
    const base = deriveEffectiveGates(paneGates, globalGates, isActivePane);
    if (!coreState.frozen) return base;
    // Frozen overlay — mirror the resolver's single-choke-point short-circuit on the surface.
    const out = {} as Record<CapabilityGate, GateValue>;
    for (const cap of ALL_CAPABILITIES) out[cap] = applyFrozenShortCircuit(true, base[cap]);
    return out;
  }
  function posturePayloadForPane(paneId: string): { id: string; effective_gates: Record<CapabilityGate, GateValue>; posture: ReturnType<typeof derivePostureWord> } {
    const effective = effectiveGatesForPane(paneId);
    const mode = effectiveModeFor(paneId) as GateSurfaceMode;
    return { id: paneId, effective_gates: effective, posture: derivePostureWord(effective, mode) };
  }
  function allPanePostures() {
    return Object.keys(manager.terminals).map((id) => posturePayloadForPane(id));
  }
  // Single helper so every pane-state mutation broadcasts the SAME shape: a terminals_updated frame
  // carrying the per-pane posture payload (chips repaint from this without a /api/terminals refetch).
  function broadcastTerminalsUpdated() {
    broadcast({ type: "terminals_updated", postures: allPanePostures() });
  }

  // ── TWO-STAGE EMERGENCY STOP-ALL (bead 8sq, spec §2.C / §3) ───────────────────────────────────
  //
  // DELIBERATELY UNGATED — these are the ONE set of paths that do NOT route through
  // gateOrDefer/effectiveCapabilityGateFor, and that is correct, not a regression. Capability
  // gates only ever TIGHTEN; the stop-all brake is the inverse (de-escalation / withdrawing
  // autonomy). A gate set to Off must never be able to FORBID an emergency halt — that would
  // defeat the gate's own safety purpose. So an always-allowed brake is consistent with the gate
  // model, not a bypass of it. (Mirrors the directional precedent in set_capability_gate: voice may
  // always TIGHTEN/de-escalate, never LOOSEN.) Single source of truth shared by REST, WS, voice.
  function runningPaneIds(): string[] {
    return Object.entries(manager.terminals)
      .filter(([, term]) => term.status !== "Exited") // union: 'Running'|'Exited'|'Idle'
      .map(([id]) => id);
  }

  /**
   * STOP-ALL stage routine.
   *   Stage 1 (kill=false): set+persist `frozen` (gate resolver now short-circuits every capability
   *     to Off), then CANCEL EVERYTHING IN-FLIGHT — reject all pending approvals (expire), expire all
   *     deferred actions, halt running plans (paused) + enabled watch-rules (disabled). PANES AND
   *     THEIR PTYs KEEP RUNNING (spec §2.C) — the freeze is reversible; only Release clears it.
   *   Stage 2 (kill=true): terminate each running pane PTY via the existing term.stop() primitive.
   *     The deliberate, irreversible step; valid only after a Stage-1 freeze.
   * Returns the still-running pane ids (Stage 1) or the killed pane ids (Stage 2).
   * QW4 (bead qw4): Stage 2 is now ASYNC and AWAITS the kills (Promise.allSettled), so the returned
   * killed[] names panes that ACTUALLY stopped — not merely the panes we asked to kill. Panes whose
   * stop() rejects are excluded from killed[] and surfaced separately (see killAllPanes / broadcast).
   */
  async function stopAll(kill: boolean): Promise<string[]> {
    if (!kill) {
      coreState.setFrozen(true);
      // Cancel in-flight: reject every pending approval (expire path = no write, claim+delete).
      for (const p of [...pendingApprovals.all()]) applyResolution(p.messageId, "expire");
      // Expire every deferred non-PTY action (no side effect runs).
      for (const a of [...pendingActions.all()]) pendingActions.expire(a.id);
      // Halt running plans + enabled watch-rules (passive co-pilot state, no pane writes).
      let ledgerChanged = false;
      for (const plan of manager.ledger.plans) {
        if (plan.status === "running") { plan.status = "paused"; ledgerChanged = true; }
      }
      for (const rule of manager.ledger.watchRules) {
        if (rule.enabled) { rule.enabled = false; ledgerChanged = true; }
      }
      if (ledgerChanged) {
        manager.ledger["save"]?.(true);
        broadcast({ type: "plans_updated", plans: manager.ledger.plans });
        broadcast({ type: "watch_rules_updated", watchRules: manager.ledger.watchRules });
      }
      const stillRunning = runningPaneIds();
      if (store) {
        try {
          store.recordActivity({
            type: "permission_changed",
            project_id: manager.ledger.activeProjectId || "default_project",
            pane_id: null,
            summary: `STOP_ALL Stage 1: froze Janus + cancelled in-flight (${stillRunning.length} pane(s) still running)`,
            payload: { action: "stop_all_freeze", running: stillRunning },
          });
        } catch { /* store optional */ }
      }
      broadcast({ type: "frozen", frozen: true, running: stillRunning });
      broadcastTerminalsUpdated();
      return stillRunning;
    }
    // Stage 2: kill the PTYs. QW4 — AWAIT every stop() (Promise.allSettled, mirroring close()'s
    // awaited per-term stop) so we report panes that ACTUALLY stopped, not the ones we asked to.
    const { killed, failed } = await killAllPanes();
    if (store) {
      try {
        store.recordActivity({
          type: "permission_changed",
          project_id: manager.ledger.activeProjectId || "default_project",
          pane_id: null,
          summary: `STOP_ALL Stage 2: killed ${killed.length} pane PTY(s)${failed.length ? `; ${failed.length} kill(s) FAILED` : ""}`,
          payload: { action: "stop_all_kill", panes: killed, failed },
        });
      } catch { /* store optional */ }
    }
    coreState.lastStopAllFailed = failed; // QW4: surfaced to the REST confirm route (read right after the await).
    broadcast({ type: "stop_all", killed, failed });
    broadcastTerminalsUpdated();
    return killed;
  }

  /**
   * QW4 (bead qw4): the awaited Stage-2 kill primitive. Asks every non-Exited pane to stop(), AWAITS
   * all of them (Promise.allSettled — one failing kill must not abort the rest), and partitions the
   * outcome: `killed` = panes whose stop() FULFILLED; `failed` = panes whose stop() REJECTED. The
   * fire-and-forget loop this replaces reported the asked-to-kill set, which lied when a kill failed.
   */
  async function killAllPanes(): Promise<{ killed: string[]; failed: string[] }> {
    const targets = Object.entries(manager.terminals).filter(([, term]) => term.status !== "Exited");
    const results = await Promise.allSettled(targets.map(([, term]) => Promise.resolve(term.stop())));
    const killed: string[] = [];
    const failed: string[] = [];
    results.forEach((r, i) => {
      const id = targets[i][0];
      if (r.status === "fulfilled") killed.push(id);
      else { failed.push(id); console.error(`[STOP-ALL] kill ${id} failed:`, r.reason); }
    });
    return { killed, failed };
  }

  /** Clear the freeze (Release). The matrix was never mutated, so this is a clean clear. */
  function releaseStopAll(): void {
    coreState.setFrozen(false);
    if (store) {
      try {
        store.recordActivity({
          type: "permission_changed",
          project_id: manager.ledger.activeProjectId || "default_project",
          pane_id: null,
          summary: "STOP_ALL released: freeze cleared, matrix restored",
          payload: { action: "stop_all_release" },
        });
      } catch { /* store optional */ }
    }
    broadcast({ type: "frozen", frozen: false });
    broadcastTerminalsUpdated();
  }

  function pushApprovalNarration(session: any, text: string) {
    try {
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: `SYSTEM EVENT (say this to the operator, then stop): ${text}` }] }],
        turnComplete: true,
      });
    } catch (e) {
      console.error("Failed to push approval narration to session:", e);
    }
  }

  // WS-F reconnect digest (spec §6.2/§7): "welcome back — here's what you left in progress."
  // After a fresh live session is established, re-attach every orphaned approval (a survivor whose
  // handle was nulled by detachSession on the prior disconnect, OR a restart-hydrated row) to THIS
  // session — opening a fresh TTL window — then speak ONE batched digest across approvals + pending
  // actions and broadcast so the UI chips repopulate the FULL list. Survivors stay UN-APPROVED
  // (re-require approval): the digest only re-surfaces them for a conscious yes; nothing auto-fires.
  function reannounceSurvivors(session: any) {
    const now = Date.now();
    // (1) Re-attach every orphan approval to the freshly-connected session (fresh TTL window,
    // lastCallAt cleared). pendingActions have no session binding — they survive in-process untouched.
    for (const orphan of pendingApprovals.orphans()) {
      pendingApprovals.reattachSession(orphan, session, now + APPROVAL_TTL_MS);
    }
    // (2) Collect the survivors: re-attached approvals (now bound to this session) + ALL pending
    // actions (not session-bound, spec §6.2 includes them all). Build ONE digest line per item.
    const approvals = pendingApprovals.forSession(session);
    const actions = pendingActions.all();
    type Survivor = { line: string; ts: number };
    const survivors: Survivor[] = [
      ...approvals.map((a) => ({ line: renderResumptionLine(a, now), ts: a.timestamp })),
      ...actions.map((a) => ({ line: `${a.capability}: ${redactSecrets(a.summary)}`, ts: a.timestamp })),
    ];
    if (survivors.length === 0) return; // (spec §7) zero survivors -> SILENT.

    // (3) Most-recent first; speak up to 3, summarize the rest (spec §7). UI shows the full list.
    survivors.sort((x, y) => y.ts - x.ts);
    const total = survivors.length;
    const shown = survivors.slice(0, 3).map((s) => s.line);
    let digest: string;
    if (total === 1) {
      digest = `Welcome back — one action still waiting: ${shown[0]}. Approve, or has this moved on?`;
    } else if (total <= 3) {
      digest = `Welcome back — ${total} actions waiting from before: ${shown.join("; ")}. Which first?`;
    } else {
      digest = `Welcome back — ${total} actions waiting from before: ${shown.join("; ")}; …and ${total - 3} more, all in your queue.`;
    }
    pushApprovalNarration(session, digest);
    // (4) Repopulate the UI chips for the FULL list (the spoken cap is 3; the UI is not capped).
    broadcastTerminalsUpdated();
  }

  // M4: the approval-related WS-event `type:` literals, named in one place. NOTE: the frontend
  // (ApprovalDialog.tsx) keys on these EXACT strings — do NOT rename the values without changing
  // the client. The `command_auto_executed` payload has two boolean variants the UI relies on:
  //   - `approved: true`  -> operator-APPROVED a HiTL command (REST or voice) — not auto-run.
  //   - `vocal: true`     -> the approval/dispatch arrived via VOICE (vs the REST dialog).
  //   - (neither flag)    -> a genuine Full-Auto auto-execution (no operator in the loop).
  const WS_EVT = {
    APPROVAL_PENDING: "approval_pending",
    AUTO_EXECUTED: "command_auto_executed",
    BLOCKED: "command_blocked",
    // Issue E: a messageId-keyed "this pending command is resolved — clear its modal" event,
    // broadcast on EVERY non-lost_race resolve so a VOICE approval (or a cross-client REST approve,
    // or a TTL-expire sweep) dismisses the ApprovalDialog in real time instead of lingering until
    // the ~20s safety-net poll. Mirrors the action_resolved event the pendingActions flow uses.
    APPROVAL_RESOLVED: "approval_resolved",
  } as const;

  // WS-E single choke-point (simplicity H1 / maintainability H1/H2/L9): the ONE place every
  // resolve path (REST approve, voice approve/reject, TTL sweep) renders the outcome of the pure
  // `resolveDecision`. The MANDATORY atomic `claim()` lives INSIDE `resolveDecision`, so no path
  // here can write without winning the claim (the sweep now goes through the SAME gate too).
  // Returns the ResolveAction so a caller can branch on the reason for its own response shape.
  // R3 (P0-1): `call.id` was already answered ONCE by the non-blocking `pending_approval`
  // response at proposal time; resolution NEVER sends a 2nd `sendToolResponse` — the model-facing
  // outcome is the `pushApprovalNarration` push only.
  // Handoff gate leg (design §5.3 / step 9): when a resolved pending approval corresponds to a
  // staged handoff (the handoff delivery uses pendingId == handoff_id; gate_approval_id also
  // tracks it), flip the persisted handoff row to its terminal/transition state in the SAME
  // resolver choke-point — one added store call, no forked path. Approve => delivered (the write
  // already landed via the approved branch); reject => rejected; expire/dead-pane => expired.
  function flipHandoffOnResolve(messageId: string, reason: ResolveReason, opts?: { vocal?: boolean }) {
    // Delegate to the EXPORTED, unit-tested resolve-leg flip (src/handoffFlow) so the lookup +
    // reason->state mapping + provenance live in ONE source of truth and are exercised end-to-end
    // against a real JanusStore without a live session. `reason` is narrowed there to the handoff
    // resolve reasons; lost_race/not_found never reach here (gated at the applyResolution call site).
    applyHandoffFlipOnResolve(store, messageId, reason as HandoffResolveReason, { vocal: opts?.vocal });
  }

  function applyResolution(messageId: string, mode: ResolveMode, opts?: { vocal?: boolean }) {
    const action = resolveDecision(
      pendingApprovals,
      messageId,
      mode,
      (terminalId) => !!manager.terminals[terminalId]
    );
    const { reason, record } = action;
    if (!record) return action; // not_found: idempotent no-op
    const session = pendingApprovals.sessionFor(messageId);
    const safeInstr = redactSecrets(record.instruction);
    const verb = record.kind === "agent_instruction" ? "direct pane" : "run on pane";

    switch (reason) {
      case "lost_race":
        // Another resolver already won the claim — render nothing (exactly-once preserved).
        break;
      case "dead_pane":
        if (session) pushApprovalNarration(session, `That pane (${record.terminalId}) is gone — I could not dispatch the command.`);
        broadcast({ type: WS_EVT.BLOCKED, terminalId: record.terminalId, cmd: safeInstr, reason: "Target pane missing." });
        break;
      case "approved": {
        // Claim already won inside resolveDecision — this is the single write path.
        HistoryManager.getInstance().addCommand(record.terminalId, record.instruction);
        manager.terminals[record.terminalId]!.writeInput(record.instruction);
        if (session) pushApprovalNarration(session, `Approving: ${verb} ${record.terminalId} — "${safeInstr}". Dispatching now.`);
        // P1-2: operator-APPROVED, not an auto-execution — flag it so the UI does not mislabel.
        broadcast({ type: WS_EVT.AUTO_EXECUTED, terminalId: record.terminalId, cmd: safeInstr, approved: true, ...(opts?.vocal ? { vocal: true } : {}) });
        break;
      }
      case "rejected":
        if (session) pushApprovalNarration(session, `Rejecting the command on pane ${record.terminalId}: "${safeInstr}".`);
        broadcast({ type: WS_EVT.BLOCKED, terminalId: record.terminalId, cmd: safeInstr, reason: opts?.vocal ? "Execution cancelled by operator via voice." : "Execution cancelled by operator." });
        break;
      case "expired":
        if (session) pushApprovalNarration(session, `The command on pane ${record.terminalId} expired after ${Math.round(APPROVAL_TTL_MS / 60000)} minutes; I cancelled it.`);
        announcementBus.enqueue({ kind: "exited", terminalId: record.terminalId, summary: "Approval expired." });
        broadcast({ type: WS_EVT.BLOCKED, terminalId: record.terminalId, cmd: safeInstr, reason: "Approval expired (timeout)." });
        break;
    }
    // Step 9: flip any associated handoff row in the SAME choke-point (after the write/narration).
    if (reason === "approved" || reason === "rejected" || reason === "expired" || reason === "dead_pane") {
      flipHandoffOnResolve(messageId, reason, opts);
    }
    // Issue E: emit a messageId-keyed resolve event so EVERY client dismisses the ApprovalDialog in
    // real time — voice approvals, cross-client REST approvals, and TTL-expire/dead-pane sweeps
    // alike. lost_race is skipped: the resolver that WON the claim already broadcast for this
    // messageId, and its record fields are the authoritative ones. The client's optimistic click
    // filter still gives instant button feedback and harmlessly double-filters on this event.
    if (reason !== "lost_race") {
      broadcast({ type: WS_EVT.APPROVAL_RESOLVED, messageId, terminalId: record.terminalId, outcome: reason });
      broadcastTerminalsUpdated();
    }
    return action;
  }

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

  // WS-F (spec §4.1/§6.3): the sweep no longer SILENTLY auto-rejects on TTL. It drives off the pure
  // `decideSweepAction` so the timing/connectivity policy lives in ONE unit-tested place:
  //   - DISCONNECTED item -> "none": the clock is PAUSED (you cannot speak a last-call into a session
  //     that isn't there, and the spec forbids rejecting without first speaking one). The item waits,
  //     durably, until the operator returns — this is the "away at a meeting -> still there" guarantee.
  //   - CONNECTED + past TTL, no prior last-call -> "lastcall": stamp lastCallAt=now and SPEAK a
  //     context-rich last-call (renderResumptionLine + "approve now or I'll drop it"). Do NOT reject.
  //   - CONNECTED + last-call already spoken + grace elapsed -> "reject": NOW route through the
  //     UNCHANGED terminal path (applyResolution(id,"expire") -> resolveDecision claim+delete).
  // Connectivity is resolved HERE and passed in: per-record `sessionFor(id) !== undefined` for
  // approvals (the detach/re-attach seam), global `coreState.activeFrontendWs !== null` for the non-session-
  // bound pending actions. Only the TRIGGER + the connected-gate change; the reject itself stays
  // byte-for-byte (the mandatory claim gate / exactly-once / dead-pane invariants are untouched).
  function sweepExpiredApprovals(now: number = Date.now()) {
    for (const pending of pendingApprovals.expired(APPROVAL_TTL_MS, now)) {
      const isConnected = pendingApprovals.sessionFor(pending.messageId) !== undefined;
      const decision = decideSweepAction(pending, now, APPROVAL_TTL_MS, APPROVAL_GRACE_MS, isConnected);
      if (decision.action === "none") continue; // not due, clock paused, or inside grace.
      if (decision.action === "lastcall") {
        // First crossing while connected: SPEAK the last-call (no reject), stamp the transient.
        pending.lastCallAt = now;
        const session = pendingApprovals.sessionFor(pending.messageId);
        if (session) pushApprovalNarration(session, `${renderResumptionLine(pending, now)} — approve now or I'll drop it.`);
        broadcastTerminalsUpdated();
        continue;
      }
      // decision.action === "reject": grace elapsed after the last-call -> the UNCHANGED terminal path.
      applyResolution(pending.messageId, "expire");
    }
    // G1 + WS-F: pending actions get the SAME last-call->grace shape. Connectivity is gated on the
    // SAME ref used to narrate (`coreState.activeLiveSession`), NOT `coreState.activeFrontendWs`. The two diverge during
    // the Gemini `ai.live.connect()` handshake window: `coreState.activeFrontendWs` is set synchronously on WS
    // open, but `coreState.activeLiveSession` is only assigned AFTER the async connect resolves. If the gate
    // were `coreState.activeFrontendWs`, a sweep tick in that window could return "lastcall" (gate true), stamp
    // the one-shot `lastCallAt`, yet SKIP the narration (no live session) — and since "lastcall" never
    // re-fires once stamped, the action would later be rejected having NEVER spoken a last-call,
    // violating spec §4.1/§10 #4 ("a spoken last-call always precedes any reject"). Coupling the gate
    // to `coreState.activeLiveSession` mirrors the approval path (gate ref == narration ref). The transient
    // `lastCallAt` drives the two-phase transition; expiry stays the unchanged pendingActions.expire(id).
    const actionsConnected = coreState.activeLiveSession !== null;
    for (const act of pendingActions.expired(APPROVAL_TTL_MS, now)) {
      const decision = decideSweepAction(act, now, APPROVAL_TTL_MS, APPROVAL_GRACE_MS, actionsConnected);
      if (decision.action === "none") continue;
      if (decision.action === "lastcall") {
        act.lastCallAt = now;
        if (coreState.activeLiveSession) pushApprovalNarration(coreState.activeLiveSession, `${act.capability}: ${redactSecrets(act.summary)} — approve now or I'll drop it.`);
        broadcast({ type: "action_pending", actionId: act.id, capability: act.capability, summary: act.summary });
        continue;
      }
      // decision.action === "reject": grace elapsed -> expire (claim + drop, no side effect).
      pendingActions.expire(act.id);
      broadcast({ type: "action_resolved", actionId: act.id, outcome: "expired" });
    }
  }
  const approvalSweepTimer = setInterval(sweepExpiredApprovals, APPROVAL_SWEEP_MS);
  if (typeof approvalSweepTimer.unref === "function") approvalSweepTimer.unref();

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

    let session: any = null;
    let unsubscribePaneSignals: (() => void) | null = null;
    // `wsClosed` is now STRICTLY "the operator's client WS has closed" (set in clientWs.on("close")).
    // It is the reconnect kill-switch: a scheduled reconnect aborts if the operator already left.
    // A dead Gemini live session is tracked SEPARATELY by a per-attempt `sessionDead` flag inside
    // connectLiveSession (so a stale session's post-close flush can't poison the token WITHOUT also
    // blocking a fresh reconnect — the two used to share `wsClosed`, which would have defeated PLM4).
    let wsClosed = false;
    let currentSessionUserUtterance = "";
    let currentSessionModelUtterance = "";
    // Correlated interaction log: one interaction_id per operator TURN. `lastSpeaker` flips the turn —
    // when the operator speaks after the model, mint a fresh id; the model's response + tool calls +
    // result + pty all share it. turnId() lazily mints for model-first events (e.g. a greeting).
    let currentInteractionId: string | null = null;
    let lastSpeaker: "operator" | "model" | null = null;
    const turnId = (): string => {
      if (currentInteractionId == null) currentInteractionId = interactionLog.mint();
      lastInteractionId = currentInteractionId;
      return currentInteractionId;
    };
    const onOperatorSpeech = (): string => {
      if (lastSpeaker !== "operator") currentInteractionId = interactionLog.mint();
      lastSpeaker = "operator";
      lastInteractionId = currentInteractionId;
      return currentInteractionId!;
    };
    const voiceName = manager.settings.voiceAi?.voice || "Zephyr";

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
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // PLM4 (Finding: flap): one-shot timer armed on each successful hoist; it resets the retry budget
    // ONLY once the session has been live for RECONNECT_STABLE_UPTIME_MS. Cleared if the session drops
    // (or the operator leaves) before then, so a flapping session never refreshes its budget.
    let stableResetTimer: ReturnType<typeof setTimeout> | null = null;
    function clearStableResetTimer(): void {
      if (stableResetTimer) { clearTimeout(stableResetTimer); stableResetTimer = null; }
    }
    // PLM4 (2): monotonic connect generation. Each connectLiveSession() invocation bumps it and
    // captures its own number; when its async connect resolves it bails if a NEWER connect has since
    // started (so a slow stale connect can never clobber a newer live session). Mirrors the QW3
    // `coreState.activeLiveSession === session` identity guard for the in-flight (not-yet-hoisted) window.
    let connectGeneration = 0;
    function clearReconnectTimer(): void {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
          HistoryManager.getInstance().addCommand(targetId, instruction);
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
    const myGeneration = ++connectGeneration;
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
      if (session) {
        const detached = pendingApprovals.detachSession(session);
        if (detached.length) console.log(`[VOICE] kept ${detached.length} approval survivor(s) after voice channel ${reason}.`);
        // Identity guard (NOT the double-fire guard): the per-attempt `sessionDead` flag above is what
        // makes a double onerror+onclose for ONE drop fire exactly once. THIS guard does a DIFFERENT
        // job — it only nulls the hoisted handle if it still points at THIS session, so a LATE stale
        // callback (whose `session` was overwritten by a newer reconnect) can't null the newer live
        // session. `session` is the mutated connection-scope let, so the comparison is by reference
        // against whatever is currently hoisted (copied from WS-close).
        if (coreState.activeLiveSession === session) {
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
        const interactionIdForCall = currentInteractionId; // stamp the active turn onto this dispatch's audit row
        return {
          manager,
          session,                              // the live Gemini session in this scope
          callId,
          // PLM3 version stamp for THIS dispatch — the deferring handlers spread it into the intent
          // params they persist via gateOrDefer, so a later boot can quarantine a drifted def.
          versionStamp: actionName ? { actionName, schemaHash: actionSchemaHash(actionName) ?? undefined } : undefined,
          trigger: currentSessionUserUtterance || "voice",
          surface: "voice",                     // explicit dispatch-surface token (action_log)
          userUtterance: currentSessionUserUtterance,
          broadcast,
          broadcastLedgerUpdate,
          gateOrDefer,
          dispatchProposal: dispatchProposal as ActionContext["dispatchProposal"],
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
          // Emergency brake — the real connection-scoped closures (they broadcast their own frames).
          stopAll,
          releaseStopAll,
          isFrozen: () => coreState.frozen,
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
      session = await boundLiveConnector(sessionAi, {
        model: liveModel,
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            // Check for sessionResumption update. Gemini Live emits a fresh handle on
            // (nearly) every turn; only log when it actually changes, else a single
            // session floods the log with dozens of near-identical lines (bug E).
            // Also ignore the SDK's final post-close token flush (wsClosed): writing it
            // would overwrite the live handle with a stale one from a dead session and
            // poison the next reconnect's resume attempt.
            if ((message as any).sessionResumptionUpdate && !wsClosed && !sessionDead) {
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
              lastSpeaker = "model";
            }

            if (userUtterance) {
              currentSessionUserUtterance = userUtterance;
              interactionLog.log({ interactionId: onOperatorSpeech(), kind: "voice_in", text: userUtterance, data: { source: "operator" } });
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
                      pushApprovalNarration(session, `I heard both approve and reject — which did you mean for the ${entries.length} pending command${entries.length === 1 ? "" : "s"}?`);
                    } else {
                      const target = selectApprovalTarget(
                        entries.map((e) => ({ messageId: e.messageId, instruction: e.instruction, terminalId: e.terminalId })),
                        parsed.targetHint,
                        pendingApprovals.lastAnnouncedFor(session)
                      );
                      if (target.ambiguous || !target.messageId) {
                        // >1 pending and nothing disambiguates -> clarify, list them.
                        const list = entries.map((e, i) => `${i + 1}. "${redactSecrets(e.instruction)}" on pane ${e.terminalId}`).join("; ");
                        pushApprovalNarration(session, `I have ${entries.length} pending: ${list}. Which one?`);
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
                      narrate: (t) => pushApprovalNarration(session, t),
                      redact: redactSecrets,
                    });
                  }
                }
              }
            }
            if (modelUtterance) {
              currentSessionModelUtterance = modelUtterance;
              interactionLog.log({ interactionId: turnId(), kind: "gemini_text", text: modelUtterance });
              lastSpeaker = "model";
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

            // Pass audio back to client
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audio) {
            clientWs.send(JSON.stringify({ type: "audio", audio }));
          }
          if (message.serverContent?.interrupted) {
            clientWs.send(JSON.stringify({ type: "interrupted", interrupted: true }));
          }

          // Handle Tool Calls
          if (message.toolCall) {
            for (const call of message.toolCall.functionCalls || []) {
              const name = call.name;
              const args = call.args as Record<string, any>;
              const ixnId = turnId();
              lastSpeaker = "model";
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
              const replayDef = REGISTRY.find((d) => d.name === name);
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
                const actionCtx: ActionContext = buildActionContext(call.id, name);
                const result = await runAction(REGISTRY, name, (args ?? {}) as Record<string, unknown>, actionCtx);
                interactionLog.log({ interactionId: ixnId, kind: "action_result", data: { name, callId: call.id, resultKind: (result as { kind?: string })?.kind } });
                resultToToolResponse(result, session, name, call.id);
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
        systemInstruction: `You are Project Janus, a voice helper controlling active terminal panes.\n\nCURRENT ROUTING CONTEXT (System State):\n- Active Project/Workspace ID: ${manager.ledger.activeProjectId || "None"}\n- Available Workspaces: ${Object.keys(manager.ledger.workspaces).map(pId => pId + " (" + manager.ledger.workspaces[pId].name + ")").join(", ")}\n\nPane status (busy/idle), elapsed time, and last command are LIVE and change constantly. NEVER assume a pane's status from memory or this prompt — it is not listed here because it would be stale. ALWAYS call list_panes to read current per-pane status before reporting whether anything is running or done.\n\nYou DIRECT; the agent panes (Claude Code / Codex / Antigravity) do the heavy lifting. Your job is to route the operator's request to the RIGHT agent pane and report back — you must NOT author and run raw working shell yourself. When the operator dictates a goal, do NOT relay it verbatim: COMPRESS it into a short, targeted instruction for the agent, CONFIRM that distilled version by voice, then call propose_command with kind='agent_instruction' (the default). When the operator is composing a prompt to review before sending (the Prompt Draft / Workbench), keep that draft SYNTHESIZED: call update_draft_prompt(mode='replace') with your distilled, ready-to-send instruction — do NOT leave the draft as the operator's raw dictation — and refine it as the conversation evolves so the draft is always a clean instruction the operator can review and send. If a goal spans multiple panes, decompose it and propose per pane (or build a plan). Use kind='shell' only for your OWN small read-only/observe commands (git status, ls, cat, pwd); never run heavy/mutating shell yourself.\n\nWhen a command is awaiting approval (Human-in-the-Loop), you are NOT muted: SPEAK the distilled instruction and target pane and ASK the operator to approve or reject BEFORE it runs. Use list_pending_approvals to recall what is queued. You can list panes, get pane summaries, switch project contexts, add notes, and rename things. Remain token-light. Always use switch_context to get the full project briefing when starting.\n\nEMERGENCY BRAKE (two stages, always allowed): if the operator says "stop", "halt", "abort", "freeze", or "stop everything", call stop_all IMMEDIATELY — it freezes you (every capability becomes Off) and cancels everything in flight, but the panes KEEP RUNNING. After it freezes, tell the operator how many panes are still running and ASK whether to also kill them (that is irreversible). If they confirm the kill ("kill them", "yes"), call confirm_stop_all. When they say "release"/"resume", call release_stop_all to un-freeze (your gates restore exactly; killed panes stay killed).`,
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
        tools: [{
          functionDeclarations: toGeminiDeclarations(REGISTRY),
        }]
      },
    });

      // PLM4 (2): IDENTITY GUARD on the just-resolved connect. The async connect could have raced the
      // operator leaving (wsClosed) or a newer session winning the hoist. If so, this freshly-minted
      // session is stale — close it and bail WITHOUT clobbering the live channel. (`session` is the
      // connection-scope let; on a reconnect a newer attempt could already have overwritten it, but
      // last-write-wins here is fine: we only proceed if NOTHING newer has hoisted.)
      const justConnected = session;
      if (wsClosed || myGeneration !== connectGeneration) {
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
      stableResetTimer = setTimeout(() => {
        stableResetTimer = null;
        if (wsClosed) return; // operator already left.
        // Only the CURRENTLY-live session earns the refresh; a stale callback can't credit a newer one.
        if (coreState.activeLiveSession === justConnected) {
          reconnectAttempts = 0;
          console.log(`[VOICE] session stable for ${RECONNECT_STABLE_UPTIME_MS}ms — reconnect budget refreshed.`);
        }
      }, RECONNECT_STABLE_UPTIME_MS);
      if (typeof stableResetTimer.unref === "function") stableResetTimer.unref();
      // PLM4 (4): reannounceSurvivors runs on the reconnect path too (this closure IS the reconnect
      // path), so the surviving approvals are re-attached + re-announced for free on every (re)connect.
      reannounceSurvivors(justConnected);

      // Push-observation: bridge global pane signals into THIS live session. The bus owns
      // debounce; we forward each signal as a user-role nudge (same convention as approval
      // narration the model already speaks). Unsubscribed on socket close.
      if (unsubscribePaneSignals) { unsubscribePaneSignals(); unsubscribePaneSignals = null; }
      unsubscribePaneSignals = paneSignalBus.subscribe((sig) => {
        try {
          justConnected.sendClientContent({
            turns: [{ role: "user", parts: [{ text: formatPaneSignal(sig) }] }],
            turnComplete: true,
          });
        } catch (e) {
          console.error("Failed to push pane signal to session:", e);
        }
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
      if (wsClosed) return;                 // operator left — no reconnect.
      if (reconnectTimer) return;           // one in flight already.
      if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        console.warn(`[VOICE] reconnect giving up after ${reconnectAttempts} attempts.`);
        broadcast({ type: "voice_channel_lost", reason: "reconnect_failed", permanent: true });
        return;
      }
      const attempt = reconnectAttempts++;
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (wsClosed) return;               // re-check at fire time: operator may have left during the wait.
        // connectLiveSession is itself try/caught (initial + reconnect arms); it never throws. We add a
        // .catch belt as defense-in-depth so a rejected promise can never escape this timer callback.
        Promise.resolve(connectLiveSession(true)).catch((e) => {
          console.error("[VOICE] reconnect attempt threw (unexpected):", e);
          scheduleReconnect();
        });
      }, delay);
      if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
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
          if (session) {
            try {
              session.sendRealtimeInput({
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
      wsClosed = true; // gate out the SDK's post-close resumption-token flush + the reconnect loop
      // PLM4 (2): the operator left — cancel any pending reconnect attempt (no reconnect storm after
      // the WS closes). scheduleReconnect also re-checks wsClosed, so this is belt-and-suspenders.
      clearReconnectTimer();
      clearStableResetTimer(); // PLM4 (Finding: flap): no budget-refresh timer should outlive the WS.
      if (unsubscribePaneSignals) { unsubscribePaneSignals(); unsubscribePaneSignals = null; }
      coreState.clients.delete(clientWs);
      if (coreState.activeFrontendWs === clientWs) {
        coreState.activeFrontendWs = null;
        coreState.activePaneId = null; // Step 5: no UI connected -> no source of truth -> no write permitted.
      }
      if (session) {
        // WS-F (spec §6.1): disconnect = DETACH, not purge. Drop the dead live-session handle but
        // KEEP each staged approval (record + order + durable row) so the survivors re-announce on
        // reconnect (reannounceSurvivors). The clock is paused while detached (the sweep skips items
        // with no session), so nothing the operator stepped away from is silently dropped.
        // pendingActions needs nothing here — it is not session-bound and survives in-process.
        const detached = pendingApprovals.detachSession(session);
        if (detached.length) console.log(`[DETACH] kept ${detached.length} survivor(s) for re-announce on reconnect.`);
        // Drop the hoisted live-session ref if it points at this (now dead) session, so the action
        // last-call doesn't narrate into a torn-down channel. The action clock also pauses now
        // (coreState.activeFrontendWs went null above), matching the approval clock-pause-while-away.
        if (coreState.activeLiveSession === session) coreState.activeLiveSession = null;
        try {
          session.close();
        } catch (e) {
          console.error("Error closing Gemini session on socket close:", e);
        }
      }
      console.log("Client WS closed");
    });
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
