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

  // ── Voice-only by design (multi-cli spec §8, bead 1y8): restart_pane is the SEMANTIC live-promotion
  // tool. The REST/UI surface for the same intent is set_pane_permissions (which also delegates to the
  // live applyPaneMode choke point); a separate restart_pane REST twin would be a redundant affordance. ─
  restart_pane: new Set<Surface>(["voice"]),
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
