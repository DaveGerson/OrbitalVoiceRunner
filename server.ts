import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";
import crypto from "crypto";
import { OrchestratorManager, UniversalTerminal, stripAnsiSequences, redactSecrets, classifySecrets } from "./src/terminal";
import { SHELL_PROMPT } from "./src/statusConstants";
import { PaneSignalBus } from "./src/paneSignalBus";
import { classifyPaneOutput, formatPaneSignal } from "./src/paneSignals";
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
import { parseApprovalIntent, selectApprovalTarget, selectPendingAction } from "./src/approvalIntent";
import { isPaneActiveForWrite, inactivePaneClarify } from "./src/activePane";
import { JanusStore } from "./src/store/sqliteStore";
import { deliverOutcomeToHandoff, applyHandoffFlipOnResolve, type HandoffResolveReason } from "./src/handoffFlow";
import { PendingActionStore } from "./src/pendingActions";
import { restGateOutcome } from "./src/restGate";
import { planRecipeApply } from "./src/recipeApply";
import { migrateOnBootIfNeeded } from "./src/store/migrate";
import type { GateValue, CapabilityGate, CapabilityGateMap } from "./src/types";
import { deriveEffectiveGates, derivePostureWord, ALL_CAPABILITIES, type EffectiveMode as GateSurfaceMode } from "./src/gateSurface";
import { resolveProjectDir, isBadProjectDir } from "./src/projectDir";

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

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

  async function summarizeCommandOutcome(command: string, rawOutput: string): Promise<string> {
    try {
      const apiKey = (manager.settings.secrets?.geminiApiKey && manager.settings.secrets.geminiApiKey !== "CONFIGURED_IN_ENV")
        ? manager.settings.secrets.geminiApiKey
        : (process.env.GEMINI_API_KEY || "");

      const summarizeAi = apiKey ? new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      }) : ai;

      // WS-B: redactSecrets applied to raw output before it reaches the model (was UNREDACTED,
      // finding N-5). Secrets printed to a pane are now scrubbed before this Gemini call.
      const prompt = `You are a strict, command-line terminal outcome synthesizer.
Summarize the final response and outcome of the following command execution. Do NOT include raw or verbose stdout log sequences. Focus exclusively on the ultimate outcome, success/failure of the command, and any critical final lines of output (key numbers, final results, final generated file text, or compile error statements). Do not say who you are. Keep your summary to 1-2 small conversational sentences, highly professional and compact.

Command: ${command}
Verbose Output:
${redactSecrets(rawOutput.slice(-3000))}`;

      // NOTE: `rawOutput` is now sent to the summarizer model via redactSecrets(), which
      // scrubs AWS keys, JWTs, PEM blocks, Google API keys, GitHub/Slack tokens, and
      // generic key=value secret assignments before any content reaches the model.
      const response = await summarizeAi.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });
      return response.text?.trim() || "No outcomes summary available.";
    } catch (err) {
      console.error("[summarizeCommandOutcome] Error:", err);
      // Honest neutral fallback — do NOT claim success; the outcome is unknown here.
      return "Command outcome summary unavailable.";
    }
  }

  // Push-observation: one bus per server; each /live connection subscribes its session.
  const paneSignalBus = new PaneSignalBus();

  manager.onIdle = async (terminalId) => {
    const term = manager.terminals[terminalId];
    if (term) {
      const history = HistoryManager.getInstance().loadHistory(terminalId);
      // WS-D summary for the proactive completion notification. Built ONLY from
      // already-redacted/derived sources (never raw pane text): a fresh summarization when
      // there is substantive output, else the existing redacted finalResponse, else a brief
      // last-command-based fallback. Always set so the announcement below can fire.
      let summaryText = "finished";
      if (history.length > 0) {
        const lastEntry = history[history.length - 1];
        try {
          const cleanOutput = lastEntry.output ? stripAnsiSequences(lastEntry.output).trim() : "";
          if (cleanOutput.length > 5 && !lastEntry.finalResponse) {
            summaryText = await summarizeCommandOutcome(lastEntry.command, cleanOutput);
            lastEntry.finalResponse = summaryText;
            HistoryManager.getInstance().saveHistory(terminalId, history);
            broadcast({ type: "history_updated", terminalId, history });
          } else if (lastEntry.finalResponse) {
            summaryText = lastEntry.finalResponse; // already WS-B redacted
          } else if (lastEntry.command) {
            summaryText = `${lastEntry.command} finished`;
          }
        } catch (err) {
          console.error("Auto-summarization failed for command outcomes:", err);
        }
      }

      // WS-D (BUG-024): announce on this genuine WS-C Running->Idle completion edge — no new
      // idle inference. Fires regardless of whether there was substantive output / an existing
      // finalResponse, with the redacted summary above as the message. The bus owns the
      // per-pane debounce / coalescing / rate limit, so a trivial completion is still safe.
      announcementBus.enqueue({ kind: "completion", terminalId, summary: summaryText });
      paneSignalBus.publish({ paneId: terminalId, kind: "idle", detail: summaryText.slice(0, 160) });
    }
  };

  let activeFrontendWs: any = null;
  // WS-F (spec §5/§6.3): the current live Gemini session, hoisted to closure scope so the module-level
  // sweep can speak a last-call for non-session-bound pending ACTIONS (approvals carry their own
  // per-record session via sessionFor; actions do not). Single-operator, last-connection-wins: set
  // when a connect resolves, nulled on socket close. Null === no voice channel to narrate into.
  let activeLiveSession: any = null;
  const clients = new Set<any>();

  // Step 5 (single active pane): the pane the operator currently has open on screen, driven by the
  // UI via `set_active_pane`. It is the SINGLE source of truth for where Janus may write — see
  // `isPaneActiveForWrite`. Null when no pane is open / no UI is connected (no write permitted).
  let activePaneId: string | null = null;

  // STOP-ALL Stage-1 freeze (bead 8sq, spec §2.C / §3). When set, the gate resolver short-circuits
  // EVERY capability to Off at the single choke-point (effectiveCapabilityGateFor) — Janus cannot
  // act anywhere until Release. PERSISTED to the durable kv ("frozen"="1") so a froze-for-a-reason
  // survives a process restart; the matrix itself is NEVER mutated, so Release is a clean clear.
  // Restored from the store on boot (below). Module-level `store` is the durable backend.
  let frozen: boolean = store?.getKV("frozen") === "1";
  const FROZEN_KV = "frozen";
  function persistFrozen(value: boolean): void {
    frozen = value;
    if (!store) return;
    try { if (value) store.setKV(FROZEN_KV, "1"); else store.deleteKV(FROZEN_KV); }
    catch (e) { console.error("[STOP-ALL] failed to persist frozen flag:", e); }
  }

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
    for (const client of clients) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(data);
        } catch (e) {
          console.error("Failed to send socket broadcast:", e);
        }
      }
    }
  }

  // Step 6 (the Workbench): per-pane WIP draft helpers. The draft is composed against the ACTIVE
  // pane (single source of truth, step 5); composing/editing it is not a CLI write and is ungated.
  function activeDraftTarget(): { projectId: string; paneId: string } | null {
    if (!activePaneId) return null;
    return { projectId: manager.ledger.activeProjectId || "default_project", paneId: activePaneId };
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

  const lastStates: Record<string, string> = {};

  function handleWatchRulesTrigger(terminalId: string, transition: "idle" | "prompt" | "error" | "build-failed" | "exited") {
    const rules = manager.ledger.watchRules;
    let changed = false;
    for (const rule of rules) {
      if (rule.enabled && rule.triggerTerminalId === terminalId && rule.triggerTransition === transition) {
        // Prompt-composer refactor: watch rules NEVER write to a CLI pane. They are co-pilot
        // nudges — when the trigger matches, we SURFACE the suggested command for the operator
        // (who can act on it, gated, on the active pane). No autonomous, background, or
        // cross-pane write happens here. (architecture §5: Remove watch-rule autonomous writes.)
        console.log(`[WATCH RULE NUDGE] Rule ${rule.id} matched: suggesting '${rule.actionCommand}' for '${rule.actionTerminalId}' (not writing).`);
        const itemID = "att_" + Math.random().toString(36).substring(2, 11);
        manager.attentionQueue.push({
          id: itemID,
          type: "confirmation",
          terminalId: rule.actionTerminalId,
          projectId: manager.ledger.activeProjectId || "default_project",
          message: `Suggestion: run '${rule.actionCommand}' on '${rule.actionTerminalId}' (trigger: '${terminalId}' → '${transition}').`,
          timestamp: new Date().toISOString(),
          dismissed: false,
          details: {
            kind: "watch_rule_suggestion",
            ruleId: rule.id,
            suggestedCommand: rule.actionCommand,
            targetTerminalId: rule.actionTerminalId,
          },
        });
        pruneAttention(); // BUG-035 cap/TTL
        broadcast({ type: "attention_updated", queue: manager.attentionQueue });
        broadcast({
          type: "watch_rule_suggested",
          ruleId: rule.id,
          suggestedCommand: rule.actionCommand,
          targetTerminalId: rule.actionTerminalId,
          message: `Watch rule matched — suggested '${rule.actionCommand}' on '${rule.actionTerminalId}'. Not executed; awaiting the operator.`
        });
        if (rule.oneShot) {
          rule.enabled = false;
          changed = true;
        }
      }
    }
    if (changed) {
      manager.ledger["save"](true);
      broadcast({ type: "watch_rules_updated", watchRules: manager.ledger.watchRules });
    }
  }

  function handlePlansTrigger(terminalId: string, transition: "idle" | "prompt" | "error" | "build-failed" | "exited") {
    const plans = manager.ledger.plans;
    let changed = false;
    for (const plan of plans) {
      if (plan.status === "running") {
        const currentStep = plan.steps[plan.currentStepIndex];
        if (currentStep && currentStep.status === "running" && currentStep.terminalId === terminalId) {
          if (transition === currentStep.expectedTransition) {
            currentStep.status = "completed";
            console.log(`[PLAN PROGRESS] Plan '${plan.name}' - Step ${plan.currentStepIndex + 1} completed!`);
            broadcast({
              type: "plan_step_completed",
              planId: plan.id,
              stepId: currentStep.id,
              message: `Plan step completed successfully on '${terminalId}'.`
            });
            const nextIndex = plan.currentStepIndex + 1;
            if (nextIndex < plan.steps.length) {
              // Prompt-composer refactor: a plan is an OUTLINE, not an execution engine. We do
              // NOT auto-advance by writing the next step into a pane. Mark the next step pending,
              // pause the plan awaiting the operator, and SURFACE it as a co-pilot suggestion the
              // operator can act on (gated, on the active pane). (architecture §5: Demote plans.)
              plan.currentStepIndex = nextIndex;
              const nextStep = plan.steps[nextIndex];
              nextStep.status = "pending";
              plan.status = "paused";
              const itemID = "att_" + Math.random().toString(36).substring(2, 11);
              manager.attentionQueue.push({
                id: itemID,
                type: "confirmation",
                terminalId: nextStep.terminalId,
                projectId: manager.ledger.activeProjectId || "default_project",
                message: `Plan '${plan.name}': step ${nextIndex + 1} ready — suggest '${nextStep.command}' on '${nextStep.terminalId}'.`,
                timestamp: new Date().toISOString(),
                dismissed: false,
                details: {
                  kind: "plan_step_suggestion",
                  planId: plan.id,
                  stepId: nextStep.id,
                  suggestedCommand: nextStep.command,
                  targetTerminalId: nextStep.terminalId,
                },
              });
              pruneAttention(); // BUG-035 cap/TTL
              broadcast({ type: "attention_updated", queue: manager.attentionQueue });
              announcementBus.enqueue({
                kind: "plan_paused",
                terminalId: nextStep.terminalId,
                summary: `Plan '${plan.name}' — step ${nextIndex + 1} ready for your approval.`
              });
              changed = true;
            } else {
              plan.status = "completed";
              console.log(`[PLAN COMPLETED] Plan '${plan.name}' finished successfully!`);
              broadcast({
                type: "plan_completed",
                planId: plan.id,
                message: `Plan '${plan.name}' completed all steps successfully!`
              });
              announcementBus.enqueue({
                kind: "plan_completed",
                terminalId: plan.id,
                summary: `Plan '${plan.name}' completed.`
              });
              changed = true;
            }
          } else if (transition === "error" || transition === "build-failed" || transition === "exited") {
            currentStep.status = "failed";
            plan.status = "paused";
            console.log(`[PLAN PAUSED] Plan '${plan.name}' failed on step ${plan.currentStepIndex + 1} due to ${transition}.`);
            
            const itemID = "att_" + Math.random().toString(36).substring(2, 11);
            manager.attentionQueue.push({
              id: itemID,
              type: "build-failed",
              terminalId,
              projectId: manager.ledger.activeProjectId || "default_project",
              message: `Plan '${plan.name}' was paused on step ${plan.currentStepIndex + 1}: pane returned ${transition}.`,
              timestamp: new Date().toISOString(),
              dismissed: false
            });
            pruneAttention(); // BUG-035 cap/TTL
            broadcast({ type: "attention_updated", queue: manager.attentionQueue });
            broadcast({
              type: "plan_paused",
              planId: plan.id,
              message: `Plan '${plan.name}' paused due to execution error.`
            });
            announcementBus.enqueue({
              kind: "plan_paused",
              terminalId,
              summary: `Plan '${plan.name}' paused on step ${plan.currentStepIndex + 1}.`
            });
            changed = true;
          }
        }
      }
    }
    if (changed) {
      manager.ledger["save"](true);
      broadcast({ type: "plans_updated", plans: manager.ledger.plans });
    }
  }

  function detectAndTriggerTransitions(terminalId: string, cleanChunk: string) {
    const term = manager.terminals[terminalId];
    if (!term) return;

    let transition: "idle" | "prompt" | "error" | "build-failed" | "exited" | null = null;
    if (term.status === "Exited") {
      transition = "exited";
    } else {
      const lower = cleanChunk.toLowerCase();
      if (
        lower.includes("failed to compile") ||
        lower.includes("build failed") ||
        lower.includes("modulenotfounderror") ||
        lower.includes("compile error") ||
        lower.includes("npm err!") ||
        lower.includes("failed to build") ||
        lower.includes("error: command failed") ||
        lower.includes("error: not found")
      ) {
        transition = "build-failed";
      } else if (
        cleanChunk.includes("Error:") ||
        cleanChunk.includes("Exception:") ||
        cleanChunk.includes("Stderr:") ||
        lower.includes("traceback") ||
        lower.includes("fatal: ")
      ) {
        transition = "error";
      } else if (term.status === "Idle") {
        // The busy/idle status is now owned by the authoritative state machine
        // (src/statusMachine.ts). Here we only refine an already-Idle pane into a
        // "prompt" attention if it looks like a shell prompt awaiting input —
        // using the shared SHELL_PROMPT regex from statusConstants.ts (I4: shell
        // panes only, never an interactive_cli TUI). This is an attention-label
        // concern independent of the idle decision. Otherwise we defer to "idle".
        const isShell = term.runtimeType === "shell";
        const tail = stripAnsiSequences(cleanChunk);
        if (isShell && SHELL_PROMPT.test(tail)) {
          transition = "prompt";
        } else {
          transition = "idle";
        }
      }
    }

    const previousState = lastStates[terminalId];
    if (transition && transition !== previousState) {
      lastStates[terminalId] = transition;
      console.log(`[TRANSITION] Terminal ${terminalId} transitioned: ${previousState || "none"} -> ${transition}`);
      
      broadcast({
        type: "pane_transition",
        terminalId,
        transition,
        message: `Pane ${terminalId} is now ${transition}.`
      });

      if (transition === "build-failed" || transition === "error" || transition === "exited") {
        const activeProjectId = manager.ledger.activeProjectId || "default_project";
        const id = "att_" + Math.random().toString(36).substring(2, 11);
        // WS-B: scrub the chunk before it becomes a displayed/announced hint.
        const hint = redactSecrets(cleanChunk.trim()).slice(-160);
        manager.attentionQueue.push({
          id,
          type: transition,
          terminalId,
          projectId: activeProjectId,
          message: `Pane '${terminalId}' transitioned to '${transition}' state.`,
          timestamp: new Date().toISOString(),
          dismissed: false
        });
        pruneAttention(); // BUG-035 cap/TTL
        broadcast({ type: "attention_updated", queue: manager.attentionQueue });

        // WS-D (BUG-024): high-severity proactive announcement (reuses the existing
        // lastStates edge-dedup, so this fires once per genuine transition edge).
        announcementBus.enqueue({ kind: transition, terminalId, summary: hint });
      }

      handleWatchRulesTrigger(terminalId, transition);
      handlePlansTrigger(terminalId, transition);
    }
  }

  const outputBuffers: Record<string, string[]> = {};
  let flushTimeout: NodeJS.Timeout | null = null;

  manager.onOutput = (terminalId, chunk) => {
    const term = manager.terminals[terminalId];
    if (term) {
      const cleanChunk = stripAnsiSequences(chunk);
      // Push-observation: classify each chunk and publish error/prompt signals. The bus
      // debounces per (pane,kind), so a chatty pane won't spam the model.
      const cls = classifyPaneOutput(cleanChunk);
      if (cls) {
        paneSignalBus.publish({ paneId: terminalId, kind: cls.kind, detail: cls.detail });
      }
      HistoryManager.getInstance().appendOutputToLastCommand(terminalId, cleanChunk);
      
      // Classify transitions and handle trigger rules
      detectAndTriggerTransitions(terminalId, cleanChunk);
    }

    if (!outputBuffers[terminalId]) {
      outputBuffers[terminalId] = [];
    }
    outputBuffers[terminalId].push(chunk);

    if (!flushTimeout) {
      flushTimeout = setTimeout(() => {
        flushTimeout = null;
        for (const [tid, chunks] of Object.entries(outputBuffers)) {
          if (chunks.length > 0) {
            broadcast({
              type: "stdout_chunk",
              terminalId: tid,
              chunk: chunks.join("")
            });
            outputBuffers[tid] = [];
          }
        }
      }, 30);
    }
  };

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
    const { terminalId, cwd, command, toolPreset, permissionsMode, sessionId, projectId } = req.body;
    if (!terminalId || !command) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
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
      const result = manager.addTerminal(terminalId, resolvedCwd, command, toolPreset, permissionsMode, sessionId, projectId || "");
      broadcastLedgerUpdate();
      broadcast({ type: "terminals_updated" });
      return String(result);
    };
    const g = gateOrDefer("create_pane", terminalId, `Create pane ${terminalId} (${command})`, spawnEffect);
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
        let cmd = "bash";
        // WS-G quick win: Claude Code is installed globally here, so the bare
        // `claude` binary is correct; `npx @anthropic-ai/claude` is the wrong package.
        if (pane.tool_preset === "Claude Code") cmd = "claude";
        else if (pane.tool_preset === "Codex") cmd = "codex";
        else if (pane.tool_preset === "Antigravity") cmd = "antigravity";
        
        manager.addTerminal(id, activeProject!.directory || process.cwd(), cmd, pane.tool_preset, pane.permissions_mode, pane.session_id);
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
    res.json({ frozen, running: frozen ? runningPaneIds() : [] });
  });
  app.post("/api/stop-all", (_req, res) => {
    const running = stopAll(false);
    res.json({ success: true, frozen: true, running });
  });
  app.post("/api/stop-all/confirm", (_req, res) => {
    if (!frozen) {
      res.status(409).json({ success: false, error: "Not frozen — Stage 2 kill requires a prior Stage 1 freeze (POST /api/stop-all)." });
      return;
    }
    const killed = stopAll(true);
    res.json({ success: true, killed });
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
    const bareShell = manager.settings.advanced.defaultShellCommand || (process.platform === "win32" ? "cmd.exe" : "bash");
    const paneById = new Map(recipe.panes.map(p => [p.id, p]));
    const spawned: string[] = [];
    const deferred: { paneId: string; actionId: string }[] = [];
    const blocked: string[] = [];
    for (const planned of plan.panes) {
      if (planned.disposition === "skip-existing") continue;
      if (planned.disposition === "block") { blocked.push(planned.paneId); continue; }
      const p = paneById.get(planned.paneId)!;
      const spawnPane = (): string => {
        // Always open a bare shell — never auto-run the recipe's startupCommand.
        manager.addTerminal(p.id, proj.directory || process.cwd(), bareShell, p.preset as any, p.permissionsMode as any, "", activeProjectId);
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
        const g = gateOrDefer("create_pane", p.id, `Create pane ${p.id} (recipe ${recipe.id})`, spawnPane);
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
  // G1: deferred execution for gated NON-PTY mutators (create_pane / set_*_permissions). On the
  // Ask tier these stage a side-effect here and run exactly once on operator confirm — separate
  // from the pane-write PendingApprovalStore so the two never entangle. (src/pendingActions.)
  const pendingActions = new PendingActionStore();
  let pendingActionSeq = 0;
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
    const isActivePane = !!paneId && activePaneId === paneId;
    const resolved = resolveCapabilityGateWithContext(paneGate, globalGates?.[capability], capability, isActivePane);
    // STOP-ALL Stage-1: the ONE place the `frozen` short-circuit is applied. While frozen every
    // capability resolves Off; the matrix above is untouched, so Release re-exposes it exactly.
    return applyFrozenShortCircuit(frozen, resolved);
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
    run: () => string
  ): { disposition: "run" } | { disposition: "forbidden" } | { disposition: "deferred"; actionId: string; summary: string } {
    const gate = effectiveCapabilityGateFor(paneId, capability);
    const activeProjectId = manager.ledger.activeProjectId || "default_project";
    if (gate === "Off") {
      if (store) { try { store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: paneId ?? null, summary: `FORBIDDEN ${capability}: ${summary}`, payload: { capability, gate, action: "forbidden" } }); } catch {} }
      return { disposition: "forbidden" };
    }
    if (gate === "Ask") {
      const actionId = `act_${Date.now()}_${pendingActionSeq++}`;
      pendingActions.add({ id: actionId, capability, summary, timestamp: Date.now(), run });
      if (store) { try { store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: paneId ?? null, summary: `DEFERRED ${capability} (await confirm): ${summary}`, payload: { capability, gate, action: "deferred", action_id: actionId } }); } catch {} }
      broadcast({ type: "action_pending", actionId, capability, summary });
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
    const isActivePane = activePaneId === paneId;
    const base = deriveEffectiveGates(paneGates, globalGates, isActivePane);
    if (!frozen) return base;
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
   */
  function stopAll(kill: boolean): string[] {
    if (!kill) {
      persistFrozen(true);
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
    // Stage 2: kill the PTYs. Fire-and-forget term.stop() (async SIGTERM->SIGKILL); the onExit
    // will flip status to Exited and re-broadcast. We collect the set we asked to kill.
    const killed: string[] = [];
    for (const [id, term] of Object.entries(manager.terminals)) {
      if (term.status !== "Exited") {
        killed.push(id);
        Promise.resolve(term.stop()).catch((e) => console.error(`[STOP-ALL] kill ${id} failed:`, e));
      }
    }
    if (store) {
      try {
        store.recordActivity({
          type: "permission_changed",
          project_id: manager.ledger.activeProjectId || "default_project",
          pane_id: null,
          summary: `STOP_ALL Stage 2: killed ${killed.length} pane PTY(s)`,
          payload: { action: "stop_all_kill", panes: killed },
        });
      } catch { /* store optional */ }
    }
    broadcast({ type: "stop_all", killed });
    broadcastTerminalsUpdated();
    return killed;
  }

  /** Clear the freeze (Release). The matrix was never mutated, so this is a clean clear. */
  function releaseStopAll(): void {
    persistFrozen(false);
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
    if (reason !== "lost_race") broadcastTerminalsUpdated();
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
  // approvals (the detach/re-attach seam), global `activeFrontendWs !== null` for the non-session-
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
    // SAME ref used to narrate (`activeLiveSession`), NOT `activeFrontendWs`. The two diverge during
    // the Gemini `ai.live.connect()` handshake window: `activeFrontendWs` is set synchronously on WS
    // open, but `activeLiveSession` is only assigned AFTER the async connect resolves. If the gate
    // were `activeFrontendWs`, a sweep tick in that window could return "lastcall" (gate true), stamp
    // the one-shot `lastCallAt`, yet SKIP the narration (no live session) — and since "lastcall" never
    // re-fires once stamped, the action would later be rejected having NEVER spoken a last-call,
    // violating spec §4.1/§10 #4 ("a spoken last-call always precedes any reject"). Coupling the gate
    // to `activeLiveSession` mirrors the approval path (gate ref == narration ref). The transient
    // `lastCallAt` drives the two-phase transition; expiry stays the unchanged pendingActions.expire(id).
    const actionsConnected = activeLiveSession !== null;
    for (const act of pendingActions.expired(APPROVAL_TTL_MS, now)) {
      const decision = decideSweepAction(act, now, APPROVAL_TTL_MS, APPROVAL_GRACE_MS, actionsConnected);
      if (decision.action === "none") continue;
      if (decision.action === "lastcall") {
        act.lastCallAt = now;
        if (activeLiveSession) pushApprovalNarration(activeLiveSession, `${act.capability}: ${redactSecrets(act.summary)} — approve now or I'll drop it.`);
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

  let lastSessionResumptionToken: any = null;

  wss.on("connection", async (clientWs, req) => {
    const tokenFromCookie = getCookie(req.headers.cookie, "auth_token");
    if (tokenFromCookie !== API_AUTH_TOKEN) {
      console.warn("[SECURITY] Blocked unauthorized WebSocket connection attempt.");
      clientWs.send(JSON.stringify({ type: "error", message: "Unauthorized WebSocket access. Please reload the interface." }));
      clientWs.close(4001, "Unauthorized");
      return;
    }

    activeFrontendWs = clientWs;
    clients.add(clientWs);
    console.log("Client connected to WebSocket");

    // Step 6: drafts are per-pane now; the client fetches the active pane's draft once it has told
    // us which pane is open (set_active_pane). No global buffer to push on connect.

    let session: any = null;
    let unsubscribePaneSignals: (() => void) | null = null;
    let wsClosed = false;
    let currentSessionUserUtterance = "";
    let currentSessionModelUtterance = "";
    const voiceName = manager.settings.voiceAi?.voice || "Zephyr";

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
      if (!isPaneActiveForWrite(activePaneId, targetId)) {
        return { kind: "clarify", text: inactivePaneClarify(activePaneId, targetId) };
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
          clientWs.send(JSON.stringify({ type: "approval_pending", messageId: pendingId, cmd: safeInstr, instruction: safeInstr, kind, terminalId: targetId, rationale }));
          const verb = kind === "agent_instruction" ? "direct pane" : "run on pane";
          return { kind: "pending", text: `Pending approval: ${verb} ${targetId} — "${safeInstr}". Read it back to the operator and ask them to approve or reject.` };
        }
      }
    }

    try {
      const sessionKey = (manager.settings.secrets?.geminiApiKey && manager.settings.secrets.geminiApiKey !== "CONFIGURED_IN_ENV")
        ? manager.settings.secrets.geminiApiKey
        : (process.env.GEMINI_API_KEY || "");
      
      const sessionAi = sessionKey ? new GoogleGenAI({
        apiKey: sessionKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      }) : ai;

      const liveModel = manager.settings.voiceAi?.model || "gemini-3.1-flash-live-preview";

      // Initialize Gemini Live session (through the injectable seam so tests /
      // the offline simulator can substitute a fake session). Uses the per-server snapshot
      // (boundLiveConnector) so a sibling test server's setLiveConnector cannot redirect us.
      session = await boundLiveConnector(sessionAi, {
        model: liveModel,
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            // Check for sessionResumption update. Gemini Live emits a fresh handle on
            // (nearly) every turn; only log when it actually changes, else a single
            // session floods the log with dozens of near-identical lines (bug E).
            // Also ignore the SDK's final post-close token flush (wsClosed): writing it
            // would overwrite the live handle with a stale one from a dead session and
            // poison the next reconnect's resume attempt.
            if ((message as any).sessionResumptionUpdate && !wsClosed) {
              const prevHandle = lastSessionResumptionToken?.newHandle;
              lastSessionResumptionToken = (message as any).sessionResumptionUpdate;
              if (lastSessionResumptionToken?.newHandle !== prevHandle) {
                console.log("[SESSION RESUMPTION] Token updated:", lastSessionResumptionToken?.newHandle);
              }
            }

            // Extract user or model verbal transcripts
            let userUtterance = "";
            let modelUtterance = "";

            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) {
                  modelUtterance += part.text;
                }
              }
            }
            if ((message.serverContent as any)?.turn?.parts) {
              for (const part of (message.serverContent as any).turn.parts) {
                if (part.text) {
                  userUtterance += part.text;
                }
              }
            }
            if ((message.serverContent as any)?.userTurn?.parts) {
              for (const part of (message.serverContent as any).userTurn.parts) {
                if (part.text) {
                  userUtterance += part.text;
                }
              }
            }

            if (userUtterance) {
              currentSessionUserUtterance = userUtterance;
              clientWs.send(JSON.stringify({
                type: "transcript_text",
                sender: "User",
                text: userUtterance
              }));

              const cleanUtter = userUtterance.trim();
              if (cleanUtter.length > 2) {
                // Step 6: capture dictation into the ACTIVE pane's WIP draft (raw material the
                // operator refines before sending). No-op if no pane is open.
                appendActiveDraft(`* **User Dictation**: ${cleanUtter}`, "operator");

                // WS-E.2 (BUG-007/008): hands-free voice approvals via the PURE intent parser
                // + most-recently-announced targeting (NOT FIFO, NOT substring matching).
                const parsed = parseApprovalIntent(cleanUtter);
                if (parsed.intent !== "none") {
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
                    const actions = pendingActions.all();
                    if (actions.length > 0) {
                      const target = selectPendingAction(
                        actions.map((a) => ({ id: a.id, summary: a.summary })),
                        parsed.targetHint
                      );
                      if (parsed.intent === "clarify") {
                        pushApprovalNarration(session, `I heard both approve and reject — which of the ${actions.length} pending action${actions.length === 1 ? "" : "s"} did you mean?`);
                      } else if (target.ambiguous || !target.id) {
                        // >1 staged and nothing disambiguates -> read back the SUMMARIES (actions
                        // have no meaningful terminalId; never narrate an empty pane id).
                        const list = actions.map((a, i) => `${i + 1}. ${redactSecrets(a.summary)}`).join("; ");
                        pushApprovalNarration(session, `I have ${actions.length} pending action${actions.length === 1 ? "" : "s"}: ${list}. Which one?`);
                      } else if (parsed.intent === "approve") {
                        const result = pendingActions.confirm(target.id);
                        if (result.reason === "confirmed") {
                          broadcast({ type: "action_resolved", actionId: target.id, outcome: "confirmed" });
                          pushApprovalNarration(session, `Done — ${redactSecrets(target.summary ?? "")}.`);
                        }
                        // lost_race / not_found -> a concurrent REST already resolved it; stay silent
                        // (no double-narration, no pane re-broadcast).
                      } else {
                        // reject
                        const result = pendingActions.cancel(target.id);
                        broadcast({ type: "action_resolved", actionId: target.id, outcome: "cancelled" });
                        if (result.reason === "cancelled") pushApprovalNarration(session, `Cancelled — ${redactSecrets(target.summary ?? "")}.`);
                      }
                    }
                  }
                }
              }
            }
            if (modelUtterance) {
              currentSessionModelUtterance = modelUtterance;
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

              // Guard every tool handler: an uncaught throw here would escape the Gemini SDK
              // onmessage callback, leave this call.id unanswered, and stall the conversation.
              try {
              if (name === "list_panes") {
                const list = manager.listPanes();
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: list } }]
                });
              } else if (name === "get_pane_command_history") {
                const targetId = args.pane_id;
                const term = manager.terminals[targetId];
                let cwd = process.cwd();
                if (term) {
                  cwd = term.cwd;
                } else {
                  const activeProject = manager.ledger.getActiveProject();
                  if (activeProject) {
                    cwd = activeProject.directory || process.cwd();
                  }
                }
                const history = HistoryManager.getInstance().loadHistory(targetId);
                const conciseHistory = history.map((entry: any) => ({
                  command: entry.command,
                  timestamp: entry.timestamp,
                  // WS-B: when no summarized finalResponse exists, the raw output fallback is
                  // ANSI-stripped then secret-redacted before it reaches the Gemini model.
                  finalResponse: entry.finalResponse || redactSecrets(stripAnsiSequences(entry.output).slice(-300).trim()) || "No output captured."
                }));
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: conciseHistory } }]
                });
              } else if (name === "get_pane_summary") {
                const targetId = args.pane_id;
                const out = manager.getPaneSummary(targetId);
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: out } }]
                });
              } else if (name === "get_pane_delta") {
                const targetId = args.pane_id;
                const out = manager.getPaneDelta(targetId);
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: out } }]
                });
              } else if (name === "switch_context") {
                const projectId = args.project_id;
                manager.ledger.switchContext(projectId);
                manager.settings.projects.activeContext = projectId;
                const wsPath = manager.ledger.workspaces[projectId]?.directory || process.cwd();
                manager.settings.projects.localWorkspacePath = wsPath;
                manager.saveSettings();
                broadcastLedgerUpdate();
                const briefing = manager.ledger.getProjectBriefing(projectId) || { error: "Project not found" };
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: briefing } }]
                });
              } else if (name === "propose_command") {
                const targetId = args.pane_id;
                // R2 back-compat: accept the legacy `command` arg as an alias for `instruction`.
                const instruction = args.instruction ?? args.command ?? "";
                const explicitKind: ApprovalKind | undefined =
                  args.kind === "shell" || args.kind === "agent_instruction" ? args.kind : undefined;
                const trigger = currentSessionUserUtterance || "Spoken execute command";

                const outcome = dispatchProposal({ sess: session, callId: call.id, targetId, instruction, explicitKind, trigger });
                // WS-E.1 (BUG-001): ALWAYS answer call.id exactly once. Pending is answered
                // NON-BLOCKINGLY (pending_approval) so Janus is not muted and can read it back.
                if (outcome.kind === "pending") {
                  session.sendToolResponse({
                    functionResponses: [{ name: "propose_command", id: call.id, response: { status: "pending_approval", messageId: call.id, pane_id: targetId, prompt: outcome.text } }]
                  });
                } else if (outcome.kind === "clarify") {
                  session.sendToolResponse({
                    functionResponses: [{ name: "propose_command", id: call.id, response: { status: "clarify", output: outcome.text } }]
                  });
                } else {
                  session.sendToolResponse({
                    functionResponses: [{ name: "propose_command", id: call.id, response: { output: outcome.text } }]
                  });
                }
              } else if (name === "switch_active_pane") {
                // Step 5: Janus may change which pane is open ONLY when the operator directs it
                // ("switch to the build pane"). This moves the UI's source of truth: the server
                // records the new active pane and tells the UI to open it; the UI echoes it back
                // via set_active_pane. It does NOT write any command — it just changes focus.
                const targetId = args.pane_id;
                const term = manager.terminals[targetId];
                const wsProj = manager.ledger.getActiveProject();
                const paneExists = !!term || !!(wsProj && wsProj.panes[targetId]);
                let output = "";
                if (!paneExists) {
                  output = `Cannot switch: pane '${targetId}' does not exist.`;
                } else {
                  activePaneId = targetId;
                  broadcast({ type: "switch_active_pane", paneId: targetId });
                  output = `Opened pane '${targetId}'. It is now the active pane; I can propose commands here for your approval.`;
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output } }]
                });
              } else if (name === "update_draft_prompt") {
                // Step 6: Janus composes/refines the WIP draft for the OPERATOR to review and send.
                // It does NOT send (sending is operator-direct). Targets the active pane.
                const t = activeDraftTarget();
                let output = "";
                if (!t) {
                  output = "No pane is open, so there is no draft to write. Ask the operator to open a pane first.";
                } else {
                  const mode = args.mode === "append" ? "append" : "replace";
                  const text = String(args.text ?? "");
                  if (mode === "append") manager.ledger.appendDraft(t.projectId, t.paneId, text, "janus");
                  else manager.ledger.setDraft(t.projectId, t.paneId, text, "janus");
                  broadcastDraft(t.projectId, t.paneId);
                  output = `Draft for pane '${t.paneId}' updated (${mode}). The operator can review and send it.`;
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output } }]
                });
              } else if (name === "list_pending_approvals") {
                // WS-E.1 (BUG-016): let the eyes-off operator ask "what's queued for approval?"
                // Reads the SAME store the REST endpoint reads, redacted, scoped to this session.
                const entries = pendingApprovals.forSession(session);
                if (entries.length) pendingApprovals.setLastAnnounced(session, entries[entries.length - 1].messageId);
                // M3: reuse serializePending (it already redacts + computes ageSeconds); add the
                // voice-facing `index`/`pane_id` aliases on top so we don't hand-roll a 3rd shape.
                const items = entries.map((p, i) => {
                  const ser = serializePending(p);
                  return { index: i + 1, pane_id: ser.terminalId, ...ser };
                });
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: { count: items.length, items } } }]
                });
              } else if (name === "add_project_note") {
                const ok = manager.ledger.addNote(args.project_id, args.note);
                if (ok) broadcastLedgerUpdate();
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: ok ? `Note added to project ${args.project_id}` : `Could not add note: project ${args.project_id} not found.` } }]
                });
              } else if (name === "add_pane_note") {
                // MUST-FIX #4 (bead bjm): pane_id defaults to the server-tracked active pane. When no
                // pane is open there is nowhere to attach the note — write nothing and say so.
                const paneId = (typeof args.pane_id === "string" && args.pane_id) ? args.pane_id : activePaneId;
                if (!paneId) {
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: "No pane is open, so there's nowhere to attach this note. Open a pane first." } }]
                  });
                } else {
                  const projectId = args.project_id || manager.ledger.activeProjectId || "default_project";
                  const ok = manager.ledger.addPaneNote(projectId, paneId, args.note);
                  if (ok) broadcastLedgerUpdate();
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: ok ? `Note added to pane ${paneId}` : `Could not add note: pane ${paneId} not found in project ${projectId}.` } }]
                  });
                }
              } else if (name === "get_project_notes") {
                // bead bjm: read-only recall. Works WITHOUT switch_context (defaults to the active
                // project). MUST-FIX #1: redact every snippet handed to the model (model-egress guard).
                // An explicit project_id may recall another project's notes — intentional under the
                // single-operator trust model (one director, one token); snippets are still redacted.
                const projectId = args.project_id || manager.ledger.activeProjectId || "default_project";
                const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
                const notes = manager.ledger.getNotes({ projectId }).slice(0, limit).map((n) => ({
                  id: n.id, pane_id: n.pane_id, type: n.type, created_at: n.created_at, text: redactSecrets(n.text),
                }));
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: { project_id: projectId, count: notes.length, notes } } }]
                });
              } else if (name === "search_notes") {
                // bead bjm MUST-FIX #2: store.search returns note AND event rows — request note-only
                // (so a flood of higher-ranked events can't starve notes out of the limit) and redact
                // every snippet before it reaches the model. The source==='note' filter is kept as
                // belt-and-suspenders in case a backend ignores the hint.
                const query = String(args.query ?? "");
                const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
                const results = manager.ledger.search(query, { limit, source: "note" })
                  .filter((r) => r.source === "note")
                  .slice(0, limit)
                  .map((r) => ({ id: r.id, snippet: redactSecrets(r.snippet) }));
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: { query, count: results.length, results } } }]
                });
              } else if (name === "amend_note") {
                // bead bjm MUST-FIX #3: gate through update_metadata; mutate ONLY inside the run
                // closure; bind the amend text at enqueue time so a later Ask-confirm applies exactly
                // this text (not whatever the model says next).
                const noteId = String(args.note_id ?? "");
                const newText = String(args.text ?? "");
                const amendEffect = (): string => {
                  manager.ledger.amendNote(noteId, newText);
                  broadcastLedgerUpdate();
                  return `Note ${noteId} updated.`;
                };
                const g = gateOrDefer("update_metadata", null, `Amend note ${noteId}`, amendEffect);
                let output: string;
                if (g.disposition === "forbidden") output = `Error: the 'update_metadata' capability is gated Off; amending notes is forbidden by policy.`;
                else if (g.disposition === "deferred") output = `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to apply the amendment.`;
                else output = amendEffect();
                session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output } }] });
              } else if (name === "delete_note") {
                // bead bjm MUST-FIX #3: gate through update_metadata; mutate ONLY inside the run closure.
                const noteId = String(args.note_id ?? "");
                const deleteEffect = (): string => {
                  manager.ledger.deleteNote(noteId);
                  broadcastLedgerUpdate();
                  return `Note ${noteId} deleted.`;
                };
                const g = gateOrDefer("update_metadata", null, `Delete note ${noteId}`, deleteEffect);
                let output: string;
                if (g.disposition === "forbidden") output = `Error: the 'update_metadata' capability is gated Off; deleting notes is forbidden by policy.`;
                else if (g.disposition === "deferred") output = `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to delete the note.`;
                else output = deleteEffect();
                session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output } }] });
              } else if (name === "rename_project") {
                manager.ledger.renameProject(args.project_id, args.name);
                broadcastLedgerUpdate();
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Project renamed to ${args.name}` } }]
                });
              } else if (name === "rename_pane") {
                manager.ledger.renamePane(args.project_id, args.pane_id, args.name);
                broadcastLedgerUpdate();
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Pane renamed to ${args.name}` } }]
                });
              } else if (name === "get_attention_digest") {
                pruneAttention(); // BUG-035: evict stale items before reading the digest
                const unread = manager.attentionQueue.filter(item => !item.dismissed);
                // BUG-009: MERGE pending approvals — the digest tool claims to cover approvals,
                // so it must actually include them (one source of truth: the same store
                // list_pending_approvals / GET /api/commands/pending read).
                const pending = pendingApprovals.forSession(session);
                let text = "";
                if (unread.length === 0 && pending.length === 0) {
                  text = "There are no pending alerts or actions requiring your attention right now.";
                } else {
                  if (unread.length > 0) {
                    text += `There are ${unread.length} items requiring attention. `;
                    unread.forEach((item, index) => {
                      // BUG-025: enrich with live elapsed time + last command so Janus can
                      // say e.g. "Pane build has been busy 4 minutes running npm run build."
                      const term = manager.terminals[item.terminalId];
                      let timing = "";
                      if (term) {
                        const elapsedMs = Date.now() - term.lastStatusChangeAt;
                        const mins = Math.floor(elapsedMs / 60000);
                        const secs = Math.floor((elapsedMs % 60000) / 1000);
                        const dur = mins > 0 ? `${mins} minute${mins === 1 ? "" : "s"}` : `${secs} second${secs === 1 ? "" : "s"}`;
                        timing = ` It has been ${term.status.toLowerCase()} for ${dur}`;
                        // P2 (WS-B): redact secrets in the verbatim last command so a
                        // token typed as a command is never surfaced/spoken unredacted.
                        if (term.lastCommand) timing += `, last command was '${redactSecrets(term.lastCommand)}'`;
                        timing += ".";
                      }
                      text += `${index + 1}. Pane ${item.terminalId} in project ${item.projectId} transitioned to ${item.type}: ${item.message}.${timing} `;
                    });
                  }
                  if (pending.length > 0) {
                    pendingApprovals.setLastAnnounced(session, pending[pending.length - 1].messageId);
                    text += `You also have ${pending.length} command${pending.length === 1 ? "" : "s"} awaiting approval: `;
                    pending.forEach((p, i) => {
                      const verb = p.kind === "agent_instruction" ? "direct pane" : "run on pane";
                      text += `${i + 1}. ${verb} ${p.terminalId} — "${redactSecrets(p.instruction)}". `;
                    });
                  }
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: text } }]
                });
              } else if (name === "dismiss_attention") {
                // BUG-035: let the eyes-off operator clear an attention item by voice.
                // Mirrors the REST dismiss path (/api/attention/:id/dismiss) so REST and
                // voice share one queue. `id` omitted -> dismiss all.
                const targetId = args.id;
                let output: string;
                if (targetId) {
                  const item = manager.attentionQueue.find(i => i.id === targetId);
                  if (item) {
                    item.dismissed = true;
                    output = `Dismissed attention item ${targetId}.`;
                  } else {
                    output = `No attention item found with id ${targetId}.`;
                  }
                } else {
                  const count = manager.attentionQueue.filter(i => !i.dismissed).length;
                  manager.attentionQueue.forEach(i => i.dismissed = true);
                  output = `Dismissed all ${count} pending attention item${count === 1 ? "" : "s"}.`;
                }
                pruneAttention();
                broadcast({ type: "attention_updated", queue: manager.attentionQueue });
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output } }]
                });
              } else if (name === "create_project") {
                const { project_id, directory, summary, key_terms } = args;
                // G5: reject a non-existent caller-supplied directory before persisting it
                // (a bad dir later taints every child pane's cwd). Blank/"." resolves to the
                // server cwd. The rejection is a spoken-friendly tool response so the model
                // can re-prompt the operator, matching the gated-Off voice error style below.
                if (isBadProjectDir(directory)) {
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: {
                      output: `Error: the directory '${String(directory).trim()}' does not exist, so I did not create project ${project_id}. Give me a folder that exists, or omit it to use the current workspace.`
                    } }]
                  });
                } else {
                  manager.ledger.addProject(project_id, resolveProjectDir(directory), summary || "", key_terms || []);
                  broadcastLedgerUpdate();
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: `Project context ${project_id} created successfully.` } }]
                  });
                }
              } else if (name === "create_pane") {
                const { project_id, pane_id, command, tool_preset, permissions_mode } = args;
                const createPaneEffect = (): string => {
                  if (!manager.ledger.getProject(project_id)) {
                    manager.ledger.addProject(project_id, ".", "Co-created with pane");
                  }
                  const result = manager.addTerminal(
                    pane_id,
                    manager.ledger.workspaces[project_id]?.directory || process.cwd(),
                    command,
                    tool_preset || "Custom",
                    permissions_mode || "Human-in-the-Loop",
                    "",
                    project_id
                  );
                  broadcastLedgerUpdate();
                  broadcastTerminalsUpdated();
                  return `Pane ${pane_id} created under project ${project_id}. Result: ${result}`;
                };
                const g = gateOrDefer("create_pane", pane_id ?? null, `Create pane ${pane_id} (${command}) in ${project_id}`, createPaneEffect);
                if (g.disposition === "forbidden") {
                  session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `Error: the 'create_pane' capability is gated Off; pane creation is forbidden by policy.` } }] });
                } else if (g.disposition === "deferred") {
                  session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to create the pane.` } }] });
                } else {
                  session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: createPaneEffect() } }] });
                }
              } else if (name === "set_global_permissions") {
                const { permissions_mode } = args;
                // The deferred side effect (runs now on Auto, or on operator confirm under Ask).
                const applyGlobalPerms = (): string => {
                  manager.globalPermissionsMode = permissions_mode;
                  manager.settings.advanced.globalPermissionsMode = permissions_mode;
                  manager.saveSettings();
                  broadcast({
                    type: "settings_updated",
                    globalPermissionsMode: permissions_mode,
                    settings: sanitizeSettingsForClient(manager.settings)
                  });
                  return `Global permissions updated to ${permissions_mode}.`;
                };
                const g = gateOrDefer("set_global_permissions", null, `Set global permissions to ${permissions_mode}`, applyGlobalPerms);
                if (g.disposition === "forbidden") {
                  session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `Error: the 'set_global_permissions' capability is gated Off; this change is forbidden by policy.` } }] });
                } else if (g.disposition === "deferred") {
                  session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to apply.` } }] });
                } else {
                  session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: applyGlobalPerms() } }] });
                }
              } else if (name === "set_voice_mute") {
                const { muted } = args;
                manager.settings.voiceAi.isMicMuted = muted;
                manager.saveSettings();
                broadcast({
                  type: "settings_updated",
                  settings: sanitizeSettingsForClient(manager.settings)
                });
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Microphone now ${muted ? 'muted' : 'active-listening'}.` } }]
                });
              } else if (name === "create_orchestrator_plan") {
                const { name: planName, steps } = args;
                const formattedSteps = steps.map((s: any, idx: number) => ({
                  id: "step_" + idx,
                  terminalId: s.terminalId,
                  command: s.command,
                  expectedTransition: s.expectedTransition || "idle",
                  status: "pending" as const
                }));
                const newPlan = {
                  id: "plan_" + Math.random().toString(36).substring(2, 11),
                  name: planName,
                  steps: formattedSteps,
                  currentStepIndex: 0,
                  status: "idle" as const
                };
                manager.ledger.plans.push(newPlan);
                manager.ledger["save"](true);
                broadcast({ type: "plans_updated", plans: manager.ledger.plans });
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Multi-pane plan '${planName}' created. Contains ${steps.length} steps.` } }]
                });
              } else if (name === "execute_plan") {
                const { plan_id } = args;
                const plan = manager.ledger.plans.find(p => p.id === plan_id);
                let resp = "";
                if (plan) {
                  plan.status = "running";
                  plan.currentStepIndex = 0;
                  plan.steps.forEach((s, idx) => s.status = idx === 0 ? "running" : "pending");
                  const currentStep = plan.steps[0];

                  // R4: route the plan step's pane write through the SAME effective-mode gate +
                  // pending-approval path. In HiTL the step becomes a spoken pending approval
                  // (it does NOT auto-execute); Full Auto still runs immediately.
                  const stepOutcome = dispatchProposal({
                    sess: session,
                    callId: call.id,
                    pendingId: `${call.id}__${plan.id}__step0`,
                    targetId: currentStep.terminalId,
                    instruction: currentStep.command,
                    trigger: `Plan '${plan.name}' step 1`,
                    // Gate-bypass fix: ride the execute_plan capability (not the default
                    // write_to_pane) so capabilityGates.execute_plan is actually enforced.
                    capability: "execute_plan",
                  });
                  if (stepOutcome.kind === "executed") {
                    resp = `Started execution of plan '${plan.name}'! Running step 1 on '${currentStep.terminalId}'.`;
                  } else if (stepOutcome.kind === "pending") {
                    resp = `Plan '${plan.name}' step 1 needs approval: ${stepOutcome.text}`;
                  } else if (stepOutcome.kind === "clarify") {
                    plan.status = "paused";
                    currentStep.status = "failed";
                    resp = `Plan '${plan.name}' step 1 paused: ${stepOutcome.text}`;
                  } else {
                    plan.status = "paused";
                    currentStep.status = "failed";
                    resp = `Could not start plan '${plan.name}': ${stepOutcome.text}`;
                  }
                  manager.ledger["save"](true);
                  broadcast({ type: "plans_updated", plans: manager.ledger.plans });
                } else {
                  resp = `Error: Plan '${plan_id}' not found.`;
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "apply_orchestration_recipe") {
                const { recipe_id } = args;
                const activeProjectId = manager.ledger.activeProjectId || "default_project";
                const proj = manager.ledger.getProject(activeProjectId);
                let resp = "";
                if (!proj) {
                  resp = "Error: There is no active project context synchronized to apply templates under.";
                } else {
                  const recipe = recipes.find(r => r.id === recipe_id);
                  if (!recipe) {
                    resp = `Error: Template recipe ${recipe_id} not found.`;
                  } else {
                    // bri (WS-F scope C): converge the voice recipe path onto the SAME staged-deferral
                    // seam as REST `POST /api/recipes/apply`. Previously this handler spawned live PTYs
                    // via addTerminal() on create_pane=Ask (apply-now, Off-veto only) while REST deferred
                    // — the WF-2 divergence. Now the shared pure planner (planRecipeApply) decides each
                    // pane's disposition, and Ask panes are STAGED in pendingActions (gateOrDefer) so
                    // "Ask means stage+confirm" holds at BOTH the voice and REST boundaries.
                    // Keep one gateCapability call for the layout-level `apply_recipe` audit row (the
                    // planner is pure and emits none); the veto is authoritative via plan.layoutForbidden.
                    gateCapability("apply_recipe", null);
                    const plan = planRecipeApply(
                      recipe.panes,
                      new Set(Object.keys(manager.terminals)),
                      () => effectiveCapabilityGateFor(null, "apply_recipe"),
                      (id) => effectiveCapabilityGateFor(id, "create_pane"),
                    );
                    if (plan.layoutForbidden) {
                      resp = `Error: the 'apply_recipe' capability is gated Off; spawning template layouts is forbidden by policy.`;
                    } else {
                      const bareShell = manager.settings.advanced.defaultShellCommand || (process.platform === "win32" ? "cmd.exe" : "bash");
                      const paneById = new Map(recipe.panes.map(p => [p.id, p]));
                      const spawned: string[] = [];
                      const deferred: string[] = [];
                      const blocked: string[] = [];
                      for (const planned of plan.panes) {
                        if (planned.disposition === "skip-existing") continue;
                        if (planned.disposition === "block") { blocked.push(planned.paneId); continue; }
                        const p = paneById.get(planned.paneId)!;
                        // Same spawn closure shape as REST (server.ts ~1293): bare shell, startupCommand
                        // recorded as an auditable pane note, broadcasts INSIDE so a deferred-confirm repaints.
                        const spawnPane = (): string => {
                          manager.addTerminal(p.id, proj.directory || process.cwd(), bareShell, p.preset as any, p.permissionsMode as any, "", activeProjectId);
                          if (p.startupCommand) {
                            manager.ledger.addPaneNote(activeProjectId, p.id, `Suggested startup command: ${p.startupCommand}`);
                          }
                          broadcastLedgerUpdate();
                          broadcast({ type: "terminals_updated" });
                          return p.id;
                        };
                        if (planned.disposition === "defer") {
                          // Route through gateOrDefer so the audit row + action_pending broadcast +
                          // pendingActions.add fire identically to REST. (gateOrDefer re-resolves the
                          // gate; the planner already classified it Ask, so this stages.)
                          const g = gateOrDefer("create_pane", p.id, `Create pane ${p.id} (recipe ${recipe.id})`, spawnPane);
                          if (g.disposition === "forbidden") blocked.push(p.id);
                          else if (g.disposition === "deferred") deferred.push(p.id);
                          else { spawnPane(); spawned.push(p.id); }
                        } else {
                          // Auto -> spawn now.
                          spawnPane();
                          spawned.push(p.id);
                        }
                      }
                      resp = `Template recipe layout '${recipe.name}': spawned ${spawned.length} pane(s)`
                        + (deferred.length ? `, ${deferred.length} awaiting your confirmation (create_pane=Ask: ${deferred.join(", ")})` : "")
                        + (blocked.length ? `, ${blocked.length} blocked by create_pane=Off (${blocked.join(", ")})` : "")
                        + ".";
                    }
                  }
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "handoff_context_between_panes") {
                const { source_pane_id, target_pane_id, context_notes } = args;
                const sourceTerm = manager.terminals[source_pane_id];
                const targetTerm = manager.terminals[target_pane_id];
                
                let resp = "";
                // Prompt-composer refactor: handoff carries CONTEXT, not commands. It writes to
                // the target pane's model-context layer (ungated, not a CLI write) and never
                // injects into the target pane's stdin — so there is no effective-mode gate here.
                // (architecture §5: Remove handoff stdin injection.)
                if (!sourceTerm || !targetTerm) {
                  resp = `Error: Both source and target terminal panes must be active. (Source: ${sourceTerm ? 'OK':'Not found'}, Target: ${targetTerm ? 'OK':'Not found'})`;
                } else {
                  const sourceHistory = HistoryManager.getInstance().loadHistory(source_pane_id);
                  const lastFiveOutlines = sourceHistory.map(h => `${h.command} -> ${h.finalResponse || "executed"}`).slice(-5).join(" | ");

                  const activeProjectId = manager.ledger.activeProjectId || "default_project";
                  const handoffNote = `Handoff from [${source_pane_id}] with notes: ${context_notes}. Last events: ${lastFiveOutlines}`;

                  manager.ledger.addModelContext(activeProjectId, target_pane_id, handoffNote, "handoff");

                  broadcastLedgerUpdate();
                  resp = `Handoff context from [${source_pane_id}] recorded into [${target_pane_id}]'s orientation context. No command was written to the pane.`;
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "propose_handoff") {
                // UNGATED (design §4/§6): drafting never touches a pane. Insert a 'composing' row,
                // snapshot source_context (live getPaneSummary OR archived scrollback) + redact it.
                const { to_pane, draft_text, from_pane, rationale } = args;
                let resp: any;
                if (!store) {
                  resp = "Error: the persistent store is unavailable; handoffs cannot be created right now.";
                } else if (!to_pane) {
                  resp = "Error: a target pane (to_pane) is required for a handoff.";
                } else {
                  const activeProjectId = manager.ledger.activeProjectId || "default_project";
                  // source_context: prefer the live pane summary; fall back to command history.
                  let sourceSummary = "";
                  if (from_pane) {
                    if (manager.terminals[from_pane]) {
                      sourceSummary = redactSecrets(manager.getPaneSummary(from_pane, 12));
                    } else {
                      const hist = HistoryManager.getInstance().loadHistory(from_pane);
                      sourceSummary = redactSecrets(hist.map(h => `${h.command} -> ${h.finalResponse || "executed"}`).slice(-8).join("\n"));
                    }
                  }
                  const sourceContext = {
                    from_pane: from_pane ?? null,
                    rationale: rationale ? redactSecrets(String(rationale)) : null,
                    summary: sourceSummary || "[no source context captured]",
                    captured_at: new Date().toISOString(),
                  };
                  const targetTerm = manager.terminals[to_pane];
                  const kind: ApprovalKind = targetTerm?.runtimeType === "shell" ? "shell" : "agent_instruction";
                  const h = store.createHandoff({
                    workspace_id: activeProjectId,
                    from_pane: from_pane ?? null,
                    to_pane,
                    kind,
                    composed_prompt: draft_text ?? "",
                    source_context: JSON.stringify(sourceContext),
                    state: "composing",
                  });
                  broadcast({ type: "handoffs_updated" });
                  resp = {
                    handoff_id: h.id,
                    state: h.state,
                    to_pane: h.to_pane,
                    composed_prompt: redactSecrets(h.composed_prompt),
                    message: `Drafted handoff ${h.id} to pane ${to_pane} (state: composing). Read the draft back to the operator; revise by voice, then stage and deliver.`,
                  };
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "revise_handoff") {
                // UNGATED: rewrite the same row, revision_count++ (the co-authoring heartbeat).
                const { handoff_id, new_draft_text } = args;
                let resp: any;
                if (!store) {
                  resp = "Error: the persistent store is unavailable.";
                } else {
                  const updated = store.updateHandoffCargo(handoff_id, new_draft_text ?? "");
                  if (!updated) {
                    resp = `Error: handoff ${handoff_id} not found.`;
                  } else {
                    broadcast({ type: "handoffs_updated" });
                    resp = {
                      handoff_id: updated.id,
                      state: updated.state,
                      revision_count: updated.revision_count,
                      composed_prompt: redactSecrets(updated.composed_prompt),
                      message: `Revised handoff ${handoff_id} (revision ${updated.revision_count}). Read it back; stage when the operator is satisfied.`,
                    };
                  }
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "stage_handoff") {
                // UNGATED: freeze the text, cheap live-pane pre-check, state -> staged.
                const { handoff_id } = args;
                let resp: any;
                if (!store) {
                  resp = "Error: the persistent store is unavailable.";
                } else {
                  const h = store.getHandoff(handoff_id);
                  if (!h) {
                    resp = `Error: handoff ${handoff_id} not found.`;
                  } else {
                    const targetTerm = manager.terminals[h.to_pane];
                    const wsProj = manager.ledger.getActiveProject();
                    const targetExists = !!targetTerm || !!(wsProj && wsProj.panes[h.to_pane]);
                    if (!targetExists) {
                      resp = `Cannot stage: target pane ${h.to_pane} no longer exists.`;
                    } else {
                      // Secret guard (director posture: prompts must never contain secrets).
                      // High-confidence leak -> BLOCK staging; low-confidence -> stage WITH a warning.
                      const scan = classifySecrets(h.composed_prompt);
                      if (scan.confidence === "high") {
                        if (store) {
                          const activeProjectId = manager.ledger.activeProjectId || "default_project";
                          store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: h.to_pane, summary: `BLOCKED staging handoff ${handoff_id}: secret detected (${scan.labels.join(", ")})`, payload: { handoff_id, refused: true, secret_labels: scan.labels }, handoff_id });
                        }
                        resp = `Blocked: the composed prompt for handoff ${handoff_id} appears to contain a secret (${scan.labels.join(", ")}). Prompts must never carry secrets — revise it to remove the credential, then stage again.`;
                      } else {
                        const staged = store.updateHandoffState(handoff_id, "staged");
                        broadcast({ type: "handoffs_updated" });
                        const warn = scan.confidence === "low"
                          ? ` WARNING: the prompt contains a possible credential assignment (${scan.labels.join(", ")}) — confirm it carries no real secret before approving delivery.`
                          : "";
                        resp = {
                          handoff_id,
                          state: staged?.state,
                          message: `Handoff ${handoff_id} is staged for pane ${h.to_pane}. Ask the operator to approve delivery (deliver_handoff).${warn}`,
                        };
                      }
                    }
                  }
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "read_handoff") {
                // UNGATED read; redacted output.
                const { handoff_id } = args;
                let resp: any;
                if (!store) {
                  resp = "Error: the persistent store is unavailable.";
                } else {
                  const h = store.getHandoff(handoff_id);
                  resp = h ? {
                    handoff_id: h.id, state: h.state, from_pane: h.from_pane, to_pane: h.to_pane,
                    kind: h.kind, revision_count: h.revision_count,
                    composed_prompt: redactSecrets(h.composed_prompt),
                    source_context: h.source_context, // already redacted at compose time
                  } : `Error: handoff ${handoff_id} not found.`;
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "list_handoffs") {
                // UNGATED read; redacted output.
                const { state } = args;
                let resp: any;
                if (!store) {
                  resp = "Error: the persistent store is unavailable.";
                } else {
                  const activeProjectId = manager.ledger.activeProjectId || "default_project";
                  const rows = store.listHandoffs({ workspaceId: activeProjectId, state: state || undefined });
                  const now = Date.now();
                  resp = rows.map(h => {
                    const stale = h.state === "staged" && isStagedStale(h.staged_at, now);
                    return {
                      handoff_id: h.id, state: h.state, to_pane: h.to_pane, from_pane: h.from_pane,
                      revision_count: h.revision_count, composed_prompt: redactSecrets(h.composed_prompt).slice(0, 200),
                      // Staged drafts never auto-expire; surface a stale flag so the operator notices.
                      ...(h.state === "staged" ? { stale, staged_age_seconds: h.staged_at ? Math.floor((now - h.staged_at) / 1000) : null } : {}),
                    };
                  });
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "reject_handoff") {
                // UNGATED pre-gate flip; if a delivery is pending, route through the gate's reject.
                const { handoff_id } = args;
                let resp: any;
                if (!store) {
                  resp = "Error: the persistent store is unavailable.";
                } else {
                  const h = store.getHandoff(handoff_id);
                  if (!h) {
                    resp = `Error: handoff ${handoff_id} not found.`;
                  } else if (h.gate_approval_id && pendingApprovals.has(h.gate_approval_id)) {
                    // A delivery is pending at the gate — route through the SAME claim gate.
                    applyResolution(h.gate_approval_id, "reject");
                    resp = { handoff_id, state: "rejected", message: `Cancelled the pending delivery of handoff ${handoff_id}.` };
                  } else {
                    store.updateHandoffState(handoff_id, "rejected");
                    broadcast({ type: "handoffs_updated" });
                    resp = { handoff_id, state: "rejected", message: `Handoff ${handoff_id} rejected.` };
                  }
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "deliver_handoff") {
                // GATED — the ONLY handoff handler that writes. Rides dispatchProposal with
                // capability "deliver_handoff" (AND-composed with write_to_pane / effectiveMode).
                const { handoff_id } = args;
                if (!store) {
                  session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: "Error: the persistent store is unavailable." } }] });
                } else {
                  const h = store.getHandoff(handoff_id);
                  if (!h) {
                    session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `Error: handoff ${handoff_id} not found.` } }] });
                  } else if (h.state !== "staged") {
                    session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `Handoff ${handoff_id} is '${h.state}', not 'staged'. Stage it before delivery.` } }] });
                  } else if (classifySecrets(h.composed_prompt).confidence === "high") {
                    // Deliver-time backstop: a prompt revised to a secret after staging is still
                    // hard-blocked before it can reach the PTY (prompts must never carry secrets).
                    const scan = classifySecrets(h.composed_prompt);
                    if (store) {
                      const activeProjectId = manager.ledger.activeProjectId || "default_project";
                      store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: h.to_pane, summary: `BLOCKED delivery of handoff ${handoff_id}: secret detected (${scan.labels.join(", ")})`, payload: { handoff_id, refused: true, secret_labels: scan.labels }, handoff_id });
                    }
                    session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `Blocked: handoff ${handoff_id}'s prompt appears to contain a secret (${scan.labels.join(", ")}). Revise it to remove the credential before delivery.` } }] });
                  } else {
                    const outcome = dispatchProposal({
                      sess: session,
                      callId: call.id,
                      pendingId: handoff_id,
                      targetId: h.to_pane,
                      instruction: h.composed_prompt,
                      explicitKind: h.kind,
                      trigger: "handoff delivery",
                      capability: "deliver_handoff",
                    });
                    // Pure mapping (src/handoffFlow): dispatch outcome -> persisted-row effect.
                    // One source of truth, unit- + smoke-tested against a real JanusStore (G3).
                    const effect = deliverOutcomeToHandoff(outcome.kind as any);
                    if (effect.kind === "deliver_now") {
                      // Full Auto: the write already landed; flip the row to delivered now.
                      store.updateHandoffState(handoff_id, effect.state, { approved_via: effect.approvedVia });
                      broadcast({ type: "handoffs_updated" });
                      session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `Delivered handoff ${handoff_id} to pane ${h.to_pane}.` } }] });
                    } else if (effect.kind === "await_approval") {
                      // HiTL: persist the gate_approval_id; applyResolution flips to delivered on approve.
                      store.setGateApprovalId(handoff_id, handoff_id);
                      broadcast({ type: "handoffs_updated" });
                      session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { status: "pending_approval", messageId: handoff_id, pane_id: h.to_pane, prompt: outcome.text } }] });
                    } else if (effect.kind === "block") {
                      store.updateHandoffState(handoff_id, effect.state);
                      broadcast({ type: "handoffs_updated" });
                      session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: outcome.text } }] });
                    } else {
                      session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: outcome.text } }] });
                    }
                  }
                }
              } else if (name === "set_capability_gate") {
                // META self-gate (design §6, director posture 2026-06-01): "changing the locks"
                // is the one deliberate exception to defaults-are-overridable. TIGHTENING a gate
                // by voice (e.g. Auto->Ask, Ask->Off) is always safe and applies immediately.
                // LOOSENING by voice (e.g. Off->Ask, Ask->Auto) is REFUSED — it must be a
                // deliberate UI act, so a confused/misheard Janus cannot loosen its own restraints.
                const { pane_id, capability, gate } = args;
                const validGates = ["Auto", "Ask", "Off"];
                let resp: any;
                if (!validGates.includes(gate)) {
                  resp = `Invalid gate "${gate}". Must be one of: Auto, Ask, Off.`;
                } else if (isLoosening(effectiveCapabilityGateFor(pane_id || null, capability as CapabilityGate), gate as GateValue)) {
                  const current = effectiveCapabilityGateFor(pane_id || null, capability as CapabilityGate);
                  resp = `For safety I can't LOOSEN a capability gate by voice (you asked to change '${capability}' from ${current} to ${gate}). Loosening must be done deliberately in the Settings UI. I can TIGHTEN gates by voice anytime.`;
                  if (store) {
                    const activeProjectId = manager.ledger.activeProjectId || "default_project";
                    store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: pane_id ?? null, summary: `REFUSED voice loosen ${capability} ${current}->${gate}${pane_id ? ` (pane ${pane_id})` : " (global)"}`, payload: { capability, from: current, to: gate, pane_id: pane_id ?? null, refused: true } });
                  }
                } else {
                  if (!manager.settings.advanced.capabilityGates) manager.settings.advanced.capabilityGates = {};
                  if (pane_id) {
                    const proj = manager.ledger.getActiveProject();
                    const pane = proj?.panes?.[pane_id];
                    if (!pane) {
                      resp = `Pane ${pane_id} not found in the active project.`;
                    } else {
                      pane.capabilityGates = { ...(pane.capabilityGates || {}), [capability]: gate };
                      // Persist via updatePane so the per-pane override survives in BOTH backends
                      // (SQLite writes the capability_gates column; a bare save() would be a no-op
                      // there — bead 8sq schema v4).
                      manager.ledger.updatePane(manager.ledger.activeProjectId || "default_project", pane, true);
                      resp = `Set per-pane gate '${capability}' = ${gate} for pane ${pane_id}.`;
                    }
                  } else {
                    manager.settings.advanced.capabilityGates[capability as CapabilityGate] = gate as GateValue;
                    manager.saveSettings();
                    resp = `Set global gate '${capability}' = ${gate}.`;
                  }
                  if (store) {
                    const activeProjectId = manager.ledger.activeProjectId || "default_project";
                    store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: pane_id ?? null, summary: `gate ${capability}=${gate}${pane_id ? ` (pane ${pane_id})` : " (global)"}`, payload: { capability, gate, pane_id: pane_id ?? null } });
                  }
                  broadcast({ type: "settings_updated", settings: sanitizeSettingsForClient(manager.settings) });
                }
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: resp } }]
                });
              } else if (name === "get_pane_gates") {
                // UNGATED read.
                const { pane_id } = args;
                const caps: CapabilityGate[] = [
                  "write_to_pane", "deliver_handoff", "create_pane", "close_pane", "restart_pane",
                  "set_pane_permissions", "set_global_permissions", "set_capability_gate",
                  "add_watch_rule", "execute_plan", "apply_recipe", "create_project",
                  "update_metadata", "switch_context", "set_voice_mute", "dismiss_attention",
                ];
                const resolved: Record<string, GateValue> = {};
                for (const c of caps) resolved[c] = effectiveCapabilityGateFor(pane_id || null, c);
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: { pane_id: pane_id ?? null, gates: resolved } } }]
                });
              } else if (name === "list_capabilities") {
                // UNGATED read.
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: [
                    "write_to_pane", "deliver_handoff", "create_pane", "close_pane", "restart_pane",
                    "set_pane_permissions", "set_global_permissions", "set_capability_gate",
                    "add_watch_rule", "execute_plan", "apply_recipe", "create_project",
                    "update_metadata", "switch_context", "set_voice_mute", "dismiss_attention",
                  ] } }]
                });
              } else if (name === "stop_all") {
                // EMERGENCY BRAKE Stage 1 (bead 8sq, spec §2.C/§D). Always allowed — NOT routed
                // through gateOrDefer (see stopAll). An Off gate must never forbid an emergency halt.
                // Stage 1 is instant + reversible: freeze Janus + cancel everything in-flight; the
                // panes KEEP RUNNING. We then ask for the spoken Stage-2 kill confirm (voice has no
                // hold-to-fire, so the verbal "kill them" IS the deliberate second step).
                const running = stopAll(false);
                const output = running.length
                  ? `I've frozen myself and cancelled everything in flight. ${running.length} pane(s) are still running (${running.join(", ")}). Should I also kill them? That can't be undone — say "kill them" to confirm, or "release" to resume.`
                  : `I've frozen myself and cancelled everything in flight. No panes are running, so there's nothing to kill. Say "release" when you want to resume.`;
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output } }]
                });
              } else if (name === "confirm_stop_all") {
                // EMERGENCY BRAKE Stage 2 (bead 8sq, spec §2.C/§D). Always allowed. The deliberate,
                // irreversible kill — ONLY valid while frozen-awaiting-confirm (a stray "kill them"
                // with no prior freeze does nothing). Terminates running PTYs via term.stop().
                if (!frozen) {
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: "There's nothing to confirm — I'm not frozen. Say \"stop everything\" first if you want to halt." } }]
                  });
                } else {
                  const killed = stopAll(true);
                  const output = killed.length
                    ? `Done — I killed ${killed.length} pane(s): ${killed.join(", ")}. They stay killed; I'm still frozen, say "release" to resume.`
                    : `There were no running panes left to kill. I'm still frozen — say "release" to resume.`;
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output } }]
                  });
                }
              } else if (name === "release_stop_all") {
                // Clear the freeze (bead 8sq, spec §2.C/§D). Always allowed. The matrix was never
                // mutated, so this is a clean restore — does NOT auto-restart any killed panes.
                if (!frozen) {
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: "I wasn't frozen — nothing to release. Carrying on as normal." } }]
                  });
                } else {
                  releaseStopAll();
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: "Released — I've un-frozen and your safety gates are back exactly as they were. Any panes you killed stay killed." } }]
                  });
                }
              } else if (name === "set_pane_permissions") {
                const { project_id, pane_id, permissions_mode } = args;
                // Ungated validation pre-checks (cheap reads, no side effect) BEFORE the gate.
                const validModes = ["Full Auto", "Human-in-the-Loop", "Read-Only"];
                const term = manager.terminals[pane_id];
                const ws = manager.ledger.getProject(project_id);
                const paneExists = !!(ws && ws.panes[pane_id]);
                if (!validModes.includes(permissions_mode)) {
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: `Invalid permissions mode "${permissions_mode}". Must be one of: ${validModes.join(", ")}.` } }]
                  });
                } else if (!term && !paneExists) {
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: `Pane ${pane_id} not found in project ${project_id}; no permission change applied.` } }]
                  });
                } else {
                  const applyPanePerms = (): string => {
                    if (manager.terminals[pane_id]) manager.terminals[pane_id].setPermissionsMode(permissions_mode);
                    const ws2 = manager.ledger.getProject(project_id);
                    if (ws2 && ws2.panes[pane_id]) {
                      ws2.panes[pane_id].permissions_mode = permissions_mode;
                      manager.ledger["save"]();
                    }
                    broadcastLedgerUpdate();
                    broadcastTerminalsUpdated();
                    return `Safety permission mode for pane ${pane_id} updated to ${permissions_mode} successfully.`;
                  };
                  const g = gateOrDefer("set_pane_permissions", pane_id ?? null, `Set pane ${pane_id} permissions to ${permissions_mode}`, applyPanePerms);
                  if (g.disposition === "forbidden") {
                    session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `Error: the 'set_pane_permissions' capability is gated Off for pane ${pane_id}; forbidden by policy.` } }] });
                  } else if (g.disposition === "deferred") {
                    session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to apply.` } }] });
                  } else {
                    session.sendToolResponse({ functionResponses: [{ name, id: call.id, response: { output: applyPanePerms() } }] });
                  }
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
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
        systemInstruction: `You are Project Janus, a voice helper controlling active terminal panes.\n\nCURRENT ROUTING CONTEXT (System State):\n- Active Project/Workspace ID: ${manager.ledger.activeProjectId || "None"}\n- Available Workspaces: ${Object.keys(manager.ledger.workspaces).map(pId => pId + " (" + manager.ledger.workspaces[pId].name + ")").join(", ")}\n\nPane status (busy/idle), elapsed time, and last command are LIVE and change constantly. NEVER assume a pane's status from memory or this prompt — it is not listed here because it would be stale. ALWAYS call list_panes to read current per-pane status before reporting whether anything is running or done.\n\nYou DIRECT; the agent panes (Claude Code / Codex / Antigravity) do the heavy lifting. Your job is to route the operator's request to the RIGHT agent pane and report back — you must NOT author and run raw working shell yourself. When the operator dictates a goal, do NOT relay it verbatim: COMPRESS it into a short, targeted instruction for the agent, CONFIRM that distilled version by voice, then call propose_command with kind='agent_instruction' (the default). If a goal spans multiple panes, decompose it and propose per pane (or build a plan). Use kind='shell' only for your OWN small read-only/observe commands (git status, ls, cat, pwd); never run heavy/mutating shell yourself.\n\nWhen a command is awaiting approval (Human-in-the-Loop), you are NOT muted: SPEAK the distilled instruction and target pane and ASK the operator to approve or reject BEFORE it runs. Use list_pending_approvals to recall what is queued. You can list panes, get pane summaries, switch project contexts, add notes, and rename things. Remain token-light. Always use switch_context to get the full project briefing when starting.\n\nEMERGENCY BRAKE (two stages, always allowed): if the operator says "stop", "halt", "abort", "freeze", or "stop everything", call stop_all IMMEDIATELY — it freezes you (every capability becomes Off) and cancels everything in flight, but the panes KEEP RUNNING. After it freezes, tell the operator how many panes are still running and ASK whether to also kill them (that is irreversible). If they confirm the kill ("kill them", "yes"), call confirm_stop_all. When they say "release"/"resume", call release_stop_all to un-freeze (your gates restore exactly; killed panes stay killed).`,
        ...({
          sessionResumption: lastSessionResumptionToken ? { token: lastSessionResumptionToken.token } : {},
          contextWindowCompression: {
            triggerTokens: 25000,
            slidingWindow: { targetTokens: 16000 }
          }
        } as any),
        tools: [{
          functionDeclarations: [
            {
              name: "list_panes",
              description: "List all projects and their panes with runtime_type, is_busy, alive, a one-line state, and live timing: last_status_change_at (ISO), elapsed_ms (time in the current status), and last_command. Use elapsed_ms/last_command to say things like 'the build pane has been running 4 minutes'. This is the authoritative source of current pane status — always call it before reporting whether something is busy or done. Cheap orientation call.",
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: "propose_command",
              description: "Direct work to the pane the operator currently has OPEN (the active pane). You can ONLY propose to that pane, so the operator can see and refine the command before it runs; to act on a different pane, call switch_active_pane first (with the operator's go-ahead). Does NOT execute directly — it passes the effective permission gate (auto-runs in Full Auto, becomes a spoken pending approval in Human-in-the-Loop, blocked in Read-Only). PREFER kind='agent_instruction' (the default): relay a SHORT, FOCUSED, DISTILLED instruction to the Claude Code / Codex / Antigravity agent in that pane and let the AGENT do the heavy lifting (write code, run builds/tests). Do NOT relay the operator's dictation verbatim — compress it to a targeted instruction first and confirm it by voice. kind='shell' is ONLY for your OWN small read-only/observe needs (status checks like git status, ls, cat, pwd); never author or run heavy/mutating shell yourself — delegate that to an agent pane via kind='agent_instruction'. A non-allowlisted shell command returns a clarification so you can re-route it to the agent.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  pane_id: { type: Type.STRING, description: "Target pane ID." },
                  instruction: { type: Type.STRING, description: "The DISTILLED instruction to relay to the agent (kind='agent_instruction') or the shell command (kind='shell')." },
                  kind: { type: Type.STRING, description: "'agent_instruction' (default, FIRST-CLASS — direct the agent in this pane) or 'shell' (your own small read-only command only).", enum: ["agent_instruction", "shell"] }
                },
                required: ["pane_id", "instruction"]
              }
            },
            {
              name: "switch_active_pane",
              description: "Change which pane is open on the operator's screen. Call this ONLY when the operator directs you to ('switch to the build pane', 'open the test pane'). You can only propose commands to the pane the operator currently has OPEN — if you need to act on a different pane, switch to it first (with the operator's go-ahead). This changes focus only; it never runs a command.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  pane_id: { type: Type.STRING, description: "The pane to open / make active." }
                },
                required: ["pane_id"]
              }
            },
            {
              name: "update_draft_prompt",
              description: "Compose or refine the WIP draft prompt for the pane the operator currently has open, so they can review/edit and send it. This does NOT send anything — sending is the operator's action. Use it to distill the conversation into a clean, focused prompt for the agent in that pane. Defaults to replacing the draft; use mode='append' to add to it.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING, description: "The draft prompt text (markdown allowed)." },
                  mode: { type: Type.STRING, description: "'replace' (default) or 'append'.", enum: ["replace", "append"] }
                },
                required: ["text"]
              }
            },
            {
              name: "list_pending_approvals",
              description: "List the commands/instructions currently awaiting the operator's spoken approval (pane, kind, distilled instruction, rationale, count). Use it when the operator asks 'what's queued for approval?' and to disambiguate which one they mean before approving/rejecting.",
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: "get_pane_command_history",
              description: "Return the list of recently executed commands in this pane with their concise, high-level final responses/outcomes, rather than raw/messy terminal outputs. Highly token-light and preserves context.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  pane_id: { type: Type.STRING, description: "Pane ID." },
                },
                required: ["pane_id"]
              }
            },
            {
              name: "get_pane_summary",
              description: "Return the last ~20 lines of one pane's recent terminal output (ANSI-stripped and secret-redacted). Primary observation path. Pull, not push. NOTE: known secret patterns (AWS keys, JWTs, PEM blocks, GitHub/Slack tokens, Google API keys, generic key=value secrets) are scrubbed and replaced with [REDACTED:*] tokens before this response is sent. This is NOT a delta — it is a snapshot of the most recent lines only; incremental diffing is a later workstream.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  pane_id: { type: Type.STRING, description: "Pane ID." },
                },
                required: ["pane_id"]
              }
            },
            {
              name: "get_pane_delta",
              description: "Return ONLY the pane output that is new since you last read this pane (true incremental delta; ANSI-stripped, secret-redacted). Advances a per-pane read cursor, so repeated calls won't re-show old lines. Prefer this over get_pane_summary when tracking progress.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  pane_id: { type: Type.STRING, description: "The pane id." },
                },
                required: ["pane_id"]
              }
            },
            {
              name: "switch_context",
              description: "Make a project the active focus. Returns a fresh project briefing (summary, directory, panes, notes) and backgrounds the previous project.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING, description: "Project ID." },
                },
                required: ["project_id"]
              }
            },
            {
              name: "add_project_note",
              description: "Add a durable note to a project.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING },
                  note: { type: Type.STRING }
                },
                required: ["project_id", "note"]
              }
            },
            {
              name: "add_pane_note",
              description: "Add a durable note to a pane. Omit pane_id to attach it to the pane the operator currently has open (the active pane); if no pane is open the note is not saved.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING, description: "Project ID. Omit to use the active project." },
                  pane_id: { type: Type.STRING, description: "Pane ID. Omit to use the active pane." },
                  note: { type: Type.STRING }
                },
                required: ["note"]
              }
            },
            {
              name: "get_project_notes",
              description: "Recall the durable notes saved for a project (decisions, todos, warnings). Use this to answer 'what did we decide', 'what are my notes', 'remind me what we noted'. Defaults to the active project — you do NOT need to switch_context first. Returns id-bearing, secret-redacted notes, newest first.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING, description: "Project ID. Omit to use the active project." },
                  limit: { type: Type.NUMBER, description: "Max notes to return (default 10, max 50)." }
                }
              }
            },
            {
              name: "search_notes",
              description: "Full-text search the saved NOTES for a phrase ('find the note about auth', 'what did we say about retries'). Returns matching note snippets (secret-redacted) with their ids. Notes only — it does not search the raw activity log.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  query: { type: Type.STRING, description: "The words/phrase to search for." },
                  limit: { type: Type.NUMBER, description: "Max results (default 10, max 50)." }
                },
                required: ["query"]
              }
            },
            {
              name: "amend_note",
              description: "Edit the text of an existing note by its id (get the id from get_project_notes or search_notes). Gated by the 'update notes & metadata' permission: auto-applies in Auto, asks for operator confirmation in Ask, refused when Off.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  note_id: { type: Type.STRING, description: "The id of the note to edit." },
                  text: { type: Type.STRING, description: "The new note text (replaces the old text)." }
                },
                required: ["note_id", "text"]
              }
            },
            {
              name: "delete_note",
              description: "Delete a note permanently by its id (get the id from get_project_notes or search_notes). Gated by the 'update notes & metadata' permission: auto-applies in Auto, asks for operator confirmation in Ask, refused when Off.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  note_id: { type: Type.STRING, description: "The id of the note to delete." }
                },
                required: ["note_id"]
              }
            },
            {
              name: "rename_project",
              description: "Rename a project.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING },
                  name: { type: Type.STRING }
                },
                required: ["project_id", "name"]
              }
            },
            {
              name: "rename_pane",
              description: "Rename a pane.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING },
                  pane_id: { type: Type.STRING },
                  name: { type: Type.STRING }
                },
                required: ["project_id", "pane_id", "name"]
              }
            },
            {
              name: "get_attention_digest",
              description: "Speak a structured summary of items needing the operator's attention: panes that transitioned to error/exit states AND any commands currently awaiting spoken approval (both are merged into one digest).",
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: "dismiss_attention",
              description: "Dismiss one attention item by its id (or all items if id is omitted) once the operator has acknowledged it, so it stops appearing in the digest and proactive notifications.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: "The attention item id to dismiss; omit to dismiss all." }
                }
              }
            },
            {
              name: "create_project",
              description: "Create a new project workspace directory context block.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING, description: "Unique project identifier." },
                  directory: { type: Type.STRING, description: "Local workspace folder path." },
                  summary: { type: Type.STRING, description: "A brief overview description of what this project does." },
                  key_terms: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Key codebase terms/keywords to anchor project context." }
                },
                required: ["project_id"]
              }
            },
            {
              name: "create_pane",
              description: "Create a new terminal pane inside a project and live restore start its process environment.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING, description: "Project ID context to create under." },
                  pane_id: { type: Type.STRING, description: "Unique pane terminal identifier." },
                  command: { type: Type.STRING, description: "The command line string to run." },
                  tool_preset: { 
                    type: Type.STRING, 
                    description: "Tool preset environment to configure (Claude Code, Codex, Antigravity, Custom)."
                  },
                  permissions_mode: {
                    type: Type.STRING,
                    description: "Local permission safety policy mode (Full Auto, Human-in-the-Loop, Read-Only)."
                  }
                },
                required: ["project_id", "pane_id", "command"]
              }
            },
            {
              name: "set_global_permissions",
              description: "Set the system wide voice execution permission mode.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  permissions_mode: { 
                    type: Type.STRING, 
                    description: "Permissions Mode (Full Auto, Human-in-the-Loop, Read-Only, Inherit)"
                  }
                },
                required: ["permissions_mode"]
              }
            },
            {
              name: "set_voice_mute",
              description: "Set microphone muted status.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  muted: { type: Type.BOOLEAN, description: "True to mute, False to unmute." }
                },
                required: ["muted"]
              }
            },
            {
              name: "create_orchestrator_plan",
              description: "Synthesize a multi-step sequence of chained commands spanning multiple panes that run sequentially with automatic state verification of previous outputs.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Title designation of the recipe plan." },
                  steps: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        terminalId: { type: Type.STRING },
                        command: { type: Type.STRING },
                        expectedTransition: { type: Type.STRING, description: "Expected transition (idle, prompt)" }
                      },
                      required: ["terminalId", "command", "expectedTransition"]
                    }
                  }
                },
                required: ["name", "steps"]
              }
            },
            {
              name: "execute_plan",
              description: "Starts running a synthesized multi-step plan recipe.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  plan_id: { type: Type.STRING }
                },
                required: ["plan_id"]
              }
            },
            {
              name: "apply_orchestration_recipe",
              description: "Apply a pre-configured template layout suite (such as full-stack-web or python-worker) to standard workspaces.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  recipe_id: { type: Type.STRING, description: "Recipe template ID (full-stack-web, python-worker)" }
                },
                required: ["recipe_id"]
              }
            },
            {
              name: "handoff_context_between_panes",
              description: "Gather context from a source CLI pane and package summaries/learnings to prime a model agent in another target pane.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  source_pane_id: { type: Type.STRING },
                  target_pane_id: { type: Type.STRING },
                  context_notes: { type: Type.STRING, description: "Active guidance/handoff instructions summarizing context." }
                },
                required: ["source_pane_id", "target_pane_id", "context_notes"]
              }
            },
            {
              name: "set_pane_permissions",
              description: "Set the safety permission policy mode for a specific terminal pane. Promotes or reverts autonomy (Full Auto, Human-in-the-Loop, Read-Only).",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING, description: "The project workspace ID containing the pane." },
                  pane_id: { type: Type.STRING, description: "The terminal pane ID to configure." },
                  permissions_mode: { type: Type.STRING, description: "Safety mode: Full Auto, Human-in-the-Loop, or Read-Only." }
                },
                required: ["project_id", "pane_id", "permissions_mode"]
              }
            },
            {
              name: "propose_handoff",
              description: "Draft a first-class handoff to a target pane (UNGATED — never touches the pane). Snapshots the source pane's context (redacted) and stores a 'composing' draft for the operator to revise by voice. Use this to begin co-authoring a prompt to delegate to a CLI agent pane.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  to_pane: { type: Type.STRING, description: "Target pane ID that will receive the prompt." },
                  draft_text: { type: Type.STRING, description: "The initial composed prompt draft." },
                  from_pane: { type: Type.STRING, description: "Optional source pane ID to snapshot context from (may be archived)." },
                  rationale: { type: Type.STRING, description: "Optional rationale/notes for the handoff." }
                },
                required: ["to_pane", "draft_text"]
              }
            },
            {
              name: "revise_handoff",
              description: "Rewrite a handoff's composed prompt (UNGATED co-authoring; increments revision_count). Read the revised draft back to the operator.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  handoff_id: { type: Type.STRING },
                  new_draft_text: { type: Type.STRING, description: "The revised composed prompt." }
                },
                required: ["handoff_id", "new_draft_text"]
              }
            },
            {
              name: "stage_handoff",
              description: "Freeze a handoff draft and mark it 'staged' (UNGATED; validates the target pane is live). After staging, ask the operator to approve delivery.",
              parameters: {
                type: Type.OBJECT,
                properties: { handoff_id: { type: Type.STRING } },
                required: ["handoff_id"]
              }
            },
            {
              name: "deliver_handoff",
              description: "Deliver a STAGED handoff into the target pane's live session (GATED by the deliver_handoff capability + the pane's effective mode). Full Auto writes immediately; Human-in-the-Loop creates a pending approval to read back; Read-Only/Off blocks.",
              parameters: {
                type: Type.OBJECT,
                properties: { handoff_id: { type: Type.STRING } },
                required: ["handoff_id"]
              }
            },
            {
              name: "read_handoff",
              description: "Read a single handoff (UNGATED, redacted output).",
              parameters: {
                type: Type.OBJECT,
                properties: { handoff_id: { type: Type.STRING } },
                required: ["handoff_id"]
              }
            },
            {
              name: "list_handoffs",
              description: "List handoffs in the active workspace, optionally filtered by state (UNGATED, redacted output).",
              parameters: {
                type: Type.OBJECT,
                properties: { state: { type: Type.STRING, description: "Optional state filter: composing, revising, staged, delivered, consumed, rejected, expired." } },
                required: []
              }
            },
            {
              name: "reject_handoff",
              description: "Reject/cancel a handoff (UNGATED pre-gate flip; if a delivery is pending at the gate, routes through the gate's reject path).",
              parameters: {
                type: Type.OBJECT,
                properties: { handoff_id: { type: Type.STRING } },
                required: ["handoff_id"]
              }
            },
            {
              name: "set_capability_gate",
              description: "Set a capability gate to Auto, Ask, or Off — globally or for one pane (meta capability). Auto=proceed, Ask=require human approval, Off=forbidden.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  pane_id: { type: Type.STRING, description: "Optional pane ID for a per-pane override; omit for the global default." },
                  capability: { type: Type.STRING, description: "Capability name, e.g. write_to_pane, deliver_handoff, create_pane." },
                  gate: { type: Type.STRING, description: "Gate value: Auto, Ask, or Off." }
                },
                required: ["capability", "gate"]
              }
            },
            {
              name: "get_pane_gates",
              description: "Read the resolved capability-gate matrix for a pane (or global if pane_id omitted). UNGATED read.",
              parameters: {
                type: Type.OBJECT,
                properties: { pane_id: { type: Type.STRING, description: "Optional pane ID." } },
                required: []
              }
            },
            {
              name: "list_capabilities",
              description: "List every gateable capability name. UNGATED read.",
              parameters: { type: Type.OBJECT, properties: {}, required: [] }
            },
            {
              name: "stop_all",
              description: "EMERGENCY Stage 1: instantly freeze yourself (every capability becomes Off) and cancel everything in flight — pending approvals, deferred actions, running plans and rules. Panes KEEP RUNNING. Always allowed — never gated. Use when the operator says stop/halt/abort/freeze everything. After freezing, ASK whether to also kill the running panes (Stage 2, irreversible).",
              parameters: { type: Type.OBJECT, properties: {}, required: [] }
            },
            {
              name: "confirm_stop_all",
              description: "EMERGENCY Stage 2 (irreversible): kill every running pane's process. Always allowed. ONLY call this after stop_all has frozen things and the operator verbally confirms the kill (e.g. says \"kill them\", \"yes kill\"). Does nothing if not currently frozen.",
              parameters: { type: Type.OBJECT, properties: {}, required: [] }
            },
            {
              name: "release_stop_all",
              description: "Clear the emergency freeze and resume normal operation; restores the safety gates exactly as they were (the matrix was never changed). Always allowed. Use when the operator says release/resume/unfreeze. Does NOT restart any panes that were killed.",
              parameters: { type: Type.OBJECT, properties: {}, required: [] }
            }
          ]
        }]
      },
    });

      // WS-F (spec §6.2): the live session is now established. Hoist it for the action last-call,
      // then re-attach every staged survivor that outlived the prior disconnect (or a process
      // restart) to THIS session and speak ONE batched resumption digest — "welcome back, here's
      // your queue" — re-requiring explicit approval. Runs exactly once per (re)connect, AFTER the
      // connect promise resolves so `session` is live.
      activeLiveSession = session;
      reannounceSurvivors(session);

      // Push-observation: bridge global pane signals into THIS live session. The bus owns
      // debounce; we forward each signal as a user-role nudge (same convention as approval
      // narration the model already speaks). Unsubscribed on socket close.
      unsubscribePaneSignals = paneSignalBus.subscribe((sig) => {
        try {
          session.sendClientContent({
            turns: [{ role: "user", parts: [{ text: formatPaneSignal(sig) }] }],
            turnComplete: true,
          });
        } catch (e) {
          console.error("Failed to push pane signal to session:", e);
        }
      });
    } catch (err: any) {
      console.error("Failed to establish Gemini Live session:", err);
      clientWs.send(JSON.stringify({ 
        type: "error", 
        message: "Gemini Live Voice Connection Failed. Please verify your Gemini API Key in Settings." 
      }));
    }

    clientWs.on("message", (data) => {
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
          const paneId = msg.paneId || activePaneId;
          if (paneId && manager.ledger.setDraft(projectId, paneId, msg.text, "operator")) {
            broadcastDraft(projectId, paneId);
          }
        } else if (msg.type === "set_active_pane") {
          // Step 5: the UI is the source of truth for the active pane. Whatever the operator has
          // open (or null if nothing is open) is recorded here and gates every Janus write.
          activePaneId = typeof msg.paneId === "string" ? msg.paneId : null;
        } else if (msg.type === "stop_all") {
          // TWO-STAGE EMERGENCY BRAKE from the UI (bead 8sq). Always allowed — never gated.
          // Stage 1 (default / kill=false): freeze + cancel in-flight; panes keep running.
          // Stage 2 (kill=true): hold-to-fire kill of running PTYs, only when already frozen.
          // stopAll broadcasts {type:'frozen'}/{type:'stop_all'} to ALL clients; this is the
          // per-client ack so the requesting UI can confirm completion.
          if (msg.kill === true) {
            if (!frozen) {
              clientWs.send(JSON.stringify({ type: "stop_all_done", error: "not_frozen" }));
            } else {
              const killed = stopAll(true);
              clientWs.send(JSON.stringify({ type: "stop_all_done", stage: 2, killed }));
            }
          } else {
            const running = stopAll(false);
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
      wsClosed = true; // gate out the SDK's post-close resumption-token flush
      if (unsubscribePaneSignals) { unsubscribePaneSignals(); unsubscribePaneSignals = null; }
      clients.delete(clientWs);
      if (activeFrontendWs === clientWs) {
        activeFrontendWs = null;
        activePaneId = null; // Step 5: no UI connected -> no source of truth -> no write permitted.
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
        // (activeFrontendWs went null above), matching the approval clock-pause-while-away.
        if (activeLiveSession === session) activeLiveSession = null;
        try {
          session.close();
        } catch (e) {
          console.error("Error closing Gemini session on socket close:", e);
        }
      }
      console.log("Client WS closed");
    });
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

  return { app, server, wss, manager, port, close };
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
