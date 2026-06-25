// src/classic/components/SystemStatusBar.tsx — the bottom system bar (UPTIME / cumulative context
// readout / "[CORE CLOUD SYSTEMS ONLINE]" / "Orbital Harness v1.0.4"), extracted VERBATIM out of
// src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, chunk-3 "telemetry-voice-transcript").
// Mirrors the src/classic/components/ seam.
//
// NOTE: the "Orbital Harness v1.0.4-live" string near the App HEADER brand is a DIFFERENT element —
// this leaf is only the bottom status bar. Trivial leaf, no harness coupling. formatCharCountLower /
// formatTokenCount stay module imports; only the two derived totals are threaded as props. JSX
// order/className strings are unchanged.

import * as React from "react";
import { formatCharCountLower, formatTokenCount } from "../../appHelpers";

export function SystemStatusBar({
  totalContextSize,
  totalTokensEstimated,
}: {
  totalContextSize: number;
  totalTokensEstimated: number;
}) {
  return (
    <div className="bg-black border-t border-white/5 px-6 py-2 flex justify-between items-center shrink-0">
      <div className="flex gap-6">
        <span className="text-xs font-mono opacity-30">UPTIME: ACTIVE DETECTED</span>
        <span className="text-xs font-mono text-cyan-400 font-bold tracking-wider">
          CUMULATIVE CONTEXT SIZE: {formatCharCountLower(totalContextSize)} (~{formatTokenCount(totalTokensEstimated)} tokens)
        </span>
      </div>
      <div className="flex gap-4">
        <span className="text-xs font-mono text-cyan-400">[CORE CLOUD SYSTEMS ONLINE]</span>
        <span className="text-xs font-mono opacity-30 uppercase tracking-tighter italic font-bold">Orbital Harness v1.0.4</span>
      </div>
    </div>
  );
}
