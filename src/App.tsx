import { useEffect, useState, useRef } from "react";
import { Terminal, PendingCommand, Workspace, PaneMeta, SystemSettings } from "./types";
import { pcmToBase64, playAudioChunk, resetAudioPlayback } from "./utils/audio";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { CreateTerminalDialog } from "./components/CreateTerminalDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Mic, MicOff, RefreshCw, Cpu, Shield, Terminal as TermIcon, FileText, Clipboard, Plus, Trash2, Settings } from "lucide-react";

export default function App() {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [ledger, setLedger] = useState<Record<string, Workspace>>({});
  const [activeProjectId, setActiveProjectId] = useState<string>("default_project");
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [promptDialog, setPromptDialog] = useState<{title: string, placeholder: string, onSubmit: (val: string) => void} | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [newNoteInputs, setNewNoteInputs] = useState<Record<string, string>>({});
  const [globalPermissionsMode, setGlobalPermissionsMode] = useState<"Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit">("Inherit");
  const [autoApprovedNotification, setAutoApprovedNotification] = useState<{terminalId: string, cmd: string} | null>(null);
  const [blockedNotification, setBlockedNotification] = useState<{terminalId: string, cmd: string, reason: string} | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // Mirror mute state into a ref so the long-lived onaudioprocess callback
  // reads the current value instead of the value captured when it was created.
  const isMicMutedRef = useRef(false);

  useEffect(() => {
    isMicMutedRef.current = isMicMuted;
  }, [isMicMuted]);

  const fetchTerminals = async () => {
    try {
      const res = await fetch("/api/terminals");
      if (!res.ok) return;
      const data = await res.json();
      setTerminals(data);
    } catch (e) {
      // Silent catch to prevent 'Failed to fetch' console errors during server restarts
    }
  };

  const fetchLedger = async () => {
    try {
      const res = await fetch("/api/ledger");
      if (!res.ok) return;
      const data = await res.json();
      setLedger(data);
    } catch (e) {}
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch("/api/settings");
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

      const res = await fetch("/api/settings", {
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
      const res = await fetch("/api/settings", {
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

  useEffect(() => {
    fetchTerminals();
    fetchLedger();
    fetchSettings();
    const interval = setInterval(fetchTerminals, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleApprove = async (messageId: string) => {
    try {
      await fetch("/api/commands/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, approved: true })
      });
      setPendingCommand(null);
      setTimeout(fetchTerminals, 500);
    } catch (e) {}
  };

  const handleReject = async (messageId: string) => {
    try {
      await fetch("/api/commands/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, approved: false })
      });
      setPendingCommand(null);
    } catch (e) {}
  };

  const handleCreateTerminal = async (
    id: string,
    cwd: string,
    cmd: string,
    toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom",
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only"
  ) => {
    try {
      await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          terminalId: id,
          cwd,
          command: cmd,
          toolPreset,
          permissionsMode
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
      await fetch(`/api/terminals/${id}/restart`, {
        method: "POST"
      });
      fetchTerminals();
      fetchLedger();
    } catch (e) {}
  };

  const handleUpdatePermissions = async (paneId: string, val: string) => {
    try {
      await fetch(`/api/projects/${activeProjectId}/panes/${paneId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: val })
      });
      fetchLedger();
      fetchTerminals();
    } catch (e) {}
  };

  const startLive = async () => {
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/live`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      resetAudioPlayback();

      ws.onopen = async () => {
        setIsLive(true);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        
        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        
        source.connect(processor);
        processor.connect(audioCtx.destination);

        processor.onaudioprocess = (e) => {
          if (ws.readyState === WebSocket.OPEN && !isMicMutedRef.current) {
            const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
            ws.send(JSON.stringify({ type: "audio", audio: base64 }));
          }
        };
      };

      ws.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "audio" && msg.audio) {
          playAudioChunk(audioCtx, msg.audio);
        } else if (msg.type === "interrupted") {
          resetAudioPlayback();
        } else if (msg.type === "approval_pending") {
          setPendingCommand({
            messageId: msg.messageId,
            cmd: msg.cmd,
            terminalId: msg.terminalId
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
          // Live, latency-free updates! Feed chunks directly to the UI
          setTerminals((prev) =>
            prev.map((t) => {
              if (t.id === msg.terminalId) {
                const lines = (t.output + msg.chunk).split("\n").slice(-40);
                return { ...t, output: lines.join("\n") };
              }
              return t;
            })
          );
        }
      };

      ws.onclose = () => {
        stopLive();
      };
    } catch (e) {
      console.error(e);
      stopLive();
    }
  };

  const stopLive = () => {
    setIsLive(false);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
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
    setPromptDialog({
      title: "Create New Project Context Space", placeholder: "e.g. multi-agent-space",
      onSubmit: async (val) => {
        if (!val.trim()) return;
        const normId = val.trim().toLowerCase().replace(/\s+/g, "_");
        await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: normId, directory: process.cwd(), summary: "Custom Registered Context" })
        });
        setPromptDialog(null);
        handleSwitchProject(normId);
      }
    });
  };

  const handleSwitchProject = async (id: string) => {
    await fetch(`/api/projects/${id}/switch`, { method: "POST" });
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
        await fetch(`/api/projects/${id}`, { method: "DELETE" });
        setPromptDialog(null);
        fetchLedger();
        setActiveTerminalId(null);
        fetchTerminals();
      }
    });
  };

  const handleDeletePanePrompt = async (projId: string, paneId: string) => {
    await fetch(`/api/projects/${projId}/panes/${paneId}`, { method: "DELETE" });
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
        await fetch(`/api/projects/${id}/rename`, { method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: val}) });
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
        await fetch(`/api/projects/${id}/notes`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({note: val}) });
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
        await fetch(`/api/projects/${projId}/panes/${paneId}/rename`, { method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: val}) });
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
        await fetch(`/api/projects/${projId}/panes/${paneId}/notes`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({note: val}) });
        setPromptDialog(null);
        fetchLedger();
      }
    });
  };

  const handleAddPaneNoteInline = async (projId: string, paneId: string) => {
    const rawNote = newNoteInputs[paneId];
    if (!rawNote || !rawNote.trim()) return;
    await fetch(`/api/projects/${projId}/panes/${paneId}/notes`, {
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

  return (
    <div className="flex flex-col h-screen w-full bg-[#050505] text-[#e0e0e0] font-sans overflow-hidden border-t-4 border-[#121212]">
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
        />
      )}
      
      {pendingCommand && (
        <ApprovalDialog 
          messageId={pendingCommand.messageId}
          terminalId={pendingCommand.terminalId}
          cmd={pendingCommand.cmd}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
      
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
      </div>

      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-black/40 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full ${isLive ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-600'}`}></div>
          <h1 className="font-serif italic text-xl tracking-wide text-white flex items-center gap-2">
            Orbital Harness <span className="text-xs font-mono font-normal opacity-40">v1.0.4-live</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-6">
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
            <span className={`text-xs font-mono ${isLive ? (isMicMuted ? 'text-amber-400' : 'text-green-400') : 'text-zinc-600'}`}>
              {isLive ? (isMicMuted ? 'MUTED' : 'LISTENING...') : 'OFFLINE'}
            </span>
          </div>
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

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <nav className="w-72 border-r border-white/5 bg-black/20 flex flex-col overflow-y-auto">
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
                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                       <button onClick={() => handleRenameProject(project.id, project.name)} className="text-[9px] uppercase hover:text-cyan-400" title="Rename space">Rename</button>
                       <button onClick={() => handleAddProjectNote(project.id)} className="text-[9px] uppercase hover:text-cyan-400" title="Append note">Note</button>
                       {projectList.length > 1 && (
                         <button onClick={() => handleDeleteProjectPrompt(project.id)} className="text-[9px] uppercase hover:text-red-400 text-zinc-650" title="Prune Project Memory">Prune</button>
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
                  
                  {activeProjectId === project.id && project.panes && (
                    <div className="space-y-1 pl-2 mt-2">
                      {Object.values(project.panes).map((pane) => {
                        const isActive = activeTerminalId === pane.pane_id;
                        const term = terminals.find(t => t.id === pane.pane_id);
                        const isAlertActive = pendingCommand && pendingCommand.terminalId === pane.pane_id;
                        let statusColor = "bg-zinc-600";
                        
                        if (isAlertActive) {
                          statusColor = "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.9)] animate-pulse";
                        } else if (term) {
                          if (term.status === "Running") {
                            statusColor = "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse";
                          } else if (term.status === "Idle") {
                            statusColor = "bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.6)]";
                          } else if (term.status === "Exited") {
                            statusColor = "bg-red-500";
                          }
                        } else {
                          if (pane.alive && pane.is_busy) statusColor = "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse";
                          else if (pane.alive && !pane.is_busy) statusColor = "bg-yellow-500";
                          else statusColor = "bg-red-500";
                        }
                        
                        return (
                          <div key={pane.pane_id} className="flex flex-col group">
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
                              <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${statusColor}`} title={isAlertActive ? "Status: Alert (Approval Required)" : `Status: ${pane.last_known_state}`}></span>
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
                          </div>
                        );
                      })}
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
        <section className="flex-1 flex flex-col bg-[#0b0b0b] min-w-0">
          {activeTerminalId && activeTerminal ? (
            /* Terminal View */
            <div className="flex flex-1 flex-col overflow-hidden">
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
                    onClick={() => handleRestartTerminal(activeTerminal.id)}
                    className="p-1.5 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors"
                    title="Restart Node Engine"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex-1 p-6 font-mono text-xs overflow-y-auto text-[#b4b4b4] leading-relaxed bg-[#060606]">
                <pre className="whitespace-pre-wrap break-all break-words">{activeTerminal.output}</pre>
                <div className="mt-2 text-cyan-400 animate-pulse">_</div>
              </div>
            </div>
          ) : (
            /* Dashboard High-Level View */
            <div className="flex-1 flex flex-col overflow-y-auto p-8">
              <div className="mb-8 select-none">
                <h1 className="text-xl font-mono text-white tracking-widest uppercase mb-1 flex items-center gap-2">
                  <Cpu className="w-5 h-5 text-cyan-400 shrink-0" />
                  Node Configuration Matrix
                </h1>
                <p className="text-xs text-zinc-500 font-mono">
                  Active compilation channels tracking Claude Code, Codex, and Antigravity orchestrator engines.
                </p>
              </div>

              {activeProject && activeProject.panes && Object.keys(activeProject.panes).length > 0 ? (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  {Object.values(activeProject.panes).map((pane) => {
                    const term = terminals.find(t => t.id === pane.pane_id);
                    const status = term?.status || (pane.alive ? (pane.is_busy ? "Running" : "Idle") : "Exited");
                    const cpu = term?.cpu_usage !== undefined ? term.cpu_usage : (pane.cpu_usage || 0);

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

                    const isAlertActive = pendingCommand && pendingCommand.terminalId === pane.pane_id;
                    const finalStatus = isAlertActive ? "Alert (Awaiting Approval)" : status;

                    // CPU health color
                    const cpuColor = cpu > 70 ? "bg-red-500" : cpu > 30 ? "bg-amber-500" : "bg-cyan-500";

                    return (
                      <div 
                        key={pane.pane_id} 
                        className={`bg-[#111] border rounded-lg p-5 flex flex-col justify-between transition-all duration-300 ${isAlertActive ? 'border-amber-500 bg-amber-950/[0.02] shadow-[0_0_15px_rgba(245,158,11,0.05)]' : primaryColorClass} ${bgHover}`}
                      >
                        {/* Card Header */}
                        <div>
                          <div className="flex items-start justify-between gap-2 mb-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className={`w-2 h-2 rounded-full ${
                                  isAlertActive ? "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.9)] animate-ping" :
                                  status === "Running" ? "bg-green-500 animate-pulse" : status === "Idle" ? "bg-yellow-500" : "bg-red-500"
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
                                {pendingCommand.cmd}
                              </span>
                              <span className="block mt-1.5 text-[8.5px] opacity-75">
                                Execute with voice "Confirm" or hit the approve trigger below.
                              </span>
                            </div>
                          )}

                          {/* CPU Meter */}
                          <div className="space-y-1 mb-4">
                            <div className="flex justify-between items-center text-[10px] font-mono text-zinc-400">
                              <span className="flex items-center gap-1"><Cpu className="w-3 h-3" /> CPU Load</span>
                              <span>{cpu.toFixed(1)}%</span>
                            </div>
                            <div className="w-full h-1 bg-zinc-950 rounded overflow-hidden">
                              <div className={`h-full ${cpuColor} transition-all duration-500`} style={{ width: `${Math.min(cpu, 100)}%` }}></div>
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
                      </div>
                    );
                  })}
                </div>
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
              )}

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
                                  <span className="truncate max-w-[180px]">Session ID: <span className="text-zinc-400 text-[9px]">{pane.session_id || "None"}</span></span>
                                  <span>Cpu: <span className="text-zinc-400">{pane.cpu_usage || 0}%</span></span>
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
      </main>

      {/* System Bar */}
      <div className="bg-black border-t border-white/5 px-6 py-2 flex justify-between items-center shrink-0">
        <div className="flex gap-6">
          <span className="text-[10px] font-mono opacity-30">UPTIME: ACTIVE DETECTED</span>
          <span className="text-[10px] font-mono opacity-30">TOKEN USE: ADAPTIVE GRID</span>
        </div>
        <div className="flex gap-4">
          <span className="text-[10px] font-mono text-cyan-400">[CORE CLOUD SYSTEMS ONLINE]</span>
          <span className="text-[10px] font-mono opacity-30 uppercase tracking-tighter italic font-bold">Orbital Harness v1.0.4</span>
        </div>
      </div>
    </div>
  );
}
