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

  // Web API to get terminals state
  app.get("/api/terminals", (req, res) => {
    const list = Object.keys(manager.terminals).map((id) => ({
      id,
      cwd: manager.terminals[id].cwd,
      command: manager.terminals[id].shellCmd,
      output: manager.terminals[id].getRecentOutput(20),
      status: manager.terminals[id].status
    }));
    res.json(list);
  });

  // Web API to create a terminal manually
  app.post("/api/terminals", (req, res) => {
    const { terminalId, cwd, command } = req.body;
    if (!terminalId || !cwd || !command) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    const result = manager.addTerminal(terminalId, cwd, command);
    if (activeFrontendWs) {
      activeFrontendWs.send(JSON.stringify({ type: "terminals_updated" }));
    }
    res.json({ success: true, result });
  });

  // Client pending commands mapping Map<messageId, Function(approved: boolean)>
  // To keep it simple, we store pending execution approvals here.
  const pendingApprovals: Record<string, { cmd: string, terminalId: string, callId: string, session: any }> = {};

  app.post("/api/commands/approve", (req, res) => {
    const { messageId, approved } = req.body;
    const pending = pendingApprovals[messageId];
    if (pending) {
      if (approved) {
        const term = manager.terminals[pending.terminalId];
        if (term) {
          term.writeInput(pending.cmd);
          pending.session.sendToolResponse({
            functionResponses: [{
              name: "propose_command",
              id: pending.callId,
              response: { output: `Command dispatched to ${pending.terminalId} successfully.` }
            }]
          });
        }
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

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  let activeFrontendWs: any = null;

  wss.on("connection", async (clientWs) => {
    activeFrontendWs = clientWs;
    console.log("Client connected to WebSocket");

    // Initialize Gemini Live session
    const session = await ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
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
            }
          }
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
        },
        systemInstruction: "You are Project Janus, a voice helper controlling active terminal panes. You can list panes, get pane summaries, switch project contexts, and propose commands for human approval. You MUST remain token-light: only query screen summaries when necessary. Always use switch_context to get the project briefing when starting.",
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
            }
          ]
        }]
      },
    });

    clientWs.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "audio" && msg.audio) {
        // Feed user mic to Gemini
        session.sendRealtimeInput({
          audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
        });
      }
    });

    clientWs.on("close", () => {
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
