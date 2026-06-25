// src/classic/hooks/useLedgerData.ts — the LEDGER-DATA SPINE, extracted VERBATIM out of src/App.tsx's
// AppRaw() (bead wsm-e2e-pinned-4ib — the final dbt4 App.tsx decomposition keystone, mirroring the
// gold-standard useApprovalsQueue / useComposer seam: params-interface in, documented-but-inferred
// returns out, the pure response normalizers split into the node:test-pinned
// src/classic/helpers/ledgerDataLogic.ts sibling).
//
// Owns the 9 read-only data state slices + the 7 GET fetchers that populate them:
//   * terminals / ledger          — the live panes + the project/workspace ledger.
//   * settings / globalPermissionsMode — the system settings + the global capability-gate mode.
//   * activeProjectNotes          — the id-bearing notes feed (Node Chronicle delete/amend).
//   * frozen / frozenRunning       — the two-stage emergency STOP-ALL state (bead 8sq), restored on boot.
//   * plans / archive             — the plan list + the recoverable pane archive.
//
// *** DELIBERATELY NOT MOVED (stays in App) ***: the boot useEffect, the 20s safety-net poll, and EVERY
// mutation handler (handleStopAll* / handleSaveSettings / handleUpdateGlobalPermissions / note edits /
// archive+plan actions). They orchestrate fetchers ACROSS sibling hooks (fetchPendingCommands →
// useApprovalsQueue, fetchActiveDraft/fetchWipDrafts → useComposer) and reading the ledger fetchers into
// this hook AND the boot effect would form a create-order cycle (useApprovalsQueue needs fetchTerminals
// from here; the boot effect needs fetchPendingCommands from there). The clean boundary: this hook is the
// READ layer; App keeps the cross-cutting orchestration + the WRITE handlers, calling the returns below.
//
// *** HARNESS COUPLING (load-bearing) ***: setTerminals, setLedger, setFrozen, setFrozenRunning are 4 of
// the e2e-harness-wired setters (E2EHarnessDeps at src/e2e/harness.ts:154/158/164/165). This hook RETURNS
// them and App threads those exact identities back into the useE2EHarness deps — mirroring how
// useApprovalsQueue preserved setPendingCommands/setPendingActions.
//
// Seam: the fetchers perform REST GET I/O; the caller (App) supplies isMockModeRef (the client-only mock
// gate — every fetcher short-circuits on it EXCEPT fetchSettings, which has no guard, preserved verbatim)
// and activeProjectId (fetchProjectNotes' default project). Behavior is byte-identical to the former App
// body: same endpoints, same guards, same normalization. Witnesses: the REST-preservation smoke
// (src/ledgerData.rest.test.tsx), the normalizer chars (tests/test_ledger_data_logic.ts), pixel parity
// (e2e/ledger_data_pixel_parity.spec.ts), and the 178-spec classic mock e2e lane.

import type * as React from "react";
import { useState, type Dispatch, type SetStateAction } from "react";
import type { Terminal, Workspace, SystemSettings, Plan } from "../../types";
import { apiFetch } from "../../utils/api";
import {
  normalizeProjectNotes,
  normalizeFrozenStatus,
  normalizeArchive,
  globalModeFromSettings,
} from "../helpers/ledgerDataLogic";

/** The global capability-gate mode (mirrors the former inline `useState` union in App). */
export type GlobalPermissionsMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";

/** An id-bearing project note (the DOM-render-only feed; bead bjm). */
export interface ProjectNote {
  id: string;
  project_id: string;
  pane_id: string | null;
  text: string;
  type: string;
  created_at: number;
}

export interface LedgerDataParams {
  /** Client-only mock gate (App-owned). When true the fetchers short-circuit the real REST GETs. */
  isMockModeRef: React.MutableRefObject<boolean>;
  /** Default project for fetchProjectNotes() (callers may override with an explicit projId). */
  activeProjectId: string;
}

/**
 * The hook's return shape, kept as documentation of the seam (mirrors useApprovalsQueue/useComposer).
 * NOTE: it is deliberately NOT applied as an explicit return annotation on the hook — letting the
 * return type INFER from the inline `useState`s reproduces the former App body byte-for-byte at every
 * JSX/handler consumer (the same defense useApprovalsQueue documents). Documented here for readers.
 */
export interface LedgerData {
  terminals: Terminal[];
  setTerminals: Dispatch<SetStateAction<Terminal[]>>;
  ledger: Record<string, Workspace>;
  setLedger: Dispatch<SetStateAction<Record<string, Workspace>>>;
  settings: SystemSettings | null;
  setSettings: Dispatch<SetStateAction<SystemSettings | null>>;
  activeProjectNotes: ProjectNote[];
  setActiveProjectNotes: Dispatch<SetStateAction<ProjectNote[]>>;
  globalPermissionsMode: GlobalPermissionsMode;
  setGlobalPermissionsMode: Dispatch<SetStateAction<GlobalPermissionsMode>>;
  frozen: boolean;
  setFrozen: Dispatch<SetStateAction<boolean>>;
  frozenRunning: string[];
  setFrozenRunning: Dispatch<SetStateAction<string[]>>;
  plans: Plan[];
  setPlans: Dispatch<SetStateAction<Plan[]>>;
  // archive is `any[]` verbatim from the former inline `useState<any[]>` — the Pane Archive panel
  // consumes items as `any`; narrowing to unknown[] would trip tsc at those consumers.
  archive: any[];
  setArchive: Dispatch<SetStateAction<any[]>>;
  fetchTerminals: () => Promise<void>;
  fetchLedger: () => Promise<void>;
  fetchProjectNotes: (projId?: string) => Promise<void>;
  fetchFrozenStatus: () => Promise<void>;
  fetchSettings: () => Promise<void>;
  fetchPlans: () => Promise<void>;
  fetchArchive: () => Promise<void>;
}

export function useLedgerData(params: LedgerDataParams) {
  const { isMockModeRef, activeProjectId } = params;

  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [ledger, setLedger] = useState<Record<string, Workspace>>({});
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  // bead bjm: id-bearing notes for the active project (GET /api/projects/:id/notes) — the Node
  // Chronicle renders pane-scoped notes from THIS so it can expose delete/amend controls keyed by note id.
  const [activeProjectNotes, setActiveProjectNotes] = useState<ProjectNote[]>([]);
  const [globalPermissionsMode, setGlobalPermissionsMode] = useState<GlobalPermissionsMode>("Inherit");
  // bead 8sq (spec §2.C): the two-stage emergency STOP-ALL state. `frozen` = Stage-1 freeze active;
  // `frozenRunning` = the panes still alive while frozen (the Stage-2 hold-to-fire kill target count).
  // Restored from /api/stop-all/status on boot (fetchFrozenStatus) so the banner survives a reload.
  const [frozen, setFrozen] = useState(false);
  const [frozenRunning, setFrozenRunning] = useState<string[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [archive, setArchive] = useState<any[]>([]);

  const fetchTerminals = async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/terminals");
      if (!res.ok) return;
      const data = await res.json();
      setTerminals(data);
    } catch (e) {
      // Silent catch to prevent 'Failed to fetch' console errors during server restarts
    }
  };

  const fetchLedger = async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/ledger");
      if (!res.ok) return;
      const data = await res.json();
      setLedger(data);
    } catch (e) {}
  };

  // bead bjm: pull the id-bearing notes for a project (DOM-render-only feed). Never forwarded to the
  // live session — model egress goes through the redacted voice tools only.
  const fetchProjectNotes = async (projId = activeProjectId) => {
    if (isMockModeRef.current || !projId) return;
    try {
      const res = await apiFetch(`/api/projects/${projId}/notes`);
      if (!res.ok) return;
      const data = await res.json();
      setActiveProjectNotes(normalizeProjectNotes(data) as ProjectNote[]);
    } catch (e) {}
  };

  // bead 8sq: restore the STOP-ALL freeze state on boot so the FROZEN banner survives a page reload.
  const fetchFrozenStatus = async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/stop-all/status");
      if (!res.ok) return;
      const data = await res.json();
      const next = normalizeFrozenStatus(data);
      setFrozen(next.frozen);
      setFrozenRunning(next.running as string[]);
    } catch (e) {}
  };

  // NOTE: fetchSettings has NO mock guard (verbatim from App) — settings load even under the mock harness.
  const fetchSettings = async () => {
    try {
      const res = await apiFetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data);
      const g = globalModeFromSettings(data);
      if (g.apply) {
        setGlobalPermissionsMode(g.mode as GlobalPermissionsMode);
      }
    } catch (e) {}
  };

  const fetchPlans = async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/plans");
      if (res.ok) {
        const data = await res.json();
        setPlans(data);
      }
    } catch (e) {}
  };

  const fetchArchive = async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/archive");
      if (res.ok) {
        const data = await res.json();
        setArchive(normalizeArchive(data) as any[]);
      }
    } catch (e) {}
  };

  return {
    terminals, setTerminals,
    ledger, setLedger,
    settings, setSettings,
    activeProjectNotes, setActiveProjectNotes,
    globalPermissionsMode, setGlobalPermissionsMode,
    frozen, setFrozen,
    frozenRunning, setFrozenRunning,
    plans, setPlans,
    archive, setArchive,
    fetchTerminals,
    fetchLedger,
    fetchProjectNotes,
    fetchFrozenStatus,
    fetchSettings,
    fetchPlans,
    fetchArchive,
  };
}
