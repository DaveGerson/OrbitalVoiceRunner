import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";
import { OrchestratorManager, UniversalTerminal, stripAnsiSequences } from "./src/terminal";

dotenv.config();

const PORT = 3000;

const manager = new OrchestratorManager();
// Add default terminal
manager.addTerminal("primary-cli", process.cwd(), process.platform === "win32" ? "cmd.exe" : "bash");

async function startServer() {
  const app = express();
  app.use(express.json());

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

  manager.onOutput = (terminalId, chunk) => {
    broadcast({
      type: "stdout_chunk",
      terminalId,
      chunk
    });
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
        cpu_usage: term.cpuUsage
      };
    });
    res.json(list);
  });

  app.get("/api/ledger", (req, res) => {
    res.json(manager.ledger.workspaces);
  });

  // Web API to create a terminal manually
  app.post("/api/terminals", (req, res) => {
    const { terminalId, cwd, command, toolPreset, permissionsMode, sessionId } = req.body;
    if (!terminalId || !cwd || !command) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    const result = manager.addTerminal(terminalId, cwd, command, toolPreset, permissionsMode, sessionId);
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

  // Project and Pane management endpoints
  app.post("/api/projects", (req, res) => {
    const { id, directory, summary } = req.body;
    manager.ledger.addProject(id, directory, summary);
    broadcastLedgerUpdate();
    res.json({ success: true });
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
  const pendingApprovals: Record<string, { cmd: string, terminalId: string, callId: string, session: any }> = {};

  app.get("/api/commands/pending", (req, res) => {
    res.json(Object.entries(pendingApprovals).map(([messageId, details]) => ({
      messageId,
      cmd: details.cmd,
      terminalId: details.terminalId
    })));
  });

  app.post("/api/commands/approve", (req, res) => {
    const { messageId, approved } = req.body;
    const pending = pendingApprovals[messageId];
    if (pending) {
      if (approved) {
        const term = manager.terminals[pending.terminalId];
        const dispatched = term ? term.writeInput(pending.cmd) : false;
        pending.session.sendToolResponse({
          functionResponses: [{
            name: "propose_command",
            id: pending.callId,
            response: {
              output: dispatched
                ? `Command dispatched to ${pending.terminalId} successfully.`
                : `Execution failed: pane '${pending.terminalId}' is unavailable or has exited.`
            }
          }]
        });
      } else {
        pending.session.sendToolResponse({
          functionResponses: [{
            name: "propose_command",
            id: pending.callId,
            response: { output: "Execution cancelled by operator." }
          }]
        });
      }
      delete pendingApprovals[messageId];
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Pending command not found" });
    }
  });

  wss.on("connection", async (clientWs) => {
    activeFrontendWs = clientWs;
    clients.add(clientWs);
    console.log("Client connected to WebSocket");

    let session: any = null;
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
              } else if (name === "get_pane_summary") {
                const targetId = args.pane_id;
                const out = manager.getPaneSummary(targetId);
                session.sendToolResponse({
                  functionResponses: [{ name, id: call.id, response: { output: out } }]
                });
              } else if (name === "switch_context") {
                const projectId = args.project_id;
                manager.ledger.switchContext(projectId);
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
                  pendingApprovals[messageId] = { cmd, terminalId: targetId, callId: call.id, session };
                  
                  // Notify frontend to ask for approval
                  clientWs.send(JSON.stringify({
                    type: "approval_pending",
                    messageId,
                    cmd,
                    terminalId: targetId
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
        systemInstruction: "You are Project Janus, a voice helper controlling active terminal panes. You can list panes, get pane summaries, switch project contexts, and propose commands for human approval. You can also add notes to projects/panes and rename them to help you organize. You MUST remain token-light: only query screen summaries when necessary. Always use switch_context to get the project briefing when starting.",
        ...({
          sessionResumption: {},
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
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
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
      }
    });

    clientWs.on("close", () => {
      clients.delete(clientWs);
      if (activeFrontendWs === clientWs) {
        activeFrontendWs = null;
      }
      // Release the upstream Gemini session and drop approvals bound to it
      // so connect/disconnect cycles don't leak live sessions.
      for (const [id, pending] of Object.entries(pendingApprovals)) {
        if (pending.session === session) delete pendingApprovals[id];
      }
      if (session) {
        try {
          session.close();
        } catch {}
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

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
