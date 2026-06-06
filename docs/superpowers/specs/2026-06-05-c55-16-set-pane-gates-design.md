# c55.16 — `set_pane_gates`: converge the BULK per-pane gate-map route onto the registry

**Status:** design complete, ready for TDD implementation
**Worktree:** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-10-gates`
**Held collision being resolved:** `inlineExceptions.ts:45` —
`{ method: "put", path: "/api/projects/:projectId/panes/:paneId/capability-gates", category: "held", reason: "BULK gate map-write; set_capability_gate def is single-entry tighten-only — needs new set_pane_gates (held)" }`

---

## BLUF

Mint a **new rest-only ActionDef `set_pane_gates`** that converges the inline
`PUT /api/projects/:projectId/panes/:paneId/capability-gates` route — the operator matrix-editor's
**BULK whole-map** per-pane override writer. It is the deliberate UI sibling of the voice
`set_capability_gate` tool: where voice is single-entry and **tighten-only**, this UI route writes the
operator-chosen map **verbatim (loosening allowed)**. The def reuses the **existing**
`set_capability_gate` capability row (so the 24-row matrix does **not** grow — the §8.1b subset
invariant holds with zero matrix edits), and rides the **`rest.toHttp` primitive** to reproduce the
inline route's exact `200 {success,capabilityGates}` / `404 {error}` contract that
`tests/test_pane_gates_rest.ts` pins byte-for-byte. `set_capability_gate` **stays** (it is the voice
meta-gate, untouched); only its **dormant, never-mounted `rest` binding is removed** and re-homed onto
`set_pane_gates`.

---

## 1. Why this is "held" — the precise collision

`setCapabilityGate` (in `src/actions/defs/locks.ts:302`) already declares:

```ts
rest: { method: "put", path: "/api/projects/:projectId/panes/:paneId/capability-gates" },
```

…but it is **NOT in the `mountRestRoutes` `only`-set** (`server.ts:1192`), so that binding is **dormant
dead metadata** — `mountRestRoutes` skips any def not in the allow-filter (`rest.ts:82`). The inline
route (`server.ts:810`) still serves all traffic. The collision is **semantic**, not a
double-registration:

| | voice `set_capability_gate` (tool) | inline PUT `/capability-gates` (matrix editor) |
|---|---|---|
| Arity | **single entry** `{capability, gate}` | **whole map** `{capabilityGates: {cap→gate}}` |
| Direction | **tighten-only** (`isLoosening` refuses loosen-by-voice) | **verbatim** (UI is the deliberate place loosening is allowed) |
| Scope | global **or** one pane (`pane_id?`) | always one pane (`:projectId/:paneId`) |
| Replace vs merge | **merges** one key into the pane map | **replaces** the whole pane override map |
| Empty `{}` | n/a | **clears** the override (no masking `{}`) |

You cannot make one def be both single-entry-tighten-only AND bulk-verbatim without branching its
schema and gating on an arg shape — that is two contracts wearing one name. The clean convergence is a
**second def** that owns the bulk-write contract.

---

## 2. The inline route's EXACT contract (the thing we must reproduce)

`server.ts:810-844`, transcribed:

```ts
app.put("/api/projects/:projectId/panes/:paneId/capability-gates", (req, res) => {
  const { projectId, paneId } = req.params;
  const incoming = req.body?.capabilityGates;
  const ws = manager.ledger.getProject(projectId);
  const pane = ws?.panes?.[paneId];
  if (!pane) { res.status(404).json({ error: "Pane not found" }); return; }   // (A) 404
  const clean: CapabilityGateMap = {};
  let any = false;
  if (incoming && typeof incoming === "object") {
    for (const [k, v] of Object.entries(incoming)) {
      if (v === "Auto" || v === "Ask" || v === "Off") { (clean as any)[k] = v; any = true; }  // (B) normalize
    }
  }
  pane.capabilityGates = any ? clean : undefined;                              // (C) empty => clear
  manager.ledger.updatePane(projectId, pane, true);                           // (D) durable BOTH backends
  if (store) { try { store.recordActivity({ type: "permission_changed", ... }) } catch {} }  // (E) audit
  broadcastLedgerUpdate();                                                     // (F) ledger frame
  broadcastTerminalsUpdated();                                                 // (G) posture frame
  res.json({ success: true, capabilityGates: pane.capabilityGates ?? null }); // (H) 200 body
});
```

**Pinned by `tests/test_pane_gates_rest.ts` (this suite must stay green after convergence):**

1. `200` + `body.capabilityGates` **deep-equals the stored map** (full replace, no loss) — round-trips into `ledger pane.capabilityGates` verbatim.
2. Empty `{}` ⇒ `body.capabilityGates === null` **and** `pane.capabilityGates === undefined` (cleared, never a masking `{}`).
3. Invalid gate values are **silently dropped** by the `Auto|Ask|Off` filter (an all-invalid map behaves like empty ⇒ clears).
4. Unknown pane ⇒ `404` (status only; the suite asserts `res.status === 404`).
5. The override flows into the resolved effective posture (proven via the persisted ledger override).

These are the regression bars. The convergence is **behavior-preserving** except the one accepted body
delta below.

---

## 3. The `rest.toHttp` primitive — why we need it here

`resultToHttp` (`rest.ts:142`) maps `ok→200 {output}`, `pending→202`, `clarify→409`, `blocked→403`,
`error→500`. It has **no 404 path** and its `200` body is `{output:string}`, not
`{success, capabilityGates}`. The inline route returns:

- `200 { success:true, capabilityGates: <map|null> }` (a structured body the flat `{output}` cannot carry)
- `404 { error: "Pane not found" }` (a status the default kind→status map cannot express)

This is exactly the case `rest.toHttp` exists for (`types.ts:377-390`, `rest.ts:111-132`): an
OPTIONAL per-def response translator that re-projects `result.output` into a bespoke `{status, body}`.
Precedent: the `lifecycle_rest.ts` deletes (status-via-kinds) and the Batch-F structured reads
(`get_stop_all_status`, `list_panes`, `get_terminal_history`) and the c55.15 approvals defs all use
`toHttp` to preserve a non-default status/body contract.

**Encoding decision (status-via-kinds where possible, `toHttp` for the structured shape):**

| Outcome | handler returns | `toHttp` maps to |
|---|---|---|
| pane not found | `{ kind: "ok", output: { notFound: true } }` *(sentinel — see §4c)* | `404 { error: "Pane not found" }` |
| success | `{ kind: "ok", output: { capabilityGates: <map\|null> } }` | `200 { success: true, capabilityGates: <map\|null> }` |

We deliberately model the 404 as an **`ok`-shaped sentinel** the `toHttp` inspects, NOT as
`kind:"blocked"` (403) or `kind:"error"` (500) — those would change the status the existing suite
asserts. The handler is rest-only, so this `output` shape is pure-UI and the voice path never sees it
(consistent with the `surfaces: new Set(["rest"])` rule for `toHttp` defs, `rest.ts:26-27`).

---

## 4. The design decisions (each with rationale)

### (a) Args schema

```ts
const SetPaneGatesParams = z.object({
  project_id: z.string(),
  pane_id: z.string(),
  // The WHOLE override map (full replacement, not a single entry). Values are validated/normalized
  // IN-HANDLER (Auto|Ask|Off filter), NOT via z.enum, to reproduce the inline route's silent-drop of
  // invalid entries (a z.enum would 500 on a bad value; the inline route quietly skips it). An empty/
  // absent map CLEARS the override.
  capability_gates: z.record(z.string()).optional(),
});
```

- **Snake_case route segments** so Express injects `:project_id`/`:pane_id` directly onto the snake
  zod keys (the Batch-B/-D param-skew pattern — `set_pane_permissions`, `lifecycle_rest`). The inline
  route used camelCase `:projectId`/`:paneId`; the def's `rest.path` rewrites them to snake_case.
- **Body alias `capabilityGates` → `capability_gates`** via `coerceArgs` (the matrix editor PUTs
  `{ capabilityGates: {...} }`; the snake zod key is `capability_gates`). Same shape as
  `set_pane_permissions`'s `{permissions → permissions_mode}` alias (`locks.ts:200`).
- `z.record(z.string())` (NOT `z.record(GateEnum)`): the inline route accepts any object and filters;
  promoting to an enum would change the silent-drop behavior into a zod-500 (regression bar #3).

### (b) GATING — the meta-gate reconciliation (the subtle one)

A bulk gate-map write **is** a "changing the locks" / meta-gate change (P2: safety changes are GATED).
But the inline route applies **unconditionally and ungated** today, and `test_pane_gates_rest.ts`
expects an immediate `200`. Reconcile with the meta-gate self-gate rule
(`locks.ts:15-17`, `capabilities.ts` self-gate posture, handoff design 2026-06-01) as follows:

**Decision: `set_pane_gates` is the deliberate UI loosening surface — it preserves the inline route's
ungated, verbatim, immediate-apply behavior. It does NOT route through `gateOrDefer`, and it does NOT
apply the voice tighten-only `isLoosening` refusal.**

Rationale (this is the *core* product call, grounded in the existing meta-gate doctrine):
- The meta-gate's tighten-only rule (`locks.ts:311-339`) exists so a **confused/misheard Janus cannot
  loosen its own restraints by VOICE**. The inline comment at `server.ts:804-806` states it explicitly:
  *"the UI is the deliberate place where LOOSENING is allowed (voice may only tighten — see the tool
  handler), so this endpoint writes the operator-chosen map verbatim."*
- `set_pane_gates` is **operator-direct UI** (REST, behind the shared director-token auth at
  `app.use("/api", authMiddleware)`), NOT a Janus-proactive surface. It is the human turning the dials.
  Per P1, the gate matrix governs **unprompted** proactivity; this route is never an unprompted Janus
  act, so gating it would only add friction to the operator's own deliberate matrix edit.
- Gating it (e.g. via `gateOrDefer("set_capability_gate", …)`) would make the matrix-editor "Save"
  button Ask-defer or 403 against the very capability it is trying to set — a UX deadlock, and it would
  break `test_pane_gates_rest.ts` (which expects immediate `200`).

**So: ungated, verbatim, immediate.** This is consistent with the other operator-UI converged defs
(notes, archive, watch-rules) that are `ALWAYS_ALLOWED` and apply instantly. The **capability row it
declares is `set_capability_gate`** (for matrix projection + docs + audit attribution), but per the
handler-owned gate model (`types.ts:200-208`), *declaring* the capability is NOT a promise that
`runAction` enforces it — the **handler is the authority**, and this handler deliberately does not gate
(exactly like `set_capability_gate`'s own handler owns its directional enforcement rather than calling
`gateOrDefer`).

> **Open product note for the director (surface, don't block):** if you ever want the bulk **loosen**
> path itself gated (e.g. require a confirm when the operator loosens many panes at once), the seam is
> ready — the handler could call `ctx.gateOrDefer("set_capability_gate", pane_id, …)` and ride
> status-via-kinds. Today we preserve the inline ungated behavior to keep the matrix editor frictionless
> and the regression suite green. Defaulting to "preserve current behavior" matches every prior c55 wave.

### (c) `rest.toHttp` contract (exact status + body)

```ts
rest: {
  method: "put",
  path: "/api/projects/:project_id/panes/:pane_id/capability-gates",
  toHttp: (result, _args) => {
    const out = (result as { output?: unknown }).output as
      | { notFound: true }
      | { capabilityGates: CapabilityGateMap | null }
      | undefined;
    if (out && (out as { notFound?: boolean }).notFound) {
      return { status: 404, body: { error: "Pane not found" } };
    }
    const gates = (out as { capabilityGates?: CapabilityGateMap | null })?.capabilityGates ?? null;
    return { status: 200, body: { success: true, capabilityGates: gates } };
  },
},
```

- `404 { error: "Pane not found" }` — byte-identical to the inline route.
- `200 { success: true, capabilityGates: <map|null> }` — byte-identical, including the
  `?? null`-clears-to-`null` contract (regression bar #2).

### (d) Route-param → action-param mapping

`:projectId/:paneId` (inline camelCase) → `project_id`/`pane_id` (snake): handled by rewriting
`rest.path` to snake_case segments so Express's `req.params` lands directly on the snake zod keys (the
Batch-B/-D precedent — no camelCase skew). Arg precedence in `mountRestRoutes` is
`query < params < body` (`rest.ts:94-98`), and `coerceArgs` aliases the body `capabilityGates` key.

### (e) Does `set_capability_gate` stay or get subsumed?

**It STAYS, untouched in behavior.** It is the **voice** meta-gate (single-entry, tighten-only,
self-gating) and is referenced directly by `test_voice_tools.ts` and `test_voice_tool_goldens.ts`.
Subsuming it would break the voice contract. The ONLY edit to it is **removing its dormant `rest`
binding** (which was never mounted) so the path's single owner becomes `set_pane_gates`. After this:
- `set_capability_gate` → `surfaces: new Set(["voice"])` (voice-only), and it MUST be added to
  `INTENTIONAL_ASYMMETRY` as `["voice"]` (it becomes single-surface → the §8.4 coverage guard would
  otherwise flag it; today it dodges the guard only because its dormant rest binding makes it
  "multi-surface" — removing the binding flips that). See risk R3.

---

## 5. File touchpoints (exact)

1. **`src/actions/defs/locks.ts`**
   - **Edit `setCapabilityGate`**: remove the `rest: { method:"put", path:".../capability-gates" }`
     line; change `surfaces` from `new Set(["voice","rest"])` → `new Set(["voice"])`. Handler unchanged.
   - **Add new `setPaneGates: ActionDef<typeof SetPaneGatesParams>`** (schema + `coerceArgs` alias +
     `rest` with `toHttp` + ungated verbatim handler reproducing inline (A)–(H)).
   - **Append `setPaneGates` to `LOCKS_ACTIONS`** (after `setCapabilityGate`).
   - Import `CapabilityGateMap` is already imported at `locks.ts:22`.

2. **`src/actions/coverage.ts`** (`INTENTIONAL_ASYMMETRY`)
   - **Add** `set_capability_gate: new Set<Surface>(["voice"])` (now voice-only).
   - **Add** `set_pane_gates: new Set<Surface>(["rest"])` (rest-only by design — operator-UI; voice uses `set_capability_gate`).

3. **`server.ts`**
   - **Delete** the inline `app.put("/api/projects/:projectId/panes/:paneId/capability-gates", …)` block
     (lines ~804-844, comment + route).
   - **Add** `"set_pane_gates"` to the `mountRestRoutes` `only`-set (`server.ts:1193`).
   - Leave a one-line cutover comment in the deleted route's place (the c55.* convention).

4. **`src/actions/inlineExceptions.ts`**
   - **Delete** the `held` row at line 45 (the route is now a registry def — the no-twin guard's
     "stale entry" test fails if you delete the route but keep the catalog row, and the "undeclared"
     test fails if you keep the route but delete the row, so route-delete + row-delete must land
     together).

5. **`tests/test_c55_16_set_pane_gates.ts`** (NEW — see §6).

6. **`tests/test_pane_gates_rest.ts`** — **DO NOT edit**; it is the live in-process regression harness
   that must keep passing through the cutover (its `PUT …/capability-gates` round-trips now hit the
   registry handler instead of the inline route, producing identical responses).

> **No matrix-file edits.** Because `set_pane_gates.capability === "set_capability_gate"` (an existing
> row), `deriveCapabilities(REGISTRY)` is unchanged, so `gateSurface.ts` ALL_CAPABILITIES,
> `capabilities.ts` CAPABILITY_DEFS, `types.ts` CapabilityGate union / DEFAULT_CAPABILITY_GATES, and
> `e2e/harness.ts` DEFAULT_MOCK_GATES are all untouched. The §8.1b subset+equality invariant holds
> with zero gate-matrix changes — this is the deliberate lever.

---

## 6. Bite-sized TDD implementation plan

Follow `tests/test_c55_14_lifecycle.ts` as the doctrine template (def-level deterministic: fake ctx +
`runAction` + `applyResultToHttp`, plus a text-scan cutover guard). Each step is RED→GREEN.

**Step 1 — (shape, RED).** New `tests/test_c55_16_set_pane_gates.ts`. Assert the registry contains a
def `set_pane_gates`: `surfaces` === `{rest}`, `capability` === `"set_capability_gate"`,
`readOnly:false`, `rest.method === "put"`, `rest.path === "/api/projects/:project_id/panes/:pane_id/capability-gates"`,
`typeof rest.toHttp === "function"`, and `INTENTIONAL_ASYMMETRY.set_pane_gates` deep-equals
`new Set(["rest"])`. → fails (no def).

**Step 2 — (GREEN).** Add `SetPaneGatesParams`, `setPaneGates` def (stub handler returning
`{kind:"ok", output:{capabilityGates:null}}`), `coerceArgs` alias, `rest` + `toHttp`; append to
`LOCKS_ACTIONS`; add the two `INTENTIONAL_ASYMMETRY` rows. → Step 1 green.

**Step 3 — (success fidelity, RED→GREEN).** With a fake ctx (fake `manager.ledger.getProject` returning
a ws whose `panes[pane_id]` exists; record `updatePane(projectId, pane, immediate)` calls,
`broadcastLedgerUpdate`, `broadcastTerminalsUpdated`, and `store.recordActivity`): call
`runAction(REGISTRY, "set_pane_gates", { project_id, pane_id, capabilityGates: { write_to_pane:"Off", close_pane:"Ask" } })`.
Assert: result `kind:"ok"`; `pane.capabilityGates` deep-equals the map; `updatePane` called with
`(projectId, pane, true)`; both broadcasts fired; `recordActivity` called with
`type:"permission_changed"`. Then `applyResultToHttp(def, result, args, fakeRes)` ⇒ `status 200`,
`json` deep-equals `{ success:true, capabilityGates:{write_to_pane:"Off",close_pane:"Ask"} }`.
Implement handler (A)→(H). → green.

**Step 4 — (normalize + clear, RED→GREEN).** (i) Map with an invalid value
`{ write_to_pane:"Off", bogus:"NOPE" }` ⇒ stored map drops `bogus`, body
`capabilityGates:{write_to_pane:"Off"}`. (ii) Empty `{}` ⇒ `pane.capabilityGates === undefined`, body
`capabilityGates: null`, `updatePane` still called (clear is durable), both broadcasts fired. (iii)
All-invalid map behaves like empty (clears). → green (the `Auto|Ask|Off` filter + `any?clean:undefined`).

**Step 5 — (404 sentinel, RED→GREEN).** Fake ctx where `getProject` returns a ws with no matching pane
(or `null`): result is the `ok`-shaped `{notFound:true}` sentinel; `updatePane` NOT called; **no
broadcasts**; `applyResultToHttp` ⇒ `status 404`, `json` deep-equals `{ error:"Pane not found" }`. →
implement the pane-existence pre-check before any mutation. → green.

**Step 6 — (coerceArgs alias, RED→GREEN).** Call `runAction` with the **camelCase** body key
`{ project_id, pane_id, capabilityGates:{...} }` (the matrix editor's real shape) AND a route-param-only
call; assert the handler sees `capability_gates`. (Belt-and-suspenders: also assert a snake-key
`capability_gates` call is untouched — alias only fills when the snake key is absent, mirroring
`set_pane_permissions` `coerceArgs`.) → green.

**Step 7 — (cutover guard, RED→GREEN).** In the same test file, read `server.ts` as text (the
`test_c55_14` pattern): assert the `mountRestRoutes` only-set block **includes** `"set_pane_gates"`,
and assert the inline route is **deleted**:
`!/app\.put\(\s*["']\/api\/projects\/:projectId\/panes\/:paneId\/capability-gates["']/.test(serverSrc)`.
Then perform the server.ts edits (delete inline route, add name to only-set). → green.

**Step 8 — (catalog reconcile, RED→GREEN).** Run `tests/test_no_inline_twins.ts` — it goes RED with a
**stale entry** (the route is gone from server.ts but the `held` row remains). Delete the
`inlineExceptions.ts:45` row. Re-run → both no-twin tests green (no undeclared route, no stale entry).

**Step 9 — (live regression, GREEN).** Run `tests/test_pane_gates_rest.ts` (the in-process server
suite). All five assertions must pass **unchanged** — round-trip, clear-to-null, invalid-drop,
404-unknown-pane, posture-flow — proving the registry handler is a faithful twin. Then run the
matrix invariants `tests/test_action_registry.ts` (§8.1b) and the coverage guard
`tests/test_action_coverage.ts` (§8.4 #20) — both green with no matrix edits.

**Step 10 — (full battery).** `npm run lint` (tsc --noEmit), `npm test`
(`tsx --test --test-force-exit`), `npm run catalog` if the drift guard flags. Confirm green.

---

## 7. Risks

- **R1 — `set_capability_gate` surface flip breaks the coverage guard.** Removing the dormant `rest`
  binding makes `set_capability_gate` single-surface (`voice`), so `unexpectedAsymmetries` (`coverage.ts:185`)
  will flag it unless it is added to `INTENTIONAL_ASYMMETRY`. **Mitigation:** Step 2 adds the
  `set_capability_gate: ["voice"]` row in the SAME change. (Today it passes the guard only because the
  dead rest binding makes `isMultiSurface` true — that crutch is removed here, which is *correct*.)

- **R2 — schema-hash drift quarantines an in-flight intent.** `actionSchemaHash` (`registry.ts:381`)
  hashes `{name, capability, sorted param keys}`. We are NOT changing `set_capability_gate`'s name,
  capability, or params (only its surfaces + rest binding, which are excluded from the hash), so its
  hash is **stable** — no quarantine. `set_pane_gates` is a brand-new name (new hash, no prior staged
  intents). **No durable-replay hazard.** (Confirmed: surfaces/rest are not in the hash material.)

- **R3 — the no-twin guard's known text-scan footgun.** The guard regex matches commented-out
  `app.put('…')` lines too (`test_no_inline_twins.ts:17-21`). When deleting the inline route, replace
  it with a **prose** cutover comment (no `app.put("…")` literal), or the guard will still "see" it as a
  live undeclared route after you delete the catalog row. Use the `// c55.16: …now served by …` prose
  form the other converged routes use.

- **R4 — body delta on the 404 path.** The inline route returns `404 {error:"Pane not found"}`. The
  registry path reproduces it EXACTLY via `toHttp`. The only *accepted* behaviorDelta is that an
  unhandled handler throw maps to `500 {error}` via the `rest.ts:102-105` catch (dead code today —
  `runAction` never throws). No client reads the 404 body beyond status; `test_pane_gates_rest.ts:134`
  asserts status only. **Low risk.**

- **R5 — `updatePane` vs `ledger.save()` durability (SQLite).** The inline route uses
  `manager.ledger.updatePane(projectId, pane, true)` deliberately (a bare `save()` is a SQLite no-op
  that silently drops the override — schema v4 `capability_gates` column, comment at `server.ts:826-828`).
  The handler **must** call `updatePane`, not `save()`, on BOTH the set and clear paths. Pinned by the
  Step-3/Step-4 fake-ctx assertion on the `updatePane` call. **Mitigated by test.**

- **R6 — `store` optional on some ctx paths.** `recordActivity` is wrapped in `try/catch` and guarded by
  `if (ctx.store)` in the inline route. The handler must keep that guard (`ctx.store` is `null` under
  `JANUS_LEDGER_BACKEND=legacy`). The fake-ctx test should cover both `store` present and `store:null`.

- **R7 — empty-clear still broadcasts.** The inline route fires both broadcasts even when clearing
  (empty map). The handler must broadcast on the clear path too (so chips repaint back to the global
  default). Pinned by Step-4(ii).

---

## Adversarial review (c55-closeout workflow)

**Verdict: sound-with-fixes.** Every load-bearing claim checks out against the actual code.

### Required fixes

1. **MINOR (correctness of the design's own prose, not the impl):** R1's causal explanation is wrong — the §8.4 guard (`coverage.ts:168-178` `surfaceCoverage`) reads `def.surfaces.has('rest')`, the SURFACES SET, not the dormant rest binding object. `set_capability_gate` is multi-surface today because `surfaces===new Set(['voice','rest'])` (`locks.ts:309`), NOT because of the binding. The fix (add `set_capability_gate:['voice']` to `INTENTIONAL_ASYMMETRY` when flipping surfaces to `{voice}`) is correct and unchanged — just correct the rationale so the implementer flips BOTH the surfaces set AND removes the binding (the design already says to do both in §5.1; ensure the surfaces flip, not merely the binding removal, is what satisfies the guard).
2. **DO the cutover atomically in ONE change:** (1) flip `set_capability_gate` surfaces→`{voice}` + remove its rest binding, (2) add BOTH `INTENTIONAL_ASYMMETRY` rows (`set_capability_gate:['voice']` AND `set_pane_gates:['rest']`), (3) add `set_pane_gates` def to `LOCKS_ACTIONS`, (4) add `'set_pane_gates'` to the `mountRestRoutes` only-set, (5) delete the inline route, (6) delete `inlineExceptions.ts:45`. Any subset landing alone breaks a guard: missing (2) → `test_action_coverage` §8.4#20 RED; (5) without (6) → no-twin "stale entry" RED; (6) without (5) → no-twin "undeclared" RED.
3. **When deleting the inline route (server.ts:810-844) replace it with a PROSE-ONLY cutover comment** containing NO `app.put('...')` string literal (R3) — the no-twin guard's `ROUTE_RE` (`test_no_inline_twins.ts:22`) is a raw-text scan that matches commented-out `app.<verb>('<path>')` lines and would re-register the route as "undeclared" after the catalog row is deleted.
4. **Handler must reproduce inline (A)-(H) EXACTLY:** pane-existence pre-check returns the `{notFound:true}` ok-sentinel BEFORE any mutation/broadcast (404 path fires NO `updatePane`, NO broadcasts — matches inline early-return at `server.ts:815`); use `manager.ledger.updatePane(projectId, pane, true)` NOT `save()` on BOTH set and clear (R5 — SQLite no-op otherwise); fire `broadcastLedgerUpdate()`+`broadcastTerminalsUpdated()` on BOTH set and clear paths (R7); guard store with `if(ctx.store)`+try/catch (R6); `pane.capabilityGates = any ? clean : undefined` (empty/all-invalid clears to undefined; body reports `?? null`). The inline audit summary string is `'UI set per-pane gates for <id> (<n> override(s))'` with payload `{action:'set_pane_gates', capabilityGates: any?clean:null}` (`server.ts:836-837`) — reproduce or intentionally simplify, but note the design's §2 transcription (E) omitted the exact summary string.
5. **coerceArgs: alias body `capabilityGates` → `capability_gates` ONLY when the snake key is absent** (mirror `set_pane_permissions` coerceArgs at `locks.ts:200-205`); coerceArgs runs BEFORE `params.parse` (`gemini.ts:191`) so `z.record(z.string()).optional()` then validates. Keep `z.record(z.string())` NOT `z.record(GateEnum)` so an invalid value (e.g. `{bogus:'NOPE'}`) is SILENTLY DROPPED by the in-handler `Auto|Ask|Off` filter rather than a zod-500 (regression bar #3 in `test_pane_gates_rest.ts`).
6. **VERIFY at impl time (not blocking, but pin it):** `apiFetch`'s non-2xx behavior — confirm the production client (`SettingsDialog.tsx:1100` catch) treats 404 the same way under the registry path as the inline path. Both return 404 on unknown pane, so this should be a no-op, but the e2e/mock harness (`DEFAULT_MOCK_GATES`) and any client error toast should be smoke-checked once.

### Issues / verified findings

- **VERIFIED SOUND** — every load-bearing claim checks out against the actual code. **(a) 8.1b invariants:** `set_pane_gates` reuses the EXISTING capability `'set_capability_gate'` (a row already in `CAPABILITY_DEFS` at `capabilities.ts:84` and the "Changing the locks" CATEGORY at `:37`). `deriveCapabilities()` de-dupes on `def.capability` (`capabilities.ts:106-116`), so a 2nd def with that capability adds ZERO derived capabilities → the SUBSET invariant holds; and the `ALL_CAPABILITIES===CAPABILITY_DEFS` equality assertion (`test_action_registry.ts:218-220`) is registry-INDEPENDENT, so it is untouched. "No matrix-file edits" is correct.
- **(a) P2/meta-gate reconciliation is GROUNDED, not hand-waved.** The "UI is the deliberate loosening surface, ungated" call is supported verbatim by the live inline comment at `server.ts:804-806` and by the handler-owns-gating model: `runAction` (`gemini.ts:200-222`) applies NO central gate ("runAction applies no gate of its own"; `ALWAYS_ALLOWED` is no longer special-cased) — the handler is the authority, exactly as `set_capability_gate`'s own handler owns its tighten-only enforcement. Declaring `capability:'set_capability_gate'` is purely for matrix projection/audit, not an enforcement promise.
- **(b) HTTP contract reproduced byte-for-byte.** `types.ts:389` confirms `toHttp:(result,args)=>{status,body}`; `rest.ts:120-132` `applyResultToHttp` routes through it (`res.status(status).json(body)`). The inline route at `server.ts:810-844` returns exactly `404 {error:'Pane not found'}` and `200 {success:true, capabilityGates: pane.capabilityGates ?? null}` with empty-clears-to-null — the design's `toHttp` matches. `readOnly:false` (so `redactResult` at `gemini.ts:222` is skipped, output passes through clean). CONFIRMED the React client (`SettingsDialog.tsx:1091-1103`) awaits the PUT but does NOT read the response body — it PUTs `{capabilityGates: gates ?? {}}` (camelCase, empty `{}` on clear, matching coerceArgs+clear semantics) and only relies on non-throw; so only status matters in prod, and `test_pane_gates_rest.ts` (the body-pinning regression harness) is reproduced exactly.
- **(c) no-twin guard stays green.** The held catalog row is real at `inlineExceptions.ts:45`; the live route is the ONLY `app.put(...capability-gates...)` in server.ts (grep-confirmed at `:810`). Deleting the route AND the row together drops the key from both the scanned "actual" set and the "declared" set (`test_no_inline_twins.ts:31-32`) simultaneously. R3 correctly flags the raw-text-scan footgun (`ROUTE_RE` at `:22` matches commented-out `app.put` lines — confirmed by the guard's own NOTE at `:17-21`) and mandates a PROSE cutover comment.
- **(d) every cited symbol/line/test is REAL and accurately described:** `locks.ts:302` `setCapabilityGate`, `:309` `surfaces:{voice,rest}`, `:310` dormant rest binding, `:22` `CapabilityGateMap` import; `set_capability_gate` is confirmed ABSENT from the `mountRestRoutes` only-set (`server.ts:1193-1346`) so the binding IS dormant today; `registry.ts:381` `actionSchemaHash` material is `{name,capability,sorted param keys}` (R2 correct — surfaces/rest excluded, no quarantine); `test_c55_14_lifecycle.ts` is a real runAction+applyResultToHttp+makeFakeRes({status,json})+text-scan template.
- **(d) R1 mechanism is slightly IMPRECISE but the FIX is correct.** The design says `set_capability_gate` "dodges the §8.4 guard today only because its dormant rest binding makes `isMultiSurface` true." Actually `coverage.ts:168-178` reads `def.surfaces.has('rest')` (the surfaces SET), NOT the rest binding object — so it is multi-surface today because `surfaces===new Set(['voice','rest'])` (`locks.ts:309`), independent of the binding. The conclusion still holds: flipping surfaces to `{voice}` makes it single-surface and REQUIRES the `INTENTIONAL_ASYMMETRY` entry. Both required rows (`set_capability_gate:['voice']`, `set_pane_gates:['rest']`) are correctly specified; `test_action_coverage.ts:22-28` (`unexpectedAsymmetries===[]`) would go RED without BOTH.
- **(d) Precedent for two defs sharing one capability is REAL:** `restart_pane` (`locks.ts:256`) and `set_pane_permissions` (`locks.ts:190`) both declare `capability:'set_pane_permissions'`. So `set_pane_gates`+`set_capability_gate` sharing `'set_capability_gate'` is an established pattern, not novel risk.
- **(e) TDD plan is genuinely bite-sized and RED-first:** 10 steps each RED→GREEN following the real `test_c55_14` doctrine (def-shape, success fidelity, normalize+clear, 404 sentinel, coerceArgs alias, cutover text-guard, catalog reconcile, live regression, full battery).
