# Gap Assessment — "Vibe-Coded → Substantive"

- **Date:** 2026-06-03
- **Status:** Assessment (companion to `2026-06-03-unified-tool-registry-tdd-spec.md`)
- **Purpose:** Honestly size what separates OrbitalVoiceRunner from a tool dependable enough for the operator's daily developer workflow. Severity-ranked, effort-sized, and mapped to the three pillars (§1.1 of the registry spec).
- **Method/confidence:** Two read-verified sub-audits (resilience; maintainability/tests/types/dead-code) + measured `grep`/`wc` over the source. Line numbers are indicative — **spot-verify before acting**; a few resilience findings are inferred from the absence of handlers and should be confirmed by reproduction.
- **Reconciled 2026-06-04** against `origin/main` @a977724 (19 commits landed after the audit). Headline findings hold; three are now partly addressed. See §7 for the deltas before acting on any item.

---

## 0. Verdict (BLUF)

This is a **high-quality scaffold with sharp corners** — an ~0.8 alpha, not a cliff but not a smooth on-ramp. The **core abstractions are genuinely sound and well-tested**: the gate resolver, the approval lifecycle, the handoff state machine, and the SQLite store each have real, substantial suites. What stops it being a daily driver is a consistent pattern: **the happy path is solid; the boundaries are soft.** Specifically — no crash-safety net at the async edges, weak typing where external data enters, two ~4k-line monoliths, and test coverage that thins out exactly where the real world breaks things (session drops, PTY failures, REST in isolation, restart recovery).

The good news: the registry effort (Pillar 1 / G0) **directly attacks three of the six problem areas** (boundary typing, the dispatch monolith, duplication), and several of the scariest resilience gaps are **small, cheap fixes** that can ride alongside it.

## 1. Hard metrics (measured)

| Metric | Value | Read |
|---|---|---|
| Largest files | `App.tsx` **4,527**, `server.ts` **3,789**, `SettingsDialog.tsx` 1,253 | two monoliths dominate |
| Total source (TS/TSX) | ~26,500 lines | — |
| `as any` casts | **117** | type erosion at boundaries |
| `: any` annotations | **156** | "" |
| `@ts-ignore` / `@ts-expect-error` | 2 | low — good |
| `server.ts` try / catch | 30 / 31 | guarded *inside*, not at the process edge |
| `.catch(` (whole repo) | **6** | very few fire-and-forget guards |
| `process.on('uncaughtException' / 'unhandledRejection')` | **0** | **no crash safety net** |
| Debt markers (TODO/FIXME/HACK/BUG-) | **57** | meaningful but tracked |
| Test files / lines | ~30 / **7,926** | real breadth; specific holes |
| Dead Python files | 2 (`universal_terminal.py` + its test) | unused by the app |

## 2. Findings by theme (severity-ranked)

### A. Crash-safety at async boundaries — **HIGH** (Pillar 2)
The single biggest "vibe-coded" tell: the system guards logic *inside* handlers but has **no net at the edges**, so real-world events (network blips, bad spawns) become full-process crashes.

| # | Finding | Sev | Effort | Tested? |
|---|---|---|---|---|
| A1 | **Gemini Live session has no `onerror`/`onclose` and no reconnect** (`server.ts` ~2111). Mid-task voice-channel death is *silent*; pending approvals can expire against a dead session. | HIGH | M | no |
| A2 | **PTY spawn is unguarded** (`ptyTransport.ts` ~113; `terminal.ts:start()` ~523 calls it with no try/catch). A bad command/cwd can throw past the handler. | HIGH | S | no |
| A3 | **No `uncaughtException`/`unhandledRejection` handler** anywhere. Any unguarded throw (a ledger save, a broadcast, the approval sweep `setInterval`) can crash the whole server. | HIGH | S | no |
| A4 | **`stopAll` Stage 2 is fire-and-forget** (`server.ts` ~1684): reports panes "killed" without awaiting `term.stop()`. The *emergency brake can lie*. | MED→HIGH | S | no |
| A5 | Unguarded `onOutput` callback chain (`terminal.ts` ~554 → server pane-signal/history/transition handlers): one throw silently kills a pane's output stream. | MED | S | no |
| A6 | `broadcast()` keeps broken sockets in the `clients` set on send-error → slow leak over a long session. | LOW | S | no |

> Several of these (A2, A3, A4) are **S-effort, HIGH-value** — the cheapest dependability wins in the codebase.

### B. Weak typing where external data enters — **HIGH** (Pillar 1 / G0 fixes most)
Untyped data flows from three external sources straight into logic, so schema drift or a malformed input fails at *runtime*, not compile time.

- **B1 — Gemini tool args are `Record<string, any>`** (`server.ts:2224`), then unchecked: `const targetId = args.pane_id`. If the model omits/misspells a field, you get `manager.terminals[undefined]` failing silently. **This is exactly what the registry's per-action zod schema (§5 of the spec) eliminates.** Sev HIGH, effort M.
- **B2 — SQLite results cast `as any[]`** in 40+ places (`store/sqliteStore.ts`): a dropped/renamed column only fails at a downstream `.map()`. Sev MED, effort M (typed row hydration).
- **B3 — Gemini SDK message shape guessed via `(message as any)` polyfills** (`server.ts` ~2121–2148): depends on undocumented field shapes with no validating envelope. Sev MED, effort M.
- **B4 — `preset as any` / `permissionsMode as any`** at `addTerminal` call sites (`server.ts` 1389, 2681): bypasses `parsePresetsSafe()`; a stale preset value slips through. Sev MED, effort S. (Overlaps the §3.1 keystone.)

### C. Structure / monoliths — **HIGH maintainability** (Pillar 1 partially fixes)
- **C1 — `server.ts` is one ~3,800-line `startServer()`** mixing ~55 REST routes, the 41-branch Gemini `if/else` dispatch, gate logic, lifecycle events, and 28+ inline `broadcast()` calls. No module boundaries — adding a feature means editing a paragraph deep in the chain and hoping you didn't perturb a broadcast. **The registry's `runAction` + generated routes is the principal remedy** (collapses the dispatch + REST wiring). Sev HIGH, effort L.
- **C2 — `App.tsx` is 4,527 lines.** Out of scope for the registry, but the UI-side twin of the same problem; flagged for later.
- **C3 — `addTerminal()` is called from 4 places** (REST, recipe, voice, restart) — the keystone divergence, already specced.

### D. Test coverage holes — **HIGH/MED**
Breadth is real (~7.9k lines), but concentrated on the *pure* cores. Gaps:
- **D1 — `server.ts` REST endpoints largely untested in isolation** (~55 routes; the gated ones like `…/permissions`, notes CRUD, archive, resize, history have no direct test). Exercised only indirectly via the mock-Live harness. Sev HIGH, effort M. *(The registry's REST adapter + parity tests close much of this.)*
- **D2 — PTY teardown / Windows ConPTY drain / legacy transport fallback untested** (`ptyTransport.ts` covered ~2%: only signal selection). Sev MED, effort L.
- **D3 — No failure-injection tests anywhere** — no session drop, no spawn failure, no mid-flight crash, no restart-with-pending-approvals. This is the test face of theme A. Sev HIGH, effort M.
- **D4 — The Gemini dispatch's only cross-check is the source-scraping regex** (`test_voice_tools.ts`) — already slated for replacement by the registry's structural tests.

### E. State / recovery & known debt — **MED** (Pillar 2)
- **E1 — Pending approvals are not re-announced after a server restart** (`pendingApprovals.ts` ~658, "WS-F TODO"). They persist in the store but a crash-while-you're-away can let them expire unheard. Sev MED, effort M.
- **E2 — Running PTYs are all marked Exited on boot** with no "restart these?" prompt — work is silently lost. Sev MED (acceptable for a voice tool, but undocumented), effort M.
- **E3 — `attentionQueue` unbounded** (BUG-035); mitigated by `pruneAttention()` but not at every mutation site. Sev MED, effort S.
- **E4 — Drafts persistence** unclear (may be per-session in-memory) — verify. Sev LOW.

### F. Dead / legacy / duplicated code — **LOW/MED**
- **F1 — `universal_terminal.py` + `tests/test_universal_terminal.py` are dead** (no references; not in `package.json` test script) — yet `CLAUDE.md` lists the Python test in the build battery. Delete or document. Sev LOW, effort S.
- **F2 — Dual ledger backend** (`JANUS_LEDGER_BACKEND=legacy`, `ledger.ts` ~472 lines + parity tests): actively maintained fallback no production operator uses — ~500 lines of carrying cost. Sev MED, effort M (decide: keep as escape hatch or retire).
- **F3 — Gate-precedence logic deliberately mirrored** in `gateSurface.ts` (`resolveOne`) and `pendingApprovals.ts` (`resolveCapabilityGateWithContext`) — the file header *admits* it and says "keep in lockstep." A shared resolver removes the footgun. Sev MED, effort S.
- **F4 — Minor duplication**: cwd resolution inline in ≥2 places; repeated broadcast payload shapes. Sev LOW, effort S.

## 3. How this maps to the registry effort & the three pillars

| Theme | Owned by | Does the registry (Pillar 1 / G0) fix it? |
|---|---|---|
| B (boundary typing) | Pillar 1 | **Yes, largely** — per-action zod schema kills the `args: any` class (B1, B4) at the tool boundary. |
| C (dispatch monolith) | Pillar 1 | **Yes, the dispatch + REST wiring** (C1/C3). `App.tsx` (C2) is separate. |
| D1/D4 (REST + dispatch testing) | Pillar 1 | **Yes** — REST adapter + structural/parity tests replace the regex and cover routes. |
| F3/F4 (duplication) | Pillar 1 | **Yes** — one home per behavior is the point. |
| A (crash-safety) | **Pillar 2** | **No** — the registry's single try/catch helps uniformity, but onerror/reconnect/spawn-guard/process-net are net-new. |
| D2/D3 (PTY + failure injection) | Pillar 2 | No — resilience testing. |
| E (restart recovery, queues) | Pillar 2 | No. |
| B2/B3 (SQLite/SDK typing) | adjacent | Partial — same discipline, different surface. |
| F1/F2 (dead/legacy) | hygiene | No — independent cleanup. |
| C2 (App.tsx) | later | No — UI refactor, own effort. |

**Reading:** Pillar 1 (the registry) is correctly the first investment — it retires a big share of the HIGH findings (B, C, D1, F3). But the assessment surfaces one adjustment worth making: **a few A-theme fixes are S-effort and HIGH-value**, and waiting for "Pillar 2 later" leaves daily-use crash risk on the table longer than necessary.

## 4. Recommended sequencing (revised by this assessment)

1. **Pillar-0 quick wins (½–1 day, do alongside/just before Phase 1):** add the process-level `uncaughtException`/`unhandledRejection` net (A3); wrap PTY spawn (A2); add Gemini session `onerror`/`onclose` that at minimum surfaces "voice lost" to the client (A1, minimal form); `await` the Stage-2 kills (A4). These are cheap and stop the worst daily-use crashes immediately.
2. **Pillar 1 — the registry (the spec).** Lands G0 legibility + retires B1/B4, C1/C3, D1/D4, F3. Delete the dead Python (F1) as part of the cleanup.
3. **Pillar 2 — resilience proper.** Reconnect logic (A1 full), failure-injection tests (D3), PTY/ConPTY tests (D2), approval-restart re-announce (E1/E2), attention-queue cap audit (E3). This is its own spec (§13 of the registry doc).
4. **Pillar 3 — observability** (action-log view + health), and the **`App.tsx` decomposition** (C2) as a parallel UI track.
5. **Decisions to make:** retire vs. keep the legacy ledger backend (F2); SQLite typed-row layer (B2).

**Rough sizing to "reliable daily driver":** the sub-audit estimate of **~3–4 focused engineer-weeks** is consistent with these findings (registry refactor ~1.5wk incl. tests; resilience + failure tests ~1wk; recovery + cleanup ~0.5–1wk). The quick wins in step 1 buy most of the *felt* reliability in the first day.

## 5. What's genuinely good (so the scope is honest)
Not everything is soft — these are already substantive and should **not** be rebuilt:
- The **capability-gate model** (16-cap matrix, override→spotlight→global precedence) — well-designed and tested (`test_capability_gate.ts`, `test_gate_surface.ts`).
- The **approval lifecycle** incl. durable store, atomic claims, voice/REST parity (`test_approvals_wse.ts` 41 cases, `test_pendingApprovals_durable.ts`).
- The **handoff state machine** with on-disk flow tests (`test_handoff_flow.ts`, `test_handoff_resolve_e2e.ts`).
- The **SQLite store** with migration + JSON↔SQLite parity (`test_store_*.ts`).
- The **status machine / probe** with replay tests.

## 6. Reconciliation — `origin/main` @a977724 (2026-06-04)

19 commits landed between the audit and this merge. **The verdict is unchanged** — happy path solid, boundaries soft — and the highest-severity findings still hold, but the picture moved on a few, and the deltas *reinforce* the registry thesis rather than undercut it.

**Findings that still hold (re-verified on the integrated tree):**
- **A3 / QW1** no `uncaughtException`/`unhandledRejection` net — **still 0**. Holds.
- **A2 / QW2** PTY spawn unguarded — `pty.spawn(...)` at `ptyTransport.ts:113` still has no try/catch. Holds.
- **C1** server.ts monolith — **worse**: 3,789 → **4,038** lines. Intensified.
- **B1** type erosion — **worse**: 117 → **140** `as any`. Intensified.
- **KS keystone (launch-derivation half)** — the restart path still hardcodes its own `if tool_preset === "Claude Code"` map (`server.ts:871–873`); voice/REST still pass `command`. Open.

**Findings now (partly) addressed — re-scope before acting:**
| Finding | What landed | New status |
|---|---|---|
| §4.2 / KS **gate-bypass half** | `restGateOutcome` (G6, `restGate.ts`) routes REST pane-spawn through the same `gateOrDefer` seam | **Closed.** KS re-scopes to the launch-derivation half only. |
| **E1 / RES3** approvals/actions not durable across restart | durable `PendingActionStore` (kzt) + `PendingApprovalStore` (nzt), intent persisted + `run()` rebuilt on boot via `actionEffects.ts` | **Largely addressed** at the persistence layer. Remaining: boot-time "N panes were running, restart them?" re-announce UX + running-PTY recovery (E2). |
| **F4** cwd/dir duplication | `resolveProjectDir` shared helper used on voice + REST `create_project` (commit `ea66446`) | **Partly addressed** for project dir; pane cwd still inline. |
| crash-safety direction | n2r added UI-side crash-safety (gate-cockpit normalizers + local error boundary) | Narrow (presentation only); does **not** touch the server-side A-theme (QW1/QW2/QW3). |

**Finding now *strengthened* by the new code — F3 (mirror duplication):** main grew a whole family of hand-extracted, "*Mirrors X / keep in lockstep*" pure helpers — `restGate.ts`, `recipeApply.ts`, `actionPendingPayload.ts`, `actionEffects.ts`, `projectDir.ts` — each a per-surface twin maintained by hand because there is no unified action surface. This is precisely the proliferation the registry (Pillar 1) exists to end; the case for it is **stronger** post-merge, not weaker. (Also: the team is clearly TDD-disciplined — test files grew 30 → 61 — consistent with "strong cores, soft boundaries.")

**Net:** Pillar 0 (QW1/QW2/QW3) is untouched by these commits and remains the cheapest reliability win. The registry (Pillar 1) is more justified. The keystone shrinks to its launch-derivation half. RES3 shrinks to its boot-UX/recovery half. No finding was invalidated.

The registry work *builds on* these — it changes how actions are *defined and routed*, not how the gate, approval, or store internals work.
