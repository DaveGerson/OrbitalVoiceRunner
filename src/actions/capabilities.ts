/**
 * src/actions/capabilities.ts — the capability matrix as a TABLE + its derivation (Decision 5/6).
 *
 * Appendix A of the registry TDD spec, transcribed: one CapabilityDef per capability. The 16
 * EXISTING capabilities reuse the exact plain-language labels + categories from src/gateSurface.ts
 * (the single source for operator-facing strings — no jargon, no drift). The NEW promoted
 * capabilities (reads/focus/draft/archive/clear) default Auto/Ask per Decision 6/7, preserving
 * today's behavior while making each individually tunable.
 *
 * Per Decision 5 the capability SET is a projection of the registry: deriveCapabilities(registry)
 * walks the ActionDefs and returns the unique non-ALWAYS_ALLOWED capabilities. CAPABILITY_DEFS is
 * the metadata table those derived ids index into; a test (§8.1b #5b) asserts no orphans either way.
 */

import type { ActionDef, Capability, CapabilityDef } from "./types";
import { ALWAYS_ALLOWED } from "./types";
import { CAPABILITY_LABELS } from "../gateSurface";

/**
 * The category each EXISTING capability sits in, reused from gateSurface.CAPABILITY_CATEGORIES
 * (the matrix editor's grouped sections). Kept as a flat lookup here so each CapabilityDef can carry
 * its own `category` string. NEW promoted capabilities get a "Reading" / "Orientation" grouping.
 */
const CATEGORY: Record<string, string> = {
  // Acting in a pane
  write_to_pane: "Acting in a pane",
  deliver_handoff: "Acting in a pane",
  // Destructive
  close_pane: "Destructive",
  delete_pane: "Destructive",
  delete_project: "Destructive",
  restart_pane: "Destructive",
  clear_history: "Destructive", // NEW (Ask) — destructive, joins this group
  // Changing the locks
  set_pane_permissions: "Changing the locks",
  set_global_permissions: "Changing the locks",
  set_capability_gate: "Changing the locks",
  // Spawning work
  create_pane: "Spawning work",
  execute_plan: "Spawning work",
  apply_recipe: "Spawning work",
  add_watch_rule: "Spawning work",
  // Orientation (low-risk)
  create_project: "Orientation (low-risk)",
  update_metadata: "Orientation (low-risk)",
  switch_context: "Orientation (low-risk)",
  set_voice_mute: "Orientation (low-risk)",
  dismiss_attention: "Orientation (low-risk)",
  archive_pane: "Orientation (low-risk)", // NEW (Auto) — reversible housekeeping
  focus_pane: "Orientation (low-risk)",   // NEW (Auto) — switch_active_pane
  compose_draft: "Orientation (low-risk)", // NEW (Auto) — drafting / handoff staging
  // Reading
  read_pane: "Reading",
  read_notes: "Reading",
};

/**
 * The full capability matrix (Appendix A). `defaultGate` is the GLOBAL default; the spotlight may
 * still loosen `spotlightEligible` capabilities to Auto on the active pane. Existing labels come
 * from CAPABILITY_LABELS; NEW capabilities get a fresh plain-language label here.
 *
 * Pinned by tests §8.1b #5b (no orphans), #5c (defaultGate golden), #5d (spotlight set).
 */
export const CAPABILITY_DEFS: readonly CapabilityDef[] = [
  // ── NEW promotions (Decision 6/7) — default to today's effective behavior. Labels come from
  //    CAPABILITY_LABELS (gateSurface) — the SINGLE label source for all 24 caps, so no drift (F4). ──
  { id: "read_pane", label: CAPABILITY_LABELS.read_pane, category: CATEGORY.read_pane, defaultGate: "Auto" },
  { id: "read_notes", label: CAPABILITY_LABELS.read_notes, category: CATEGORY.read_notes, defaultGate: "Auto" },
  { id: "focus_pane", label: CAPABILITY_LABELS.focus_pane, category: CATEGORY.focus_pane, defaultGate: "Auto" },
  { id: "compose_draft", label: CAPABILITY_LABELS.compose_draft, category: CATEGORY.compose_draft, defaultGate: "Auto" },
  { id: "archive_pane", label: CAPABILITY_LABELS.archive_pane, category: CATEGORY.archive_pane, defaultGate: "Auto" },
  { id: "clear_history", label: CAPABILITY_LABELS.clear_history, category: CATEGORY.clear_history, defaultGate: "Ask" },

  // ── EXISTING 16 (gateSurface labels; current defaults transcribed from behavior) ──
  { id: "write_to_pane", label: CAPABILITY_LABELS.write_to_pane, category: CATEGORY.write_to_pane, defaultGate: "Ask", spotlightEligible: true },
  { id: "deliver_handoff", label: CAPABILITY_LABELS.deliver_handoff, category: CATEGORY.deliver_handoff, defaultGate: "Ask", spotlightEligible: true },
  { id: "create_pane", label: CAPABILITY_LABELS.create_pane, category: CATEGORY.create_pane, defaultGate: "Ask" },
  { id: "close_pane", label: CAPABILITY_LABELS.close_pane, category: CATEGORY.close_pane, defaultGate: "Ask" },
  { id: "delete_pane", label: CAPABILITY_LABELS.delete_pane, category: CATEGORY.delete_pane, defaultGate: "Ask" },
  { id: "delete_project", label: CAPABILITY_LABELS.delete_project, category: CATEGORY.delete_project, defaultGate: "Ask" },
  { id: "restart_pane", label: CAPABILITY_LABELS.restart_pane, category: CATEGORY.restart_pane, defaultGate: "Ask" },
  { id: "set_pane_permissions", label: CAPABILITY_LABELS.set_pane_permissions, category: CATEGORY.set_pane_permissions, defaultGate: "Ask" },
  { id: "set_global_permissions", label: CAPABILITY_LABELS.set_global_permissions, category: CATEGORY.set_global_permissions, defaultGate: "Ask" },
  { id: "set_capability_gate", label: CAPABILITY_LABELS.set_capability_gate, category: CATEGORY.set_capability_gate, defaultGate: "Ask" },
  { id: "add_watch_rule", label: CAPABILITY_LABELS.add_watch_rule, category: CATEGORY.add_watch_rule, defaultGate: "Ask" },
  { id: "execute_plan", label: CAPABILITY_LABELS.execute_plan, category: CATEGORY.execute_plan, defaultGate: "Ask" },
  { id: "apply_recipe", label: CAPABILITY_LABELS.apply_recipe, category: CATEGORY.apply_recipe, defaultGate: "Ask" },
  { id: "create_project", label: CAPABILITY_LABELS.create_project, category: CATEGORY.create_project, defaultGate: "Auto" },
  { id: "update_metadata", label: CAPABILITY_LABELS.update_metadata, category: CATEGORY.update_metadata, defaultGate: "Auto" },
  { id: "switch_context", label: CAPABILITY_LABELS.switch_context, category: CATEGORY.switch_context, defaultGate: "Auto" },
  { id: "set_voice_mute", label: CAPABILITY_LABELS.set_voice_mute, category: CATEGORY.set_voice_mute, defaultGate: "Auto" },
  { id: "dismiss_attention", label: CAPABILITY_LABELS.dismiss_attention, category: CATEGORY.dismiss_attention, defaultGate: "Auto" },
] as const;

/** Fast id -> CapabilityDef lookup over the table. */
export const CAPABILITY_DEF_BY_ID: ReadonlyMap<Capability, CapabilityDef> = new Map(
  CAPABILITY_DEFS.map((d) => [d.id, d] as const)
);

/**
 * deriveCapabilities(registry) — the matrix is a PROJECTION of the registry (Decision 5).
 * Returns the de-duplicated set of every ActionDef.capability, with the ALWAYS_ALLOWED sentinel
 * removed (it is not a matrix row). Order is first-seen across the registry. This REPLACES the
 * hand-maintained gateSurface.ALL_CAPABILITIES.
 */
export function deriveCapabilities(registry: readonly ActionDef[]): Capability[] {
  const seen = new Set<Capability>();
  const out: Capability[] = [];
  for (const def of registry) {
    if (def.capability === ALWAYS_ALLOWED) continue;
    if (seen.has(def.capability)) continue;
    seen.add(def.capability);
    out.push(def.capability);
  }
  return out;
}

/**
 * The capabilities the SPOTLIGHT may loosen to Auto on the active pane. Derived from the table so
 * it stays in lockstep with CAPABILITY_DEFS (and, by §8.1b #5d, with gateSurface SPOTLIGHT_CAPABILITIES).
 */
export function spotlightCapabilities(): Set<Capability> {
  return new Set(CAPABILITY_DEFS.filter((d) => d.spotlightEligible).map((d) => d.id));
}
