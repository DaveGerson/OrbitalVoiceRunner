# c55.16 — Converge `create_project` (the post-create RENAME 2nd-mutation) so `POST /api/projects` can be deleted

**Status:** design + TDD plan, ready to implement
**Worktree:** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-10-gates`
**Author context:** c55 REST→registry contract-convergence program (every capability is ONE `ActionDef`; voice/REST/WS are projections via `runAction` + `mountRestRoutes`; the no-twin guard `tests/test_no_inline_twins.ts` keeps server.ts inline routes and `src/actions/inlineExceptions.ts` in lockstep).

---

## BLUF

Adopt **Approach 1: extend the existing `create_project` def to perform the optional post-create rename as a SECOND in-handler store mutation, gated by a new optional `name` param, plus a `coerceArgs` shim to absorb the client's `id`/`keyTerms`/`name` body skew.** The inline `app.post("/api/projects", …)` then becomes byte-redundant and is deleted in the SAME change: add `"create_project"` to the `mountRestRoutes` `only` set, delete the inline route, and delete its `held` row in `inlineExceptions.ts`. No `rest.toHttp` is needed — the client **ignores the response body entirely** (it never reads `res.json()` / `res.ok`), so the default `kind:"ok" → 200 { output }` map is a fully acceptable, recorded body delta from the inline `{ success: true }`.

This is the same convergence shape Batch B / Batch D already shipped (`rename_project`, `set_pane_permissions`): a def that already broadcasts the right WS frame, cut over via the `only` allow-set, with a documented client-invisible body delta.

---

## 1. The blocker, grounded in code

### 1.1 The inline route (`server.ts:756-777`)

```ts
app.post("/api/projects", (req, res) => {
  const { id, directory, summary, keyTerms, name } = req.body;
  if (!id) { res.status(400).json({ error: "Missing required field: id" }); return; }
  if (isBadProjectDir(directory)) {
    res.status(400).json({ error: `Project directory does not exist: ${String(directory).trim()}` });
    return;
  }
  const terms = Array.isArray(keyTerms) ? keyTerms : [];
  manager.ledger.addProject(id, resolveProjectDir(directory), summary || "", terms);   // MUTATION 1
  if (name) {
    manager.ledger.renameProject(id, name);                                            // MUTATION 2 (conditional)
  }
  broadcastLedgerUpdate();
  res.json({ success: true });                                                          // 200 { success: true }
});
```

Two store mutations: `addProject(...)` then, **iff** a truthy `name` was supplied, `renameProject(id, name)`. Response is `200 { success: true }`.

### 1.2 Why the rename is a SECOND mutation (not a parameter on `addProject`)

`src/ledger.ts:170-190`:

```ts
addProject(id, directory, summary = "", keyTerms = []) {
  if (!this.workspaces[id]) {                 // <-- NO-OP if the id already exists
    this.workspaces[id] = { id, name: id, directory, summary, notes: [], panes: {}, keyTerms };
    this.save(true);
  }
}
renameProject(id, name) {
  if (this.workspaces[id]) { this.workspaces[id].name = name; this.save(true); }
}
```

- `addProject` initializes the display **`name` to the `id`** and has **no `name` parameter**. The only way to set a distinct display name is the separate `renameProject(id, name)` call.
- `addProject` is **idempotent / no-op when the id already exists**, so it cannot be coerced into "create-or-update the name."
- `SqliteStore.addProject` (`src/store/sqliteStore.ts:777`) has the same shape (`INSERT … WHERE NOT EXISTS`), and `renameProject` (`:785`) is the `UPDATE projects SET name=?`.

So the post-create rename is genuinely a **distinct ledger op**, and it is **ledger-scoped, not connection-scoped** — both `addProject` and `renameProject` are pure `manager.ledger` methods with no PTY / no `dispatchProposal` / no session dependency. (Contrast `execute_plan`, held because its 2nd op is a connection-scoped `dispatchProposal` pane-write.) **Nothing prevents the registry handler from running both.** The current `create_project` def simply never ported the conditional rename.

### 1.3 The current `create_project` def (`src/actions/defs/orient.ts:139-170`)

```ts
const CreateProjectParams = z.object({
  project_id: z.string(),
  directory:  z.string().optional(),
  summary:    z.string().optional(),
  key_terms:  z.array(z.string()).optional(),
});                                            // <-- strict-strip (NOT .passthrough()); no `name`

export const createProject: ActionDef<typeof CreateProjectParams> = {
  name: "create_project",
  capability: "create_project",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/projects" },
  handler: (args, ctx) => {
    const { project_id, directory, summary, key_terms } = args;
    if (isBadProjectDir(directory)) {
      return { kind: "ok", output: `Error: the directory '…' does not exist, … (re-prompt)` };
    }
    ctx.manager.ledger.addProject(project_id, resolveProjectDir(directory), summary || "", key_terms || []);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Project context ${project_id} created successfully.` };
  },
};
```

Two gaps vs the inline route:
1. **No `name` param + no rename mutation** — this is the c55.16 held blocker.
2. **Param-name skew** — the def reads `project_id` / `key_terms` (snake_case); the client body sends `id` / `keyTerms` / `name` (see §1.4). Because the zod schema is the default strict-strip object (NOT `.passthrough()`), an un-aliased `id` is **dropped**, `project_id` becomes `undefined`, and `params.parse` throws "Required" → `runAction` returns `kind:"error"` → 500. **`coerceArgs` is therefore mandatory**, not optional polish.

> Note: `isBadProjectDir` / `resolveProjectDir` are **module imports** from `../../projectDir` (orient.ts:23), not ctx closures — reuse them as-is.

### 1.4 What the client actually sends — and consumes (`src/App.tsx:1762-1773`)

```ts
} else {
  await apiFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: data.id, name: data.name, directory: data.directory,
                           summary: data.summary, keyTerms: data.keyTerms }),
  });
  await handleSwitchProject(data.id);     // repaints via fetchLedger()/fetchTerminals()
}
```

**Decisive finding:** the client **never reads the response** — it `await`s the fetch but does not touch `res.ok`, `res.status`, or `res.json()`. It immediately calls `handleSwitchProject(data.id)`, which `POST`s `/api/projects/:id/switch` and then `fetchLedger()` / `fetchTerminals()` to repaint. The success path is observed purely through the subsequent ledger refetch (and the live `ledger_updated` WS frame `broadcastLedgerUpdate()` fans out).

Body the client POSTs: `{ id, name, directory, summary, keyTerms }` — camelCase `id`/`keyTerms`, plus `name`. (`isMockMode` short-circuits before any fetch — `App.tsx:1718-1748` — so the REST path is the only one that hits the server.)

**Consequence:** the converged def does **not** need to reproduce `{ success: true }`. The default `kind:"ok" → 200 { output: "Project context … created successfully." }` is correct and invisible to the client. This is the SAME accepted body delta Batch B recorded for `rename_project` (`{ success:true }` → `{ output }`) — see `tests/test_c55_batch_b.ts` header lines 51-56.

### 1.5 The lockstep guard (`tests/test_no_inline_twins.ts`)

The guard scans `server.ts` text for `app.<verb>('<path>')` literals and asserts the set is **exactly** the `INLINE_EXCEPTIONS` catalog (`src/actions/inlineExceptions.ts`). It fails in **both** directions:
- delete the inline route but leave the catalog row → **STALE** failure;
- delete the catalog row but leave the inline route → **UNDECLARED** failure.

So the route deletion (`server.ts:756`) and its catalog-row deletion (`inlineExceptions.ts:44`, the `held` `post /api/projects` entry) **must land in the same change**.

### 1.6 The matrix invariant (§8.1b) is UNAFFECTED

`tests/test_action_registry.ts:204-221` pins: `deriveCapabilities(REGISTRY) ⊆ ALL_CAPABILITIES`, and `ALL_CAPABILITIES === CAPABILITY_DEFS` id-set. This convergence **adds no capability** — `create_project` already exists as a row (default gate `Auto`, per `tests/fixtures/voice-tool-goldens.json:54` and the §8.1b golden). We only add an optional `name` param + a 2nd mutation to an EXISTING def. The cross-pinned sources (`gateSurface.ts`, `capabilities.ts`, `types.ts`, `e2e/harness.ts`) need **no edit**.

---

## 2. The recommendation: Approach 1 (extend the handler) — and why not 2 or 3

| Approach | What it is | Verdict |
|---|---|---|
| **(1) Extend `create_project`** | Add optional `name` param + `coerceArgs` alias; sequence `addProject` then (iff `name`) `renameProject` inside the one handler; reproduce response via the default `resultToHttp`. | **CHOSEN.** Both ops are pure ledger mutations (§1.2) — no connection scope. One action, one choke-point, one `ledger_updated` frame. Matches the shipped Batch-B/D pattern. Minimal surface. |
| (2) Multi-step seam | A second action / a `set_pane_gates`-style new def for the rename. | **Rejected.** Over-engineered: the rename is already a public ledger method (`renameProject`) and the voice twin `rename_project` already exists. Splitting one inline route into two REST round-trips invents a seam the client doesn't want (it sends one body) and risks a half-created project if step 2 is skipped. No connection-scope justification exists to force a seam. |
| (3) Keep inline as a declared exception | Leave the `held` row, never converge. | **Rejected.** The whole premise of the hold ("the def lacks the 2nd mutation") dissolves once we see both mutations are ledger-scoped and the client ignores the body. There is no connection-scoped op here (unlike `execute_plan`). Keeping it inline would be unjustified debt against the convergence goal. |

### 2.1 The exact response contract & how the converged def reproduces it

| Branch | Inline route | Converged def (via `runAction` + `resultToHttp`) | Client impact |
|---|---|---|---|
| happy path (create [+ rename]) | `200 { success: true }` | `kind:"ok"` → **`200 { output: "Project context <id> created successfully." }`** | **none** — body ignored; repaint via `fetchLedger` + `ledger_updated` |
| bad directory | `400 { error: "Project directory does not exist: …" }` | `kind:"ok"` → **`200 { output: "Error: the directory '…' does not exist, … re-prompt" }`** (already the def's behavior; preserves the `create_project.bad_dir` golden) | **none** — body ignored; project simply not created |
| missing `id` | `400 { error: "Missing required field: id" }` | zod "Required" on `project_id` → `kind:"error"` → **`500 { error: … }`** | **none in practice** — the client's project-create modal always supplies an id; a malformed direct call now 500s instead of 400 (recorded delta, same class as `create_pane`'s "inline 400 → zod 500", `server.ts:1262`) |

All three are **client-invisible** because the client reads no field of the response. The happy-path and bad-dir branches stay `kind:"ok"` (no `toHttp` hook required); only a malformed direct call shifts 400→500, which is the standard, already-accepted zod-validation delta in this program.

WS frame parity: the inline route calls `broadcastLedgerUpdate()` once after both mutations. The converged handler calls `ctx.broadcastLedgerUpdate()` once after both mutations — identical single `ledger_updated` frame. (The two `save(true)` calls happen INSIDE `addProject` / `renameProject`, exactly as inline.)

---

## 3. The converged def (target shape)

```ts
const CreateProjectParams = z.object({
  project_id: z.string(),
  directory:  z.string().optional(),
  summary:    z.string().optional(),
  key_terms:  z.array(z.string()).optional(),
  name:       z.string().optional(),          // NEW: optional display name -> 2nd mutation
});

export const createProject: ActionDef<typeof CreateProjectParams> = {
  name: "create_project",
  description: "Create a new project workspace directory context block.",
  params: CreateProjectParams,
  capability: "create_project",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/projects" },
  // c55.16: the UI POSTs { id, name, directory, summary, keyTerms } (camelCase + `id`/`keyTerms`).
  // Alias to the snake_case zod keys ONLY when the snake key is absent, so a voice call carrying
  // project_id / key_terms is never clobbered. `name` passes straight through.
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.project_id == null && out.id != null) out.project_id = out.id;
    if (out.key_terms == null && out.keyTerms != null) out.key_terms = out.keyTerms;
    delete out.id;
    delete out.keyTerms;
    return out;
  },
  handler: (args, ctx): ActionResult => {
    const { project_id, directory, summary, key_terms, name } = args;
    if (isBadProjectDir(directory)) {
      return { kind: "ok", output: `Error: the directory '${String(directory).trim()}' does not exist, so I did not create project ${project_id}. Give me a folder that exists, or omit it to use the current workspace.` };
    }
    ctx.manager.ledger.addProject(project_id, resolveProjectDir(directory), summary || "", key_terms || []);  // MUTATION 1
    if (name) {
      ctx.manager.ledger.renameProject(project_id, name);                                                     // MUTATION 2
    }
    ctx.broadcastLedgerUpdate();                                                                               // ONE frame
    return { kind: "ok", output: `Project context ${project_id} created successfully.` };
  },
};
```

Notes:
- `coerceArgs` runs **before** `params.parse` in `runAction` (`src/actions/gemini.ts:191-194`), so the alias lands the camelCase body onto the snake_case zod keys.
- The "alias only when snake key absent" guard means a **voice** call (which already sends `project_id`/`key_terms`) is untouched, preserving the `create_project` + `create_project.bad_dir` goldens (which never send `name`).
- `delete out.id / out.keyTerms` keeps the strict-strip schema from choking — though strict-strip would drop them anyway, the explicit delete is the established Batch-D style (`apply_orchestration_recipe.coerceArgs`, orchestration.ts:199-204) and documents intent.

---

## 4. Bite-sized TDD implementation plan

Follow the project battery: `npm run lint` (`tsc --noEmit`), `npm test` (`tsx --test --test-force-exit`). Write tests FIRST (red), then implement (green).

**Step 0 — orient (read-only).** Re-read `src/actions/defs/orient.ts:139-170` (def), `server.ts:756-777` (inline route) and `server.ts:1192-1346` (the `only` set), `src/actions/inlineExceptions.ts:44` (the held row), `tests/test_c55_batch_b.ts` (the contract+cutover test template to mirror).

**Step 1 — RED: new contract test file `tests/test_c55_16_create_project.ts`.** Mirror `test_c55_batch_b.ts`'s structure (seedable fake ledger + `runToHttp` helper + `mountOne` route-flow helper + a text-scan cutover guard). Assert:
  1. **happy path, no name** — `runAction("create_project", { project_id:"p1", directory:"" }, ctx)` → `kind:"ok"`, `resultToHttp` → `200 { output: "Project context p1 created successfully." }`; fake `addProject` called with `p1`; `renameProject` NOT called; exactly one `ledger_updated` broadcast.
  2. **happy path WITH name** — `{ project_id:"p2", name:"My Proj", directory:"" }` → `addProject("p2", …)` THEN `renameProject("p2","My Proj")` (assert call order + that the seeded project's `name === "My Proj"`); still ONE `ledger_updated` broadcast.
  3. **client body skew via coerceArgs** — feed the RAW client body `{ id:"p3", name:"C", keyTerms:["a"], directory:"" }` (camelCase, `id`/`keyTerms`) → asserts `addProject("p3", <dir>, "", ["a"])` and `renameProject("p3","C")` both ran (proves the alias). This is the test that fails today (project_id undefined → 500).
  4. **bad-dir branch unchanged** — `{ project_id:"p4", directory:"/definitely/not/real/xyzzy" }` → `kind:"ok"` → `200 { output: starts-with "Error: the directory" }`; `addProject` NOT called. (Reuse a dir guaranteed bad; mirror the golden string.)
  5. **route-flow through the real seam** — `mountRestRoutes(fakeApp, REGISTRY, () => ctx, { only:new Set(["create_project"]) })`; invoke the captured handler with `{ body:{ id:"p5", name:"R", directory:"" } }`; assert `200` and that the seeded ledger has `p5` named `R`. Proves the body reaches the handler through `mountRestRoutes` end-to-end.
  6. **registry binding** — `REGISTRY.find(d=>d.name==="create_project")` has `surfaces.has("rest")` and `rest === { method:"post", path:"/api/projects" }`.
  7. **CUTOVER GUARD (text scan of server.ts):** `mountRestRoutes` only-set INCLUDES `"create_project"`; AND the inline literal `app.post("/api/projects"` is GONE (regex `/app\.post\(\s*["']\/api\/projects["']\s*,/` — anchor the trailing comma so it does not match `/api/projects/:id/...` sub-routes).
  8. **catalog guard:** `INLINE_EXCEPTIONS` no longer contains `{ method:"post", path:"/api/projects" }`.

  Run `npm test` — Step-1 tests fail (def lacks `name`/coerce; server still inline; catalog still has the row).

**Step 2 — GREEN (def):** edit `src/actions/defs/orient.ts` — add `name: z.string().optional()` to `CreateProjectParams`, add the `coerceArgs` shim, and add the `if (name) ctx.manager.ledger.renameProject(project_id, name);` line between `addProject` and `broadcastLedgerUpdate` (§3). Update the def's header comment block (orient.ts:127-138) to document the 2nd mutation + coerce. Re-run `npm test` — contract tests (1.1-1.6) go green; cutover/catalog tests (1.7-1.8) still red.

**Step 3 — GREEN (server cutover):** in `server.ts`:
  - add `"create_project"` to the `mountRestRoutes` `only` set (near `update_project`/`rename_project`, with a `// c55.16` comment noting the `{success:true}`→`{output}` body delta + the 2nd-mutation rename now runs in-handler);
  - delete the inline `app.post("/api/projects", …)` block (`:756-777`), replacing it with a one-line `// c55.16: POST /api/projects now served by the registry-derived create_project def (mountRestRoutes only-set above) …` breadcrumb in the house style.

**Step 4 — GREEN (catalog):** in `src/actions/inlineExceptions.ts`, delete the `held` row `{ method:"post", path:"/api/projects", … }` (line 44). Re-run `npm test` — cutover (1.7), catalog (1.8), AND `tests/test_no_inline_twins.ts` all go green (route gone + row gone = lockstep satisfied).

**Step 5 — regression sweep:** `npm run lint` (tsc clean) and `npm test` (full unit suite). Specifically confirm GREEN: `tests/test_voice_tool_goldens.ts` (`create_project` + `create_project.bad_dir` goldens unchanged — they never pass `name`), `tests/test_action_registry.ts` §8.1b (no capability change), `tests/test_no_inline_twins.ts`, `tests/test_rest_mount.ts`, and the catalog drift guard (`npm run catalog` if the registry catalog snapshot is asserted — run if `test_catalog.ts` flags drift; the def gained a param, not a capability/route, so the route catalog is unchanged, but run it to be safe).

**Step 6 — (optional, recommended) live/e2e smoke:** if `e2e` mocks project-create, confirm the `?mock=1` harness path is unaffected (the client short-circuits mock mode before fetch, `App.tsx:1718`). No `e2e/harness.ts` `DEFAULT_MOCK_GATES` change is needed (no new capability).

---

## 5. File touchpoints (exact)

- `src/actions/defs/orient.ts` — `CreateProjectParams` (add `name`), `createProject` (add `coerceArgs` + the `renameProject` 2nd mutation), header comment block `:127-138`.
- `server.ts` — `mountRestRoutes` `only` set `:1192-1346` (add `"create_project"`); delete inline `app.post("/api/projects", …)` `:756-777` (replace with breadcrumb comment).
- `src/actions/inlineExceptions.ts` — delete the `held` row `:44` `{ method:"post", path:"/api/projects", … }`.
- `tests/test_c55_16_create_project.ts` — NEW contract + route-flow + cutover + catalog test (mirror `tests/test_c55_batch_b.ts`).

No change to: `src/actions/gateSurface.ts`, `src/actions/capabilities.ts`, `src/actions/types.ts`, `e2e/harness.ts`, `src/ledger.ts`, `src/store/sqliteStore.ts`, `src/App.tsx`, `tests/fixtures/voice-tool-goldens.json`.

---

## 6. Risks & mitigations

1. **Param skew (HIGH if missed) → 500 on every UI create.** The strict-strip zod schema drops un-aliased `id`/`keyTerms`; without `coerceArgs`, `project_id` is `undefined` → zod throws → 500. **Mitigation:** `coerceArgs` (Step 2) + the dedicated raw-client-body test (Step 1.3). This is the single highest-value test.
2. **Voice golden regression.** A naive coerce that overwrites `project_id` when both keys are present could clobber a voice call. **Mitigation:** alias **only when the snake key is absent** (the Batch-D `apply_orchestration_recipe` pattern). The `create_project` / `create_project.bad_dir` goldens (which send `project_id`, never `id`/`name`) stay byte-identical — verified in Step 5.
3. **Double-registration masking the cutover.** Express keeps the FIRST-registered handler; if the inline route is left in place, it shadows the registry mount and the convergence silently no-ops. **Mitigation:** the text-scan cutover guard (Step 1.7) asserts the inline literal is GONE; `test_no_inline_twins.ts` independently fails STALE/UNDECLARED if route and catalog row drift.
4. **`missing id` status delta (400 → 500).** A malformed *direct* API call without `id` now 500s (zod) instead of 400. **Accepted:** client-invisible (the UI always supplies an id; body ignored), same class as `create_pane`'s recorded `inline 400 → zod 500` (`server.ts:1262`). Record it in the def/server comments and the test's "accepted deltas" note.
5. **Body-shape delta (`{success:true}` → `{output:…}`).** **Accepted & recorded:** the client reads no response field (`App.tsx:1762-1773`), identical to the Batch-B `rename_project` delta. No `rest.toHttp` needed.
6. **Catalog drift guard.** `scripts/catalog.ts` could flag the registry change. **Mitigation:** the def gained a *param*, not a capability or a new route binding, so the gate/route catalog is unchanged; if `test_catalog.ts` still flags, run `npm run catalog` to refresh and commit the snapshot (Step 5).

---

## Adversarial review (c55-closeout workflow)

**Verdict: sound-with-fixes.** Every load-bearing claim checks out against code.

### Required fixes

1. **When deleting the inline `app.post("/api/projects", …)` block at `server.ts:756-777`, replace it with a PROSE breadcrumb** in the existing house style (cf. `server.ts:779-788`) that does NOT contain the literal token `app.post("/api/projects"` — the no-twin guard's raw-text scan (`test_no_inline_twins.ts`) also matches commented-out `app.<verb>('<path>')` lines, so a literal in the comment would re-trigger an UNDECLARED/STALE failure even after the catalog row is removed.
2. **Land all three edits in the SAME change:** (1) add `"create_project"` to the `mountRestRoutes` only-set (`server.ts:1192-1346`), (2) delete the inline route (`server.ts:756-777`), (3) delete the held catalog row (`src/actions/inlineExceptions.ts:44`). Deleting any one without the others flips the no-twin guard (STALE if only route removed; UNDECLARED if only row removed) or silently no-ops the cutover via Express first-registered-wins double-registration.
3. **In the new `tests/test_c55_16_create_project.ts`, include the cutover-guard regex EXACTLY as scoped** — `/app\.post\(\s*["']\/api\/projects["']\s*,/` with the closing quote immediately after `projects` and the trailing comma anchored — so it asserts the EXACT route is gone WITHOUT false-matching sibling sub-routes like `/api/projects/:id/switch` (POST) or `/api/projects/:project_id/rename` (PUT).
4. **Keep the coerceArgs guard "alias ONLY when the snake key is absent"** (`out.project_id == null && out.id != null`) and add the dedicated raw-client-body test (Step 1.3) feeding `{id, name, keyTerms, directory}`; this is the single highest-value test and the one that fails today (`project_id` undefined → zod 500). Also keep a snake-case voice-shape test to prove the `create_project` / `create_project.bad_dir` goldens stay byte-identical.
5. **Add `name: z.string().optional()` to `CreateProjectParams`** (`orient.ts:139-144`) — without the schema field, default zod object behavior STRIPS `name` before the handler sees it, so the 2nd mutation would never fire even with coerceArgs. The handler must destructure `name` and call `ctx.manager.ledger.renameProject(project_id, name)` only when truthy, BEFORE the single `ctx.broadcastLedgerUpdate()`.

### Issues / verified findings

- **VERIFIED SOUND** — every load-bearing claim checks out against code. **(a) P2 taxonomy + 8.1b:** `create_project` is an EXISTING capability (`src/actions/capabilities.ts:88`, defaultGate `'Auto'`, category `'Orientation (low-risk)'`; `ALL_CAPABILITIES`/`CAPABILITY_DEFS` pin at `tests/test_action_registry.ts:204-221`). The def adds NO new capability — only an optional `name` param + a 2nd ledger mutation — so `deriveCapabilities(REGISTRY)` is unchanged and both 8.1b invariants (subset + DEFS-equality) hold. Both mutations (`addProject` @ `src/ledger.ts:170`, `renameProject` @ `:185`) are pure ledger ops, no connection scope — leaving the handler ungated matches the established classification (it is ungated inline AND as a def today; `orient.ts:16`). No taxonomy violation.
- **(b) HTTP contract VERIFIED:** `resultToHttp` (`src/actions/rest.ts:142-160`) maps `ok->200{output}`, `error->500{error}`. The React client (`src/App.tsx:1762-1773`) never reads `res.ok`/`res.status`/`res.json` — it awaits then calls `handleSwitchProject` → `fetchLedger`/`fetchTerminals`. So the `{success:true}`→`{output}` body delta and the malformed-call 400→500 delta are genuinely client-invisible. Only ONE client call site exists (grep-confirmed).
- **(c) No-twin guard VERIFIED green:** the guard (`tests/test_no_inline_twins.ts:22-52`) scans both directions; route (`server.ts:756`) + catalog row (`src/actions/inlineExceptions.ts:44`) deleted together = lockstep. Exactly ONE `app.post("/api/projects"` exists (grep-confirmed), so deletion fully clears the scanned key.
- **(d) Files/symbols/tests REAL:** `orient.ts` def, ledger methods, inline route, App.tsx client, `gemini.ts` coerce-before-parse (`src/actions/gemini.ts:191`), the batch_b template (`tests/test_c55_batch_b.ts` — makeCtx/runToHttp/mountOne/text-scan all present), goldens (`tests/fixtures/voice-tool-goldens.json:18/22/54`), and the Batch-D coerceArgs precedent (`src/actions/defs/orchestration.ts:199-204`) all match. `ORIENT_ACTIONS` (incl. `createProject`) IS spread into `REGISTRY` (`src/actions/registry.ts:310`), so the only-set cutover will mount it.
- **(e) TDD plan is genuinely bite-sized + failing-test-first:** Step1 writes RED tests on the real batch_b template; Steps 2-4 are incremental def→server→catalog with explicit red→green transitions; Step5 regression sweep. Goldens stay byte-identical because they send snake-case `project_id` (no `id`/`name`) and the coerceArgs aliases ONLY when the snake key is absent (verified against `test_voice_tool_goldens.ts:455-469`).
- **MINOR (non-blocking)** — design omits the explicit caveat that the Step-3 breadcrumb replacing the deleted route MUST be PROSE, not a literal `app.post("/api/projects"`. The no-twin guard is a RAW-TEXT scan that also matches commented-out `app.<verb>('<path>')` lines (`tests/test_no_inline_twins.ts:17-21` NOTE). All existing breadcrumbs (`server.ts:779-788`) are prose and avoid the literal, and the design says "house style", but it never states the failure mode outright.
- **MINOR (cosmetic)** — the §3 target handler signature drops the `: ActionContext` annotation on `ctx` that the live def carries (`orient.ts:154`). TS infers it from `ActionDef`, so harmless, but the implementer should keep the existing `ctx: ActionContext` annotation for consistency.
- **MINOR** — §3 proposed coerceArgs returns `out` typed as the spread of `raw: Record<string,unknown>`; assigning `out.project_id = out.id` is fine under that index signature (matches the Batch-D precedent exactly), so no type error. Noted only to confirm the index-signature path is clean.
