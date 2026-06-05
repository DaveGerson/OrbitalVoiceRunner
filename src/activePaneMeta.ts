// Active-pane context resolver (f06 — "context shifted late" fix).
//
// The prompt-composer's context body (name + modelContext + humanContext, rendered at
// src/App.tsx:2031-2034) must track the active pane in the SAME render that moves the cyan
// highlight — the highlight keys off `activeTerminalId` directly, so it is already optimistic.
// The data is already local: `/api/ledger` returns the full workspaces map and the body derives
// purely from it; `set_active_pane` is a pointer write that broadcasts nothing. So the correct
// cut is to read the meta synchronously from the ledger in-render — no round-trip, no placeholder.
//
// This is the in-render loop previously inline at App.tsx:1567-1579, extracted verbatim so it can
// be unit-pinned. It keys SOLELY off `activeTerminalId` (scans every project, ignores the active
// project) so it stays correct under a stale active-project. NOTE: deliberately separate from
// `src/activePane.ts` (the server write-guard) to avoid a name/concept collision.

import type { PaneMeta, Workspace } from "./types";

export function resolveActivePaneMeta(
  ledger: Record<string, Workspace>,
  activeTerminalId: string | null,
): { pane: PaneMeta | null; project: Workspace | null } {
  if (!activeTerminalId) return { pane: null, project: null };
  for (const proj of Object.values(ledger)) {
    if (proj.panes && proj.panes[activeTerminalId]) {
      return { pane: proj.panes[activeTerminalId], project: proj };
    }
  }
  return { pane: null, project: null };
}
