/**
 * src/actions/defs/notes.ts — the NOTES group of the unified ActionDef registry (REG1).
 *
 * FAITHFUL PORTS of the server.ts voice dispatch branches (server.ts:2665-2749), handler-owned
 * gating, ZERO behavior change:
 *   - add_project_note (server.ts:2665) — UNGATED write + broadcastLedgerUpdate on success.
 *   - add_pane_note    (server.ts:2671) — UNGATED write; pane_id defaults to the active pane.
 *   - get_project_notes(server.ts:2687) — read-only recall, per-note redactSecrets.
 *   - search_notes     (server.ts:2700) — read-only FTS, note-only + redactSecrets.
 *   - delete_note      (server.ts:2734) — GATED via ctx.gateOrDefer durable Ask-defer
 *     (capability "update_metadata", paneId null, durable intent { op:"delete", noteId } in
 *     lockstep with src/actionEffects.ts buildActionRun update_metadata case). Mirrors the amend_note
 *     template in registry.ts EXACTLY, op:"delete".
 *
 * amend_note already lives in registry.ts — NOT re-added here.
 *
 * WIRE FIDELITY: every legacy branch answers session.sendToolResponse with response.output set to a
 * value (string or object). Therefore EVERY handler here returns kind:"ok" with that exact value —
 * including delete_note's forbidden/deferred dispositions, which the legacy branch reports as plain
 * { output: <string> } (see amend_note template). We do NOT use kind:"blocked"/"pending" here because
 * the legacy wire shape does not differ across dispositions for these tools.
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";
import { redactSecrets } from "../../terminal";

// ─────────────────────────────────────────────────────────────────────────────
// add_project_note (server.ts:2665) — UNGATED write.
// ─────────────────────────────────────────────────────────────────────────────

/** add_project_note params (server.ts Gemini decl: project_id + note, both STRING, both required). */
const AddProjectNoteParams = z.object({
  project_id: z.string(),
  note: z.string(),
});

/**
 * add_project_note — FAITHFUL PORT of server.ts:2665-2670. addNote returns StoredNote | null (null =
 * project not found, no orphan notes). broadcastLedgerUpdate fires ONLY on success. The not-found path
 * is a NORMAL ok tool response whose output text reports the miss — NOT a {kind:"error"}.
 */
export const addProjectNote: ActionDef<typeof AddProjectNoteParams> = {
  name: "add_project_note",
  description: "Add a durable note to a project.",
  params: AddProjectNoteParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    // PHASE 1 (deferrable-toggle honesty): add_project_note was ungated; mirror delete_note's
    // gateOrDefer pattern (capability update_metadata, default Auto → silent unless tightened). The
    // effect computes its own success/miss narration (addNote returns null when the project is gone).
    // op:"add", scope:"project" discriminants keep the durable intent in lockstep with src/actionEffects.ts.
    const addEffect = (): string => {
      const ok = ctx.manager.ledger.addNote(args.project_id, args.note);
      if (ok) ctx.broadcastLedgerUpdate();
      return ok
        ? `Note added to project ${args.project_id}`
        : `Could not add note: project ${args.project_id} not found.`;
    };
    const g = ctx.gateOrDefer("update_metadata", null, `Add note to project ${args.project_id}`, addEffect, {
      ...(ctx.versionStamp ?? {}),
      op: "add",
      scope: "project",
      projectId: args.project_id,
      note: args.note,
    });
    if (g.disposition === "forbidden") {
      return { kind: "ok", output: `Error: the 'update_metadata' capability is gated Off; adding notes is forbidden by policy.` };
    }
    if (g.disposition === "deferred") {
      return { kind: "ok", output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to add the note.` };
    }
    return { kind: "ok", output: addEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// add_pane_note (server.ts:2671) — UNGATED write; pane_id defaults to the active pane.
// ─────────────────────────────────────────────────────────────────────────────

/** add_pane_note params (server.ts Gemini decl: project_id?/pane_id? optional, note required). */
const AddPaneNoteParams = z.object({
  project_id: z.string().optional(),
  pane_id: z.string().optional(),
  note: z.string(),
});

/**
 * add_pane_note — FAITHFUL PORT of server.ts:2671-2686 (MUST-FIX #4, bead bjm). pane_id resolves to
 * an explicit non-empty string, else the server-tracked active pane (ctx.getActivePaneId()). When
 * neither resolves, answer the no-pane refusal (writes/broadcasts nothing). projectId uses the
 * `||` ladder to activeProjectId then 'default_project'. addPaneNote returns StoredNote | null
 * (null = pane row not found); broadcastLedgerUpdate fires only on success; the miss is reported in
 * the ok output text.
 */
export const addPaneNote: ActionDef<typeof AddPaneNoteParams> = {
  name: "add_pane_note",
  description:
    "Add a durable note to a pane. Omit pane_id to attach it to the pane the operator currently has open (the active pane); if no pane is open the note is not saved.",
  params: AddPaneNoteParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    const paneId = (typeof args.pane_id === "string" && args.pane_id) ? args.pane_id : ctx.getActivePaneId();
    if (!paneId) {
      return { kind: "ok", output: "No pane is open, so there's nowhere to attach this note. Open a pane first." };
    }
    const projectId = args.project_id || ctx.manager.ledger.activeProjectId || "default_project";
    // PHASE 1: gate add_pane_note through update_metadata (default Auto → silent unless tightened),
    // mirroring delete_note. The no-pane refusal above is resolved BEFORE the gate (we never stage a
    // note with no target). The effect computes its own success/miss narration. op:"add", scope:"pane"
    // discriminants keep the durable intent in lockstep with src/actionEffects.ts.
    const addEffect = (): string => {
      const ok = ctx.manager.ledger.addPaneNote(projectId, paneId, args.note);
      if (ok) ctx.broadcastLedgerUpdate();
      return ok
        ? `Note added to pane ${paneId}`
        : `Could not add note: pane ${paneId} not found in project ${projectId}.`;
    };
    const g = ctx.gateOrDefer("update_metadata", paneId, `Add note to pane ${paneId}`, addEffect, {
      ...(ctx.versionStamp ?? {}),
      op: "add",
      scope: "pane",
      projectId,
      paneId,
      note: args.note,
    });
    if (g.disposition === "forbidden") {
      return { kind: "ok", output: `Error: the 'update_metadata' capability is gated Off; adding notes is forbidden by policy.` };
    }
    if (g.disposition === "deferred") {
      return { kind: "ok", output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to add the note.` };
    }
    return { kind: "ok", output: addEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_project_notes (server.ts:2687) — read-only recall.
// ─────────────────────────────────────────────────────────────────────────────

/** get_project_notes params (server.ts Gemini decl: project_id? optional, limit? number). */
const GetProjectNotesParams = z.object({
  project_id: z.string().optional(),
  limit: z.number().optional(),
});

/**
 * get_project_notes — FAITHFUL PORT of server.ts:2687-2699 (bead bjm, MUST-FIX #1 model-egress
 * redaction). projectId via the `||` ladder; limit clamped to [1,50] default 10. getNotes returns
 * project- AND pane-scoped notes newest-first; .slice(0,limit) after the DESC sort; each note
 * projected to {id, pane_id, type, created_at, text} with text redacted in-handler. Pure read.
 * (readOnly:true also triggers runAction's central ctx.redact pass — idempotent second pass; the
 * in-handler redactSecrets is kept for byte-identical output.)
 */
export const getProjectNotes: ActionDef<typeof GetProjectNotesParams> = {
  name: "get_project_notes",
  description:
    "Recall the durable notes saved for a project (decisions, todos, warnings). Use this to answer 'what did we decide', 'what are my notes', 'remind me what we noted'. Defaults to the active project — you do NOT need to switch_context first. Returns id-bearing, secret-redacted notes, newest first.",
  params: GetProjectNotesParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    // igc read-gating lever: block ONLY on the explicit Off veto for "read_notes" (an unseeded
    // capability resolves to Auto, so this is behavior-preserving until the operator sets Off).
    // Notes are PROJECT-scoped, not pane-scoped -> resolve the matrix with paneId null. PURE
    // resolver (no audit side effect on the common allowed path).
    // Block only on an EXPLICIT operator Off, NOT the STOP-ALL frozen short-circuit (reads stay available during a freeze — behavior-preserving).
    if (!ctx.isFrozen() && ctx.effectiveCapabilityGateFor(null, "read_notes") === "Off") {
      return { kind: "ok", output: "Error: the 'read_notes' capability is gated Off; reading note content is forbidden by policy." };
    }
    const projectId = args.project_id || ctx.manager.ledger.activeProjectId || "default_project";
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const notes = ctx.manager.ledger.getNotes({ projectId }).slice(0, limit).map((n) => ({
      id: n.id, pane_id: n.pane_id, type: n.type, created_at: n.created_at, text: redactSecrets(n.text),
    }));
    return { kind: "ok", output: { project_id: projectId, count: notes.length, notes } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// search_notes (server.ts:2700) — read-only FTS, note-only + redaction.
// ─────────────────────────────────────────────────────────────────────────────

/** search_notes params (server.ts Gemini decl: query required STRING, limit? number). */
const SearchNotesParams = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

/**
 * search_notes — FAITHFUL PORT of server.ts:2700-2713 (bead bjm MUST-FIX #2). store.search with
 * source:"note" (so the events sub-query returns [] and can't starve note hits), re-filtered to
 * source==="note" (belt-and-suspenders), sliced to limit, each snippet redacted. Result shape is
 * {id, snippet} ONLY. Pure read.
 */
export const searchNotes: ActionDef<typeof SearchNotesParams> = {
  name: "search_notes",
  description:
    "Full-text search the saved NOTES for a phrase ('find the note about auth', 'what did we say about retries'). Returns matching note snippets (secret-redacted) with their ids. Notes only — it does not search the raw activity log.",
  params: SearchNotesParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    // igc read-gating lever: block ONLY on the explicit Off veto for "read_notes" (Auto fallback =
    // behavior-preserving). Notes are PROJECT-scoped -> resolve with paneId null. PURE resolver.
    // Block only on an EXPLICIT operator Off, NOT the STOP-ALL frozen short-circuit (reads stay available during a freeze — behavior-preserving).
    if (!ctx.isFrozen() && ctx.effectiveCapabilityGateFor(null, "read_notes") === "Off") {
      return { kind: "ok", output: "Error: the 'read_notes' capability is gated Off; reading note content is forbidden by policy." };
    }
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const results = ctx.manager.ledger.search(query, { limit, source: "note" })
      .filter((r) => r.source === "note")
      .slice(0, limit)
      .map((r) => ({ id: r.id, snippet: redactSecrets(r.snippet) }));
    return { kind: "ok", output: { query, count: results.length, results } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// delete_note (server.ts:2734) — GATED via ctx.gateOrDefer durable Ask-defer.
// ─────────────────────────────────────────────────────────────────────────────

/** delete_note params (server.ts Gemini decl: note_id required STRING). */
const DeleteNoteParams = z.object({
  note_id: z.string(),
});

/**
 * delete_note — FAITHFUL PORT of server.ts:2734-2749 (bead bjm MUST-FIX #3 — gate through
 * update_metadata, mutate ONLY inside the run closure). Mirrors the amend_note template (registry.ts)
 * with op:"delete". The handler builds the REAL deleteEffect closure, then calls ctx.gateOrDefer with
 * that closure AND the serializable intent params { op:"delete", noteId } — the SAME shape
 * buildActionRun (src/actionEffects.ts:167 update_metadata case) re-derives on restart, in LOCKSTEP.
 * paneId is NULL (note ops are global-scoped, not pane-scoped).
 *
 * WIRE FIDELITY: the legacy branch answers { output: <string> } for ALL THREE dispositions, so each
 * arm returns kind:"ok" with the verbatim legacy string (Off / Ask / run), exactly as amend_note.
 */
export const deleteNote: ActionDef<typeof DeleteNoteParams> = {
  name: "delete_note",
  description:
    "Delete a note permanently by its id (get the id from get_project_notes or search_notes). Gated by the 'update notes & metadata' permission: auto-applies in Auto, asks for operator confirmation in Ask, refused when Off.",
  params: DeleteNoteParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    const noteId = String(args.note_id ?? "");
    const deleteEffect = (): string => {
      ctx.manager.ledger.deleteNote(noteId);
      ctx.broadcastLedgerUpdate();
      return `Note ${noteId} deleted.`;
    };
    // kzt: persist the delete INTENT (op + noteId) so a deferred delete survives a restart. Keys in
    // lockstep with src/actionEffects.ts UpdateMetadataParams ({ op:"delete", noteId }).
    const g = ctx.gateOrDefer("update_metadata", null, `Delete note ${noteId}`, deleteEffect, {
      ...(ctx.versionStamp ?? {}),
      op: "delete",
      noteId,
    });
    if (g.disposition === "forbidden") {
      return {
        kind: "ok",
        output: `Error: the 'update_metadata' capability is gated Off; deleting notes is forbidden by policy.`,
      };
    }
    if (g.disposition === "deferred") {
      return {
        kind: "ok",
        output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to delete the note.`,
      };
    }
    return { kind: "ok", output: deleteEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// c55.12 — 6 rest-only operator-UI note/context defs (faithful ports of the inline routes)
// ─────────────────────────────────────────────────────────────────────────────
// These are the OPERATOR-UI surface: ungated (the operator acts in their own browser) and, for the
// read feed, UNREDACTED (DOM-render-only — redaction is a MODEL-egress guard; the voice tools redact,
// this feed does not). DISTINCT from the gated/redacted voice note defs above. ALWAYS_ALLOWED +
// readOnly:false (the §8.1 invariant binds readOnly to read_pane/read_notes; ungated reads use false,
// same as get_stop_all_status). Writes return an ok-narration -> default {output} (the UI ignores the
// body and repaints off the ledger_updated broadcast). rest.path uses snake_case segments. The ungated
// posture is intentional (revisited by c55.10 gate-tightening).

const CreateProjectNoteParams = z.object({ project_id: z.string(), note: z.string() });
export const createProjectNote: ActionDef<typeof CreateProjectNoteParams> = {
  name: "create_project_note",
  description: "Operator-UI: add a note to a project (ungated, operator-direct). The gated model-facing path is the voice add_project_note tool.",
  params: CreateProjectNoteParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/projects/:project_id/notes" },
  handler: (args, ctx): ActionResult => {
    ctx.manager.ledger.addNote(args.project_id, args.note);
    // Faithful to the inline route: broadcasts unconditionally (the voice add_project_note guards on success). Harmless spurious broadcast if the project is missing.
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Note added to project ${args.project_id}.` };
  },
};

const ReadProjectNotesParams = z.object({ project_id: z.string() });
export const readProjectNotes: ActionDef<typeof ReadProjectNotesParams> = {
  name: "read_project_notes",
  description: "Operator-UI: the raw, id-bearing project notes feed for the Node Chronicle (UNREDACTED — DOM-render-only). The redacted model-facing read is the voice get_project_notes tool.",
  params: ReadProjectNotesParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/projects/:project_id/notes",
    // Emit {notes:[…]} TOP-LEVEL — the exact legacy inline body shape the UI reads as data.notes.
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: { notes: result.kind === "ok" ? result.output : [] },
    }),
  },
  handler: (args, ctx): ActionResult => ({ kind: "ok", output: ctx.manager.ledger.getNotes({ projectId: args.project_id }) }),
};

const EditNoteParams = z.object({ note_id: z.string(), text: z.string() });
export const editNote: ActionDef<typeof EditNoteParams> = {
  name: "edit_note",
  description: "Operator-UI: edit a note's text by id (ungated, operator-direct). The gated model-facing path is the voice amend_note tool.",
  params: EditNoteParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "put", path: "/api/notes/:note_id" },
  handler: (args, ctx): ActionResult => {
    // Accepted delta: the inline 400 "Missing text" type-guard is superseded by Zod (text: z.string()) upstream.
    ctx.manager.ledger.amendNote(args.note_id, args.text);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Note ${args.note_id} updated.` };
  },
};

const RemoveNoteParams = z.object({ note_id: z.string() });
export const removeNote: ActionDef<typeof RemoveNoteParams> = {
  name: "remove_note",
  description: "Operator-UI: delete a note by id (ungated, operator-direct). The gated model-facing path is the voice delete_note tool.",
  params: RemoveNoteParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/notes/:note_id" },
  handler: (args, ctx): ActionResult => {
    ctx.manager.ledger.deleteNote(args.note_id);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Note ${args.note_id} deleted.` };
  },
};

const CreatePaneNoteParams = z.object({ project_id: z.string(), pane_id: z.string(), note: z.string() });
export const createPaneNote: ActionDef<typeof CreatePaneNoteParams> = {
  name: "create_pane_note",
  description: "Operator-UI: add a note to a specific pane (ungated, operator-direct). The voice add_pane_note tool is the model-facing path.",
  params: CreatePaneNoteParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/projects/:project_id/panes/:pane_id/notes" },
  handler: (args, ctx): ActionResult => {
    ctx.manager.ledger.addPaneNote(args.project_id, args.pane_id, args.note);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Note added to pane ${args.pane_id}.` };
  },
};

const AddPaneContextParams = z.object({ project_id: z.string(), pane_id: z.string(), text: z.string(), layer: z.string().optional() });
export const addPaneContext: ActionDef<typeof AddPaneContextParams> = {
  name: "add_pane_context",
  description: "Operator-UI: add a layered context entry to a pane (model layer if layer='model', else the human steering layer). Ungated operator-direct steering; not a CLI write.",
  params: AddPaneContextParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/projects/:project_id/panes/:pane_id/context" },
  handler: (args, ctx): ActionResult => {
    const ok = args.layer === "model"
      ? ctx.manager.ledger.addModelContext(args.project_id, args.pane_id, args.text, "operator-ui")
      : ctx.manager.ledger.addHumanContext(args.project_id, args.pane_id, args.text);
    // Accepted delta (c55 program): pane-not-found maps to 200 ok-narration, not the inline 404.
    // The UI ignores the body and repaints off ledger_updated (which does NOT fire on this failure path).
    if (!ok) return { kind: "ok", output: `Pane ${args.pane_id} not found in project ${args.project_id}.` };
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Context added to pane ${args.pane_id}.` };
  },
};

/** The NOTES group of the canonical registry (amend_note lives in registry.ts; not re-exported here). */
export const NOTES_ACTIONS: ActionDef[] = [
  addProjectNote,
  addPaneNote,
  getProjectNotes,
  searchNotes,
  deleteNote,
  createProjectNote,
  readProjectNotes,
  editNote,
  removeNote,
  createPaneNote,
  addPaneContext,
];
