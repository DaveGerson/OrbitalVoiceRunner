// ── ORBITAL · The Pantry (per-project tracker) ─────────────────────────
// The stockroom: a calm, per-project overview — panes, an editable About, and the
// repo. Per the UX brief this surface is CALM: NO mascots, NO scribbles, NO whimsy
// (those are Line-only). Everything wired is real (project summary via PUT
// /api/projects/:id, panes from the live ledger); the git repo card is an honest
// disabled placeholder (no git data on the backend yet).
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { INK } from "../theme";
import { Button, Chip, Icon, Pips, StatusBadge } from "../primitives";
import type { Station, StationProject } from "../station";
import type { ArchivedPane } from "../useOrbitalData";

// 2K.1: one archived pane in the freezer — Restore is one tap (non-destructive), Delete is
// permanent so it takes a two-tap inline confirm (auto-resets after 3s).
function FreezerRow({ a, dark, onRestore, onDelete }: {
  a: ArchivedPane; dark: boolean; onRestore: (paneId: string) => void; onDelete: (paneId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const fg = dark ? "#ffe9c7" : INK;
  return (
    <div data-testid="freezer-pane" data-pane-id={a.pane_id}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, border: "2px solid " + INK, background: dark ? "#1a0f08" : "#fff4de" }}>
      <span style={{ fontSize: 15 }}>🧊</span>
      <span style={{ fontFamily: "JetBrains Mono", fontSize: 11, fontWeight: 700, color: "#8a6a4f", flexShrink: 0 }}>#{a.pane_id}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: "DM Sans", fontWeight: 800, fontSize: 13.5, color: fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name || a.pane_id}</span>
        {a.last_command && <span style={{ display: "block", fontFamily: "JetBrains Mono", fontSize: 10.5, color: "#8a6a4f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.last_command}</span>}
      </span>
      {a.tool_preset && <Chip bg={dark ? "#241409" : "#fff9ec"} color="#8a6a4f">{a.tool_preset}</Chip>}
      <Button testId="freezer-restore" variant="mint" size="sm" icon="play" title="Thaw it — restore this pane to its project" onClick={() => onRestore(a.pane_id)}>Restore</Button>
      <Button testId="freezer-delete" variant={confirming ? "primary" : "default"} size="sm" icon="x"
        title={confirming ? "This is permanent — tap again to toss it" : "Toss it for good (permanent)"}
        onClick={() => {
          if (!confirming) { setConfirming(true); setTimeout(() => setConfirming(false), 3000); return; }
          setConfirming(false);
          onDelete(a.pane_id);
        }}>{confirming ? "Sure, Chef?" : "Delete"}</Button>
    </div>
  );
}

function Card({ dark, children, style = {} }: { dark: boolean; children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: dark ? "#241409" : "#fff9ec", border: "2px solid " + INK, borderRadius: 14, padding: 18, boxShadow: "4px 4px 0 0 " + INK, ...style }}>{children}</div>;
}
function Head({ children, dark }: { children: ReactNode; dark: boolean }) {
  return <div style={{ fontFamily: "DM Sans", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", color: dark ? "#c89f74" : "#5b3a23", marginBottom: 10 }}>{children}</div>;
}

export function ThePantry({ dark, projects, stations, archived, summaryOf, selectedProject, onUpdateSummary, onOpenStation, onRestoreArchived, onDeleteArchived }: {
  dark: boolean;
  projects: StationProject[];
  stations: Station[];
  /** 2K.1: the freezer — archived (recoverable) panes from GET /api/archive. */
  archived: ArchivedPane[];
  summaryOf: (projectId: string) => string;
  selectedProject: string;
  onUpdateSummary: (projectId: string, summary: string) => void;
  onOpenStation: (id: string) => void;
  onRestoreArchived: (paneId: string) => void;
  onDeleteArchived: (paneId: string) => void;
}) {
  // Derive the shown project each render (never hold stale state): an explicit pick if still valid,
  // else the board's selected project, else the first. Avoids the start-view race where `projects` is
  // empty on first paint (the ledger seeds a tick later).
  const [picked, setPicked] = useState<string | null>(null);
  const pid = picked && projects.some((p) => p.id === picked)
    ? picked
    : (selectedProject !== "all" && projects.some((p) => p.id === selectedProject) ? selectedProject : (projects[0]?.id ?? ""));
  const fg = dark ? "#ffe9c7" : INK;
  const proj = projects.find((p) => p.id === pid);
  const panes = stations.filter((s) => s.project === pid);
  const cooking = panes.filter((s) => s.status === "Running").length;
  const frozen = archived.filter((a) => a.project_id === pid);

  return (
    <div data-testid="pantry" style={{ flex: 1, overflowY: "auto", padding: 24, background: dark ? "#1a0f08" : "var(--cream)", backgroundImage: dark ? "radial-gradient(#3a2415 1px, transparent 1.5px)" : "radial-gradient(#e7cfa0 1px, transparent 1.5px)", backgroundSize: "18px 18px" }}>
      {/* project picker */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        <span style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", color: "#8a6a4f" }}>the pantry —</span>
        {projects.map((p) => {
          const on = p.id === pid;
          return (
            <Fragment key={p.id}>
              <button data-testid={`pantry-project-${p.id}`} aria-pressed={on} onClick={() => setPicked(p.id)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, border: "2px solid " + INK, cursor: "pointer", background: on ? p.color : (dark ? "#241409" : "#fff4de"), color: on ? "#fff4de" : fg, fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, boxShadow: on ? "2px 2px 0 0 " + INK : "none" }}>
                <span>{p.emoji}</span>{p.name}
              </button>
            </Fragment>
          );
        })}
      </div>

      {!proj ? (
        <Card dark={dark}><div style={{ fontFamily: "DM Sans", fontSize: 14, fontWeight: 600, color: "#8a6a4f" }}>No kitchens stocked yet — open one from the Line.</div></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 880 }}>
          {/* banner */}
          <Card dark={dark} style={{ background: proj.color, color: "#fff4de", borderColor: INK }}>
            <div data-testid="pantry-banner" style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ fontSize: 38 }}>{proj.emoji}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "DM Sans", fontSize: 10.5, fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase", opacity: .85 }}>Project</div>
                <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 30, lineHeight: 1, color: "#fff4de" }}>{proj.name}</div>
                <div style={{ fontFamily: "JetBrains Mono", fontSize: 11.5, opacity: .9, marginTop: 4 }}>{proj.cwd} · {panes.length} pane{panes.length === 1 ? "" : "s"} · {cooking} cooking</div>
              </div>
            </div>
          </Card>

          {/* About (editable summary) */}
          <Card dark={dark}>
            <Head dark={dark}>About this project</Head>
            <textarea key={pid} data-testid="pantry-about" defaultValue={summaryOf(pid)} placeholder="What's this kitchen working on? (saved when you click away)"
              onBlur={(e) => { const v = e.target.value; if (v !== summaryOf(pid)) onUpdateSummary(pid, v); }}
              style={{ width: "100%", minHeight: 80, resize: "vertical", padding: 12, border: "2px solid " + INK, borderRadius: 10, background: dark ? "#1a0f08" : "#fff4de", color: fg, fontFamily: "DM Sans", fontSize: 13.5, fontWeight: 600, lineHeight: 1.5, outline: "none", boxSizing: "border-box" }} />
          </Card>

          {/* panes */}
          <Card dark={dark}>
            <Head dark={dark}>Panes &amp; their work</Head>
            {panes.length === 0 ? (
              <div style={{ fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, color: "#8a6a4f" }}>No panes open in this kitchen yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {panes.map((s) => (
                  <Fragment key={s.id}>
                    <button data-testid="pantry-pane" onClick={() => onOpenStation(s.id)}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, border: "2px solid " + INK, background: dark ? "#1a0f08" : "#fff4de", cursor: "pointer", textAlign: "left", width: "100%" }}>
                      <span style={{ fontFamily: "JetBrains Mono", fontSize: 11, fontWeight: 700, color: "#8a6a4f", flexShrink: 0 }}>#{s.id}</span>
                      <StatusBadge status={s.status} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontFamily: "DM Sans", fontWeight: 800, fontSize: 13.5, color: fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                        {s.scribble && <span style={{ display: "block", fontFamily: "JetBrains Mono", fontSize: 10.5, color: "#8a6a4f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.scribble}</span>}
                      </span>
                      <Pips steps={8} done={s.contextPips} color={proj.color} label={s.contextLabel} />
                      <span style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "#8a6a4f", flexShrink: 0 }}>{s.elapsed}</span>
                    </button>
                  </Fragment>
                ))}
              </div>
            )}
          </Card>

          {/* 2K.1: In the freezer — archived (recoverable) panes. Restore brings one back to the
              line; Delete is permanent (two-tap confirm). Driven by GET /api/archive, the same
              feed as the classic app's restore tray. */}
          <Card dark={dark}>
            <Head dark={dark}>In the freezer</Head>
            {frozen.length === 0 ? (
              <div data-testid="freezer-empty" style={{ fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, color: "#8a6a4f" }}>
                Nothing in the freezer — 86'd and cleared stations land here, restorable.
              </div>
            ) : (
              <div data-testid="freezer-list" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {frozen.map((a) => (
                  <Fragment key={a.pane_id}>
                    <FreezerRow a={a} dark={dark} onRestore={onRestoreArchived} onDelete={onDeleteArchived} />
                  </Fragment>
                ))}
              </div>
            )}
          </Card>

          {/* The Repo — honest disabled placeholder (no git data on the backend yet) */}
          <Card dark={dark}>
            <Head dark={dark}>The Repo</Head>
            <div data-testid="pantry-repo-disabled" style={{ opacity: .6, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <Chip bg={dark ? "#1a0f08" : "#fff4de"} color="#8a6a4f"><Icon name="spark" size={11} /> branch — soon</Chip>
              <span style={{ fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, color: "#8a6a4f", flex: 1, minWidth: 180 }}>Git status &amp; commit/push/pull aren't plumbed to the pantry yet.</span>
              <Button variant="default" size="sm" disabled>Commit</Button>
              <Button variant="default" size="sm" disabled>Push</Button>
              <Button variant="default" size="sm" disabled>Pull</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
