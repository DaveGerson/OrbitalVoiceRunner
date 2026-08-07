# NEXT STEPS — Janus / Orbital Harness (live tracker)

> **Living document.** Recommended next-session work + an open-bug/risk list. Update the
> checkboxes and the "Last anchored" line as the trunk moves. Authoritative priority order:
> `docs/roadmap/RECONCILIATION.md` §4 (decisions LOCKED 2026-06-01) — **but see R8 below: that
> stack is now fully shipped and its item-1-10 framing predates most of what's open today; treat
> it as historical until the operator re-derives it.** Live task tracker: **beads** (`bd ready`).
> Canonical historical bug status: `docs/review/BUG_LOG.md`.
>
> **Last anchored:** akv re-scope 2026-08-07 (commit `2a8e8b9`, PR #158 merged). Since the prior
> re-scope (`cd5bc83`, 2026-07-07) the trunk absorbed the **Voice Communication Cockpit release
> review** (step 5.5, `c262c43`), the **bug-register sweep** (PR #144), the **voice-coherence
> co-design program (vc A-D)** (PRs #151/#152/#154), the **turn-arbiter conversation scheduler**
> (PR #153), **last-call retraction hardening** (PR #155), the **J0 conversational-coherence
> sweep** (PR #157), and the **agent merge-authority policy fix** (PR #158) — 153 commits total.
> **Re-anchor line refs before acting** — the trunk moves under concurrent sessions; as of this
> re-scope, 4 beads (`qj6s`, `a2tp`, `486w`, `fikj.1`) are **IN PROGRESS in sibling worktrees** —
> do not duplicate or re-plan that work.

---

## North Star
A live voice loop (Janus ↔ Gemini Live) driving real Claude/Codex panes, with the
capability-gate matrix as the safety substrate and the **Python cortex as the deterministic
decision layer**. The operator's surface is now a **communication cockpit**: Orbital listens,
understands, drafts, routes, correlates, and reports; the terminal agents do the engineering.

## DONE recently (on trunk)
- ✅ **Voice Communication Cockpit, Phases 1–5** (2026-07-09/10; validation record
  `docs/review/2026-07-10-release-validation-5.5.md`; ops guide
  `docs/runbooks/communication-cockpit-operations.md`) — AgentExchange spine, project-correct
  Cortex/sessions, instruction drafting/routing, honest return channel, fleet cockpit. Full detail
  unchanged from the prior anchoring; see git history for the phase-by-phase breakdown.
- ✅ **Bug-register sweep** (PR #144, `e0e8007`, 2026-07-24) — 8 code-fixable
  register beads resolved, including **neg1** (result-envelope `exchange_id` correlation: the
  delivered instruction now carries a correlation hint via `withExchangeCorrelationHint`,
  `src/voice/index.ts:1799`). **This closes the "Exchange-id delivery for the result envelope"
  next-step that lived in this doc's prior revision — see R9 below, that entry was stale.**
- ✅ **Exchange spine graduates default off → record** (PR #148, 2026-07-28) — the AgentExchange
  capability now runs on by default in production, not opt-in.
- ✅ **Voice-coherence co-design, vc A–D** (spec PR #151; follow-ups PR #152 — failure earcon,
  answer-first ordering, `switch_context` pane honesty; D4 dial + vc-D production wiring PR #154 —
  2026-07-29 → 2026-08-05). Epic `wsm-e2e-pinned-fikj`; two child beads remain open (see below).
- ✅ **Turn-arbiter conversation scheduler** (PR #153, `d4c8e39`, 2026-08-05) — one desk for every
  model-bound send, replacing the ad-hoc chunk/regex/silence idle inference. **Not yet "stable"**:
  the 14-day telemetry watch (`v02l`) runs 2026-08-05 → 2026-08-19 before tuning/close.
- ✅ **Last-call retraction hardening** (PR #155, 2026-08-05) — `p19o` (retract stale queued
  last-calls on defer re-arm) + `okes` (brake the ACTION leg).
- ✅ **J0 conversational-coherence sweep** (PR #157 / `a132359`, 2026-08-06) — all six layer beads
  from the journey-gap-register retirement (`docs/journeys/README.md`); one residual gap filed
  (`wsm-e2e-pinned-02wz`, P2 — Full-Auto promotion doesn't retract staged approvals through the
  arbiter, only actions are covered).
- ✅ **Agent merge-authority policy correction** (PR #158, 2026-08-06) — `CLAUDE.md`'s git-authority
  section now correctly states agents merge their own green+reviewed PR (earlier wording implied a
  human click was required; it wasn't the intent).
- ✅ **Cortex is PRIMARY by default** (Wave 4, PR #126) — escape hatch `JANUS_CORTEX_PRIMARY=0`.
- ✅ **Trust dials** (Wave 7, PR #129) · **Capture-to-reuse knowledge** (Wave 6, PR #128) ·
  **Legible by ear** (Wave 5, PR #127) · **Voice-UX trio** (Wave 3, PR #125).
- ✅ **Legacy ledger retired** (dbt3, 2026-07-02): SQLite `JanusStore` is the only backend.

## IN PROGRESS — sibling agents, 2026-08-07 (do not re-plan; treat as committed work)
All four discovered by the codex-sol journey review (`handover/2026-07-28/codex-sol-journey-review.md`,
triaged in the now-closed `vi3c`) or the vc epic; all claimed and started today.
1. **`wsm-e2e-pinned-qj6s`** (P0, rank 1) — normal spawn bypasses adapter launch plans; a pane's
   mode label can disagree with the real CLI permission posture.
2. **`wsm-e2e-pinned-a2tp`** (P0, rank 2) — approval resolution never revalidates capability
   POLICY at commit time (the liveness half is already fixed).
3. **`wsm-e2e-pinned-486w`** (P1, rank 6) — Workbench send to an Exited-but-registered pane 200s,
   clears the draft, marks the exchange delivered.
4. **`wsm-e2e-pinned-fikj.1`** (P0) — voice system prompt falsely claims a runtime silence gate
   exists when `voiceAi.silenceGate` defaults `false`.

## Recommended next steps (priority order, once the above land)
1. [ ] **`fikj.2` — muted-as-aside earcon + queryable mute-rate telemetry** (P0). **HARD-GATES**
   `fikj.5` (flip `silenceGate` default to `true`) by director decision — no early flip. Open
   product decision inside the bead: where the mute-rate counter is queryable from (a `list_panes`-
   style status field vs. its own tool) — needs an operator call before implementation starts.
2. [ ] **z5c slice 3 EXECUTION — physical hot-warm sockets** (P1). The decision layer
   (`pool.plan`, hot-slot budget, state machine) shipped with the cockpit program; the physical
   multi-socket layer (concurrent Gemini sessions, background feeding) is the deferred remainder
   — spec status note at the top of
   `docs/superpowers/specs/2026-07-07-z5c-session-pool-design.md`. No open bead tracks the
   physical-execution slice itself (only the narrower dead-pane-detection sweep `ud10` does).
3. [ ] **Codex-sol journey review, remaining ranks** (P2, three NEW beads filed in this re-scope
   — the prior triage, `vi3c`, sliced ranks 1/2/6 into the in-progress beads above and left 5/7/8/9
   "deferred" with no beads; re-verified against today's tree, three are still live):
   - **`wsm-e2e-pinned-8nm8`** (rank 7) — `delete_project` never stops the project's live PTYs;
     `syncLedger`'s `ensureProject` auto-create then silently resurrects the deleted project row.
   - **`wsm-e2e-pinned-cqjv`** (rank 9) — `saveSettings` swallows filesystem write errors;
     `PUT /api/settings` still reports success on a failed persist.
   - **`wsm-e2e-pinned-so9s`** (rank 8) — voice dispatch still settles `AgentExchange` delivery
     *after* the pane write completes (crash window); the pre/post-write hook already exists in
     `src/dispatch/paneWrite.ts` but `src/voice/index.ts`'s `dispatchProposal` never populates
     `deps.exchangeId` to use it.
   - Rank 5 (restart ACK-before-readiness) needs **no new bead** — verified substantially mitigated
     by the vc-D retraction protocol (`fikj.11`): the eager ack is now a tracked, retractable claim.
   - Rank 4 already tracked on `2if`; rank 10 is an accepted gap (covered by `smoke:claude` /
     `smoke:completion-prompt`, both outside `npm test`).
4. [ ] **`qs3` — Reach & automation** (consolidated epic): recipes primary surface (`33c.1`),
   watch-rule voice twin decision (`dvn`), webhook/phone push (`qs3.1`), tip jar (`9ql.5`).
5. [ ] **`reg2` — Python catalog authority + codegen**: Pydantic source-of-truth → generated
   TS/JSON; aligns with the Python-owns-decisions seam ADR.
6. [ ] Decisions parked: **`9ou`** (Nova Sonic 2 backend). **`2if`** (Codex live verification, with
   the `ngw` paste-gap checklist) — **title corrected this re-scope**: was stale
   "— BLOCKED on install" though the bead's own 2026-07-07 comment records codex-cli
   0.142.5 installed + authed that same day; the only remaining work is the live interactive
   session (`/permissions` picker + ConPTY mode-switch).

## DEFERRED / watch — not actionable right now
- **`v02l` — turn-arbiter telemetry watch** (P1). Blocked on **data**, not code; tooling
  (`npm run telemetry:arbiter`, `scripts/arbiter-telemetry.ts`) is complete and unit-tested. Review
  window 2026-08-05 → 2026-08-19; only 2 of 14 days elapsed as of this re-scope and no `.janus.db`
  exists yet in this environment. **Do not work before 2026-08-19.**

## Open bugs / risks (live)

| # | Severity | Item | Where | Status |
|---|---|---|---|---|
| R1 | Med | **Concurrent-session churn** — multiple orchestrator sessions run against this repo simultaneously; don't stash/rescue foreign changes; coordinate before touching a branch another session owns. | repo-wide | **Live** — work in isolated worktrees; one committer per tree. |
| R2 | Low | **Smoke test not in CI** — accepted manual gate (bead pox tombstoned 2026-07-07). Live-gated checks (smoke:claude, test:e2e:live, verify:live-voice) also cannot run in headless containers — record ENVIRONMENT-GATED, never fake. | `scripts/` | **Accepted**. |
| R3 | Low | **`bytesAfter>0`-style weak assertions may exist elsewhere** — audit smoke/integration checks for "some output" vs "expected content". | `scripts/`, smoke tests | **Open** — sweep. |
| R4 | Info | **Roadmap line anchors stale** — `docs/roadmap/*` still reference 2026-05/06 commits; re-anchor per item before acting. | `docs/roadmap/` | **Known**. |
| R5 | Low | **Cortex fallback health** — post-cutover target: `cortexFallbackRate` <1% on a warm daemon (`npx tsx scripts/context-metrics-report.ts`). Check after each cortex-adjacent wave. | telemetry | **Watch**. |
| R6 | Low | **4.5-B7 accepted exposure** — a terminal_idle-parked exchange can, in a narrow vetoed case, be settled by a manual command's done-line output. Documented decision of record; revisit if mint-at-compose (see R9) lands. | `src/observe/index.ts` | **Accepted / documented**. |
| R7 | Low | **Repo housekeeping (verified 2026-08-07)** — branch `codex/review-quickwins` is stranded (9 commits ahead / 224 behind main, no PR; includes npm-audit remediation + missing CI quality gates). Four worktrees are fully merged and prunable: `completion-smoke-batch` (`docs/runbook-flag-default-drift`, 0 ahead of main), plus three (`fix-x6oo-headless-vt-emulator`→`fix/voice-coherence-followups`, `voice-followups-tdd`→`feat/turn-arbiter-program`, `voice-thought-chunking-fix`→`fix/live-test-batch`) whose branches are already merged and deleted on `origin` — the worktrees are the only thing left. Not urgent; next cleanup pass. | worktrees / branches | **Known — no action taken (out of docs-only scope).** |
| R8 | Info | **`RECONCILIATION.md` §4 priority stack is fully shipped.** Verified 2026-08-07: P0a hardening is done; P0b's two keystones are both live in code (push-observation; matrix surface — `src/orbital/EmergencyStop.tsx` = global stop-all, `src/orbital/views/BackOfHouse.tsx` + `src/orbital/station.ts` = the capability-matrix settings surface + per-pane chips). The bead `akv`'s own standing description text ("push-observation P0b-1 done; matrix surface P0b-2 next") is now stale — both are done. Current open backlog (voice-coherence, turn-arbiter, codex-sol journey-review hardening) is almost entirely **post-roadmap** work that doesn't map cleanly onto the original P1/P2 item-1-10 list, which predates all of it (locked 2026-06-01). **OPERATOR DECISION NEEDED**: either re-derive `RECONCILIATION.md` §4 for the current program, or formally mark it historical. Not decided in this re-scope — the doc is locked and a tier/OUT change is explicitly out of scope for an agent to make unilaterally. | `docs/roadmap/RECONCILIATION.md` | **Flagged for operator.** |
| R9 | Info | **Doc correction, this re-scope**: the prior revision of this file listed "Exchange-id delivery for the result envelope (P1)" as a live next step, describing the delivered instruction as never carrying its `exchange_id`. That was fixed by PR #144 (bead `neg1`, closed 2026-07-24) — `withExchangeCorrelationHint` now stamps the hint at `src/voice/index.ts:1799`. The entry has been removed from "Recommended next steps" above; the narrower remaining gap (delivery-hook *ordering* around the write, not the correlation hint itself) is tracked fresh as rank-8 (`so9s`). | `src/voice/index.ts`, `src/dispatch/paneWrite.ts` | **Resolved / superseded — documented for the record.** |

> Add bugs as discovered. When closing one, move it to a "Resolved" note with the PR # rather
> than deleting, so the tracker doubles as a changelog.
