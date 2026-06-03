# G4 — Regression coverage for the launch-string builder

**Bead:** `wsm-e2e-pinned-2tl` · **Priority:** P3 · **Type:** task · **Kind:** backend
**Branch:** `feat/session-fixes` (worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes`)

---

## BLUF

BUG-032 (the agent-launch string that shipped invented flags, a bad `--resume`, and an `npx` prefix) was **already fixed on `main`**, but it has **zero regression coverage** — the fix lives inline inside `UniversalTerminal.start()` and `UniversalTerminal` constructor, both of which spawn a real PTY, so nothing pins the launch-string contract today. This task extracts a **pure** `buildLaunchCommand(shellCmd, toolPreset, sessionId)` from the resume-flag logic in `start()` (`src/terminal.ts:486-496`), rewires `start()` to call it (behavior **unchanged**), and pins all three BUG-032 failure modes in a new `tests/test_launch_command.ts`. This is a **characterization-test + safe-refactor** task, not a behavior change.

---

## 1. Problem & root cause (code-anchored)

### 1.1 The fix exists but is untested

The BUG-032 regression surface is the command string Janus hands to the PTY when it spawns an agent pane. Three historical failure modes were fixed inline on `main`:

| Failure mode | Where it was fixed | Current correct behavior |
|---|---|---|
| **Invented flags** (`--resume-previous-session`, `--with-open-textbox`) made the CLI exit immediately | `src/components/CreateTerminalDialog.tsx:44-51` (UI base-command builder) | Only real flags are appended; bare `claude` / `codex` / `antigravity` otherwise |
| **`npx <pkg>` prefix** — agent CLIs are global binaries, never `npx` | `src/components/CreateTerminalDialog.tsx:32` (comment-enforced) | Base command is the bare binary name |
| **Bad `--resume`** — `--resume` was appended with a *synthetic* tracking id (e.g. `claude-code-session-3f9a1c2b`), which the CLI rejects because it requires a real UUID | `src/terminal.ts:486-496` (the `start()` resume guard) | `--resume <id>` appended **only** when `sessionId` is a real UUID **and** the command does not already carry `--resume`/`--session` |

The server-side guard that this task targets is `UniversalTerminal.start()`:

```ts
// src/terminal.ts:486-496
start() {
  let finalCommand = this.shellCmd;
  if (this.toolPreset !== "Custom" && this.sessionId) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const alreadyHasResume = /--resume\b|--session\b/.test(finalCommand);
    // Only resume a genuine prior session: the CLI requires a real UUID. A synthetic
    // tracking id (e.g. "claude-code-session-<hex>") is NOT resumable — launch fresh.
    if (!alreadyHasResume && UUID_RE.test(this.sessionId)) {
      finalCommand = `${finalCommand} --resume ${this.sessionId}`;
    }
  }
  // ... loadScrollback(), childEnv scrub, createPtyTransport(finalCommand, ...) ...
```

**Root cause of the gap:** the resume-guard logic is entangled with PTY-spawning side effects (`loadScrollback()`, env scrubbing, `createPtyTransport(finalCommand, ...)` at `src/terminal.ts:498-518`). There is no seam to assert the resulting command string without booting a process, so the three BUG-032 invariants are silently unprotected. A future edit to the resume guard (or a careless refactor) could reintroduce any of the three failure modes and **no test would fail.**

### 1.2 Why the synthetic id matters (the `--resume` trap)

The constructor mints a synthetic tracking id when no real session is supplied (`src/terminal.ts:276-288`):

```ts
// src/terminal.ts:283-285
const toolLower = toolPreset.toLowerCase().replace(/\s+/g, "-");
const randomId = Math.random().toString(16).substring(2, 10);
this.sessionId = `${toolLower}-session-${randomId}`;   // e.g. "claude-code-session-3f9a1c2b"
```

This id is for **internal tracking/display only** (comment at `src/terminal.ts:279-282`). The `UUID_RE` guard at `start()` is precisely what stops this synthetic id from leaking into a `--resume` flag that the real CLI would reject. That guard is the single most important behavior to pin.

### 1.3 Scope boundary (explicit)

The constructor's `--dangerously-skip-permissions` mutation (`src/terminal.ts:263-273`) and the symmetric `setPermissionsMode()` mutation (`src/terminal.ts:291-303`) are **OUT OF SCOPE**. They are a *separate* concern (permissions-mode → flag), not part of the launch-string/resume builder, and the bead explicitly carves them out. `buildLaunchCommand` takes `shellCmd` **as already-built** (i.e. post-permissions-mutation) and only owns the **resume-flag decision**. Do not fold the permissions mutation into the helper.

---

## 2. The exact change (file : location : change)

### 2.1 `src/terminal.ts` — extract the pure helper

**Location:** add a new module-level exported function. Place it next to the other exported pure helpers (`parsePresetsSafe` / `appendRawCapped` / `stripAnsiSequences` / `redactSecrets` / `classifySecrets`, all at `src/terminal.ts:13-175`) — directly **after** `parsePresetsSafe` ends (around `src/terminal.ts:60`) is the natural home, before `appendRawCapped`.

**Change:** introduce the pure function. Keep the comment intent verbatim so the contract is self-documenting:

```ts
/**
 * Pure launch-string builder (BUG-032 regression surface). Given a fully-built
 * base command (already carrying any --dangerously-skip-permissions mutation from
 * the constructor — that is NOT this function's concern), decide whether to append
 * a `--resume <id>` flag.
 *
 * Invariants (pinned in tests/test_launch_command.ts):
 *  - Custom panes are never touched (no resume flag ever).
 *  - --resume is appended ONLY when sessionId is a real UUID. A synthetic tracking
 *    id (e.g. "claude-code-session-<hex>") is NOT resumable — launch fresh.
 *  - Never double-append: if the command already carries --resume or --session,
 *    leave it alone.
 *  - The base command is returned verbatim otherwise (no invented flags, no npx).
 */
export function buildLaunchCommand(
  shellCmd: string,
  toolPreset: "Claude Code" | "Codex" | "Antigravity" | "Custom",
  sessionId: string
): string {
  let finalCommand = shellCmd;
  if (toolPreset !== "Custom" && sessionId) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const alreadyHasResume = /--resume\b|--session\b/.test(finalCommand);
    if (!alreadyHasResume && UUID_RE.test(sessionId)) {
      finalCommand = `${finalCommand} --resume ${sessionId}`;
    }
  }
  return finalCommand;
}
```

> **Fidelity note:** the `UUID_RE`, the `--resume\b|--session\b` guard, and the template literal must be **byte-identical** to the current inline logic at `src/terminal.ts:489-494`. This is a pure extraction — copy, do not retype from memory.

### 2.2 `src/terminal.ts:486-496` — rewire `start()` to call the helper

**Change:** replace the inline resume block in `start()` with a single delegating call. The post-condition (`finalCommand`) is identical:

```ts
start() {
  const finalCommand = buildLaunchCommand(this.shellCmd, this.toolPreset, this.sessionId);

  // Populate historical output buffer from persistent scrollback log
  this.loadScrollback();
  // ... unchanged below (childEnv scrub, createPtyTransport(finalCommand, ...)) ...
```

- The `let finalCommand = this.shellCmd; if (...) { ... }` block at `src/terminal.ts:487-496` collapses to the one `const finalCommand = buildLaunchCommand(...)` line.
- `this.shellCmd`, `this.toolPreset`, `this.sessionId` are all instance fields already in scope (set in the constructor at `src/terminal.ts:256`, `274`, `277`/`285`/`287`). No signature change to `start()`.
- Everything from `this.loadScrollback()` (`src/terminal.ts:499`) downward is untouched.

### 2.3 `tests/test_launch_command.ts` — new test file

**Change:** create a new file (auto-discovered by the `tests/*.ts` glob in `test:unit`). Import the helper by name from `../src/terminal`, matching the existing pure-helper import convention (cf. `tests/test_redaction.ts:3`, `tests/test_terminal_resize.ts:3`). Full proposed contents in §3.2.

---

## 3. Test-first plan (TDD, aligned to repo runners)

The repo runs unit tests with `node:test` via `tsx --test --test-force-exit tests/*.ts` (see `package.json` `test:unit`). Tests use `describe`/`it` from `node:test` and `assert` from `node:assert` (cf. `tests/test_status_parsers.ts:1-7`, `tests/test_status_machine.ts:1-11`).

### 3.1 The FIRST failing test (write this, watch it fail to compile)

Before touching `src/terminal.ts`, create `tests/test_launch_command.ts` whose very first test imports a symbol that **does not yet exist**:

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildLaunchCommand } from "../src/terminal";

describe("buildLaunchCommand (BUG-032 regression surface)", () => {
  it("appends --resume ONLY for a real UUID session id", () => {
    const uuid = "0f9e8d7c-6b5a-4321-9876-543210fedcba";
    assert.strictEqual(
      buildLaunchCommand("claude", "Claude Code", uuid),
      `claude --resume ${uuid}`
    );
  });
});
```

**Expected first-run failure:** `tsx`/`tsc` resolution fails — `buildLaunchCommand` is not exported from `../src/terminal` (and `npm run lint` errors with TS2305 "Module '../src/terminal' has no exported member 'buildLaunchCommand'"). This is the red state. The extraction in §2.1 turns it green **without changing any production behavior** (the inline logic at `start()` already produces this exact string for a UUID).

Run the single file to watch it fail fast:

```
npx tsx --test --test-force-exit tests/test_launch_command.ts
```

### 3.2 Full assertion set (the 3 BUG-032 modes + guards)

Complete proposed `tests/test_launch_command.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildLaunchCommand } from "../src/terminal";

/**
 * BUG-032 regression pins. The launch string Janus hands the PTY must:
 *   (1) carry NO invented flags / NO npx — bare binary otherwise;
 *   (2) append --resume ONLY for a genuine UUID session id;
 *   (3) NEVER attach --resume to a synthetic "<tool>-session-<hex>" tracking id.
 * The helper owns ONLY the resume-flag decision; the
 * --dangerously-skip-permissions mutation is the constructor's concern (out of scope).
 */
describe("buildLaunchCommand (BUG-032 regression surface)", () => {
  const UUID = "0f9e8d7c-6b5a-4321-9876-543210fedcba";

  // MODE 1 — no invented flags / no npx: bare command returned verbatim.
  it("returns the bare command unchanged when there is no resumable session", () => {
    assert.strictEqual(buildLaunchCommand("claude", "Claude Code", ""), "claude");
    assert.strictEqual(buildLaunchCommand("codex", "Codex", ""), "codex");
    assert.strictEqual(buildLaunchCommand("antigravity", "Antigravity", ""), "antigravity");
  });
  it("never introduces npx or invented flags", () => {
    const out = buildLaunchCommand("claude", "Claude Code", UUID);
    assert.ok(!out.includes("npx"), "must never prefix npx");
    assert.ok(!out.includes("--resume-previous-session"), "no invented resume flag");
    assert.ok(!out.includes("--with-open-textbox"), "no invented textbox flag");
  });

  // MODE 2 — UUID-guarded --resume: appended only with a real UUID.
  it("appends --resume <uuid> for a genuine UUID session id", () => {
    assert.strictEqual(
      buildLaunchCommand("claude", "Claude Code", UUID),
      `claude --resume ${UUID}`
    );
  });
  it("is case-insensitive on the UUID and preserves the id verbatim", () => {
    const upper = UUID.toUpperCase();
    assert.strictEqual(
      buildLaunchCommand("claude", "Claude Code", upper),
      `claude --resume ${upper}`
    );
  });

  // MODE 3 — synthetic tracking id is NOT resumable: never appended.
  it("does NOT append --resume for a synthetic <tool>-session-<hex> id", () => {
    assert.strictEqual(
      buildLaunchCommand("claude", "Claude Code", "claude-code-session-3f9a1c2b"),
      "claude"
    );
  });
  it("does NOT append --resume for a non-UUID free-form id", () => {
    assert.strictEqual(
      buildLaunchCommand("codex", "Codex", "not-a-uuid"),
      "codex"
    );
  });

  // GUARDS — Custom panes & double-append.
  it("never touches a Custom pane, even with a UUID", () => {
    assert.strictEqual(buildLaunchCommand("bash", "Custom", UUID), "bash");
    assert.strictEqual(buildLaunchCommand("cmd.exe", "Custom", ""), "cmd.exe");
  });
  it("does not double-append when --resume is already present", () => {
    const pre = `claude --resume ${UUID}`;
    assert.strictEqual(buildLaunchCommand(pre, "Claude Code", UUID), pre);
  });
  it("does not append when --session is already present", () => {
    const pre = "claude --session abc";
    assert.strictEqual(buildLaunchCommand(pre, "Claude Code", UUID), pre);
  });

  // PRESERVES pre-existing flags (e.g. --dangerously-skip-permissions from the ctor).
  it("preserves a pre-built flag and still appends --resume after it", () => {
    assert.strictEqual(
      buildLaunchCommand("claude --dangerously-skip-permissions", "Claude Code", UUID),
      `claude --dangerously-skip-permissions --resume ${UUID}`
    );
  });
});
```

### 3.3 Key assertions (the load-bearing pins)

1. **UUID → `--resume <uuid>`** appended exactly once, id preserved verbatim (incl. uppercase).
2. **Synthetic id (`claude-code-session-<hex>`) and any non-UUID → NO `--resume`** (the core BUG-032 trap).
3. **Bare binary returned verbatim** when not resumable — no `npx`, no invented flags.
4. **`Custom` preset never gets `--resume`**, even with a real UUID.
5. **No double-append** when the command already carries `--resume` or `--session`.
6. **Pre-built flags survive** (`--dangerously-skip-permissions` stays; `--resume` is appended after it) — proves the helper composes cleanly with the constructor mutation it does not own.

---

## 4. Verify commands

Run from the feature worktree root (`C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes`):

```bash
# Red → green for the new file specifically (fast loop)
npx tsx --test --test-force-exit tests/test_launch_command.ts

# Full unit suite (proves the start() rewire broke nothing — terminal-manager / server tests cover start())
npm test

# Lint — proves the extraction type-checks and start() still compiles
npm run lint
```

All three must be green. `npm test` is the regression net for the `start()` rewire: `tests/test_terminal_manager.ts`, `tests/test_server.ts`, and `tests/test_pane_delta.ts` exercise `OrchestratorManager`/`UniversalTerminal` and would surface any behavior drift in the spawn path.

---

## 5. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Extraction drifts from the inline logic (a retyped regex / template) silently changes behavior | Low–Med | Copy the `UUID_RE`, the `--resume\b|--session\b` guard, and the `${finalCommand} --resume ${sessionId}` literal **byte-for-byte** from `src/terminal.ts:489-494`. `npm test` (start()-exercising suites) is the backstop. |
| Hidden second caller of the inline resume logic | Low | `grep` confirmed the resume guard is referenced only in `start()` (`src/terminal.ts:490,494`) plus the explanatory constructor comment (`:280-282`). No other call site. |
| Test imports a heavy module graph (`../src/terminal` pulls in `ledger`, `ptyTransport`, etc.) and slows/leaks | Low | Same import path already used by `tests/test_redaction.ts` / `tests/test_terminal_resize.ts` with no issue; `--test-force-exit` already handles the PTY-keeps-loop-alive gotcha. |
| Scope creep into the `--dangerously-skip-permissions` constructor mutation | Med (tempting) | Explicitly out of scope (§1.3). The helper takes `shellCmd` post-mutation; the "preserves pre-built flag" test documents the boundary instead of absorbing it. |
| Windows path / shell quoting concerns | None | Helper is pure string logic; no shell, no path, no platform branch. |

---

## 6. Acceptance criteria

- [ ] `buildLaunchCommand(shellCmd, toolPreset, sessionId)` is exported from `src/terminal.ts` as a pure, side-effect-free function (no PTY, no `this`).
- [ ] `UniversalTerminal.start()` delegates to `buildLaunchCommand(...)`; the inline resume block at `src/terminal.ts:487-496` is removed; `finalCommand` is otherwise identical and the rest of `start()` is untouched.
- [ ] **All 3 BUG-032 modes pinned** in `tests/test_launch_command.ts`: (1) bare command / no invented flags / no npx; (2) UUID-guarded `--resume`; (3) synthetic-id → no `--resume`. Plus the Custom-pane and double-append guards.
- [ ] Behavior is **unchanged** — `npm test` (full suite, incl. `start()`-exercising tests) passes.
- [ ] `npm run lint` (`tsc --noEmit`) is green.
- [ ] The constructor `--dangerously-skip-permissions` mutation (`src/terminal.ts:263-273`) is **not** modified.
- [ ] Bead `wsm-e2e-pinned-2tl` closed with the changed files and green gates noted.

---

## Appendix — verified anchors (read at authoring time)

- `src/terminal.ts:486-496` — `start()` inline resume guard (the extraction source). Verified verbatim.
- `src/terminal.ts:263-273` / `291-303` — constructor + `setPermissionsMode` `--dangerously-skip-permissions` mutation (out of scope). Verified.
- `src/terminal.ts:276-288` — synthetic `<tool>-session-<hex>` id minting. Verified.
- `src/terminal.ts:13,70,75,90,175` — existing module-level pure exports (the home/convention for the new helper). Verified.
- `src/components/CreateTerminalDialog.tsx:32,44-57` — UI base-command builder (no `npx`, no invented flags). Verified.
- `tests/test_status_parsers.ts:1-7`, `tests/test_status_machine.ts:1-11` — `node:test` + `node:assert` `describe`/`it` convention. Verified.
- `tests/test_redaction.ts:3`, `tests/test_terminal_resize.ts:3` — import-pure-helper-from-`../src/terminal` convention. Verified.
- `package.json` `test:unit` = `tsx --test --test-force-exit tests/*.ts` (new file auto-discovered). Verified.
