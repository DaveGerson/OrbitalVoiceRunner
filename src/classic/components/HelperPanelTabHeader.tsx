// src/classic/components/HelperPanelTabHeader.tsx — the collapsed one-tab "Sync Spec" header,
// extracted VERBATIM out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, chunk-2
// "composer-cluster"). The Orchestrate & Alerts tabs were removed, leaving Sync Spec as the sole
// right-panel surface, so the tab-bar chrome collapses to a plain titled header (a one-tab tab bar
// is an anti-pattern). The draft-pending badge (sync-spec-draft-badge) is preserved — it is asserted
// by e2e/draft_badge.spec.ts and reflects real composer/WIP state.
//
// The draft-pending predicate is the node:test-pinned composerLogic.computeDraftPending: a draft is
// pending iff the active-pane buffer holds non-whitespace text OR any pane has a staged WIP draft.
// It mirrors the composer-send enable gate (.trim()), unlike the legacy mobile nav dot which gates on
// raw promptBuffer.length and ignores wipDrafts.

import * as React from "react";
import { CheckSquare } from "lucide-react";
import { computeDraftPending } from "../helpers/composerLogic";
import type { WipDraft } from "../hooks/useComposer";

export function HelperPanelTabHeader({
  promptBuffer,
  wipDrafts,
}: {
  promptBuffer: string;
  wipDrafts: WipDraft[];
}) {
  const draftPending = computeDraftPending(promptBuffer, wipDrafts);
  return (
    <div className="flex bg-black/60 p-1 rounded-t border-t border-l border-r border-white/5 shrink-0 select-none">
      <div className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-mono tracking-wider border-b-2 border-cyan-400 text-cyan-400 font-extrabold bg-cyan-950/[0.04] relative uppercase">
        <CheckSquare className="w-3.5 h-3.5" />
        <span>Sync Spec</span>
        {draftPending && (
          <span
            data-testid="sync-spec-draft-badge"
            title="A prompt draft is pending"
            className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shrink-0"
          ></span>
        )}
      </div>
    </div>
  );
}
