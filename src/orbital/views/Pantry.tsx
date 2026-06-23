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
import type { ArchivedPane, HealthSnapshot, ServiceLogRow } from "../useOrbitalData";

// 4U.3: pull a pane id out of the redacted-args JSON (best-effort, presentation only) so a
// service-log row can say WHERE it happened. The action log has no pane column; the args do.

/** Try to read a pane-id field from one already-parsed args object. */
export function extractPaneIdFromArgs(a: unknown): string | null {
  if (!a || typeof a !== "object") return null;
  const obj = a as Record<string, unknown>;
  const v = obj["pane_id"] ?? obj["paneId"] ?? obj["terminalId"] ?? obj["terminal_id"];
  return typeof v === "string" && v ? v : null;
}

/** Parse args_redacted JSON and extract a pane id (best-effort). */
export function paneOf(row: ServiceLogRow): string | null {
  if (!row.args_redacted) return null;
  try {
    return extractPaneIdFromArgs(JSON.parse(row.args_redacted));
  } catch { return null; }
}

function logTime(ts: number): string {
  try { return new Date(ts).toLocaleTimeString(); } catch { return String(ts); }
}

/** Map a result_kind string to its badge colours. */
export function kindSkinFor(kind: string): { bg: string; fg: string } {
  if (kind === "error") return { bg: "#e23a3a", fg: "#fff4de" };
  if (kind === "blocked") return { bg: "#ff8a3d", fg: INK };
  if (kind === "pending") return { bg: "#ffc94a", fg: INK };
  return { bg: "#4db892", fg: INK };
}

/** Derive the display label for a log row (name → capability → fallback). */
export function resolveLogLabel(r: ServiceLogRow): string {
  return r.name || r.capability || "—";
}

// One calm service-log row: time · what ran · where · how it went. All server truth
// (GET /api/action-log — runAction's durable audit), newest-first.
function ServiceLogLine({ r, dark }: { r: ServiceLogRow; dark: boolean }) {
  const fg = dark ? "#ffe9c7" : INK;
  const kind = (r.result_kind || "ok").toLowerCase();
  const kindSkin = kindSkinFor(kind);
  const pane = paneOf(r);
  const msSuffix = typeof r.ms === "number"
    ? <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f", flexShrink: 0 }}>{r.ms < 1 ? "<1" : Math.round(r.ms)}ms</span>
    : null;
  return (
    <div data-testid="service-log-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 9, border: "1.5px solid " + INK, background: dark ? "#1a0f08" : "#fff4de" }}>
      <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f", flexShrink: 0, width: 72 }}>{logTime(r.ts)}</span>
      <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, fontWeight: 700, color: fg, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {resolveLogLabel(r)}{pane ? <span style={{ color: "#8a6a4f", fontWeight: 600 }}> · #{pane}</span> : null}
      </span>
      {r.surface && <Chip bg={dark ? "#241409" : "#fff9ec"} color="#8a6a4f">{r.surface}</Chip>}
      <Chip bg={kindSkin.bg} color={kindSkin.fg}>{kind}</Chip>
      {msSuffix}
    </div>
  );
}

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
      <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, fontWeight: 700, color: "#8a6a4f", flexShrink: 0 }}>#{a.pane_id}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: "DM Sans", fontWeight: 800, fontSize: 13.5, color: fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name || a.pane_id}</span>
        {a.last_command && <span style={{ display: "block", fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.last_command}</span>}
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
  return <div style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", color: dark ? "#c89f74" : "#5b3a23", marginBottom: 10 }}>{children}</div>;
}

// bead apu: render the recent-action error rate as a whole-percent chip ("7%"). Clamps the 0–1
// fraction the handler emits; a degenerate/NaN value reads "0%" rather than blank or "NaN%".
export function fmtErrorRate(rate: number): string {
  const r = typeof rate === "number" && Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0;
  return `${Math.round(r * 100)}%`;
}

// bead apu: the health strip's per-chip skin decisions, pulled out of the component so the JSX stays
// straight-line (within the complexity gate) and the colour/label logic is unit-testable. Frozen is
// loud (the brake), a non-zero error rate warms, pending approvals warm, otherwise everything's steady.
export function healthChipSkins(health: HealthSnapshot, dark: boolean) {
  const steady = dark ? "#241409" : "#fff9ec";
  const pending = health.pending_approvals > 0;
  const errored = health.recent.error_rate > 0;
  return {
    steady,
    frozen: {
      bg: health.frozen ? "#e23a3a" : "#4db892",
      color: health.frozen ? "#fff4de" : INK,
      label: health.frozen ? "frozen — brake on" : "running free",
    },
    pending: { bg: pending ? "#ffc94a" : steady, color: pending ? INK : "#8a6a4f" },
    errors: { bg: errored ? "#ff8a3d" : steady, color: errored ? INK : "#8a6a4f" },
  };
}

// bead apu: the health strip — a calm, one-glance observability row at the top of the Pantry.
// All server truth from GET /api/health (src/actions/defs/observability.ts getHealth).
function HealthStrip({ health, dark }: { health: HealthSnapshot; dark: boolean }) {
  const fg = dark ? "#ffe9c7" : INK;
  const p = health.panes;
  const skin = healthChipSkins(health, dark);
  return (
    <Card dark={dark}>
      <Head dark={dark}>Health — the kitchen at a glance</Head>
      <div data-testid="health-strip" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span data-testid="health-frozen" style={{ display: "inline-flex" }}>
          <Chip bg={skin.frozen.bg} color={skin.frozen.color}>{skin.frozen.label}</Chip>
        </span>
        <span data-testid="health-panes" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 700, color: fg }}>
          <Chip bg={skin.steady} color="#8a6a4f">{p.total} pane{p.total === 1 ? "" : "s"}</Chip>
          <Chip bg={skin.steady} color="#8a6a4f">{p.running} running</Chip>
          <Chip bg={skin.steady} color="#8a6a4f">{p.idle} idle</Chip>
          <Chip bg={skin.steady} color="#8a6a4f">{p.exited} exited</Chip>
        </span>
        <span data-testid="health-pending" style={{ display: "inline-flex" }}>
          <Chip bg={skin.pending.bg} color={skin.pending.color}>{health.pending_approvals} at the pass</Chip>
        </span>
        <span data-testid="health-error-rate" style={{ display: "inline-flex" }}>
          <Chip bg={skin.errors.bg} color={skin.errors.color}>{fmtErrorRate(health.recent.error_rate)} errors</Chip>
        </span>
      </div>
    </Card>
  );
}

/**
 * Resolve which project id to display. Uses an explicit pick when still valid,
 * else the board's selected project, else the first available project.
 */
export function resolvePid(
  picked: string | null,
  selectedProject: string,
  projects: StationProject[],
): string {
  if (picked && projects.some((p) => p.id === picked)) return picked;
  if (selectedProject !== "all" && projects.some((p) => p.id === selectedProject)) return selectedProject;
  return projects[0]?.id ?? "";
}

export function ThePantry({ dark, projects, stations, archived, serviceLog, health, summaryOf, selectedProject, onUpdateSummary, onOpenStation, onRestoreArchived, onDeleteArchived }: {
  dark: boolean;
  projects: StationProject[];
  stations: Station[];
  /** 2K.1: the freezer — archived (recoverable) panes from GET /api/archive. */
  archived: ArchivedPane[];
  /** 4U.3: the service log — recent action-log rows (GET /api/action-log), newest-first. */
  serviceLog: ServiceLogRow[];
  /** bead apu: the one-glance health snapshot (GET /api/health); null until the first fetch lands. */
  health: HealthSnapshot | null;
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
  const pid = resolvePid(picked, selectedProject, projects);
  const fg = dark ? "#ffe9c7" : INK;
  const proj = projects.find((p) => p.id === pid);
  const panes = stations.filter((s) => s.project === pid);
  const cooking = panes.filter((s) => s.status === "Running").length;
  const frozen = archived.filter((a) => a.project_id === pid);

  function renderPanesCard(): ReactNode {
    const body = panes.length === 0
      ? <div style={{ fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, color: "#8a6a4f" }}>No panes open in this kitchen yet.</div>
      : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {panes.map((s) => (
            <Fragment key={s.id}>
              <button data-testid="pantry-pane" onClick={() => onOpenStation(s.id)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, border: "2px solid " + INK, background: dark ? "#1a0f08" : "#fff4de", cursor: "pointer", textAlign: "left", width: "100%" }}>
                <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, fontWeight: 700, color: "#8a6a4f", flexShrink: 0 }}>#{s.id}</span>
                <StatusBadge status={s.status} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontFamily: "DM Sans", fontWeight: 800, fontSize: 13.5, color: fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                  {s.scribble && <span style={{ display: "block", fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.scribble}</span>}
                </span>
                <Pips steps={8} done={s.contextPips} color={proj!.color} label={s.contextLabel} />
                <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f", flexShrink: 0 }}>{s.elapsed}</span>
              </button>
            </Fragment>
          ))}
        </div>
      );
    return <Card dark={dark}><Head dark={dark}>Panes &amp; their work</Head>{body}</Card>;
  }

  function renderFreezerCard(): ReactNode {
    const body = frozen.length === 0
      ? (
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
      );
    return (
      /* 2K.1: In the freezer — archived (recoverable) panes. Restore brings one back to the
         line; Delete is permanent (two-tap confirm). Driven by GET /api/archive, the same
         feed as the classic app's restore tray. */
      <Card dark={dark}><Head dark={dark}>In the freezer</Head>{body}</Card>
    );
  }

  function renderServiceLog(): ReactNode {
    const body = serviceLog.length === 0
      ? (
        <div data-testid="service-log-empty" style={{ fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, color: "#8a6a4f" }}>
          Nothing on the record yet — actions land here as they run.
        </div>
      ) : (
        <div data-testid="service-log" style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 380, overflowY: "auto" }}>
          {serviceLog.slice(0, 100).map((r) => (
            <Fragment key={r.id}><ServiceLogLine r={r} dark={dark} /></Fragment>
          ))}
        </div>
      );
    return (
      /* 4U.3: the Service log — the kitchen's reviewable past, straight off the durable action
         log (GET /api/action-log). Global (not per-project) and CALM, per the pantry's brief.
         Capped at 100 rows (the fetch asks for limit=100; rows arrive newest-first). */
      <div style={{ maxWidth: 880, marginTop: 16 }}>
        <Card dark={dark}>
          <Head dark={dark}>Service log — what the kitchen's done lately</Head>
          {body}
        </Card>
      </div>
    );
  }

  return (
    <div data-testid="pantry" style={{ flex: 1, overflowY: "auto", padding: 24, background: dark ? "#1a0f08" : "var(--cream)", backgroundImage: dark ? "radial-gradient(#3a2415 1px, transparent 1.5px)" : "radial-gradient(#e7cfa0 1px, transparent 1.5px)", backgroundSize: "18px 18px" }}>
      {/* bead apu: the health strip — global observability (GET /api/health), above the picker */}
      {health && (
        <div style={{ maxWidth: 880, marginBottom: 18 }}>
          <HealthStrip health={health} dark={dark} />
        </div>
      )}

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
                <div style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase", opacity: .85 }}>Project</div>
                <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 30, lineHeight: 1, color: "#fff4de" }}>{proj.name}</div>
                <div style={{ fontFamily: "JetBrains Mono", fontSize: 12, opacity: .9, marginTop: 4 }}>{proj.cwd} · {panes.length} pane{panes.length === 1 ? "" : "s"} · {cooking} cooking</div>
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
          {renderPanesCard()}

          {/* 2K.1: In the freezer */}
          {renderFreezerCard()}

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

      {/* 4U.3: the Service log */}
      {renderServiceLog()}
    </div>
  );
}
