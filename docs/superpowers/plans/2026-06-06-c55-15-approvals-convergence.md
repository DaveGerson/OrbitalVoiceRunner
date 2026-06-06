# c55.15 — APPROVALS/PENDING HiTL Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Converge the **5 inline approvals/pending HiTL routes** into rest-only registry defs, all `ALWAYS_ALLOWED` (the operator surface that RESOLVES gated actions is itself above-the-gate), **preserving the exact 404/422/200/500 status contract** the default kind→status map cannot express — via the `rest.toHttp` primitive.

**Architecture:** Two halves. **(A) ActionContext extension** (the one non-mechanical wrinkle): the converged defs need `pendingActions` (the non-PTY deferred-action store: `.all()/.has()/.confirm()/.cancel()`) and `pendingApprovals.all()` — neither is on `ActionContext` today (`buildRestActionContext` injects `pendingApprovals` as a narrow `forSession/setLastAnnounced/has` surface + `applyResolution`, but NOT `pendingActions`). So Task 1 ADDITIVELY extends the "FROZEN CONTRACT": add `pendingActions: PendingActionStore` and widen the `pendingApprovals` surface with `all(): PendingApproval[]`. **(B) Convergence:** 5 rest-only `ALWAYS_ALLOWED` defs in `src/actions/defs/approvals_rest.ts`, each carrying a `rest.toHttp` that re-projects a discriminated `result.output` into the legacy `{status, body}` (the 2 GETs emit JSON arrays TOP-LEVEL at 200; the 3 POSTs map a `{outcome}` tag to 404 / 422 / 200 / 500). `broadcast` is already on ctx (server.ts:1177) — the confirm/cancel defs fan `action_resolved` through it.

**Tech Stack:** TypeScript, `node:test` via `tsx --test --test-force-exit`. No new deps.

---

## Worktree (already set up)

Worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-15-approvals`, branch `feat/c55.15-approvals-convergence` (off `main` @ `3155c96`, the c55.14 merge), node_modules junctioned (zod present), bead `wsm-e2e-pinned-c55.15` claimed.

## Platform notes
- Windows: **PowerShell tool** for npm (`Set-Location` the worktree + `$env:PYTHONIOENCODING='utf-8'`; no `&&`, chain with `;`). **Bash tool** for git only (`git -C "<wt>" …`). `server.ts` large — Grep then Read a tight window. node-pty `AttachConsole failed` / `NativeCommandError` wrapping node stderr = display noise (judge by `# pass`/`# fail` + exit codes). Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push until green + approval; do NOT run `bd` beyond claim/close.

## Fidelity contract (legacy inline handlers, captured @ 3155c96 — re-Grep line numbers before editing; they shift as you delete)

| Inline route (server.ts) | Behavior + status | New def | toHttp mapping |
|---|---|---|---|
| `GET /api/commands/pending` (1057) | `res.json(pendingApprovals.all().map(serializePending))` — JSON array, 200 | `list_pending_commands` | 200, array top-level |
| `GET /api/actions/pending` (1062) | `res.json(pendingActions.all().map(a => ({id, capability, summary, ageSeconds})))` — array, 200; `ageSeconds = max(0, floor((Date.now()-a.timestamp)/1000))` | `list_pending_actions` | 200, array top-level |
| `POST /api/actions/:id/confirm` (1066) | `!has(id)`→404`{error}`; `confirm(id)`: `lost_race`→200`{success:true,already:true}`, `not_found`→404`{error}`, else→broadcast `action_resolved`/confirmed + 200`{success:true,output}`; throw→500`{success:false,error}` | `confirm_pending_action` | 404 / 200(already) / 200(output) / 500 |
| `POST /api/actions/:id/cancel` (1080) | `!has(id)`→404`{error}`; `cancel(id)`→broadcast `action_resolved`/cancelled + 200`{success:true, already: reason==="lost_race"}` | `cancel_pending_action` | 404 / 200(already) |
| `POST /api/commands/approve` (1088) | body `{messageId, approved}`; `!pendingApprovals.has(messageId)`→404`{error}`; `applyResolution(messageId, approved?"approve":"reject")` → `not_found`→404`{error}`, `dead_pane`→422`{success:false,error:"target pane missing"}`, `lost_race`→200`{success:true,already:true}`, default→200`{success:true}` | `approve_pending_command` | 404 / 422 / 200(already) / 200 |

> Grounding refs: `serializePending` is `src/pendingApprovals.ts:421` (exported pure fn). `PendingActionStore` is `src/pendingActions.ts:91` (`.all()`:150, `.confirm(id)`:185, `.cancel(id)`:199; `ActionResolveResult` reasons `"not_found"`/`"lost_race"`, `.record`/`.output`). `PendingApprovalStore.all()` is `src/pendingApprovals.ts:623`. `broadcast` is already on `ActionContext` (types.ts:222, injected server.ts:1177). The 5 inline routes' `future-convergence: approvals / pending (HiTL)` catalog rows are `src/actions/inlineExceptions.ts` (the 5 rows after the lifecycle ones were removed in c55.14 — Grep `commands/pending`).

---

### Task 1: Extend ActionContext — `pendingActions` + `pendingApprovals.all()`

**Files:** `src/actions/types.ts`, `server.ts` (`buildRestActionContext`), plus every test/e2e ctx-fake that must stay total (Grep the fakes).

The converged defs reference `ctx.pendingActions` and `ctx.pendingApprovals.all()`. ActionContext is the "FROZEN CONTRACT" — extend it ADDITIVELY (no existing field changes).

- [ ] **Step 1 (TDD): a failing ctx-shape test.** In a new `tests/test_c55_15_approvals.ts`, assert the registry can build a ctx exposing `pendingActions` (with `all/has/confirm/cancel`) and `pendingApprovals.all`. (This will fail to typecheck/run until the fields exist.) Keep it minimal — the real coverage is Task 2.

- [ ] **Step 2: `src/actions/types.ts`** — add the import + fields:
  - Import the store type: `import type { PendingActionStore } from "../pendingActions";` (match the file's existing import style; if a narrower view type already exists, e.g. `PendingActionResolverStore` in `voiceApprovalRouting.ts:18`, prefer the narrowest that exposes `all/has/confirm/cancel` — Grep both and pick).
  - On `interface ActionContext`, add (near `pendingApprovals` / `applyResolution`, ~line 305-308):
    ```ts
    /** The non-PTY deferred-action store (gated-Ask staging), injected (server.ts pendingActions).
     *  Used by the approvals/pending REST defs: list / confirm / cancel. */
    pendingActions: PendingActionStore;
    ```
  - Widen the `pendingApprovals` surface type (`PendingApprovalsSurface`, the type of the ctx field) with `all(): PendingApproval[];` so `GET /api/commands/pending` can list. (Grep the surface type def; add `all` additively. `PendingApproval` is already imported in types.ts.)

- [ ] **Step 3: `server.ts` `buildRestActionContext`** (~1170) — add `pendingActions,` to the returned object (the server-lifetime `pendingActions` binding is already destructured ~line 602; confirm via Grep). `pendingApprovals` already passed — confirm the concrete store satisfies the widened `all()` (PendingApprovalStore has `.all()` at pendingApprovals.ts:623, so it already does).

- [ ] **Step 4: fix every other ctx-fake** that must stay structurally total. Grep for `buildRestActionContext` callers + test ctx fakes (`tests/`, `src/e2e/harness.ts`, `src/voice/`) — any object literal typed `ActionContext` now needs `pendingActions`. Add a minimal stub to each (`{ all:()=>[], has:()=>false, confirm:()=>({reason:"not_found"}), cancel:()=>({reason:"not_found"}) } as unknown as PendingActionStore` where a real one isn't handy). If the voice ActionContext factory (`src/voice/index.ts`) builds a ctx, wire the real `pendingActions` there too.

- [ ] **Step 5: lint + the existing registry/ctx tests.** PowerShell `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npm run lint` (exit 0) and `npx tsx --test --test-force-exit tests/test_action_registry.ts tests/test_c55_15_approvals.ts` (`# fail 0`). Commit the touched files with `feat(c55.15): extend ActionContext with pendingActions + pendingApprovals.all() for the approvals surface`.

---

### Task 2: The 5 rest-only ALWAYS_ALLOWED defs + toHttp status contract (TDD)

**Files:** Create `src/actions/defs/approvals_rest.ts`, extend `tests/test_c55_15_approvals.ts`; Modify `src/actions/registry.ts`, `src/actions/coverage.ts`.

- [ ] **Step 1 (TDD): the contract test.** In `tests/test_c55_15_approvals.ts` cover, with a call-recording fake ctx (model on `tests/test_c55_14_lifecycle.ts` + the archive/reads suites; Grep for the fake-ctx idiom + `applyResultToHttp` import):
  - **Shape** for all 5: rest-only, `ALWAYS_ALLOWED`, correct `rest.method`/`rest.path`, each in `INTENTIONAL_ASYMMETRY` as `Set(["rest"])`, and each declares `rest.toHttp`.
  - **GET fidelity:** `list_pending_commands` → `applyResultToHttp` emits `pendingApprovals.all().map(serializePending)` as a TOP-LEVEL array at 200; `list_pending_actions` → the `{id,capability,summary,ageSeconds}` array at 200 (assert `ageSeconds>=0`).
  - **POST status matrix (the careful part) — drive the fake store to each branch and assert BOTH the returned shape AND `applyResultToHttp(...).status`:**
    - `confirm_pending_action`: missing→**404**`{error}`; `confirm` returns `lost_race`→**200**`{success:true,already:true}`; returns ok→**200**`{success:true,output}` + `broadcast` fired `action_resolved`/confirmed; handler throw→**500**`{success:false,error}`.
    - `cancel_pending_action`: missing→**404**; `cancel` ok→**200**`{success:true,already:<lost_race>}` + `broadcast` cancelled.
    - `approve_pending_command`: missing→**404**; `applyResolution` `dead_pane`→**422**`{success:false,error:"target pane missing"}`; `lost_race`→**200**`{success:true,already:true}`; default→**200**`{success:true}`.
  Run → FAIL (defs missing).

- [ ] **Step 2: create `src/actions/defs/approvals_rest.ts`.** All 5 defs `ALWAYS_ALLOWED`, `surfaces:new Set(["rest"])`. **Pattern (mirror the c55.11 toHttp reads — Grep `get_ledger`/`get_attention_queue` in `reads.ts` for the EXACT structured-output typing idiom + how `toHttp` reads `result.output`):** the handler returns `{kind:"ok", output:<payload>}` where `output` carries either the array (GETs) or a discriminated `{outcome, ...}` (POSTs); `rest.toHttp(result)` re-projects it into the legacy `{status, body}`. Concrete logic per def:

  ```ts
  // GET /api/commands/pending
  handler: (_a, ctx) => ({ kind: "ok", output: ctx.pendingApprovals.all().map(serializePending) /* as the toHttp-read idiom */ }),
  rest: { method: "get", path: "/api/commands/pending", toHttp: (r) => ({ status: 200, body: <r.output array> }) },

  // GET /api/actions/pending  (ageSeconds computed in-handler with Date.now())
  handler: (_a, ctx) => ({ kind: "ok", output: ctx.pendingActions.all().map((x) => ({ id: x.id, capability: x.capability, summary: x.summary, ageSeconds: Math.max(0, Math.floor((Date.now() - x.timestamp) / 1000)) })) }),
  rest: { method: "get", path: "/api/actions/pending", toHttp: (r) => ({ status: 200, body: <r.output array> }) },

  // POST /api/actions/:id/confirm   params: { id }
  handler: (args, ctx) => {
    if (!ctx.pendingActions.has(args.id)) return { kind: "ok", output: { outcome: "not_found" } };
    try {
      const res = ctx.pendingActions.confirm(args.id);
      if (res.reason === "lost_race") return { kind: "ok", output: { outcome: "already" } };
      if (res.reason === "not_found") return { kind: "ok", output: { outcome: "not_found" } };
      ctx.broadcast({ type: "action_resolved", actionId: args.id, outcome: "confirmed" });
      return { kind: "ok", output: { outcome: "ok", output: res.output } };
    } catch (e) { return { kind: "ok", output: { outcome: "error", error: e instanceof Error ? e.message : String(e) } }; }
  },
  rest: { method: "post", path: "/api/actions/:id/confirm", toHttp: (r) => {
    const o = r.output; // discriminated
    if (o.outcome === "not_found") return { status: 404, body: { error: "Pending action not found" } };
    if (o.outcome === "already")   return { status: 200, body: { success: true, already: true } };
    if (o.outcome === "error")     return { status: 500, body: { success: false, error: o.error } };
    return { status: 200, body: { success: true, output: o.output } };
  } },

  // POST /api/actions/:id/cancel   params: { id }
  handler: (args, ctx) => {
    if (!ctx.pendingActions.has(args.id)) return { kind: "ok", output: { outcome: "not_found" } };
    const res = ctx.pendingActions.cancel(args.id);
    ctx.broadcast({ type: "action_resolved", actionId: args.id, outcome: "cancelled" });
    return { kind: "ok", output: { outcome: "ok", already: res.reason === "lost_race" } };
  },
  rest: { method: "post", path: "/api/actions/:id/cancel", toHttp: (r) => {
    const o = r.output;
    if (o.outcome === "not_found") return { status: 404, body: { error: "Pending action not found" } };
    return { status: 200, body: { success: true, already: o.already } };
  } },

  // POST /api/commands/approve   body: { messageId, approved }
  handler: (args, ctx) => {
    if (!ctx.pendingApprovals.has(args.messageId)) return { kind: "ok", output: { outcome: "not_found" } };
    const action = ctx.applyResolution(args.messageId, args.approved ? "approve" : "reject");
    if (action.reason === "not_found") return { kind: "ok", output: { outcome: "not_found" } };
    if (action.reason === "dead_pane") return { kind: "ok", output: { outcome: "dead_pane" } };
    if (action.reason === "lost_race") return { kind: "ok", output: { outcome: "already" } };
    return { kind: "ok", output: { outcome: "ok" } };
  },
  rest: { method: "post", path: "/api/commands/approve", toHttp: (r) => {
    const o = r.output;
    if (o.outcome === "not_found") return { status: 404, body: { error: "Pending command not found" } };
    if (o.outcome === "dead_pane") return { status: 422, body: { success: false, error: "target pane missing" } };
    if (o.outcome === "already")   return { status: 200, body: { success: true, already: true } };
    return { status: 200, body: { success: true } };
  } },
  ```
  > **Typing note:** `ActionResult.output` is typed `string`; the c55.11 toHttp reads already stuff structured data through `output` for the `toHttp`-only path — **match their exact idiom** (Grep `get_ledger` in `reads.ts`: whether they widen via a cast `as unknown as string` on the handler return and `r.output as <Shape>` in toHttp, or another approach). Use the SAME idiom here so it compiles without inventing a new pattern. Params: confirm/cancel use `z.object({ id: z.string() })`; approve uses `z.object({ messageId: z.string(), approved: z.boolean() })`; the GETs `z.object({})`.

- [ ] **Step 3: wire `APPROVALS_REST_ACTIONS` into `registry.ts`** (import + spread, like `LIFECYCLE_REST_ACTIONS`/`ARCHIVE_ACTIONS`).

- [ ] **Step 4: add 5 `INTENTIONAL_ASYMMETRY` entries** in `coverage.ts`:
  ```ts
  // ── c55.15: NEW rest-only approvals/pending HiTL defs (operator surface that RESOLVES gated actions;
  // ALWAYS_ALLOWED — above-the-gate). No voice twin (voice has list_pending_approvals / the live approval path). ──
  list_pending_commands: new Set<Surface>(["rest"]),
  list_pending_actions:  new Set<Surface>(["rest"]),
  confirm_pending_action: new Set<Surface>(["rest"]),
  cancel_pending_action:  new Set<Surface>(["rest"]),
  approve_pending_command: new Set<Surface>(["rest"]),
  ```

- [ ] **Step 5: green + lint + commit.** `npx tsx --test --test-force-exit tests/test_c55_15_approvals.ts tests/test_action_registry.ts` (`# fail 0`), `npm run lint` (0). Commit `src/actions/defs/approvals_rest.ts tests/test_c55_15_approvals.ts src/actions/registry.ts src/actions/coverage.ts` with `feat(c55.15): 5 rest-only approvals/pending defs (ALWAYS_ALLOWED) + toHttp status contract + asymmetry`.

---

### Task 3: Cutover — mount, delete 5 inline routes, shrink the catalog (TDD)

- [ ] **Step 1:** Append a cutover-guard `describe` to `tests/test_c55_15_approvals.ts` (clone the c55.14 block in `tests/test_c55_14_lifecycle.ts`): assert the 5 names are in the mount only-set AND these inline literals are GONE (method-anchored, quote-terminated regexes):
  - `/app\.get\(\s*["']\/api\/commands\/pending["']/`, `/app\.get\(\s*["']\/api\/actions\/pending["']/`, `/app\.post\(\s*["']\/api\/actions\/:id\/confirm["']/`, `/app\.post\(\s*["']\/api\/actions\/:id\/cancel["']/`, `/app\.post\(\s*["']\/api\/commands\/approve["']/`. Run → FAIL.
- [ ] **Step 2:** Add the 5 names to the `only: new Set([` set in `server.ts` (after the c55.14 entries), with a c55.15 comment block in the established per-batch style (note: ALWAYS_ALLOWED; toHttp preserves the 404/422/200/500 contract; client repaints off `action_resolved`/`action_pending` WS frames + refetch).
- [ ] **Step 3:** Delete the 5 inline route blocks (Grep each literal, Read window, Edit out, re-Grep between). Leave a one-line c55.15 breadcrumb each (established style). **DO NOT touch** the `gating.startSweepTimer()`/`approvalSweepTimer` wiring (server.ts ~1113) or `attachVoiceSession` (~1123) — only the 5 `app.*` route blocks.
- [ ] **Step 4:** Remove the 5 `future-convergence: approvals / pending (HiTL)` rows + their section comment from `src/actions/inlineExceptions.ts` (Grep `commands/pending`).
- [ ] **Step 5:** `npx tsx --test --test-force-exit tests/test_c55_15_approvals.ts tests/test_no_inline_twins.ts` → BOTH `# fail 0`. Lint. Commit `server.ts inlineExceptions.ts tests/test_c55_15_approvals.ts` with `feat(c55.15): cut over the 5 inline approvals/pending routes; shrink the no-twin catalog`.

---

### Task 4: Full-battery + catalog regen + scope check

- [ ] **Step 1:** `npm run catalog` → regenerate (expect 73→78 actions; no new caps — all ALWAYS_ALLOWED). Commit if changed: `chore(c55.15): regenerate catalog (5 new approvals/pending defs)`.
- [ ] **Step 2:** Full battery (`npm run lint; npm test; npm run build`). Expect lint 0; `# fail 0`; build 0. **Watch for** a stale scope-guard asserting one of the 5 approvals routes "stays inline" (the c55.11–c55.14 pattern — retire with a NOTE, don't weaken). Handle any voice-golden / catalog-drift by REGENERATING (the 5 new defs may surface in `tests/fixtures/voice-tool-goldens.json` if it enumerates rest defs — additive only). Any REAL regression (status contract wrong, a client break) → STOP and report.
- [ ] **Step 3:** Scope check (`git -C "<wt>" diff --name-only main..HEAD`; fork = `3155c96`): expect this plan, `src/actions/types.ts`, `server.ts`, `src/actions/defs/approvals_rest.ts`, `src/actions/registry.ts`, `src/actions/coverage.ts`, `src/actions/inlineExceptions.ts`, `tests/test_c55_15_approvals.ts`, `docs/CAPABILITIES.md`, + any ctx-fake files touched in Task 1 Step 4 + any regenerated golden. Flag anything else.

---

## Self-Review

- **Decision coverage:** the bead's "gating IS the point → design care" → these defs are ALWAYS_ALLOWED because they are the operator surface that RESOLVES gated actions (the gate already fired when the action was staged; confirming/cancelling/approving is the human-in-the-loop *answer*, not a new gated act). The "design care" is the **status contract**, realized via `toHttp` (404/422/200/500) — the first defs to use toHttp for non-200 statuses, grounded in the Batch E primitive.
- **Placeholder scan:** the 5 defs' LOGIC + the per-route status mapping + the ctx-extension are concrete; the only template reference is the `toHttp` structured-`output` typing idiom (match the existing c55.11 reads — a real, in-tree template, not a placeholder).
- **Type consistency:** `pendingActions`/`pendingApprovals.all()` appear identically in the ActionContext interface, `buildRestActionContext`, the voice ctx factory, and every test fake; the def `outcome` discriminants match 1:1 between each handler and its `toHttp`.
- **Behavior parity:** every status + body + broadcast reproduces the inline handler exactly (no behaviorDelta — unlike c55.14, nothing here changes gating). Accepted: none beyond the client already ignoring bodies + repainting off WS.

## Out of scope
`execute_plan` REST seam (c55.9 — needs a REST-capable pane-write path), gate-tightening other ungated REST writes (c55.10), the `opts.only` drop + held collisions (c55.16). The durable delete-replay tech debt is `wsm-e2e-pinned-j2e`.
