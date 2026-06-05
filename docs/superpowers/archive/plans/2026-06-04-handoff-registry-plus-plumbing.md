# Registry + Plumbing — Verified Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the `2026-06-04-handoff-registry-plus-plumbing.md` handoff to its DoD — Pillar-0 crash safety (Wave A) → keystone `create_pane` launch parity (Wave B) → full register-as-is registry Phase 1 (Wave C) → the 5 plumbing payoffs (Wave D) — TDD, one isolated worktree per wave, stop-and-review gate after each wave.

**Architecture:** In-process TypeScript. `server.ts` (4053 lines) is the WS/REST hub; the 41 voice tools live as a `functionDeclarations` array (3395-3856) + a parallel `if (name===…)` dispatch chain (2420-3368). Safety routes through nested closures `gateOrDefer`/`effectiveCapabilityGateFor`/`dispatchProposal` in `server.ts`. State persists via the SQLite `JanusStore` (`src/store/sqliteStore.ts`, forward-only migrations in `src/store/schema.ts`).

**Tech Stack:** TypeScript 5.8, Node + tsx, node:test (`tsx --test --test-force-exit tests/*.ts`), Express 4, ws, better-sqlite3, node-pty (ConPTY on Windows), Vite + esbuild build. **`zod` must be added** (Wave B) — it is the registry's mandated schema lib and is not yet a dependency.

> **Source of truth (all on `main` @ 5ccd2b1):** the handoff doc (waves/scope/DoD), `2026-06-03-execution-plan-subagents.md` (per-task TDD), `2026-06-03-unified-tool-registry-tdd-spec.md` (§8 tests, §12 DoD, Appendix A capability matrix). **This plan corrects their stale line anchors** (server.ts grew ~190-258 lines; the keystone partly shipped in `253e9a3`) from a read-only grounding sweep of today's code.

---

## ⚠️ Reconciliation against today's `main` (what changed since the specs were authored)

The spec/exec-plan/handoff cite lines from `@a977724`; HEAD is `5ccd2b1`. **Navigate by symbol, never by the spec's cited line.** Verified corrections:

| Spec said | Reality on `main` @ 5ccd2b1 |
|---|---|
| restart hack `server.ts:871-873` (`if tool_preset==="Claude Code"`) is open KS work | **GONE** — `253e9a3` replaced it with `normalizePreset()`+`presetCommand()` (now `server.ts:875-878`) |
| voice `create_pane` (`~2524`) passes a free-form `command` | **DONE** — handler at `2732-2769` derives `command` server-side; tool decl `3620-3646` dropped the `command` field, added `tool_preset` enum |
| `buildLaunchCommand` at `terminal.ts:82` | at `terminal.ts:159-175`; owns ONLY `--resume` |
| preset table at `terminal.ts:736` | `presetCommand()` `terminal.ts:129-142`, `PRESET_ID_BY_UNION` `80-84`, `PRESET_FALLBACK_CMD` `87-91` (keyed on preset **`.id`**) |
| `gateOrDefer`/`effectiveCapabilityGateFor`/`redactSecrets` in `src/gateSurface.ts` | **WRONG FILE** — `gateOrDefer` (`server.ts:1670-1730`, **6 args** incl. `requestedMode`), `effectiveCapabilityGateFor` (`server.ts:1628-1640`), `dispatchProposal` (`server.ts:2150-2163`) are **nested closures in server.ts**; `redactSecrets` is in `src/terminal.ts:205` |
| `stopAll` at `~1684` | `server.ts:1790` — **sync** `function stopAll(kill): string[]`, Stage-2 kills are **fire-and-forget** (1826-1834) |
| `onOutput` at `~725`, `broadcast` at `~441` | `730` and `446` |
| `functionDeclarations` `~3137-3592`, dispatch `~2229-3110` | `3395-3856` and `2420-3368` (41 = 41) |

---

## Wave A — Pillar 0 Quick Wins (EXECUTE FIRST; independent of the registry)

**Worktree:** one isolated worktree off `main`. **Parallelism inside the wave:** server.ts QWs share one file → **serialize in a single owner**; QW2 (`ptyTransport.ts`/`terminal.ts`) and H1 (deletes) are file-disjoint → parallel-safe.

**Harness contract (verified — every new test file uses this):**
- Imports: `import { describe, it, before, after } from "node:test"; import assert from "node:assert";` then `WebSocket` from `ws`, `installMockLive`/`waitFor` from `./helpers/mockLive`, `teardownServerSuite` from `./helpers/teardown`, `RunningServer` type from `../server`.
- Boot recipe (lift from `tests/test_stop_all_two_stage.ts` before/after): set `JANUS_NO_AUTOSTART="1"` + `NODE_ENV="test"`; `process.chdir(mkdtempSync(...))` **before** `await import("../server")`; `installMockLive()` **before** `startServer({ port: 0, enableVite: false })`; WS client auth via **cookie** `auth_token=${API_AUTH_TOKEN}` (REST uses `x-api-token` header); `session = await waitFor(() => mock.latest())` after WS open.
- Drive a tool: `const id = session.emitToolCall("name", {args})`; read back `String(await waitFor(() => mock.responseFor(id)))`.
- `StubTerminal` is copy-pasted local (no shared export); register via `(running.manager.terminals as any)[id] = new StubTerminal(id, "Running")`. **Do NOT spawn real PTYs** in unit tests (ConPTY instability) except where unavoidable, and then `await term.stop()`.
- after(): release any freeze (`POST /api/stop-all/release`), revert capability-gate mutations, drain+terminate WS client, `await teardownServerSuite(running)`, `chdir(prevCwd)`, `rmSync(tmpDir)`. **`--test-force-exit` is mandatory.**

### Task A1 — Process-level error net (QW1) · bead `qw1`
**Files:** Modify `server.ts` (install at **module scope ~line 246**, beside `process.once("exit", …)` — NOT inside `startServer` at 4021, to avoid MaxListeners accumulation across in-process test servers). Test: `tests/test_process_safety.ts` (new).
- [ ] Write failing test: `it("an unhandledRejection is logged and does not exit")` + `it("uncaughtException triggers graceful drain, not a bare crash")`. Drive by emitting `process.emit("unhandledRejection", new Error("x"), Promise.resolve())` / `process.emit("uncaughtException", new Error("y"))` against the installed handler; assert the handler ran (spy on a logger or a module-scope counter) and `process.exitCode` was not force-set on a recoverable rejection. Guard against double-install.
- [ ] Run `tsx --test --test-force-exit tests/test_process_safety.ts` → expect FAIL (no handler).
- [ ] GREEN: at module scope add a guarded one-time install of `process.on("uncaughtException")` + `process.on("unhandledRejection")` that (a) structured-log, (b) best-effort flush (the existing `process.once("exit")` already closes the store), (c) do **not** `process.exit()` on a recoverable rejection. Minimal net.
- [ ] Run test → PASS. Confirm existing suites still green.

### Task A2 — Guard PTY spawn (QW2) · bead `qw2` · *(parallel agent — disjoint files)*
**Files:** Modify `src/terminal.ts` (`start()` factory call at **637**; mirror the `onExit` teardown at **690-703**). Optionally `src/ptyTransport.ts` (`pty.spawn` at **113**, factory **293-337**). Test: `tests/test_pty_spawn_guard.ts` (new).
- [ ] Write failing test: `it("a spawn failure surfaces as a clean error, not an uncaught throw")` — construct a `UniversalTerminal` injecting a `transportFactory` (constructor arg #9) that throws; call `start()`; assert no throw escapes, `term.status === "Exited"`, `term.transport === null`, `shellPid === undefined`.
- [ ] Run the new test → FAIL.
- [ ] GREEN: wrap the `this.transportFactory(...)` call in `start()` in try/catch; on failure set `this.transport = null; this.shellPid = undefined; this.status = "Exited"; this.lastStatusChangeAt = Date.now();` (mirror `onExit` teardown — clear probe/idle/readyFallback timers if armed), `console.warn` a reason (like the legacy-fallback warning at `ptyTransport.ts:318-321`, which never throws). Reuse `"Exited"` — there is **no `"Error"` status** (`status: "Running"|"Exited"|"Idle"`, `terminal.ts:333`). Do not leave half-assigned state.
- [ ] Run test → PASS. Happy-path spawn unchanged.

### Task A3 — Gemini session onerror/onclose (QW3) · bead `qw3`
**Files:** Modify `server.ts` — add `onerror`/`onclose` as **siblings of `onmessage`** in the connect callbacks object (insert before the callbacks-closing brace at **~3380**; `onmessage` opens 2266-2267). Mirror the WS-close teardown (3943-3970). Test: `tests/test_session_drop_minimal.ts` (new, uses `mockLive`).
- [ ] Write failing tests: `it("a session error nulls activeLiveSession and detaches approvals")` + `it("a session error notifies the frontend 'voice lost'")`. Stage a pending approval, fire the mock session's error/close, assert `activeLiveSession` nulled, approvals detached (survivors kept), and a `voice_channel_lost` broadcast frame is seen on the WS client.
- [ ] Run → FAIL (no callbacks; no such broadcast type).
- [ ] GREEN: in `onerror`/`onclose`: null `activeLiveSession` **only if `=== session`** (copy the identity guard from 3962 — prevents nulling a newer session); `pendingApprovals.detachSession(session)` (3957) so survivors re-announce via `reannounceSurvivors` on reconnect; `broadcast({ type: "voice_channel_lost", reason })` (new type — none exists). **No reconnect logic** (that's PLM4). Set `wsClosed=true` if gating the resumption-token flush.
- [ ] Run → PASS. (Note for PLM4: token field mismatch — reads `.newHandle` 2275, sends `.token` 3388.)

### Task A4 — Await stop_all Stage-2 kills (QW4) · bead `qw4`
**Files:** Modify `server.ts` `stopAll` (**1790**, Stage-2 loop **1826-1834**). Extend `tests/test_stop_all_two_stage.ts`.
- [ ] Add failing test: `it("stop_all reports only panes that actually stopped")` — register stubs, make one stub's `stop()` reject; drive `confirm_stop_all`; assert the rejecting pane is **not** in `killed` and the failure is surfaced; non-Exited panes flip to `Exited` with `stopCount===1`; already-Exited panes are not re-stopped.
- [ ] Run → FAIL (current code reports the *asked-to-kill* set, fire-and-forget).
- [ ] GREEN: make Stage-2 `await Promise.allSettled(...)` the `term.stop()` calls; build `killed` from **fulfilled** results only; surface rejected ones. Mirror the existing awaited pattern in `close()`/`shutdown` (3993-3999). **Signature impact:** `stopAll` becomes `async`/returns `Promise<string[]>` → update all callers to `await`; accept the broadcast now fires after kills settle (document it). Verify the two-stage REST + voice + WS paths stay green.
- [ ] Run full `test_stop_all_two_stage.ts` → PASS.

### Task A5 — Guard the onOutput chain (QW5) · bead `qw5`
**Files:** Modify `server.ts` `manager.onOutput` (**730**, unguarded chain **733-743**). Test: `tests/test_output_guard.ts` (new).
- [ ] Write failing test: `it("a throw in a pane-signal/history/transition step does not blind the output stream")` — make `paneSignalBus.publish` (or a transition hook) throw once; push two chunks; assert the second chunk is still buffered/broadcast.
- [ ] Run → FAIL.
- [ ] GREEN: wrap each independent step — `classifyPaneOutput`/`paneSignalBus.publish` (736-738), `HistoryManager…appendOutputToLastCommand` (740), `detectAndTriggerTransitions` (743) — in its own try/catch that logs and proceeds; the buffer/broadcast tail (746-765) must still run.
- [ ] Run → PASS.

### Task A6 — Prune broken sockets (QW6) · bead `qw6` · *(smallest; mostly done)*
**Files:** Modify `server.ts` `broadcast` (**446-457**; per-client `send` is **already** in try/catch 452-454). Test: `tests/test_broadcast_prune.ts` (new).
- [ ] Write failing test: `it("a socket that throws on send is removed from the clients set")` — add a fake client to `clients` whose `send` throws; call a broadcast; assert it is removed from `clients`.
- [ ] Run → FAIL (current catch only logs, does not remove).
- [ ] GREEN: in the existing `catch` (453), `clients.delete(client)`. (Optionally also guard `JSON.stringify(msg)` at 447, the one remaining unguarded spot — out of strict scope; note in PR.)
- [ ] Run → PASS.

### Task A7 — Delete dead Python + fix docs (H1) · bead `h1` · *(parallel agent — disjoint files)*
**Files:** Delete `universal_terminal.py`, `tests/test_universal_terminal.py`. Edit `CLAUDE.md` (remove line **80** `py -3 -m unittest tests.test_universal_terminal`; trim the orphaned `py -3` clause in the gotcha at **85** — keep the `--test-force-exit` gotcha at 84). Edit `README.md` (remove the two file-tree entries at **84-85**).
- [ ] N/A RED (deletion). Grep the repo for `universal_terminal` — confirm the only **code** importer is the deleted test (line 10); remaining hits are historical docs/specs/beads (leave them). The runtime `UniversalTerminal` class (`src/terminal.ts`) + camelCase `stripAnsiSequences` are unrelated — **do not touch**.
- [ ] Delete the two files; edit CLAUDE.md + README.md.
- [ ] `npm run lint` + `npm run build` green; `grep universal_terminal` shows only historical prose. No `package.json`/CI change (the `.py` was never in `tests/*.ts`).

**Wave A exit gate:** all new tests + extended `test_stop_all_two_stage.ts` green; full battery (`npm run lint` → `npm run test:unit` → `npm run build`) green; per-QW commits in the worktree. **STOP — review + merge to main before Wave B.**

---

## Wave B — Keystone (KS) · beads `ks` (dep `qw2`) — **RE-SCOPED** (much already shipped in `253e9a3`)

Already done (do **not** redo): restart-hack removal, voice `create_pane` server-side derivation, the single preset→command home `presetCommand()` (the spec's `resolveLaunch`), restart-restore reuse, `tests/test_preset_command.ts`.

**Remaining KS work:**
- [ ] **B0 — characterization goldens** from `main` for the §8.5 representative set + `create_pane` resolved launch (the no-behavior-change oracle for KS+REG1).
- [ ] **B1 — `npm install zod`** (commit the lockfile change); the registry's schema lib. *(First concrete REG dependency; do it here.)*
- [ ] **B2 — REST `POST /api/terminals` derivation (the 17d headline gap):** route the REST handler (`server.ts:807-851`, still requires a client `command` at 809) through the **same** `presetCommand(normalizePreset(toolPreset), …)` derivation the voice path uses, so **voice ≡ REST** produce an identical launch (test 17d). Preserve the cwd fallback (816-824, validate → active project dir → `process.cwd()` = test 17e).
- [ ] **B3 — recipe-apply derivation:** route `apply_orchestration_recipe` per-pane launches (`server.ts:1449` REST + voice twin ~2917, currently hardcoded `bareShell` + `p.preset as any`) through the same home (spec §5.4 "Generalizes").
- [ ] **B4 — env-hygiene characterization (17f):** pin `UniversalTerminal.start()` env hygiene (`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` stripped, `--dangerously-skip-permissions` per `permissions_mode`).
- [ ] **B5 — naming/test reconciliation:** spec §8.3b references `resolveLaunch` + `tests/test_action_create_pane.ts`; reality is `presetCommand`/`normalizePreset` + `tests/test_preset_command.ts`. Add the §8.3b acceptance cases (17a-17f) **against the existing functions** — do not duplicate.
- [ ] **🔶 DECISION (17c Custom command):** `253e9a3` dropped the `command` field entirely from voice `create_pane`, so a `Custom` pane can't be told to run `htop` by voice. Spec §5.4/17c wants `command` to survive **for `Custom` only** (zod `.refine`). **Restore Custom-only command, or accept the drop?** — raise with operator before B2.

**Wave B exit gate:** voice ≡ REST launch parity enforced by a permanent test (17d); recipe paths on the one home; §8.3b green; characterization goldens equal `main`; full battery + `smoke:claude`. **STOP — review + merge.**

---

## Wave C — Full registry Phase 1 (REG1) · bead `reg1` (dep `ks`) — the large single-owner refactor

Migrate the 41 tools into one `ActionDef` surface and flip the dispatch. **Do not parallelize across agents** (one rewrite of the server.ts dispatch surface). Same worktree continues from Wave B.

- [ ] **C1 — scaffolding + migrate:** create `src/actions/{types,registry,gemini,rest,coverage}.ts` (+ `capabilities.ts` for the `CapabilityDef` table). Move each of the 41 dispatch branches (2420-3368) into an `ActionDef.handler` (logic **moved**, not rewritten) with its zod schema, capability (Appendix A), `readOnly`, `surfaces`. **Inject** `gateOrDefer`/`dispatchProposal`/`redactSecrets`/`broadcast` via `ActionContext` — they are nested closures over server state and **cannot be lifted**; the handler calls them, never reimplements them. Tools (41) and capabilities (16) are **distinct namespaces** — do not auto-derive one from the other. Tests: spec §8.1, §8.1b (matrix derived), §8.2 (Gemini gen + golden), §8.3 (gate/redaction/error-once), §8.3b, §8.4 (coverage), §8.5 (characterization).
- [ ] **C2 — swap dispatch + REST + audit seam:** replace the `functionDeclarations: […]` literal (3395-3856) with `toGeminiDeclarations(registry)`; replace the `if (name===…)` chain (2420-3368) with `runAction(name,args,ctx)` + `resultToToolResponse(result,session,call.id)` — **preserving the single try/catch wrapper (try 2419 / catch 3369) that answers `call.id` exactly once**, and each branch's exact response shapes (esp. `propose_command`'s 3-way pending/clarify/output). Mount registry-backed REST via `mountRestRoutes`. Add the **`action_log` table** as a forward-only **v6 migration** in `src/store/schema.ts` (bump `SCHEMA_VERSION=6`); `runAction` appends one redacted row per action (`if(store)`-guarded). Delete the regex parity guard (`test_voice_tools.ts:324-356`); assert against runtime `session.params.config.tools[0].functionDeclarations` instead (§8.2 #6) — never re-scrape source.
- [ ] **C3 — coverage + battery + follow-ups:** derive `ALL_CAPABILITIES` from the registry; export `SPOTLIGHT_CAPABILITIES` (currently module-private `gateSurface.ts:45`); seed the coverage allow-list with **every** current asymmetry (§4.2); `npm run catalog` ⇒ no diff vs committed `docs/CAPABILITIES.md` (§8.4 #20a — add the script). Full §12 Phase-1 DoD battery. Confirm CV/REG2/RES/DBT backlog beads exist.

**Wave C exit gate = registry-spec §12 Phase-1 DoD in full:** no `if (name===…)` tool chain remains; regex guard gone; allow-list = every current asymmetry; **no tool gained/lost a surface**; goldens equal `main`. **STOP — review + merge.**

---

## Wave D — Registry plumbing (PLM1-5) · beads `plm1-5` (dep `reg1`) — the choke-point payoff

PLM1/PLM2/PLM3 are independent (parallel-safe in their own worktrees off the merged registry); PLM4 then PLM5 (dep PLM2).

- [ ] **D1 — PLM1 per-action timeout** (`src/actions/gemini.ts` `runAction`; optional `ActionDef.timeoutMs`): `Promise.race` the handler against a deadline; over-deadline → `{kind:"error"}` answered once; `ALWAYS_ALLOWED` brake exempt; realtime never blocks. Test `tests/test_action_timeout.ts`.
- [ ] **D2 — PLM2 action-log view**: new `get_action_log` read action (readOnly, `read_pane`/Auto) querying `action_log` (copy the `pending_actions` helper seam on `JanusStore`, `sqliteStore.ts:244-266`); `mountRestRoutes` auto-exposes `GET /api/action-log`; minimal `src/App.tsx` panel. Rows redacted, filterable by pane/capability/outcome, carry `gateDisposition`+`ms`. Test `tests/test_action_log_view.ts`.
- [ ] **D3 — PLM3 durable-closure version guard**: stamp `{actionName, schemaHash}` into the persisted `PendingAction.params` (**zero schema change** — `add()` already JSON-serializes params, `pendingActions.ts:102-122`); in `buildActionRun` (`actionEffects.ts:92-187`) add a guard **before** the switch that returns a **no-op** `run()` (explanatory string) on missing-capability/hash-mismatch — **never throw** (the boot hydration loop `server.ts:1581-1601` has no per-row try; the never-throw `default:` arm is the contract to match). Test `tests/test_durable_action_version.ts`.
- [ ] **D4 — PLM4 session reconnect + idempotency** (builds on QW3 `onerror`/`onclose`): persist the resumption token (mind the `.newHandle` vs `.token` field mismatch, 2275/3388); reconnect with backoff on close; idempotency key `(surface+actor+name+argsHash)` recorded in `action_log` so a replay is detected (never double-apply); reuse `reannounceSurvivors` (`server.ts:1886-1919`) on the new session — this is the **Janus survivor digest**, distinct from the Gemini SDK token path. Test `tests/test_session_reconnect.ts`.
- [ ] **D5 — PLM5 health/counters strip** (dep PLM2): new `get_health` read action aggregating session state + pane counts + pending count + recent error-rate from `action_log`; small always-visible `src/App.tsx` strip. Test `tests/test_health.ts`.

**Wave D exit gate = handoff §5 DoD:** audit log visible, per-action timeout live, durable rehydrate version-guarded, session reconnect working, health strip rendering.

---

## Backlog (filed as beads, do NOT start): CV1-3, RES2/3/5/6, DBT1-4, REG2. A thin rate-limit hook at the `runAction` seam is the noted next add.

## Self-review notes
- Every Wave A QW maps to a task with verified anchors + a test. QW6 confirmed largely-done (only `clients.delete` remains). QW1 module-scope install resolves the MaxListeners hazard.
- KS re-scoped to the genuinely-remaining surfaces (REST/recipe) + the 17c product decision — not the already-shipped voice/restart derivation.
- REG1 risks captured: nested-closure injection, 41≠16 namespaces, single try/catch invariant, exact per-branch response shapes, regex-guard replacement.
- Wave D anchors verified: forward-only v6 migration, stamp-into-params, never-throw quarantine, survivor-digest vs SDK-token separation, `if(store)` guards.
