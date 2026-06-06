# c55.14 — PROJECT/PANE Lifecycle Convergence + delete-gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Converge the 4 inline project/pane lifecycle routes into registry defs, AND — per the director's decision — gate the two destructive deletes behind two NEW safety-matrix capabilities (`delete_pane`, `delete_project`, both Destructive / default **Ask**).

**Architecture:** Two halves. **(A) Matrix expansion:** add `delete_pane` + `delete_project` to the derived capability matrix (the 22→24 change rippling through `gateSurface.ts`, `capabilities.ts`, `types.ts`, the e2e harness, and the catalog). The totality tests key off `ALL_CAPABILITIES.length` so they auto-adapt; the §8.1b set-equality + #5c defaultGate-golden tests must be kept consistent. **(B) Convergence:** 4 rest-only defs — `update_project` + `stop_pane` are `ALWAYS_ALLOWED` (ungated plumbing); `delete_project` + `delete_pane` are GATED via `ctx.gateOrDefer` with **status-via-kinds** (Off→`kind:'blocked'`→403, Ask→`kind:'pending'`→202, Auto→`kind:'ok'`→200), exactly mirroring `respawn_pane` (`src/actions/defs/panes_rest.ts:147`). This is a deliberate behaviorDelta: the inline deletes were ungated; they now Ask.

**Tech Stack:** TypeScript, `node:test` via `tsx --test --test-force-exit`. No new deps.

---

## Worktree (already set up)

Worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-14-lifecycle`, branch `feat/c55.14-lifecycle-convergence` (off `main` @ the c55.13 merge), node_modules junctioned, bead `wsm-e2e-pinned-c55.14` claimed.

## Platform notes
- Windows: **PowerShell tool** for npm (`Set-Location` the worktree + `$env:PYTHONIOENCODING='utf-8'`; no `&&`). **Bash tool** for git only (`git -C "<wt>" …`). `server.ts` large — Grep then Read a tight window. node-pty `AttachConsole failed` = display noise. Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push (until green + your approval); do NOT run `bd` beyond claim/close.

## Fidelity contract (legacy inline handlers, captured pre-cutover)

| Inline route | Handler (server.ts, pre-c55.14 line) | New def | Gating |
|---|---|---|---|
| `PUT /api/projects/:id` (773) | partial update `{directory,summary,keyTerms,name}` on `getProject(id)`; 404 if missing; `{success:true}` | `update_project` | ALWAYS_ALLOWED |
| `DELETE /api/projects/:id` (861) | `delete workspaces[id]` + active-project reassignment (`switchContext`/`addProject` fallback) + `saveSettings` + `save` + broadcast; 404 if missing | `delete_project` | **GATED `delete_project` (Ask)** |
| `DELETE /api/projects/:projectId/panes/:paneId` (884) | `term.stop()` + `delete terminals[paneId]` + `delete ws.panes[paneId]` + `save` + ledger&terminals broadcast | `delete_pane` | **GATED `delete_pane` (Ask)** |
| `POST /api/projects/:projectId/panes/:paneId/stop` (904) | `await stopAndArchivePane(projectId,paneId)` + broadcasts; `{success:true, archived}` | `stop_pane` | ALWAYS_ALLOWED |

> Re-Grep these line numbers in THIS worktree before editing (the c55.13 merge may have shifted them). `PUT /api/projects/:projectId/panes/:paneId/capability-gates` is NOT in this batch — it is the HELD bulk-gates collision (c55.16). Leave it inline.

---

### Task 1: Add `delete_pane` + `delete_project` to the safety matrix

**Files:** `src/types.ts`, `src/gateSurface.ts`, `src/actions/capabilities.ts`, `src/e2e/harness.ts` (+ any defaultGate golden the tests pin).

The matrix is DERIVED + pinned by tests (`test_action_registry.ts §8.1b`: `ALL_CAPABILITIES` === `CAPABILITY_DEFS` id set === `deriveCapabilities(REGISTRY)`). Because Task 2 registers defs with capability `delete_pane`/`delete_project`, those caps MUST be added to ALL of: `ALL_CAPABILITIES`, `CAPABILITY_LABELS`, `CAPABILITY_CATEGORIES`, `CATEGORY`, `CAPABILITY_DEFS`, the `CapabilityGate` union, and any default-gate map — or the §8.1b equality + the totality tests break. Do Task 1 BEFORE Task 2's defs reference the caps.

- [ ] **Step 1: `src/types.ts`** — Read it; find the `CapabilityGate` (a.k.a `Capability`) string union (~line 14) and add `| "delete_pane" | "delete_project"`. Find the default-gates map (the one with `close_pane: "Ask"`, ~line 45) and add `delete_pane: "Ask",` + `delete_project: "Ask",`. (Match the file's exact formatting.)

- [ ] **Step 2: `src/gateSurface.ts`** — three edits:
  - `ALL_CAPABILITIES` (line 40): add `"delete_pane", "delete_project",` to the Destructive cluster (e.g. after `"close_pane",`; order only affects display).
  - `CAPABILITY_LABELS` (line 187): add `delete_pane: "Delete a pane permanently",` and `delete_project: "Delete a project",` (plain language, no jargon).
  - `CAPABILITY_CATEGORIES.Destructive` (line 226): add `"delete_pane", "delete_project"` to the `"Destructive"` array.

- [ ] **Step 3: `src/actions/capabilities.ts`** — two edits:
  - `CATEGORY` map (line 24): add `delete_pane: "Destructive",` and `delete_project: "Destructive",`.
  - `CAPABILITY_DEFS` (line 62): add two rows (near `close_pane`/`restart_pane`):
    ```ts
    { id: "delete_pane", label: CAPABILITY_LABELS.delete_pane, category: CATEGORY.delete_pane, defaultGate: "Ask" },
    { id: "delete_project", label: CAPABILITY_LABELS.delete_project, category: CATEGORY.delete_project, defaultGate: "Ask" },
    ```

- [ ] **Step 4: `src/e2e/harness.ts`** — Read it; find the gate-defaults map (with `close_pane: "Ask"`, ~line 214) and add `delete_pane: "Ask",` + `delete_project: "Ask",` so the e2e mock matrix stays total.

- [ ] **Step 5: Run the matrix/totality tests**

PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_gate_surface.ts tests/test_gate_surface_normalize.ts tests/test_action_registry.ts`
Expected: PASS. Totality tests key off `ALL_CAPABILITIES.length` (auto-adapt to 24). **If `test_action_registry.ts §8.1b` fails** with a set-mismatch, you missed one of the lists — reconcile (the message names the missing/extra cap). **If a #5c "defaultGate golden" test fails**, it pins the exact default-gate map; add the 2 new `Ask` entries to the golden (regenerate via its documented command if one exists; else add by hand — do NOT change any existing default).

- [ ] **Step 6: Lint + commit** — `npm run lint` exit 0. Commit `src/types.ts src/gateSurface.ts src/actions/capabilities.ts src/e2e/harness.ts` (+ any golden) with `feat(c55.14): add delete_pane + delete_project capabilities (Destructive, default Ask)` + trailer.

---

### Task 2: The 4 lifecycle defs (2 gated, 2 ungated) — registry side, TDD

**Files:** Create `src/actions/defs/lifecycle_rest.ts`, `tests/test_c55_14_lifecycle.ts`; Modify `src/actions/registry.ts`, `src/actions/coverage.ts`.

- [ ] **Step 1: Write the failing contract test** — `tests/test_c55_14_lifecycle.ts`. Cover: (a) shape for all 4 (rest-only; `update_project`/`stop_pane` = `ALWAYS_ALLOWED`; `delete_project`/`delete_pane` = their cap, `readOnly:false`, correct method/path, asymmetry-listed); (b) fidelity for the 2 ungated (right ledger method + broadcast via a call-recording fake); (c) **gating status-via-kinds** for the 2 deletes — drive `ctx.gateOrDefer` to each disposition via a fake and assert forbidden→`kind:'blocked'` (HTTP 403 through `applyResultToHttp`), deferred→`kind:'pending'` (202), run→`kind:'ok'` (200) + the effect ran. Model the fake `gateOrDefer` on `tests/test_c55_batch_c.ts` / the respawn_pane tests (Grep `gateOrDefer` in tests for the established fake shape). Run → FAIL (defs missing).

- [ ] **Step 2: Create `src/actions/defs/lifecycle_rest.ts`** with the 4 defs:

```ts
/**
 * src/actions/defs/lifecycle_rest.ts — c55.14: project/pane lifecycle (rest-only).
 *
 * update_project + stop_pane are ungated plumbing (ALWAYS_ALLOWED). delete_project + delete_pane are
 * the DESTRUCTIVE deletes — GATED (delete_project / delete_pane, default Ask) via ctx.gateOrDefer with
 * STATUS-VIA-KINDS (Off->blocked->403, Ask->pending->202, Auto->ok->200), mirroring respawn_pane. This
 * is a deliberate behaviorDelta: the inline deletes were ungated; they now Ask (director decision, c55.14).
 */
import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";

const UpdateProjectParams = z.object({
  project_id: z.string(),
  directory: z.string().optional(),
  summary: z.string().optional(),
  keyTerms: z.array(z.string()).optional(),
  name: z.string().optional(),
});
export const updateProject: ActionDef<typeof UpdateProjectParams> = {
  name: "update_project",
  description: "Update a project's directory/summary/keyTerms/name (operator-UI, ungated).",
  params: UpdateProjectParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "put", path: "/api/projects/:project_id" },
  handler: (args, ctx): ActionResult => {
    const ws = ctx.manager.ledger.getProject(args.project_id);
    if (!ws) return { kind: "ok", output: `Project ${args.project_id} not found.` }; // inline 404 -> 200 ok-narration
    if (args.directory !== undefined) ws.directory = args.directory;
    if (args.summary !== undefined) ws.summary = args.summary;
    if (args.keyTerms !== undefined) ws.keyTerms = Array.isArray(args.keyTerms) ? args.keyTerms : [];
    if (args.name !== undefined) ws.name = args.name;
    ctx.manager.ledger["save"](true);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Project ${args.project_id} updated.` };
  },
};

const StopPaneParams = z.object({ project_id: z.string(), pane_id: z.string() });
export const stopPane: ActionDef<typeof StopPaneParams> = {
  name: "stop_pane",
  description: "Gracefully stop a pane and archive it (recoverable). Operator-UI, ungated (the destructive hard-delete is delete_pane).",
  params: StopPaneParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/projects/:project_id/panes/:pane_id/stop" },
  handler: async (args, ctx): Promise<ActionResult> => {
    const archived = await ctx.manager.stopAndArchivePane(args.project_id, args.pane_id);
    ctx.broadcastLedgerUpdate();
    ctx.broadcastTerminalsUpdated();
    return { kind: "ok", output: `Pane ${args.pane_id} stopped and archived (${archived}).` };
  },
};

const DeleteProjectParams = z.object({ project_id: z.string() });
export const deleteProject: ActionDef<typeof DeleteProjectParams> = {
  name: "delete_project",
  description: "Permanently delete a project workspace. GATED (delete_project, default Ask): refused Off, asks in Ask, runs in Auto.",
  params: DeleteProjectParams,
  capability: "delete_project",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/projects/:project_id" },
  handler: (args, ctx): ActionResult => {
    const id = args.project_id;
    if (!ctx.manager.ledger.workspaces[id]) return { kind: "ok", output: `Project ${id} not found.` }; // resolve before gate
    const deleteEffect = (): string => {
      delete ctx.manager.ledger.workspaces[id];
      const remainingIds = Object.keys(ctx.manager.ledger.workspaces);
      if (ctx.manager.ledger.activeProjectId === id) {
        const nextId = remainingIds[0] || "default_project";
        if (!ctx.manager.ledger.workspaces[nextId]) {
          ctx.manager.ledger.addProject(nextId, process.cwd(), "Default workspace");
        }
        ctx.manager.ledger.switchContext(nextId);
        ctx.manager.settings.projects.activeContext = nextId;
        ctx.manager.settings.projects.localWorkspacePath = ctx.manager.ledger.workspaces[nextId]?.directory || process.cwd();
        ctx.manager.saveSettings();
      }
      ctx.manager.ledger["save"]();
      ctx.broadcastLedgerUpdate();
      return `Project ${id} deleted.`;
    };
    const g = ctx.gateOrDefer("delete_project", null, `Delete project ${id}`, deleteEffect, { ...(ctx.versionStamp ?? {}), origin: "rest", projectId: id });
    if (g.disposition === "forbidden") return { kind: "blocked", reason: "Error: the 'delete_project' capability is gated Off; deleting projects is forbidden by policy." };
    if (g.disposition === "deferred") return { kind: "pending", messageId: g.actionId, summary: g.summary };
    return { kind: "ok", output: deleteEffect() };
  },
};

const DeletePaneParams = z.object({ project_id: z.string(), pane_id: z.string() });
export const deletePane: ActionDef<typeof DeletePaneParams> = {
  name: "delete_pane",
  description: "Permanently delete a pane record (hard delete; not the recoverable stop_pane). GATED (delete_pane, default Ask).",
  params: DeletePaneParams,
  capability: "delete_pane",
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/projects/:project_id/panes/:pane_id" },
  handler: (args, ctx): ActionResult => {
    const { project_id, pane_id } = args;
    const deleteEffect = (): string => {
      const term = ctx.manager.terminals[pane_id];
      if (term) { term.stop(); delete ctx.manager.terminals[pane_id]; }
      const ws = ctx.manager.ledger.getProject(project_id);
      if (ws && ws.panes[pane_id]) { delete ws.panes[pane_id]; ctx.manager.ledger["save"](); }
      ctx.broadcastLedgerUpdate();
      ctx.broadcastTerminalsUpdated();
      return `Pane ${pane_id} deleted.`;
    };
    const g = ctx.gateOrDefer("delete_pane", pane_id, `Delete pane ${pane_id}`, deleteEffect, { ...(ctx.versionStamp ?? {}), origin: "rest", paneId: pane_id });
    if (g.disposition === "forbidden") return { kind: "blocked", reason: "Error: the 'delete_pane' capability is gated Off; deleting panes is forbidden by policy." };
    if (g.disposition === "deferred") return { kind: "pending", messageId: g.actionId, summary: g.summary };
    return { kind: "ok", output: deleteEffect() };
  },
};

export const LIFECYCLE_REST_ACTIONS: ActionDef[] = [updateProject, stopPane, deleteProject, deletePane];
```

> Verify against the inline handlers (Grep server.ts): the `delete_project` active-reassignment logic and `delete_pane` term-stop+record-delete must be reproduced EXACTLY inside the effect closures. Confirm `ctx.manager.stopAndArchivePane`, `ctx.manager.saveSettings`, `ctx.manager.settings.projects.*`, `ctx.versionStamp`, and `ctx.gateOrDefer` exist on the types (used by close_pane/respawn_pane — Grep if tsc complains).

- [ ] **Step 3: Wire `LIFECYCLE_REST_ACTIONS` into `registry.ts`** (import + `...LIFECYCLE_REST_ACTIONS,` spread, like `ARCHIVE_ACTIONS`).

- [ ] **Step 4: Add 4 `INTENTIONAL_ASYMMETRY` entries** in `coverage.ts`:
```ts
  // ── c55.14: NEW rest-only lifecycle defs. update_project/stop_pane ungated; delete_project/delete_pane
  // GATED (new Destructive caps, default Ask). No voice twin. ──
  update_project: new Set<Surface>(["rest"]),
  stop_pane: new Set<Surface>(["rest"]),
  delete_project: new Set<Surface>(["rest"]),
  delete_pane: new Set<Surface>(["rest"]),
```

- [ ] **Step 5: Run the test → PASS** (shape + fidelity + the 3 gating dispositions per delete). Lint. **Commit** the 4 files with `feat(c55.14): 4 rest-only lifecycle defs (update/stop ungated; delete project/pane gated Ask) + asymmetry`.

---

### Task 3: Cutover — mount, delete inline routes, shrink the catalog (TDD)

- [ ] **Step 1:** Append the cutover-guard `describe` to `tests/test_c55_14_lifecycle.ts` (clone the c55.13 block): assert the 4 names are in the mount only-set AND these inline literals are GONE: `app.put("/api/projects/:id"`, `app.delete("/api/projects/:id"`, `app.delete("/api/projects/:projectId/panes/:paneId"`, `app.post("/api/projects/:projectId/panes/:paneId/stop"`. Run → FAIL.
- [ ] **Step 2:** Add the 4 names to the `only: new Set([` set in `server.ts` (after the c55.13 entries).
- [ ] **Step 3:** Delete the 4 inline route blocks (Grep each literal, Read window, Edit out). **Do NOT touch** the `capability-gates` PUT (held) or the `switch_context` Batch-B comment. Optional breadcrumbs.
- [ ] **Step 4:** Remove the 4 `future-convergence: project/pane lifecycle` rows from `src/actions/inlineExceptions.ts`.
- [ ] **Step 5:** Run `tests/test_c55_14_lifecycle.ts tests/test_no_inline_twins.ts` → BOTH PASS. Lint. **Commit** `server.ts inlineExceptions.ts tests/test_c55_14_lifecycle.ts` with `feat(c55.14): cut over the 4 inline lifecycle routes; shrink the no-twin catalog`.

---

### Task 4: Full-battery + catalog regen + scope check

- [ ] **Step 1:** `npm run catalog` → regenerate (expected: 69→73 actions + the gate matrix gains `delete_pane`/`delete_project` rows). Commit if changed: `chore(c55.14): regenerate catalog (4 new defs + 2 new caps)`.
- [ ] **Step 2:** Full battery (`npm run lint; npm test; npm run build`). Expect lint 0; `# fail 0` (incl. `test_c55_14_lifecycle`, `test_no_inline_twins`, `test_gate_surface*`, `test_action_registry`, the coverage/asymmetry test); build 0. Handle any matrix golden / count test by regenerating (NOT weakening). Watch for a stale scope-guard asserting a lifecycle route "stays inline" — retire it like c55.11–c55.13.
- [ ] **Step 3:** Scope check (`git -C "<wt>" diff --name-only main..HEAD`): expect this plan, `src/types.ts`, `src/gateSurface.ts`, `src/actions/capabilities.ts`, `src/e2e/harness.ts`, `src/actions/defs/lifecycle_rest.ts`, `src/actions/registry.ts`, `src/actions/coverage.ts`, `server.ts`, `src/actions/inlineExceptions.ts`, `tests/test_c55_14_lifecycle.ts`, `docs/CAPABILITIES.md`, + any golden. Flag anything else.

---

## Self-Review

- **Spec/decision coverage:** §10 step 4 (lifecycle → registry defs; deletes consequential → gated per P2) + the director decisions (gate deletes Ask; add delete_pane/delete_project caps) → Task 1 adds the caps, Task 2 gates the 2 deletes via status-via-kinds and leaves update/stop ungated.
- **Placeholder scan:** the 4 defs + asymmetry + matrix-edit specifics are concrete; the only Read-then-Edit steps are types.ts/harness positions + the defaultGate golden (the exact line moves; the additions are specified).
- **Type consistency:** the 2 new caps appear identically in the types union, ALL_CAPABILITIES, CAPABILITY_LABELS, CAPABILITY_CATEGORIES, CATEGORY, CAPABILITY_DEFS, harness, and the def `capability` fields — the §8.1b set-equality test is the backstop.
- **Behavior delta is intentional + documented:** deletes were ungated → now Ask (403/202/200). update/stop preserve ungated behavior. Recoverable `stop_pane` stays separate from hard `delete_pane`.

## Out of scope
Approvals/pending (c55.15 — mechanical, above-the-gate ALWAYS_ALLOWED + careful status contract), the `opts.only` drop + held collisions (c55.16), gate-tightening other ungated REST writes (c55.10).
