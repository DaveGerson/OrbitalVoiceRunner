// src/classic/components/MobileNavBar.tsx — the classic (?ui=classic) mobile sticky bottom
// navigation bar, extracted VERBATIM out of src/App.tsx (App.tsx decomposition into src/classic/,
// chunk-1 "warmup leaves"). Was a `{(() => ( <div ...> ... </div> ))()}` render-closure IIFE in
// AppRaw: a touch-friendly bar with three tabs (Terminal / Sync Buffer / Projects) that switch
// `mobileActiveView`, plus a pulse badge on the Sync Buffer tab gated on promptBuffer.length. Pure
// leaf: no hooks, no state. DOM is byte-identical. Lucide icons stay module imports here.

import * as React from "react";
import { Terminal as TermIcon, CheckSquare, Layers } from "lucide-react";

export function MobileNavBar({
  mobileActiveView,
  setMobileActiveView,
  promptBuffer,
}: {
  mobileActiveView: "terminal" | "buffer" | "menu";
  setMobileActiveView: (next: "terminal" | "buffer" | "menu") => void;
  promptBuffer: string;
}) {
  return (
    <div className="lg:hidden shrink-0 h-16 bg-black border-t border-white/10 flex items-center justify-around px-2 z-20 select-none">
      <button
        onClick={() => setMobileActiveView("terminal")}
        className={`flex-1 py-1 flex flex-col items-center justify-center gap-1 transition-colors focus:outline-none ${mobileActiveView === "terminal" ? "text-cyan-400 font-extrabold" : "text-zinc-500 hover:text-zinc-300"}`}
      >
        <TermIcon className="w-4 h-4" />
        <span className="text-xs font-mono uppercase tracking-wider">Terminal</span>
      </button>
      <button
        onClick={() => setMobileActiveView("buffer")}
        className={`flex-1 py-1 flex flex-col items-center justify-center gap-1 relative transition-colors focus:outline-none ${mobileActiveView === "buffer" ? "text-cyan-400 font-extrabold" : "text-zinc-500 hover:text-zinc-300"}`}
      >
        <CheckSquare className="w-4 h-4" />
        <span className="text-xs font-mono uppercase tracking-wider">Sync Buffer</span>
        {promptBuffer.length > 0 && (
          <span className="absolute top-2.5 right-8 w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse"></span>
        )}
      </button>
      <button
        onClick={() => setMobileActiveView("menu")}
        className={`flex-1 py-1 flex flex-col items-center justify-center gap-1 transition-colors focus:outline-none ${mobileActiveView === "menu" ? "text-cyan-400 font-extrabold" : "text-zinc-500 hover:text-zinc-300"}`}
      >
        <Layers className="w-4 h-4" />
        <span className="text-xs font-mono uppercase tracking-wider">Projects</span>
      </button>
    </div>
  );
}
