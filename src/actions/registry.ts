/**
 * src/actions/registry.ts — the canonical ActionDef[] (REG1 PHASE A: a SMALL PROOF registry).
 *
 * This phase proves the SHAPE, not the full migration. Only four tools are migrated, chosen to
 * exercise every limb of the runAction wrapper:
 *   - stop_all / confirm_stop_all / release_stop_all — the emergency brake. capability ALWAYS_ALLOWED
 *     (bypasses the gate, even while frozen), empty params, surfaces voice+rest+ws (the one group
 *     wired identically across all three surfaces today — §4.2 Group 8, the template the registry
 *     generalizes).
 *   - list_panes — a READ. capability read_pane (default Auto), readOnly:true (so its output is
 *     redacted on the way out), empty params, surfaces voice+rest (voice tool + GET /api/terminals).
 *
 * Handlers here are THIN: they call ctx.manager / ctx.broadcast and return an ActionResult. The
 * heavy brake logic (stopAll/releaseStopAll, the `frozen` flag) lives in server.ts closures that are
 * NOT yet on ActionContext; this phase does not swap the dispatch (that is Phase C), so the brake
 * handlers here return a proof ok-result and broadcast the same frames the real handlers do. The
 * other 37 tools — and the full brake wiring — land in Phase B.
 */

import { z } from "zod";
import type { ActionDef, ActionResult } from "./types";
import type { ApprovalKind } from "../pendingApprovals";
import { ALWAYS_ALLOWED } from "./types";
// Phase-B grouped ActionDefs (one file per capability domain, src/actions/defs/*).
import { READS_ACTIONS } from "./defs/reads";
import { NOTES_ACTIONS } from "./defs/notes";
import { PANES_WRITE_ACTIONS } from "./defs/panes_write";
import { PANES_REST_ACTIONS } from "./defs/panes_rest";
import { ORIENT_ACTIONS } from "./defs/orient";
import { LOCKS_ACTIONS } from "./defs/locks";
import { ORCH_ACTIONS } from "./defs/orchestration";
import { HANDOFF_ACTIONS } from "./defs/handoff";
import { OBSERVABILITY_ACTIONS } from "./defs/observability";
import { WATCH_RULES_ACTIONS } from "./defs/watch_rules";

/** Empty-params schema shared by the brake trio + list_panes (pins §8.2 #8 -> properties {}). */
const NoParams = z.object({});

export const stopAll: ActionDef<typeof NoParams> = {
  name: "stop_all",
  description:
    "EMERGENCY BRAKE Stage 1 (always allowed): freeze Janus (every capability becomes Off) and cancel everything in flight. Panes KEEP RUNNING. Call IMMEDIATELY on 'stop', 'halt', 'abort', 'freeze', or 'stop everything'.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["voice", "rest", "ws"]),
  rest: { method: "post", path: "/api/stop-all" },
  handler: async (_args, ctx): Promise<ActionResult> => {
    // Stage 1: freeze + cancel-in-flight via the real injected brake closure (it broadcasts the
    // `frozen` frame itself). running = the still-alive pane names, which we narrate back.
    const running = await ctx.stopAll(false);
    const output = running.length
      ? `I've frozen myself and cancelled everything in flight. ${running.length} pane(s) are still running (${running.join(", ")}). Should I also kill them? That can't be undone — say "kill them" to confirm, or "release" to resume.`
      : `I've frozen myself and cancelled everything in flight. No panes are running, so there's nothing to kill. Say "release" when you want to resume.`;
    return { kind: "ok", output };
  },
};

export const confirmStopAll: ActionDef<typeof NoParams> = {
  name: "confirm_stop_all",
  description:
    "EMERGENCY BRAKE Stage 2 (always allowed): the deliberate, irreversible kill of running panes. Only valid while frozen-awaiting-confirm. Call on a spoken 'kill them' / 'yes' after stop_all.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["voice", "rest", "ws"]),
  rest: { method: "post", path: "/api/stop-all/confirm" },
  handler: async (_args, ctx): Promise<ActionResult> => {
    // Stage 2: only valid while frozen-awaiting-confirm. killed = the pane names actually killed.
    if (!ctx.isFrozen()) {
      return { kind: "ok", output: "There's nothing to confirm — I'm not frozen. Say \"stop everything\" first if you want to halt." };
    }
    const killed = await ctx.stopAll(true);
    const output = killed.length
      ? `Done — I killed ${killed.length} pane(s): ${killed.join(", ")}. They stay killed; I'm still frozen, say "release" to resume.`
      : `There were no running panes left to kill. I'm still frozen — say "release" to resume.`;
    return { kind: "ok", output };
  },
};

export const releaseStopAll: ActionDef<typeof NoParams> = {
  name: "release_stop_all",
  description:
    "Clear the freeze (always allowed): un-freeze Janus; safety gates restore exactly as they were. Does NOT auto-restart any killed panes. Call on 'release' / 'resume'.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["voice", "rest", "ws"]),
  rest: { method: "post", path: "/api/stop-all/release" },
  handler: (_args, ctx): ActionResult => {
    if (!ctx.isFrozen()) {
      return { kind: "ok", output: "I wasn't frozen — nothing to release. Carrying on as normal." };
    }
    ctx.releaseStopAll(); // broadcasts the unfreeze frame + restores gates itself
    return { kind: "ok", output: "Released — I've un-frozen and your safety gates are back exactly as they were. Any panes you killed stay killed." };
  },
};

export const listPanes: ActionDef<typeof NoParams> = {
  name: "list_panes",
  description:
    "List all projects and their panes with runtime_type, is_busy, alive, a one-line state, and live timing. The authoritative source of current pane status — always call it before reporting whether something is busy or done. Cheap orientation call.",
  params: NoParams,
  capability: "read_pane",
  readOnly: true, // result is redacted on the way out (§5.6) — readOnly binds only read capabilities (§8.1 #5)
  surfaces: new Set(["voice", "rest"]), // voice tool (TREE narration) + GET /api/terminals (FLAT array)
  rest: {
    method: "get",
    path: "/api/terminals",
    // c55 Batch F: the REST surface returns the FLAT per-pane array TOP-LEVEL (the shape setTerminals()
    // consumes), NOT the default `{output}` wrapper. The handler already built that array into
    // result.output on the rest surface (surface-aware below), so this re-projects it verbatim.
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? result.output : [],
    }),
  },
  handler: (_args, ctx): ActionResult => {
    // SURFACE-AWARE (c55 Batch F): voice narrates the project/pane TREE (manager.listPanes(), which
    // syncs the ledger); REST returns the FLAT per-pane array the UI's setTerminals() needs — a rich
    // fact-sheet the tree narration cannot carry (raw ANSI backfill, the ANSI-stripped tail, the 16
    // effective gate values, the posture word, context_size). toHttp emits the flat array top-level;
    // the voice path keeps reading result.output via resultToToolResponse, so the tree must stay the
    // VOICE output. Field-for-field parity with the legacy inline GET /api/terminals body (server.ts).
    if (ctx.surface === "rest") {
      const flat = Object.keys(ctx.manager.terminals).map((id) => {
        const term = ctx.manager.terminals[id];
        // SERVER-resolved effective posture (16 gate values + posture word) so the per-pane chip
        // renders from server truth — no client policy re-derivation (spec §5).
        const posture = ctx.posturePayloadForPane(id);
        return {
          id,
          cwd: term.cwd,
          command: term.shellCmd,
          // Display lane: raw bytes (escape sequences intact) for xterm to render exactly. `output`
          // stays ANSI-stripped for the pane-card text previews.
          backfill: term.getRawBackfill(),
          output: term.getRecentOutput(20),
          status: term.status,
          // Merge (concurrent multi-cli): the "cooking…" overlay flag — true when the pane is still
          // Running but has gone quiet inside the pre-idle window. Kept field-identical to the inline
          // GET /api/terminals body (|| undefined so it is omitted, not false, when not quiescing).
          quiescing: term.quiescing || undefined,
          permissions_mode: term.permissionsMode,
          tool_preset: term.toolPreset,
          session_id: term.sessionId,
          context_size: term.contextSize,
          effective_gates: posture.effective_gates,
          posture: posture.posture,
        };
      });
      return { kind: "ok", output: flat };
    }
    // Voice (and any non-rest surface): the genuine domain call. listPanes() syncs the ledger and
    // returns the project/pane tree the model narrates.
    return { kind: "ok", output: ctx.manager.listPanes() };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PROOF-OF-CONTRACT tools (REG1 Phase B): two OPPOSITE gating styles, faithfully
// ported, to validate that the handler-owned ActionContext supports BOTH:
//   propose_command — the dispatchProposal (pane-WRITE HiTL) path.
//   amend_note      — the gateOrDefer (durable Ask-defer) path.
// Each handler references ONLY ctx.* injected closures — no server.ts state.
// ─────────────────────────────────────────────────────────────────────────────

/** propose_command params (server.ts:3540). `command` is a legacy alias for `instruction` (coerced). */
const ProposeCommandParams = z.object({
  pane_id: z.string(),
  instruction: z.string(),
  kind: z.enum(["agent_instruction", "shell"]).optional(),
});

/**
 * propose_command — FAITHFUL PORT of server.ts:2589-2612 (the dispatchProposal path). Routes through
 * the pane-WRITE choke-point ctx.dispatchProposal, which owns its own gate + HiTL staging, and maps
 * DispatchOutcome.kind → ActionResult EXACTLY as the legacy three-branch mapping (pending/clarify/else).
 * The capability declared here is `write_to_pane` (the matrix row); the gate is applied INSIDE
 * dispatchProposal (default capability "write_to_pane"), not by runAction.
 */
export const proposeCommand: ActionDef<typeof ProposeCommandParams> = {
  name: "propose_command",
  description:
    "Direct work to the pane the operator currently has OPEN (the active pane). You can ONLY propose to that pane, so the operator can see and refine the command before it runs; to act on a different pane, call switch_active_pane first (with the operator's go-ahead). Does NOT execute directly — it passes the effective permission gate (auto-runs in Full Auto, becomes a spoken pending approval in Human-in-the-Loop, blocked in Read-Only). PREFER kind='agent_instruction' (the default): relay a SHORT, FOCUSED, DISTILLED instruction to the Claude Code / Codex / Antigravity agent in that pane and let the AGENT do the heavy lifting (write code, run builds/tests). Do NOT relay the operator's dictation verbatim — compress it to a targeted instruction first and confirm it by voice. kind='shell' is ONLY for your OWN small read-only/observe needs (status checks like git status, ls, cat, pwd); never author or run heavy/mutating shell yourself — delegate that to an agent pane via kind='agent_instruction'. A non-allowlisted shell command returns a clarification so you can re-route it to the agent.",
  params: ProposeCommandParams,
  capability: "write_to_pane",
  readOnly: false,
  surfaces: new Set(["voice"]),
  // R2 back-compat: accept the legacy `command` arg as an alias for `instruction` (server.ts:2592).
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.instruction == null && out.command != null) out.instruction = out.command;
    delete out.command;
    return out;
  },
  handler: (args, ctx): ActionResult => {
    const targetId = args.pane_id;
    const instruction = args.instruction ?? "";
    const explicitKind: ApprovalKind | undefined =
      args.kind === "shell" || args.kind === "agent_instruction" ? args.kind : undefined;
    const trigger = ctx.userUtterance || "Spoken execute command";

    const outcome = ctx.dispatchProposal({
      sess: ctx.session,
      callId: ctx.callId ?? "",
      targetId,
      instruction,
      explicitKind,
      trigger,
    });
    // EXACT legacy mapping (server.ts:2600-2611). pending -> structured pending_approval (with
    // pane_id + prompt); clarify -> { status:"clarify", output }; everything else -> { output }.
    if (outcome.kind === "pending") {
      return {
        kind: "pending",
        messageId: ctx.callId ?? "",
        summary: outcome.text,
        extra: { pane_id: targetId, prompt: outcome.text },
      };
    }
    if (outcome.kind === "clarify") {
      return { kind: "clarify", text: outcome.text };
    }
    return { kind: "ok", output: outcome.text };
  },
};

/** amend_note params (server.ts:3676). */
const AmendNoteParams = z.object({
  note_id: z.string(),
  text: z.string(),
});

/**
 * amend_note — FAITHFUL PORT of server.ts:2714-2733 (the gateOrDefer durable Ask-defer path). The
 * handler builds the REAL amend effect closure, then calls ctx.gateOrDefer with that closure AND the
 * serializable intent params { op:"amend", noteId, text } — the SAME params buildActionRun
 * (src/actionEffects.ts) re-derives on restart, in LOCKSTEP (kzt invariant). Off->blocked,
 * Ask->pending (effect staged, NOT run), Auto->run-now. The enqueue-bound `text` is what a deferred
 * confirm applies, not whatever the model says next (#27 MUST-FIX #3).
 */
export const amendNote: ActionDef<typeof AmendNoteParams> = {
  name: "amend_note",
  description:
    "Edit the text of an existing note by its id (get the id from get_project_notes or search_notes). Gated by the 'update notes & metadata' permission: auto-applies in Auto, asks for operator confirmation in Ask, refused when Off.",
  params: AmendNoteParams,
  capability: "update_metadata",
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    const noteId = String(args.note_id ?? "");
    const newText = String(args.text ?? "");
    const amendEffect = (): string => {
      ctx.manager.ledger.amendNote(noteId, newText);
      ctx.broadcastLedgerUpdate();
      return `Note ${noteId} updated.`;
    };
    // kzt: persist the amend INTENT (op + noteId + ENQUEUE-BOUND text) so a deferred amend survives a
    // restart and applies EXACTLY this text on confirm. Keys in lockstep with src/actionEffects.ts.
    const g = ctx.gateOrDefer("update_metadata", null, `Amend note ${noteId}`, amendEffect, {
      ...(ctx.versionStamp ?? {}),
      op: "amend",
      noteId,
      text: newText,
    });
    if (g.disposition === "forbidden") {
      return {
        kind: "ok",
        output: `Error: the 'update_metadata' capability is gated Off; amending notes is forbidden by policy.`,
      };
    }
    if (g.disposition === "deferred") {
      return {
        kind: "ok",
        output: `'${g.summary}' needs operator confirmation (gated Ask). I've queued it — confirm to apply the amendment.`,
      };
    }
    return { kind: "ok", output: amendEffect() };
  },
};

/**
 * The canonical registry — the SINGLE export everything derives from (Gemini declarations, REST mount,
 * capability matrix, coverage). The 6 inline defs above are the phase-A proof (brake trio + list_panes)
 * and the phase-B contract proof (propose_command = dispatchProposal style, amend_note = gateOrDefer
 * durable Ask-defer style). The remaining 35 tools live in src/actions/defs/* (one file per capability
 * domain), faithfully ported from their legacy server.ts branches. Phase C swaps server.ts to dispatch
 * through runAction(REGISTRY, ...). Total = 43 voice tools (parity with the legacy dispatch chain
 * + the Wave D observability pair get_action_log / get_health).
 */
export const REGISTRY: readonly ActionDef[] = [
  // ── phase-A + contract-proof inline defs (6) ──
  stopAll,
  confirmStopAll,
  releaseStopAll,
  listPanes,
  proposeCommand,
  amendNote,
  // ── phase-B grouped defs (35) ──
  ...READS_ACTIONS,
  ...NOTES_ACTIONS,
  ...PANES_WRITE_ACTIONS,
  // ── c55 Batch C rest-only pane/UI defs (5) ──
  ...PANES_REST_ACTIONS,
  ...ORIENT_ACTIONS,
  ...LOCKS_ACTIONS,
  ...ORCH_ACTIONS,
  ...HANDOFF_ACTIONS,
  // ── Wave D observability defs (2) ──
  ...OBSERVABILITY_ACTIONS,
  // ── c55 Batch G net-new rest-only watch-rule / plan-delete defs (4) ──
  ...WATCH_RULES_ACTIONS,
];

// ─────────────────────────────────────────────────────────────────────────────
// PLM3 durable-closure VERSION GUARD (F3 core).
//
// A deferred action persists only its serializable INTENT ({capability, summary, params}) and
// rebuilds its non-serializable run() closure on boot (src/actionEffects.ts buildActionRun). That
// rebuild silently assumes the action's IDENTITY + SHAPE are unchanged across the restart. If the
// binary that boots is a DIFFERENT build — the action was renamed, its capability moved, or its
// param set changed — a stale intent would re-run against a mismatched effect (apply the wrong
// thing, or apply nothing). The version guard makes that mismatch DETECTABLE: each action has a
// stable schema hash; a staged intent stamps the hash of the action it was minted against; on boot
// we re-derive the hash and QUARANTINE any intent whose stamp no longer matches (re-confirm instead
// of blind replay).
//
// The hash is over IDENTITY + SHAPE only — { name, capability, sorted param KEY names } — NOT the
// human-facing description, the handler body, or zod leaf TYPES. Renaming/moving an action, or
// adding/removing/renaming a param, changes the hash (the cases that make a persisted intent unsafe
// to replay). Reword the description or retype a field in place and the hash is unchanged — those do
// not alter how a stamped {params} intent re-derives its effect, so an in-flight deferral survives a
// cosmetic redeploy. It is DETERMINISTIC: no randomness, no time, no map-iteration order (keys are
// sorted) — the same ActionDef yields the same hash in every process, which is what lets boot N+1
// validate an intent stamped by boot N.
// ─────────────────────────────────────────────────────────────────────────────

/** Read an ActionDef's param key names. Zod v4 exposes the public `.shape` getter on a ZodObject;
 *  fall back to `.def.shape` (the internal the gemini schema walk uses) for robustness. Non-object
 *  / shapeless schemas yield no keys (the brake trio's NoParams is a legit empty-key action). */
function paramKeyNames(params: unknown): string[] {
  const p = params as { shape?: Record<string, unknown>; def?: { shape?: Record<string, unknown> } };
  const shape = p?.shape ?? p?.def?.shape;
  return shape ? Object.keys(shape) : [];
}

/**
 * A small, deterministic 32-bit FNV-1a string hash rendered as fixed 8-char lowercase hex. No
 * randomness, no time, no platform dependence — pure over the input bytes. Sufficient to detect a
 * shape/identity change of a persisted intent across a redeploy (this is a drift TRIPWIRE, not a
 * cryptographic commitment): the realistic failure mode is an honest schema edit, not an adversary
 * crafting a collision.
 */
function foldHash(s: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit unsigned via Math.imul + >>>0.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stable, deterministic hash of an action's IDENTITY + SHAPE, or `null` when no action by that name
 * exists in the registry. Derived from a canonical JSON form of { name, capability, sorted param key
 * names }. Sorting the keys removes any dependence on declaration / object-iteration order, so the
 * hash is identical across processes and builds for an unchanged def (the property boot N+1 relies on
 * to validate an intent stamped by boot N). Description, handler, and zod leaf types are intentionally
 * EXCLUDED — they do not change how a stamped {params} intent re-derives its effect.
 */
export function actionSchemaHash(name: string): string | null {
  const def = REGISTRY.find((a) => a.name === name);
  if (!def) return null;
  const canonical = JSON.stringify({
    name: def.name,
    capability: def.capability,
    params: paramKeyNames(def.params).sort(),
  });
  return foldHash(canonical);
}

/**
 * name -> schema hash for every action in the registry. Computed ONCE at module load (the registry is
 * static), for boot-time bulk checks: server.ts can validate every rehydrated intent against this map
 * without re-walking the registry per intent. `actionSchemaHash(name)` and this map agree by
 * construction (same derivation).
 */
export const REGISTRY_SCHEMA_HASHES: Record<string, string> = Object.fromEntries(
  REGISTRY.map((a) => [a.name, actionSchemaHash(a.name) as string])
);
