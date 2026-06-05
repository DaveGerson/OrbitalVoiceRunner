# c55.8 — REST→Registry Convergence: the Terminal State ("the lid")

**Status:** Design approved 2026-06-05 (brainstormed UX-first). Ready for implementation planning.
**Bead:** `wsm-e2e-pinned-c55.8` (child of the `wsm-e2e-pinned-c55` scoping bead).
**Branch:** `feat/c55.8-convergence-lid` (worktree `OrbitalVoiceRunner-wt/c55-8-lid`, off `origin/main`).
**Predecessor:** c55 batches A–G shipped to main (merge `6e4c500`); this is the final batch.

---

## 1. Where this sits in the system

`server.ts` is a **hub / wiring layer** (~1,430 lines, down from ~3,300 after DBT5 + c55 A–G). It
constructs dependencies and mounts modules; it does **not** define capabilities. Capabilities live in
the **registry** — `src/actions/` (`registry.ts`, `defs/*.ts`, `rest.ts`, `types.ts`, `gemini.ts`).
Other extracted modules: `src/voice/` (Gemini Live), `src/gating/` (the capability-gate matrix),
`src/observe/` (PTY watch), `src/core/` (shared state), `src/store/` (SQLite ledger),
`src/terminal.ts` (`OrchestratorManager` + PTYs).

Three surfaces can invoke a capability — **voice** (Gemini → `runAction`), **REST** (browser fetch →
`mountRestRoutes` → `runAction`), and the **WS live feed** (broadcasts). c55's purpose: make the
registry the single point where each capability is defined, so all three surfaces are projections of
it instead of REST carrying its own hand-written inline routes that drift from what Janus knows.

c55.8 is the act of evacuating the **last** inline routes from `server.ts` into the registry — and
then **locking the door** so routes can't creep back in and re-bloat the hub.

## 2. North star — one umbrella

**The registry is the single umbrella.** One catalog describes everything the system can do. Most
entries are full definitions (voice + REST + WS). The handful that deliberately remain as plain UI
plumbing (drafts, settings) are **declared in the same catalog**, marked "inline / UI-only" with an
in-code reason — not off in a separate, forgettable list. One place to look; one guard that reads that
one place. **Nothing exists that the umbrella doesn't know about.**

## 3. Governing principles (written down in-code, canonical — not tribal)

These are the operator-experience decisions that drove the design. They live as the header doc of the
declared-inline module (§4.1) and a short `docs/` pointer, so future contributors inherit them.

**P1 — Commandability broad, proactivity tight (two independent dials).**
- *Commandability* (the `surfaces` flag): the operator should be able to drive almost everything by
  voice → surface broadly.
- *Proactivity* (the gate matrix Auto/Ask/Off): what Janus does **unprompted** stays very limited →
  gate tightly.
- These are independent. Surfacing an action to voice (`surfaces:['voice','rest']`) makes it
  **commandable**; its gate (default Ask/Off) keeps it from being **proactive**. Voice parity costs
  zero autonomy risk.

**P2 — Gating taxonomy.**
- *Orchestration plumbing* (navigate, arrange, manage panes, drafts, resize, status reads) → **ungated**
  ("the tools Janus needs to operate the orchestrator — Janus doing the work of Janus").
- *Reading terminal results* → **gated**. The one deliberate exception among reads: protects privacy of
  sensitive output and protects the context window from bloat.
- *Consequential CLI acts + safety changes* (run a command, set a gate, spawn/kill) → **gated**
  (proactivity).

## 4. Deliverables

**Re-scope note (2026-06-05, post-recon):** a scan of the *current* `server.ts` found **~30** inline
routes, not the ~6 this doc first illustrated — a whole untwinned surface (notes, archive,
approvals/pending, project-CRUD, several reads) that c55 A–G never touched. And **dropping `opts.only`
is blocked**: at least `set_capability_gate` is a registry def whose REST path collides with the
surviving inline *bulk* gates route (the held semantic-split decision), so removing the filter would
mount a shadowed/half-right def. Therefore **c55.8 is scoped to the LID only** — the declared-inline
catalog (§4.1, all ~30 routes) + the no-twin guard (§4.3). **Dropping `opts.only` (§4.2) and converging
the untwinned families are DEFERRED to a sequenced multi-bead program** (see §10). The lid is still
~one focused PR and delivers the whole point: stop drift, institutionalize the modularization.

### 4.1 The declared-inline catalog — `src/actions/inlineExceptions.ts` (new)

A single exported list living *with* the registry (under the one umbrella). Each entry:
`{ method, path, reason }` so the "why" is in the code. Illustrative (the exact set is enumerated at
implementation time — the guard's first run reveals every inline route on the current `server.ts`):

| Route | Reason |
|---|---|
| `POST /api/terminals/:id/raw-input` | multi-cli raw-keystroke path; gated inline (`write_to_pane`); future converge |
| `GET\|PUT /api/panes/:projectId/:paneId/draft`, `GET /api/projects/:projectId/drafts`, `POST .../draft/send` | operator hand-rail; ungated plumbing (P2) — voice users have `propose_command` |
| `GET\|PUT /api/settings` | config surface; client reads a structured body; separate track (see follow-up) |
| `POST /api/plans/:id/execute` | held — needs a REST pane-write seam (`c55.9`) |
| vite middleware / static asset serving | non-action infrastructure, not a capability (NB: `get_health` is already a registry def, not inline) |

The module header carries P1 + P2 (§3).

### 4.2 Drop `opts.only` — `server.ts` — **DEFERRED (not in c55.8)**

The end-state goal is to delete the `{ only: new Set([...]) }` filter so `mountRestRoutes` mounts every
registry rest-def with no allow-list. **This is blocked** today: registry defs deliberately held out of
`opts.only` (e.g. `set_capability_gate`) have REST paths that collide with surviving inline routes whose
held semantics differ. Dropping the filter must wait until those held items resolve. Tracked as the
final step of the §10 program — **not implemented in this batch.**

### 4.3 The no-twin guard — `tests/test_no_inline_twins.ts` (new)

A deterministic unit test that statically scans `server.ts` for `app.<verb>('/api/…')` literals and
asserts **every one is present in the declared-inline catalog (§4.1)**. Fails CI on any undeclared
inline route. This is the lid: a new route must either become a registry def (Janus-aware) or earn a
declared, reasoned exception that a reviewer sees. Convergence stays converged — even as a concurrent
team keeps adding routes — because drift becomes a build failure, not a silent divergence.

### 4.4 Follow-ups (beads, not code in this batch)
- **Settings → WS rewrite** (optional future full convergence): point the React settings callers at the
  `settings_updated` WS frame they already receive and drop the body-read, so settings can become a
  normal def. Deferred — settings is "separate/grey." File as a c55 follow-up.
- Already filed: `c55.9` (execute_plan REST seam), `c55.10` (grey-area gates: `send_keys`, watch-rule /
  plan writes).

## 5. End state

**After c55.8 (the lid):**
```
  server.ts = hub + ~30 declared-inline routes (each categorized + justified in the catalog)
  opts.only = retained for now (mount allow-list); registry still the single definition home
  guard test = the lock — server.ts can gain NO undeclared route without failing CI
```
**Ultimate end state (after the §10 program):** the untwinned families are registry defs, the held
collisions are resolved, `opts.only` is dropped, and the catalog shrinks to the genuine permanent
exceptions (drafts, settings, raw-input, infra).

## 6. Testing & verification

- **Guard test green** (§4.3) — and a deliberate negative check: a temporary stray `app.get('/api/x')`
  makes it fail (proves the lid actually bites).
- **Catalog-matches-reality check** — every declared-inline entry corresponds to a real inline route
  (no stale entries), and every real inline route is declared (no missing entries). This is the same
  assertion as the guard from the other direction; implement as one test with both directions.
- **Full battery green after dropping `opts.only`** — `npm run lint && npm test && npm run test:e2e &&
  npm run build`, plus `npm run catalog` clean. This proves mounting *all* rest-defs neither broke a
  surface nor double-registered against a surviving inline route.

## 7. Risks & mitigations

- **A rest-surface def excluded by `opts.only` for a reason.** Dropping the filter mounts every
  `surfaces:['…','rest']` def. If any such def was intentionally unmounted (not ready, or its inline
  twin still serves it), it gets newly exposed. *Mitigation:* before deleting the filter, enumerate
  rest-surface defs **not** currently in `opts.only`; for each, confirm its inline twin is gone (else
  the guard flags a double-registration) and that it is intended to be live. The guard + full e2e
  backstop this.
- **The inline set has drifted since A–G** (the repo is hot; the multi-cli team keeps adding routes —
  e.g. raw-input, restart-resume). *Mitigation:* the catalog is built from the guard's first run
  against the **current** `server.ts`, not from this doc's illustrative list. Every undeclared route is
  triaged at implementation: convert-to-def vs. declared-exception-with-reason.
- **Settings stays inline "temporarily" forever.** Accepted: it is a documented, reasoned exception
  with a follow-up bead, not silent debt. The guard keeps it visible.

## 8. Out of scope
Converting settings or drafts into registry defs; the execute_plan REST seam (`c55.9`); grey-area gate
tightening (`c55.10`); any change to the multi-cli team's shipped inline routes (raw-input etc.) beyond
declaring them in the catalog.

## 9. Open decisions
None blocking. The one soft choice — whether to ever fully converge settings (translator vs.
rewrite-to-WS) — is deferred to a follow-up bead; c55.8 declares it inline either way.

## 10. The convergence program (post-lid, sequenced beads)

c55.8 lands the lid; the remaining inline surface converges in sequenced batches, each mirroring the
c55 A–G discipline (HTTP-level contract test first, then cut over, then verify). Order is rough — the
read endpoints are cheapest, the held collisions gate the final `opts.only` drop:

1. **Read endpoints** → rest-only defs (`ledger`, `attention`, `plans`, `recipes`). Likely need
   `rest.toHttp` for structured bodies; no gating questions.
2. **Notes** → registry defs (project notes ×2, note edit/delete, pane notes). Ungated plumbing (P2).
3. **Archive** → registry defs (list/restore/delete). Plumbing.
4. **Project / pane lifecycle** → registry defs (project update/delete, pane delete/stop, add context).
   Some are consequential (delete) → gated per P2.
5. **Approvals / pending (HiTL)** → registry defs (`actions/pending`, `confirm`, `cancel`,
   `commands/pending`, `approve`). The human-in-the-loop surface; gating is the whole point — design care.
6. **Resolve held collisions + drop `opts.only`** (the terminal step): author the bulk `set_pane_gates`
   action (capability-gates split), settle `create_project`'s 2nd mutation, land the `execute_plan` REST
   seam (c55.9), then delete the `opts.only` filter and tighten the guard to also flag inline routes that
   shadow a *mounted* def.

Each step removes its rows from the declared-inline catalog (the guard enforces no stale entries), so the
catalog visibly shrinks toward the genuine permanent exceptions as the program completes.
