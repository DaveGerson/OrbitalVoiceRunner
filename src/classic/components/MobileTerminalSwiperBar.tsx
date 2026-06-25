// src/classic/components/MobileTerminalSwiperBar.tsx — the classic (?ui=classic) "Mobile Terminals
// Quick Swiper Bar", extracted VERBATIM out of src/App.tsx (App.tsx decomposition into src/classic/,
// chunk-4 "sidebar-swiper", section 1). Was an inline `lg:hidden` flex bar with a GRID VIEW button +
// `terminals.map(term => pill)`. DOM is byte-identical. mobileSwiperColorClass / mobileSwiperDotClass
// stay module imports (the pure color/dot ladders), NOT threaded as props. setActiveTerminalId is the
// SAME harness-wired callback ref passed straight through. The per-term isAlertActive/isActive/colorClass
// derivations stay inline verbatim.

import * as React from "react";
import { Terminal, PendingCommand } from "../../types";
import { mobileSwiperColorClass, mobileSwiperDotClass } from "../../appHelpers";

export function MobileTerminalSwiperBar({
  activeTerminalId,
  terminals,
  pendingCommands,
  setActiveTerminalId,
  setMobileActiveView,
}: {
  activeTerminalId: string | null;
  terminals: Terminal[];
  pendingCommands: PendingCommand[];
  setActiveTerminalId: (id: string | null) => void;
  setMobileActiveView: (view: "terminal" | "buffer" | "menu") => void;
}) {
  return (
    <div className="lg:hidden flex items-center gap-2 overflow-x-auto px-4 py-2 border-b border-white/5 bg-black/80 scrollbar-none shrink-0 select-none">
      <button
        onClick={() => {
          setActiveTerminalId(null);
          setMobileActiveView("terminal");
        }}
        className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-mono border transition-all ${
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
        // Burndown: the color-class ladder is the pure derivation `mobileSwiperColorClass`
        // (alert > active > quiescing > running > idle > default — same precedence).
        const colorClass = mobileSwiperColorClass(isAlertActive, isActive, term);
        return (
          <button
            key={term.id}
            onClick={() => {
              setActiveTerminalId(term.id);
              setMobileActiveView("terminal");
            }}
            className={`flex-shrink-0 px-3.5 py-1.5 rounded-full text-xs font-mono border flex items-center gap-1.5 transition-all ${colorClass}`}
          >
            {/* Burndown: the inner-dot color ladder is the pure helper `mobileSwiperDotClass`. */}
            <span className={`w-1.5 h-1.5 rounded-full ${mobileSwiperDotClass(isAlertActive, term)}`}></span>
            {(term.id).toUpperCase()}
          </button>
        )
      })}
    </div>
  );
}
