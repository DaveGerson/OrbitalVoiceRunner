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

let promptBufferText = `# Requirements & Feedback Prompt Buffer

- **Objective**: Review code updates, dictate requirements, and capture content fixes.
- **Workflow**: Tap "Workspace Actions" below to test the core agentic workflows.
- **Real-time Sync**: Updates made here instantly broadcast between all live operators and the voice agent.

### ACTIVE CHRONICLE MEMORY LIST:
* [System Status]: Orbital Harness and live voice workspace initialized.
* [Task]: Review running nodes on mobile or initiate an agentic walkthrough session.`;

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
      if (history.length > 0) {
        const lastEntry = history[history.length - 1];
        if (lastEntry.output && !lastEntry.finalResponse) {
          try {
            const cleanOutput = stripAnsiSequences(lastEntry.output).trim();
            if (cleanOutput.length > 5) {
              const summaryText = await summarizeCommandOutcome(lastEntry.command, cleanOutput);
              lastEntry.finalResponse = summaryText;
              HistoryManager.getInstance().saveHistory(terminalId, history);

              broadcast({
                type: "history_updated",
                terminalId,
                history
              });

              // WS-D (BUG-024): announce ONLY on this genuine WS-C Running->Idle completion
              // edge — no new idle inference. summaryText is already WS-B redacted.
              announcementBus.enqueue({
                kind: "completion",
                terminalId,
                summary: summaryText
              });
            }
          } catch (err) {
            console.error("Auto-summarization failed for command outcomes:", err);
          }
        }
      }
    }
  };

  let activeFrontendWs: any = null;
  const clients = new Set<any>();

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
        const targetTerm = manager.terminals[rule.actionTerminalId];
        if (targetTerm) {
          console.log(`[WATCH RULE FIRED] Rule ${rule.id} triggered: Writing command to terminal ${rule.actionTerminalId}`);
          HistoryManager.getInstance().addCommand(rule.actionTerminalId, rule.actionCommand);
          targetTerm.writeInput(rule.actionCommand);
          broadcast({
            type: "watch_rule_fired",
            ruleId: rule.id,
            message: `Watch Rule matched! Fired '${rule.actionCommand}' on '${rule.actionTerminalId}' due to '${terminalId}' transition to '${transition}'.`
          });
          if (rule.oneShot) {
            rule.enabled = false;
            changed = true;
          }
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
              plan.currentStepIndex = nextIndex;
              const nextStep = plan.steps[nextIndex];
              nextStep.status = "running";
              const nextTerm = manager.terminals[nextStep.terminalId];
              if (nextTerm) {
                console.log(`[PLAN PROGRESS] Running next step command: '${nextStep.command}' on '${nextStep.terminalId}'`);
                HistoryManager.getInstance().addCommand(nextStep.terminalId, nextStep.command);
                nextTerm.writeInput(nextStep.command);
                changed = true;
              } else {
                plan.status = "paused";
                nextStep.status = "failed";
                const itemID = "att_" + Math.random().toString(36).substring(2, 11);
                manager.attentionQueue.push({
                  id: itemID,
                  type: "error",
                  terminalId: nextStep.terminalId,
                  projectId: manager.ledger.activeProjectId || "default_project",
                  message: `Plan '${plan.name}' paused: pane '${nextStep.terminalId}' is not online.`,
                  timestamp: new Date().toISOString(),
                  dismissed: false
                });
                pruneAttention(); // BUG-035 cap/TTL
                broadcast({ type: "attention_updated", queue: manager.attentionQueue });
                announcementBus.enqueue({
                  kind: "plan_paused",
                  terminalId: nextStep.terminalId,
                  summary: `Plan '${plan.name}' paused — pane offline.`
                });
                changed = true;
              }
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
  app.post("/api/terminals/:id/restart", (req, res) => {
    const { id } = req.params;
    const term = manager.terminals[id];
    if (term) {
      term.stop();
      term.start();
      broadcastLedgerUpdate();
      broadcast({ type: "terminals_updated" });
      res.json({ success: true, message: `Terminal ${id} restarted.` });
    } else {
      const activeProject = manager.ledger.getActiveProject();
      const pane = activeProject?.panes[id];
      if (pane) {
        let cmd = "bash";
        if (pane.tool_preset === "Claude Code") cmd = "npx @anthropic-ai/claude";
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
    
    manager.ledger.addPaneNote(activeProjectId, targetPaneId, handoffNote);
    
    const commentCommand = `# === HANDOFF CONTEXT INTERCEPT ===\n# Source: ${sourcePaneId} -> Target: ${targetPaneId}\n# Notes: ${contextNotes.replace(/\r?\n/g, ' ')}\n# State indicators: ${lastFiveOutlines.replace(/\r?\n/g, ' ')}\n# ==================================`;
    targetTerm.writeInput(commentCommand);
    
    broadcastLedgerUpdate();
    res.json({ success: true });
  });

  // REST endpoints for the real-time synchronous markdown prompt buffer
  app.get("/api/prompt-buffer", (req, res) => {
    res.json({ text: promptBufferText });
  });

  app.put("/api/prompt-buffer", (req, res) => {
    const { text } = req.body;
    if (text !== undefined) {
      promptBufferText = text;
      broadcast({
        type: "prompt_buffer_updated",
        text: promptBufferText
      });
      res.json({ success: true, text: promptBufferText });
    } else {
      res.status(400).json({ error: "Missing text field" });
    }
  });

  app.get("/api/settings", (req, res) => {
    const sanitizedSettings = JSON.parse(JSON.stringify(manager.settings));
    if (sanitizedSettings.secrets && sanitizedSettings.secrets.geminiApiKey) {
      const key = sanitizedSettings.secrets.geminiApiKey;
      if (key && key !== "CONFIGURED_IN_ENV" && key.length > 8) {
        sanitizedSettings.secrets.geminiApiKey = key.substring(0, 6) + "••••••••" + key.substring(key.length - 4);
      }
    }
    res.json(sanitizedSettings);
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
      settings: manager.settings
    });
    res.json({ success: true, settings: manager.settings, globalPermissionsMode: manager.globalPermissionsMode });
  });

  // Client pending commands mapping Map<messageId, Function(approved: boolean)>
  // To keep it simple, we store pending execution approvals here.
  const pendingApprovals: Record<string, { cmd: string, terminalId: string, callId: string, session: any, rationale?: { trigger: string, summary: string } }> = {};

  app.get("/api/commands/pending", (req, res) => {
    res.json(Object.entries(pendingApprovals).map(([messageId, details]) => ({
      messageId,
      cmd: details.cmd,
      terminalId: details.terminalId,
      rationale: details.rationale
    })));
  });

  app.post("/api/commands/approve", (req, res) => {
    const { messageId, approved } = req.body;
    const pending = pendingApprovals[messageId];
    if (pending) {
      if (approved) {
        const term = manager.terminals[pending.terminalId];
        if (term) {
          HistoryManager.getInstance().addCommand(pending.terminalId, pending.cmd);
          term.writeInput(pending.cmd);
          try {
            pending.session.sendToolResponse({
              functionResponses: [{
                name: "propose_command",
                id: pending.callId,
                response: { output: `Command dispatched to ${pending.terminalId} successfully.` }
              }]
            });
          } catch (e) {
            console.error("Failed to send tool response to dead/closed session on approve:", e);
          }
        }
      } else {
        try {
          pending.session.sendToolResponse({
            functionResponses: [{
              name: "propose_command",
              id: pending.callId,
              response: { output: "Execution cancelled by operator." }
            }]
          });
        } catch (e) {
          console.error("Failed to send tool response to dead/closed session on reject:", e);
        }
      }
      delete pendingApprovals[messageId];
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Pending command not found" });
    }
  });

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

    // Push initial prompt buffer synchronously to the newly connected client
    clientWs.send(JSON.stringify({
      type: "prompt_buffer_updated",
      text: promptBufferText
    }));

    let session: any = null;
    let currentSessionUserUtterance = "";
    let currentSessionModelUtterance = "";
    const voiceName = manager.settings.voiceAi?.voice || "Zephyr";

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
                // Auto-log dictation as bullet points inside synchronous prompt buffer
                promptBufferText += `\n* **User Dictation**: ${cleanUtter}`;
                broadcast({
                  type: "prompt_buffer_updated",
                  text: promptBufferText
                });

                // Hands-free voice approvals parsing
                const lowerUtter = cleanUtter.toLowerCase();
                const isApprove = ["approve", "go ahead", "execute", "run it", "yes run", "approve command", "confirm execution"].some(word => lowerUtter.includes(word));
                const isReject = ["reject", "cancel", "deny", "don't run", "reject command"].some(word => lowerUtter.includes(word));
                
                if (isApprove || isReject) {
                  // Find any pending approval for this session
                  const pendingEntries = Object.entries(pendingApprovals).filter(([mId, details]) => details.session === session);
                  if (pendingEntries.length > 0) {
                    // NOTE: resolves the OLDEST pending entry (insertion-order FIFO).
                    // There is no targeting of the command the operator named — see
                    // docs/review/BUG_LOG.md BUG-007 (fixed in IMPLEMENTATION_PLAN WS-E.2).
                    const [messageId, pending] = pendingEntries[0];
                    console.log(`[VOICE INTERCEPT] Auto-resolving pending command "${pending.cmd}" on pane "${pending.terminalId}" via voice: approved=${isApprove}`);
                    
                    if (isApprove) {
                      const term = manager.terminals[pending.terminalId];
                      if (term) {
                        HistoryManager.getInstance().addCommand(pending.terminalId, pending.cmd);
                        term.writeInput(pending.cmd);
                        try {
                          pending.session.sendToolResponse({
                            functionResponses: [{
                              name: "propose_command",
                              id: pending.callId,
                              response: { output: `Command dispatched to ${pending.terminalId} successfully via voice.` }
                            }]
                          });
                        } catch (e) {
                          console.error("Failed to send tool response to session on voice approve:", e);
                        }
                        
                        // Notify frontend
                        clientWs.send(JSON.stringify({
                          type: "command_auto_executed",
                          terminalId: pending.terminalId,
                          cmd: pending.cmd,
                          vocal: true
                        }));
                      }
                    } else {
                      try {
                        pending.session.sendToolResponse({
                          functionResponses: [{
                            name: "propose_command",
                            id: pending.callId,
                            response: { output: "Execution cancelled by operator via voice." }
                          }]
                        });
                      } catch (e) {
                        console.error("Failed to send tool response to session on voice reject:", e);
                      }
                      clientWs.send(JSON.stringify({
                        type: "command_blocked",
                        terminalId: pending.terminalId,
                        cmd: pending.cmd,
                        reason: "Execution cancelled by operator via voice."
                      }));
                    }
                    delete pendingApprovals[messageId];
                    broadcast({ type: "terminals_updated" }); // Refresh lists
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

              // Auto-log agent comments as bullet points inside synchronous prompt buffer
              const cleanUtter = modelUtterance.trim();
              if (cleanUtter.length > 2) {
                promptBufferText += `\n* **Agentic Thought**: *${cleanUtter}*`;
                broadcast({
                  type: "prompt_buffer_updated",
                  text: promptBufferText
                });
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
                const cmd = args.command;
                
                // Determine effective permission mode: First check global, then local terminal
                let effectivePermissions = manager.globalPermissionsMode;
                if (effectivePermissions === "Inherit") {
                  const term = manager.terminals[targetId];
                  effectivePermissions = term ? term.permissionsMode : "Human-in-the-Loop";
                }
                
                if (effectivePermissions === "Full Auto") {
                  const term = manager.terminals[targetId];
                  if (term) {
                    HistoryManager.getInstance().addCommand(targetId, cmd);
                    term.writeInput(cmd);
                    session.sendToolResponse({
                      functionResponses: [{
                        name: "propose_command",
                        id: call.id,
                        response: { output: `Command executed automatically on node ${targetId}: "${cmd}"` }
                      }]
                    });
                    clientWs.send(JSON.stringify({
                      type: "command_auto_executed",
                      terminalId: targetId,
                      cmd
                    }));
                  } else {
                    session.sendToolResponse({
                      functionResponses: [{
                        name: "propose_command",
                        id: call.id,
                        response: { output: `Error: Node ${targetId} not found.` }
                      }]
                    });
                  }
                } else if (effectivePermissions === "Read-Only") {
                  session.sendToolResponse({
                    functionResponses: [{
                      name: "propose_command",
                      id: call.id,
                      response: { output: `Error: Write execution block is active. Terminal ${targetId} is Read-Only.` }
                    }]
                  });
                  clientWs.send(JSON.stringify({
                    type: "command_blocked",
                    terminalId: targetId,
                    cmd,
                    reason: "Read-Only policy enforced."
                  }));
                } else {
                  // Human-in-the-loop intercept
                  const messageId = call.id; // use call.id as unique ID
                  const trigUtterance = currentSessionUserUtterance || "Spoken execute command";
                  const pSummary = manager.getPaneSummary(targetId, 5);
                  const rationale = { trigger: trigUtterance, summary: pSummary };
                  pendingApprovals[messageId] = { cmd, terminalId: targetId, callId: call.id, session, rationale };
                  
                  // Notify frontend to ask for approval
                  clientWs.send(JSON.stringify({
                    type: "approval_pending",
                    messageId,
                    cmd,
                    terminalId: targetId,
                    rationale
                  }));
                  // We do NOT send tool response here. It will be sent via /api/commands/approve API.
                }
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
                let text = "";
                if (unread.length === 0) {
                  text = "There are no pending alerts or actions requiring your attention right now.";
                } else {
                  text = `There are ${unread.length} items requiring attention. `;
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
                  settings: manager.settings
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
                  settings: manager.settings
                });
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Microphone now ${muted ? 'muted' : 'active-listening'}.` } }]
                });
              } else if (name === "add_watch_rule") {
                const { trigger_terminal_id, trigger_transition, action_terminal_id, action_command, one_shot } = args;
                const newRule = {
                  id: "rule_" + Math.random().toString(36).substring(2, 11),
                  triggerTerminalId: trigger_terminal_id,
                  triggerTransition: trigger_transition,
                  actionTerminalId: action_terminal_id,
                  actionCommand: action_command,
                  enabled: true,
                  oneShot: one_shot !== undefined ? one_shot : true
                };
                manager.ledger.watchRules.push(newRule);
                manager.ledger["save"](true);
                broadcast({ type: "watch_rules_updated", watchRules: manager.ledger.watchRules });
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Automation watch rule added: trigger ${trigger_terminal_id} on ${trigger_transition} -> run ${action_command} on ${action_terminal_id}` } }]
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
                  
                  const targetTerm = manager.terminals[currentStep.terminalId];
                  if (targetTerm) {
                    HistoryManager.getInstance().addCommand(currentStep.terminalId, currentStep.command);
                    targetTerm.writeInput(currentStep.command);
                    resp = `Started execution of plan '${plan.name}'! Running step 1: command '${currentStep.command}' on target '${currentStep.terminalId}'...`;
                  } else {
                    plan.status = "paused";
                    currentStep.status = "failed";
                    resp = `Error: Cannot start plan '${plan.name}' because node '${currentStep.terminalId}' is not online.`;
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
                if (!sourceTerm || !targetTerm) {
                  resp = `Error: Both source and target terminal panes must be active. (Source: ${sourceTerm ? 'OK':'Not found'}, Target: ${targetTerm ? 'OK':'Not found'})`;
                } else {
                  const sourceHistory = HistoryManager.getInstance().loadHistory(source_pane_id);
                  const lastFiveOutlines = sourceHistory.map(h => `${h.command} -> ${h.finalResponse || "executed"}`).slice(-5).join(" | ");
                  
                  const activeProjectId = manager.ledger.activeProjectId || "default_project";
                  const handoffNote = `Handoff from [${source_pane_id}] with notes: ${context_notes}. Last events: ${lastFiveOutlines}`;
                  
                  manager.ledger.addPaneNote(activeProjectId, target_pane_id, handoffNote);
                  
                  const commentCommand = `# === HANDOFF CONTEXT INTERCEPT ===\n# Source: ${source_pane_id} -> Target: ${target_pane_id}\n# Notes: ${context_notes.replace(/\r?\n/g, ' ')}\n# State indicators: ${lastFiveOutlines.replace(/\r?\n/g, ' ')}\n# ==================================`;
                  targetTerm.writeInput(commentCommand);
                  
                  broadcastLedgerUpdate();
                  resp = `Successful handoff orchestrated from [${source_pane_id}] to [${target_pane_id}]. Handoff packet injected into active process thread streams.`;
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
            }
          }
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
        systemInstruction: `You are Project Janus, a voice helper controlling active terminal panes.\n\nCURRENT ROUTING CONTEXT (System State):\n- Active Project/Workspace ID: ${manager.ledger.activeProjectId || "None"}\n- Available Workspaces: ${Object.keys(manager.ledger.workspaces).map(pId => pId + " (" + manager.ledger.workspaces[pId].name + ")").join(", ")}\n\nPane status (busy/idle), elapsed time, and last command are LIVE and change constantly. NEVER assume a pane's status from memory or this prompt — it is not listed here because it would be stale. ALWAYS call list_panes to read current per-pane status before reporting whether anything is running or done.\n\nYou can list panes, get pane summaries, switch project contexts, and propose commands for human approval. You can also add notes to projects/panes and rename them to help you organize. You MUST remain token-light: only query screen summaries when necessary. Always use switch_context to get the full project briefing when starting.`,
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
              description: "Propose a command for a pane. Does NOT execute. Triggers human approval; returns the outcome (executed | edited | denied).",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  pane_id: { type: Type.STRING, description: "Target pane ID." },
                  command: { type: Type.STRING, description: "The refined command string." }
                },
                required: ["pane_id", "command"]
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
              description: "Speak a structured summary of items in the attention queue (panes that transitioned to error/exit states). NOTE: this does NOT include pending command approvals — those are a separate queue.",
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
              name: "add_watch_rule",
              description: "Add an automation rule that runs a command in an target pane when a trigger pane undergoes a state transition.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  trigger_terminal_id: { type: Type.STRING },
                  trigger_transition: { type: Type.STRING, description: "Transition type (idle, prompt, error, build-failed, exited)" },
                  action_terminal_id: { type: Type.STRING },
                  action_command: { type: Type.STRING },
                  one_shot: { type: Type.BOOLEAN, description: "If true, rule runs once and disables itself." }
                },
                required: ["trigger_terminal_id", "trigger_transition", "action_terminal_id", "action_command"]
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
        } else if (msg.type === "prompt_buffer_edit" && msg.text !== undefined) {
          promptBufferText = msg.text;
          broadcast({
            type: "prompt_buffer_updated",
            text: promptBufferText
          });
        }
      } catch (err) {
        console.warn("Received malformed or non-JSON WebSocket frame, skipping:", err);
      }
    });

    clientWs.on("close", () => {
      clients.delete(clientWs);
      if (activeFrontendWs === clientWs) {
        activeFrontendWs = null;
      }
      if (session) {
        // Clean up any pending approvals associated with this session to avoid leaks or hanging tool-calls
        for (const [messageId, details] of Object.entries(pendingApprovals)) {
          if (details.session === session) {
            console.log(`[CLEANUP] Purging orphaned approval ${messageId} linked to closed session.`);
            delete pendingApprovals[messageId];
          }
        }
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
