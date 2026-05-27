import { useEffect, useState, useRef } from "react";
import { Terminal, PendingCommand } from "./types";
import { pcmToBase64, playAudioChunk, resetAudioPlayback } from "./utils/audio";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { CreateTerminalDialog } from "./components/CreateTerminalDialog";
import { Mic, MicOff } from "lucide-react";

export default function App() {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const fetchTerminals = async () => {
    try {
      const res = await fetch("/api/terminals");
      if (!res.ok) return;
      const data = await res.json();
      setTerminals(data);
      if (data.length > 0 && !activeTerminalId) {
        setActiveTerminalId(data[0].id);
      }
    } catch (e) {
      // Silent catch to prevent 'Failed to fetch' console errors during server restarts
    }
  };

  useEffect(() => {
    fetchTerminals();
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

  const handleCreateTerminal = async (id: string, cwd: string, cmd: string) => {
    try {
      await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminalId: id, cwd, command: cmd })
      });
      setShowCreateModal(false);
      fetchTerminals();
      setActiveTerminalId(id);
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
          if (ws.readyState === WebSocket.OPEN && !isMicMuted) {
            const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
            ws.send(JSON.stringify({ type: "audio", audio: base64 }));
          }
        };
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
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

  return (
    <div className="flex flex-col h-screen w-full bg-[#050505] text-[#e0e0e0] font-sans overflow-hidden border-t-4 border-[#1a1a1a]">
      {showCreateModal && (
        <CreateTerminalDialog 
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateTerminal}
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

      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-black/40 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full ${isLive ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-600'}`}></div>
          <h1 className="font-serif italic text-xl tracking-wide text-white">Orbital Harness <span className="text-xs font-mono font-normal opacity-40 ml-2">v1.0.4-live</span></h1>
        </div>
        
        <div className="flex items-center gap-6">
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
                    className={`text-xs font-mono uppercase transition-colors focus:outline-none ${isMicMuted ? "text-amber-400" : "text-cyan-400 opacity-80 hover:opacity-100"}`}
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
        </div>
      </header>

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <nav className="w-64 border-r border-white/5 bg-black/20 flex flex-col overflow-y-auto">
          <div className="p-4">
            <h2 className="text-[10px] font-mono uppercase opacity-40 tracking-[0.2em] mb-4">Active Nodes</h2>
            <div className="space-y-2">
              {terminals.map((term, i) => {
                const isActive = activeTerminalId === term.id;
                let statusColor = "bg-zinc-600";
                if (term.status === "Running") {
                  statusColor = "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse";
                } else if (term.status === "Idle") {
                  statusColor = "bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.6)]";
                } else if (term.status === "Exited") {
                  statusColor = "bg-red-500";
                }

                return (
                  <div 
                    key={term.id}
                    onClick={() => setActiveTerminalId(term.id)}
                    className={`group cursor-pointer p-3 rounded transition-colors ${isActive ? 'bg-white/5 border border-white/10' : 'border border-white/5 hover:bg-white/5'}`}
                  >
                    <div className="flex justify-between items-center mb-1">
                      <span className={`text-xs font-mono truncate ${isActive ? 'font-bold text-cyan-400' : 'opacity-80'}`}>
                        #{String(i + 1).padStart(2, '0')} {term.id}
                      </span>
                      <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${statusColor}`} title={`Status: ${term.status || 'Unknown'}`}></span>
                    </div>
                    <div className="text-[10px] opacity-40 font-mono italic truncate" title={term.cwd}>{term.cwd}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-auto p-4 border-t border-white/5 space-y-3">
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

        {/* Center Content: Main Terminal Output */}
        <section className="flex-1 flex flex-col bg-black/40 min-w-0">
          {activeTerminal ? (
            <>
              <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/5 shadow-sm">
                <div className="flex gap-2 items-center overflow-hidden">
                  <span className="text-[10px] font-mono px-2 py-0.5 bg-cyan-400/20 text-cyan-400 rounded shrink-0">T{terminals.findIndex(t => t.id === activeTerminalId) + 1}: {activeTerminal.id}</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 opacity-40 truncate" title={activeTerminal.command}>$ {activeTerminal.command}</span>
                </div>
                <span className="text-[10px] font-mono opacity-40 shrink-0 ml-4 pt-1 truncate" title={activeTerminal.cwd}>{activeTerminal.cwd}</span>
              </div>
              <div className="flex-1 p-6 font-mono text-sm overflow-y-auto text-[#a0a0a0] leading-relaxed">
                <pre className="whitespace-pre-wrap break-all break-words">{activeTerminal.output}</pre>
                <div className="mt-2 text-white/40 animate-pulse">_</div>
              </div>
            </>
          ) : (
             <div className="flex-1 flex items-center justify-center bg-black/20">
               <div className="text-[10px] font-mono uppercase opacity-40 tracking-[0.2em] border border-dashed border-white/10 p-6 rounded">
                 No active nodes. Voice command required.
               </div>
             </div>
          )}
        </section>
      </main>

      {/* System Bar */}
      <div className="bg-black border-t border-white/10 px-6 py-2 flex justify-between items-center shrink-0">
        <div className="flex gap-6">
          <span className="text-[10px] font-mono opacity-30">UPTIME: ACTIVE</span>
          <span className="text-[10px] font-mono opacity-30">TOKEN USE: LIGHT MODE</span>
        </div>
        <div className="flex gap-4">
          <span className="text-[10px] font-mono text-cyan-400">[SYSTEM ACTIVE]</span>
          <span className="text-[10px] font-mono opacity-30 uppercase tracking-tighter italic font-bold">Orbital Harness v1.0.4</span>
        </div>
      </div>
    </div>
  );
}

