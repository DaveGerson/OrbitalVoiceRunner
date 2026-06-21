/**
 * src/paneOwnership.ts — the ONE pane→owning-project lookup (zero runtime deps, type-only
 * imports) so every layer (gating resolver, voice/REST dispatch, action defs, restart replay)
 * can share it without import cycles: gating → actionEffects → registry → defs would close a
 * loop if the helper lived in src/gating/index.ts (which re-exports it for back-compat).
 *
 * BUG FIX (surfaced by e2e/live_gates.spec.ts): the gate resolver used to read the per-pane
 * override via `ledger.getActiveProject()?.panes?.[paneId]`, so an override on a pane in a
 * NON-active project was written fine but never consulted — the operator's "lock down that pane"
 * edit silently fell through to the global default until something switched server context.
 * Per-pane policy must follow the pane's OWNING project, independent of the server spotlight.
 *
 * Resolution order:
 *   (1) LIVE pane: manager.terminals[paneId].projectId → ledger.getProject (every UniversalTerminal
 *       carries its owning project id from spawn — src/terminal.ts).
 *   (2) The active project (covers ledger panes whose live terminal is gone AND structural test
 *       fakes that only stub getActiveProject — the legacy lookup, now a fallback).
 *   (3) TARGETED owner lookup (bd #69): ledger.getProjectIdForPane(paneId) → ledger.getProject.
 *       On the SQLite backend this is ONE indexed query (panes PK leads with pane_id), NOT the old
 *       full-ledger materialization — `ledger.workspaces` on sqliteStore rebuilds every workspace
 *       (3× SELECT * + assembly) on each access, and this helper runs on the hot gate/posture path.
 *       Falls back to scanning `ledger.workspaces` when getProjectIdForPane is absent (structural
 *       test fakes that stub only a partial ledger — tests/test_gate_owning_project.ts).
 * Every access is defensive (`?.` / `?? {}`) because test fakes commonly inject partial ledgers.
 *
 * UNIQUENESS INVARIANT (bd #73): this returns the FIRST match across tiers, so correctness depends
 * on pane ids being GLOBALLY UNIQUE across projects — no two projects may own a pane with the same
 * id. Panes are minted with a process-unique id at spawn (src/terminal.ts) and the SQLite panes
 * table keys on (pane_id, workspace_id); a duplicated id across projects would make the resolved
 * owner (and thus the gate decision) order-dependent. Hold this invariant at every pane-registration
 * site.
 */
import type { OrchestratorManager } from "./terminal";
import type { PaneMeta } from "./types";

type Manager = Pick<OrchestratorManager, "terminals" | "ledger">;
type Owned = { projectId: string; pane: PaneMeta };

/** Tier 1: LIVE pane — manager.terminals[paneId].projectId → ledger.getProject → panes[paneId]. */
function resolveLivePane(manager: Manager, paneId: string): Owned | null {
  const liveProjectId = manager.terminals[paneId]?.projectId;
  if (!liveProjectId) return null;
  const pane = manager.ledger.getProject?.(liveProjectId)?.panes?.[paneId];
  return pane ? { projectId: liveProjectId, pane } : null;
}

/** Tier 2: the active project — ledger.getActiveProject() → panes[paneId]. */
function resolveActiveProjectPane(manager: Manager, paneId: string): Owned | null {
  const active = manager.ledger.getActiveProject?.();
  const activePane = active?.panes?.[paneId];
  return active && activePane ? { projectId: active.id, pane: activePane } : null;
}

/**
 * Tier 3 (bd #69): targeted owner lookup, then fetch just that one project. When present this is
 * AUTHORITATIVE — it never falls back to the workspace scan (returns null on miss). Returns
 * `undefined` ONLY when getProjectIdForPane is absent, signalling the caller to scan workspaces.
 */
function resolveTargetedOwner(manager: Manager, paneId: string): Owned | null | undefined {
  const getOwnerId = manager.ledger.getProjectIdForPane;
  if (typeof getOwnerId !== "function") return undefined;
  const ownerId = getOwnerId.call(manager.ledger, paneId);
  if (ownerId) {
    const pane = manager.ledger.getProject?.(ownerId)?.panes?.[paneId];
    if (pane) return { projectId: ownerId, pane };
  }
  return null;
}

/** Tier 4: fallback workspace scan — FIRST match across ledger.workspaces wins. */
function resolveByWorkspaceScan(manager: Manager, paneId: string): Owned | null {
  for (const ws of Object.values(manager.ledger.workspaces ?? {})) {
    const pane = ws?.panes?.[paneId];
    if (pane) return { projectId: ws.id, pane };
  }
  return null;
}

export function findPaneOwningProject(
  manager: Manager,
  paneId: string,
): Owned | null {
  const live = resolveLivePane(manager, paneId);
  if (live) return live;
  const active = resolveActiveProjectPane(manager, paneId);
  if (active) return active;
  // Tier 3 (bd #69): targeted owner lookup. `undefined` => getProjectIdForPane absent, so fall back
  // to scanning ledger.workspaces (partial structural test fakes). Any non-undefined result (a hit
  // OR an authoritative null) short-circuits — the targeted path never consults the scan.
  const targeted = resolveTargetedOwner(manager, paneId);
  if (targeted !== undefined) return targeted;
  return resolveByWorkspaceScan(manager, paneId);
}
