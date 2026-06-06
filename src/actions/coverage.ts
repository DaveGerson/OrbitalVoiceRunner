/**
 * src/actions/coverage.ts — drift becomes a REPORT, not a surprise (§5.3 / §5.7).
 *
 * surfaceCoverage(registry) returns, per action, which of {voice, rest, ws} it is exposed on. The
 * test suite (§8.4 #20) asserts that every single-surface action is on the INTENTIONAL_ASYMMETRY
 * allow-list; anything voice-only or rest-only that is NOT allow-listed fails the build. The
 * Convergence track (§7) then REMOVES entries from the allow-list one group at a time, each removal
 * forcing the missing surface to exist.
 *
 * PHASE A NOTE: this is the empty-ish SEED. The full §4.2 asymmetry list (every current voice-only
 * read/handoff + rest-only infra) is filled in REG1 Phase C, when the other 37 tools land and we
 * know each tool's real current surfaces. For the small proof registry, the brake trio + list_panes
 * are all multi-surface (voice+rest+ws / voice+rest), so the seed only needs to cover proof tools
 * that are intentionally single-surface — currently none.
 *
 * cv1 CONVERGENCE: six session-independent reads gained a registry-derived REST twin
 * (get_pane_summary -> GET /api/panes/:pane_id/summary, get_pane_command_history -> .../history,
 * get_pane_gates -> .../gates, list_capabilities -> GET /api/capabilities,
 * list_handoffs -> GET /api/handoffs, read_handoff -> GET /api/handoffs/:handoff_id). They are now
 * voice+rest and were REMOVED from the allow-list below (multi-surface tools are never allow-listed).
 * The reads that stay voice-only do so on purpose: get_pane_delta mutates a per-pane read cursor and
 * list_pending_approvals / get_attention_digest are session-scoped (empty on session:null REST).
 */

import type { ActionDef, Surface } from "./types";

/** Per-action surface presence. */
export interface SurfacePresence {
  name: string;
  voice: boolean;
  rest: boolean;
  ws: boolean;
}

/**
 * INTENTIONAL_ASYMMETRY — the allow-list of actions that are legitimately single-surface.
 *
 * Map of action name -> the surfaces it is intentionally restricted to. An action appears here ONLY
 * if its single-surface status is currently sanctioned: either PERMANENT by design (set_voice_mute IS
 * the mic — no REST/WS twin will ever exist) or a CONVERGENCE-TRACK residue (a voice-only read/mutator
 * whose REST/WS twin is a future §7 Convergence item, allow-listed now under Decision 3 register-as-is
 * so the §8.4 #20 build-gate is green WITHOUT mutating any tool's surfaces).
 *
 * REG1 Phase-1 exit (workstream A): every single-surface action in REGISTRY (all 41 tools surveyed —
 * the 6 inline registry.ts defs + the 35 grouped defs/* defs) is enumerated below. Multi-surface tools
 * (voice+rest, e.g. list_panes / create_pane / the brake trio at voice+rest+ws) are NOT listed —
 * isMultiSurface skips them. Removing an entry here is how the Convergence track later FORCES the
 * missing surface to be implemented (the build-gate goes red until the twin exists).
 */
export const INTENTIONAL_ASYMMETRY: Readonly<Record<string, ReadonlySet<Surface>>> = Object.freeze({
  // ── PERMANENT (by design — no twin will ever exist) ─────────────────────────────────────────────
  set_voice_mute: new Set<Surface>(["voice"]), // voice-only BY DESIGN — it IS the mic toggle (permanent)

  // ── Convergence-track residue: voice-only pane-WRITE choke-points (REST/WS twin is a future item) ─
  propose_command: new Set<Surface>(["voice"]), // dispatchProposal pane-WRITE HiTL path; voice-only today
  deliver_handoff: new Set<Surface>(["voice"]), // staged-handoff delivery (gated via dispatchProposal); voice-only today

  // ── Convergence-track residue: voice-only READS (REST/WS read twin is a future item) ─────────────
  // cv1 CONVERGED six session-independent reads to REST (get_pane_summary, get_pane_command_history,
  // get_pane_gates, list_capabilities, list_handoffs, read_handoff) — they are now voice+rest, so they
  // are multi-surface and MUST NOT be allow-listed here (isMultiSurface skips them). The three that
  // remain voice-only are NOT session-independent: get_pane_delta mutates a per-pane read cursor (unsafe
  // as an idempotent GET) and list_pending_approvals / get_attention_digest are session-scoped (always
  // empty on a session:null REST request).
  get_pane_delta: new Set<Surface>(["voice"]),
  list_pending_approvals: new Set<Surface>(["voice"]),
  get_attention_digest: new Set<Surface>(["voice"]),
  get_project_notes: new Set<Surface>(["voice"]),
  search_notes: new Set<Surface>(["voice"]),

  // ── Convergence-track residue: voice-only NOTE mutators (REST/WS twin is a future item) ──────────
  amend_note: new Set<Surface>(["voice"]),
  add_project_note: new Set<Surface>(["voice"]),
  add_pane_note: new Set<Surface>(["voice"]),
  delete_note: new Set<Surface>(["voice"]),

  // ── Convergence-track residue: voice-only draft/focus composers (REST/WS twin is a future item) ──
  switch_active_pane: new Set<Surface>(["voice"]),
  update_draft_prompt: new Set<Surface>(["voice"]),
  propose_handoff: new Set<Surface>(["voice"]),
  revise_handoff: new Set<Surface>(["voice"]),
  stage_handoff: new Set<Surface>(["voice"]),
  reject_handoff: new Set<Surface>(["voice"]),

  // ── Convergence-track residue: voice-only locks mutator (REST/WS twin is a future item) ──────────
  set_global_permissions: new Set<Surface>(["voice"]),

  // ── c55 Batch C: NEW rest-only pane/UI defs (no voice twin BY DESIGN — pure UI/operator-direct) ──
  // These converge inline app.post(...) routes that never had a Gemini voice tool. They are rest-only
  // (surfaces = {'rest'}) so they don't force a voice-tool description; a voice twin is not planned.
  respawn_pane: new Set<Surface>(["rest"]),
  send_keys: new Set<Surface>(["rest"]),
  resize_pane: new Set<Surface>(["rest"]),
  clear_history: new Set<Surface>(["rest"]),
  clear_exited: new Set<Surface>(["rest"]),

  // ── c55 Batch F: NEW rest-only STRUCTURED page-load READS (no voice twin BY DESIGN) ─────────────
  // Both converge an inline GET route whose structured body the flat {output:string} cannot carry; they
  // ride the rest.toHttp primitive. get_stop_all_status is the boot-restore snapshot {frozen,running};
  // get_terminal_history is the RAW history array (the voice history read get_pane_command_history emits
  // PROSE, so it is a separate def — not reused). No voice tool is planned for either.
  get_stop_all_status: new Set<Surface>(["rest"]),
  get_terminal_history: new Set<Surface>(["rest"]),

  // ── c55.11: NEW rest-only structured page-load READS (no voice twin BY DESIGN) ───────────────────
  // Faithful ports of the inline GET /api/{ledger,attention,plans,recipes}; each rides rest.toHttp to
  // emit its value TOP-LEVEL. ALWAYS_ALLOWED plumbing reads (the inline routes were ungated/unredacted).
  get_ledger: new Set<Surface>(["rest"]),
  get_attention_queue: new Set<Surface>(["rest"]),
  list_orchestrator_plans: new Set<Surface>(["rest"]),
  list_orchestration_recipes: new Set<Surface>(["rest"]),

  // ── c55.12: NEW rest-only operator-UI note/context defs (no voice twin BY DESIGN — the voice note
  // tools are the gated/redacted model-facing path; these are the ungated operator-direct UI path). ──
  create_project_note: new Set<Surface>(["rest"]),
  read_project_notes: new Set<Surface>(["rest"]),
  edit_note: new Set<Surface>(["rest"]),
  remove_note: new Set<Surface>(["rest"]),
  create_pane_note: new Set<Surface>(["rest"]),
  add_pane_context: new Set<Surface>(["rest"]),

  // ── c55.13: NEW rest-only operator-UI archive defs (no voice twin BY DESIGN — archive management is
  // operator-direct UI plumbing, spec §10 step 3). ──
  list_archived_panes: new Set<Surface>(["rest"]),
  restore_archived_pane: new Set<Surface>(["rest"]),
  delete_archived_pane: new Set<Surface>(["rest"]),

  // ── c55.14: NEW rest-only lifecycle defs. update_project/stop_pane ungated; delete_project/delete_pane
  // GATED (new Destructive caps, default Ask). No voice twin. ──
  update_project: new Set<Surface>(["rest"]),
  stop_pane: new Set<Surface>(["rest"]),
  delete_project: new Set<Surface>(["rest"]),
  delete_pane: new Set<Surface>(["rest"]),

  // ── c55.15: NEW rest-only approvals/pending HiTL defs (operator surface that RESOLVES gated actions;
  // ALWAYS_ALLOWED — above-the-gate). No voice twin (voice has list_pending_approvals / the live approval path). ──
  list_pending_commands: new Set<Surface>(["rest"]),
  list_pending_actions:  new Set<Surface>(["rest"]),
  confirm_pending_action: new Set<Surface>(["rest"]),
  cancel_pending_action:  new Set<Surface>(["rest"]),
  approve_pending_command: new Set<Surface>(["rest"]),

  // ── c55 Batch G: NEW rest-only watch-rule / plan-delete defs (no voice twin today) ───────────────
  // These converge inline app.{get,post,delete}(...) routes that never had a Gemini voice tool. They are
  // rest-only (surfaces = {'rest'}) so they don't force a voice-tool description. A voice yes/no twin for
  // remove_watch_rule / delete_orchestrator_plan (+ a dedicated gate row) is DEFERRED for ratification;
  // add_watch_rule's matrix row exists (default Ask) but stays reserved until that voice tool lands.
  list_watch_rules: new Set<Surface>(["rest"]),
  add_watch_rule: new Set<Surface>(["rest"]),
  remove_watch_rule: new Set<Surface>(["rest"]),
  delete_orchestrator_plan: new Set<Surface>(["rest"]),

  // ── Voice-only by design (multi-cli spec §8, bead 1y8): restart_pane is the SEMANTIC live-promotion
  // tool. The REST/UI surface for the same intent is set_pane_permissions (which also delegates to the
  // live applyPaneMode choke point); a separate restart_pane REST twin would be a redundant affordance. ─
  // (c55: this is the CONCURRENT live-mode voice tool; c55's process-restart is the distinct `respawn_pane` above.)
  restart_pane: new Set<Surface>(["voice"]),

  // ── Voice-only by design (wsm-e2e-pinned-5h0 A-voice): close_pane is the SEMANTIC exit+archive
  // voice tool. The REST/UI surface for the same intent is the hand-rolled POST /api/projects/:p/
  // panes/:id/stop route + the UI Exit button — both call manager.stopAndArchivePane — so a separate
  // close_pane REST registry twin would be a redundant affordance (same reasoning as restart_pane). ─
  close_pane: new Set<Surface>(["voice"]),
});

/** surfaceCoverage(registry) — total over the registry: one row per action, presence per surface. */
export function surfaceCoverage(registry: readonly ActionDef[]): SurfacePresence[] {
  return registry.map((def) => ({
    name: def.name,
    voice: def.surfaces.has("voice"),
    rest: def.surfaces.has("rest"),
    ws: def.surfaces.has("ws"),
  }));
}

/** True if an action is exposed on more than one surface (multi-surface = no asymmetry concern). */
export function isMultiSurface(presence: SurfacePresence): boolean {
  return [presence.voice, presence.rest, presence.ws].filter(Boolean).length > 1;
}

/**
 * Returns the names of actions that are single-surface but NOT on the INTENTIONAL_ASYMMETRY
 * allow-list — i.e. the drift the build should reject (§8.4 #20). Empty === parity is clean.
 */
export function unexpectedAsymmetries(registry: readonly ActionDef[]): string[] {
  const out: string[] = [];
  for (const presence of surfaceCoverage(registry)) {
    if (isMultiSurface(presence)) continue;            // multi-surface: never an asymmetry
    if (INTENTIONAL_ASYMMETRY[presence.name]) continue; // allow-listed single-surface: fine
    out.push(presence.name);
  }
  return out;
}
