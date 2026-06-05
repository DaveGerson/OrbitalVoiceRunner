# c55.13 — ARCHIVE-endpoint Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge the 3 inline archive routes (`GET /api/archive`, `POST /api/archive/:paneId/restore`, `DELETE /api/archive/:paneId`) into rest-only registry defs, so the registry is the single home and the no-twin catalog shrinks by 3.

**Architecture:** The 3 archive routes are operator-UI archive management — **ungated** (operator acting in their own browser; spec §10 step 3 classifies archive as plumbing) and unredacted. They become 3 new rest-only `ALWAYS_ALLOWED` defs in a new file `src/actions/defs/archive.ts`, wired into `REGISTRY` (registry.ts). `list_archived_panes` rides `rest.toHttp` to emit `{archived:[…]}` top-level (the legacy shape); the restore/delete writes use the default `{output}` map (the UI repaints off `ledger_updated`/`terminals_updated`). Exact mirror of the c55.11/c55.12 faithful-port pattern.

**Tech Stack:** TypeScript, `node:test` via `tsx --test --test-force-exit`. No new deps.

---

## Platform / worktree notes (read first)

- Worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-13-archive` on branch `feat/c55.13-archive-convergence` (off `main`, includes c55.12). Never edit the main checkout.
- Windows: **PowerShell tool** for npm (`Set-Location` the worktree + `$env:PYTHONIOENCODING='utf-8'` first; PS 5.1 has no `&&`). **Bash tool** (Git Bash) for git only, as `git -C "<wt>" …`. Never mix shells in one call.
- `server.ts` is large — Grep the route literal, Read a tight window, Edit. node-pty `AttachConsole failed` = display noise (judge by `# pass/# fail`).
- `node_modules` already junctioned (do NOT `npm ci`). Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push; do NOT run `bd`.

## Fidelity contract (the legacy inline bodies — captured pre-cutover)

| Inline route (server.ts) | Handler | New rest-only def | Faithful behavior |
|---|---|---|---|
| `GET /api/archive` (904) | projects `listArchived()` → `{archived:[{pane_id,name,project_id,tool_preset,last_command,archived_at}]}` | `list_archived_panes` | same projection; `toHttp` emits `{archived:[…]}` top-level |
| `POST /api/archive/:paneId/restore` (916) | `restoreArchivedPane(paneId)`; 404 if null; else `broadcastLedgerUpdate()` + `broadcastTerminalsUpdated()`; `{success:true}` | `restore_archived_pane` | both broadcasts; 404→200 ok-narration delta |
| `DELETE /api/archive/:paneId` (928) | `deleteArchivedPane(paneId)`; 404 if !ok; else `broadcastLedgerUpdate()`; `{success:true}` | `delete_archived_pane` | broadcast; 404→200 delta |

All 3 → `ALWAYS_ALLOWED`, `readOnly:false`, `surfaces:{'rest'}`. `rest.path` uses snake_case `:pane_id` (Batch B precedent; the client's literal URL is unchanged).

## File Structure

- **Create** `src/actions/defs/archive.ts` — the 3 rest-only archive defs + `ARCHIVE_ACTIONS`.
- **Modify** `src/actions/registry.ts` — import `ARCHIVE_ACTIONS` + spread it into `REGISTRY`.
- **Modify** `src/actions/coverage.ts` — add the 3 names to `INTENTIONAL_ASYMMETRY`.
- **Modify** `server.ts` — add the 3 names to the `mountRestRoutes` `only` set; delete the 3 inline route blocks.
- **Modify** `src/actions/inlineExceptions.ts` — delete the 3 `future-convergence: archive` rows.
- **Create** `tests/test_c55_13_archive.ts` — def shape + fidelity + cutover guard.

---

### Task 1: The 3 rest-only archive defs (registry side, TDD)

**Files:** Create `tests/test_c55_13_archive.ts`, `src/actions/defs/archive.ts`; Modify `src/actions/registry.ts`, `src/actions/coverage.ts`.

- [ ] **Step 1: Write the failing contract test** — create `tests/test_c55_13_archive.ts`:

```ts
/**
 * tests/test_c55_13_archive.ts — c55.13 (wsm-e2e-pinned-c55.13): converge the 3 inline archive routes.
 * Faithful ports: UNGATED (ALWAYS_ALLOWED), readOnly:false. list rides rest.toHttp to emit {archived:[…]}
 * top-level; restore/delete use the default {output} map (UI repaints off ledger_updated/terminals_updated).
 * Same doctrine as c55.11/c55.12: run the real choke-point with a fake ctx, assert the ActionResult,
 * then assert applyResultToHttp maps it to {status, body}.
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
  const res: RestResponse = { status(c: number) { sent.status = c; return res; }, json(p: unknown) { sent.json = p; return undefined; } };
  return { res, sent };
}
function findDef(name: string): ActionDef {
  const def = REGISTRY.find((d) => d.name === name);
  assert.ok(def, `registry must contain a def named '${name}'`);
  return def!;
}
async function runToHttp(name: string, args: Record<string, unknown>, ctx: ActionContext) {
  const def = findDef(name);
  const result = await runAction(REGISTRY, name, args, ctx);
  const { res, sent } = makeFakeRes();
  applyResultToHttp(def, result, args, res);
  return { result, status: sent.status, json: sent.json };
}

// Fake ledger that records calls + a seeded archived list (projection sentinel).
function makeCtx(opts: { restoreOk?: boolean; deleteOk?: boolean } = {}): { ctx: ActionContext; calls: string[] } {
  const calls: string[] = [];
  const archivedRaw = [{
    pane: { pane_id: "p1", name: "Pane One", tool_preset: "Claude Code", last_command: "npm test" },
    project_id: "proj", archived_at: "2026-06-05T00:00:00Z",
  }];
  const ledger: any = {
    listArchived: () => { calls.push("listArchived"); return archivedRaw; },
    restoreArchivedPane: (id: string) => { calls.push(`restore:${id}`); return opts.restoreOk === false ? null : { pane_id: id }; },
    deleteArchivedPane: (id: string) => { calls.push(`delete:${id}`); return opts.deleteOk === false ? false : true; },
  };
  const ctx = {
    manager: { ledger }, session: null, surface: "rest",
    broadcastLedgerUpdate: () => { calls.push("ledger_broadcast"); },
    broadcastTerminalsUpdated: () => { calls.push("terminals_broadcast"); },
    redact: (s: string) => s, isFrozen: () => false, effectiveCapabilityGateFor: () => "Auto",
  } as unknown as ActionContext;
  return { ctx, calls };
}

const SHAPE: Array<{ name: string; method: string; path: string }> = [
  { name: "list_archived_panes", method: "get", path: "/api/archive" },
  { name: "restore_archived_pane", method: "post", path: "/api/archive/:pane_id/restore" },
  { name: "delete_archived_pane", method: "delete", path: "/api/archive/:pane_id" },
];

describe("c55.13 — 3 rest-only archive defs (shape + asymmetry)", () => {
  for (const { name, method, path: p } of SHAPE) {
    it(`${name} is rest-only ALWAYS_ALLOWED readOnly:false, binds ${method.toUpperCase()} ${p}, allow-listed`, () => {
      const def = findDef(name);
      assert.strictEqual(def.capability, "ALWAYS_ALLOWED");
      assert.strictEqual(def.readOnly, false);
      assert.deepStrictEqual([...def.surfaces], ["rest"]);
      assert.deepStrictEqual(def.rest?.method, method);
      assert.deepStrictEqual(def.rest?.path, p);
      assert.deepStrictEqual(INTENTIONAL_ASYMMETRY[name], new Set(["rest"]));
    });
  }
});

describe("c55.13 — fidelity", () => {
  it("list_archived_panes -> {archived:[projected]} TOP-LEVEL at 200", async () => {
    const { ctx } = makeCtx();
    const { status, json } = await runToHttp("list_archived_panes", {}, ctx);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { archived: [{
      pane_id: "p1", name: "Pane One", project_id: "proj", tool_preset: "Claude Code",
      last_command: "npm test", archived_at: "2026-06-05T00:00:00Z",
    }] }, "byte-identical to the inline {archived:[…]} projection, top-level (not {output})");
  });
  it("restore_archived_pane ok -> both broadcasts, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("restore_archived_pane", { pane_id: "p1" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("restore:p1") && calls.includes("ledger_broadcast") && calls.includes("terminals_broadcast"));
  });
  it("restore_archived_pane not-found -> 200 ok-narration, NO broadcast (404→200 delta)", async () => {
    const { ctx, calls } = makeCtx({ restoreOk: false });
    const { status } = await runToHttp("restore_archived_pane", { pane_id: "nope" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("restore:nope") && !calls.includes("ledger_broadcast"));
  });
  it("delete_archived_pane ok -> ledger broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("delete_archived_pane", { pane_id: "p1" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("delete:p1") && calls.includes("ledger_broadcast"));
  });
  it("delete_archived_pane not-found -> 200 ok-narration, NO broadcast", async () => {
    const { ctx, calls } = makeCtx({ deleteOk: false });
    const { status } = await runToHttp("delete_archived_pane", { pane_id: "nope" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("delete:nope") && !calls.includes("ledger_broadcast"));
  });
});
```

- [ ] **Step 2: Run the test → verify it fails** — PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_c55_13_archive.ts` → FAIL (`registry must contain a def named 'list_archived_panes'`).

- [ ] **Step 3: Create `src/actions/defs/archive.ts`** with this exact content:

```ts
/**
 * src/actions/defs/archive.ts — c55.13: the ARCHIVE group (operator-UI archive management).
 *
 * Faithful ports of the inline GET/POST/DELETE /api/archive routes: UNGATED operator-direct
 * (spec §10 step 3 classifies archive as plumbing), unredacted. ALWAYS_ALLOWED + readOnly:false
 * (the §8.1 invariant binds readOnly to read_pane/read_notes; ungated reads use false, same as
 * get_stop_all_status). list rides rest.toHttp to emit {archived:[…]} top-level; restore/delete
 * use the default {output} map (the UI repaints off ledger_updated/terminals_updated). rest-only
 * (no voice twin planned).
 */
import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";

const NoParams = z.object({});
const PaneIdParams = z.object({ pane_id: z.string() });

export const listArchivedPanes: ActionDef<typeof NoParams> = {
  name: "list_archived_panes",
  description: "List archived (exited+cleared) panes for the UI restore tray (pane_id/name/project/preset/last_command/archived_at). UNGATED operator-UI read.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/archive",
    // Emit {archived:[…]} TOP-LEVEL — the exact legacy inline body shape.
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: { archived: result.kind === "ok" ? result.output : [] },
    }),
  },
  handler: (_args, ctx): ActionResult => {
    const archived = ctx.manager.ledger.listArchived().map((a: any) => ({
      pane_id: a.pane.pane_id,
      name: a.pane.name,
      project_id: a.project_id,
      tool_preset: a.pane.tool_preset,
      last_command: a.pane.last_command || "",
      archived_at: a.archived_at,
    }));
    return { kind: "ok", output: archived };
  },
};

export const restoreArchivedPane: ActionDef<typeof PaneIdParams> = {
  name: "restore_archived_pane",
  description: "Restore an archived pane back into its project (operator-UI, ungated). Re-fans the ledger + terminals so the live tree repaints.",
  params: PaneIdParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/archive/:pane_id/restore" },
  handler: (args, ctx): ActionResult => {
    const entry = ctx.manager.ledger.restoreArchivedPane(args.pane_id);
    // Accepted delta (c55 program): not-found maps to 200 ok-narration, not the inline 404. The UI
    // ignores the body and repaints off the broadcasts (which do NOT fire on this failure path).
    if (!entry) return { kind: "ok", output: `Archived pane ${args.pane_id} not found.` };
    ctx.broadcastLedgerUpdate();
    ctx.broadcastTerminalsUpdated();
    return { kind: "ok", output: `Pane ${args.pane_id} restored.` };
  },
};

export const deleteArchivedPane: ActionDef<typeof PaneIdParams> = {
  name: "delete_archived_pane",
  description: "Permanently delete an archived pane record from the restore tray (operator-UI, ungated).",
  params: PaneIdParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/archive/:pane_id" },
  handler: (args, ctx): ActionResult => {
    const ok = ctx.manager.ledger.deleteArchivedPane(args.pane_id);
    if (!ok) return { kind: "ok", output: `Archived pane ${args.pane_id} not found.` };
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Archived pane ${args.pane_id} deleted.` };
  },
};

/** The ARCHIVE group of the canonical registry. */
export const ARCHIVE_ACTIONS: ActionDef[] = [
  listArchivedPanes,
  restoreArchivedPane,
  deleteArchivedPane,
];
```

- [ ] **Step 4: Wire `ARCHIVE_ACTIONS` into `src/actions/registry.ts`** — follow the EXACT pattern of the other group imports/spreads (e.g. `READS_ACTIONS` / `NOTES_ACTIONS`):
  - Add near the other `defs/*` imports: `import { ARCHIVE_ACTIONS } from "./defs/archive";`
  - Add into the `REGISTRY` array (near the other `...GROUP_ACTIONS` spreads, e.g. right after `...NOTES_ACTIONS,`): `  ...ARCHIVE_ACTIONS,`

- [ ] **Step 5: Add the 3 names to `INTENTIONAL_ASYMMETRY`** in `src/actions/coverage.ts` (after the c55.12 block):

```ts
  // ── c55.13: NEW rest-only operator-UI archive defs (no voice twin BY DESIGN — archive management is
  // operator-direct UI plumbing, spec §10 step 3). ──
  list_archived_panes: new Set<Surface>(["rest"]),
  restore_archived_pane: new Set<Surface>(["rest"]),
  delete_archived_pane: new Set<Surface>(["rest"]),
```

- [ ] **Step 6: Run the test → PASS** (PowerShell, same command as Step 2). Expect 8 tests pass (3 shape + 5 fidelity).

- [ ] **Step 7: Lint + commit** — `npm run lint` exit 0. Bash: `git -C "<wt>" add src/actions/defs/archive.ts src/actions/registry.ts src/actions/coverage.ts tests/test_c55_13_archive.ts && git -C "<wt>" commit -m "feat(c55.13): 3 rest-only archive defs (list/restore/delete) + registry wiring + asymmetry" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: Cutover — mount, delete inline routes, shrink the catalog (TDD)

**Files:** Modify `tests/test_c55_13_archive.ts`, `server.ts`, `src/actions/inlineExceptions.ts`.

- [ ] **Step 1: Append the failing cutover guard** to `tests/test_c55_13_archive.ts`:

```ts
// ════════════════════════════════════════════════════════════════════════════════════════════════
// cutover guard — server.ts inline routes deleted + names added to the only-set
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55.13 — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");
  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock = onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  for (const name of ["list_archived_panes", "restore_archived_pane", "delete_archived_pane"]) {
    it(`mountRestRoutes only-set includes "${name}"`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(new RegExp(`["']${name}["']`).test(mountBlock), `only-set must include "${name}" after the c55.13 cutover`);
    });
  }
  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "GET /api/archive", needle: /app\.get\(\s*["']\/api\/archive["']/ },
    { label: "POST /api/archive/:paneId/restore", needle: /app\.post\(\s*["']\/api\/archive\/:paneId\/restore["']/ },
    { label: "DELETE /api/archive/:paneId", needle: /app\.delete\(\s*["']\/api\/archive\/:paneId["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(!needle.test(serverSrc), `inline ${label} must be deleted (converged to the registry)`);
    });
  }
});
```

- [ ] **Step 2: Run it → verify it fails** (PowerShell, same command).

- [ ] **Step 3: Add the 3 names to the mount `only` set** in `server.ts` (Grep `only: new Set`; add after the c55.12 entries):

```ts
      // c55.13 — 3 rest-only operator-UI archive defs, cut over from the inline app.* routes deleted
      // below. Ungated operator-direct; the UI repaints off ledger_updated/terminals_updated.
      "list_archived_panes",
      "restore_archived_pane",
      "delete_archived_pane",
```

- [ ] **Step 4: Delete the 3 inline route blocks** from `server.ts` (Grep each literal, Read a tight window, Edit out): `app.get("/api/archive"` (the multi-line projection handler), `app.post("/api/archive/:paneId/restore"`, `app.delete("/api/archive/:paneId"`. Optional one-line breadcrumb at each site. Do NOT delete or alter any other route (the `// --- ORCHESTRATION PIPELINES …` comment + the `recipes` const that follow the delete block STAY).

- [ ] **Step 5: Remove the 3 catalog rows** from `src/actions/inlineExceptions.ts` — the `// ── future-convergence: archive ──` comment + its 3 entries (`get /api/archive`, `post /api/archive/:paneId/restore`, `delete /api/archive/:paneId`).

- [ ] **Step 6: Run the c55.13 test + the no-twin guard → both green** — PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_c55_13_archive.ts tests/test_no_inline_twins.ts`. Expect BOTH PASS.

- [ ] **Step 7: Lint + commit** — `npm run lint` exit 0. Bash: `git -C "<wt>" add server.ts src/actions/inlineExceptions.ts tests/test_c55_13_archive.ts && git -C "<wt>" commit -m "feat(c55.13): cut over the 3 inline archive routes to the registry; shrink the no-twin catalog" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: Full-battery + catalog regen + scope check

- [ ] **Step 1: Regenerate the catalog** — PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npm run catalog`. If it changed a generated file (expected: 66→69 actions), commit it (`git -C "<wt>" add -A && git -C "<wt>" commit -m "chore(c55.13): regenerate catalog for the 3 new archive defs" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`). Else skip.

- [ ] **Step 2: Full battery** — PowerShell (one call): `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npm run lint; npm test; npm run build`. Expect lint 0; `# fail 0` (incl. `test_c55_13_archive` + `test_no_inline_twins` + the coverage/asymmetry test); build 0. If a registry/catalog golden or hard-coded action-COUNT test fails due to the 3 new defs, regenerate (`npm run catalog`) or bump the count (+3) with a one-line note and commit — do NOT weaken an assertion. Watch for a stale scope-guard asserting an archive route "stays inline" (retire it the way c55.11/c55.12 did — remove only the now-converged entries, keep genuinely-inline ones, annotate, commit separately).

- [ ] **Step 3: Scope check** — Bash: `git -C "<wt>" diff --name-only main..HEAD`. Expected: the plan.md, `src/actions/defs/archive.ts`, `src/actions/registry.ts`, `src/actions/coverage.ts`, `server.ts`, `src/actions/inlineExceptions.ts`, `tests/test_c55_13_archive.ts`, and (if regenerated/retired) the catalog artifact + any scope-guard test. Flag anything else. Also `git -C "<wt>" log --oneline main..HEAD` and `git -C "<wt>" status --short` (clean).

---

## Self-Review

- **Spec coverage:** §10 step 3 (Archive → registry defs list/restore/delete, plumbing) → Tasks 1–2 cover all 3 routes as ungated rest-only defs with the catalog rows removed under the guard.
- **Placeholder scan:** none — all 3 defs, the registry wiring, the asymmetry entries, the deletions, and the full test are verbatim. The only conditional is the catalog/golden regen.
- **Type consistency:** def names (`list_archived_panes`/`restore_archived_pane`/`delete_archived_pane`) identical across archive.ts, registry.ts spread, coverage.ts, the mount set, and the test. All `ALWAYS_ALLOWED` + `readOnly:false` + `surfaces:{'rest'}`. `list_archived_panes` uses `toHttp` for `{archived:…}`; restore/delete use the default `{output}` map.
- **Fidelity:** `list_archived_panes` reproduces the inline projection exactly (6 fields, `last_command || ""`); restore fans BOTH broadcasts, delete fans ledger only — matching the inline handlers; 404→200 deltas documented.

## Out of scope (later beads)
Project/pane lifecycle (c55.14 — has gating decisions), approvals/pending (c55.15 — HiTL gating), the terminal `opts.only` drop (c55.16), and gate-tightening the new ungated REST writes (c55.10). This batch touches only the 3 archive routes.
