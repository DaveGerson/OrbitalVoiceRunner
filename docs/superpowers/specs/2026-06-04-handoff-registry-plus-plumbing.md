# Handoff — Registry **+ its plumbing** (the choke-point payoff)

- **Date:** 2026-06-04
- **Status:** Handoff plan (drives execution; this doc is the PR centerpiece)
- **Why this exists:** the original stop point ("registry implemented") would have installed the `runAction` choke-point as an *empty hook* — the audit log written but unreadable, no timeout, no reconnect. This handoff pulls the **highest-value plumbing** that makes the registry actually pay off into the registry epic, so it ships as a *working* dependability surface, not just a seam.
- **Reads (source of truth, already on `main`):**
  - `2026-06-03-substantive-roadmap.md` — item IDs + sequencing (now includes **Pillar 1+ plumbing**).
  - `2026-06-03-execution-plan-subagents.md` — Waves A–C **and the new Wave D** (per-task TDD/files/acceptance).
  - `2026-06-03-unified-tool-registry-tdd-spec.md` — the Pillar-1 contract + §8 tests; §5.6 is the choke-point the plumbing hangs off.
  - `2026-06-03-gap-assessment-vibe-to-substantive.md` §6 — the 2026-06-04 reconciliation against `main`.

---

## 1. Scope of this handoff

Execute **Wave A → B → C → D**, stopping at the end of Wave D:

| Wave | Item(s) | What it delivers |
|---|---|---|
| **A** | QW1–QW6, H1 | Pillar 0 crash-safety + dead-code delete (independent; land first) |
| **B** | KS | Keystone slice — `create_pane` launch-derivation single-home + schema guardrail (gate half already done on `main` via `restGateOutcome`) |
| **C** | REG1 | Full registry Phase 1 — one `ActionDef` surface, generated Gemini/REST, derived matrix, **`action_log` table written** |
| **D** | PLM1–PLM5 | **The plumbing that makes the seam worth installing** ↓ |

### Wave D — the highest-value plumbing (this is the point of the PR)
| ID | Plumbing | Why highest-value | Effort |
|---|---|---|---|
| **PLM1** (was RES4) | **Per-action timeout** in `runAction` | The seam's cheapest safety win — a stuck handler can't block the realtime voice session. Trivial once the wrapper exists. | S |
| **PLM2** (was OBS1) | **Action-log view** — `get_action_log` read action → `GET /api/action-log` + minimal UI panel | Turns the `action_log` table REG1 *writes* into the actual trust feature: "what did Janus do, and was it allowed?" Without it the audit trail is invisible. | M |
| **PLM3** (NEW) | **Durable-closure version guard** | REG1 rewrites every handler; durable `PendingAction`s persist *intent* and rebuild `run()` on boot. A pre-refactor intent could rebuild into a changed/removed effect. Must quarantine skew, not silently mis-run. | M |
| **PLM4** (was RES1) | **Session reconnect + in-flight idempotency** | Voice-first table stakes: survive a network blip without losing the session; an interrupted `runAction` must never double-apply. Hangs off the same wrapper + QW3's `onerror`. | M |
| **PLM5** (was OBS2-min) | **Health/counters strip** | Always-visible truth: session-connected, pane liveness, pending count, recent error-rate (read from `action_log`). | S |

**Out of scope (file as backlog beads, do not start):** Convergence CV1–CV3, remaining resilience (RES2 PTY-death, RES3 boot-UX, RES5 failure-suite, RES6 queue-cap), Pillar-3 remainder, cross-cutting debt (DBT1–DBT4), Python catalog (REG2). A thin **rate-limit** hook is noted as the next add at the same seam.

## 2. How to run it

1. `bd prime`; **file the beads** — `sh scripts/seed-beads.sh` (or `bd import docs/beads/2026-06-04-registry-plumbing.jsonl`). The manifest is §4 below.
2. Work the waves in order; **stop-and-review gate after each wave** (A, B, C, D). Within a wave, TDD every task (RED → GREEN → refactor) with the exact `it(...)` names from the execution plan / registry-spec §8.
3. **Worktree isolation is mandatory** for commits (own worktree off `main`; never commit on `main`; one committer per tree — CLAUDE.md).
4. Battery before any task is done: `npm install` → `npm run lint` → `npm run test:unit` → `npm run build` (keystone/registry also `npm run smoke:claude`). Windows: `py -3`.
5. No further PRs unless asked.

## 3. Don't redo what `main` already did (reconciliation)
- KS = **launch-derivation half only** (gate half done: `restGateOutcome`/G6). Remove the restart hack at `server.ts:871–873`; fold preset→binary into one `resolveLaunch`. `buildLaunchCommand` (BUG-032) owns only `--resume`.
- Durable stores already exist (kzt/nzt) — PLM3 *guards* their rehydrate, it doesn't rebuild them.
- Still-open, verify-then-fix: QW1 (no process error net — 0), QW2 (`pty.spawn` at `ptyTransport.ts:113` unguarded).

## 4. Bead manifest (file these)

> `bd` is **not installed in the web container** these specs were authored in, so the beads ship here as a seed (script + JSONL) for a `bd`-equipped session to file in one command. IDs below are slugs; `bd` assigns real IDs.

**Epic `p0` — Pillar 0 Quick Wins**
| slug | title | type | prio | deps | accept |
|---|---|---|---|---|---|
| qw1 | Process-level error net (uncaughtException/unhandledRejection) | task | 1 | — | net present; `test_process_safety.ts` green; no force-exit on recoverable rejection |
| qw2 | Guard PTY spawn (degrade-not-crash) | task | 1 | — | bad cmd/cwd → clean error state; `test_pty_spawn_guard.ts` green |
| qw3 | Gemini session onerror/onclose (minimal) | task | 1 | — | session error nulls activeLiveSession, detaches approvals, notifies frontend |
| qw4 | Await stop_all Stage-2 kills | task | 1 | — | reported `killed` = only panes actually stopped |
| qw5 | Guard the onOutput chain | task | 2 | — | one bad step doesn't blind a pane's output |
| qw6 | Prune broken sockets from clients set | task | 3 | — | throwing socket removed on send error |
| h1 | Delete dead universal_terminal.py + fix CLAUDE.md battery | chore | 3 | — | files gone; no dangling refs; lint/build green |

**Epic `p1` — Registry**
| slug | title | type | prio | deps | accept |
|---|---|---|---|---|---|
| ks | Keystone: create_pane launch-derivation single-home + schema guardrail | feature | 1 | qw2 | §8.3b 17a–17f green incl. voice≡REST identical launch; restart hack removed |
| reg1 | Registry Phase 1 — register-as-is; generated surfaces; derived matrix; action_log seam | feature | 1 | ks | spec §12 Phase-1 DoD; regex guard gone; goldens == main; no surface changed |

**Epic `plm` — Registry plumbing (the choke-point payoff)** — all dep `reg1`
| slug | title | type | prio | accept |
|---|---|---|---|---|
| plm1 | Per-action timeout in runAction | feature | 1 | over-deadline handler → `{kind:error}` answered once; brake exempt; session never blocked |
| plm2 | Action-log view — get_action_log read action + GET /api/action-log + UI panel | feature | 1 | rows redacted, filterable by pane/capability/outcome; carries gateDisposition+ms |
| plm3 | Durable-closure version guard (rehydrate skew) | feature | 1 | persisted intent w/ missing capability or changed schema-hash → quarantined for re-confirm, not auto-run |
| plm4 | Session reconnect + in-flight idempotency | feature | 1 | resume from token; interrupted runAction not double-applied; approvals re-announced |
| plm5 | Health/counters strip (get_health + UI) | feature | 2 | reports session state, pane counts, pending count, recent error-rate; dep plm2 |

**Epic `backlog` — deferred (file, do not start)**
| slug | title | type | prio |
|---|---|---|---|
| cv1 | Convergence C1 — reads → REST | feature | 2 |
| cv2 | Convergence C2 — handoff lifecycle → REST/WS | feature | 2 |
| cv3 | Convergence C3 — infra → voice (close/restart pane, archive, watch-rule CRUD) | feature | 2 |
| res2 | PTY death handling + ConPTY drain tests | task | 2 |
| res3 | Server-restart recovery UX ("restart N panes?") + running-PTY restore | task | 2 |
| res5 | Failure-injection test suite | task | 2 |
| res6 | Attention-queue cap audit (pruneAttention at every site) | task | 2 |
| dbt1 | SQLite typed-row hydration (kill `as any[]`) | task | 2 |
| dbt2 | Gemini message envelope typing | task | 2 |
| dbt3 | Legacy ledger backend decision (retire vs. keep) | chore | 3 |
| dbt4 | App.tsx decomposition (4.5k lines) | task | 2 |
| reg2 | Phase 2 — Python catalog authority + codegen | feature | 2 |

## 5. Definition of done for this handoff
Waves A–D complete: Pillar-0 crash-safety merged; keystone launch parity enforced; registry-spec §12 Phase-1 DoD met; and the **registry ships with working plumbing** — visible audit log, per-action timeout, version-guarded durable rehydrate, session reconnect, and a health strip. Backlog beads filed for everything deferred.
