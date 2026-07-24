import * as React from "react";
import { useEffect, useState, useRef } from "react";
import { Terminal, PendingCommand, PendingActionView, Workspace, PaneMeta, SystemSettings, Plan } from "./types";
import { playAudioChunk, resetAudioPlayback, setPlaybackVolume } from "./utils/audio";
import { CreateTerminalDialog } from "./components/CreateTerminalDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { TerminalView } from "./components/TerminalView";
import { ProjectDialog } from "./components/ProjectDialog";
import { NotificationStack } from "./components/NotificationStack";
import { effectForEvent } from "./eventBus";
import { upsertNotification, dismissNotification, ProactiveNotification } from "./notificationStack";
import { Check, Sparkles, BookOpen, Play, Activity, Flame, Send } from "lucide-react";
import { apiFetch } from "./utils/api";
import { publishChunk } from "./terminalStream";
import { useE2EHarness, isE2EWireArmed } from "./e2e/harness";
import { buildPaneInputFrame, shouldSendPaneInput } from "./orbital/paneInputClient";
import { resolveActivePaneMeta } from "./activePaneMeta";
import {
  countExitedPanes,
  sumContextSize,
  dispatchWsMessage,
  classifyRawKeyOutcome,
  estimateTokens,
} from "./appHelpers";
import { useLiveSession } from "./hooks/useLiveSession";
import { useEarcons } from "./classic/hooks/useEarcons";
import { useStdoutStream } from "./classic/hooks/useStdoutStream";
import { useTerminalHistory } from "./classic/hooks/useTerminalHistory";
import { useRecentlyIdled } from "./classic/hooks/useRecentlyIdled";
import { useComposer } from "./classic/hooks/useComposer";
import { useApprovalsQueue } from "./classic/hooks/useApprovalsQueue";
import { useLedgerData } from "./classic/hooks/useLedgerData";
import { buildMockData } from "./mockData";
import { MiniMarkdown } from "./classic/components/MiniMarkdown";
import { ErrorBoundary } from "./classic/components/ErrorBoundary";
import { ControlKeyBar } from "./classic/components/ControlKeyBar";
import { GenericPromptModal } from "./classic/components/GenericPromptModal";
import { ToastNotificationStack } from "./classic/components/ToastNotificationStack";
import { FrozenBanner } from "./classic/components/FrozenBanner";
import { MobileNavBar } from "./classic/components/MobileNavBar";
import { PromptSynchronizerPanel } from "./classic/components/PromptSynchronizerPanel";
import { HelperPanelTabHeader } from "./classic/components/HelperPanelTabHeader";
import { TerminalHealthHeatmap } from "./classic/components/TerminalHealthHeatmap";
import { SynergyMatrixPanel } from "./classic/components/SynergyMatrixPanel";
import { TranscriptPanel } from "./classic/components/TranscriptPanel";
import { SystemStatusBar } from "./classic/components/SystemStatusBar";
import { MobileTerminalSwiperBar } from "./classic/components/MobileTerminalSwiperBar";
import { WorkspaceSidebar } from "./classic/components/WorkspaceSidebar";
import { ApprovalQueue } from "./classic/components/ApprovalQueue";
import { ActionConfirmQueue } from "./classic/components/ActionConfirmQueue";
import { AppHeader } from "./classic/components/AppHeader";
import { ActivePaneHeaderBar } from "./classic/components/ActivePaneHeaderBar";
import { PaneHistorySidebar } from "./classic/components/PaneHistorySidebar";
import { DashboardHeader } from "./classic/components/DashboardHeader";
import { ArtifactsRegistryPanel } from "./classic/components/ArtifactsRegistryPanel";
import { PaneGridSection } from "./classic/components/PaneGridSection";

function AppRaw() {
  const [activeProjectId, setActiveProjectId] = useState<string>("default_project");
  // dbt4 (wsm-e2e-pinned-4ib): the ledger-data spine — 9 read-only state slices + the 7 GET fetchers
  // that populate them — now live in useLedgerData (src/classic/hooks/useLedgerData.ts). Called HERE,
  // FIRST, because useRecentlyIdled({terminals}) and useStdoutStream({setTerminals}) below consume it.
  // The boot effect, the 20s safety-net poll, and every mutation handler (POST/PUT/DELETE) STAY in App
  // (they orchestrate across sibling hooks → a create-order cycle if pulled in). isMockModeRef is
  // App-owned (the client-only mock gate) and threaded in. setTerminals/setLedger/setFrozen/
  // setFrozenRunning are 4 of the harness-wired setters (src/e2e/harness.ts). Normalizers are pinned in
  // tests/test_ledger_data_logic.ts; the boot REST set in src/ledgerData.rest.test.tsx; pixel parity in
  // e2e/ledger_data_pixel_parity.spec.ts. Catalogue: docs/.../2026-06-24-ledger-data-parity-catalogue.md.
  const isMockModeRef = useRef(false);
  const {
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
  } = useLedgerData({ isMockModeRef, activeProjectId });
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [termFilter, setTermFilter] = useState<"All" | "Running" | "Idle">("All");
  // dbt4: pendingCommands / pendingActions state + fetchPendingCommands + handleApprove / handleReject
  // / handleConfirmAction / handleCancelAction now live in useApprovalsQueue
  // (src/classic/hooks/useApprovalsQueue.ts). It's CALLED below — after fetchTerminals is in scope.
  // setPendingCommands AND setPendingActions are returned and threaded into useE2EHarness (the
  // injectPendingApproval / injectPendingAction harness contract; src/e2e/harness.ts:161-162). The
  // pure optimistic-filter decisions are pinned in tests/test_approvals_logic.ts.
  const [showCreateModal, setShowCreateModal] = useState(false);
  // dbt4: the recently-idled pulse map + its prev-terminals-diff effect now live in useRecentlyIdled
  // (src/classic/hooks/useRecentlyIdled.ts). Behavior is byte-identical; the pure Running→Idle diff is
  // split to src/classic/helpers/idleDiff.ts. No harness coupling for setRecentlyIdled.
  const { recentlyIdled } = useRecentlyIdled({ terminals });
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Workspace | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [promptDialog, setPromptDialog] = useState<{title: string, placeholder: string, onSubmit: (val: string) => void} | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [newNoteInputs, setNewNoteInputs] = useState<Record<string, string>>({});
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");
  const [isMockMode, setIsMockMode] = useState<boolean>(false);
  const [autoApprovedNotification, setAutoApprovedNotification] = useState<{terminalId: string, cmd: string} | null>(null);
  const [blockedNotification, setBlockedNotification] = useState<{terminalId: string, cmd: string, reason: string} | null>(null);
  const [wsErrorNotification, setWsErrorNotification] = useState<{message: string} | null>(null);
  // Raw control-key outcome toast (multi-cli adapter nit #3): writeControlKey used to swallow non-2xx
  // silently. Surface the gated/deferred/refused outcomes (403 / 202 / 409) so the operator gets a
  // visible signal instead of a dead button. `tone` keys the palette; cleared on a timer.
  const [rawKeyNotification, setRawKeyNotification] = useState<{ tone: "blocked" | "deferred" | "refused"; title: string; detail: string } | null>(null);
  // WS-D (BUG-024): coalescing proactive-notification stack (one entry per pane+severity).
  const [proactiveNotifications, setProactiveNotifications] = useState<ProactiveNotification[]>([]);
  // bead 8sq (spec §2.C): the two-stage emergency STOP-ALL *state* (`frozen`/`frozenRunning`) now lives
  // in useLedgerData (restored from /api/stop-all/status on boot). The freeze/kill/release ACTIONS and
  // the `frozen` WS-event handler stay here in App and write through the returned setters.
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [transcript, setTranscript] = useState<{ sender: "User" | "Janus"; text: string; timestamp: Date; grounding?: { queries: string[]; sources: { uri: string; title: string }[] } }[]>([]);
  const [showTranscriptPanel, setShowTranscriptPanel] = useState(false);
  // dbt4: the active-pane command-history panel state + fetch/clear + the 5s poll effect now live in
  // useTerminalHistory (src/classic/hooks/useTerminalHistory.ts). Behavior is byte-identical; the pure
  // poll-arm gate is pinned in src/classic/helpers/historyLogic.ts. No harness coupling for these
  // setters (E2EHarnessDeps owns setTerminals/setActiveTerminalId/etc., not these).
  const {
    showHistoryPanel,
    setShowHistoryPanel,
    historyList,
    selectedHistoryEntry,
    setSelectedHistoryEntry,
    fetchActiveTerminalHistory,
    clearActiveTerminalHistory,
  } = useTerminalHistory({ activeTerminalId });
  const [hoveredTermId, setHoveredTermId] = useState<string | null>(null);

  // dbt4: the hands-free non-verbal feedback layer (browserNotificationsEnabled toggle + the
  // Web-Audio playEarcon player + the gated triggerDesktopNotification wrapper) now lives in
  // useEarcons (src/classic/hooks/useEarcons.ts). Behavior is byte-identical; the pure notification
  // gate is pinned in tests/test_earcon_logic.ts.
  const { playEarcon, triggerDesktopNotification, setBrowserNotificationsEnabled } = useEarcons();

  // Archive panel states (the `archive` list itself now lives in useLedgerData)
  const [showArchivePanel, setShowArchivePanel] = useState(false);
  // A-UI (wsm-e2e-pinned-5h0): auto-expand the Pane Archive the first time it gains content, so a
  // just-exited (terminated + archived, recoverable) pane is immediately discoverable instead of
  // hidden behind the collapsed-by-default toggle. Only ever auto-OPENS — it never fights a manual
  // collapse afterward (re-arms only after the archive empties again).
  const archiveWasEmptyRef = useRef(true);
  useEffect(() => {
    if (archive.length > 0 && archiveWasEmptyRef.current) setShowArchivePanel(true);
    archiveWasEmptyRef.current = archive.length === 0;
  }, [archive.length]);

  // dbt4: the Markdown prompt-buffer / WIP-draft composer (promptBuffer / isBufferFocused /
  // promptBufferEditMode / wipDrafts / contextInput + fetchActiveDraft / fetchWipDrafts +
  // handlePromptBufferChange / handleSendDraft / handleAddHumanContext) now lives in useComposer
  // (src/classic/hooks/useComposer.ts). It's CALLED below — after useLiveSession, because
  // handlePromptBufferChange pushes draft_edit frames over that hook's wsRef. setWipDrafts is returned
  // and threaded into useE2EHarness (the harness injectWipDraft contract; src/e2e/harness.ts:167).
  // The pure WS-vs-REST routing gate is pinned in tests/test_composer_logic.ts.

  // Mobile layout switcher state: terminal | buffer | menu
  const [mobileActiveView, setMobileActiveView] = useState<"terminal" | "buffer" | "menu">("terminal");

  // Grid view display mode: detailed dashboard vs compact row list vs video wall layout
  const [gridDisplayMode, setGridDisplayMode] = useState<"detailed" | "compact" | "videowall">("compact");

  // Simplicity Mode / Focus View toggler for a clean, non-overloaded experience
  const [isSimpleMode, setIsSimpleMode] = useState<boolean>(true);

  // dbt4: fetchActiveTerminalHistory + clearActiveTerminalHistory moved into useTerminalHistory (see
  // the destructure above). Other App effects/handlers (the active-pane-change effect, the
  // history-panel toggle button) still call the hook's returned fetcher with the same order/args.

  // dbt4: the rAF-batched stdout preview flush (queueStdoutChunk) + the debounced terminal-resize
  // POST (handleTerminalResize) now live in useStdoutStream (src/classic/hooks/useStdoutStream.ts).
  // queueStdoutChunk's identity is preserved and still fed into useE2EHarness below — the harness
  // injectStdoutChunk contract is unchanged. isMockModeRef + e2eActiveRef are App-owned and threaded
  // in (e2eActiveRef is created here so the harness, which depends on queueStdoutChunk, can share it).
  // The pure pieces (the -110 flush slice + the grid-key dedup) are pinned in tests/test_stream_logic.ts.
  // isMockModeRef is created at the top of AppRaw (it's a useLedgerData param); e2eActiveRef stays here.
  const e2eActiveRef = useRef(false);
  const { queueStdoutChunk, handleTerminalResize } = useStdoutStream({
    setTerminals,
    isMockModeRef,
    e2eActiveRef,
  });

  // dbt4: the WS + Web-Audio capture/playback refs and the connect/start/stop/cleanup +
  // auto-reconnect lifecycle now live in useLiveSession (src/hooks/useLiveSession.ts). isMicMutedRef
  // and activeTerminalIdRef stay App-owned (App mirrors state into them) and are passed in.
  const isMicMutedRef = useRef(false);
  // WS-D: mirror of activeTerminalId for the ws.onmessage closure (which captures a stale
  // value otherwise) — used to gate the pushed history_updated refresh to the active pane.
  const activeTerminalIdRef = useRef<string | null>(null);

  // dbt4: the useE2EHarness({...}) call MOVED DOWN — below useComposer — because the harness deps now
  // include setWipDrafts (from useComposer), which is declared after useLiveSession. Keeping the call
  // here would reference setWipDrafts before its const init (TDZ). The harness effect runs post-mount
  // regardless of declaration order; e2eActiveRef is App-owned (created above for useStdoutStream's
  // resize guard) and passed in, so nothing downstream depends on the harness running earlier.

  // dbt4 (wsm-e2e-pinned-4ib): fetchTerminals / fetchLedger / fetchProjectNotes moved into useLedgerData
  // (destructured at the top of AppRaw). The note-mutation handlers below still call the returned fetchers.

  const handleDeleteNote = async (id: string) => {
    if (isMockModeRef.current) return;
    await apiFetch(`/api/notes/${id}`, { method: "DELETE" });
    if (editingNoteId === id) setEditingNoteId(null);
    fetchProjectNotes();
    fetchLedger();
  };

  const handleSaveNoteEdit = async (id: string) => {
    const text = editingNoteText.trim();
    if (!text) { setEditingNoteId(null); return; }
    await apiFetch(`/api/notes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    setEditingNoteId(null);
    setEditingNoteText("");
    fetchProjectNotes();
    fetchLedger();
  };

  // dbt4 (wsm-e2e-pinned-4ib): fetchFrozenStatus / fetchSettings moved into useLedgerData. The STOP-ALL
  // freeze/kill/release actions + the settings PUT handlers below still call the returned setters/fetchers.

  // bead 8sq (spec §2.C): the two-stage emergency STOP-ALL. Stage 1 freezes Janus + cancels in-flight
  // (reversible; panes keep running); Stage 2 (hold-to-fire) kills the running PTYs (irreversible);
  // Release clears the freeze. All three hit the always-allowed REST routines; the `frozen` WS event
  // drives the banner state, so these just fire-and-confirm.
  const handleStopAllFreeze = async () => {
    try {
      const res = await apiFetch("/api/stop-all", { method: "POST" });
      if (!res.ok) return;
      const data = await res.json();
      setFrozen(true);
      setFrozenRunning(Array.isArray(data.running) ? data.running : []);
    } catch (e) { console.error("stop-all freeze failed", e); }
  };
  const handleStopAllKill = async () => {
    try {
      const res = await apiFetch("/api/stop-all/confirm", { method: "POST" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.killed)) setFrozenRunning(prev => prev.filter(id => !data.killed.includes(id)));
    } catch (e) { console.error("stop-all kill failed", e); }
  };
  const handleStopAllRelease = async () => {
    try {
      const res = await apiFetch("/api/stop-all/release", { method: "POST" });
      if (!res.ok) return;
      setFrozen(false);
      setFrozenRunning([]);
    } catch (e) { console.error("stop-all release failed", e); }
  };

  const handleUpdateGlobalPermissions = async (val: string) => {
    try {
      const updatedSettings = settings ? {
        ...settings,
        advanced: { ...settings.advanced, globalPermissionsMode: val }
      } : { advanced: { globalPermissionsMode: val } };

      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedSettings)
      });
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data.settings);
      setGlobalPermissionsMode(data.globalPermissionsMode);
    } catch (e) {}
  };

  const handleSaveSettings = async (updatedSettings: SystemSettings) => {
    try {
      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedSettings)
      });
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data.settings);
      setGlobalPermissionsMode(data.globalPermissionsMode);
      // Apply volume immediately (client-side gain) and sync the live mic gate.
      if (typeof data.settings?.voiceAi?.volume === "number") setPlaybackVolume(data.settings.voiceAi.volume);
      if (typeof data.settings?.voiceAi?.isMicMuted === "boolean") setIsMicMuted(data.settings.voiceAi.isMicMuted);
    } catch (e) {}
  };

  // Restart the live voice session so reconnect-only settings (voice, model, API
  // key) take effect. Wired to the Settings dialog's "Apply & Reconnect" button.
  // dbt4: fetchPendingCommands moved into useApprovalsQueue (called below). The boot + safety-net poll
  // effects still call the hook's returned fetcher with the same order/args.

  // dbt4 (wsm-e2e-pinned-4ib): fetchPlans / fetchArchive moved into useLedgerData. The plan/archive
  // mutation handlers below (execute/delete/restore/clear-exited) still call the returned fetchers.

  const handleClearExited = async () => {
    const exitedCount = activeProject ? countExitedPanes(activeProject.panes, terminals) : 0;
    if (exitedCount === 0) return;
    setPromptDialog({
      title: `Type "CLEAR" to archive ${exitedCount} exited pane(s) from this project:`,
      placeholder: "CLEAR",
      onSubmit: async (val) => {
        if (val.trim() !== "CLEAR") return;
        try {
          await apiFetch("/api/terminals/clear-exited", { method: "POST" });
          setPromptDialog(null);
          fetchLedger();
          fetchTerminals();
          fetchArchive();
          playEarcon("success");
        } catch (e) {}
      }
    });
  };

  const handleRestoreArchived = async (paneId: string) => {
    try {
      await apiFetch(`/api/archive/${paneId}/restore`, { method: "POST" });
      fetchArchive();
      fetchLedger();
      fetchTerminals();
      playEarcon("success");
    } catch (e) {}
  };

  const handleDeleteArchived = async (paneId: string) => {
    try {
      await apiFetch(`/api/archive/${paneId}`, { method: "DELETE" });
      fetchArchive();
      playEarcon("execute");
    } catch (e) {}
  };

  const handleExecutePlan = async (id: string) => {
    try {
      await apiFetch(`/api/plans/${id}/execute`, { method: "POST" });
      fetchPlans();
      playEarcon("success");
    } catch (e) {}
  };

  const handleDeletePlan = async (id: string) => {
    try {
      await apiFetch(`/api/plans/${id}`, { method: "DELETE" });
      fetchPlans();
      playEarcon("execute");
    } catch (e) {}
  };

  useEffect(() => {
    fetchTerminals();
    fetchLedger();
    fetchSettings();
    fetchPendingCommands();
    fetchPlans();
    fetchActiveDraft(); // Step 6: load the active pane's WIP draft (no-op until a pane is open)
    fetchWipDrafts();
    fetchArchive(); // feat/local-testing: load the recoverable pane archive
    fetchFrozenStatus(); // bead 8sq: restore the STOP-ALL freeze so the banner survives a reload

    // Auto-detect browser notification support configuration
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "granted") {
        setBrowserNotificationsEnabled(true);
      }
    }

    // WS-D (BUG-010): the push branches in ws.onmessage now drive these setters in real
    // time, so the poll is demoted to a slow safety-net (reconciles if a broadcast is
    // missed on a flaky socket) rather than the primary refresh path.
    const interval = setInterval(() => {
      fetchTerminals();
      fetchPendingCommands();
      fetchPlans();
    }, 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once boot + slow safety-net poll; fetch* are unstable body fns, listing them would re-run every render.
  }, []);

  useEffect(() => {
    isMicMutedRef.current = isMicMuted;
  }, [isMicMuted]);

  // Apply the persisted playback volume (Settings → Speaker Volume) to the audio
  // layer whenever settings load or change. Gemini Live has no server volume knob,
  // so this client-side gain is the real control.
  useEffect(() => {
    const vol = settings?.voiceAi?.volume;
    if (typeof vol === "number") setPlaybackVolume(vol);
  }, [settings?.voiceAi?.volume]);

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId;
    if (activeTerminalId) {
      fetchActiveTerminalHistory(activeTerminalId);
    }
    // Step 5 (single active pane): the UI is the source of truth for where Janus may write.
    // Tell the server which pane the operator has open (or null if none) on every change.
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "set_active_pane", paneId: activeTerminalId }));
    }
    // Step 6: load the newly-open pane's WIP draft into the Workbench, and refresh the register.
    fetchActiveDraft(activeProjectId, activeTerminalId);
    fetchWipDrafts(activeProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on pane/project change only; fetch* are unstable body fns called with explicit args, listing them would re-run every render.
  }, [activeTerminalId, activeProjectId]);

  // bead bjm: keep the id-bearing notes feed fresh — on project switch and whenever the ledger
  // changes (e.g. a voice-added note broadcasts a ledger_update), so the Chronicle stays in sync.
  useEffect(() => {
    fetchProjectNotes(activeProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on project/ledger change only; fetchProjectNotes is an unstable body fn called with explicit arg, listing it would re-run every render.
  }, [activeProjectId, ledger]);

  // dbt4: the 5s history-panel poll effect now lives in useTerminalHistory; the recently-idled
  // pulse diff + its 6s clear timers now live in useRecentlyIdled (each hook owns its own effect).

  // dbt4: handleApprove / handleReject / handleConfirmAction / handleCancelAction moved into
  // useApprovalsQueue (called below). The ApprovalDialog / ActionConfirmDialog call the hook's returned
  // handlers; the optimistic-filter decisions are split to approvalsLogic (node:test-pinned).

  const handleCreateTerminal = async (
    id: string,
    cwd: string,
    cmd: string,
    toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom",
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only"
  ) => {
    if (isMockModeRef.current) {
      setTerminals(prev => [...prev, {
        id,
        cwd,
        command: cmd,
        output: "Mock Node Started...\n",
        status: "Running",
        tool_preset: toolPreset,
        permissions_mode: permissionsMode,
        context_size: 0
      }]);
      setLedger(prev => {
        const next = { ...prev };
        if (activeProjectId && next[activeProjectId]) {
          next[activeProjectId].panes[id] = {
            pane_id: id,
            name: "Mock Node " + id,
            runtime_type: "shell",
            last_known_state: "Running",
            is_busy: true,
            alive: true,
            notes: [],
            permissions_mode: permissionsMode,
            session_id: "mock_session_" + id,
            tool_preset: toolPreset,
            context_size: 0
          };
        }
        return next;
      });
      setShowCreateModal(false);
      setActiveTerminalId(id);
      return;
    }
    
    try {
      // G6: /api/terminals is now gated. apiFetch does NOT throw on non-2xx, so branch on res.status:
      //   403 (gate Off)  -> pane was NOT created; close modal, surface refusal, do NOT activate.
      //   202 (gate Ask)  -> deferred; the action_pending broadcast already added a pending chip.
      //                      Close modal but do NOT activate — the pane does not exist yet.
      //   200 (gate Auto) -> pane spawned; activate it.
      const res = await apiFetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          terminalId: id,
          cwd,
          command: cmd,
          toolPreset,
          permissionsMode,
          projectId: activeProjectId
        })
      });
      if (res.status === 403) {
        setShowCreateModal(false);
        playEarcon("alert"); // gate Off refusal (NO "error" earcon token exists)
        return;
      }
      if (res.status === 202) {
        setShowCreateModal(false);
        playEarcon("execute"); // queued, awaiting confirm
        return;
      }
      setShowCreateModal(false);
      fetchTerminals();
      fetchLedger();
      setActiveTerminalId(id);
    } catch (e) {}
  };

  const handleRestartTerminal = async (id: string) => {
    try {
      await apiFetch(`/api/terminals/${id}/restart`, {
        method: "POST"
      });
      fetchTerminals();
      fetchLedger();
    } catch (e) {}
  };

  // Raw control-key bar (multi-cli adapter spec §8): POST literal control bytes to a pane's PTY via
  // the raw-input endpoint (writeRaw — no Enter-append, no history). Nav keys + Ctrl+C are
  // always-allowed; Shift+Tab is gated (write_to_pane) and may return 202 (deferred awaiting confirm).
  const writeControlKey = async (paneId: string, bytes: string) => {
    try {
      const res = await apiFetch(`/api/terminals/${paneId}/raw-input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bytes }),
      });
      // Nit #3: surface every non-2xx outcome to the operator (no more silent swallow). apiFetch does
      // NOT throw on non-2xx, so branch on status. 403 = gated Off; 202 = deferred (Ask); 409 = the
      // pane is not active / not running. Each gets an earcon + a transient toast. dbt4: the status
      // ladder is now classifyRawKeyOutcome (pure, unit-pinned). The earcon is reason-independent, so
      // it plays BEFORE the 409 json read (original ordering: 409 did playEarcon then await json),
      // then the 409 reason is resolved and merged into the toast detail.
      const base = classifyRawKeyOutcome(res.status, paneId, "");
      if (base) {
        playEarcon(base.earcon);
        const detail = res.status === 409
          ? await res.json()
              .then((b) => (b && typeof b.error === "string" ? b.error : ""))
              .catch(() => "")
              .then((reason) => reason || base.toast.detail)
          : base.toast.detail;
        showRawKeyToast(base.toast.tone, base.toast.title, detail);
      }
    } catch (e) {}
  };

  // Nit #3 helper: raise a transient raw-key outcome toast (auto-dismiss). Mirrors the existing
  // blocked/auto-approved toast pattern (a one-shot useState cleared on a timer).
  const showRawKeyToast = (tone: "blocked" | "deferred" | "refused", title: string, detail: string) => {
    setRawKeyNotification({ tone, title, detail });
    setTimeout(() => setRawKeyNotification(null), 5000);
  };

  // Nit #2 helper: grid-view control keys. The server's active-pane guard (nit #1) refuses raw input
  // to any pane that is not coreState.activePaneId, so a grid pane's key must FIRST activate that pane
  // — the SAME switch-active-pane path a pane click uses — and THEN send the key, so it lands on the
  // now-active pane and passes the guard. We push set_active_pane on the WS directly (ordered,
  // synchronous server-side activation ahead of the raw-input POST) AND set activeTerminalId so the UI
  // stays in lockstep; then writeControlKey POSTs the bytes (carrying its own 403/202/409 feedback).
  const writeControlKeyFromGrid = (paneId: string, bytes: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "set_active_pane", paneId }));
    }
    setActiveTerminalId(paneId);
    writeControlKey(paneId, bytes);
  };

  const handleUpdatePermissions = async (paneId: string, val: string) => {
    try {
      await apiFetch(`/api/projects/${activeProjectId}/panes/${paneId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: val })
      });
      fetchLedger();
      fetchTerminals();
    } catch (e) {}
  };

  // dbt4: the live voice-session lifecycle (ws + audio refs, connect/start/stop/cleanup +
  // auto-reconnect) lives in useLiveSession. App owns the WS-message routing: onWsMessage builds
  // the dispatchWsMessage ctx exactly as the former inline ws.onmessage did (same setters/refs/
  // helpers, same ORDERING), with the connection-local 24kHz playbackCtx threaded in for audio.
  const onWsMessage = (msg: any, playbackCtx: AudioContext) => {
    dispatchWsMessage(msg, {
      playEarcon,
      triggerDesktopNotification,
      setPendingCommands,
      setPendingActions,
      setActiveTerminalId,
      setActiveProjectId,
      setIsBufferFocused,
      setPromptBuffer,
      fetchWipDrafts,
      setTerminals,
      setFrozen,
      setFrozenRunning,
      setLedger,
      setGlobalPermissionsMode,
      setSettings,
      setIsMicMuted,
      setAutoApprovedNotification,
      setBlockedNotification,
      setTranscript,
      setWsErrorNotification,
      setProactiveNotifications,
      setPlans,
      queueStdoutChunk,
      fetchTerminals,
      fetchPlans,
      fetchActiveTerminalHistory,
      resetAudioPlayback,
      playAudioChunk: (m: any) => playAudioChunk(playbackCtx, m.audio),
      upsertNotification,
      effectForEvent,
      activeTerminalIdRef,
    });
  };

  const { wsRef, startLive, stopLive, reconnectLive } = useLiveSession({
    activeTerminalIdRef,
    isMicMutedRef,
    setIsLive,
    setIsReconnecting,
    isLive,
    onWsMessage,
  });

  // dbt4: the Markdown prompt-buffer / WIP-draft composer. Called AFTER useLiveSession so it can read
  // that hook's wsRef (handlePromptBufferChange pushes draft_edit frames over the SAME live socket,
  // falling back to REST). onWsMessage / the boot + active-pane effects close over the returned
  // setters/fetchers (deferred execution, so the post-declaration call site is TDZ-safe). setWipDrafts
  // is threaded into useE2EHarness below (the injectWipDraft harness contract).
  // chunk-2: keep the full composer object (passed as ONE prop into PromptSynchronizerPanel so the
  // hook's exact setter/handler identities thread through unchanged) AND destructure the flat
  // variables the rest of AppRaw still reads.
  const composer = useComposer({
    activeProjectId,
    activeTerminalId,
    wsRef,
    playEarcon,
    fetchLedger,
  });
  const {
    promptBuffer,
    setPromptBuffer,
    isBufferFocused,
    setIsBufferFocused,
    promptBufferEditMode,
    setPromptBufferEditMode,
    wipDrafts,
    setWipDrafts,
    contextInput,
    setContextInput,
    fetchActiveDraft,
    fetchWipDrafts,
    handlePromptBufferChange,
    handleSendDraft,
    handleAddHumanContext,
  } = composer;

  // dbt4: the gated-approval / deferred-action queue (pendingCommands / pendingActions +
  // fetchPendingCommands + the four approve/reject/confirm/cancel handlers). onWsMessage / the boot +
  // safety-net poll effects close over the returned setters/fetcher/handlers (deferred execution, so
  // the post-declaration call site is TDZ-safe). setPendingCommands + setPendingActions are threaded
  // into useE2EHarness below (the injectPendingApproval / injectPendingAction harness contracts).
  const {
    pendingCommands,
    setPendingCommands,
    pendingActions,
    setPendingActions,
    fetchPendingCommands,
    handleApprove,
    handleReject,
    handleConfirmAction,
    handleCancelAction,
  } = useApprovalsQueue({
    isMockModeRef,
    setTerminals,
    fetchTerminals,
  });

  // E2E test harness — fully isolated in ./e2e/harness. No-op unless ?mock=1. Called HERE (after
  // useComposer) so its deps can include setWipDrafts — the injectWipDraft harness contract
  // (src/e2e/harness.ts:167). e2eActiveRef (App-owned, created above for useStdoutStream's resize
  // guard) lets the mock-mode-gated resize POST still fire under e2e; the harness writes into it.
  // The 3 harness-wired setters threaded here: setPendingCommands, setPendingActions, setWipDrafts.
  useE2EHarness({
    isMockModeRef,
    e2eActiveRef,
    setIsMockMode,
    setShowTranscriptPanel,
    setTerminals,
    setActiveTerminalId,
    setLedger,
    queueStdoutChunk,
    setTranscript,
    setPendingCommands,
    setPendingActions,
    setFrozen,
    setFrozenRunning,
    setWipDrafts,
  });

  const generateMockData = () => {
    isMockModeRef.current = !isMockMode;
    setIsMockMode(!isMockMode);
    
    if (isMockMode) {
      // Turn off mock mode
      fetchTerminals();
      fetchLedger();
      fetchPendingCommands();
      setTranscript([]);
      return;
    }

    // Turn on mock mode and populate fake data. dbt4: the fixture literals were evicted into the
    // pure buildMockData factory (src/mockData.ts); the setter order here is unchanged.
    const mock = buildMockData(Date.now());
    setTerminals(mock.terminals);
    setLedger(mock.ledger);
    setActiveProjectId(mock.activeProjectId);
    setPendingCommands(mock.pendingCommands);
    setTranscript(mock.transcript);
  };

  const activeTerminal = terminals.find(t => t.id === activeTerminalId);
  const projectList = Object.values(ledger) as Workspace[];
  // f06: the context body (name + model/human context, rendered at App.tsx:2031-2034) must track
  // the active pane in the SAME render that moves the cyan highlight (which keys off activeTerminalId
  // directly). The data is already local — derive it synchronously from the ledger, no round-trip.
  // Extracted to a pure, unit-pinned resolver; keys solely off activeTerminalId (stale-active-project safe).
  const { pane: activePaneMeta, project: activeProjectMeta } =
    resolveActivePaneMeta(ledger, activeTerminalId);

  const handleCreateProject = () => {
    setEditingProject(null);
    setShowProjectModal(true);
  };

  const handleEditProject = (project: Workspace) => {
    setEditingProject(project);
    setShowProjectModal(true);
  };

  const handleSaveProject = async (data: {
    id: string;
    name: string;
    directory: string;
    summary: string;
    keyTerms: string[];
  }) => {
    if (isMockModeRef.current) {
      setLedger(prev => {
        const next = { ...prev };
        if (editingProject) {
          next[editingProject.id] = {
            ...next[editingProject.id],
            name: data.name,
            directory: data.directory,
            summary: data.summary,
            keyTerms: data.keyTerms,
          };
        } else {
          next[data.id] = {
            id: data.id,
            name: data.name,
            directory: data.directory,
            summary: data.summary,
            keyTerms: data.keyTerms,
            notes: [],
            panes: {}
          };
        }
        return next;
      });
      if (!editingProject) {
        setActiveProjectId(data.id);
      }
      setShowProjectModal(false);
      setEditingProject(null);
      return;
    }
    if (editingProject) {
      await apiFetch(`/api/projects/${editingProject.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          directory: data.directory,
          summary: data.summary,
          keyTerms: data.keyTerms,
        }),
      });
      fetchLedger();
    } else {
      await apiFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: data.id,
          name: data.name,
          directory: data.directory,
          summary: data.summary,
          keyTerms: data.keyTerms,
        }),
      });
      await handleSwitchProject(data.id);
    }
    setShowProjectModal(false);
    setEditingProject(null);
  };

  const handleSwitchProject = async (id: string) => {
    if (isMockModeRef.current) {
      setActiveProjectId(id);
      setActiveTerminalId(null);
      return;
    }
    await apiFetch(`/api/projects/${id}/switch`, { method: "POST" });
    setActiveProjectId(id);
    setActiveTerminalId(null);
    fetchLedger();
    fetchTerminals();
  };

  const handleDeleteProjectPrompt = (id: string) => {
    setPromptDialog({
      title: `Type "SURE" to de-register and delete project [${id}]:`,
      placeholder: "SURE",
      onSubmit: async (val) => {
        if (val.trim() !== "SURE") return;
        await apiFetch(`/api/projects/${id}`, { method: "DELETE" });
        setPromptDialog(null);
        fetchLedger();
        setActiveTerminalId(null);
        fetchTerminals();
      }
    });
  };

  const handleDeletePanePrompt = async (projId: string, paneId: string) => {
    await apiFetch(`/api/projects/${projId}/panes/${paneId}`, { method: "DELETE" });
    fetchLedger();
    if (activeTerminalId === paneId) {
      setActiveTerminalId(null);
    }
    fetchTerminals();
  };

  // Graceful per-pane EXIT: terminate the PTY and archive the pane (recoverable),
  // preserving the ledger record — the non-destructive middle between PRUNE (hard
  // delete) and the reactive "Clear Exited". On success the pane leaves the active
  // list (into the recoverable archive), so drop the terminal view back to the grid.
  const handleStopPane = async (projId: string, paneId: string) => {
    await apiFetch(`/api/projects/${projId}/panes/${paneId}/stop`, { method: "POST" });
    if (activeTerminalId === paneId) setActiveTerminalId(null);
    fetchLedger();
    fetchTerminals();
    fetchArchive();
    playEarcon("execute");
  };

  const handleRenameProject = (id: string, current: string) => {
    setPromptDialog({
      title: "Rename Project", placeholder: current,
      onSubmit: async (val) => {
        if (!val.trim()) return;
        await apiFetch(`/api/projects/${id}/rename`, { method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: val}) });
        setPromptDialog(null);
        fetchLedger();
      }
    });
  };

  const handleAddProjectNote = (id: string) => {
    setPromptDialog({
      title: "Add Project Note", placeholder: "Note...",
      onSubmit: async (val) => {
        if (!val.trim()) return;
        await apiFetch(`/api/projects/${id}/notes`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({note: val}) });
        setPromptDialog(null);
        fetchLedger();
      }
    });
  };

  const handleRenamePane = (projId: string, paneId: string, current: string) => {
    setPromptDialog({
      title: "Rename Pane", placeholder: current,
      onSubmit: async (val) => {
        if (!val.trim()) return;
        await apiFetch(`/api/projects/${projId}/panes/${paneId}/rename`, { method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: val}) });
        setPromptDialog(null);
        fetchLedger();
      }
    });
  };

  const handleAddPaneNote = (projId: string, paneId: string) => {
    setPromptDialog({
      title: "Add Pane Note", placeholder: "Note...",
      onSubmit: async (val) => {
        if (!val.trim()) return;
        await apiFetch(`/api/projects/${projId}/panes/${paneId}/notes`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({note: val}) });
        setPromptDialog(null);
        fetchLedger();
      }
    });
  };

  const handleAddPaneNoteInline = async (projId: string, paneId: string) => {
    const rawNote = newNoteInputs[paneId];
    if (!rawNote || !rawNote.trim()) return;
    await apiFetch(`/api/projects/${projId}/panes/${paneId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: rawNote.trim() })
    });
    setNewNoteInputs(prev => ({ ...prev, [paneId]: "" }));
    fetchProjectNotes(projId);
    fetchLedger();
  };

  const handleCopyClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const activeProject = projectList.find(p => p.id === activeProjectId);

  const totalContextSize = sumContextSize(activeProject?.panes, terminals);

  const totalTokensEstimated = estimateTokens(totalContextSize);

  return (
    <div className="flex flex-col h-screen w-full bg-[#050505] text-[#e0e0e0] font-sans overflow-hidden border-t-4 border-[#121212]">
      {/* Modal cluster — inner IIFE keeps AppRaw's CC under the gate (the modal && guards leave its
          scope). JSX order/props/handlers unchanged. */}
      {(() => (
      <>
      {showProjectModal && (
        <ProjectDialog
          onClose={() => {
            setShowProjectModal(false);
            setEditingProject(null);
          }}
          onSave={handleSaveProject}
          project={editingProject}
        />
      )}

      {showCreateModal && (
        <CreateTerminalDialog
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateTerminal}
        />
      )}

      {showSettingsModal && (
        <SettingsDialog
          onClose={() => setShowSettingsModal(false)}
          settings={settings}
          onSave={handleSaveSettings}
          terminals={terminals}
          isMockMode={isMockMode}
          onToggleMockMode={generateMockData}
          isLive={isLive}
          onReconnectLive={reconnectLive}
          activeProjectId={activeProjectId}
          activePanes={activeProject?.panes}
        />
      )}
      
      {/* Approval queue — extracted to ApprovalQueue (chunk-5 "modal-queues + AppHeader", section 1).
          ApprovalDialog stays a module import inside it; key={pending.messageId} + every prop spread
          are byte-identical; onApprove/onReject are the SAME useApprovalsQueue handler refs. */}
      <ApprovalQueue
        pendingCommands={pendingCommands}
        onApprove={handleApprove}
        onReject={handleReject}
      />

      {/* Action-confirm queue — extracted to ActionConfirmQueue (chunk-5, section 2). ActionConfirmDialog
          stays a module import inside it; key={action.actionId} + every prop spread are byte-identical;
          onConfirm/onCancel are the SAME useApprovalsQueue handler refs. */}
      <ActionConfirmQueue
        pendingActions={pendingActions}
        onConfirm={handleConfirmAction}
        onCancel={handleCancelAction}
      />

      <GenericPromptModal promptDialog={promptDialog} setPromptDialog={setPromptDialog} />
      </>
      ))()}

      {/* Toast Notifications — extracted to the ToastNotificationStack leaf (chunk-1). The per-toast
          && guards (and the raw-key tone→class/glyph derivation) now live there + toastLogic.ts. */}
      <ToastNotificationStack
        autoApprovedNotification={autoApprovedNotification}
        blockedNotification={blockedNotification}
        wsErrorNotification={wsErrorNotification}
        rawKeyNotification={rawKeyNotification}
      />

      {/* WS-D (BUG-024): proactive completion/error notification stack */}
      <NotificationStack
        notifications={proactiveNotifications}
        onDismiss={(id) => setProactiveNotifications(prev => dismissNotification(prev, id))}
      />

      {/* Header — extracted to AppHeader (chunk-5 "modal-queues + AppHeader", section 3). The brand
          + telemetry strip, the right-hand controls cluster, and the connect/mute toggle stay as the
          SAME three internal nested render closures VERBATIM. EmergencyStop + the lucide icons + the
          gemini/format/context helpers stay module imports inside it; the two brand-strip pure
          derivations were hoisted to appHelpers (headerStatusDotClass / headerRunningCount). All state
          reads + handlers thread as props; setIsMicMuted is the SAME harness-wired ref. */}
      <AppHeader
        isLive={isLive}
        isReconnecting={isReconnecting}
        isSimpleMode={isSimpleMode}
        pendingCommands={pendingCommands}
        terminals={terminals}
        activeProject={activeProject}
        globalPermissionsMode={globalPermissionsMode}
        isMicMuted={isMicMuted}
        totalContextSize={totalContextSize}
        totalTokensEstimated={totalTokensEstimated}
        showTranscriptPanel={showTranscriptPanel}
        transcript={transcript}
        frozen={frozen}
        frozenRunning={frozenRunning}
        setIsSimpleMode={setIsSimpleMode}
        playEarcon={playEarcon}
        handleUpdateGlobalPermissions={handleUpdateGlobalPermissions}
        setIsMicMuted={setIsMicMuted}
        startLive={startLive}
        stopLive={stopLive}
        setShowTranscriptPanel={setShowTranscriptPanel}
        handleStopAllFreeze={handleStopAllFreeze}
        handleStopAllKill={handleStopAllKill}
        handleStopAllRelease={handleStopAllRelease}
        setShowSettingsModal={setShowSettingsModal}
      />

      {/* bead 8sq: FROZEN banner — Stage-2 hold-to-fire kill + Release (spec §2.C). Renders full-width
          directly under the header when a Stage-1 freeze is active. Extracted to FrozenBanner (chunk-1);
          it keeps the EmergencyStop module import. Same handler trio also feeds the header trigger. */}
      <FrozenBanner
        frozen={frozen}
        frozenRunning={frozenRunning}
        onFreeze={handleStopAllFreeze}
        onKill={handleStopAllKill}
        onRelease={handleStopAllRelease}
      />

      {/* Mobile Terminals Quick Swiper Bar — extracted to MobileTerminalSwiperBar (chunk-4
          "sidebar-swiper", section 1). mobileSwiperColorClass/mobileSwiperDotClass stay module
          imports inside it; setActiveTerminalId is the SAME harness-wired ref. JSX byte-identical. */}
      <MobileTerminalSwiperBar
        activeTerminalId={activeTerminalId}
        terminals={terminals}
        pendingCommands={pendingCommands}
        setActiveTerminalId={setActiveTerminalId}
        setMobileActiveView={setMobileActiveView}
      />

      {/* Main Content */}
      <main className="flex flex-col lg:flex-row flex-1 overflow-hidden min-h-0">
        {/* Sidebar — extracted to WorkspaceSidebar (chunk-4 "sidebar-swiper", section 2). The four
            internal render closures, <AnimatePresence initial={false}>, <motion.div key={pane.pane_id}>,
            GateChip, and the lone <nav> className all live VERBATIM inside it. setActiveTerminalId is
            the SAME harness-wired ref; the 11 mutation handlers stay in App and pass down here. */}
        <WorkspaceSidebar
          mobileActiveView={mobileActiveView}
          activeTerminalId={activeTerminalId}
          termFilter={termFilter}
          activeProjectId={activeProjectId}
          projectList={projectList}
          terminals={terminals}
          pendingCommands={pendingCommands}
          recentlyIdled={recentlyIdled}
          setActiveTerminalId={setActiveTerminalId}
          setTermFilter={setTermFilter}
          handleCreateProject={handleCreateProject}
          handleSwitchProject={handleSwitchProject}
          handleEditProject={handleEditProject}
          handleRenameProject={handleRenameProject}
          handleAddProjectNote={handleAddProjectNote}
          handleDeleteProjectPrompt={handleDeleteProjectPrompt}
          handleRenamePane={handleRenamePane}
          handleAddPaneNote={handleAddPaneNote}
          setShowCreateModal={setShowCreateModal}
        />

        {/* Center Content — wrapped in an inline render closure (IIFE) for the burndown; this is the
            largest sub-tree (terminal view vs dashboard), so its conditionals dominate AppRaw's CC.
            JSX order/keys/props/handlers unchanged. */}
        {(() => (
        <section className={`flex-1 flex flex-col bg-[#0b0b0b] min-w-0 min-h-0 h-full overflow-hidden ${mobileActiveView === "terminal" ? "flex" : "hidden lg:flex"}`}>
          {activeTerminalId && activeTerminal ? (
            /* Terminal View — inner IIFE keeps the center-section IIFE's CC under the gate. */
            (() => (
            <div className="flex flex-1 flex-row overflow-hidden">
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Active-pane header bar — extracted to ActivePaneHeaderBar (chunk-6 "terminal-view
                    + dashboard chrome", section 3). GateChip stays a module import inside it;
                    data-testid="gate-chip-header" is byte-identical (the real-pointer clickability
                    guard). setActiveTerminalId is the SAME harness-wired ref — Back-to-Grid still calls
                    setActiveTerminalId(null). The History-toggle conditional fetch is preserved. */}
                <ActivePaneHeaderBar
                  activeProjectMeta={activeProjectMeta}
                  activePaneMeta={activePaneMeta}
                  activeTerminal={activeTerminal}
                  activeProjectId={activeProjectId}
                  showHistoryPanel={showHistoryPanel}
                  setShowHistoryPanel={setShowHistoryPanel}
                  fetchActiveTerminalHistory={fetchActiveTerminalHistory}
                  handleRestartTerminal={handleRestartTerminal}
                  setActiveTerminalId={setActiveTerminalId}
                  handleStopPane={handleStopPane}
                />
                {/* Raw control-key bar (multi-cli adapter spec §8): send literal keystrokes (arrows,
                    Tab, Esc, Enter, Ctrl+C, Shift+Tab) straight into the pane's PTY. Independent of
                    the mode <select>; Ctrl+C/Shift+Tab carry the warn tint (Shift+Tab is gated). */}
                <div className="px-2 sm:px-4 lg:px-6 py-1.5 border-b border-white/5 bg-black/30 flex items-center gap-2">
                  <span className="text-xs font-mono uppercase tracking-[0.15em] text-zinc-600 shrink-0">Keys</span>
                  <ControlKeyBar paneId={activeTerminal.id} onKey={writeControlKey} />
                </div>
                <div data-testid="terminal-pane" className="flex-1 p-2 sm:p-4 lg:p-6 font-mono text-xs overflow-hidden leading-relaxed bg-[#060606] relative">
                  <TerminalView
                    key={activeTerminal.id}
                    terminalId={activeTerminal.id}
                    backfill={activeTerminal.backfill}
                    onResize={(cols, rows) => handleTerminalResize(activeTerminal.id, cols, rows)}
                    onInput={(data) => {
                      const ws = wsRef.current;
                      if (!shouldSendPaneInput(isMockModeRef.current, isE2EWireArmed(), ws)) return;
                      ws!.send(JSON.stringify(buildPaneInputFrame(activeTerminal.id, data)));
                    }}
                  />
                </div>
              </div>

              {/* Collapsible History Sidebar Panel — extracted to PaneHistorySidebar (chunk-6
                  "terminal-view + dashboard chrome", section 4). The showHistoryPanel gate STAYS here;
                  the [...historyList].reverse() ordering + the (entry as any) casts are byte-identical;
                  the per-row selected predicate is the hoisted historyEntryIsSelected helper.
                  fetchActiveTerminalHistory / clearActiveTerminalHistory / setSelectedHistoryEntry come
                  from useTerminalHistory and thread straight through. */}
              {showHistoryPanel && (
                <PaneHistorySidebar
                  historyList={historyList}
                  selectedHistoryEntry={selectedHistoryEntry}
                  fetchActiveTerminalHistory={fetchActiveTerminalHistory}
                  clearActiveTerminalHistory={clearActiveTerminalHistory}
                  setSelectedHistoryEntry={setSelectedHistoryEntry}
                />
              )}
            </div>
            ))()
          ) : (
            /* Dashboard High-Level View — inner IIFE keeps the center-section IIFE's CC under the gate. */
            (() => (
            <div className="flex-1 flex flex-col overflow-y-auto p-4 lg:p-8">
              {/* Dashboard chrome ABOVE the grid — extracted to DashboardHeader (chunk-6 "terminal-view
                  + dashboard chrome", section 5). The title, the view-mode switcher (its inner IIFE kept
                  VERBATIM), and the conditional Clear-Exited button. countExitedPanes stays a module
                  import inside it; setGridDisplayMode is a plain useState setter. The grid itself
                  (filteredPanes.map + render*Card) stays below, untouched. */}
              <DashboardHeader
                isSimpleMode={isSimpleMode}
                gridDisplayMode={gridDisplayMode}
                activeProject={activeProject}
                terminals={terminals}
                setGridDisplayMode={setGridDisplayMode}
                handleClearExited={handleClearExited}
              />

              {/* Core Goal: Live Conversation & Synergy Matrix — extracted to the SynergyMatrixPanel
                  leaf (chunk-3). The voice-hub + spec-buffer halves are INTERNAL closures there; the
                  AGENT STATUS label is the new voiceAgentStatusLabel helper (its strings differ from
                  the header's geminiVoiceLabel), the badge is specBufferBadge. setIsMicMuted is
                  harness-wired and threaded unchanged. */}
              <SynergyMatrixPanel
                isLive={isLive}
                isReconnecting={isReconnecting}
                isMicMuted={isMicMuted}
                promptBuffer={promptBuffer}
                startLive={startLive}
                stopLive={stopLive}
                setIsMicMuted={setIsMicMuted}
                setMobileActiveView={setMobileActiveView}
              />

              {/* dbt4 (sec-pane-grid): the dashboard pane-grid — extracted as ONE atomic component
                  PaneGridSection (chunk-7 "pane-grid"). The grid IIFE (filteredPanes derivation + the
                  4 render*Card closures sharing ~11 per-iteration map-locals + the dispatch ladder +
                  the empty-state) lives there VERBATIM; splitting the cards would diverge the shared
                  locals. AnimatePresence mode="popLayout"/layout/key={pane.pane_id} preserved exactly.
                  setActiveTerminalId is harness-wired (passed straight through); writeControlKeyFromGrid
                  stays App-owned (set_active_pane → byte; active-pane guard) and threads down unchanged;
                  every note/permissions/restart/copy mutation handler stays in App. Residual inline
                  derivations were hoisted to appHelpers (paneHasPendingCommand / isRecentlyIdled /
                  tailOutputLines / chooseChronicleSource), char-pinned in tests/test_pane_grid_logic.ts. */}
              <PaneGridSection
                activeProject={activeProject}
                terminals={terminals}
                termFilter={termFilter}
                gridDisplayMode={gridDisplayMode}
                isSimpleMode={isSimpleMode}
                pendingCommands={pendingCommands}
                recentlyIdled={recentlyIdled}
                activeProjectNotes={activeProjectNotes}
                activeProjectId={activeProjectId}
                copiedId={copiedId}
                editingNoteId={editingNoteId}
                editingNoteText={editingNoteText}
                newNoteInputs={newNoteInputs}
                setActiveTerminalId={setActiveTerminalId}
                handleRestartTerminal={handleRestartTerminal}
                writeControlKeyFromGrid={writeControlKeyFromGrid}
                handleCopyClipboard={handleCopyClipboard}
                handleUpdatePermissions={handleUpdatePermissions}
                handleAddPaneNoteInline={handleAddPaneNoteInline}
                handleSaveNoteEdit={handleSaveNoteEdit}
                handleDeleteNote={handleDeleteNote}
                setEditingNoteId={setEditingNoteId}
                setEditingNoteText={setEditingNoteText}
                setNewNoteInputs={setNewNoteInputs}
                setShowCreateModal={setShowCreateModal}
              />

              {/* Artifacts & Memory Registry Panel — extracted to ArtifactsRegistryPanel (chunk-6
                  "terminal-view + dashboard chrome", section 2). The two-column workspace/pane register
                  (formatCharCount stays a module import inside it; the live-pane check is the hoisted
                  isPaneLive helper) AND the nested Pane Archive (now <ArchivePanel/>, section 1). All
                  project/pane mutation handlers stay in App and thread down; the archive state + its
                  restore/delete/refresh handlers thread straight through to ArchivePanel. */}
              <ArtifactsRegistryPanel
                projectList={projectList}
                activeProjectId={activeProjectId}
                activeProject={activeProject}
                terminals={terminals}
                handleCreateProject={handleCreateProject}
                handleSwitchProject={handleSwitchProject}
                handleDeleteProjectPrompt={handleDeleteProjectPrompt}
                handleDeletePanePrompt={handleDeletePanePrompt}
                handleRestartTerminal={handleRestartTerminal}
                archive={archive}
                showArchivePanel={showArchivePanel}
                setShowArchivePanel={setShowArchivePanel}
                handleRestoreArchived={handleRestoreArchived}
                handleDeleteArchived={handleDeleteArchived}
                fetchArchive={fetchArchive}
              />
            </div>
            ))()
          )}
        </section>
        ))()}

        {/* Mobile Active Views */}
        {mobileActiveView === "buffer" && (
          <section className="flex-1 flex flex-col bg-[#080808] p-4 lg:hidden overflow-y-auto h-full gap-4">
            <TerminalHealthHeatmap
              terminals={terminals}
              pendingCommands={pendingCommands}
              activeTerminalId={activeTerminalId}
              hoveredTermId={hoveredTermId}
              onHoverTerm={setHoveredTermId}
            />
            <HelperPanelTabHeader promptBuffer={promptBuffer} wipDrafts={wipDrafts} />
            <PromptSynchronizerPanel
              composer={composer}
              activePaneMeta={activePaneMeta}
              activeTerminalId={activeTerminalId}
              setActiveTerminalId={setActiveTerminalId}
            />
          </section>
        )}

        {/* Desktop Helper Panel: Shared Sync Buffer */}
        <aside className="hidden lg:flex w-[400px] shrink-0 border-l border-white/5 bg-black/40 flex-col overflow-hidden max-h-full">
          <div className="p-4 border-b border-white/5 bg-black/10 shrink-0">
            <TerminalHealthHeatmap
              terminals={terminals}
              pendingCommands={pendingCommands}
              activeTerminalId={activeTerminalId}
              hoveredTermId={hoveredTermId}
              onHoverTerm={setHoveredTermId}
            />
          </div>
          <div className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto h-full scrollbar-thin">
            <HelperPanelTabHeader promptBuffer={promptBuffer} wipDrafts={wipDrafts} />
            <PromptSynchronizerPanel
              composer={composer}
              activePaneMeta={activePaneMeta}
              activeTerminalId={activeTerminalId}
              setActiveTerminalId={setActiveTerminalId}
            />
          </div>
        </aside>

        {/* Right side Transcript Log Panel — extracted to the TranscriptPanel leaf (chunk-3). The
            showTranscriptPanel gate STAYS here; setTranscript is harness-wired (Clear) and fires via
            onClear unchanged. */}
        {showTranscriptPanel && <TranscriptPanel transcript={transcript} onClear={() => setTranscript([])} />}
      </main>

      {/* Mobile Sticky Touch-friendly Navigation Bar — extracted to the MobileNavBar leaf (chunk-1). */}
      <MobileNavBar
        mobileActiveView={mobileActiveView}
        setMobileActiveView={setMobileActiveView}
        promptBuffer={promptBuffer}
      />

      {/* System Bar — extracted to the SystemStatusBar leaf (chunk-3). formatCharCountLower /
          formatTokenCount stay module imports there; only the two derived totals are threaded. */}
      <SystemStatusBar totalContextSize={totalContextSize} totalTokensEstimated={totalTokensEstimated} />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppRaw />
    </ErrorBoundary>
  );
}
