// ── ORBITAL KITCHEN — app shell + view router ───────────────────────────
// Wave P0: chrome + routing + tweaks (all genuinely working, client-side).
// Live data, board, burner, radio, settings, the pass land in later waves.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import "./orbital.css";
import { ACCENTS, INK } from "./theme";
import { Icon, IconSprite, Mascot } from "./primitives";
import { TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakColor } from "./TweaksPanel";
import { useTweaks, mergedDefaults, type Tweaks } from "./useTweaks";
import { useOrbitalData } from "./useOrbitalData";
import { deriveProjects, deriveStations } from "./station";
import { Board, ProjectsSidebar } from "./views/Line";
import { ServiceMode } from "./ServiceMode";
import { EmergencyStop } from "./EmergencyStop";
import { KitchenRadio } from "./KitchenRadio";
import { TerminalWindow } from "./TerminalWindow";
import { BackOfHouse } from "./views/BackOfHouse";
import { ThePass } from "./views/Pass";
import { ThePantry } from "./views/Pantry";
import { NewPaneModal, NewProjectModal } from "./modals";
import { ApprovalDialog } from "../components/ApprovalDialog";
import { ActionConfirmDialog } from "../components/ActionConfirmDialog";
import { modeToServiceId, serviceIdToMode, type ServiceModeId } from "./theme";

type View = "line" | "pantry" | "boh";

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

function TopNav({ accentHex, accentOn, view, setView, running, needsCount, onJumpToNeeds, mode, setMode, onPanic }: {
  accentHex: string; accentOn: string; view: View; setView: (v: View) => void; running: number;
  needsCount: number; onJumpToNeeds: () => void;
  mode: ServiceModeId; setMode: (id: ServiceModeId) => void; onPanic: () => void;
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
      <div data-testid="kitchen-status" style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff4de", color: INK, padding: "6px 12px", borderRadius: 999, border: "2px solid " + INK, boxShadow: "2px 2px 0 0 " + INK, flexShrink: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#4db892", border: "1.5px solid " + INK }} />
        <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, whiteSpace: "nowrap" }}>Kitchen open · {running} on the burner</span>
      </div>
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
  const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const [t, setTweak] = useTweaks(mergedDefaults());
  const acc = ACCENTS[t.accent] || ACCENTS.cherry;
  const startView = (["boh", "pantry"].includes(params.get("view") || "") ? params.get("view") : "line") as View;
  const [view, setView] = useState<View>(startView);
  const [selectedProject, setSelectedProject] = useState<string>(params.get("project") || "all");
  const [panic, setPanic] = useState(false);
  const [newPaneProj, setNewPaneProj] = useState<string | null>(null);
  const [newProjOpen, setNewProjOpen] = useState(false);
  const [burnerId, setBurnerId] = useState<string | null>(null);
  const pageBg: CSSProperties["background"] = t.dark ? "#1a0f08" : "var(--cream)";

  const data = useOrbitalData({ voiceCues: t.voiceCues });
  const stations = useMemo(
    () => deriveStations(data.terminals, data.ledger, data.pendingCommands),
    [data.terminals, data.ledger, data.pendingCommands],
  );
  const projects = useMemo(() => deriveProjects(stations, data.ledger), [stations, data.ledger]);
  const running = stations.filter((s) => s.status === "Running").length;
  const needsList = stations.filter((s) => s.status === "Needs Input");
  const jumpToNeeds = () => { const f = needsList[0]; if (f) { data.selectActivePane(f.id); setBurnerId(f.id); } };
  const serviceId = modeToServiceId(data.globalPermissionsMode === "Inherit" ? "Human-in-the-Loop" : data.globalPermissionsMode);

  // The Burner: the station whose live terminal is open. Resolved from the live board so it tracks
  // status; if the pane disappears (closed/archived) the modal self-closes on the next render.
  const burnerStation = burnerId ? stations.find((s) => s.id === burnerId) : undefined;
  const burnerBackfill = burnerId ? data.terminals.find((t) => t.id === burnerId)?.backfill : undefined;
  useEffect(() => {
    if (burnerId && stations.length > 0 && !stations.some((s) => s.id === burnerId)) setBurnerId(null);
  }, [burnerId, stations]);

  // The Pass jots into one concrete project: the selected one, else the active station's, else the first.
  const passProjectId = selectedProject !== "all"
    ? selectedProject
    : (stations.find((s) => s.id === data.activeTerminalId)?.project || projects[0]?.id || null);
  const passProjectName = projects.find((p) => p.id === passProjectId)?.name || "a kitchen";
  // Keep The Pass's tickets fresh for the in-view project(s): the selected one, or all when unfiltered.
  const projectIdsKey = projects.map((p) => p.id).join(",");
  const refetchNotes = data.refetchNotes;
  useEffect(() => {
    const ids = selectedProject !== "all" ? [selectedProject] : projectIdsKey.split(",").filter(Boolean);
    if (ids.length) refetchNotes(ids);
  }, [selectedProject, projectIdsKey, refetchNotes]);

  return (
    <div className="orbital-kitchen" style={{ height: "100%", display: "flex", flexDirection: "column", background: pageBg, overflow: "hidden" }}>
      <IconSprite />
      <TopNav accentHex={acc.hex} accentOn={acc.on} view={view} setView={setView} running={running}
        needsCount={needsList.length} onJumpToNeeds={jumpToNeeds}
        mode={serviceId} setMode={(id) => data.setGlobalMode(serviceIdToMode(id))}
        onPanic={() => { data.stopAllFreeze(); setPanic(true); }} />

      {view === "line" && (
        <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
          <ProjectsSidebar stations={stations} projects={projects} selected={selectedProject} setSelected={setSelectedProject} dark={t.dark} onNewProject={() => setNewProjOpen(true)} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, minWidth: 0, backgroundImage: t.dark ? "radial-gradient(#3a2415 1px, transparent 1.5px)" : "radial-gradient(#e7cfa0 1px, transparent 1.5px)", backgroundSize: "18px 18px" }}>
            <ThePass notes={data.notes} jotProjectId={passProjectId} jotProjectName={passProjectName} dark={t.dark} voiceCues={t.voiceCues}
              onAdd={(pid, text) => data.addNote(pid, text)} onEdit={(id, text) => data.editNote(id, text, passProjectId ?? undefined)} onDelete={(id) => data.deleteNote(id, passProjectId ?? undefined)}
              onFirePane={(pid) => { setSelectedProject(pid); setNewPaneProj(pid); }} onJumpToPane={(id) => { data.selectActivePane(id); setBurnerId(id); }} />
            <Board stations={stations} projects={projects} dark={t.dark} density={t.density} layout={t.layout} onOpen={(st) => { data.selectActivePane(st.id); setBurnerId(st.id); }} showCue={t.voiceCues} activeId={data.activeTerminalId} selectedProject={selectedProject} onNewPane={(pid) => setNewPaneProj(pid)} />
          </div>
          {/* action-right: the Kitchen Radio (voice channel). "If you can click it, you can say it." */}
          <aside style={{ width: 392, flexShrink: 0, borderLeft: "3px solid " + INK, height: "100%", overflow: "hidden", minHeight: 0 }}>
            <KitchenRadio dark={t.dark} live={data.isLive} muted={data.micMuted} reconnecting={data.voiceReconnecting}
              transcript={data.transcript} voiceCues={t.voiceCues} stations={stations}
              onGoLive={data.goLive} onToggleMute={data.toggleMute}
              onCall={(phrase) => data.showToast(`🎙 "${phrase}" — heard, Chef!`)} />
          </aside>
        </div>
      )}
      {view === "pantry" && (
        <ThePantry dark={t.dark} projects={projects} stations={stations}
          summaryOf={(pid) => (data.ledger[pid]?.summary ?? "")}
          selectedProject={selectedProject}
          onUpdateSummary={data.updateProjectSummary}
          onOpenStation={(id) => { data.selectActivePane(id); setBurnerId(id); }} />
      )}
      {view === "boh" && (
        <BackOfHouse dark={t.dark} settings={data.settings}
          globalMode={data.globalPermissionsMode}
          setGlobalMode={(m) => data.setGlobalMode(m)}
          saveSettings={data.saveSettings} />
      )}

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
          isMockRef={data.isMockModeRef} wsRef={data.wsRef} voiceCues={t.voiceCues}
          paneNotes={data.notes.filter((n) => n.pane_id === burnerStation.id)}
          onAddNote={(text) => data.addNote(burnerStation.project, text, burnerStation.id)}
          onDeleteNote={(id) => data.deleteNote(id, burnerStation.project)}
          onClose={() => setBurnerId(null)} onRestart={() => data.restartPane(burnerStation.id)}
          writeControlKey={data.writeControlKey} resizeTerminal={data.resizeTerminal} showToast={data.showToast} />
      )}
      {/* HiTL gating prompts — reuse the shared dialogs verbatim (server-truth posture). Wrapped in a
          high-z stacking context so a write/action confirm sits above the burner + board modals. */}
      {data.pendingActions.map((a) => (
        <div key={a.actionId} style={{ position: "relative", zIndex: 260 }}>
          <ActionConfirmDialog actionId={a.actionId} capability={a.capability} summary={a.summary}
            posture={a.posture} effectiveGate={a.effective_gate} effectiveMode={a.effective_mode}
            requestedMode={a.requested_mode} globalOverride={a.global_override} paneId={a.pane_id}
            onConfirm={data.confirmAction} onCancel={data.cancelAction} />
        </div>
      ))}
      {data.pendingCommands.map((c) => (
        <div key={c.messageId} style={{ position: "relative", zIndex: 260 }}>
          <ApprovalDialog messageId={c.messageId} terminalId={c.terminalId} cmd={c.cmd}
            rationale={c.rationale ? { trigger: c.rationale.trigger ?? "", summary: c.rationale.summary } : undefined}
            posture={c.posture} effectiveGates={c.effective_gates} effectiveMode={c.effective_mode} capability={c.capability}
            onApprove={data.approveCommand} onReject={data.rejectCommand} />
        </div>
      ))}

      {panic && (
        <EmergencyStop runningCount={data.frozenRunning.length || running} onKill={data.stopAllKill}
          onClose={() => { data.stopAllRelease(); setPanic(false); }} />
      )}

      {data.frozen && !panic && (
        <div data-testid="frozen-banner" onClick={() => setPanic(true)} style={{ position: "fixed", top: 64, left: "50%", transform: "translateX(-50%)", zIndex: 110, background: "#e23a3a", color: "#fff4de", border: "2px solid " + INK, borderRadius: 10, padding: "7px 14px", boxShadow: "3px 3px 0 0 " + INK, fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, cursor: "pointer" }}>
          ❄ Line frozen — Janus paused. Click to manage.
        </div>
      )}

      <CornerChef show={t.mascot && view === "line" && !panic} chatter={t.mascot} />
      <DanceTroupe show={t.danceParty && view === "line" && !panic} />

      {data.toast && (
        <div data-testid="toast" className="orb-pop-in" style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 130, background: data.toast.kind === "fire" ? "#4db892" : "#ffc94a", color: INK, border: "2px solid " + INK, borderRadius: 12, padding: "10px 18px", boxShadow: "4px 4px 0 0 " + INK, fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 16 }}>
          {data.toast.msg}
        </div>
      )}

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
        <TweakToggle label="Chef dance party 🕺" value={t.danceParty} onChange={(v) => setTweak("danceParty", v)} />
      </TweaksPanel>
    </div>
  );
}
