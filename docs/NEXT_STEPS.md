# NEXT STEPS — Janus / Orbital Harness (live tracker)

> **Living document.** Recommended next-session work + an open-bug/risk list. Update the
> checkboxes and the "Last anchored" line as the trunk moves. Authoritative priority order:
> `docs/roadmap/RECONCILIATION.md` §4 (decisions LOCKED 2026-06-01). Live task tracker: **beads**
> (`bd ready`). Canonical historical bug status: `docs/review/BUG_LOG.md`.
>
> **Last anchored:** the **Voice Communication Cockpit program** (2026-07-09/10, commits
> `d859f36..f9dc83a` + the 5.5 release review) — five phases landed on top of the cortex-primary
> + trust-dials trunk. **Re-anchor line refs before acting** — the trunk moves under concurrent
> sessions.

---

## North Star
A live voice loop (Janus ↔ Gemini Live) driving real Claude/Codex panes, with the
capability-gate matrix as the safety substrate and the **Python cortex as the deterministic
decision layer**. The operator's surface is now a **communication cockpit**: Orbital listens,
understands, drafts, routes, correlates, and reports; the terminal agents do the engineering.

## DONE recently (on trunk)
- ✅ **Voice Communication Cockpit, Phases 1–5** (2026-07-09/10; validation record
  `docs/review/2026-07-10-release-validation-5.5.md`; ops guide
  `docs/runbooks/communication-cockpit-operations.md`):
  - **P1 — AgentExchange spine**: schema v12, 12-state lifecycle, exactly-once CAS delivery,
    run-correlated dispatch join, boot-recovery quarantine (`JANUS_EXCHANGE_SPINE`).
  - **P2 — project-correct Cortex/sessions**: WorldModel communication enrichment, per-project/
    session context versions, session pool slices 1–2 (+ slice-3 decision layer), redaction
    hardening (secrets never at rest).
  - **P3 — instruction drafting/routing**: InstructionEnvelope (anti-fabrication), target
    resolver (exact-beats-ranker, never-guess), Workbench draft convergence
    (`JANUS_INSTRUCTION_ENVELOPE`).
  - **P4 — return channel**: defensive agent result envelope (`JANUS_AGENT_RESULT_ENVELOPE`),
    honest idle (idle ≠ complete), exchange-aware exactly-once narration/SITREP/catch-up,
    interruption dispositions + provable-failure retry.
  - **P5 — fleet cockpit**: communication-by-exception Fleet View + gated quick actions,
    exchange replay + communication-quality metrics (REST + CLI), release benchmark harness,
    security audit (5.4) + release review fixes (5.5: fleet action/lifecycle consistency,
    background-completion suppression made real, SITREP completion windowing, manual-command
    seam wired, context_injections TTL, test_policy_client unref-timer fix).
- ✅ **Cortex is PRIMARY by default** (Wave 4, PR #126) — escape hatch `JANUS_CORTEX_PRIMARY=0`.
- ✅ **Trust dials** (Wave 7, PR #129) · **Capture-to-reuse knowledge** (Wave 6, PR #128) ·
  **Legible by ear** (Wave 5, PR #127) · **Voice-UX trio** (Wave 3, PR #125).
- ✅ **Legacy ledger retired** (dbt3, 2026-07-02): SQLite `JanusStore` is the only backend.

## Recommended next steps (priority order)

1. [ ] **z5c slice 3 EXECUTION — physical hot-warm sockets** (P1). The decision layer
   (`pool.plan`, hot-slot budget, state machine) shipped with the cockpit program; the physical
   multi-socket layer (concurrent Gemini sessions, background feeding) is the deferred remainder
   — spec status note at the top of
   `docs/superpowers/specs/2026-07-07-z5c-session-pool-design.md`. Sweep **ud10** here.
2. [ ] **Exchange-id delivery for the result envelope** (P1, unlocks live envelope settlement).
   The delivered instruction never carries its `exchange_id`, so agents cannot echo a matching
   result envelope — settlement rides the legacy heuristic today. Root fix is mint-at-compose
   (exchange minted when drafting starts), which ALSO unifies the envelope/exchange version
   counters and closes the draft-registry restart gap — three documented gaps, one root cause
   (decisions of record, `docs/review/2026-07-10-release-validation-5.5.md`).
3. [ ] **qs3 — Reach & automation** (consolidated epic post-re-scope): recipes primary surface
   (33c.1), watch-rule voice twin decision (dvn), webhook/phone push (qs3.1), tip jar (9ql.5).
4. [ ] **reg2 — Python catalog authority + codegen**: Pydantic source-of-truth → generated
   TS/JSON; aligns with the Python-owns-decisions seam ADR.
5. [ ] Decisions parked: **9ou** (Nova Sonic 2 backend). **2if** (Codex live verification, with
   the ngw paste-gap checklist) remains UNBLOCKED — codex-cli installed/authed; needs a live
   interactive session.

## Open bugs / risks (live)

| # | Severity | Item | Where | Status |
|---|---|---|---|---|
| R1 | Med | **Concurrent-session churn** — multiple orchestrator sessions run against this repo simultaneously; don't stash/rescue foreign changes; coordinate before touching a branch another session owns. | repo-wide | **Live** — work in isolated worktrees; one committer per tree. |
| R2 | Low | **Smoke test not in CI** — accepted manual gate (bead pox tombstoned 2026-07-07). Live-gated checks (smoke:claude, test:e2e:live, verify:live-voice) also cannot run in headless containers — record ENVIRONMENT-GATED, never fake. | `scripts/` | **Accepted**. |
| R3 | Low | **`bytesAfter>0`-style weak assertions may exist elsewhere** — audit smoke/integration checks for "some output" vs "expected content". | `scripts/`, smoke tests | **Open** — sweep. |
| R4 | Info | **Roadmap line anchors stale** — `docs/roadmap/*` still reference 2026-05/06 commits; re-anchor per item before acting. | `docs/roadmap/` | **Known**. |
| R5 | Low | **Cortex fallback health** — post-cutover target: `cortexFallbackRate` <1% on a warm daemon (`npx tsx scripts/context-metrics-report.ts`). Check after each cortex-adjacent wave. | telemetry | **Watch**. |
| R6 | Low | **4.5-B7 accepted exposure** — a terminal_idle-parked exchange can, in a narrow vetoed case, be settled by a manual command's done-line output. Documented decision of record; revisit if mint-at-compose (item 2) lands. | `src/observe/index.ts` | **Accepted / documented**. |

> Add bugs as discovered. When closing one, move it to a "Resolved" note with the PR # rather
> than deleting, so the tracker doubles as a changelog.
