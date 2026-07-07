/**
 * src/actions/defs/export.ts — hwu.6: the deterministic project EXPORT (voice trigger + REST twin).
 *
 * OPERATOR RESCOPE (2026-07-06, binding): the export is a deterministic artifact IN THE PROJECT
 * FOLDER, usable/referenceable by a subagent running in a pane FOR that project. Orbital does NOT
 * compose stakeholder notes or any other derived document — it is the voice layer; downstream
 * translation is pane-subagent territory, out of scope here. The voice leg is a terse trigger + a
 * ONE-LINE spoken confirmation, never a spoken digest and never the document read aloud. This is a
 * DEFINED-PATHWAY write: a fixed basename, fully deterministic redacted content, no agent-authored
 * text — distinct from (and not a reopening of) the hwu.4 no-live-agent-file-writes rescope.
 *
 * Architecture — ONE pure composer, TWO thin shells:
 *   - composeExportMarkdown(snapshot, clock) is a PURE function: same snapshot + same clock -> the
 *     SAME bytes, every time. It never touches fs/ctx. `clock` is injected (not `Date.now` baked in)
 *     so tests can golden-pin the "Generated:" line.
 *   - buildExportSnapshot(ctx, project, projectId) is the ONLY place that reads the live ledger
 *     (notes/panes/events/plans) into the plain-data ExportProjectSnapshot the composer consumes.
 *   - export_project (voice): resolves the target project SERVER-SIDE (an optional project_id, never
 *     a path), builds the snapshot, composes, and — ONLY on the gate's "run" disposition — writes it
 *     atomically (temp+rename) to `<project.directory>/ORBITAL_EXPORT.md` (EXPORT_BASENAME is a
 *     compile-time constant; the live agent has ZERO influence over path or basename). It answers a
 *     terse spoken confirmation ONLY ("Export written — N notes, M stations") — the composed
 *     Markdown body NEVER reaches `output`, so it can never reach Gemini.
 *   - get_project_export (rest-only): the SAME composer, returned as the HTTP body (text/markdown,
 *     Content-Disposition: attachment) — no file write on this leg. 404 for an unknown project.
 *
 * Both defs share composeExportMarkdown + buildExportSnapshot — there is exactly ONE assembly path.
 *
 * Redaction (risk: a missed path here is a durable secret-exfil artifact ON DISK): every free-text
 * field (note text, event summaries, plan/step commands, project summary + key terms) is passed
 * through `redactForExport`, which layers a composer-local pass ON TOP of the canonical
 * `redactSecrets` (../../terminal). The canonical pass's generic "key=value" catch-all is anchored
 * with `\b` word boundaries, which do NOT fire between two word characters — so an underscore-joined
 * secret-shaped key like `API_AUTH_TOKEN` (the perimeter auth secret; CLAUDE.md: "never log
 * API_AUTH_TOKEN") is NOT caught by `\btoken\b` (the underscore before "TOKEN" is itself a word
 * character, so there is no boundary there for the regex to anchor on). `redactForExport` repeats the
 * same key vocabulary WITHOUT the `\b` anchors so it also catches those underscore/camel-joined
 * forms. This is purely ADDITIVE (never edits the shared terminal.ts) and idempotent.
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import type { ActionContext, ActionDef, ActionResult } from "../types";
import type { NoteType } from "../../store/types";
import type { Workspace } from "../../types";
import { redactSecrets } from "../../terminal";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The FIXED basename export_project writes. A compile-time constant — no arg, no ctx field, no
 *  server setting ever feeds into this string, so the live agent cannot influence it. */
export const EXPORT_BASENAME = "ORBITAL_EXPORT.md";

/** Recent-history window cap (the serviceLog cap idiom): the export's history section is the last
 *  N events for the project, not a full-table dump. */
export const EXPORT_HISTORY_CAP = 100;

/** Canonical NoteType iteration order (deterministic section ordering — never insertion order). */
const NOTE_TYPE_ORDER: readonly NoteType[] = ["decision", "todo", "warning", "note", "handoff"];
const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  decision: "Decisions",
  todo: "Todos",
  warning: "Warnings",
  note: "Notes",
  handoff: "Handoffs",
};

// ─────────────────────────────────────────────────────────────────────────────
// Redaction — canonical redactSecrets + a composer-local defense-in-depth pass
// ─────────────────────────────────────────────────────────────────────────────

/** Same key vocabulary as terminal.ts's redactSecrets generic catch-all, WITHOUT \b anchors, so an
 *  underscore/camel-joined key (API_AUTH_TOKEN, someApiKey) still matches. Redacts the VALUE only. */
const EXPORT_EXTRA_SECRET_RE =
  /(api[_-]?key|secret|token|password|passwd|bearer|access[_-]?key)(\s*[=:]\s*)["']?([^\s"']{6,})["']?/gi;

/** Every export string field routes through this — the canonical pass, then the extra pass above. */
export function redactForExport(text: string): string {
  const afterCanonical = redactSecrets(text);
  return afterCanonical.replace(EXPORT_EXTRA_SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}[REDACTED:secret]`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The plain-data snapshot the pure composer consumes
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportNoteSnapshot {
  id: string;
  type: NoteType;
  pane_id: string | null;
  text: string;
  created_at: number;
}
export interface ExportPaneSnapshot {
  pane_id: string;
  name: string;
  alive: boolean;
  last_known_state: string;
  tool_preset: string;
  permissions_mode: string;
}
export interface ExportEventSnapshot {
  id: number;
  ts: number;
  type: string;
  pane_id: string | null;
  summary: string;
}
export interface ExportPlanStepSnapshot {
  id: string;
  command: string;
  status: string;
}
export interface ExportPlanSnapshot {
  id: string;
  name: string;
  status: string;
  steps: ExportPlanStepSnapshot[];
}
export interface ExportProjectSnapshot {
  project: { id: string; name: string; directory: string; summary: string; keyTerms: string[] };
  notes: ExportNoteSnapshot[];
  panes: ExportPaneSnapshot[];
  /** ALREADY bounded to EXPORT_HISTORY_CAP (most-recent-last) by the builder — the composer never
   *  slices; it renders exactly what it is given. */
  events: ExportEventSnapshot[];
  /** Plans are a GLOBAL board in the current data model (Plan carries no project_id) — every plan is
   *  included, not filtered per project. */
  plans: ExportPlanSnapshot[];
}

// ─────────────────────────────────────────────────────────────────────────────
// buildExportSnapshot — the ONLY place that reads the live ledger for export
// ─────────────────────────────────────────────────────────────────────────────

/** Reads notes/panes/plans off ctx.manager.ledger (the LedgerLike surface every def already uses)
 *  and events off ctx.store (typed JanusStore, since LedgerLike does not declare getEvents). Degrades
 *  gracefully (empty events) when ctx.store is absent (a hand-built test ActionContext). */
export function buildExportSnapshot(ctx: ActionContext, project: Workspace, projectId: string): ExportProjectSnapshot {
  const notes: ExportNoteSnapshot[] = ctx.manager.ledger.getNotes({ projectId }).map((n) => ({
    id: n.id, type: n.type, pane_id: n.pane_id, text: n.text, created_at: n.created_at,
  }));
  const panes: ExportPaneSnapshot[] = Object.values(project.panes).map((p) => ({
    pane_id: p.pane_id, name: p.name, alive: p.alive,
    last_known_state: p.last_known_state, tool_preset: p.tool_preset, permissions_mode: p.permissions_mode,
  }));
  const rawEvents = ctx.store?.getEvents({ projectId }) ?? [];
  const events: ExportEventSnapshot[] = rawEvents.slice(-EXPORT_HISTORY_CAP).map((e) => ({
    id: e.id, ts: e.ts, type: e.type, pane_id: e.pane_id, summary: e.summary,
  }));
  const plans: ExportPlanSnapshot[] = ctx.manager.ledger.plans.map((p) => ({
    id: p.id, name: p.name, status: p.status,
    steps: p.steps.map((s) => ({ id: s.id, command: s.command, status: s.status })),
  }));
  return {
    project: {
      id: project.id, name: project.name, directory: project.directory,
      summary: project.summary ?? "", keyTerms: project.keyTerms ?? [],
    },
    notes, panes, events, plans,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// composeExportMarkdown — the ONE pure composer (deterministic; zero decision logic)
// ─────────────────────────────────────────────────────────────────────────────

function renderProjectSection(s: ExportProjectSnapshot): string {
  const terms = s.project.keyTerms.length ? s.project.keyTerms.map(redactForExport).join(", ") : "(none)";
  const summary = s.project.summary.trim() ? redactForExport(s.project.summary) : "(none)";
  return [
    "## Project", "",
    `- **Directory:** ${s.project.directory}`,
    `- **Summary:** ${summary}`,
    `- **Key Terms:** ${terms}`,
  ].join("\n");
}

function renderNoteGroup(type: NoteType, notes: ExportNoteSnapshot[]): string {
  const lines = [`### ${NOTE_TYPE_LABELS[type]} (${notes.length})`, ""];
  if (notes.length === 0) { lines.push("(none)"); return lines.join("\n"); }
  for (const n of notes) {
    const scope = n.pane_id ? `pane ${n.pane_id}` : "project-level";
    lines.push(`- **[${n.id}]** (${scope}) — ${redactForExport(n.text)} _(${new Date(n.created_at).toISOString()})_`);
  }
  return lines.join("\n");
}

function renderNotesSection(s: ExportProjectSnapshot): string {
  const byType = new Map<NoteType, ExportNoteSnapshot[]>();
  for (const t of NOTE_TYPE_ORDER) byType.set(t, []);
  for (const n of s.notes) byType.get(n.type)?.push(n);
  const groups = NOTE_TYPE_ORDER.map((t) => renderNoteGroup(t, byType.get(t) ?? []));
  return [`## Notes (${s.notes.length})`, ...groups].join("\n\n");
}

function renderPanesSection(s: ExportProjectSnapshot): string {
  const lines = [`## Panes (${s.panes.length})`, ""];
  if (s.panes.length === 0) { lines.push("(none)"); return lines.join("\n"); }
  for (const p of s.panes) {
    const life = p.alive ? "alive" : "exited";
    // hwu.6: the pane NAME is agent-writable free text (rename_pane is a voice tool), so it must pass
    // redactForExport like every other free-text field — a secret-shaped rename can never land raw on disk.
    lines.push(`- **${p.pane_id}** — ${redactForExport(p.name)} — ${life} / ${p.last_known_state} — preset:${p.tool_preset} mode:${p.permissions_mode}`);
  }
  return lines.join("\n");
}

function renderHistorySection(s: ExportProjectSnapshot): string {
  const lines = [`## Recent History (last ${s.events.length} shown)`, ""];
  if (s.events.length === 0) { lines.push("(none)"); return lines.join("\n"); }
  for (const e of s.events) {
    const scope = e.pane_id ? `pane ${e.pane_id}` : "project-level";
    lines.push(`- \`${new Date(e.ts).toISOString()}\` **${e.type}** (${scope}) — ${redactForExport(e.summary)}`);
  }
  return lines.join("\n");
}

function renderPlanSteps(steps: ExportPlanStepSnapshot[]): string {
  if (steps.length === 0) return "  - (no steps)";
  return steps.map((st, i) => `  - step ${i + 1}: ${redactForExport(st.command)} — ${st.status}`).join("\n");
}

function renderPlansSection(s: ExportProjectSnapshot): string {
  const lines = [`## Plans (${s.plans.length})`, ""];
  if (s.plans.length === 0) { lines.push("(none)"); return lines.join("\n"); }
  for (const p of s.plans) {
    lines.push(`### ${redactForExport(p.name)} (${p.status}) — ${p.id}`, renderPlanSteps(p.steps));
  }
  return lines.join("\n");
}

/**
 * The pure composer: same snapshot + same clock -> byte-identical Markdown. `clock` is a `() =>
 * number` (epoch ms) — production callers pass `Date.now`; tests pass a fixed function so the
 * "Generated:" line golden-pins exactly like the rest of the body.
 */
export function composeExportMarkdown(snapshot: ExportProjectSnapshot, clock: () => number): string {
  const generatedAt = new Date(clock()).toISOString();
  return [
    // hwu.6: the project NAME is agent-writable free text (rename_project is a voice tool) — redact it
    // like the pane names / summary / note text so the title line can never carry a secret onto disk.
    `# Orbital Export — ${redactForExport(snapshot.project.name)} (${snapshot.project.id})`,
    "",
    `_Generated: ${generatedAt}_`,
    "",
    renderProjectSection(snapshot),
    "",
    renderNotesSection(snapshot),
    "",
    renderPanesSection(snapshot),
    "",
    renderHistorySection(snapshot),
    "",
    renderPlansSection(snapshot),
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic write (temp + rename) — the ONLY fs-mutating step, and only on the voice leg
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write `markdown` to `<dir>/ORBITAL_EXPORT.md` atomically: write the FULL content to a sibling temp
 * file, then rename it over the target in one filesystem op. A crash/throw during the temp write
 * never touches the target path (it either doesn't exist yet or still holds its PRIOR content) — a
 * pane subagent can never observe a partial/corrupt artifact. Best-effort temp-file cleanup on error
 * (never throws itself; the caller's error already carries the real signal).
 */
export function writeExportArtifactAtomic(dir: string, markdown: string): string {
  const targetPath = path.join(dir, EXPORT_BASENAME);
  const tmpPath = path.join(dir, `.${EXPORT_BASENAME}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  try {
    fs.writeFileSync(tmpPath, markdown, "utf8");
    fs.renameSync(tmpPath, targetPath);
    return targetPath;
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// export_project (voice) — resolve project server-side, gate, compose, write, speak a terse confirm
// ─────────────────────────────────────────────────────────────────────────────

const ExportProjectParams = z.object({ project_id: z.string().optional() });

export const exportProject: ActionDef<typeof ExportProjectParams> = {
  name: "export_project",
  description:
    "Write a deterministic, secret-redacted Markdown snapshot of this project (notes/panes/recent history/plans) to ORBITAL_EXPORT.md in the project's own folder, so a pane subagent running there can read it. Speaks a terse confirmation only ('Export written — N notes, M stations') — it never reads the document aloud and never returns its body to you.",
  params: ExportProjectParams,
  // Auto-capable write-class action under the metadata/persistence gate (deterministic fixed-path
  // redacted content) — shares the same "update_metadata" matrix row as add/delete note (default Auto;
  // an operator can still dial it to Ask/Off).
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    const projectId = args.project_id || ctx.manager.ledger.activeProjectId || "default_project";
    const project = ctx.manager.ledger.getProject(projectId);
    if (!project) {
      return { kind: "ok", output: `Could not export: project ${projectId} not found.` };
    }
    // The REAL effect: compose (pure) THEN write (the one fs mutation). Composing before opening any
    // file handle means a composer throw leaves NOTHING on disk (nothing to roll back).
    const exportEffect = (): string => {
      const snapshot = buildExportSnapshot(ctx, project, projectId);
      const markdown = composeExportMarkdown(snapshot, Date.now);
      try {
        writeExportArtifactAtomic(project.directory, markdown);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Export failed: could not write ${EXPORT_BASENAME} (${message}).`;
      }
      return `Export written — ${snapshot.notes.length} notes, ${snapshot.panes.length} stations.`;
    };
    const g = ctx.gateOrDefer(
      "update_metadata",
      null,
      `Export project ${projectId} to ${EXPORT_BASENAME}`,
      exportEffect,
      { ...(ctx.versionStamp ?? {}), op: "export", projectId },
    );
    if (g.disposition === "forbidden") {
      return { kind: "ok", output: `Error: the 'update_metadata' capability is gated Off; exporting the project is forbidden by policy.` };
    }
    if (g.disposition === "deferred") {
      return { kind: "ok", output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to write the export.` };
    }
    // "run": gateOrDefer does not itself invoke the effect on this disposition (mirrors add_project_note).
    return { kind: "ok", output: exportEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_project_export (rest-only) — the SAME composer, no file write
// ─────────────────────────────────────────────────────────────────────────────

const GetProjectExportParams = z.object({ project_id: z.string() });

export const getProjectExport: ActionDef<typeof GetProjectExportParams> = {
  name: "get_project_export",
  description:
    "Return the same deterministic, secret-redacted Markdown export as export_project, as a markdown download (text/markdown; Content-Disposition: attachment). Read-only — no file write on this leg. 404 for an unknown project.",
  params: GetProjectExportParams,
  capability: "read_notes",
  // readOnly:false is DELIBERATE despite this being a pure read: runAction's readOnly egress pass
  // (redactResult, src/actions/gemini.ts) rebuilds the "ok" result as a bare `{kind:"ok", output}` —
  // it DROPS `meta` entirely, which would silently strip the httpStatus/contentType/filename this
  // route's REST projection depends on (applyMetaResponseOverride, src/actions/rest.ts). Redaction is
  // NOT skipped as a result: composeExportMarkdown already runs every field through redactForExport,
  // so the output is redacted at the SOURCE rather than by the generic blanket pass.
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "get", path: "/api/projects/:project_id/export" },
  handler: (args, ctx): ActionResult => {
    // igc read-gating lever: block ONLY on the explicit Off veto (Auto fallback = behavior-preserving),
    // same posture as get_project_notes. A REST-only def can answer the real 403, unlike its voice
    // sibling above (which must degrade to an ok-narration string).
    if (!ctx.isFrozen() && ctx.effectiveCapabilityGateFor(null, "read_notes") === "Off") {
      return { kind: "blocked", reason: "Error: the 'read_notes' capability is gated Off; reading project content is forbidden by policy." };
    }
    const projectId = args.project_id;
    const project = ctx.manager.ledger.getProject(projectId);
    if (!project) {
      return { kind: "ok", output: { error: `Project ${projectId} not found.` }, meta: { httpStatus: 404 } };
    }
    const snapshot = buildExportSnapshot(ctx, project, projectId);
    const markdown = composeExportMarkdown(snapshot, Date.now);
    return {
      kind: "ok",
      output: markdown,
      meta: { httpStatus: 200, contentType: "text/markdown; charset=utf-8", filename: EXPORT_BASENAME },
    };
  },
};

/** The EXPORT group. Registered by the integrator into the canonical REGISTRY (see this task's
 *  requiredRegistrations note) — built + unit-tested standalone here per file-ownership rules. */
export const EXPORT_ACTIONS: ActionDef[] = [exportProject, getProjectExport];
