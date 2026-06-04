/**
 * src/actions/defs/panes_write.ts — REG1 group PANES_WRITE.
 *
 * Three pane-mutating voice tools, FAITHFULLY PORTED from their legacy server.ts dispatch branches
 * (handler-owned gating, zero behavior change):
 *   - switch_active_pane   (server.ts:2613) — UNGATED focus move. Mutates the active-pane source of
 *                          truth via ctx.setActivePane; broadcasts {type:'switch_active_pane'}.
 *   - update_draft_prompt  (server.ts:2633) — UNGATED draft compose. Writes the ledger draft column
 *                          (never a PTY) via ctx.activeDraftTarget()/manager.ledger + ctx.broadcastDraft.
 *   - create_pane          (server.ts:2849) — THE KEYSTONE. GATED via ctx.gateOrDefer (durable
 *                          Ask-defer, capability "create_pane"). The launch command is DERIVED on the
 *                          server from the (normalized) tool_preset via presetCommand(normalizePreset())
 *                          — the single launch-derivation home in ../terminal. The zod schema carries a
 *                          .refine so a free-form `command` is accepted ONLY for the Custom preset
 *                          (registry-spec §5.4 / tests/test_action_create_pane.ts 17c-voice). The
 *                          gateOrDefer params bag matches buildActionRun's create_pane case
 *                          (CreatePaneParams: paneId/cwd/command/toolPreset/permissionsMode/projectId/origin)
 *                          in src/actionEffects.ts EXACTLY, so a deferred-then-confirmed create survives
 *                          a restart.
 *
 * propose_command (the other PANES_WRITE-adjacent dispatchProposal tool) is ALREADY in registry.ts.
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import { normalizePreset, presetCommand } from "../../terminal";

// ─────────────────────────────────────────────────────────────────────────────
// switch_active_pane — UNGATED focus move (server.ts:2613-2632).
// ─────────────────────────────────────────────────────────────────────────────

/** switch_active_pane params (server.ts FunctionDeclaration: { pane_id: STRING, required }). */
const SwitchActivePaneParams = z.object({
  pane_id: z.string(),
});

/**
 * switch_active_pane — FAITHFUL PORT of server.ts:2613-2632. Changes which pane is OPEN (the active
 * pane), the single source of truth propose_command / deliver_handoff read before a write. It is
 * UNGATED in the legacy branch (it always switches) — the handler does NOT call any gate. If the pane
 * does not exist (no live terminal AND not in the active project's panes), it returns the failure text
 * in `output` (an ok-shaped response, NOT error/blocked) and mutates nothing. Otherwise it sets the
 * active pane via ctx.setActivePane(targetId), broadcasts {type:'switch_active_pane',paneId}, and
 * returns the confirm string. It writes NO command.
 */
export const switchActivePane: ActionDef<typeof SwitchActivePaneParams> = {
  name: "switch_active_pane",
  description:
    "Change which pane is open on the operator's screen. Call this ONLY when the operator directs you to ('switch to the build pane', 'open the test pane'). You can only propose commands to the pane the operator currently has OPEN — if you need to act on a different pane, switch to it first (with the operator's go-ahead). This changes focus only; it never runs a command.",
  params: SwitchActivePaneParams,
  capability: "focus_pane",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    const targetId = args.pane_id;
    const term = ctx.manager.terminals[targetId];
    const wsProj = ctx.manager.ledger.getActiveProject();
    const paneExists = !!term || !!(wsProj && wsProj.panes[targetId]);
    let output = "";
    if (!paneExists) {
      output = `Cannot switch: pane '${targetId}' does not exist.`;
    } else {
      ctx.setActivePane(targetId);
      ctx.broadcast({ type: "switch_active_pane", paneId: targetId });
      output = `Opened pane '${targetId}'. It is now the active pane; I can propose commands here for your approval.`;
    }
    return { kind: "ok", output };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// update_draft_prompt — UNGATED draft compose (server.ts:2633-2650).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * update_draft_prompt params (server.ts FunctionDeclaration: { text: STRING required, mode: enum opt }).
 * `text` is coerced via String(args.text ?? "") in the handler (empty is a valid clearing replace).
 * `mode` defaults to "replace" for any non-"append" / omitted value — handled in the handler.
 */
const UpdateDraftPromptParams = z.object({
  text: z.string(),
  mode: z.enum(["replace", "append"]).optional(),
});

/**
 * update_draft_prompt — FAITHFUL PORT of server.ts:2633-2650. Composes/refines the WIP draft prompt
 * for the OPERATOR to review and send (it never sends, never writes a PTY). Targets the ACTIVE pane
 * only (no pane_id param). UNGATED in the legacy branch — composing a draft is not a CLI write
 * (server.ts:507) — so the handler does NOT call any gate. When no pane is open
 * (ctx.activeDraftTarget() === null) it returns the no-pane text and writes nothing. Otherwise it
 * writes the ledger draft column (set/append) and re-broadcasts the draft via ctx.broadcastDraft.
 */
export const updateDraftPrompt: ActionDef<typeof UpdateDraftPromptParams> = {
  name: "update_draft_prompt",
  description:
    "Compose or refine the WIP draft prompt for the pane the operator currently has open, so they can review/edit and send it. This does NOT send anything — sending is the operator's action. Use it to distill the conversation into a clean, focused prompt for the agent in that pane. Defaults to replacing the draft; use mode='append' to add to it.",
  params: UpdateDraftPromptParams,
  capability: "compose_draft",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    const t = ctx.activeDraftTarget();
    let output = "";
    if (!t) {
      output = "No pane is open, so there is no draft to write. Ask the operator to open a pane first.";
    } else {
      const mode = args.mode === "append" ? "append" : "replace";
      const text = String(args.text ?? "");
      if (mode === "append") ctx.manager.ledger.appendDraft(t.projectId, t.paneId, text, "janus");
      else ctx.manager.ledger.setDraft(t.projectId, t.paneId, text, "janus");
      ctx.broadcastDraft(t.projectId, t.paneId);
      output = `Draft for pane '${t.paneId}' updated (${mode}). The operator can review and send it.`;
    }
    return { kind: "ok", output };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// create_pane — THE KEYSTONE. GATED via ctx.gateOrDefer (server.ts:2849-2886).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * create_pane params (server.ts FunctionDeclaration: project_id/pane_id/tool_preset required;
 * permissions_mode optional). REG1 KEYSTONE ADDITION: an OPTIONAL free-form `command` field, GUARDED
 * by a zod .refine so it is accepted ONLY when normalizePreset(tool_preset) === "Custom"
 * (registry-spec §5.4; un-skips tests/test_action_create_pane.ts 17c-voice). For non-Custom presets
 * the command is always DERIVED server-side via presetCommand — the model can no longer free-form a
 * launch command for an agent preset.
 *
 * tool_preset accepts both preset .ids (claudeCode/codex/antigravity), union display names
 * (Claude Code/Codex/Antigravity), and Custom; normalizePreset() collapses any of them onto the
 * addTerminal union server-side.
 */
const CreatePaneParamsSchema = z
  .object({
    project_id: z.string(),
    pane_id: z.string(),
    tool_preset: z.enum([
      "claudeCode",
      "codex",
      "antigravity",
      "Claude Code",
      "Codex",
      "Antigravity",
      "Custom",
    ]),
    permissions_mode: z.enum(["Full Auto", "Human-in-the-Loop", "Read-Only"]).optional(),
    command: z.string().optional(),
  })
  .superRefine((a, ctx) => {
    // §5.4 keystone guardrail. The free-form `command` field is the Custom escape hatch ONLY:
    //   - Custom     => command is OPTIONAL. Provided + non-empty => the launch the model/operator
    //                   owns (e.g. "htop"); OMITTED => the bare defaultShellCommand is derived
    //                   server-side (the established U4 "just give me a shell pane" behavior,
    //                   tests/test_voice_tools.ts "Custom derives defaultShellCommand"). Custom is the
    //                   shell preset; requiring a command would break the common voice "open a shell".
    //   - non-Custom => command MUST be absent/undefined. The launch is DERIVED server-side via
    //                   presetCommand; the model cannot override an agent preset's command. THIS is the
    //                   real guardrail (the model cannot free-form claude/codex/antigravity).
    if (normalizePreset(a.tool_preset) !== "Custom" && a.command !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a free-form command is only allowed for the Custom preset",
        path: ["command"],
      });
    }
  });

/**
 * create_pane — FAITHFUL PORT of the voice branch (server.ts:2849-2886). DETERMINISTIC launch:
 * tool_preset is the single source of truth. normalizePreset() collapses id/name/union onto the
 * addTerminal union; presetCommand() derives the launch command from the (normalized) preset using
 * the configured presets + defaultShellCommand — the single launch-derivation home in ../terminal
 * (NOT inlined). For the Custom preset a non-empty client `command` is honored (the REST Custom escape
 * hatch at server.ts:884, now mirrored on voice per REG1 §5.4); every non-Custom preset derives and
 * IGNORES any client-supplied command.
 *
 * GATED via ctx.gateOrDefer("create_pane", pane_id, summary, createPaneEffect, intentParams):
 *   - forbidden -> { output: "Error: the 'create_pane' capability is gated Off; pane creation is
 *                    forbidden by policy." } (verbatim — returned as kind:"ok" so the operator-facing
 *                    string is byte-identical to the legacy wire frame).
 *   - deferred  -> { output: `'${summary}' needs operator confirmation (gated Ask). I've queued it —
 *                    confirm to create the pane.` } (verbatim — kind:"ok").
 *   - run       -> { output: createPaneEffect() } (kind:"ok").
 *
 * The 5th gateOrDefer arg is the kzt serializable restart-intent. Its keys are in LOCKSTEP with
 * buildActionRun's create_pane case (CreatePaneParams) in src/actionEffects.ts: origin:"voice" (so the
 * rebuild returns the voice-shaped `Pane … created under project …. Result: …` string),
 * paneId/cwd/command/toolPreset/permissionsMode/projectId — carrying the DERIVED command + NORMALIZED
 * preset so a confirm-after-restart rebuilds the same agent. createPaneEffect auto-creates the project
 * if missing, spawns the PTY via manager.addTerminal (with the derived command + normalized preset),
 * then fans out broadcastLedgerUpdate() + broadcastTerminalsUpdated() (the voice surface broadcasts
 * postures; the REST surface — a separate code path — broadcasts a bare frame).
 */
export const createPane: ActionDef<typeof CreatePaneParamsSchema> = {
  name: "create_pane",
  description:
    "Create a new terminal pane inside a project and start its agent. For an agent preset (Claude Code / Codex / Antigravity) the command line is DERIVED on the server from tool_preset — do NOT pass command. ONLY for the Custom preset may you pass a free-form `command` (e.g. 'htop'); omit it to open a bare shell.",
  params: CreatePaneParamsSchema,
  capability: "create_pane",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/terminals" },
  handler: (args, ctx): ActionResult => {
    const { project_id, pane_id, tool_preset, permissions_mode } = args;
    const preset = normalizePreset(tool_preset);
    // Derive the launch command from the normalized preset (single home: ../terminal). For the Custom
    // preset honor a non-empty client command (REG1 §5.4 / REST escape hatch); otherwise derive.
    const clientCommand = (args.command ?? "").trim();
    const command =
      preset === "Custom" && clientCommand !== ""
        ? args.command!
        : presetCommand(preset, ctx.manager.settings.presets, ctx.manager.settings.advanced?.defaultShellCommand);

    const createPaneEffect = (): string => {
      if (!ctx.manager.ledger.getProject(project_id)) {
        ctx.manager.ledger.addProject(project_id, ".", "Co-created with pane");
      }
      const result = ctx.manager.addTerminal(
        pane_id,
        ctx.manager.ledger.workspaces[project_id]?.directory || process.cwd(),
        command,                                // derived from the preset, not the model
        preset,                                 // normalized union (was tool_preset || "Custom")
        permissions_mode || "Human-in-the-Loop",
        "",
        project_id
      );
      ctx.broadcastLedgerUpdate();
      ctx.broadcastTerminalsUpdated();
      return `Pane ${pane_id} created under project ${project_id}. Result: ${result}`;
    };

    const g = ctx.gateOrDefer(
      "create_pane",
      pane_id ?? null,
      `Create pane ${pane_id} (${command}) in ${project_id}`,
      createPaneEffect,
      // kzt: serializable restart-intent. origin:"voice" -> the rebuild returns the voice-shaped
      // string. Keys in LOCKSTEP with buildActionRun's CreatePaneParams (src/actionEffects.ts).
      {
        ...(ctx.versionStamp ?? {}),
        origin: "voice",
        paneId: pane_id,
        cwd: ctx.manager.ledger.workspaces[project_id]?.directory,
        command,
        toolPreset: preset,
        permissionsMode: permissions_mode,
        projectId: project_id,
      }
    );

    if (g.disposition === "forbidden") {
      return {
        kind: "ok",
        output: `Error: the 'create_pane' capability is gated Off; pane creation is forbidden by policy.`,
      };
    }
    if (g.disposition === "deferred") {
      return {
        kind: "ok",
        output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to create the pane.`,
      };
    }
    return { kind: "ok", output: createPaneEffect() };
  },
};

/** The PANES_WRITE group registry slice. */
export const PANES_WRITE_ACTIONS: ActionDef[] = [
  switchActivePane,
  updateDraftPrompt,
  createPane,
];
