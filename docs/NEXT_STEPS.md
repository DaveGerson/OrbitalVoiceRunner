# NEXT STEPS — Janus / Orbital Harness (live tracker)

> **Living document.** Recommended next-session work + an open-bug/risk list. Update the
> checkboxes and the "Last anchored" line as the trunk moves. Authoritative priority order:
> `docs/roadmap/RECONCILIATION.md` §4 (decisions LOCKED 2026-06-01). Live task tracker: **beads**
> (`bd ready`). Canonical historical bug status: `docs/review/BUG_LOG.md`.
>
> **Last anchored:** `main @ 6a98563` (2026-07-07) — after the akv re-scope ritual, run against
> the shipped cortex-primary + trust-dials trunk (PRs #109–#129). **Re-anchor line refs before
> acting** — the trunk moves under concurrent sessions.

---

## North Star
A live voice loop (Janus ↔ Gemini Live) driving real Claude/Codex panes, with the
capability-gate matrix as the safety substrate and the **Python cortex as the deterministic
decision layer**. Stack: **P0a harden → P0b keystones → P1 velocity → P2 polish** (P0a/P0b
complete; the live work is P1/P2 riding the hardened matrix).

## DONE recently (on trunk)
- ✅ **Cortex is PRIMARY by default** (Wave 4, PR #126): trigger profiles, D2 inject gate
  (hash + 3s debounce; kills the measured 99.4% redundant re-injects), D4 hysteresis,
  300ms-raced apply path with the TS renderer as permanent fail-closed floor.
  Escape hatch: `JANUS_CORTEX_PRIMARY=0`.
- ✅ **Trust dials** (Wave 7, PR #129): timed autonomy windows + posture profiles.
- ✅ **Capture-to-reuse knowledge** (Wave 6, PR #128): typed notes, promotion, catch-up,
  export, action panel.
- ✅ **Legible by ear** (Wave 5, PR #127): 10-state conversational pill, caption bar, earcons,
  voice macros. Live-lane deflake absorbed.
- ✅ **Voice-UX trio** (Wave 3, PR #125): spoken SITREP, focus resolver, spoken confirm;
  `python/policies` daemon (resolve_focus + rank_sitrep).
- ✅ **Resilience 5b** (PR #124): PTY-death push signal, dead-pane write guard, boot recovery
  summary, failure-injection suite.
- ✅ **Perimeter token hardening** (PR #122) · **cortex context telemetry** (PR #121) ·
  **bounded self-cleaning e2e lanes + opt-in live voice verification** (PR #119).
- ✅ **Legacy ledger retired** (dbt3, 2026-07-02): SQLite `JanusStore` is the only backend.

## Recommended next steps (priority order)

1. [ ] **z5c — cortex session/connection management** (P1). Spec approved 2026-07-07
   (per-project session pool, hybrid LRU: `docs/superpowers/specs/2026-07-07-z5c-session-pool-design.md`).
   **Slice 1 is PR #131** (inject delivery class — closed 1d6w); slices 2 (handle tier) and
   3 (hot slots + `pool.plan`) each get their own plan after #131 merges. **f2om** fix is
   already open as **PR #130**; sweep **ud10** (dead-pane false-positive) in slice 2/3.
2. [ ] **cvg — Fleet legibility**: live output tiles on Kitchen station cards. Design spec
   `docs/superpowers/specs/2026-06-25-fleet-view-design.md` is parked in-tree (this PR).
3. [ ] **qs3 — Reach & automation** (consolidated epic post-re-scope): recipes primary surface
   (33c.1), watch-rule voice twin decision (dvn), webhook/phone push (qs3.1), tip jar (9ql.5).
4. [ ] **reg2 — Python catalog authority + codegen**: Pydantic source-of-truth → generated
   TS/JSON; aligns with the Python-owns-decisions seam ADR.
5. [ ] Decisions parked: **9ou** (Nova Sonic 2 backend). **2if** (Codex live verification,
   now also carrying the ngw paste-gap checklist) is **UNBLOCKED** as of 2026-07-07 —
   codex-cli 0.142.5 is installed and authed; it needs a live interactive session, not an install.

## Open bugs / risks (live)

| # | Severity | Item | Where | Status |
|---|---|---|---|---|
| R1 | Med | **Concurrent-session churn** — multiple orchestrator sessions run against this repo simultaneously; on 2026-07-07 one hard-reset another's worktree branch mid-integration, and the shared main checkout's dirty files (`package-lock.json`, `tests/test_catalog.ts`, `stubs/`) were restored by a session with no commit trail. Residual main-checkout dirt: `handover/`. Don't stash/rescue foreign changes; coordinate before touching a branch another session owns. | repo-wide | **Live** — work in isolated worktrees; one committer per tree. |
| R2 | Low | **Smoke test not in CI** — accepted manual gate (bead pox tombstoned 2026-07-07); PR #119's opt-in live lane partially covers. | `scripts/smoke-claude-pane.ts` | **Accepted / closed**. |
| R3 | Low | **`bytesAfter>0`-style weak assertions may exist elsewhere** — audit smoke/integration checks for "some output" vs "expected content". | `scripts/`, smoke tests | **Open** — sweep. |
| R4 | Info | **Roadmap line anchors stale** — `docs/roadmap/*` still reference 2026-05/06 commits; re-anchor per item before acting. | `docs/roadmap/` | **Known**. |
| R5 | Low | **Cortex fallback health** — post-cutover target: `cortexFallbackRate` <1% on a warm daemon (`npx tsx scripts/context-metrics-report.ts`). Check after each cortex-adjacent wave. | telemetry | **Watch**. |

> Add bugs as discovered. When closing one, move it to a "Resolved" note with the PR # rather
> than deleting, so the tracker doubles as a changelog.
