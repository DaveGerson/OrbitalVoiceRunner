/**
 * actionEffects — the intent ⇄ run registry for DURABLE deferred actions (bead wsm-e2e-pinned-kzt).
 *
 * A PendingAction (src/pendingActions.ts) carries a non-serializable `run()` CLOSURE, so it cannot be
 * persisted directly. Instead we persist the action's INTENT (capability + the JSON params the closure
 * captured) and rebuild a fresh `run()` ON BOOT from that intent — bound to the LIVE manager/broadcast
 * references inside the new startServer() closure (a deserialized closure could never re-bind them).
 *
 * This module is PURE / side-effect-free (no `../server` import — importing the server boots a real
 * listener), so the unit tests import it directly. It is parameterized by a `deps` bag the server
 * supplies at boot. `buildActionRun` is a RE-DERIVATION of the literal staging-site closures on
 * CURRENT main (server.ts: REST /api/terminals 836-840, REST recipe 1441-1451, voice update_metadata
 * amend 2511-2514 + delete 2525-2528, voice create_pane 2637-2652, voice set_global_permissions
 * 2665-2674, voice recipe 2803-2810, voice set_pane_permissions 3229-3238).
 *
 * RETURN-STRING FIDELITY (Risk 1, remediated): the THREE create_pane staging sites run identical side
 * effects but each returns a DIFFERENT operator/model-facing confirm string. Capability alone cannot
 * discriminate them, so the persisted intent carries an `origin` tag (voice|rest|recipe) and the
 * create_pane rebuild reproduces the exact string per origin. Likewise update_metadata carries an `op`
 * tag (amend|delete) — the two #27 sites share the capability string but call different ledger methods
 * and return different strings. set_pane_permissions keeps its trailing "successfully.";
 * set_global_permissions already matched. The result: a confirm-after-restart yields a BYTE-IDENTICAL
 * confirm string to a confirm-in-process, not just identical side effects.
 *
 * CRITICAL LOCKSTEP RULE: any edit to a staging-site closure (effects OR return string) MUST be
 * mirrored here, or a confirm-after-restart silently diverges from a confirm-in-process.
 * tests/test_actionEffects.ts pins the EXACT confirm string per origin/capability/op (the drift
 * guard), and tests/test_pendingActions_durable.ts pins it once through the full durable round-trip —
 * keep both.
 */

// The version guard derives an action's current schema hash from the canonical registry. registry.ts
// imports only zod + the static ActionDef groups (NO server boot), so this keeps actionEffects PURE
// (importable directly by the unit tests, no listener spun up).
import fs from "fs";
import path from "path";
import { actionSchemaHash } from "./actions/registry";
import { buildExportSnapshot, composeExportMarkdown, writeExportArtifactAtomic, EXPORT_BASENAME } from "./actions/defs/export";
import { findPaneOwningProject } from "./paneOwnership";
import { getHistoryBridge } from "./historyBridge";
import { respawnFromLedger } from "./actions/respawnFromLedger";
import type { ActionContext } from "./actions/types";

/**
 * Which staging site produced a create_pane intent. The three sites run the SAME side effects
 * (addTerminal + broadcasts) but each returns a DIFFERENT operator/model-facing confirm string, so
 * the rebuild must reproduce the exact string for the origin or a confirm-after-restart drifts from
 * a confirm-in-process (Risk 1). Persisted in the intent params; legacy rows (pre-origin) default to
 * "voice" — the richest string — for back-compat.
 *   voice  -> server.ts voice create_pane closure (returns `Pane … created under project …. Result: …`)
 *   rest   -> server.ts REST /api/terminals spawnEffect (returns `String(result)`)
 *   recipe -> server.ts REST + voice recipe spawnPane (returns the bare pane id)
 */
export type CreatePaneOrigin = "voice" | "rest" | "recipe";

/** Params captured by the create_pane closures (voice + REST + recipe variants). */
export interface CreatePaneParams {
  paneId: string;
  /** Working directory for the spawned pane; falls back to process.cwd() when absent. */
  cwd?: string;
  command: string;
  toolPreset?: string;
  permissionsMode?: string;
  sessionId?: string;
  projectId?: string;
  /** Recipe variant only: a suggested startup command recorded as an auditable pane note. */
  startupCommand?: string;
  /** Confirm-string discriminator (see CreatePaneOrigin). Absent on legacy rows -> defaults to "voice". */
  origin?: CreatePaneOrigin;
}
/** Params captured by the set_global_permissions closure. */
export interface SetGlobalPermissionsParams { permissionsMode: string; }
/** Params captured by the set_pane_permissions closure. */
export interface SetPanePermissionsParams { paneId: string; projectId: string; permissionsMode: string; }
/**
 * Params captured by the applyPaneMode choke point's Ask deferral (src/applyPaneMode.ts, 3V.4).
 * `source` is the SHAPE DISCRIMINATOR: the legacy locks.ts staging site never stages it, so its
 * presence routes the rebuild to the applyPaneMode arm. No projectId is staged — the choke point
 * persists against the ACTIVE project (gating's persistMode), which the rebuild mirrors.
 */
export interface ApplyPaneModeParams { paneId: string; permissionsMode: string; source: "voice" | "ui" | "promote_pane_mode"; }
/**
 * Params captured by the #27 update_metadata closures (amend_note / delete_note, server.ts:2511/2525).
 * `op` is the discriminator — both sites share capability "update_metadata" but call different ledger
 * methods and return different confirm strings. `text` is the ENQUEUE-BOUND amend text (#27 MUST-FIX
 * #3): a confirm-after-restart must apply exactly this text, not whatever the model says next.
 */
export interface UpdateMetadataParams {
  op: "amend" | "delete" | "add" | "rename" | "export";
  /** amend/delete: the target note id. */
  noteId?: string;
  /** amend: the ENQUEUE-BOUND amend text (applied verbatim across a restart). */
  text?: string;
  // ── PHASE 1 (deferrable-toggle honesty) additive note/rename ops ──
  /** add: "project" | "pane"; rename: "project" | "pane" — the scope discriminator. */
  scope?: "project" | "pane";
  /** add/rename: the owning project id. */
  projectId?: string;
  /** add(pane)/rename(pane): the target pane id. */
  paneId?: string;
  /** add: the note text. */
  note?: string;
  /** rename: the new display name. */
  name?: string;
}
/** Params captured by the close_pane closure (terminate + recoverable archive). */
export interface ClosePaneParams { paneId: string; projectId?: string; }
/**
 * PHASE 1 (deferrable-toggle honesty). Params captured by the create_project closure (orient.ts).
 * `directory` is the RESOLVED path (resolveProjectDir ran before staging). `name` is the OPTIONAL
 * post-create display rename (c55.16 2nd mutation). The rebuild reproduces addProject [+ rename] +
 * the single ledger_updated broadcast + the exact confirm string.
 */
export interface CreateProjectParams { projectId: string; directory: string; summary?: string; keyTerms?: string[]; name?: string; }
/**
 * PHASE 1 (deferrable-toggle honesty). Params captured by the clear_history closure (panes_rest.ts).
 * `op:"clear"` is a forward-looking discriminator (clear_history has one op today). The rebuild
 * re-fires the SAME bridge-first clear + confirm string. NOTE: a confirm-AFTER-restart clears the
 * pane's history through the freshly-registered bridge bound at the new boot — safe + idempotent
 * (clearing an already-empty history is a no-op).
 */
export interface ClearHistoryParams { op: "clear"; paneId: string; }
/**
 * PHASE 1 (deferrable-toggle honesty). Params captured by the archive_pane closure (panes_rest.ts).
 * `projectId` is the OWNING project resolved at stage time. The rebuild re-fires ledger.archivePane
 * + the broadcasts + the exact confirm string. Idempotent: an already-archived row returns false →
 * the "already gone" narration, no broadcast.
 */
export interface ArchivePaneParams { paneId: string; projectId: string; }
/**
 * wsm-e2e-pinned-j2e: params captured by the respawn_pane deferral (src/actions/defs/panes_rest.ts).
 * The staged CAPABILITY is "restart_pane" (unchanged matrix row — see that file's header note on the
 * respawn_pane/restart_pane name split), so that is the EFFECT_BUILDERS key below, even though the
 * action itself is named respawn_pane. Only paneId is staged (mirrors ArchivePaneParams's minimal
 * shape) — the rebuild re-resolves the owning project via findPaneOwningProject, the same canonical
 * resolver the live handler uses, rather than trusting a persisted snapshot that could be stale.
 */
export interface RestartPaneReplayParams { paneId: string; }
/**
 * wsm-e2e-pinned-j2e: params captured by the delete_pane deferral (src/actions/defs/lifecycle_rest.ts).
 * NOTE: the staging site does NOT widen the persisted bag with project_id (only paneId), so the
 * rebuild resolves the owning project via findPaneOwningProject rather than trusting a stale caller id.
 */
export interface DeletePaneReplayParams { paneId: string; }
/**
 * wsm-e2e-pinned-j2e: params captured by the delete_project deferral (src/actions/defs/lifecycle_rest.ts).
 */
export interface DeleteProjectReplayParams { projectId: string; }

/**
 * Params captured by the c55.10 remove_watch_rule closure (src/actions/defs/watch_rules.ts).
 * `ruleId` is the WIDENED payload (the staging bag formerly carried only { origin, versionStamp }, so a
 * confirm-after-restart could not reconstruct WHICH rule to splice). The id is bound at enqueue and the
 * rebuilt effect splices exactly that rule across a restart (the idempotent re-find guard mirrors the
 * def: a rule deleted between stage and confirm is a no-op, still narrates success).
 */
export interface RemoveWatchRuleParams { ruleId: string; }
/**
 * Params captured by the c55.10 delete_orchestrator_plan closure (src/actions/defs/watch_rules.ts).
 * `planId` is the WIDENED payload (see RemoveWatchRuleParams). The rebuilt effect splices exactly that
 * plan off the board across a restart (idempotent re-find guard mirrors the def).
 */
export interface DeleteOrchestratorPlanParams { planId: string; }

/**
 * The serializable intent of a deferred action: capability + a capability-specific param bag, plus
 * the OPTIONAL PLM3 version stamp ({ actionName, schemaHash }) the server writes when staging so a
 * later boot can quarantine a drifted def before rebuilding its closure. The stamp is optional so
 * legacy rows (pre-stamp) still type-check; checkActionVersion treats a missing/unknown name as
 * "unknown_action" (re-confirm, never blind-replay). buildActionRun ignores the stamp.
 */
export interface ActionIntent extends VersionStamp {
  capability: string;
  params: Record<string, unknown>;
}

/**
 * PLM3 durable-closure VERSION-GUARD stamp (F3). When a pending action is staged, the server stamps
 * the action's canonical name and its `actionSchemaHash(name)` into the persisted intent params, so a
 * later boot can prove the action's identity+shape is unchanged before blindly rebuilding+running the
 * effect. Both OPTIONAL: legacy rows (pre-stamp) carry neither — they are treated as "unknown_action"
 * by the guard (re-confirm, never silently replay against a possibly-drifted def). Stored alongside
 * the capability-specific params; the rebuild path (buildActionRun) ignores them.
 */
export interface VersionStamp {
  /** Canonical registry action name this intent was minted against (e.g. "amend_note"). */
  actionName?: string;
  /** actionSchemaHash(actionName) at staging time — the value boot re-derivation must still match. */
  schemaHash?: string;
}

/**
 * QUARANTINE gate (PLM3 F3). Given a rehydrated intent's stamped { actionName, schemaHash }, decide
 * whether the persisted closure is SAFE to rebuild + run on this boot. ok only when the action still
 * exists AND its current schema hash equals the stamped one; otherwise a reason a caller renders into
 * a "re-confirm, don't blind-replay" path:
 *   - "unknown_action": no stamped name, or the name is no longer in the registry (renamed/removed,
 *      or a legacy pre-stamp row). actionSchemaHash returns null -> never matches a stamped hash.
 *   - "schema_changed": the action exists but its identity/shape moved (capability or param keys
 *      changed) since staging, so the stamped hash no longer matches the current one.
 *
 * A caller that gets ok:false MUST NOT run the effect — it re-confirms with the operator instead.
 * Pure: no randomness, no time; `actionSchemaHash` is a deterministic registry lookup.
 */
export function checkActionVersion(
  stored: { actionName?: string; schemaHash?: string }
): { ok: boolean; reason?: "unknown_action" | "schema_changed" } {
  const current = stored.actionName ? actionSchemaHash(stored.actionName) : null;
  // No name stamped, or the action no longer exists in the registry.
  if (current === null) return { ok: false, reason: "unknown_action" };
  // Action exists but its identity/shape drifted since the intent was stamped (covers a missing
  // stamped hash on an otherwise-known action — a partially-stamped/legacy row is still unsafe).
  if (current !== stored.schemaHash) return { ok: false, reason: "schema_changed" };
  return { ok: true };
}

/** The live references a rebuilt run() needs. Supplied by server.ts at boot (fresh per process). */
export interface ActionEffectDeps {
  manager: any;                 // OrchestratorManager (typed loosely to avoid a server import cycle)
  broadcast: (msg: any) => void;
  broadcastLedgerUpdate: () => void;
  sanitizeSettingsForClient: (s: any) => any;
  setActivePane?: (paneId: string | null) => void;
}

/** Activate a newly created pane — make it the operator's active WRITE target + broadcast the view
 *  switch — but ONLY for an operator-initiated VOICE create. A REST/recipe/dispatch_group background
 *  spawn must never steal the operator's focus, so a non-voice OR unknown origin does NOT activate
 *  (fail-safe: undefined origin is treated as non-voice, never as voice). The broadcast mirrors
 *  switch_active_pane's wire contract (panes_write.ts) so the browser remounts its xterm on the new
 *  pane and subscribes the PTY stream; without it a voice-created pane leaves the browser on the OLD
 *  pane and the new pane's stdout has no listener ("you can see them, but I can't"). */
export function activateCreatedPane(
  deps: { setActivePane?: (paneId: string | null) => void; broadcast: (msg: any) => void },
  paneId: string | null | undefined,
  origin?: string
): void {
  if (!paneId) return;
  if (origin !== "voice") return; // fail-safe: only an explicit voice origin steals operator focus
  if (deps.setActivePane) {
    deps.setActivePane(paneId);
  }
  deps.broadcast({ type: "switch_active_pane", paneId });
}

/** A capability builder: turns a rehydrated intent + live deps into the deferred-effect thunk. */
type EffectBuilder = (intent: ActionIntent, deps: ActionEffectDeps) => () => string;

// ── create_pane: the origin-specific confirm string (the Risk-1 drift guard) ──────────────────────
// The three create_pane staging sites run IDENTICAL side effects but each returns a DIFFERENT
// operator/model-facing confirm string. Capability alone can't discriminate them, so the persisted
// intent carries an `origin` tag and we reproduce the exact string per origin here. Absent origin
// (legacy rows) defaults to the richest, voice string. Extracted from the create_pane arrow so the
// effect body stays under CC 10 and the per-origin mapping is hand-verifiable in one place.
function createPaneConfirm(p: CreatePaneParams, projectId: string, result: unknown): string {
  switch (p.origin) {
    case "rest":
      // REST /api/terminals spawnEffect: `return String(result);` (server.ts:840).
      return String(result);
    case "recipe":
      // REST + voice recipe spawnPane: `return p.id;` (server.ts:1451 / 2810).
      return p.paneId;
    case "voice":
    default:
      // voice create_pane (server.ts:2652); also the back-compat default for legacy rows.
      return `Pane ${p.paneId} created under project ${projectId}. Result: ${result}`;
  }
}

function buildCreatePane(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  const p = intent.params as unknown as CreatePaneParams;
  return () => {
    const projectId = p.projectId ?? "";
    // Co-create the project if missing (mirrors voice create_pane + REST projectId-sync).
    if (projectId && !deps.manager.ledger.getProject(projectId)) {
      deps.manager.ledger.addProject(projectId, p.cwd || ".", "Co-created with pane");
    }
    const result = deps.manager.addTerminal(
      p.paneId,
      p.cwd || process.cwd(),
      p.command,
      // `??` (not `||`) defaults only on nullish, mirroring addTerminal's own default-param
      // semantics — so this matches the REST/recipe staging sites (which pass the value raw and
      // rely on those param defaults) for every input, including an explicit "". (The voice site
      // uses `|| "Custom"`, but tool_preset/permissions_mode are never an empty string in
      // practice; nullish-default is the faithful, addTerminal-contract-aligned choice.)
      p.toolPreset ?? "Custom",
      p.permissionsMode ?? "Human-in-the-Loop",
      p.sessionId || "",
      projectId,
    );
    // Recipe variant: a suggested startup command is recorded as an auditable pane note.
    if (p.startupCommand) {
      deps.manager.ledger.addPaneNote(projectId, p.paneId, `Suggested startup command: ${p.startupCommand}`);
    }
    deps.broadcastLedgerUpdate();
    deps.broadcast({ type: "terminals_updated" });
    activateCreatedPane(deps, p.paneId, p.origin);
    // Reproduce the EXACT confirm string of the originating staging site (Risk 1 drift guard).
    // The side effects above are identical across origins; only the return string differs.
    return createPaneConfirm(p, projectId, result);
  };
}

function buildSetGlobalPermissions(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  const p = intent.params as unknown as SetGlobalPermissionsParams;
  return () => {
    deps.manager.globalPermissionsMode = p.permissionsMode;
    deps.manager.settings.advanced.globalPermissionsMode = p.permissionsMode;
    deps.manager.saveSettings();
    deps.broadcast({
      type: "settings_updated",
      globalPermissionsMode: p.permissionsMode,
      settings: deps.sanitizeSettingsForClient(deps.manager.settings),
    });
    return `Global permissions updated to ${p.permissionsMode}.`;
  };
}

// ── set_pane_permissions: TWO staging sites share this capability; `source` discriminates ─────────
// The applyPaneMode choke point stages { paneId, permissionsMode, source }; the legacy locks.ts
// fallback stages { paneId, projectId, permissionsMode }. Each shape's thunk is extracted so the
// dispatcher stays flat and each body stays under CC 10.

function buildApplyPaneModeReplay(p: ApplyPaneModeParams, deps: ActionEffectDeps): () => string {
  return () => {
    const term = deps.manager.terminals[p.paneId];
    if (term) term.setPermissionsMode(p.permissionsMode);
    // PERSIST-WINS: mirror gating's persistMode (OWNING project, forced updatePane).
    const owned = findPaneOwningProject(deps.manager, p.paneId);
    if (owned) {
      owned.pane.permissions_mode = p.permissionsMode as typeof owned.pane.permissions_mode;
      deps.manager.ledger.updatePane(owned.projectId, owned.pane, true);
    }
    deps.broadcastLedgerUpdate();
    deps.broadcast({ type: "settings_updated", paneId: p.paneId, permissionsMode: p.permissionsMode });
    deps.broadcast({ type: "terminals_updated", paneId: p.paneId });
    // The restart-resume note: the live process (if any) was NOT signal-switched by this replay.
    deps.broadcast({
      type: "pane_note",
      paneId: p.paneId,
      note: `Permission mode for pane ${p.paneId} set to ${p.permissionsMode} after restart — restart the pane (restart-resume) to apply it to a LIVE process.`,
    });
    return `Safety permission mode for pane ${p.paneId} updated to ${p.permissionsMode}. Applied after a restart: the next pane start uses it; restart the pane to switch a live process.`;
  };
}

function buildLegacyPanePermissions(p: SetPanePermissionsParams, deps: ActionEffectDeps): () => string {
  return () => {
    if (deps.manager.terminals[p.paneId]) deps.manager.terminals[p.paneId].setPermissionsMode(p.permissionsMode);
    const ws = deps.manager.ledger.getProject(p.projectId);
    if (ws && ws.panes[p.paneId]) {
      ws.panes[p.paneId].permissions_mode = p.permissionsMode;
      deps.manager.ledger.save();
    }
    deps.broadcastLedgerUpdate();
    deps.broadcast({ type: "terminals_updated" });
    // Exact confirm string — keep the trailing "successfully." (server.ts:3238 literal).
    return `Safety permission mode for pane ${p.paneId} updated to ${p.permissionsMode} successfully.`;
  };
}

function buildSetPanePermissions(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // 3V.4: `source` (a string) routes to the applyPaneMode replay arm; its absence routes to the
  // legacy locks.ts fallback arm. See the original header note on why a full live replay is
  // impractical post-restart (this deps bag has no adapter/poll/gate seams).
  if (typeof (intent.params as { source?: unknown }).source === "string") {
    return buildApplyPaneModeReplay(intent.params as unknown as ApplyPaneModeParams, deps);
  }
  return buildLegacyPanePermissions(intent.params as unknown as SetPanePermissionsParams, deps);
}

// ── update_metadata: amend/add/rename/delete, each a leaf reproducing its def's EXACT string ──────
// PHASE 1 (deferrable-toggle honesty): the additive note/rename ops join amend/delete under the
// shared update_metadata capability. `op` (+ `scope` for add/rename) discriminates; each arm
// reproduces its def's EXACT confirm string + broadcast (the Risk-1 drift guard). Decomposed from
// the single CC21 arrow into one helper per op so each leaf is hand-verifiable and under CC 10.

function applyUpdateAmend(p: UpdateMetadataParams, deps: ActionEffectDeps): string {
  deps.manager.ledger.amendNote(p.noteId, p.text ?? "");
  deps.broadcastLedgerUpdate();
  return `Note ${p.noteId} updated.`;     // EXACT — matches registry.ts amend_note
}

function applyUpdateAddPane(p: UpdateMetadataParams, deps: ActionEffectDeps): string {
  const ok = deps.manager.ledger.addPaneNote(p.projectId ?? "", p.paneId ?? "", p.note ?? "");
  if (ok) deps.broadcastLedgerUpdate();
  return ok
    ? `Note added to pane ${p.paneId}`                                              // EXACT — notes.ts add_pane_note
    : `Could not add note: pane ${p.paneId} not found in project ${p.projectId}.`;
}

function applyUpdateAddProject(p: UpdateMetadataParams, deps: ActionEffectDeps): string {
  const ok = deps.manager.ledger.addNote(p.projectId ?? "", p.note ?? "");
  if (ok) deps.broadcastLedgerUpdate();
  return ok
    ? `Note added to project ${p.projectId}`                                          // EXACT — notes.ts add_project_note
    : `Could not add note: project ${p.projectId} not found.`;
}

function applyUpdateAdd(p: UpdateMetadataParams, deps: ActionEffectDeps): string {
  return p.scope === "pane" ? applyUpdateAddPane(p, deps) : applyUpdateAddProject(p, deps);
}

function applyUpdateRename(p: UpdateMetadataParams, deps: ActionEffectDeps): string {
  if (p.scope === "pane") {
    deps.manager.ledger.renamePane(p.projectId ?? "", p.paneId ?? "", p.name ?? "");
    deps.broadcastLedgerUpdate();
    return `Pane renamed to ${p.name}`;     // EXACT — orient.ts rename_pane
  }
  deps.manager.ledger.renameProject(p.projectId ?? "", p.name ?? "");
  deps.broadcastLedgerUpdate();
  return `Project renamed to ${p.name}`;    // EXACT — orient.ts rename_project
}

function applyUpdateDelete(p: UpdateMetadataParams, deps: ActionEffectDeps): string {
  // op:"delete" (and any legacy delete-shaped row).
  deps.manager.ledger.deleteNote(p.noteId);
  deps.broadcastLedgerUpdate();
  return `Note ${p.noteId} deleted.`;       // EXACT — matches notes.ts delete_note
}

function applyUpdateExport(p: UpdateMetadataParams, deps: ActionEffectDeps): string {
  // Wave 6 fix: export_project stages capability "update_metadata" with op:"export" (export.ts). WITHOUT
  // this arm the op fell through to applyUpdateDelete → ledger.deleteNote(undefined) → a bind TypeError
  // that consumed the operator's confirm as a 500. This re-runs the DETERMINISTIC export exactly like the
  // live effect (export.ts exportEffect): resolve the project, build the snapshot, compose (pure), write
  // atomically, and return the BYTE-IDENTICAL confirm string. Events come from the JanusStore's getEvents
  // (manager.ledger IS the store — server.ts:647); a ledger without getEvents degrades to no events (the
  // snapshot builder's `ctx.store?.getEvents` guard), never a crash.
  const projectId = p.projectId ?? "";
  const project = deps.manager.ledger.getProject(projectId);
  if (!project) return `Could not export: project ${projectId} not found.`;  // EXACT — export.ts miss string
  const ledger = deps.manager.ledger as { getEvents?: unknown };
  const store = typeof ledger.getEvents === "function" ? deps.manager.ledger : undefined;
  const replayCtx = { manager: deps.manager, store } as unknown as ActionContext;
  const snapshot = buildExportSnapshot(replayCtx, project, projectId);
  const markdown = composeExportMarkdown(snapshot, Date.now);
  try {
    writeExportArtifactAtomic(project.directory, markdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Export failed: could not write ${EXPORT_BASENAME} (${message}).`;  // EXACT — export.ts fail string
  }
  return `Export written — ${snapshot.notes.length} notes, ${snapshot.panes.length} stations.`;  // EXACT
}

function buildUpdateMetadata(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // RE-SCOPE CORE (kzt-rescope.md §3.4): the #27 amend_note / delete_note deferral. `op` discriminates;
  // `text` is the enqueue-bound amend text (applied verbatim across a restart). op:"export" re-runs the
  // deterministic project export (Wave 6 fix — see applyUpdateExport). An unrecognized op takes the
  // delete arm — the documented legacy-shaped default (preserved from the original chain).
  const p = intent.params as unknown as UpdateMetadataParams;
  return () => {
    if (p.op === "amend") return applyUpdateAmend(p, deps);
    if (p.op === "add") return applyUpdateAdd(p, deps);
    if (p.op === "rename") return applyUpdateRename(p, deps);
    if (p.op === "export") return applyUpdateExport(p, deps);
    return applyUpdateDelete(p, deps);
  };
}

function buildClosePane(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // wsm-e2e-pinned-5h0 (A-voice): rebuild the deferred terminate+archive. stopAndArchivePane is
  // async; fire-and-forget (the rebuild has no awaiting seam) and broadcast on completion —
  // mirrors the panes_write closeEffect. manager.onClosed (wired in server.ts) publishes the
  // turn-gated "closed" pane signal when the archive lands.
  const p = intent.params as unknown as ClosePaneParams;
  return () => {
    Promise.resolve(deps.manager.stopAndArchivePane(p.projectId ?? "", p.paneId))
      .then(() => { deps.broadcastLedgerUpdate(); deps.broadcast({ type: "terminals_updated" }); })
      .catch((e: unknown) => console.error(`[close_pane replay] failed for ${p.paneId}:`, e));
    return `Exiting and archiving pane ${p.paneId}. It's recoverable from the archive.`;
  };
}

function buildRemoveWatchRule(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // c55.16 tech_debt_buildactionrun: durable replay of the c55.10 gated rest-only cap. Mirrors
  // removeEffect (src/actions/defs/watch_rules.ts:187-195) BYTE-IDENTICALLY — re-find by id (the
  // idempotent guard: a rule deleted between stage and confirm is a no-op), splice, force-persist
  // via ledger.save(true), return the EXACT confirm string. CRITICAL LOCKSTEP RULE (header §): keep
  // in step with the def closure. wsm-e2e-pinned-33c.4: the watch_rules_updated BROADCAST is pruned
  // (no client consumes that frame post d858e5e) — the persist + confirm-string effect is unchanged.
  const p = intent.params as unknown as RemoveWatchRuleParams;
  return () => {
    const i = deps.manager.ledger.watchRules.findIndex((r: { id: string }) => r.id === p.ruleId);
    if (i !== -1) {
      deps.manager.ledger.watchRules.splice(i, 1);
      deps.manager.ledger["save"](true);
    }
    return `Watch rule ${p.ruleId} removed.`;  // EXACT — matches watch_rules.ts:194
  };
}

function buildDeleteOrchestratorPlan(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // c55.16 tech_debt_buildactionrun: durable replay of the c55.10 gated rest-only cap. Mirrors
  // deleteEffect (src/actions/defs/watch_rules.ts:248-256) BYTE-IDENTICALLY — re-find by id
  // (idempotent guard), splice off the board, force-persist via ledger.save(true), broadcast
  // plans_updated with the CURRENT live array, return the EXACT confirm string.
  const p = intent.params as unknown as DeleteOrchestratorPlanParams;
  return () => {
    const i = deps.manager.ledger.plans.findIndex((pl: { id: string }) => pl.id === p.planId);
    if (i !== -1) {
      deps.manager.ledger.plans.splice(i, 1);
      deps.manager.ledger["save"](true);
      deps.broadcast({ type: "plans_updated", plans: deps.manager.ledger.plans });
    }
    return `Plan ${p.planId} deleted.`;  // EXACT — matches watch_rules.ts:255
  };
}

function buildCreateProject(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // PHASE 1 (deferrable-toggle honesty): durable replay of the orient.ts create_project deferral.
  // Mirrors createEffect BYTE-IDENTICALLY — addProject (resolved directory + summary + keyTerms),
  // the OPTIONAL post-create rename (c55.16 2nd mutation), ONE ledger_updated broadcast, the EXACT
  // confirm string. The bad-dir clarify already ran at stage time (the path here is resolved).
  const p = intent.params as unknown as CreateProjectParams;
  return () => {
    deps.manager.ledger.addProject(p.projectId, p.directory, p.summary ?? "", p.keyTerms ?? []);
    if (p.name) deps.manager.ledger.renameProject(p.projectId, p.name);
    deps.broadcastLedgerUpdate();
    return `Project context ${p.projectId} created successfully.`;  // EXACT — orient.ts create_project
  };
}

function clearHistoryFallback(paneId: string): void {
  // Faithful fallback (mirrors panes_rest.ts saveHistory(id, [])): set this pane's history to []
  // in the on-disk map at process.cwd()/.janus_history.json. Best-effort (never throws).
  try {
    const fp = path.join(process.cwd(), ".janus_history.json");
    let all: Record<string, unknown[]> = {};
    if (fs.existsSync(fp)) {
      const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) all = parsed;
    }
    all[paneId] = [];
    fs.writeFileSync(fp, JSON.stringify(all, null, 2), "utf-8");
  } catch (e) {
    console.warn(`[clear_history replay] failed for ${paneId}:`, e);
  }
}

function buildClearHistory(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // PHASE 1 (deferrable-toggle honesty): durable replay of the panes_rest.ts clear_history deferral.
  // Bridge-first (the server registers its HistoryManager bridge at boot); a direct file clear is the
  // fallback only when no bridge is registered (bare tests). Returns the EXACT confirm string.
  void deps; // history clear goes through the module-level bridge (or the file fallback), not deps.
  const p = intent.params as unknown as ClearHistoryParams;
  return () => {
    const bridge = getHistoryBridge();
    if (bridge) {
      bridge.clearHistory(p.paneId);
    } else {
      clearHistoryFallback(p.paneId);
    }
    return `History cleared for terminal ${p.paneId}.`;  // EXACT — panes_rest.ts clear_history
  };
}

function buildArchivePane(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // PHASE 1 (deferrable-toggle honesty): durable replay of the panes_rest.ts archive_pane deferral.
  // Mirrors archiveEffect BYTE-IDENTICALLY — ledger.archivePane (recoverable move), the
  // ledger_updated + terminals_updated broadcasts on success, the EXACT confirm string. Idempotent:
  // an already-archived row (false) returns the "already gone" narration with no broadcast.
  const p = intent.params as unknown as ArchivePaneParams;
  return () => {
    const ok = deps.manager.ledger.archivePaneOwned(p.projectId, p.paneId);
    if (ok) {
      deps.broadcastLedgerUpdate();
      deps.broadcast({ type: "terminals_updated" });
      return `Pane ${p.paneId} archived (recoverable).`;       // EXACT — panes_rest.ts archive_pane
    }
    return `Pane ${p.paneId} could not be archived (already gone).`;
  };
}

// ── wsm-e2e-pinned-j2e: durable replay for the gated deletes + the respawn ("restart_pane") gate ──
// buildActionRun previously had NO case for delete_pane / delete_project / restart_pane, so a
// deferred (Ask) confirm of any of the three AFTER a process restart degraded to the safe "unknown
// capability" no-op narration instead of running the real effect (fail-safe but wrong — the operator
// is told the pane/project was deleted or restarted, but it wasn't). These three mirror their
// staging-site closures (lifecycle_rest.ts / panes_rest.ts) BYTE-IDENTICALLY.

function buildRespawnPane(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // Mirrors respawnPane's restartEffect (panes_rest.ts) for the two branches reachable on replay:
  //  - a LIVE terminal already present in this (fresh) manager: the SAME ordered stop()-then-start()
  //    with the SAME two kdtu 86-during-restart guards (ownership + archivingPanes), so a replay can
  //    never respawn a ghost PTY for a pane an interleaved archive already took off the board.
  //  - a ledger-only pane: respawnFromLedger, the SAME shared spawn closure respawn_pane/restore both
  //    use — reused here (not re-derived) so the launch-command/cwd/addTerminal logic can never drift.
  // Neither present (deleted between stage and confirm) -> idempotent "not found" narration, no-op.
  const p = intent.params as unknown as RestartPaneReplayParams;
  return () => {
    const id = p.paneId;
    const term = deps.manager.terminals[id];
    const owner = findPaneOwningProject(deps.manager, id);
    if (!term && !owner) return `Terminal ${id} not found.`;
    if (term) {
      void (async () => {
        await term.stop();
        // Same synchronous-tick guard as the live handler (kdtu): no await between the checks and
        // term.start() re-opens the 86-during-restart window.
        if (deps.manager.terminals[id] !== term || deps.manager.archivingPanes?.has(id)) return;
        term.start();
        deps.broadcastLedgerUpdate();
        deps.broadcast({ type: "terminals_updated" });
      })().catch((e: unknown) => console.error(`[restart_pane replay] deferred restart failed for ${id}:`, e));
      return `Terminal ${id} restarted.`;
    }
    // respawnFromLedger only touches ctx.manager / ctx.broadcastLedgerUpdate / ctx.broadcastTerminalsUpdated
    // — the minimal ActionContext slice this replay deps bag can satisfy.
    const replayCtx = {
      manager: deps.manager,
      broadcastLedgerUpdate: deps.broadcastLedgerUpdate,
      broadcastTerminalsUpdated: () => deps.broadcast({ type: "terminals_updated" }),
    } as unknown as ActionContext;
    return respawnFromLedger(replayCtx, id, owner!.pane, owner!.projectId, `Terminal ${id} restored and started.`);
  };
}

function buildDeletePane(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // Mirrors lifecycle_rest.ts deleteEffect BYTE-IDENTICALLY: stop() + drop the live terminal slot,
  // splice the ledger row, persist, broadcast, EXACT confirm string. The owning project is resolved
  // via findPaneOwningProject (see DeletePaneReplayParams — project_id is never staged). Idempotent:
  // a pane already gone by replay time (both the live slot and the ledger row absent) is a no-op
  // "not found" narration, mirroring the def's own pre-gate existence check.
  const p = intent.params as unknown as DeletePaneReplayParams;
  return () => {
    const id = p.paneId;
    const owner = findPaneOwningProject(deps.manager, id);
    if (!deps.manager.terminals[id] && !owner) return `Pane ${id} not found.`;
    const term = deps.manager.terminals[id];
    if (term) { term.stop(); delete deps.manager.terminals[id]; }
    // wsm-e2e-pinned major-finding fix: a snapshot mutation (`delete ws.panes[id]`) is a silent
    // no-op against JanusStore — `deletePane` issues the real durable row DELETE, mirroring
    // lifecycle_rest.ts's live handler byte-identically (lockstep rule), `save()` included.
    if (owner) {
      deps.manager.ledger.deletePane(owner.projectId, id);
      deps.manager.ledger["save"]();
    }
    deps.broadcastLedgerUpdate();
    deps.broadcast({ type: "terminals_updated" });
    return `Pane ${id} deleted.`;  // EXACT — matches lifecycle_rest.ts delete_pane
  };
}

function buildDeleteProject(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // Mirrors lifecycle_rest.ts deleteEffect BYTE-IDENTICALLY: delete the workspace row, re-point the
  // active project (create a fallback default_project if none remain) when the deleted one WAS
  // active, persist, broadcast, EXACT confirm string. Idempotent guard added for the cross-restart
  // gap (the def's own existence check only covers stage time): a project already gone by replay
  // time is a no-op "not found" narration, no broadcast.
  const p = intent.params as unknown as DeleteProjectReplayParams;
  return () => {
    const id = p.projectId;
    if (!deps.manager.ledger.workspaces[id]) return `Project ${id} not found.`;
    // wsm-e2e-pinned major-finding fix: a snapshot mutation (`delete workspaces[id]`) is a silent
    // no-op against JanusStore — `deleteProject` issues the real durable row DELETE (panes cascade),
    // mirroring lifecycle_rest.ts's live handler byte-identically (lockstep rule).
    deps.manager.ledger.deleteProject(id);
    const remainingIds = Object.keys(deps.manager.ledger.workspaces);
    if (deps.manager.ledger.activeProjectId === id) {
      const nextId = remainingIds[0] || "default_project";
      if (!deps.manager.ledger.workspaces[nextId]) {
        deps.manager.ledger.addProject(nextId, process.cwd(), "Default workspace");
      }
      deps.manager.ledger.switchContext(nextId);
      deps.manager.settings.projects.activeContext = nextId;
      deps.manager.settings.projects.localWorkspacePath = deps.manager.ledger.workspaces[nextId]?.directory || process.cwd();
      deps.manager.saveSettings();
    }
    deps.manager.ledger["save"]();
    deps.broadcastLedgerUpdate();
    return `Project ${id} deleted.`;  // EXACT — matches lifecycle_rest.ts delete_project
  };
}

// The capability ⇄ builder dispatch table. A Map (not a string-keyed plain object) so a rehydrated
// capability string can never collide with an Object.prototype member name (the prototype-leak class
// that bit terminal.ts normalizePreset / the gating resolver). An unknown capability returns the
// safe no-op below — we NEVER throw on rebuild: a corrupt/legacy row must not crash boot.
// NOTE: send_keys is DELIBERATELY absent (panes_rest.ts:222-225 accepted scope-out). Its effect
// re-fires term.writeInput straight to the LIVE PTY — a confirm-after-restart would re-send a
// keystroke to a possibly-different pane process, a product question, not a mechanical port. A
// rebuilt send_keys intent falls through to the no-op default; tests/test_actionEffects.ts pins that.
const EFFECT_BUILDERS = new Map<string, EffectBuilder>([
  ["create_pane", buildCreatePane],
  ["set_global_permissions", buildSetGlobalPermissions],
  ["set_pane_permissions", buildSetPanePermissions],
  ["update_metadata", buildUpdateMetadata],
  ["close_pane", buildClosePane],
  ["remove_watch_rule", buildRemoveWatchRule],
  ["delete_orchestrator_plan", buildDeleteOrchestratorPlan],
  ["create_project", buildCreateProject],
  ["clear_history", buildClearHistory],
  ["archive_pane", buildArchivePane],
  // wsm-e2e-pinned-j2e: the capability key is "restart_pane" (the matrix row), NOT the action name
  // "respawn_pane" — see RestartPaneReplayParams / panes_rest.ts's header note on the name split.
  ["restart_pane", buildRespawnPane],
  ["delete_pane", buildDeletePane],
  ["delete_project", buildDeleteProject],
]);

/**
 * Rebuild the deferred side effect from a persisted intent, bound to the live deps. Mirrors the
 * literal closures at the staging sites EXACTLY, so a confirm-after-restart produces byte-identical
 * effects + broadcasts. An unknown capability returns a no-op run that yields an explanatory string —
 * we NEVER throw on rebuild: a corrupt/legacy row must not crash boot; the action is simply
 * un-runnable (its confirm surfaces the explanation, then the row is removed by the normal path).
 */
export function buildActionRun(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  // Map dispatch (prototype-safe) -> per-capability builder. An unknown capability returns a safe
  // no-op run that yields an explanatory string — we NEVER throw on rebuild: a corrupt/legacy row
  // must not crash boot; the action is simply un-runnable (its confirm surfaces the explanation,
  // then the row is removed by the normal path). Each builder reproduces its staging-site closure
  // EXACTLY (effects, ordering, broadcasts, and the byte-identical confirm string).
  const builder = EFFECT_BUILDERS.get(intent.capability);
  if (builder) return builder(intent, deps);
  return () => `Cannot replay deferred action: unknown capability "${intent.capability}".`;
}
