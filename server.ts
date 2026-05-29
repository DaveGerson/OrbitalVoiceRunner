import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";
import crypto from "crypto";
import { OrchestratorManager, UniversalTerminal, stripAnsiSequences } from "./src/terminal";

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

      const prompt = `You are a strict, command-line terminal outcome synthesizer.
Summarize the final response and outcome of the following command execution. Do NOT include raw or verbose stdout log sequences. Focus exclusively on the ultimate outcome, success/failure of the command, and any critical final lines of output (key numbers, final results, final generated file text, or compile error statements). Do not say who you are. Keep your summary to 1-2 small conversational sentences, highly professional and compact.

Command: ${command}
Verbose Output:
${rawOutput.slice(-3000)}`;

      const response = await summarizeAi.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });
      return response.text?.trim() || "No outcomes summary available.";
    } catch (err) {
      console.error("[summarizeCommandOutcome] Error:", err);
      return "Execution finished successfully.";
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

  const outputBuffers: Record<string, string[]> = {};
  let flushTimeout: NodeJS.Timeout | null = null;

  manager.onOutput = (terminalId, chunk) => {
    const term = manager.terminals[terminalId];
    if (term) {
      const cleanChunk = stripAnsiSequences(chunk);
      HistoryManager.getInstance().appendOutputToLastCommand(terminalId, cleanChunk);
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

              // Auto-log dictation as bullet points inside synchronous prompt buffer
              const cleanUtter = userUtterance.trim();
              if (cleanUtter.length > 2) {
                promptBufferText += `\n* **User Dictation**: ${cleanUtter}`;
                broadcast({
                  type: "prompt_buffer_updated",
                  text: promptBufferText
                });
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
                const history = HistoryManager.getInstance().loadHistory(cwd);
                const conciseHistory = history.map((entry: any) => ({
                  command: entry.command,
                  timestamp: entry.timestamp,
                  finalResponse: entry.finalResponse || stripAnsiSequences(entry.output).slice(-300).trim() || "No output captured."
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
                manager.ledger.addNote(args.project_id, args.note);
                broadcastLedgerUpdate();
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Note added to project ${args.project_id}` } }]
                });
              } else if (name === "add_pane_note") {
                manager.ledger.addPaneNote(args.project_id, args.pane_id, args.note);
                broadcastLedgerUpdate();
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: `Note added to pane ${args.pane_id}` } }]
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
        systemInstruction: `You are Project Janus, a voice helper controlling active terminal panes.\n\nCURRENT ROUTING CONTEXT (System State):\n- Active Project/Workspace ID: ${manager.ledger.activeProjectId || "None"}\n- Available Workspaces: ${Object.keys(manager.ledger.workspaces).map(pId => pId + " (" + manager.ledger.workspaces[pId].name + ")").join(", ")}\n- Live Terminal Panes: ${Object.values(manager.terminals).map(t => t.terminalId + " (Status: " + t.status + ", CWD: " + t.cwd + ")").join(", ")}\n\nYou can list panes, get pane summaries, switch project contexts, and propose commands for human approval. You can also add notes to projects/panes and rename them to help you organize. You MUST remain token-light: only query screen summaries when necessary. Always use switch_context to get the full project briefing when starting.`,
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
              description: "List all projects and their panes with runtime_type, is_busy, alive, and a one-line state. Cheap orientation call.",
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
              description: "Return the clean, redacted markdown delta of one pane's recent screen activity. Primary observation path. Pull, not push.",
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
