# Execution Plan — Subagent Task Breakdown (Pillars 0–1)

- **Date:** 2026-06-03
- **Status:** Execution plan (ready to dispatch; covers Quick Wins → Keystone → Registry Phase 1)
- **Companions:** `2026-06-03-substantive-roadmap.md` (item IDs + sequencing), `2026-06-03-unified-tool-registry-tdd-spec.md` (the Pillar-1 contract + TDD tests), `2026-06-03-gap-assessment-vibe-to-substantive.md` (findings).
- **Scope:** the agent-sized tasks for **QW1–QW6, H1** (Pillar 0), **KS** (keystone slice), **REG1** (full registry Phase 1). Convergence (CV*), Resilience (RES*), Observability (OBS*), and cross-cutting debt (DBT*) get their own plans when scheduled.

---

## 0. Working agreement (applies to every task)

- **Worktree isolation is mandatory** (CLAUDE.md "Worktree Isolation" + registry spec R7). Every commit-authorized agent works in **its own worktree** (`dev <task>` / `claude --worktree`, `isolation:'worktree'`), never the shared main checkout. One committer per tree. Reads across trees are always fine; mutation is single-owner.
- **TDD, every task:** write the failing test (RED) → minimum code (GREEN) → refactor. Test names are taken verbatim from registry spec §8 where they exist.
- **Battery before "done":** `npm run lint` (`tsc --noEmit`) → `npm run test:unit` → `npm run build`. Keystone/registry tasks also keep `npm run smoke:claude` driving a live pane.
- **Beads, not TODOs:** claim with `bd update <id> --claim`, close with `bd close <id>` (CLAUDE.md). Do not commit/push without the active profile's authority or an explicit instruction.
- **No behavior change unless the task says so.** Pillar 0 adds guards (degrade-not-crash); REG1 is a pure register-as-is refactor pinned by characterization goldens.
- **Recommended agent:** `general-purpose` with `isolation:'worktree'`, model `sonnet` for implementation tasks; escalate to `opus` only for REG1's dispatch swap if needed. Run independent tasks concurrently; serialize where the dependency graph (§4) says so.

---

## Wave A — Pillar 0 Quick Wins  *(one worktree, discrete commits)*

> **Why one agent / one worktree:** QW1, QW4, QW5, QW6 all touch `server.ts`; QW2 touches `src/ptyTransport.ts` + `src/terminal.ts`; QW3 touches the `server.ts` session setup. Splitting across agents would collide on `server.ts`. Run them as **one agent making one focused commit per QW item** so each is independently revertible but they don't fight over the file. H1 (dead-code delete) can be a parallel second agent (no overlap).

### Task A1 — Process-level error net  *(QW1)*
- **Files:** `server.ts` (top-level, near `startServer` bootstrap / the `close` handler).
- **RED:** `tests/test_process_safety.ts` — `it("an unhandledRejection is logged and does not exit")` and `it("uncaughtException triggers graceful drain, not a bare crash")`. Drive by emitting `process.emit('unhandledRejection', …)` against the installed handler; assert the handler ran and `process.exitCode` was not force-set to a crash.
- **GREEN:** install `process.on('uncaughtException')` + `process.on('unhandledRejection')` that (a) log structured, (b) best-effort flush the action log / announce, (c) do **not** `process.exit()` on a recoverable rejection. Keep it minimal — a net, not a framework.
- **Acceptance:** handlers present; the two tests green; no existing test regresses.

### Task A2 — Guard PTY spawn  *(QW2)*
- **Files:** `src/ptyTransport.ts` (`NodePtyTransport` ctor ~113, `LegacyChildProcessTransport` ~203, `createPtyTransport` ~293), `src/terminal.ts` (`start()` ~523 call site).
- **RED:** `tests/test_pty_spawn_guard.ts` — `it("a spawn failure surfaces as a clean error, not an uncaught throw")`: stub the pty loader to throw on `spawn`; assert `createPtyTransport`/`start()` returns/propagates a typed failure (terminal goes to an error/Exited state with a reason) and **no** exception escapes.
- **GREEN:** wrap the spawn in try/catch in both transports; have `createPtyTransport` return a structured failure; `terminal.start()` catch it, set a clean error status, surface a reason. Do not leave `this.transport`/`this.shellPid` half-assigned.
- **Acceptance:** bad command/cwd yields a clean error state; test green; happy-path spawn unchanged.

### Task A3 — Gemini session `onerror`/`onclose` (minimal)  *(QW3)*
- **Files:** `server.ts` (the `ai.live.connect` setup ~2111 and the WS `close` cleanup ~3679).
- **RED:** `tests/test_session_drop_minimal.ts` (using `tests/helpers/mockLive.ts`) — `it("a session error nulls activeLiveSession and detaches approvals")` and `it("a session error notifies the frontend 'voice lost'")`.
- **GREEN:** pass `onerror`/`onclose` callbacks to the connector: null `activeLiveSession` (guarded against the reconnect race — only if it still `=== session`), detach this session's approvals cleanly, broadcast a `voice_channel_lost` notice. **No reconnect logic here** — that's RES1. This is the minimal "fail loud, clean up" version.
- **Acceptance:** mock session error path is clean (no orphaned approvals, frontend notified); tests green.

### Task A4 — Await `stop_all` Stage-2 kills  *(QW4)*
- **Files:** `server.ts` (`stopAll` ~1684).
- **RED:** extend `tests/test_stop_all_two_stage.ts` — `it("stop_all reports only panes that actually stopped")`: make one pane's `stop()` reject; assert it is **not** in the reported `killed` set and the failure is surfaced.
- **GREEN:** `await Promise.allSettled(...)` the Stage-2 kills; build `killed` from fulfilled results only; report the rejected ones as failures.
- **Acceptance:** the brake never claims a pane is dead that isn't; existing two-stage tests stay green.

### Task A5 — Guard the `onOutput` chain  *(QW5)*
- **Files:** `server.ts` (`manager.onOutput` handler ~725), optionally `src/terminal.ts` (~554 callback invocation).
- **RED:** `tests/test_output_guard.ts` — `it("a throw in a pane-signal/history/transition step does not kill the output stream")`: make `paneSignalBus.publish` (or a transition hook) throw once; assert subsequent output from the same pane is still buffered/broadcast.
- **GREEN:** wrap each independent step (classify/publish, history append, transition detect) so one failure is logged and the rest proceed; the broadcast still happens.
- **Acceptance:** one bad chunk no longer blinds a pane; test green.

### Task A6 — Prune broken sockets  *(QW6)*  *(optional, smallest)*
- **Files:** `server.ts` (`broadcast` ~441).
- **RED:** `tests/test_broadcast_prune.ts` — `it("a socket that throws on send is removed from the clients set")`.
- **GREEN:** on send error, remove the client from `clients`.
- **Acceptance:** broken sockets don't accumulate; test green.

### Task A7 — Delete dead Python + fix docs  *(H1)*  *(parallel, separate agent — no `server.ts` overlap)*
- **Files:** remove `universal_terminal.py`, `tests/test_universal_terminal.py`; edit `CLAUDE.md` to drop the `tests.test_universal_terminal` line from the Build & Test battery (or replace with the real Python suite if one is intended to remain).
- **RED/GREEN:** N/A (deletion) — verify nothing imports them (`grep -r universal_terminal`) and the battery in CLAUDE.md no longer references a non-existent target.
- **Acceptance:** files gone, no dangling references, lint/build green.

**Wave A exit gate:** all QW tests green, full battery green, **merged to the integration branch before Wave B starts.** Bead per QW item closed.

---

## Wave B — Keystone vertical slice  *(KS — one agent, one worktree; depends on Wave A merged)*

Builds the `src/actions/*` scaffolding and migrates **only `create_pane`** end-to-end, proving the registry pattern and fixing the keystone launch-divergence bug. Follows registry spec §5.4 + §8.3b exactly.

> **Re-scope (2026-06-04, post `origin/main` @a977724):** the *gate* half of the keystone is already done on main — `restGateOutcome` (G6, `src/restGate.ts`) routes `POST /api/terminals` through the same `gateOrDefer` seam. So Wave B's net-new work is the **launch-derivation** half: pull the preset→binary map out of the three places that still hold it — REST/voice `create_pane` (pass-through `command`) and the **restart hack** (`server.ts:871–873`, `if tool_preset === "Claude Code"`) — into one `resolveLaunch` home, and make the schema a guardrail. `buildLaunchCommand` (`terminal.ts:82`, BUG-032) is a partial precedent that owns only the `--resume` decision; extend the "one home" to the binary map. Task B2's §8.3b tests already pin exactly this.

### Task B0 — Capture characterization goldens from `main`  *(prep, do first)*
- Before any refactor, capture the pre-refactor `sendToolResponse` payloads for the representative set (registry spec §8.5 #21) and `create_pane`'s resolved launch, committing them as fixtures. These are the "no behavior change" oracle for KS and REG1.

### Task B1 — Scaffolding
- **New files:** `src/actions/types.ts` (`ActionDef`, `ActionResult`, `ActionContext`, `Surface`), and minimal stubs of `registry.ts`, `gemini.ts` (`toGeminiDeclarations`, `zodToGeminiSchema`, `runAction`, `resultToToolResponse`), `rest.ts` (`mountRestRoutes`, `resultToHttp`), `coverage.ts` (`surfaceCoverage` + allow-list).
- **RED:** registry spec §8.1 #1–#5 (totality/shape), §8.3 #10–#16 (gate/redaction/error-once) written against a one-entry registry.
- **GREEN:** implement the wrapper + types so those tests pass with `create_pane` as the sole entry.

### Task B2 — `create_pane` as the first ActionDef (the keystone)
- **Domain:** extract `resolveLaunch(preset, command, settings)` into one home (`src/actions/` or the domain layer it calls) — the single preset→command map. Schema (`zod`) makes a model-authored launch string **unrepresentable**: `tool_preset` enum + `command` only valid (and required) for `Custom`.
- **RED (registry spec §8.3b):** 17a `preset→command derivation has exactly one home`; 17b `voice create_pane derives the launch command — the model cannot supply one`; 17c `Custom honors a free-form command`; 17d **`voice and REST create_pane produce an identical launch`**; 17e `cwd resolution matches the UI route`; 17f `shared env hygiene preserved`.
- **GREEN:** the `create_pane` handler calls `manager.addTerminal` via the shared `resolveLaunch`; wire `create_pane` through `runAction` on the voice path **and** `mountRestRoutes` for `POST /api/terminals`, both hitting the one handler.
- **Acceptance:** all §8.3b tests green (esp. 17d — the test that would have caught the original bug); `create_pane` characterization golden equals `main`; the rest of the dispatch is **untouched** (still the legacy `if/else` for the other 40 tools).

**Wave B exit gate:** `src/actions/*` exists and is proven by the keystone; voice≡REST launch parity is enforced by a permanent test; no other tool migrated; full battery + `smoke:claude` green. This is a mergeable, value-adding increment on its own (the keystone bug is fixed).

---

## Wave C — Full registry Phase 1  *(REG1 — same worktree/agent continues from Wave B; depends on KS)*

Migrate the remaining 40 tools and flip the dispatch. This is the large, sequential, single-owner refactor — **do not parallelize across agents** (it's one rewrite of the `server.ts` dispatch surface).

### Task C1 — Migrate the remaining 40 tools into the registry
- Move each `onmessage` branch's logic into an `ActionDef.handler` (logic *moved*, not rewritten), with its zod schema, capability (per Appendix A), `readOnly`, and current `surfaces`. Inject `gateOrDefer`/`dispatchProposal` via `ActionContext` (R3) — handlers are thin adapters, they don't reimplement gate/handoff logic.
- **RED:** registry spec §8.1b (matrix derived from registry: 5a–5d), §8.2 (Gemini generation 6–9, incl. the golden), §8.4 (#18–#20b coverage + REST adapter), §8.5 #21 (characterization goldens for the representative set).
- **GREEN:** populate the full registry; derive `ALL_CAPABILITIES` from it; seed the coverage allow-list with **every** current asymmetry (§4.2) so the build is green without converging anything.

### Task C2 — Swap the dispatch + REST mount + build the audit seam
- **Modify `server.ts`:** replace the `functionDeclarations: [...]` literal with `toGeminiDeclarations(registry)`; replace the `if (name === …)` chain with `const result = await runAction(name, args, ctx); resultToToolResponse(result, session, call.id)`; replace registry-backed `app.<verb>` routes with `mountRestRoutes(app, registry, ctxFactory)`. Leave non-tool branches (audio/interrupt) alone.
- **Build the `action_log` seam** (registry spec §5.6): `runAction` appends one structured row per action to a new `action_log` table in `JanusStore` and returns the result unchanged. (Surfacing is Pillar 3 / OBS1 — not now.)
- **Delete** the regex parity guard in `tests/test_voice_tools.ts`; point its assertions at the registry (§8.2 #6 replaces it).
- **One try/catch** in `runAction` replaces the 41 hand-guards; `resultToToolResponse` answers `call.id` exactly once (pins WS-E.1 / BUG-001 structurally — §8.3 #16).

### Task C3 — Coverage map + green the battery + file follow-ups
- **RED/GREEN:** §8.4 #20a (`npm run catalog` ⇒ no diff vs. committed `docs/CAPABILITIES.md`), #20b (coverage total over capability×surface).
- Run the **full DoD battery** (registry spec §12 Phase 1): lint, test:unit, build, smoke:claude; characterization goldens equal `main`; `surfaceCoverage` green with no surface changed.
- **File follow-up beads** for CV1/CV2/CV3 (convergence) and REG2 (Python catalog), and confirm the RES*/OBS* beads exist.

**Wave C exit gate = registry spec §12 Phase-1 DoD in full.** No `if (name === …)` tool chain remains; regex guard gone; allow-list = every current asymmetry; **no tool gained or lost a surface**; goldens equal `main`.

---

## Wave D — Registry plumbing  *(PLM1–PLM5 — the choke-point payoff; depends on REG1)*

This is what makes the registry worth installing: it hangs the dependability features off the `runAction` seam + `action_log` table that Wave C built. PLM1–PLM3 are independent of one another (parallel-safe in their own worktrees off the merged registry); PLM4 is the largest; PLM5 depends on PLM2.

### Task D1 — Per-action timeout  *(PLM1, was RES4)*
- **Files:** `src/actions/gemini.ts` (`runAction`); `src/actions/types.ts` (optional `ActionDef.timeoutMs`).
- **RED:** `tests/test_action_timeout.ts` — `it("a handler exceeding its deadline yields {kind:'error'} answered once")`; `it("ALWAYS_ALLOWED brake actions are exempt / get a generous deadline")`.
- **GREEN:** `Promise.race` the handler against a per-action deadline (default + override); on timeout return an `error` result; `resultToToolResponse` still answers `call.id` exactly once; the realtime session is never blocked.
- **Acceptance:** stuck handler degrades cleanly; brake unaffected; tests green.

### Task D2 — Action-log view  *(PLM2, was OBS1)*
- **Files:** new `get_action_log` ActionDef (readOnly, `read_pane`/Auto) querying `action_log`; `mountRestRoutes` auto-exposes `GET /api/action-log`; a minimal `src/App.tsx` panel.
- **RED:** `tests/test_action_log_view.ts` — `it("get_action_log returns redacted rows filtered by pane/capability/outcome")`; `it("each row carries surface, actor, capability, gateDisposition, resultKind, ms")`.
- **GREEN:** a query helper on `JanusStore`; register the read action (so it inherits gate + redaction + REST generation for free — the registry dogfooding its own payoff); wire the panel.
- **Acceptance:** the audit trail REG1 writes is now *visible and filterable*; tests green.

### Task D3 — Durable-closure version guard  *(PLM3, NEW)*
- **Context:** durable `PendingAction`s persist *intent* and rebuild `run()` on boot via `actionEffects.ts`; REG1 rewrites every handler, so a pre-refactor intent could rebuild into a changed/removed effect.
- **Files:** `src/actionEffects.ts` (`buildActionRun`), `src/pendingActions.ts` (persist path), `src/store/schema.ts` (add a `registry_version` / action-schema-hash column).
- **RED:** `tests/test_durable_action_version.ts` — `it("a persisted intent whose capability no longer exists is quarantined, not silently mis-run")`; `it("a persisted intent with a mismatched action-schema hash is flagged for re-confirmation, not auto-run")`.
- **GREEN:** stamp each persisted intent with `{actionName, schemaHash}` (hash of the ActionDef params+capability); on rehydrate, validate against the live registry — on miss/mismatch mark the pending action `needs_review` and surface it, rather than rebuilding a possibly-wrong `run()`.
- **Acceptance:** version skew is quarantined, never silently executed; tests green.

### Task D4 — Session reconnect + in-flight idempotency  *(PLM4, was RES1)*
- **Files:** `server.ts` session setup (builds on QW3's `onerror`/`onclose`); `src/actions/gemini.ts` (`runAction` idempotency hook).
- **RED:** `tests/test_session_reconnect.ts` — `it("on reconnect the session resumes from the last sessionResumption token")`; `it("an in-flight runAction interrupted by a drop is replayed idempotently or reported interrupted — never double-applied")`; `it("pending approvals survive a reconnect and are re-announced")`.
- **GREEN:** persist the resumption token; on `onclose` attempt reconnect with backoff; tag each `runAction` with an idempotency key `(surface+actor+name+argsHash)` recorded in `action_log` so a replay is detected; reuse `reannounceSurvivors` on the new session.
- **Acceptance:** a network blip no longer ends the session; no double-apply; tests green.

### Task D5 — Health/counters strip  *(PLM5, was OBS2; dep D2)*
- **Files:** new `get_health` read action (session-connected, pane liveness counts, in-flight/pending counts, recent error-rate from `action_log`); a small always-visible `src/App.tsx` strip.
- **RED:** `tests/test_health.ts` — `it("get_health reports session state, pane counts, pending count, recent error rate")`.
- **GREEN:** aggregate from `manager` + `action_log`; register the read action; render the strip.
- **Acceptance:** always-visible truth about the system; test green.

> **Noted next add (not this wave):** a thin **rate-limit** hook at the same `runAction` seam — cheap once PLM1/PLM2 exist; file as a follow-up bead.

**Wave D exit gate = the handoff doc §5 DoD:** audit log visible, per-action timeout live, durable rehydrate version-guarded, session reconnect working, health strip rendering.

---

## 4. Dependency graph & parallelism

```
            ┌─────────────── Wave A (Pillar 0) ───────────────┐
            │  A1 A2 A3 A4 A5 A6  (one agent, serial commits)  │   A7/H1 ‖ (separate agent)
            └──────────────────────┬──────────────────────────┘
                                   │  merge to integration
                                   ▼
                          Wave B  (KS)  B0 → B1 → B2        (one agent, one worktree)
                                   │  merge (keystone bug fixed)
                                   ▼
                          Wave C  (REG1) C1 → C2 → C3       (same agent continues; single-owner)
                                   │  Phase-1 DoD
                                   ▼
              Wave D (plumbing)   PLM1 ‖ PLM2 ‖ PLM3   →   PLM4   →   PLM5(dep PLM2)
                                   │  handoff DoD (audit visible, timeout, version-guard, reconnect, health)
                                   ▼
        ┌──────────── then (separate plans) ────────────┐
        │  CV1→CV2→CV3   ‖   REG2(Python)   ‖   RES2/3/5/6   ‖   OBS3  │
        └────────────────────────────────────────────────────────────┘

Parallel throughout (independent worktrees, own track): DBT4 (App.tsx), DBT1/DBT2 typing.
```

- **Serialize:** A → B → C → D (each rebases on the prior merge). Within C, C1→C2→C3 are sequential edits of the same surface. Within D, PLM1/PLM2/PLM3 fan out; PLM4 then PLM5.
- **Parallel-safe now:** A7/H1 (deletes), the DBT typing/UI tracks, and (within Wave D) PLM1/PLM2/PLM3 in separate worktrees off the merged registry.
- **Hard rule:** only **one** agent mutates the `server.ts`/`src/actions` worktree at a time (worktree-mutex). Reviewers may read any worktree concurrently (CLAUDE.md "Reads vs. writes").

## 5. Dispatch checklist (what to launch, in order)
1. **Agent 1 (worktree):** Wave A QW1–QW6 — serial commits, then full battery, then stop for review/merge.
   **Agent 2 (worktree, parallel):** A7/H1 dead-code delete.
2. After A merges → **Agent 3 (worktree):** Wave B (B0→B1→B2), keystone. Stop at the Wave-B exit gate for review/merge.
3. After B merges → **Agent 3 continues (same worktree):** Wave C (C1→C2→C3) to the Phase-1 DoD; file backlog beads.
4. After C merges → **Wave D plumbing:** fan out **Agent 5a/5b/5c (worktrees):** PLM1 / PLM2 / PLM3 in parallel → merge → **Agent 5 (worktree):** PLM4 → PLM5. Stop at the handoff DoD.
5. Optional anytime: **Agent 4 (worktree):** DBT4 App.tsx decomposition (independent).

Each agent reports: changed files, validation run, bead status, and any blocked commit/push step (per CLAUDE.md session-completion protocol). No PRs unless explicitly requested.
