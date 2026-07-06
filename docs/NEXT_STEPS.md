# NEXT STEPS — Janus / Orbital Harness (live tracker)

> **Living document.** Recommended next-session work + an open-bug/risk list. Update the
> checkboxes and the "Last anchored" line as the trunk moves. Authoritative priority order:
> `docs/roadmap/RECONCILIATION.md` §4 (decisions LOCKED 2026-06-01). Canonical historical bug
> status: `docs/review/BUG_LOG.md`. Session scratchpad: `DEBUG_NOTES.md`.
>
> **Last anchored:** `main @ 1ce30d2` (2026-06-01) — after WS-M went live (PR #6/#7) + smoke
> content-assertion (PR #8). **Re-anchor line refs before acting** — the trunk moves under
> concurrent sessions; several `server.ts` anchors below will drift.

---

## North Star
A live voice loop (Janus ↔ Gemini Live) driving real Claude/Codex panes, with the
capability-gate matrix as the safety substrate. Stack: **P0a harden → P0b keystones → P1 velocity → P2 polish**.

## DONE recently (on trunk)
- ✅ **WS-M SQLite ledger is LIVE & default** (PR #6 parity `98c2cfe`, PR #7 activation `ffee0e4`).
  Gated, idempotent boot migration (`migrateOnBootIfNeeded`, marker `ledgerMigratedAt` in `kv`);
  originals → `.bak`. → closes P0a *PendingApproval persistence (store layer)*.
- ✅ **dbt3 — legacy ledger backend retired** (2026-07-02). SQLite (`JanusStore`) is now the ONLY
  ledger backend; the `JANUS_LEDGER_BACKEND=legacy` escape hatch + the in-memory/JSON `Ledger`
  implementation it selected are gone. A store-init failure is now a fatal boot error. The
  JSON→SQLite boot migration for pre-WS-M on-disk data is unaffected and still runs.
- ✅ **Smoke content-assertion** (PR #8 `1ce30d2`) — `scripts/smoke-claude-pane.ts` now asserts the
  response contains `PONG`, not just `bytesAfter>0`. → closes a P0a hardening item.

---

## Recommended next steps (priority order)

### P0a — finish HARDENING (gates everything else)
- [ ] **Wire the server's `PendingApprovalStore` → SQLite.** `server.ts:1296` still does
  `new PendingApprovalStore()` (in-memory). The durable store + `insertPendingApproval`/
  `getPendingApprovals`/`claimApproval` exist (WS-M) and restart-recovery is unit-proven, but the
  *server* isn't reading/writing them yet. This is the last mile of P0a "full PendingApproval persistence."
  ⚠️ **High collision** — concurrent session is active in this file/`src/pendingApprovals.ts`. Coordinate ownership first.
- [ ] **Full `deliver_handoff → flipHandoffOnResolve` server path.** Partially built
  (`server.ts:1389` `flipHandoffOnResolve`, `:1455` call site, `deliver_handoff` gate `~:2329`).
  Verify the resolve actually flips the handoff row state end-to-end. ⚠️ High collision (same session).
- [ ] **WS-F deferred-execution staging.** Seams exist (`src/pendingApprovals.ts` `claimed` flag;
  `server.ts:2926` `TODO(WS-F): persist + re-announce on reconnect instead of purging`). Today an
  `Ask`-tier side effect is applied-and-audited immediately; WS-F stages it for deferred operator
  approval. ⚠️ High collision.

### P0b — two keystones (both full builds; run in parallel)
- [ ] **① Push-observation w/ deltas** (the data plane). Plan already on trunk via **PR #5**
  (`docs/.../push-observation` plan). **Parallel-safe** — largely code-disjoint from the P0a
  approval/handoff churn; the best pick if avoiding collisions.
- [ ] **② Matrix surface**: per-pane gate chips + capability-matrix settings UI + global stop-all +
  item-5 voice tools on the already-gated handlers. Waits on hardened gates (P0a).

### P1 / P2 (ride the hardened, surfaced matrix)
- [ ] P1: attention queue · multi-pane tiles · watch rules · fleet view · templates/recipes · voice ergonomics.
- [ ] P2: hands-free confirm as `Ask`-tier voice UX · velocity polish.

---

## Open bugs / risks (live)

| # | Severity | Item | Where | Status |
|---|---|---|---|---|
| R1 | Med | **Concurrent-session churn** — another agent commits across worktrees (`feat/handoff-hardening`, `feat/p0b-plan`) and an auto-committer can absorb a worktree's uncommitted tree. Caused HEAD churn + a surprise checkpoint commit this session. | repo-wide | **Live** — work in an isolated worktree; coordinate before touching `server.ts` approval/handoff. |
| R2 | Low | **Smoke test not in CI** — `npm run smoke:claude` needs an authenticated Claude binary + ~30s round-trip; the new PONG assertion is logic-verified but the live run is manual. | `scripts/smoke-claude-pane.ts` | **Accepted** — manual gate. |
| R3 | Low | **Migration is one-way** — dbt3 (2026-07-02) retired the `JANUS_LEDGER_BACKEND=legacy` rollback path along with the legacy backend itself; restoring the `.bak` JSON file no longer has a backend that reads it. | `src/store/migrate.ts` | **Closed by design** — no rollback path exists post-dbt3; restore from a `.janus.db` backup instead. |
| R4 | Low | **`bytesAfter>0`-style weak assertions may exist elsewhere** — audit other smoke/integration checks for "some output" vs "expected content". | `scripts/`, smoke tests | **Open** — sweep. |
| R5 | Info | **Roadmap line anchors stale** — `docs/roadmap/*` reference `main @16c62da` (2026-05-28); re-anchor before acting (`RECONCILIATION.md` §5). | `docs/roadmap/` | **Known** — re-anchor per item. |

> Add bugs as discovered. When closing one, move it to a "Resolved" note with the PR # rather than deleting,
> so the tracker doubles as a changelog.

---

## Backup branches (droppable)
- `wsm-e2e-work`, `wsm-integration` — superseded; all WS-M work is on `main`. Safe to delete once trusted.
