# c55.8 — Convergence Lid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Institutionalize the DBT5 + c55 modularization with a *declared-inline catalog* + a *no-twin guard test*, so `server.ts` can never silently re-accrete REST routes ("the lid").

**Architecture:** One new data module (`src/actions/inlineExceptions.ts`) lists every route deliberately left inline in `server.ts`, each with a category + reason, and carries the two governing principles (P1/P2) in its header. One new unit test (`tests/test_no_inline_twins.ts`) statically scans `server.ts` for `app.<verb>('<path>')` registrations and asserts the set matches the catalog **bidirectionally** — undeclared route ⇒ build fails; stale catalog entry ⇒ build fails. **No production behavior changes; `opts.only` is NOT touched in this batch** (dropping it is blocked by held collisions — deferred to a later bead).

**Tech Stack:** TypeScript, `node:test` via `tsx --test --test-force-exit` (Windows). No new dependencies.

---

## Platform / worktree notes (read first)

- Work in worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-8-lid` on branch `feat/c55.8-convergence-lid`. Never edit the main checkout.
- Windows shell: **PowerShell tool** for npm (`Set-Location` the worktree + `$env:PYTHONIOENCODING='utf-8'` at the start of every call; PS 5.1 has no `&&`). **Bash tool** (Git Bash) for git only, as `git -C "<wt>" …`. Never mix shells in one call.
- Tests: `npm test` = `tsx --test --test-force-exit`. node-pty ConPTY `AttachConsole failed` lines are a display artifact — judge by the runner summary (`pass N / fail 0`) + exit code.
- `node_modules` must be present (junction from the main checkout: `cmd /c mklink /J "<wt>\node_modules" "<main>\node_modules"`).
- End commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push; do NOT run `bd`.

## File Structure

- **Create** `src/actions/inlineExceptions.ts` — the declared-inline catalog (data) + P1/P2 principles in the header. One responsibility: the canonical record of what is deliberately inline. Lives *with* the registry (the "one umbrella").
- **Create** `tests/test_no_inline_twins.ts` — the guard. One responsibility: assert `server.ts`'s inline route set == the catalog, both directions.
- **NOT modified:** `server.ts` (no route changes; `opts.only` untouched), the registry, any def.

---

### Task 1: The declared-inline catalog

**Files:**
- Create: `src/actions/inlineExceptions.ts`

- [ ] **Step 1: Create the catalog module with the full current inline set**

> The list below was enumerated from the current `server.ts`. It is a STARTING point — Task 2 Step 3 reconciles it against the guard's live scan (the authoritative enumeration) and you fix any drift there. Categories: `exception` (genuine UI/operator plumbing, stays inline by design), `held` (open c55 decision), `future-convergence` (untwinned, slated for a later registry-def batch), `infra` (non-action).

```ts
// src/actions/inlineExceptions.ts
/**
 * The declared-inline catalog — the "one umbrella" completeness record + the no-twin guard's data.
 *
 * SINGLE SOURCE OF TRUTH = the registry (src/actions/) as one catalog. Most capabilities are full
 * ActionDefs (voice|rest|ws). The routes below are the deliberate INLINE exceptions in server.ts,
 * declared here with a reason so the umbrella knows about everything. tests/test_no_inline_twins.ts
 * fails CI if server.ts gains an app.<verb>('/api/…') route NOT listed here: a new route must become a
 * registry def (Janus-aware) or earn a documented entry — drift becomes a build failure, not a silent
 * divergence. See docs/superpowers/specs/2026-06-05-c55-8-convergence-terminal-state-design.md.
 *
 * GOVERNING PRINCIPLES (canonical statement):
 *  P1 Commandability broad / proactivity tight — two INDEPENDENT dials. `surfaces:['voice',…]` makes an
 *     action COMMANDABLE; the gate matrix (Auto/Ask/Off) ALONE governs what Janus does UNPROMPTED.
 *     Surface almost everything to voice; keep proactivity tightly gated. Voice parity costs no autonomy.
 *  P2 Gating taxonomy — orchestration plumbing (navigate/arrange/manage/drafts/resize/status reads) is
 *     UNGATED ("Janus doing the work of Janus"); reading terminal RESULTS is GATED (privacy of sensitive
 *     output + protecting the context window); consequential CLI acts + safety changes are GATED.
 */
export type InlineCategory = "exception" | "held" | "future-convergence" | "infra";

export interface InlineException {
  readonly method: "get" | "post" | "put" | "delete" | "use";
  readonly path: string;
  readonly category: InlineCategory;
  readonly reason: string;
}

export const INLINE_EXCEPTIONS: readonly InlineException[] = [
  // ── infra (non-action) ──
  { method: "use", path: "/api", category: "infra", reason: "shared director-token auth middleware mount" },
  { method: "get", path: "*", category: "infra", reason: "SPA catch-all — serves index.html for client routes" },
  // ── exception: drafts (operator hand-rail; ungated plumbing per P2; voice uses propose_command) ──
  { method: "get", path: "/api/panes/:projectId/:paneId/draft", category: "exception", reason: "draft buffer read on pane-switch; operator hand-rail" },
  { method: "put", path: "/api/panes/:projectId/:paneId/draft", category: "exception", reason: "draft buffer persist (WS draft_edit primary; REST fallback)" },
  { method: "get", path: "/api/projects/:projectId/drafts", category: "exception", reason: "WIP draft list indicator; operator hand-rail" },
  { method: "post", path: "/api/panes/:projectId/:paneId/draft/send", category: "exception", reason: "operator sends own draft; above-the-gate by design" },
  // ── exception: settings (config; client reads structured body; separate track) ──
  { method: "get", path: "/api/settings", category: "exception", reason: "settings read on load; structured body; settings->WS rewrite is a follow-up" },
  { method: "put", path: "/api/settings", category: "exception", reason: "settings write; client reads {settings,globalPermissionsMode}; follow-up to converge" },
  // ── exception: raw keystrokes (multi-cli; gated inline via write_to_pane) ──
  { method: "post", path: "/api/terminals/:id/raw-input", category: "exception", reason: "multi-cli raw-keystroke path; bifurcated gate inline; future converge" },
  // ── held (open c55 decisions) ──
  { method: "post", path: "/api/projects", category: "held", reason: "create_project: inline does a post-create rename (2nd mutation) the def lacks — held" },
  { method: "put", path: "/api/projects/:projectId/panes/:paneId/capability-gates", category: "held", reason: "BULK gate map-write; set_capability_gate def is single-entry tighten-only — needs new set_pane_gates (held)" },
  { method: "post", path: "/api/plans/:id/execute", category: "held", reason: "execute_plan: registry handler's dispatchProposal is a refusing stub on REST — needs a REST pane-write seam (c55.9)" },
  { method: "post", path: "/api/attention/clear", category: "held", reason: "thin shim delegating to runAction('dismiss_attention',{}) — path-alias pending multi-path rest binding" },
  // ── future-convergence: notes ──
  { method: "post", path: "/api/projects/:id/notes", category: "future-convergence", reason: "project notes add — future registry def (notes batch)" },
  { method: "get", path: "/api/projects/:id/notes", category: "future-convergence", reason: "project notes read — future registry def" },
  { method: "put", path: "/api/notes/:id", category: "future-convergence", reason: "note edit — future registry def" },
  { method: "delete", path: "/api/notes/:id", category: "future-convergence", reason: "note delete — future registry def" },
  { method: "post", path: "/api/projects/:projectId/panes/:paneId/notes", category: "future-convergence", reason: "pane notes add — future registry def" },
  { method: "post", path: "/api/projects/:projectId/panes/:paneId/context", category: "future-convergence", reason: "add model context to pane — future registry def" },
  // ── future-convergence: project/pane lifecycle ──
  { method: "put", path: "/api/projects/:id", category: "future-convergence", reason: "project update — future registry def" },
  { method: "delete", path: "/api/projects/:id", category: "future-convergence", reason: "project delete — future registry def" },
  { method: "delete", path: "/api/projects/:projectId/panes/:paneId", category: "future-convergence", reason: "pane delete — future registry def" },
  { method: "post", path: "/api/projects/:projectId/panes/:paneId/stop", category: "future-convergence", reason: "non-destructive pane stop — future registry def" },
  // ── future-convergence: archive ──
  { method: "get", path: "/api/archive", category: "future-convergence", reason: "archive list read — future rest-only def" },
  { method: "post", path: "/api/archive/:paneId/restore", category: "future-convergence", reason: "restore archived pane — future registry def" },
  { method: "delete", path: "/api/archive/:paneId", category: "future-convergence", reason: "delete archived pane — future registry def" },
  // ── future-convergence: reads (ledger/attention/plans/recipes) ──
  { method: "get", path: "/api/ledger", category: "future-convergence", reason: "full ledger read — future rest-only def (structured body)" },
  { method: "get", path: "/api/attention", category: "future-convergence", reason: "attention queue read — future rest-only def" },
  { method: "get", path: "/api/plans", category: "future-convergence", reason: "plans board read — future rest-only def" },
  { method: "get", path: "/api/recipes", category: "future-convergence", reason: "recipes list read — future rest-only def" },
  // ── future-convergence: approvals / pending (HiTL) ──
  { method: "get", path: "/api/commands/pending", category: "future-convergence", reason: "pending commands read — future rest-only def" },
  { method: "get", path: "/api/actions/pending", category: "future-convergence", reason: "pending actions read — future rest-only def" },
  { method: "post", path: "/api/actions/:id/confirm", category: "future-convergence", reason: "confirm a deferred action (HiTL) — future registry def" },
  { method: "post", path: "/api/actions/:id/cancel", category: "future-convergence", reason: "cancel a deferred action — future registry def" },
  { method: "post", path: "/api/commands/approve", category: "future-convergence", reason: "approve a proposed command (HiTL) — future registry def" },
];
```

- [ ] **Step 2: Lint to confirm it compiles**

PowerShell: `Set-Location "C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-8-lid"; $env:PYTHONIOENCODING='utf-8'; npm run lint`
Expected: `LINT_EXIT=0`.

- [ ] **Step 3: Commit**

Bash: `git -C "C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-8-lid" add src/actions/inlineExceptions.ts && git -C "…" commit -m "feat(c55.8): declared-inline catalog + governing principles"` (with the co-author trailer).

---

### Task 2: The no-twin guard test

**Files:**
- Create: `tests/test_no_inline_twins.ts`

- [ ] **Step 1: Write the guard test**

```ts
// tests/test_no_inline_twins.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { INLINE_EXCEPTIONS } from "../src/actions/inlineExceptions";

// Same server.ts-as-text pattern the c55 batch cutover guards use (tests/test_c55_batch_a.ts).
const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

// Match every Express registration with a STRING path literal:
//   app.get('/api/x', …)  app.post("/api/y/:id", …)  app.use('/api', …)  app.get('*', …)
// app.use(express.json()), app.use(fn), app.use(vite.middlewares), app.use(express.static(…)) have NO
// string path → not matched → not required in the catalog (they are not addressable routes).
const ROUTE_RE = /\bapp\.(get|post|put|delete|use)\(\s*(['"`])([^'"`]+)\2/g;

function scanInlineRoutes(src: string): Set<string> {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = ROUTE_RE.exec(src)) !== null) found.add(`${m[1]} ${m[3]}`);
  return found;
}

const actual = scanInlineRoutes(serverSrc);
const declared = new Set(INLINE_EXCEPTIONS.map((e) => `${e.method} ${e.path}`));

describe("no-twin guard — server.ts inline routes are fully declared in inlineExceptions", () => {
  it("has NO UNDECLARED inline route (a new route must be a registry def OR a documented exception)", () => {
    const undeclared = [...actual].filter((r) => !declared.has(r)).sort();
    assert.deepStrictEqual(
      undeclared, [],
      `Undeclared inline app.* route(s) in server.ts. Convert to a registry def, or add a documented ` +
      `entry to src/actions/inlineExceptions.ts:\n  ${undeclared.join("\n  ")}`,
    );
  });

  it("has NO STALE catalog entry (every declared exception still exists in server.ts)", () => {
    const stale = [...declared].filter((r) => !actual.has(r)).sort();
    assert.deepStrictEqual(
      stale, [],
      `Stale entry(ies) in src/actions/inlineExceptions.ts (route removed from server.ts — delete them):` +
      `\n  ${stale.join("\n  ")}`,
    );
  });
});
```

- [ ] **Step 2: Run the guard — it is the authoritative enumeration**

PowerShell: `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npx tsx --test --test-force-exit tests/test_no_inline_twins.ts`
Expected: ideally PASS. If FAIL, the assertion message lists exactly which routes are **undeclared** (in `server.ts`, missing from the catalog) or **stale** (in the catalog, gone from `server.ts`).

- [ ] **Step 3: Reconcile the catalog against the live scan**

For every route the guard reports **undeclared**, add an `InlineException` entry to `src/actions/inlineExceptions.ts` with the correct `method`/`path` and a category + reason (use the nearest comment block in `server.ts` to write an honest reason; pick `future-convergence` if it is an untwinned operator route, `held` if it shadows a known-deferred def, `exception` if it is permanent UI plumbing, `infra` if non-action). For every **stale** entry, delete it. Re-run Step 2 until **PASS**.

- [ ] **Step 4: Negative check — prove the lid bites**

Temporarily add `  app.get('/api/_guardcheck', (_req, res) => res.json({}));` near the other routes in `server.ts`. Run Step 2 → expect FAIL listing `get /api/_guardcheck` as undeclared. Remove the temporary line. Run Step 2 → expect PASS. (Do NOT commit the temporary line.)

- [ ] **Step 5: Commit**

Bash: `git -C "<wt>" add tests/test_no_inline_twins.ts src/actions/inlineExceptions.ts && git -C "…" commit -m "test(c55.8): no-twin guard — server.ts inline routes must be declared"` (co-author trailer). Confirm `git -C "<wt>" status --short` is clean (the temp line from Step 4 is gone).

---

### Task 3: Full-battery verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full battery**

PowerShell (one call): `Set-Location "<wt>"; $env:PYTHONIOENCODING='utf-8'; npm run lint; npm test; npm run build`
Expected: lint exit 0; unit suite `fail 0` exit 0 (the new guard suite is included); build exit 0. (No e2e needed — this batch adds no runtime behavior. Run `npm run test:e2e` only if you want the regression signal.)

- [ ] **Step 2: Confirm no production code changed**

Bash: `git -C "<wt>" diff --name-only origin/main..HEAD` → expect ONLY `src/actions/inlineExceptions.ts`, `tests/test_no_inline_twins.ts`, and the spec/plan docs. `server.ts` must NOT appear. If it does, you changed a route — revert that; this batch is the lid only.

---

## Self-Review

- **Spec coverage:** §4.1 catalog → Task 1. §4.3 guard → Task 2. §6 testing (incl. the negative "lid bites" check) → Task 2 Step 4 + Task 3. §4.2 "drop opts.only" → **intentionally deferred** per the re-scope (blocked by held `set_capability_gate` collision); tracked as a follow-up bead, not in this plan.
- **Placeholder scan:** none — the catalog and guard are provided in full; Task 2 Step 3 is a concrete reconcile loop driven by the guard's own output, not a "TODO".
- **Type consistency:** `INLINE_EXCEPTIONS` / `InlineException` (`method`,`path`,`category`,`reason`) are referenced identically in Task 1 and Task 2; the guard key is `` `${method} ${path}` `` in both the catalog projection and the scan.

## Out of scope (tracked as separate beads — the convergence program)
Dropping `opts.only`; resolving held collisions (`set_capability_gate` bulk → `set_pane_gates`, `create_project` 2nd mutation, `execute_plan` seam); converging the untwinned families (notes, archive, approvals/pending, project-CRUD, read endpoints) into registry defs. Each is its own batch with HTTP-level contract tests, mirroring c55 A–G.
