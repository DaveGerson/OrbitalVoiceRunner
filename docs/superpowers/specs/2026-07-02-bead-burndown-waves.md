# Bead Burn-Down Wave Plan — 2026-07-02

Execution plan for the 59 open beads, approved by the operator 2026-07-02 ("I love it").
Pattern per wave: **sonnet implementers → fable adversarial review → fix → gates**, then
commit → CI → push → PR (the standing done-pipeline). Priority order stays LOCKED per
`docs/roadmap/RECONCILIATION.md` §4; Waves 3 and 4 contain P1s but are **brainstorm-gated
by explicit operator instruction**, which wins — mechanical waves run while those gates wait.

## Execution order

| # | Wave | Beads | Gate |
|---|------|-------|------|
| 0 | Merge #120 → #121 | — | operator click (stacked PRs, both green) |
| 2 | Perimeter hardening | `xge` (P1) + `rm4` sidecar | autonomous — **running now** |
| 5a | Mechanical debt sweep | `ztd` `ngw` `smz` `j2e` `4s2` `3vl` `yfa` `33c.4` `kcc0` `f9ne` `egc` `dbt3` `izj` | autonomous, after Wave 2 lands |
| 5b | Resilience trio | `res2` `res3` `res5` | autonomous (yields to brainstorm gates if operator returns) |
| 3 | Voice-first UX trio | `hwu.1` `8fz.1` `f09.1` (all P1) | **STOP — brainstorm with operator first** |
| 4 | Cortex brain | `qky` → `e6s` → `icn`+`4ey` → `896` → `z5c` | **STOP — brainstorm with operator first** |

## Wave 1 decision record (operator approved the recommendations wholesale)

- `e6s`: diff-gated change-detector + debounce floor (== spec §17 dedupe flag; measured by `briefHashRepeatRate` from PR #121). Final shape confirmed at the Wave 4 brainstorm.
- `9ou`: **park** Nova Sonic 2 (bead stays open as the parking record).
- `dvn`: voice twin for watch rules (lands with epic 33c work, not in these waves).
- `izj`: keep operator typing ungated under STOP-ALL; document (Wave 5a).
- `dbt3`: retire `JANUS_LEDGER_BACKEND=legacy` (~−500 LOC, Wave 5a).
- `egc`: rename `restart_pane` → `promote_pane_mode` (Wave 5a).

## Wave 2 scope (this branch: `feat/perimeter-token-hardening`, stacked on #121)

`xge` — binding design directions:
1. Bind default `127.0.0.1` in ALL modes (kill the production→`0.0.0.0` special case,
   `server.ts:961`); non-loopback only via explicit host option/env.
2. Fail-closed: non-loopback bind without an explicit `API_AUTH_TOKEN` env refuses to start.
3. Token fallback (`server.ts:85`): deterministic cwd-hash → crypto-random per boot.
   The exported `API_AUTH_TOKEN` seam is load-bearing (~40 test files) — keep it.
4. Cookie auto-seed (`server.ts:655-678`): loopback peers only; add `?auth_token=` query
   seeding (exact match) as the remote-operator path.
5. `/live` (and observe) WS upgrade: if an `Origin` header is present it must be same-host
   or in `JANUS_ALLOWED_ORIGINS`; absent Origin (non-browser client with valid cookie) stays allowed.
6. Never log the token. Threat-model doc + bind×token behavior matrix in `docs/design/`.

`rm4` sidecar: document the read-gating boundary (content recall vs. always-on
orientation/alert metadata); seed the 6 promoted caps into the settings matrix so
`get_pane_gates` reports declared defaults — promoted caps only, no resolver rewrite.

## Standing constraints (all waves)

- Cortex primary never default-on; no safety-gating behavior changes without explicit design.
- No live API keys in tests; mock/fake seams only. Redaction invariants preserved.
- TDD; complexity gates (CC≤10 / cognitive≤15, zero suppressions) are hard errors.
- Beads: claim on start, close with provenance on land; follow-ups filed as new beads.

## Parked

Epic tails `hwu.2–6`, `8fz.2–6`, `f09.2–3`, `cvg.1`, `qs3.1`, `9ql.5`, `33c.1` (sequence
behind their wave-3/4 leads); `2if` (blocked on install); `pox` (accepted manual gate);
`akv` (standing ritual — run its re-scope pass after Wave 3 ships UI changes).
