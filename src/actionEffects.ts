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
import { actionSchemaHash } from "./actions/registry";

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
export interface ApplyPaneModeParams { paneId: string; permissionsMode: string; source: "voice" | "ui" | "restart_pane"; }
/**
 * Params captured by the #27 update_metadata closures (amend_note / delete_note, server.ts:2511/2525).
 * `op` is the discriminator — both sites share capability "update_metadata" but call different ledger
 * methods and return different confirm strings. `text` is the ENQUEUE-BOUND amend text (#27 MUST-FIX
 * #3): a confirm-after-restart must apply exactly this text, not whatever the model says next.
 */
export interface UpdateMetadataParams { op: "amend" | "delete"; noteId: string; text?: string; }
/** Params captured by the close_pane closure (terminate + recoverable archive). */
export interface ClosePaneParams { paneId: string; projectId?: string; }
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
}

/**
 * Rebuild the deferred side effect from a persisted intent, bound to the live deps. Mirrors the
 * literal closures at the staging sites EXACTLY, so a confirm-after-restart produces byte-identical
 * effects + broadcasts. An unknown capability returns a no-op run that yields an explanatory string —
 * we NEVER throw on rebuild: a corrupt/legacy row must not crash boot; the action is simply
 * un-runnable (its confirm surfaces the explanation, then the row is removed by the normal path).
 */
export function buildActionRun(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  switch (intent.capability) {
    case "create_pane": {
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
        // Reproduce the EXACT confirm string of the originating staging site (Risk 1 drift guard).
        // The side effects above are identical across origins; only the return string differs.
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
      };
    }
    case "set_global_permissions": {
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
    case "set_pane_permissions": {
      // 3V.4: TWO staging sites share this capability. The applyPaneMode choke point (live-signal /
      // restart-resume mechanics) stages { paneId, permissionsMode, source }; the legacy locks.ts
      // fallback stages { paneId, projectId, permissionsMode }. `source` discriminates. A FULL
      // live replay of applyPaneMode is impractical here — this deps bag has no adapter/poll/gate
      // seams, and re-entering applyPaneMode would re-route through gateOrDefer (still Ask ->
      // re-defer forever). So the rebuild applies WHAT IT CAN reach: the live pane object's mode
      // (next-spawn semantics, when the pane is running) + the ledger persist (PERSIST-WINS mirror
      // of gating's persistMode) + the broadcasts — and SAYS, in both the broadcast note and the
      // confirm string, that the pane needs a restart (restart-resume) before the LIVE process
      // switches. Post-restart panes boot INERT anyway, so the persisted mode governs the next start.
      if (typeof (intent.params as { source?: unknown }).source === "string") {
        const p = intent.params as unknown as ApplyPaneModeParams;
        return () => {
          const term = deps.manager.terminals[p.paneId];
          if (term) term.setPermissionsMode(p.permissionsMode);
          // PERSIST-WINS: mirror gating's persistMode (active project, forced updatePane).
          const ws = deps.manager.ledger.getActiveProject?.();
          const pane = ws?.panes?.[p.paneId];
          if (ws && pane) {
            pane.permissions_mode = p.permissionsMode;
            deps.manager.ledger.updatePane(deps.manager.ledger.activeProjectId || "default_project", pane, true);
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
      const p = intent.params as unknown as SetPanePermissionsParams;
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
    case "update_metadata": {
      // RE-SCOPE CORE (kzt-rescope.md §3.4): the #27 amend_note / delete_note deferral. The ORIGINAL
      // buildActionRun lacked this case → a rebuilt amend returned the no-op "unknown capability"
      // string and applied NO text (the precise #27 notes-recall regression). `op` discriminates the
      // two sites; `text` is the enqueue-bound amend text (applied verbatim across a restart).
      const p = intent.params as unknown as UpdateMetadataParams;
      return () => {
        if (p.op === "amend") {
          deps.manager.ledger.amendNote(p.noteId, p.text ?? "");
          deps.broadcastLedgerUpdate();
          return `Note ${p.noteId} updated.`;     // EXACT — matches server.ts:2514
        }
        deps.manager.ledger.deleteNote(p.noteId);
        deps.broadcastLedgerUpdate();
        return `Note ${p.noteId} deleted.`;       // EXACT — matches server.ts:2528
      };
    }
    case "close_pane": {
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
    case "remove_watch_rule": {
      // c55.16 tech_debt_buildactionrun: durable replay of the c55.10 gated rest-only cap. Mirrors
      // removeEffect (src/actions/defs/watch_rules.ts:187-195) BYTE-IDENTICALLY — re-find by id (the
      // idempotent guard: a rule deleted between stage and confirm is a no-op), splice, force-persist
      // via ledger.save(true), broadcast watch_rules_updated with the CURRENT live array, return the
      // EXACT confirm string. CRITICAL LOCKSTEP RULE (header §): keep in step with the def closure.
      const p = intent.params as unknown as RemoveWatchRuleParams;
      return () => {
        const i = deps.manager.ledger.watchRules.findIndex((r: { id: string }) => r.id === p.ruleId);
        if (i !== -1) {
          deps.manager.ledger.watchRules.splice(i, 1);
          deps.manager.ledger["save"](true);
          deps.broadcast({ type: "watch_rules_updated", watchRules: deps.manager.ledger.watchRules });
        }
        return `Watch rule ${p.ruleId} removed.`;  // EXACT — matches watch_rules.ts:194
      };
    }
    case "delete_orchestrator_plan": {
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
    // NOTE: send_keys is DELIBERATELY absent (panes_rest.ts:222-225 accepted scope-out). Its effect
    // re-fires term.writeInput straight to the LIVE PTY — a confirm-after-restart would re-send a
    // keystroke to a possibly-different pane process, a product question, not a mechanical port. The
    // rebuilt intent falls through to the no-op default below; tests/test_actionEffects.ts pins that.
    default:
      return () => `Cannot replay deferred action: unknown capability "${intent.capability}".`;
  }
}
