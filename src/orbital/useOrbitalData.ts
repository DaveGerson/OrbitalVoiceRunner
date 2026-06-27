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
import { pcmToBase64, playAudioChunk, resetAudioPlayback, setPlaybackVolume, applyOutputDevice } from "../utils/audio";
import { isEarconType, playEarcon } from "../utils/earcon";
import { notifyDesktop, requestNotifyPermission } from "../utils/notify";
import { useE2EHarness, isE2EWireArmed, type TranscriptEntry } from "../e2e/harness";
import { setProjectSkin } from "./theme";
import type {
  Terminal,
  Workspace,
  PendingCommand,
  PendingActionView,
  SystemSettings,
  Plan,
  PaneLayout,
  AttentionItem,
} from "../types";
import type { StoredNote, StoredHandoff } from "../store/types";
import { extractSlots } from "../templates";
import {
  projectTemplatesFrame, historyEntriesFromFrame, attentionQueueFromFrame, draftTextFromFrame, shouldAdoptMute,
  buildPendingCommand, buildPendingAction, blockedToastText, attachGrounding,
  firstServerMessage, hasSettingsEcho, globalModeToast, resolvePaneCommand, paneSlug, layoutApplyToast, layoutSaveToast,
  templateClarifyText, templateApplyToast, layoutGatedText, playObserveEarcon, isPaneExitedFrame,
  dismissAttentionOutcome, attentionResolveTarget, handoffsFromFrame, normalizeHandoffRows, handoffPromptFromReadResponse,
  isApprovalHere, buildAttentionApprovalItem, approvalToPromote,
} from "./useOrbitalDataHelpers";

export type GlobalMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";
export type { TranscriptEntry };

// 2K.1: one archived (stopped/cleared, recoverable) pane — the exact row shape GET /api/archive
// returns ({archived:[…]}, src/actions/defs/archive.ts listArchivedPanes).
export interface ArchivedPane {
  pane_id: string;
  name: string;
  project_id: string;
  tool_preset?: string;
  last_command?: string;
  archived_at?: number | string;
}

// 2K.4: an optional one-tap action riding a toast (e.g. Undo on a destructive delete).
export interface ToastAction { label: string; run: () => void }

// 4U.2: one recorded command in a pane's ticket history — the exact RAW entry shape
// GET /api/terminals/:pane_id/history returns (server HistoryEntry, reads.ts getTerminalHistory).
export interface PaneHistoryEntry {
  command: string;
  timestamp: string;
  output: string;
  finalResponse?: string;
}

// Journey-expansion C: one saved prompt template, the exact projection GET /api/templates returns
// (templateView in src/actions/defs/templates.ts — `slots` are DERIVED from the body server-side,
// so they can never go stale against the body shown here).
export interface TemplateView {
  id: string;
  name: string;
  description: string;
  body: string;
  slots: string[];
  created_at: number;
  updated_at: number;
}

// bead apu: the one-glance health snapshot GET /api/health returns — mirrors the getHealth
// handler's output shape (src/actions/defs/observability.ts). All fields server truth.
export interface HealthSnapshot {
  frozen: boolean;
  panes: { total: number; running: number; idle: number; exited: number };
  pending_approvals: number;
  recent: { total: number; errors: number; error_rate: number };
  memory: { synthesizer: string };
}

// 4U.3: one service-log row — the exact ActionLogRow shape GET /api/action-log returns
// (src/store/sqliteStore.ts; body is {output:{rows}} via the default resultToHttp map).
export interface ServiceLogRow {
  id: number;
  ts: number;
  name: string | null;
  capability: string | null;
  result_kind: string | null;
  ms: number | null;
  args_redacted: string | null;
  surface: string | null;
}

const POLL_MS = 20000;

// 4U.3: the radio transcript survives a reload (sessionStorage, capped at the existing 50-entry
// slice). Session-scoped on purpose: a fresh tab starts a fresh service, a reload keeps the record.
const TRANSCRIPT_STORE_KEY = "orbital_radio_transcript_v1";

function loadStoredTranscript(): TranscriptEntry[] {
  try {
    const raw = sessionStorage.getItem(TRANSCRIPT_STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && (e.sender === "User" || e.sender === "Janus") && typeof e.text === "string" && e.text)
      .slice(-50)
      .map((e) => ({
        sender: e.sender as "User" | "Janus",
        text: e.text as string,
        timestamp: new Date(typeof e.timestamp === "string" || typeof e.timestamp === "number" ? e.timestamp : Date.now()),
        grounding: e.grounding && typeof e.grounding === "object" ? e.grounding : undefined,
      }));
  } catch { return []; } // sandboxed/full storage — boot with an empty radio, never crash
}

// 3C.3: the one-shot reload guard for a 4001 (unauthorized) WS close. sessionStorage-scoped so a
// fresh tab can re-key again, but a reload that STILL 4001s can never loop — it toasts instead.
const UNAUTH_RELOAD_KEY = "orbital_4001_reloaded";

// 1B.7: long auto-executed/blocked commands are toasted — keep the chip glanceable (~80 chars).
function truncateCmd(cmd: unknown): string {
  const s = typeof cmd === "string" ? cmd : "";
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

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
  /** 4U.1: the voice-built orchestrator plans (GET /api/plans + plans_updated frames). */
  plans: Plan[];
  pendingCommands: PendingCommand[];
  pendingActions: PendingActionView[];
  /** D2: the attention/"what needs me" inbox (GET /api/attention + attention_updated frames). */
  attentionQueue: AttentionItem[];
  frozen: boolean;
  frozenRunning: string[];
  /** A-1a (inc2): the latest daemon_state WS frame — "python" = healthy, "fallback" = degraded, null = not yet received. */
  daemonState: "python" | "fallback" | null;
  transcript: TranscriptEntry[];
  notes: StoredNote[];
  activeTerminalId: string | null;
  isMock: boolean;
  isLive: boolean;
  voiceReconnecting: boolean;
  /** 1B.5: TRUE only while the voice /live socket is actually OPEN ("● LIVE" gates on this). */
  voiceConnected: boolean;
  /** 1B.5: getUserMedia was denied/failed — the radio must say so, not claim it's listening. */
  micBlocked: boolean;
  micMuted: boolean;
  streamConnected: boolean;
  /** 3C.2: bumps each time the observe socket RE-opens after a drop — mounted terminals resync on it. */
  streamGeneration: number;
  /** 3C.2: the pane's freshest raw backfill (server truth; mock: current harness state). */
  fetchPaneBackfill: (paneId: string) => Promise<string | null>;
  toast: { msg: string; kind: "fire" | "warn"; action?: ToastAction } | null;
  /** 2K.1: the freezer — archived (recoverable) panes from GET /api/archive. */
  archived: ArchivedPane[];
  /** 2K.3: latest server-pushed draft per pane (draft_updated frames), for the Order Pad mirror. */
  paneDrafts: Record<string, { text: string; at: number }>;
  /** 4U.2: latest server-pushed history per pane (history_updated frames; entries null = refetch). */
  paneHistories: Record<string, { entries: PaneHistoryEntry[] | null; at: number }>;
  /** 4U.3: the service log — recent action-log rows from GET /api/action-log (newest-first). */
  serviceLog: ServiceLogRow[];
  refetchServiceLog: () => void;
  /** bead apu: the latest one-glance health snapshot from GET /api/health (null until first fetch). */
  healthSnapshot: HealthSnapshot | null;
  refetchHealth: () => void;
  /** Journey-expansion C: the cookbook — saved prompt templates (GET /api/templates + templates_updated). */
  templates: TemplateView[];
  /** Journey-expansion C: mise en place — saved pane layouts (GET /api/layouts + layouts_updated). */
  layouts: PaneLayout[];
  /** j4e1: the line drawer's handoffs (GET /api/handoffs + handoffs_updated frames), redacted server-side. */
  handoffs: StoredHandoff[];
  // setters / actions
  selectActivePane: (paneId: string | null) => void;
  setGlobalPermissionsMode: (m: GlobalMode) => void;
  setGlobalMode: (m: GlobalMode) => void;
  saveSettings: (next: SystemSettings) => void;
  showToast: (msg: string, kind?: "fire" | "warn", earconOverride?: Parameters<typeof playEarcon>[0] | null, action?: ToastAction) => void;
  createPane: (opts: { projectId: string; toolPreset: string; permissionsMode: string; name?: string }) => void;
  createProject: (opts: { name: string; directory: string; emoji?: string; color?: string }) => void;
  updateProjectSummary: (projectId: string, summary: string) => void;
  restartPane: (id: string) => void;
  // 2K.1: pane lifecycle — the same routes the classic app uses.
  /** "86 this station": graceful stop + archive (recoverable) — POST /api/projects/:p/panes/:id/stop. */
  stopPane: (projectId: string, paneId: string) => void;
  /** Rename a station — PUT /api/projects/:p/panes/:id/rename. */
  renamePane: (projectId: string, paneId: string, name: string) => void;
  /** Archive every Exited pane in the active project — POST /api/terminals/clear-exited. */
  clearExited: () => void;
  /** Bring a pane back from the freezer — POST /api/archive/:pane_id/restore. */
  restoreArchived: (paneId: string) => void;
  /** Permanently delete an archived pane — DELETE /api/archive/:pane_id. */
  deleteArchived: (paneId: string) => void;
  refetchArchive: () => void;
  // 4U.1: plans on The Pass — the same routes the classic Spec Buffer used.
  /** Fire a plan (step 1 runs through the gate) — POST /api/plans/:id/execute (200/202/403/…). */
  executePlan: (planId: string) => void;
  /** 86 a plan — DELETE /api/plans/:id (gated: may 202-defer). */
  deletePlan: (planId: string) => void;
  // Journey-expansion C: prompt templates + pane layouts on The Pass.
  /** Save a new template — POST /api/templates (gated update_metadata: may 202/403). */
  createTemplate: (opts: { name: string; body: string; description?: string }) => void;
  /** Edit a template — PUT /api/templates/:id (gated update_metadata). */
  updateTemplate: (id: string, opts: { name?: string; body?: string; description?: string }) => void;
  /** Delete a template — DELETE /api/templates/:id (gated update_metadata). */
  deleteTemplate: (id: string) => void;
  /** Fill a pane's WIP draft from a template — POST /api/templates/:id/apply {pane_id, values}. */
  applyTemplate: (id: string, paneId: string, values: { name: string; value: string }[]) => void;
  /** Snapshot the current setup — POST /api/layouts {name} (gated update_metadata). */
  saveLayout: (name: string) => void;
  /** Re-materialize a layout — POST /api/layouts/:id/apply (gated like a recipe: 200 narration/403). */
  applyLayout: (id: string) => void;
  /** Delete a layout — DELETE /api/layouts/:id (gated update_metadata). */
  deleteLayout: (id: string) => void;
  refetchTemplates: () => void;
  refetchLayouts: () => void;
  // j4e1: the handoff line-drawer's hero actions. These call the cv2 canonical REST twins
  // (registry-derived from src/actions/defs/handoff.ts: read_handoff -> GET /api/handoffs/:handoff_id,
  // so the lifecycle twins are POST /api/handoffs/:handoff_id/<verb>). The board repaints off the
  // handoffs_updated frame; the post-success refetch is the safety net for a missed frame.
  /** Deliver a STAGED handoff into the target pane — POST /api/handoffs/:id/deliver (gated: 202/403). */
  deliverHandoff: (handoffId: string) => void;
  /** Rewrite a handoff's composed prompt — POST /api/handoffs/:id/revise {new_draft_text} (ungated). */
  reviseHandoff: (handoffId: string, newDraftText: string) => void;
  /** Stage a composing/revising handoff to `staged` — POST /api/handoffs/:id/stage (ungated). */
  stageHandoff: (handoffId: string) => void;
  /** Reject/cancel a handoff — POST /api/handoffs/:id/reject (ungated pre-gate flip). */
  rejectHandoff: (handoffId: string) => void;
  /** Read the FULL (untruncated) composed prompt — GET /api/handoffs/:id (revise editor seed). */
  fetchHandoffPrompt: (handoffId: string) => Promise<string | null>;
  refetchHandoffs: () => void;
  // 2K.2: per-pane capability-gate override (the Rulebook's pane scope) —
  // PUT /api/projects/:p/panes/:id/capability-gates {capabilityGates}.
  setPaneGates: (projectId: string, paneId: string, gates: Record<string, string>) => void;
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
  /** D2: re-pull the attention inbox (GET /api/attention) — used by the safety-net poll + degrade. */
  refetchAttention: () => void;
  /** D2: clear one attention item — POST /api/attention/:id/dismiss (dismiss_attention, veto). */
  dismissAttention: (id: string) => void;
  /** bead e7h: in-inbox Approve — resolve a held gated request by its messageId (same resolver voice
   *  uses), or jump-to-station for a triage-only item. Optimistically clears the alert. */
  approveAttention: (item: AttentionItem) => void;
  /** bead e7h: in-inbox Deny — reject a held gated request by its messageId, or locally dismiss a
   *  triage-only item. Optimistically clears the alert. */
  denyAttention: (item: AttentionItem) => void;
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

export function useOrbitalData(opts?: { voiceCues?: boolean; desktopNotes?: boolean }): OrbitalData {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [ledger, setLedger] = useState<Record<string, Workspace>>({});
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [globalPermissionsMode, setGlobalPermissionsMode] = useState<GlobalMode>("Inherit");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [pendingCommands, setPendingCommands] = useState<PendingCommand[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingActionView[]>([]);
  // D2: the attention/"what needs me" inbox (GET /api/attention + attention_updated frames).
  const [attentionQueue, setAttentionQueue] = useState<AttentionItem[]>([]);
  const [frozen, setFrozen] = useState<boolean>(false);
  const [frozenRunning, setFrozenRunning] = useState<string[]>([]);
  // A-1a (inc2): track the latest daemon_state WS frame — null until the first frame arrives.
  const [daemonState, setDaemonState] = useState<"python" | "fallback" | null>(null);
  // 4U.3: seeded from sessionStorage so the radio's record survives a reload (capped 50 below).
  const [transcript, setTranscript] = useState<TranscriptEntry[]>(loadStoredTranscript);
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [isMock, setIsMock] = useState<boolean>(false);
  const [streamConnected, setStreamConnected] = useState<boolean>(false);
  // Kitchen Radio (voice). `voiceLive` flips the wsRef socket from the mic-free observe lane to a full
  // Gemini /live session; `voiceReconnecting` covers the bounded auto-reconnect window; `micMuted` gates
  // the outbound mic frames without tearing the session down.
  const [voiceLive, setVoiceLive] = useState<boolean>(false);
  const [voiceReconnecting, setVoiceReconnecting] = useState<boolean>(false);
  // 1B.5: LIVE means live — the chip gates on the voice socket actually being OPEN, and a denied
  // mic must be loud (micBlocked drives the "MIC BLOCKED" chip instead of "I'm listening, Chef").
  const [voiceConnected, setVoiceConnected] = useState<boolean>(false);
  const [micBlocked, setMicBlocked] = useState<boolean>(false);
  const [micMuted, setMicMuted] = useState<boolean>(false);
  const [toast, setToast] = useState<{ msg: string; kind: "fire" | "warn"; action?: ToastAction } | null>(null);
  // 2K.1: the freezer (archived, recoverable panes). 2K.3: per-pane server-pushed draft mirror.
  const [archived, setArchived] = useState<ArchivedPane[]>([]);
  const [paneDrafts, setPaneDrafts] = useState<Record<string, { text: string; at: number }>>({});
  // 4U.2: per-pane server-pushed history mirror (history_updated frames carry the full array;
  // a frame without one stores entries:null so the burner knows to refetch).
  const [paneHistories, setPaneHistories] = useState<Record<string, { entries: PaneHistoryEntry[] | null; at: number }>>({});
  // 4U.3: the service log (GET /api/action-log rows, newest-first, capped 100).
  const [serviceLog, setServiceLog] = useState<ServiceLogRow[]>([]);
  // bead apu: the one-glance health snapshot (GET /api/health), refreshed when the Pantry opens.
  const [healthSnapshot, setHealthSnapshot] = useState<HealthSnapshot | null>(null);
  // Journey-expansion C: the cookbook (prompt templates) + mise en place (pane layouts).
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [layouts, setLayouts] = useState<PaneLayout[]>([]);
  // j4e1: the line drawer's handoffs (GET /api/handoffs + handoffs_updated frames).
  const [handoffs, setHandoffs] = useState<StoredHandoff[]>([]);

  // 3C.2: counts observe-socket REconnects (not the first open). TerminalView keys its
  // reset-and-rewrite-from-snapshot resync on this, so a gap is repaired the moment we're back.
  const [streamGeneration, setStreamGeneration] = useState<number>(0);

  const isMockModeRef = useRef<boolean>(false);
  // 3C.3: under plain ?mock=1 (a human exploring the harness against a REAL deployment) mutations
  // must stay fully client-side. Only Playwright-armed pages (armE2EWire's init script, snapshotted
  // by the harness) get the real wire, so the e2e suite keeps intercepting + asserting it.
  const mockClientOnly = useCallback(() => isMockModeRef.current && !isE2EWireArmed(), []);
  // 2K.4: a render-fresh mirror of `notes` so deleteNote can capture the doomed note SYNCHRONOUSLY
  // (a setState updater is NOT guaranteed to run before the next statement in React 18 — the
  // undo action must be built from the note's data at click time, not after a re-render).
  const notesRef = useRef<StoredNote[]>([]);
  notesRef.current = notes;
  // wsRef = the always-on OBSERVE socket (data lane; TerminalWindow's draft_edit rides it).
  // voiceWsRef = the separate, voice-session socket (3C.2a) — opened/closed by the radio only,
  // so tuning in/out can never tear down the terminal stream.
  const wsRef = useRef<WebSocket | null>(null);
  const voiceWsRef = useRef<WebSocket | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  activeTerminalIdRef.current = activeTerminalId;
  // 3C.2: render-fresh mirror so the mock fetchPaneBackfill can read synchronously.
  const terminalsRef = useRef<Terminal[]>([]);
  terminalsRef.current = terminals;
  // bead 8xn: render-fresh mirror of the inbox so the promotion effect (keyed on activeTerminalId +
  // a visibilitychange listener) reads the LATEST queue WITHOUT re-subscribing on every queue
  // mutation — same render-fresh-ref idiom as activeTerminalIdRef / terminalsRef.
  const attentionQueueRef = useRef<AttentionItem[]>([]);
  attentionQueueRef.current = attentionQueue;
  // Hands-free earcons are gated behind the "Voice cues" tweak; the ref lets the long-lived WS closure
  // read the latest value. Default on (the brief forbids silent state changes for an eyes-off chef).
  const voiceCuesRef = useRef<boolean>(true);
  voiceCuesRef.current = opts?.voiceCues ?? true;
  // 2K.6: "Desktop notes" tweak (separate from Voice cues, which gates audio). The ref lets the
  // long-lived WS closure read the latest value. notifyDesktop itself is background-only
  // (document.hidden) and permission-gated, so this flag is the only product-level switch.
  const desktopNotesRef = useRef<boolean>(true);
  desktopNotesRef.current = opts?.desktopNotes ?? true;
  const desktopNote = useCallback((title: string, body: string) => { if (desktopNotesRef.current) notifyDesktop(title, body); }, []);
  const earcon = useCallback((type: Parameters<typeof playEarcon>[0]) => { if (voiceCuesRef.current) playEarcon(type); }, []);
  // Declared ABOVE the live-socket effect (which now references it for honest WS-driven feedback —
  // 1B.5 mic denial, 1B.7 auto-executed/blocked/proactive toasts). `earconOverride` lets a caller
  // pick a more specific tone than the fire→success / warn→alert default, or `null` for no tone
  // (proactive_notification: the bus already sent its own proactive_earcon — don't double-chime).
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, kind: "fire" | "warn" = "fire", earconOverride?: Parameters<typeof playEarcon>[0] | null, action?: ToastAction) => {
    setToast({ msg, kind, action });
    // 2K.4: an action-bearing toast (Undo) lingers longer; a newer toast cancels the older timer
    // so it can't be hidden early by a stale timeout.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), action ? 6000 : 2400);
    // Narrate every ack into the Kitchen Radio — the brief's "source of truth" — so an eyes-off chef
    // keeps a durable, scrollable record even when off-air. Renders as a Chef de Cuisine bubble.
    setTranscript((prev) => [...prev, { sender: "Janus" as const, text: msg, timestamp: new Date() }].slice(-50));
    if (earconOverride !== null) earcon(earconOverride ?? (kind === "fire" ? "success" : "alert")); // audible + visible ack (gated by Voice cues)
  }, [earcon]);
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
  // 3C.1: monotonic in-flight sequencing. Two overlapping /api/terminals fetches can resolve out
  // of order (the payload is heavy — every pane's output+backfill), letting a STALE list overwrite
  // a fresher one (the status flap). Capture the seq at request START; apply only if no newer
  // request has started by resolve time. Same guard on the ledger (cheap, same failure mode).
  const terminalsReqSeq = useRef(0);
  const ledgerReqSeq = useRef(0);

  const refetchTerminals = useCallback(async () => {
    if (isMockModeRef.current) return;
    const seq = ++terminalsReqSeq.current;
    try {
      const res = await apiFetch("/api/terminals");
      if (!res.ok) return;
      const rows = await res.json();
      if (seq === terminalsReqSeq.current) setTerminals(rows);
    } catch { /* server restart — silent */ }
  }, []);

  const refetchLedger = useCallback(async () => {
    if (isMockModeRef.current) return;
    const seq = ++ledgerReqSeq.current;
    try {
      const res = await apiFetch("/api/ledger");
      if (!res.ok) return;
      const data = await res.json();
      if (seq === ledgerReqSeq.current) setLedger(data);
    } catch { /* silent */ }
  }, []);

  // 3C.2: the pane's FRESHEST raw backfill, for the burner's resync-from-truth. There is no
  // single-pane GET, so this rides /api/terminals (whose payload already carries backfill) and —
  // since it paid for the round-trip — also freshens the board through the same seq guard.
  // Mock: the harness owns state; answer from the current seeded terminals synchronously.
  const fetchPaneBackfill = useCallback(async (paneId: string): Promise<string | null> => {
    if (isMockModeRef.current) {
      return terminalsRef.current.find((t) => t.id === paneId)?.backfill ?? null;
    }
    const seq = ++terminalsReqSeq.current;
    try {
      const res = await apiFetch("/api/terminals");
      if (!res.ok) return null;
      const rows = await res.json();
      if (!Array.isArray(rows)) return null;
      if (seq === terminalsReqSeq.current) setTerminals(rows);
      return (rows as Terminal[]).find((t) => t.id === paneId)?.backfill ?? null;
    } catch { return null; }
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
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows)) setPlans(rows);
    } catch { /* silent */ }
  }, []);

  // D2: the attention inbox. GET /api/attention returns the raw queue array TOP-LEVEL (the def's
  // rest.toHttp projection, src/actions/defs/reads.ts getAttentionQueue — same shape as plans). The
  // ?mock guard mirrors the board fetchers (the harness owns state under ?mock=1; the live frames +
  // the 20s poll keep it fresh otherwise).
  const refetchAttention = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/attention");
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows)) setAttentionQueue(rows);
    } catch { /* silent */ }
  }, []);

  // Journey-expansion C: templates + layouts. Both GETs return the raw array TOP-LEVEL (the defs'
  // rest.toHttp projection, src/actions/defs/{templates,layouts}.ts — list_watch_rules precedent).
  const refetchTemplates = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/templates");
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows)) setTemplates(rows);
    } catch { /* silent */ }
  }, []);

  const refetchLayouts = useCallback(async () => {
    if (isMockModeRef.current) return;
    try {
      const res = await apiFetch("/api/layouts");
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows)) setLayouts(rows);
    } catch { /* silent */ }
  }, []);

  // j4e1: the line drawer's handoffs. list_handoffs has NO toHttp, so GET /api/handoffs rides the
  // default resultToHttp map → the redacted rows arrive under { output: [...] } (keyed handoff_id).
  // normalizeHandoffRows coalesces that into the StoredHandoff shape the drawer reads (and equally
  // adopts a future cv2 full-row payload). The convergence server broadcasts a PAYLOAD-LESS
  // handoffs_updated frame, so the live spine is ALWAYS this GET refetch — under a Playwright-armed
  // page the GET fires (3C.3b) so the e2e drives the board exactly as production does (payload-less
  // frame → GET /api/handoffs); a plain human ?mock=1 page stays fully client-side.
  const refetchHandoffs = useCallback(async () => {
    if (isMockModeRef.current && !isE2EWireArmed()) return;
    try {
      const res = await apiFetch("/api/handoffs");
      if (!res.ok) return;
      const d = await res.json().catch(() => null);
      const rows = Array.isArray(d) ? d : (d && Array.isArray(d.output) ? d.output : null);
      if (rows) setHandoffs(normalizeHandoffRows(rows));
    } catch { /* silent */ }
  }, []);

  // 4U.3: the service log — GET /api/action-log (default resultToHttp wraps the rows: {output:{rows}}).
  // Fetched on demand (the Pantry refreshes it when it opens), not on the poll — it's a review
  // surface, not a live board. Under ?mock=1 the GET fires only on a Playwright-armed page (3C.3b).
  const refetchServiceLog = useCallback(async () => {
    if (isMockModeRef.current && !isE2EWireArmed()) return;
    try {
      const res = await apiFetch("/api/action-log?limit=100");
      if (!res.ok) return;
      const d = await res.json().catch(() => null);
      const rows = d && d.output && Array.isArray(d.output.rows) ? d.output.rows : null;
      if (rows) setServiceLog(rows.slice(0, 100));
    } catch { /* silent */ }
  }, []);

  // bead apu: the health snapshot — GET /api/health (default resultToHttp wraps it: {output:{…}}).
  // Fetched on demand when the Pantry opens (a status read, not a live board), same gating as the
  // service log: under ?mock=1 the GET fires only on a Playwright-armed page (3C.3b).
  const refetchHealth = useCallback(async () => {
    if (isMockModeRef.current && !isE2EWireArmed()) return;
    try {
      const res = await apiFetch("/api/health");
      if (!res.ok) return;
      const d = await res.json().catch(() => null);
      const snap = d && d.output && typeof d.output === "object" ? d.output : null;
      if (snap) setHealthSnapshot(snap as HealthSnapshot);
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

  // 2K.1: the freezer list. Unlike the board fetchers this also FIRES under ?mock=1 (the harness
  // seeds no archive state of its own, and the e2e intercepts the GET to drive the Pantry freezer);
  // state only changes on a real ok payload, so an unrouted 404 in mock is a harmless no-op.
  const refetchArchive = useCallback(async () => {
    try {
      const res = await apiFetch("/api/archive");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.archived)) setArchived(data.archived);
    } catch { /* silent */ }
  }, []);

  const refetchAll = useCallback(() => {
    refetchTerminals();
    refetchLedger();
    refetchSettings();
    refetchPending();
    refetchActions();
    refetchPlans();
    refetchAttention();
    refetchFrozen();
    refetchArchive();
    refetchTemplates();
    refetchLayouts();
    refetchHandoffs();
  }, [refetchTerminals, refetchLedger, refetchSettings, refetchPending, refetchActions, refetchPlans, refetchAttention, refetchFrozen, refetchArchive, refetchTemplates, refetchLayouts, refetchHandoffs]);

  // ── observe-lane frame handler ───────────────────────────────────────────
  // Extracted from the socket closure (3C.1/3C.2a) so (a) the always-on observe socket and the
  // e2e harness (injectWsFrame) drive the SAME switch, and (b) the voice socket can ignore these
  // broadcast frames entirely — both sockets are in the server's broadcast set while the radio is
  // live, and double-handling would double the refetches and duplicate xterm writes.
  // Voice-only frames (audio/transcripts/grounding/channel state) live in the voice effect below.
  const handleObserveFrame = useCallback((msg: any) => {
    // velocity-mech: play the hands-free earcon this RAW frame maps to (approval_pending → "alert";
    // pane_transition with transition:"exited" → "completion"; null = no tone). Delegates to the
    // pure `playObserveEarcon` decide-and-fire gate — the SAME routing the unit test pins with a spy
    // earcon — over the voice-cues-gated `earcon` sink.
    const playFrameEarcon = () => playObserveEarcon(msg, earcon);
    // The original flat switch is replaced by a per-type dispatch table: one tiny handler per frame
    // type, each a thin closure over the same setters. The OBSERVABLE order of setState / refetch /
    // earcon / desktopNote calls inside each handler is byte-identical to the original switch arm; the
    // table just routes by type (prototype-safe Object.hasOwn lookup) instead of a giant branch ladder.
    const handlers: Record<string, () => void> = {
      stdout_chunk: () => {
        if (typeof msg.terminalId === "string" && typeof msg.chunk === "string") queueStdoutChunk(msg.terminalId, msg.chunk);
      },
      terminals_updated: () => {
        refetchTerminals();
        refetchArchive(); // 2K.1: a stop/clear/restore elsewhere must repaint the freezer too
      },
      // 3C.1: patch the matching pane IN PLACE from the frame's own fields (the classic app's
      // deliberate pattern, App.tsx:1177-1185) instead of a full refetchTerminals round-trip — the
      // heavy payload + out-of-order resolution caused the status flap this removes. A real status
      // change also clears the humble "cooking…" overlay so a stale label can't linger.
      pane_status: () => {
        if (typeof msg.terminalId === "string" && typeof msg.status === "string") {
          setTerminals((prev) => prev.map((t) => (t.id === msg.terminalId ? { ...t, status: msg.status, quiescing: false } : t)));
        }
      },
      // 3C.1: the pre-idle "cooking…" overlay flag, set in place (frame carries terminalId only).
      pane_quiescing: () => {
        if (typeof msg.terminalId === "string") {
          setTerminals((prev) => prev.map((t) => (t.id === msg.terminalId ? { ...t, quiescing: true } : t)));
        }
      },
      // velocity-mech: the server's REAL pane-exit signal. A finished pane does NOT broadcast a
      // `pane_exited` frame (there is none) — it rides `pane_transition` with transition:"exited"
      // (src/observe/index.ts ~580). Only the "exited" transition chimes the rising "completion"
      // earcon (UX_BRIEF §4 — an eyes-off chef must hear a finished pane) and patches status in place
      // (mirroring the pane_status arm). Every other transition (idle/prompt/error/build-failed) is a
      // no-op here: those edges already drive the board through their own broadcasts.
      pane_transition: () => {
        if (!isPaneExitedFrame(msg)) return;
        playFrameEarcon(); // "completion" — work finished
        if (typeof msg.terminalId === "string") {
          setTerminals((prev) => prev.map((t) => (t.id === msg.terminalId ? { ...t, status: "Exited", quiescing: false } : t)));
        }
      },
      // 2K.3: a pane's WIP draft changed server-side (Janus dictation, another view's edit). Stash the
      // latest text per pane; the Order Pad applies it ONLY while the textarea isn't focused
      // (classic App.tsx:1164-1176's focus-lock, enforced in TerminalWindow).
      draft_updated: () => {
        if (typeof msg.paneId === "string") setPaneDrafts((prev) => ({ ...prev, [msg.paneId]: { text: draftTextFromFrame(msg), at: Date.now() } }));
      },
      // 4U.2: a pane's recorded command history changed (WS-D). The frame carries the full array —
      // mirror it per-pane so an open burner repaints; a payload-less frame stores entries:null, which
      // tells the burner to refetch GET /api/terminals/:id/history.
      history_updated: () => {
        if (typeof msg.terminalId === "string") setPaneHistories((prev) => ({ ...prev, [msg.terminalId]: { entries: historyEntriesFromFrame(msg), at: Date.now() } }));
      },
      ledger_updated: () => { refetchLedger(); },
      // 4U.1: the server broadcasts the full plans board on every plan mutation — adopt it directly;
      // degrade to a refetch otherwise.
      plans_updated: () => { if (Array.isArray(msg.plans)) setPlans(msg.plans); else refetchPlans(); },
      // D2: the server broadcasts the full attention queue on every queue mutation (observe pushes,
      // orient dismisses) — adopt it directly; degrade to a refetch when the frame carries no array.
      attention_updated: () => { const q = attentionQueueFromFrame(msg); if (q) setAttentionQueue(q); else refetchAttention(); },
      // Journey-expansion C: the frame carries the RAW ledger rows (no derived `slots`). Adopt them with
      // slots re-derived through the same pure engine the server projects with (extractSlots).
      templates_updated: () => { const p = projectTemplatesFrame(msg); if (p) setTemplates(p); else refetchTemplates(); },
      // The frame carries the full layouts array — adopt it directly; degrade to a refetch otherwise.
      layouts_updated: () => { if (Array.isArray(msg.layouts)) setLayouts(msg.layouts); else refetchLayouts(); },
      // j4e1: the server broadcasts on every handoff lifecycle mutation (compose/revise/stage/deliver/
      // reject). The cv2 frame carries the full board → adopt it (normalized); the current payload-less
      // frame yields null → degrade to a refetch (GET /api/handoffs). Mirrors plans_updated.
      handoffs_updated: () => { const rows = handoffsFromFrame(msg); if (rows) setHandoffs(normalizeHandoffRows(rows)); else refetchHandoffs(); },
      settings_updated: () => {
        if (msg.settings) {
          setSettings(msg.settings as SystemSettings);
          // 1B.4: propagate the authoritative mute state so a model-driven set_voice_mute actually gates
          // mic capture (the processor reads micMutedRef). The !== guard keeps our own optimistic toggle
          // echo from bouncing it.
          if (shouldAdoptMute(msg.settings.voiceAi?.isMicMuted, micMutedRef.current)) setMicMuted(msg.settings.voiceAi.isMicMuted);
        }
        if (typeof msg.globalPermissionsMode === "string") setGlobalPermissionsMode(msg.globalPermissionsMode as GlobalMode);
      },
      switch_active_pane: () => { if (typeof msg.paneId === "string") setActiveTerminalId(msg.paneId); },
      frozen: () => { earcon("alert"); refetchFrozen(); refetchTerminals(); }, // the All Hands brake — never silent
      stop_all: () => { refetchFrozen(); refetchTerminals(); },
      // A staged PTY write awaiting HiTL approval. bead 8xn: focus-route it. When the operator is AT
      // the station (its pane is active AND the tab is visible) it pops the blocking ApprovalDialog
      // modal (the existing pendingCommands path); otherwise it lands in the attention inbox keyed by
      // messageId (e7h's id-gate makes the in-inbox Approve/Deny REAL). Either way the bell rings + a
      // background-tab desktop note fires — a pane needs you on both surfaces. The promotion effect
      // (below) moves an inbox item to the modal one-directionally when its station regains focus.
      approval_pending: () => {
        playFrameEarcon(); // the bell: a pane needs you (eyes-off) — "alert"
        desktopNote("🛎 At the pass", `${msg.terminalId} needs your ok: ${truncateCmd(msg.cmd)}`); // 2K.6 — background tab only
        const here = isApprovalHere(msg, activeTerminalIdRef.current, document.visibilityState === "visible");
        if (here) {
          setPendingCommands((prev) => prev.some((c) => c.messageId === msg.messageId) ? prev : [...prev, buildPendingCommand(msg)]);
        } else if (typeof msg.messageId === "string" && msg.messageId) {
          // Fail-closed to the inbox: no active station / wrong pane / hidden tab → a quiet, badged
          // row. Guard on a real messageId so a malformed frame never seeds a fake-approve row.
          const item = buildAttentionApprovalItem(msg);
          setAttentionQueue((prev) => prev.some((a) => a.id === item.id || (a.messageId && a.messageId === item.messageId)) ? prev : [...prev, item]);
        }
      },
      approval_resolved: () => {
        // bead 8xn — "resolve anywhere clears EVERYWHERE." A held approval lives on exactly one
        // surface (modal pendingCommands OR the focus-routed inbox), so resolving it via voice/REST/
        // modal/TTL-sweep must drop it from BOTH. The server broadcast carries only the messageId;
        // clear it from pendingCommands AND any inbox row keyed by it (the inbox row is client-
        // synthesized and is NOT part of manager.attentionQueue, so attention_updated never clears it).
        if (msg.messageId) {
          setPendingCommands((prev) => prev.filter((c) => c.messageId !== msg.messageId));
          setAttentionQueue((prev) => prev.filter((a) => !a.messageId || a.messageId !== msg.messageId));
        }
        refetchPending();
      },
      // A gated non-PTY mutator staged on the Ask tier — carry the SERVER-resolved effective posture so
      // the confirm dialog can render the rider + divergence.
      action_pending: () => {
        earcon("alert"); // needs a taste at the pass
        desktopNote("🛎 Needs a taste", typeof msg.summary === "string" ? msg.summary : "An action is waiting at the pass"); // 2K.6
        setPendingActions((prev) => prev.some((a) => a.actionId === msg.actionId) ? prev : [...prev, buildPendingAction(msg)]);
      },
      action_resolved: () => { if (msg.actionId) setPendingActions((prev) => prev.filter((a) => a.actionId !== msg.actionId)); },
      // 1B.7: end silent autonomy — the kitchen says WHAT fired where. showToast carries the "execute"
      // earcon itself (no doubled tone) + the transcript line.
      command_auto_executed: () => {
        showToast(`Fired on its own — ${msg.terminalId}: ${truncateCmd(msg.cmd)}`, "fire", "execute");
        desktopNote("▶ Fired on its own", `${msg.terminalId}: ${truncateCmd(msg.cmd)}`); // 2K.6
        refetchPending();
      },
      // 1B.7: a blocked command names the pane, the command and the server's reason.
      command_blocked: () => {
        showToast(blockedToastText(msg.terminalId, truncateCmd(msg.cmd), msg.reason), "warn");
        desktopNote("⛔ Held back", `${msg.terminalId}: ${truncateCmd(msg.cmd)}`); // 2K.6
        refetchPending();
      },
      // 1B.7: the orchestrator's proactive announcements reach the kitchen too. earcon: null — the bus
      // already fired its own proactive_earcon for this event.
      proactive_notification: () => {
        if (typeof msg.message === "string" && msg.message) {
          showToast(msg.message, msg.severity === "high" ? "warn" : "fire", null);
          desktopNote("👨‍🍳 From the kitchen", msg.message); // 2K.6
        }
      },
      // 1B.7: immediate non-verbal feedback for a proactive event (fires before the notification frame).
      proactive_earcon: () => { if (isEarconType(msg.earcon)) earcon(msg.earcon); },
      error: () => {
        setToast({ msg: typeof msg.message === "string" ? msg.message : "Radio hiccup — try again", kind: "warn" });
        setTimeout(() => setToast(null), 4000);
      },
      // A-1a (inc2): track daemon up/down transitions for the DaemonStateBadge. Best-effort:
      // a malformed frame (missing or invalid `state` field) is silently ignored — the badge
      // stays at its last-known value, which is the safest observable-degradation posture.
      daemon_state: () => {
        if (msg.state === "python" || msg.state === "fallback") setDaemonState(msg.state);
      },
    };
    const type = msg?.type;
    if (typeof type === "string" && Object.hasOwn(handlers, type)) handlers[type]();
  }, [queueStdoutChunk, refetchTerminals, refetchArchive, refetchLedger, refetchPlans, refetchAttention, refetchTemplates, refetchLayouts, refetchHandoffs, refetchFrozen, refetchPending, earcon, desktopNote, showToast]);

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
    // 1B.1/1B.5 e2e seam: lets Playwright drive the connection truth-states the client renders
    // (offline pill / "TUNING IN…" / "MIC BLOCKED") — the mock harness has no real sockets.
    setConnMock: (s) => {
      if (typeof s.stream === "boolean") setStreamConnected(s.stream);
      if (typeof s.voice === "boolean") setVoiceConnected(s.voice);
      if (typeof s.micBlocked === "boolean") setMicBlocked(s.micBlocked);
    },
    // 2K.3 e2e seam: stage a server-pushed draft_updated for a pane (the harness has no real WS),
    // driving the same per-pane mirror state the live socket writes.
    setPaneDraftMock: (paneId, text) => {
      setPaneDrafts((prev) => ({ ...prev, [paneId]: { text, at: Date.now() } }));
    },
    // 3C.1 e2e seam: feed a frame through the REAL observe-lane switch (no real WS under ?mock=1),
    // so the in-place pane_status/pane_quiescing patch is pinned through the production path.
    onWsFrame: (frame) => handleObserveFrame(frame),
    // 3C.2 e2e seam: model the observe socket dropping + reopening — the same generation bump a
    // real reconnect makes, which drives the mounted TerminalView's resync-with-marker.
    bumpStreamGeneration: () => {
      setStreamConnected(true);
      setStreamGeneration((g) => g + 1);
    },
  });

  // Under the ?mock=1 harness there is no real server, so seed settings once so Back of House renders.
  useEffect(() => {
    if (isMock && !settings) setSettings(MOCK_SETTINGS);
  }, [isMock, settings]);

  // 1B.1: the harness is client-only (no real /live socket), so the kitchen reads as open under
  // ?mock=1 — the e2e setConnMock hook can still flip it to drive the offline pill.
  useEffect(() => {
    if (isMock) setStreamConnected(true);
  }, [isMock]);

  // 1B.6: apply the persisted playback volume (Back of House → voice volume) to the audio layer
  // whenever settings load or change (mirrors classic App.tsx — setPlaybackVolume clamps/normalizes).
  useEffect(() => {
    const vol = settings?.voiceAi?.volume;
    if (typeof vol === "number") setPlaybackVolume(vol);
  }, [settings?.voiceAi?.volume]);

  // 4U.3: persist the radio transcript across reloads (sessionStorage; the slice(-50) writers
  // already cap the in-memory list, the slice here re-asserts the cap on the wire format).
  useEffect(() => {
    try { sessionStorage.setItem(TRANSCRIPT_STORE_KEY, JSON.stringify(transcript.slice(-50))); }
    catch { /* sandboxed/full storage — the in-memory radio still works */ }
  }, [transcript]);

  // Mount: initial fetch + slow safety-net poll (the realtime push wave is P5).
  useEffect(() => {
    refetchAll();
    const iv = setInterval(() => {
      refetchTerminals();
      refetchLedger(); // re-derive elapsed_ms / last_command so running cards don't read frozen at a glance
      refetchPending();
      refetchActions();
      refetchPlans();
      refetchAttention(); // D2: keep the "what needs me" inbox fresh on the safety-net poll too
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [refetchAll, refetchTerminals, refetchLedger, refetchPending, refetchActions, refetchPlans, refetchAttention]);

  // bead 8xn: PROMOTE an inbox-routed approval to the modal when its station regains the operator's
  // attention — either the active station changes TO it, or the tab regains focus while it's active.
  // One-directional (inbox → modal only; never modal → inbox on blur). The move is keyed by messageId
  // and dedups against pendingCommands, so a concurrent voice/REST resolve can't resurrect it.
  const promoteApprovalForActive = useCallback(() => {
    if (document.visibilityState !== "visible") return; // only promote when the operator can see it
    const item = approvalToPromote(attentionQueueRef.current, activeTerminalIdRef.current);
    if (!item) return;
    setAttentionQueue((prev) => prev.filter((a) => a.id !== item.id));         // leave the inbox
    // Rebuild the PendingCommand from the RAW cmd (item.rawCmd), NOT the wrapped inbox label in
    // item.message — the ApprovalDialog must render the real instruction, not "<pane> needs your ok: …".
    setPendingCommands((prev) => prev.some((c) => c.messageId === item.messageId)
      ? prev
      : [...prev, buildPendingCommand({ messageId: item.messageId, cmd: item.rawCmd ?? "", terminalId: item.terminalId })]); // pop the modal
  }, []);

  // Fires on every active-station change (the dep) AND on a tab visibilitychange (the listener).
  useEffect(() => {
    promoteApprovalForActive();
    const onVis = () => promoteApprovalForActive();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [activeTerminalId, promoteApprovalForActive]);

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

  // ── 3C.3a: a 4001 close is TERMINAL (the server's unauthorized close — src/voice/index.ts
  // rejects a bad/missing auth cookie with close(4001)). Retrying can never re-key a cookie —
  // reload ONCE to pick up fresh auth; a sessionStorage flag makes a reload loop impossible
  // (a second 4001 only toasts). The flag is cleared on any authorized open.
  const handleUnauthorizedClose = useCallback(() => {
    let alreadyReloaded = false;
    try { alreadyReloaded = sessionStorage.getItem(UNAUTH_RELOAD_KEY) === "1"; } catch { /* sandboxed storage */ }
    if (alreadyReloaded) {
      showToast("Session expired — reload to re-key.", "warn");
      return;
    }
    try { sessionStorage.setItem(UNAUTH_RELOAD_KEY, "1"); } catch { /* sandboxed storage */ }
    showToast("Session expired — re-keying the kitchen…", "warn");
    setTimeout(() => window.location.reload(), 800); // let the toast paint before the reload
  }, [showToast]);
  const clearUnauthorizedFlag = useCallback(() => {
    try { sessionStorage.removeItem(UNAUTH_RELOAD_KEY); } catch { /* sandboxed storage */ }
  }, []);

  // ── 3C.2a: TWO sockets, decoupled lifetimes ──────────────────────────────
  // The old design keyed ONE socket on `voiceLive`, so tuning the radio in/out tore down and
  // rebuilt the data lane — every toggle silently dropped PTY chunks. Now:
  //   • OBSERVE (this effect, mounted once): /live?observe=1 — the always-on data lane
  //     (stdout_chunk → xterm, board/ledger/freeze realtime, approval/action chips,
  //     set_active_pane/draft_edit out). wsRef points here. The radio never touches it.
  //   • VOICE (next effect, keyed on voiceLive): /live — the Gemini session lane (mic out, model
  //     audio in, transcripts, grounding, channel state). voiceWsRef points here.
  // Both sockets join the server's broadcast set, so the voice lane IGNORES broadcast frames
  // (handleObserveFrame owns them) — otherwise refetches would double-fire and chunks would be
  // written into xterm twice. Skipped in mock (the harness drives the setters directly); the 20s
  // poll stays as a safety net.
  useEffect(() => {
    if (isMockModeRef.current) return;
    let closedByUs = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // TRUE once we've lost (or failed to make) the stream — the next open is then a RECONNECT,
    // which bumps streamGeneration so mounted terminals rebuild from a fresh snapshot (3C.2b).
    let droppedSinceOpen = false;

    const scheduleReconnect = () => {
      if (closedByUs || reconnectTimer) return;
      attempt = Math.min(attempt + 1, 6);
      const delay = Math.min(500 * 2 ** (attempt - 1), 15000); // bounded backoff, 0.5s→15s
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    };

    const connect = () => {
      if (closedByUs) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      let ws: WebSocket;
      try { ws = new WebSocket(`${protocol}//${window.location.host}/live?observe=1`); }
      catch { droppedSinceOpen = true; scheduleReconnect(); return; }
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStreamConnected(true);
        clearUnauthorizedFlag(); // an authorized open re-arms the one-shot 4001 reload
        // Re-assert the open pane so operator raw-input / draft writes target it through the gate.
        if (activeTerminalIdRef.current && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "set_active_pane", paneId: activeTerminalIdRef.current }));
        }
        // 1B.1: a reconnect must RESYNC, not just re-arm — anything missed while dark (board,
        // pending chips, freeze state, settings) is refetched the moment the socket is back.
        refetchAll();
        if (droppedSinceOpen) {
          droppedSinceOpen = false;
          setStreamGeneration((g) => g + 1); // 3C.2b: mounted terminals resync from snapshot truth
        }
      };
      ws.onmessage = (event) => {
        // The /live frame is an untyped JSON blob (same as the classic app's ws.onmessage). Field
        // access is guarded per-case inside handleObserveFrame.
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }
        handleObserveFrame(msg);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        setStreamConnected(false);
        droppedSinceOpen = true;
        if (closedByUs) return;
        if (ev.code === 4001) { handleUnauthorizedClose(); return; } // terminal — never retry into a dead key
        scheduleReconnect();
      };
    };

    connect();
    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws) { try { ws.close(); } catch { /* noop */ } wsRef.current = null; }
    };
  }, [handleObserveFrame, refetchAll, handleUnauthorizedClose, clearUnauthorizedFlag]);

  // ── voice lane: the Gemini Live session socket (radio only) ──────────────
  // Opened when the operator tunes in, closed when they tune out — WITHOUT touching the observe
  // socket above (3C.2a: tuning the radio must never drop terminal output). Handles ONLY the
  // per-session voice frames; broadcast frames that also reach this socket fall through to the
  // default arm (the observe lane owns them — no double refetch, no double xterm write).
  useEffect(() => {
    if (isMockModeRef.current) return;
    if (!voiceLive) return;
    let closedByUs = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (closedByUs || reconnectTimer) return;
      if (!desiredVoiceRef.current) return; // voice only reconnects while the operator wants it
      attempt = Math.min(attempt + 1, 6);
      const delay = Math.min(500 * 2 ** (attempt - 1), 15000); // bounded backoff, 0.5s→15s
      setVoiceReconnecting(true);
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
        // 1B.5: a denied/failed mic must be LOUD — the chip said "I'm listening, Chef" forever while
        // nothing was captured. Flag it (KitchenRadio renders "MIC BLOCKED") and tell the operator.
        console.error("Mic capture failed to start:", err);
        setMicBlocked(true);
        showToast("Mic's blocked, Chef — check browser permissions.", "warn");
      }
    };

    const connect = () => {
      if (closedByUs) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      let ws: WebSocket;
      try { ws = new WebSocket(`${protocol}//${window.location.host}/live`); }
      catch { scheduleReconnect(); return; }
      voiceWsRef.current = ws;

      const captureCtx = new AudioContext({ sampleRate: 16000 });
      const playbackCtx = new AudioContext({ sampleRate: 24000 });
      applyOutputDevice(playbackCtx);
      captureCtxRef.current = captureCtx;
      playbackCtxRef.current = playbackCtx;
      resetAudioPlayback();

      ws.onopen = () => {
        attempt = 0;
        setVoiceConnected(true);
        setVoiceReconnecting(false);
        clearUnauthorizedFlag();
        // Tell the session which pane is open so model writes are gated against the right target.
        if (activeTerminalIdRef.current && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "set_active_pane", paneId: activeTerminalIdRef.current }));
        }
        startMic(ws, captureCtx);
      };
      ws.onmessage = (event) => {
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }
        // Split into the audio/transcript half and the channel-state half so neither arrow trips the
        // complexity gate; the per-case setState/audio ordering is unchanged from the flat switch.
        const handleVoiceMedia = (): boolean => {
          switch (msg.type) {
            // ── voice-only frames (Kitchen Radio) ──
            case "audio":
              if (typeof msg.audio === "string") playAudioChunk(playbackCtx, msg.audio);
              return true;
            case "interrupted":
              resetAudioPlayback();
              return true;
            case "transcript_text":
              if ((msg.sender === "User" || msg.sender === "Janus") && typeof msg.text === "string") {
                setTranscript((prev) => [...prev, { sender: msg.sender, text: msg.text, timestamp: new Date() }].slice(-50));
              }
              return true;
            case "grounding":
              // Attach grounded sources/queries to the most recent Janus turn (no-op if none yet).
              setTranscript((prev) => attachGrounding(prev, msg.sources, msg.queries));
              return true;
            default:
              return false;
          }
        };
        const handleVoiceChannel = (): void => {
          switch (msg.type) {
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
            case "voice_channel_restored":
              // 2K.6: the Gemini channel came back after a transient drop. The all-clear must be as
              // loud as the loss was: success earcon + toast + a durable transcript line (showToast
              // carries all three) and the reconnecting tell stands down.
              setVoiceReconnecting(false);
              showToast("Back on the air.", "fire", "success");
              break;
            case "error":
              setToast({ msg: typeof msg.message === "string" ? msg.message : "Radio hiccup — try again", kind: "warn" });
              setTimeout(() => setToast(null), 4000);
              resetAudioPlayback();
              break;
            default:
              // Broadcast/board frames also reach this socket — the observe lane owns them.
              break;
          }
        };
        if (!handleVoiceMedia()) handleVoiceChannel();
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
      ws.onclose = (ev) => {
        if (voiceWsRef.current === ws) voiceWsRef.current = null;
        setVoiceConnected(false); // 1B.5: the chip must stop saying LIVE the moment the channel drops
        teardownAudio();
        if (closedByUs) return;
        if (ev.code === 4001) {
          // 3C.3a: terminal — retrying can't re-key. Stand the radio down, then the one-shot reload.
          desiredVoiceRef.current = false;
          setVoiceLive(false);
          setVoiceReconnecting(false);
          handleUnauthorizedClose();
          return;
        }
        if (desiredVoiceRef.current) scheduleReconnect();
        else { setVoiceLive(false); setVoiceReconnecting(false); }
      };
    };

    connect();
    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = voiceWsRef.current;
      if (ws) { try { ws.close(); } catch { /* noop */ } voiceWsRef.current = null; }
      teardownAudio();
    };
  }, [voiceLive, teardownAudio, earcon, showToast, handleUnauthorizedClose, clearUnauthorizedFlag]);

  // The UI is the source of truth for the single active pane. Echo it whenever it changes and a
  // socket is open — BOTH lanes accept set_active_pane (3C.2a), so the voice session and the
  // observe gate stay in agreement about the open pane.
  const selectActivePane = useCallback((paneId: string | null) => {
    setActiveTerminalId(paneId);
    for (const ws of [wsRef.current, voiceWsRef.current]) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "set_active_pane", paneId }));
      }
    }
  }, []);

  // ── Kitchen Radio: tune in / off-air / mute ─────────────────────────────
  // Tuning in opens the SEPARATE voice socket (the voice effect above keys on voiceLive); the
  // observe data lane is untouched either way (3C.2a). desiredVoiceRef is the reconnect
  // kill-switch: a dropped session only auto-reconnects while the operator still wants to be
  // live. Mute gates outbound mic frames without a teardown.
  const goLive = useCallback(() => {
    desiredVoiceRef.current = true;
    // 2K.6: the first tune-in is the user gesture that may ask for desktop-notification
    // permission (no-op once decided, gated by the "Desktop notes" tweak).
    if (desktopNotesRef.current) requestNotifyPermission();
    setMicMuted(false);
    setMicBlocked(false); // a fresh tune-in retries the mic — re-flagged on failure
    setVoiceLive(true);
    // ?mock=1 is client-only (no real socket): mirror the connected state so the live UI renders;
    // the e2e setConnMock hook can still drive the "TUNING IN…" window explicitly.
    if (isMockModeRef.current) setVoiceConnected(true);
  }, []);
  const stopLive = useCallback(() => { desiredVoiceRef.current = false; setVoiceLive(false); setVoiceConnected(false); }, []);
  const toggleMute = useCallback(() => setMicMuted((m) => !m), []);

  // ── mutations (the real backend writes; gated routes may 202/403) ───────
  const setGlobalMode = useCallback(async (mode: GlobalMode) => {
    setGlobalPermissionsMode(mode); // optimistic
    showToast(globalModeToast(mode));
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
    // 3C.3b: the PUT fires under ?mock=1 ONLY on a Playwright-armed page (the e2e intercepts +
    // asserts the wire). A human's manual ?mock=1 stays client-side — the old unconditional PUT
    // let the mock fixture overwrite a real deployment's live settings. Only adopts the server
    // echo when it actually returns a settings object, so a thin ack can't wipe optimistic state.
    if (mockClientOnly()) { showToast("Rulebook updated."); return; }
    try {
      const res = await apiFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        if (hasSettingsEcho(d)) setSettings(d.settings as unknown as SystemSettings);
        if (d && typeof d.globalPermissionsMode === "string") setGlobalPermissionsMode(d.globalPermissionsMode);
        showToast("Rulebook updated."); // 1B.3: a settings write acks — never a silent maybe
      } else {
        // 1B.3: failed write → say so AND reconcile the optimistic state with server truth.
        showToast("That didn't save, Chef — try again.", "warn");
        refetchSettings();
      }
    } catch {
      showToast("That didn't save, Chef — try again.", "warn");
      refetchSettings();
    }
  }, [showToast, refetchSettings, mockClientOnly]);

  const createPane = useCallback(async (opts: { projectId: string; toolPreset: string; permissionsMode: string; name?: string }) => {
    const ws = (Object.values(ledger) as Workspace[]).find((w) => w.id === opts.projectId);
    const cwd = ws?.directory || "~";
    const slug = paneSlug(opts.name);
    const terminalId = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const cmdFor = (tp: string) => resolvePaneCommand(tp, settings?.presets);
    if (isMockModeRef.current) { showToast(`Fired up ${terminalId} 🔥`); return; }
    try {
      const res = await apiFetch("/api/terminals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminalId, cwd, command: cmdFor(opts.toolPreset), toolPreset: opts.toolPreset, permissionsMode: opts.permissionsMode, projectId: opts.projectId }),
      });
      if (res.status === 403) { showToast("Not in my kitchen — that's gated off", "warn"); return; }
      if (res.status === 202) { showToast("Queued — needs your ok at the pass 🛎", "warn"); return; }
      if (res.ok) { refetchTerminals(); refetchLedger(); selectActivePane(terminalId); showToast(`Fired up ${terminalId} 🔥`); }
      else showToast("Couldn't fire that station, Chef — try again.", "warn"); // 1B.3: no silent failures
    } catch { showToast("Couldn't fire that station, Chef — try again.", "warn"); }
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
      else showToast("Couldn't open that kitchen, Chef — try again.", "warn"); // 1B.3: no silent failures
    } catch { showToast("Couldn't open that kitchen, Chef — try again.", "warn"); }
  }, [showToast, refetchLedger]);

  // Edit a project's About (summary). PUT /api/projects/:id {summary} (ungated). Optimistic; under
  // ?mock=1 the wire fires only on a Playwright-armed page (3C.3b) so the Pantry e2e can assert it
  // while a human's manual mock stays client-side. Summary-only — touches no other project field.
  const updateProjectSummary = useCallback(async (projectId: string, summary: string) => {
    setLedger((prev) => (prev[projectId] ? { ...prev, [projectId]: { ...prev[projectId], summary } } : prev));
    if (mockClientOnly()) return;
    try {
      const res = await apiFetch(`/api/projects/${projectId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary }) });
      if (res.ok) { if (!isMockModeRef.current) refetchLedger(); }
      else showToast("Couldn't save the About", "warn");
    } catch { /* silent */ }
  }, [refetchLedger, showToast, mockClientOnly]);

  // Re-fire a station (restart its process). Targets a real pane id; under ?mock=1 the wire fires
  // only on a Playwright-armed page (3C.3b — the e2e intercepts + asserts the POST).
  const restartPane = useCallback(async (id: string) => {
    if (mockClientOnly()) { showToast("Re-firing the station 🔥"); return; }
    try {
      const res = await apiFetch(`/api/terminals/${id}/restart`, { method: "POST" });
      if (res.status === 403) { showToast("Re-fire is gated off", "warn"); return; }
      if (res.status === 202) { showToast("Re-fire queued — needs your ok 🛎", "warn"); return; }
      // 1B.3: "Re-firing 🔥" only when the server actually accepted the restart.
      if (!res.ok) { showToast("Re-fire didn't go through, Chef — try again.", "warn"); return; }
      refetchTerminals(); refetchLedger(); showToast("Re-firing the station 🔥");
    } catch { showToast("Re-fire didn't go through, Chef — try again.", "warn"); }
  }, [refetchTerminals, refetchLedger, showToast, mockClientOnly]);

  // ── 2K.1: pane lifecycle (the classic app's routes, kitchen-toned) ───────
  // Like restartPane, these target real ids; under ?mock=1 the REAL request fires only on a
  // Playwright-armed page (3C.3b — the e2e intercepts + asserts the wire; a human's manual mock
  // keeps the optimistic ack, client-side). Honest-feedback pattern: against a real server the
  // success ack fires only after the server said ok; failures warn, never a false ack.

  // "86 this station" — graceful stop + archive (recoverable). Classic: handleStopPane (App.tsx:1613).
  const stopPane = useCallback(async (projectId: string, paneId: string) => {
    if (mockClientOnly()) { showToast(`86'd ${paneId} — it's in the freezer if you need it back`, "fire", "execute"); return; }
    try {
      const res = await apiFetch(`/api/projects/${projectId || "default_project"}/panes/${paneId}/stop`, { method: "POST" });
      if (!res.ok) { showToast("Couldn't 86 that station, Chef — try again.", "warn"); return; }
      showToast(`86'd ${paneId} — it's in the freezer if you need it back`, "fire", "execute");
      if (!isMockModeRef.current) { refetchTerminals(); refetchLedger(); refetchArchive(); }
    } catch { showToast("Couldn't 86 that station, Chef — try again.", "warn"); }
  }, [refetchTerminals, refetchLedger, refetchArchive, showToast, mockClientOnly]);

  // Rename a station — PUT …/rename {name}. Classic: handleRenamePane (App.tsx:1646).
  const renamePane = useCallback(async (projectId: string, paneId: string, name: string) => {
    const n = name.trim();
    if (!n) return;
    if (mockClientOnly()) { showToast(`Station's now "${n}"`); return; }
    try {
      const res = await apiFetch(`/api/projects/${projectId || "default_project"}/panes/${paneId}/rename`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }),
      });
      if (!res.ok) { showToast("That rename didn't stick, Chef — try again.", "warn"); return; }
      showToast(`Station's now "${n}"`);
      if (!isMockModeRef.current) refetchLedger();
    } catch { showToast("That rename didn't stick, Chef — try again.", "warn"); }
  }, [refetchLedger, showToast, mockClientOnly]);

  // Clear exited — archive every Exited pane in the active project. Classic: handleClearExited
  // (App.tsx:645, POST /api/terminals/clear-exited).
  const clearExited = useCallback(async () => {
    if (mockClientOnly()) { showToast("Cleared the exited stations into the freezer 🧊", "fire", "execute"); return; }
    try {
      const res = await apiFetch("/api/terminals/clear-exited", { method: "POST" });
      if (!res.ok) { showToast("Couldn't clear the line, Chef — try again.", "warn"); return; }
      showToast("Cleared the exited stations into the freezer 🧊", "fire", "execute");
      if (!isMockModeRef.current) { refetchTerminals(); refetchLedger(); refetchArchive(); }
    } catch { showToast("Couldn't clear the line, Chef — try again.", "warn"); }
  }, [refetchTerminals, refetchLedger, refetchArchive, showToast, mockClientOnly]);

  // Restore from the freezer. Classic: handleRestoreArchived (App.tsx:671).
  const restoreArchived = useCallback(async (paneId: string) => {
    if (mockClientOnly()) {
      setArchived((prev) => prev.filter((a) => a.pane_id !== paneId)); // keep the tray honest
      showToast(`${paneId} is back on the line`, "fire", "success");
      return;
    }
    try {
      const res = await apiFetch(`/api/archive/${paneId}/restore`, { method: "POST" });
      if (!res.ok) { showToast("Couldn't thaw that one, Chef — try again.", "warn"); return; }
      showToast(`${paneId} is back on the line`, "fire", "success");
      if (!isMockModeRef.current) { refetchArchive(); refetchLedger(); refetchTerminals(); }
      else setArchived((prev) => prev.filter((a) => a.pane_id !== paneId)); // mock: keep the tray honest
    } catch { showToast("Couldn't thaw that one, Chef — try again.", "warn"); }
  }, [refetchArchive, refetchLedger, refetchTerminals, showToast, mockClientOnly]);

  // Permanently delete an archived pane. Classic: handleDeleteArchived (App.tsx:681).
  const deleteArchived = useCallback(async (paneId: string) => {
    if (mockClientOnly()) {
      setArchived((prev) => prev.filter((a) => a.pane_id !== paneId));
      showToast(`Tossed ${paneId} for good`, "fire", "execute");
      return;
    }
    try {
      const res = await apiFetch(`/api/archive/${paneId}`, { method: "DELETE" });
      if (!res.ok) { showToast("Couldn't toss that one, Chef — try again.", "warn"); return; }
      showToast(`Tossed ${paneId} for good`, "fire", "execute");
      if (!isMockModeRef.current) refetchArchive();
      else setArchived((prev) => prev.filter((a) => a.pane_id !== paneId));
    } catch { showToast("Couldn't toss that one, Chef — try again.", "warn"); }
  }, [refetchArchive, showToast, mockClientOnly]);

  // D2: dismiss one attention item — POST /api/attention/:id/dismiss (dismiss_attention, veto-class,
  // Auto by default). Optimistic drop so the inbox clears instantly; the server's attention_updated
  // frame reconciles the authoritative queue. On a real failure the item is restored and we warn.
  const dismissAttention = useCallback(async (id: string) => {
    let removed: AttentionItem | undefined;
    setAttentionQueue((prev) => { removed = prev.find((a) => a.id === id) ?? removed; return prev.filter((a) => a.id !== id); });
    const restore = () => { const r = removed; if (r) setAttentionQueue((prev) => (prev.some((a) => a.id === r.id) ? prev : [...prev, r])); };
    if (mockClientOnly()) { showToast("Cleared that alert"); return; }
    try {
      const res = await apiFetch(`/api/attention/${id}/dismiss`, { method: "POST" });
      // A dismiss is veto-class: gated-Off does NOT 403, it returns kind:ok -> 200 with an "Error:"-
      // wrapped output, so a bare 200 is not proof the alert cleared (see dismissAttentionOutcome).
      const body = res.ok ? await res.json().catch(() => ({} as Record<string, unknown>)) : {};
      const outcome = dismissAttentionOutcome(res.status, res.ok, body);
      if (outcome === "blocked") { restore(); showToast("Dismissing alerts is gated off, Chef", "warn"); return; }
      if (outcome === "failed") { restore(); showToast("That didn't go through, Chef — try again.", "warn"); return; }
      showToast("Cleared that alert");
      if (!isMockModeRef.current) refetchAttention();
    } catch { restore(); showToast("That didn't go through, Chef — try again.", "warn"); }
  }, [refetchAttention, showToast, mockClientOnly]);

  // ── 4U.1: plans on The Pass (the classic Spec Buffer's routes, kitchen-toned) ──
  // execute_plan runs step 1 through the gate INSIDE the server (dispatchProposal), so the REST
  // status carries the whole truth: 200 fired / 202 step-1 needs an ok / 403 gated off /
  // 400 pane offline / 404 unknown plan / 409 clarify. The board repaints off plans_updated.
  const executePlan = useCallback(async (planId: string) => {
    if (mockClientOnly()) { showToast("Spec's firing — step 1 on the line 🔥", "fire", "execute"); return; }
    try {
      const res = await apiFetch(`/api/plans/${planId}/execute`, { method: "POST" });
      if (res.status === 202) { showToast("Spec queued — step 1 needs your ok at the pass 🛎", "warn"); }
      else if (res.status === 403) { showToast("That spec's gated off, Chef", "warn"); }
      else if (!res.ok) {
        // 400 (pane offline) carries {output}, 404 {error}-ish, 409 {clarify} — surface whichever.
        const d = await res.json().catch(() => ({} as Record<string, unknown>));
        const msg = [d.output, d.error, d.clarify].find((v) => typeof v === "string" && v) as string | undefined;
        showToast(msg || "Couldn't fire that spec, Chef — try again.", "warn");
      } else {
        showToast("Spec's firing — step 1 on the line 🔥", "fire", "execute");
      }
      if (!isMockModeRef.current) refetchPlans();
    } catch { showToast("Couldn't fire that spec, Chef — try again.", "warn"); }
  }, [refetchPlans, showToast, mockClientOnly]);

  // 86 a plan — DELETE /api/plans/:id (delete_orchestrator_plan, gated Ask by default → may 202).
  const deletePlan = useCallback(async (planId: string) => {
    if (mockClientOnly()) {
      setPlans((prev) => prev.filter((p) => p.id !== planId)); // keep the pass honest client-side
      showToast("86'd that spec", "fire", "execute");
      return;
    }
    try {
      const res = await apiFetch(`/api/plans/${planId}`, { method: "DELETE" });
      if (res.status === 202) { showToast("86 queued — needs your ok at the pass 🛎", "warn"); return; }
      if (res.status === 403) { showToast("That 86 is gated off, Chef", "warn"); return; }
      if (!res.ok) { showToast("Couldn't 86 that spec, Chef — try again.", "warn"); return; }
      showToast("86'd that spec", "fire", "execute");
      if (!isMockModeRef.current) refetchPlans();
      else setPlans((prev) => prev.filter((p) => p.id !== planId)); // armed mock: no real refetch
    } catch { showToast("Couldn't 86 that spec, Chef — try again.", "warn"); }
  }, [refetchPlans, showToast, mockClientOnly]);

  // ── Journey-expansion C: prompt templates (the cookbook) + pane layouts (mise en place) ──
  // Same REST mapping as plans (src/actions/rest.ts resultToHttp): 200 ok {output} / 202 pending /
  // 403 blocked {error} / 409 {clarify}. The board repaints off templates_updated/layouts_updated
  // frames; the post-success refetch is the safety net for a missed frame. Honest-feedback rules
  // apply: success acks only after the server said ok; 200-narrations that are really refusals
  // ("not found", "no live panes") surface as warnings, never a false ack.

  const createTemplate = useCallback(async (opts: { name: string; body: string; description?: string }) => {
    if (mockClientOnly()) {
      const now = Date.now();
      setTemplates((prev) => [...prev, {
        id: `tmp-${Math.random().toString(36).slice(2, 8)}`, name: opts.name, description: opts.description ?? "",
        body: opts.body, slots: extractSlots(opts.body), created_at: now, updated_at: now,
      }]);
      showToast("Template's in the cookbook 🧾");
      return;
    }
    try {
      const res = await apiFetch("/api/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) });
      if (res.status === 202) { showToast("Save queued — needs your ok at the pass 🛎", "warn"); return; }
      if (res.status === 403) { showToast("Saving templates is gated off, Chef", "warn"); return; }
      if (!res.ok) { showToast("Couldn't save that template, Chef — try again.", "warn"); return; }
      showToast("Template's in the cookbook 🧾");
      if (!isMockModeRef.current) refetchTemplates();
    } catch { showToast("Couldn't save that template, Chef — try again.", "warn"); }
  }, [refetchTemplates, showToast, mockClientOnly]);

  const updateTemplate = useCallback(async (id: string, opts: { name?: string; body?: string; description?: string }) => {
    if (mockClientOnly()) {
      setTemplates((prev) => prev.map((t) => (t.id === id ? {
        ...t,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.body !== undefined ? { body: opts.body, slots: extractSlots(opts.body) } : {}),
        updated_at: Date.now(),
      } : t)));
      showToast("Template updated 🧾");
      return;
    }
    try {
      const res = await apiFetch(`/api/templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) });
      if (res.status === 202) { showToast("Edit queued — needs your ok at the pass 🛎", "warn"); return; }
      if (res.status === 403) { showToast("Editing templates is gated off, Chef", "warn"); return; }
      if (!res.ok) { showToast("That edit didn't stick, Chef — try again.", "warn"); return; }
      showToast("Template updated 🧾");
      if (!isMockModeRef.current) refetchTemplates();
    } catch { showToast("That edit didn't stick, Chef — try again.", "warn"); }
  }, [refetchTemplates, showToast, mockClientOnly]);

  const deleteTemplate = useCallback(async (id: string) => {
    if (mockClientOnly()) {
      setTemplates((prev) => prev.filter((t) => t.id !== id)); // keep the pass honest client-side
      showToast("86'd that template", "fire", "execute");
      return;
    }
    try {
      const res = await apiFetch(`/api/templates/${id}`, { method: "DELETE" });
      if (res.status === 202) { showToast("86 queued — needs your ok at the pass 🛎", "warn"); return; }
      if (res.status === 403) { showToast("That 86 is gated off, Chef", "warn"); return; }
      if (!res.ok) { showToast("Couldn't 86 that template, Chef — try again.", "warn"); return; }
      showToast("86'd that template", "fire", "execute");
      if (!isMockModeRef.current) refetchTemplates();
      else setTemplates((prev) => prev.filter((t) => t.id !== id)); // armed mock: no real refetch
    } catch { showToast("Couldn't 86 that template, Chef — try again.", "warn"); }
  }, [refetchTemplates, showToast, mockClientOnly]);

  // Fill a pane's WIP draft from a template. The instantiated text lands on the pane's EXISTING
  // draft surface (setDraft + draft_updated — the same Order Pad mirror 2K.3 already paints), so
  // the review-then-gated-send loop stays the single write choke-point. A 200 can still be an
  // ok-narration refusal (unknown id / pane not running) — only a genuine apply gets the ack.
  const applyTemplate = useCallback(async (id: string, paneId: string, values: { name: string; value: string }[]) => {
    if (mockClientOnly()) { showToast(`Draft's filled on ${paneId} — review it at the station 📝`); return; }
    try {
      const res = await apiFetch(`/api/templates/${id}/apply`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pane_id: paneId, values }),
      });
      const d = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.status === 409) {
        // clarify: the slot list drifted under us (body edited elsewhere) — say so + resync.
        showToast(templateClarifyText(d), "warn");
        if (!isMockModeRef.current) refetchTemplates();
        return;
      }
      if (!res.ok) {
        showToast(firstServerMessage(d) || "Couldn't fill that draft, Chef — try again.", "warn");
        return;
      }
      const t = templateApplyToast(d, paneId);
      showToast(t.msg, t.kind);
    } catch { showToast("Couldn't fill that draft, Chef — try again.", "warn"); }
  }, [refetchTemplates, showToast, mockClientOnly]);

  // Snapshot the current setup as a layout. The server captures the ACTIVE project's live panes
  // (save_project_layout); a 200 can be a "no live panes" narration — surfaced honestly.
  const saveLayout = useCallback(async (name: string) => {
    const n = name.trim();
    if (!n) return;
    if (mockClientOnly()) { showToast(`Layout '${n}' is on the books 🗺`); return; }
    try {
      const res = await apiFetch("/api/layouts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
      if (res.status === 202) { showToast("Save queued — needs your ok at the pass 🛎", "warn"); return; }
      if (res.status === 403) { showToast("Saving layouts is gated off, Chef", "warn"); return; }
      if (!res.ok) { showToast("Couldn't save that layout, Chef — try again.", "warn"); return; }
      const d = await res.json().catch(() => ({} as Record<string, unknown>));
      const t = layoutSaveToast(d, n);
      showToast(t.msg, t.kind);
      if (!isMockModeRef.current) refetchLayouts();
    } catch { showToast("Couldn't save that layout, Chef — try again.", "warn"); }
  }, [refetchLayouts, showToast, mockClientOnly]);

  // Re-materialize a layout (gated like a recipe: apply_recipe veto + per-pane create_pane). The
  // 200 narration carries the per-pane mix (spawned / awaiting ok / skipped / blocked) — surface
  // it verbatim; a 403 surfaces the server's reason.
  const applyLayout = useCallback(async (id: string) => {
    if (mockClientOnly()) { showToast("Setting those stations 🔥", "fire", "execute"); return; }
    try {
      const res = await apiFetch(`/api/layouts/${id}/apply`, { method: "POST" });
      const d = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.status === 202) { showToast("Layout queued — needs your ok at the pass 🛎", "warn"); return; }
      if (res.status === 403) {
        showToast(layoutGatedText(d), "warn");
        return;
      }
      if (!res.ok) {
        showToast(firstServerMessage(d) || "Couldn't set that layout, Chef — try again.", "warn");
        return;
      }
      // "not found" / "no active project" come back as 200 ok-narrations — they read honestly as-is.
      const t = layoutApplyToast(d);
      showToast(t.msg, t.kind, t.earcon);
      if (!isMockModeRef.current) { refetchTerminals(); refetchLedger(); }
    } catch { showToast("Couldn't set that layout, Chef — try again.", "warn"); }
  }, [refetchTerminals, refetchLedger, showToast, mockClientOnly]);

  const deleteLayout = useCallback(async (id: string) => {
    if (mockClientOnly()) {
      setLayouts((prev) => prev.filter((l) => l.id !== id)); // keep the pass honest client-side
      showToast("86'd that layout", "fire", "execute");
      return;
    }
    try {
      const res = await apiFetch(`/api/layouts/${id}`, { method: "DELETE" });
      if (res.status === 202) { showToast("86 queued — needs your ok at the pass 🛎", "warn"); return; }
      if (res.status === 403) { showToast("That 86 is gated off, Chef", "warn"); return; }
      if (!res.ok) { showToast("Couldn't 86 that layout, Chef — try again.", "warn"); return; }
      showToast("86'd that layout", "fire", "execute");
      if (!isMockModeRef.current) refetchLayouts();
      else setLayouts((prev) => prev.filter((l) => l.id !== id)); // armed mock: no real refetch
    } catch { showToast("Couldn't 86 that layout, Chef — try again.", "warn"); }
  }, [refetchLayouts, showToast, mockClientOnly]);

  // ── j4e1: the handoff line-drawer's hero actions (deliver / revise / stage / reject) ──
  // These call the cv2 canonical handoff REST twins. Each path is an EXPLICIT registry `rest` entry on
  // its action def (src/actions/defs/handoff.ts) — there is no auto-fallback router; the verb-family
  // shape POST /api/handoffs/:handoff_id/<verb> is the contract those defs declare, alongside the read
  // twin GET /api/handoffs/:handoff_id. The board repaints off handoffs_updated;
  // the post-success refetch is the safety net. Honest-feedback: the ack fires only after the server
  // said ok; a gated deliver may 202 (needs an ok at the pass) / 403 (gated off). Under a human's
  // plain ?mock=1 these stay client-side; a Playwright-armed page fires the wire so the e2e asserts it.

  // Deliver a STAGED handoff (the GATED hero action; the server gates via dispatchProposal →
  // 200 delivered / 202 needs-approval / 403 gated off). Mirrors executePlan's status ladder.
  const deliverHandoff = useCallback(async (handoffId: string) => {
    if (mockClientOnly()) { showToast("Sent it down the line 🍽", "fire", "execute"); return; }
    try {
      const res = await apiFetch(`/api/handoffs/${handoffId}/deliver`, { method: "POST" });
      if (res.status === 202) { showToast("Delivery queued — needs your ok at the pass 🛎", "warn"); }
      else if (res.status === 403) { showToast("That delivery's gated off, Chef", "warn"); }
      else if (!res.ok) {
        const d = await res.json().catch(() => ({} as Record<string, unknown>));
        showToast(firstServerMessage(d) || "Couldn't deliver that handoff, Chef — try again.", "warn");
      } else { showToast("Sent it down the line 🍽", "fire", "execute"); }
      if (!isMockModeRef.current) refetchHandoffs();
    } catch { showToast("Couldn't deliver that handoff, Chef — try again.", "warn"); }
  }, [refetchHandoffs, showToast, mockClientOnly]);

  // Revise a handoff's composed prompt (UNGATED co-authoring). Body key is `new_draft_text` (the
  // revise_handoff schema). A 200 narration is the only success; failures warn honestly.
  const reviseHandoff = useCallback(async (handoffId: string, newDraftText: string) => {
    const text = newDraftText.trim();
    if (!text) return;
    // Optimistic: update ONLY composed_prompt. The server's revise (updateHandoffCargo) PRESERVES the
    // lifecycle state, so flipping to "revising" here would diverge from the authoritative handoffs_updated
    // frame — let the server frame own `state` (and revision_count).
    setHandoffs((prev) => prev.map((h) => (h.id === handoffId ? { ...h, composed_prompt: text } : h)));
    if (mockClientOnly()) { showToast("Tweaked the handoff ✍️"); return; }
    try {
      const res = await apiFetch(`/api/handoffs/${handoffId}/revise`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ new_draft_text: text }),
      });
      if (!res.ok) { showToast("That revision didn't stick, Chef — try again.", "warn"); refetchHandoffs(); return; }
      showToast("Tweaked the handoff ✍️");
      if (!isMockModeRef.current) refetchHandoffs();
    } catch { showToast("That revision didn't stick, Chef — try again.", "warn"); refetchHandoffs(); }
  }, [refetchHandoffs, showToast, mockClientOnly]);

  // Reject/cancel a handoff (UNGATED pre-gate flip; routes through the gate if a delivery is pending).
  const rejectHandoff = useCallback(async (handoffId: string) => {
    setHandoffs((prev) => prev.map((h) => (h.id === handoffId ? { ...h, state: "rejected" } : h))); // optimistic
    if (mockClientOnly()) { showToast("86'd that handoff", "warn"); return; }
    try {
      const res = await apiFetch(`/api/handoffs/${handoffId}/reject`, { method: "POST" });
      if (!res.ok) { showToast("Couldn't 86 that handoff, Chef — try again.", "warn"); refetchHandoffs(); return; }
      showToast("86'd that handoff", "warn");
      if (!isMockModeRef.current) refetchHandoffs();
    } catch { showToast("Couldn't 86 that handoff, Chef — try again.", "warn"); refetchHandoffs(); }
  }, [refetchHandoffs, showToast, mockClientOnly]);

  // Stage a composing/revising handoff — freezes the draft to `staged`, the ONLY state Deliver accepts
  // (UNGATED; the server validates the target pane is live + runs the secret guard). Without this the
  // drawer can never advance a fresh draft to a deliverable row. POST /api/handoffs/:id/stage.
  const stageHandoff = useCallback(async (handoffId: string) => {
    if (mockClientOnly()) { showToast("Staged — ready to send 🍳", "fire", "execute"); return; }
    try {
      const res = await apiFetch(`/api/handoffs/${handoffId}/stage`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as Record<string, unknown>));
        showToast(firstServerMessage(d) || "Couldn't stage that handoff, Chef — try again.", "warn");
        refetchHandoffs(); return;
      }
      showToast("Staged — ready to send 🍳", "fire", "execute");
      if (!isMockModeRef.current) refetchHandoffs();
    } catch { showToast("Couldn't stage that handoff, Chef — try again.", "warn"); refetchHandoffs(); }
  }, [refetchHandoffs, showToast, mockClientOnly]);

  // Fetch the FULL composed prompt for one handoff (GET /api/handoffs/:id = read_handoff). The list
  // projection (list_handoffs) truncates composed_prompt to 200 chars + redacts, so the revise editor
  // MUST seed from this full read or a Save would PUT the capped/redacted text back, corrupting a long
  // prompt. read_handoff wraps the row under { output: { composed_prompt } } (default resultToHttp).
  // A plain human ?mock=1 page returns null (no server; the harness owns full rows) — but a
  // Playwright-armed page DOES fire the GET (3C.3b) so the e2e proves the editor seeds from the FULL
  // read, not the truncated list row. Any failure also returns null (the caller keeps its seed).
  const fetchHandoffPrompt = useCallback(async (handoffId: string): Promise<string | null> => {
    if (isMockModeRef.current && !isE2EWireArmed()) return null;
    try {
      const res = await apiFetch(`/api/handoffs/${handoffId}`);
      if (!res.ok) return null;
      return handoffPromptFromReadResponse(await res.json().catch(() => null));
    } catch { return null; }
  }, []);

  // ── 2K.2: per-pane gate override (the Rulebook's pane scope) ─────────────
  // PUT the pane's whole override map (the bulk matrix-editor route, src/actions/defs/locks.ts
  // setPaneGates). res.ok-checked; on failure the ledger is refetched so the segs snap back to truth.
  const setPaneGates = useCallback(async (projectId: string, paneId: string, gates: Record<string, string>) => {
    if (mockClientOnly()) { showToast("Rulebook updated for that station."); return; }
    try {
      const res = await apiFetch(`/api/projects/${projectId || "default_project"}/panes/${paneId}/capability-gates`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capabilityGates: gates }),
      });
      if (!res.ok) { showToast("That didn't save, Chef — try again.", "warn"); if (!isMockModeRef.current) refetchLedger(); return; }
      showToast("Rulebook updated for that station.");
      if (!isMockModeRef.current) { refetchLedger(); refetchTerminals(); } // terminals carry the re-resolved posture
    } catch { showToast("That didn't save, Chef — try again.", "warn"); }
  }, [refetchLedger, refetchTerminals, showToast, mockClientOnly]);

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

  // Jot a note → POST (project- or pane-scoped). Optimistic so The Pass updates instantly; under
  // ?mock=1 the POST fires only on a Playwright-armed page (3C.3b). POST body key is `note`.
  const addNote = useCallback(async (projectId: string, text: string, paneId?: string | null) => {
    const t = text.trim();
    if (!t || !projectId || projectId === "all") return;
    const optimistic: StoredNote = {
      id: `tmp-${Math.random().toString(36).slice(2, 8)}`, project_id: projectId, pane_id: paneId ?? null,
      text: t, type: "note", author: "user", created_at: Date.now(), updated_at: Date.now(),
    };
    setNotes((prev) => [optimistic, ...prev]);
    showToast("Jotted it down 🎫");
    if (mockClientOnly()) return;
    try {
      const path = paneId ? `/api/projects/${projectId}/panes/${paneId}/notes` : `/api/projects/${projectId}/notes`;
      const res = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: t }) });
      if (res.ok && !isMockModeRef.current) { refetchNotes([projectId]); refetchLedger(); }
    } catch { /* silent */ }
  }, [showToast, refetchNotes, refetchLedger, mockClientOnly]);

  const editNote = useCallback(async (id: string, text: string, projectId?: string) => {
    const t = text.trim();
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text: t, updated_at: Date.now() } : n)));
    if (mockClientOnly()) return;
    try {
      const res = await apiFetch(`/api/notes/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) });
      if (res.ok && projectId && !isMockModeRef.current) refetchNotes([projectId]);
      else if (!res.ok) showToast("That edit didn't stick, Chef — try again.", "warn"); // 1B.3
    } catch { showToast("That edit didn't stick, Chef — try again.", "warn"); }
  }, [refetchNotes, showToast, mockClientOnly]);

  const deleteNote = useCallback(async (id: string, projectId?: string) => {
    // 2K.4: undo-in-toast for the destructive delete. The deleted note's text/scope are captured
    // before the DELETE; Undo re-POSTs it through addNote (a true un-delete isn't possible — the
    // row is gone server-side — so the restored ticket gets a fresh id and type "note").
    const r = notesRef.current.find((n) => n.id === id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
    showToast("86'd that one", "fire", undefined, r ? {
      label: "Undo",
      run: () => addNote(r.project_id, r.text, r.pane_id ?? undefined),
    } : undefined);
    if (mockClientOnly()) return;
    try {
      const res = await apiFetch(`/api/notes/${id}`, { method: "DELETE" });
      if (res.ok && projectId && !isMockModeRef.current) refetchNotes([projectId]);
    } catch { /* silent */ }
  }, [showToast, refetchNotes, addNote, mockClientOnly]);

  // Send a literal control-key sequence into a pane's PTY (the raw-input route — arrows / Tab / Esc /
  // Enter / PgUp/PgDn / Ctrl+C always-allowed; Shift+Tab gated → may 202-defer). Under ?mock=1 the
  // REAL POST fires only on a Playwright-armed page (3C.3b — the e2e intercepts + asserts the wire).
  // 403/202/409 surface as a toast instead of a dead button.
  const writeControlKey = useCallback(async (paneId: string, bytes: string) => {
    if (mockClientOnly()) return;
    try {
      const res = await apiFetch(`/api/terminals/${paneId}/raw-input`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bytes }),
      });
      if (res.status === 403) showToast("That key's gated off", "warn");
      else if (res.status === 202) showToast("Key queued — needs your ok 🛎", "warn");
      else if (res.status === 409) showToast("Open the pane first", "warn");
    } catch { /* pane may have exited — best-effort */ }
  }, [showToast, mockClientOnly]);

  // Sync the backend PTY grid to the xterm grid (debounced per-pane). Under ?mock=1 the POST fires
  // only on a Playwright-armed page (3C.3b) — mirrors App.tsx's e2e-active resize seam.
  const resizeTerminal = useCallback((paneId: string, cols: number, rows: number) => {
    if (!cols || !rows) return;
    if (mockClientOnly()) return;
    const key = `${cols}x${rows}`;
    if (lastGridRef.current[paneId] === key) return;
    lastGridRef.current[paneId] = key;
    clearTimeout(resizeDebounceRef.current[paneId]);
    resizeDebounceRef.current[paneId] = setTimeout(() => {
      apiFetch(`/api/terminals/${paneId}/resize`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cols, rows }),
      }).catch(() => { /* pane may have exited; resize is best-effort */ });
    }, 120);
  }, [mockClientOnly]);

  // ── HiTL gating resolves (the safety dial actually fires) ────────────────
  // Approve / reject a staged PTY write; confirm / cancel a gated deferred action. Each drops the chip
  // optimistically (the server emits approval_resolved/action_resolved to confirm) and routes through
  // the operator-above-the-gate REST choke-points. Optimistic-only in mock (the e2e asserts the wire).
  // 1B.3 (honest feedback): the chip drop stays OPTIMISTIC, but the success toast/earcon fires only
  // AFTER the server says ok. On !res.ok / network failure the chip is RESTORED (the decision is
  // still pending on the server) and the kitchen says so. Mock keeps the optimistic+toast path (the
  // harness is client-only; the wire is pinned by the server suite).
  const approveCommand = useCallback(async (messageId: string) => {
    let removed: PendingCommand | undefined;
    setPendingCommands((prev) => { removed = prev.find((c) => c.messageId === messageId) ?? removed; return prev.filter((c) => c.messageId !== messageId); });
    if (isMockModeRef.current) { showToast("Order up! 🍽"); return; }
    try {
      const res = await apiFetch("/api/commands/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId, approved: true }) });
      if (!res.ok) throw new Error(`approve ${res.status}`);
      showToast("Order up! 🍽"); // the most consequential operator action must never be silent (eyes-off)
      setTimeout(refetchTerminals, 500);
    } catch {
      const r = removed;
      if (r) setPendingCommands((prev) => (prev.some((c) => c.messageId === r.messageId) ? prev : [...prev, r]));
      showToast("That didn't go through, Chef — try again.", "warn");
    }
  }, [refetchTerminals, showToast]);

  const rejectCommand = useCallback(async (messageId: string) => {
    let removed: PendingCommand | undefined;
    setPendingCommands((prev) => { removed = prev.find((c) => c.messageId === messageId) ?? removed; return prev.filter((c) => c.messageId !== messageId); });
    if (isMockModeRef.current) { showToast("86'd it — held back", "warn"); return; }
    try {
      const res = await apiFetch("/api/commands/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId, approved: false }) });
      if (!res.ok) throw new Error(`reject ${res.status}`);
      showToast("86'd it — held back", "warn");
    } catch {
      const r = removed;
      if (r) setPendingCommands((prev) => (prev.some((c) => c.messageId === r.messageId) ? prev : [...prev, r]));
      showToast("That didn't go through, Chef — try again.", "warn");
    }
  }, [showToast]);

  // bead e7h: in-inbox Approve/Deny. When an attention item carries a held-request messageId
  // (attentionResolveTarget), resolve it through the SAME POST /api/commands/approve resolver voice
  // uses (approveCommand/rejectCommand) AND optimistically clear the alert from the inbox. When it
  // carries NO messageId (a triage-only item) there is nothing to resolve — Approve degrades to a
  // jump-to-station (the parent wires that) and Deny degrades to a local dismiss. The id gate lives
  // here so the resolver is NEVER called without a real target.
  const approveAttention = useCallback((item: AttentionItem) => {
    const messageId = attentionResolveTarget(item);
    if (!messageId) { selectActivePane(item.terminalId); return; }
    setAttentionQueue((prev) => prev.filter((a) => a.id !== item.id)); // optimistic clear
    approveCommand(messageId);
  }, [approveCommand, selectActivePane]);

  const denyAttention = useCallback((item: AttentionItem) => {
    const messageId = attentionResolveTarget(item);
    if (!messageId) { dismissAttention(item.id); return; }
    setAttentionQueue((prev) => prev.filter((a) => a.id !== item.id)); // optimistic clear
    rejectCommand(messageId);
  }, [rejectCommand, dismissAttention]);

  const confirmAction = useCallback(async (actionId: string) => {
    let removed: PendingActionView | undefined;
    setPendingActions((prev) => { removed = prev.find((a) => a.actionId === actionId) ?? removed; return prev.filter((a) => a.actionId !== actionId); });
    if (isMockModeRef.current) { showToast("Fired it 🔥"); return; }
    try {
      const res = await apiFetch(`/api/actions/${actionId}/confirm`, { method: "POST" });
      if (!res.ok) throw new Error(`confirm ${res.status}`);
      showToast("Fired it 🔥");
      setTimeout(refetchTerminals, 500);
    } catch {
      const r = removed;
      if (r) setPendingActions((prev) => (prev.some((a) => a.actionId === r.actionId) ? prev : [...prev, r]));
      showToast("That didn't go through, Chef — try again.", "warn");
    }
  }, [refetchTerminals, showToast]);

  const cancelAction = useCallback(async (actionId: string) => {
    let removed: PendingActionView | undefined;
    setPendingActions((prev) => { removed = prev.find((a) => a.actionId === actionId) ?? removed; return prev.filter((a) => a.actionId !== actionId); });
    if (isMockModeRef.current) { showToast("Scrapped it", "warn"); return; }
    try {
      const res = await apiFetch(`/api/actions/${actionId}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error(`cancel ${res.status}`);
      showToast("Scrapped it", "warn");
    } catch {
      const r = removed;
      if (r) setPendingActions((prev) => (prev.some((a) => a.actionId === r.actionId) ? prev : [...prev, r]));
      showToast("That didn't go through, Chef — try again.", "warn");
    }
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
    pendingCommands, pendingActions, attentionQueue, frozen, frozenRunning, daemonState, transcript,
    activeTerminalId, isMock, isLive: voiceLive, voiceReconnecting, voiceConnected, micBlocked, micMuted, streamConnected, toast, notes,
    streamGeneration, fetchPaneBackfill,
    archived, paneDrafts, paneHistories, serviceLog, refetchServiceLog,
    healthSnapshot, refetchHealth,
    templates, layouts, handoffs,
    selectActivePane, setGlobalPermissionsMode, setGlobalMode, saveSettings, showToast,
    createPane, createProject, updateProjectSummary, restartPane,
    stopPane, renamePane, clearExited, restoreArchived, deleteArchived, refetchArchive, setPaneGates,
    executePlan, deletePlan,
    createTemplate, updateTemplate, deleteTemplate, applyTemplate,
    saveLayout, applyLayout, deleteLayout, refetchTemplates, refetchLayouts,
    deliverHandoff, reviseHandoff, stageHandoff, rejectHandoff, fetchHandoffPrompt, refetchHandoffs,
    refetchNotes, addNote, editNote, deleteNote,
    goLive, stopLive, toggleMute, writeControlKey, resizeTerminal,
    approveCommand, rejectCommand, confirmAction, cancelAction,
    stopAllFreeze, stopAllKill, stopAllRelease,
    refetchTerminals, refetchLedger, refetchSettings, refetchAttention, dismissAttention, approveAttention, denyAttention, refetchAll,
    wsRef, isMockModeRef,
    setTerminals, setTranscript, setPendingCommands, setPendingActions, setFrozen, setFrozenRunning,
  };
}
