# Substantive Roadmap — "Vibe-Coded → Daily Driver"

- **Date:** 2026-06-03
- **Status:** Roadmap (sequences the work; pairs with the gap assessment + registry spec)
- **Companions:**
  - `2026-06-03-gap-assessment-vibe-to-substantive.md` — the measured audit (findings A–F).
  - `2026-06-03-unified-tool-registry-tdd-spec.md` — Pillar 1, the registry (the centrepiece refactor).
  - `2026-06-03-execution-plan-subagents.md` — agent-sized task breakdown for Pillars 0–1.
- **Relationship to the product roadmap:** This is the **dependability/engineering** roadmap. It does **not** alter the LOCKED product priority stack in `docs/roadmap/RECONCILIATION.md §4` — it is the substrate-hardening track those features ride on. Where they touch (e.g. voice `create_pane`, item 5), the IDs are cross-referenced.
- **Reconciled 2026-06-04** against `origin/main` @a977724 (19 post-audit commits). Pillar 0 untouched and still the cheapest win; **KS re-scoped to its launch-derivation half** (gate half done via `restGateOutcome`/G6); **RES3 re-scoped to boot-UX/recovery** (durable stores done via kzt/nzt); F4 partly done. The new "keep-in-lockstep" helper family *strengthens* the registry case. Full deltas in the gap assessment §6.

---

## 0. BLUF

The gap assessment found a consistent shape: **the happy path is solid, the boundaries are soft.** The core abstractions (gate matrix, approvals, handoff state machine, SQLite store) are substantive and well-tested and are *not* rebuilt here. What's missing is the defensive/structural layer at the edges. This roadmap closes that in **five stages across four pillars**, front-loaded so the cheapest, highest-felt-reliability work lands first:

```
Pillar 0  Quick Wins        ~1 day    crash-safety + hygiene        (independent; land first)
Pillar 1  Registry          ~1.5 wk   one legible action surface    (the registry spec; keystone-first)
   └─ Convergence track     ~1 wk     burn down surface asymmetry   (piecemeal, post-registry)
Pillar 2  Resilience        ~1 wk     tested failure recovery        (attaches to the runAction seam)
Pillar 3  Observability     ~0.5 wk   surface the audit trail        (attaches to the same seam)
   ‖ Cross-cutting debt     parallel  typing, dead code, App.tsx     (opportunistic)
```

Total to a dependable daily driver: **~3–4 focused engineer-weeks**, but the *felt* jump happens on day 1 (Pillar 0) and the legibility jump on the registry merge.

## 1. The items (stable IDs)

Every gap-assessment finding is assigned a roadmap item with a stable ID so the subagent plan and beads can reference it. `[A1]`-style tags point back to the assessment's findings.

### Pillar 0 — Quick Wins (Stage 0)  *— crash-safety + hygiene, independent of the refactor*
| ID | Item | Closes | Sev | Effort |
|---|---|---|---|---|
| **QW1** | Process-level error net — `uncaughtException` + `unhandledRejection` handlers (log, attempt graceful drain, don't crash mid-op) | [A3] | HIGH | S |
| **QW2** | Guard PTY spawn — wrap `pty.spawn`/legacy `spawn` and the `createPtyTransport` call so a bad command/cwd returns a clean error, never an uncaught throw | [A2] | HIGH | S |
| **QW3** | Gemini session `onerror`/`onclose` (minimal) — surface "voice channel lost" to the client + null out `activeLiveSession` + detach approvals cleanly. (Full reconnect is RES1.) | [A1-min] | HIGH | S |
| **QW4** | Await `stop_all` Stage-2 kills — the emergency brake must report only panes actually stopped | [A4] | HIGH | S |
| **QW5** | Guard the `onOutput` callback chain — one throw in pane-signal/history/transition must not kill a pane's output stream | [A5] | MED | S |
| **QW6** | Prune broken sockets from the `clients` set on send-error (stop the slow leak) | [A6] | LOW | S |
| **H1** | Delete dead `universal_terminal.py` + `tests/test_universal_terminal.py`; fix the stale reference in `CLAUDE.md`'s build battery | [F1] | LOW | S |

### Pillar 1 — Registry (Stages 1–2)  *— the registry spec; G0 legibility is the headline*
| ID | Item | Closes | Sev | Effort |
|---|---|---|---|---|
| **KS** | **Keystone vertical slice** — `create_pane` migrated end-to-end: single-home `resolveLaunch` derivation, schema-as-guardrail (model picks `tool_preset`, cannot author a launch string), voice≡REST parity test (§8.3b). Proves the registry pattern before the bulk migration. **Re-scoped 2026-06-04:** the *gate* half is already done on main (`restGateOutcome`, G6); KS is now the **launch-derivation** half — fold the preset→binary map + the restart hack (`server.ts:871–873`) into one home; `buildLaunchCommand` (BUG-032) is a partial precedent (owns only `--resume`). | [B4] keystone | HIGH | M |
| **REG1** | Full Phase-1 register-as-is — `src/actions/{types,registry,gemini,rest,coverage}.ts`; migrate all 41 voice tools + rest-only infra; swap `server.ts` dispatch + REST mount to generators; derive the capability matrix from the registry; **build the `action_log` seam** (§5.6); delete the regex parity guard; characterization goldens. | [B1][C1][D1·][D4][F3][G0] | HIGH | L |
| **CV1** | Convergence C1 — read tools → REST (`get_pane_summary/delta/gates`, `search_notes`, `list_capabilities`) | [D1] | MED | M |
| **CV2** | Convergence C2 — handoff lifecycle → REST/WS | [D1] | MED | M |
| **CV3** | Convergence C3 — rest-only infra → voice (`close_pane`/`restart_pane` Ask-gated, archive, clear-exited, watch-rule CRUD) | [D1] | MED | M |
| **REG2** | Phase 2 — Python catalog authority + codegen (Pydantic → committed generated TS/JSON, no-drift test) | (spec §7) | — | M |

### Pillar 2 — Resilience (Stage 4)  *— attaches to the runAction seam (spec §13)*
| ID | Item | Closes | Sev | Effort |
|---|---|---|---|---|
| **RES1** | Gemini session reconnect — resume from `sessionResumption` token; in-flight `runAction` idempotent-replayable or reported interrupted; pending approvals re-announced | [A1-full][D3] | HIGH | M |
| **RES2** | PTY death handling — pane death → attention item + earcon; `read`/`propose` on a dead pane returns clean `blocked`/`clarify`; restart via shared `resolveLaunch`; ConPTY drain tested | [A5][D2] | MED | L |
| **RES3** | Server-restart recovery — **re-scoped 2026-06-04:** the persistence half is **done on main** (durable `PendingActionStore`/`PendingApprovalStore`, intent persisted + `run()` rebuilt on boot via `actionEffects.ts`). Remaining: boot-time "N panes were running, restart them?" re-announce UX + running-PTY recovery; nothing silently re-executes | [E1·done][E2] | MED | S |
| **RES4** | Per-action timeout in `runAction` — stuck handler → `{kind:"error"}` answered once; realtime session never blocked | (spec §13) | MED | S |
| **RES5** | Failure-injection test suite (`tests/test_resilience.ts`) — kill the mock session mid-tool-call, transport exit mid-command, persist+re-import server | [D3] | HIGH | M |
| **RES6** | Attention-queue cap audit — ensure `pruneAttention()` at every mutation site (BUG-035) | [E3] | MED | S |

### Pillar 3 — Observability (Stage 5)  *— surface the seam (spec §13)*
| ID | Item | Closes | Sev | Effort |
|---|---|---|---|---|
| **OBS1** | Action-log view — `GET /api/action-log` (itself a registry read action) + UI panel over `action_log`: filter by pane/capability/outcome, gate decision + latency per action | (spec §13) | MED | M |
| **OBS2** | Health/status strip — pane liveness, session-connected, in-flight/pending counts, recent error rate | (spec §13) | MED | S |

### Cross-cutting debt (parallel / opportunistic)
| ID | Item | Closes | Sev | Effort |
|---|---|---|---|---|
| **DBT1** | SQLite typed-row hydration — replace the 40+ `as any[]` query casts with typed row mappers | [B2] | MED | M |
| **DBT2** | Gemini message envelope typing — one validated shape for the `onmessage` polyfills | [B3] | MED | M |
| **DBT3** | Legacy ledger backend decision — retire `JANUS_LEDGER_BACKEND=legacy` (~500 LOC) or keep as a documented escape hatch | [F2] | MED | M |
| **DBT4** | `App.tsx` decomposition (4.5k lines) — split the UI monolith; own track, parallel to the server work | [C2] | HIGH | L |
| **DBT5** | Duplication mop-up — cwd resolution (project-dir half done on main via `resolveProjectDir`; pane cwd + broadcast shapes remain; mostly absorbed by REG1) + the new hand-mirrored helper family (`restGate`/`recipeApply`/`actionPendingPayload`/`actionEffects`, all "keep in lockstep") | [F3][F4] | LOW | S |

## 2. Sequenced plan (stages, gates, dependencies)

### Stage 0 — Pillar 0 Quick Wins  *(QW1–QW6, H1)*
- **Entry:** none. **Depends on:** nothing.
- **Why first:** S-effort, HIGH-value, and independent of the registry. They harden the exact async edges the registry refactor will lean on, so the refactor rebases on a process that no longer crashes.
- **Exit gate:** each fix has a focused test (or a documented manual repro where a test is impractical); `npm run lint && npm run test:unit && npm run build` green; merged to the integration branch **before** KS starts.

### Stage 1 — Keystone vertical slice  *(KS)*
- **Depends on:** Stage 0 merged (so the new handler inherits the spawn guard + process net).
- **Why a slice first:** `create_pane` exercises every hard part of the registry at once — schema guardrail, deterministic `resolveLaunch`, gate routing, voice≡REST parity. Proving it end-to-end de-risks the bulk migration and lands the keystone bug fix (the original voice/REST launch divergence) early.
- **Exit gate:** §8.3b tests (17a–17f) green, including `voice and REST create_pane produce an identical launch`; the `src/actions/*` scaffolding exists; no other tool migrated yet; no behavior change for `create_pane` vs. `main` (characterization golden).

### Stage 2 — Full registry (REG1)
- **Depends on:** KS (the proven pattern + scaffolding).
- **Scope:** migrate the remaining 40 tools; swap `server.ts` dispatch + REST mount to the generators; derive the matrix; build the `action_log` seam; delete the regex guard; full characterization goldens.
- **Exit gate:** registry-spec **Phase 1 DoD** (§12) — all surfaces generated, regex guard gone, coverage allow-list = every current asymmetry, goldens equal `main`, full battery green, convergence/Phase-2 beads filed.

### Stage 3 — Convergence  *(CV1 → CV2 → CV3)* and **REG2** (parallel-able)
- **Depends on:** REG1. Each Cn is independent, small, revertible, and gated by its own parity-cutover test (§8.5b). REG2 (Python catalog) can run in parallel once REG1 lands.

### Stage 4 — Resilience  *(RES1–RES6)*
- **Depends on:** REG1 (RES1/RES4 hook the `runAction` seam; RES4's timeout lives in the wrapper). RES2/RES3/RES6 are largely independent and can interleave with Stage 3.
- **Exit gate:** `tests/test_resilience.ts` green; a `resilience-design.md` records the specified behavior per failure mode.

### Stage 5 — Observability  *(OBS1–OBS2)*
- **Depends on:** REG1's `action_log` table existing. Pure surfacing; lowest urgency.

**Cross-cutting debt** (DBT1–DBT5) is scheduled opportunistically: DBT5 falls out of REG1; DBT1/DBT2 ride alongside Stage 2/4; DBT3 is a decision gate (make the call before REG2 to avoid carrying both backends into codegen); DBT4 (App.tsx) is a parallel UI track that does not block the server work.

## 3. Traceability — finding → item → stage → pillar → does the registry fix it?

| Assessment finding | Item | Stage | Pillar | Registry (Pillar 1) fixes it? |
|---|---|---|---|---|
| A1 session no `onerror`/reconnect | QW3 (min) + RES1 (full) | 0, 4 | 0/2 | No |
| A2 unguarded PTY spawn | QW2 | 0 | 0 | No |
| A3 no process error net | QW1 | 0 | 0 | No (uniform try/catch helps, but the net is net-new) |
| A4 `stop_all` fire-and-forget | QW4 | 0 | 0 | No |
| A5 unguarded `onOutput` | QW5 + RES2 | 0, 4 | 0/2 | No |
| A6 broken-socket leak | QW6 | 0 | 0 | No |
| B1 untyped tool args | REG1 (zod schemas) | 2 | 1 | **Yes** |
| B2 SQLite `as any[]` | DBT1 | parallel | adjacent | Partial (same discipline) |
| B3 Gemini message polyfills | DBT2 | parallel | adjacent | Partial |
| B4 `preset as any` divergence | KS | 1 | 1 | **Yes (keystone)** |
| C1 server.ts monolith dispatch | REG1 | 2 | 1 | **Yes** |
| C2 App.tsx monolith | DBT4 | parallel | UI | No |
| C3 `addTerminal` 4 call sites | KS + REG1 | 1–2 | 1 | **Yes** |
| D1 REST untested in isolation | REG1 + CV1–3 | 2–3 | 1 | **Yes** (adapter + parity tests) |
| D2 PTY/ConPTY untested | RES2 | 4 | 2 | No |
| D3 no failure-injection tests | RES5 | 4 | 2 | No |
| D4 dispatch only regex-guarded | REG1 | 2 | 1 | **Yes** (structural tests) |
| E1 approvals not re-announced | RES3 | 4 | 2 | No |
| E2 running PTYs lost on boot | RES3 | 4 | 2 | No |
| E3 attention queue unbounded | RES6 | 4 | 2 | No |
| F1 dead Python | H1 | 0 | hygiene | No |
| F2 dual ledger backend | DBT3 | decision | hygiene | No |
| F3 mirrored gate logic | REG1 | 2 | 1 | **Yes** (one resolver) |
| F4 cwd/broadcast duplication | DBT5 | 2 | 1 | **Yes** (absorbed) |

**Reading:** Pillar 1 retires the bulk of the HIGH-severity *legibility/typing/structure* findings (B1, B4, C1, C3, D1, D4, F3, F4). The HIGH-severity *crash-safety* findings (A1–A4) are Pillar 0, deliberately pulled ahead because they're cheap and independent. Resilience/recovery (D2, D3, E*) is Pillar 2. Hygiene and the UI monolith run in parallel.

## 4. What we are explicitly **not** doing (and why)
- **Not rebuilding** the gate matrix, approval lifecycle, handoff state machine, or SQLite store — they are already substantive and well-tested (assessment §5). The registry routes *through* them.
- **No Python execution backend** (registry Decision 1 / NG3) — the seam stays future-proof; we don't build it.
- **No signed/replay audit, RBAC, per-path policy engine, rate-limit/anomaly** — ruled out for a single-director tool by `RECONCILIATION.md §2/§6`. (Unsigned `action_log` is in scope as REG1's seam.)
- **No new product features here** — this roadmap hardens the substrate; product velocity items keep their LOCKED order in `RECONCILIATION.md §4`.

## 5. Tracking
File one bead per item ID above (Pillar 0 items as a small epic, KS + REG1 as the registry epic, CV/RES/OBS/DBT as their own). Dependencies mirror §2. The subagent execution plan (`2026-06-03-execution-plan-subagents.md`) covers Pillars 0–1 (QW*, H1, KS, REG1) in agent-sized tasks; later stages get their own plans when they come up.
