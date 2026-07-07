/**
 * src/actions/defs/macros.ts — VOICE MACROS CRUD (8fz.6): list / define / delete.
 *
 * Macros are named phrases mapping to an ordered group of per-pane instructions, persisted on the
 * ledger as a self-persisting document array (`macros` — same kv/Proxy shape as promptTemplates).
 * They are FIRED by a routed utterance (matched in src/voice/index.ts, expanded through the
 * dispatch_group forceStage kernel), never by a Gemini tool call.
 *
 * OPERATOR DECISION (2026-07-06): authoring is REST + Pass-view UI CRUD ONLY — voice can FIRE a macro
 * but can never DEFINE or MODIFY one. So NONE of these defs expose the "voice" surface; there is no
 * voice-surface define/delete verb. This mirrors the templates GATING precedent otherwise:
 *   - list_macros:   READ — capability "read_notes", readOnly:true (redacted on the way out).
 *   - define/delete: metadata writes — gateOrDefer("update_metadata", …), default Auto.
 *
 * SAFETY: define_macro REJECTS a phrase that parses as an approval/reject/defer intent or a reserved
 * wake / emergency-brake / spoken-confirm word (validateMacroPhrase), so a macro can never shadow
 * "approve"/"yes" during a pending destructive confirm.
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import type { Macro } from "../../macros";
import { validateMacroPhrase, newMacroId } from "../../macros";

/** Stable macro view for the REST/UI surface. */
function macroView(m: Macro) {
  return {
    id: m.id,
    phrase: m.phrase,
    name: m.name,
    steps: m.steps.map((s) => ({ pane_name: s.paneName, instruction: s.instruction })),
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// list_macros — GET /api/macros (READ; REST/UI only).
// ─────────────────────────────────────────────────────────────────────────────

const ListMacrosParams = z.object({});

export const listMacros: ActionDef<typeof ListMacrosParams> = {
  name: "list_macros",
  description:
    "List the saved voice macros (phrase, name, and the ordered per-pane steps each fires). Management surface — macros are fired by speaking their phrase, not by calling a tool.",
  params: ListMacrosParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/macros",
    // The UI consumes the raw array TOP-LEVEL (list_prompt_templates precedent).
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? ((result.output as { macros?: unknown })?.macros ?? []) : [],
    }),
  },
  handler: (_args, ctx): ActionResult => {
    const macros = ctx.manager.ledger.macros.map(macroView);
    return { kind: "ok", output: { count: macros.length, macros } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// define_macro — POST /api/macros (gated update_metadata; phrase validated first).
// ─────────────────────────────────────────────────────────────────────────────

const MacroStepParams = z.object({
  pane_name: z.string().min(1),
  instruction: z.string().min(1),
});

const DefineMacroParams = z.object({
  name: z.string().min(1),
  phrase: z.string().min(1),
  steps: z.array(MacroStepParams).min(1),
});

export const defineMacro: ActionDef<typeof DefineMacroParams> = {
  name: "define_macro",
  description:
    "Save a voice macro: a spoken phrase that fans out to an ordered group of per-pane instructions. Firing stages one pending approval per step (never auto-runs). Authoring is REST/UI only.",
  params: DefineMacroParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/macros" },
  handler: (args, ctx): ActionResult => {
    // Phrase validation FIRST (before the gate): a phrase that would shadow a voice approval / a
    // reserved command is refused outright — 403 on REST.
    const check = validateMacroPhrase(args.phrase);
    // `check.ok === false` (not `!check.ok`) — TS narrows the discriminant reliably on the explicit
    // comparison (the focusResolver bindFocus precedent).
    if (check.ok === false) return { kind: "blocked", reason: check.reason };

    const now = Date.now();
    const macro: Macro = {
      id: newMacroId(now),
      phrase: args.phrase,
      name: args.name,
      steps: args.steps.map((s) => ({ paneName: s.pane_name, instruction: s.instruction })),
      created_at: now,
      updated_at: now,
    };
    const createEffect = (): string => {
      ctx.manager.ledger.macros.push(macro);
      ctx.manager.ledger["save"](true);
      ctx.broadcast({ type: "macros_updated", macros: ctx.manager.ledger.macros });
      return `Macro '${macro.name}' saved (id ${macro.id}) with ${macro.steps.length} step(s).`;
    };
    const g = ctx.gateOrDefer(
      "update_metadata",
      null,
      `Save voice macro '${args.name}'`,
      createEffect,
      { ...(ctx.versionStamp ?? {}), origin: ctx.surface ?? "rest" }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'update_metadata' capability is gated Off; saving macros is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: createEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// delete_macro — DELETE /api/macros/:macro_id (gated update_metadata).
// ─────────────────────────────────────────────────────────────────────────────

const DeleteMacroParams = z.object({
  macro_id: z.string(),
});

export const deleteMacro: ActionDef<typeof DeleteMacroParams> = {
  name: "delete_macro",
  description: "Delete a saved voice macro by its id.",
  params: DeleteMacroParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/macros/:macro_id" },
  handler: (args, ctx): ActionResult => {
    const idx = ctx.manager.ledger.macros.findIndex((m) => m.id === args.macro_id);
    if (idx === -1) {
      // Unknown id -> ok narration BEFORE the gate (no mutation, no stage/forbid for a no-op).
      return { kind: "ok", output: `Macro ${args.macro_id} not found.` };
    }
    const deleteEffect = (): string => {
      const i = ctx.manager.ledger.macros.findIndex((m) => m.id === args.macro_id);
      if (i !== -1) {
        const [removed] = ctx.manager.ledger.macros.splice(i, 1);
        ctx.manager.ledger["save"](true);
        ctx.broadcast({ type: "macros_updated", macros: ctx.manager.ledger.macros });
        return `Macro '${removed.name}' deleted.`;
      }
      return `Macro ${args.macro_id} not found.`;
    };
    const g = ctx.gateOrDefer(
      "update_metadata",
      null,
      `Delete voice macro ${args.macro_id}`,
      deleteEffect,
      { ...(ctx.versionStamp ?? {}), origin: ctx.surface ?? "rest" }
    );
    if (g.disposition === "forbidden") {
      return { kind: "blocked", reason: "Error: the 'update_metadata' capability is gated Off; deleting macros is forbidden by policy." };
    }
    if (g.disposition === "deferred") {
      return { kind: "pending", messageId: g.actionId, summary: g.summary };
    }
    return { kind: "ok", output: deleteEffect() };
  },
};

/** The voice-macros registry slice. */
export const MACROS_ACTIONS: ActionDef[] = [listMacros, defineMacro, deleteMacro];
