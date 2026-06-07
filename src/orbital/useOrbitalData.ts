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
import { pcmToBase64, playAudioChunk, resetAudioPlayback } from "../utils/audio";
import { playEarcon } from "../utils/earcon";
import { useE2EHarness, type TranscriptEntry } from "../e2e/harness";
import { setProjectSkin } from "./theme";
import type {
  Terminal,
  Workspace,
  PendingCommand,
  PendingActionView,
  SystemSettings,
} from "../types";
import type { StoredNote } from "../store/types";

export type GlobalMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";
export type { TranscriptEntry };

const POLL_MS = 20000;

// Mock settings seeded under ?mock=1 so the Back of House rooms (and any settings-driven surface)
// render deterministically in the e2e harness, which is client-only (no real GET /api/settings).
const MOCK_SETTINGS: SystemSettings = {
  server: { port: 3000, host: "localhost", appUrl: "http://localhost:3000" },
  voiceAi: { voice: "Zephyr", voiceStyle: "Direct", volume: 1, speechSpeed: 1, isMicMuted: false, model: "gemini-2.0-flash-live", groundingEnabled: false },
  projects: { activeContext: "mock_project", localWorkspacePath: "." },
  presets: [],
  advanced: {
    webSocketUrl: "ws://localhost:3000/live", latencyMode: "Balanced", throughputBps: 0, audioBufferSize: 4096,
    debugLogging: false, connectionTimeoutMs: 10000, rateLimitRequestsPerMin: 60,
    maxBufferLines: 10000, idleTimeoutMs: 2000, agentIdleTimeoutMs: 3500, defaultShellCommand: "bash",
    globalPermissionsMode: "Human-in-the-Loop", historyMaxCommands: 100,
  },
  secrets: { geminiApiKey: "••••••••" },
};

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
  notes: StoredNote[];
  activeTerminalId: string | null;
  isMock: boolean;
  isLive: boolean;
  voiceReconnecting: boolean;
  micMuted: boolean;
  streamConnected: boolean;
  toast: { msg: string; kind: "fire" | "warn" } | null;
  // setters / actions
  selectActivePane: (paneId: string | null) => void;
  setGlobalPermissionsMode: (m: GlobalMode) => void;
  setGlobalMode: (m: GlobalMode) => void;
  saveSettings: (next: SystemSettings) => void;
  showToast: (msg: string, kind?: "fire" | "warn") => void;
  createPane: (opts: { projectId: string; toolPreset: string; permissionsMode: string; name?: string }) => void;
  createProject: (opts: { name: string; directory: string; emoji?: string; color?: string }) => void;
  updateProjectSummary: (projectId: string, summary: string) => void;
  restartPane: (id: string) => void;
  refetchNotes: (projectIds: string[]) => void;
  addNote: (projectId: string, text: string, paneId?: string | null) => void;
  editNote: (id: string, text: string, projectId?: string) => void;
  deleteNote: (id: string, projectId?: string) => void;
  goLive: () => void;
  stopLive: () => void;
  toggleMute: () => void;
  writeControlKey: (paneId: string, bytes: string) => void;
  resizeTerminal: (paneId: string, cols: number, rows: number) => void;
  approveCommand: (messageId: string) => void;
  rejectCommand: (messageId: string) => void;
  confirmAction: (actionId: string) => void;
  cancelAction: (actionId: string) => void;
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

export function useOrbitalData(opts?: { voiceCues?: boolean }): OrbitalData {
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
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [isMock, setIsMock] = useState<boolean>(false);
  const [streamConnected, setStreamConnected] = useState<boolean>(false);
  // Kitchen Radio (voice). `voiceLive` flips the wsRef socket from the mic-free observe lane to a full
  // Gemini /live session; `voiceReconnecting` covers the bounded auto-reconnect window; `micMuted` gates
  // the outbound mic frames without tearing the session down.
  const [voiceLive, setVoiceLive] = useState<boolean>(false);
  const [voiceReconnecting, setVoiceReconnecting] = useState<boolean>(false);
  const [micMuted, setMicMuted] = useState<boolean>(false);
  const [toast, setToast] = useState<{ msg: string; kind: "fire" | "warn" } | null>(null);

  const isMockModeRef = useRef<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  activeTerminalIdRef.current = activeTerminalId;
  // Hands-free earcons are gated behind the "Voice cues" tweak; the ref lets the long-lived WS closure
  // read the latest value. Default on (the brief forbids silent state changes for an eyes-off chef).
  const voiceCuesRef = useRef<boolean>(true);
  voiceCuesRef.current = opts?.voiceCues ?? true;
  const earcon = useCallback((type: Parameters<typeof playEarcon>[0]) => { if (voiceCuesRef.current) playEarcon(type); }, []);
  // Voice session audio plumbing (ported from App.tsx connectLive). All per-session; torn down on stop.
  const desiredVoiceRef = useRef<boolean>(false);
  const micMutedRef = useRef<boolean>(false);
  micMutedRef.current = micMuted;
  const captureCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // The burner's PTY-grid resize is debounced per-pane (same shape as App.tsx): coalesce a
  // viewport reflow burst into one POST, and skip a no-op repeat of the last grid.
  const lastGridRef = useRef<Record<string, string>>({});
  const resizeDebounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

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

  // Boot/poll durability for deferred ACTIONS (the WS broadcast carries the rich rider; this minimal
  // shape — id/capability/summary — keeps chips after a reload, degrade-safe in the confirm dialog).
  const refetchActions = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/actions/pending");
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows)) setPendingActions(rows.map((a: { id: string; capability: string; summary: string }) => ({ actionId: a.id, capability: a.capability, summary: a.summary })));
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
    refetchActions();
    refetchPlans();
    refetchFrozen();
  }, [refetchTerminals, refetchLedger, refetchSettings, refetchPending, refetchActions, refetchPlans, refetchFrozen]);

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

  // Under the ?mock=1 harness there is no real server, so seed settings once so Back of House renders.
  useEffect(() => {
    if (isMock && !settings) setSettings(MOCK_SETTINGS);
  }, [isMock, settings]);

  // Mount: initial fetch + slow safety-net poll (the realtime push wave is P5).
  useEffect(() => {
    refetchAll();
    const iv = setInterval(() => {
      refetchTerminals();
      refetchLedger(); // re-derive elapsed_ms / last_command so running cards don't read frozen at a glance
      refetchPending();
      refetchActions();
      refetchPlans();
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [refetchAll, refetchTerminals, refetchLedger, refetchPending, refetchActions, refetchPlans]);

  // Tear down all per-session voice audio (mic capture chain + both AudioContexts). Idempotent.
  const teardownAudio = useCallback(() => {
    try { micProcessorRef.current?.disconnect(); } catch { /* */ }
    micProcessorRef.current = null;
    try { micSourceRef.current?.disconnect(); } catch { /* */ }
    micSourceRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* */ } });
    micStreamRef.current = null;
    try { captureCtxRef.current?.close(); } catch { /* */ }
    captureCtxRef.current = null;
    try { playbackCtxRef.current?.close(); } catch { /* */ }
    playbackCtxRef.current = null;
    resetAudioPlayback();
  }, []);

  // ── live socket: mic-free observe lane ⇄ full Gemini voice session ───────
  // ONE wsRef socket, two modes keyed on `voiceLive`:
  //   • observe (default): /live?observe=1 — joins the broadcast set (stdout_chunk → xterm, board/
  //     ledger/freeze realtime, approval/action chips) with NO Gemini session, no mic, no cost.
  //   • voice (operator tuned in): /live — the full Gemini Live session: mic capture out, model
  //     audio in, operator + Janus transcripts, grounded sources. Flipping the mode tears the old
  //     socket down and opens the new one. Skipped in mock (the harness drives setters directly);
  //     the 20s poll stays as a safety net under both modes.
  useEffect(() => {
    if (isMockModeRef.current) return;
    const voice = voiceLive;
    let closedByUs = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (closedByUs || reconnectTimer) return;
      if (voice && !desiredVoiceRef.current) return; // voice only reconnects while the operator wants it
      attempt = Math.min(attempt + 1, 6);
      const delay = Math.min(500 * 2 ** (attempt - 1), 15000); // bounded backoff, 0.5s→15s
      if (voice) setVoiceReconnecting(true);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    };

    const startMic = async (ws: WebSocket, captureCtx: AudioContext) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        micStreamRef.current = stream;
        const source = captureCtx.createMediaStreamSource(stream);
        micSourceRef.current = source;
        const processor = captureCtx.createScriptProcessor(4096, 1, 1);
        micProcessorRef.current = processor;
        source.connect(processor);
        processor.connect(captureCtx.destination);
        processor.onaudioprocess = (e) => {
          if (ws.readyState === WebSocket.OPEN && !micMutedRef.current) {
            ws.send(JSON.stringify({ type: "audio", audio: pcmToBase64(e.inputBuffer.getChannelData(0)) }));
          }
        };
      } catch (err) {
        console.error("Mic capture failed to start:", err);
      }
    };

    const connect = () => {
      if (closedByUs) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      let ws: WebSocket;
      try { ws = new WebSocket(`${protocol}//${window.location.host}/live${voice ? "" : "?observe=1"}`); }
      catch { scheduleReconnect(); return; }
      wsRef.current = ws;

      let captureCtx: AudioContext | null = null;
      let playbackCtx: AudioContext | null = null;
      if (voice) {
        captureCtx = new AudioContext({ sampleRate: 16000 });
        playbackCtx = new AudioContext({ sampleRate: 24000 });
        captureCtxRef.current = captureCtx;
        playbackCtxRef.current = playbackCtx;
        resetAudioPlayback();
      }

      ws.onopen = () => {
        attempt = 0;
        if (voice) { setVoiceLive(true); setVoiceReconnecting(false); }
        else setStreamConnected(true);
        // Re-assert the open pane so operator raw-input / draft writes target it through the gate.
        if (activeTerminalIdRef.current && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "set_active_pane", paneId: activeTerminalIdRef.current }));
        }
        if (voice && captureCtx) startMic(ws, captureCtx);
      };
      ws.onmessage = (event) => {
        // The /live frame is an untyped JSON blob (same as the classic app's ws.onmessage). Field
        // access is guarded per-case before use.
        let msg: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        try { msg = JSON.parse(event.data); } catch { return; }
        switch (msg.type) {
          case "stdout_chunk":
            if (typeof msg.terminalId === "string" && typeof msg.chunk === "string") queueStdoutChunk(msg.terminalId, msg.chunk);
            break;
          case "terminals_updated":
          case "pane_status":
          case "pane_quiescing":
            refetchTerminals();
            break;
          case "ledger_updated":
            refetchLedger();
            break;
          case "settings_updated":
            if (msg.settings) setSettings(msg.settings as SystemSettings);
            if (typeof msg.globalPermissionsMode === "string") setGlobalPermissionsMode(msg.globalPermissionsMode as GlobalMode);
            break;
          case "switch_active_pane":
            if (typeof msg.paneId === "string") setActiveTerminalId(msg.paneId);
            break;
          case "frozen":
          case "stop_all":
            if (msg.type === "frozen") earcon("alert"); // the All Hands brake — never silent
            refetchFrozen();
            refetchTerminals();
            break;
          case "approval_pending":
            // A staged PTY write awaiting HiTL approval. Append the chip from the broadcast payload
            // (immediate — same shape the classic app builds) so the ApprovalDialog renders at once.
            earcon("alert"); // the bell: a pane needs you (eyes-off)
            setPendingCommands((prev) => prev.some((c) => c.messageId === msg.messageId) ? prev : [...prev, {
              messageId: msg.messageId, cmd: msg.cmd, terminalId: msg.terminalId, rationale: msg.rationale,
              effective_gates: msg.effective_gates, posture: msg.posture, effective_mode: msg.effective_mode, capability: msg.capability,
            }]);
            break;
          case "approval_resolved":
            if (msg.messageId) setPendingCommands((prev) => prev.filter((c) => c.messageId !== msg.messageId));
            refetchPending();
            break;
          case "action_pending":
            // A gated non-PTY mutator (create_pane / set_*_permissions) staged on the Ask tier — carry
            // the SERVER-resolved effective posture so the confirm dialog can render the rider + divergence.
            earcon("alert"); // needs a taste at the pass
            setPendingActions((prev) => prev.some((a) => a.actionId === msg.actionId) ? prev : [...prev, {
              actionId: msg.actionId, capability: msg.capability, summary: msg.summary,
              effective_gate: msg.effective_gate, effective_mode: msg.effective_mode, posture: msg.posture,
              effective_gates: msg.effective_gates, pane_id: msg.pane_id, requested_mode: msg.requested_mode, global_override: msg.global_override,
            }]);
            break;
          case "action_resolved":
            if (msg.actionId) setPendingActions((prev) => prev.filter((a) => a.actionId !== msg.actionId));
            break;
          case "command_auto_executed":
            earcon("execute"); // it fired on its own (Full Auto)
            refetchPending();
            break;
          case "command_blocked":
            earcon("alert");
            refetchPending();
            break;
          // ── voice-only frames (Kitchen Radio) ──
          case "audio":
            if (playbackCtx && typeof msg.audio === "string") playAudioChunk(playbackCtx, msg.audio);
            break;
          case "interrupted":
            resetAudioPlayback();
            break;
          case "transcript_text":
            if ((msg.sender === "User" || msg.sender === "Janus") && typeof msg.text === "string") {
              setTranscript((prev) => [...prev, { sender: msg.sender, text: msg.text, timestamp: new Date() }].slice(-50));
            }
            break;
          case "grounding":
            // Attach grounded sources/queries to the most recent Janus turn (no-op if none yet).
            setTranscript((prev) => {
              const sources = Array.isArray(msg.sources) ? msg.sources : [];
              const queries = Array.isArray(msg.queries) ? msg.queries : [];
              if (sources.length === 0 && queries.length === 0) return prev;
              let lastJanus = -1;
              for (let i = prev.length - 1; i >= 0; i--) { if (prev[i].sender === "Janus") { lastJanus = i; break; } }
              if (lastJanus === -1) return prev;
              const next = prev.slice();
              next[lastJanus] = { ...next[lastJanus], grounding: { queries, sources } };
              return next;
            });
            break;
          case "voice_channel_lost":
            // The Gemini channel died while our browser WS stayed open. Eyes-off must HEAR it, and a
            // PERMANENT loss must stop the rail lying "● LIVE" (UX_BRIEF §4: no quiet state changes).
            earcon("alert");
            if (msg.permanent === true) {
              setToast({ msg: "Radio's down — tune back in, Chef", kind: "warn" });
              setTimeout(() => setToast(null), 4000);
              desiredVoiceRef.current = false;
              setVoiceLive(false);
              setVoiceReconnecting(false);
            } else {
              setVoiceReconnecting(true); // server is still retrying a transient drop
            }
            break;
          case "error":
            setToast({ msg: typeof msg.message === "string" ? msg.message : "Radio hiccup — try again", kind: "warn" });
            setTimeout(() => setToast(null), 4000);
            resetAudioPlayback();
            break;
          default:
            break;
        }
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (voice) {
          teardownAudio();
          if (!closedByUs && desiredVoiceRef.current) scheduleReconnect();
          else { setVoiceLive(false); setVoiceReconnecting(false); }
        } else {
          setStreamConnected(false);
          scheduleReconnect();
        }
      };
    };

    connect();
    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws) { try { ws.close(); } catch { /* noop */ } wsRef.current = null; }
      if (voice) teardownAudio();
    };
  }, [voiceLive, queueStdoutChunk, refetchTerminals, refetchLedger, refetchFrozen, refetchPending, teardownAudio, earcon]);

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
    // Narrate every ack into the Kitchen Radio — the brief's "source of truth" — so an eyes-off chef
    // keeps a durable, scrollable record even when off-air. Renders as a Chef de Cuisine bubble.
    setTranscript((prev) => [...prev, { sender: "Janus" as const, text: msg, timestamp: new Date() }].slice(-50));
    earcon(kind === "fire" ? "success" : "alert"); // audible + visible ack (gated by Voice cues)
  }, [earcon]);

  // ── Kitchen Radio: tune in / off-air / mute ─────────────────────────────
  // Tuning in flips the wsRef socket to a full Gemini voice session (the effect above re-runs on
  // voiceLive). desiredVoiceRef is the reconnect kill-switch: a dropped session only auto-reconnects
  // while the operator still wants to be live. Mute gates outbound mic frames without a teardown.
  const goLive = useCallback(() => { desiredVoiceRef.current = true; setMicMuted(false); setVoiceLive(true); }, []);
  const stopLive = useCallback(() => { desiredVoiceRef.current = false; setVoiceLive(false); }, []);
  const toggleMute = useCallback(() => setMicMuted((m) => !m), []);

  // ── mutations (the real backend writes; gated routes may 202/403) ───────
  const setGlobalMode = useCallback(async (mode: GlobalMode) => {
    setGlobalPermissionsMode(mode); // optimistic
    showToast(mode === "Full Auto" ? "Lettin' 'em cook 🔥" : mode === "Read-Only" ? "Hands off — watchin' the line" : "Tastin' every plate 🛎");
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
  }, [settings, showToast]);

  // Generic settings write (Back of House rooms). Caller builds the full next SystemSettings from the
  // current one; server preserves a masked/blank geminiApiKey, so echoing it back is safe. Optimistic.
  const saveSettings = useCallback(async (next: SystemSettings) => {
    setSettings(next); // optimistic
    if (typeof next.advanced?.globalPermissionsMode === "string") setGlobalPermissionsMode(next.advanced.globalPermissionsMode);
    // Fires the real PUT even under ?mock=1 (the e2e intercepts + asserts the wire). Only adopts the
    // server echo when it actually returns a settings object, so a thin ack can't wipe optimistic state.
    try {
      const res = await apiFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        if (d && d.settings && typeof d.settings === "object" && Object.keys(d.settings).length > 0) setSettings(d.settings);
        if (d && typeof d.globalPermissionsMode === "string") setGlobalPermissionsMode(d.globalPermissionsMode);
      }
    } catch { /* silent */ }
  }, []);

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

  // Re-fire a station (restart its process). Like the other burner wires (writeControlKey/resize), this
  // targets a real pane id, so it fires the real POST even under ?mock=1 (the e2e intercepts + asserts).
  // Edit a project's About (summary). PUT /api/projects/:id {summary} (ungated). Optimistic; fires in
  // mock so the Pantry e2e can assert the wire. Summary-only — touches no other project field.
  const updateProjectSummary = useCallback(async (projectId: string, summary: string) => {
    setLedger((prev) => (prev[projectId] ? { ...prev, [projectId]: { ...prev[projectId], summary } } : prev));
    try {
      const res = await apiFetch(`/api/projects/${projectId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary }) });
      if (res.ok) { if (!isMockModeRef.current) refetchLedger(); }
      else showToast("Couldn't save the About", "warn");
    } catch { /* silent */ }
  }, [refetchLedger, showToast]);

  const restartPane = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/terminals/${id}/restart`, { method: "POST" });
      if (res.status === 403) { showToast("Re-fire is gated off", "warn"); return; }
      if (res.status === 202) { showToast("Re-fire queued — needs your ok 🛎", "warn"); return; }
      refetchTerminals(); refetchLedger(); showToast("Re-firing the station 🔥");
    } catch { /* silent */ }
  }, [refetchTerminals, refetchLedger, showToast]);

  // ── The Pass: per-project notes (the expediter's tickets) ───────────────
  // Notes are the real backend for The Pass (there is no beads REST surface — BeadsExplorer stays a
  // disabled placeholder). refetchNotes merges the id-bearing feed across the given projects.
  const refetchNotes = useCallback(async (projectIds: string[]) => {
    if (isMockModeRef.current) return;
    try {
      const all: StoredNote[] = [];
      for (const pid of projectIds) {
        if (!pid || pid === "all") continue;
        const res = await apiFetch(`/api/projects/${pid}/notes`);
        if (res.ok) { const d = await res.json(); if (Array.isArray(d.notes)) all.push(...d.notes); }
      }
      setNotes(all);
    } catch { /* silent */ }
  }, []);

  // Jot a note → POST (project- or pane-scoped). Optimistic so The Pass updates instantly; the POST
  // fires even in mock (e2e intercepts). POST body key is `note` (server contract).
  const addNote = useCallback(async (projectId: string, text: string, paneId?: string | null) => {
    const t = text.trim();
    if (!t || !projectId || projectId === "all") return;
    const optimistic: StoredNote = {
      id: `tmp-${Math.random().toString(36).slice(2, 8)}`, project_id: projectId, pane_id: paneId ?? null,
      text: t, type: "note", author: "user", created_at: Date.now(), updated_at: Date.now(),
    };
    setNotes((prev) => [optimistic, ...prev]);
    showToast("Jotted it down 🎫");
    try {
      const path = paneId ? `/api/projects/${projectId}/panes/${paneId}/notes` : `/api/projects/${projectId}/notes`;
      const res = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: t }) });
      if (res.ok && !isMockModeRef.current) { refetchNotes([projectId]); refetchLedger(); }
    } catch { /* silent */ }
  }, [showToast, refetchNotes, refetchLedger]);

  const editNote = useCallback(async (id: string, text: string, projectId?: string) => {
    const t = text.trim();
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text: t, updated_at: Date.now() } : n)));
    try {
      const res = await apiFetch(`/api/notes/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) });
      if (res.ok && projectId && !isMockModeRef.current) refetchNotes([projectId]);
    } catch { /* silent */ }
  }, [refetchNotes]);

  const deleteNote = useCallback(async (id: string, projectId?: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    showToast("86'd that one");
    try {
      const res = await apiFetch(`/api/notes/${id}`, { method: "DELETE" });
      if (res.ok && projectId && !isMockModeRef.current) refetchNotes([projectId]);
    } catch { /* silent */ }
  }, [showToast, refetchNotes]);

  // Send a literal control-key sequence into a pane's PTY (the raw-input route — arrows / Tab / Esc /
  // Enter / PgUp/PgDn / Ctrl+C always-allowed; Shift+Tab gated → may 202-defer). Fires the REAL POST
  // even under the ?mock=1 harness so the e2e can intercept + assert the wire (there are no real mock
  // users). 403/202/409 surface as a toast instead of a dead button.
  const writeControlKey = useCallback(async (paneId: string, bytes: string) => {
    try {
      const res = await apiFetch(`/api/terminals/${paneId}/raw-input`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bytes }),
      });
      if (res.status === 403) showToast("That key's gated off", "warn");
      else if (res.status === 202) showToast("Key queued — needs your ok 🛎", "warn");
      else if (res.status === 409) showToast("Open the pane first", "warn");
    } catch { /* pane may have exited — best-effort */ }
  }, [showToast]);

  // Sync the backend PTY grid to the xterm grid (debounced per-pane). Fires the real POST even in mock
  // so the e2e can assert the round-trip (mirrors App.tsx's e2e-active resize seam).
  const resizeTerminal = useCallback((paneId: string, cols: number, rows: number) => {
    if (!cols || !rows) return;
    const key = `${cols}x${rows}`;
    if (lastGridRef.current[paneId] === key) return;
    lastGridRef.current[paneId] = key;
    clearTimeout(resizeDebounceRef.current[paneId]);
    resizeDebounceRef.current[paneId] = setTimeout(() => {
      apiFetch(`/api/terminals/${paneId}/resize`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cols, rows }),
      }).catch(() => { /* pane may have exited; resize is best-effort */ });
    }, 120);
  }, []);

  // ── HiTL gating resolves (the safety dial actually fires) ────────────────
  // Approve / reject a staged PTY write; confirm / cancel a gated deferred action. Each drops the chip
  // optimistically (the server emits approval_resolved/action_resolved to confirm) and routes through
  // the operator-above-the-gate REST choke-points. Optimistic-only in mock (the e2e asserts the wire).
  const approveCommand = useCallback(async (messageId: string) => {
    setPendingCommands((prev) => prev.filter((c) => c.messageId !== messageId));
    showToast("Order up! 🍽"); // the most consequential operator action must never be silent (eyes-off)
    if (isMockModeRef.current) return;
    try {
      await apiFetch("/api/commands/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId, approved: true }) });
      setTimeout(refetchTerminals, 500);
    } catch { /* silent */ }
  }, [refetchTerminals, showToast]);

  const rejectCommand = useCallback(async (messageId: string) => {
    setPendingCommands((prev) => prev.filter((c) => c.messageId !== messageId));
    showToast("86'd it — held back", "warn");
    if (isMockModeRef.current) return;
    try {
      await apiFetch("/api/commands/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId, approved: false }) });
    } catch { /* silent */ }
  }, [showToast]);

  const confirmAction = useCallback(async (actionId: string) => {
    setPendingActions((prev) => prev.filter((a) => a.actionId !== actionId));
    showToast("Fired it 🔥");
    if (isMockModeRef.current) return;
    try {
      await apiFetch(`/api/actions/${actionId}/confirm`, { method: "POST" });
      setTimeout(refetchTerminals, 500);
    } catch { /* silent */ }
  }, [refetchTerminals, showToast]);

  const cancelAction = useCallback(async (actionId: string) => {
    setPendingActions((prev) => prev.filter((a) => a.actionId !== actionId));
    showToast("Scrapped it", "warn");
    if (isMockModeRef.current) return;
    try {
      await apiFetch(`/api/actions/${actionId}/cancel`, { method: "POST" });
    } catch { /* silent */ }
  }, [showToast]);

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
    activeTerminalId, isMock, isLive: voiceLive, voiceReconnecting, micMuted, streamConnected, toast, notes,
    selectActivePane, setGlobalPermissionsMode, setGlobalMode, saveSettings, showToast,
    createPane, createProject, updateProjectSummary, restartPane, refetchNotes, addNote, editNote, deleteNote,
    goLive, stopLive, toggleMute, writeControlKey, resizeTerminal,
    approveCommand, rejectCommand, confirmAction, cancelAction,
    stopAllFreeze, stopAllKill, stopAllRelease,
    refetchTerminals, refetchLedger, refetchSettings, refetchAll,
    wsRef, isMockModeRef,
    setTerminals, setTranscript, setPendingCommands, setPendingActions, setFrozen, setFrozenRunning,
  };
}
