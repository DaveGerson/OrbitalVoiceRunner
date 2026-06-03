/**
 * G6 — map a `gateOrDefer` disposition onto the REST contract for non-PTY spawn mutators.
 *
 * The capability gate is enforced at the voice boundary (the Gemini tool-call handler) via
 * `gateOrDefer`; the REST spawn routes (`POST /api/terminals`, `POST /api/recipes/apply`) drifted
 * and bypassed it entirely. This pure helper lets those routes reuse the SAME gate seam and answer
 * the right HTTP status without an Express/PTY harness (the repo has none — gate logic is unit-tested
 * as pure functions). Mirrors the extraction precedent of `applyHandoffFlipOnResolve` (commit 7cd90db).
 *
 *   Off  -> 403 (forbidden by policy, no side effect ran)
 *   Ask  -> 202 (deferred; body carries actionId so the UI can track the pending action)
 *   Auto -> 200 (caller already ran / should run the effect; body carries its result)
 *
 * Keep the param type in lockstep with `gateOrDefer`'s return union in server.ts.
 */
export function restGateOutcome(
  g:
    | { disposition: "run" }
    | { disposition: "forbidden" }
    | { disposition: "deferred"; actionId: string; summary: string }
): { status: 200 | 202 | 403; body: Record<string, unknown> } {
  if (g.disposition === "forbidden") {
    return {
      status: 403,
      body: {
        error: "create_pane is gated Off; pane creation is forbidden by policy.",
        capability: "create_pane",
      },
    };
  }
  if (g.disposition === "deferred") {
    return {
      status: 202,
      body: { deferred: true, actionId: g.actionId, summary: g.summary },
    };
  }
  return { status: 200, body: { success: true } };
}
