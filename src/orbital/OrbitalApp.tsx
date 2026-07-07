// ── ORBITAL KITCHEN — app shell + view router ───────────────────────────
// Wave P0: chrome + routing + tweaks (all genuinely working, client-side).
// Live data, board, burner, radio, settings, the pass land in later waves.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import "./orbital.css";
import { ACCENTS, INK } from "./theme";
import { Icon, IconSprite, Mascot } from "./primitives";
import { TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakColor } from "./TweaksPanel";
import { useTweaks, mergedDefaults, type Tweaks } from "./useTweaks";
import { useOrbitalData } from "./useOrbitalData";
import { useConversationalState, chipColorForKind, type ConversationalState } from "./useConversationalState";
import { groupHandoffsByPane } from "./useOrbitalDataHelpers";
import { deriveProjects, deriveStations } from "./station";
import { Board, ProjectsSidebar } from "./views/Line";
import { ServiceMode } from "./ServiceMode";
import { EmergencyStop } from "./EmergencyStop";
import { KitchenRadio } from "./KitchenRadio";
import { ActionPanel } from "./ActionPanel";
import { CaptionBar } from "./CaptionBar";
import { TerminalWindow } from "./TerminalWindow";
import { BackOfHouse } from "./views/BackOfHouse";
import { ThePass } from "./views/Pass";
import { ThePantry } from "./views/Pantry";
import { NewPaneModal, NewProjectModal } from "./modals";
import { ApprovalDialog } from "../components/ApprovalDialog";
import { ActionConfirmDialog } from "../components/ActionConfirmDialog";
import { DaemonStateBadge } from "../components/DaemonStateBadge";
import type { DaemonState } from "../components/DaemonStateBadge";
import { modeToServiceId, serviceIdToMode, type ServiceModeId } from "./theme";
import {
  resolveStartView, resolveStartProject, getLocationSearch,
  resolveServiceId, resolvePassProjectId, resolvePassProjectName,
  matchVoiceCall, labelForPill, type View,
} from "./orbitalAppHelpers";

const CHATTER = [
  "Order up, Chef!", "Two on the burner, lookin' good.", "Heard, Chef.",
  "Station four's movin'.", "Pass is gettin' busy!", "Yes, Chef!", "We're cookin' now.",
];

const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700;9..144,800;9..144,900&family=DM+Sans:wght@400;500;600;700;800&family=Caveat:wght@500;600;700&family=JetBrains+Mono:wght@500;700&display=swap";

// Load the kitchen webfonts + reset the body margin ONLY while the kitchen is
// mounted. Kept out of index.html so the classic app (and its e2e suite, which
// waits on networkidle) never blocks on the Google Fonts request.
function useKitchenChrome() {
  useEffect(() => {
    let link: HTMLLinkElement | null = null;
    if (!document.getElementById("orbital-fonts")) {
      link = document.createElement("link");
      link.id = "orbital-fonts";
      link.rel = "stylesheet";
      link.href = FONTS_HREF;
      document.head.appendChild(link);
    }
    const prevMargin = document.body.style.margin;
    const prevHtmlH = document.documentElement.style.height;
    const prevBodyH = document.body.style.height;
    document.body.style.margin = "0";
    document.documentElement.style.height = "100%";
    document.body.style.height = "100%";
    const root = document.getElementById("root");
    const prevRootH = root?.style.height ?? "";
    if (root) root.style.height = "100%";
    return () => {
      document.body.style.margin = prevMargin;
      document.documentElement.style.height = prevHtmlH;
      document.body.style.height = prevBodyH;
      if (root) root.style.height = prevRootH;
      link?.remove();
    };
  }, []);
}

// Velocity-design (D7): the conversational pill — a glanceable read of the voice channel's state,
// driven by the useConversationalState machine. Only shown once a voice session is requested (off-air
// has its own "Tune in" affordance in the radio, so the nav stays quiet until the chef is on the air).
// SEAM (bead m9v): the radio chip (getChipBg) and this nav pill dot now resolve their color through
// the SAME chipColorForKind map in useConversationalState — single source of truth, so the two
// surfaces can never paint one state two different colors. No local placeholder map here anymore.
function ConversationalPill({ state }: { state: ConversationalState }) {
  if (state.kind === "offline") return null; // the radio's own "Tune in" owns the off-air case
  const pulse = state.kind === "tuning" || state.kind === "thinking" || state.kind === "blocked";
  return (
    <div data-testid="convo-pill" data-convo-state={state.kind}
      style={{ display: "flex", alignItems: "center", gap: 7, background: "#fff4de", color: INK, padding: "6px 12px", borderRadius: 999, border: "2px solid " + INK, boxShadow: "2px 2px 0 0 " + INK, flexShrink: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: chipColorForKind(state.kind), border: "1.5px solid " + INK, animation: pulse ? "orb-pulse 1s var(--ease-bounce) infinite" : undefined }} />
      {/* labelForPill drops any leading bullet the shared label carries (LABELS.listening = '● LIVE'),
          so the pill's own dot span above is never doubled to '● ● LIVE'. */}
      <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, whiteSpace: "nowrap", textTransform: "capitalize" }}>{labelForPill(state.label)}</span>
    </div>
  );
}

function TopNav({ accentHex, accentOn, view, setView, running, needsCount, onJumpToNeeds, mode, setMode, onPanic, connected, convo, daemonState }: {
  accentHex: string; accentOn: string; view: View; setView: (v: View) => void; running: number;
  needsCount: number; onJumpToNeeds: () => void;
  mode: ServiceModeId; setMode: (id: ServiceModeId) => void; onPanic: () => void;
  /** 1B.1: the live /live stream is actually attached — the pill must not claim "Kitchen open" while dark. */
  connected: boolean;
  /** Velocity-design (D7): the conversational pill's derived state (useConversationalState). */
  convo: ConversationalState;
  /** A-1a (inc2): the latest daemon_state — shows a subtle badge when the approver is in fallback. */
  daemonState: DaemonState;
}) {
  const tabs: { id: View; l: string; i: string }[] = [
    { id: "line", l: "The Line", i: "fire" },
    { id: "pantry", l: "The Pantry", i: "salt" },
    { id: "boh", l: "Back of House", i: "menu" },
  ];
  return (
    <nav style={{ position: "relative", display: "flex", alignItems: "center", gap: 16, padding: "11px 20px", background: accentHex, borderBottom: "3px solid " + INK, color: accentOn, flexShrink: 0, zIndex: 5 }}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: -3, height: 6, backgroundImage: "repeating-linear-gradient(90deg, #fff4de 0 12px, #2a1a10 12px 24px)" }} />
      <img src="/orbital/logo-mark.svg" alt="" style={{ height: 42, width: "auto", flexShrink: 0 }} />
      <div style={{ lineHeight: 1, flexShrink: 0 }}>
        <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 22, color: accentOn, letterSpacing: ".02em" }}>ORBITAL</div>
        <div style={{ fontFamily: "Caveat, cursive", fontSize: 15, color: accentOn, opacity: .9, marginTop: -1, transform: "rotate(-1.5deg)", whiteSpace: "nowrap" }}>the kitchen pass</div>
      </div>
      <div style={{ display: "flex", gap: 4, background: INK, padding: 4, borderRadius: 10, marginLeft: 10, flexShrink: 0 }}>
        {tabs.map((t) => {
          const on = view === t.id;
          return (
            <button key={t.id} data-testid={`tab-${t.id}`} aria-pressed={on} onClick={() => setView(t.id)} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 7, cursor: "pointer", border: "none",
              background: on ? "#ffc94a" : "transparent", color: on ? INK : "#ffe9c7",
              fontFamily: "DM Sans", fontWeight: 800, fontSize: 13, whiteSpace: "nowrap",
            }}><Icon name={t.i} size={15} />{t.l}</button>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      <ServiceMode mode={mode} setMode={setMode} />
      {needsCount > 0 && (
        <button data-testid="needs-you" onClick={onJumpToNeeds} title="Jump to the station that needs you"
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, border: "2px solid " + INK, background: "#ff8a3d", color: INK, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 900, fontSize: 12, whiteSpace: "nowrap", boxShadow: "2px 2px 0 0 " + INK, flexShrink: 0 }}>
          🛎 Needs you · {needsCount}
        </button>
      )}
      {/* 1B.1: honest status pill — green "Kitchen open" only while the live stream is attached;
          a dropped socket shows the pulsing red "Kitchen dark" until the bounded backoff reconnects. */}
      <div data-testid="kitchen-status" style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff4de", color: INK, padding: "6px 12px", borderRadius: 999, border: "2px solid " + INK, boxShadow: "2px 2px 0 0 " + INK, flexShrink: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "#4db892" : "#e23a3a", border: "1.5px solid " + INK, animation: connected ? undefined : "orb-pulse 1s var(--ease-bounce) infinite" }} />
        <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, whiteSpace: "nowrap" }}>
          {connected ? <>Kitchen open · {running} on the burner</> : <>Kitchen dark — reconnecting…</>}
        </span>
      </div>
      {/* A-1a (inc2): subtle degraded-state badge — visible only when the Python approver has fallen back. */}
      <DaemonStateBadge state={daemonState} />
      <ConversationalPill state={convo} />
      <button data-testid="all-hands" onClick={onPanic} title="Emergency brake" style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 10, border: "2px solid " + INK, background: "#2a1a10", color: "#ffc94a", cursor: "pointer", fontFamily: "DM Sans", fontWeight: 900, fontSize: 12.5, letterSpacing: ".04em", boxShadow: "2px 2px 0 0 " + INK, flexShrink: 0, textTransform: "uppercase" }}>
        <Icon name="fire" size={16} color="#e23a3a" /> All Hands
      </button>
    </nav>
  );
}

function CornerChef({ show, chatter }: { show: boolean; chatter: boolean }) {
  const [line, setLine] = useState(CHATTER[0]);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!chatter) return;
    const iv = setInterval(() => setIdx((n) => (n + 1) % CHATTER.length), 3800);
    return () => clearInterval(iv);
  }, [chatter]);
  useEffect(() => { setLine(CHATTER[idx]); }, [idx]);
  if (!show) return null;
  return (
    <div style={{ position: "fixed", bottom: -14, left: 250, pointerEvents: "none", zIndex: 50 }}>
      {chatter && (
        <div style={{ position: "absolute", bottom: "calc(100% - 6px)", left: 30, background: "#fff9ec", border: "2px solid " + INK, borderRadius: 12, padding: "6px 11px", boxShadow: "2px 2px 0 0 " + INK, fontFamily: "Caveat, cursive", fontSize: 17, color: "#a8151a", transform: "rotate(-2deg)", whiteSpace: "nowrap" }}>
          {line}
          <div style={{ position: "absolute", bottom: -6, left: 16, width: 10, height: 10, background: "#fff9ec", borderRight: "2px solid " + INK, borderBottom: "2px solid " + INK, transform: "rotate(45deg)" }} />
        </div>
      )}
      <Mascot variant="running" size={64} style={{ animation: "orb-dance 0.85s var(--ease-bounce) infinite", transformOrigin: "bottom center" }} />
    </div>
  );
}

function DanceTroupe({ show }: { show: boolean }) {
  if (!show) return null;
  const crew: ("default" | "wink" | "running" | "panic")[] = ["default", "wink", "running", "panic", "default", "wink"];
  return (
    <div style={{ position: "fixed", bottom: 0, left: 234, right: 408, height: 92, pointerEvents: "none", zIndex: 49, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 18, overflow: "hidden" }}>
      {Array.from({ length: 14 }).map((_, i) => (
        <span key={"c" + i} style={{ position: "absolute", bottom: 30 + (i % 4) * 14, left: (i * 7.0 + 4) + "%", width: 7, height: 7, borderRadius: i % 2 ? "50%" : 1, background: ["#e23a3a", "#ffc94a", "#4db892", "#4b3bb3", "#ff8a3d"][i % 5], border: "1.5px solid " + INK, animation: `orb-confetti ${0.5 + (i % 5) * 0.12}s ease-in-out ${i * 0.07}s infinite alternate` }} />
      ))}
      {crew.map((v, i) => (
        <span key={i} style={{ display: "contents" }}>
          <Mascot variant={v} size={58 + (i % 2) * 6} style={{ animation: `${i % 2 ? "orb-dance2" : "orb-dance"} ${0.7 + (i % 3) * 0.12}s var(--ease-bounce) ${i * 0.08}s infinite`, transformOrigin: "bottom center" }} />
        </span>
      ))}
    </div>
  );
}

export default function OrbitalApp() {
  useKitchenChrome();
  const locationSearch = getLocationSearch();
  const [t, setTweak] = useTweaks(mergedDefaults());
  const acc = ACCENTS[t.accent] || ACCENTS.cherry;
  const [view, setView] = useState<View>(resolveStartView(locationSearch));
  const [selectedProject, setSelectedProject] = useState<string>(resolveStartProject(locationSearch));
  const [panic, setPanic] = useState(false);
  const [newPaneProj, setNewPaneProj] = useState<string | null>(null);
  const [newProjOpen, setNewProjOpen] = useState(false);
  const [burnerId, setBurnerId] = useState<string | null>(null);
  const pageBg: CSSProperties["background"] = t.dark ? "#1a0f08" : "var(--cream)";

  const data = useOrbitalData({ voiceCues: t.voiceCues, desktopNotes: t.desktopNotes });
  const stations = useMemo(
    () => deriveStations(data.terminals, data.ledger, data.pendingCommands),
    [data.terminals, data.ledger, data.pendingCommands],
  );
  const projects = useMemo(() => deriveProjects(stations, data.ledger), [stations, data.ledger]);
  // j4e1: the per-station handoff line-drawer wiring — handoffs bucketed by to_pane + the hero-action
  // callbacks (deliver/revise/reject, which fire the canonical handoff REST twins inside the hook).
  const handoffWiring = useMemo(() => ({
    byPane: groupHandoffsByPane(data.handoffs),
    onDeliver: data.deliverHandoff, onRevise: data.reviseHandoff, onStage: data.stageHandoff,
    onReject: data.rejectHandoff, onFetchPrompt: data.fetchHandoffPrompt,
  }), [data.handoffs, data.deliverHandoff, data.reviseHandoff, data.stageHandoff, data.rejectHandoff, data.fetchHandoffPrompt]);
  const running = stations.filter((s) => s.status === "Running").length;
  // Velocity-design (D7): the conversational pill's state, derived from the voice-channel signals the
  // data layer already computes + tool-call activity off the transcript (activeSources). Pure machine,
  // memoized — additive and perf-safe (no per-frame xterm work).
  const convo = useConversationalState({
    live: data.isLive, connected: data.voiceConnected, micBlocked: data.micBlocked,
    muted: data.micMuted, reconnecting: data.voiceReconnecting, transcript: data.transcript,
    // bead 8fz.2: real audio playback + a resolvable approval on the attention queue. `executing`
    // has no backing signal yet — reserved for a follow-up wave (dispatch/tool-write telemetry).
    speaking: data.audioPlaying, waiting: data.approvalWaiting, executing: false,
  });
  const needsList = stations.filter((s) => s.status === "Needs Input");
  const jumpToNeeds = () => { const f = needsList[0]; if (f) { data.selectActivePane(f.id); setBurnerId(f.id); } };

  // A clicked call must DO the thing it names — never fake a "heard!" receipt for a no-op (that's
  // the costume-over-machine anti-pattern, dangerous on "ALL HANDS"). Deterministic calls dispatch to
  // the real handler; genuinely voice-only lines (free-form orders, queries the model answers) get an
  // honest "say it out loud" coaching hint instead of a false success ack.
  const handleCall = (phrase: string) => {
    const action = matchVoiceCall(phrase, stations);
    if (action.kind === "open") { data.selectActivePane(action.stationId); setBurnerId(action.stationId); }
    else if (action.kind === "setMode") { data.setGlobalMode(action.mode); }
    else if (action.kind === "stopFreeze") { data.stopAllFreeze(); setPanic(true); }
    else if (action.kind === "stopRelease") { data.stopAllRelease(); setPanic(false); }
    else { data.showToast(`🎙 Say "${action.phrase}" out loud to fire it`); } // honest coaching — not a receipt
  };
  const serviceId = resolveServiceId(data.globalPermissionsMode);

  // The Burner: the station whose live terminal is open. Resolved from the live board so it tracks
  // status; if the pane disappears (closed/archived) the modal self-closes on the next render.
  const burnerStation = burnerId ? stations.find((s) => s.id === burnerId) : undefined;
  const burnerBackfill = burnerId ? data.terminals.find((t) => t.id === burnerId)?.backfill : undefined;
  useEffect(() => {
    if (burnerId && stations.length > 0 && !stations.some((s) => s.id === burnerId)) setBurnerId(null);
  }, [burnerId, stations]);

  // The Pass jots into one concrete project: the selected one, else the active station's, else the first.
  const passProjectId = resolvePassProjectId(selectedProject, stations, data.activeTerminalId, projects);
  const passProjectName = resolvePassProjectName(passProjectId, projects);
  // Keep The Pass's tickets fresh for the in-view project(s): the selected one, or all when unfiltered.
  const projectIdsKey = projects.map((p) => p.id).join(",");
  const refetchNotes = data.refetchNotes;
  useEffect(() => {
    const ids = selectedProject !== "all" ? [selectedProject] : projectIdsKey.split(",").filter(Boolean);
    if (ids.length) refetchNotes(ids);
  }, [selectedProject, projectIdsKey, refetchNotes]);

  // 4U.3: the Service log is a review surface — refresh it when the Pantry opens (no polling).
  const refetchServiceLog = data.refetchServiceLog;
  useEffect(() => {
    if (view === "pantry") refetchServiceLog();
  }, [view, refetchServiceLog]);

  // bead apu: the health strip is a status read — refresh it when the Pantry opens (no polling).
  const refetchHealth = data.refetchHealth;
  useEffect(() => {
    if (view === "pantry") refetchHealth();
  }, [view, refetchHealth]);

  // ── inline render helpers — relocate JSX subsections; no new components, no hook changes ──

  const renderLineView = (): ReactNode => {
    if (view !== "line") return null;
    const dotBg = t.dark
      ? "radial-gradient(#3a2415 1px, transparent 1.5px)"
      : "radial-gradient(#e7cfa0 1px, transparent 1.5px)";
    return (
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        <ProjectsSidebar stations={stations} projects={projects} selected={selectedProject} setSelected={setSelectedProject} dark={t.dark} onNewProject={() => setNewProjOpen(true)} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, minWidth: 0, backgroundImage: dotBg, backgroundSize: "18px 18px" }}>
          <ThePass notes={data.notes} plans={data.plans} templates={data.templates} layouts={data.layouts} attention={data.attentionQueue}
            stations={stations} activePaneId={data.activeTerminalId}
            jotProjectId={passProjectId} jotProjectName={passProjectName} dark={t.dark} voiceCues={t.voiceCues}
            onAdd={(pid, text) => data.addNote(pid, text)} onEdit={(id, text) => data.editNote(id, text, passProjectId ?? undefined)} onDelete={(id) => data.deleteNote(id, passProjectId ?? undefined)}
            onFirePane={(pid) => { setSelectedProject(pid); setNewPaneProj(pid); }} onJumpToPane={(id) => { data.selectActivePane(id); setBurnerId(id); }}
            onExecutePlan={data.executePlan} onDeletePlan={data.deletePlan}
            onCreateTemplate={data.createTemplate} onUpdateTemplate={data.updateTemplate} onDeleteTemplate={data.deleteTemplate} onApplyTemplate={data.applyTemplate}
            onSaveLayout={data.saveLayout} onApplyLayout={data.applyLayout} onDeleteLayout={data.deleteLayout}
            /* bead e7h: attention acts. Approve/Deny resolve a HELD gated request by its messageId
               through the SAME POST /api/commands/approve resolver voice uses (data.approveAttention /
               data.denyAttention id-gate that internally); a triage-only item (no messageId) degrades
               to jump-to-station / local dismiss. We also open the burner on approve so the operator
               lands on the station. restart → re-fire the dead/failed station; dismiss → clear it. */
            onApproveAttention={(item) => { data.approveAttention(item); setBurnerId(item.terminalId); }}
            onDenyAttention={(item) => data.denyAttention(item)}
            onRestartAttention={(id) => data.restartPane(id)}
            onDismissAttention={(id) => data.dismissAttention(id)} />
          <Board stations={stations} projects={projects} dark={t.dark} density={t.density} layout={t.layout} onOpen={(st) => { data.selectActivePane(st.id); setBurnerId(st.id); }} showCue={t.voiceCues} activeId={data.activeTerminalId} selectedProject={selectedProject} onNewPane={(pid) => setNewPaneProj(pid)} onClearExited={data.clearExited} handoffs={handoffWiring} />
        </div>
        {/* action-right: the Kitchen Radio (voice channel). "If you can click it, you can say it." */}
        <aside style={{ width: 392, flexShrink: 0, borderLeft: "3px solid " + INK, height: "100%", overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <KitchenRadio dark={t.dark} live={data.isLive} muted={data.micMuted} reconnecting={data.voiceReconnecting}
              connected={data.voiceConnected} micBlocked={data.micBlocked}
              audioPlaying={data.audioPlaying} approvalWaiting={data.approvalWaiting}
              transcript={data.transcript} voiceCues={t.voiceCues} stations={stations}
              onGoLive={data.goLive} onStopLive={data.stopLive} onToggleMute={data.toggleMute} onCall={handleCall}
              /* hwu.3: a transcript bubble's save icon jots it into The Pass (the concrete pass project),
                 through the operator-direct ungated + server-classified note route. */
              onSaveBubble={(text) => data.saveRadioNote(passProjectId, text)} />
          </div>
          {/* hwu.7: the read-only action panel — a sibling REGION (not a replacement) that re-keys to
              the agent's most recent completed voice tool call (the panel keys its own root by callId,
              so it re-mounts per call). Renders nothing until the first tool completes, so the at-rest
              sidebar (KitchenRadio above, CaptionBar below) is byte-identical to today; when present it
              takes a capped share of height with its own scroll, so it can never cover the mic controls
              or the caption bar. */}
          <ActionPanel frame={data.lastAction} dark={t.dark} />
          {/* bead 8fz.3: caption pop-up — rises from the bottom of this sidebar as its own flex
              row (never an overlay), so it structurally can't cover KitchenRadio's mic controls. */}
          <CaptionBar transcript={data.transcript} live={data.isLive} captionsOn={t.captions} dark={t.dark} />
        </aside>
      </div>
    );
  };

  const renderPantryView = (): ReactNode => {
    if (view !== "pantry") return null;
    return (
      <ThePantry dark={t.dark} projects={projects} stations={stations}
        archived={data.archived}
        serviceLog={data.serviceLog}
        health={data.healthSnapshot}
        summaryOf={(pid) => (data.ledger[pid]?.summary ?? "")}
        selectedProject={selectedProject}
        onUpdateSummary={data.updateProjectSummary}
        onOpenStation={(id) => { data.selectActivePane(id); setBurnerId(id); }}
        onRestoreArchived={data.restoreArchived}
        onDeleteArchived={data.deleteArchived} />
    );
  };

  const renderBohView = (): ReactNode => {
    if (view !== "boh") return null;
    return (
      <BackOfHouse dark={t.dark} settings={data.settings}
        globalMode={data.globalPermissionsMode}
        setGlobalMode={(m) => data.setGlobalMode(m)}
        saveSettings={data.saveSettings}
        /* 2K.2: the Rulebook's pane scope — live panes + their CURRENT override maps (ledger truth). */
        panes={stations.map((s) => ({ id: s.id, name: s.name, project: s.project,
          overrides: data.ledger[s.project]?.panes?.[s.id]?.capabilityGates,
          /* f09.2: server-truth live-window expiry so the Rulebook can show a countdown + End control. */
          autonomy_until: s.autonomy_until }))}
        setPaneGates={data.setPaneGates}
        grantAutonomyWindow={data.grantAutonomyWindow}
        endAutonomyWindow={data.endAutonomyWindow}
        applyPosture={data.applyPosture} />
    );
  };

  const renderModals = (): ReactNode => (
    <>
      {newPaneProj !== null && (
        <NewPaneModal projectId={newPaneProj} projects={projects} dark={t.dark} onClose={() => setNewPaneProj(null)}
          onCreate={(o) => { data.createPane(o); setNewPaneProj(null); if (o.projectId) setSelectedProject(o.projectId); }} />
      )}
      {newProjOpen && (
        <NewProjectModal dark={t.dark} onClose={() => setNewProjOpen(false)}
          onCreate={(o) => { data.createProject(o); setNewProjOpen(false); }} />
      )}
      {burnerStation && (
        <TerminalWindow st={burnerStation} backfill={burnerBackfill} accentHex={acc.hex} dark={t.dark}
          streamGeneration={data.streamGeneration}
          fetchBackfill={() => data.fetchPaneBackfill(burnerStation.id)}
          isMockRef={data.isMockModeRef} wsRef={data.wsRef} voiceCues={t.voiceCues}
          paneNotes={data.notes.filter((n) => n.pane_id === burnerStation.id)}
          incomingDraft={data.paneDrafts[burnerStation.id]}
          incomingHistory={data.paneHistories[burnerStation.id]}
          onAddNote={(text) => data.addNote(burnerStation.project, text, burnerStation.id)}
          onDeleteNote={(id) => data.deleteNote(id, burnerStation.project)}
          onClose={() => setBurnerId(null)} onRestart={() => data.restartPane(burnerStation.id)}
          onStop={() => data.stopPane(burnerStation.project, burnerStation.id)}
          onRename={(name) => data.renamePane(burnerStation.project, burnerStation.id, name)}
          writeControlKey={data.writeControlKey} resizeTerminal={data.resizeTerminal} showToast={data.showToast} />
      )}
    </>
  );

  const renderApprovals = (): ReactNode => (
    // HiTL gating prompts — reuse the shared dialogs verbatim (server-truth posture). Wrapped in a
    // high-z stacking context so a write/action confirm sits above the burner + board modals.
    // 1B.2: only the TOPMOST overlay owns Escape. Actions render before approvals here, so with
    // any approvals mounted the last APPROVAL is DOM-topmost; otherwise the last action is.
    <>
      {data.pendingActions.map((a, i) => (
        <div key={a.actionId} style={{ position: "relative", zIndex: 260 }}>
          <ActionConfirmDialog actionId={a.actionId} capability={a.capability} summary={a.summary}
            posture={a.posture} effectiveGate={a.effective_gate} effectiveMode={a.effective_mode}
            requestedMode={a.requested_mode} globalOverride={a.global_override} paneId={a.pane_id}
            isTop={data.pendingCommands.length === 0 && i === data.pendingActions.length - 1}
            onConfirm={data.confirmAction} onCancel={data.cancelAction} />
        </div>
      ))}
      {data.pendingCommands.map((c, i) => (
        <div key={c.messageId} style={{ position: "relative", zIndex: 260 }}>
          <ApprovalDialog messageId={c.messageId} terminalId={c.terminalId} cmd={c.cmd}
            rationale={c.rationale ? { trigger: c.rationale.trigger ?? "", summary: c.rationale.summary } : undefined}
            posture={c.posture} effectiveGates={c.effective_gates} effectiveMode={c.effective_mode} capability={c.capability}
            isTop={i === data.pendingCommands.length - 1}
            onApprove={data.approveCommand} onReject={data.rejectCommand} />
        </div>
      ))}
    </>
  );

  const renderMascots = (): ReactNode => (
    <>
      <CornerChef show={t.mascot && view === "line" && !panic} chatter={t.mascot} />
      <DanceTroupe show={t.danceParty && view === "line" && !panic} />
    </>
  );

  // NOTE: emergency overlays (panic + frozen-banner) and the toast are kept as SEPARATE render
  // helpers so the final return preserves the original DOM order: …approvals → panic → frozen →
  // mascots → toast. (Folding them into one block would move the mascots; see render order below.)
  const renderEmergencyOverlays = (): ReactNode => (
    <>
      {panic && (
        <EmergencyStop runningCount={data.frozenRunning.length || running} onKill={data.stopAllKill}
          onClose={() => { data.stopAllRelease(); setPanic(false); }} />
      )}
      {data.frozen && !panic && (
        <div data-testid="frozen-banner" onClick={() => setPanic(true)} style={{ position: "fixed", top: 64, left: "50%", transform: "translateX(-50%)", zIndex: 110, background: "#e23a3a", color: "#fff4de", border: "2px solid " + INK, borderRadius: 10, padding: "7px 14px", boxShadow: "3px 3px 0 0 " + INK, fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, cursor: "pointer" }}>
          ❄ Line frozen — Janus paused. Click to manage.
        </div>
      )}
    </>
  );

  const renderToast = (): ReactNode => (
    <>
      {/* 2K.5: role="status" aria-live="polite" so screen readers hear every kitchen ack.
          2K.4: an action-bearing toast (Undo) renders its one-tap action inline. */}
      {data.toast && (
        <div data-testid="toast" role="status" aria-live="polite" className="orb-pop-in" style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 130, display: "flex", alignItems: "center", gap: 12, background: data.toast.kind === "fire" ? "#4db892" : "#ffc94a", color: INK, border: "2px solid " + INK, borderRadius: 12, padding: "10px 18px", boxShadow: "4px 4px 0 0 " + INK, fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 16 }}>
          {data.toast.msg}
          {data.toast.action && (
            <button data-testid="toast-action" onClick={data.toast.action.run}
              style={{ padding: "4px 12px", borderRadius: 8, border: "2px solid " + INK, background: "#fff4de", color: INK, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, boxShadow: "2px 2px 0 0 " + INK, whiteSpace: "nowrap" }}>
              {data.toast.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="orbital-kitchen" style={{ height: "100%", display: "flex", flexDirection: "column", background: pageBg, overflow: "hidden" }}>
      <IconSprite />
      <TopNav accentHex={acc.hex} accentOn={acc.on} view={view} setView={setView} running={running}
        needsCount={needsList.length} onJumpToNeeds={jumpToNeeds}
        mode={serviceId} setMode={(id) => data.setGlobalMode(serviceIdToMode(id))}
        onPanic={() => { data.stopAllFreeze(); setPanic(true); }}
        /* Tuning the radio in REPLACES the observe socket with the voice socket (same broadcast
           lane) — either one being open means the kitchen is genuinely attached. */
        connected={data.streamConnected || data.voiceConnected} convo={convo} daemonState={data.daemonState} />

      {renderLineView()}
      {renderPantryView()}
      {renderBohView()}
      {renderModals()}
      {renderApprovals()}
      {renderEmergencyOverlays()}
      {renderMascots()}
      {renderToast()}

      <TweaksPanel title="Tweaks">
        <TweakSection label="The board" />
        <TweakRadio label="Density" value={t.density} options={["calm", "dense"] as const} onChange={(v) => setTweak("density", v)} />
        <TweakRadio label="Layout" value={t.layout} options={["grid", "rail", "list"] as const} onChange={(v) => setTweak("layout", v)} />
        <TweakToggle label="Dinner-service (dark)" value={t.dark} onChange={(v) => setTweak("dark", v)} />
        <TweakSection label="Flavor" />
        <TweakColor label="House accent" value={acc.hex}
          options={[{ key: "cherry", hex: ACCENTS.cherry.hex }, { key: "blueberry", hex: ACCENTS.blueberry.hex }, { key: "mint", hex: ACCENTS.mint.hex }, { key: "butter", hex: ACCENTS.butter.hex }]}
          onChange={(k) => setTweak("accent", k as Tweaks["accent"])} />
        <TweakToggle label="Chef mascot & chatter" value={t.mascot} onChange={(v) => setTweak("mascot", v)} />
        <TweakSection label="Hands-free" />
        <TweakToggle label="Voice cues" value={t.voiceCues} onChange={(v) => setTweak("voiceCues", v)} />
        <TweakToggle label="Captions" value={t.captions} onChange={(v) => setTweak("captions", v)} />
        <TweakToggle label="Desktop notes" value={t.desktopNotes} onChange={(v) => setTweak("desktopNotes", v)} />
        <TweakToggle label="Chef dance party 🕺" value={t.danceParty} onChange={(v) => setTweak("danceParty", v)} />
      </TweaksPanel>
    </div>
  );
}
