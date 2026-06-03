# G6 — REST terminal-create bypasses the capability gate

**Bead:** `wsm-e2e-pinned-9tv` (P2 · BUG · backend)
**Coordinates with:** U1 `wsm-e2e-pinned-9fe` (shared `gateOrDefer` / `pendingActions` plumbing)
**Worktree (all edits here):** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes` (branch `feat/session-fixes`)

---

## BLUF

The capability gate is enforced at the **voice boundary** (the Gemini tool-call handler) but not at the **mutation boundary**. Two REST routes — `POST /api/terminals` and `POST /api/recipes/apply` — call `manager.addTerminal()` directly with **zero gate check**, so a `create_pane=Off` policy is silently defeated by anyone hitting the HTTP API (including our own UI "Deploy Node Unit" button). The fix routes both REST spawn paths through the existing `gateOrDefer("create_pane", …)` seam (Off→403, Ask→202+actionId, Auto→spawn), moves the `broadcast()` calls **inside** the spawn effect closure so a deferred-then-confirmed spawn still repaints the UI, and teaches `App.tsx` to branch on `res.status` because `apiFetch` never throws on a non-2xx response.

---

## 1. Problem & Root Cause (code-anchored)

### 1a. The two ungated mutation sites

**`server.ts` `POST /api/terminals`** — currently (verified `server.ts:728-758`):

```ts
app.post("/api/terminals", (req, res) => {
  const { terminalId, cwd, command, toolPreset, permissionsMode, sessionId, projectId } = req.body;
  if (!terminalId || !command) { res.status(400)…; return; }
  // …cwd resolution…
  const result = manager.addTerminal(terminalId, resolvedCwd, command, toolPreset, permissionsMode, sessionId, projectId || "");
  broadcastLedgerUpdate();
  broadcast({ type: "terminals_updated" });
  res.json({ success: true, result });
});
```

No call to `gateCapability` or `gateOrDefer`. `addTerminal` spawns a live PTY unconditionally.

**`server.ts` `POST /api/recipes/apply`** — currently (verified `server.ts:1206-1234`):

```ts
app.post("/api/recipes/apply", (req, res) => {
  // …resolve proj, find recipe…
  for (const p of recipe.panes) {
    if (!manager.terminals[p.id]) {
      manager.addTerminal(p.id, proj.directory || process.cwd(), bareShell, …);
      if (p.startupCommand) manager.ledger.addPaneNote(…);
    }
  }
  broadcastLedgerUpdate();
  broadcast({ type: "terminals_updated" });
  res.json({ success: true });
});
```

Also ungated — even though the **voice** equivalent `apply_orchestration_recipe` (verified `server.ts:2272-2317`) *already* honors the gate: it checks `gateCapability("apply_recipe", null)` for the whole layout and `gateCapability("create_pane", p.id)` per pane. The REST route is the drift.

### 1b. Why the gate currently "works" — and where it leaks

The gate is real and well-tested, but only on the **voice path**. The reference implementation is the `create_pane` tool handler (verified `server.ts:2145-2171`): it builds a `createPaneEffect` closure (which does the `addTerminal` **and** the two broadcasts), then calls `gateOrDefer("create_pane", pane_id, summary, createPaneEffect)` and dispatches on `g.disposition` (`forbidden` / `deferred` / `run`). `gateOrDefer` itself (verified `server.ts:1395-1416`):

- `Off`  → `{ disposition: "forbidden" }` (audited, no side effect)
- `Ask`  → stages `run` in `pendingActions`, broadcasts `action_pending`, returns `{ disposition: "deferred", actionId, summary }`
- `Auto` → `{ disposition: "run" }` (caller invokes the effect now)

The deferred effect later runs **exactly once** via `POST /api/actions/:id/confirm` → `pendingActions.confirm(id)` (verified `server.ts:1560-1572` and `PendingActionStore`, exercised in `tests/test_pending_actions.ts`). **The REST routes never enter this machine.**

### 1c. The frontend half of the bug

`apiFetch` (verified `src/utils/api.ts:4-12`) only special-cases `401` (reload); it returns the `Response` for every other status and **never throws on 4xx/5xx**. So `handleCreateTerminal` (verified `src/App.tsx:926-986`) does:

```ts
await apiFetch("/api/terminals", { method: "POST", … });
setShowCreateModal(false);
fetchTerminals(); fetchLedger();
setActiveTerminalId(id);   // ← optimistically activates a pane that may never have spawned
```

After the fix, a `403` (gate Off) or `202` (gate Ask, deferred) would leave the modal closed and `activeTerminalId` pointing at a non-existent pane. The handler must read `res.status` and branch.

`handleApplyRecipe` (verified `src/App.tsx:662-673`) has the same `await … ; fetchTerminals()` shape with no status check.

---

## 2. The Exact Changes (`file:location:change`)

> Design choice (LOCKED): we reuse the **existing** `gateOrDefer` closure rather than inventing a new seam. To make the disposition→HTTP mapping **unit-testable without an HTTP harness** (the repo has none — see §3), we extract one pure helper that maps a `gateOrDefer` result to a status code, mirroring the existing extraction precedent (`applyHandoffFlipOnResolve`, commit 7cd90db).
>
> **VERIFIED CONSTRAINT (do not skip):** `server.ts` ends with `startServer().catch(console.error)` at module scope (confirmed at the file tail; `server.listen(PORT, …)` runs inside `startServer`). Therefore `import … from "../server"` in a unit test **boots a real listener** — it is NOT a safe import. Change A MUST land the helper in a **new module `src/restGate.ts`** and `server.ts` imports it from there. Do NOT `export` it from `server.ts` and import `../server` in the test.

### Change A — `src/restGate.ts`: pure status-mapping helper (NEW module)

Create `src/restGate.ts` (side-effect-free) and import it into `server.ts` (near the other gate helpers, ~`server.ts:1416`, used inside both routes):

```ts
// G6: map a gateOrDefer disposition onto the REST contract for non-PTY spawn mutators.
//   Off       -> 403 (forbidden by policy, no side effect ran)
//   Ask        -> 202 (deferred; body carries actionId so the UI can track the pending action)
//   Auto       -> 200 (caller already ran/should run the effect; body carries its result)
// Pure + exported for unit test (no Express, no PTY). Keep in lockstep with gateOrDefer's union.
export function restGateOutcome(
  g: { disposition: "run" } | { disposition: "forbidden" } | { disposition: "deferred"; actionId: string; summary: string }
): { status: 200 | 202 | 403; body: Record<string, unknown> } {
  if (g.disposition === "forbidden") return { status: 403, body: { error: "create_pane is gated Off; pane creation is forbidden by policy.", capability: "create_pane" } };
  if (g.disposition === "deferred") return { status: 202, body: { deferred: true, actionId: g.actionId, summary: g.summary } };
  return { status: 200, body: { success: true } };
}
```

In `server.ts`, add `import { restGateOutcome } from "./src/restGate";` alongside the existing `./src/pendingActions` import (`server.ts:38`). `restGateOutcome` is the **failing-test-first** target (§3).

### Change B — `server.ts:728-758`: gate `POST /api/terminals`

Replace the direct `addTerminal` + broadcasts with the effect-closure + `gateOrDefer` + `restGateOutcome` pattern. The broadcasts MOVE **inside** `spawnEffect` (so a deferred confirm still repaints):

```ts
app.post("/api/terminals", (req, res) => {
  const { terminalId, cwd, command, toolPreset, permissionsMode, sessionId, projectId } = req.body;
  if (!terminalId || !command) { res.status(400).json({ error: "Missing required fields" }); return; }
  // …existing resolvedCwd resolution + projectId sync (server.ts:737-753) UNCHANGED…
  const spawnEffect = (): string => {
    const result = manager.addTerminal(terminalId, resolvedCwd, command, toolPreset, permissionsMode, sessionId, projectId || "");
    broadcastLedgerUpdate();
    broadcast({ type: "terminals_updated" });
    return String(result);
  };
  const g = gateOrDefer("create_pane", terminalId, `Create pane ${terminalId} (${command})`, spawnEffect);
  const out = restGateOutcome(g);
  if (g.disposition === "run") out.body.result = spawnEffect();   // Auto: run now, return its result
  res.status(out.status).json(out.body);
});
```

> NOTE: the `projectId` ledger-sync block (`server.ts:747-753`) stays **before** the gate — it mutates only ledger metadata, not a PTY, and matches the voice handler's behavior of ensuring the project exists. The PTY spawn is the only thing gated.

### Change C — `server.ts:1206-1234`: gate `POST /api/recipes/apply`

Mirror the voice `apply_orchestration_recipe` semantics (whole-layout `apply_recipe` veto + per-pane `create_pane` veto), but for REST return the right status. Because a recipe spawns *N* panes, the route gates per pane and reports a structured result; the simplest correct contract that satisfies acceptance ("no create path bypasses the gate"):

```ts
app.post("/api/recipes/apply", (req, res) => {
  const { recipeId } = req.body;
  const activeProjectId = manager.ledger.activeProjectId || "default_project";
  const proj = manager.ledger.getProject(activeProjectId);
  if (!proj) { res.status(404).json({ error: "No active workspace is registered." }); return; }
  const recipe = recipes.find(r => r.id === recipeId);
  if (!recipe) { res.status(404).json({ error: "Recipe layout not found." }); return; }
  // Whole-layout veto (mirror server.ts:2288-2290).
  if (gateCapability("apply_recipe", null).forbidden) {
    res.status(403).json({ error: "apply_recipe is gated Off; spawning template layouts is forbidden by policy.", capability: "apply_recipe" });
    return;
  }
  const bareShell = manager.settings.advanced.defaultShellCommand || (process.platform === "win32" ? "cmd.exe" : "bash");
  const spawned: string[] = [];
  const deferred: { paneId: string; actionId: string }[] = [];
  const blocked: string[] = [];
  for (const p of recipe.panes) {
    if (manager.terminals[p.id]) continue;
    const spawnPane = (): string => {
      manager.addTerminal(p.id, proj.directory || process.cwd(), bareShell, p.preset as any, p.permissionsMode as any, "", activeProjectId);
      if (p.startupCommand) manager.ledger.addPaneNote(activeProjectId, p.id, `Suggested startup command: ${p.startupCommand}`);
      broadcastLedgerUpdate();
      broadcast({ type: "terminals_updated" });
      return p.id;
    };
    const g = gateOrDefer("create_pane", p.id, `Create pane ${p.id} (recipe ${recipe.id})`, spawnPane);
    if (g.disposition === "forbidden") blocked.push(p.id);
    else if (g.disposition === "deferred") deferred.push({ paneId: p.id, actionId: g.actionId });
    else { spawnPane(); spawned.push(p.id); }
  }
  res.json({ success: true, spawned, deferred, blocked });
});
```

> The recipe route stays `200` (it is a partial/batch operation; per-pane outcomes are in the body). Only the **whole-layout `apply_recipe=Off`** veto returns `403`, matching the voice handler's "forbids the whole layout" comment (`server.ts:2286-2290`). Each pane's broadcast is inside `spawnPane`, so deferred-confirm spawns still repaint.

### Change D — `src/App.tsx:926-986`: branch on status in `handleCreateTerminal`

After the `await apiFetch(...)`, read the response **before** optimistically activating:

```ts
const res = await apiFetch("/api/terminals", { method: "POST", headers: {...}, body: ... });
if (res.status === 403) {
  // gate Off: pane was NOT created. Close modal, surface refusal, do not activate.
  setShowCreateModal(false);
  playEarcon("alert");            // VERIFIED token set in App.tsx: "alert"|"chime"|"execute"|"success" — there is NO "error" token
  return;
}
if (res.status === 202) {
  // gate Ask: deferred. The action_pending broadcast already added a pending-action chip.
  // Close the modal but do NOT setActiveTerminalId — the pane does not exist yet.
  setShowCreateModal(false);
  playEarcon("execute");          // queued, awaiting confirm
  return;
}
// 200 path (Auto): pane spawned.
setShowCreateModal(false);
fetchTerminals(); fetchLedger();
setActiveTerminalId(id);
```

> The mock-mode early return (`src/App.tsx:933-966`) is UNCHANGED — it never hits HTTP. **Earcon vocabulary is VERIFIED** = `"alert"`, `"chime"`, `"execute"`, `"success"` only. Use `"alert"` for a 403 refusal and `"execute"` for a 202 queued/deferred. Do NOT use `"error"` — it does not exist and will fail the build (Risk 6).

### Change E — `src/App.tsx:662-673`: branch on status in `handleApplyRecipe`

```ts
const res = await apiFetch("/api/recipes/apply", { method: "POST", headers: {...}, body: JSON.stringify({ recipeId }) });
if (res.status === 403) { playEarcon("alert"); return; }   // whole-layout gated Off (NO "error" token — see Risk 6)
fetchTerminals(); fetchLedger();
playEarcon("success");
```

> A `200` with `blocked`/`deferred` arrays is still a success render (some panes may have spawned, some deferred); the pending-action chips handle the deferred ones via the existing `action_pending` broadcast path.

### Change F (optional, only if a test needs it) — `src/components/CreateTerminalDialog.tsx`

No functional change required for the gate. The dossier lists it because the `onCreate` callback signature (`CreateTerminalDialog.tsx:8-14`) is the contract `handleCreateTerminal` implements. Touch this file ONLY if you add a `data-testid` to the "Deploy Node Unit" button (`CreateTerminalDialog.tsx:192-200`) to drive the e2e test in §3c. Recommended: add `data-testid="create-deploy"` to that button.

---

## 3. TEST-FIRST Plan (aligned to the repo runners)

> **Hard constraint discovered by reading the code:** the Express routes are defined *inside* the un-exported `startServer()` closure (`server.ts:225`). There is **no HTTP test harness** in this repo — `tests/test_server.ts` drives `OrchestratorManager` directly, and gate logic is unit-tested as **pure functions** (`tests/test_capability_gate.ts`) and via `PendingActionStore` (`tests/test_pending_actions.ts`). The TDD plan therefore tests (a) the new pure mapping helper, (b) the deferred-spawn-broadcasts invariant via `PendingActionStore` + a spy effect, and (c) the frontend status branching via Playwright `?mock=1`. This matches `tsx --test --test-force-exit tests/*.ts` and `playwright test ./e2e`.

### 3a. THE FAILING TEST TO WRITE FIRST (write it, watch it fail to compile/import)

**File:** `tests/test_rest_gate.ts` (NEW)
**Runner:** `npm test` (`tsx --test --test-force-exit tests/*.ts`)

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { restGateOutcome } from "../src/restGate";   // <- fails first: src/restGate.ts does not exist yet
// NOTE: import from ../src/restGate, NEVER ../server — server.ts calls startServer() at module load
// (verified at file tail) and would boot a real listener on import.

describe("G6 — restGateOutcome maps a gateOrDefer disposition to the REST contract", () => {
  it("Off  -> 403 forbidden, no actionId", () => {
    const o = restGateOutcome({ disposition: "forbidden" });
    assert.strictEqual(o.status, 403);
    assert.strictEqual(o.body.capability, "create_pane");
    assert.ok(!("actionId" in o.body));
  });
  it("Ask  -> 202 deferred, carries actionId + summary", () => {
    const o = restGateOutcome({ disposition: "deferred", actionId: "act_1", summary: "Create pane build-1" });
    assert.strictEqual(o.status, 202);
    assert.strictEqual(o.body.deferred, true);
    assert.strictEqual(o.body.actionId, "act_1");
  });
  it("Auto -> 200 success", () => {
    const o = restGateOutcome({ disposition: "run" });
    assert.strictEqual(o.status, 200);
    assert.strictEqual(o.body.success, true);
  });
});
```

This is the **first failing test**: it fails at import (`src/restGate.ts` does not exist) until Change A lands. The module is pure and side-effect-free, so the import is safe (unlike importing `../server`, which boots the listener — verified at the `server.ts` tail).

### 3b. Deferred-spawn-broadcasts invariant (the "lands silently" bug)

**File:** `tests/test_rest_gate.ts` (same file, second `describe`)
**Runner:** `npm test`

Prove that the effect closure passed to `gateOrDefer` performs its broadcast **when run on confirm**, not at stage time. Use `PendingActionStore` directly (same pattern as `tests/test_pending_actions.ts:11-16`):

```ts
import { PendingActionStore } from "../src/pendingActions";

describe("G6 — a deferred spawn effect runs (and would broadcast) exactly on confirm", () => {
  it("stages without running; confirm runs the effect exactly once", () => {
    const store = new PendingActionStore();
    let spawns = 0, broadcasts = 0;
    const spawnEffect = () => { spawns++; broadcasts++; return "spawned"; };  // models addTerminal + broadcast bundled
    store.add({ id: "a1", capability: "create_pane", summary: "Create pane x", timestamp: Date.now(), run: spawnEffect });
    assert.strictEqual(spawns, 0, "staging must NOT spawn");
    assert.strictEqual(broadcasts, 0, "staging must NOT broadcast");
    const r = store.confirm("a1");
    assert.strictEqual(r.output, "spawned");
    assert.strictEqual(spawns, 1);
    assert.strictEqual(broadcasts, 1, "confirm must broadcast (else the deferred pane lands silently)");
  });
});
```

This pins the **structural** requirement of Changes B/C: the broadcast lives *inside* the effect closure, so confirming a deferred action repaints. (The literal `addTerminal`/`broadcast` are not invoked here — `PendingActionStore` is the unit under test, and the bundling is what we assert.)

### 3c. Frontend status branching (Playwright, `?mock=1`)

**File:** `e2e/create-gate.spec.ts` (NEW)
**Runner:** `npm run test:e2e` (`playwright test`, auto-starts Vite)

The mock harness short-circuits HTTP (`src/App.tsx:933-966`), so to test the **real HTTP branch** we must intercept the network. Use Playwright route interception to force `403` / `202` and assert the UI does NOT activate a phantom pane:

```ts
import { test, expect, gotoMockedApp } from "./fixtures";

test.describe("G6 — create-pane gate REST branching", () => {
  test("403 (gate Off) does not activate a pane", async ({ page }) => {
    await page.route("**/api/terminals", r =>
      r.fulfill({ status: 403, contentType: "application/json",
                  body: JSON.stringify({ error: "create_pane is gated Off", capability: "create_pane" }) }));
    await gotoMockedApp(page);
    // open dialog, fill id+command, click Deploy (needs data-testid="create-deploy" — Change F)
    // … drive the dialog …
    // assert: modal closed, no new active terminal tab for the attempted id
    await expect(page.getByTestId("terminal-tab-build-1")).toHaveCount(0);
  });

  test("202 (gate Ask) defers — no phantom active pane, pending chip path untouched", async ({ page }) => {
    await page.route("**/api/terminals", r =>
      r.fulfill({ status: 202, contentType: "application/json",
                  body: JSON.stringify({ deferred: true, actionId: "act_x", summary: "Create pane build-1" }) }));
    await gotoMockedApp(page);
    // … drive the dialog, click Deploy …
    await expect(page.getByTestId("terminal-tab-build-1")).toHaveCount(0);
  });
});
```

> Verify the exact selectors against the rendered DOM before finalizing: confirm the terminal-tab test-id scheme (grep `data-testid` in `src/App.tsx` / tab components) and add `data-testid="create-deploy"` per Change F. If a phantom-pane test-id is awkward, assert on `activeTerminalId`-driven DOM (e.g. the active pane header text) instead. The **load-bearing** assertion is: after a 403/202, the attempted pane is NOT shown as active. This e2e is OPTIONAL-but-recommended; 3a+3b are the mandatory gate.

### Test execution order

1. Write `tests/test_rest_gate.ts` §3a → `npm test` → **RED** (import error: `restGateOutcome` undefined).
2. Land Change A (`restGateOutcome`, exported from `src/restGate.ts` or `server.ts`) → `npm test` → §3a **GREEN**.
3. Add §3b → `npm test` → GREEN (PendingActionStore already supports it; this pins the closure shape).
4. Land Changes B, C (server routes) → `npm run lint` (`tsc --noEmit`) GREEN.
5. Land Changes D, E, F (frontend) → add `e2e/create-gate.spec.ts` §3c → `npm run test:e2e` GREEN.

---

## 4. Verify Commands

```bash
npm run lint          # tsc --noEmit — type-checks server.ts route changes + App.tsx branches
npm test              # tsx --test --test-force-exit tests/*.ts — runs test_rest_gate.ts + full unit suite
npm run test:e2e      # playwright — runs create-gate.spec.ts (auto-starts Vite, ?mock=1)
npm run build         # vite + esbuild → dist/server.cjs — confirms no module-resolution regression from restGate split
```

Run from the feature worktree root `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes`.

---

## 5. Risks

1. **Importing `../server` boots the listener — CONFIRMED.** `server.ts` ends with `startServer().catch(console.error)` at module scope and `server.listen(PORT, …)` runs inside it. A unit test importing `../server` would open a port/PTY. **Mitigation (mandatory, baked into Change A):** `restGateOutcome` lives in `src/restGate.ts` (side-effect-free); the test imports `../src/restGate`, never `../server`.
2. **Spotlight loosening hides the gate in manual testing.** `effectiveCapabilityGateFor` applies the SPOTLIGHT (`server.ts:1356-1365`): an *active* pane loosens *productive* capabilities to Auto — but `create_pane`/`apply_recipe` are explicitly **excluded** from `SPOTLIGHT_CAPABILITIES` (asserted in `tests/test_capability_gate.ts:211-215`). So spotlight will NOT mask this gate. No action needed; noted so a manual tester isn't surprised that an active pane still defers create.
3. **`projectId` ledger mutation runs before the gate.** Intentional (matches voice handler), but means a forbidden create still registers an empty project if `projectId` was novel. Low risk; if undesired, move the `projectId` block inside `spawnEffect`. Call out in review.
4. **Recipe route partial-success contract.** Returning `200` with `{spawned, deferred, blocked}` (rather than 202 when *any* pane defers) is a deliberate simplification. If a consumer needs a single status reflecting "all deferred," that is a follow-up — file a bead, don't expand scope here.
5. **U1 coordination / merge order.** U1 (`wsm-e2e-pinned-9fe`) touches the same `gateOrDefer`/`pendingActions` plumbing. If U1 changes `gateOrDefer`'s return union, `restGateOutcome`'s param type must track it. Land G6 on top of U1 or rebase; the pure helper localizes the blast radius to one function.
6. **Earcon token vocabulary — CONFIRMED `"alert"|"chime"|"execute"|"success"` only.** There is **no `"error"` token** in `App.tsx`; using one breaks the typed `playEarcon` signature at build. Use `"alert"` for 403 refusal, `"execute"` for 202 deferred.

---

## 6. Acceptance Criteria (from the bead, made checkable)

- [ ] **No create path bypasses the gate.** Both `POST /api/terminals` and `POST /api/recipes/apply` route every PTY spawn through `gateOrDefer("create_pane", …)` (and recipe also through the `apply_recipe` whole-layout veto). Verified by code review + `restGateOutcome` unit coverage.
- [ ] **Off → 403, no pane.** `create_pane=Off` REST create returns `403` and `manager.addTerminal` is never reached (effect closure not invoked).
- [ ] **Ask → 202 + pending action; confirm creates it AND broadcasts.** Deferred create stages in `pendingActions`; `POST /api/actions/:id/confirm` runs the effect once, which spawns + broadcasts (§3b invariant).
- [ ] **Auto → spawns** with `200` and the `addTerminal` result in the body.
- [ ] **UI handles 403/202.** `handleCreateTerminal` / `handleApplyRecipe` branch on `res.status`; no phantom `setActiveTerminalId` on a non-spawned pane.
- [ ] **Broadcasts moved inside the spawn effect** (deferred-confirm spawn repaints the UI).
- [ ] **`npm test`, `npm run lint`, `npm run test:e2e`, `npm run build` all green.**
