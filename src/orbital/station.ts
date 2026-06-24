// ── ORBITAL · the Station view-model ────────────────────────────────────
// One STATION = one pane/terminal, merged from the two real sources the
// backend exposes: GET /api/terminals (Terminal: live status, tool_preset,
// context_size, posture) and GET /api/ledger (Workspace→PaneMeta: name,
// last_command, elapsed_ms, project membership). "Needs Input" is synthesized
// from an open approval for the pane (no such backend enum exists). Chefs are
// decoration (chefForPane). This is the contract every board surface consumes.
import type { PendingCommand, Terminal, Workspace } from "../types";
import { chefForPane, skinForProject, type ChefKey, type StationStatus, type ToolPreset } from "./theme";

export interface Station {
  id: string;
  project: string;          // workspace id ("" if unassigned)
  projectName: string;
  projectColor: string;
  projectEmoji: string;
  name: string;
  status: StationStatus;
  toolPreset: ToolPreset;
  chef: ChefKey;            // decorative
  scribble: string;         // real: last_command
  cwd: string;
  elapsed: string;          // formatted from elapsed_ms
  contextFill: number;      // 0..1 of the context budget
  contextLabel: string;     // e.g. "32k"
  contextPips: number;      // squares filled (0..8)
  outputTail: string[];     // last lines of Terminal.output (the burner peek)
  needsInput: boolean;
  // 2K.2: SERVER truth for the pane's autonomy, rendered visual-only by the posture chip.
  // `posture` is the server-resolved effective posture the terminals payload already carries
  // (Terminal.posture — same field the classic GateChip reads); `mode` is the ledger
  // permissions_mode fallback for older payloads that omit posture.
  posture?: "OPEN" | "GUARDED" | "LOCKED";
  mode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
}

export interface StationProject {
  id: string;
  name: string;
  color: string;
  emoji: string;
  cwd: string;
}

const CONTEXT_BUDGET = 200_000; // tokens — Claude-class window; the fill is relative to this
const PIP_COUNT = 8;

export function formatElapsed(ms?: number): string {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export function formatTokens(n?: number): string {
  if (!n || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

function toStatus(t: Terminal, needsInput: boolean): StationStatus {
  if (needsInput) return "Needs Input";
  if (t.status === "Exited") return "Exited";
  if (t.status === "Idle") return "Idle";
  return "Running";
}

function tail(output: string | undefined, n = 4): string[] {
  if (!output) return [];
  return output.split(/\r?\n/).filter((l) => l.length > 0).slice(-n);
}

/** Find the workspace that owns a pane id. */
function findWorkspace(ledger: Record<string, Workspace>, paneId: string): Workspace | undefined {
  for (const ws of Object.values(ledger)) {
    if (ws.panes && ws.panes[paneId]) return ws;
  }
  return undefined;
}

/** Resolve the workspace/pane context for a terminal id (membership + skin + project id). */
function resolvePaneContext(ledger: Record<string, Workspace>, t: Terminal) {
  const ws = findWorkspace(ledger, t.id);
  const pane = ws?.panes?.[t.id];
  const projId = ws?.id ?? "";
  const skin = skinForProject(projId || t.id);
  return { ws, pane, projId, skin };
}

/** Context-budget derivation: clamped fill, formatted label, and filled pips. */
function deriveContext(ctx: number) {
  const fill = Math.max(0, Math.min(1, ctx / CONTEXT_BUDGET));
  return {
    contextFill: fill,
    contextLabel: `${formatTokens(ctx)} ctx`,
    contextPips: Math.round(fill * PIP_COUNT),
  };
}

/** Project identity columns (name + skin), with the Unassigned fallback. */
function deriveProjectFields(ctx2: ReturnType<typeof resolvePaneContext>) {
  const { ws, projId, skin } = ctx2;
  return {
    project: projId,
    projectName: ws?.name ?? "Unassigned",
    projectColor: skin.color,
    projectEmoji: skin.emoji,
  };
}

// Fallback chains for the coalescing-heavy scalar columns. Each `||`/`??`
// ladder lives in its own tiny pure helper so no single function carries the
// combined branch count — identical results to the original inline expressions.
type PaneCtx = ReturnType<typeof resolvePaneContext>;

const stationName = (t: Terminal, { pane }: PaneCtx): string => pane?.name || t.id;

const stationPreset = (t: Terminal, { pane }: PaneCtx): ToolPreset =>
  (t.tool_preset || pane?.tool_preset || "Custom") as ToolPreset;

const stationScribble = (t: Terminal, { pane }: PaneCtx): string =>
  pane?.last_command || t.command || "";

const stationCwd = (t: Terminal, { ws }: PaneCtx): string => t.cwd || ws?.directory || "~";

const stationMode = (t: Terminal, { pane }: PaneCtx): Station["mode"] =>
  t.permissions_mode ?? pane?.permissions_mode;

/**
 * Fallback-chained scalar fields. Each chain delegates to a single-purpose
 * helper above so this assembler — and buildStation — stay flat.
 */
function deriveFallbackFields(t: Terminal, ctx2: PaneCtx) {
  return {
    name: stationName(t, ctx2),
    toolPreset: stationPreset(t, ctx2),
    scribble: stationScribble(t, ctx2),
    cwd: stationCwd(t, ctx2),
    elapsed: formatElapsed(ctx2.pane?.elapsed_ms),
    mode: stationMode(t, ctx2),
  };
}

/** Shape a single Station from a terminal + its resolved ledger context. */
function buildStation(
  t: Terminal,
  ctx2: ReturnType<typeof resolvePaneContext>,
  needsInput: boolean,
): Station {
  const ctx = t.context_size ?? ctx2.pane?.context_size ?? 0;
  return {
    id: t.id,
    ...deriveProjectFields(ctx2),
    status: toStatus(t, needsInput),
    chef: chefForPane(t.id) as ChefKey,
    ...deriveFallbackFields(t, ctx2),
    ...deriveContext(ctx),
    outputTail: tail(t.output),
    needsInput,
    posture: t.posture,
  };
}

// Urgency ordinal per status — lower = more urgent, so it floats to the top of the line.
// Order (operator brief): Needs Input → Exited → Idle → Running. A pane that needs a human
// (open approval) is loudest; a dead pane is next (it wants clearing); idle is calm; running
// is happy. Any unmapped status sorts last (defensive — never reorders a known status above it).
const URGENCY_ORDER: Record<StationStatus, number> = {
  "Needs Input": 0,
  Exited: 1,
  Idle: 2,
  Running: 3,
};

/** The urgency ordinal for a station status (lower = more urgent). */
export function urgencyRank(status: StationStatus): number {
  return URGENCY_ORDER[status] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Stable, non-mutating urgency sort: pending → exited → idle → running. Ties keep input order
 * (Array.prototype.sort is stable in modern V8/Node), so the memoized board never churns on equal
 * ranks. Returns a new array; the caller's input is untouched.
 */
export function sortStationsByUrgency(stations: Station[]): Station[] {
  return [...stations].sort((a, b) => urgencyRank(a.status) - urgencyRank(b.status));
}

export function deriveStations(
  terminals: Terminal[],
  ledger: Record<string, Workspace>,
  pendingCommands: PendingCommand[],
): Station[] {
  const needsByPane = new Set(pendingCommands.map((c) => c.terminalId));
  const stations = terminals.map((t) =>
    buildStation(t, resolvePaneContext(ledger, t), needsByPane.has(t.id)),
  );
  return sortStationsByUrgency(stations);
}

/** Distinct projects present on the board, in a stable order, with pane/running counts. */
export function deriveProjects(
  stations: Station[],
  ledger: Record<string, Workspace>,
): StationProject[] {
  const seen = new Map<string, StationProject>();
  for (const ws of Object.values(ledger)) {
    const skin = skinForProject(ws.id);
    seen.set(ws.id, { id: ws.id, name: ws.name, color: skin.color, emoji: skin.emoji, cwd: ws.directory });
  }
  // include any project a station references that isn't in the ledger
  for (const st of stations) {
    if (st.project && !seen.has(st.project)) {
      seen.set(st.project, { id: st.project, name: st.projectName, color: st.projectColor, emoji: st.projectEmoji, cwd: "~" });
    }
  }
  return Array.from(seen.values());
}
