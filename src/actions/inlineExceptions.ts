// src/actions/inlineExceptions.ts
/**
 * The declared-inline catalog — the "one umbrella" completeness record + the no-twin guard's data.
 *
 * SINGLE SOURCE OF TRUTH = the registry (src/actions/) as one catalog. Most capabilities are full
 * ActionDefs (voice|rest|ws). The routes below are the deliberate INLINE exceptions in server.ts,
 * declared here with a reason so the umbrella knows about everything. tests/test_no_inline_twins.ts
 * fails CI if server.ts gains an app.<verb>('/api/…') route NOT listed here: a new route must become a
 * registry def (Janus-aware) or earn a documented entry — drift becomes a build failure, not a silent
 * divergence. See docs/superpowers/specs/2026-06-05-c55-8-convergence-terminal-state-design.md.
 *
 * GOVERNING PRINCIPLES (canonical statement):
 *  P1 Commandability broad / proactivity tight — two INDEPENDENT dials. `surfaces:['voice',…]` makes an
 *     action COMMANDABLE; the gate matrix (Auto/Ask/Off) ALONE governs what Janus does UNPROMPTED.
 *     Surface almost everything to voice; keep proactivity tightly gated. Voice parity costs no autonomy.
 *  P2 Gating taxonomy — orchestration plumbing (navigate/arrange/manage/drafts/resize/status reads) is
 *     UNGATED ("Janus doing the work of Janus"); reading terminal RESULTS is GATED (privacy of sensitive
 *     output + protecting the context window); consequential CLI acts + safety changes are GATED.
 */
export type InlineCategory = "exception" | "held" | "future-convergence" | "infra";

export interface InlineException {
  readonly method: "get" | "post" | "put" | "delete" | "use";
  readonly path: string;
  readonly category: InlineCategory;
  readonly reason: string;
}

export const INLINE_EXCEPTIONS: readonly InlineException[] = [
  // ── infra (non-action) ──
  { method: "use", path: "/api", category: "infra", reason: "shared director-token auth middleware mount" },
  { method: "get", path: "*", category: "infra", reason: "SPA catch-all — serves index.html for client routes" },
  // wsm-e2e-pinned-s1ap: the scripted-live e2e control channel. NOT actions and NEVER voice-commandable —
  // these two routes exist ONLY when the JANUS_MOCK_LIVE=1 non-production gate is active (they are not
  // registered at all otherwise) and are loopback-fenced per request. A registry def is exactly what they
  // must never become: the registry is the operator-facing catalog, and this is test scaffolding.
  { method: "post", path: "/__scripted_live__/emit", category: "infra", reason: "scripted-live e2e lane: inject a raw Gemini envelope; gate-registered + loopback-only (src/voice/scriptedLiveConnector.ts)" },
  { method: "post", path: "/__scripted_live__/close", category: "infra", reason: "scripted-live e2e lane: simulate the Gemini socket dropping; gate-registered + loopback-only" },
  // ── exception: drafts (operator hand-rail; ungated plumbing per P2; voice uses propose_command) ──
  { method: "get", path: "/api/panes/:projectId/:paneId/draft", category: "exception", reason: "draft buffer read on pane-switch; operator hand-rail" },
  { method: "put", path: "/api/panes/:projectId/:paneId/draft", category: "exception", reason: "draft buffer persist (WS draft_edit primary; REST fallback)" },
  { method: "get", path: "/api/projects/:projectId/drafts", category: "exception", reason: "WIP draft list indicator; operator hand-rail" },
  // Phase 5, Step 5.1 (Fleet View "communication-by-exception"): a small, bounded, read-only
  // projection of every live pane's latest AgentExchange (src/exchanges/fleetProjection.ts) —
  // mirrors GET .../draft's shape/placement exactly (structured {summaries:{...}} body, not the
  // ActionDef default {output} wrapper); a voice/registry twin has no natural verb (it is a
  // client-board read, not an operator-speakable action).
  { method: "get", path: "/api/fleet/exchange-summary", category: "exception", reason: "bounded per-pane exchange-summary projection for the Fleet View board; structured body, no voice-natural verb" },
  { method: "post", path: "/api/panes/:projectId/:paneId/draft/send", category: "exception", reason: "operator sends own draft; above-the-gate by design" },
  // ── exception: settings (config; client reads structured body; separate track) ──
  { method: "get", path: "/api/settings", category: "exception", reason: "settings read on load; structured body; settings->WS rewrite is a follow-up" },
  { method: "put", path: "/api/settings", category: "exception", reason: "settings write; client reads {settings,globalPermissionsMode}; follow-up to converge" },
  // ── exception: raw keystrokes (multi-cli; gated inline via write_to_pane) ──
  { method: "post", path: "/api/terminals/:id/raw-input", category: "exception", reason: "multi-cli raw-keystroke path; bifurcated gate inline; future converge" },
  // ── exception: attention/clear path alias (permanent; collision-free) ──
  // c55.16: POST /api/projects (create_project) was CONVERGED — the def gained an optional `name`
  // param + a coerceArgs shim and now ports the inline post-create RENAME as a 2nd in-handler ledger
  // mutation (both pure ledger ops, no connection scope). The inline route + its held row were deleted
  // together (no-twin lockstep). The {success:true}->{output} body delta is client-invisible.
  // c55.16: PUT /api/projects/:projectId/panes/:paneId/capability-gates (the BULK per-pane gate-map
  // write) was CONVERGED to the new rest-only set_pane_gates def — the inline route + its held row were
  // deleted together (no-twin guard). The voice set_capability_gate def is now voice-only.
  // c55.9: POST /api/plans/:id/execute (execute_plan) was CONVERGED — buildRestActionContext now
  // injects a gated REST pane-write seam (restDispatchProposal -> applyDispatchDecision), so the inline
  // route + its held row were deleted together (no-twin guard). BUG-040 closed.
  // c55.16: /api/attention/clear is the LAST held row, DOWNGRADED held->exception (NOT converged). It is
  // a permanent, logic-free PATH ALIAS over dismiss_attention's mass-dismiss (id omitted): the inline
  // shim already routes EXECUTION through runAction('dismiss_attention',{}) — no logic twin to drift.
  // dismiss_attention is mounted on the DISTINCT per-item path POST /api/attention/:id/dismiss
  // (orient.ts), so NO registry def claims /api/attention/clear -> it never collides (off the
  // opts.only critical path, never trips the shadow guard). Keeping the thin shim and downgrading the
  // category is the minimal terminal disposition; it unblocks the eventual no-held-rows gate without a
  // multi-path rest binding (deferred — only warranted if the multi-path seam is independently wanted).
  { method: "post", path: "/api/attention/clear", category: "exception", reason: "permanent logic-free path alias over dismiss_attention (dismiss-all); no registry def claims this path" },
  // c55.15: the 5 approvals/pending (HiTL) future-convergence rows were converged to rest-only
  // ALWAYS_ALLOWED registry defs (list_pending_commands / list_pending_actions / confirm_pending_action /
  // cancel_pending_action / approve_pending_command) — their inline routes are deleted from server.ts.
];
