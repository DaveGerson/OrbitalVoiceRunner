# c55.11 — READ-endpoint Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge the 4 inline `GET` reads (`/api/ledger`, `/api/attention`, `/api/plans`, `/api/recipes`) into rest-only registry defs, so the registry is the single home and the no-twin guard's catalog shrinks by 4.

**Architecture:** Each read becomes a rest-only `ActionDef` in `src/actions/defs/reads.ts` that returns its data off `ActionContext` (`ctx.manager.ledger.workspaces` / `ctx.manager.attentionQueue` / `ctx.manager.ledger.plans` / `ctx.recipes`) and rides the `rest.toHttp` primitive to emit the value **TOP-LEVEL** (byte-identical to the legacy `res.json(...)` body, not wrapped in `{output}`). This is the exact pattern Batch F used for `get_stop_all_status` / `get_terminal_history`. The defs are `ALWAYS_ALLOWED` + `readOnly:false` (system-state plumbing reads, never gated, no egress redaction — faithful to the inline routes, which did none). After the defs are mounted (added to `mountRestRoutes`'s `opts.only` set), the 4 inline routes are deleted and their 4 rows removed from `src/actions/inlineExceptions.ts` (the no-twin guard enforces no-stale).

**Tech Stack:** TypeScript, `node:test` via `tsx --test --test-force-exit`. No new dependencies.

---

## Platform / worktree notes (read first)

- Work in worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-11-reads` on branch `feat/c55.11-read-convergence` (off `main`, includes the c55.8 lid). Never edit the main checkout.
- Windows shell: **PowerShell tool** for npm (`Set-Location` the worktree + `$env:PYTHONIOENCODING='utf-8'` at the start of every call; PS 5.1 has no `&&` — chain with `;`). **Bash tool** (Git Bash) for git only, as `git -C "<wt>" …`. Never mix shells in one call.
- Tests: `npm test` = `tsx --test --test-force-exit`. node-pty ConPTY `AttachConsole failed` / `NativeCommandError` lines are a display artifact — judge by the runner summary (`# pass N / # fail 0`) + exit code.
- `node_modules` is already junctioned (do NOT `npm ci`).
- End commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push; do NOT run `bd`.

## Fidelity contract (the legacy inline bodies — captured pre-cutover)

| Route | Inline handler (server.ts) | Body returned | New def reads |
|---|---|---|---|
| `GET /api/ledger` | `res.json(manager.ledger.workspaces)` (l.624) | `workspaces` array, top-level | `ctx.manager.ledger.workspaces` |
| `GET /api/attention` | `res.json(manager.attentionQueue)` (l.1012) | `attentionQueue` array, top-level | `ctx.manager.attentionQueue` |
| `GET /api/plans` | `res.json(manager.ledger.plans)` (l.1043) | `plans` array, top-level | `ctx.manager.ledger.plans` |
| `GET /api/recipes` | `res.json(recipes)` (l.1094) | `recipes` array, top-level | `ctx.recipes` (injected at server.ts:1317) |

All four are **ungated, unredacted, top-level** reads → `ALWAYS_ALLOWED`, `readOnly:false`, `surfaces:{'rest'}`, with a `rest.toHttp` that emits `result.output` top-level (fallback `[]`).

## File Structure

- **Modify** `src/actions/defs/reads.ts` — append 4 rest-only read defs + add them to `READS_ACTIONS`.
- **Modify** `src/actions/coverage.ts` — add the 4 names to `INTENTIONAL_ASYMMETRY` (rest-only defs must be allow-listed or the §8.4 #20 build-gate fails).
- **Modify** `server.ts` — add the 4 names to `mountRestRoutes`'s `only` set; delete the 4 inline `app.get` route blocks. (Keep the `recipes` const at l.986 — it feeds `ctx.recipes`.)
- **Modify** `src/actions/inlineExceptions.ts` — delete the 4 `future-convergence: reads` rows.
- **Create** `tests/test_c55_11_reads.ts` — def-behavior + fidelity + asymmetry + cutover guard.

---

### Task 1: The 4 rest-only read defs (registry side, TDD)

**Files:**
- Create: `tests/test_c55_11_reads.ts`
- Modify: `src/actions/defs/reads.ts`
- Modify: `src/actions/coverage.ts`

- [ ] **Step 1: Write the failing contract test** — create `tests/test_c55_11_reads.ts`:

```ts
/**
 * tests/test_c55_11_reads.ts — c55.11 (wsm-e2e-pinned-c55.11): converge the 4 inline GET reads.
 *
 * Each inline read (`res.json(<value>)`) becomes a rest-only ActionDef returning <value> off ctx and
 * riding rest.toHttp to emit it TOP-LEVEL (byte-identical to the legacy body, NOT wrapped in {output}).
 * ALWAYS_ALLOWED + readOnly:false (system-state plumbing read, never gated, no egress redaction —
 * faithful to the inline routes). Same doctrine as Batch F: run the real choke-point with a fake ctx,
 * assert the ActionResult, then assert applyResultToHttp maps it to {status, body}.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import { INTENTIONAL_ASYMMETRY } from "../src/actions/coverage";
import type { ActionContext, ActionDef, ActionResult } from "../src/actions/types";

function makeFakeRes(): { res: RestResponse; sent: { status?: number; json?: unknown } } {
  const sent: { status?: number; json?: unknown } = {};
  const res: RestResponse = {
    status(code: number) { sent.status = code; return res; },
    json(payload: unknown) { sent.json = payload; return undefined; },
  };
  return { res, sent };
}

function findDef(name: string): ActionDef {
  const def = REGISTRY.find((d) => d.name === name);
  assert.ok(def, `registry must contain a def named '${name}'`);
  return def!;
}

async function runToHttp(name: string, ctx: ActionContext): Promise<{ result: ActionResult; status?: number; json?: unknown }> {
  const def = findDef(name);
  const result = await runAction(REGISTRY, name, {}, ctx);
  const { res, sent } = makeFakeRes();
  applyResultToHttp(def, result, {}, res);
  return { result, status: sent.status, json: sent.json };
}

// A fake ctx seeded with the 4 data sources the defs read. Sentinels so a wrong source fails loudly.
function makeCtx(over: {
  workspaces?: unknown; attentionQueue?: unknown; plans?: unknown; recipes?: unknown;
} = {}): ActionContext {
  const manager: any = {
    ledger: { workspaces: over.workspaces ?? [], plans: over.plans ?? [] },
    attentionQueue: over.attentionQueue ?? [],
  };
  return {
    manager,
    recipes: over.recipes ?? [],
    session: null,
    surface: "rest",
    redact: (s: string) => s,
    isFrozen: () => false,
    effectiveCapabilityGateFor: () => "Auto",
  } as unknown as ActionContext;
}

// name -> { path, ctxKey seed, expected body }
const READS: Array<{ name: string; path: string; seed: () => ActionContext; expect: unknown }> = [
  {
    name: "get_ledger", path: "/api/ledger",
    seed: () => makeCtx({ workspaces: [{ id: "ws1", projects: [] }] }),
    expect: [{ id: "ws1", projects: [] }],
  },
  {
    name: "get_attention_queue", path: "/api/attention",
    seed: () => makeCtx({ attentionQueue: [{ terminalId: "p1", type: "error", message: "boom" }] }),
    expect: [{ terminalId: "p1", type: "error", message: "boom" }],
  },
  {
    name: "list_orchestrator_plans", path: "/api/plans",
    seed: () => makeCtx({ plans: [{ id: "plan1", status: "idle", steps: [] }] }),
    expect: [{ id: "plan1", status: "idle", steps: [] }],
  },
  {
    name: "list_orchestration_recipes", path: "/api/recipes",
    seed: () => makeCtx({ recipes: [{ id: "full-stack-web", name: "X", panes: [] }] }),
    expect: [{ id: "full-stack-web", name: "X", panes: [] }],
  },
];

describe("c55.11 — 4 rest-only read defs (shape + asymmetry)", () => {
  for (const { name, path: routePath } of READS) {
    it(`${name} is rest-only ALWAYS_ALLOWED readOnly:false, binds GET ${routePath}, declares toHttp, is allow-listed`, () => {
      const def = findDef(name);
      assert.strictEqual(def.capability, "ALWAYS_ALLOWED", `${name} is an ungated plumbing read`);
      assert.strictEqual(def.readOnly, false, `${name}: §8.1 binds readOnly to read_pane/read_notes only`);
      assert.deepStrictEqual([...def.surfaces], ["rest"], `${name} is rest-only (no voice twin)`);
      assert.deepStrictEqual(def.rest?.method, "get");
      assert.deepStrictEqual(def.rest?.path, routePath);
      assert.ok(typeof def.rest?.toHttp === "function", `${name} must declare a rest.toHttp translator`);
      assert.deepStrictEqual(INTENTIONAL_ASYMMETRY[name], new Set(["rest"]), `${name} must be allow-listed rest-only in INTENTIONAL_ASYMMETRY`);
    });
  }
});

describe("c55.11 — fidelity: toHttp emits the value TOP-LEVEL (byte-identical to the legacy res.json body)", () => {
  for (const { name, seed, expect } of READS) {
    it(`${name} -> HTTP 200, body is the bare value (not wrapped in {output})`, async () => {
      const { result, status, json } = await runToHttp(name, seed());
      assert.strictEqual(result.kind, "ok");
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json, expect, `${name} body must equal the seeded source value, emitted top-level`);
      assert.ok(!(json && typeof json === "object" && !Array.isArray(json) && "output" in (json as object)),
        `${name} must NOT wrap the body in {output}`);
    });
  }
});
```

- [ ] **Step 2: Run the test — verify it fails**

PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_c55_11_reads.ts`
Expected: FAIL — `registry must contain a def named 'get_ledger'` (the defs don't exist yet).

- [ ] **Step 3: Add the 4 defs to `src/actions/defs/reads.ts`** — insert these 4 defs immediately BEFORE the `READS_ACTIONS` export (after `getTerminalHistory`, ~l.381):

```ts
// ─────────────────────────────────────────────────────────────────────────────
// c55.11 — 4 rest-only structured reads (faithful ports of the inline GET routes)
// ─────────────────────────────────────────────────────────────────────────────
// Each converges an inline `res.json(<value>)` read into a rest-only def returning <value> off ctx,
// riding rest.toHttp to emit it TOP-LEVEL (byte-identical to the legacy body). ALWAYS_ALLOWED +
// readOnly:false (system-state plumbing read, never gated; the inline routes did NO redaction, so
// readOnly:false preserves that — same reasoning as get_stop_all_status). No voice twin planned.

export const getLedger: ActionDef<typeof NoParams> = {
  name: "get_ledger",
  description: "Read the full workspaces ledger (project/pane tree the UI loads on page open). UNGATED plumbing read.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/ledger",
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? result.output : [],
    }),
  },
  handler: (_args, ctx): ActionResult => ({ kind: "ok", output: ctx.manager.ledger.workspaces }),
};

export const getAttentionQueue: ActionDef<typeof NoParams> = {
  name: "get_attention_queue",
  description: "Read the raw attention/alert queue (panes that transitioned to error/exit). UNGATED plumbing read. (The voice prose digest is get_attention_digest.)",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/attention",
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? result.output : [],
    }),
  },
  handler: (_args, ctx): ActionResult => ({ kind: "ok", output: ctx.manager.attentionQueue }),
};

export const listOrchestratorPlans: ActionDef<typeof NoParams> = {
  name: "list_orchestrator_plans",
  description: "Read the multi-step orchestrator plans board (id/status/steps per plan). UNGATED plumbing read.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/plans",
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? result.output : [],
    }),
  },
  handler: (_args, ctx): ActionResult => ({ kind: "ok", output: ctx.manager.ledger.plans }),
};

export const listOrchestrationRecipes: ActionDef<typeof NoParams> = {
  name: "list_orchestration_recipes",
  description: "Read the orchestration recipe templates (suggested multi-pane suites the UI offers). UNGATED plumbing read.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/recipes",
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? result.output : [],
    }),
  },
  handler: (_args, ctx): ActionResult => ({ kind: "ok", output: ctx.recipes }),
};
```

Then add the 4 to the `READS_ACTIONS` array (after `getTerminalHistory`):

```ts
export const READS_ACTIONS: ActionDef[] = [
  getPaneCommandHistory,
  getPaneSummary,
  getPaneDelta,
  listPendingApprovals,
  getAttentionDigest,
  getPaneGates,
  listCapabilities,
  getStopAllStatus,
  getTerminalHistory,
  getLedger,
  getAttentionQueue,
  listOrchestratorPlans,
  listOrchestrationRecipes,
];
```

> NOTE on `ctx.recipes`: `ActionContext["recipes"]` already exists (server.ts:1317 injects it as `recipes as ActionContext["recipes"]`). If `tsc` complains that `recipes` is not on `ActionContext`, it IS already there — do not add it; re-check the import/spelling. `NoParams`, `ALWAYS_ALLOWED`, `ActionDef`, `ActionResult` are already imported at the top of `reads.ts`.

- [ ] **Step 4: Add the 4 names to `INTENTIONAL_ASYMMETRY`** in `src/actions/coverage.ts` — insert after the Batch F block (after the `get_terminal_history` entry, ~l.103):

```ts
  // ── c55.11: NEW rest-only structured page-load READS (no voice twin BY DESIGN) ───────────────────
  // Faithful ports of the inline GET /api/{ledger,attention,plans,recipes}; each rides rest.toHttp to
  // emit its value TOP-LEVEL. ALWAYS_ALLOWED plumbing reads (the inline routes were ungated/unredacted).
  get_ledger: new Set<Surface>(["rest"]),
  get_attention_queue: new Set<Surface>(["rest"]),
  list_orchestrator_plans: new Set<Surface>(["rest"]),
  list_orchestration_recipes: new Set<Surface>(["rest"]),
```

- [ ] **Step 5: Run the test — verify it passes (def-level)**

PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_c55_11_reads.ts`
Expected: PASS (8 shape/fidelity tests). The defs exist and project correctly. (Inline routes still serve traffic; that cutover is Task 2.)

- [ ] **Step 6: Lint + commit**

PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npm run lint` → exit 0.
Bash: `git -C "<wt>" add src/actions/defs/reads.ts src/actions/coverage.ts tests/test_c55_11_reads.ts && git -C "<wt>" commit -m "feat(c55.11): 4 rest-only read defs (ledger/attention/plans/recipes) + asymmetry" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: Cutover — mount, delete inline routes, shrink the catalog (TDD)

**Files:**
- Modify: `tests/test_c55_11_reads.ts` (add the cutover-guard block)
- Modify: `server.ts`
- Modify: `src/actions/inlineExceptions.ts`

- [ ] **Step 1: Add the failing cutover guard** — append to `tests/test_c55_11_reads.ts`:

```ts
// ════════════════════════════════════════════════════════════════════════════════════════════════
// cutover guard — server.ts inline GET routes deleted + names added to the only-set
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55.11 — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock = onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  for (const name of ["get_ledger", "get_attention_queue", "list_orchestrator_plans", "list_orchestration_recipes"]) {
    it(`mountRestRoutes only-set includes "${name}"`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(new RegExp(`["']${name}["']`).test(mountBlock), `only-set must include "${name}" after the c55.11 cutover`);
    });
  }

  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "GET /api/ledger", needle: /app\.get\(\s*["']\/api\/ledger["']/ },
    { label: "GET /api/attention", needle: /app\.get\(\s*["']\/api\/attention["']/ },
    { label: "GET /api/plans", needle: /app\.get\(\s*["']\/api\/plans["']/ },
    { label: "GET /api/recipes", needle: /app\.get\(\s*["']\/api\/recipes["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(!needle.test(serverSrc), `inline ${label} must be deleted (converged to the registry)`);
    });
  }
});
```

- [ ] **Step 2: Run it — verify it fails**

PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_c55_11_reads.ts`
Expected: FAIL — the 4 `only-set includes` + 4 `inline route is deleted` assertions fail (not mounted, routes still present).

- [ ] **Step 3: Add the 4 names to the mount `only` set** in `server.ts` (~l.1349, inside `only: new Set([`). Add after the Batch G entries (e.g. after `"delete_orchestrator_plan",`):

```ts
      // c55.11 — 4 rest-only structured reads, cut over from the inline app.get(...) routes deleted
      // below. Each rides rest.toHttp to emit its value TOP-LEVEL, byte-identical to the legacy body.
      "get_ledger",
      "get_attention_queue",
      "list_orchestrator_plans",
      "list_orchestration_recipes",
```

- [ ] **Step 4: Delete the 4 inline route blocks** in `server.ts`. Delete exactly these (leave surrounding comments/section headers and the `recipes` const intact):

`GET /api/ledger` (the 3 lines):
```ts
  app.get("/api/ledger", (req, res) => {
    res.json(manager.ledger.workspaces);
  });
```

`GET /api/attention` (the 3 lines, under `// 1. Attention alerting queue`):
```ts
  app.get("/api/attention", (req, res) => {
    res.json(manager.attentionQueue);
  });
```

`GET /api/plans` (the 3 lines, under `// 3. Multi-step sequenced resumable plans`):
```ts
  app.get("/api/plans", (req, res) => {
    res.json(manager.ledger.plans);
  });
```

`GET /api/recipes` (the 3 lines, under `// 4. Recipes and templates`):
```ts
  app.get("/api/recipes", (req, res) => {
    res.json(recipes);
  });
```

> Do NOT delete the `const recipes = [ … ];` block (~l.986) — it is still injected into `ctx.recipes` (server.ts:1317) which the `list_orchestration_recipes` handler reads. Optionally replace each deleted block with a one-line `// c55.11: GET /api/<x> now served by the registry-derived <def> (mountRestRoutes only-set above).` breadcrumb, matching the existing Batch A–G comment style.

- [ ] **Step 5: Remove the 4 catalog rows** from `src/actions/inlineExceptions.ts` — delete the entire `// ── future-convergence: reads (ledger/attention/plans/recipes) ──` comment + its 4 entries:

```ts
  // ── future-convergence: reads (ledger/attention/plans/recipes) ──
  { method: "get", path: "/api/ledger", category: "future-convergence", reason: "full ledger read — future rest-only def (structured body)" },
  { method: "get", path: "/api/attention", category: "future-convergence", reason: "attention queue read — future rest-only def" },
  { method: "get", path: "/api/plans", category: "future-convergence", reason: "plans board read — future rest-only def" },
  { method: "get", path: "/api/recipes", category: "future-convergence", reason: "recipes list read — future rest-only def" },
```

- [ ] **Step 6: Run the c55.11 test + the no-twin guard — both green**

PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_c55_11_reads.ts tests/test_no_inline_twins.ts`
Expected: BOTH PASS. The c55.11 cutover guard is green (mounted + inline deleted); the no-twin guard is green (the 4 routes AND their 4 catalog rows are gone together — neither undeclared nor stale).

- [ ] **Step 7: Lint + commit**

PowerShell: `npm run lint` → exit 0.
Bash: `git -C "<wt>" add server.ts src/actions/inlineExceptions.ts tests/test_c55_11_reads.ts && git -C "<wt>" commit -m "feat(c55.11): cut over the 4 inline reads to the registry; shrink the no-twin catalog" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: Full-battery + catalog regen + scope check

**Files:** possibly the regenerated catalog artifact (`CAPABILITIES.md` and/or `src/actions/catalog.generated.*`), if `npm run catalog` reports drift.

- [ ] **Step 1: Regenerate the catalog (4 new actions changed the registry)**

PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npm run catalog`
Then Bash `git -C "<wt>" status --short` — if `npm run catalog` modified a generated file, that's expected (4 new ALWAYS_ALLOWED rest defs). Stage + commit it: `git -C "<wt>" add -A && git -C "<wt>" commit -m "chore(c55.11): regenerate catalog for the 4 new read defs" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`. If `npm run catalog` changed nothing, skip the commit.

- [ ] **Step 2: Run the full battery**

PowerShell (one call): `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npm run lint; npm test; npm run build`
Expected: lint exit 0; unit suite `# fail 0` exit 0 (includes `test_c55_11_reads`, `test_no_inline_twins`, the coverage/asymmetry test, and any catalog/registry golden); build exit 0.
> If a registry/catalog GOLDEN or count test fails because of the 4 new defs, regenerate it the documented way (`npm run catalog`, or the golden's own update command) and commit — do NOT hand-edit a golden to suppress a real, intended registry change. If a test asserts a hard-coded action COUNT, update it to the new count (+4) with a one-line note.

- [ ] **Step 3: Scope check (contamination-safe — diff vs the fork point, NOT origin/main)**

Bash: `git -C "<wt>" diff --name-only main..HEAD` (the branch forked from current `main`, a direct ancestor → clean). Expected set: `docs/superpowers/plans/2026-06-05-c55-11-read-convergence.md`, `src/actions/defs/reads.ts`, `src/actions/coverage.ts`, `server.ts`, `src/actions/inlineExceptions.ts`, `tests/test_c55_11_reads.ts`, and (if regenerated) the catalog artifact. Confirm no unrelated file changed.
Also `git -C "<wt>" log --oneline main..HEAD` (3–4 commits) and `git -C "<wt>" status --short` (clean).

---

## Self-Review

- **Spec coverage:** §10 step 1 (read endpoints → rest-only defs, "likely need rest.toHttp", "no gating questions", "remove their rows from inlineExceptions.ts (guard enforces no-stale)") → Tasks 1–2 cover all 4 reads, all rest-only + toHttp + ALWAYS_ALLOWED, with the catalog rows removed under the guard.
- **Placeholder scan:** none — every def, the asymmetry entries, the deletions, and the full test are provided verbatim; the only conditional is the catalog/golden regen (a concrete `npm run catalog` + commit-if-changed loop).
- **Type consistency:** def names (`get_ledger`, `get_attention_queue`, `list_orchestrator_plans`, `list_orchestration_recipes`) are identical across reads.ts, coverage.ts, the mount set, and the test. `toHttp` signature `(result) => { status, body }` matches `getStopAllStatus`. `NoParams`/`ALWAYS_ALLOWED`/`ActionDef`/`ActionResult` are pre-imported in reads.ts.
- **Fidelity:** each handler reads the SAME source the inline route did (`ctx.manager.ledger.workspaces` / `ctx.manager.attentionQueue` / `ctx.manager.ledger.plans` / `ctx.recipes`) and emits it top-level via toHttp — byte-identical body, ungated, unredacted (readOnly:false).

## Out of scope (later beads)
Notes (c55.12), archive (c55.13), project/pane lifecycle (c55.14), approvals/pending HiTL (c55.15), and the terminal `opts.only` drop + held-collision resolution (c55.16). This batch touches only the 4 reads.
