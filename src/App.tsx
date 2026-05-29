import * as React from "react";
import { useEffect, useState, useRef } from "react";
import { Terminal, PendingCommand, Workspace, PaneMeta, SystemSettings } from "./types";
import { pcmToBase64, playAudioChunk, resetAudioPlayback, isAudioPlaying } from "./utils/audio";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { CreateTerminalDialog } from "./components/CreateTerminalDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { TerminalView } from "./components/TerminalView";
import { AnimatePresence, motion } from "motion/react";
import { ProjectDialog } from "./components/ProjectDialog";
import { Mic, MicOff, RefreshCw, Cpu, Database, Shield, Terminal as TermIcon, FileText, Clipboard, Plus, Trash2, Settings, History, Clock, Check, CheckSquare, Layers, Sparkles, Smartphone, Laptop, BookOpen } from "lucide-react";
import { apiFetch } from "./utils/api";

function AppRaw() {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [ledger, setLedger] = useState<Record<string, Workspace>>({});
  const [activeProjectId, setActiveProjectId] = useState<string>("default_project");
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [termFilter, setTermFilter] = useState<"All" | "Running" | "Idle">("All");
  const [pendingCommands, setPendingCommands] = useState<PendingCommand[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [recentlyIdled, setRecentlyIdled] = useState<Record<string, boolean>>({});
  const prevTerminalsRef = useRef<Terminal[]>([]);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Workspace | null>(null);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [promptDialog, setPromptDialog] = useState<{title: string, placeholder: string, onSubmit: (val: string) => void} | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [newNoteInputs, setNewNoteInputs] = useState<Record<string, string>>({});
  const [isMockMode, setIsMockMode] = useState<boolean>(false);
  const [globalPermissionsMode, setGlobalPermissionsMode] = useState<"Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit">("Inherit");
  const [autoApprovedNotification, setAutoApprovedNotification] = useState<{terminalId: string, cmd: string} | null>(null);
  const [blockedNotification, setBlockedNotification] = useState<{terminalId: string, cmd: string, reason: string} | null>(null);
  const [wsErrorNotification, setWsErrorNotification] = useState<{message: string} | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [transcript, setTranscript] = useState<{ sender: "User" | "Janus"; text: string; timestamp: Date }[]>([]);
  const [showTranscriptPanel, setShowTranscriptPanel] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState<boolean>(false);
  const [historyList, setHistoryList] = useState<{ command: string; timestamp: string; output: string }[]>([]);
  const [selectedHistoryEntry, setSelectedHistoryEntry] = useState<{ command: string; timestamp: string; output: string } | null>(null);
  const [hoveredTermId, setHoveredTermId] = useState<string | null>(null);

  // --- Real-time Synchronous Markdown Prompt Buffer & Voice Agent Workspace States ---
  const [promptBuffer, setPromptBuffer] = useState("");
  const [isBufferFocused, setIsBufferFocused] = useState(false);
  const [promptBufferEditMode, setPromptBufferEditMode] = useState<"edit" | "preview">("preview");

  // Mobile layout switcher state: terminal | buffer | menu
  const [mobileActiveView, setMobileActiveView] = useState<"terminal" | "buffer" | "menu">("terminal");

  // Grid view display mode: detailed dashboard vs compact row list (useful for quick mobile operations)
  const [gridDisplayMode, setGridDisplayMode] = useState<"detailed" | "compact">("compact");

  // Fetch Synchronous Prompt Buffer Initial State
  const fetchPromptBuffer = async () => {
    try {
      const res = await apiFetch("/api/prompt-buffer");
      if (res.ok) {
        const data = await res.json();
        setPromptBuffer(data.text);
      }
    } catch (e) {
      console.warn("REST prompt-buffer fetch failed: fallback to offline mode");
    }
  };

  const handlePromptBufferChange = (val: string) => {
    setPromptBuffer(val);
    
    // Send over WebSocket or save REST fallback
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "prompt_buffer_edit",
        text: val
      }));
    } else {
      apiFetch("/api/prompt-buffer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: val })
      }).catch(() => {});
    }
  };

  const handleSyncNoteToActiveNode = async () => {
    if (!activeTerminalId || !activeProjectId) return;
    try {
      await apiFetch(`/api/projects/${activeProjectId}/panes/${activeTerminalId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: `Requirement Spec Captured: ${promptBuffer.slice(0, 100).replace(/\n/g, " ")}...` })
      });
      fetchLedger();
    } catch (e) {}
  };

  const fetchActiveTerminalHistory = async (terminalId: string | null = activeTerminalId) => {
    if (!terminalId) return;
    try {
      const res = await apiFetch(`/api/terminals/${terminalId}/history`);
      if (res.ok) {
        const data = await res.json();
        setHistoryList(data);
      }
    } catch (e) {
      console.error("Failed to load terminal history:", e);
    }
  };

  const clearActiveTerminalHistory = async () => {
    if (!activeTerminalId) return;
    try {
      const res = await apiFetch(`/api/terminals/${activeTerminalId}/history/clear`, {
        method: "POST"
      });
      if (res.ok) {
        setHistoryList([]);
        setSelectedHistoryEntry(null);
      }
    } catch (e) {
      console.error("Failed to clear terminal history:", e);
    }
  };

  const stdoutBufferRef = useRef<Record<string, string>>({});
  const animationFrameRef = useRef<number | null>(null);

  const queueStdoutChunk = (terminalId: string, chunk: string) => {
    stdoutBufferRef.current[terminalId] = (stdoutBufferRef.current[terminalId] || "") + chunk;
    
    if (!animationFrameRef.current) {
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null;
        const currentBuffers = { ...stdoutBufferRef.current };
        stdoutBufferRef.current = {};

        setTerminals((prev) =>
          prev.map((t) => {
            const bufMatch = currentBuffers[t.id];
            if (bufMatch) {
              const lines = (t.output + bufMatch).split("\n").slice(-110);
              return { ...t, output: lines.join("\n") };
            }
            return t;
          })
        );
      });
    }
  };

  const wsRef = useRef<WebSocket | null>(null);
  const voiceCaptureCtxRef = useRef<AudioContext | null>(null);
  const voicePlaybackCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const isMicMutedRef = useRef(false);
  const desiredLiveRef = useRef(false);
  const reconnectTimeoutRef = useRef<any>(null);

  const isMockModeRef = useRef(false);

  const fetchTerminals = async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/terminals");
      if (!res.ok) return;
      const data = await res.json();
      setTerminals(data);
    } catch (e) {
      // Silent catch to prevent 'Failed to fetch' console errors during server restarts
    }
  };

  const fetchLedger = async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/ledger");
      if (!res.ok) return;
      const data = await res.json();
      setLedger(data);
    } catch (e) {}
  };

  const fetchSettings = async () => {
    try {
      const res = await apiFetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data);
      if (data.advanced) {
        setGlobalPermissionsMode(data.advanced.globalPermissionsMode);
      }
    } catch (e) {}
  };

  const handleUpdateGlobalPermissions = async (val: string) => {
    try {
      const updatedSettings = settings ? {
        ...settings,
        advanced: { ...settings.advanced, globalPermissionsMode: val }
      } : { advanced: { globalPermissionsMode: val } };

      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedSettings)
      });
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data.settings);
      setGlobalPermissionsMode(data.globalPermissionsMode);
    } catch (e) {}
  };

  const handleSaveSettings = async (updatedSettings: SystemSettings) => {
    try {
      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedSettings)
      });
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data.settings);
      setGlobalPermissionsMode(data.globalPermissionsMode);
    } catch (e) {}
  };

  const fetchPendingCommands = async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/commands/pending");
      if (!res.ok) return;
      const data = await res.json();
      setPendingCommands(data);
    } catch (e) {}
  };

  useEffect(() => {
    fetchTerminals();
    fetchLedger();
    fetchSettings();
    fetchPendingCommands();
    fetchPromptBuffer(); // Sync initial prompt buffer
    const interval = setInterval(() => {
      fetchTerminals();
      fetchPendingCommands();
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    isMicMutedRef.current = isMicMuted;
  }, [isMicMuted]);

  useEffect(() => {
    if (activeTerminalId) {
      fetchActiveTerminalHistory(activeTerminalId);
    }
  }, [activeTerminalId]);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (showHistoryPanel && activeTerminalId) {
      fetchActiveTerminalHistory(activeTerminalId);
      interval = setInterval(() => {
        fetchActiveTerminalHistory(activeTerminalId);
      }, 5000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [showHistoryPanel, activeTerminalId]);

  useEffect(() => {
    const prev = prevTerminalsRef.current;
    let hasChanges = false;
    const nextRecentlyIdled = { ...recentlyIdled };

    terminals.forEach((term) => {
      const prevTerm = prev.find((p) => p.id === term.id);
      if (prevTerm && prevTerm.status === "Running" && term.status === "Idle") {
        nextRecentlyIdled[term.id] = true;
        hasChanges = true;
        
        // Remove animation after 6 seconds (2 heartbeats)
        setTimeout(() => {
          setRecentlyIdled(current => {
            if (!current[term.id]) return current;
            const updated = { ...current };
            delete updated[term.id];
            return updated;
          });
        }, 6000);
      } else if (term.status === "Running" && nextRecentlyIdled[term.id]) {
        delete nextRecentlyIdled[term.id];
        hasChanges = true;
      }
    });

    if (hasChanges) {
      setRecentlyIdled(nextRecentlyIdled);
    }

    prevTerminalsRef.current = terminals;
  }, [terminals]);

  const handleApprove = async (messageId: string) => {
    if (isMockModeRef.current) {
      const pendingCmd = pendingCommands.find(p => p.messageId === messageId);
      setPendingCommands(prev => prev.filter(item => item.messageId !== messageId));
      if (pendingCmd) {
        setTerminals(prev => prev.map(t => {
          if (t.id === pendingCmd.terminalId) {
            return {
              ...t,
              status: "Running",
              command: pendingCmd.cmd,
              output: t.output + `\n\n> ${pendingCmd.cmd}\n` + (pendingCmd.cmd.includes("tailwindcss") ? "added 1 package, and audited 2 packages in 3s" : "Successfully installed pandas 2.1.0\nDONE"),
            };
          }
          return t;
        }));
      }
      return;
    }
    try {
      await apiFetch("/api/commands/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, approved: true })
      });
      setPendingCommands(prev => prev.filter(item => item.messageId !== messageId));
      setTimeout(fetchTerminals, 500);
    } catch (e) {}
  };

  const handleReject = async (messageId: string) => {
    if (isMockModeRef.current) {
      setPendingCommands(prev => prev.filter(item => item.messageId !== messageId));
      return;
    }
    try {
      await apiFetch("/api/commands/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, approved: false })
      });
      setPendingCommands(prev => prev.filter(item => item.messageId !== messageId));
    } catch (e) {}
  };

  const handleCreateTerminal = async (
    id: string,
    cwd: string,
    cmd: string,
    toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom",
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only"
  ) => {
    if (isMockModeRef.current) {
      setTerminals(prev => [...prev, {
        id,
        cwd,
        command: cmd,
        output: "Mock Node Started...\n",
        status: "Running",
        tool_preset: toolPreset,
        permissions_mode: permissionsMode,
        context_size: 0
      }]);
      setLedger(prev => {
        const next = { ...prev };
        if (activeProjectId && next[activeProjectId]) {
          next[activeProjectId].panes[id] = {
            pane_id: id,
            name: "Mock Node " + id,
            runtime_type: "shell",
            last_known_state: "Running",
            is_busy: true,
            alive: true,
            notes: [],
            permissions_mode: permissionsMode,
            session_id: "mock_session_" + id,
            tool_preset: toolPreset,
            context_size: 0
          };
        }
        return next;
      });
      setShowCreateModal(false);
      setActiveTerminalId(id);
      return;
    }
    
    try {
      await apiFetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          terminalId: id,
          cwd,
          command: cmd,
          toolPreset,
          permissionsMode,
          projectId: activeProjectId
        })
      });
      setShowCreateModal(false);
      fetchTerminals();
      fetchLedger();
      setActiveTerminalId(id);
    } catch (e) {}
  };

  const handleRestartTerminal = async (id: string) => {
    try {
      await apiFetch(`/api/terminals/${id}/restart`, {
        method: "POST"
      });
      fetchTerminals();
      fetchLedger();
    } catch (e) {}
  };

  const handleUpdatePermissions = async (paneId: string, val: string) => {
    try {
      await apiFetch(`/api/projects/${activeProjectId}/panes/${paneId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: val })
      });
      fetchLedger();
      fetchTerminals();
    } catch (e) {}
  };

  const cleanupSocketOnly = () => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch (e) {}
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch (e) {}
      sourceRef.current = null;
    }
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((track) => track.stop());
      } catch (e) {}
      streamRef.current = null;
    }
    if (voiceCaptureCtxRef.current) {
      try {
        voiceCaptureCtxRef.current.close();
      } catch (e) {}
      voiceCaptureCtxRef.current = null;
    }
    if (voicePlaybackCtxRef.current) {
      try {
        voicePlaybackCtxRef.current.close();
      } catch (e) {}
      voicePlaybackCtxRef.current = null;
    }
  };

  const connectLive = async () => {
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/live`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const captureCtx = new AudioContext({ sampleRate: 16000 });
      const playbackCtx = new AudioContext({ sampleRate: 24000 });
      voiceCaptureCtxRef.current = captureCtx;
      voicePlaybackCtxRef.current = playbackCtx;
      resetAudioPlayback();

      ws.onopen = async () => {
        setIsLive(true);
        setIsReconnecting(false);
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          streamRef.current = stream;
          
          const source = captureCtx.createMediaStreamSource(stream);
          sourceRef.current = source;
          const processor = captureCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;
          
          source.connect(processor);
          processor.connect(captureCtx.destination);

          processor.onaudioprocess = (e) => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && !isMicMutedRef.current) {
              if (isAudioPlaying(voicePlaybackCtxRef.current)) {
                // Half-duplex barge-in/echo prevention: drop capture frames while synthesized speech streams through speakers
                return;
              }
              const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
              wsRef.current.send(JSON.stringify({ type: "audio", audio: base64 }));
            }
          };
        } catch (mediaErr) {
          console.error("Microphone streaming failed to start:", mediaErr);
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio" && msg.audio) {
          playAudioChunk(playbackCtx, msg.audio);
        } else if (msg.type === "interrupted") {
          resetAudioPlayback();
        } else if (msg.type === "approval_pending") {
          setPendingCommands(prev => {
            if (prev.some(pc => pc.messageId === msg.messageId)) return prev;
            return [...prev, {
              messageId: msg.messageId,
              cmd: msg.cmd,
              terminalId: msg.terminalId,
              rationale: msg.rationale
            }];
          });
        } else if (msg.type === "prompt_buffer_updated") {
          setIsBufferFocused(focused => {
            if (!focused) {
              setPromptBuffer(msg.text);
            }
            return focused;
          });
        } else if (msg.type === "terminals_updated") {
          fetchTerminals();
        } else if (msg.type === "ledger_updated") {
          setLedger(msg.ledger);
        } else if (msg.type === "settings_updated") {
          setGlobalPermissionsMode(msg.globalPermissionsMode);
          if (msg.settings) {
            setSettings(msg.settings);
          }
        } else if (msg.type === "command_auto_executed") {
          setAutoApprovedNotification({ terminalId: msg.terminalId, cmd: msg.cmd });
          setTimeout(() => setAutoApprovedNotification(null), 4000);
          fetchTerminals();
        } else if (msg.type === "command_blocked") {
          setBlockedNotification({ terminalId: msg.terminalId, cmd: msg.cmd, reason: msg.reason });
          setTimeout(() => setBlockedNotification(null), 4000);
        } else if (msg.type === "stdout_chunk") {
          queueStdoutChunk(msg.terminalId, msg.chunk);
        } else if (msg.type === "transcript_text") {
          setTranscript((prev) => [
            ...prev,
            { sender: msg.sender, text: msg.text, timestamp: new Date() }
          ].slice(-50));
        } else if (msg.type === "error") {
          setWsErrorNotification({ message: msg.message || "An unexpected error occurred during raw liveness communication." });
          setTimeout(() => setWsErrorNotification(null), 8000);
          resetAudioPlayback();
        }
      };

      ws.onclose = (event) => {
        cleanupSocketOnly();
        
        // Adaptive auto-reconnection if closure was unexpected from server-side or connection drops
        if (desiredLiveRef.current) {
          setIsLive(true);
          setIsReconnecting(true);
          
          if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = setTimeout(() => {
            if (desiredLiveRef.current) {
              connectLive();
            }
          }, 3000);
        } else {
          setIsLive(false);
          setIsReconnecting(false);
        }
      };
    } catch (e) {
      console.error("Connection establish failed:", e);
      cleanupSocketOnly();
      if (desiredLiveRef.current) {
        setIsLive(true);
        setIsReconnecting(true);
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (desiredLiveRef.current) connectLive();
        }, 3000);
      } else {
        setIsLive(false);
        setIsReconnecting(false);
      }
    }
  };

  const startLive = async () => {
    desiredLiveRef.current = true;
    setIsReconnecting(false);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    await connectLive();
  };

  const stopLive = () => {
    desiredLiveRef.current = false;
    setIsLive(false);
    setIsReconnecting(false);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    cleanupSocketOnly();
  };

  const generateMockData = () => {
    isMockModeRef.current = !isMockMode;
    setIsMockMode(!isMockMode);
    
    if (isMockMode) {
      // Turn off mock mode
      fetchTerminals();
      fetchLedger();
      fetchPendingCommands();
      setTranscript([]);
      return;
    }

    // Turn on mock mode and populate fake data
    const mockTermId1 = "terminal_mock_1";
    const mockTermId2 = "terminal_mock_2";
    const mockTermId3 = "terminal_mock_3";
    
    setTerminals([
      {
        id: mockTermId1,
        cwd: "/home/user/workspace/web-app",
        command: "npm run dev",
        output: "\\n> web-app@1.0.0 dev\\n> vite\\n\\n  VITE v5.0.0  ready in 150 ms\\n\\n  ➜  Local:   http://localhost:5173/\\n  ➜  Network: use --host to expose",
        status: "Running",
        tool_preset: "Claude Code",
        permissions_mode: "Full Auto",
        context_size: 450
      },
      {
        id: mockTermId2,
        cwd: "/home/user/workspace/backend-api",
        command: "python main.py",
        output: "Starting server on port 8000...\\nConnecting to db...\\nDatabase connected.",
        status: "Idle",
        tool_preset: "Custom",
        permissions_mode: "Human-in-the-Loop",
        context_size: 2300
      },
      {
        id: mockTermId3,
        cwd: "/home/user/workspace/data-pipeline",
        command: "npm run build",
        output: "[ERROR] Failed to compile data-pipeline.\\nModuleNotFoundError: No module named 'pandas'\\n\\nError: Command failed with exit code 1.\\nPlease verify your dependencies are installed.",
        status: "Running",
        tool_preset: "Claude Code",
        permissions_mode: "Full Auto",
        context_size: 1024
      }
    ]);

    setLedger({
      "mock_project_alpha": {
        id: "mock_project_alpha",
        name: "Alpha Project",
        directory: "/home/user/workspace",
        summary: "This is a mock project to test UI capability.",
        notes: ["Remember to check API rate limits"],
        keyTerms: ["react", "vite", "nodejs"],
        panes: {
          [mockTermId1]: {
            pane_id: mockTermId1,
            name: "React Frontend",
            runtime_type: "shell",
            last_known_state: "Running",
            is_busy: true,
            alive: true,
            notes: ["Dev server running"],
            permissions_mode: "Full Auto",
            session_id: "mock-sess-1",
            tool_preset: "Claude Code",
            context_size: 450
          },
          [mockTermId2]: {
            pane_id: mockTermId2,
            name: "Python Backend",
            runtime_type: "shell",
            last_known_state: "Idle",
            is_busy: false,
            alive: true,
            notes: ["DB Connected"],
            permissions_mode: "Human-in-the-Loop",
            session_id: "mock-sess-2",
            tool_preset: "Custom",
            context_size: 2300
          },
          [mockTermId3]: {
            pane_id: mockTermId3,
            name: "Data Pipeline",
            runtime_type: "shell",
            last_known_state: "Running",
            is_busy: true,
            alive: true,
            notes: ["Needs to install pandas", "Troubleshoot build failure"],
            permissions_mode: "Full Auto",
            session_id: "mock-sess-3",
            tool_preset: "Claude Code",
            context_size: 1024
          }
        }
      }
    });

    setActiveProjectId("mock_project_alpha");
    
    setPendingCommands([
      {
        messageId: "mock_msg_1",
        cmd: "npm install tailwindcss",
        terminalId: mockTermId2,
        rationale: { trigger: "I need tailwind", summary: "To add styling support to the project." }
      },
      {
        messageId: "mock_msg_2",
        cmd: "pip install pandas",
        terminalId: mockTermId3,
        rationale: { trigger: "Missing module", summary: "To fix the build error shown in the terminal output." }
      }
    ]);

    setTranscript([
      { sender: "User", text: "Please start the development server and prepare the background worker.", timestamp: new Date(Date.now() - 60000) },
      { sender: "Janus", text: "Understood. I will spin up the React frontend and initialize the Python backend.", timestamp: new Date(Date.now() - 55000) },
      { sender: "User", text: "Great, also install tailwind on the backend for some reason.", timestamp: new Date(Date.now() - 10000) },
      { sender: "Janus", text: "I noticed an error in the data pipeline build regarding a missing 'pandas' module. I have proposed a command to install it.", timestamp: new Date(Date.now() - 5000) }
    ]);
  };

  const activeTerminal = terminals.find(t => t.id === activeTerminalId);
  let activePaneMeta = null;
  let activeProjectMeta = null;
  const projectList = Object.values(ledger) as Workspace[];

  if (activeTerminalId) {
    for (const proj of projectList) {
      if (proj.panes && proj.panes[activeTerminalId]) {
        activePaneMeta = proj.panes[activeTerminalId];
        activeProjectMeta = proj;
        break;
      }
    }
  }

  const handleCreateProject = () => {
    setEditingProject(null);
    setShowProjectModal(true);
  };

  const handleEditProject = (project: Workspace) => {
    setEditingProject(project);
    setShowProjectModal(true);
  };

  const handleSaveProject = async (data: {
    id: string;
    name: string;
    directory: string;
    summary: string;
    keyTerms: string[];
  }) => {
    if (isMockModeRef.current) {
      setLedger(prev => {
        const next = { ...prev };
        if (editingProject) {
          next[editingProject.id] = {
            ...next[editingProject.id],
            name: data.name,
            directory: data.directory,
            summary: data.summary,
            keyTerms: data.keyTerms,
          };
        } else {
          next[data.id] = {
            id: data.id,
            name: data.name,
            directory: data.directory,
            summary: data.summary,
            keyTerms: data.keyTerms,
            notes: [],
            panes: {}
          };
        }
        return next;
      });
      if (!editingProject) {
        setActiveProjectId(data.id);
      }
      setShowProjectModal(false);
      setEditingProject(null);
      return;
    }
    if (editingProject) {
      await apiFetch(`/api/projects/${editingProject.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          directory: data.directory,
          summary: data.summary,
          keyTerms: data.keyTerms,
        }),
      });
      fetchLedger();
    } else {
      await apiFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: data.id,
          name: data.name,
          directory: data.directory,
          summary: data.summary,
          keyTerms: data.keyTerms,
        }),
      });
      await handleSwitchProject(data.id);
    }
    setShowProjectModal(false);
    setEditingProject(null);
  };

  const handleSwitchProject = async (id: string) => {
    if (isMockModeRef.current) {
      setActiveProjectId(id);
      setActiveTerminalId(null);
      return;
    }
    await apiFetch(`/api/projects/${id}/switch`, { method: "POST" });
    setActiveProjectId(id);
    setActiveTerminalId(null);
    fetchLedger();
    fetchTerminals();
  };

  const handleDeleteProjectPrompt = (id: string) => {
    setPromptDialog({
      title: `Type "SURE" to de-register and delete project [${id}]:`,
      placeholder: "SURE",
      onSubmit: async (val) => {
        if (val.trim() !== "SURE") return;
        await apiFetch(`/api/projects/${id}`, { method: "DELETE" });
        setPromptDialog(null);
        fetchLedger();
        setActiveTerminalId(null);
        fetchTerminals();
      }
    });
  };

  const handleDeletePanePrompt = async (projId: string, paneId: string) => {
    await apiFetch(`/api/projects/${projId}/panes/${paneId}`, { method: "DELETE" });
    fetchLedger();
    if (activeTerminalId === paneId) {
      setActiveTerminalId(null);
    }
    fetchTerminals();
  };

  const handleRenameProject = (id: string, current: string) => {
    setPromptDialog({
      title: "Rename Project", placeholder: current,
      onSubmit: async (val) => {
        if (!val.trim()) return;
        await apiFetch(`/api/projects/${id}/rename`, { method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: val}) });
        setPromptDialog(null);
        fetchLedger();
      }
    });
  };

  const handleAddProjectNote = (id: string) => {
    setPromptDialog({
      title: "Add Project Note", placeholder: "Note...",
      onSubmit: async (val) => {
        if (!val.trim()) return;
        await apiFetch(`/api/projects/${id}/notes`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({note: val}) });
        setPromptDialog(null);
        fetchLedger();
      }
    });
  };

  const handleRenamePane = (projId: string, paneId: string, current: string) => {
    setPromptDialog({
      title: "Rename Pane", placeholder: current,
      onSubmit: async (val) => {
        if (!val.trim()) return;
        await apiFetch(`/api/projects/${projId}/panes/${paneId}/rename`, { method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: val}) });
        setPromptDialog(null);
        fetchLedger();
      }
    });
  };

  const handleAddPaneNote = (projId: string, paneId: string) => {
    setPromptDialog({
      title: "Add Pane Note", placeholder: "Note...",
      onSubmit: async (val) => {
        if (!val.trim()) return;
        await apiFetch(`/api/projects/${projId}/panes/${paneId}/notes`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({note: val}) });
        setPromptDialog(null);
        fetchLedger();
      }
    });
  };

  const handleAddPaneNoteInline = async (projId: string, paneId: string) => {
    const rawNote = newNoteInputs[paneId];
    if (!rawNote || !rawNote.trim()) return;
    await apiFetch(`/api/projects/${projId}/panes/${paneId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: rawNote.trim() })
    });
    setNewNoteInputs(prev => ({ ...prev, [paneId]: "" }));
    fetchLedger();
  };

  const handleCopyClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const GenericPromptModal = () => {
    if (!promptDialog) return null;
    const [val, setVal] = useState("");
    return (
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur flex items-center justify-center p-4">
        <div className="bg-[#111] border border-white/10 p-6 rounded shadow-2xl w-full max-w-sm flex flex-col gap-4">
          <h2 className="text-white text-sm font-bold font-mono tracking-wide">{promptDialog.title}</h2>
          <input 
            autoFocus
            type="text" 
            placeholder={promptDialog.placeholder}
            value={val}
            onChange={e => setVal(e.target.value)}
            className="w-full bg-black border border-white/20 p-2 text-white font-mono text-xs focus:outline-none focus:border-cyan-500"
            onKeyDown={e => e.key === 'Enter' && promptDialog.onSubmit(val)}
          />
          <div className="flex justify-end gap-3 mt-2">
            <button onClick={() => setPromptDialog(null)} className="text-[10px] font-mono uppercase tracking-wider text-white/50 hover:text-white transition">Cancel</button>
            <button onClick={() => promptDialog.onSubmit(val)} className="text-[10px] font-mono uppercase tracking-wider text-cyan-400 font-bold hover:text-cyan-300 transition">Save</button>
          </div>
        </div>
      </div>
    );
  };

  const activeProject = projectList.find(p => p.id === activeProjectId);

  const totalContextSize = activeProject && activeProject.panes
    ? Object.values(activeProject.panes).reduce((sum, pane) => {
        const term = terminals.find(t => t.id === pane.pane_id);
        const size = term?.context_size !== undefined ? term.context_size : (pane.context_size || 0);
        return sum + size;
      }, 0)
    : 0;

  const totalTokensEstimated = Math.ceil(totalContextSize / 4);

  const renderTerminalHealthHeatmap = () => {
    return (
      <div className="flex flex-col bg-[#090909] border border-white/5 rounded-lg p-4 select-none relative w-full">
        {/* Title & Stats */}
        <div className="flex items-center justify-between mb-3.5 pb-2 border-b border-white/[0.04]">
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <h3 className="text-[11px] font-mono font-bold tracking-widest text-zinc-200 uppercase flex items-center gap-1.5">
              Agent Telemetry Heatmap
            </h3>
          </div>
          <span className="text-[9px] font-mono text-cyan-400/80 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/10">
            {terminals.filter(t => t.status === "Running").length}/{terminals.length} Running
          </span>
        </div>

        {/* Heatmap Grid */}
        {terminals.length === 0 ? (
          <div className="text-[10px] text-zinc-500 font-mono italic text-center py-4 bg-black/20 rounded border border-dashed border-white/5">
            No active agents registered in ledger.
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-5 sm:grid-cols-6 lg:grid-cols-5 xl:grid-cols-8 gap-2 mb-2">
              {terminals.map((term, index) => {
                const isAlertActive = pendingCommands.some(cmd => cmd.terminalId === term.id);
                const isActive = activeTerminalId === term.id;
                
                // Determine color classes for tiles
                let bgClass = "bg-zinc-950";
                let borderClass = "border-white/5";
                let textClass = "text-zinc-400";
                let animateDot = "";
                let dotColor = "bg-zinc-600";

                if (isAlertActive) {
                  bgClass = "bg-amber-500/15";
                  borderClass = "border-amber-500/70 shadow-[0_0_8px_rgba(245,158,11,0.2)]";
                  textClass = "text-amber-300 font-extrabold";
                  animateDot = "animate-ping";
                  dotColor = "bg-amber-500";
                } else if (term.status === "Running") {
                  bgClass = "bg-emerald-500/10";
                  borderClass = "border-emerald-500/30";
                  textClass = "text-emerald-400 font-semibold";
                  animateDot = "animate-pulse";
                  dotColor = "bg-emerald-500";
                } else if (term.status === "Idle") {
                  bgClass = "bg-yellow-500/5";
                  borderClass = "border-yellow-500/20";
                  textClass = "text-yellow-500/80";
                  dotColor = "bg-yellow-500";
                } else {
                  bgClass = "bg-red-500/5";
                  borderClass = "border-red-500/20";
                  textClass = "text-red-400/80";
                  dotColor = "bg-red-500";
                }

                // If currently viewed connected terminal, add cyan glow/override
                if (isActive) {
                  borderClass = "border-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.3)]";
                }

                return (
                  <div
                    key={term.id}
                    className={`h-11 rounded-md border flex flex-col items-center justify-center relative cursor-pointer group/tile transition-all duration-250 select-none ${bgClass} ${borderClass} hover:scale-105 active:scale-95`}
                    onMouseEnter={() => setHoveredTermId(term.id)}
                    onMouseLeave={() => setHoveredTermId(null)}
                    onClick={() => {
                      // Clicking on heatmap cell toggles tooltip or connects active terminal
                      setHoveredTermId(hoveredTermId === term.id ? null : term.id);
                    }}
                  >
                    <span className={`text-[10px] font-mono tracking-tight ${textClass}`}>
                      T{index + 1}
                    </span>
                    
                    {/* Tiny status indicator dot */}
                    <span className="absolute top-1.5 right-1.5 flex h-1.5 w-1.5">
                      {animateDot && (
                        <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${animateDot} ${dotColor}`}></span>
                      )}
                      <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${dotColor}`}></span>
                    </span>

                    {/* Badge showing truncated Name */}
                    <span className="text-[7.5px] font-mono text-zinc-650 group-hover/tile:text-zinc-400 select-none uppercase truncate max-w-[90%] pointer-events-none mt-0.5 leading-none">
                      {term.id.slice(-4)}
                    </span>
                  </div>
                );
              })}
            </div>
            
            {/* Visual Legend */}
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[8.5px] font-mono text-zinc-500 pt-1.5 border-t border-white/[0.03]">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span>
                Running
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 inline-block"></span>
                Idle
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block"></span>
                Exited
              </span>
              <span className="flex items-center gap-1 text-amber-500">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse inline-block"></span>
                Alert Needed
              </span>
            </div>
          </div>
        )}

        {/* Floating popover/tooltip element when cell hovered, rendering rich diagnostics & last stdout snippet inside! */}
        {(() => {
          if (!hoveredTermId) return null;
          const term = terminals.find(t => t.id === hoveredTermId);
          if (!term) return null;

          const isAlertActive = pendingCommands.some(cmd => cmd.terminalId === term.id);
          const currentOutputSnippetLines = term.output ? term.output.trim().split("\n").slice(-4) : [];
          
          let statusLabel = "Idle & Listening";
          let statusBadgeClass = "bg-yellow-500/10 text-yellow-400 border border-yellow-500/10";
          if (isAlertActive) {
            statusLabel = "AWAITING APPROVAL";
            statusBadgeClass = "bg-amber-500 text-black font-extrabold shadow-[0_0_8px_#f59e0b]";
          } else if (term.status === "Running") {
            statusLabel = "ACTIVE EXECUTING";
            statusBadgeClass = "bg-emerald-500/10 text-emerald-400 border border-emerald-500/10";
          } else if (term.status === "Exited") {
            statusLabel = "TERMINATED";
            statusBadgeClass = "bg-red-500/10 text-red-400 border border-red-500/10";
          }

          return (
            <div className="absolute top-[102%] left-0 right-0 z-50 bg-[#0d0d0d] border border-cyan-500/30 shadow-[0_4px_24px_rgba(0,0,0,0.85)] rounded-lg p-3.5 text-left font-mono text-[10.5px] leading-relaxed animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="absolute top-3 right-3 flex gap-1.5">
                <span className={`text-[8.5px] uppercase tracking-wider px-1.5 py-0.5 rounded font-black ${statusBadgeClass}`}>
                  {statusLabel}
                </span>
                <button 
                  onClick={() => setHoveredTermId(null)}
                  className="text-zinc-500 hover:text-white px-1 font-sans font-bold hover:bg-white/5 rounded text-[11px] leading-none"
                >
                  ✕
                </button>
              </div>

              {/* Title & Preset Identifier */}
              <div className="mb-2">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${isAlertActive ? 'bg-amber-500' : term.status === 'Running' ? 'bg-emerald-500' : 'bg-yellow-500'}`}></span>
                  NODE: {term.id.toUpperCase()}
                </h4>
                <p className="text-[9px] text-zinc-500 -mt-0.5 uppercase tracking-wide">
                  Type: {term.tool_preset || "Custom Shell Engine"} • Mode: {term.permissions_mode || "Human-in-the-Loop"}
                </p>
              </div>

              {/* Specs Bento List */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[9.5px] text-zinc-400 bg-black/40 border border-white/[0.03] p-2 rounded-md mb-2.5">
                <div>
                  <span className="text-zinc-650 uppercase text-[8.5px] block">Active Cwd</span>
                  <span className="text-zinc-300 truncate block whitespace-nowrap" title={term.cwd}>{term.cwd}</span>
                </div>
                <div>
                  <span className="text-zinc-650 uppercase text-[8.5px] block">Context memory</span>
                  <span className="text-cyan-400 block font-bold">
                    {term.context_size < 1000 ? `${term.context_size} chars` : `${(term.context_size / 1000).toFixed(1)}k chars`}
                  </span>
                </div>
                <div className="col-span-2">
                  <span className="text-zinc-650 uppercase text-[8.5px] block">Active process thread</span>
                  <span className="text-zinc-300 truncate block whitespace-nowrap" title={term.command}>$ {term.command || "idle waiting"}</span>
                </div>
              </div>

              {/* last stdout console output panel widget */}
              <div className="bg-black/80 rounded border border-white/5 p-2 font-mono text-[9px] leading-relaxed text-zinc-500">
                <div className="text-[8.5px] uppercase tracking-wider text-cyan-500/60 font-semibold mb-1 flex items-center justify-between border-b border-white/[0.04] pb-1 select-none">
                  <span>🛰️ Live Stdout Capture</span>
                  <span className="opacity-40">{term.output?.length || 0} bytes</span>
                </div>
                <div className="space-y-0.5 selection:bg-cyan-500/25 selection:text-white overflow-hidden max-h-24">
                  {currentOutputSnippetLines.length > 0 ? (
                    currentOutputSnippetLines.map((line, idx) => (
                      <div key={idx} className="truncate text-emerald-400/80 leading-normal block whitespace-pre">
                        {line || " "}
                      </div>
                    ))
                  ) : (
                    <div className="italic text-zinc-600 py-1 font-mono">No live stream log. Waiting on execute triggers...</div>
                  )}
                </div>
              </div>

              {/* Action notice helper */}
              <div className="mt-2 text-right">
                <span className="text-[8.5px] text-zinc-650 italic">
                  Tap to lock popup • Hover another tile to swap inspect
                </span>
              </div>
            </div>
          );
        })()}
      </div>
    );
  };

  const renderPromptSynchronizerPanel = () => {
    return (
      <div className="flex-1 flex flex-col bg-[#060606] border border-white/5 rounded-lg overflow-hidden h-full">
        {/* Header toolbar */}
        <div className="p-3 bg-white/[0.02] border-b border-white/5 flex items-center justify-between shrink-0 select-none">
          <div className="flex items-center gap-2">
            <CheckSquare className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-mono font-bold tracking-wider text-white uppercase">Shared Prompt Buffer</h3>
          </div>
          <div className="flex items-center gap-1.5 bg-black/60 p-1 rounded border border-white/10">
            <button
              onClick={() => setPromptBufferEditMode("preview")}
              className={`px-2 py-0.5 text-[9px] font-mono rounded transition-colors uppercase ${promptBufferEditMode === "preview" ? "bg-cyan-500/10 text-cyan-400 font-bold" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              Preview
            </button>
            <button
              onClick={() => setPromptBufferEditMode("edit")}
              className={`px-2 py-0.5 text-[9px] font-mono rounded transition-colors uppercase ${promptBufferEditMode === "edit" ? "bg-cyan-500/10 text-cyan-400 font-bold" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              Edit
            </button>
          </div>
        </div>

        {/* Content Viewport */}
        <div className="flex-1 p-4 overflow-y-auto font-mono text-xs text-zinc-300 min-h-[300px]">
          {promptBufferEditMode === "edit" ? (
            <textarea
              value={promptBuffer}
              onChange={(e) => handlePromptBufferChange(e.target.value)}
              onFocus={() => setIsBufferFocused(true)}
              onBlur={() => setIsBufferFocused(false)}
              className="w-full h-full min-h-[280px] bg-black text-xs text-zinc-200 p-3 rounded border border-white/10 focus:outline-none focus:border-cyan-500 font-mono resize-none leading-relaxed overflow-y-auto selection:bg-cyan-500/30"
              placeholder="Keep track of high-level specs as a list here. Operator typing & Live Voice Agent transcripts update this buffer in real-time..."
            />
          ) : (
            <div className="prose prose-invert max-w-none text-zinc-300">
              {promptBuffer ? (
                <MiniMarkdown text={promptBuffer} />
              ) : (
                <p className="text-[10px] text-zinc-600 font-mono italic">No prompt notes captured. Switch to Edit or speak into the microphone to write specifications...</p>
              )}
            </div>
          )}
        </div>

        {/* Quick Toolbar macros */}
        <div className="p-3 bg-[#0d0d0d] border-t border-white/5 flex flex-wrap gap-2 items-center justify-between shrink-0 select-none">
          <div className="flex gap-2">
            <button
              onClick={() => handlePromptBufferChange(promptBuffer + "\n- [ ] ")}
              className="px-2 py-1 text-[9px] font-mono uppercase bg-white/5 border border-white/10 text-zinc-300 hover:text-white rounded"
            >
              + Task
            </button>
            <button
              onClick={() => handlePromptBufferChange(
                `# Requirements Specification Checklist\n\n- [ ] **Architecture**: Build production containers.\n- [ ] **Database Snapshots**: Configure sqlite snapshots in .env file.`
              )}
              className="px-2 py-1 text-[9px] font-mono uppercase bg-white/5 border border-white/10 text-zinc-300 hover:text-white rounded"
            >
              Template
            </button>
          </div>

          <div className="flex gap-2">
            {activeTerminalId && (
              <button
                onClick={handleSyncNoteToActiveNode}
                className="px-2.5 py-1 text-[9px] font-mono uppercase bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/30 rounded font-bold flex items-center gap-1"
                title="Pushes prompt buffer specs directly to node chronicle notes registry"
              >
                Sync Note
              </button>
            )}
            <button
              onClick={() => handlePromptBufferChange("")}
              className="px-2 py-1 text-[9px] font-mono uppercase bg-red-500/5 hover:bg-red-500/10 border border-red-500/10 hover:border-red-500/20 text-red-400 rounded"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen w-full bg-[#050505] text-[#e0e0e0] font-sans overflow-hidden border-t-4 border-[#121212]">
      {showProjectModal && (
        <ProjectDialog 
          onClose={() => {
            setShowProjectModal(false);
            setEditingProject(null);
          }}
          onSave={handleSaveProject}
          project={editingProject}
        />
      )}

      {showCreateModal && (
        <CreateTerminalDialog 
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateTerminal}
        />
      )}
      
      {showSettingsModal && (
        <SettingsDialog 
          onClose={() => setShowSettingsModal(false)}
          settings={settings}
          onSave={handleSaveSettings}
          terminals={terminals}
          isMockMode={isMockMode}
          onToggleMockMode={generateMockData}
        />
      )}
      
      {pendingCommands.map((pending) => (
        <ApprovalDialog 
          key={pending.messageId}
          messageId={pending.messageId}
          terminalId={pending.terminalId}
          cmd={pending.cmd}
          rationale={pending.rationale}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      ))}
      
      <GenericPromptModal />

      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none">
        {autoApprovedNotification && (
          <div className="bg-[#111] border border-green-500/30 text-green-400 p-4 rounded-lg shadow-xl max-w-sm flex flex-col gap-1 pointer-events-auto animate-in slide-in-from-top-4 duration-300">
            <span className="text-[10px] font-mono uppercase tracking-widest text-green-500">▶ Auto-Approved & Executed</span>
            <span className="text-[11px] font-mono text-white/90">Node ID: {autoApprovedNotification.terminalId}</span>
            <pre className="text-[10px] bg-black/40 p-2 rounded text-[#b4b4b4] border border-white/5 whitespace-pre-wrap font-mono mt-1 max-h-24 overflow-y-auto">{autoApprovedNotification.cmd}</pre>
          </div>
        )}
        {blockedNotification && (
          <div className="bg-[#111] border border-red-500/30 text-red-400 p-4 rounded-lg shadow-xl max-w-sm flex flex-col gap-1 pointer-events-auto animate-in slide-in-from-top-4 duration-300">
            <span className="text-[10px] font-mono uppercase tracking-widest text-red-500">⛔ Access Blocked (Read-Only)</span>
            <span className="text-[11px] font-mono text-white/90">Node ID: {blockedNotification.terminalId}</span>
            <span className="text-[10px] text-zinc-400">Policy: {blockedNotification.reason}</span>
            <pre className="text-[10px] bg-black/40 p-2 rounded text-zinc-500 border border-white/5 whitespace-pre-wrap font-mono mt-1 max-h-24 overflow-y-auto">{blockedNotification.cmd}</pre>
          </div>
        )}
        {wsErrorNotification && (
          <div className="bg-[#111] border border-red-500/50 text-red-500 p-4 rounded-lg shadow-xl max-w-sm flex flex-col gap-1 pointer-events-auto animate-in slide-in-from-top-4 duration-300">
            <span className="text-[10px] font-mono uppercase tracking-widest text-red-500 font-bold">⛔ Connection / AI Error</span>
            <span className="text-[11px] font-mono text-white/90">{wsErrorNotification.message}</span>
          </div>
        )}
      </div>

      {/* Header */}
      <header className="flex flex-col lg:flex-row items-start lg:items-center justify-between px-4 lg:px-6 py-4 border-b border-white/5 bg-black/40 backdrop-blur-md gap-4 shrink-0">
        <div className="flex items-center gap-4 shrink-0">
          <div className={`w-3 h-3 rounded-full ${
            isLive 
              ? (isReconnecting ? 'bg-amber-500 animate-pulse' : 'bg-cyan-400 animate-pulse') 
              : 'bg-zinc-600'
          }`}></div>
          <h1 className="font-serif italic text-lg lg:text-xl tracking-wide text-white flex items-center gap-2">
            Orbital Harness <span className="text-[10px] lg:text-xs font-mono font-normal opacity-40">v1.0.4-live</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-4 lg:gap-6 w-full lg:w-auto overflow-x-auto pb-2 lg:pb-0 shrink-0 hide-scrollbar">
          <div className="flex flex-col">
            <span className="text-[10px] font-mono uppercase opacity-40 tracking-widest">Global Voice Agent Permission</span>
            <select
              value={globalPermissionsMode}
              onChange={(e) => handleUpdateGlobalPermissions(e.target.value)}
              className="mt-1 bg-black text-xs text-zinc-300 border border-white/10 rounded px-2 py-1 focus:outline-none focus:border-cyan-500 cursor-pointer font-mono"
            >
              <option value="Inherit">Inherit From Active Node</option>
              <option value="Full Auto">Full Auto (Auto-Approve)</option>
              <option value="Human-in-the-Loop">Human-in-the-Loop (Always Ask)</option>
              <option value="Read-Only">Read-Only (Lock Inputs)</option>
            </select>
          </div>
          <div className="w-px h-8 bg-white/10"></div>
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-mono uppercase opacity-40 tracking-widest">Controls</span>
            <div className="flex items-center gap-2 mt-1">
              {!isLive ? (
                <button 
                  onClick={startLive}
                  className="text-xs font-mono uppercase text-cyan-400 opacity-80 hover:opacity-100 hover:text-cyan-300 transition-colors focus:outline-none"
                >
                  Connect
                </button>
              ) : (
                <div className="flex items-center gap-3">
                   <button 
                    onClick={() => setIsMicMuted(!isMicMuted)}
                    className={`text-xs font-mono uppercase transition-colors focus:outline-none ${isMicMuted ? "text-amber-400" : "text-cyan-400 opacity-80"}`}
                  >
                    {isMicMuted ? "Unmute" : "Mute"}
                  </button>
                  <button 
                    onClick={stopLive}
                    className="text-xs font-mono uppercase text-red-400 opacity-80 hover:opacity-100 transition-colors focus:outline-none"
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="w-px h-8 bg-white/10"></div>
          <div className="flex flex-col">
            <span className="text-[10px] font-mono uppercase opacity-40 tracking-widest">Gemini Voice</span>
            <span className={`text-xs font-mono ${
              isLive 
                ? (isReconnecting 
                    ? 'text-amber-500 animate-pulse' 
                    : (isMicMuted ? 'text-amber-400' : 'text-green-400')) 
                : 'text-zinc-600'
            }`}>
              {isLive 
                ? (isReconnecting 
                    ? 'RECONNECTING...' 
                    : (isMicMuted ? 'MUTED' : 'LISTENING...')) 
                : 'OFFLINE'}
            </span>
          </div>
          <div className="w-px h-8 bg-white/10"></div>
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-mono uppercase opacity-40 tracking-widest flex items-center gap-1 leading-none select-none">
              <Database className="w-2.5 h-2.5 text-cyan-400" />
              Rigorous Context Memory
            </span>
            <div className="flex items-center gap-2 mt-1 leading-none select-none">
              <span className={`text-xs font-mono font-black ${
                totalContextSize > 80000 ? 'text-red-400 animate-pulse font-extrabold' : totalContextSize > 40000 ? 'text-amber-400 font-bold' : 'text-cyan-400'
              }`}>
                {totalContextSize < 1000 ? `${totalContextSize} Chars` : `${(totalContextSize / 1000).toFixed(1)}k chars`}
              </span>
              <span className="text-[9px] font-mono opacity-40">
                (~{totalTokensEstimated < 1000 ? `${totalTokensEstimated}` : `${(totalTokensEstimated / 1000).toFixed(1)}k`} tokens)
              </span>
            </div>
            {/* Context overload bar */}
            <div className="w-24 h-1 bg-zinc-950 rounded-full overflow-hidden mt-1.5" title="Aggregated Sandbox Overload Threshold Indicator">
              <div 
                className={`h-full transition-all duration-500 ${
                  totalContextSize > 80000 ? 'bg-red-500 shadow-[0_0_8px_#ef4444]' : totalContextSize > 40000 ? 'bg-amber-500' : 'bg-cyan-500'
                }`}
                style={{ width: `${Math.min((totalContextSize / 100000) * 100, 100)}%` }}
              ></div>
            </div>
          </div>
          <div className="w-px h-8 bg-white/10"></div>
          <button 
            onClick={() => setShowTranscriptPanel(!showTranscriptPanel)}
            className={`p-1.5 px-3 hover:bg-cyan-500/10 border transition-all rounded hover:text-cyan-400 focus:outline-none flex items-center justify-center cursor-pointer gap-1.5 shrink-0 ${
              showTranscriptPanel 
                ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-400" 
                : "bg-white/5 border-white/10 text-zinc-400"
            }`}
            title="Toggle Operator Conversation Transcript Log"
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${transcript.length > 0 ? "bg-cyan-400" : "bg-zinc-400"}`}></span>
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${transcript.length > 0 ? "bg-cyan-500" : "bg-zinc-600"}`}></span>
            </span>
            <span className="text-[10px] font-mono uppercase tracking-[0.1em] font-bold">Transcripts ({transcript.length})</span>
          </button>
          <div className="w-px h-8 bg-white/10"></div>
          <button 
            onClick={() => setShowSettingsModal(true)}
            className="p-1.5 px-3 bg-white/5 hover:bg-cyan-500/10 border border-white/10 hover:border-cyan-500/30 transition-all rounded text-zinc-400 hover:text-cyan-400 focus:outline-none flex items-center justify-center cursor-pointer gap-1.5 shrink-0"
            title="System Parameters Settings"
          >
            <Settings className="w-3.5 h-3.5 animate-[spin_10s_linear_infinite]" />
            <span className="text-[10px] font-mono uppercase tracking-[0.1em] font-bold">Config</span>
          </button>
        </div>
      </header>

      {/* Mobile Terminals Quick Swiper Bar */}
      <div className="lg:hidden flex items-center gap-2 overflow-x-auto px-4 py-2 border-b border-white/5 bg-black/80 scrollbar-none shrink-0 select-none">
        <button
          onClick={() => {
            setActiveTerminalId(null);
            setMobileActiveView("terminal");
          }}
          className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[10px] font-mono border transition-all ${
            activeTerminalId === null
              ? "bg-cyan-500/15 border-cyan-500 text-cyan-400 font-bold"
              : "bg-white/5 border-white/10 text-zinc-500"
          }`}
        >
          GRID VIEW
        </button>
        {terminals.map((term) => {
          const isAlertActive = pendingCommands.some(cmd => cmd.terminalId === term.id);
          const isActive = activeTerminalId === term.id;
          let colorClass = "border-zinc-850 text-zinc-500 bg-black/40";
          if (isAlertActive) {
            colorClass = "border-amber-500 text-amber-400 bg-amber-500/15 animate-pulse font-bold";
          } else if (isActive) {
            colorClass = "border-cyan-500 text-cyan-400 bg-cyan-500/10 font-bold";
          } else if (term.status === "Running") {
            colorClass = "border-green-500/50 text-green-400 bg-green-500/5";
          } else if (term.status === "Idle") {
            colorClass = "border-yellow-500/50 text-yellow-500 bg-yellow-500/5";
          }
          return (
            <button
              key={term.id}
              onClick={() => {
                setActiveTerminalId(term.id);
                setMobileActiveView("terminal");
              }}
              className={`flex-shrink-0 px-3.5 py-1.5 rounded-full text-[10px] font-mono border flex items-center gap-1.5 transition-all ${colorClass}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${
                isAlertActive ? "bg-amber-500 animate-ping2" :
                term.status === "Running" ? "bg-green-500" : "bg-yellow-500"
              }`}></span>
              {(term.id).toUpperCase()}
            </button>
          )
        })}
      </div>

      {/* Main Content */}
      <main className="flex flex-col lg:flex-row flex-1 overflow-hidden">
        {/* Sidebar */}
        <nav className={`w-full lg:w-72 border-b lg:border-b-0 lg:border-r border-white/5 bg-black/40 flex-col h-full lg:h-auto shrink-0 overflow-y-auto ${mobileActiveView === "menu" ? "flex" : "hidden lg:flex"}`}>
          <div className="p-4 flex-1">
            <button
              onClick={() => setActiveTerminalId(null)}
              className={`w-full flex items-center justify-between px-3 py-2.5 mb-4 rounded border text-[11px] font-mono tracking-wider transition-all ${
                activeTerminalId === null
                  ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30"
                  : "bg-transparent text-zinc-400 border-white/5 hover:border-white/10"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${activeTerminalId === null ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-500'}`}></span>
                GRID SUMMARY VIEW
              </span>
              <span className="text-[9px] opacity-40 px-1 bg-white/5 rounded">ALL</span>
            </button>

            <div className="mb-5 flex items-center justify-between border border-white/5 bg-black/30 px-3 py-2 rounded">
              <label className="text-[10px] font-mono uppercase opacity-60">Filter Panes:</label>
              <select
                value={termFilter}
                onChange={(e) => setTermFilter(e.target.value as "All" | "Running" | "Idle")}
                className="bg-[#111] text-[10px] font-mono text-zinc-300 border border-white/10 rounded px-1.5 py-1 focus:outline-none focus:border-cyan-500 cursor-pointer"
              >
                <option value="All">All Panes</option>
                <option value="Running">Running</option>
                <option value="Idle">Idle</option>
              </select>
            </div>

            <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-1 select-none">
              <h2 className="text-[10px] font-mono uppercase opacity-40 tracking-[0.2em]">Workspace Contexts</h2>
              <button
                onClick={handleCreateProject}
                className="text-[9px] font-mono uppercase text-cyan-400 opacity-60 hover:opacity-100 transition-opacity flex items-center gap-0.5 focus:outline-none"
                title="Create New Project Context Space"
              >
                <Plus className="w-2.5 h-2.5" /> NEW
              </button>
            </div>

            <div className="space-y-4">
              {projectList.map((project) => (
                <div key={project.id} className="space-y-1">
                  <div className="flex items-center justify-between group">
                    <div 
                      onClick={() => handleSwitchProject(project.id)}
                      className={`text-xs font-mono font-bold px-2 py-1 cursor-pointer transition-colors rounded ${activeProjectId === project.id ? 'text-cyan-400 bg-white/5 border border-white/5' : 'text-zinc-500 hover:text-zinc-400 hover:bg-white/[0.02]'}`}
                    >
                      {(project.name || project.id).toUpperCase()}
                    </div>
                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                       <button onClick={() => handleEditProject(project)} className="text-[9px] uppercase hover:text-cyan-400 px-1 hover:bg-white/5 rounded" title="Edit workspace details">Edit</button>
                       <button onClick={() => handleRenameProject(project.id, project.name)} className="text-[9px] uppercase hover:text-cyan-450 text-zinc-500 hover:bg-white/5 px-1 rounded animate-pulse" title="Quick rename space">Rename</button>
                       <button onClick={() => handleAddProjectNote(project.id)} className="text-[9px] uppercase hover:text-cyan-450 text-zinc-400 hover:bg-white/5 px-1 rounded" title="Append note">Note</button>
                       {projectList.length > 1 && (
                         <button onClick={() => handleDeleteProjectPrompt(project.id)} className="text-[9px] uppercase hover:text-red-400 text-zinc-650 px-1 hover:bg-red-500/10 rounded" title="Prune Project Memory">Prune</button>
                       )}
                    </div>
                  </div>
                  {project.notes && project.notes.length > 0 && activeProjectId === project.id && (
                    <div className="px-3 py-1 space-y-1 my-2 border-l-2 border-cyan-400/20 ml-2">
                       {project.notes.map((note, idx) => (
                          <div key={idx} className="text-[10px] opacity-60 text-cyan-100 flex items-start gap-1">
                            <span className="opacity-40">-</span><span>{note}</span>
                          </div>
                       ))}
                    </div>
                  )}

                  {activeProjectId === project.id && (
                    <div className="pl-3 ml-2 border-l-2 border-white/5 space-y-2 mt-1.5 py-1 select-none">
                      {project.summary && (
                        <p className="text-[10px] text-zinc-500 leading-relaxed font-mono italic max-w-[210px] break-all">
                          {project.summary}
                        </p>
                      )}
                      {project.keyTerms && project.keyTerms.length > 0 && (
                        <div className="flex flex-wrap gap-1 max-w-[210px]">
                          {project.keyTerms.map((term, idx) => (
                            <span key={idx} className="bg-cyan-500/5 text-cyan-400/80 border border-cyan-500/10 px-1 py-0.5 rounded text-[8px] font-mono leading-none">
                              {term}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  
                  {activeProjectId === project.id && project.panes && (
                    <div className="space-y-1 pl-2 mt-2">
                      <AnimatePresence initial={false}>
                        {Object.values(project.panes).filter(pane => {
                          if (termFilter === "All") return true;
                          const term = terminals.find(t => t.id === pane.pane_id);
                          const status = term?.status || (pane.alive ? (pane.is_busy ? "Running" : "Idle") : "Exited");
                          return status === termFilter;
                        }).map((pane) => {
                          const isActive = activeTerminalId === pane.pane_id;
                          const term = terminals.find(t => t.id === pane.pane_id);
                          const isAlertActive = pendingCommands.some(cmd => cmd.terminalId === pane.pane_id);
                          let statusColor = "bg-zinc-600";
                          
                          if (isAlertActive) {
                            statusColor = "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.9)] animate-pulse";
                          } else if (term) {
                            if (term.status === "Running") {
                              statusColor = "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse";
                            } else if (term.status === "Idle") {
                              statusColor = `bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.6)] ${recentlyIdled[pane.pane_id] ? "heartbeat-animation" : ""}`;
                            } else if (term.status === "Exited") {
                              statusColor = "bg-red-500";
                            }
                          } else {
                            if (pane.alive && pane.is_busy) statusColor = "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse";
                            else if (pane.alive && !pane.is_busy) statusColor = `bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.6)] ${recentlyIdled[pane.pane_id] ? "heartbeat-animation" : ""}`;
                            else statusColor = "bg-red-500";
                          }
                          
                          return (
                            <motion.div
                              key={pane.pane_id}
                              initial={{ opacity: 0, height: 0, scale: 0.95 }}
                              animate={{ opacity: 1, height: "auto", scale: 1 }}
                              exit={{ opacity: 0, height: 0, scale: 0.95 }}
                              transition={{ duration: 0.2 }}
                              className="flex flex-col group overflow-hidden"
                            >
                              <div 
                                onClick={() => { setActiveTerminalId(pane.pane_id); }}
                                className={`group cursor-pointer p-2 rounded transition-colors flex items-center justify-between ${isAlertActive ? 'bg-amber-500/10 border border-amber-500/30' : isActive ? 'bg-white/5 border border-white/10' : 'border border-transparent hover:bg-white/5'}`}
                              >
                              <div className="flex flex-col overflow-hidden min-w-0 pr-2">
                                <span className={`text-xs font-mono truncate flex items-center gap-1.5 ${isAlertActive ? 'text-amber-400 font-bold' : isActive ? 'font-bold text-cyan-400' : 'opacity-80'}`}>
                                  {pane.name}
                                  {isAlertActive && (
                                    <span className="text-[7px] bg-amber-500 text-black px-1 rounded font-sans font-black uppercase animate-bounce leading-none py-0.5">
                                      ▲ ALERT
                                    </span>
                                  )}
                                </span>
                                {term && <span className="text-[9px] opacity-30 font-mono truncate">{term.cwd}</span>}
                              </div>
                              <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full transition-all duration-1000 ${statusColor}`} title={isAlertActive ? "Status: Alert (Approval Required)" : `Status: ${pane.last_known_state}`}></span>
                            </div>
                            {isActive && (
                              <div className="flex px-3 mt-1 pb-1 gap-2 border-b border-white/5">
                                 <button onClick={() => handleRenamePane(project.id, pane.pane_id, pane.name)} className="text-[9px] uppercase hover:text-cyan-400 opacity-60">Rename</button>
                                 <button onClick={() => handleAddPaneNote(project.id, pane.pane_id)} className="text-[9px] uppercase hover:text-cyan-400 opacity-60">Note</button>
                              </div>
                            )}
                            {isActive && pane.notes && pane.notes.length > 0 && (
                              <div className="ml-4 pl-2 py-1 mt-1 border-l border-white/5 text-[9px] font-sans text-amber-200/60 leading-relaxed max-w-full italic overflow-hidden break-words">
                                 {pane.notes.map((n, idx) => <div key={idx}>• {n}</div>)}
                              </div>
                            )}
                          </motion.div>
                        );
                      })}
                      </AnimatePresence>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="p-4 border-t border-white/5 space-y-3">
            <button 
              onClick={() => setShowCreateModal(true)}
              className="w-full text-center py-2 bg-transparent border border-dashed border-white/20 hover:border-cyan-500/50 hover:text-cyan-400 text-white/60 text-[10px] uppercase tracking-widest transition-colors focus:outline-none"
            >
              + Create Node
            </button>
            <div className="w-full text-center text-zinc-600 text-[10px] uppercase tracking-widest">
              {terminals.length} Nodes Online
            </div>
          </div>
        </nav>

        {/* Center Content */}
        <section className={`flex-1 flex flex-col bg-[#0b0b0b] min-w-0 ${mobileActiveView === "terminal" ? "flex" : "hidden lg:flex"}`}>
          {activeTerminalId && activeTerminal ? (
            /* Terminal View */
            <div className="flex flex-1 flex-row overflow-hidden">
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 bg-white/[0.02] border-b border-white/5 shadow-sm">
                  <div className="flex gap-2 items-center overflow-hidden">
                    <span className="text-[10px] font-mono px-2 py-0.5 bg-cyan-400/20 text-cyan-400 rounded shrink-0">
                      {activeProjectMeta?.name?.toUpperCase() || "NODE"}: {activePaneMeta?.name || activeTerminal.id}
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 opacity-40 truncate" title={activeTerminal.command}>
                      $ {activeTerminal.command}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] font-mono opacity-40 truncate" title={activeTerminal.cwd}>
                      {activeTerminal.cwd}
                    </span>
                    <button
                      onClick={() => {
                        const nextState = !showHistoryPanel;
                        setShowHistoryPanel(nextState);
                        if (nextState) {
                          fetchActiveTerminalHistory();
                        }
                      }}
                      className={`p-1.5 hover:bg-white/5 rounded transition-colors ${showHistoryPanel ? "text-cyan-400 bg-white/5" : "text-zinc-400 hover:text-white"}`}
                      title="Toggle Command History Pane"
                    >
                      <History className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleRestartTerminal(activeTerminal.id)}
                      className="p-1.5 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors"
                      title="Restart Node Engine"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="flex-1 p-2 sm:p-4 lg:p-6 font-mono text-xs overflow-hidden leading-relaxed bg-[#060606] relative">
                  <TerminalView key={activeTerminal.id} output={activeTerminal.output} />
                </div>
              </div>

              {/* Collapsible History Sidebar Panel */}
              {showHistoryPanel && (
                <aside className="w-80 border-l border-white/5 bg-[#090909] flex flex-col shrink-0 overflow-hidden">
                  <div className="p-4 border-b border-white/5 flex items-center justify-between select-none">
                    <div className="flex items-center gap-2">
                      <History className="w-4 h-4 text-cyan-400 shrink-0" />
                      <span className="text-[11px] font-mono tracking-wider text-white uppercase font-bold">Local Pane History</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => fetchActiveTerminalHistory()}
                        className="p-1 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors"
                        title="Reload History"
                      >
                        <RefreshCw className="w-3 h-3" />
                      </button>
                      <button 
                        onClick={clearActiveTerminalHistory} 
                        className="text-[9px] uppercase font-mono px-2 py-0.5 bg-white/5 hover:bg-red-500/10 hover:text-red-400 text-zinc-500 rounded border border-transparent hover:border-red-500/20 cursor-pointer focus:outline-none flex items-center gap-1"
                        title="Clear command history"
                      >
                        <Trash2 className="w-2.5 h-2.5" /> Clear
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 flex flex-col overflow-hidden">
                    {/* Commands List Area */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-2.5 scrollbar-thin border-b border-white/5">
                      {historyList.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center p-4">
                          <History className="w-6 h-6 text-zinc-700 mb-2" />
                          <p className="text-[10px] font-mono text-zinc-500 leading-relaxed max-w-[170px] italic">
                            No commands recorded in .janus_history.json
                          </p>
                        </div>
                      ) : (
                        [...historyList].reverse().map((entry, idx) => (
                          <div 
                            key={idx}
                            onClick={() => setSelectedHistoryEntry(selectedHistoryEntry?.command === entry.command && selectedHistoryEntry?.timestamp === entry.timestamp ? null : entry)}
                            className={`group border rounded p-2.5 font-mono cursor-pointer transition-all duration-200 text-left ${
                              selectedHistoryEntry?.command === entry.command && selectedHistoryEntry?.timestamp === entry.timestamp
                                ? "border-cyan-500/40 bg-cyan-950/[0.08]" 
                                : "border-white/5 bg-[#121212] hover:border-white/10"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-[9px] text-zinc-500 flex items-center gap-1 shrink-0">
                                <Clock className="w-3 h-3 opacity-60" />
                                {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard.writeText(entry.command);
                                }}
                                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-opacity duration-200"
                                title="Copy command"
                              >
                                <Clipboard className="w-3 h-3" />
                              </button>
                            </div>
                            
                            <div className="text-[11px] text-zinc-200 break-all font-semibold mt-1 bg-black/40 px-2 py-1.5 rounded border border-white/5 select-text">
                              $ {entry.command}
                            </div>

                            {(entry as any).finalResponse && (
                              <div className="mt-2 text-[10px] text-zinc-400 font-mono bg-cyan-950/10 border border-cyan-500/15 p-2 rounded flex gap-1.5 items-start">
                                <span className="text-cyan-400 font-bold shrink-0">◇ Outcome Briefing:</span>
                                <span className="leading-relaxed select-text">{(entry as any).finalResponse}</span>
                              </div>
                            )}

                            {entry.output && (
                              <div className="mt-2 flex items-center justify-between text-[8px] text-cyan-500/80 uppercase tracking-widest leading-none">
                                <span>{selectedHistoryEntry?.command === entry.command && selectedHistoryEntry?.timestamp === entry.timestamp ? "▲ Hide stdout" : "▼ Read stdout context"}</span>
                                <span className="opacity-40">{entry.output.length} Chars</span>
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>

                    {/* Selected stdout reading pane */}
                    {selectedHistoryEntry && (
                      <div className="h-1/2 flex flex-col bg-black/60 border-t border-white/5 overflow-hidden shrink-0">
                        <div className="px-3 py-1.5 border-b border-white/5 bg-[#141414] flex items-center justify-between">
                          <span className="text-[9px] font-mono text-cyan-400 font-bold uppercase tracking-widest">Stdout capture context</span>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(selectedHistoryEntry.output);
                            }}
                            className="p-1 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors"
                            title="Copy captured context"
                          >
                            <Clipboard className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="flex-1 overflow-auto p-3 font-mono text-[10px] text-zinc-400 leading-normal scrollbar-thin select-text whitespace-pre-wrap selection:bg-cyan-500/30 selection:text-white">
                          {selectedHistoryEntry.output || "No output captured for this command."}
                        </div>
                      </div>
                    )}
                  </div>
                </aside>
              )}
            </div>
          ) : (
            /* Dashboard High-Level View */
            <div className="flex-1 flex flex-col overflow-y-auto p-4 lg:p-8">
              <div className="mb-8 select-none flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-white/5 pb-6">
                <div>
                  <h1 className="text-xl font-mono text-white tracking-widest uppercase mb-1 flex items-center gap-2">
                    <Cpu className="w-5 h-5 text-cyan-400 shrink-0" />
                    Project Terminal Workspace
                  </h1>
                  <p className="text-xs text-zinc-500 font-mono">
                    Active terminal sessions tracking Claude Code, Codex, and Antigravity orchestrator engines.
                  </p>
                </div>
                
                {/* Responsive Touch-friendly View Switcher */}
                <div className="flex items-center gap-1 bg-black/80 p-1.5 rounded-lg border border-white/10 shrink-0 select-none self-start md:self-auto shadow-inner">
                  <button
                    onClick={() => setGridDisplayMode("detailed")}
                    className={`px-3 py-1.5 text-[10px] font-mono rounded-md transition-all uppercase font-bold flex items-center gap-1.5 ${
                      gridDisplayMode === "detailed"
                        ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 font-black shadow-sm"
                        : "text-zinc-500 hover:text-zinc-300 border border-transparent"
                    }`}
                  >
                    <Laptop className="w-3.5 h-3.5" />
                    Detailed
                  </button>
                  <button
                    onClick={() => setGridDisplayMode("compact")}
                    className={`px-3 py-1.5 text-[10px] font-mono rounded-md transition-all uppercase font-bold flex items-center gap-1.5 ${
                      gridDisplayMode === "compact"
                        ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 font-black shadow-sm"
                        : "text-zinc-500 hover:text-zinc-300 border border-transparent"
                    }`}
                  >
                    <Smartphone className="w-3.5 h-3.5" />
                    Compact List
                  </button>
                </div>
              </div>

              {(() => {
                const filteredPanes = activeProject && activeProject.panes ? Object.values(activeProject.panes).filter(pane => {
                  if (termFilter === "All") return true;
                  const term = terminals.find(t => t.id === pane.pane_id);
                  const status = term?.status || (pane.alive ? (pane.is_busy ? "Running" : "Idle") : "Exited");
                  return status === termFilter;
                }) : [];

                return filteredPanes.length > 0 ? (
                  <motion.div layout className={gridDisplayMode === "compact" ? "flex flex-col gap-3" : "grid grid-cols-1 xl:grid-cols-2 gap-6"}>
                    <AnimatePresence mode="popLayout">
                    {filteredPanes.map((pane) => {
                      const term = terminals.find(t => t.id === pane.pane_id);
                    const status = term?.status || (pane.alive ? (pane.is_busy ? "Running" : "Idle") : "Exited");
                    const contextSize = term?.context_size !== undefined ? term.context_size : (pane.context_size || 0);

                    // Badge colors
                    let primaryColorClass = "border-zinc-800 text-zinc-400";
                    let bgHover = "hover:border-zinc-700";
                    let presetLabel = pane.tool_preset || "Custom";
                    
                    if (pane.tool_preset === "Claude Code") {
                      primaryColorClass = "border-purple-500/20 text-purple-400 bg-purple-500/[0.02]";
                      bgHover = "hover:border-purple-500/50";
                    } else if (pane.tool_preset === "Codex") {
                      primaryColorClass = "border-orange-500/20 text-orange-400 bg-orange-500/[0.02]";
                      bgHover = "hover:border-orange-500/50";
                    } else if (pane.tool_preset === "Antigravity") {
                      primaryColorClass = "border-cyan-500/20 text-cyan-400 bg-cyan-500/[0.02]";
                      bgHover = "hover:border-cyan-500/50";
                    }

                    const isAlertActive = pendingCommands.some(cmd => cmd.terminalId === pane.pane_id);
                    const finalStatus = isAlertActive ? "Alert (Awaiting Approval)" : status;

                    // Context memory warnings/colors
                    const contextPercent = Math.min((contextSize / 20000) * 100, 100);
                    const contextColor = contextSize > 15000 ? "bg-red-500" : contextSize > 8000 ? "bg-amber-500" : "bg-cyan-500";

                    if (gridDisplayMode === "compact") {
                      return (
                        <motion.div
                          layout
                          key={pane.pane_id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.15 }}
                          className={`bg-[#0d0d0d] border rounded-lg p-3 lg:p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 transition-colors duration-200 ${
                            isAlertActive ? 'border-amber-500 bg-amber-950/[0.04]' : 'border-white/5 bg-black/40'
                          } ${bgHover}`}
                        >
                          {/* Inner element container */}
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 transition-all duration-1000 ${
                              isAlertActive ? "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.9)] animate-ping" :
                              status === "Running" ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)] animate-pulse" : status === "Idle" ? `bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.2)] ${recentlyIdled[pane.pane_id] ? "heartbeat-animation" : ""}` : "bg-red-500"
                            }`}></span>
                            
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 md:gap-2">
                                <h3 className="text-xs font-mono font-bold text-white uppercase truncate">
                                  {pane.name}
                                </h3>
                                <span className={`text-[8px] font-mono px-1.5 py-0.2 rounded uppercase ${
                                  pane.tool_preset === "Claude Code" ? "bg-purple-500/10 text-purple-400" :
                                  pane.tool_preset === "Codex" ? "bg-orange-500/10 text-orange-400" :
                                  pane.tool_preset === "Antigravity" ? "bg-cyan-500/10 text-cyan-400" : "bg-zinc-805 text-zinc-500"
                                }`}>
                                  {presetLabel}
                                </span>
                                {isAlertActive && (
                                  <span className="text-[7.5px] bg-amber-500 text-black px-1.5 py-0.2 rounded font-sans font-black uppercase tracking-wider animate-bounce">
                                    ALERT REQUIRED
                                  </span>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500 font-mono mt-0.5">
                                <span>{pane.pane_id}</span>
                                <span>•</span>
                                <span className="truncate max-w-[180px]" title={term?.cwd || "/workspace"}>Cwd: {term?.cwd ? (term.cwd.length > 25 ? '...' + term.cwd.slice(-25) : term.cwd) : '/workspace'}</span>
                              </div>
                            </div>
                          </div>

                          {/* Stats Metrics Badge */}
                          <div className="flex items-center gap-4 shrink-0 justify-between md:justify-end border-t border-white/[0.04] md:border-0 pt-2.5 md:pt-0">
                            <div className="flex items-center gap-3">
                              <div className="flex flex-col items-end text-right">
                                <span className="text-[10px] font-mono text-cyan-400 flex items-center gap-1 font-bold">
                                  <Database className="w-2.5 h-2.5" />
                                  {contextSize < 1000 ? `${contextSize} B` : `${(contextSize / 1000).toFixed(1)}k c`}
                                </span>
                                <span className="text-[8px] font-mono text-zinc-550">
                                  ~{Math.ceil(contextSize / 4)} tkn
                                </span>
                              </div>
                              <div className="h-6 w-px bg-white/5 hidden md:block"></div>
                              <div className="flex flex-col items-start min-w-[64px]">
                                <span className={`text-[8.5px] uppercase tracking-wider font-bold ${status === "Running" ? "text-green-400" : isAlertActive ? "text-amber-400" : "text-zinc-500"}`}>
                                  {status === "Running" ? "Running" : isAlertActive ? "Awaiting" : "Idle"}
                                </span>
                                <span className="text-[8px] text-zinc-550 uppercase font-mono">Process</span>
                              </div>
                            </div>

                            {/* Connectivity Activations */}
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() => handleRestartTerminal(pane.pane_id)}
                                className="p-2 border border-white/5 hover:border-white/10 hover:bg-white/5 text-zinc-400 hover:text-white rounded active:scale-95 transition-all text-[9px]"
                                title="Restart Node Engine"
                              >
                                <RefreshCw className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => {
                                  setActiveTerminalId(pane.pane_id);
                                }}
                                className="px-3.5 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/15 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/30 rounded text-[9.5px] font-mono uppercase tracking-wider flex items-center gap-1 active:scale-95 transition-all font-bold select-none h-[34px]"
                              >
                                <TermIcon className="w-3.5 h-3.5" />
                                CONNECT
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      );
                    }

                    return (
                      <motion.div 
                        layout
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ duration: 0.2 }}
                        key={pane.pane_id} 
                        className={`bg-[#111] border rounded-lg p-5 flex flex-col justify-between transition-colors transition-shadow duration-300 ${isAlertActive ? 'border-amber-500 bg-amber-950/[0.02] shadow-[0_0_15px_rgba(245,158,11,0.05)]' : primaryColorClass} ${bgHover}`}
                      >
                        {/* Card Header */}
                        <div>
                          <div className="flex items-start justify-between gap-2 mb-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className={`w-2 h-2 transition-all duration-1000 rounded-full ${
                                  isAlertActive ? "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.9)] animate-ping" :
                                  status === "Running" ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse" : status === "Idle" ? `bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.2)] ${recentlyIdled[pane.pane_id] ? "heartbeat-animation" : ""}` : "bg-red-500"
                                }`}></span>
                                <h3 className="text-xs font-mono font-bold text-white tracking-widest uppercase flex items-center gap-1.5">
                                  {pane.name}
                                  {isAlertActive && (
                                    <span className="text-[7px] bg-amber-500 text-black px-1.5 py-0.5 rounded font-sans font-black uppercase tracking-wider animate-bounce">
                                      ▲ ALERT REQUIRED
                                    </span>
                                  )}
                                </h3>
                              </div>
                              <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest ml-4 block">{pane.pane_id}</span>
                            </div>
                            <span className={`text-[9px] font-mono px-2 py-0.5 rounded uppercase tracking-wider ${
                              pane.tool_preset === "Claude Code" ? "bg-purple-500/10 text-purple-400" :
                              pane.tool_preset === "Codex" ? "bg-orange-500/10 text-orange-400" :
                              pane.tool_preset === "Antigravity" ? "bg-cyan-500/10 text-cyan-400" : "bg-zinc-800 text-zinc-400"
                            }`}>
                              {presetLabel}
                            </span>
                          </div>

                          {isAlertActive && (
                            <div className="mb-4 bg-amber-500/10 border border-amber-500/25 rounded p-2.5 font-mono text-[10px] text-amber-300 animate-pulse">
                              <span className="font-bold block text-amber-400">🚨 AGENT DISPATCHED WARNING:</span>
                              <span className="block mt-1 font-mono text-[9.5px] text-white break-all bg-black/50 p-1.5 rounded border border-white/5">
                                {pendingCommands.find(cmd => cmd.terminalId === pane.pane_id)?.cmd}
                              </span>
                              <span className="block mt-1.5 text-[8.5px] opacity-75">
                                Execute with voice "Confirm" or hit the approve trigger below.
                              </span>
                            </div>
                          )}

                          {/* Pane Context Size Meter */}
                          <div className="space-y-1 mb-4">
                            <div className="flex justify-between items-center text-[10px] font-mono text-zinc-400">
                              <span className="flex items-center gap-1 text-cyan-400"><Database className="w-3 h-3" /> Context Memory</span>
                              <span>
                                {contextSize < 1000 ? `${contextSize} Chars` : `${(contextSize / 1000).toFixed(1)}k Chars`} (~{Math.ceil(contextSize / 4)} Tokens)
                              </span>
                            </div>
                            <div className="w-full h-1 bg-zinc-950 rounded overflow-hidden" title="Relative fill up to 20k characters memory threshold">
                              <div className={`h-full ${contextColor} transition-all duration-500`} style={{ width: `${contextPercent}%` }}></div>
                            </div>
                          </div>

                          {/* Metadata Fields */}
                          <div className="space-y-2 text-[10px] font-mono text-zinc-400 border-t border-b border-white/[0.04] py-3 my-3">
                            <div className="flex items-center justify-between">
                              <span>Session ID</span>
                              <span className="flex items-center gap-1.5 bg-black px-2 py-1 rounded text-zinc-300 border border-white/5">
                                <span className="text-[9px] font-bold tracking-tight max-w-[150px] truncate">{pane.session_id || "None"}</span>
                                {pane.session_id && (
                                  <button
                                    onClick={() => handleCopyClipboard(pane.session_id, pane.pane_id)}
                                    className="hover:text-cyan-400 transition-colors"
                                  >
                                    <Clipboard className="w-3 h-3" />
                                  </button>
                                )}
                              </span>
                            </div>
                            {copiedId === pane.pane_id && (
                              <div className="text-right text-[8px] text-green-400 -mt-1 scale-in">Copied!</div>
                            )}

                            <div className="flex items-center justify-between">
                              <span className="flex items-center gap-1"><Shield className="w-3 h-3" /> Security Access</span>
                              <select
                                value={pane.permissions_mode || "Human-in-the-Loop"}
                                onChange={(e) => handleUpdatePermissions(pane.pane_id, e.target.value)}
                                className="bg-black text-[10px] text-zinc-300 border border-white/10 rounded px-1 py-0.5 focus:outline-none focus:border-cyan-500 cursor-pointer"
                              >
                                <option value="Full Auto">Full Auto</option>
                                <option value="Human-in-the-Loop">Human-in-the-Loop</option>
                                <option value="Read-Only">Read-Only</option>
                              </select>
                            </div>

                            <div className="flex items-center justify-between">
                              <span>Process State</span>
                              <span className={`uppercase font-bold text-[9px] ${status === "Running" ? "text-green-400" : "text-zinc-500"}`}>{status}</span>
                            </div>
                          </div>
                        </div>

                        {/* Inline notes and actions */}
                        <div>
                          {/* Pane Notes Area */}
                          <div className="mt-2 bg-black/40 rounded p-2.5 border border-white/[0.02]">
                            <div className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mb-1.5 flex justify-between items-center">
                              <span>Node Chronicle</span>
                              <span className="opacity-40">{pane.notes?.length || 0} Entries</span>
                            </div>
                            <div className="max-h-24 overflow-y-auto space-y-1 pr-1 scrollbar-thin">
                              {pane.notes && pane.notes.length > 0 ? (
                                pane.notes.map((note, idx) => (
                                  <div key={idx} className="text-[10px] text-[#e0e0e0]/70 flex items-start gap-1 font-sans">
                                    <span className="text-cyan-500/40 select-none font-mono">•</span>
                                    <span>{note}</span>
                                  </div>
                                ))
                              ) : (
                                <div className="text-[9px] font-mono py-1.5 text-zinc-600 italic">No notes created.</div>
                              )}
                            </div>
                            <div className="flex items-center gap-1 mt-2.5 pt-2 border-t border-white/[0.04]">
                              <input 
                                type="text"
                                placeholder="Add note..."
                                value={newNoteInputs[pane.pane_id] || ""}
                                onChange={(e) => setNewNoteInputs(prev => ({ ...prev, [pane.pane_id]: e.target.value }))}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddPaneNoteInline(activeProjectId, pane.pane_id)}
                                className="flex-1 bg-black text-[9px] border border-white/5 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500/50"
                              />
                              <button
                                onClick={() => handleAddPaneNoteInline(activeProjectId, pane.pane_id)}
                                className="p-1 text-cyan-500 hover:text-cyan-400 hover:bg-white/5 rounded transition-colors"
                              >
                                <Plus className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Action Buttons */}
                          <div className="flex gap-2.5 mt-4">
                            <button
                              onClick={() => handleRestartTerminal(pane.pane_id)}
                              className="flex-1 py-1.5 border border-white/10 hover:border-white/20 text-white rounded text-[10px] font-mono uppercase tracking-wider flex items-center justify-center gap-1"
                            >
                              <RefreshCw className="w-3 h-3" />
                              RESTART
                            </button>
                            <button
                              onClick={() => {
                                setActiveTerminalId(pane.pane_id);
                              }}
                              className="flex-1 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/30 rounded text-[10px] font-mono uppercase tracking-wider flex items-center justify-center gap-1"
                            >
                              <TermIcon className="w-3 h-3" />
                              CONNECT
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                  </AnimatePresence>
                </motion.div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center bg-[#090909] border border-dashed border-white/5 rounded-xl p-12">
                  <div className="w-10 h-10 rounded-full border border-dashed border-white/20 flex items-center justify-center text-zinc-500 mb-4 animate-pulse">
                    <TermIcon className="w-5 h-5" />
                  </div>
                  <div className="text-[10px] font-mono uppercase text-zinc-500 tracking-[0.2em] mb-3">
                    No active node modules in project.
                  </div>
                  <button
                    onClick={() => setShowCreateModal(true)}
                    className="px-4 py-1.5 text-[10px] font-mono uppercase bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/30 rounded tracking-[0.1em]"
                  >
                    Launch Core Engine Note
                  </button>
                </div>
              );
            })()}

              {/* Artifacts & Memory Registry Panel */}
              <div className="mt-12 pt-8 border-t border-white/5 space-y-6">
                <div>
                  <h2 className="text-sm font-mono text-white tracking-widest uppercase flex items-center gap-2">
                    <FileText className="w-4 h-4 text-cyan-400" />
                    Ledger Artifacts & Memory Registry
                  </h2>
                  <p className="text-[10px] text-zinc-500 font-mono mt-1">
                    Manage and inspect workspace configurations, metadata snapshots, and idle session properties stored in memory.
                  </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Left: Project Context Entities */}
                  <div className="bg-[#0b0b0b] border border-white/5 rounded-lg p-5 space-y-4">
                    <div className="flex justify-between items-center border-b border-white/5 pb-2">
                      <span className="text-[11px] font-mono uppercase text-zinc-400 font-bold tracking-wider">Registered Workspaces ({projectList.length})</span>
                      <button 
                        onClick={handleCreateProject}
                        className="text-[9px] font-mono uppercase bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 px-2 py-0.5 rounded cursor-pointer"
                      >
                        + Create Space
                      </button>
                    </div>

                    <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                      {projectList.map((p) => {
                        const isActive = p.id === activeProjectId;
                        const paneKeys = Object.keys(p.panes || {});
                        return (
                          <div key={p.id} className={`p-3 rounded border font-mono text-xs transition-colors ${isActive ? "bg-cyan-500/[0.02] border-cyan-500/20" : "bg-black/30 border-white/5"}`}>
                            <div className="flex justify-between items-center">
                              <span className={`font-bold ${isActive ? "text-cyan-400" : "text-zinc-400"}`}>{p.name?.toUpperCase() || p.id}</span>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleSwitchProject(p.id)}
                                  disabled={isActive}
                                  className="text-[9px] text-zinc-400 hover:text-white disabled:opacity-30 disabled:hover:text-zinc-400 cursor-pointer"
                                >
                                  [SWITCH]
                                </button>
                                {projectList.length > 1 && (
                                  <button
                                    onClick={() => handleDeleteProjectPrompt(p.id)}
                                    className="text-[9px] text-zinc-500 hover:text-red-400 cursor-pointer"
                                  >
                                    [DELETE]
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className="text-[10px] text-zinc-500 mt-1 space-y-1">
                              <div>Directory: <span className="text-zinc-400 font-bold">{p.directory}</span></div>
                              <div className="flex justify-between text-[9px] text-zinc-600">
                                <span>Panes registered: {paneKeys.length}</span>
                                <span>Notes: {p.notes?.length || 0}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Right: Selected Workspace Panes & Terminal Session Artifacts */}
                  <div className="bg-[#0b0b0b] border border-white/5 rounded-lg p-5 space-y-4">
                    <div className="flex justify-between items-center border-b border-white/5 pb-2">
                      <span className="text-[11px] font-mono uppercase text-zinc-400 font-bold tracking-wider">
                        Stored Sessions of [{(activeProject?.name || activeProjectId).toUpperCase()}]
                      </span>
                      <span className="text-[9px] text-zinc-650 font-mono">
                        {Object.keys(activeProject?.panes || {}).length} snapshots saved
                      </span>
                    </div>

                    <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                      {activeProject && Object.values(activeProject.panes || {}).length > 0 ? (
                        Object.values(activeProject.panes).map((pane) => {
                          const isLiveProcess = terminals.some(t => t.id === pane.pane_id);
                          return (
                            <div key={pane.pane_id} className="p-3 bg-black/30 border border-white/5 rounded font-mono text-xs">
                              <div className="flex justify-between items-center">
                                <span className="font-bold text-zinc-300">{pane.name}</span>
                                <div className="flex items-center gap-2">
                                  <span className={`text-[8px] px-1 py-0.2 rounded font-sans uppercase ${
                                    isLiveProcess ? "bg-green-500/10 text-green-400" : "bg-zinc-800 text-zinc-500"
                                  }`}>
                                    {isLiveProcess ? "Active RAM" : "Idle Registry"}
                                  </span>
                                  <button
                                    onClick={() => handleDeletePanePrompt(activeProjectId, pane.pane_id)}
                                    className="text-[9px] text-zinc-500 hover:text-red-400 cursor-pointer"
                                    title="De-register module memory object completely"
                                  >
                                    [PRUNE]
                                  </button>
                                </div>
                              </div>
                              <div className="text-[10px] text-zinc-500 mt-1.5 space-y-1">
                                <div className="flex justify-between">
                                  <span>Preset: <span className="text-zinc-400">{pane.tool_preset}</span></span>
                                  <span>Policy: <span className="text-zinc-400">{pane.permissions_mode}</span></span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="truncate max-w-[140px]">Session ID: <span className="text-zinc-400 text-[9px]">{pane.session_id || "None"}</span></span>
                                  <span>Context: <span className="text-cyan-400 text-[10px] font-bold">{pane.context_size < 1000 ? `${pane.context_size} Chars` : `${(pane.context_size / 1000).toFixed(1)}k Chars`}</span></span>
                                </div>
                                {!isLiveProcess && (
                                  <div className="pt-1.5 flex justify-end">
                                    <button
                                      onClick={() => handleRestartTerminal(pane.pane_id)}
                                      className="text-[9px] text-cyan-400 hover:text-cyan-300 border border-cyan-400/20 px-2 py-0.5 rounded hover:bg-cyan-500/[0.05] cursor-pointer"
                                    >
                                      Recover & Wake up Engine
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div className="p-6 text-center text-zinc-600 text-[10px] italic border border-dashed border-white/5 rounded">
                          No pane configuration snapshots saved.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Mobile Active Views */}
        {mobileActiveView === "buffer" && (
          <section className="flex-1 flex flex-col bg-[#080808] p-4 lg:hidden overflow-y-auto h-full gap-4">
            {renderTerminalHealthHeatmap()}
            {renderPromptSynchronizerPanel()}
          </section>
        )}

        {/* Desktop Helper Panel: Shared Sync Buffer */}
        <aside className="hidden lg:flex w-[400px] shrink-0 border-l border-white/5 bg-black/40 flex-col overflow-hidden max-h-full">
          <div className="p-4 border-b border-white/5 bg-black/10 shrink-0">
            {renderTerminalHealthHeatmap()}
          </div>
          <div className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto h-full scrollbar-thin">
            {renderPromptSynchronizerPanel()}
          </div>
        </aside>

        {/* Right side Transcript Log Panel */}
        {showTranscriptPanel && (
          <aside className="w-80 border-l border-white/5 bg-[#090909] flex flex-col shrink-0">
            <div className="p-4 border-b border-white/5 flex items-center justify-between select-none">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
                <span className="text-[11px] font-mono tracking-wider text-white uppercase font-bold">Janus Voice Log</span>
              </div>
              <button 
                onClick={() => setTranscript([])} 
                className="text-[9px] uppercase font-mono px-2 py-0.5 bg-white/5 hover:bg-red-500/10 hover:text-red-400 text-zinc-500 rounded border border-transparent hover:border-red-500/20 cursor-pointer focus:outline-none"
                title="Clear transcript history"
              >
                Clear
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3.5 scrollbar-thin">
              {transcript.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-4">
                  <div className="w-8 h-8 rounded-full border border-white/5 flex items-center justify-center text-zinc-600 mb-2 font-mono text-xs select-none">?</div>
                  <p className="text-[10px] font-mono text-zinc-500 leading-relaxed max-w-[170px] italic">
                    Speak to Janus or trigger a query to stream transcripts...
                  </p>
                </div>
              ) : (
                transcript.map((item, idx) => {
                  const isUser = item.sender === "User";
                  return (
                    <div 
                      key={idx} 
                      className={`flex flex-col max-w-[90%] ${isUser ? "ml-auto items-end" : "mr-auto items-start"}`}
                    >
                      <span className="text-[9px] font-mono opacity-30 mb-0.5 select-none uppercase">
                        {item.sender}
                      </span>
                      <div className={`p-2.5 rounded-lg text-xs leading-relaxed font-sans ${
                        isUser 
                          ? "bg-zinc-850 text-zinc-200 rounded-tr-none border border-white/5" 
                          : "bg-cyan-950/25 border border-cyan-500/20 text-cyan-200 rounded-tl-none pr-3"
                      }`}>
                        {item.text}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="p-3 border-t border-white/5 bg-black/40 text-[9px] font-mono text-zinc-500 leading-normal select-none">
              Derived from client mic input PCM streaming mapping at 16,000 Hz.
            </div>
          </aside>
        )}
      </main>

      {/* Mobile Sticky Touch-friendly Navigation Bar */}
      <div className="lg:hidden shrink-0 h-16 bg-black border-t border-white/10 flex items-center justify-around px-2 z-20 select-none">
        <button
          onClick={() => setMobileActiveView("terminal")}
          className={`flex-1 py-1 flex flex-col items-center justify-center gap-1 transition-colors focus:outline-none ${mobileActiveView === "terminal" ? "text-cyan-400 font-extrabold" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          <TermIcon className="w-4 h-4" />
          <span className="text-[9px] font-mono uppercase tracking-wider">Terminal</span>
        </button>
        <button
          onClick={() => setMobileActiveView("buffer")}
          className={`flex-1 py-1 flex flex-col items-center justify-center gap-1 relative transition-colors focus:outline-none ${mobileActiveView === "buffer" ? "text-cyan-400 font-extrabold" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          <CheckSquare className="w-4 h-4" />
          <span className="text-[9px] font-mono uppercase tracking-wider">Sync Buffer</span>
          {promptBuffer.length > 0 && (
            <span className="absolute top-2.5 right-8 w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse"></span>
          )}
        </button>
        <button
          onClick={() => setMobileActiveView("menu")}
          className={`flex-1 py-1 flex flex-col items-center justify-center gap-1 transition-colors focus:outline-none ${mobileActiveView === "menu" ? "text-cyan-400 font-extrabold" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          <Layers className="w-4 h-4" />
          <span className="text-[9px] font-mono uppercase tracking-wider">Projects</span>
        </button>
      </div>

      {/* System Bar */}
      <div className="bg-black border-t border-white/5 px-6 py-2 flex justify-between items-center shrink-0">
        <div className="flex gap-6">
          <span className="text-[10px] font-mono opacity-30">UPTIME: ACTIVE DETECTED</span>
          <span className="text-[10px] font-mono text-cyan-400 font-bold tracking-wider">
            CUMULATIVE CONTEXT SIZE: {totalContextSize < 1000 ? `${totalContextSize} Chars` : `${(totalContextSize / 1000).toFixed(1)}k chars`} (~{totalTokensEstimated < 1000 ? `${totalTokensEstimated}` : `${(totalTokensEstimated / 1000).toFixed(1)}k`} tokens)
          </span>
        </div>
        <div className="flex gap-4">
          <span className="text-[10px] font-mono text-cyan-400">[CORE CLOUD SYSTEMS ONLINE]</span>
          <span className="text-[10px] font-mono opacity-30 uppercase tracking-tighter italic font-bold">Orbital Harness v1.0.4</span>
        </div>
      </div>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState;
  props: ErrorBoundaryProps;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.props = props;
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[CRITICAL FRONTEND FAULT]", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#060606] text-white flex flex-col items-center justify-center p-6 font-mono select-none">
          <div className="w-full max-w-md bg-red-950/20 border border-red-500/30 rounded p-6 shadow-2xl relative animate-in zoom-in duration-250">
            <div className="absolute top-3 right-3 text-[9px] bg-red-500 text-black px-1.5 rounded font-bold">FAULT</div>
            <h1 className="text-sm font-bold uppercase tracking-wider text-red-400 mb-4 flex items-center gap-2">
              ⚠️ Critical Sandbox Error
            </h1>
            <p className="text-xs text-zinc-400 leading-relaxed mb-4">
              The Antigravity application engine encountered an unhandled execution exception. This sandbox remains active.
            </p>
            <div className="bg-black/60 p-3 rounded text-[10px] text-zinc-500 overflow-x-auto break-all border border-white/5 max-h-40 mb-6 font-mono leading-relaxed">
              {this.state.error?.stack || this.state.error?.message || "Unknown Runtime Exception"}
            </div>
            <button
              onClick={() => window.location.reload()}
              className="w-full text-center py-2 bg-red-500 text-black hover:bg-red-400 text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer focus:outline-none"
            >
              Reboot Application View
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function parseInlines(text: string): React.ReactNode[] {
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const matches = text.split(regex);
  return matches.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-bold text-white font-sans">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <span key={i} className="italic text-cyan-200">
          {part.slice(1, -1)}
        </span>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="bg-black/80 px-1.5 py-0.5 rounded border border-white/10 font-mono text-[9px] text-cyan-400">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  }).filter(Boolean) as React.ReactNode[];
}

function MiniMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1.5 select-text font-sans">
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        // Headers
        if (trimmed.startsWith("### ")) {
          return (
            <h4 key={idx} className="text-[11px] font-mono font-bold text-cyan-400 uppercase tracking-widest mt-4 mb-2 border-b border-white/5 pb-1">
              {trimmed.slice(4)}
            </h4>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h3 key={idx} className="text-xs font-mono font-bold text-white uppercase tracking-wider mt-5 mb-2 border-b border-white/10 pb-1">
              {trimmed.slice(3)}
            </h3>
          );
        }
        if (trimmed.startsWith("# ")) {
          return (
            <h2 key={idx} className="text-sm font-sans font-black text-white hover:text-cyan-400 uppercase tracking-widest mt-6 mb-3 border-b-2 border-cyan-400/20 pb-1">
              {trimmed.slice(2)}
            </h2>
          );
        }
        // Horizontal separators
        if (trimmed === "---") {
          return <hr key={idx} className="border-white/5 my-4" />;
        }
        // Lists
        if (trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ") || trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          const isChecklist = trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ");
          const isChecked = trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ");
          
          let listText = trimmed;
          if (isChecklist) {
            listText = trimmed.slice(6);
          } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
            listText = trimmed.slice(2);
          }
          
          return (
            <div key={idx} className="flex items-start gap-2.5 text-xs text-zinc-300 ml-4 py-0.5 font-sans leading-relaxed">
              {isChecklist ? (
                <span className={`w-3.5 h-3.5 border rounded flex-shrink-0 flex items-center justify-center text-[8px] tracking-tighter ${
                  isChecked ? "bg-cyan-500/20 border-cyan-400 text-cyan-400 font-bold" : "border-white/20 text-transparent bg-black"
                }`}>✓</span>
              ) : (
                <span className="text-cyan-500 select-none">•</span>
              )}
              <span className={isChecked ? "line-through text-zinc-650" : ""}>{parseInlines(listText)}</span>
            </div>
          );
        }
        // Empty space
        if (!trimmed) {
          return <div key={idx} className="h-1.5" />;
        }
        // Normal text
        return (
          <p key={idx} className="text-[11.5px] text-zinc-400 leading-relaxed py-0.5 font-sans">
            {parseInlines(line)}
          </p>
        );
      })}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppRaw />
    </ErrorBoundary>
  );
}
