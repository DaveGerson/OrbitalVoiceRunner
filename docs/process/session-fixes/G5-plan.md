# G5 — `create_project` stores an unvalidated directory (voice + REST)

**Bead:** `wsm-e2e-pinned-7lu`
**Priority:** P3 · **Type:** bug · **Kind:** backend · **Files:** `server.ts` (+ one new pure module + one new test)

---

## BLUF

`create_project` has **two** unvalidated write paths — the voice tool handler and
`POST /api/projects` — that both store a model-/client-supplied `directory` verbatim into the
ledger. A bad path (typo, hallucinated folder, stale absolute path) gets persisted as the
project's `directory`, then later flows into `addTerminal(...)` as a child pane's `cwd` and
**ConPTY/node-pty throws** (`ERROR_DIRECTORY` / code 267, "The system cannot find the path
specified."). The fix extracts the existing REST-terminal validator into one pure
`resolveProjectDir(raw)` helper, then routes **both** project-create paths through it so the
**resolved, existence-checked** directory is what we store.

---

## 1. Problem & root cause (code-anchored)

### 1a. The two unvalidated write paths

**Voice handler** — `server.ts:2138-2144`:

```ts
} else if (name === "create_project") {
  const { project_id, directory, summary, key_terms } = args;
  manager.ledger.addProject(project_id, directory || ".", summary || "", key_terms || []);
  broadcastLedgerUpdate();
  session.sendToolResponse({
    functionResponses: [{ name, id: call.id, response: { output: `Project context ${project_id} created successfully.` } }]
  });
}
```

`directory` comes straight from the Gemini tool-call `args` (schema at `server.ts:2877-2890`,
where `directory` is an optional free-text `STRING`, not in `required`). It is stored with **no
existence check** — `directory || "."` only guards against empty/undefined, not against a
non-existent path.

**REST handler** — `POST /api/projects`, `server.ts:848-857`:

```ts
app.post("/api/projects", (req, res) => {
  const { id, directory, summary, keyTerms, name } = req.body;
  const terms = Array.isArray(keyTerms) ? keyTerms : [];
  manager.ledger.addProject(id, directory || ".", summary || "", terms);
  if (name) {
    manager.ledger.renameProject(id, name);
  }
  broadcastLedgerUpdate();
  res.json({ success: true });
});
```

Same `directory || "."` pattern, same lack of validation. This is the **second hole** the
dossier flags.

### 1b. Why a bad stored dir is harmful (the taint path)

`addProject` simply persists whatever it's handed — it does **not** validate. Both backends:

- Legacy `Ledger.addProject` — `src/ledger.ts:163-176`: `this.workspaces[id] = { ... directory, ... }`.
- `JanusStore.addProject` — `src/store/sqliteStore.ts:644-649`: `saveWorkspace({ ... directory, ... })`.

Both are **idempotent** (no-op if the id already exists: `ledger.ts:164` `if (!this.workspaces[id])`;
`sqliteStore.ts:646` `if (exists) return;`). That matters for the test design (a second create
with a good dir will **not** repair a previously-stored bad dir).

The stored `directory` then becomes a pane `cwd`:

- Voice `create_pane` — `server.ts:2151-2159`: `manager.addTerminal(pane_id, manager.ledger.workspaces[project_id]?.directory || process.cwd(), ...)`.
- REST `POST /api/terminals/:id/restart` (restore branch) — `server.ts:784`: `manager.addTerminal(id, activeProject!.directory || process.cwd(), ...)`.

A bad `directory` reaches `addTerminal` → the PTY spawn. The repo already documents this exact
failure in two places:
- `server.ts:734-736` comment: *"Passing a bad path to spawn() is what produced the cryptic 'The system cannot find the path specified.'"*
- `tests/test_journeys.ts:46-49` comment: *"cwd must be a real directory — node-pty validates it and throws (Windows ERROR_DIRECTORY / code 267) on a bogus path."*

### 1c. The validator that already exists (and the model to mirror)

`POST /api/terminals` already does the right thing — `server.ts:734-745`:

```ts
// Resolve the working directory: an empty, "." , or non-existent cwd falls back
// to the active project's directory (or the server cwd). Passing a bad path to
// spawn() is what produced the cryptic "The system cannot find the path specified."
const activeProj = manager.ledger.getActiveProject();
let resolvedCwd = (cwd && cwd.trim() && cwd.trim() !== ".") ? cwd.trim() : (activeProj?.directory || process.cwd());
try {
  if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
    resolvedCwd = activeProj?.directory || process.cwd();
  }
} catch {
  resolvedCwd = process.cwd();
}
```

> Note: the dossier cites `server.ts:739-745` for the validator — that range is only the inner
> `try` block. The **full** resolve logic is `server.ts:734-745` (the `activeProj` lookup +
> ternary + try). Mirror the whole shape.

`fs` is already imported at `server.ts:3` (`import fs from "fs";`). No new import needed in
`server.ts`.

### Root cause (one line)

Both `create_project` paths trust a caller-supplied `directory` and persist it without the
existence/`isDirectory` check that the terminal-create path already performs — so a bad dir is
stored and later taints every child pane's `cwd`.

---

## 2. The exact changes (file : location : change)

### Change A — new pure module `src/projectDir.ts` (NEW FILE)

Extract the resolve logic into a single testable function. This mirrors the established
single-purpose pure-module convention (`src/activePane.ts`, `src/pendingActions.ts`) so it can
be unit-tested by importing from `../src/projectDir` — `server.ts` currently exports nothing, so
the logic **cannot** be tested in place.

```ts
// src/projectDir.ts
import fs from "fs";

/**
 * Resolve a caller-supplied project directory to a REAL, existing directory.
 *
 * Mirrors the POST /api/terminals cwd validator (server.ts) so the voice + REST
 * create_project paths can no longer persist a bogus dir that later taints a child
 * pane's cwd (node-pty throws ERROR_DIRECTORY / code 267 on a bad path).
 *
 * Resolution order:
 *   1. blank / "." / undefined            -> `fallback` (default process.cwd())
 *   2. a path that exists AND isDirectory -> the trimmed path (resolved to absolute)
 *   3. anything else (missing / a file)   -> `fallback`
 *
 * Note: "." is treated as "use the fallback" (the real cwd), NOT dropped — we keep
 * valid orientation intent instead of throwing it away.
 */
export function resolveProjectDir(raw: unknown, fallback: string = process.cwd()): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || trimmed === ".") return fallback;
  try {
    if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
      return trimmed;
    }
  } catch {
    /* fall through to fallback */
  }
  return fallback;
}

/** True iff `raw` is a non-blank, non-"." path that does NOT resolve to a real directory. */
export function isBadProjectDir(raw: unknown): boolean {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || trimmed === ".") return false;
  try {
    return !(fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory());
  } catch {
    return true;
  }
}
```

> `isBadProjectDir` is the predicate the handlers use to decide whether to **reject** (return a
> clear error) vs. silently resolve. The dossier's acceptance criterion is *"bad dir rejected
> with a clear error"* — so a **non-blank** path that doesn't exist is an error, while blank/"."
> resolves quietly to the fallback (preserving valid intent). This split keeps the two
> behaviours MECE.

### Change B — import the helper in `server.ts`

`server.ts:40` (after the existing `import type { GateValue, CapabilityGate } from "./src/types";`):

```ts
import { resolveProjectDir, isBadProjectDir } from "./src/projectDir";
```

### Change C — gate + resolve the REST path `POST /api/projects`

`server.ts:848-857` — replace the body:

```ts
app.post("/api/projects", (req, res) => {
  const { id, directory, summary, keyTerms, name } = req.body;
  if (!id) {
    res.status(400).json({ error: "Missing required field: id" });
    return;
  }
  if (isBadProjectDir(directory)) {
    res.status(400).json({ error: `Project directory does not exist: ${String(directory).trim()}` });
    return;
  }
  const terms = Array.isArray(keyTerms) ? keyTerms : [];
  manager.ledger.addProject(id, resolveProjectDir(directory), summary || "", terms);
  if (name) {
    manager.ledger.renameProject(id, name);
  }
  broadcastLedgerUpdate();
  res.json({ success: true });
});
```

> The `if (!id)` guard is added per the dossier ("also gate `POST /api/projects`"): an
> id-less create silently stored a `""`-keyed workspace before. It is in scope but secondary;
> the load-bearing change is `isBadProjectDir` + `resolveProjectDir`.

### Change D — gate + resolve the voice path `create_project`

`server.ts:2138-2144` — replace the branch body:

```ts
} else if (name === "create_project") {
  const { project_id, directory, summary, key_terms } = args;
  if (isBadProjectDir(directory)) {
    session.sendToolResponse({
      functionResponses: [{ name, id: call.id, response: {
        output: `Error: the directory '${String(directory).trim()}' does not exist, so I did not create project ${project_id}. Give me a folder that exists, or omit it to use the current workspace.`
      } }]
    });
  } else {
    manager.ledger.addProject(project_id, resolveProjectDir(directory), summary || "", key_terms || []);
    broadcastLedgerUpdate();
    session.sendToolResponse({
      functionResponses: [{ name, id: call.id, response: { output: `Project context ${project_id} created successfully.` } }]
    });
  }
}
```

> Voice rejection returns a **spoken-friendly** tool response (not an HTTP error) — the model
> hears it and can re-prompt the operator. This matches the existing voice error style at
> `server.ts:2166` / `2188` (`Error: the '…' capability is gated Off …`).

**Out of scope (do NOT touch):** the capability-gate disposition for `create_project` stays
`Auto` (`src/types.ts:45`). G5 is a validation bug, not a gating-policy change. Existence
validation is orthogonal to Auto/Ask/Off and runs regardless of gate state.

---

## 3. Test-first plan (TDD, aligned to repo runners)

Runner: `npm test` → `tsx --test --test-force-exit tests/*.ts` (`package.json:13`). New test
files matching `tests/*.ts` are auto-discovered. Style: `node:test` `describe`/`it` +
`node:assert`, importing the unit under test from `../src/...` (pattern: `tests/test_active_pane.ts`,
`tests/test_server.ts:4`).

### 3a. The FIRST failing test (write this first, watch it fail to compile/import)

**File:** `tests/test_project_dir.ts` (NEW)

The very first test asserts the **rejection** behaviour that does not exist yet — and because
`src/projectDir.ts` does not exist, the import fails first (red by missing module), then by
missing logic once the file is stubbed empty.

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveProjectDir, isBadProjectDir } from "../src/projectDir";

describe("G5 — resolveProjectDir / isBadProjectDir", () => {
  // A path we are confident does NOT exist on any runner (Win + POSIX).
  const BOGUS = path.join(os.tmpdir(), "janus_g5_does_not_exist_" + Date.now());

  it("flags a non-existent, non-blank dir as bad (THE failing test first)", () => {
    assert.strictEqual(fs.existsSync(BOGUS), false, "precondition: bogus path must be absent");
    assert.strictEqual(isBadProjectDir(BOGUS), true);
  });

  it("resolves a bad dir to the fallback instead of storing it", () => {
    assert.strictEqual(resolveProjectDir(BOGUS, process.cwd()), process.cwd());
  });

  it("treats '.' as 'use the fallback' (valid intent, not bad)", () => {
    assert.strictEqual(isBadProjectDir("."), false);
    assert.strictEqual(resolveProjectDir(".", process.cwd()), process.cwd());
  });

  it("treats blank / undefined as the fallback (not bad)", () => {
    assert.strictEqual(isBadProjectDir(""), false);
    assert.strictEqual(isBadProjectDir(undefined), false);
    assert.strictEqual(resolveProjectDir("", "/tmp/x"), "/tmp/x");
    assert.strictEqual(resolveProjectDir(undefined, "/tmp/x"), "/tmp/x");
  });

  it("keeps a real, existing directory verbatim (trimmed)", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "janus_g5_real_"));
    try {
      assert.strictEqual(isBadProjectDir(real), false);
      assert.strictEqual(resolveProjectDir("  " + real + "  "), real); // trims
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it("flags a path that exists but is a FILE (not a directory) as bad", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "janus_g5_f_")), "afile.txt");
    fs.writeFileSync(f, "x");
    try {
      assert.strictEqual(isBadProjectDir(f), true);
      assert.strictEqual(resolveProjectDir(f, process.cwd()), process.cwd());
    } finally {
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    }
  });
});
```

**Run-to-red:** `npm test` (or scoped: `npx tsx --test --test-force-exit tests/test_project_dir.ts`)
→ fails because `../src/projectDir` does not exist. Then create the module (Change A) →
green. This is the failing-test-first gate.

### 3b. Integration assertion — both create paths reject a bad dir via the ledger

Add to the SAME new file (keeps G5 self-contained) a block that exercises the **handler logic
through the ledger**, since `server.ts` is not importable. We validate the *contract the handlers
must honour*: "a bad dir is never persisted; a good/blank dir is."

```ts
import { OrchestratorManager } from "../src/terminal";

describe("G5 — create_project never persists a bad dir (handler contract)", () => {
  const BOGUS = path.join(os.tmpdir(), "janus_g5_handler_absent_" + Date.now());

  // Mirror the handler decision the server now makes (Changes C & D):
  //   if (isBadProjectDir(dir)) -> reject, do NOT addProject
  //   else                      -> addProject(id, resolveProjectDir(dir), ...)
  function simulateCreateProject(mgr: OrchestratorManager, id: string, dir: unknown): boolean {
    if (isBadProjectDir(dir)) return false;            // rejected, nothing stored
    mgr.ledger.addProject(id, resolveProjectDir(dir), "", []);
    return true;
  }

  it("rejects a bad dir on the voice/REST contract — nothing is stored", () => {
    const mgr = new OrchestratorManager();
    const ok = simulateCreateProject(mgr, "proj_bad", BOGUS);
    assert.strictEqual(ok, false);
    assert.strictEqual(mgr.ledger.getProject("proj_bad"), null);
  });

  it("stores the RESOLVED (not raw) dir for a blank/'.' create", () => {
    const mgr = new OrchestratorManager();
    simulateCreateProject(mgr, "proj_dot", ".");
    const ws = mgr.ledger.getProject("proj_dot");
    assert.ok(ws);
    assert.strictEqual(ws!.directory, process.cwd());   // resolved, never the literal "."
  });
});
```

> `simulateCreateProject` is **the exact branch logic** Changes C/D introduce; it is the
> contract under test. (Full HTTP/WS round-trip coverage is a follow-up E2E, see §6 Risks — it
> is not required to land G5 and the dossier scopes the test to "unit + integration both create
> paths reject a bad dir.")

### 3c. Key assertions (the load-bearing ones)

1. `isBadProjectDir(<absent path>) === true` — the missing case that drives the whole fix.
2. `isBadProjectDir(".") === false` **and** `resolveProjectDir(".") === process.cwd()` — "." is
   preserved as valid intent, **not** rejected and **not** stored literally.
3. `isBadProjectDir("") === false` / `isBadProjectDir(undefined) === false` — blank is fine.
4. `isBadProjectDir(<existing file>) === true` — exists-but-not-a-directory is rejected (the
   `isDirectory()` half of the check, not just `existsSync`).
5. `resolveProjectDir(<real dir, padded>) === <real dir>` — trims, keeps a good path verbatim.
6. Handler contract: a bad dir ⇒ `getProject(id) === null` (idempotency means a later good
   create cannot silently repair it, so rejecting up front is the only correct behaviour).

---

## 4. Verify commands

```bash
# from the feature worktree: C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes
npx tsx --test --test-force-exit tests/test_project_dir.ts   # the new G5 suite (red, then green)
npm test                                                     # full unit suite — no regressions
npm run lint                                                 # tsc --noEmit (server.ts + new module typecheck)
npm run build                                                # vite + esbuild — server.ts still bundles
```

Optional sanity (no behavioural assertion, just confirms the touched paths still parse under the
existing journeys that use `addProject` with "." dirs):

```bash
npx tsx --test --test-force-exit tests/test_journeys.ts
```

---

## 5. Acceptance criteria

- [ ] `src/projectDir.ts` exists with `resolveProjectDir` + `isBadProjectDir`, mirroring the
      `server.ts:734-745` validator semantics (exists **and** `isDirectory`; "." / blank →
      fallback; never throws).
- [ ] **Both** create paths route through it:
      - Voice `create_project` (`server.ts:2138-2144`) rejects a bad dir with a spoken error and
        stores `resolveProjectDir(directory)` otherwise.
      - `POST /api/projects` (`server.ts:848-857`) returns `400` on a bad dir (and on missing
        `id`) and stores `resolveProjectDir(directory)` otherwise.
- [ ] A non-blank dir that does not exist (or is a file) is **rejected with a clear error**; it
      is never persisted to the ledger.
- [ ] A blank/"." dir resolves to `process.cwd()` (valid intent preserved, not dropped, not
      stored literally).
- [ ] `tests/test_project_dir.ts` is green; first commit shows it failing before `src/projectDir.ts`
      exists (TDD red→green).
- [ ] `npm test`, `npm run lint`, `npm run build` all green; no existing test regressed.
- [ ] `create_project` gate stays `Auto` (`src/types.ts:45`) — unchanged.

---

## 6. Risks & notes

- **`server.ts` is not importable** (exports nothing) → the handler bodies themselves are not
  directly unit-tested; we test (a) the pure helper and (b) a faithful re-implementation of the
  handler branch (`simulateCreateProject`). **Mitigation:** keep the helper as the single source
  of truth so the handler is a thin `if (isBadProjectDir) reject; else addProject(resolve)`.
  A future full round-trip E2E (boot server, `POST /api/projects` with a bogus dir, assert
  `400` + ledger empty) is a **follow-up bead**, not a blocker for G5.
- **Idempotency of `addProject`** (`ledger.ts:164`, `sqliteStore.ts:646`): a project created with
  a bad dir that *slipped through* could never be repaired by a second create — which is exactly
  why validation must happen **before** the store call, not after. The tests pin this (§3b first
  case).
- **TOCTOU**: `existsSync`+`statSync` is a check-then-use; the dir could vanish between validation
  and a later pane spawn. This is **pre-existing** behaviour (the `POST /api/terminals` validator
  has the same shape) and out of scope — node-pty still guards the actual spawn. We are closing
  the *"store a knowingly-bad dir"* hole, not promising spawn-time guarantees.
- **Windows path semantics**: `resolveProjectDir` keeps the trimmed string as-is (no
  `path.resolve` normalization) to exactly match the existing `server.ts:738` behaviour and avoid
  changing how absolute Windows paths are stored. Tests use `os.tmpdir()` + `fs.mkdtempSync` so
  they pass on both ConPTY/Windows and POSIX CI.
- **U2 / push-observation parity**: the `feat/p0b-matrix-live-harness` worktree carries the
  identical unvalidated `create_project` block (`.claude/worktrees/push-observation/server.ts:2404-2410`).
  G5 lands only on `feat/session-fixes`; when U2 merges, the same fix must be re-applied or the
  hole returns. Flag in the PR description (do not edit the U2 worktree — read-only).
- **Scope discipline**: the `if (!id)` guard on `POST /api/projects` is a small bonus hardening
  bundled here because it's the same handler; if review prefers a tighter diff, it can split to
  its own bead. The directory validation is the load-bearing G5 change.
