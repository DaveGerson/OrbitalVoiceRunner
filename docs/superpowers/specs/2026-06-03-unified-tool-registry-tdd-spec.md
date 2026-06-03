# Unified Tool Registry — One Action Surface for Gemini Live **and** the UI

- **Bead:** _(to file)_ `unified-action-registry` — "Single source of truth for tools/functions shared by Gemini Live + REST/WS UI"
- **Date:** 2026-06-03
- **Status:** Design / TDD — open questions resolved 2026-06-03 (see "Decisions" below); spec only, no production code in this pass.
- **Author context:** requested by operator — "all relevant tools Gemini Live uses should be 1:1 matched with the function calls and tools the backend uses, so Gemini and the UI work off the same set of functions… we only have to touch one path to make updates."
- **Depends on (all ✓ today):** `nzt` (SQLite ledger / `JanusStore`), `odb` (deferred staging), `8sq` (capability-matrix surface + `gateSurface.ts`), `alf` (handoff flip)
- **Blocks / enables:** future tool growth (every new capability becomes a single registry entry instead of 4 hand-edits), a Python tool-catalog authority (§6 Phase 2)

### Decisions (locked 2026-06-03)

1. **Python trajectory = catalog + codegen (Phase 2).** Python (Pydantic) becomes the authoring source of truth for tool definitions; a build step generates the Gemini declarations + a TS binding table. **Execution stays in TS.** No full Python execution backend (Option B) is planned now.
2. **Everything lives in this one repo and is committed together.** Generated files (`catalog.generated.ts`, `gemini.tools.json`) are *committed* alongside hand-written code — they are ordinary emitted source, not a separate service. A no-drift test (§8.6) guards staleness. There is no second server.
3. **Register-as-is first, then converge piecemeal.** Phase 1 wraps **every existing tool** into the registry with **no surface changes** — all current asymmetries (§4.2) are recorded in the allow-list. Surface convergence (giving a tool its missing voice/REST/WS twin) happens **afterward, one small phase per tool group** (§7 Convergence track), each gated by a **parity-cutover test** that proves the new surface behaves identically to the existing one *before* the UI is pointed at it.
4. **Params schema = `zod`.** One zod schema per tool serves both runtime validation and Gemini schema generation; the hand-maintained JSON params are retired.
5. **The registry IS the capability matrix (like-for-like security).** Every action carries a **mandatory** capability and its gate is **encapsulated** in the action (enforced centrally by `runAction`, never re-implemented per surface). The set of capabilities is **derived from the registry**, not a hand-maintained list — so the matrix *grows with the catalog*, and previously-ungated actions (`switch_active_pane`, `update_draft_prompt`, handoff draft/stage steps, reads) become first-class, individually-tunable matrix entries. `gateSurface.ts`'s hand-listed `ALL_CAPABILITIES` / labels / categories become **generated from the registry**. See §5.0.
6. **Behavior-preserving defaults.** Making a currently-ungated action a capability does **not** change what happens today: each new capability **defaults to the gate that matches its current effective behavior** — Auto for everything currently ungated, **including reads** (`read_pane`/`read_notes` default **Auto**). The *new ability* is that you can now tune any of them. Net: Phase 1 adds tunability, not new friction. Read-gating's purpose is covered in §5.5.
7. **Mechanics in the handler, intent in the schema (the keystone, §3.1).** Deterministic, environment-sensitive logic (e.g. preset→launch-command derivation) lives **once**, in the action handler or the domain layer it calls — never in the model and never duplicated per surface. Action schemas express **intent** and act as **guardrails** that make wrong inputs unrepresentable (the model picks `tool_preset`, it does not author a launch string). A deterministic fix is then applied in exactly one place.

---

## 1. BLUF

Today a "tool" is defined **up to four times**:

1. a Gemini `FunctionDeclaration` (name + description + JSON-ish params) — `server.ts` ~L3137–3592,
2. an `if (name === "X")` **dispatch handler** inside the live `onmessage` callback — `server.ts` ~L2229–3110,
3. a hand-written **REST route** (`app.post("/api/…")`) — `server.ts`, 55 routes,
4. an ad-hoc **WS message** handler + the client call that sends it — `server.ts` + `src/App.tsx`.

Each path re-parses args, re-applies (or forgets) the capability gate, re-does (or forgets) secret redaction, and re-shapes the response. The only thing keeping voice paths #1 and #2 honest is a **regex that scrapes `server.ts` source** (`tests/test_voice_tools.ts` "parity guard"). Paths #3/#4 have already **drifted** from #1/#2 (see §4 inventory).

**This spec defines a single `ActionRegistry`: one canonical `ActionDef` per operation — name, params schema, capability gate, redaction policy, surfaces, and one handler.** Every surface is then *derived* from it:

- Gemini `functionDeclarations` are **generated** from the registry (no hand-list).
- The Gemini tool-call dispatch becomes **one generic loop** (`runAction(name, args, ctx)`), not 41 branches.
- REST + WS endpoints become **thin adapters** that call the same `runAction`.
- The brittle regex parity test is replaced by **structural** tests over the registry.

Net: to add or change a tool you edit **one entry**, and Gemini + the UI move together by construction.

### 1.1 North Star — from vibe-coded to dependable (three pillars)

The real objective beyond DRY wiring: take this from a *works-in-the-demo* prototype into a tool that is **trustworthy enough to sit in the operator's daily critical developer workflow.** Dependability does not come from features — it comes from a **small number of choke-points you can trust, test, and reason about.** Today the app has the opposite (the same operation implemented 2–4 times, safety one surface can bypass, launch logic the model re-invents) — the vibe-coded signature: it runs, but you can't depend on it because any given path might be the unfixed one.

The path is **three pillars, sequenced so each makes the next cheap**:

- **Pillar 1 — One trustworthy surface (this spec).** The `runAction` registry: one definition, one gate, one redaction, one result shape per action. This is the foundation; the other two pillars bolt onto its single choke-point.
- **Pillar 2 — Resilience / known failure modes (next bead — §13).** A specified, tested recovery story for the things that actually bite a daily driver: Gemini Live session drop mid-task, a pane PTY dying, a server restart with work in flight.
- **Pillar 3 — Observability you can see (later bead — §13).** Surfacing the audit trail and health, not just logging it.

**Latent wins of the single choke-point (Pillar 1 unlocks these almost for free — see §5.6):** a complete **audit trail** of every action Janus took to your work (trigger, args, gate decision, result); **metrics** (per-action counts/latency/failure); **uniform failure handling** (one try/catch, one error shape, instead of 41 hand-guarded branches that can each forget); and a natural home for **rate-limiting / circuit-breaking** a runaway model. These are impossible to do reliably across four scattered paths and trivial with one — which is *why* the registry is the right first investment toward dependability, not just toward tidiness.

**Governing constraints inherited from the codebase (do not regress):**
- The capability-gate matrix stays the single choke-point (`gateOrDefer` / `effectiveCapabilityGateFor`); the registry routes *through* it, it does not replace it.
- Secret redaction (`redactSecrets`) stays mandatory on every model-bound read.
- The emergency brake (`stop_all` / `confirm_stop_all` / `release_stop_all`) stays **always-allowed**, bypassing the gate.
- Every Gemini tool call is still answered **exactly once** via `session.sendToolResponse({...call.id...})` — non-blocking for pending approvals (WS-E.1 / BUG-001).

## 2. Goals & Non-Goals

### Goals
- **G1 — One definition per tool.** A tool's name, schema, gate, redaction, and handler live in exactly one place.
- **G2 — Generated Gemini surface.** `functionDeclarations` and the dispatch are produced from the registry; they cannot drift from each other or from the handlers.
- **G3 — Shared execution for the UI.** REST/WS handlers for registry-backed actions call the same handler the voice path does (same gate, same redaction, same result shape).
- **G4 — Structural parity tests.** Replace source-scraping regex with set/shape assertions over the registry (and a golden snapshot of the emitted Gemini schema).
- **G5 — Convergence path for drift.** A clear, enforced way to see which actions are missing from which surface, and to close the gap.
- **G6 — A credible Python trajectory.** The design must let the *catalog* (and later, *execution*) move to Python without re-litigating the architecture (operator's stated direction — §7).
- **G7 — Operational leverage from one choke-point (Pillar 1 payoff).** `runAction` is the single home for the audit trail, metrics, uniform error handling, and rate-limiting that make the tool dependable (§5.6). Phase 1 lands the *seam*; surfacing (Pillar 3) is later.

### Non-Goals (this pass)
- **NG1 — No behavior change.** This is a refactor to a registry; each tool must behave identically (characterization-tested). New tools are out of scope.
- **NG2 — No PTY / ledger / gate re-platform.** node-pty, `better-sqlite3`/`JanusStore`, and the gate resolver stay where they are.
- **NG3 — No Python execution backend *yet*.** §7 evaluates it and Phase 3 specs the seam; building it is a separate, later bead.
- **NG4 — Spec only in this pass.** No production code lands now (operator chose "spec doc only"). The TDD section is the contract the implementation bead will satisfy.

## 3. The pain, concretely

Adding one capability today touches, in `server.ts` alone:
- the `functionDeclarations` array (declare it for Gemini),
- the `onmessage` `if/else` chain (dispatch it),
- a REST route + its body (so the UI button can do it),
- often a WS broadcast + a `src/App.tsx` branch.

Four edits, four chances to forget the gate or the redaction, and a regex test that only checks #1 vs #2 — by **string-matching the source file** (`src.indexOf("functionDeclarations: [")`, `matchAll(/name === "…"/g)`). That test breaks if someone reformats the file, and it says nothing about REST/WS parity, the params schema, the gate, or redaction.

### 3.1 Keystone example — terminal bring-up (why this is about *behavior*, not just wiring)

The motivating bug: the **UI** path was fixed to spin up Claude panes correctly, but **Janus keeps creating them wrong** — inferring the wrong environment, reaching for root `bash`, sending `npx @anthropic-ai/claude` instead of the bare `claude`. The fix never reached the voice path because the two paths are **separate implementations of the same behavior**. Concretely, *three* places independently "know" how to launch a pane, and the model is one of them:

| Who | How it gets the launch command | Source |
|---|---|---|
| `addTerminal()` / `UniversalTerminal` | **Does not derive it** — runs whatever `command` string it's handed | `src/terminal.ts:872`, `:254` |
| UI (`POST /api/terminals`) | Client already mapped preset→binary; sends `command:"claude"` | `server.ts:802` |
| Restart (`POST …/restart`) | Its **own** hardcoded map (`Claude Code → claude`, "WS-G quick win") | `server.ts:848` |
| **Janus (`create_pane` tool)** | The **model invents** a free-form `command` (schema: *"The command line string to run"*) → guesses wrong | `server.ts:2524`, decl `:3363` |

The genuinely-shared env logic — stripping `CLAUDECODE` nesting markers, the `--dangerously-skip-permissions` flag, the `--resume` UUID guard — already lives in `UniversalTerminal.start()` and works for every caller. **The one thing not shared is preset→command derivation**, and that is exactly what the model is doing badly.

**The registry fixes this two ways (both specced below):**
1. **Mechanics move into the shared handler / domain layer (Decision 7).** Preset→command derivation is pushed down into `addTerminal` against the authoritative `presets` list (`terminal.ts:736`). The UI's client-side mapping and the restart handler's hardcoded map both **collapse into that one home**; a fix lands once and every surface inherits it.
2. **The schema becomes a guardrail.** Janus's `create_pane` takes **intent** (`tool_preset` + project/cwd), not a free-form `command`. For a non-`Custom` preset the model literally **cannot** supply a launch string — the wrong input is *unrepresentable*. Free-form `command` survives only for `Custom`. See §5.4.

This is the whole thesis in one example: **one definition + one implementation of the deterministic behavior** means deterministic fixes never have to be re-applied per surface.

## 4. Current-state inventory (authoritative)

### 4.1 Voice surface — 41 tools, parity holds today (#1 ≡ #2)

`list_panes, propose_command, switch_active_pane, update_draft_prompt, list_pending_approvals, get_pane_command_history, get_pane_summary, get_pane_delta, switch_context, add_project_note, add_pane_note, get_project_notes, search_notes, amend_note, delete_note, rename_project, rename_pane, get_attention_digest, dismiss_attention, create_project, create_pane, set_global_permissions, set_voice_mute, create_orchestrator_plan, execute_plan, apply_orchestration_recipe, handoff_context_between_panes, set_pane_permissions, propose_handoff, revise_handoff, stage_handoff, deliver_handoff, read_handoff, list_handoffs, reject_handoff, set_capability_gate, get_pane_gates, list_capabilities, stop_all, confirm_stop_all, release_stop_all`

### 4.2 Voice ⇄ REST correspondence (the drift map, expanded)

Read-verified from source (server.ts dispatch ~2229–3109, REST routes, `src/App.tsx` ~1194–1310, `src/eventBus.ts`). Columns: **what** the step performs (+ core backend call), the **broadcast → UI impact** (what the operator sees change), **where the code lives today** (voice handler ↔ REST/WS twin), and the **drift** status. The "UI impact" cites the broadcast; the broadcast→handler legend is at the end of this section so it isn't repeated per row.

#### Group 1 — Reads / orientation (no mutation; spoken read-back only)
| Voice tool | What it does (core call) | Broadcast → UI impact | Voice handler | REST/WS twin | Drift |
|---|---|---|---|---|---|
| `list_panes` | All projects/panes w/ status, timing, last cmd (`manager.listPanes()`) | none → voice read-back only | `server.ts:2229–2233` | `GET /api/terminals` :771; `GET /api/ledger` :797 | both, shapes differ |
| `get_pane_command_history` | Recent commands + outcomes for a pane (`HistoryManager.loadHistory()`) | none → read-back | `:2234–2256` | `GET /api/terminals/:id/history` :936 | both |
| `get_pane_summary` | Last ~20 lines, ANSI-stripped + redacted (`manager.getPaneSummary()`) | none → read-back | `:2257–2262` | _none (UI reads stdout stream)_ | **voice-only** |
| `get_pane_delta` | New output since last read, per-pane cursor (`manager.getPaneDelta()`) | none → read-back | `:2263–2268` | _none_ | **voice-only** |

#### Group 2 — Direct work (route operator intent into a pane)
| Voice tool | What it does (core call) | Broadcast → UI impact | Voice handler | REST/WS twin | Drift |
|---|---|---|---|---|---|
| `propose_command` | Distilled instruction/shell → active pane **through the gate** (`dispatchProposal()`) | `approval_pending` / `command_auto_executed` / `command_blocked` → approval dialog OR auto-exec/blocked toast | `:2281–2304` | `POST /api/terminals/:id/input` :897 | both, **gate logic duplicated** |
| `switch_active_pane` | Change which pane is open; no exec (`activePaneId=…` + broadcast) | `switch_active_pane` → pane view switches | `:2305–2324` | _WS only (no REST)_ | **voice/WS only** |
| `update_draft_prompt` | Compose/refine WIP draft, replace\|append (`ledger.setDraft/appendDraft()`) | `draft_updated` → draft box refreshes | `:2325–2342` | `PUT /api/panes/:p/:id/draft` :1436 | both |
| `list_pending_approvals` | Recall commands awaiting approval (`pendingApprovals.forSession()`) | none → read-back | `:2343–2356` | `GET /api/commands/pending` :1860 | both |
| `switch_context` | Make a project active + briefing (`ledger.switchContext()` + `saveSettings()`) | `ledger_updated` → project/pane tree updates | `:2269–2280` | `POST /api/projects/:id/switch` :1107 | both |

#### Group 3 — Spawn / create
| Voice tool | What it does (core call) | Broadcast → UI impact | Voice handler | REST/WS twin | Drift |
|---|---|---|---|---|---|
| `create_pane` | Spawn pane in project (gated) (`manager.addTerminal()`) | `action_pending`(Ask) / `ledger_updated` / `terminals_updated` → action dialog OR new pane in tree | `:2524–2550` | `POST /api/terminals` :802 | both — **the §3.1 keystone divergence** |
| `create_project` | New project context (`ledger.addProject()`) | `ledger_updated` → tree updates | `:2517–2523` | `POST /api/projects` :950 | both |
| `create_orchestrator_plan` | Draft multi-pane plan (`ledger.plans.push()`) | `plans_updated` → plans sidebar updates | `:2584–2605` | `POST /api/plans` :1305 | both |
| `execute_plan` | Run first step of a plan (`dispatchProposal()` for step) | `approval_pending`(HiTL) / `plans_updated` / `plan_step_completed` → plan-exec UI | `:2606–2650` | `POST /api/plans/:id/execute` :1331 | both |
| `apply_orchestration_recipe` | Spawn template layout, per-pane `create_pane`-gated (`manager.addTerminal()` ×N) | `ledger_updated` / `terminals_updated` → panes appear | `:2651–2696` | `POST /api/recipes/apply` :1375 | both |

#### Group 4 — Handoffs (move context between agents)
| Voice tool | What it does (core call) | Broadcast → UI impact | Voice handler | REST/WS twin | Drift |
|---|---|---|---|---|---|
| `handoff_context_between_panes` | Write context into target pane's model-context, not a CLI write (`ledger.addModelContext()`) | `ledger_updated` → tree updates | `:2697–2723` | `POST /api/handoff` :1406 | both |
| `propose_handoff` | Draft handoff, snapshot source, state `composing` (`store.createHandoff()`) | `handoffs_updated` → handoff editor modal | `:2724–2773` | _none_ | **voice-only** |
| `revise_handoff` | Rewrite prompt, ++revision (`store.updateHandoffCargo()`) | `handoffs_updated` → editor updates | `:2774–2797` | _none_ | **voice-only** |
| `stage_handoff` | Freeze text, pre-check target, secret-scan, → `staged` (`store.updateHandoffState()`) | `handoffs_updated` → shows staged | `:2798–2841` | _none_ | **voice-only** |
| `deliver_handoff` | Write staged handoff to target pane (**double-gated** `deliver_handoff`+`write_to_pane`) (`dispatchProposal()`) | `approval_pending`(HiTL) / `handoffs_updated` → approval dialog OR delivered | `:2906–2959` | _none_ | **voice-only** |
| `read_handoff` | Retrieve one handoff, redacted (`store.getHandoff()`) | none → read-back | `:2842–2859` | _none_ | **voice-only** |
| `list_handoffs` | List handoffs by state + staleness (`store.listHandoffs()`) | none → read-back | `:2860–2882` | _none_ | **voice-only** |
| `reject_handoff` | Cancel; if pending at gate, route through reject (`applyResolution()` / `updateHandoffState()`) | `handoffs_updated` → removed/marked rejected | `:2883–2905` | _none_ | **voice-only** |

#### Group 5 — Notes / metadata
| Voice tool | What it does (core call) | Broadcast → UI impact | Voice handler | REST/WS twin | Drift |
|---|---|---|---|---|---|
| `add_project_note` | Note onto project (`ledger.addNote()`) | `ledger_updated` → sidebar notes | `:2357–2362` | `POST /api/projects/:id/notes` :985 | both |
| `add_pane_note` | Note onto pane (default active) (`ledger.addPaneNote()`) | `ledger_updated` → sidebar | `:2363–2378` | `POST …/panes/:id/notes` :1024 | both |
| `get_project_notes` | Recall notes, redacted (`ledger.getNotes()`) | none → read-back | `:2379–2391` | `GET /api/projects/:id/notes` :996 | both |
| `search_notes` | Full-text note search, redacted (`ledger.search()`) | none → read-back | `:2392–2405` | _none_ | **voice-only** |
| `amend_note` | Edit note (gated `update_metadata`) (`gateOrDefer()` + `ledger.amendNote()`) | `action_pending`(Ask) / `ledger_updated` → dialog OR note updates | `:2406–2422` | `PUT /api/notes/:id` :1003 | both |
| `delete_note` | Delete note (gated `update_metadata`) (`gateOrDefer()` + `ledger.deleteNote()`) | `action_pending`(Ask) / `ledger_updated` → dialog OR removed | `:2423–2436` | `DELETE /api/notes/:id` :1011 | both |
| `rename_project` | Rename project (`ledger.renameProject()`) | `ledger_updated` → name in tree | `:2437–2442` | `PUT /api/projects/:id/rename` :978 | both |
| `rename_pane` | Rename pane (`ledger.renamePane()`) | `ledger_updated` → name in tree | `:2443–2448` | `PUT …/panes/:id/rename` :1017 | both |

#### Group 6 — Attention queue
| Voice tool | What it does (core call) | Broadcast → UI impact | Voice handler | REST/WS twin | Drift |
|---|---|---|---|---|---|
| `get_attention_digest` | Merge unread alerts + pending approvals (`pruneAttention()` + `attentionQueue` + `forSession()`) | none → read-back | `:2449–2492` | `GET /api/attention` :1241 | both, shapes differ |
| `dismiss_attention` | Dismiss item by id (or all) (`item.dismissed=true` + `pruneAttention()`) | `attention_updated` → items disappear | `:2493–2516` | `POST /api/attention/:id/dismiss` :1245; `/clear` :1256 | both |

#### Group 7 — Safety / permissions / gates
| Voice tool | What it does (core call) | Broadcast → UI impact | Voice handler | REST/WS twin | Drift |
|---|---|---|---|---|---|
| `set_global_permissions` | Set global mode, gated (`gateOrDefer()` + `globalPermissionsMode=…`) | `action_pending`(Ask) / `settings_updated` → dialog OR settings modal | `:2551–2572` | `PUT /api/settings` :1472 | both, indirect |
| `set_pane_permissions` | Set per-pane mode, gated (`gateOrDefer()` + `term.setPermissionsMode()`) | `action_pending`(Ask) / `ledger_updated` / `terminals_updated` → dialog OR pane chips | `:3074–3109` | `PUT …/panes/:id/permissions` :1044 | both |
| `set_capability_gate` | Set a gate Auto/Ask/Off, global or per-pane; **voice may only tighten** (`isLoosening()` guard + `settings.advanced.capabilityGates` / `pane.capabilityGates`) | `settings_updated` → settings modal | `:2960–3006` | `PUT …/panes/:id/capability-gates` :1071 | both, shapes differ |
| `get_pane_gates` | Read effective gates for a pane/global (`effectiveCapabilityGateFor()`) | none → read-back | `:3007–3020` | _part of `terminals_updated` payload_ | **voice-only** |
| `list_capabilities` | List gatable capabilities (**hardcoded list** today) | none → read-back | `:3021–3030` | _static `gateSurface.ALL_CAPABILITIES`_ | **voice-only** (Decision 5 makes this derived) |
| `set_voice_mute` | Toggle mic mute (`settings.voiceAi.isMicMuted=…` + `saveSettings()`) | `settings_updated` → settings modal shows muted | `:2573–2583` | `PUT /api/settings` :1472 | both, indirect |

#### Group 8 — Emergency brake (always allowed; the wired-identically template)
| Voice tool | What it does (core call) | Broadcast → UI impact | Voice handler | REST/WS twin | Drift |
|---|---|---|---|---|---|
| `stop_all` | Stage 1: freeze Janus + cancel in-flight; panes keep running (`stopAll(false)`) | `frozen` → FROZEN banner, gates→Off | `:3031–3043` | `POST /api/stop-all` :879 (+ `GET /status` :876) | both ✓ |
| `confirm_stop_all` | Stage 2: kill running PTYs, irreversible (`stopAll(true)` + `term.stop()`) | `stop_all` → panes → Exited | `:3044–3060` | `POST /api/stop-all/confirm` :883 | both ✓ |
| `release_stop_all` | Un-freeze; gates restore exactly; killed panes stay killed (`releaseStopAll()`) | `frozen` → banner disappears | `:3061–3073` | `POST /api/stop-all/release` :891 | both ✓ |

#### REST/WS-only (no voice tool today — C3 convergence adds voice twins)
| What | Route | UI impact | Drift |
|---|---|---|---|
| Resize PTY grid | `POST /api/terminals/:id/resize` :918 | pane reflows | **REST-only** (stays — pure viewport, §5.4) |
| Clear pane history | `POST /api/terminals/:id/history/clear` :943 | `history_updated` → history panel clears | **REST-only** → `clear_history` voice (C3, Ask) |
| Archive exited panes | `POST /api/terminals/clear-exited` :1161; `GET/POST/DELETE /api/archive…` :1179/1191/1203 | tree prunes exited panes | **REST-only** → `archive_pane` voice (C3, Auto) |
| Close / restart a pane | `DELETE …/panes/:paneId` :1141; `POST /api/terminals/:id/restart` :835 | pane removed / restarts (note: restart has its **own** preset→cmd map :848) | **REST-only** → `close_pane`/`restart_pane` voice (C3, Ask) |
| Watch-rule CRUD | `GET/POST/DELETE /api/watch-rules…` :1263/1267/1288 | `watch_rules_updated` → watch-rules panel | **REST-only** → `add_watch_rule` voice (C3, Ask) |
| Add layered pane context | `POST …/panes/:paneId/context` :1033 | `ledger_updated` → tree | **REST-only** (folds into `update_metadata`) |

**Broadcast → UI legend** (one place; rows above reference these `type`s):

| Broadcast `type` | `App.tsx` / `eventBus.ts` | What the operator sees |
|---|---|---|
| `approval_pending` | App.tsx 1198–1209 | command approval dialog + alert earcon |
| `action_pending` / `action_resolved` | 1210–1220 | deferred-action confirm dialog appears / clears |
| `switch_active_pane` | 1221–1224 | open pane switches |
| `draft_updated` | 1225–1237 | draft box refreshes |
| `terminals_updated` | 1238–1240 | pane posture chips repaint (status + effective gates) |
| `frozen` / `stop_all` | 1240–1250 | FROZEN banner + gates→Off / panes → Exited |
| `ledger_updated` | 1251–1252 | project/pane tree, notes, names update |
| `settings_updated` | 1253–1267 | settings modal (mode, gates, mute) updates |
| `command_auto_executed` / `command_blocked` | 1268–1278 | "auto-approved" / "blocked (Read-Only)" toast |
| `stdout_chunk` | 1279–1280 | live terminal output |
| `transcript_text` | 1281–1285 | chat transcript panel |
| `attention_updated` / `plans_updated` / `watch_rules_updated` / `plan_step_completed` etc. | eventBus.ts 32–52 | attention panel / plans sidebar / watch-rules panel + earcons |
| `handoffs_updated` | App state setter | handoff editor/queue updates |

**Reading:** the `stop_all` family is the *only* group wired identically across voice + REST + WS today (`8sq` built it that way, with a real test). Everything else either duplicates logic across two paths (`propose_command`, `create_pane`, the gated metadata/permission tools) or is single-surface (all of Group 4 handoffs and the content reads are voice-only; the housekeeping rows are REST-only). The registry generalizes the `stop_all` template to all ~50 operations.

### 4.3 The gate matrix today (the 16 hand-listed capabilities)

From `src/gateSurface.ts` / `src/types.ts`: `write_to_pane, deliver_handoff, create_pane, close_pane, restart_pane, set_pane_permissions, set_global_permissions, set_capability_gate, add_watch_rule, execute_plan, apply_recipe, create_project, update_metadata, switch_context, set_voice_mute, dismiss_attention`.

This list is **hand-maintained** and does **not** cover every action: reads, `switch_active_pane`, `update_draft_prompt`, and the handoff draft/stage steps are ungated (no row). Decision 5 makes this list a **derived projection of the registry** instead, and promotes those ungated actions to first-class capabilities (defaulting Auto, Decision 6). The expanded set is in Appendix A.

## 5. Core design — the `ActionDef` registry

One module, `src/actions/registry.ts`, exports an array of `ActionDef`. Everything else — the Gemini surface, the REST/WS surface, **and the capability matrix** — is derived.

### 5.0 The registry *is* the capability matrix (Decision 5)

Today the capability matrix is a **hand-maintained list of 16** in `gateSurface.ts` (`ALL_CAPABILITIES`, `CAPABILITY_LABELS`, `CAPABILITY_CATEGORIES`), and a swathe of actions are **ungated** (no matrix entry): all reads, `switch_active_pane`, `update_draft_prompt`, `create_orchestrator_plan`, `propose_handoff`, `revise_handoff`, `stage_handoff`, `reject_handoff`, `handoff_context_between_panes`. That is exactly the "different paths / things slip through" problem, applied to *security* rather than wiring.

Under this spec the relationship is inverted: **the capability matrix is a projection of the registry.**

- **Every `ActionDef` declares one mandatory `capability`** (or the `ALWAYS_ALLOWED` sentinel for the emergency brake). There is no ungated action.
- **The capability set is *derived*** by walking the registry — `ALL_CAPABILITIES = unique(registry.map(a => a.capability))`. Adding a housekeeping action that needs a new capability *adds a matrix row automatically*; the matrix can never lag the catalog.
- **Capability metadata lives in one `CapabilityDef` table** (`src/actions/capabilities.ts`): plain-language `label`, `category`, and `defaultGate`. `gateSurface.ts`'s three hand-lists are generated from it (or it replaces them), so the matrix UI, the voice read-backs, and the gate resolver all render the same source.
- **Many actions → one capability is fine** (e.g. all the note/rename actions share `update_metadata`; all the pane reads share `read_pane`). The capability is the *unit of gating*; the action is the *unit of behavior*.
- **The gate is encapsulated** (operator's answer 1): `runAction` always resolves `capability` through the existing `gateOrDefer` choke-point before invoking the handler. A handler never re-checks permissions; a surface never bypasses them. One enforcement point, used everywhere.
- **Behavior-preserving (Decision 6):** each newly-promoted capability's `defaultGate` matches today's behavior — `Auto` for what is currently ungated (reads, focus, drafting). Nothing gets *more* friction; everything gets *tunable*.

```ts
// src/actions/types.ts
import { z } from "zod"; // zod: one schema that serves validation AND Gemini schema-gen

/** Which surfaces expose this action. Goal is convergence; the flag makes drift explicit. */
export type Surface = "voice" | "rest" | "ws";

/** A capability = one row of the matrix. The set is DERIVED from the registry, not hand-listed. */
export type Capability = string; // closed at runtime by the registry; see ALL_CAPABILITIES (derived)
export interface CapabilityDef {
  id: Capability;                 // e.g. "write_to_pane", "read_pane", "archive_pane"
  label: string;                  // plain language, no jargon (matrix + voice read-backs)
  category: string;               // grouping for the matrix editor
  defaultGate: "Auto" | "Ask" | "Off"; // behavior-preserving default (Decision 6)
  spotlightEligible?: boolean;    // may loosen to Auto on the active pane (today: write_to_pane, deliver_handoff)
}

/** Discriminated result so one handler can express every existing response shape. */
export type ActionResult =
  | { kind: "ok"; output: unknown }                                  // normal read/write success
  | { kind: "pending"; messageId: string; summary: string; extra?: Record<string, unknown> } // HiTL / deferred
  | { kind: "clarify"; text: string }                                // re-route / disambiguate (e.g. non-allowlisted shell)
  | { kind: "blocked"; reason: string }                              // gate Off / forbidden
  | { kind: "error"; message: string };                              // handler failure (still answered once)

export interface ActionContext {
  manager: OrchestratorManager;
  session: LiveSessionLike | null;     // present on the voice path; null for REST/WS
  callId?: string;                     // Gemini call.id on the voice path
  trigger?: string;                    // operator utterance / "REST" / "WS"
  broadcast: (msg: unknown) => void;
  gateOrDefer: GateOrDefer;            // the existing choke-point, injected (not re-implemented)
  redact: (s: string) => string;      // redactSecrets, injected
}

export interface ActionDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;                        // canonical snake_case (the Gemini + dispatch + REST key)
  description: string;                 // operator-facing; fed verbatim to Gemini
  params: S;                           // ONE schema -> Gemini params + REST/WS validation
  capability: Capability | "ALWAYS_ALLOWED"; // MANDATORY — every action is a matrix entry (Decision 5)
  readOnly: boolean;                   // true => result text is redacted before leaving the process
  surfaces: ReadonlySet<Surface>;      // where it is exposed (drift made explicit & testable)
  rest?: { method: "get"|"post"|"put"|"delete"; path: string }; // optional explicit route binding
  handler: (args: z.infer<S>, ctx: ActionContext) => Promise<ActionResult> | ActionResult;
  /** Optional arg coercion for back-compat (e.g. propose_command: command -> instruction). */
  coerceArgs?: (raw: Record<string, unknown>) => Record<string, unknown>;
}
```

### 5.1 Derivations (the three generators)

- **`toGeminiDeclarations(registry)`** → `FunctionDeclaration[]`. Filters `surfaces.has("voice")`, maps `params` (zod) → Gemini `{ type: OBJECT, properties, required }` via a `zodToGeminiSchema` adapter (enums and `required` derived from the schema; no hand-maintained JSON). This array is what gets passed to `ai.live.connect({ config: { tools: [{ functionDeclarations }] }})`.
- **`runAction(name, rawArgs, ctx)`** → `ActionResult`. The *entire* Gemini dispatch becomes: look up the def → `coerceArgs` → `params.parse` → **resolve `capability` through `gateOrDefer` (the single, encapsulated enforcement point)** unless `ALWAYS_ALLOWED` → run `handler` → if `readOnly`, redact text in the result → return. Every action is gated here; no handler or surface re-checks or bypasses.
- **`deriveCapabilities(registry)`** → the matrix. `ALL_CAPABILITIES = unique(registry.map(a => a.capability).filter(c => c !== "ALWAYS_ALLOWED"))`; labels/categories/defaults come from the `CapabilityDef` table. This *replaces* the hand-maintained lists in `gateSurface.ts` (a test asserts every referenced capability has a `CapabilityDef`, and vice-versa — no orphans). The `onmessage` callback then maps `ActionResult` → exactly one `sendToolResponse({...call.id...})` (pending/clarify/blocked/ok/error each have a fixed wire mapping). One try/catch, one place.
- **`mountRestRoutes(app, registry, ctxFactory)`** → for every def with `surfaces.has("rest")`, register `def.rest.method`/`path`, validate the body/params with `params`, build a `ctx` with `session:null`, call `runAction`, map `ActionResult` → HTTP (`ok`→200 JSON, `pending`→202 + messageId, `blocked`→403, `clarify`→409, `error`→500). WS messages map the same way over the socket.

### 5.2 What stays hand-written

- The **audio / transcript / interrupt** branches of `onmessage` (`serverContent`) — not tool calls.
- **Pure-infra REST** with no model meaning (`/api/terminals/:id/resize`, `/api/settings` GET sanitization, static asset serving). These can stay outside the registry or be added with `surfaces:{"rest"}` only — the registry tolerates surface-asymmetric actions; §5.3 makes the asymmetry visible.

### 5.3 Drift becomes a report, not a surprise

A pure function `surfaceCoverage(registry)` returns, per action, which of `{voice,rest,ws}` it is on. The test suite asserts an **explicit allow-list** of intentional asymmetries. Anything voice-only or rest-only that is **not** on the allow-list **fails the build** — the opposite of today, where drift is silent.

**Initial allow-list = every current asymmetry** (Decision 3 — register-as-is). Phase 1 seeds the allow-list with *all* of the §4.2 single-surface tools (the voice-only reads/handoffs and the rest-only infra), so the registry adopts reality without changing any surface. The **Convergence track (§7)** then *removes* entries from this allow-list one group at a time — each removal forces the missing surface to exist and is gated by a parity-cutover test (§8.5b). The allow-list is therefore a live to-do list: when it is empty (minus the inherently single-surface tools), parity is complete.

### 5.4 Worked redesign — `create_pane` (Decision 7 in practice)

**Today (the bug):** the model supplies a required free-form `command`; `addTerminal` runs it verbatim; the preset→binary map is duplicated in the client and the restart handler and *guessed* by Janus.

**Target:** intent-only schema + one derivation home.

- **Domain layer (one home).** `addTerminal(...)` (or a small `resolveLaunch(preset, customCommand?)` it calls) derives the command from the authoritative `settings.presets` table: `Claude Code → claude`, `Codex → codex`, `Antigravity → antigravity`; `Custom → the provided command`. The restart handler's hardcoded map (`server.ts:848`) and the client-side mapping are **deleted** and call this instead. (This is a behavior-correcting change for the voice path and a behavior-preserving refactor for UI/restart — pinned by tests below.)
- **Action handler (shared).** The `create_pane` `ActionDef.handler` takes `{ project_id, pane_id?, tool_preset, cwd?, permissions_mode?, command? }`, resolves cwd the way the UI route already does (validate → fall back to active project dir — `server.ts:806`), and calls the domain layer. Both the voice path and `POST /api/terminals` call **this one handler**.
- **Schema as guardrail (zod).** 
  ```ts
  params: z.object({
    project_id: z.string(),
    pane_id: z.string().optional(),                 // server can mint one
    tool_preset: z.enum(["Claude Code","Codex","Antigravity","Custom"]),
    cwd: z.string().optional(),
    permissions_mode: z.enum(["Full Auto","Human-in-the-Loop","Read-Only"]).optional(),
    command: z.string().optional(),                 // honored ONLY when tool_preset === "Custom"
  }).refine(v => v.tool_preset !== "Custom" || !!v.command,
            "command is required (and only allowed) for the Custom preset")
  ```
  The model can no longer hand a `claude` / `bash` / `npx …` string for a known preset — it's *unrepresentable*. The description tells Janus to pick a preset and describe intent, not author a launch line.

**Generalizes:** any action whose mechanics are deterministic and environment-sensitive follows the same intent-vs-mechanics split (e.g. `apply_orchestration_recipe` already spawns from a template — its per-pane launches must route through the same `resolveLaunch`, not re-derive commands).

### 5.5 Read-gating as context control (not just privacy)

Reads default **Auto** (Decision 6) — Janus can always orient. But `read_pane` being its **own capability, independent of `write_to_pane`**, is load-bearing for two operator goals beyond security:

- **Direct-without-reading.** A valid, intentional posture is `write_to_pane: Auto` + `read_pane: Off`: *"route work into this pane, but don't slurp its output into your context."* The like-for-like model gives this for free (separate capabilities); the matrix UI should make this combination easy to set per pane.
- **Context-rot defense across panes.** The operator directs the workflow by voice; **pane output is supplementary, not primary**. Pulling verbose output (build logs, test spew) from many panes into the live Gemini session is a top cause of context rot. Per-pane `read_pane: Off` is the operator's **coarse, deliberate lever** to keep a noisy pane *out* of Janus's context window — complementing the automatic `contextWindowCompression` (triggerTokens 25000 / sliding 16000) already in the Live config. When a read is gated Off, the read tools return `blocked` ("not permitted to read pane-X"), so that pane's bytes never enter the context at all.
- **Graceful degradation.** Because the human is directing, a read-Off pane doesn't break Janus — she leans on spoken direction and the task description instead of pane output. (Contrast an autonomous agent, which would stall.)

Implication for the matrix surface (§8sq lineage): `read_pane` joins the per-pane chip/popover like any capability; a pane showing `write Auto / read Off` reads as "I act here, I don't watch here."

### 5.6 The choke-point payoff — audit, metrics, uniform errors (Pillar 1 → dependability, G7)

Because **every** action — voice, REST, WS — funnels through one `runAction`, the operational properties that separate a dependable tool from a vibe-coded one attach to *one wrapper* instead of 41 branches × 3 surfaces. Phase 1 builds the **seam** and the audit log; metrics/rate-limiting are thin additions; the *surfacing* of all this is Pillar 3 (§13).

```ts
// src/actions/runAction.ts — conceptual; the single wrapper around every action
export async function runAction(name, rawArgs, ctx): Promise<ActionResult> {
  const t0 = performance.now();
  const def = registry.get(name);
  if (!def) return audit({ name, outcome: "unknown" }, { kind: "error", message: `unknown action ${name}` });
  try {
    const args = def.params.parse(def.coerceArgs?.(rawArgs) ?? rawArgs);     // 1 validation point
    const gate = def.capability === "ALWAYS_ALLOWED"
      ? { disposition: "allowed" }
      : ctx.gateOrDefer(def.capability, paneOf(args), summarize(def, args)); // 1 enforcement point
    if (gate.disposition === "forbidden") return audit(..., { kind: "blocked", reason: "gate Off" });
    if (gate.disposition === "deferred")  return audit(..., { kind: "pending", messageId: gate.id, ... });
    const result = await def.handler(args, ctx);                              // 1 execution point
    const shaped = def.readOnly ? redactResult(result, ctx.redact) : result;  // 1 redaction point
    return audit({ name, surface: ctx.surface, args, gate, ms: performance.now() - t0 }, shaped);
  } catch (e) {
    return audit({ name, outcome: "threw", error: String(e) }, { kind: "error", message: "internal error" });
  }
}
```

What this single point buys (the §1.1 latent wins, made concrete):

- **Audit trail (build in Phase 1).** `audit(record, result)` appends one structured row per action — `{ ts, surface: voice|rest|ws, actor, name, args(redacted), capability, gateDisposition, resultKind, ms }` — to the existing `JanusStore` (a new `action_log` table) and returns the result unchanged. This is the answer to *"what did Janus do to my repo, and was it allowed?"* — a single queryable record, impossible to assemble reliably from 4 scattered code paths.
- **Metrics (cheap follow-on).** Per-action call counts, p50/p95 latency, and failure rate fall out of the same wrapper — no per-handler instrumentation.
- **Uniform failure handling (Phase 1).** One try/catch replaces 41 hand-written guards (some of which today only *happen* to catch). Every failure becomes a typed `ActionResult` answered exactly once on every surface (pins the WS-E.1 "answer call.id once" invariant structurally).
- **Rate-limit / circuit-break (later, optional).** A natural pre-handler hook to throttle a runaway model hammering a tool — one place, all surfaces.

Redaction note: audit args/results are redacted with the same `redactSecrets` so the log itself never becomes a secrets sink.

## 6. Architecture options & honest evaluation

The operator's instinct: *"Python is the most expressive and advanced as we aim to scale."* That is true for **authoring/validating a large tool catalog and for agentic tool logic** (Pydantic, rich typing, the LLM-tooling ecosystem). It is **not** an unqualified win **for the part of this system that does the work**, because the work is native-TS: node-pty PTY lifecycle (incl. Windows ConPTY), `better-sqlite3` ledger, the gate resolver, the WS broadcast hub, handoff/approval flows. Below, three options, scored against the goals.

### Option A — In-process **TypeScript** registry
One `ActionRegistry` in `src/actions/`; Gemini dispatch and REST/WS both call `runAction` in the same process.

- **Pros:** smallest diff; **literally one path** (same function object on every surface); reuses node-pty / SQLite / gates / redaction directly; zero IPC latency on the realtime voice path; end-to-end type safety; build stays a single `dist/server.cjs`; the existing `8sq` `stop_all` pattern generalizes cleanly.
- **Cons:** the catalog and handlers stay in TypeScript — it does not, by itself, advance a Python ambition.
- **Solves G1–G5 fully. G6: only as a seam (see Phase 2).** Risk: **low**.

### Option B — **Python execution backend** (TS becomes a thin proxy)
Python owns the registry **and executes** tools; `server.ts` proxies every call to it.

- **Pros:** maximum expressiveness for complex/agentic tool logic; Pydantic schemas; independent scaling/deploy of the tool service; Python's ML/embeddings ecosystem (e.g. semantic tool routing) on tap.
- **Cons (honest, and large):**
  - The things tools actually *do* are native-TS today. A Python backend must **re-implement** PTY lifecycle, the SQLite ledger format, the exact gate precedence (`override → spotlight → global`), handoff/approval state machines, and the broadcast hub — **thousands of lines**, with real parity risk (ConPTY behavior, store schema, gate edge cases the current tests pin).
  - **Latency on the realtime path:** every voice tool call crosses a process boundary; `list_panes`/`get_pane_delta` are called constantly.
  - **Two runtimes to package/test/ship** (today: one bundled `server.cjs`; the build battery is `tsc`/`tsx`/Playwright with a *vestigial* `py -3 unittest`). Operationally heavier.
  - It does **not** by itself deliver "one path": unless the TS UI **also** routes through Python, the REST handlers re-duplicate. So you still need the registry abstraction — *plus* an RPC boundary.
- **Solves G6 maximally; G1–G5 only if paired with the registry anyway.** Risk: **high**. Cost: **high**. Premature relative to current scale.

### Option C — **Hybrid:** Python is the **catalog/schema authority + codegen**; TS executes
Python (Pydantic) declares the canonical tool catalog (name, description, params, capability, surfaces, redaction). A build step emits (a) the Gemini `functionDeclarations` JSON and (b) a **typed TS binding table** the dispatch + REST adapters import. Handlers stay in TS, each **bound by name** to a catalog entry. Later, individual handlers can move behind an RPC call to a Python worker without touching the catalog or the surfaces.

- **Pros:** honors "Python first" where it pays off — **the thing you edit to add/spec a tool is Python**; both Gemini and TS surfaces are *generated* from it (genuine one-path for the contract); keeps risky native execution in TS until there's a concrete reason to move it; provides a clean, incremental path to Option B per-tool.
- **Cons:** introduces a **codegen step** (build complexity + a generated, checked-in artifact + a no-drift test); the repo now has a load-bearing two-language split (declaration in Python, implementation in TS) that needs a **binding test** to stay honest.
- **Solves G1–G6.** Risk: **medium** (the risk is build/codegen, not runtime).

### Scorecard

| | A (TS) | B (Py backend) | C (Hybrid) |
|---|---|---|---|
| One definition per tool (G1) | ✅ | ✅ | ✅ |
| Generated Gemini surface (G2) | ✅ | ✅ | ✅ |
| Shared UI execution (G3) | ✅ (same fn) | ⚠️ (needs RPC + registry) | ✅ (same fn) |
| Structural parity tests (G4) | ✅ | ✅ | ✅ |
| Python trajectory (G6) | ⚠️ seam only | ✅ | ✅ |
| Realtime latency | ✅ none | ❌ per-call IPC | ✅ none (exec in TS) |
| Re-platform risk | ✅ none | ❌ high | ⚠️ codegen only |
| Packaging/ops | ✅ one artifact | ❌ two runtimes | ⚠️ build adds a gen step |
| Diff size now | ✅ small | ❌ very large | ⚠️ medium |

### Recommendation — phased, A (now) → converge piecemeal → C (Python catalog); B deferred

**Phase 1 (this work): build Option A.** Collapse the four paths into one in-process TS `ActionRegistry`. This delivers the *entire* "touch one place" win at low risk and is **never wasted** — the `ActionDef` shape is identical regardless of where the catalog eventually lives.

**Phase 2 (next bead, honors the Python direction): lift the *catalog* to Python (Option C).** Author the tool catalog in Pydantic; codegen the Gemini declarations + the TS binding table from it. Now "to add or change a tool" = edit Python + run `npm run gen:catalog`. Execution stays in TS.

**Phase 3 — Option B (full Python execution backend) is NOT planned (Decision 1).** The registry seam keeps it *possible* later (an `executor:"ts"|"py"` flag, gate enforced before the boundary), but we do not build it now. Re-evaluate only under real scaling pressure.

Interleaved between Phase 1 and Phase 2 is the **Surface Convergence track** (§7): register-as-is first, then add each missing surface piecemeal, every cutover gated by a parity test (Decision 3).

This sequencing gives the operator the Python platform they want **without betting the realtime PTY/gate path on a premature re-platform**, and every phase ships value on its own.

## 7. Phased plan (file-by-file)

**Shape of the rollout (Decision 3):** Phase 1 is a pure **register-as-is** refactor — every existing tool becomes a registry entry with its *current* surfaces, no twin added, every asymmetry allow-listed. Then the **Convergence track** adds missing surfaces one small group at a time, each gated by a parity-cutover test. Phase 2 (Python catalog) can run in parallel once Phase 1 lands. There is no Phase-3 execution backend in this plan (Decision 1).

### Phase 1 — TS registry (register-as-is refactor)
Wrap the 41 voice tools **and** the rest-only infra actions into the registry with **no behavior or surface change**. Each `ActionDef.surfaces` reflects exactly where the tool lives **today** (voice tools → `{voice}` (+ `rest`/`ws` only where a twin already exists); infra → `{rest}`). The coverage allow-list (§5.3) is seeded with *all* current asymmetries so the build is green without converging anything. This is the cutover that collapses the four hand-edited paths into one definition; convergence is deliberately deferred.

**New files**
- `src/actions/types.ts` — `ActionDef`, `ActionResult`, `ActionContext`, `Surface`.
- `src/actions/registry.ts` — the canonical `ActionDef[]` (the 41 voice tools + the rest-only infra actions we choose to fold in). Handlers here are **extracted from** today's `onmessage` branches and REST bodies — same logic, moved.
- `src/actions/gemini.ts` — `toGeminiDeclarations()`, `zodToGeminiSchema()`, `runAction()`, and `resultToToolResponse()` (ActionResult → `sendToolResponse` mapping, answering `call.id` once).
- `src/actions/rest.ts` — `mountRestRoutes()` + `resultToHttp()`.
- `src/actions/coverage.ts` — `surfaceCoverage()` + the intentional-asymmetry allow-list.

**Modified**
- `server.ts` — replace the `functionDeclarations: [ … ]` literal with `toGeminiDeclarations(registry)`; replace the `if (name === …)` chain with `const result = await runAction(name, args, ctx); resultToToolResponse(result, session, call.id)`; replace registry-backed `app.<verb>` routes with `mountRestRoutes(app, registry, ctxFactory)`. Non-tool branches (audio/interrupt) untouched.
- `tests/test_voice_tools.ts` — delete the **regex** parity guard; point its assertions at the registry (§9).

**Phase 1 exit criteria:** all surfaces derive from the registry; the regex parity guard is gone; coverage allow-list = every current asymmetry; characterization goldens (§8.5) equal `main`. *No tool has gained or lost a surface.*

### Convergence track — burn down the allow-list, one group per phase (piecemeal)
Each convergence is an independent, small, revertible phase. The order below is by operator value (UI-meaningful first); each can ship on its own. **Every phase follows the same TDD-of-parity cutover ritual (§8.5b):**

1. **RED** — add a parity test: drive the tool through the *existing* surface and the *new* surface; assert identical `ActionResult` (same gate outcome, same redaction, same shape). It fails because the new surface doesn't exist yet.
2. **GREEN** — flip `ActionDef.surfaces` to add the twin and remove that tool from the coverage allow-list. `mountRestRoutes` / `toGeminiDeclarations` now emit the new surface automatically; the parity test passes.
3. **CUTOVER** — point the client (`src/App.tsx`) at the now-existing endpoint (or expose the new voice tool); delete any bespoke one-off path it replaced.
4. **GUARD** — the parity test stays in the suite forever, so the two surfaces can never re-diverge.

Suggested phase slices (each removes its rows from the allow-list):
- **C1 — Read tools → REST:** `get_pane_summary`, `get_pane_delta`, `get_pane_gates`, `search_notes`, `list_capabilities`. (UI reads from the same handlers the voice path uses.)
- **C2 — Handoff lifecycle → REST/WS:** `propose/revise/stage/deliver/read/list/reject_handoff`. (UI can drive handoffs, not just voice.)
- **C3 — REST-only infra → voice:** `resize`*, `clear-exited`, `archive`/`archive/restore`, watch-rule CRUD, `panes/:id/context`. (* `resize` is a candidate to stay rest-only — viewport geometry has no voice meaning; if so it remains permanently allow-listed, see Decision 3 "inherently single-surface".)

Inherently single-surface tools (kept on the allow-list permanently, by design): `set_voice_mute` (voice-only — it *is* the mic), pure viewport `resize`. The allow-list's *legitimate* residue is exactly these.

### Phase 2 — Python catalog authority + codegen (parallel-able after Phase 1)
- `catalog/tools.py` — Pydantic models for each tool (name, description, params, capability, surfaces, readOnly). **This becomes the place you edit to add/change a tool.**
- `scripts/gen-catalog.mjs` (or a Python emitter) → **committed** `src/actions/catalog.generated.ts` (binding table) + `gemini.tools.json` (golden declarations). Both files live in-repo and are committed (Decision 2).
- `package.json` — `"gen:catalog"` script; wire into `predev`/CI.
- No-drift test (§8.6) fails CI if the committed generated output is stale.
- Handler bodies stay in TS, bound by name to the Python catalog entry; a binding test (§8.6) asserts the TS handler set === the Python catalog name set.

### Phase 3 — Python *execution* backend — NOT PLANNED (Decision 1)
Out of scope by decision. Documented only so the registry seam stays future-proof: `ActionDef` could later carry an `executor: "ts" | "py"` flag and route `"py"` handlers to a worker **after** the TS-side gate passes. Revisit only under real scaling pressure; do not build now.

## 8. TDD — tests first (the contract)

Order: write the test (RED), then the minimum code (GREEN), then refactor. Names below are the actual `it(...)` titles to add. Runner: `npm run test:unit` (`tsx --test --test-force-exit tests/*.ts`).

### 8.1 Phase 1 — registry totality & shape — `tests/test_action_registry.ts`
1. **`every ActionDef has name, description, params schema, capability, readOnly, surfaces, handler`** — no field missing; `handler` is a function.
2. **`action names are unique and snake_case`** — `Set(names).size === names.length`; each matches `/^[a-z][a-z0-9_]*$/`.
3. **`every action has a non-empty capability`** — `capability` is a non-empty string or `"ALWAYS_ALLOWED"`; **no action is ungated** (Decision 5 — there is no `null`/missing capability).
4. **`the emergency brake trio is ALWAYS_ALLOWED`** — `stop_all`, `confirm_stop_all`, `release_stop_all` have `capability === "ALWAYS_ALLOWED"`.
5. **`readOnly actions bind only to read capabilities`** — `readOnly === true` ⇒ `capability ∈ {read_pane, read_notes}` (reads are gated like everything else, just defaulting Auto).

### 8.1b Phase 1 — the matrix is derived from the registry (Decision 5)
5a. **`ALL_CAPABILITIES === unique(registry capabilities)`** — `deriveCapabilities(registry)` equals the de-duplicated set of `ActionDef.capability` (minus `ALWAYS_ALLOWED`). The old hand-listed `gateSurface.ALL_CAPABILITIES` is gone or generated; a guard asserts no hand-list drifts from the derived set.
5b. **`every referenced capability has a CapabilityDef, and vice-versa`** — no orphan capability (referenced but unlabeled) and no dead `CapabilityDef` (labeled but unused). Pins label/category/`defaultGate` totality (the §8.1 analogue of today's `CAPABILITY_LABELS` totality test).
5c. **`defaultGate matches today's behavior`** — golden table: each capability's `defaultGate` equals the value transcribed from current behavior (e.g. `write_to_pane:Ask`, `update_metadata:Auto`, and every NEW promoted capability `:Auto`). Guards Decision 6 — the refactor cannot silently add friction.
5d. **`spotlight set unchanged`** — only `write_to_pane` + `deliver_handoff` are `spotlightEligible` (pins `gateSurface` SPOTLIGHT_CAPABILITIES).

### 8.2 Phase 1 — Gemini generation — `tests/test_action_registry.ts`
6. **`toGeminiDeclarations emits exactly the voice-surface actions`** — generated names `===` `registry.filter(surfaces.has("voice")).map(name)` (this **replaces the regex parity test** — parity is now true *by construction*, and the test proves the generator is the source).
7. **`generated declaration carries name, description, and params schema`** — for a sampled action (`propose_command`), `type === OBJECT`, `properties.pane_id`/`instruction` present, `required` includes `pane_id`+`instruction`, `kind` enum `=== ["agent_instruction","shell"]`.
8. **`empty-params tools generate an empty properties object`** — `list_panes`, `stop_all` ⇒ `parameters.properties === {}` (pins today's `8sq` assertion).
9. **`GOLDEN: emitted functionDeclarations match the committed snapshot`** — `dist/gemini.tools.json` (or an inline golden) deep-equals `toGeminiDeclarations(registry)`. Guards accidental description/schema changes and gives Phase 2 a contract target.

### 8.3 Phase 1 — `runAction` gate + redaction — `tests/test_action_registry.ts`
10. **`a gated action with capability=Auto runs the handler`** — stub `gateOrDefer` → allowed; handler invoked; `kind:"ok"`.
11. **`a gated action with capability=Ask returns pending and does not mutate`** — `gateOrDefer` → deferred; `kind:"pending"` with a `messageId`; handler side-effect absent.
12. **`a gated action with capability=Off returns blocked`** — `kind:"blocked"`, handler not called.
13. **`ALWAYS_ALLOWED bypasses the gate even when frozen`** — with `frozen=true`, `stop_all` still runs (mirrors the safety-critical `8sq` test; the gate is never consulted).
14. **`readOnly action output is redacted`** — handler returns a fake AWS key; injected `redact` is applied; secret absent from `ActionResult`.
15. **`unknown action name yields a single error result`** — `runAction("nope", …)` ⇒ `kind:"error"`, never throws.
16. **`handler throw is caught and yields error, answering once`** — a handler that throws ⇒ `kind:"error"`; `resultToToolResponse` calls `sendToolResponse` exactly once with `call.id` (spy count `=== 1`).
17. **`coerceArgs back-compat: propose_command accepts legacy 'command'`** — `{command:"x"}` coerces to `{instruction:"x"}` (pins the R2 alias at L2284).

### 8.3b Phase 1 — deterministic terminal bring-up (the keystone, §3.1/§5.4) — `tests/test_action_create_pane.ts`
17a. **`preset→command derivation has exactly one home`** — `resolveLaunch("Claude Code") === "claude"`, `"Codex" → "codex"`, `"Antigravity" → "antigravity"`, `"Custom" → the supplied command`; derived from `settings.presets`. Pins the single map.
17b. **`voice create_pane derives the launch command — the model cannot supply one`** — drive `create_pane` with `{tool_preset:"Claude Code"}` and **no** `command`; the spawned pane's `shellCmd` starts with `claude` (not `bash`, not `npx …`). A `{tool_preset:"Claude Code", command:"bash"}` call is **rejected by the schema** (guardrail — §5.4 refine).
17c. **`Custom preset still honors a free-form command`** — `{tool_preset:"Custom", command:"htop"}` runs `htop`; omitting `command` for `Custom` is a schema error.
17d. **`voice and REST create_pane produce an identical launch`** — same preset/cwd via the mock Gemini path and via `POST /api/terminals` ⇒ identical resolved `command` + `cwd` (the keystone "fix-once" proof; this is the test that would have caught the original divergence).
17e. **`cwd resolution matches the UI route`** — empty/`.`/non-existent cwd falls back to the active project directory then `process.cwd()` (pins `server.ts:806` behavior in the shared handler).
17f. **`shared env hygiene preserved`** — the spawned env has `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` stripped and applies `--dangerously-skip-permissions` per `permissions_mode` (characterizes `UniversalTerminal.start()` so the refactor keeps it).

### 8.4 Phase 1 — surface adapters & coverage
18. **`mountRestRoutes registers a route per rest-surface action`** (`tests/test_action_rest.ts`) — boot the server (existing `ce7`/mockLive harness), assert each `def.rest` path responds; a 401 without token (mirrors `test_voice_tools.ts` auth test).
19. **`REST and voice run the same handler for a shared action`** — call `propose_command` via the mock Gemini path and via `POST /api/terminals/:id/input`; assert identical gate outcome + result shape (the core "one path" proof).
20. **`surfaceCoverage flags only allow-listed asymmetries`** (`tests/test_action_registry.ts`) — every voice-only / rest-only action is in the intentional allow-list; fail otherwise.

### 8.5 Phase 1 — characterization (no behavior change, NG1)
21. **`each migrated tool produces the pre-refactor response shape`** (`tests/test_voice_tools.ts`, extended) — for a representative set (`list_panes`, `get_pane_summary`, `propose_command` Auto/Ask/Off, `deliver_handoff`, `stop_all`/`confirm`/`release`), push synthetic tool calls through the **new** dispatch and assert the recorded `sendToolResponse` payloads equal the captured pre-refactor goldens. (Capture goldens from `main` before the refactor; commit them as fixtures.)

### 8.5b Convergence track — parity-cutover test per group (the cutover gate)
This is the **TDD-of-parity** ritual the operator asked for: a tool may not gain a surface until a test proves the new surface matches the existing one. One parametrized helper, reused per converging tool, in `tests/test_action_parity.ts`:

22. **`<tool> behaves identically on its existing and new surface`** — for each tool in the converging group, drive the action through both surfaces (e.g. voice mock call *and* the new REST route) against the same `manager` state and assert **deep-equal `ActionResult`**: same gate disposition (Auto/Ask/Off → ok/pending/blocked), same redaction, same payload. Written **RED first** (new surface 404s / undeclared) → flip `surfaces` + drop the allow-list row → **GREEN**.
23. **`converged tool is removed from the coverage allow-list`** — `surfaceCoverage` shows the tool on both surfaces and the allow-list no longer lists it (so §8.4 #20 now *requires* the twin to exist — regression-proof).
24. **`the parity test is permanent`** — left in the suite after cutover so the surfaces can never silently re-diverge (this is the §7 GUARD step, encoded).

> Each Convergence phase (C1/C2/C3) adds rows 22–24 for *its* tool group only; the helper makes that a few lines per tool. The phase is mergeable the moment its parity tests are green and the client cutover is done.

### 8.6 Phase 2 — Python catalog ↔ TS no-drift (separate bead)
25. **`tests/test_tool_catalog.py`** (`py -3 -m unittest`): catalog totality; each tool's params is a valid Pydantic model; `capability ∈` the 16 + `{None,"ALWAYS_ALLOWED"}`; JSON-schema export round-trips.
26. **`generated TS binding table is up to date`** (`tests/test_catalog_codegen.ts`): running the generator yields **no diff** vs. the **committed** `catalog.generated.ts` (CI guard against stale codegen — Decision 2).
27. **`Python catalog name set === TS handler name set`** (binding test): every catalog entry has a TS handler and vice-versa — the cross-language analogue of the §8.2 #6 parity test.
28. **`Python-emitted Gemini declarations equal the TS golden`**: the committed `gemini.tools.json` deep-equals the §8.2 golden — the catalog move changed nothing Gemini sees.

### 8.7 Phase 3 — NOT PLANNED (Decision 1)
No execution-backend tests in this plan. If revisited, the seam contract would be: a `"py"`-executor tool returns the same `ActionResult` shape as its TS twin; the gate is enforced **before** the RPC boundary (an `Off` capability returns `blocked` without the worker being called); a worker timeout/crash still answers `call.id` exactly once.

## 9. Wire-mapping reference (ActionResult → surface)

| `ActionResult` | Voice (`sendToolResponse.response`) | REST | WS |
|---|---|---|---|
| `ok` | `{ output }` | `200 { output }` | `{ type:"<name>_result", output }` |
| `pending` | `{ status:"pending_approval", messageId, …extra }` | `202 { status:"pending_approval", messageId }` | `{ type:"approval_pending", messageId, … }` |
| `clarify` | `{ status:"clarify", output:text }` | `409 { clarify:text }` | `{ type:"clarify", text }` |
| `blocked` | `{ output: reason }` (spoken) | `403 { error:reason }` | `{ type:"command_blocked", reason }` |
| `error` | `{ output:"Internal error…" }` | `500 { error:message }` | `{ type:"error", message }` |

This table is the single definition of how every surface answers — pinned by tests §8.3/§8.4.

## 10. Risks & mitigations

- **R1 — Subtle per-tool response shapes** (`pending_approval`, `clarify`, status fields). _Mitigation:_ the `ActionResult` union covers all observed shapes; **characterization goldens (§8.5)** captured from `main` before refactor.
- **R2 — The regex parity test is load-bearing today.** _Mitigation:_ replace with **stronger** structural tests (§8.2 #6) + golden (#9) in the same PR; never remove coverage without its replacement landing green.
- **R3 — `gateOrDefer`/`dispatchProposal` coupling.** `propose_command`/`deliver_handoff` carry rich logic (kind inference, allowlist, handoff state). _Mitigation:_ inject these via `ActionContext`; the registry handler *calls* `dispatchProposal`, it does not reimplement it. Keep the handler a thin adapter.
- **R4 — Schema fidelity** (zod → Gemini). _Mitigation:_ `zodToGeminiSchema` covers only the shapes in use (object/string/number/boolean/enum/optional); a test (#7/#8) per shape; unsupported shapes throw at build, not runtime.
- **R5 — Phase 2 codegen drift.** _Mitigation:_ the no-drift test (§8.6 #23) fails CI if `gen:catalog` output differs from the committed artifact.
- **R6 — Phase 3 latency/availability.** _Mitigation:_ keep realtime-hot reads (`list_panes`, `get_pane_delta`) TS-executed; gate before RPC; one-shot error mapping (§8.7).
- **R7 — Worktree/commit policy.** This is a refactor of `server.ts`; the implementing agent must follow the repo's worktree-isolation rule (commit-authorized agents work in their own worktree).

## 11. Resolved decisions (was: open questions)

All four open questions were answered by the operator on 2026-06-03 (see the "Decisions" block at the top):

1. **Phase-2 shape** → **Python catalog + codegen** (execution stays in TS; no full Python backend). 
2. **Generated artifacts** → **committed in-repo** alongside hand-written code (one repo, everything together), guarded by a no-drift test.
3. **Surface convergence** → **register-as-is in Phase 1, then converge piecemeal** in the §7 Convergence track, each group gated by a parity-cutover test. Convergence appetite is full (reads→REST, handoffs→REST, infra→voice) but sequenced after the registry lands; only `set_voice_mute` / pure `resize` stay permanently single-surface.
4. **Schema library** → **`zod`** (one schema for validation + Gemini generation).
5. **Registry = capability matrix; like-for-like security** → every action is a mandatory, gated matrix entry; the capability set is derived from the registry; ungated actions get promoted (default Auto). (Decisions 5 & 6.)
6. **Mechanics in the handler, intent in the schema** (Decision 7) → deterministic logic lives once (the §3.1/§5.4 terminal keystone); schemas are guardrails.
7. **Housekeeping defaults** (operator-confirmed) → `archive_pane` = **Auto** (reversible); `clear_history` = **Ask** (destructive); `add_watch_rule` = **Ask** (arms automation).
8. **Close/restart by voice** (operator-confirmed) → add **`close_pane` + `restart_pane` voice tools, Ask-gated**, in C3 (completes like-for-like; the capabilities already exist).

9. **Reads default Auto; read-gating is a context-control lever** (operator-confirmed) → `read_pane`/`read_notes` default **Auto** (Janus always orients). Read-gating is independent of write, and its purpose is **privacy *and* context-rot defense** — per-pane `read_pane: Off` keeps a noisy pane out of the live context while `write_to_pane` can stay Auto. See §5.5.

All judgment calls are now resolved. Lower-stakes unknowns (settle during implementation, non-blocking): exact REST paths/verbs for C1–C3; whether `resize` ever converges; precise WS message names in §9; whether reads stay two capabilities (`read_pane`/`read_notes`) or collapse to one `read_state` (cosmetic — both default Auto).

## 12. Definition of Done

### Phase 1 (register-as-is) — DoD
- [ ] `src/actions/{types,registry,gemini,rest,coverage}.ts` exist; **all 41 voice tools and the rest-only infra actions** are registry entries with their *current* surfaces.
- [ ] `server.ts` Gemini declarations + dispatch + registry-backed REST routes are **generated** from the registry; no `if (name === …)` tool chain remains.
- [ ] §8.1–§8.5 tests green; the **regex** parity guard is deleted and replaced by the structural one (§8.2 #6).
- [ ] Coverage allow-list = **every current asymmetry**; `surfaceCoverage` test (§8.4 #20) green with no surface having changed.
- [ ] `npm run lint` (`tsc --noEmit`), `npm run test:unit`, `npm run build` pass; `npm run smoke:claude` still drives a live pane.
- [ ] **No behavior change** vs. `main` (characterization goldens equal).
- [ ] Follow-up beads filed for each Convergence phase (C1/C2/C3) and for Phase 2 (Python catalog).

### Convergence phase Cn — DoD (repeats per group)
- [ ] Parity-cutover tests (§8.5b) green for every tool in the group (existing surface ≡ new surface).
- [ ] `ActionDef.surfaces` updated; the group's rows removed from the coverage allow-list.
- [ ] Client (`src/App.tsx`) cut over to the new surface; the bespoke path it replaced is deleted.
- [ ] Parity tests remain in the suite (permanent anti-divergence guard).

### Phase 2 (Python catalog) — DoD
- [ ] `catalog/tools.py` is the authored source; `catalog.generated.ts` + `gemini.tools.json` are committed and regenerated by `npm run gen:catalog`.
- [ ] §8.6 tests green (no-drift, name-set binding, Gemini golden unchanged).

## 13. Dependability roadmap — Pillars 2 & 3 (future beads, NOT this spec's scope)

This spec delivers **Pillar 1** (one trustworthy surface, §1.1). Pillars 2 and 3 are what carry the app the rest of the way from vibe-coded to a daily-driver you can depend on. They are **out of scope here** — recorded so the registry seam is built with them in mind and so they become their own specs/beads. Both are *cheap* precisely because Pillar 1 gives them a single choke-point to hook.

### Pillar 2 — Resilience / known failure modes (next)
A daily driver must have a **specified, tested** answer to "what happens when it breaks mid-task." Today these paths are implicit/untested. Each becomes a scenario test (the harness already boots a real server + mock Live + stub PTYs — `tests/test_voice_tools.ts`).

| Failure | Today (implicit) | Target (specified + tested) |
|---|---|---|
| **Gemini Live session drops mid-task** | reconnect relies on `sessionResumption` token; unclear what happens to an in-flight tool call / pending approval | On reconnect: resume from the last token; any in-flight `runAction` is either idempotent-replayable or reported as interrupted; pending approvals survive (already in `JanusStore`) and are re-announced. Test: kill the mock session between a tool call and its `sendToolResponse`. |
| **A pane PTY dies** (crash/OOM/exit) | `UniversalTerminal` marks Exited; probe ticks notice | A pane death emits an attention item + earcon; `read_pane`/`propose_command` on a dead pane returns a clean `blocked`/`clarify` (not a throw); restart path is the shared `resolveLaunch` (§5.4). Test: transport emits exit mid-command. |
| **Server restart with work in flight** | SQLite ledger + `frozen` flag persist; panes are INERT on boot (no auto-spawn) | On boot, the ledger/handoffs/approvals/`frozen` state restore deterministically; the operator is told "N panes were running, restart them?"; nothing silently re-executes. Test: persist state, re-import server, assert restore. |
| **Handler hangs / never returns** | a stuck handler stalls that call | `runAction` enforces a per-action timeout → `{kind:"error"}` answered once; the realtime session is never blocked. |

Deliverable: a `docs/.../resilience-design.md` + `tests/test_resilience.ts`, building on the §5.6 wrapper (timeout + idempotency hooks live there).

### Pillar 3 — Observability you can see (later)
Pillar 1 *logs* the audit trail (§5.6); Pillar 3 *surfaces* it so the operator can trust and debug what Janus did.

- **Action log view** — a UI panel (and `GET /api/action-log`, itself a registry read action) over the `action_log` table: filter by pane/capability/outcome, see the gate decision and latency per action.
- **Health/status** — pane liveness, session-connected state, in-flight/pending counts, recent error rate — a small always-visible status strip.
- **"Why did that happen?"** — because every action carries its `trigger` (operator utterance) + gate decision, the log answers "why did Janus run this" without guesswork.

Deliverable: a `docs/.../observability-design.md` + the action-log read action and panel.

### Sequencing
Pillar 1 (this spec) → Pillar 2 (resilience) → Pillar 3 (observability). 2 and 3 both attach to the §5.6 choke-point, so doing Pillar 1 first is what makes them small. None of Pillar 2/3 is required for Phase 1 to ship and add value.

---

### Appendix A — derived capability matrix (Phase-1 seed)

Every action maps to exactly one capability (Decision 5). **Existing** capabilities keep their current `defaultGate`; **NEW** capabilities (rows marked) are *promotions of previously-ungated actions* and default to `Auto` to preserve today's behavior (Decision 6). `defaultGate` is the **global** default; the spotlight may still loosen `write_to_pane`/`deliver_handoff` to Auto on the active pane.

| capability | default | new? | actions bound to it |
|---|---|---|---|
| `read_pane` | Auto | **NEW** | `list_panes, get_pane_summary, get_pane_delta, get_pane_command_history, list_pending_approvals, get_attention_digest, get_pane_gates, list_capabilities` |
| `read_notes` | Auto | **NEW** | `get_project_notes, search_notes, read_handoff, list_handoffs` |
| `focus_pane` | Auto | **NEW** | `switch_active_pane` |
| `compose_draft` | Auto | **NEW** | `update_draft_prompt, create_orchestrator_plan, propose_handoff, revise_handoff, stage_handoff, reject_handoff, handoff_context_between_panes` |
| `write_to_pane` | Ask (Auto on active) | — | `propose_command` |
| `deliver_handoff` | Ask (Auto on active) | — | `deliver_handoff` |
| `create_pane` | Ask | — | `create_pane` |
| `close_pane` | Ask | — | **NEW voice tool `close_pane`** (Ask-gated) added in C3 — operator-confirmed |
| `restart_pane` | Ask | — | **NEW voice tool `restart_pane`** (Ask-gated) added in C3 — operator-confirmed |
| `create_project` | Auto | — | `create_project` |
| `set_pane_permissions` | Ask | — | `set_pane_permissions` |
| `set_global_permissions` | Ask | — | `set_global_permissions` |
| `set_capability_gate` | Ask (tighten-only by voice) | — | `set_capability_gate` |
| `execute_plan` | Ask | — | `execute_plan` |
| `apply_recipe` | Ask | — | `apply_orchestration_recipe` |
| `add_watch_rule` | Ask | — | _(REST today; → voice in C3)_ |
| `update_metadata` | Auto | — | `add_project_note, add_pane_note, amend_note, delete_note, rename_project, rename_pane`, `panes/:id/context` |
| `switch_context` | Auto | — | `switch_context` |
| `set_voice_mute` | Auto | — | `set_voice_mute` |
| `dismiss_attention` | Auto | — | `dismiss_attention` |
| `archive_pane` | Auto (reversible) | **NEW** | _(REST `clear-exited`/`archive`/`restore` today; → voice in C3)_ — operator-confirmed Auto |
| `clear_history` | Ask (destructive) | **NEW** | _(REST `history/clear` today; → voice in C3)_ — operator-confirmed Ask |
| `ALWAYS_ALLOWED` (sentinel, not a matrix row) | — | — | `stop_all, confirm_stop_all, release_stop_all` |

Notes:
- `resize` is intentionally **not** a capability — pure viewport geometry, rest-only forever (the legitimate allow-list residue).
- `read_pane`/`read_notes` default **Auto** (resolved). The two-vs-one (`read_state`) split is cosmetic and may collapse during implementation; either way reads default Auto and are independently gateable from writes (§5.5).
- All gate defaults here are operator-confirmed or transcribed from today's behavior and **must be pinned by tests §8.3 + §8.1b** so the refactor cannot silently re-gate a tool or change a default.
