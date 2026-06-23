// ── ORBITAL · The Line ──────────────────────────────────────────────────
// The board of stations (panes), grouped by project (grid/list) or by status
// (rail). Faithful port of the shell's Board/ProjectsSidebar, fed by live data.
import { Fragment } from "react";
import { INK } from "../theme";
import { Button, Icon } from "../primitives";
import { StationCard } from "../StationCard";
import { TILTS } from "../theme";
import type { Station, StationProject } from "../station";
import type { Tweaks } from "../useTweaks";
import type { StoredHandoff } from "../../store/types";

// j4e1: the handoff line-drawer wiring, threaded Board → sections → StationCard. `byPane` maps a
// station id (to_pane) to the handoffs bound to it; the callbacks fire the canonical REST twins.
// One bundle keeps the prop chain minimal and the existing Board/StationCard contract unchanged
// (everything here is optional — omit it and the drawer simply never renders).
export interface HandoffWiring {
  byPane: Record<string, StoredHandoff[]>;
  onDeliver: (id: string) => void;
  onRevise: (id: string, text: string) => void;
  onStage: (id: string) => void;
  onReject: (id: string) => void;
  onFetchPrompt: (id: string) => Promise<string | null>;
}

/** Spread the per-station handoff props onto a StationCard from the wiring bundle (or nothing). */
function handoffCardProps(wiring: HandoffWiring | undefined, paneId: string) {
  if (!wiring) return {};
  return {
    handoffs: wiring.byPane[paneId] ?? [],
    onDeliverHandoff: wiring.onDeliver,
    onReviseHandoff: wiring.onRevise,
    onStageHandoff: wiring.onStage,
    onRejectHandoff: wiring.onReject,
    onFetchHandoffPrompt: wiring.onFetchPrompt,
  };
}

const RAIL_COLS = [
  { status: "Running" as const, label: "On the burner", emoji: "🔥", color: "#ffc94a" },
  { status: "Needs Input" as const, label: "Ding! needs you", emoji: "🛎", color: "#ff8a3d" },
  { status: "Idle" as const, label: "Resting", emoji: "😴", color: "#d4a15a" },
  { status: "Exited" as const, label: "Off the line", emoji: "🧊", color: "#8a6a4f" },
];

function Empty({ msg }: { msg: string }) {
  return <div style={{ padding: 18, textAlign: "center", border: "2px dashed #c9a97a", borderRadius: 10, fontFamily: "Caveat, cursive", fontSize: 17, color: "#8a6a4f" }}>{msg}</div>;
}

function PaneList({ items, dark, compact, layout, onOpen, showCue, activeId, handoffs }: {
  items: Station[]; dark: boolean; compact: boolean; layout: Tweaks["layout"];
  onOpen: (st: Station) => void; showCue: boolean; activeId: string | null; handoffs?: HandoffWiring;
}) {
  if (items.length === 0) return <Empty msg="nothin' cookin' here 😴" />;
  if (layout === "list") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((st) => <Fragment key={st.id}><StationCard st={st} accentHex={st.projectColor} dark={dark} compact={compact} tilt={0} onOpen={() => onOpen(st)} layout="list" showCue={showCue} active={st.id === activeId} {...handoffCardProps(handoffs, st.id)} /></Fragment>)}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(auto-fill, minmax(248px, 1fr))" : "repeat(auto-fill, minmax(290px, 1fr))", gap: compact ? 13 : 18 }}>
      {items.map((st, i) => <Fragment key={st.id}><StationCard st={st} accentHex={st.projectColor} dark={dark} compact={compact} tilt={TILTS[i % TILTS.length]} onOpen={() => onOpen(st)} layout="grid" showCue={showCue} active={st.id === activeId} {...handoffCardProps(handoffs, st.id)} /></Fragment>)}
    </div>
  );
}

function ProjectSection({ proj, items, dark, compact, layout, onOpen, showCue, activeId, onNewPane, handoffs }: {
  proj: StationProject; items: Station[]; dark: boolean; compact: boolean; layout: Tweaks["layout"];
  onOpen: (st: Station) => void; showCue: boolean; activeId: string | null; onNewPane?: (projectId: string) => void;
  handoffs?: HandoffWiring;
}) {
  const running = items.filter((s) => s.status === "Running").length;
  return (
    <section style={{ marginBottom: 26 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", marginBottom: 14, background: proj.color, border: "2px solid " + INK, borderRadius: 12, boxShadow: "4px 4px 0 0 " + INK, color: "#fff4de" }}>
        <span style={{ fontSize: 24 }}>{proj.emoji}</span>
        <div style={{ lineHeight: 1.05 }}>
          <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 21, letterSpacing: "-.01em" }}>{proj.name}</div>
          <div style={{ fontFamily: "JetBrains Mono", fontSize: 10.5, opacity: .85, marginTop: 1 }}>{proj.cwd}</div>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 999, background: "#2a1a10", color: "#fff4de", fontFamily: "DM Sans", fontWeight: 800, fontSize: 11 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: running ? "#9be3c0" : "#8a6a4f" }} />{running} running · {items.length} panes
        </span>
        <button onClick={() => onNewPane?.(proj.id)} disabled={!onNewPane} title="Open a new pane in this project" style={{
          display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 8, border: "2px solid " + INK,
          background: "#fff4de", color: INK, cursor: onNewPane ? "pointer" : "not-allowed", opacity: onNewPane ? 1 : 0.5,
          fontFamily: "DM Sans", fontWeight: 800, fontSize: 11.5, boxShadow: "2px 2px 0 0 " + INK,
        }}><Icon name="plus" size={13} /> Pane</button>
      </div>
      <PaneList items={items} dark={dark} compact={compact} layout={layout} onOpen={onOpen} showCue={showCue} activeId={activeId} handoffs={handoffs} />
    </section>
  );
}

// 2K.1: the "Clear exited" affordance — appears only while a station on the board is actually
// Exited, archives them (recoverable) via the same clear-exited route the classic app uses.
// One-tap (the operation is non-destructive: panes land in the Pantry's freezer, restorable).
function ClearExitedChip({ count, onClear }: { count: number; onClear?: () => void }) {
  if (count === 0 || !onClear) return null;
  return (
    <button data-testid="clear-exited" onClick={onClear}
      title="Archive every exited station into the freezer (recoverable from the Pantry)"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 999,
        border: "2px solid " + INK, background: "#8a6a4f", color: "#fff4de", cursor: "pointer",
        fontFamily: "DM Sans", fontWeight: 800, fontSize: 11.5, whiteSpace: "nowrap", boxShadow: "2px 2px 0 0 " + INK,
      }}>
      🧊 Clear exited · {count}
    </button>
  );
}

export function Board({ stations, projects, dark, density, layout, onOpen, showCue, activeId, selectedProject, onNewPane, onClearExited, handoffs }: {
  stations: Station[]; projects: StationProject[]; dark: boolean; density: Tweaks["density"]; layout: Tweaks["layout"];
  onOpen: (st: Station) => void; showCue: boolean; activeId: string | null; selectedProject: string; onNewPane?: (projectId: string) => void;
  /** 2K.1: archive all Exited panes (POST /api/terminals/clear-exited). */
  onClearExited?: () => void;
  /** j4e1: the per-station handoff line-drawer wiring (handoffs by to_pane + deliver/revise/reject). */
  handoffs?: HandoffWiring;
}) {
  const compact = density === "dense";
  const scope = selectedProject === "all" ? stations : stations.filter((s) => s.project === selectedProject);
  const exitedCount = scope.filter((s) => s.status === "Exited").length;

  if (layout === "rail") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {exitedCount > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 20px 0" }}>
            <ClearExitedChip count={exitedCount} onClear={onClearExited} />
          </div>
        )}
        <div style={{ flex: 1, display: "flex", gap: 14, padding: "18px 20px", overflow: "auto" }}>
        {RAIL_COLS.map((col) => {
          const items = scope.filter((s) => s.status === col.status);
          return (
            <section key={col.status} style={{ flex: 1, minWidth: 250, display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "9px 13px", marginBottom: 12, background: col.color, border: "2px solid " + INK, borderRadius: 10, boxShadow: "3px 3px 0 0 " + INK, transform: "rotate(-.5deg)", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>{col.emoji}</span>
                <span style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 16, color: INK }}>{col.label}</span>
                <div style={{ flex: 1 }} />
                <span style={{ width: 24, height: 24, borderRadius: "50%", background: INK, color: "#fff4de", display: "grid", placeItems: "center", fontFamily: "Fraunces", fontWeight: 900, fontSize: 12 }}>{items.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {items.map((st, i) => <Fragment key={st.id}><StationCard st={st} accentHex={st.projectColor} dark={dark} compact={compact} tilt={TILTS[i % TILTS.length]} onOpen={() => onOpen(st)} layout="grid" showCue={showCue} active={st.id === activeId} {...handoffCardProps(handoffs, st.id)} /></Fragment>)}
                {items.length === 0 && <Empty msg="nothin' here 😴" />}
              </div>
            </section>
          );
        })}
        </div>
      </div>
    );
  }

  const groups = projects.map((p) => ({ p, items: scope.filter((s) => s.project === p.id) })).filter((g) => g.items.length);
  return (
    <div style={{ flex: 1, overflow: "auto", padding: "20px", maxWidth: layout === "list" ? 960 : 1280, margin: "0 auto", width: "100%" }}>
      {exitedCount > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
          <ClearExitedChip count={exitedCount} onClear={onClearExited} />
        </div>
      )}
      {groups.length === 0 && <Empty msg="the line's quiet — fire up a pane to start cookin' 🍳" />}
      {groups.map((g) => <Fragment key={g.p.id}><ProjectSection proj={g.p} items={g.items} dark={dark} compact={compact} layout={layout} onOpen={onOpen} showCue={showCue} activeId={activeId} onNewPane={onNewPane} handoffs={handoffs} /></Fragment>)}
    </div>
  );
}

export function ProjectsSidebar({ stations, projects, selected, setSelected, dark, onNewProject }: {
  stations: Station[]; projects: StationProject[]; selected: string; setSelected: (id: string) => void;
  dark: boolean; onNewProject?: () => void;
}) {
  const fg = dark ? "#ffe9c7" : INK;
  const panelBg = dark ? "#241409" : "#fff9ec";
  const totalRunning = stations.filter((s) => s.status === "Running").length;
  const rows = [{ id: "all", name: "All kitchens", emoji: "🍽", color: "#2a1a10", cwd: "everything", panes: stations.length }]
    .concat(projects.map((p) => ({ ...p, panes: stations.filter((s) => s.project === p.id).length })));
  return (
    <aside style={{ width: 234, flexShrink: 0, borderRight: "3px solid " + INK, background: panelBg, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "12px 14px", borderBottom: "2px solid " + INK, display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 16 }}>📂</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 17, color: fg, lineHeight: 1 }}>Projects</div>
          <div style={{ fontFamily: "Caveat, cursive", fontSize: 13.5, color: "#8a6a4f" }}>{totalRunning} cooking across {projects.length} kitchens</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 7 }}>
        {rows.map((p) => {
          const on = selected === p.id;
          const running = p.id === "all" ? totalRunning : stations.filter((s) => s.project === p.id && s.status === "Running").length;
          const needs = p.id === "all" ? stations.some((s) => s.status === "Needs Input") : stations.some((s) => s.project === p.id && s.status === "Needs Input");
          return (
            <button key={p.id} data-testid={`project-row-${p.id}`} onClick={() => setSelected(p.id)} style={{
              textAlign: "left", padding: "9px 11px", borderRadius: 10, border: "2px solid " + INK, cursor: "pointer",
              background: on ? p.color : dark ? "#2f1d12" : "#fff4de", color: on ? "#fff4de" : fg,
              boxShadow: on ? "3px 3px 0 0 " + INK : "none", transform: on ? "translate(-1px,-1px)" : "none",
              transition: "all 140ms var(--ease-bounce)", display: "flex", alignItems: "center", gap: 9,
            }}>
              <span style={{ fontSize: 17 }}>{p.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                <div style={{ fontFamily: "JetBrains Mono", fontSize: 9.5, opacity: .8 }}>{p.panes} panes · {running} running</div>
              </div>
              {needs && <span style={{ fontSize: 12 }}>🛎</span>}
            </button>
          );
        })}
      </div>
      <div style={{ padding: 10, borderTop: "2px solid " + INK, flexShrink: 0 }}>
        <Button variant="butter" size="sm" icon="plus" style={{ width: "100%", justifyContent: "center" }} onClick={onNewProject} disabled={!onNewProject}>New project</Button>
      </div>
    </aside>
  );
}
