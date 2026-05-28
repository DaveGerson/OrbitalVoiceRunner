import { useState, useEffect } from "react";

export function CreateTerminalDialog({
  onClose,
  onCreate
}: {
  onClose: () => void;
  onCreate: (
    terminalId: string,
    cwd: string,
    command: string,
    toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom",
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only"
  ) => Promise<void>;
}) {
  const [id, setId] = useState("");
  const [cwd, setCwd] = useState(".");
  const [toolPreset, setToolPreset] = useState<"Claude Code" | "Codex" | "Antigravity" | "Custom">("Claude Code");
  const [permissionsMode, setPermissionsMode] = useState<"Full Auto" | "Human-in-the-Loop" | "Read-Only">("Human-in-the-Loop");
  const [cmd, setCmd] = useState("npx @anthropic-ai/claude");

  // Modern Startup Config Modifiers state
  const [dangerouslySkipPermissions, setDangerouslySkipPermissions] = useState(false);
  const [sessionResume, setSessionResume] = useState(true);
  const [customEnvVars, setCustomEnvVars] = useState("");
  const [portOffset, setPortOffset] = useState("");
  const [showModifiers, setShowModifiers] = useState(true);

  useEffect(() => {
    let baseCmd = "";
    if (toolPreset === "Claude Code") {
      baseCmd = "npx @anthropic-ai/claude";
    } else if (toolPreset === "Codex") {
      baseCmd = "npx codex-cli";
    } else if (toolPreset === "Antigravity") {
      baseCmd = "npx antigravity";
    } else {
      baseCmd = process.platform === "win32" ? "cmd.exe" : "bash";
    }

    const flags: string[] = [];
    if (dangerouslySkipPermissions || (toolPreset !== "Custom" && permissionsMode === "Full Auto")) {
      flags.push("--dangerously-skip-permissions");
    }
    if (sessionResume) {
      flags.push("--resume-previous-session");
      flags.push("--with-open-textbox");
    }
    if (portOffset) {
      flags.push(`--port-offset=${portOffset}`);
    }
    if (customEnvVars) {
      flags.push(`--env="${customEnvVars}"`);
    }

    if (flags.length > 0) {
      baseCmd = `${baseCmd} ${flags.join(" ")}`;
    }
    setCmd(baseCmd);
  }, [toolPreset, permissionsMode, dangerouslySkipPermissions, sessionResume, portOffset, customEnvVars]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-[#111] border border-white/10 p-6 rounded-xl w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto">
        <h2 className="text-xs font-mono text-white mb-4 uppercase tracking-widest border-b border-white/10 pb-2 flex justify-between items-center">
          <span>Create New Node Unit</span>
          <span className="text-[10px] text-zinc-500 font-normal">Harness v1.0.4</span>
        </h2>
        
        <div className="space-y-4 font-mono text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-500 mb-1">Terminal ID</label>
              <input 
                autoFocus
                className="w-full bg-black border border-white/10 rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-cyan-500 transition-colors"
                value={id} onChange={e => setId(e.target.value.trim())} placeholder="my-service" 
              />
            </div>
            <div>
              <label className="block text-zinc-500 mb-1">Tool Preset</label>
              <select
                value={toolPreset}
                onChange={e => setToolPreset(e.target.value as any)}
                className="w-full bg-black border border-white/10 rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer"
              >
                <option value="Claude Code">Claude Code</option>
                <option value="Codex">Codex</option>
                <option value="Antigravity">Antigravity</option>
                <option value="Custom">Custom Shell</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-500 mb-1">Permissions Mode</label>
              <select
                value={permissionsMode}
                onChange={e => setPermissionsMode(e.target.value as any)}
                className="w-full bg-black border border-white/10 rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer"
              >
                <option value="Full Auto">Full Auto (Voice/AI Submits Commands Automatically)</option>
                <option value="Human-in-the-Loop">Human-in-the-Loop (Require User Approval to Execute)</option>
                <option value="Read-Only">Read-Only (Terminal output only, no submissions)</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-500 mb-1">Working Directory</label>
              <input 
                className="w-full bg-black border border-white/10 rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-cyan-500 transition-colors"
                value={cwd} onChange={e => setCwd(e.target.value)} placeholder="./" 
              />
            </div>
          </div>

          {/* Collapsible/Detail configuration card for Modifiers & Startup options */}
          <div className="border border-white/5 rounded-lg bg-black/[0.15] p-3.5 space-y-3">
            <button 
              type="button" 
              onClick={() => setShowModifiers(!showModifiers)}
              className="w-full flex justify-between items-center text-[10px] uppercase font-bold text-cyan-400 select-none tracking-widest focus:outline-none"
            >
              <span>Startup Modifiers & Options</span>
              <span className="text-zinc-500 text-[9px]">{showModifiers ? "[HIDE]" : "[SHOW & EDIT]"}</span>
            </button>

            {showModifiers && (
              <div className="space-y-3.5 pt-2 border-t border-white/5 animate-in fade-in duration-300">
                <div className="grid grid-cols-2 gap-4">
                  <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input 
                      type="checkbox"
                      checked={dangerouslySkipPermissions || permissionsMode === "Full Auto"}
                      onChange={e => setDangerouslySkipPermissions(e.target.checked)}
                      disabled={permissionsMode === "Full Auto"}
                      className="mt-0.5 rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 bg-black cursor-pointer"
                    />
                    <div className="flex flex-col">
                      <span className="text-[10px] text-zinc-200 font-bold leading-tight">Danger Skip Permissions</span>
                      <span className="text-[8px] text-zinc-500 mt-0.5">Appends --dangerously-skip-permissions to bypass all checks</span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input 
                      type="checkbox"
                      checked={sessionResume}
                      onChange={e => setSessionResume(e.target.checked)}
                      className="mt-0.5 rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 bg-black cursor-pointer"
                    />
                    <div className="flex flex-col">
                      <span className="text-[10px] text-zinc-200 font-bold leading-tight">Session Resume</span>
                      <span className="text-[8px] text-zinc-500 mt-0.5">Resume buffer automatically with an open terminal text box</span>
                    </div>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] text-zinc-500 mb-0.5">Custom Env Variables</label>
                    <input 
                      type="text"
                      className="w-full bg-black border border-white/10 rounded px-2 py-1 text-white text-[10px] focus:outline-none focus:border-cyan-500"
                      value={customEnvVars} 
                      onChange={e => setCustomEnvVars(e.target.value)} 
                      placeholder="DEBUG=1,COLOR=true" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-500 mb-0.5">Node Port Offset</label>
                    <input 
                      type="text"
                      className="w-full bg-black border border-white/10 rounded px-2 py-1 text-white text-[10px] focus:outline-none focus:border-cyan-500"
                      value={portOffset} 
                      onChange={e => setPortOffset(e.target.value)} 
                      placeholder="e.g. 8080" 
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-zinc-500 mb-1">Resulting Command Executed</label>
            <div className="w-full bg-zinc-950 border border-white/10 p-2.5 rounded text-green-400 font-mono text-[10px] break-all select-all leading-relaxed whitespace-pre-wrap">
              {cmd}
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3 border-t border-white/5 pt-4">
          <button onClick={onClose} className="px-4 py-1.5 text-xs font-mono text-zinc-400 hover:text-white transition-colors focus:outline-none rounded">Cancel</button>
          <button 
            onClick={() => {
              if (id && cwd && cmd) onCreate(id, cwd, cmd, toolPreset, permissionsMode);
            }}
            disabled={!id || !cwd || !cmd}
            className="px-4 py-1.5 text-xs font-mono bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border border-cyan-500/50 rounded transition-all disabled:opacity-40 focus:outline-none"
          >
            Deploy Node Unit
          </button>
        </div>
      </div>
    </div>
  );
}
