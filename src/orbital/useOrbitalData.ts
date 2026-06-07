// ── ORBITAL · live data spine ───────────────────────────────────────────
// The kitchen's read model, lifted from src/App.tsx's data layer: fetch on
// mount + a 20s safety-net poll, with the same shared plumbing (apiFetch,
// terminalStream, the ?mock=1 e2e harness) reused verbatim. The realtime /live
// WebSocket (and voice audio) lands in a later wave (P5); until then the poll +
// post-mutation refetch keep the board fresh, exactly like the classic app
// before a voice session is started.
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { apiFetch } from "../utils/api";
import { publishChunk } from "../terminalStream";
import { useE2EHarness, type TranscriptEntry } from "../e2e/harness";
import { setProjectSkin } from "./theme";
import type {
  Terminal,
  Workspace,
  PendingCommand,
  PendingActionView,
  SystemSettings,
} from "../types";

export type GlobalMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";
export type { TranscriptEntry };

const POLL_MS = 20000;

export interface OrbitalData {
  terminals: Terminal[];
  ledger: Record<string, Workspace>;
  settings: SystemSettings | null;
  globalPermissionsMode: GlobalMode;
  plans: any[];
  pendingCommands: PendingCommand[];
  pendingActions: PendingActionView[];
  frozen: boolean;
  frozenRunning: string[];
  transcript: TranscriptEntry[];
  activeTerminalId: string | null;
  isMock: boolean;
  isLive: boolean;
  toast: { msg: string; kind: "fire" | "warn" } | null;
  // setters / actions
  selectActivePane: (paneId: string | null) => void;
  setGlobalPermissionsMode: (m: GlobalMode) => void;
  setGlobalMode: (m: GlobalMode) => void;
  showToast: (msg: string, kind?: "fire" | "warn") => void;
  createPane: (opts: { projectId: string; toolPreset: string; permissionsMode: string; name?: string }) => void;
  createProject: (opts: { name: string; directory: string; emoji?: string; color?: string }) => void;
  restartPane: (id: string) => void;
  stopAllFreeze: () => void;
  stopAllKill: () => void;
  stopAllRelease: () => void;
  refetchTerminals: () => void;
  refetchLedger: () => void;
  refetchSettings: () => void;
  refetchAll: () => void;
  // exposed for the realtime/voice wave to reuse
  wsRef: MutableRefObject<WebSocket | null>;
  isMockModeRef: MutableRefObject<boolean>;
  setTerminals: Dispatch<SetStateAction<Terminal[]>>;
  setTranscript: Dispatch<SetStateAction<TranscriptEntry[]>>;
  setPendingCommands: Dispatch<SetStateAction<PendingCommand[]>>;
  setPendingActions: Dispatch<SetStateAction<PendingActionView[]>>;
  setFrozen: Dispatch<SetStateAction<boolean>>;
  setFrozenRunning: Dispatch<SetStateAction<string[]>>;
}

export function useOrbitalData(): OrbitalData {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [ledger, setLedger] = useState<Record<string, Workspace>>({});
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [globalPermissionsMode, setGlobalPermissionsMode] = useState<GlobalMode>("Inherit");
  const [plans, setPlans] = useState<any[]>([]);
  const [pendingCommands, setPendingCommands] = useState<PendingCommand[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingActionView[]>([]);
  const [frozen, setFrozen] = useState<boolean>(false);
  const [frozenRunning, setFrozenRunning] = useState<string[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [isMock, setIsMock] = useState<boolean>(false);
  const [toast, setToast] = useState<{ msg: string; kind: "fire" | "warn" } | null>(null);

  const isMockModeRef = useRef<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  activeTerminalIdRef.current = activeTerminalId;

  // Display lane only (P4 xterm subscribes via subscribeChunks). The preview
  // tail / byte-count come straight off Terminal.output, so no React buffer here.
  const queueStdoutChunk = useCallback((terminalId: string, chunk: string) => {
    publishChunk(terminalId, chunk);
  }, []);

  // ── fetchers (no-op in mock mode; the harness owns state then) ──────────
  const refetchTerminals = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/terminals");
      if (res.ok) setTerminals(await res.json());
    } catch { /* server restart — silent */ }
  }, []);

  const refetchLedger = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/ledger");
      if (res.ok) setLedger(await res.json());
    } catch { /* silent */ }
  }, []);

  const refetchSettings = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data);
      if (data.advanced) setGlobalPermissionsMode(data.advanced.globalPermissionsMode);
    } catch { /* silent */ }
  }, []);

  const refetchPending = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/commands/pending");
      if (res.ok) setPendingCommands(await res.json());
    } catch { /* silent */ }
  }, []);

  const refetchPlans = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/plans");
      if (res.ok) setPlans(await res.json());
    } catch { /* silent */ }
  }, []);

  const refetchFrozen = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/stop-all/status");
      if (!res.ok) return;
      const data = await res.json();
      setFrozen(!!data.frozen);
      setFrozenRunning(Array.isArray(data.running) ? data.running : []);
    } catch { /* silent */ }
  }, []);

  const refetchAll = useCallback(() => {
    refetchTerminals();
    refetchLedger();
    refetchSettings();
    refetchPending();
    refetchPlans();
    refetchFrozen();
  }, [refetchTerminals, refetchLedger, refetchSettings, refetchPending, refetchPlans, refetchFrozen]);

  // E2E harness (?mock=1) — drives all the same setters as the classic app.
  useE2EHarness({
    isMockModeRef,
    setIsMockMode: setIsMock,
    setShowTranscriptPanel: () => {},
    setTerminals,
    setActiveTerminalId,
    setLedger,
    queueStdoutChunk,
    setTranscript,
    setPendingCommands,
    setPendingActions,
    setFrozen,
    setFrozenRunning,
    setWipDrafts: () => {},
  });

  // Mount: initial fetch + slow safety-net poll (the realtime push wave is P5).
  useEffect(() => {
    refetchAll();
    const iv = setInterval(() => {
      refetchTerminals();
      refetchPending();
      refetchPlans();
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [refetchAll, refetchTerminals, refetchPending, refetchPlans]);

  // The UI is the source of truth for the single active pane. Echo it to the
  // server whenever it changes and the socket is open (the WS wave relies on this).
  const selectActivePane = useCallback((paneId: string | null) => {
    setActiveTerminalId(paneId);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_active_pane", paneId }));
    }
  }, []);

  const showToast = useCallback((msg: string, kind: "fire" | "warn" = "fire") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2400);
  }, []);

  // ── mutations (the real backend writes; gated routes may 202/403) ───────
  const setGlobalMode = useCallback(async (mode: GlobalMode) => {
    setGlobalPermissionsMode(mode); // optimistic
    if (isMockModeRef.current) return;
    try {
      const body = { ...(settings ?? {}), advanced: { ...(settings?.advanced ?? {}), globalPermissionsMode: mode } };
      const res = await apiFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) {
        const data = await res.json();
        if (data.settings) setSettings(data.settings);
        if (data.globalPermissionsMode) setGlobalPermissionsMode(data.globalPermissionsMode);
      }
    } catch { /* silent */ }
  }, [settings]);

  const createPane = useCallback(async (opts: { projectId: string; toolPreset: string; permissionsMode: string; name?: string }) => {
    const ws = (Object.values(ledger) as Workspace[]).find((w) => w.id === opts.projectId);
    const cwd = ws?.directory || "~";
    const slug = (opts.name || "pane").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "pane";
    const terminalId = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const cmdFor = (tp: string) => settings?.presets?.find((p) => p.name === tp)?.command
      || ({ "Claude Code": "claude", Codex: "codex", Antigravity: "antigravity", Custom: "bash" }[tp] ?? "bash");
    if (isMockModeRef.current) { showToast(`Fired up ${terminalId} 🔥`); return; }
    try {
      const res = await apiFetch("/api/terminals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminalId, cwd, command: cmdFor(opts.toolPreset), toolPreset: opts.toolPreset, permissionsMode: opts.permissionsMode, projectId: opts.projectId }),
      });
      if (res.status === 403) { showToast("Not in my kitchen — that's gated off", "warn"); return; }
      if (res.status === 202) { showToast("Queued — needs your ok at the pass 🛎", "warn"); return; }
      if (res.ok) { refetchTerminals(); refetchLedger(); selectActivePane(terminalId); showToast(`Fired up ${terminalId} 🔥`); }
    } catch { /* silent */ }
  }, [ledger, settings, showToast, refetchTerminals, refetchLedger, selectActivePane]);

  const createProject = useCallback(async (opts: { name: string; directory: string; emoji?: string; color?: string }) => {
    const id = "p" + Date.now().toString(36);
    if (opts.emoji && opts.color) setProjectSkin(id, { emoji: opts.emoji, color: opts.color });
    if (isMockModeRef.current) { showToast("New kitchen opened! 🍽"); return; }
    try {
      const res = await apiFetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: opts.name || "New project", directory: opts.directory || ("~/" + id), summary: "" }),
      });
      if (res.ok) { refetchLedger(); showToast("New kitchen opened! 🍽"); }
    } catch { /* silent */ }
  }, [showToast, refetchLedger]);

  const restartPane = useCallback(async (id: string) => {
    if (isMockModeRef.current) return;
    try {
      await apiFetch(`/api/terminals/${id}/restart`, { method: "POST" });
      refetchTerminals(); refetchLedger();
    } catch { /* silent */ }
  }, [refetchTerminals, refetchLedger]);

  const stopAllFreeze = useCallback(async () => {
    if (isMockModeRef.current) { setFrozen(true); return; }
    try {
      const res = await apiFetch("/api/stop-all", { method: "POST" });
      if (res.ok) { const d = await res.json(); setFrozen(true); setFrozenRunning(Array.isArray(d.running) ? d.running : []); }
    } catch { /* silent */ }
  }, []);
  const stopAllKill = useCallback(async () => {
    if (isMockModeRef.current) { setFrozenRunning([]); return; }
    try {
      const res = await apiFetch("/api/stop-all/confirm", { method: "POST" });
      if (res.ok) { const d = await res.json(); if (Array.isArray(d.killed)) setFrozenRunning((prev) => prev.filter((x) => !d.killed.includes(x))); refetchTerminals(); }
    } catch { /* silent */ }
  }, [refetchTerminals]);
  const stopAllRelease = useCallback(async () => {
    if (isMockModeRef.current) { setFrozen(false); setFrozenRunning([]); return; }
    try {
      const res = await apiFetch("/api/stop-all/release", { method: "POST" });
      if (res.ok) { setFrozen(false); setFrozenRunning([]); }
    } catch { /* silent */ }
  }, []);

  return {
    terminals, ledger, settings, globalPermissionsMode, plans,
    pendingCommands, pendingActions, frozen, frozenRunning, transcript,
    activeTerminalId, isMock, isLive: false, toast,
    selectActivePane, setGlobalPermissionsMode, setGlobalMode, showToast,
    createPane, createProject, restartPane, stopAllFreeze, stopAllKill, stopAllRelease,
    refetchTerminals, refetchLedger, refetchSettings, refetchAll,
    wsRef, isMockModeRef,
    setTerminals, setTranscript, setPendingCommands, setPendingActions, setFrozen, setFrozenRunning,
  };
}
