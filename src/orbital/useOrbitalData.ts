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
  // setters / actions
  selectActivePane: (paneId: string | null) => void;
  setGlobalPermissionsMode: (m: GlobalMode) => void;
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

  return {
    terminals, ledger, settings, globalPermissionsMode, plans,
    pendingCommands, pendingActions, frozen, frozenRunning, transcript,
    activeTerminalId, isMock, isLive: false,
    selectActivePane, setGlobalPermissionsMode,
    refetchTerminals, refetchLedger, refetchSettings, refetchAll,
    wsRef, isMockModeRef,
    setTerminals, setTranscript, setPendingCommands, setPendingActions, setFrozen, setFrozenRunning,
  };
}
