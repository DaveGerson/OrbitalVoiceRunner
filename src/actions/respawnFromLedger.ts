/**
 * src/actions/respawnFromLedger.ts — the ONE "respawn a pane from its PERSISTED identity" spawn
 * closure, shared by restore_archived_pane (src/actions/defs/archive.ts) and respawn_pane's
 * ledger-only branch (src/actions/defs/panes_rest.ts).
 *
 * Both call sites had a byte-identical spawn body: derive the launch command from tool_preset
 * (presetCommand(normalizePreset(pane.tool_preset), …, defaultShellCommand) — never last_command),
 * resolve cwd to the OWNING project's directory (process.cwd() fallback when the project row is
 * gone — legacy recreates, SQLite falls back), addTerminal INTO the owning project id (not the
 * active one), then broadcast ledger + terminals. The two former bodies differed only in their
 * confirm narration and in archive's defensive `permissions_mode || …` / `session_id || …`
 * fallbacks — both no-ops for a valid PaneMeta (permissions_mode is a required non-empty union,
 * session_id is a required string and "" || "" === ""), so the merged closure is behaviorally
 * equivalent. The message stays a PARAMETER so each call site keeps its exact wording.
 *
 * The GATE WIRING stays at the call sites (archive: ledger-restore-then-gated-spawn; respawn_pane:
 * gated restart) — only this spawn closure is shared. Lives under src/actions/ (not in a def file)
 * so both defs import it without a cycle: it imports only the terminal launch helpers + the
 * ActionContext type, exactly what the defs already import.
 */
import type { ActionContext } from "./types";
import type { PaneMeta } from "../types";
import { normalizePreset, presetCommand } from "../terminal";

/**
 * Spawn a terminal from a pane's persisted identity and fan out the ledger/terminals broadcasts.
 * Returns the supplied `message` (the call site's confirm narration). The caller owns the gate
 * decision and only invokes this on the Auto-run / in-process-confirm path.
 *
 * @param ctx        the action context (manager + broadcasts).
 * @param paneId     the pane id to respawn.
 * @param pane       the persisted PaneMeta (preset/permissions/session derive from it).
 * @param projectId  the OWNING project id — both the cwd source and addTerminal's 7th arg.
 * @param message    the confirm narration to return verbatim.
 */
export function respawnFromLedger(
  ctx: ActionContext,
  paneId: string,
  pane: PaneMeta,
  projectId: string,
  message: string,
): string {
  const preset = normalizePreset(pane.tool_preset);
  const cmd = presetCommand(preset, ctx.manager.settings.presets, ctx.manager.settings.advanced?.defaultShellCommand);
  const cwd = ctx.manager.ledger.getProject(projectId)?.directory || process.cwd();
  ctx.manager.addTerminal(
    paneId,
    cwd,
    cmd,
    preset,
    pane.permissions_mode,
    pane.session_id,
    projectId,
  );
  ctx.broadcastLedgerUpdate();
  ctx.broadcastTerminalsUpdated();
  return message;
}

/** fikj.11 (vc-D): the restart-claim seam shared by the LIVE handler (panes_rest.ts) and the
 *  replay builder (actionEffects.ts) — kept in the respawn home both already import so the two
 *  mirrored restart paths cannot drift. Best-effort: a correction fault never breaks the restart. */
export type RestartClaimLedger = {
  record(claim: {
    claimId: string; paneId: string;
    kind: "dispatch" | "restart" | "completion" | "readiness";
    assertedText: string; assertedAt: number; spoken: boolean;
  }): void;
  invalidate(ref: string, groundTruth: string, opts?: { severity?: "exception" | "info" }): unknown;
};

/** Monotonic per-process suffix: two restarts of the SAME pane in the SAME millisecond would
 *  otherwise mint identical claimIds and merge claim identities — converting the ledger's designed
 *  supersession-silence into a spoken falsehood (the survivor's retraction arms would target the
 *  wrong claim). The counter breaks the tie; time keeps the ids humanly orderable. */
let restartClaimSeq = 0;

/** Record the ACK-before-readiness claim at ack time. Returns the claimId the async arms retract
 *  by. Time+seq-suffixed: a repeat restart supersedes its predecessor through the ledger's own
 *  (pane, kind) supersession — never a duplicate correction, even for two same-millisecond
 *  restarts (the monotonic seq guarantees distinct claim identities).
 *  Deliberate asymmetry: restart claims are unconditionally `spoken: true` — the confirm string
 *  always reaches the invoking surface (and a voice correction for a silent UI-failure is the
 *  rank-5 feature) — while dispatch claims compute `spoken` from the narration push result. */
export function recordRestartClaim(ledger: RestartClaimLedger | undefined, paneId: string, assertedText: string): string {
  const claimId = `restart:${paneId}:${Date.now()}:${++restartClaimSeq}`;
  if (!ledger) return claimId;
  try {
    ledger.record({ claimId, paneId, kind: "restart", assertedText, assertedAt: Date.now(), spoken: true });
  } catch (e) {
    console.error(`[vc-d] restart claim record failed for ${paneId}:`, e);
  }
  return claimId;
}

/** Retract a restart-ack claim (exception severity — a not-up pane is the worst kind of news). */
export function invalidateRestartClaim(
  ledger: RestartClaimLedger | undefined,
  claimId: string,
  paneId: string,
  groundTruth: string,
): void {
  if (!ledger) return;
  try {
    ledger.invalidate(claimId, `pane ${paneId}: ${groundTruth}`, { severity: "exception" });
  } catch (e) {
    console.error(`[vc-d] restart claim invalidate failed for ${paneId}:`, e);
  }
}
