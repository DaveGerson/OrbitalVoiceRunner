import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";
import crypto from "crypto";
import { OrchestratorManager, UniversalTerminal, stripAnsiSequences, redactSecrets } from "./src/terminal";
import { SHELL_PROMPT } from "./src/statusConstants";
import { AnnouncementBus, pruneAttentionQueue, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "./src/announcementBus";
import {
  PendingApprovalStore,
  decideProposal,
  resolveDecision,
  inferKind,
  loadShellAllowlist,
  serializePending,
  type ApprovalKind,
  type EffectiveMode,
  type PendingApproval,
  type ResolveMode,
} from "./src/pendingApprovals";
import { parseApprovalIntent, selectApprovalTarget } from "./src/approvalIntent";
import { isPaneActiveForWrite, inactivePaneClarify } from "./src/activePane";

dotenv.config();

const PORT = 3000;

// Automatic session secret token loaded from env or generated cryptographically fresh on boot
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || crypto.randomBytes(32).toString("hex");
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

const manager = new OrchestratorManager();

// Prompt-composer refactor (step 6): the single global prompt buffer is gone. Each pane now keeps
// its OWN persistent WIP draft in the ledger (PaneMeta.draft), composed against the active pane.

async function startServer() {
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
    }
  };

  let activeFrontendWs: any = null;
  const clients = new Set<any>();

  // Step 5 (single active pane): the pane the operator currently has open on screen, driven by the
  // UI via `set_active_pane`. It is the SINGLE source of truth for where Janus may write — see
  // `isPaneActiveForWrite`. Null when no pane is open / no UI is connected (no write permitted).
  let activePaneId: string | null = null;

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
      return {
        id,
        cwd: term.cwd,
        command: term.shellCmd,
        output: term.getRecentOutput(20),
        status: term.status,
        permissions_mode: term.permissionsMode,
        tool_preset: term.toolPreset,
        session_id: term.sessionId,
        context_size: term.contextSize
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
    if (!terminalId || !cwd || !command) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    // ensure the active projectId is synced with this new terminal if requested
    if (projectId) {
      manager.ledger.activeProjectId = projectId;
      // also ensure the project exists, just in case
      if (!manager.ledger.getProject(projectId)) {
        manager.ledger.addProject(projectId, cwd, "", []);
      }
    }
    const result = manager.addTerminal(terminalId, cwd, command, toolPreset, permissionsMode, sessionId, projectId || "");
    broadcastLedgerUpdate();
    broadcast({ type: "terminals_updated" });
    res.json({ success: true, result });
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
      broadcast({ type: "terminals_updated" });
      res.json({ success: true, message: `Terminal ${id} restarted.` });
    } else {
      const activeProject = manager.ledger.getActiveProject();
      const pane = activeProject?.panes[id];
      if (pane) {
        let cmd = "bash";
        // WS-G quick win: Claude Code is installed globally here, so the bare
        // `claude` binary is correct; `npx @anthropic-ai/claude` is the wrong package.
        if (pane.tool_preset === "Claude Code") cmd = "claude";
        else if (pane.tool_preset === "Codex") cmd = "npx codex-cli";
         else if (pane.tool_preset === "Antigravity") cmd = "npx antigravity";
        
        manager.addTerminal(id, activeProject!.directory || process.cwd(), cmd, pane.tool_preset, pane.permissions_mode, pane.session_id);
        broadcastLedgerUpdate();
        broadcast({ type: "terminals_updated" });
        res.json({ success: true, message: `Terminal ${id} restored and started.` });
      } else {
        res.status(404).json({ error: "Terminal not found" });
      }
    }
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
    const terms = Array.isArray(keyTerms) ? keyTerms : [];
    manager.ledger.addProject(id, directory || ".", summary || "", terms);
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
    broadcast({ type: "terminals_updated" });
    res.json({ success: true });
  });

  // --- ORCHESTRATION PIPELINES & AUTOMATIONS ENDPOINTS ---
  const recipes = [
    {
      id: "full-stack-web",
      name: "Full-Stack Web App Suite",
      description: "Vite SPA client, Express backend router, and test watcher setup.",
      panes: [
        { id: "pane_frontend", name: "SPA Frontend (Vite)", command: "echo 'Frontend running' && npm run dev", preset: "Custom" as const, permissionsMode: "Human-in-the-Loop" as const },
        { id: "pane_api", name: "Proxy Router (Express Server)", command: "echo 'API running' && node server.ts", preset: "Custom" as const, permissionsMode: "Full Auto" as const },
        { id: "pane_tests", name: "Vitest Live Suite", command: "echo 'Tests idle' && npm run test", preset: "Custom" as const, permissionsMode: "Read-Only" as const }
      ]
    },
    {
      id: "python-worker",
      name: "SQL Pipeline & background Queue",
      description: "FastAPI Web Engine with an RQ asynchronous background worker.",
      panes: [
        { id: "pane_fastapi", name: "Microservice Host (Uvicorn)", command: "echo 'Uvicorn running' && uvicorn main:app --reload", preset: "Custom" as const, permissionsMode: "Human-in-the-Loop" as const },
        { id: "pane_worker", name: "Asynchronous Poll Task Queue", command: "echo 'Queue worker poller running' && python -m rq worker tasks_queue", preset: "Custom" as const, permissionsMode: "Full Auto" as const }
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
    if (recipe) {
      for (const p of recipe.panes) {
        if (!manager.terminals[p.id]) {
          manager.addTerminal(p.id, proj.directory || process.cwd(), p.command, p.preset as any, p.permissionsMode as any, "", activeProjectId);
        }
      }
      broadcastLedgerUpdate();
      broadcast({ type: "terminals_updated" });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Recipe layout not found." });
    }
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
  const pendingApprovals = new PendingApprovalStore();
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
    if (reason !== "lost_race") broadcast({ type: "terminals_updated" });
    return action;
  }

  app.get("/api/commands/pending", (req, res) => {
    res.json(pendingApprovals.all().map((p) => serializePending(p)));
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

  // WS-E.3 (BUG-019): periodic sweep auto-rejects expired approvals so an unresolved vote
  // never freezes a session indefinitely. The interval is unref'd so the test suite/process
  // exits cleanly; it is also cleared on shutdown. The expiry routes through the SAME mandatory
  // claim gate as approve (via applyResolution -> resolveDecision), closing the prior asymmetry
  // where the sweep bypassed the claim by filtering `!p.claimed`.
  function sweepExpiredApprovals(now: number = Date.now()) {
    for (const pending of pendingApprovals.expired(APPROVAL_TTL_MS, now)) {
      applyResolution(pending.messageId, "expire");
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
    }): DispatchOutcome {
      const { sess, callId, targetId, instruction } = opts;
      const pendingId = opts.pendingId ?? callId;
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

      const decision = decideProposal({ kind, instruction, effectiveMode, runtimeType, paneExists, allowlist: shellAllowlist });
      const safeInstr = redactSecrets(instruction);

      switch (decision.type) {
        case "error_no_pane":
          return { kind: "error", text: `Error: pane ${targetId} not found.` };
        case "error_kind_mismatch":
          return { kind: "error", text: decision.reason };
        case "clarify_shell":
          // Non-blocking re-route (never a dead-end, never execution).
          return { kind: "clarify", text: decision.reason };
        case "blocked_read_only":
          broadcast({ type: "command_blocked", terminalId: targetId, cmd: safeInstr, reason: "Read-Only policy enforced." });
          return { kind: "blocked", text: `Error: Write execution block is active. Pane ${targetId} is Read-Only.` };
        case "auto_execute":
          HistoryManager.getInstance().addCommand(targetId, instruction);
          term!.writeInput(instruction);
          broadcast({ type: "command_auto_executed", terminalId: targetId, cmd: safeInstr });
          return { kind: "executed", text: `Command executed automatically on pane ${targetId}: "${safeInstr}"` };
        case "pending_approval": {
          // WS-E.1 two-phase: store a serializable pending entry + the session in the side-map,
          // mark it announced for targeting, and let the caller answer call.id NON-BLOCKINGLY.
          const pSummary = redactSecrets(manager.getPaneSummary(targetId, 5));
          const rationale = { trigger: redactSecrets(opts.trigger), summary: pSummary };
          const record: PendingApproval = { messageId: pendingId, instruction, kind, terminalId: targetId, callId, rationale, timestamp: Date.now() };
          pendingApprovals.add(record, sess);
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

      // Initialize Gemini Live session
      session = await sessionAi.live.connect({
        model: liveModel,
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            // Check for sessionResumption update
            if ((message as any).sessionResumptionUpdate) {
              lastSessionResumptionToken = (message as any).sessionResumptionUpdate;
              console.log("[SESSION RESUMPTION] Captured token:", lastSessionResumptionToken);
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
                const ok = manager.ledger.addPaneNote(args.project_id, args.pane_id, args.note);
                if (ok) broadcastLedgerUpdate();
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: ok ? `Note added to pane ${args.pane_id}` : `Could not add note: pane ${args.pane_id} not found in project ${args.project_id}.` } }]
                });
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
                manager.ledger.addProject(project_id, directory || ".", summary || "", key_terms || []);
                broadcastLedgerUpdate();
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Project context ${project_id} created successfully.` } }]
                });
              } else if (name === "create_pane") {
                const { project_id, pane_id, command, tool_preset, permissions_mode } = args;
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
                broadcast({ type: "terminals_updated" });
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Pane ${pane_id} created under project ${project_id}. Result: ${result}` } }]
                });
              } else if (name === "set_global_permissions") {
                const { permissions_mode } = args;
                manager.globalPermissionsMode = permissions_mode;
                manager.settings.advanced.globalPermissionsMode = permissions_mode;
                manager.saveSettings();
                broadcast({
                  type: "settings_updated",
                  globalPermissionsMode: permissions_mode,
                  settings: sanitizeSettingsForClient(manager.settings)
                });
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Global permissions updated to ${permissions_mode}.` } }]
                });
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
                    for (const p of recipe.panes) {
                      if (!manager.terminals[p.id]) {
                        manager.addTerminal(p.id, proj.directory || process.cwd(), p.command, p.preset as any, p.permissionsMode as any, "", activeProjectId);
                      }
                    }
                    broadcastLedgerUpdate();
                    broadcast({ type: "terminals_updated" });
                    resp = `Template recipe layout '${recipe.name}' successfully spawned in workspace.`;
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
              } else if (name === "set_pane_permissions") {
                const { project_id, pane_id, permissions_mode } = args;
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
                  if (term) {
                    term.setPermissionsMode(permissions_mode);
                  }
                  if (paneExists) {
                    ws!.panes[pane_id].permissions_mode = permissions_mode;
                    manager.ledger["save"]();
                  }
                  broadcastLedgerUpdate();
                  broadcast({ type: "terminals_updated" });
                  session.sendToolResponse({
                    functionResponses: [{ name, id: call.id, response: { output: `Safety permission mode for pane ${pane_id} updated to ${permissions_mode} successfully.` } }]
                  });
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
        systemInstruction: `You are Project Janus, a voice helper controlling active terminal panes.\n\nCURRENT ROUTING CONTEXT (System State):\n- Active Project/Workspace ID: ${manager.ledger.activeProjectId || "None"}\n- Available Workspaces: ${Object.keys(manager.ledger.workspaces).map(pId => pId + " (" + manager.ledger.workspaces[pId].name + ")").join(", ")}\n\nPane status (busy/idle), elapsed time, and last command are LIVE and change constantly. NEVER assume a pane's status from memory or this prompt — it is not listed here because it would be stale. ALWAYS call list_panes to read current per-pane status before reporting whether anything is running or done.\n\nYou DIRECT; the agent panes (Claude Code / Codex / Antigravity) do the heavy lifting. Your job is to route the operator's request to the RIGHT agent pane and report back — you must NOT author and run raw working shell yourself. When the operator dictates a goal, do NOT relay it verbatim: COMPRESS it into a short, targeted instruction for the agent, CONFIRM that distilled version by voice, then call propose_command with kind='agent_instruction' (the default). If a goal spans multiple panes, decompose it and propose per pane (or build a plan). Use kind='shell' only for your OWN small read-only/observe commands (git status, ls, cat, pwd); never run heavy/mutating shell yourself.\n\nWhen a command is awaiting approval (Human-in-the-Loop), you are NOT muted: SPEAK the distilled instruction and target pane and ASK the operator to approve or reject BEFORE it runs. Use list_pending_approvals to recall what is queued. You can list panes, get pane summaries, switch project contexts, add notes, and rename things. Remain token-light. Always use switch_context to get the full project briefing when starting.`,
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
              description: "Add a durable note to a specific pane.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  project_id: { type: Type.STRING },
                  pane_id: { type: Type.STRING },
                  note: { type: Type.STRING }
                },
                required: ["project_id", "pane_id", "note"]
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
            }
          ]
        }]
      },
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
        }
      } catch (err) {
        console.warn("Received malformed or non-JSON WebSocket frame, skipping:", err);
      }
    });

    clientWs.on("close", () => {
      clients.delete(clientWs);
      if (activeFrontendWs === clientWs) {
        activeFrontendWs = null;
        activePaneId = null; // Step 5: no UI connected -> no source of truth -> no write permitted.
      }
      if (session) {
        // Clean up any pending approvals associated with this session to avoid leaks or hanging
        // tool-calls. TODO(WS-F): persist + re-announce these on reconnect instead of purging
        // (the store's session side-map keeps the serializable record re-attachable).
        const purged = pendingApprovals.purgeSession(session);
        if (purged.length) console.log(`[CLEANUP] Purged ${purged.length} orphaned approval(s) for closed session.`);
        try {
          session.close();
        } catch (e) {
          console.error("Error closing Gemini session on socket close:", e);
        }
      }
      console.log("Client WS closed");
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const shutdown = async () => {
    console.log("Shutting down cleanly, stopping all terminals...");
    announcementBus.stop(); // WS-D: clear coalescing/rate-limit timers
    clearInterval(approvalSweepTimer); // WS-E.3: clear the TTL sweep
    for (const term of Object.values(manager.terminals)) {
      try {
        await term.stop();
      } catch (err) {
        console.error(`Error stopping terminal ${term.terminalId}:`, err);
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const bindHost = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  server.listen(PORT, bindHost, () => {
    console.log(`Server running on http://${bindHost}:${PORT}`);
  });
}

startServer().catch(console.error);
