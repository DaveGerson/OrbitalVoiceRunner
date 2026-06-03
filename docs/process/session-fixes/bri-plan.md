# bri-plan — WS-F follow-up (scope C): convert remaining `gateCapability` apply-now sites to staged deferral

**Bead:** `wsm-e2e-pinned-bri` (P3, OPEN) — "Some non-PTY mutators still use `gateCapability` (Off-veto only; Ask proceeds) rather than `gateOrDefer`. Audit and convert to staged deferral. odb spec sec 3/9."
**Branch:** `feat/session-fixes` (worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes`)
**Builds on (already landed on-branch):** U1 `gateOrDefer`/`pendingActions` (commit `290e970`), G6 REST pane-spawn gate + `restGateOutcome` (`25b6f49`), the `buildLaunchCommand`/`applyHandoffFlipOnResolve` pure-extraction precedent (`af6463a`, `7cd90db`).
**Baseline (must not regress):** `npm test` = **478 pass / 0 fail**; `npm run lint` exit 0.

---

## BLUF

There is exactly **one** real divergence left: the **voice** `apply_orchestration_recipe` tool handler spawns-and-audits via `gateCapability` (apply-now), while the **REST** `/api/recipes/apply` path was already converted to per-pane `gateOrDefer` deferral by G6. Under `create_pane=Ask`, the same recipe applied by voice **spawns immediately** but applied by REST **stages and waits for confirm**. That breaks the product invariant "Ask means stage+confirm EVERYWHERE."

The fix mirrors the established pattern (`restGateOutcome`, `buildLaunchCommand`): **extract a pure, exported, side-effect-free planner** (`planRecipeApply`) that maps a recipe + a gate resolver to a per-pane disposition list (`spawn` / `defer` / `block` / `skip-existing`), TDD it as a pure function (the repo harness has no Express/PTY/session boot), then have BOTH recipe call sites consume it. The voice handler stops calling `gateCapability` per pane and instead defers Ask panes into `pendingActions` exactly like REST.

This is the only `gateCapability`-as-apply-now mutator path remaining. All other former apply-now mutators (`create_pane`, `set_global_permissions`, `set_pane_permissions`) already route through `gateOrDefer` (see Inventory §2). The bead is therefore **one site, one extraction**.

---

## 1. Problem & root cause (code-anchored, current branch state)

### 1.1 The two recipe paths diverge on the `Ask` tier

**VOICE path** — `server.ts:2430-2475`, tool `apply_orchestration_recipe`:

- `server.ts:2446` — `const recipeGate = gateCapability("apply_recipe", null);` → only the `Off` veto blocks the whole layout; **`Ask` falls through to apply-now.**
- `server.ts:2455` — `if (gateCapability("create_pane", p.id).forbidden) { blocked.push(p.id); continue; }` → per pane, **only `Off` is honored**; **`Ask` proceeds to spawn** at `server.ts:2460` (`manager.addTerminal(...)`), then audits. This is the G1 anti-pattern ("Ask was non-functional, only the Off veto worked") that `gateOrDefer` was built to eliminate — but this site never got converted.

`gateCapability` (`server.ts:1484-1493`) returns `{ forbidden: gate === "Off", gate }` and records an `exercise` audit event. It has **no `Ask`/defer branch** — by construction `Ask` === proceed.

**REST path** — `server.ts:1280-1310`, `POST /api/recipes/apply` (G6, already correct):

- `server.ts:1283` — `if (gateCapability("apply_recipe", null).forbidden) { 403 }` → layout-level `Off` veto (this single `gateCapability` use is **correct and stays**: it is a pure boolean veto on the *aggregate* capability, not a per-pane mutator).
- `server.ts:1293-1308` — builds a `spawnPane` closure per pane and routes it through `const g = gateOrDefer("create_pane", p.id, ...)` → `forbidden`→`blocked[]`, `deferred`→`deferred[{paneId,actionId}]`, `run`→spawn now + `spawned[]`. Responds `{ success, spawned, deferred, blocked }`.

**The divergence:** under `create_pane=Ask`, REST stages each pane in `pendingActions` (operator confirms via `POST /api/actions/:id/confirm`); voice spawns the PTY immediately. Same policy, opposite behavior depending on entry boundary. This is precisely the concrete divergence WF-2 holistic flagged.

### 1.2 Root cause

The G6 commit (`25b6f49`) converted the REST recipe path to `gateOrDefer` but **did not touch the voice tool handler** — `gateOrDefer` is invoked at six voice sites (create_pane `2322`, set_global_permissions `2344`, set_pane_permissions `2834`, plus the REST sites), yet the voice `apply_orchestration_recipe` handler was left on the old `gateCapability` apply-now logic. The per-pane spawn loop in voice and REST are near-duplicates that drifted: REST got the defer seam, voice did not.

### 1.3 Why a pure-extraction (not an inline edit)

- The repo has **no Express/PTY/session test harness** — every gate test is a pure-function test (`test_rest_gate.ts`, `test_pending_actions.ts`, `test_capability_gate.ts`). `server.ts` calls `startServer()` at module load, so importing it boots a real listener (noted at `test_rest_gate.ts:4-5`). You **cannot** unit-test the voice handler in place.
- TDD is mandatory. The only testable, fail-first surface is a pure function. This exactly mirrors the two landed precedents: `restGateOutcome` (`src/restGate.ts`, consumed by REST at `server.ts:775`) and `buildLaunchCommand` (`src/`, extracted from a PTY-spawning method in `af6463a`).
- Extracting the **per-recipe planning** (which panes spawn/defer/block, given a gate resolver) makes the voice↔REST reconciliation literally the same function, killing the drift permanently.

---

## 2. Inventory — every `gateCapability` vs `gateOrDefer` call site (audit for the bead)

`gateCapability(...)` sites (`server.ts`):

| line | capability | verdict |
|---|---|---|
| 1283 | `apply_recipe` (REST layout veto) | **KEEP** — pure aggregate `Off` veto, not a per-pane mutator; `Ask`/`Auto` correctly fall through to the per-pane `gateOrDefer` loop below it. |
| 1484 | — | definition of `gateCapability` itself. |
| 1495 | — | comment referencing `gateCapability` in the `gateOrDefer` doc. |
| 2446 | `apply_recipe` (VOICE layout veto) | **CONVERT context** — keep as the layout `Off` veto for parity with REST `1283`, BUT the per-pane loop beneath it must switch to deferral. |
| 2455 | `create_pane` (VOICE per-pane) | **CONVERT** — this is the apply-now `Ask`-bypass. Replace with `gateOrDefer` deferral. |

`gateOrDefer(...)` sites (all already correct, used as the conversion template): `774` (REST create_pane), `1305` (REST recipe per-pane), `2322` (voice create_pane), `2344` (voice set_global_permissions), `2834` (voice set_pane_permissions).

**Conclusion:** the *only* remaining apply-now mutator is the voice recipe per-pane spawn (`server.ts:2455`/`2460`). `apply_recipe` at `1283`/`2446` is a legitimate aggregate veto and stays as `gateCapability` (it has no "stage the whole layout" semantics — deferral happens at the pane grain). Scope is therefore one handler.

---

## 3. The exact changes (file : location : change)

### Change A — NEW pure planner: `src/recipeApply.ts`

Create `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes/src/recipeApply.ts`.

Export a pure function that, given the recipe panes, the set of already-live pane ids, and a per-pane gate resolver, returns the per-pane plan. **No side effects, no `addTerminal`, no broadcast, no `pendingActions`** — it only computes dispositions. The caller wires effects.

```ts
import type { CapabilityGate, GateValue } from "./types";

export type RecipePaneDisposition = "spawn" | "defer" | "block" | "skip-existing";

export interface RecipePanePlan {
  paneId: string;
  disposition: RecipePaneDisposition;
}

export interface RecipeApplyPlan {
  /** Layout-level Off veto on apply_recipe — caller refuses the whole layout. */
  layoutForbidden: boolean;
  panes: RecipePanePlan[]; // in recipe order
}

/**
 * Pure planner shared by the voice (`apply_orchestration_recipe`) and REST
 * (`POST /api/recipes/apply`) paths so the two cannot drift again (WF-2 divergence:
 * voice spawned-now on Ask while REST deferred). Mirrors restGateOutcome / buildLaunchCommand:
 * decision logic extracted out of the server so it is unit-testable (no Express/PTY/session boot).
 *
 * resolveLayout / resolvePane return the effective GateValue ("Off"|"Ask"|"Auto") for the
 * apply_recipe (layout) and create_pane (per-pane) capabilities respectively. The caller maps:
 *   spawn -> run the spawn effect now (Auto)
 *   defer -> stage in pendingActions (Ask)
 *   block -> Off veto on create_pane for that pane
 *   skip-existing -> pane already live; do nothing
 */
export function planRecipeApply(
  panes: ReadonlyArray<{ id: string }>,
  livePaneIds: ReadonlySet<string>,
  resolveLayout: () => GateValue,
  resolvePane: (paneId: string) => GateValue,
): RecipeApplyPlan {
  if (resolveLayout() === "Off") {
    return { layoutForbidden: true, panes: [] };
  }
  const out: RecipePanePlan[] = [];
  for (const p of panes) {
    if (livePaneIds.has(p.id)) { out.push({ paneId: p.id, disposition: "skip-existing" }); continue; }
    const g = resolvePane(p.id);
    out.push({
      paneId: p.id,
      disposition: g === "Off" ? "block" : g === "Ask" ? "defer" : "spawn",
    });
  }
  return { layoutForbidden: false, panes: out };
}
```

> Note: confirm the exact `CapabilityGate`/`GateValue` import path from `src/types.ts` (the gateSurface imports `import type { CapabilityGate, GateValue, CapabilityGateMap } from "./types";` at `src/gateSurface.ts:19`). `GateValue` is the `"Off"|"Ask"|"Auto"` union. `CapabilityGate` import is only needed if you type the resolver args; keep imports minimal to avoid an unused-import lint error (`tsc --noEmit`).

### Change B — VOICE handler consumes the planner + defers Ask panes: `server.ts:2442-2470`

Replace the per-pane `gateCapability` apply-now loop (currently `server.ts:2446-2469`) with:

1. Build `livePaneIds = new Set(Object.keys(manager.terminals))`.
2. Call `planRecipeApply(recipe.panes, livePaneIds, () => effectiveCapabilityGateFor(null, "apply_recipe"), (id) => effectiveCapabilityGateFor(id, "create_pane"))`.
   - If `plan.layoutForbidden` → set `resp = "Error: the 'apply_recipe' capability is gated Off; ..."` (preserve current wording at `2448`).
3. Iterate `plan.panes`. For each:
   - `skip-existing` → continue.
   - `block` → push to `blocked[]`.
   - `defer` → **stage in `pendingActions`** by calling `gateOrDefer("create_pane", paneId, \`Create pane ${paneId} (recipe ${recipe.id})\`, spawnPaneFor(paneId))` and push to `deferred[]` (its `actionId`). Reuse the SAME `spawnPane` closure shape REST uses at `server.ts:1293-1304` (bare shell, `addPaneNote` for `startupCommand`, `broadcastLedgerUpdate()` + `broadcast({type:"terminals_updated"})` **inside** the closure so a deferred-confirm repaints).
   - `spawn` → run `spawnPaneFor(paneId)()` now and push to `spawned[]`.

   **Simplest faithful implementation:** instead of re-branching on the disposition, mirror REST exactly — for every non-existing, non-`skip` pane call `gateOrDefer("create_pane", p.id, summary, spawnPane)` and branch on `g.disposition` (`forbidden`→blocked, `deferred`→deferred, `run`→spawn+spawned), guarded by the layout `apply_recipe` Off veto. In that case the planner's role is the **tested contract**; the handler may either (a) consume `planRecipeApply` directly, or (b) replicate REST's `gateOrDefer` loop verbatim. **Prefer (a)** so voice and REST share one planner and the test pins the shared seam. Use `gateOrDefer` for the `defer`/`run`/`forbidden` mapping so the audit + `broadcast({type:"action_pending"})` + `pendingActions.add` all fire identically to REST.

4. Update the voice response string to report deferrals, e.g.:
   `resp = \`Template recipe layout '${recipe.name}': spawned ${spawned.length}, ${deferred.length} awaiting confirmation (create_pane=Ask), ${blocked.length} blocked by create_pane=Off.\`;`
   (Voice answers the model with a single string — there is no JSON body like REST. Include the deferred count so the model can narrate "I've queued N panes for your confirmation.")

**Keep** the layout `Off` veto at `2446` as a `gateCapability("apply_recipe", null).forbidden` check OR fold it into `plan.layoutForbidden` (the planner already does the `Off` check via `resolveLayout`). Folding it in is cleaner and removes the last stray `gateCapability` from this handler; the `apply_recipe` audit event that `gateCapability` emitted is non-essential here (the per-pane `gateOrDefer` calls emit their own `permission_changed` audit rows). If you want to preserve the layout-level audit row, keep one `gateCapability("apply_recipe", null)` call purely for its audit side effect before planning — document the choice inline.

### Change C — (Optional, recommended) REST handler also consumes the planner: `server.ts:1280-1310`

To make voice↔REST provably identical, refactor REST `/api/recipes/apply` to call `planRecipeApply` too, then drive `gateOrDefer` from the plan. This is **low-risk** (REST already behaves correctly; the planner reproduces its exact branch logic) and turns the test into a true single-source-of-truth guarantee. If you want to minimize blast radius, you may leave REST as-is (it is already correct) and only converge voice onto the planner — but then the "no future drift" guarantee is weaker. **Recommendation:** do Change C; it is a few lines and the planner output maps 1:1 onto REST's existing `spawned/deferred/blocked` arrays.

### Out of scope (do NOT touch)

- `gateCapability` definition (`1484`) and the `apply_recipe` aggregate veto semantics — `apply_recipe` legitimately has no per-layout defer.
- `handoff_context_between_panes` (`2476`) / `propose_handoff` (`2503`) — explicitly **ungated** (model-context writes, not CLI writes; documented at `2482-2485`). Not mutator gates.
- `set_voice_mute` (`2352`) and other non-capability settings toggles.
- The pane WRITE path (`resolveDecision`/`applyResolution`/`pendingApprovals`) — separate concern (`pendingActions.ts:11-14`).

---

## 4. TEST-FIRST plan (failing test first, then implement, then green)

Runner: `cd "C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes" && npm test` (i.e. `tsx --test --test-force-exit tests/*.ts`). New file: `tests/test_recipe_apply.ts`.

### Step 1 — write the failing test (must fail for the RIGHT reason)

`tests/test_recipe_apply.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { planRecipeApply } from "../src/recipeApply"; // FAILS FIRST: src/recipeApply.ts does not exist (TS2307 / missing export)
import { PendingActionStore } from "../src/pendingActions";

const panes = [{ id: "build" }, { id: "test" }, { id: "review" }];

describe("planRecipeApply — pure recipe gate planner (bri)", () => {
  it("layout apply_recipe=Off forbids the whole layout, zero pane plans", () => {
    const plan = planRecipeApply(panes, new Set(), () => "Off", () => "Auto");
    assert.strictEqual(plan.layoutForbidden, true);
    assert.deepStrictEqual(plan.panes, []);
  });

  it("create_pane=Auto -> every pane spawns now", () => {
    const plan = planRecipeApply(panes, new Set(), () => "Auto", () => "Auto");
    assert.strictEqual(plan.layoutForbidden, false);
    assert.deepStrictEqual(plan.panes.map(p => p.disposition), ["spawn", "spawn", "spawn"]);
  });

  it("create_pane=Ask -> every pane DEFERS (the WF-2 divergence: voice must stage, not spawn)", () => {
    const plan = planRecipeApply(panes, new Set(), () => "Auto", () => "Ask");
    assert.deepStrictEqual(plan.panes.map(p => p.disposition), ["defer", "defer", "defer"]);
  });

  it("create_pane=Off -> every pane is blocked", () => {
    const plan = planRecipeApply(panes, new Set(), () => "Auto", () => "Off");
    assert.deepStrictEqual(plan.panes.map(p => p.disposition), ["block", "block", "block"]);
  });

  it("already-live panes are skipped, not re-planned", () => {
    const plan = planRecipeApply(panes, new Set(["test"]), () => "Auto", () => "Ask");
    const byId = Object.fromEntries(plan.panes.map(p => [p.paneId, p.disposition]));
    assert.strictEqual(byId["test"], "skip-existing");
    assert.strictEqual(byId["build"], "defer");
  });

  it("per-pane gate is resolved PER PANE (mixed policy)", () => {
    const perPane = (id: string) => (id === "build" ? "Off" : id === "test" ? "Ask" : "Auto") as const;
    const plan = planRecipeApply(panes, new Set(), () => "Auto", perPane);
    assert.deepStrictEqual(plan.panes.map(p => p.disposition), ["block", "defer", "spawn"]);
  });
});

// Voice↔REST parity: a 'defer' plan staged into pendingActions runs the spawn effect ONLY on confirm
// (mirrors test_rest_gate.ts:29-42 but proves the recipe planner feeds the SAME deferral seam).
describe("recipe defer -> pendingActions: effect runs exactly on confirm (voice parity)", () => {
  it("a deferred recipe pane does not spawn until confirmed", () => {
    const store = new PendingActionStore();
    let spawns = 0, broadcasts = 0;
    const plan = planRecipeApply([{ id: "build" }], new Set(), () => "Auto", () => "Ask");
    for (const p of plan.panes) {
      if (p.disposition !== "defer") continue;
      store.add({ id: `act_${p.paneId}`, capability: "create_pane", summary: `Create pane ${p.paneId} (recipe r1)`, timestamp: Date.now(),
        run: () => { spawns++; broadcasts++; return p.paneId; } });
    }
    assert.strictEqual(spawns, 0, "staging a deferred recipe pane must NOT spawn (the voice bug)");
    store.confirm("act_build");
    assert.strictEqual(spawns, 1);
    assert.strictEqual(broadcasts, 1, "confirm must broadcast so the deferred pane repaints");
  });
});
```

**Confirm fail-first:** run `npm test`. Expect a TypeScript resolution failure on `../src/recipeApply` (module/export missing) — analogous to `test_rest_gate.ts:3` ("fails first: src/restGate.ts does not exist yet"). This proves the test exercises the new surface and is not vacuously green.

### Step 2 — implement Change A (`src/recipeApply.ts`)

Add the planner from §3.A. Re-run `npm test`: `test_recipe_apply.ts` goes green; all prior 478 still pass (no production code touched yet).

### Step 3 — implement Change B (voice handler) + optional Change C (REST)

Wire `planRecipeApply` into `server.ts:2442-2470` (and optionally `1280-1310`). Because the server isn't unit-tested directly, the **planner test IS the regression contract** for the gate logic; the handler edit is a mechanical wiring that reuses the already-tested `gateOrDefer`/`spawnPane`/`pendingActions` seams (themselves covered by `test_pending_actions.ts` + `test_rest_gate.ts`).

### Step 4 — full green gate (before commit)

```bash
cd "C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes" && npm run lint      # tsc --noEmit, exit 0 (catches unused imports / type drift in recipeApply.ts + handler)
cd "C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes" && npm test          # expect 478 + (7 new) = 485 pass / 0 fail
cd "C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes" && npm run build      # vite + esbuild -> dist/server.cjs compiles (catches server.ts wiring errors the unit suite can't see)
```

`npm run build` is the key safety net for Change B/C: since the voice handler edit has no direct unit test, a successful esbuild bundle of `server.ts` confirms the planner is wired with correct types and no syntax/reference breakage. `py -3 -m unittest tests.test_universal_terminal` is unaffected (no Python surface touched) but run it if you want the full battery green.

---

## 5. Risks

- **R1 — voice response-string shape.** Voice answers the model with one string, not JSON. If the string omits the deferred count, the model can't narrate "queued for confirmation" and the UX silently regresses to looking like nothing happened. **Mitigation:** assert the new wording mentions deferred count in the handler edit; build-check confirms it compiles. (No unit test reaches the string — keep it terse and correct by inspection.)
- **R2 — losing the `apply_recipe` layout audit row.** Folding the layout `Off` check into the planner drops the `gateCapability("apply_recipe")` `exercise` audit event. **Mitigation:** if audit parity matters, keep one `gateCapability("apply_recipe", null)` call for its side effect before planning (documented inline); otherwise accept the per-pane `gateOrDefer` audit rows as sufficient. Decide explicitly in the commit body.
- **R3 — `effectiveCapabilityGateFor` signature.** The planner takes resolver *callbacks*; the handler must pass `(paneId, capability)` in the order `effectiveCapabilityGateFor` expects (used at `server.ts:1485`, `1509` as `effectiveCapabilityGateFor(paneId, capability)`). Swapping arg order silently mis-gates. **Mitigation:** copy the call shape verbatim from `gateOrDefer` (`server.ts:1509`).
- **R4 — drift if only voice is converged (Change C skipped).** Leaving REST on its inline loop means the planner guarantees voice-correctness but not literal voice==REST. **Mitigation:** do Change C (recommended); else add a comment at both sites pointing to `planRecipeApply` as the contract.
- **R5 — `pendingActions` TTL/orphan behavior for recipe panes.** Deferred recipe panes now ride the same TTL sweep + WS-F resumption digest as other actions (`server.ts:1553-1557`). This is correct/desired (parity), but means a recipe applied under Ask and never confirmed will expire — verify that's acceptable (it is: same as a single deferred `create_pane`).
- **R6 — none of the server wiring is unit-covered.** Inherent to the harness. **Mitigation:** `npm run build` + the pure planner test + reuse of already-tested seams (`gateOrDefer`, `spawnPane`, `pendingActions.confirm`). Do not invent a new effect path; reuse REST's `spawnPane` closure verbatim.

---

## 6. Acceptance criteria

1. **Audit complete:** the doc enumerates every `gateCapability`/`gateOrDefer` site (§2) and identifies the voice recipe per-pane spawn (`server.ts:2455`/`2460`) as the sole remaining apply-now mutator; `apply_recipe` aggregate vetoes (`1283`, `2446`) are justified to stay.
2. **Pure planner exists & is tested:** `src/recipeApply.ts` exports `planRecipeApply`; `tests/test_recipe_apply.ts` fails-first (missing module), then passes, covering Off-layout, Auto/Ask/Off per-pane, mixed policy, skip-existing, and the defer→confirm-runs-once parity case.
3. **Voice path defers on Ask:** under `create_pane=Ask`, `apply_orchestration_recipe` stages each new pane in `pendingActions` (no immediate `addTerminal`), emits `action_pending`, and the spawn runs only on `POST /api/actions/:id/confirm` — behaviorally identical to `POST /api/recipes/apply`.
4. **No new `gateCapability` apply-now mutator remains** in `server.ts` (only the two `apply_recipe` aggregate vetoes, by design).
5. **Green battery:** `npm run lint` exit 0; `npm test` = **485 pass / 0 fail** (478 baseline + 7 new, no regression); `npm run build` produces `dist/server.cjs`.
6. **Clean tree:** `git -C ... status --short` clean after commit; commit subject references `wsm-e2e-pinned-bri`, body explains change+test, ends with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## 7. Anchored reference index (current branch)

- Voice `apply_orchestration_recipe` handler: `server.ts:2430-2475` (apply-now `gateCapability` at `2446`, `2455`; spawn at `2460`).
- REST `/api/recipes/apply` (correct G6 template): `server.ts:1280-1310` (layout veto `1283`; `spawnPane` closure `1293-1304`; `gateOrDefer` `1305`).
- `gateCapability` def: `server.ts:1484-1493`. `gateOrDefer` def: `server.ts:1503-1524`.
- Effective gate resolver: `effectiveCapabilityGateFor(paneId, capability)` — call shape at `server.ts:1485`, `1509`.
- `pendingActions` store: `src/pendingActions.ts` (confirm/cancel/expire/claim). REST confirm/cancel: `server.ts:1668-1688`.
- Extraction precedents to mirror: `src/restGate.ts` (`restGateOutcome`, consumed `server.ts:775`); `buildLaunchCommand` (commit `af6463a`); `applyHandoffFlipOnResolve` (commit `7cd90db`).
- Test precedents: `tests/test_rest_gate.ts` (fail-first import + defer-runs-on-confirm), `tests/test_pending_actions.ts` (claim/exactly-once).
- Type source: `GateValue` = `"Off"|"Ask"|"Auto"`, `CapabilityGate` union — `src/types.ts` (imported at `src/gateSurface.ts:19`).
