# c55.16 — Drop `opts.only`, Tighten the No-Twin Guard (the TERMINAL convergence step)

**Status:** Design + TDD impl plan. Decision-gated (this is Batch H from the master spec
`docs/superpowers/specs/2026-06-05-c55-rest-registry-convergence.md` §"Migration Order").
**Worktree this targets:** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-10-gates`
**Author context:** written for an implementer with zero prior context. Every file:line
citation below was read against the live worktree at authoring time — re-verify before editing.

---

## BLUF

Two coupled moves close the REST→registry convergence:

1. **Drop the `only:` allow-set** from the single `mountRestRoutes(...)` call in `server.ts`
   (~line 1192) so the registry auto-serves **every** rest-surface def. This is safe **only
   after** the last three path-colliding inline routes (`create_project`, `set_capability_gate`,
   `execute_plan`) are each either CONVERGED or RE-DECLARED as a permanent exception — because
   those three are the *only* registry defs whose `rest.path` matches a surviving inline route.
2. **Tighten the no-twin guard** (`tests/test_no_inline_twins.ts`) to add a **shadow check**: no
   declared inline exception may share `verb + normalized-path` with a def the registry would
   MOUNT. Today the guard only proves the catalog and `server.ts` are in lockstep; it does not
   catch a *registry* def silently shadowed (or shadowing) an inline route once the filter is
   gone. The shadow check is what makes dropping `only:` safe to keep dropped.

The collision math is decisive: of the **38** registry `rest.path` bindings, **exactly three**
collide with a surviving inline route — and all three are the already-known HELD rows. Every
other surviving inline exception (drafts×4, settings×2, raw-input×1, plus the 2 infra) lives on a
path **no** registry def claims, so removing the filter introduces **zero** new double-registration.

---

## 1. Current State (grounded)

### 1.1 The mount call and its filter

`server.ts` registers all hand-written inline routes first (lines 396–1052), THEN calls
`mountRestRoutes` once at **server.ts:1192**:

```ts
mountRestRoutes(app as unknown as RestApp, REGISTRY, buildRestActionContext, {
  only: new Set([ /* ~50 names across c55 Batches A–G + cv1 reads */ ]),
});
```

`mountRestRoutes` (`src/actions/rest.ts:74`) iterates the registry and skips a def unless it is
rest-surfaced AND in the filter:

```ts
for (const def of registry) {
  if (!def.surfaces.has("rest") || !def.rest) continue;   // rest.ts:81
  if (opts?.only && !opts.only.has(def.name)) continue;   // rest.ts:82  ← the filter
  const { method, path } = def.rest;
  ...
  app[method](path, handler);                             // rest.ts:107
}
```

`opts.only` is documented (rest.ts:66–69) as an **incremental-cutover allow-filter**: omitting it
"mounts all rest-surface defs." So dropping the filter is a one-token change *in the function's
contract* — the risk is entirely in `server.ts`'s route inventory, not in `rest.ts`.

**Registration order matters.** Express keeps the **first** matching handler for a given
method+path. The inline routes register at lines 396–1052; the mount runs at 1192. So if a
registry def's `rest.path` equals an inline route's path, **the inline route wins and the registry
def is dead (shadowed)** the moment `only:` stops excluding it. This is the failure mode the
shadow guard exists to make loud.

### 1.2 The 14 surviving inline routes == the 14-row catalog

`tests/test_no_inline_twins.ts` text-scans `server.ts` for `app.<verb>('<path>')` and
set-equality-checks the result against `INLINE_EXCEPTIONS` (`src/actions/inlineExceptions.ts`).
At authoring time the live `app.<verb>` routes in `server.ts` are exactly:

| line | route | catalog row |
|---|---|---|
| 396 | `use /api` | infra |
| 696 | `post /api/terminals/:id/raw-input` | exception (raw-input) |
| 756 | `post /api/projects` | **held — create_project** |
| 810 | `put /api/projects/:projectId/panes/:paneId/capability-gates` | **held — set_capability_gate** |
| 914 | `post /api/attention/clear` | **held — attention/clear alias** |
| 945 | `post /api/plans/:id/execute` | **held — execute_plan** |
| 998 | `get /api/panes/:projectId/:paneId/draft` | exception (drafts) |
| 1004 | `put /api/panes/:projectId/:paneId/draft` | exception (drafts) |
| 1015 | `get /api/projects/:projectId/drafts` | exception (drafts) |
| 1022 | `post /api/panes/:projectId/:paneId/draft/send` | exception (drafts) |
| 1036 | `get /api/settings` | exception (settings) |
| 1040 | `put /api/settings` | exception (settings) |
| 1361 | `get *` | infra (SPA catch-all) |

(line 665 is the **commented-out** `// app.use("/api", …)` — the guard's known raw-text
limitation dedups it into the live `use /api` key, a documented no-op; see test header note.)

So the catalog has 14 rows = 2 infra + 4 drafts + 2 settings + 1 raw-input + **4 held**.

### 1.3 The four "held" rows — what blocks the drop

```ts
// src/actions/inlineExceptions.ts:43-47
{ method: "post",   path: "/api/projects",                                             category: "held", reason: "create_project: inline does a post-create rename (2nd mutation) the def lacks" },
{ method: "put",    path: "/api/projects/:projectId/panes/:paneId/capability-gates",   category: "held", reason: "BULK gate map-write; set_capability_gate def is single-entry tighten-only — needs set_pane_gates" },
{ method: "post",   path: "/api/plans/:id/execute",                                    category: "held", reason: "execute_plan: registry handler's dispatchProposal is a refusing stub on REST — needs a REST pane-write seam (c55.9)" },
{ method: "post",   path: "/api/attention/clear",                                      category: "held", reason: "thin shim delegating to runAction('dismiss_attention',{}) — path-alias pending multi-path rest binding" },
```

Of these four, **THREE have a path-colliding registry def** and one does NOT:

| held inline route | colliding registry def | collides? |
|---|---|---|
| `post /api/projects` | `createProject` — `rest:{post,/api/projects}` (orient.ts:153, surfaces `voice,rest`) | **YES** |
| `put …/capability-gates` | `setCapabilityGate` — `rest:{put,/api/projects/:projectId/panes/:paneId/capability-gates}` (locks.ts:310, surfaces `voice,rest`) | **YES** |
| `post /api/plans/:id/execute` | `executePlan` — `rest:{post,/api/plans/:id/execute}` (orchestration.ts:120, surfaces `voice,rest`) | **YES** |
| `post /api/attention/clear` | `dismissAttention` — `rest:{post,/api/attention/:id/dismiss}` (orient.ts:192) | **NO** (different path) |

The first three are time bombs: drop `only:` today and each registry def auto-mounts on the SAME
path as its inline twin → silent double-registration where the inline route shadows the (now-live)
registry handler. **These three are the entire precondition set for the drop.** `attention/clear`
is NOT a collision — its registry counterpart `dismiss_attention` is already mounted on a *distinct*
path (`/api/attention/:id/dismiss`), so the `clear` alias can remain an inline exception forever
with no shadow.

### 1.4 Why the other surviving exceptions are collision-free

Cross-checking the full 38-entry registry `rest.path` inventory (grep of `src/actions/defs/**`)
against the 7 surviving *action* inline routes:

- drafts: `/api/panes/:projectId/:paneId/draft`, `.../draft/send`, `/api/projects/:projectId/drafts`
- settings: `/api/settings` (get + put)
- raw-input: `/api/terminals/:id/raw-input`

**No registry def declares any of these paths.** (The registry's pane-write family lives on
`/api/terminals`, `/api/terminals/:pane_id/{restart,input,resize,history/clear}`,
`/api/terminals/clear-exited` — none is `/raw-input`. No def touches `/draft*` or `/settings`.)
Therefore, after the three held collisions are resolved, dropping `only:` mounts the full registry
with **zero** path overlap against any surviving inline exception.

---

## 2. Preconditions to drop `opts.only` (against the CURRENT catalog)

The invariant that must hold the instant `only:` is removed:

> **Every rest-surface registry def that would now mount lands on a path that NO surviving inline
> route also serves; and every surviving inline route is a declared exception.**

Concretely, each of the four held rows must reach one of two terminal states. State per row:

### P-1 `set_capability_gate` — **author `set_pane_gates`** (Open Decision #5)
The inline route (server.ts:810) writes a **full/partial gate map verbatim** (loosening allowed —
it is the deliberate UI place to loosen). The registry `set_capability_gate` is **single-entry,
tighten-only** with a voice-loosen refusal (locks.ts:311–369). They are NOT the same capability —
do not overload.
**Resolution = author a NEW def `set_pane_gates`** (bulk, loosening-allowed, operator-direct,
rest-only) bound to the SAME path `put /api/projects/:projectId/panes/:paneId/capability-gates`,
delete the inline route, delete the held catalog row. The existing `set_capability_gate` def keeps
its own path binding — **but note `set_capability_gate.rest.path` is currently the camelCase
capability-gates path too (locks.ts:310), which is the inline route's path.** That binding is a
latent shadow: it must be **repointed or removed** so `set_capability_gate` does not also claim the
path `set_pane_gates` now owns. Cleanest: give `set_pane_gates` the path; **drop the `rest` binding
from `set_capability_gate`** (make it `surfaces: ['voice']`, voice-only — it is a voice meta-tool;
the UI uses `set_pane_gates`). This removes the collision at the registry, not via the filter.

### P-2 `create_project` — **converge the 2nd mutation** (Open Decision #4)
Inline (server.ts:756–777) does `addProject(...)` THEN, if `name` is present, a SECOND mutation
`renameProject(id, name)`. The def (orient.ts:154–169) does only `addProject` — it lacks the
post-create rename.
**Resolution = converge:** extend `CreateProjectParams` with `name: z.string().optional()` and add
the conditional `ctx.manager.ledger.renameProject(project_id, name)` after `addProject` (guarded by
`if (name)`), preserving the existing G5 bad-dir narration and the single `broadcastLedgerUpdate()`.
Then delete the inline route + the held catalog row. The def already binds `rest:{post,/api/projects}`
so the path is already correct.

### P-3 `attention/clear` — **bind the path alias** (Easy, Batch D leftover)
The inline shim (server.ts:914–918) already executes through the registry
(`runAction('dismiss_attention', {})`) — there is NO logic twin, only a PATH alias. It needs
`dismiss_attention` to answer on a SECOND path. Two acceptable resolutions:
  - **(a) multi-path rest binding** (the "Batch H multi-path seam"): teach `ActionDef.rest` to carry
    an optional `aliases: {method,path}[]` and have `mountRestRoutes` register each alias to the same
    handler. Then `dismiss_attention` declares the `clear` alias, the inline shim is deleted, and the
    held row is deleted.
  - **(b) keep it a declared exception** (lowest risk): leave the thin inline shim and re-categorize
    the catalog row from `held` → `exception` (it is a permanent, logic-free path alias — exactly the
    kind of thing the exception tier exists for). **This is the recommended default** unless the
    multi-path seam is independently wanted: it is a no-collision route (no registry def claims
    `/api/attention/clear`), so it passes the shadow guard untouched.

### P-4 `execute_plan` — **INPUT VARIABLE (design for BOTH branches)**
The held reason is real: `executePlan` (orchestration.ts:121–164) routes step 1 through
`ctx.dispatchProposal`, which `buildRestActionContext` injects as a **refusing stub**
(server.ts:1144: `() => ({ kind: "error", text: "pane-write is not available on the REST surface" })`).
Converging it as-is would make the UI "Run plan" button always refuse — a real regression.
The resolution depends on c55.9 (the REST pane-write seam):

  - **Branch C9-CONVERGE** — if c55.9 lands a REST-capable `dispatchProposal` (a non-refusing
    implementation injected by `buildRestActionContext` that can write to a pane on the REST
    surface): then `execute_plan` converges with NO def change — just delete the inline route
    (server.ts:945–970) and delete the held catalog row. Its def already binds
    `rest:{post,/api/plans/:id/execute}`, so the path is correct and it auto-mounts.
  - **Branch C9-EXCEPTION** — if c55.9 is NOT ready (or is deferred): then `execute_plan` must NOT
    auto-mount, because its registry handler would refuse. To keep the working inline route AND drop
    the filter, you must prevent the def from mounting. Since `mountRestRoutes` will no longer have a
    filter, the way to stop a single def mounting is to **remove its `rest` binding** (or its `rest`
    surface) so `mountRestRoutes`'s `!def.surfaces.has("rest") || !def.rest` guard (rest.ts:81) skips
    it. Concretely: set `executePlan.surfaces = new Set(['voice'])` and delete its `rest` field. The
    inline route stays; re-categorize the catalog row `held` → `exception` with the reason "REST
    pane-write seam (c55.9) not yet available; def is voice-only until then." The voice path is
    unaffected (voice keeps its own connection-scoped working `dispatchProposal`, voice/index.ts:21–22).

**Both branches leave the system shadow-clean:** in C9-CONVERGE the inline route is gone and the def
mounts; in C9-EXCEPTION the def does not mount (no rest binding) and the inline route is a declared
exception. The shadow guard (Section 4) passes either way.

### Precondition checklist (all must be TRUE before the one-line drop)
- [ ] `set_pane_gates` authored, bound to the capability-gates path; `set_capability_gate` no longer
      binds that path (voice-only or repointed). Inline route deleted, held row deleted.
- [ ] `create_project` def carries the `name` 2nd-mutation; inline route deleted, held row deleted.
- [ ] `attention/clear` resolved: either multi-path alias bound (inline deleted, row deleted) OR row
      re-categorized `held`→`exception` (inline shim kept).
- [ ] `execute_plan` resolved per c55.9 branch: C9-CONVERGE (inline deleted, row deleted, def mounts)
      OR C9-EXCEPTION (def rest-binding removed, inline kept, row re-categorized `held`→`exception`).
- [ ] **No `held` rows remain in `INLINE_EXCEPTIONS`** (every held row is either converged-and-deleted
      or downgraded to `exception`). This is the machine-checkable gate (see test in §5.4).

---

## 3. The `mountRestRoutes` change (remove the allow-set)

### 3.1 server.ts (the only functional change)

At **server.ts:1192**, change:

```ts
mountRestRoutes(app as unknown as RestApp, REGISTRY, buildRestActionContext, {
  only: new Set([ /* the entire ~50-name block, lines 1193–1346 */ ]),
});
```

to:

```ts
// c55.16 (Batch H terminal step): the registry now auto-serves EVERY rest-surface def. The
// `only:` allow-filter is retired — collision-freedom is no longer enforced by an allow-list
// but PROVEN by the no-twin shadow guard (tests/test_no_inline_twins.ts): no surviving inline
// route shares verb+path with a mounted def. The surviving inline exceptions (drafts, settings,
// raw-input, + any held-downgraded aliases) live on paths no registry def claims.
mountRestRoutes(app as unknown as RestApp, REGISTRY, buildRestActionContext);
```

Delete the entire `only: new Set([...])` literal (lines 1193–1346) and the trailing `,`.

> **No change to `src/actions/rest.ts`.** Its contract already mounts all rest-surface defs when
> `opts` is omitted (rest.ts:78,82). The `opts?: { only?: ReadonlySet<string> }` parameter and the
> `if (opts?.only && !opts.only.has(def.name)) continue;` line should STAY — many unit tests
> (test_rest_mount, test_c55_batch_b/d/f) pass `{ only: new Set([...]) }` to mount one def in
> isolation. Removing the parameter would break those harnesses. We drop the *production caller's*
> use of it, not the capability.

### 3.2 How collision is prevented once the filter is gone

The filter was never the real collision-prevention mechanism — it was a *scaffold* that let the
cutover proceed a few routes at a time. Real collision-freedom rests on three structural facts,
each independently verified by a test:

1. **Path-disjointness.** Every surviving inline exception path is one no registry def declares
   (§1.4). The held collisions are removed at the SOURCE (def converged → inline deleted; or def's
   rest-binding removed → def does not mount). So the set of mounted-def paths and the set of
   surviving-inline paths are disjoint by construction.
2. **The shadow guard makes it stay disjoint** (§4): any future PR that re-introduces an inline
   route on a path a mounted def owns (or vice-versa) fails CI.
3. **Express's first-wins semantics are now irrelevant** because there are no duplicate paths to
   order. (Before this change, the mount-after-inline order meant a colliding inline route silently
   won; after, there are no colliding pairs.)

---

## 4. Tighten the no-twin guard: ADD shadow detection

### 4.1 What the guard proves today vs. what it must also prove

**Today** (`tests/test_no_inline_twins.ts`): two set-equalities between (the `app.<verb>` routes
text-scanned from `server.ts`) and (`INLINE_EXCEPTIONS`): no UNDECLARED inline route, no STALE
catalog entry. It says nothing about the **registry**.

**The gap:** once `only:` is gone, a def and an inline route can collide on a path. The current
guard would still pass (the inline route is a declared exception; the catalog is in lockstep) while
a registry def is silently dead. We must add a third invariant:

> **SHADOW:** No declared inline exception shares `verb + normalized-path` with a registry def that
> `mountRestRoutes` would MOUNT (i.e. `surfaces.has('rest') && !!def.rest`).

### 4.2 Path normalization (the one subtlety)

Express treats `:id` and `:project_id` as the same positional wildcard — `POST /api/plans/:id/execute`
(inline) and `POST /api/plans/:plan_id/execute` (a hypothetical def) collide at the router even
though the param NAMES differ. So the shadow comparison must normalize every `:param` segment to a
single placeholder (e.g. `:*`) before comparing. Method is compared verbatim. (The existing two
checks stay string-exact — they compare server.ts text to the catalog, both of which use the same
literal param names, so normalization there is unnecessary and would loosen them.)

### 4.3 Exact code to ADD to `tests/test_no_inline_twins.ts`

Add the import of the registry, a normalizer, the mounted-def path set, and a third `describe`
block. Insert after the existing two `it` blocks (after line 51), keeping the existing two intact.

```ts
// ── shadow detection (c55.16 / Batch H): once `opts.only` is dropped, the registry auto-mounts
// EVERY rest-surface def. A declared inline exception that shares verb+path with a MOUNTED def is a
// silent double-registration (Express keeps the first-registered handler — the inline route — so the
// registry handler is dead). This guard makes that loud. Param names are normalized (Express treats
// :id and :project_id as the same wildcard), so `/api/plans/:id/execute` collides with
// `/api/plans/:plan_id/execute`.
import { REGISTRY } from "../src/actions/registry";

/** Collapse every `:param` segment to a single placeholder so param-name skew can't hide a collision. */
function normalizePath(p: string): string {
  return p
    .split("/")
    .map((seg) => (seg.startsWith(":") ? ":*" : seg))
    .join("/");
}

/** verb + normalized-path keys for every def mountRestRoutes WOULD register (surfaces:rest && def.rest). */
const mountedDefKeys = new Set(
  REGISTRY.filter((d) => d.surfaces.has("rest") && !!d.rest).map(
    (d) => `${d.rest!.method} ${normalizePath(d.rest!.path)}`,
  ),
);

describe("no-twin guard — no inline exception SHADOWS a mounted registry def (c55.16)", () => {
  it("has NO inline exception sharing verb+path with a def the registry would mount", () => {
    const shadows = INLINE_EXCEPTIONS
      // infra rows (`use /api`, `get *`) are not addressable action routes and never collide.
      .filter((e) => e.category !== "infra")
      .map((e) => ({ entry: e, key: `${e.method} ${normalizePath(e.path)}` }))
      .filter(({ key }) => mountedDefKeys.has(key))
      .map(({ entry }) => `${entry.method} ${entry.path}  [${entry.category}]`)
      .sort();
    assert.deepStrictEqual(
      shadows, [],
      `Inline exception(s) SHADOW a mounted registry def (Express keeps the inline handler — the ` +
      `registry def is dead). Resolve by CONVERGING the route (delete the inline route + catalog ` +
      `row; the def now serves it) OR by removing the def's rest binding so it does not mount:\n  ` +
      `${shadows.join("\n  ")}`,
    );
  });
});
```

### 4.4 Why this guard, run on the PRE-drop tree, will FAIL today (good — it's TDD)

Run as-is against the current catalog, `mountedDefKeys` contains
`post /api/projects`, `put /api/projects/:*/panes/:*/capability-gates`, and
`post /api/plans/:*/execute` (all three defs are `surfaces:rest && def.rest`, regardless of the
`only:` filter — the guard inspects the *registry*, not the *filter*). All three match a `held`
catalog row → the new test reports **three shadows** and fails. That failure IS the precondition
checklist made executable: it goes green only when all three held collisions are resolved at the
source. Write this test FIRST (it red), then resolve P-1/P-2/P-4, then it greens, then drop `only:`.

> **Belt-and-suspenders option (recommended):** also assert no `held` rows remain (§5.4). The shadow
> guard catches the three *colliding* held rows; the no-held-rows guard additionally forces the two
> *non-colliding* dispositions (`attention/clear`, and `execute_plan` in the C9-EXCEPTION branch) to
> be explicitly re-categorized `exception` rather than left dangling as `held`. Together they fully
> pin the terminal state.

---

## 5. Dependency-ordered impl plan (bite-sized TDD)

Hard gate between every step: `npm run lint && npm test` green (CLAUDE.md: unit runner needs
`--test-force-exit`; run `npm run catalog` if the drift guard trips after a def is added/changed).
Order is chosen so the tree is GREEN after each step and `only:` is dropped LAST.

**Step 0 — Land the shadow guard RED-then-instrument.**
Add the shadow `describe` block (§4.3) to `tests/test_no_inline_twins.ts`. Run `npm test` — it must
FAIL with exactly three shadows (create_project, capability-gates, plans/:id/execute). This encodes
the precondition set executably. (Do NOT touch any other file yet.)

**Step 1 — set_pane_gates (P-1).**
- Test first: a new `tests/test_set_pane_gates.ts` exercising the bulk map-write handler
  (loosening allowed, empty-map clears override, invalid entries dropped, 404 on missing pane) +
  a cutover-guard assertion that the inline `app.put('…/capability-gates')` literal is GONE.
- Implement: author `setPaneGates` def (rest-only, ALWAYS_ALLOWED, bulk verbatim map-write,
  `rest:{put,/api/projects/:projectId/panes/:paneId/capability-gates}`) faithfully porting
  server.ts:810–843; add to its group's export + REGISTRY; `npm run catalog`.
- Repoint `set_capability_gate`: drop its `rest` field and set `surfaces:new Set(['voice'])`
  (locks.ts:309–310) so it no longer claims the path. Update coverage/asymmetry allow-list if the
  §8.4 coverage test flags the voice-only narrowing.
- Delete inline route server.ts:810–844. Delete the held catalog row. The shadow guard loses one
  shadow.

**Step 2 — create_project 2nd mutation (P-2).**
- Test first: characterization test — `create_project` with `{name}` performs addProject THEN
  renameProject (one `broadcastLedgerUpdate`), preserves G5 bad-dir narration; cutover-guard
  asserts inline `app.post('/api/projects')` literal GONE.
- Implement: extend `CreateProjectParams` with `name: z.string().optional()`; add
  `if (name) ctx.manager.ledger.renameProject(project_id, name);` after `addProject`
  (orient.ts:166). Delete inline route server.ts:756–777. Delete the held catalog row. Shadow guard
  loses the second shadow.

**Step 3 — execute_plan (P-4) — BRANCH on c55.9.**
- **If c55.9 has landed (Branch C9-CONVERGE):** test that `execute_plan` over a REST ctx with the
  new working `dispatchProposal` dispatches step 1 (not refuses); cutover-guard asserts inline
  `app.post('/api/plans/:id/execute')` GONE. Implement: delete inline route server.ts:945–970,
  delete held catalog row. Def is unchanged (already binds the path). Shadow guard loses the third
  shadow.
- **If c55.9 NOT ready (Branch C9-EXCEPTION):** test that `executePlan.surfaces` is `['voice']` and
  it has no `rest` binding (so `mountRestRoutes` skips it), and that the inline route SURVIVES.
  Implement: set `executePlan.surfaces = new Set(['voice'])`, delete its `rest` field
  (orchestration.ts:119–120); `npm run catalog`. Re-categorize the catalog row `held`→`exception`
  (reason: "REST pane-write seam c55.9 not yet available; voice-only until then"). Inline route
  stays. Shadow guard loses the third shadow (the def no longer mounts, so it is no longer a
  mounted-def key).
- Either way, also flip the existing Batch-B guards
  (`tests/test_c55_batch_b.ts:491,524`) that currently assert execute_plan is OUT of the only-set /
  inline route preserved — those assertions are about the `only:` block (which is being deleted)
  and the inline route (deleted in C9-CONVERGE). Update or remove them deliberately, matching the
  chosen branch.

**Step 4 — attention/clear (P-3).**
- **Default (recommended, no seam):** re-categorize the catalog row `held`→`exception` (reason:
  "permanent logic-free path alias over dismiss_attention; no registry def claims this path"). No
  code change; the inline shim (server.ts:914–918) stays. Add/keep a test asserting the shim still
  routes through `runAction('dismiss_attention', {})`. (No shadow — `/api/attention/clear` is on no
  def's path.)
- **OR (multi-path seam):** extend `ActionDef.rest` with `aliases?: {method,path}[]`, have
  `mountRestRoutes` register each alias to the same handler (one `it` in test_rest_mount), declare
  the `clear` alias on `dismiss_attention`, delete the inline shim, delete the row. (More surface
  area; only do this if the multi-path seam is independently desired.)

**Step 5 — assert no held rows remain (the machine gate).**
Add the no-`held`-rows test (§5.4). It greens only after Steps 1–4. This is the green light for the
drop.

**Step 6 — DROP `opts.only` (the terminal one-liner).**
- Pre-check: shadow guard GREEN, no-held-rows GREEN (so the registry is provably disjoint from the
  surviving exceptions). Update the cv1/batch text-scan guards that read the `only: new Set([` block
  (test_c55_batch_a/d/f, test_c55_11/13/14, test_c55_15 — they all do
  `serverSrc.indexOf("only: new Set([", mountIdx)`). After the drop that anchor disappears; those
  `it`s will break. Update each to assert the route's def is in `REGISTRY` (rest-surfaced) instead
  of "in the only-set string" — the registry membership is now the real cutover proof. (This is a
  mechanical sweep; ~7 test files.)
- Implement: delete the `{ only: new Set([...]) }` arg at server.ts:1192–1347 per §3.1.
- Verify: `npm run lint && npm test`; then a runtime smoke that every previously-only-set route
  still answers (the registry now serves them without the filter) and that the 7 surviving inline
  routes still answer (no def stole their path).

### 5.4 The no-held-rows gate (add to test_no_inline_twins.ts)

```ts
it("has NO `held` rows left in the catalog (every held collision converged or downgraded)", () => {
  const held = INLINE_EXCEPTIONS.filter((e) => e.category === "held")
    .map((e) => `${e.method} ${e.path}`).sort();
  assert.deepStrictEqual(
    held, [],
    `Unresolved held row(s) — cannot drop opts.only until each is converged (delete route+row) or ` +
    `downgraded to "exception":\n  ${held.join("\n  ")}`,
  );
});
```

---

## 6. Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | The drop is gated on resolving the **three path-colliding** held rows, not all four. | `attention/clear` is collision-free (`dismiss_attention` is on a different path); it can stay a permanent exception. Grounded in the 38-path registry inventory vs the 7 surviving inline paths. |
| D2 | Resolve collisions at the SOURCE (converge the def or remove its rest-binding), never by keeping a narrower filter. | The whole point of Batch H is to retire the scaffold. A residual filter would re-introduce the drift the no-twin guard exists to prevent. |
| D3 | Keep the `opts.only` PARAMETER in `rest.ts`; only drop the production caller's USE of it. | Many unit harnesses mount one def in isolation via `{only:new Set([...])}`. Removing the param breaks them for no benefit. |
| D4 | Shadow guard normalizes `:param` names before comparing; the two legacy checks stay string-exact. | Express collides `:id` with `:project_id`; the registry↔catalog checks compare same-literal text and must stay exact to catch typos. |
| D5 | `execute_plan` is an INPUT VARIABLE with two pre-designed branches keyed on c55.9. | c55.9's landing is out of this step's control; both branches leave the tree shadow-clean and the impl plan picks the branch at Step 3. |
| D6 | `set_capability_gate` is repointed to voice-only (rest-binding dropped); a NEW `set_pane_gates` owns the path. | The two have opposite loosen/tighten semantics (Open Decision #5: "do not overload"). The voice meta-tool must not also claim the UI bulk-write path, or it would be the shadow. |
| D7 | Add a no-`held`-rows gate alongside the shadow guard. | The shadow guard only catches *colliding* held rows; the no-held-rows gate forces the non-colliding ones (`attention/clear`, C9-EXCEPTION `execute_plan`) to be explicitly downgraded, fully pinning the terminal catalog. |

---

## 7. Risks & mitigations

- **Silent shadow if a future def reuses a surviving-exception path (e.g. someone authors a
  `/api/settings` def).** → The shadow guard now fails CI on exactly this. It is the durable
  replacement for the `only:` allow-list's implicit protection.
- **Param-name skew hides a collision** (`:id` vs `:plan_id`). → `normalizePath` collapses all
  params to `:*` before comparison.
- **Batch text-scan guards break when the `only: new Set([` anchor disappears** (test_c55_batch_a/d/f,
  test_c55_11/13/14, test_c55_15). → Step 6 explicitly sweeps them to assert registry membership
  instead of only-set-string membership. Do this in the SAME commit as the drop or the suite reds.
- **execute_plan C9-EXCEPTION regresses voice if the rest-binding removal is fumbled.** → Only the
  `rest` field + `surfaces` change; the handler is untouched and voice keeps its own working
  `dispatchProposal` (voice/index.ts:21–22). Covered by the existing voice goldens.
- **create_project rename ordering / double-broadcast.** → Faithful port keeps the SINGLE
  `broadcastLedgerUpdate()` after both mutations (matches inline server.ts:775); characterization
  test asserts exactly one broadcast.
- **`set_capability_gate` narrowed to voice-only trips the §8.4 surface-coverage / asymmetry
  allow-list.** → Update `src/actions/coverage.ts` INTENTIONAL_ASYMMETRY (as `set_voice_mute` does)
  and re-run `npm run catalog`.
- **Catalog drift guard reds after adding `set_pane_gates` / editing defs.** → `npm run catalog`
  regenerates; commit the regenerated artifact (CLAUDE.md gotcha).
- **8.1b matrix invariants** (`deriveCapabilities ⊆ ALL_CAPABILITIES`; `ALL_CAPABILITIES == CAPABILITY_DEFS`).
  `set_pane_gates` should reuse the EXISTING `set_capability_gate` capability (it is the same gate
  surface, just bulk) → no new capability row, so the matrix invariants are untouched. If a new
  capability is minted instead, all four matrix sources must be updated in lockstep.

---

## 8. File touchpoints (exact)

- `server.ts:1192–1347` — delete the `{ only: new Set([...]) }` argument (Step 6).
- `server.ts:756–777` — delete inline `post /api/projects` (Step 2, C9-CONVERGE / always).
- `server.ts:810–844` — delete inline `put …/capability-gates` (Step 1).
- `server.ts:945–970` — delete inline `post /api/plans/:id/execute` (Step 3, **C9-CONVERGE only**).
- `server.ts:914–918` — inline `post /api/attention/clear`: kept (default P-3) or deleted (multi-path seam).
- `src/actions/inlineExceptions.ts:44–47` — delete the 3 converged held rows; downgrade the
  surviving alias/exception rows `held`→`exception`.
- `src/actions/defs/orient.ts:139–169` — `create_project`: add `name` param + rename mutation.
- `src/actions/defs/locks.ts:296–310` — `set_capability_gate`: drop `rest`, set `surfaces:['voice']`.
- `src/actions/defs/<group>.ts` (+ REGISTRY aggregation) — NEW `set_pane_gates` def.
- `src/actions/defs/orchestration.ts:119–120` — `execute_plan`: **C9-EXCEPTION only** — drop `rest`,
  set `surfaces:['voice']`.
- `src/actions/coverage.ts` — INTENTIONAL_ASYMMETRY for the voice-only narrowings.
- `tests/test_no_inline_twins.ts` — ADD shadow `describe` (§4.3) + no-held-rows `it` (§5.4) +
  `import { REGISTRY }`.
- `tests/test_c55_batch_b.ts:491,524` — flip the execute_plan held/only-set assertions to the chosen branch.
- `tests/test_c55_batch_a.ts`, `test_c55_batch_d.ts`, `test_c55_batch_f.ts`, `test_c55_11_reads.ts`,
  `test_c55_13_archive.ts`, `test_c55_14_lifecycle.ts`, `test_c55_15_approvals.ts` — sweep the
  `only: new Set([` text-scan guards to registry-membership assertions (Step 6).
- NEW `tests/test_set_pane_gates.ts`, `tests/test_create_project_rename.ts` — Steps 1–2 characterization.

---

## Adversarial review (c55-closeout workflow)

**Verdict: sound-with-fixes.** This is the TERMINAL convergence step; its preconditions (`set_pane_gates`, `create_project` 2nd-mutation, `execute_plan` per c55.9) are tracked as separate designs and must land first.

### Required fixes

1. **Add a `coerceArgs` to `createProject` that aliases the client body to the schema keys** (`id` → `project_id`, `keyTerms` → `key_terms`) BEFORE deleting the inline route, OR keep the inline route. Without this, deleting the inline `/api/projects` route and auto-mounting the def breaks UI project creation (zod parse fails on missing `project_id` → HTTP 500). Add a characterization test that POSTs the EXACT client body `{id, name, keyTerms,...}` (`App.tsx:1762-1771`) through the mounted def and asserts `addProject`+`renameProject` ran with one `broadcastLedgerUpdate`. *(This is fully designed in the companion `create_project` 2nd-mutation doc — that design IS the precondition for this step's P-2.)*
2. **Add `test_c55_12_notes.ts` to the Step 6 only-set-anchor sweep** (it does the same `serverSrc.indexOf('only: new Set([')` scan at lines 133-143 and asserts 6 names are in the only-set). Re-derive the full sweep set programmatically (grep `tests/` for `only: new Set([` minus the legitimate mount-isolation harness `test_rest_mount.ts`) rather than relying on the hand-listed file set, which is incomplete.
3. **Add `INTENTIONAL_ASYMMETRY` entries (`coverage.ts`) for the new single-surface defs:** `set_pane_gates: new Set(['rest'])`; and, in Branch C9-EXCEPTION, `execute_plan: new Set(['voice'])`. Re-run `npm run catalog`. Otherwise the §8.4 #20 single-surface coverage test reds.
4. **Harden the no-twin guard with a def-vs-def normalized-path uniqueness assertion** (no two rest-mounted defs share `verb+normalizePath(path)`) so the design's "collision-freedom PROVEN by the guard" claim actually holds — specifically to catch the case where `set_capability_gate`'s rest binding is not dropped and co-claims the capability-gates path with the new `set_pane_gates`.
5. **Resolve the `set_pane_gates` capability/status inconsistency:** choose EITHER `capability:'set_capability_gate'` (reuses the matrix row; 8.1b stays green) OR `capability:ALWAYS_ALLOWED` (also 8.1b-safe), and update Step 1 wording accordingly; and fix the test assertion — either drop the "404 on missing pane" expectation (accept `kind:ok` → 200, which the client tolerates) or add a `rest.toHttp` hook to the def to preserve the 404 contract. *(The companion `set_pane_gates` design resolves this as `capability:'set_capability_gate'` + a `toHttp` hook preserving the 404 — adopt that resolution.)*
6. **In Step 1, explicitly confirm `set_pane_gates` fires BOTH `broadcastLedgerUpdate()` and `broadcastTerminalsUpdated()`** (the inline route does both, `server.ts:841-842`) — the client relies on these WS frames (not the HTTP body) to repaint the matrix chips; a faithful port must preserve them or the UI goes stale.

### Issues / verified findings

The structured issues for this doc are the six required fixes above (they each carry their own grounded rationale). The doc's collision math (38 registry `rest.path` bindings; exactly three collide with surviving inline routes; all three are the known HELD rows) is the load-bearing analysis and is sound. The two coupled moves — drop `opts.only` and add the shadow guard — are correctly sequenced (shadow guard RED first, resolve the three collisions at the SOURCE, then drop the filter LAST). Cross-references: P-1 (`set_pane_gates`) and P-2 (`create_project`) are fully designed in their companion docs and must land before this terminal step; P-4 (`execute_plan`) remains an INPUT VARIABLE branched on c55.9, which is the architectural blocker feeding this step (see the closeout roadmap critical-path section).
