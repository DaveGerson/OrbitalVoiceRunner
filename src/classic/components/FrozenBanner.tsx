// src/classic/components/FrozenBanner.tsx — the classic (?ui=classic) Stage-2 FROZEN banner (bead
// 8sq, spec §2.C), extracted VERBATIM out of src/App.tsx (App.tsx decomposition into src/classic/,
// chunk-1 "warmup leaves"). Was an inline `{frozen && ( <EmergencyStop .../> )}` conditional that
// renders full-width directly under the header when a Stage-1 freeze is active. DOM is byte-
// identical. EmergencyStop stays a module import here (NOT threaded as a prop). Note the SAME
// handleStopAll{Freeze,Kill,Release} trio also feeds the header's own EmergencyStop trigger — this
// banner just receives the same handler refs.

import * as React from "react";
import { EmergencyStop } from "../../components/EmergencyStop";

export function FrozenBanner({
  frozen,
  frozenRunning,
  onFreeze,
  onKill,
  onRelease,
}: {
  frozen: boolean;
  frozenRunning: string[];
  onFreeze: () => void;
  onKill: () => void;
  onRelease: () => void;
}) {
  if (!frozen) return null;
  return (
    <EmergencyStop
      frozen={true}
      runningCount={frozenRunning.length}
      onFreeze={onFreeze}
      onKill={onKill}
      onRelease={onRelease}
    />
  );
}
