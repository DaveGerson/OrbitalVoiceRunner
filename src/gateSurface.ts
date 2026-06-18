/**
 * gateSurface — PURE, FRONTEND-SAFE surface derivations for the capability-matrix UI
 * (spec docs/superpowers/specs/2026-06-01-wsm-8sq-matrix-surface-design.md §4, §6, §7).
 *
 * This module is the single source of truth for THREE surface concerns:
 *   1. deriveEffectiveGates — the 16 effective gate values per pane (override -> spotlight -> global).
 *   2. derivePostureWord    — the calm one-word posture (OPEN | GUARDED | LOCKED) the chip renders.
 *   3. CAPABILITY_LABELS + CAPABILITY_CATEGORIES — the plain-language label map (NO PRODUCT JARGON).
 *
 * It imports ONLY types from ./types — no React, no PTY, no server, no `fs`. That keeps it usable
 * from the browser bundle (GateChip / CapabilityMatrixTab) AND unit-testable without the server.
 *
 * Precedence is a DELIBERATE MIRROR of resolveCapabilityGateWithContext in src/pendingApprovals.ts
 * (the server's pure resolver). We re-implement it here (rather than import) because pendingApprovals
 * pulls in ./terminal -> redactSecrets -> `fs`, which is not frontend-safe. Keep the two in lockstep:
 * any change to the override -> spotlight -> global precedence must land in BOTH.
 */

import type { CapabilityGate, GateValue, CapabilityGateMap } from "./types";
import type { CapabilityEnforcement } from "./actions/types";

/** The pane's effective autonomy mode (mirrors EffectiveMode in src/pendingApprovals.ts). */
export type EffectiveMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";

/** The calm one-word posture the per-pane chip shows (spec §2.A / §7). */
export type PostureWord = "OPEN" | "GUARDED" | "LOCKED";

/**
 * The CapabilityGate union as a runtime array — the MATRIX AUTHORITY the surface iterates
 * (deriveEffectiveGates fills all of them; the totality tests assert against it).
 *
 * F4 (wsm-e2e-pinned-lqb): this is now the WHOLE matrix (27 rows): the 16 original gates PLUS the 6
 * promoted capabilities PLUS the 2 destructive deletes (delete_pane/delete_project) PLUS the 3 c55.10
 * tightened rest-write caps (send_keys/remove_watch_rule/delete_orchestrator_plan). It MUST equal
 * the CAPABILITY_DEFS id set in src/actions/capabilities.ts.
 * We keep it a hand-list (rather than DERIVING it via `CAPABILITY_DEFS.map(d => d.id)`) ON PURPOSE:
 * capabilities.ts imports CAPABILITY_LABELS from THIS module and reads it EAGERLY inside the
 * CAPABILITY_DEFS array literal, so a back-import of CAPABILITY_DEFS here would be a value-level
 * circular dependency (whichever module loads first sees the other half-initialized). Per the F4
 * spec's escape hatch we keep the list widened to the 27 and PIN it with a test
 * (test_action_registry.ts §8.1b: ALL_CAPABILITIES === CAPABILITY_DEFS id set) so it can never drift.
 */
export const ALL_CAPABILITIES: readonly CapabilityGate[] = [
  "write_to_pane", "deliver_handoff", "create_pane", "close_pane",
  "delete_pane", "delete_project",
  "restart_pane", "set_pane_permissions", "set_global_permissions",
  "set_capability_gate", "add_watch_rule", "execute_plan",
  "apply_recipe", "create_project", "update_metadata",
  "switch_context", "set_voice_mute", "dismiss_attention",
  // ── promoted capabilities (Decision 6/9): individually-tunable, default Auto (clear_history=Ask) ──
  "read_pane", "read_notes", "focus_pane",
  "compose_draft", "archive_pane", "clear_history",
  // ── c55.10: rest-only writes tightened from ALWAYS_ALLOWED → Ask (default Ask) ──
  "send_keys", "remove_watch_rule", "delete_orchestrator_plan",
] as const;

/**
 * Capabilities the SPOTLIGHT may loosen to Auto on the ACTIVE pane ("trust follows focus").
 * MIRRORS SPOTLIGHT_CAPABILITIES in src/pendingApprovals.ts — only PRODUCTIVE writes are
 * spotlight-eligible. Destructive / meta / spawn capabilities are NEVER loosened by focus.
 */
const SPOTLIGHT_CAPABILITIES: ReadonlySet<CapabilityGate> = new Set<CapabilityGate>([
  "write_to_pane",
  "deliver_handoff",
]);

/**
 * Resolve ONE capability's effective gate value (override -> spotlight -> global -> Auto).
 * Private mirror of resolveCapabilityGateWithContext (src/pendingApprovals.ts) — see file header.
 */
function resolveOne(
  paneGate: GateValue | undefined,
  globalGate: GateValue | undefined,
  capability: CapabilityGate,
  isActivePane: boolean
): GateValue {
  if (paneGate !== undefined) return paneGate;                                   // explicit override wins
  if (isActivePane && SPOTLIGHT_CAPABILITIES.has(capability)) return "Auto";     // spotlight loosens
  return globalGate ?? "Auto";                                                   // global default, else Auto
}

/**
 * Derive the full 16-capability effective gate map for a pane — "what would actually happen if
 * Janus acted here now" (spec §2.A). Honors override -> spotlight -> global precedence per
 * capability. Total: every CapabilityGate is present in the result (never a sparse map).
 *
 * @param paneGates    the pane's per-pane override map (PaneMeta.capabilityGates) — may be undefined.
 * @param globalGates  the global default map (settings.advanced.capabilityGates) — may be undefined.
 * @param isActivePane whether this pane currently holds the spotlight (the active write target).
 */
export function deriveEffectiveGates(
  paneGates: CapabilityGateMap | undefined,
  globalGates: CapabilityGateMap | undefined,
  isActivePane: boolean
): Record<CapabilityGate, GateValue> {
  const out = {} as Record<CapabilityGate, GateValue>;
  for (const capability of ALL_CAPABILITIES) {
    out[capability] = resolveOne(paneGates?.[capability], globalGates?.[capability], capability, isActivePane);
  }
  return out;
}

/**
 * Derive the calm posture word from a pane's EFFECTIVE gate map + its effective mode (spec §7):
 *
 *   if effectiveMode === "Read-Only" OR effective.write_to_pane === "Off"  -> "LOCKED"
 *   else if any capability === "Ask" OR any capability === "Off"           -> "GUARDED"
 *   else                                                                   -> "OPEN"
 *
 * LOCKED is reserved for "Janus can't type here at all" so it stays meaningful — a peripheral Off
 * (e.g. close_pane) reads GUARDED, with the popover showing specifics.
 */
export function derivePostureWord(
  effective: Record<CapabilityGate, GateValue>,
  effectiveMode: EffectiveMode
): PostureWord {
  // LOCKED: Janus literally cannot type into this pane (Read-Only mode, or write_to_pane Off).
  if (effectiveMode === "Read-Only" || effective.write_to_pane === "Off") return "LOCKED";
  // GUARDED: not locked, but there is friction — any Ask, or any (non-write) Off.
  for (const capability of ALL_CAPABILITIES) {
    const v = effective[capability];
    if (v === "Ask" || v === "Off") return "GUARDED";
  }
  // OPEN: every relevant capability resolves Auto; Janus acts freely.
  return "OPEN";
}

// ─────────────────────────────────────────────────────────────────────────────
// rbh (bead wsm-e2e-pinned-rbh): SHARED posture/gate PALETTE — moved here OUT of GateChip.tsx so the
// chip AND both confirmation dialogs (ActionConfirmDialog / ApprovalDialog) import ONE copy. dialog ==
// chip == engine, zero drift (D4). The class strings are byte-identical to the prior GateChip-local
// consts so the chip render — and e2e/gate_chip.spec.ts — is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/** Posture word → swatch classes + a plain-language label (the one gate-language palette). */
export const POSTURE_STYLE: Record<PostureWord, { dot: string; text: string; ring: string; label: string }> = {
  OPEN: { dot: "bg-emerald-500", text: "text-emerald-400", ring: "border-emerald-500/30 bg-emerald-500/5", label: "Janus can act here freely." },
  GUARDED: { dot: "bg-amber-500", text: "text-amber-400", ring: "border-amber-500/30 bg-amber-500/5", label: "Some actions here need a checkpoint." },
  LOCKED: { dot: "bg-red-500", text: "text-red-400", ring: "border-red-500/30 bg-red-500/5", label: "Janus can't type into this pane." },
};

/** Gate value → dot color + plain word. Auto = green/Allowed, Ask = amber/Asks first, Off = red/Blocked. */
export const GATE_STYLE: Record<GateValue, { dot: string; text: string; word: string }> = {
  Auto: { dot: "bg-emerald-500", text: "text-emerald-400", word: "Allowed" },
  Ask: { dot: "bg-amber-500", text: "text-amber-400", word: "Asks first" },
  Off: { dot: "bg-red-500", text: "text-red-400", word: "Blocked" },
};

/**
 * rbh: the confirm-dialog divergence decision as a PURE function — "the operator asked for
 * `requestedMode`, but will the engine actually apply that?" Returns the divergence KIND so the dialog
 * renders the right plain-language "heads up" (and nothing when the action is clean). This lives here
 * (not in the component) so the decision is unit-testable and shares ONE source with the chip/palette
 * (D4). The two divergence sources, in precedence order:
 *   1. "global": the GLOBAL MODE overrides the requested per-pane mode. This is the ROOT cause — a
 *      Read-Only global mode also forces the write gate Off downstream, so we lead with the mode
 *      reason rather than the (secondary) gate veto.
 *   2. "gate": a bare capability gate is Off with no mode override.
 * "none" means the engine will apply exactly what was asked (clean — calm "Effective: …" only).
 *
 * PRECISION (reviewer concern 3): in the staged-but-not-yet-applied Ask flow, `effectiveMode` is the
 * pane's CURRENT mode (applyPanePerms has not run), so a mismatch with `requestedMode` does NOT by
 * itself mean the global mode wins — when the global mode is "Inherit" the requested change WILL take
 * effect on confirm (no divergence). The "global" branch therefore requires `globalOverrides` — the
 * caller's explicit signal that the global mode (≠ Inherit) is the dominating cause — so we never
 * mislabel ordinary staging as a global override. Defaults to (effectiveMode !== requestedMode) for
 * back-compat: pass it explicitly to be precise.
 */
export type ActionDivergence = "none" | "global" | "gate";

export function deriveActionDivergence(
  requestedMode: string | undefined,
  effectiveMode: EffectiveMode | undefined,
  effectiveGate: GateValue | undefined,
  // The global mode (≠ Inherit) genuinely dominates the requested per-pane mode. When omitted we fall
  // back to the raw mode mismatch (legacy behavior). Pass the server's "globalMode !== Inherit" truth
  // to avoid mislabeling staged-but-not-applied mode changes as a global override.
  globalOverrides?: boolean
): ActionDivergence {
  if (!requestedMode) return "none";                                  // no requested mode → no mode rider
  const modeMismatch = !!effectiveMode && effectiveMode !== requestedMode;
  const globalWins = globalOverrides ?? modeMismatch;                 // explicit signal wins; else legacy
  if (modeMismatch && globalWins) return "global";
  if (effectiveGate === "Off") return "gate";
  return "none";
}

/**
 * PLAIN-LANGUAGE label map (spec §6, operator directive: NO PRODUCT JARGON). Every operator-facing
 * surface (chip popover, matrix editor, voice read-backs) renders THESE strings — never the raw
 * snake_case identifier. TOTAL over the CapabilityGate union (a unit test asserts this).
 */
export const CAPABILITY_LABELS: Record<CapabilityGate, string> = {
  write_to_pane: "Type a command into a pane",
  deliver_handoff: "Hand a prompt to another pane",
  close_pane: "Close a pane",
  delete_pane: "Delete a pane permanently",
  delete_project: "Delete a project",
  restart_pane: "Restart a pane",
  set_pane_permissions: "Change a pane's autonomy mode",
  set_global_permissions: "Change the global autonomy mode",
  set_capability_gate: "Change these safety gates",
  create_pane: "Open a new pane",
  execute_plan: "Run a multi-step plan",
  apply_recipe: "Apply a workspace recipe",
  add_watch_rule: "Add an automation rule",
  create_project: "Create a project",
  update_metadata: "Update notes & metadata",
  switch_context: "Switch focus",
  set_voice_mute: "Mute or unmute voice",
  dismiss_attention: "Dismiss an alert",
  // ── promoted capabilities (F4 / wsm-e2e-pinned-lqb) — plain language, no jargon. These are the
  // SINGLE source for the promoted-cap labels; CAPABILITY_DEFS reads them back from here (no drift). ──
  read_pane: "Read a pane's output",
  read_notes: "Read notes & handoffs",
  focus_pane: "Switch which pane is open",
  compose_draft: "Compose a draft or handoff",
  archive_pane: "Archive an exited pane",
  clear_history: "Clear a pane's history",
  // ── c55.10: rest-only write caps tightened to Ask — plain language, no jargon. ──
  send_keys: "Send keystrokes to a pane",
  remove_watch_rule: "Remove an automation rule",
  delete_orchestrator_plan: "Delete an orchestrator plan",
};

/**
 * The matrix editor's grouped sections (spec §6) — sections by intent, each listing its plain-
 * labeled capabilities. Covers all 27 capabilities EXACTLY ONCE (a unit test asserts this), so the
 * grouped-toggle editor can render every capability with no orphans or duplicates. Category NAMES
 * are themselves plain language (NO PRODUCT JARGON).
 *
 * F4 (wsm-e2e-pinned-lqb): the 6 promoted capabilities slot into the matching intent groups, mirroring
 * the CATEGORY map in src/actions/capabilities.ts — clear_history is Destructive; archive_pane /
 * focus_pane / compose_draft are low-risk Orientation; read_pane / read_notes form a new "Reading" group.
 * c55.10: send_keys joins "Acting in a pane" (raw-PTY keystroke write); remove_watch_rule joins
 * "Spawning work" (mirror of add_watch_rule); delete_orchestrator_plan joins "Destructive".
 */
export const CAPABILITY_CATEGORIES: Record<string, readonly CapabilityGate[]> = {
  "Acting in a pane": ["write_to_pane", "deliver_handoff", "send_keys"],
  "Destructive": ["close_pane", "delete_pane", "delete_project", "restart_pane", "clear_history", "delete_orchestrator_plan"],
  "Changing the locks": ["set_pane_permissions", "set_global_permissions", "set_capability_gate"],
  "Spawning work": ["create_pane", "execute_plan", "apply_recipe", "add_watch_rule", "remove_watch_rule"],
  "Orientation (low-risk)": ["create_project", "update_metadata", "switch_context", "set_voice_mute", "dismiss_attention", "archive_pane", "focus_pane", "compose_draft"],
  "Reading": ["read_pane", "read_notes"],
};

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 (veto-toggle honesty): the per-capability ENFORCEMENT class, surfaced FRONTEND-SAFELY so the
// matrix editor + chip popover render the HONEST control for each capability (3-way / 2-way / badge).
//
// METADATA-PLUMBING CHOICE: this is a hand-list MIRROR of `enforcement` in src/actions/capabilities.ts
// (CAPABILITY_DEFS), kept HERE rather than importing `enforcementOf` into the React bundle — for the
// SAME reason ALL_CAPABILITIES is a hand-list (see its docblock): capabilities.ts imports
// CAPABILITY_LABELS from THIS module EAGERLY inside its CAPABILITY_DEFS array literal, so a back-import
// of capabilities.ts here would be a value-level circular dependency. The UI already sources ALL its
// capability metadata (labels, categories, ALL_CAPABILITIES) from this one frontend-safe module; adding
// enforcement here keeps that single surface and avoids coupling the React bundle to the actions layer.
// A LOCKSTEP TEST (tests/test_capability_enforcement_lockstep.ts) asserts this map === enforcementOf for
// all 27 caps, so the two sources can never drift.
// ─────────────────────────────────────────────────────────────────────────────
export const CAPABILITY_ENFORCEMENT: Record<CapabilityGate, CapabilityEnforcement> = {
  // deferrable — full Auto/Ask/Off (3-way)
  write_to_pane: "deferrable",
  deliver_handoff: "deferrable",
  send_keys: "deferrable",
  create_pane: "deferrable",
  close_pane: "deferrable",
  delete_pane: "deferrable",
  delete_project: "deferrable",
  restart_pane: "deferrable",
  clear_history: "deferrable",
  delete_orchestrator_plan: "deferrable",
  set_pane_permissions: "deferrable",
  set_global_permissions: "deferrable",
  set_capability_gate: "deferrable",
  execute_plan: "deferrable",
  apply_recipe: "deferrable",
  add_watch_rule: "deferrable",
  remove_watch_rule: "deferrable",
  create_project: "deferrable",
  update_metadata: "deferrable",
  archive_pane: "deferrable",
  // veto — Allow/Off only (2-way); "Ask" is meaningless and must never be shown
  read_pane: "veto",
  read_notes: "veto",
  focus_pane: "veto",
  switch_context: "veto",
  compose_draft: "veto",
  dismiss_attention: "veto",
  // informational — gating is self-defeating; read-only badge, never an interactive control
  set_voice_mute: "informational",
};

/** The honest control type the UI must render for a capability, derived from its enforcement class. */
export type GateControlKind = "three-way" | "two-way" | "badge";

/**
 * controlForEnforcement(cap) — the SINGLE pure mapping from a capability to the control the UI renders:
 *   deferrable    → "three-way" (Auto / Ask / Off)
 *   veto          → "two-way"   (Allow / Off — "Allow" stores "Auto"; "Ask" is never offered)
 *   informational → "badge"     (read-only, never gated)
 * Unknown ids fall back to the safe 3-way (a full control never under-reports a real gate), mirroring
 * enforcementOf's back-compat default. Extracted so the per-class mapping is unit-testable browserless.
 */
export function controlForEnforcement(cap: CapabilityGate): GateControlKind {
  switch (CAPABILITY_ENFORCEMENT[cap] ?? "deferrable") {
    case "veto": return "two-way";
    case "informational": return "badge";
    default: return "three-way";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// n2r (bead wsm-e2e-pinned-n2r): PRESENTATION-NORMALIZERS — crash-safety for the gate UI.
//
// The chip + matrix render directly off SERVER-PROVIDED posture / effective_gates. A single malformed
// payload — a posture word that isn't OPEN|GUARDED|LOCKED, a gate value that isn't Auto|Ask|Off, or a
// non-object effective_gates — used to index an undefined POSTURE_STYLE/GATE_STYLE record and throw
// DURING RENDER, which unwound to the one global ErrorBoundary and white-screened the entire cockpit.
//
// These pure, total, NEVER-THROWING functions are the single normalization choke-point both
// components consume, so neither ever indexes a style record with an unknown key. They are
// PRESENTATION concerns only (not policy / precedence) — there is NO server twin to keep in lockstep
// (unlike deriveEffectiveGates, which mirrors the server resolver). Fail-safe directions (locked, §3):
//   - unknown POSTURE  → GUARDED (D1): never falsely imply OPEN/"free to act" nor LOCKED/"can't type".
//   - unknown GATE     → Ask     (D2): surface friction rather than silently imply Auto/Allowed.
//   - absent posture   → null    (D3): legacy payloads legitimately omit it → caller renders no chip.
//   - non-object gates → all-Auto(D6): coerce to a TOTAL valid map so no lookup ever throws.
//   - pane override bad entry → stripped, stays partial (D7): preserves "absent = follow global".
// ─────────────────────────────────────────────────────────────────────────────

/** Runtime guard set for the closed PostureWord union (the surface's only valid posture words). */
const POSTURE_WORDS: ReadonlySet<string> = new Set<PostureWord>(["OPEN", "GUARDED", "LOCKED"]);
/** Runtime guard set for the closed GateValue union. */
const GATE_VALUES: ReadonlySet<string> = new Set<GateValue>(["Auto", "Ask", "Off"]);

/**
 * Coerce an unknown server posture to a known word. Unknown/present-but-malformed → "GUARDED"
 * (fail-safe: never imply OPEN/free-to-act, never imply LOCKED/can't-type, when we genuinely don't
 * know). Returns null ONLY for the legitimate "no posture at all" case (null/undefined) so the caller
 * can render nothing (back-compat with older payloads / mocks). (D1 / D3.)
 */
export function normalizePostureWord(posture: unknown): PostureWord | null {
  if (posture == null) return null;                       // genuinely absent → caller renders no chip
  if (typeof posture === "string" && POSTURE_WORDS.has(posture)) return posture as PostureWord;
  return "GUARDED";                                       // present but malformed → fail-safe GUARDED
}

/**
 * Coerce one unknown gate value to a known one. Missing → "Auto" (legacy default). Present-but-bad
 * → "Ask" (fail-safe: surface friction rather than silently imply Auto/Allowed). (D2.)
 */
export function normalizeGateValue(value: unknown): GateValue {
  if (value == null) return "Auto";
  if (typeof value === "string" && GATE_VALUES.has(value)) return value as GateValue;
  return "Ask";
}

/** Whether a value is a plain (non-array, non-null) object we can safely index for gate keys. */
function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return raw != null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * Coerce an unknown effective-gates payload to a TOTAL, well-typed map (all 16 caps, every value a
 * valid GateValue). Non-object/array/primitive input → all-Auto. This is what GateChip iterates, so it
 * never indexes a style record with an unknown key. Unknown keys are NOT copied through; every value
 * is run through normalizeGateValue (bad value → Ask, D2; absent → Auto). (D6.)
 */
export function normalizeEffectiveGates(raw: unknown): Record<CapabilityGate, GateValue> {
  const src = isPlainObject(raw) ? raw : {};
  const out = {} as Record<CapabilityGate, GateValue>;
  for (const cap of ALL_CAPABILITIES) out[cap] = normalizeGateValue(src[cap]);
  return out;
}

/**
 * Coerce an unknown PARTIAL gate map (a pane override) to a clean partial map: keep ONLY keys in
 * ALL_CAPABILITIES whose value is a valid GateValue; drop unknown keys AND bad-value entries entirely.
 *
 * Unlike normalizeEffectiveGates this stays PARTIAL — it never fabricates the 16 missing caps. That
 * preserves the pane-scope "absent = follow the global default" semantics the matrix's reset
 * affordance depends on: an invalid override entry is simply IGNORED (falls back to global) rather
 * than crashing the toggle or painting a phantom selection. (D7.)
 */
export function sanitizePartialGateMap(raw: unknown): CapabilityGateMap {
  const src = isPlainObject(raw) ? raw : {};
  const out: CapabilityGateMap = {};
  for (const cap of ALL_CAPABILITIES) {
    const v = src[cap];
    if (typeof v === "string" && GATE_VALUES.has(v)) out[cap] = v as GateValue;
  }
  return out;
}
