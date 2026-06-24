# c55 — REST → Registry Contract Convergence (Design / Spec)

**Status:** Approved 2026-06-05. Execution authorized via the c55 TDD workflow.
**Bead:** `wsm-e2e-pinned-c55` (scoping) → children c55.1…c55.8.
**Branch:** `feat/c55-rest-convergence` (worktree `OrbitalVoiceRunner-wt/c55-convergence`, off `origin/main` @ 36e6038).

---

## North Star

Every capability is **defined exactly once** — a single `ActionDef` in the registry
(`src/actions/registry.ts` + `src/actions/defs/*`) owns its name, zod schema, capability
gate, redaction policy, handler, **and** (new) its REST binding + optional response shaping.

Both surfaces become pure projections of that one object:
- **Voice:** `runAction` → `resultToToolResponse` → Gemini toolResponse.
- **REST:** the **same** `runAction` via `mountRestRoutes` → `resultToHttp` → HTTP.

`server.ts` contains **zero** hand-written `app.<verb>('/api/…')` blocks that twin a
registry action. Change a gate/validation/handler once → the voice command and the UI
button inherit it atomically. The drift hazard (an inline route silently diverging from
its twin — different status codes, param names, a second mutation, a 403 rendered as a
200 string) becomes *structurally impossible* because the inline route no longer exists.

This is the **terminal** state. Strategy C (incremental triage) is the *path*; single
source of truth is the *destination*. No permanent two-tier fork.

## End-State Architecture

The entire REST surface is produced by one call:
`mountRestRoutes(app, REGISTRY, buildRestActionContext)` — with `opts.only` **removed**.

Cutover is staged via the existing `opts.only` allow-set (`server.ts:1521-1532`). Each
step **adds names to `opts.only` AND deletes the matching inline block in the same
commit**, so there is never both an inline route and a mounted route for one path (Express
lets the first-registered handler win and would silently mask the cutover).

Param-name skew is resolved at the registry, never in `server.ts`:
- **Route params** (`:id`/`:projectId`/`:paneId`/`:plan_id`) → write `rest.path` with
  snake_case segments (`/api/projects/:project_id/rename`) so Express params land directly
  on zod keys.
- **Body params** (camelCase client payloads: `sourcePaneId`, `recipeId`,
  `terminalId`…) → the def's existing `coerceArgs(raw)` hook maps camel→snake before zod.

Two guard tests lock the invariant:
1. **Coverage** — every def with `surfaces.has('rest')` has a reachable `rest` binding.
2. **No-twin guard** — `server.ts` contains no `app.<verb>('/api/…')` literals outside the
   allowlisted non-action endpoints (vite middleware, health probe, static).

## The One New Primitive — `rest.toHttp`

~99% of routes ride the default `{output:string}` body (200). A handful of **page-load
reads** return a structured fact-sheet the flat string cannot carry, and they fire
*before* any WebSocket frame exists to lean on. For those only, add an **optional,
declarative** escape hatch on the def's REST binding:

```ts
// ActionDef.rest: { method, path } → add:
toHttp?: (result: ActionResult, args: Record<string, unknown>) => { status: number; body: unknown }
```

`mountRestRoutes` dispatches through `applyResultToHttp(def, result, args, res)`:
```ts
if (def.rest?.toHttp) { const { status, body } = def.rest.toHttp(result, args); return res.status(status).json(body); }
return resultToHttp(result, res); // unchanged default map
```

Properties:
- The hook reads `result.output` (already typed `unknown`, so a handler may stuff a rich
  structure in) and re-projects it to the exact legacy body.
- The **voice path never consults `toHttp`** — it keeps reading `result.output` via
  `resultToToolResponse`. So a structured `output` must narrate sanely for voice, **or**
  the def is `surfaces: new Set(['rest'])` when the shape is pure-UI.
- **Status via kinds is preferred over `toHttp` wherever possible.** `create_pane` /
  `apply_orchestration_recipe` must status-branch (403 Off / 202 Ask). The fix is to make
  the handler **return `kind:'blocked'`/`kind:'pending'`** instead of a voice-shaped
  `kind:'ok'` narration string — `resultToHttp` already maps those to 403/202. No `toHttp`
  needed; only a handler-kind correction (voice still narrates from the same kinds).
  - **Intentional surface asymmetry (bd wsm-e2e-pinned-gb4, not debt):** `deliver_handoff`'s
    blocked branch returns `kind:'blocked'`, which voice renders as a 200-equivalent spoken
    narration (`{ output: result.reason }`) but REST renders as a **403** — deliver is a
    voice-primary gated action and REST is the escape-hatch surface whose drawer button must
    status-branch on a true HTTP failure. Same kind, two faithful renderings; do **not**
    "symmetrize" REST to 200 (pinned by `tests/test_cv2_handoff_rest.ts`).
- `toHttp` is reserved strictly for the ~4 READS whose body is a structured array/object.

## Tier Summary (≈35 twinned routes)

**Free — delete inline, point at registry (client ignores body; live feed repaints):**
`stop_all`, `confirm_stop_all`, `release_stop_all`, `rename_project`, `rename_pane`,
`switch_context`, `dismiss_attention`, `create_orchestrator_plan`, `execute_plan`, plus 5
new thin rest-only defs: `restart_pane`, `send_keys`, `resize_pane`, `clear_history`,
`clear_exited`.

**Easy — one small fix each:** `set_pane_permissions` (route-param alias),
`attention/clear` (2nd path binding for id-omitted `dismiss_attention`),
`apply_orchestration_recipe` (`recipeId` alias + `kind:'blocked'` on layout-Off),
`handoff_context_between_panes` (`coerceArgs` camel→snake), `create_pane` (param alias +
handler returns `blocked`/`pending`).

**Hard — structured reads (need `toHttp`) + net-new actions:** `list_panes` (flat rich
pane array — highest blast radius), `get_stop_all_status` (new readOnly def; the
boot-restore snapshot that motivates the primitive), `GET /api/terminals/:id/history`
(rest-only def + raw array), `list/add/remove_watch_rule` (3 net-new defs),
`delete_orchestrator_plan` (net-new, no twin today).

**Carve-out (separate beads — NO twin exists, so net-new authoring, not drift-closure):**
`GET`/`PUT /api/settings` (client reads structured body — translator vs client-rewrite to
the `settings_updated` WS frame), the draft family (`GET`/`PUT /draft`, `GET /drafts`,
`POST /draft/send` — operator-direct, deliberately ungated, WS-primary).
Also held: `set_capability_gate` **bulk** UI path (the inline route is a bulk loosen/replace
map-write; the registry `set_capability_gate` is single-entry tighten-only — author a
**new** `set_pane_gates` action, do not overload), and `create_project`'s post-create
`renameProject(name)` second mutation.

## Migration Order (batches = c55 child beads)

Each batch is TDD: **characterization test first** (encode the target contract — status +
body shape + WS frame — and watch it fail), then implement the cutover, then green.
Each batch **ends fully converged** (no temporary tier). Hard gate between batches:
`npm run lint && npm test` must be green before the next batch starts.

| Batch | Beads | Routes | Net-new infra | Risk |
|---|---|---|---|---|
| **A** | c55.1 | stop_all trio, dismiss_attention, create_orchestrator_plan | none | low |
| **B** | c55.2 | rename_project, rename_pane, switch_context, execute_plan | snake-case `rest.path` | low |
| **C** | c55.3 | restart_pane, send_keys, resize_pane, clear_history, clear_exited | 5 new rest-only defs | med |
| **D** | c55.4 | set_pane_permissions, handoff, apply_recipe, create_pane, attention/clear | `coerceArgs`; status-via-kinds | med |
| **E** | c55.5 | (infra) `ActionDef.rest.toHttp` + `applyResultToHttp` + coverage test | the translator primitive | med |
| **F** | c55.6 | list_panes, get_stop_all_status, history GET | uses E; structured bodies | high |
| **G** | c55.7 | watch-rules trio, delete_orchestrator_plan | net-new gated actions | high |
| **H** | c55.8 | settings + drafts decision, then **drop `opts.only`** + no-twin guard | DECISION-GATED — held | high |

**This workflow executes A→G.** Batch H and the held items (`set_capability_gate` bulk,
`create_project` second mutation) are **decision-gated** and surfaced for ratification —
not silently resolved.

## Open Decisions (ratify before/at H; safe defaults applied meanwhile)

1. **Hard-reads strategy (settings, drafts):** translator-preserve (author defs + `toHttp`)
   vs client-rewrite (point React at the `settings_updated`/`draft_updated` WS frames it
   already receives, drop the body-read → downgrades to Easy). *Default for A–G: leave
   settings/drafts inline, untouched.*
2. **Status-code fidelity:** accept the registry's intended collapses where the client does
   not branch — inline `404` on unknown id (dismiss/restart/execute/watch-delete) → `200`
   ok-narration; inline `400` bad-input → zod-`500`/`200`/clarify. Client ignores these
   today; document as a wire-contract change for any future non-UI consumer.
3. **New-action gates — SAFE DEFAULT APPLIED:** `send_keys`/`resize_pane` are ungated
   inline today → register as **`ALWAYS_ALLOWED`** to preserve current behavior (flag for
   tightening later). `restart_pane` capability already exists → it now enforces (closes a
   current gate-skip — a deliberate safety improvement, flagged). `add_watch_rule` label
   exists (default Ask) → confirm. `remove_watch_rule`/`delete_orchestrator_plan` need new
   gate rows + a voice-tool yes/no — **held for ratification.**
4. **`create_project` second mutation** (post-create rename) — held.
5. **`set_capability_gate` semantic split** (new bulk `set_pane_gates`) — held.
6. **`create_pane` active-pane delta:** voice handler sets active pane + broadcasts
   `switch_active_pane`; inline REST does not. Converging adds a benign redundant broadcast
   (client already self-activates on 200) — accept.

## Risks & Mitigations

- **Double-registration:** add-name-without-deleting-block → Express keeps the inline
  handler, masking the cutover. **Every step adds-name AND deletes-block atomically**; the
  verify gate asserts the response shape actually changed to the registry shape.
- **`list_panes` body fidelity (highest blast radius):** registry handler returns a
  project/pane *tree*, not the flat per-pane array `setTerminals()` consumes (missing
  `backfill`/`getRecentOutput(20)`/`effective_gates`/`posture`/`context_size`). Capture the
  legacy body, assert byte-identical-or-intended-superset; its own high-rigor task + e2e.
- **Status-contract collapse (create_pane / apply_recipe):** the only routes where the
  client status-branches (403/202). Handler-returns-blocked/pending is mandatory and
  verified by **HTTP status assertion**, not just body.
- **Boot-restore gap:** `GET /api/stop-all/status` is read once on load before any WS
  frame; `{type:'frozen'}` only fires on *change*. Dropping it without a faithful
  `get_stop_all_status` replacement regresses frozen-survives-restart (spec §10.3). Verify
  by reloading against an already-frozen server.
- **Ungated-write promotion:** routing `send_keys`/`resize`/`restart` through a capability
  is a safety win but a behavior change. Default to `ALWAYS_ALLOWED`/Auto to preserve
  current behavior unless deliberately tightening.
- **`coerceArgs` correctness:** the camel→snake bridge runs before zod; a typo'd key
  silently arrives `undefined`. Unit-test each map; assert the snake key reaches the
  handler with a known value.
- **Catalog drift guard:** adding defs changes the derived matrix/catalog;
  `scripts/catalog.ts` fails until `npm run catalog` regenerates. Run `npm run catalog` in
  every step that adds/changes a def.

## Verification Doctrine (applies to every batch)

1. **TDD order:** characterization/contract test first → fail → implement → green.
2. **Prefer deterministic def-level + `resultToHttp` unit tests** (call `runAction` with a
   fake ctx, assert `ActionResult` kind/output; assert the HTTP mapping) over server-boot
   tests. Use e2e for the UI-repaint integration assertion.
3. **Hard gate per batch:** `npm run lint && npm test` green (plus `npm run catalog` when
   defs change). Targeted e2e after D (status-branch UX) and F (list_panes fidelity);
   full e2e at the end.
4. **Adversarial verify:** a fresh reviewer re-runs the gates, inspects `git show` of the
   batch commit for double-registration / faked tests / regressions / contract collapse.
5. **No push, no bd mutation, no main-checkout edits inside the workflow.** All work is in
   the c55 worktree; integration/push is surfaced for explicit approval.
