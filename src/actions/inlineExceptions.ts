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
  // ── exception: drafts (operator hand-rail; ungated plumbing per P2; voice uses propose_command) ──
  { method: "get", path: "/api/panes/:projectId/:paneId/draft", category: "exception", reason: "draft buffer read on pane-switch; operator hand-rail" },
  { method: "put", path: "/api/panes/:projectId/:paneId/draft", category: "exception", reason: "draft buffer persist (WS draft_edit primary; REST fallback)" },
  { method: "get", path: "/api/projects/:projectId/drafts", category: "exception", reason: "WIP draft list indicator; operator hand-rail" },
  { method: "post", path: "/api/panes/:projectId/:paneId/draft/send", category: "exception", reason: "operator sends own draft; above-the-gate by design" },
  // ── exception: settings (config; client reads structured body; separate track) ──
  { method: "get", path: "/api/settings", category: "exception", reason: "settings read on load; structured body; settings->WS rewrite is a follow-up" },
  { method: "put", path: "/api/settings", category: "exception", reason: "settings write; client reads {settings,globalPermissionsMode}; follow-up to converge" },
  // ── exception: raw keystrokes (multi-cli; gated inline via write_to_pane) ──
  { method: "post", path: "/api/terminals/:id/raw-input", category: "exception", reason: "multi-cli raw-keystroke path; bifurcated gate inline; future converge" },
  // ── held (open c55 decisions) ──
  { method: "post", path: "/api/projects", category: "held", reason: "create_project: inline does a post-create rename (2nd mutation) the def lacks — held" },
  { method: "put", path: "/api/projects/:projectId/panes/:paneId/capability-gates", category: "held", reason: "BULK gate map-write; set_capability_gate def is single-entry tighten-only — needs new set_pane_gates (held)" },
  { method: "post", path: "/api/plans/:id/execute", category: "held", reason: "execute_plan: registry handler's dispatchProposal is a refusing stub on REST — needs a REST pane-write seam (c55.9)" },
  { method: "post", path: "/api/attention/clear", category: "held", reason: "thin shim delegating to runAction('dismiss_attention',{}) — path-alias pending multi-path rest binding" },
  // ── future-convergence: project/pane lifecycle ──
  { method: "put", path: "/api/projects/:id", category: "future-convergence", reason: "project update — future registry def" },
  { method: "delete", path: "/api/projects/:id", category: "future-convergence", reason: "project delete — future registry def" },
  { method: "delete", path: "/api/projects/:projectId/panes/:paneId", category: "future-convergence", reason: "pane delete — future registry def" },
  { method: "post", path: "/api/projects/:projectId/panes/:paneId/stop", category: "future-convergence", reason: "non-destructive pane stop — future registry def" },
  // ── future-convergence: archive ──
  { method: "get", path: "/api/archive", category: "future-convergence", reason: "archive list read — future rest-only def" },
  { method: "post", path: "/api/archive/:paneId/restore", category: "future-convergence", reason: "restore archived pane — future registry def" },
  { method: "delete", path: "/api/archive/:paneId", category: "future-convergence", reason: "delete archived pane — future registry def" },
  // ── future-convergence: approvals / pending (HiTL) ──
  { method: "get", path: "/api/commands/pending", category: "future-convergence", reason: "pending commands read — future rest-only def" },
  { method: "get", path: "/api/actions/pending", category: "future-convergence", reason: "pending actions read — future rest-only def" },
  { method: "post", path: "/api/actions/:id/confirm", category: "future-convergence", reason: "confirm a deferred action (HiTL) — future registry def" },
  { method: "post", path: "/api/actions/:id/cancel", category: "future-convergence", reason: "cancel a deferred action — future registry def" },
  { method: "post", path: "/api/commands/approve", category: "future-convergence", reason: "approve a proposed command (HiTL) — future registry def" },
];
