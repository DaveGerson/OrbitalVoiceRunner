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
import type { ActionContext, ActionDef, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";
import { redactSecrets } from "../../terminal";
import { recentTurns, type TurnAuthor } from "../../voice/recentTurns";
import type { NoteType } from "../../store/types";

// ─────────────────────────────────────────────────────────────────────────────
// Note-TYPE classification seam (hwu.3). Pure, deterministic, non-hot (fires once per operator save,
// never per frame) -> Python via the "policies" stdio daemon (ctx.policies.classifyNote), FAIL-OPEN to
// "note". The seam call is async, bounded by the policy race timeout, and NEVER rejects/blocks: a daemon
// down/timeout/schema-miss yields "note", so classification can never block or delay note capture.
// ─────────────────────────────────────────────────────────────────────────────

/** Classify note text into a NoteType, falling OPEN to "note" on ANY daemon miss (down/timeout/schema/
 *  throw). This is the ONE place the classification seam is crossed for a note write. hwu.4 reuses this
 *  exported helper for promote_draft so draft→note capture classifies identically to transcript capture. */
export async function classifyNoteType(ctx: ActionContext, text: string): Promise<NoteType> {
  try {
    const t = await ctx.policies?.classifyNote?.(text);
    return t ?? "note";
  } catch {
    // The client contract is never-reject, but belt-and-suspenders: a stray throw must never block capture.
    return "note";
  }
}

/** Map the optional spoken `author` arg (model/janus | operator/user) to a transcript-turn author
 *  filter; undefined => "the last turn of either author". */
function turnAuthorFilter(author: string | undefined): TurnAuthor | undefined {
  if (author === "model" || author === "janus") return "janus";
  if (author === "operator" || author === "user") return "user";
  return undefined;
}

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
// save_transcript_note (hwu.3) — capture the last completed transcript turn as a typed note.
// ─────────────────────────────────────────────────────────────────────────────

/** save_transcript_note params — optional `author` narrows capture to the model (Janus) or operator
 *  side; omitted => the most recent turn of either author. */
const SaveTranscriptNoteParams = z.object({
  author: z.enum(["model", "operator", "janus", "user"]).optional(),
});

/**
 * save_transcript_note — "save that as a note". Captures the most recent COMPLETED transcript turn from
 * the server-side recent-turns ring (src/voice/recentTurns.ts), REDACTS it (the live transcript is raw —
 * an operator may have spoken a secret), CLASSIFIES its NoteType via the fail-open Python seam, and
 * persists it through the addNote path with the classified type + the turn's author.
 *
 * GATING PARITY with add_project_note (notes.ts add_project_note): routes through
 * ctx.gateOrDefer("update_metadata", null, …) with the SAME op:"add"/scope:"project" durable intent, so
 * a deferred save survives a restart in lockstep with src/actionEffects.ts (applyUpdateAddProject).
 * Note-TYPE is classified BEFORE the gate so the narration + intent name the type; the classification
 * seam is bounded + fail-open, so it never blocks capture.
 *
 * Empty ring => a graceful spoken "nothing to save yet" (never a crash, never an empty note).
 */
export const saveTranscriptNote: ActionDef<typeof SaveTranscriptNoteParams> = {
  name: "save_transcript_note",
  description:
    "Save the last thing said in the conversation as a durable, typed note (decision/todo/warning/note, auto-classified). Use for 'save that as a note', 'note that', 'remember that'. Omit author to capture the most recent turn; pass author='operator' or 'model' to pick a side. Attaches to the active project.",
  params: SaveTranscriptNoteParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: async (args, ctx): Promise<ActionResult> => {
    const turn = recentTurns.latest(turnAuthorFilter(args.author));
    if (!turn) {
      return { kind: "ok", output: "There's nothing to save yet — I don't have a recent transcript turn to note." };
    }
    // Redact BEFORE persistence (the raw transcript may carry a spoken secret). Classify the REDACTED
    // text (fail-open "note") so the classifier never sees a secret either.
    const text = redactSecrets(turn.text);
    const noteType = await classifyNoteType(ctx, text);
    const projectId = ctx.manager.ledger.activeProjectId || "default_project";
    const noteAuthor: TurnAuthor = turn.author;
    const addEffect = (): string => {
      const ok = ctx.manager.ledger.addNote(projectId, text, { type: noteType, author: noteAuthor });
      if (ok) ctx.broadcastLedgerUpdate();
      return ok
        ? `Saved that as a ${noteType} note.`
        : `Could not save the note: project ${projectId} not found.`;
    };
    const g = ctx.gateOrDefer("update_metadata", null, `Save transcript as a ${noteType} note`, addEffect, {
      ...(ctx.versionStamp ?? {}),
      op: "add",
      scope: "project",
      projectId,
      note: text,
    });
    if (g.disposition === "forbidden") {
      return { kind: "ok", output: `Error: the 'update_metadata' capability is gated Off; saving notes is forbidden by policy.` };
    }
    if (g.disposition === "deferred") {
      return { kind: "ok", output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to save the note.` };
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

/** search_notes params (server.ts Gemini decl: query required STRING, limit? number). hwu.5 adds an
 *  OPTIONAL `type` narrowing param — a closed zod enum over NoteType, so an invalid value is REJECTED
 *  at the params boundary (never reaches the handler, let alone a query) and an absent value is the
 *  legacy behavior byte-for-byte (untyped search across all note types). */
const SearchNotesParams = z.object({
  query: z.string(),
  limit: z.number().optional(),
  type: z.enum(["decision", "todo", "warning", "note", "handoff"]).optional(),
});

/**
 * search_notes — FAITHFUL PORT of server.ts:2700-2713 (bead bjm MUST-FIX #2). store.search with
 * source:"note" (so the events sub-query returns [] and can't starve note hits), re-filtered to
 * source==="note" (belt-and-suspenders), sliced to limit, each snippet redacted. Result shape is
 * {id, snippet} ONLY (plus `type` once hwu.5's optional filter is supplied — see below). Pure read.
 *
 * hwu.5 TYPE FILTER: `args.type` is ALREADY validated by the zod enum above before this line ever
 * runs — it can never be an arbitrary string, so it never reaches SQL as raw text. Because
 * sqliteStore.search()'s FTS union is the belt-and-suspenders-guarded surface (bjm MUST-FIX #2), we
 * do NOT thread the filter into that FTS query (a second WHERE clause there would need its own
 * note+event-union care). Instead we POST-FILTER the already note-only, already-redacted result rows
 * against getNotes()'s existing, already-parameterized `type=?` predicate (sqliteStore.ts getNotes) —
 * bounded to the already-limit-sliced hit set, so this never touches an unbounded row set.
 */
export const searchNotes: ActionDef<typeof SearchNotesParams> = {
  name: "search_notes",
  description:
    "Full-text search the saved NOTES for a phrase ('find the note about auth', 'what did we say about retries'). Returns matching note snippets (secret-redacted) with their ids. Notes only — it does not search the raw activity log. Pass type='decision' for 'what did we decide?', type='todo' for outstanding action items, type='warning' for flagged risks, or type='handoff' for handoff notes; omit type to search across all note types.",
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
    let results = ctx.manager.ledger.search(query, { limit, source: "note" })
      .filter((r) => r.source === "note")
      .slice(0, limit);
    // hwu.5: args.type is enum-validated above (never raw text); when present, narrow the ALREADY
    // note-only rows to that type by cross-referencing the persisted note row (belt-and-suspenders
    // filter #2 above stays intact — this runs strictly after it).
    if (args.type) {
      const typed = new Set(ctx.manager.ledger.getNotes({ type: args.type }).map((n) => n.id));
      results = results.filter((r) => typed.has(r.id));
    }
    const mapped = results.map((r) => ({ id: r.id, snippet: redactSecrets(r.snippet) }));
    return { kind: "ok", output: { query, count: mapped.length, results: mapped } };
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
  // hwu.3: the operator-direct save route (the KitchenRadio bubble-save target) now classifies the note
  // server-side so a saved bubble lands in The Pass with the right kind chip. Classification is bounded +
  // fail-open ("note" on any daemon miss), so the operator save is never blocked or delayed.
  handler: async (args, ctx): Promise<ActionResult> => {
    const text = redactSecrets(args.note);
    const noteType = await classifyNoteType(ctx, text);
    ctx.manager.ledger.addNote(args.project_id, text, { type: noteType });
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
    ctx.manager.ledger.amendNote(args.note_id, redactSecrets(args.text));
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
    ctx.manager.ledger.addPaneNote(args.project_id, args.pane_id, redactSecrets(args.note));
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

/**
 * The NOTES group of the canonical registry (amend_note lives in registry.ts; not re-exported here).
 *
 * hwu.3 (Wave 6 integration): `saveTranscriptNote` is now registered here — its golden/coverage/harness
 * updates landed with the Wave 6 integration pass. The def is also unit-tested directly
 * (tests/test_save_transcript_note.ts).
 */
export const NOTES_ACTIONS: ActionDef[] = [
  addProjectNote,
  saveTranscriptNote,
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
