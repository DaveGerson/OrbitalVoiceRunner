import { useEffect } from "react";

export function ApprovalDialog({ 
  messageId, 
  terminalId, 
  cmd, 
  onApprove, 
  onReject 
}: { 
  messageId: string; 
  terminalId: string; 
  cmd: string; 
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onApprove(messageId);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onReject(messageId);
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [messageId, onApprove, onReject]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm">
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-[600px] bg-[#111] border-2 border-amber-500/50 rounded-xl p-6 shadow-2xl shadow-black/80 animate-in slide-in-from-bottom-10 fade-in duration-300">
        <div className="flex items-start gap-5">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/50 flex items-center justify-center">
            <span className="text-amber-500 font-bold text-xl">!</span>
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-amber-500">Proposed Command Execution</h3>
              <span className="text-[10px] font-mono opacity-40">Target: {terminalId}</span>
            </div>
            <p className="text-sm font-mono text-white/90 bg-black/40 p-2 rounded border border-white/5 mb-4 break-all">
              {cmd}
            </p>
            <div className="flex gap-3">
              <button 
                onClick={() => onApprove(messageId)}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 text-black text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                Confirm & Fire [Enter]
              </button>
              <button 
                onClick={() => onReject(messageId)}
                className="px-6 py-2 border border-white/10 hover:bg-white/5 text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-white/20"
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
