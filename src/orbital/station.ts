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

export function deriveStations(
  terminals: Terminal[],
  ledger: Record<string, Workspace>,
  pendingCommands: PendingCommand[],
): Station[] {
  const needsByPane = new Set(pendingCommands.map((c) => c.terminalId));
  return terminals.map((t) => {
    const ws = findWorkspace(ledger, t.id);
    const pane = ws?.panes?.[t.id];
    const projId = ws?.id ?? "";
    const skin = skinForProject(projId || t.id);
    const ctx = t.context_size ?? pane?.context_size ?? 0;
    const fill = Math.max(0, Math.min(1, ctx / CONTEXT_BUDGET));
    const needsInput = needsByPane.has(t.id);
    return {
      id: t.id,
      project: projId,
      projectName: ws?.name ?? "Unassigned",
      projectColor: skin.color,
      projectEmoji: skin.emoji,
      name: pane?.name || t.id,
      status: toStatus(t, needsInput),
      toolPreset: (t.tool_preset || pane?.tool_preset || "Custom") as ToolPreset,
      chef: chefForPane(t.id) as ChefKey,
      scribble: pane?.last_command || t.command || "",
      cwd: t.cwd || ws?.directory || "~",
      elapsed: formatElapsed(pane?.elapsed_ms),
      contextFill: fill,
      contextLabel: `${formatTokens(ctx)} ctx`,
      contextPips: Math.round(fill * PIP_COUNT),
      outputTail: tail(t.output),
      needsInput,
      posture: t.posture,
      mode: t.permissions_mode ?? pane?.permissions_mode,
    };
  });
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
