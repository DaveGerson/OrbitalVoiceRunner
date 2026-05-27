import { useState } from "react";

export function CreateTerminalDialog({
  onClose,
  onCreate
}: {
  onClose: () => void;
  onCreate: (terminalId: string, cwd: string, command: string) => Promise<void>;
}) {
  const [id, setId] = useState("");
  const [cwd, setCwd] = useState(".");
  const [cmd, setCmd] = useState(process.platform === "win32" ? "cmd.exe" : "bash");

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-[#111] border border-white/10 p-6 rounded-xl w-full max-w-sm shadow-2xl animate-in zoom-in-95 duration-200">
        <h2 className="text-sm font-mono text-white mb-4 uppercase tracking-widest border-b border-white/10 pb-2">Create New Node</h2>
        
        <div className="space-y-4 font-mono text-xs">
          <div>
            <label className="block text-zinc-500 mb-1">Terminal ID</label>
            <input 
              autoFocus
              className="w-full bg-black border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors"
              value={id} onChange={e => setId(e.target.value)} placeholder="my-service" 
            />
          </div>
          <div>
            <label className="block text-zinc-500 mb-1">Working Directory</label>
            <input 
              className="w-full bg-black border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors"
              value={cwd} onChange={e => setCwd(e.target.value)} placeholder="./" 
            />
          </div>
          <div>
            <label className="block text-zinc-500 mb-1">Startup Command</label>
            <input 
              className="w-full bg-black border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors"
              value={cmd} onChange={e => setCmd(e.target.value)} placeholder="npm run dev" 
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-xs font-mono text-zinc-400 hover:text-white transition-colors focus:outline-none focus:ring-1 focus:ring-white/20 rounded">Cancel</button>
          <button 
            onClick={() => {
              if (id && cwd && cmd) onCreate(id, cwd, cmd);
            }}
            disabled={!id || !cwd || !cmd}
            className="px-4 py-2 text-xs font-mono bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border border-cyan-500/50 rounded transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-cyan-500"
          >
            Launch Node
          </button>
        </div>
      </div>
    </div>
  );
}
