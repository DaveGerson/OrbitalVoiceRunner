/**
 * src/globalOverrideRider.ts — the BUG-003 global-override HONESTY rider (SINGLE SOURCE OF TRUTH).
 *
 * effectiveModeFor (src/gating/index.ts) is GLOBAL-FIRST by design: whenever the manager's
 * globalPermissionsMode !== "Inherit", that global mode DOMINATES every per-pane mode, so a
 * pane-permission change reports success but has NO gating effect until the global mode returns to
 * Inherit. This helper is the eyes-off honesty fix (NOT a precedence change): given the CURRENT global
 * mode it returns a leading-space spoken rider that (1) NAMES the global mode, (2) states the pane
 * change has NO gating effect, (3) says it stays that way until global is Inherit. When global IS
 * "Inherit" (or unset/null) it returns "" so the success string stays byte-for-byte the clean original.
 *
 * WHY A SHARED LEAF: every success path that applies a per-pane permission change must speak the SAME
 * rider so the operator hears one consistent message no matter which path applied the change —
 *   • the immediate voice handlers  (src/actions/defs/locks.ts — legacy + live-delegate ok returns),
 *   • the live choke-point CONFIRM path (src/applyPaneMode.ts — the Ask→confirm success string), and
 *   • the post-restart REPLAY effects (src/actionEffects.ts — the rebuilt deferred closures).
 * Keeping the literal here (a dependency-free leaf, importable by all three without an import cycle) is
 * what guarantees the wording can never drift between paths.
 */
export function globalOverrideRiderForMode(global: string | null | undefined): string {
  if (!global || global === "Inherit") return "";
  return ` Heads up: the global autonomy mode is ${global}, so this pane setting has no gating effect until you set the global mode back to Inherit.`;
}
