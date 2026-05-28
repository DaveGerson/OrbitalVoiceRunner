import { useEffect } from "react";

export function ApprovalDialog({ 
  messageId, 
  terminalId, 
  cmd, 
  rationale,
  onApprove, 
  onReject 
}: { 
  key?: string;
  messageId: string; 
  terminalId: string; 
  cmd: string; 
  rationale?: {
    trigger: string;
    summary: string;
  };
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onReject(messageId);
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [messageId, onReject]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-[620px] bg-[#111] border-2 border-amber-500/50 rounded-xl p-6 shadow-2xl shadow-black/80 animate-in slide-in-from-bottom-10 fade-in duration-300">
        <div className="flex items-start gap-5">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/50 flex items-center justify-center">
            <span className="text-amber-500 font-bold text-xl">!</span>
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-[#d97706]">Proposed Command Execution</h3>
              <span className="text-[10px] font-mono opacity-40">Target: {terminalId}</span>
            </div>
            
            <p className="text-sm font-mono text-white/90 bg-black/40 p-2 rounded border border-white/5 mb-4 break-all">
              {cmd}
            </p>

            {rationale && (
              <div className="mb-4 space-y-2 border-l-2 border-zinc-700 pl-3">
                <div className="text-[10px] font-mono">
                  <span className="text-zinc-500 uppercase tracking-wider block font-bold">Heard trigger / context</span>
                  <span className="text-zinc-300 italic">"{rationale.trigger}"</span>
                </div>
                <div className="text-[10px] font-mono">
                  <span className="text-zinc-500 uppercase tracking-wider block font-bold">Proposed rationale / summary</span>
                  <pre className="text-[9.5px] bg-black/30 p-1.5 rounded border border-white/5 text-zinc-400 whitespace-pre-wrap max-h-24 overflow-y-auto">
                     {rationale.summary}
                  </pre>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button 
                onClick={() => onApprove(messageId)}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 text-black text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                Confirm & Fire
              </button>
              <button 
                onClick={() => onReject(messageId)}
                autoFocus
                className="px-6 py-2 border border-red-500/30 bg-red-950/10 hover:bg-red-900/20 text-red-400 text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                Reject [Esc]
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
