import React, { useState, useEffect } from "react";
import { SystemSettings, CliPreset } from "../types";
import { 
  X, 
  Settings, 
  Volume2, 
  Cpu, 
  FileCode, 
  Download, 
  Upload, 
  Check, 
  Copy, 
  AlertCircle, 
  HelpCircle, 
  Server,
  Key,
  Terminal,
  Code,
  Gauge,
  Sliders,
  Trash2,
  Plus,
  Eye,
  EyeOff
} from "lucide-react";

function parsePresetsSafe(input: any): CliPreset[] {
  if (Array.isArray(input)) {
    return input.map((item: any) => ({
      id: String(item?.id || ""),
      name: String(item?.name || ""),
      command: String(item?.command || ""),
      enabled: Boolean(item?.enabled ?? true),
      permissionsMode: item?.permissionsMode || "Human-in-the-Loop",
      windowMode: item?.windowMode || "Standard Split-Pane",
      visualTheme: item?.visualTheme || "Default Green Mono",
      persistentRestore: Boolean(item?.persistentRestore ?? false),
      dangerouslySkipPermissions: Boolean(item?.dangerouslySkipPermissions ?? false),
      sessionResume: Boolean(item?.sessionResume ?? true),
      portOffset: item?.portOffset !== undefined ? String(item.portOffset) : "",
      customEnvVars: item?.customEnvVars !== undefined ? String(item.customEnvVars) : ""
    }));
  }
  if (input && typeof input === "object") {
    return Object.entries(input).map(([key, val]: [string, any]) => {
      let displayName = key;
      if (key === "claudeCode") displayName = "Claude Code";
      else if (key === "codex") displayName = "Codex CLI";
      else if (key === "antigravity") displayName = "Antigravity Agent";
      else {
        displayName = key.charAt(0).toUpperCase() + key.slice(1);
      }
      return {
        id: key,
        name: val?.name || displayName,
        command: String(val?.command || ""),
        enabled: Boolean(val?.enabled ?? true),
        permissionsMode: val?.permissionsMode || "Human-in-the-Loop",
        windowMode: val?.windowMode || "Standard Split-Pane",
        visualTheme: val?.visualTheme || "Default Green Mono",
        persistentRestore: Boolean(val?.persistentRestore ?? false),
        dangerouslySkipPermissions: Boolean(val?.dangerouslySkipPermissions ?? false),
        sessionResume: Boolean(val?.sessionResume ?? true),
        portOffset: val?.portOffset !== undefined ? String(val.portOffset) : "",
        customEnvVars: val?.customEnvVars !== undefined ? String(val.customEnvVars) : ""
      };
    });
  }
  return [];
}

interface SettingsDialogProps {
  onClose: () => void;
  settings: SystemSettings | null;
  onSave: (updated: SystemSettings) => Promise<void>;
  terminals?: any[];
}

export function SettingsDialog({
  onClose,
  settings: initialSettings,
  onSave,
  terminals = []
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<"form" | "json" | "install">("form");
  const [formTab, setFormTab] = useState<"session" | "profiles" | "advanced" | "secrets">("session");
  
  // Local states for Form Inputs - Server
  const [port, setPort] = useState<number>(3000);
  const [host, setHost] = useState<string>("0.0.0.0");
  const [appUrl, setAppUrl] = useState<string>("");

  // Local states - Voice AI (General Session Info)
  const [voice, setVoice] = useState<string>("Zephyr");
  const [voiceStyle, setVoiceStyle] = useState<"Direct" | "Creative" | "Concise" | "Explanatory">("Creative");
  const [volume, setVolume] = useState<number>(80);
  const [speechSpeed, setSpeechSpeed] = useState<number>(1.0);
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);
  const [model, setModel] = useState<string>("gemini-3.1-flash-live-preview");

  // Local states - Project profiles
  const [activeContext, setActiveContext] = useState<string>("default_project");
  const [localWorkspacePath, setLocalWorkspacePath] = useState<string>("");

  // Local states - Customizable CLIs Startup presets
  const [presets, setPresets] = useState<CliPreset[]>([]);

  // Local states - Advanced plumbing / Connection variables
  const [webSocketUrl, setWebSocketUrl] = useState<string>("");
  const [latencyMode, setLatencyMode] = useState<"Low Latency" | "High Throughput" | "Balanced">("Balanced");
  const [throughputBps, setThroughputBps] = useState<number>(16000);
  const [audioBufferSize, setAudioBufferSize] = useState<number>(1024);
  const [debugLogging, setDebugLogging] = useState<boolean>(false);
  const [connectionTimeoutMs, setConnectionTimeoutMs] = useState<number>(10000);
  const [rateLimitRequestsPerMin, setRateLimitRequestsPerMin] = useState<number>(60);
  const [maxBufferLines, setMaxBufferLines] = useState<number>(100);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(2000);
  const [defaultShellCommand, setDefaultShellCommand] = useState<string>("bash");
  const [globalPermissionsMode, setGlobalPermissionsMode] = useState<"Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit">("Inherit");

  // Local states - Secret Key Cabinet
  const [geminiApiKey, setGeminiApiKey] = useState<string>("");
  const [showApiKey, setShowApiKey] = useState<boolean>(false);

  // Raw JSON state
  const [rawJsonStr, setRawJsonStr] = useState<string>("");
  const [jsonValidationError, setJsonValidationError] = useState<string | null>(null);

  // Feedback notifications
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Sync initial settings into state
  const [pendingCommands, setPendingCommands] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/commands/pending")
      .then(res => res.json())
      .then(data => setPendingCommands(Array.isArray(data) ? data : []))
      .catch(err => console.error("Error fetching pending approvals settings modal", err));
  }, []);

  useEffect(() => {
    if (initialSettings) {
      setPort(initialSettings.server?.port ?? 3000);
      setHost(initialSettings.server?.host ?? "0.0.0.0");
      setAppUrl(initialSettings.server?.appUrl ?? "");

      setVoice(initialSettings.voiceAi?.voice ?? "Zephyr");
      setVoiceStyle(initialSettings.voiceAi?.voiceStyle ?? "Creative");
      setVolume(initialSettings.voiceAi?.volume ?? 80);
      setSpeechSpeed(initialSettings.voiceAi?.speechSpeed ?? 1.0);
      setIsMicMuted(initialSettings.voiceAi?.isMicMuted ?? false);
      setModel(initialSettings.voiceAi?.model ?? "gemini-3.1-flash-live-preview");

      setActiveContext(initialSettings.projects?.activeContext ?? "default_project");
      setLocalWorkspacePath(initialSettings.projects?.localWorkspacePath ?? "");

      setPresets(parsePresetsSafe(initialSettings.presets));

      setWebSocketUrl(initialSettings.advanced?.webSocketUrl ?? "");
      setLatencyMode(initialSettings.advanced?.latencyMode ?? "Balanced");
      setThroughputBps(initialSettings.advanced?.throughputBps ?? 16000);
      setAudioBufferSize(initialSettings.advanced?.audioBufferSize ?? 1024);
      setDebugLogging(initialSettings.advanced?.debugLogging ?? false);
      setConnectionTimeoutMs(initialSettings.advanced?.connectionTimeoutMs ?? 10000);
      setRateLimitRequestsPerMin(initialSettings.advanced?.rateLimitRequestsPerMin ?? 60);
      setMaxBufferLines(initialSettings.advanced?.maxBufferLines ?? 100);
      setIdleTimeoutMs(initialSettings.advanced?.idleTimeoutMs ?? 2000);
      setDefaultShellCommand(initialSettings.advanced?.defaultShellCommand ?? "bash");
      setGlobalPermissionsMode(initialSettings.advanced?.globalPermissionsMode ?? "Inherit");

      setGeminiApiKey(initialSettings.secrets?.geminiApiKey ?? "");

      // Format JSON string
      setRawJsonStr(JSON.stringify(initialSettings, null, 2));
    }
  }, [initialSettings]);

  // Handle building updated object from form values
  const getCompiledSettings = (): SystemSettings => {
    return {
      server: {
        port,
        host,
        appUrl
      },
      voiceAi: {
        voice,
        voiceStyle,
        volume,
        speechSpeed,
        isMicMuted,
        model
      },
      projects: {
        activeContext,
        localWorkspacePath
      },
      presets,
      advanced: {
        webSocketUrl,
        latencyMode,
        throughputBps,
        audioBufferSize,
        debugLogging,
        connectionTimeoutMs,
        rateLimitRequestsPerMin,
        maxBufferLines,
        idleTimeoutMs,
        defaultShellCommand,
        globalPermissionsMode
      },
      secrets: {
        geminiApiKey
      }
    };
  };

  // Compile and sync live JSON string preview when form inputs change
  useEffect(() => {
    if (activeTab === "json") {
      setRawJsonStr(JSON.stringify(getCompiledSettings(), null, 2));
    }
  }, [
    activeTab, port, host, appUrl, voice, voiceStyle, volume, speechSpeed, isMicMuted, model,
    activeContext, localWorkspacePath, presets, webSocketUrl, latencyMode, throughputBps,
    audioBufferSize, debugLogging, connectionTimeoutMs, rateLimitRequestsPerMin, maxBufferLines,
    idleTimeoutMs, defaultShellCommand, globalPermissionsMode, geminiApiKey
  ]);

  // Handle Saving
  const handleSave = async (compiledData = getCompiledSettings()) => {
    setIsSaving(true);
    try {
      await onSave(compiledData);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  // Handle direct JSON String modifications
  const handleJsonChange = (val: string) => {
    setRawJsonStr(val);
    try {
      const parsed = JSON.parse(val);
      setJsonValidationError(null);
      
      if (parsed.server) {
        if (parsed.server.port !== undefined) setPort(parsed.server.port);
        if (parsed.server.host !== undefined) setHost(parsed.server.host);
        if (parsed.server.appUrl !== undefined) setAppUrl(parsed.server.appUrl);
      }
      if (parsed.voiceAi) {
        if (parsed.voiceAi.voice !== undefined) setVoice(parsed.voiceAi.voice);
        if (parsed.voiceAi.voiceStyle !== undefined) setVoiceStyle(parsed.voiceAi.voiceStyle);
        if (parsed.voiceAi.volume !== undefined) setVolume(parsed.voiceAi.volume);
        if (parsed.voiceAi.speechSpeed !== undefined) setSpeechSpeed(parsed.voiceAi.speechSpeed);
        if (parsed.voiceAi.isMicMuted !== undefined) setIsMicMuted(parsed.voiceAi.isMicMuted);
        if (parsed.voiceAi.model !== undefined) setModel(parsed.voiceAi.model);
      }
      if (parsed.projects) {
        if (parsed.projects.activeContext !== undefined) setActiveContext(parsed.projects.activeContext);
        if (parsed.projects.localWorkspacePath !== undefined) setLocalWorkspacePath(parsed.projects.localWorkspacePath);
      }
      if (parsed.presets !== undefined) {
        setPresets(parsePresetsSafe(parsed.presets));
      }
      if (parsed.advanced) {
        if (parsed.advanced.webSocketUrl !== undefined) setWebSocketUrl(parsed.advanced.webSocketUrl);
        if (parsed.advanced.latencyMode !== undefined) setLatencyMode(parsed.advanced.latencyMode);
        if (parsed.advanced.throughputBps !== undefined) setThroughputBps(parsed.advanced.throughputBps);
        if (parsed.advanced.audioBufferSize !== undefined) setAudioBufferSize(parsed.advanced.audioBufferSize);
        if (parsed.advanced.debugLogging !== undefined) setDebugLogging(parsed.advanced.debugLogging);
        if (parsed.advanced.connectionTimeoutMs !== undefined) setConnectionTimeoutMs(parsed.advanced.connectionTimeoutMs);
        if (parsed.advanced.rateLimitRequestsPerMin !== undefined) setRateLimitRequestsPerMin(parsed.advanced.rateLimitRequestsPerMin);
        if (parsed.advanced.maxBufferLines !== undefined) setMaxBufferLines(parsed.advanced.maxBufferLines);
        if (parsed.advanced.idleTimeoutMs !== undefined) setIdleTimeoutMs(parsed.advanced.idleTimeoutMs);
        if (parsed.advanced.defaultShellCommand !== undefined) setDefaultShellCommand(parsed.advanced.defaultShellCommand);
        if (parsed.advanced.globalPermissionsMode !== undefined) setGlobalPermissionsMode(parsed.advanced.globalPermissionsMode);
      }
      if (parsed.secrets) {
        if (parsed.secrets.geminiApiKey !== undefined) setGeminiApiKey(parsed.secrets.geminiApiKey);
      }
    } catch (e: any) {
      setJsonValidationError(e.message ?? "Parsing Exception");
    }
  };

  const handleCopyConfig = () => {
    navigator.clipboard.writeText(rawJsonStr);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleDownloadConfig = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(getCompiledSettings(), null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "janus-config.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleUploadConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const contents = evt.target?.result;
      if (typeof contents === "string") {
        try {
          const parsed = JSON.parse(contents);
          handleJsonChange(JSON.stringify(parsed, null, 2));
          alert("Profile configurations parsed successfully! Click 'Apply Settings' to trigger standard synchronization.");
        } catch (err: any) {
          alert("Failed to parse configurations file: " + err.message);
        }
      }
    };
    reader.readAsText(file);
  };

  // Customizable Presets List handlers
  const handleAddPreset = () => {
    const id = "custom_" + Date.now();
    setPresets([
      ...presets,
      { 
        id, 
        name: "Custom Subshell", 
        command: "bash", 
        enabled: true,
        permissionsMode: "Human-in-the-Loop",
        windowMode: "Standard Split-Pane",
        visualTheme: "Default Green Mono",
        persistentRestore: false
      }
    ]);
  };

  const handleUpdatePreset = (id: string, updatedFields: Partial<CliPreset>) => {
    setPresets(presets.map(p => p.id === id ? { ...p, ...updatedFields } : p));
  };

  const handleDeletePreset = (id: string) => {
    setPresets(presets.filter(p => p.id !== id));
  };

  const isFormValid = !jsonValidationError;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-[#0b0b0b] border border-white/10 rounded-xl w-full max-w-3xl h-[85vh] max-h-[800px] shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-white/[0.02] border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <Settings className="w-5 h-5 text-cyan-400 shrink-0" />
            <div>
              <h2 className="text-sm font-mono text-white uppercase tracking-widest leading-none">Janus Parameters orchestrator config</h2>
              <p className="text-[10px] text-zinc-500 font-mono mt-1">Configure session context, dynamic CLI profiles, and pipings</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-1 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Controls */}
        <div className="flex bg-black px-6 border-b border-white/5 shrink-0 font-mono text-[11px] uppercase tracking-wide">
          <button 
            onClick={() => setActiveTab("form")}
            className={`px-4 py-3 border-b-2 transition-colors cursor-pointer ${activeTab === "form" ? "border-cyan-500 text-cyan-400 bg-white/[0.01]" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
          >
            Setup Panels
          </button>
          <button 
            onClick={() => setActiveTab("json")}
            className={`px-4 py-3 border-b-2 transition-colors cursor-pointer ${activeTab === "json" ? "border-cyan-500 text-cyan-400 bg-white/[0.01]" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
          >
            Interactive Raw JSON
          </button>
          <button 
            onClick={() => setActiveTab("install")}
            className={`px-4 py-3 border-b-2 transition-colors cursor-pointer ${activeTab === "install" ? "border-cyan-500 text-cyan-400 bg-white/[0.01]" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
          >
            Terminal Seed Snippet
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-hidden font-mono text-xs">
          
          {/* TAB 1: FORM CONTROLS */}
          {activeTab === "form" && (
            <div className="flex h-full">
              {/* Form Sidebar Subtabs */}
              <div className="w-48 bg-black/40 border-r border-white/5 p-4 flex flex-col gap-1 shrink-0 font-mono text-[10px] uppercase tracking-wider overflow-y-auto">
                <span className="text-[9px] text-zinc-600 px-3 uppercase tracking-widest font-bold mb-1">Session Settings</span>
                <button 
                  onClick={() => setFormTab("session")}
                  className={`px-3 py-2 text-left rounded transition-colors flex items-center gap-2 cursor-pointer ${formTab === "session" ? "bg-cyan-950/40 border border-cyan-500/20 text-cyan-400 font-bold" : "border border-transparent text-zinc-400 hover:bg-white/[0.02]"}`}
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  Voice Session
                </button>

                <div className="h-px bg-white/5 my-2" />
                <span className="text-[9px] text-zinc-600 px-3 uppercase tracking-widest font-bold mb-1">Profiles / Terminal</span>
                <button 
                  onClick={() => setFormTab("profiles")}
                  className={`px-3 py-2 text-left rounded transition-colors flex items-center gap-2 cursor-pointer ${formTab === "profiles" ? "bg-cyan-950/40 border border-cyan-500/20 text-cyan-400 font-bold" : "border border-transparent text-zinc-400 hover:bg-white/[0.02]"}`}
                >
                  <Terminal className="w-3.5 h-3.5" />
                  CLI profiles
                </button>

                <div className="h-px bg-white/5 my-2" />
                <span className="text-[9px] text-zinc-600 px-3 uppercase tracking-widest font-bold mb-1">Subsystems / Plumbing</span>
                <button 
                  onClick={() => setFormTab("advanced")}
                  className={`px-3 py-2 text-left rounded transition-colors flex items-center gap-2 cursor-pointer ${formTab === "advanced" ? "bg-cyan-950/40 border border-cyan-500/20 text-cyan-400 font-bold" : "border border-transparent text-zinc-400 hover:bg-white/[0.02]"}`}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  Advanced Plumbing
                </button>

                <button 
                  onClick={() => setFormTab("secrets")}
                  className={`px-3 py-2 text-left rounded transition-colors flex items-center gap-2 cursor-pointer ${formTab === "secrets" ? "bg-red-950/30 border border-red-500/20 text-rose-400 font-bold" : "border border-transparent text-zinc-400 hover:bg-white/[0.02]"}`}
                >
                  <Key className="w-3.5 h-3.5" />
                  Secrets Key cabinet
                </button>
              </div>

              {/* Form Input fields */}
              <div className="flex-1 overflow-y-auto p-6 space-y-5">
                
                {/* 1. General User Session Settings */}
                {formTab === "session" && (
                  <div className="space-y-4">
                    <div className="border-b border-white/5 pb-2">
                      <h3 className="text-white uppercase text-[10px] tracking-widest font-bold">General voice session</h3>
                      <p className="text-[10px] text-zinc-500 mt-0.5">Customize real-time voice, sound, and speaking traits</p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-zinc-400 mb-1">Sound Persona</label>
                        <select
                          value={voice}
                          onChange={e => setVoice(e.target.value)}
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
                        >
                          <option value="Zephyr">Zephyr (Default Warm Male)</option>
                          <option value="Puck">Puck (Energetic Accent)</option>
                          <option value="Charon">Charon (Deep Monotone)</option>
                          <option value="Aoede">Aoede (Soft Lyric Accent)</option>
                          <option value="Kore">Kore (Clear Conversational Female)</option>
                          <option value="Fenrir">Fenrir (Crisp Assertive Male)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-zinc-400 mb-1">Dialogue Tone Style</label>
                        <select
                          value={voiceStyle}
                          onChange={e => setVoiceStyle(e.target.value as any)}
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
                        >
                          <option value="Creative">Creative & Associative</option>
                          <option value="Direct">Direct & Analytical</option>
                          <option value="Concise">Concise & Bullet-focused</option>
                          <option value="Explanatory">Explanatory & In-depth</option>
                        </select>
                      </div>
                    </div>

                    <div className="space-y-3 p-3 bg-white/[0.01] border border-white/5 rounded-lg">
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-zinc-400">Speaker Volume ({volume}%)</label>
                          <Volume2 className="w-3.5 h-3.5 text-zinc-500" />
                        </div>
                        <input 
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          className="w-full accent-cyan-500 bg-zinc-900 h-1.5 rounded-lg cursor-pointer"
                          value={volume} onChange={e => setVolume(Number(e.target.value))}
                        />
                      </div>

                      <div className="pt-2">
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-zinc-400">Dialogue Playback Rate ({speechSpeed}x)</label>
                          <Sliders className="w-3.5 h-3.5 text-zinc-500" />
                        </div>
                        <input 
                          type="range"
                          min="0.5"
                          max="2.0"
                          step="0.1"
                          className="w-full accent-cyan-500 bg-zinc-900 h-1.5 rounded-lg cursor-pointer"
                          value={speechSpeed} onChange={e => setSpeechSpeed(Number(e.target.value))}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-zinc-400 mb-1">Gemini Voice Model Module</label>
                      <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
                      >
                        <option value="gemini-3.1-flash-live-preview">gemini-3.1-flash-live-preview (Fastest Live Output)</option>
                        <option value="gemini-2.0-flash-exp">gemini-2.0-flash-exp (Experimental Series)</option>
                        <option value="gemini-2.5-flash">gemini-2.5-flash (Standard Medium-Fast Model)</option>
                      </select>
                    </div>

                    <div className="p-3 bg-zinc-950/50 border border-white/5 rounded-lg flex items-center justify-between">
                      <div>
                        <span className="text-zinc-300 font-bold block">Microphone Live Mute Status</span>
                        <span className="text-[10px] text-zinc-500">Mutes voice inputs instantly. Hotkey: Spacebar toggle.</span>
                      </div>
                      <button 
                        type="button"
                        onClick={() => setIsMicMuted(!isMicMuted)}
                        className={`px-3 py-1.5 rounded text-[10px] tracking-wider font-bold transition-all ${isMicMuted ? "bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30" : "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"}`}
                      >
                        {isMicMuted ? "● MUTED (LIVE SILENCE)" : "● TRANSMITTING VOICE"}
                      </button>
                    </div>
                  </div>
                )}

                {/* 2. Project Profiles & Customizable CLI Startups list */}
                {formTab === "profiles" && (
                  <div className="space-y-5">
                    <div className="border-b border-white/5 pb-2">
                      <h3 className="text-white uppercase text-[10px] tracking-widest font-bold">Workspace profiles & cli config</h3>
                      <p className="text-[10px] text-zinc-500 mt-0.5">Manage target space directories and terminal shells</p>
                    </div>

                    <div className="grid grid-cols-2 gap-4 bg-white/[0.01] p-3 rounded-lg border border-white/5">
                      <div>
                        <label className="block text-zinc-400 mb-1">Active Context Context ID</label>
                        <input 
                          type="text"
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white"
                          value={activeContext} onChange={e => setActiveContext(e.target.value)} placeholder="default_project"
                        />
                      </div>
                      <div>
                        <label className="block text-zinc-400 mb-1">Local Directory Path Reference</label>
                        <input 
                          type="text"
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white"
                          value={localWorkspacePath} onChange={e => setLocalWorkspacePath(e.target.value)} placeholder="./"
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <div>
                          <h4 className="text-zinc-300 font-bold text-xs uppercase tracking-wider">CLI startup shell profiles</h4>
                          <span className="text-[10px] text-zinc-600 block">Available shells when initializing command loops</span>
                        </div>
                        <button 
                          type="button"
                          onClick={handleAddPreset}
                          className="flex items-center gap-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 font-bold px-2 py-1 rounded text-[10px] transition-colors cursor-pointer"
                        >
                          <Plus className="w-3 h-3" />
                          Add Profile
                        </button>
                      </div>

                      <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                        {presets.map((preset) => {
                          const isDefault = ["claudeCode", "codex", "antigravity"].includes(preset.id);
                          
                          // Helper to identify terminals associated with this preset
                          const getMatchingTerminals = (p: CliPreset) => {
                            return terminals.filter(t => {
                              const termPresetLower = (t.tool_preset || "").toLowerCase();
                              const presetIdLower = p.id.toLowerCase();
                              const presetNameLower = p.name.toLowerCase();

                              if (presetIdLower === "claudecode" && termPresetLower === "claude code") return true;
                              if (presetIdLower === "codex" && termPresetLower === "codex") return true;
                              if (presetIdLower === "antigravity" && termPresetLower === "antigravity") return true;
                              if (termPresetLower === presetNameLower) return true;
                              
                              // Substring / command fallback checks
                              if (t.id.toLowerCase().includes(presetIdLower) || t.id.toLowerCase().includes(presetNameLower)) return true;
                              if (t.command.toLowerCase().includes(p.command.toLowerCase())) return true;
                              return false;
                            });
                          };

                          const matched = getMatchingTerminals(preset);
                          const numActive = matched.length;
                          const totalCpu = matched.reduce((sum, t) => sum + (t.cpu_usage || 0), 0);
                          const hasAlert = matched.some(t => pendingCommands.some(pc => pc.terminalId === t.id));

                          let statusLabel = "No Live Processes";
                          let statusBadgeStyle = "text-zinc-500 bg-zinc-950 border-zinc-800";
                          let dotColor = "bg-zinc-600";

                          if (numActive > 0) {
                            if (hasAlert) {
                              statusLabel = `▲ ALERT: AWAITING APPROVAL`;
                              statusBadgeStyle = "text-amber-400 bg-amber-500/10 border-amber-500/30 font-bold animate-pulse";
                              dotColor = "bg-amber-500 animate-ping";
                            } else if (matched.some(t => t.status === "Running")) {
                              statusLabel = `● RUNNING ACTIVE COMMAND`;
                              statusBadgeStyle = "text-green-400 bg-green-500/10 border-green-500/30 font-bold";
                              dotColor = "bg-green-500 animate-pulse";
                            } else {
                              statusLabel = `● IDLE OPERATING READY`;
                              statusBadgeStyle = "text-yellow-400 bg-yellow-500/10 border-yellow-500/20 font-bold";
                              dotColor = "bg-yellow-500";
                            }
                          }

                          return (
                            <div 
                              key={preset.id} 
                              className={`p-3 bg-black/40 border rounded-lg transition-all ${preset.enabled ? "border-cyan-500/20 bg-cyan-950/[0.01]" : "border-white/5 opacity-60"}`}
                            >
                              <div className="flex items-center gap-3 justify-between mb-2">
                                <div className="flex items-center gap-2 flex-1">
                                  <input 
                                    type="checkbox"
                                    checked={preset.enabled}
                                    onChange={e => handleUpdatePreset(preset.id, { enabled: e.target.checked })}
                                    className="rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 bg-black cursor-pointer"
                                  />
                                  <input 
                                    type="text"
                                    value={preset.name}
                                    placeholder="Shell Preset Name"
                                    disabled={isDefault}
                                    onChange={e => handleUpdatePreset(preset.id, { name: e.target.value })}
                                    className="bg-transparent border-b border-transparent hover:border-white/10 focus:border-cyan-500 text-white font-bold focus:outline-none text-xs w-full py-0.5"
                                  />
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {/* Visual status pill */}
                                  <span className={`text-[8px] px-2 py-0.5 rounded border flex items-center gap-1 font-mono uppercase tracking-widest ${statusBadgeStyle}`}>
                                    <span className={`w-1 h-1 rounded-full ${dotColor}`} />
                                    {statusLabel}
                                  </span>

                                  {numActive > 0 && (
                                    <span className="text-[8px] px-2 py-0.5 rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 font-mono font-bold flex items-center gap-1">
                                      <Cpu className="w-2.5 h-2.5" />
                                      {totalCpu.toFixed(1)}% CPU
                                    </span>
                                  )}

                                  {isDefault ? (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-sans tracking-wide">Core</span>
                                  ) : (
                                    <button 
                                      type="button"
                                      onClick={() => handleDeletePreset(preset.id)}
                                      className="p-1 hover:bg-red-500/10 rounded text-zinc-500 hover:text-red-400 transition-colors cursor-pointer"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                              </div>
                              <div className="space-y-2 mt-2">
                                <div className="flex items-center gap-2 bg-black px-2 py-1 rounded border border-white/5 font-mono text-[11px]">
                                  <Terminal className="w-3 h-3 text-cyan-500 shrink-0" />
                                  <input 
                                    type="text"
                                    value={preset.command}
                                    placeholder="Command instruction"
                                    onChange={e => handleUpdatePreset(preset.id, { command: e.target.value })}
                                    className="bg-transparent w-full focus:outline-none font-mono text-[#a3e635] text-[11px]"
                                  />
                                </div>

                                <div className="grid grid-cols-2 gap-3 text-[9px] text-zinc-400">
                                  <div>
                                    <label className="block text-[8px] uppercase tracking-wider text-zinc-500 mb-0.5">Permissions Policy</label>
                                    <select
                                      value={preset.permissionsMode || "Human-in-the-Loop"}
                                      onChange={e => handleUpdatePreset(preset.id, { permissionsMode: e.target.value as any })}
                                      className="w-full bg-black border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500 cursor-pointer"
                                    >
                                      <option value="Full Auto">Full Auto (Immediate Run)</option>
                                      <option value="Human-in-the-Loop">Human-in-the-Loop (Approval)</option>
                                      <option value="Read-Only">Read-Only</option>
                                    </select>
                                  </div>
                                  <div>
                                    <label className="block text-[8px] uppercase tracking-wider text-zinc-500 mb-0.5">Window Layout Type</label>
                                    <select
                                      value={preset.windowMode || "Standard Split-Pane"}
                                      onChange={e => handleUpdatePreset(preset.id, { windowMode: e.target.value as any })}
                                      className="w-full bg-black border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500 cursor-pointer"
                                    >
                                      <option value="Standard Split-Pane">Standard Split-Pane</option>
                                      <option value="Side Dock Panel">Side Dock Panel</option>
                                      <option value="Overlay Modal Console">Overlay Modal Console</option>
                                      <option value="Background Agent Thread">Background Agent Thread</option>
                                    </select>
                                  </div>
                                </div>

                                <div className="grid grid-cols-2 gap-3 text-[9px] text-zinc-400">
                                  <div>
                                    <label className="block text-[8px] uppercase tracking-wider text-zinc-500 mb-0.5">Visual Theme Accent</label>
                                    <select
                                      value={preset.visualTheme || "Default Green Mono"}
                                      onChange={e => handleUpdatePreset(preset.id, { visualTheme: e.target.value as any })}
                                      className="w-full bg-[#0d0d0d] border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500 cursor-pointer"
                                    >
                                      <option value="Default Green Mono">Default Green Mono</option>
                                      <option value="Cosmic Slate">Cosmic Slate (Dark Slate)</option>
                                      <option value="Crimson Warning">Crimson Warning (Vibrant Red)</option>
                                      <option value="Royal Purple">Royal Purple (Elegant Purple)</option>
                                      <option value="Amber Slop-Shield">Amber Slop-Shield (Warm Amber)</option>
                                    </select>
                                  </div>

                                  <div className="flex items-center justify-start h-full pt-3 pl-1">
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                      <input 
                                        type="checkbox"
                                        checked={!!preset.persistentRestore}
                                        onChange={e => handleUpdatePreset(preset.id, { persistentRestore: e.target.checked })}
                                        className="rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 bg-zinc-950 cursor-pointer w-3.5 h-3.5"
                                      />
                                      <div className="-mt-1">
                                        <span className="text-[9px] text-zinc-300 font-bold block leading-none">Persistent Session</span>
                                        <span className="text-[7px] text-zinc-500 font-mono block leading-none mt-1">Auto-restore on boot</span>
                                      </div>
                                    </label>
                                  </div>
                                </div>

                                {/* Startup Configuration Modifiers Setup */}
                                <div className="border border-white/5 rounded-lg bg-black/60 p-2.5 space-y-2 mt-2 font-mono text-[9px]">
                                  <div className="text-[8px] text-cyan-400 uppercase font-black tracking-widest border-b border-white/5 pb-1 flex justify-between select-none">
                                    <span>Startup Modifiers & Arguments</span>
                                    <span className="text-zinc-650 font-normal">Harness v1.0.4 Config</span>
                                  </div>

                                  <div className="grid grid-cols-2 gap-2 pt-1">
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                      <input 
                                        type="checkbox"
                                        checked={!!preset.dangerouslySkipPermissions}
                                        onChange={e => handleUpdatePreset(preset.id, { dangerouslySkipPermissions: e.target.checked })}
                                        className="rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 bg-[#0c0c0c] cursor-pointer w-3 h-3 text-cyan-500"
                                      />
                                      <div>
                                        <span className="text-[9px] text-zinc-300 font-bold block">Bypass Permissions</span>
                                        <span className="text-[7px] text-zinc-500 block -mt-0.5">--dangerously-skip-permissions</span>
                                      </div>
                                    </label>

                                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                      <input 
                                        type="checkbox"
                                        checked={preset.sessionResume !== false}
                                        onChange={e => handleUpdatePreset(preset.id, { sessionResume: e.target.checked })}
                                        className="rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 bg-[#0c0c0c] cursor-pointer w-3 h-3 text-cyan-500"
                                      />
                                      <div>
                                        <span className="text-[9px] text-zinc-300 font-bold block bg-transparent">Restore Session Frame</span>
                                        <span className="text-[7px] text-zinc-500 block -mt-0.5">--resume-previous-session</span>
                                      </div>
                                    </label>
                                  </div>

                                  <div className="grid grid-cols-2 gap-2 pt-1 text-zinc-400 select-none">
                                    <div>
                                      <label className="block text-[7.5px] uppercase tracking-wider text-zinc-500 mb-0.5">Local Port Offset</label>
                                      <input 
                                        type="text"
                                        value={preset.portOffset || ""}
                                        placeholder="e.g. 8080"
                                        onChange={e => handleUpdatePreset(preset.id, { portOffset: e.target.value })}
                                        className="w-full bg-black border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500 text-[9px] font-mono font-medium"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-[7.5px] uppercase tracking-wider text-zinc-500 mb-0.5">Injected ENV Overrides</label>
                                      <input 
                                        type="text"
                                        value={preset.customEnvVars || ""}
                                        placeholder="DEBUG=1,COLOR=true"
                                        onChange={e => handleUpdatePreset(preset.id, { customEnvVars: e.target.value })}
                                        className="w-full bg-black border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500 text-[9px] font-mono font-medium"
                                      />
                                    </div>
                                  </div>
                                </div>

                                {/* Connected subshell nodes list */}
                                {matched.length > 0 && (
                                  <div className="mt-2.5 border-t border-white/5 pt-2 space-y-1">
                                    <label className="text-[8px] uppercase tracking-wider text-zinc-500 font-bold block mb-1 font-mono">Bound Workspace Subshell Nodes</label>
                                    <div className="space-y-1 max-h-24 overflow-y-auto pr-0.5 scrollbar-thin">
                                      {matched.map(t => {
                                        const isTermAlert = pendingCommands.some(pc => pc.terminalId === t.id);
                                        return (
                                          <div key={t.id} className="flex justify-between items-center text-[9px] font-mono bg-[#090909] px-2 py-1 rounded border border-white/5">
                                            <span className="text-zinc-300 font-bold">{t.id}</span>
                                            <div className="flex items-center gap-2">
                                              <span className="text-[8px] text-zinc-500 select-none truncate max-w-[120px]">{t.cwd}</span>
                                              <span className={`w-1.5 h-1.5 rounded-full ${isTermAlert ? "bg-amber-500 animate-ping" : t.status === "Running" ? "bg-green-500 animate-pulse" : t.status === "Idle" ? "bg-yellow-500" : "bg-red-500"}`} />
                                              <span className={`text-[8px] uppercase font-bold leading-none ${isTermAlert ? "text-amber-400 animate-pulse" : t.status === "Running" ? "text-green-400" : "text-zinc-500"}`}>
                                                {isTermAlert ? "Alert / Approval Reqd" : t.status}
                                              </span>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {presets.length === 0 && (
                          <div className="p-4 text-center text-zinc-600 border border-dashed border-white/5 rounded-lg">
                            No CLI Startup Presets available. Add some using the button above.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* 3. Advanced Plumbing Section */}
                {formTab === "advanced" && (
                  <div className="space-y-4">
                    <div className="border-b border-white/5 pb-2">
                      <h3 className="text-white uppercase text-[10px] tracking-widest font-bold">Advanced Subsystems plumbing</h3>
                      <p className="text-[10px] text-zinc-500 mt-0.5">Control live transmission pipelines, timeouts, and buffers</p>
                    </div>

                    <div>
                      <label className="block text-zinc-400 mb-1">Physical WebSocket Connection Override URL</label>
                      <input 
                        type="text"
                        className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white placeholder:text-zinc-700"
                        value={webSocketUrl} onChange={e => setWebSocketUrl(e.target.value)} placeholder="wss://api.gemini.direct/v1/live (Falls back to default SDK matrix)"
                      />
                      <span className="text-[9px] text-zinc-600 mt-1 block leading-relaxed">Let blank to trigger Google GenAI SDK standard pipe routers.</span>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-zinc-400 mb-1">Latency Delivery Target</label>
                        <select
                          value={latencyMode}
                          onChange={e => setLatencyMode(e.target.value as any)}
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white focus:outline-none cursor-pointer"
                        >
                          <option value="Balanced">Balanced (Standard Sync)</option>
                          <option value="Low Latency">Low Latency (Micro-Buffer-Burst)</option>
                          <option value="High Throughput">High Throughput (Stable Volumes)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-zinc-400 mb-1">Audio PCM Frame Size (Bytes)</label>
                        <select
                          value={audioBufferSize}
                          onChange={e => setAudioBufferSize(Number(e.target.value))}
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white focus:outline-none cursor-pointer"
                        >
                          <option value="512">512 Bytes (Fast Trigger)</option>
                          <option value="1024">1024 Bytes (Standard Block)</option>
                          <option value="2048">2048 Bytes (Large Delay)</option>
                          <option value="4096">4096 Bytes (High Latency Audio)</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-zinc-400 mb-1">Rate Limit Cap (RPM)</label>
                        <input 
                          type="number"
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white"
                          value={rateLimitRequestsPerMin} onChange={e => setRateLimitRequestsPerMin(Number(e.target.value))} placeholder="60"
                        />
                      </div>
                      <div>
                        <label className="block text-zinc-400 mb-1">Idle Terminal Timeout (ms)</label>
                        <input 
                          type="number"
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white"
                          value={idleTimeoutMs} onChange={e => setIdleTimeoutMs(Number(e.target.value))} placeholder="2000"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-zinc-400 mb-1">Max Console Cache Buffer Lines</label>
                        <input 
                          type="number"
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white"
                          value={maxBufferLines} onChange={e => setMaxBufferLines(Number(e.target.value))} placeholder="100"
                        />
                      </div>
                      <div>
                        <label className="block text-zinc-400 mb-1">Fallback Host Terminal Shell</label>
                        <input 
                          type="text"
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white"
                          value={defaultShellCommand} onChange={e => setDefaultShellCommand(e.target.value)} placeholder="bash"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-zinc-400 mb-1">Live Feed Throughput volume ({throughputBps} Bps)</label>
                      <input 
                        type="range"
                        min="8000"
                        max="48000"
                        step="8000"
                        className="w-full accent-cyan-500 bg-zinc-900 h-1.5 rounded-lg cursor-pointer"
                        value={throughputBps} onChange={e => setThroughputBps(Number(e.target.value))}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-zinc-400 mb-1">Global Permissions Gate Policy</label>
                        <select
                          value={globalPermissionsMode}
                          onChange={e => setGlobalPermissionsMode(e.target.value as any)}
                          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white cursor-pointer"
                        >
                          <option value="Inherit">Inherit Parent Node Settings</option>
                          <option value="Full Auto">Full Auto (Immediate Run)</option>
                          <option value="Human-in-the-Loop">Human-in-the-Loop (Always Ask)</option>
                          <option value="Read-Only">Read-Only (Lock Execution Output)</option>
                        </select>
                      </div>

                      <div className="flex flex-col justify-end">
                        <label className="flex items-center gap-2 cursor-pointer p-2 bg-zinc-950/40 border border-white/5 rounded-lg">
                          <input 
                            type="checkbox"
                            checked={debugLogging}
                            onChange={e => setDebugLogging(e.target.checked)}
                            className="rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 bg-black"
                          />
                          <div>
                            <span className="text-[11px] text-zinc-300 font-bold block">Console debug stream logging</span>
                            <span className="text-[9px] text-zinc-500">Log websocket payloads in console</span>
                          </div>
                        </label>
                      </div>
                    </div>
                  </div>
                )}

                {/* 4. Secrets Cabinet (Sensitive Key Cabinet) */}
                {formTab === "secrets" && (
                  <div className="space-y-4">
                    <div className="border-b border-red-500/10 pb-2">
                      <h3 className="text-rose-400 uppercase text-[10px] tracking-widest font-bold">Secrets Key Cabinet</h3>
                      <p className="text-[10px] text-zinc-500 mt-0.5">Sensitive credentials used exclusively for remote connections</p>
                    </div>

                    <div className="p-3 bg-zinc-950 border border-white/5 rounded-lg space-y-3">
                      <div>
                        <label className="block text-zinc-400 mb-1 flex justify-between items-center">
                          <span>Google Gemini API Key Secret Token</span>
                          <span className="text-[9px] text-zinc-500 uppercase tracking-widest">Live voice stream only</span>
                        </label>
                        <div className="relative flex items-center">
                          <input 
                            type={showApiKey ? "text" : "password"}
                            value={geminiApiKey}
                            onChange={e => setGeminiApiKey(e.target.value)}
                            placeholder={geminiApiKey ? "CONCURRENTLY CONFIGURED KEY" : "No token key loaded. Enter your AI Studio Key."}
                            className="w-full bg-black border border-white/10 rounded pl-3 pr-10 py-1.5 font-mono text-[11px] text-cyan-400 focus:outline-none focus:border-cyan-500"
                          />
                          <button 
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="absolute right-2 text-zinc-500 hover:text-white transition-colors cursor-pointer"
                          >
                            {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="bg-red-950/10 border border-red-900/30 rounded-lg p-4 flex gap-3 text-red-300">
                      <AlertCircle className="w-5 h-5 shrink-0 text-red-400" />
                      <div className="font-sans text-[11px] leading-relaxed space-y-1">
                        <span className="font-mono text-xs font-bold block text-red-200 uppercase tracking-widest">Offline Python Integrity Guard</span>
                        <p>
                          Your CLI startup commands, folder trees, and local subshells run with raw subprocess Python execution. They are strictly local and **do not require any API keys or tokens**.
                        </p>
                        <p className="text-zinc-500">
                          This Gemini Key is used **solely** to boot the real-time audio/voice stream interface directly in this iframe.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

              </div>
            </div>
          )}

          {/* TAB 2: INTERACTIVE RAW CONFIG JSON EDITOR */}
          {activeTab === "json" && (
            <div className="flex flex-col gap-3 h-full p-6 overflow-hidden">
              <div className="flex justify-between items-center bg-black/40 px-3 py-2 border border-white/5 rounded-lg shrink-0 text-[10px] text-zinc-400">
                <span className="flex items-center gap-1.5 font-sans">
                  <AlertCircle className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  Configurations compile directly to `.janus_settings.json`. Parameters are fully bidirectionally synced.
                </span>
                <div className="flex gap-2">
                  <button 
                    onClick={handleCopyConfig}
                    className="flex bg-cyan-950 text-cyan-400 hover:bg-cyan-900 border border-cyan-800 rounded px-2 py-0.5 items-center gap-1 cursor-pointer transition text-[9px] font-bold"
                  >
                    {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {isCopied ? "COPIED" : "COPY RAW"}
                  </button>
                </div>
              </div>

              {/* Text Area */}
              <div className="flex-1 relative flex flex-col min-h-0">
                <textarea 
                  className="w-full flex-1 bg-black text-[#84cc16] border border-white/10 rounded-lg p-4 font-mono text-[11px] leading-relaxed resize-none focus:outline-none focus:border-cyan-500/50"
                  spellCheck="false"
                  value={rawJsonStr}
                  onChange={e => handleJsonChange(e.target.value)}
                />
              </div>

              {/* Validation Feedback */}
              {jsonValidationError ? (
                <div className="p-2.5 bg-red-950/20 border border-red-950 text-red-400 rounded-lg text-[10px] flex gap-2 items-start leading-relaxed shrink-0">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">JSON Syntax Validation Error:</span>
                    <pre className="mt-1 font-mono text-[9px] bg-red-950/40 p-1 rounded whitespace-pre-wrap">{jsonValidationError}</pre>
                  </div>
                </div>
              ) : (
                <div className="p-2.5 bg-green-950/10 border border-green-900/30 text-green-400 rounded-lg text-[10px] flex items-center gap-1.5 shrink-0 font-sans">
                  <Check className="w-4 h-4" />
                  <span>Config parameters validated and formatted successfully! Click 'Apply Settings' to trigger update.</span>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: LOCAL INSTALLATION GUIDE & CONFIGURATION TOOLS */}
          {activeTab === "install" && (
            <div className="p-6 space-y-6 max-w-2xl mx-auto overflow-y-auto h-full">
              <div>
                <h3 className="text-white font-bold text-sm mb-2 flex items-center gap-2">
                  <Server className="w-4 h-4 text-cyan-400" />
                  Local Installation Config Setup
                </h3>
                <p className="text-zinc-400 font-sans leading-relaxed text-xs">
                  Project Janus operates with client-side audio streaming pipelines and backend terminal process integrations. Place your keys securely in your environment variables or local configs.
                </p>
              </div>

              {/* Setup Actions */}
              <div className="grid grid-cols-2 gap-4">
                <div className="border border-white/10 bg-white/[0.01] rounded-lg p-5 flex flex-col justify-between hover:border-cyan-500/30 transition-all">
                  <div>
                    <h4 className="text-white text-xs font-bold mb-1 flex items-center gap-1">
                      <Download className="w-3.5 h-3.5 text-cyan-400" /> Download Config File
                    </h4>
                    <p className="text-[10px] text-zinc-500 font-sans leading-relaxed">
                      Download the current configurations as a standalone JSON to seed new project directories instantly.
                    </p>
                  </div>
                  <button 
                    onClick={handleDownloadConfig}
                    className="w-full mt-4 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/40 rounded text-[10px] tracking-wider uppercase font-bold cursor-pointer"
                  >
                    Download janus-config.json
                  </button>
                </div>

                <div className="border border-white/10 bg-white/[0.01] rounded-lg p-5 flex flex-col justify-between hover:border-cyan-500/30 transition-all">
                  <div>
                    <h4 className="text-white text-xs font-bold mb-1 flex items-center gap-1">
                      <Upload className="w-3.5 h-3.5 text-cyan-400" /> Upload Parameters JSON
                    </h4>
                    <p className="text-[10px] text-zinc-500 font-sans leading-relaxed">
                      Restore parameters or restore developer presets instantly by importing an existing JSON file.
                    </p>
                  </div>
                  <div className="relative mt-4">
                    <input 
                      type="file" 
                      accept=".json" 
                      onChange={handleUploadConfig}
                      className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                    />
                    <button 
                      type="button"
                      className="w-full py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-white/10 hover:border-white/20 rounded text-[10px] tracking-wider uppercase font-bold"
                    >
                      Choose JSON File
                    </button>
                  </div>
                </div>
              </div>

              {/* Code Snippet Guidance */}
              <div className="bg-black/40 border border-white/5 rounded-lg p-4 font-mono text-[10px] leading-relaxed space-y-2">
                <span className="text-zinc-400 uppercase tracking-widest text-[9px] block">Quick Start (Local Run)</span>
                <p className="text-zinc-500 font-sans">To seed a local environment, place the downloaded file as <code className="text-[#a3e635] bg-black px-1 py-0.5 rounded">.janus_settings.json</code> in this project's root folder and run:</p>
                <div className="bg-black p-3 rounded font-mono text-[#a3e635] border border-white/5 whitespace-pre leading-relaxed">
                  {`# Install dependencies\n$ npm install\n\n# Launch backend on port 3000\n$ npm run dev`}
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 bg-white/[0.02] border-t border-white/10 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
            <HelpCircle className="w-4 h-4 text-zinc-600" />
            <span className="font-sans">Configuration protocol version v1.2.0</span>
          </div>
          <div className="flex gap-3">
            <button 
              onClick={onClose} 
              className="px-4 py-2 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button 
              onClick={() => handleSave()}
              disabled={!isFormValid || isSaving}
              className="px-5 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 hover:text-cyan-300 border border-cyan-500/30 hover:border-cyan-500/50 rounded font-bold transition-colors shadow-md shadow-cyan-500/5 disabled:opacity-40 cursor-pointer"
            >
              {isSaving ? "Saving..." : "Apply Settings"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
