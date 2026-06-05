# c55.12 — NOTES-endpoint Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge the 6 inline operator-UI note/context routes into rest-only registry defs, so the registry is the single home and the no-twin catalog shrinks by 6.

**Architecture:** The 6 inline routes (`POST/GET /api/projects/:id/notes`, `PUT/DELETE /api/notes/:id`, `POST /api/projects/:projectId/panes/:paneId/notes`, `POST .../context`) are the **operator-UI** note CRUD — explicitly **ungated** (operator acting in their own browser) and, for the GET feed, **unredacted** (DOM-render-only). The existing **voice** note defs (`add_project_note`/`add_pane_note`/`amend_note`/`delete_note`/`get_project_notes` in `defs/notes.ts` + `registry.ts`) are a DIFFERENT, model-facing path — the deletes/amends are **gated** via `update_metadata` and the read is **redacted**. Reusing them on REST would regress the operator path (gate the deletes, redact the feed). So — exactly like `get_terminal_history` (raw, rest-only) sits beside `get_pane_command_history` (prose, gated, voice) — c55.12 adds **6 new rest-only `ALWAYS_ALLOWED` defs** that faithfully port the inline handlers. They live in `defs/notes.ts` beside the voice defs and join `NOTES_ACTIONS`.

> **Engineering decision (documented):** uniform rest-only `ALWAYS_ALLOWED` twins (vs. adding a REST surface to the ungated voice `add_project_note`/`add_pane_note`). Chosen for zero gating-regression risk and uniformity; the cost is 2 near-duplicate names (`create_project_note` vs voice `add_project_note`). The ungated-now posture is intentional and revisited by **c55.10** (gate-tightening for the new ALWAYS_ALLOWED REST writes); a later cleanup could merge the voice/rest note pairs. Faithful behavior is the priority for this batch.

**Tech Stack:** TypeScript, `node:test` via `tsx --test --test-force-exit`. No new deps.

---

## Platform / worktree notes (read first)

- Work in worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-12-notes` on branch `feat/c55.12-notes-convergence` (off `main`, includes c55.11). Never edit the main checkout.
- Windows: **PowerShell tool** for npm (`Set-Location` the worktree + `$env:PYTHONIOENCODING='utf-8'` first; PS 5.1 has no `&&`). **Bash tool** (Git Bash) for git only, as `git -C "<wt>" …`. Never mix shells in one call.
- `server.ts` is large — Grep the route literal, Read a tight window, then Edit. Tests: `npm test` = `tsx --test --test-force-exit`; node-pty `AttachConsole failed` lines = display noise (judge by `# pass/# fail`).
- `node_modules` already junctioned (do NOT `npm ci`). End commits with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push; do NOT run `bd`.

## Fidelity contract (the legacy inline bodies — captured pre-cutover)

| Inline route (server.ts) | Handler | New rest-only def | Faithful behavior |
|---|---|---|---|
| `POST /api/projects/:id/notes` (779) | `addNote(id, note)`; broadcast; `{success:true}` | `create_project_note` | ungated write; body delta `{success:true}`→`{output}` (UI repaints off `ledger_updated`) |
| `GET /api/projects/:id/notes` (790) | `{notes: getNotes({projectId:id})}` | `read_project_notes` | **unredacted** raw feed; `toHttp` emits `{notes:[…]}` top-level |
| `PUT /api/notes/:id` (797) | `amendNote(id, text)`; broadcast; `{success:true}` | `edit_note` | **ungated** (the voice `amend_note` is gated); 400→zod 500 delta |
| `DELETE /api/notes/:id` (805) | `deleteNote(id)`; broadcast; `{success:true}` | `remove_note` | **ungated** (the voice `delete_note` is gated) |
| `POST /api/projects/:projectId/panes/:paneId/notes` (815) | `addPaneNote(projectId, paneId, note)`; broadcast; `{success:true}` | `create_pane_note` | ungated write |
| `POST /api/projects/:projectId/panes/:paneId/context` (824) | `addModelContext`/`addHumanContext` by `layer`; broadcast; `{success:true}` | `add_pane_context` | ungated; 404→200 ok-narration, 400→zod 500 deltas |

All 6 → `ALWAYS_ALLOWED`, `readOnly:false`, `surfaces:{'rest'}`. `rest.path` uses **snake_case** segments (`:project_id`/`:pane_id`/`:note_id`) so Express injects the path param onto the snake_case zod key (Batch B precedent; the client's literal URL is unchanged).

## File Structure

- **Modify** `src/actions/defs/notes.ts` — append 6 rest-only defs + add them to `NOTES_ACTIONS`; add `ALWAYS_ALLOWED` to the `../types` import.
- **Modify** `src/actions/coverage.ts` — add the 6 names to `INTENTIONAL_ASYMMETRY`.
- **Modify** `server.ts` — add the 6 names to the `mountRestRoutes` `only` set; delete the 6 inline route blocks.
- **Modify** `src/actions/inlineExceptions.ts` — delete the 6 `future-convergence: notes` rows.
- **Create** `tests/test_c55_12_notes.ts` — def shape + fidelity + cutover guard.

---

### Task 1: The 6 rest-only note defs (registry side, TDD)

**Files:** Create `tests/test_c55_12_notes.ts`; Modify `src/actions/defs/notes.ts`, `src/actions/coverage.ts`.

- [ ] **Step 1: Write the failing contract test** — create `tests/test_c55_12_notes.ts`:

```ts
/**
 * tests/test_c55_12_notes.ts — c55.12 (wsm-e2e-pinned-c55.12): converge the 6 inline operator-UI
 * note/context routes into rest-only ActionDefs. Each is a faithful port of the inline handler:
 * UNGATED (ALWAYS_ALLOWED), readOnly:false, unredacted. Same doctrine as c55.11/Batch F: run the real
 * choke-point with a fake ctx, assert the ActionResult, then assert applyResultToHttp maps it to
 * {status, body}. Writes use the default {output} map (UI ignores the body, repaints off ledger_updated);
 * the GET feed rides rest.toHttp to emit {notes:[…]} top-level (the legacy shape).
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

// A fake ledger that records calls so we can assert the handler hit the right method with the right args.
function makeCtx(): { ctx: ActionContext; calls: string[]; notes: unknown[] } {
  const calls: string[] = [];
  const notes: unknown[] = [{ id: "n1", pane_id: null, type: "note", created_at: "t", text: "secret AKIAxxx" }];
  const ledger: any = {
    addNote: (p: string, n: string) => { calls.push(`addNote:${p}:${n}`); return { id: "n1" }; },
    getNotes: (q: { projectId: string }) => { calls.push(`getNotes:${q.projectId}`); return notes; },
    amendNote: (id: string, t: string) => { calls.push(`amendNote:${id}:${t}`); return { id }; },
    deleteNote: (id: string) => { calls.push(`deleteNote:${id}`); return true; },
    addPaneNote: (p: string, pane: string, n: string) => { calls.push(`addPaneNote:${p}:${pane}:${n}`); return { id: "n2" }; },
    addModelContext: (p: string, pane: string, t: string) => { calls.push(`addModelContext:${p}:${pane}:${t}`); return true; },
    addHumanContext: (p: string, pane: string, t: string) => { calls.push(`addHumanContext:${p}:${pane}:${t}`); return true; },
  };
  const ctx = {
    manager: { ledger }, session: null, surface: "rest",
    broadcastLedgerUpdate: () => { calls.push("broadcast"); },
    redact: (s: string) => `RED(${s})`, isFrozen: () => false, effectiveCapabilityGateFor: () => "Auto",
  } as unknown as ActionContext;
  return { ctx, calls, notes };
}

const SHAPE: Array<{ name: string; method: string; path: string }> = [
  { name: "create_project_note", method: "post", path: "/api/projects/:project_id/notes" },
  { name: "read_project_notes", method: "get", path: "/api/projects/:project_id/notes" },
  { name: "edit_note", method: "put", path: "/api/notes/:note_id" },
  { name: "remove_note", method: "delete", path: "/api/notes/:note_id" },
  { name: "create_pane_note", method: "post", path: "/api/projects/:project_id/panes/:pane_id/notes" },
  { name: "add_pane_context", method: "post", path: "/api/projects/:project_id/panes/:pane_id/context" },
];

describe("c55.12 — 6 rest-only note defs (shape + asymmetry)", () => {
  for (const { name, method, path: p } of SHAPE) {
    it(`${name} is rest-only ALWAYS_ALLOWED readOnly:false, binds ${method.toUpperCase()} ${p}, allow-listed`, () => {
      const def = findDef(name);
      assert.strictEqual(def.capability, "ALWAYS_ALLOWED", `${name} is ungated operator-UI`);
      assert.strictEqual(def.readOnly, false);
      assert.deepStrictEqual([...def.surfaces], ["rest"]);
      assert.deepStrictEqual(def.rest?.method, method);
      assert.deepStrictEqual(def.rest?.path, p);
      assert.deepStrictEqual(INTENTIONAL_ASYMMETRY[name], new Set(["rest"]), `${name} must be allow-listed rest-only`);
    });
  }
});

describe("c55.12 — fidelity: handlers hit the right ledger method + write defs broadcast", () => {
  it("create_project_note -> addNote + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("create_project_note", { project_id: "proj", note: "hi" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("addNote:proj:hi") && calls.includes("broadcast"));
  });
  it("read_project_notes -> getNotes, UNREDACTED {notes:[…]} TOP-LEVEL at 200", async () => {
    const { ctx, notes } = makeCtx();
    const { status, json } = await runToHttp("read_project_notes", { project_id: "proj" }, ctx);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { notes }, "raw {notes:[…]} top-level, byte-identical to the inline feed (NOT redacted, NOT {output})");
  });
  it("edit_note -> amendNote + broadcast, 200 (ungated)", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("edit_note", { note_id: "n1", text: "new" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("amendNote:n1:new") && calls.includes("broadcast"));
  });
  it("remove_note -> deleteNote + broadcast, 200 (ungated)", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("remove_note", { note_id: "n1" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("deleteNote:n1") && calls.includes("broadcast"));
  });
  it("create_pane_note -> addPaneNote + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("create_pane_note", { project_id: "proj", pane_id: "p1", note: "n" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("addPaneNote:proj:p1:n") && calls.includes("broadcast"));
  });
  it("add_pane_context layer=model -> addModelContext + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("add_pane_context", { project_id: "proj", pane_id: "p1", text: "ctx", layer: "model" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("addModelContext:proj:p1:ctx") && calls.includes("broadcast"));
  });
  it("add_pane_context (no layer) -> addHumanContext + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("add_pane_context", { project_id: "proj", pane_id: "p1", text: "ctx" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("addHumanContext:proj:p1:ctx") && calls.includes("broadcast"));
  });
});
```

- [ ] **Step 2: Run the test → verify it fails** — PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_c55_12_notes.ts` → FAIL (`registry must contain a def named 'create_project_note'`).

- [ ] **Step 3: Add the 6 defs to `src/actions/defs/notes.ts`** — first change the types import at the top to add `ALWAYS_ALLOWED`:

```ts
import type { ActionDef, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";
```

Then insert these 6 defs immediately BEFORE the `NOTES_ACTIONS` export:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// c55.12 — 6 rest-only operator-UI note/context defs (faithful ports of the inline routes)
// ─────────────────────────────────────────────────────────────────────────────
// These are the OPERATOR-UI surface: ungated (the operator acts in their own browser) and, for the
// read feed, UNREDACTED (DOM-render-only — redaction is a MODEL-egress guard; the voice tools redact,
// this feed does not). DISTINCT from the gated/redacted voice note defs above. ALWAYS_ALLOWED +
// readOnly:false (the §8.1 invariant binds readOnly to read_pane/read_notes; ungated reads use false,
// same as get_stop_all_status). Writes return an ok-narration -> default {output} (the UI ignores the
// body and repaints off the ledger_updated broadcast). rest.path uses snake_case segments. The ungated
// posture is intentional (revisited by c55.10 gate-tightening).

const CreateProjectNoteParams = z.object({ project_id: z.string(), note: z.string() });
export const createProjectNote: ActionDef<typeof CreateProjectNoteParams> = {
  name: "create_project_note",
  description: "Operator-UI: add a note to a project (ungated, operator-direct). The gated model-facing path is the voice add_project_note tool.",
  params: CreateProjectNoteParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/projects/:project_id/notes" },
  handler: (args, ctx): ActionResult => {
    ctx.manager.ledger.addNote(args.project_id, args.note);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Note added to project ${args.project_id}.` };
  },
};

const ReadProjectNotesParams = z.object({ project_id: z.string() });
export const readProjectNotes: ActionDef<typeof ReadProjectNotesParams> = {
  name: "read_project_notes",
  description: "Operator-UI: the raw, id-bearing project notes feed for the Node Chronicle (UNREDACTED — DOM-render-only). The redacted model-facing read is the voice get_project_notes tool.",
  params: ReadProjectNotesParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/projects/:project_id/notes",
    // Emit {notes:[…]} TOP-LEVEL — the exact legacy inline body shape the UI reads as data.notes.
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: { notes: result.kind === "ok" ? result.output : [] },
    }),
  },
  handler: (args, ctx): ActionResult => ({ kind: "ok", output: ctx.manager.ledger.getNotes({ projectId: args.project_id }) }),
};

const EditNoteParams = z.object({ note_id: z.string(), text: z.string() });
export const editNote: ActionDef<typeof EditNoteParams> = {
  name: "edit_note",
  description: "Operator-UI: edit a note's text by id (ungated, operator-direct). The gated model-facing path is the voice amend_note tool.",
  params: EditNoteParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "put", path: "/api/notes/:note_id" },
  handler: (args, ctx): ActionResult => {
    ctx.manager.ledger.amendNote(args.note_id, args.text);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Note ${args.note_id} updated.` };
  },
};

const RemoveNoteParams = z.object({ note_id: z.string() });
export const removeNote: ActionDef<typeof RemoveNoteParams> = {
  name: "remove_note",
  description: "Operator-UI: delete a note by id (ungated, operator-direct). The gated model-facing path is the voice delete_note tool.",
  params: RemoveNoteParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "delete", path: "/api/notes/:note_id" },
  handler: (args, ctx): ActionResult => {
    ctx.manager.ledger.deleteNote(args.note_id);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Note ${args.note_id} deleted.` };
  },
};

const CreatePaneNoteParams = z.object({ project_id: z.string(), pane_id: z.string(), note: z.string() });
export const createPaneNote: ActionDef<typeof CreatePaneNoteParams> = {
  name: "create_pane_note",
  description: "Operator-UI: add a note to a specific pane (ungated, operator-direct). The voice add_pane_note tool is the model-facing path.",
  params: CreatePaneNoteParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/projects/:project_id/panes/:pane_id/notes" },
  handler: (args, ctx): ActionResult => {
    ctx.manager.ledger.addPaneNote(args.project_id, args.pane_id, args.note);
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Note added to pane ${args.pane_id}.` };
  },
};

const AddPaneContextParams = z.object({ project_id: z.string(), pane_id: z.string(), text: z.string(), layer: z.string().optional() });
export const addPaneContext: ActionDef<typeof AddPaneContextParams> = {
  name: "add_pane_context",
  description: "Operator-UI: add a layered context entry to a pane (model layer if layer='model', else the human steering layer). Ungated operator-direct steering; not a CLI write.",
  params: AddPaneContextParams,
  capability: ALWAYS_ALLOWED,
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: { method: "post", path: "/api/projects/:project_id/panes/:pane_id/context" },
  handler: (args, ctx): ActionResult => {
    const ok = args.layer === "model"
      ? ctx.manager.ledger.addModelContext(args.project_id, args.pane_id, args.text, "operator-ui")
      : ctx.manager.ledger.addHumanContext(args.project_id, args.pane_id, args.text);
    if (!ok) return { kind: "ok", output: `Pane ${args.pane_id} not found in project ${args.project_id}.` };
    ctx.broadcastLedgerUpdate();
    return { kind: "ok", output: `Context added to pane ${args.pane_id}.` };
  },
};
```

Then add the 6 to `NOTES_ACTIONS` (after `deleteNote`):

```ts
export const NOTES_ACTIONS: ActionDef[] = [
  addProjectNote,
  addPaneNote,
  getProjectNotes,
  searchNotes,
  deleteNote,
  createProjectNote,
  readProjectNotes,
  editNote,
  removeNote,
  createPaneNote,
  addPaneContext,
];
```

> NOTE: `ctx.manager.ledger.addModelContext` / `addHumanContext` / `addNote` / `getNotes` / `amendNote` / `deleteNote` / `addPaneNote` are the SAME ledger methods the inline routes call — confirmed at server.ts:781/791/800/806/817/828/829. If `tsc` reports a method missing on the ledger type, re-check the spelling against the inline route; do not invent a method.

- [ ] **Step 4: Add the 6 names to `INTENTIONAL_ASYMMETRY`** in `src/actions/coverage.ts` (after the c55.11 block):

```ts
  // ── c55.12: NEW rest-only operator-UI note/context defs (no voice twin BY DESIGN — the voice note
  // tools are the gated/redacted model-facing path; these are the ungated operator-direct UI path). ──
  create_project_note: new Set<Surface>(["rest"]),
  read_project_notes: new Set<Surface>(["rest"]),
  edit_note: new Set<Surface>(["rest"]),
  remove_note: new Set<Surface>(["rest"]),
  create_pane_note: new Set<Surface>(["rest"]),
  add_pane_context: new Set<Surface>(["rest"]),
```

- [ ] **Step 5: Run the test → PASS** (PowerShell, same command as Step 2). Expect 13 tests pass (6 shape + 7 fidelity).

- [ ] **Step 6: Lint + commit** — `npm run lint` exit 0. Bash: `git -C "<wt>" add src/actions/defs/notes.ts src/actions/coverage.ts tests/test_c55_12_notes.ts && git -C "<wt>" commit -m "feat(c55.12): 6 rest-only operator-UI note/context defs + asymmetry" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: Cutover — mount, delete inline routes, shrink the catalog (TDD)

**Files:** Modify `tests/test_c55_12_notes.ts`, `server.ts`, `src/actions/inlineExceptions.ts`.

- [ ] **Step 1: Append the failing cutover guard** to `tests/test_c55_12_notes.ts`:

```ts
// ════════════════════════════════════════════════════════════════════════════════════════════════
// cutover guard — server.ts inline routes deleted + names added to the only-set
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55.12 — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");
  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const onlyOpenIdx = mountIdx >= 0 ? serverSrc.indexOf("only: new Set([", mountIdx) : -1;
  const onlyCloseIdx = onlyOpenIdx >= 0 ? serverSrc.indexOf("])", onlyOpenIdx) : -1;
  const mountBlock = onlyOpenIdx >= 0 && onlyCloseIdx >= 0 ? serverSrc.slice(onlyOpenIdx, onlyCloseIdx + 2) : "";

  for (const name of ["create_project_note", "read_project_notes", "edit_note", "remove_note", "create_pane_note", "add_pane_context"]) {
    it(`mountRestRoutes only-set includes "${name}"`, () => {
      assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
      assert.ok(new RegExp(`["']${name}["']`).test(mountBlock), `only-set must include "${name}" after the c55.12 cutover`);
    });
  }
  // The CONVERGED inline route literals must be GONE (double-registration silently masks the cutover).
  const goneLiterals: Array<{ label: string; needle: RegExp }> = [
    { label: "POST/GET /api/projects/:id/notes", needle: /app\.(get|post)\(\s*["']\/api\/projects\/:id\/notes["']/ },
    { label: "PUT /api/notes/:id", needle: /app\.put\(\s*["']\/api\/notes\/:id["']/ },
    { label: "DELETE /api/notes/:id", needle: /app\.delete\(\s*["']\/api\/notes\/:id["']/ },
    { label: "POST /api/projects/:projectId/panes/:paneId/notes", needle: /app\.post\(\s*["']\/api\/projects\/:projectId\/panes\/:paneId\/notes["']/ },
    { label: "POST /api/projects/:projectId/panes/:paneId/context", needle: /app\.post\(\s*["']\/api\/projects\/:projectId\/panes\/:paneId\/context["']/ },
  ];
  for (const { label, needle } of goneLiterals) {
    it(`inline route is deleted: ${label}`, () => {
      assert.ok(!needle.test(serverSrc), `inline ${label} must be deleted (converged to the registry)`);
    });
  }
});
```

- [ ] **Step 2: Run it → verify it fails** (PowerShell, same command). Expect the cutover assertions to fail.

- [ ] **Step 3: Add the 6 names to the mount `only` set** in `server.ts` (~the `only: new Set([` block), after the c55.11 entries:

```ts
      // c55.12 — 6 rest-only operator-UI note/context defs, cut over from the inline app.* routes
      // deleted below. Ungated operator-direct; the UI repaints off the ledger_updated broadcast.
      "create_project_note",
      "read_project_notes",
      "edit_note",
      "remove_note",
      "create_pane_note",
      "add_pane_context",
```

- [ ] **Step 4: Delete the 6 inline route blocks** from `server.ts` (Grep each literal, Read a tight window, Edit it out). Delete exactly these blocks (leave surrounding `c55 Batch B` rename comments + the `bead bjm` comments may be trimmed to a one-line breadcrumb):
  - `app.post("/api/projects/:id/notes", …)` (l.779-784)
  - `app.get("/api/projects/:id/notes", …)` (l.790-792)
  - `app.put("/api/notes/:id", …)` (l.797-803)
  - `app.delete("/api/notes/:id", …)` (l.805-809)
  - `app.post("/api/projects/:projectId/panes/:paneId/notes", …)` (l.815-820)
  - `app.post("/api/projects/:projectId/panes/:paneId/context", …)` (l.824-833)

  Optionally leave a one-line breadcrumb at each site, e.g. `// c55.12: <METHOD> <path> now served by the registry-derived <def> (mountRestRoutes only-set above).`. Do NOT delete or alter any other route.

- [ ] **Step 5: Remove the 6 catalog rows** from `src/actions/inlineExceptions.ts` — delete the `// ── future-convergence: notes ──` comment + its 6 entries (`post /api/projects/:id/notes`, `get /api/projects/:id/notes`, `put /api/notes/:id`, `delete /api/notes/:id`, `post /api/projects/:projectId/panes/:paneId/notes`, `post /api/projects/:projectId/panes/:paneId/context`).

- [ ] **Step 6: Run the c55.12 test + the no-twin guard → both green** — PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_c55_12_notes.ts tests/test_no_inline_twins.ts`. Expect BOTH PASS (cutover guard green; no-twin guard green because the 6 routes AND their 6 catalog rows are gone together).

- [ ] **Step 7: Lint + commit** — `npm run lint` exit 0. Bash: `git -C "<wt>" add server.ts src/actions/inlineExceptions.ts tests/test_c55_12_notes.ts && git -C "<wt>" commit -m "feat(c55.12): cut over the 6 inline note/context routes to the registry; shrink the no-twin catalog" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: Full-battery + catalog regen + scope check

- [ ] **Step 1: Regenerate the catalog** — PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npm run catalog`. If it changed a generated file (expected: 60→66 actions), commit it: `git -C "<wt>" add -A && git -C "<wt>" commit -m "chore(c55.12): regenerate catalog for the 6 new note defs" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`. If nothing changed, skip.

- [ ] **Step 2: Full battery** — PowerShell (one call): `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npm run lint; npm test; npm run build`. Expect lint 0; `# fail 0` (incl. `test_c55_12_notes` + `test_no_inline_twins` + the coverage/asymmetry test); build 0. If a registry/catalog golden or hard-coded action-COUNT test fails due to the 6 new defs, regenerate it (`npm run catalog`) or bump the count (+6) with a one-line note and commit — do NOT weaken an assertion. (Watch for a Batch-A/earlier scope-guard asserting these note routes "stay inline" — if present, retire it the way c55.11 did for `test_c55_batch_a.ts`: remove only the now-converged entries, keep genuinely-inline ones, annotate.)

- [ ] **Step 3: Scope check** — Bash: `git -C "<wt>" diff --name-only main..HEAD` (main is the fork point). Expected: `docs/.../2026-06-05-c55-12-notes-convergence.md`, `src/actions/defs/notes.ts`, `src/actions/coverage.ts`, `server.ts`, `src/actions/inlineExceptions.ts`, `tests/test_c55_12_notes.ts`, and (if regenerated) the catalog artifact (+ any retired scope-guard test). Flag anything else. Also `git -C "<wt>" log --oneline main..HEAD` and `git -C "<wt>" status --short` (clean).

---

## Self-Review

- **Spec coverage:** §10 step 2 (Notes → registry defs, ungated plumbing, "remove their rows from inlineExceptions.ts") → Tasks 1–2 cover all 6 routes as ungated rest-only defs with the catalog rows removed under the guard.
- **Placeholder scan:** none — all 6 defs, the asymmetry entries, the deletions, and the full test are verbatim. The only conditional is the catalog/golden regen (a concrete `npm run catalog` + commit-if-changed loop).
- **Type consistency:** def names (`create_project_note`/`read_project_notes`/`edit_note`/`remove_note`/`create_pane_note`/`add_pane_context`) are identical across notes.ts, coverage.ts, the mount set, and the test. All `ALWAYS_ALLOWED` + `readOnly:false` + `surfaces:{'rest'}`. `read_project_notes` uses `toHttp` for the `{notes:…}` shape; the 5 writes use the default `{output}` map.
- **Fidelity:** each handler calls the SAME ledger method the inline route did (`addNote`/`getNotes`/`amendNote`/`deleteNote`/`addPaneNote`/`addModelContext`/`addHumanContext`) and broadcasts identically; ungated + unredacted, faithful to the operator-UI routes. Accepted deltas (`{success:true}`→`{output}`, 400→zod 500, 404→200) match the c55 program precedent.

## Out of scope (later beads)
Archive (c55.13), project/pane lifecycle (c55.14), approvals/pending (c55.15), the terminal `opts.only` drop (c55.16), and gate-tightening these new ungated REST writes (c55.10). This batch touches only the 6 note/context routes.
