/**
 * src/actions/defs/templates.ts — PROMPT TEMPLATES (journey-expansion: structured instruction inputs).
 *
 * Five defs: list / create / update / delete prompt templates, plus apply_prompt_template — the
 * centerpiece. Templates are named, parameterized instruction bodies (`{{slot}}` syntax, engine in
 * src/templates.ts) persisted on the ledger as a self-persisting document array (promptTemplates —
 * same kv/Proxy shape as watchRules/plans on both backends).
 *
 * DESIGN (template-centric orchestration, docs/roadmap/2026-06-10-journey-expansion.md §J7):
 * applying a template NEVER writes a PTY. It instantiates the body into the target pane's WIP
 * DRAFT (ledger.setDraft + draft_updated frame) — the same compose-then-review-then-send loop as
 * update_draft_prompt — so the existing draft send path stays the single gated write choke-point.
 * Direct multi-pane sends are dispatch_to_panes' job (dispatch_group.ts), which stages approvals.
 *
 * GATING:
 *  - list_prompt_templates: READ — capability "read_notes", readOnly:true (redacted on the way out).
 *  - create/update/delete: metadata writes — gateOrDefer("update_metadata", …), default Auto. The
 *    deferred intents are NOT durable-replayable across a restart (same accepted scope-out as
 *    send_keys, panes_rest.ts) — in-process Ask->confirm replays fine via the staged closure.
 *  - apply_prompt_template: capability "compose_draft" — UNGATED like update_draft_prompt
 *    (composing a draft is not a CLI write; server.ts:507 precedent).
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import type { PromptTemplate } from "../../types";
import { extractSlots, instantiateTemplate, valuesArrayToRecord } from "../../templates";

/** Stable template view (slots DERIVED from the body so they can never go stale). */
function templateView(t: PromptTemplate) {
  return {
    id: t.id,
    name: t.name,
    description: t.description ?? "",
    body: t.body,
    slots: extractSlots(t.body),
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// list_prompt_templates — GET /api/templates (READ; voice narrates, REST gets the raw array).
// ─────────────────────────────────────────────────────────────────────────────

const ListPromptTemplatesParams = z.object({});

export const listPromptTemplates: ActionDef<typeof ListPromptTemplatesParams> = {
  name: "list_prompt_templates",
  description:
    "List the saved prompt templates (name, description, and the {{slot}} parameters each one needs). Use this to find a template before apply_prompt_template or dispatch_to_panes.",
  params: ListPromptTemplatesParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: {
    method: "get",
    path: "/api/templates",
    // The UI consumes the raw array TOP-LEVEL (list_watch_rules precedent); voice reads `output`.
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? ((result.output as { templates?: unknown })?.templates ?? []) : [],
    }),
  },
  handler: (_args, ctx): ActionResult => {
    const templates = ctx.manager.ledger.promptTemplates.map(templateView);
    return { kind: "ok", output: { count: templates.length, templates } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// create_prompt_template — POST /api/templates (gated update_metadata, default Auto).
// ─────────────────────────────────────────────────────────────────────────────

const CreatePromptTemplateParams = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
  description: z.string().optional(),
});

export const createPromptTemplate: ActionDef<typeof CreatePromptTemplateParams> = {
  name: "create_prompt_template",
  description:
    "Save a reusable prompt template. The body may contain {{slot_name}} placeholders that are filled in when the template is applied (e.g. 'Review the {{branch}} branch focusing on {{focus}}').",
  params: CreatePromptTemplateParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/templates" },
  handler: (args, ctx): ActionResult => {
    const now = Date.now();
    const tpl: PromptTemplate = {
      id: "tpl_" + now.toString(36) + Math.random().toString(36).slice(2, 7),
      name: args.name,
      description: args.description,
      body: args.body,
      created_at: now,
      updated_at: now,
    };
    const createEffect = (): string => {
      ctx.manager.ledger.promptTemplates.push(tpl);
      ctx.manager.ledger["save"](true);
      ctx.broadcast({ type: "templates_updated", templates: ctx.manager.ledger.promptTemplates });
      const slots = extractSlots(tpl.body);
      return `Template '${tpl.name}' saved (id ${tpl.id})${slots.length ? ` with slots: ${slots.join(", ")}` : ""}.`;
    };
    const g = ctx.gateOrDefer(
      "update_metadata",
      null,
      `Save prompt template '${args.name}'`,
      createEffect,
      { ...(ctx.versionStamp ?? {}), origin: ctx.surface ?? "rest" }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'update_metadata' capability is gated Off; saving templates is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: createEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// update_prompt_template — PUT /api/templates/:template_id (gated update_metadata).
// ─────────────────────────────────────────────────────────────────────────────

const UpdatePromptTemplateParams = z.object({
  template_id: z.string(),
  name: z.string().optional(),
  body: z.string().optional(),
  description: z.string().optional(),
});

export const updatePromptTemplate: ActionDef<typeof UpdatePromptTemplateParams> = {
  name: "update_prompt_template",
  description: "Edit a saved prompt template's name, description, or body by its id.",
  params: UpdatePromptTemplateParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "put", path: "/api/templates/:template_id" },
  handler: (args, ctx): ActionResult => {
    const tpl = ctx.manager.ledger.promptTemplates.find((t) => t.id === args.template_id);
    if (!tpl) {
      // Unknown id -> ok narration BEFORE the gate (watch_rules Decision-2 precedent): no mutation,
      // no stage/forbid for a no-op.
      return { kind: "ok", output: `Template ${args.template_id} not found.` };
    }
    const updateEffect = (): string => {
      const t = ctx.manager.ledger.promptTemplates.find((x) => x.id === args.template_id);
      if (!t) return `Template ${args.template_id} not found.`;
      if (args.name !== undefined) t.name = args.name;
      if (args.body !== undefined) t.body = args.body;
      if (args.description !== undefined) t.description = args.description;
      t.updated_at = Date.now();
      ctx.manager.ledger["save"](true);
      ctx.broadcast({ type: "templates_updated", templates: ctx.manager.ledger.promptTemplates });
      return `Template '${t.name}' updated.`;
    };
    const g = ctx.gateOrDefer(
      "update_metadata",
      null,
      `Update prompt template '${tpl.name}'`,
      updateEffect,
      { ...(ctx.versionStamp ?? {}), origin: ctx.surface ?? "rest" }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'update_metadata' capability is gated Off; editing templates is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: updateEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// delete_prompt_template — DELETE /api/templates/:template_id (gated update_metadata).
// ─────────────────────────────────────────────────────────────────────────────

const DeletePromptTemplateParams = z.object({
  template_id: z.string(),
});

export const deletePromptTemplate: ActionDef<typeof DeletePromptTemplateParams> = {
  name: "delete_prompt_template",
  description: "Delete a saved prompt template by its id.",
  params: DeletePromptTemplateParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "delete", path: "/api/templates/:template_id" },
  handler: (args, ctx): ActionResult => {
    const idx = ctx.manager.ledger.promptTemplates.findIndex((t) => t.id === args.template_id);
    if (idx === -1) {
      return { kind: "ok", output: `Template ${args.template_id} not found.` };
    }
    const deleteEffect = (): string => {
      const i = ctx.manager.ledger.promptTemplates.findIndex((t) => t.id === args.template_id);
      if (i !== -1) {
        const [removed] = ctx.manager.ledger.promptTemplates.splice(i, 1);
        ctx.manager.ledger["save"](true);
        ctx.broadcast({ type: "templates_updated", templates: ctx.manager.ledger.promptTemplates });
        return `Template '${removed.name}' deleted.`;
      }
      return `Template ${args.template_id} not found.`;
    };
    const g = ctx.gateOrDefer(
      "update_metadata",
      null,
      `Delete prompt template ${args.template_id}`,
      deleteEffect,
      { ...(ctx.versionStamp ?? {}), origin: ctx.surface ?? "rest" }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'update_metadata' capability is gated Off; deleting templates is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: deleteEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// apply_prompt_template — POST /api/templates/:template_id/apply (compose_draft; UNGATED like
// update_draft_prompt — instantiates into the pane's WIP draft, never a PTY write).
// ─────────────────────────────────────────────────────────────────────────────

const ApplyPromptTemplateParams = z.object({
  template_id: z.string(),
  /** Target pane; defaults to the operator's open pane (activeDraftTarget). */
  pane_id: z.string().optional(),
  /** Slot fills: [{ name: "branch", value: "auth-fix" }, …]. */
  values: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  /** replace (default) or append onto the existing draft. */
  mode: z.enum(["replace", "append"]).optional(),
});

export const applyPromptTemplate: ActionDef<typeof ApplyPromptTemplateParams> = {
  name: "apply_prompt_template",
  description:
    "Instantiate a saved prompt template (filling its {{slot}} values) into a pane's WIP draft for the operator to review and send. This does NOT send anything — sending is the operator's action. If slot values are missing it asks instead of guessing.",
  params: ApplyPromptTemplateParams,
  capability: "compose_draft",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/templates/:template_id/apply" },
  handler: (args, ctx): ActionResult => {
    const tpl = ctx.manager.ledger.promptTemplates.find((t) => t.id === args.template_id || t.name === args.template_id);
    if (!tpl) {
      return { kind: "ok", output: `Template '${args.template_id}' not found. Use list_prompt_templates to see what is saved.` };
    }
    const { text, missing } = instantiateTemplate(tpl.body, valuesArrayToRecord(args.values));
    if (missing.length) {
      return {
        kind: "clarify",
        text: `Template '${tpl.name}' needs values for: ${missing.join(", ")}. Ask the operator for them, then call apply_prompt_template again with the values filled in.`,
      };
    }
    // Resolve the target draft: explicit pane_id (its owning project comes from the live terminal),
    // else the operator's open pane (the same activeDraftTarget update_draft_prompt uses).
    let target: { projectId: string; paneId: string } | null = null;
    if (args.pane_id) {
      const term = ctx.manager.terminals[args.pane_id];
      if (term?.projectId) target = { projectId: term.projectId, paneId: args.pane_id };
    } else {
      target = ctx.activeDraftTarget();
    }
    if (!target) {
      return {
        kind: "ok",
        output: args.pane_id
          ? `Pane '${args.pane_id}' is not running, so it has no draft to fill. Start it first, or omit pane_id to target the open pane.`
          : "No pane is open, so there is no draft to fill. Ask the operator to open a pane first.",
      };
    }
    if (args.mode === "append") ctx.manager.ledger.appendDraft(target.projectId, target.paneId, text, "janus");
    else ctx.manager.ledger.setDraft(target.projectId, target.paneId, text, "janus");
    ctx.broadcastDraft(target.projectId, target.paneId);
    return {
      kind: "ok",
      output: `Template '${tpl.name}' applied to pane '${target.paneId}' as its draft. The operator can review, edit, and send it.`,
    };
  },
};

/** The prompt-templates registry slice. */
export const TEMPLATES_ACTIONS: ActionDef[] = [
  listPromptTemplates,
  createPromptTemplate,
  updatePromptTemplate,
  deletePromptTemplate,
  applyPromptTemplate,
];
