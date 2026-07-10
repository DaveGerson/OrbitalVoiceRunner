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
 *
 * cv2 CONVERGENCE (operator decision D5): the FIVE handoff WRITE tools gained a REST twin under the
 * canonical POST /api/<resource>/:id/<verb> family (propose_handoff -> POST /api/handoffs, revise_handoff
 * -> POST /api/handoffs/:handoff_id/revise, stage_handoff -> POST .../stage, reject_handoff -> POST
 * .../reject, deliver_handoff -> POST .../deliver). The first four are PURE LEDGER ops (no pane write),
 * safe on the session:null REST path. deliver_handoff WRITES to a live pane but routes through
 * ctx.dispatchProposal (restDispatchProposal on REST — the SAME gated seam execute_plan rides), so its
 * twin enforces capabilityGates.deliver_handoff at PARITY with voice via status-via-kinds (Auto->200 /
 * Ask->202 / Off->403). All five are now voice+rest and were REMOVED from the allow-list.
 *
 * 7ep / PERMANENT voice-only reads: get_pane_delta, list_pending_approvals, get_attention_digest stay
 * voice-only BY DESIGN, NOT as convergence residue. get_pane_delta MUTATES a per-pane read cursor (it is
 * not an idempotent GET); list_pending_approvals + get_attention_digest are SESSION-SCOPED (they read the
 * per-connection live state, which is always empty on a session:null REST request). A REST twin for any
 * of the three would be either unsafe (cursor mutation) or vacuous (empty) — so they are permanent.
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
  // cv2 (D5) CONVERGED deliver_handoff too: it WRITES to a live pane, but it routes through
  // ctx.dispatchProposal (restDispatchProposal on REST — the SAME gated seam execute_plan rides), so its
  // POST /api/handoffs/:handoff_id/deliver twin enforces capabilityGates.deliver_handoff at PARITY with
  // voice (Auto->write 200 / Ask->HiTL pending 202 / Off->block 403). It is now voice+rest and MUST NOT be
  // allow-listed here (isMultiSurface skips it).

  // ── PERMANENT voice-only READS (7ep — NOT convergence residue; no REST twin will ever exist) ─────
  // cv1 CONVERGED the six session-INDEPENDENT reads to REST (get_pane_summary, get_pane_command_history,
  // get_pane_gates, list_capabilities, list_handoffs, read_handoff) — now voice+rest, multi-surface, so
  // they MUST NOT be allow-listed here (isMultiSurface skips them). The three below are PERMANENT
  // voice-only by design (7ep decided this; the route-cutover for the converged reads is already done):
  //   - get_pane_delta MUTATES a per-pane read cursor → not an idempotent GET; a REST twin would be unsafe.
  //   - list_pending_approvals / get_attention_digest are SESSION-SCOPED → they read the per-connection
  //     live state, which is ALWAYS empty on a session:null REST request; a REST twin would be vacuous.
  // These are a final decision, not a deferred convergence item — do NOT remove them expecting a twin.
  get_pane_delta: new Set<Surface>(["voice"]),
  list_pending_approvals: new Set<Surface>(["voice"]),
  get_attention_digest: new Set<Surface>(["voice"]),
  // get_project_notes / search_notes: voice-only model-facing reads (the operator-direct UI reads are the
  // separate rest-only read_project_notes def). Convergence residue — a REST twin remains a future item.
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
  // cv2 (D5) CONVERGED the FIVE handoff WRITE tools — propose_handoff (POST /api/handoffs),
  // revise_handoff (POST .../:handoff_id/revise), stage_handoff (POST .../stage), reject_handoff
  // (POST .../reject), deliver_handoff (POST .../deliver). They are now voice+rest (the handoff-drawer
  // button contract), so they are multi-surface and MUST NOT be allow-listed here (isMultiSurface skips
  // them). deliver routes through ctx.dispatchProposal (the gated seam), enforcing the gate on REST too.

  // ── Convergence-track residue: voice-only locks mutator (REST/WS twin is a future item) ──────────
  set_global_permissions: new Set<Surface>(["voice"]),

  // ── c55.16: set_capability_gate is now VOICE-ONLY (the bulk REST/UI gate-map write is the separate
  // rest-only set_pane_gates def below). set_capability_gate is the single-entry, tighten-only voice
  // meta-tool; its dormant rest binding (the capability-gates path) was removed and re-homed onto
  // set_pane_gates, making set_capability_gate single-surface → it MUST be allow-listed here. ──
  set_capability_gate: new Set<Surface>(["voice"]),
  // ── c55.16: set_pane_gates — NEW rest-only BULK per-pane gate-map writer (operator matrix-editor's
  // "Save"; no voice twin BY DESIGN — voice uses set_capability_gate). Converges the inline PUT
  // /api/projects/:projectId/panes/:paneId/capability-gates. ──
  set_pane_gates: new Set<Surface>(["rest"]),

  // ── c55 Batch C: NEW rest-only pane/UI defs (no voice twin BY DESIGN — pure UI/operator-direct) ──
  // These converge inline app.post(...) routes that never had a Gemini voice tool. They are rest-only
  // (surfaces = {'rest'}) so they don't force a voice-tool description; a voice twin is not planned.
  respawn_pane: new Set<Surface>(["rest"]),
  send_keys: new Set<Surface>(["rest"]),
  resize_pane: new Set<Surface>(["rest"]),
  clear_history: new Set<Surface>(["rest"]),
  clear_exited: new Set<Surface>(["rest"]),
  // ── Phase 1 (deferrable-toggle honesty): archive_pane is the rest-only "archive THIS pane" op (pure
  // ledger move, no process stop). No voice twin BY DESIGN — the voice exit+archive tool is close_pane
  // (which terminates), and bulk exited-archive is clear_exited; standalone archive is operator-UI. ──
  // cv3 (D5) RATIFIED this REST-only asymmetry as INTENTIONAL & PERMANENT: a voice "archive this pane"
  // twin would be redundant with close_pane (semantic exit+archive) — the operator already has a voice
  // path to the same intent, so archive_pane stays rest-only (operator-UI) with NO voice twin.
  archive_pane: new Set<Surface>(["rest"]),

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
  // rest-only (surfaces = {'rest'}) so they don't force a voice-tool description.
  // cv3 (D5) RATIFICATION: the watch-rule READ (list_watch_rules) and the plan/rule DELETES
  // (remove_watch_rule, delete_orchestrator_plan) stay REST-only by design — these are operator-UI
  // management ops; a spoken "list my watch rules" / "delete plan X" twin is not planned. The ONE
  // watch-rule op whose voice twin is still genuinely OPEN (not ratified rest-only) is add_watch_rule:
  // its matrix row exists (default Ask) but the voice tool is DEFERRED to wsm-e2e-pinned-dvn (decide:
  // voice twin vs accept) — it is allow-listed here only until that decision lands. See cv3 / dvn.
  list_watch_rules: new Set<Surface>(["rest"]),
  add_watch_rule: new Set<Surface>(["rest"]),
  remove_watch_rule: new Set<Surface>(["rest"]),
  delete_orchestrator_plan: new Set<Surface>(["rest"]),

  // ── Voice-only by design (multi-cli spec §8, bead 1y8; renamed restart_pane -> promote_pane_mode,
  // wsm-e2e-pinned-egc): promote_pane_mode is the SEMANTIC live-promotion tool. The REST/UI surface
  // for the same intent is set_pane_permissions (which also delegates to the live applyPaneMode choke
  // point); a separate promote_pane_mode REST twin would be a redundant affordance. ─
  // (c55: this is the CONCURRENT live-mode voice tool; c55's process-restart is the distinct `respawn_pane` above.)
  promote_pane_mode: new Set<Surface>(["voice"]),

  // ── Voice-only by design (wsm-e2e-pinned-5h0 A-voice): close_pane is the SEMANTIC exit+archive
  // voice tool. The REST/UI surface for the same intent is the hand-rolled POST /api/projects/:p/
  // panes/:id/stop route + the UI Exit button — both call manager.stopAndArchivePane — so a separate
  // close_pane REST registry twin would be a redundant affordance (same reasoning as promote_pane_mode). ─
  close_pane: new Set<Surface>(["voice"]),

  // ── voice macros (8fz.6): REST/UI-only CRUD by design (operator decision 2026-07-06) ────────────
  // Authoring is REST + Pass-view UI ONLY — voice can FIRE a macro (via the utterance-match interceptor
  // in src/voice/index.ts, NOT a Gemini tool) but can NEVER define or modify one. So none of these
  // expose a voice surface; there is deliberately no voice-surface define/delete verb.
  list_macros: new Set<Surface>(["rest"]),
  define_macro: new Set<Surface>(["rest"]),
  delete_macro: new Set<Surface>(["rest"]),

  // ── voice-UX wave 3: voice-only by design ─────────────────────────────────────────────────────
  // get_status_summary is a SESSION-scoped read (same 7ep rationale as get_attention_digest/
  // list_pending_approvals — a REST twin would be vacuous on the session:null REST path).
  get_status_summary: new Set<Surface>(["voice"]),
  // focus_pane is conversational (spoken-reference) focus; the UI/REST path for the same intent is
  // the existing set_active_pane WS frame, not a registry twin. No REST/WS twin is planned.
  focus_pane: new Set<Surface>(["voice"]),

  // ── Wave 6 knowledge-capture (hwu.*): voice-only by design ───────────────────────────────────────
  // catch_me_up (hwu.2) is the spoken away-digest verb; its UI/REST twin would be vacuous (it composes
  // the session-independent event digest but is fired conversationally). save_transcript_note (hwu.3) is
  // the "save that as a note" voice verb — the operator-direct UI twin is the existing rest note route
  // (create_project_note, which now also classifies). promote_draft (hwu.4) reads the active pane's live
  // dictation draft (per-connection state) → a REST twin would be vacuous, same rationale as the other
  // draft/focus composers above. All three are voice-only; no REST/WS twin is planned.
  catch_me_up: new Set<Surface>(["voice"]),
  save_transcript_note: new Set<Surface>(["voice"]),
  promote_draft: new Set<Surface>(["voice"]),
  // export_project (hwu.6) is the voice write verb (fixed-path artifact); get_project_export is its
  // rest-only READ twin (the download route) — no voice twin BY DESIGN (voice never reads the body aloud).
  export_project: new Set<Surface>(["voice"]),
  get_project_export: new Set<Surface>(["rest"]),

  // ── Phase 3 Step 3.3 instruction-envelope verbs (spec 2026-07-09-instruction-routing.md §5.3):
  // voice-only by design. These compose/revise/route the CONVERSATIONAL instruction envelope for the
  // operator's open pane — the typed/UI twin for the same intent is the EXISTING Workbench draft
  // surface (WS draft_edit + PUT /api/panes/:p/:id/draft + POST /draft/send), which the convergence
  // bridge (spec §5.2) keeps mutating the SAME per-pane exchange draft. A separate REST registry twin
  // for each verb would be a redundant affordance (same reasoning as update_draft_prompt/focus_pane). ─
  draft_instruction: new Set<Surface>(["voice"]),
  revise_instruction: new Set<Surface>(["voice"]),
  retarget_instruction: new Set<Surface>(["voice"]),
  confirm_instruction: new Set<Surface>(["voice"]),
  cancel_instruction: new Set<Surface>(["voice"]),
  send_instruction: new Set<Surface>(["voice"]),

  // ── Phase 4, Step 4.3 AgentExchange recovery actions: NEW rest-only defs (no voice twin — see
  // src/actions/defs/lifecycle_rest.ts's own "SCOPE NOTE (voice)"). All four key off an opaque
  // exchange_id (the id an attention item/notification already carries), which is not naturally
  // something an operator would SPEAK; a voice-natural phrasing needs pane-scoped resolution
  // instead of an id lookup — deferred as a distinct, larger design item, not silently dropped. ──
  resume_inspect_exchange: new Set<Surface>(["rest"]),
  retry_exchange: new Set<Surface>(["rest"]),
  cancel_exchange: new Set<Surface>(["rest"]),
  open_exchange_pane: new Set<Surface>(["rest"]),

  // ── Phase 5, Step 5.2 exchange replay/metrics: NEW rest-only observability defs (no voice twin —
  // see src/actions/defs/observability.ts's own scope note). Both outputs (a full multi-field
  // timeline, a many-field metrics report) are read/inspected via REST/CLI, not spoken; a voice
  // twin is not planned. ──
  replay_exchange: new Set<Surface>(["rest"]),
  get_exchange_metrics: new Set<Surface>(["rest"]),
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
