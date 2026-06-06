# c55 Close-Out Roadmap — terminal state of the REST→registry "contract convergence"

**Status:** living roadmap (one item DONE, four queued)
**Date:** 2026-06-05
**Worktree:** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-10-gates`
**Audience:** an implementer (or director) with ZERO prior context on c55.

---

## 0. One-screen orientation (read first)

**What c55 is.** A program to make every capability exactly ONE `ActionDef` under `src/actions/`.
Voice, REST, and WebSocket are PROJECTIONS of that one def via `runAction(...)` + `mountRestRoutes(...)`.
The goal end-state: `server.ts` hand-written inline `app.<verb>('/api/...')` routes shrink to a small,
DECLARED set of exceptions, and a guard (`tests/test_no_inline_twins.ts`) fails CI if an inline route
and its catalog row (`src/actions/inlineExceptions.ts`) ever drift apart.

**Why there is still work.** Four inline routes are still flagged `category:"held"` in the catalog
(`inlineExceptions.ts:44-47`) — each blocked on a real semantic gap that stops the registry def from
faithfully replacing the inline route. The TERMINAL move of the whole program is to delete the
`opts.only` allow-filter on the single `mountRestRoutes(...)` call so the registry auto-serves EVERY
rest-surface def. That drop is **safe only after the three path-colliding held rows are resolved at
the source.**

**The two cross-cutting invariants nothing may break:**
- **§8.1b matrix invariants** (`tests/test_action_registry.ts:204-221`): `deriveCapabilities(REGISTRY)`
  is a SUBSET of `ALL_CAPABILITIES`, and `ALL_CAPABILITIES` EQUALS the `CAPABILITY_DEFS` id-set. The
  capability-gate matrix is DERIVED-but-cross-pinned across `src/gateSurface.ts`, `src/actions/capabilities.ts`,
  `src/types.ts`, and `e2e/harness.ts` — any new cap id must land in ALL of them in lockstep.
- **No-twin guard** (`tests/test_no_inline_twins.ts`): a route deletion and its catalog-row deletion
  MUST land in the same change, or CI goes RED (STALE if only the route is removed; UNDECLARED if only
  the row is removed). The guard is a RAW-TEXT scan, so a commented-out `app.<verb>('<path>')` line in a
  cutover breadcrumb re-triggers it — cutover comments must be PROSE-ONLY.

**P2 gating taxonomy (why some converged defs gate and some do not):** orchestration plumbing
(navigate / arrange / manage / drafts / resize / status reads) is UNGATED ("Janus doing the work of
Janus"); reading terminal RESULTS is GATED (privacy + context-window protection); consequential CLI
acts + safety/lock changes are GATED. **P1:** `surfaces[]` makes an action COMMANDABLE; the Auto/Ask/Off
gate matrix ALONE governs UNPROMPTED proactivity (voice exposure costs no autonomy).

---

## 1. Status of the 5 remaining close-out items

Legend: `[x] DONE` · `[~] DESIGNED, not yet implemented` · `[!] BLOCKED on an upstream seam`

| # | Item | State | Design doc |
|---|---|---|---|
| 1 | **c55.10** — gate the 7 "ALWAYS_ALLOWED-during-cutover" defs | **`[x]` DONE (committed `2cbb55b`) — 1 product decision to ratify** | [2026-06-05-c55-10-gating-policy-design.md](./2026-06-05-c55-10-gating-policy-design.md) |
| 2 | **set_pane_gates** — converge the BULK per-pane gate-map PUT (P-1 of opts.only drop) | **`[~]` DESIGNED, ready to implement** | [2026-06-05-c55-16-set-pane-gates-design.md](./2026-06-05-c55-16-set-pane-gates-design.md) |
| 3 | **create_project 2nd-mutation** — port the post-create rename so `POST /api/projects` can be deleted (P-2) | **`[~]` DESIGNED, ready to implement** | [2026-06-05-c55-16-create-project-2nd-mutation-design.md](./2026-06-05-c55-16-create-project-2nd-mutation-design.md) |
| 4 | **attention/clear path-alias** — `POST /api/attention/clear` over `dismiss_attention` (P-3) | **`[~]` DESIGNED (downgrade `held`→`exception` is the recommended default); separate track** | covered in the opts.only-drop design §2 P-3 |
| 5 | **opts.only drop + shadow guard** — the TERMINAL step (Batch H) | **`[!]` BLOCKED — gated on items 2, 3, and the `execute_plan`/c55.9 seam (P-4)** | [2026-06-05-c55-16-opts-only-drop-guard-design.md](./2026-06-05-c55-16-opts-only-drop-guard-design.md) |

### Item-by-item

**1. c55.10 — DONE (`2cbb55b`, branch `feat/c55.10-gate-tightening`).** Four rest-only defs flipped from
`ALWAYS_ALLOWED` to default-`Ask` via `ctx.gateOrDefer`: `send_keys` (NEW cap), `add_watch_rule`
(existing matrix row un-reserved), `remove_watch_rule` (NEW cap), `delete_orchestrator_plan` (NEW cap).
`resize_pane` / `clear_history` / `clear_exited` stay ungated. The 24-row matrix grew to 27, in lockstep
across all 7+ pinned sources. Battery green (lint 0, build 0, convergence 50/50, catalog no-drift 0,
full suite 1313/1313). NO push / bd / gh. **Carries one open PRODUCT DECISION (below) and one accepted
scope-out (durable cross-restart Ask-replay).** See the policy table in §3.

**2. set_pane_gates — DESIGNED.** Mints a NEW rest-only def `set_pane_gates` that converges the inline
`PUT /api/projects/:projectId/panes/:paneId/capability-gates` (the operator matrix-editor's BULK
whole-map override writer). It reuses the EXISTING `set_capability_gate` capability row (so the matrix
does NOT grow — §8.1b holds with zero matrix edits) and rides a `rest.toHttp` hook to reproduce the
inline route's `200 {success,capabilityGates}` / `404 {error}` contract byte-for-byte. The voice
`set_capability_gate` tool STAYS (single-entry, tighten-only); only its dormant, never-mounted `rest`
binding is removed and its `surfaces` flip to `{voice}` — which REQUIRES a new `INTENTIONAL_ASYMMETRY`
row or the §8.4 coverage guard reds. This is P-1 of the opts.only drop.

**3. create_project 2nd-mutation — DESIGNED.** Extends the existing `create_project` def with an
optional `name` param + a `coerceArgs` shim (aliases the client body `{id, keyTerms, name}` → snake
keys ONLY when the snake key is absent) + a SECOND in-handler ledger mutation
(`renameProject(project_id, name)`, iff `name` truthy) before the single `broadcastLedgerUpdate()`.
Adds NO capability (`create_project` is already a matrix row), so §8.1b is untouched. The client never
reads the response body, so the `{success:true}`→`{output}` delta is invisible. This is P-2 of the
opts.only drop.

**4. attention/clear path-alias — DESIGNED, SEPARATE TRACK.** `POST /api/attention/clear` is a thin
inline shim that already executes `runAction('dismiss_attention', {})` — there is NO logic twin, only a
PATH alias. It is NOT a path collision (its registry counterpart `dismiss_attention` is mounted on a
DISTINCT path `/api/attention/:id/dismiss`), so it does NOT block the opts.only drop. Recommended
default: re-categorize the catalog row `held`→`exception` (a permanent, logic-free alias), keeping the
shim. Optional alternative: a multi-path `rest.aliases[]` seam — only if independently wanted. **This is
a separate track from the three colliding held rows** (see §4).

**5. opts.only drop + shadow guard — BLOCKED (terminal step).** Deletes the `opts.only` allow-set from
the single production `mountRestRoutes(...)` call so the registry auto-serves every rest-surface def,
and ADDS a shadow check to the no-twin guard (no declared inline exception may share `verb +
normalized-path` with a def the registry would mount). It is gated on items 2 and 3 landing AND on the
`execute_plan`/c55.9 decision (P-4). See the critical path in §2.

---

## 2. The dependency-ordered critical path to dropping `opts.only`

**The terminal step (item 5) is the architectural goal of the whole program.** It is safe ONLY when
every rest-surface def that would now auto-mount lands on a path that NO surviving inline route also
serves. Of the 38 registry `rest.path` bindings, EXACTLY THREE collide with a surviving inline route —
and all three are the known `held` rows. The collision math is the precondition set:

```
                        ┌─────────────────────────────────────────────────────────┐
                        │  TERMINAL STEP (item 5, Batch H)                          │
                        │  drop opts.only  +  add no-twin SHADOW guard              │
                        │  (registry auto-serves every rest-surface def)            │
                        └───────────────▲─────────────────────────────────────────┘
                                        │ (all three colliding held rows resolved at SOURCE)
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
  ┌─────┴──────┐                 ┌──────┴───────┐                 ┌──────┴────────────────┐
  │ P-1        │                 │ P-2          │                 │ P-4  execute_plan      │
  │ set_pane_  │                 │ create_      │                 │ POST /api/plans/:id/   │
  │ gates      │                 │ project      │                 │ execute                │
  │ (item 2)   │                 │ 2nd-mutation │                 │  ── INPUT VARIABLE ──  │
  │ DESIGNED   │                 │ (item 3)     │                 │  branched on c55.9     │
  └────────────┘                 │ DESIGNED     │                 └──────▲────────────────┘
                                 └──────────────┘                        │
                                                          ┌──────────────┴──────────────────┐
                                                          │  c55.9 — REST pane-write seam     │
                                                          │  (ARCHITECTURAL BLOCKER)          │
                                                          │  a non-refusing dispatchProposal  │
                                                          │  injected by buildRestActionContext│
                                                          └───────────────────────────────────┘

  NOT on the critical path (collision-free, separate track):
  • P-3 attention/clear  → downgrade held→exception (or multi-path seam); does NOT block the drop
```

**The three path-colliding held rows (the entire precondition set for the drop):**

| Held inline route | Colliding registry def | Resolution | Item |
|---|---|---|---|
| `PUT …/capability-gates` | `setCapabilityGate` (locks.ts:310, `voice,rest`) | author `set_pane_gates`; drop `set_capability_gate`'s rest binding → `{voice}` | 2 |
| `POST /api/projects` | `createProject` (orient.ts, `voice,rest`) | add `name` param + 2nd mutation; converge | 3 |
| `POST /api/plans/:id/execute` | `executePlan` (orchestration.ts, `voice,rest`) | **branch on c55.9** (see below) | P-4 |

### c55.9 is the architectural blocker feeding the terminal step

**P-4 (`execute_plan`) cannot resolve until c55.9 is decided.** The held reason is real:
`executePlan`'s handler routes step 1 through `ctx.dispatchProposal`, which `buildRestActionContext`
injects as a **REFUSING STUB** on the REST surface (`() => ({ kind:"error", text:"pane-write is not
available on the REST surface" })`). Auto-mounting `execute_plan` as-is would make the UI "Run plan"
button always refuse — a real regression. So **c55.9 (a REST-capable pane-write seam — a non-refusing
`dispatchProposal` the REST context can inject) is the architectural blocker** that decides P-4:

- **Branch C9-CONVERGE** — if c55.9 lands a working REST `dispatchProposal`: `execute_plan` converges
  with NO def change (it already binds the path) — just delete the inline route + the held catalog row.
- **Branch C9-EXCEPTION** — if c55.9 is NOT ready: prevent the def from mounting by removing its `rest`
  binding (`surfaces:{voice}`), keep the inline route, and re-categorize the held row `held`→`exception`.
  This UNBLOCKS the opts.only drop WITHOUT c55.9 — the voice path is unaffected (voice keeps its own
  working connection-scoped `dispatchProposal`). This branch must add `execute_plan: new Set(['voice'])`
  to `INTENTIONAL_ASYMMETRY`.

**Either branch leaves the system shadow-clean**, so the opts.only drop can proceed once items 2 and 3
land and P-4 picks a branch.

### Dependency-ordered execution sequence

1. **Land the shadow guard RED-first** (add the shadow `describe` + the no-`held`-rows gate to
   `tests/test_no_inline_twins.ts`). It reports exactly THREE shadows today — the executable precondition set.
2. **Item 2 (set_pane_gates / P-1)** — resolves the capability-gates collision at source.
3. **Item 3 (create_project 2nd-mutation / P-2)** — resolves the `/api/projects` collision at source.
4. **P-4 (execute_plan)** — pick the c55.9 branch (CONVERGE or EXCEPTION). Resolves the third collision.
5. **Item 4 (attention/clear / P-3)** — downgrade the held row `held`→`exception` (separate track; can
   land any time, but the no-`held`-rows gate requires it before step 6).
6. **TERMINAL — drop `opts.only`** (item 5). Pre-check: shadow guard GREEN + no-`held`-rows GREEN. Then
   delete the `{ only: new Set([...]) }` arg at the single `mountRestRoutes(...)` call, and sweep the
   ~7 batch text-scan guards that anchor on the `only: new Set([` literal to assert registry membership
   instead.

---

## 3. c55.10 final policy table (as implemented in `2cbb55b`)

| cap | prior gate | final gate | rationale |
| --- | --- | --- | --- |
| `send_keys` | ALWAYS_ALLOWED | **Ask** (NEW cap row) | `term.writeInput` straight to the live PTY — the most consequential CLI keystroke act; rest-only twin of the gated voice write. Own row so the raw-REST channel tunes independently of `write_to_pane` spotlight semantics. |
| `add_watch_rule` | ALWAYS_ALLOWED | **Ask** (EXISTING row un-reserved) | Creating an autonomous rule that fires a command on a pane transition is a safety-config/automation change. Row already existed (reserved) at Ask — wired the def to it; zero matrix-source id churn. |
| `remove_watch_rule` | ALWAYS_ALLOWED | **Ask** (NEW cap row) | Mirror safety-config change to `add_watch_rule` (symmetry). |
| `delete_orchestrator_plan` | ALWAYS_ALLOWED | **Ask** (NEW cap row) | Permanently deletes a plan (destructive) — mirrors c55.14's gating of `delete_pane`/`delete_project`. |
| `resize_pane` | ALWAYS_ALLOWED | ALWAYS_ALLOWED (unchanged) | Viewport plumbing (Janus-of-Janus); no CLI act / result read / safety change. P2 keeps orchestration plumbing ungated. |
| `clear_exited` | ALWAYS_ALLOWED | ALWAYS_ALLOWED (unchanged) | Archives already-exited panes — reversible, not a hard delete (`archive_pane`'s own default is Auto). |
| `clear_history` | ALWAYS_ALLOWED | ALWAYS_ALLOWED (unchanged) | Clears the local `.janus_history.json` display/metadata buffer — neither a result-read nor a CLI act. The `clear_history` matrix row stays reserved/unwired (deliberate; flipping later needs no new cap id). |

### OPEN PRODUCT DECISION carried by c55.10 (must be ratified)

The 4 newly-gated caps are **NOT spotlight-eligible** (only `write_to_pane` / `deliver_handoff` are), so
OFF-CONTEXT the DEFAULT REST result is now **202-deferred, not 200**. The React operator-UI handlers
`handleCreateWatchRule` / `handleDeleteWatchRule` / `handleDeletePlan` (App.tsx ~763-804) and
`handleExecuteBroadcast` (App.tsx ~850-874) do NOT branch on `res.ok` / 202 — they immediately re-fetch
+ play a success earcon. **Net default UX: the operator clicks Delete-rule / Create-rule /
send-keystrokes, hears success, sees the list UNCHANGED, with no "pending approval" indication.** App.tsx
was untouched by design. Two options:
- **(i)** explicit director sign-off that "silent defer with no client surface" is acceptable for these
  buttons, OR
- **(ii)** a follow-up to teach those handlers to surface the 202 pending state.

This is the single load-bearing product decision for c55.10. (Accepted scope-out, separately: durable
cross-restart Ask-replay — `buildActionRun` in `src/actionEffects.ts` has no case for the 3 new caps, so
an Ask→confirm AFTER a process restart degrades to a no-op string; in-process Ask→confirm replays
correctly; `ctx.versionStamp` is passed so a drifted intent quarantines.)

---

## 4. Separate tracks (explicitly NOT on the opts.only critical path)

These are intentionally carved out so the terminal drop is not entangled with unrelated convergence debt:

- **attention/clear path-alias** (item 4) — collision-free; `dismiss_attention` is mounted on a distinct
  path. Resolve by downgrading the catalog row `held`→`exception` (recommended) or a multi-path
  `rest.aliases[]` seam. Required only to satisfy the no-`held`-rows gate, NOT to prevent a shadow.
- **settings routes** — `GET/PUT /api/settings` are declared `exception` rows. The client reads a
  structured body (`{settings, globalPermissionsMode}`); their convergence (settings→WS rewrite) is a
  follow-up on its OWN track, unrelated to opts.only.
- **drafts routes** (×4) — operator hand-rail; ungated plumbing per P2; declared `exception`. Voice uses
  `propose_command`. Separate track.
- **raw-input** — `POST /api/terminals/:id/raw-input` is the multi-CLI raw-keystroke path with a
  bifurcated gate inline (`write_to_pane`); declared `exception`, future-converge. Separate track.

None of these four exception tracks claims a path that any registry def declares, so dropping
`opts.only` introduces zero new double-registration against them — the shadow guard (added in the
terminal step) is the durable replacement for the `only:` allow-list's implicit protection.

---

## 5. The cross-pinned matrix sources (reference for any new cap id)

Any new capability id (as c55.10 did for `send_keys` / `remove_watch_rule` / `delete_orchestrator_plan`)
must land in ALL of these in lockstep, or §8.1b / the totality tests red:

- `src/types.ts` — `CapabilityGate` union (+ optionally `DEFAULT_CAPABILITY_GATES`)
- `src/gateSurface.ts` — `ALL_CAPABILITIES`, `CAPABILITY_LABELS` (plain-language, NO underscore),
  `CAPABILITY_CATEGORIES` (exactly one category each)
- `src/actions/capabilities.ts` — `CATEGORY` map + `CAPABILITY_DEFS` (carry `defaultGate`)
- `e2e/harness.ts` — `DEFAULT_MOCK_GATES` (Partial; parity, non-mandatory)
- `tests/test_action_registry.ts` — the §8.1b `golden` map (MANDATORY — every `CapabilityDef` must have
  a golden pin or the build fails)
- `tests/test_gate_surface.ts` — local `ALL_CAPABILITIES` + expected category golden
- Regenerate (do NOT hand-edit) `docs/CAPABILITIES.md` (`npm run catalog`; `CATALOG_CHECK=1` no-drift
  gate) and `tests/fixtures/voice-tool-goldens.json` (via its rewrite-flag writer; additive-only).

Items 2 and 3 are the deliberate "zero new cap id" levers: `set_pane_gates` reuses the existing
`set_capability_gate` row, and `create_project` adds only a param — both leave §8.1b untouched.
