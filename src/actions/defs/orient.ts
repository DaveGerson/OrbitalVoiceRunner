/**
 * src/actions/defs/orient.ts — ORIENT group (REG1 unified registry).
 *
 * FAITHFUL PORTS of the legacy server.ts voice-dispatch branches for the low-risk
 * "Orientation" tools. ZERO behavior change: each handler reproduces its legacy branch
 * byte-for-byte, including the exact operator-facing strings and broadcast frames.
 *
 * GATING: every branch in this group is UNGATED in server.ts today (none of them call
 * gateOrDefer / dispatchProposal / gateCapability). The survey's "central gate now runs"
 * notes are aspirational — the AUTHORITATIVE code does NOT gate, so these handlers do NOT
 * gate either. `capability` stays declared on each def for the matrix projection only.
 *
 *   rename_project   (server.ts:2750) — ungated: renameProject + ledger_updated + ok string
 *   rename_pane      (server.ts:2756) — ungated: renamePane + ledger_updated + ok string
 *   switch_context   (server.ts:2577) — ungated: switchContext + settings write + briefing
 *   create_project   (server.ts:2830) — ungated: isBadProjectDir guard (clarify) | addProject (ok)
 *   dismiss_attention(server.ts:2806) — ungated: queue mutate + prune + attention_updated frame
 *   set_voice_mute   (server.ts:2914) — ungated, VOICE-ONLY (Decision 3 allow-list residue)
 */

import { z } from "zod";
import type { ActionDef, ActionContext, ActionResult } from "../types";
import { isBadProjectDir, resolveProjectDir } from "../../projectDir";

// ─────────────────────────────────────────────────────────────────────────────
// rename_project — FAITHFUL PORT of server.ts:2750-2755 (UNGATED).
//   manager.ledger.renameProject(project_id, name) [silent no-op if id unknown];
//   broadcastLedgerUpdate(); answer once with { output: `Project renamed to ${name}` }.
// ─────────────────────────────────────────────────────────────────────────────
const RenameProjectParams = z.object({
  project_id: z.string(),
  name: z.string(),
});

export const renameProject: ActionDef<typeof RenameProjectParams> = {
  name: "rename_project",
  description: "Rename a project.",
  params: RenameProjectParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  // c55 Batch B: snake_case route param so Express injects :project_id onto the snake_case zod key.
  rest: { method: "put", path: "/api/projects/:project_id/rename" },
  handler: (args, ctx: ActionContext): ActionResult => {
    // PHASE 1 (deferrable-toggle honesty): rename_project was ungated; mirror delete_note's gateOrDefer
    // pattern (capability update_metadata, default Auto → silent unless tightened). op:"rename",
    // scope:"project" discriminants keep the durable intent in lockstep with src/actionEffects.ts.
    const renameEffect = (): string => {
      ctx.manager.ledger.renameProject(args.project_id, args.name);
      ctx.broadcastLedgerUpdate();
      return `Project renamed to ${args.name}`;
    };
    const g = ctx.gateOrDefer("update_metadata", null, `Rename project ${args.project_id} to ${args.name}`, renameEffect, {
      ...(ctx.versionStamp ?? {}),
      op: "rename",
      scope: "project",
      projectId: args.project_id,
      name: args.name,
    });
    if (g.disposition === "forbidden") {
      return { kind: "ok", output: `Error: the 'update_metadata' capability is gated Off; renaming is forbidden by policy.` };
    }
    if (g.disposition === "deferred") {
      return { kind: "ok", output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to rename the project.` };
    }
    return { kind: "ok", output: renameEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// rename_pane — FAITHFUL PORT of server.ts:2756-2761 (UNGATED).
//   manager.ledger.renamePane(project_id, pane_id, name) [silent no-op if missing];
//   broadcastLedgerUpdate(); answer once with { output: `Pane renamed to ${name}` }.
// ─────────────────────────────────────────────────────────────────────────────
const RenamePaneParams = z.object({
  project_id: z.string(),
  pane_id: z.string(),
  name: z.string(),
});

export const renamePane: ActionDef<typeof RenamePaneParams> = {
  name: "rename_pane",
  description: "Rename a pane.",
  params: RenamePaneParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  // c55 Batch B: snake_case route params so Express injects :project_id / :pane_id onto the zod keys.
  rest: { method: "put", path: "/api/projects/:project_id/panes/:pane_id/rename" },
  handler: (args, ctx: ActionContext): ActionResult => {
    // PHASE 1: gate rename_pane through update_metadata (default Auto → silent unless tightened),
    // mirroring delete_note. op:"rename", scope:"pane" discriminants keep the durable intent in
    // lockstep with src/actionEffects.ts.
    const renameEffect = (): string => {
      ctx.manager.ledger.renamePane(args.project_id, args.pane_id, args.name);
      ctx.broadcastLedgerUpdate();
      return `Pane renamed to ${args.name}`;
    };
    const g = ctx.gateOrDefer("update_metadata", args.pane_id, `Rename pane ${args.pane_id} to ${args.name}`, renameEffect, {
      ...(ctx.versionStamp ?? {}),
      op: "rename",
      scope: "pane",
      projectId: args.project_id,
      paneId: args.pane_id,
      name: args.name,
    });
    if (g.disposition === "forbidden") {
      return { kind: "ok", output: `Error: the 'update_metadata' capability is gated Off; renaming is forbidden by policy.` };
    }
    if (g.disposition === "deferred") {
      return { kind: "ok", output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to rename the pane.` };
    }
    return { kind: "ok", output: renameEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// switch_context — FAITHFUL PORT of server.ts:2577-2588 (UNGATED).
// Ordered side effects, then a briefing payload. The settings.activeContext /
// localWorkspacePath writes are UNCONDITIONAL even when switchContext no-ops on an
// unknown id (ASYMMETRY HAZARD — preserved exactly, do NOT "fix"). getProjectBriefing
// returns null for an unknown id, so the inline { error: "Project not found" } fallback
// is the OK output payload (still kind:"ok" on the wire — NOT an ActionResult error).
// ─────────────────────────────────────────────────────────────────────────────
const SwitchContextParams = z.object({
  project_id: z.string(),
});

export const switchContext: ActionDef<typeof SwitchContextParams> = {
  name: "switch_context",
  description:
    "Make a project the active focus. Returns a fresh project briefing (summary, directory, panes, notes) and backgrounds the previous project.",
  params: SwitchContextParams,
  capability: "switch_context",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  // c55 Batch B: snake_case route param so Express injects :project_id onto the snake_case zod key.
  rest: { method: "post", path: "/api/projects/:project_id/switch" },
  handler: (args, ctx: ActionContext): ActionResult => {
    const projectId = args.project_id;
    ctx.manager.ledger.switchContext(projectId);
    ctx.manager.settings.projects.activeContext = projectId;
    const wsPath = ctx.manager.ledger.workspaces[projectId]?.directory || process.cwd();
    ctx.manager.settings.projects.localWorkspacePath = wsPath;
    ctx.manager.saveSettings();
    ctx.broadcastLedgerUpdate();
    // Phase 1 "ears" (fact [E]): getProjectBriefing reads ws.panes, which is only as fresh as
    // the last syncLedger(). Force a live PTY->ledger sync FIRST so the catch-up briefing
    // reflects each pane's CURRENT status/is_busy (e.g. a pane that just went Running or Idle)
    // instead of a stale snapshot. listPanes() already does this on every call; switch_context
    // now matches. Added AFTER the unconditional settings writes / broadcastLedgerUpdate so the
    // ordered side effects (the ASYMMETRY HAZARD above) are untouched — only the briefing read
    // is made non-stale.
    ctx.manager.refreshLedger();
    // Memory Synthesis P0a (freshness trigger): the explicit "catch me up" path. After the live
    // sync, request a FRESH situational brief for the now-active pane so Gemini Live re-focuses on
    // the switched project instead of drifting on the prior snapshot. Additive + non-blocking — the
    // server wires injectMemoryBrief on the voice ctx; absent on REST/test paths (safe no-op). The
    // injector owns its own try/catch, so this never throws into the action path.
    ctx.injectMemoryBrief?.();
    const briefing = ctx.manager.ledger.getProjectBriefing(projectId) || { error: "Project not found" };
    return { kind: "ok", output: briefing };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// create_project — FAITHFUL PORT of server.ts:2830-2848 (UNGATED).
// G5 guard: isBadProjectDir(directory) -> spoken rejection (no persistence). The legacy
// branch answers ONCE with ONLY { output: "<rejection string>" } — NO status field. It is
// kind:"ok" (a plain narrated error the model reads back), NOT kind:"clarify": clarify maps
// to { status:"clarify", output } (§9), which would add a spurious `status` the legacy wire
// never emitted and break the create_project.bad_dir golden. (REG1 phase-C: this was a latent
// mis-classification in the port, surfaced once the registry path exercised it.)
// Else: addProject(resolveProjectDir(directory), summary||"", key_terms||[]) [no-op if
// id exists]; broadcastLedgerUpdate(); ok with the created-successfully string.
// isBadProjectDir/resolveProjectDir are MODULE imports (src/projectDir), NOT ctx closures.
//
// c55.16 — converges the inline app.post("/api/projects", …) so it can be deleted. Two additions:
//   (1) optional `name` param + a SECOND ledger mutation: after addProject, iff a truthy `name` was
//       supplied, ledger.renameProject(project_id, name). addProject initializes name=id and has no
//       name param, and is a no-op when the id exists, so the display name can ONLY be set by the
//       separate renameProject — genuinely a 2nd op, but PURE ledger (no connection scope), so the
//       registry handler runs both, then broadcasts ONE ledger_updated frame (identical to inline).
//   (2) coerceArgs — the UI POSTs { id, name, directory, summary, keyTerms } (camelCase `id`/`keyTerms`
//       + `name`). The strict-strip zod schema would DROP an un-aliased `id`, leaving project_id
//       undefined -> zod 500. coerceArgs (runs BEFORE params.parse) aliases id->project_id /
//       keyTerms->key_terms ONLY WHEN the snake key is absent, so a voice call carrying
//       project_id/key_terms is never clobbered (preserves the create_project / .bad_dir goldens,
//       which send snake_case and never name/id). `name` passes straight through (now a schema field).
// Accepted, client-invisible body deltas (App.tsx:1762-1773 reads NO response field, repaints via
//   handleSwitchProject -> fetchLedger/fetchTerminals + the ledger_updated WS frame):
//   - happy path: inline 200 { success:true } -> 200 { output:"Project context <id> created…" };
//   - malformed direct call (no id): inline 400 -> zod 500 (project_id Required) — same accepted
//     class as create_pane's inline-400 -> zod-500 delta.
// ─────────────────────────────────────────────────────────────────────────────
const CreateProjectParams = z.object({
  project_id: z.string(),
  directory: z.string().optional(),
  summary: z.string().optional(),
  key_terms: z.array(z.string()).optional(),
  name: z.string().optional(), // c55.16: optional display name -> post-create rename (2nd mutation)
});

export const createProject: ActionDef<typeof CreateProjectParams> = {
  name: "create_project",
  description: "Create a new project workspace directory context block.",
  params: CreateProjectParams,
  capability: "create_project",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/projects" },
  // c55.16: alias the UI's camelCase body onto the snake_case zod keys, but ONLY when the snake key
  // is absent so a voice call (project_id / key_terms) is never clobbered. `name` passes straight
  // through. Mirrors the Batch-D apply_orchestration_recipe coerceArgs precedent (orchestration.ts).
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.project_id == null && out.id != null) out.project_id = out.id;
    if (out.key_terms == null && out.keyTerms != null) out.key_terms = out.keyTerms;
    delete out.id;
    delete out.keyTerms;
    return out;
  },
  handler: (args, ctx: ActionContext): ActionResult => {
    const { project_id, directory, summary, key_terms, name } = args;
    // G5: reject a non-existent caller-supplied directory before persisting it
    // (a bad dir later taints every child pane's cwd). Blank/"." resolves to the
    // server cwd. The rejection is a spoken-friendly tool response so the model
    // can re-prompt the operator.
    if (isBadProjectDir(directory)) {
      return {
        kind: "ok",
        output: `Error: the directory '${String(directory).trim()}' does not exist, so I did not create project ${project_id}. Give me a folder that exists, or omit it to use the current workspace.`,
      };
    }
    // PHASE 1 (deferrable-toggle honesty): create_project was ungated; the capability row exists
    // (default Auto). Route BOTH mutations + broadcast through ctx.gateOrDefer so the toggle is real.
    // Default Auto → no behavior change unless the operator tightens it (Ask → confirm, Off → refuse).
    // The DIRECTORY is resolved BEFORE the gate (the bad-dir clarify above already ran) so the staged
    // intent carries the resolved path, not the raw input.
    const resolvedDir = resolveProjectDir(directory);
    const createEffect = (): string => {
      ctx.manager.ledger.addProject(project_id, resolvedDir, summary || "", key_terms || []); // MUTATION 1
      if (name) {
        ctx.manager.ledger.renameProject(project_id, name); // MUTATION 2 (conditional) — c55.16 post-create rename
      }
      ctx.broadcastLedgerUpdate(); // ONE ledger_updated frame after BOTH mutations
      return `Project context ${project_id} created successfully.`;
    };
    // PHASE 1: persist the create INTENT so a deferred create survives a restart and rebuilds the SAME
    // effect on confirm. Keys in lockstep with src/actionEffects.ts CreateProjectParams.
    const g = ctx.gateOrDefer("create_project", null, `Create project ${project_id}`, createEffect, {
      ...(ctx.versionStamp ?? {}),
      projectId: project_id,
      directory: resolvedDir,
      summary: summary || "",
      keyTerms: key_terms || [],
      ...(name ? { name } : {}),
    });
    if (g.disposition === "forbidden") {
      return { kind: "ok", output: `Error: the 'create_project' capability is gated Off; creating projects is forbidden by policy.` };
    }
    if (g.disposition === "deferred") {
      return { kind: "ok", output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to create the project.` };
    }
    return { kind: "ok", output: createEffect() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// dismiss_attention — FAITHFUL PORT of server.ts:2806-2829 (UNGATED).
// id provided + found -> dismiss it, "Dismissed attention item ${id}."
// id provided + NOT found -> NO mutation, "No attention item found with id ${id}." (still ok)
// id omitted -> count undismissed (BEFORE mass dismiss), forEach dismiss, "Dismissed all
//   ${count} pending attention item${count===1?'':'s'}."
// THEN unconditionally: pruneAttention(); broadcast { type:"attention_updated", queue }.
// ─────────────────────────────────────────────────────────────────────────────
const DismissAttentionParams = z.object({
  id: z.string().optional(),
});

export const dismissAttention: ActionDef<typeof DismissAttentionParams> = {
  name: "dismiss_attention",
  description:
    "Dismiss one attention item by its id (or all items if id is omitted) once the operator has acknowledged it, so it stops appearing in the digest and proactive notifications.",
  params: DismissAttentionParams,
  capability: "dismiss_attention",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/attention/:id/dismiss" },
  handler: (args, ctx: ActionContext): ActionResult => {
    const targetId = args.id;
    let output: string;
    if (targetId) {
      const item = ctx.manager.attentionQueue.find((i) => i.id === targetId);
      if (item) {
        item.dismissed = true;
        output = `Dismissed attention item ${targetId}.`;
      } else {
        output = `No attention item found with id ${targetId}.`;
      }
    } else {
      const count = ctx.manager.attentionQueue.filter((i) => !i.dismissed).length;
      ctx.manager.attentionQueue.forEach((i) => (i.dismissed = true));
      output = `Dismissed all ${count} pending attention item${count === 1 ? "" : "s"}.`;
    }
    ctx.pruneAttention();
    ctx.broadcast({ type: "attention_updated", queue: ctx.manager.attentionQueue });
    return { kind: "ok", output };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// set_voice_mute — FAITHFUL PORT of server.ts:2914-2924 (UNGATED, VOICE-ONLY).
// Decision 3 / permanent allow-list residue: this IS the mic toggle, no REST/WS twin.
// surfaces MUST be exactly new Set(["voice"]) (drives the Phase-C INTENTIONAL_ASYMMETRY
// allow-list entry coverage.ts earmarks). settings_updated MUST use sanitizeSettingsForClient
// so the broadcast never leaks secrets.geminiApiKey.
// ─────────────────────────────────────────────────────────────────────────────
const SetVoiceMuteParams = z.object({
  muted: z.boolean(),
});

export const setVoiceMute: ActionDef<typeof SetVoiceMuteParams> = {
  name: "set_voice_mute",
  description: "Set microphone muted status.",
  params: SetVoiceMuteParams,
  capability: "set_voice_mute",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx: ActionContext): ActionResult => {
    const { muted } = args;
    ctx.manager.settings.voiceAi.isMicMuted = muted;
    ctx.manager.saveSettings();
    ctx.broadcast({
      type: "settings_updated",
      settings: ctx.sanitizeSettingsForClient(ctx.manager.settings),
    });
    return { kind: "ok", output: `Microphone now ${muted ? "muted" : "active-listening"}.` };
  },
};

/** The ORIENT group's canonical defs (aggregated into REGISTRY in Phase C). */
export const ORIENT_ACTIONS: ActionDef[] = [
  renameProject,
  renamePane,
  switchContext,
  createProject,
  dismissAttention,
  setVoiceMute,
];
