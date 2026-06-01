# Rescue Unmerged Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every piece of unmerged prior-session work onto `main` so the artifacts holding it (`stash@{1}`, `stash@{0}`, `rescue/voice-test-harness`, and eventually `claude/prompt-composer-refactor`) can be safely retired — with zero work lost.

**Architecture:** Three independent rescue tracks, smallest-risk first: (1) the one-line `.gitignore` from `stash@{0}`; (2) the voice-agent test harness from `stash@{1}` — additive files plus a small server.ts testability seam that current main is *already* shaped for; (3) tracking the large push-observation stack on `claude/prompt-composer-refactor` as a deferred follow-up (it is durably backed up on origin, so it is preserved, not at risk — a full rebase-rescue is its own future plan). Each track is a branch → green battery → PR → squash-merge → then drop the source artifact.

**Tech Stack:** TypeScript, node:test (`tsx --test --test-force-exit`), Playwright, git, gh. Work in `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner/.claude/worktrees/wsm-e2e-pinned`.

**Battery (run before every PR):** `npm run lint` (tsc --noEmit, 0 errors) · `npm test` (all pass) · `npm run build` (succeeds). e2e (`npm run test:e2e`) only if UI/server behavior changed. Python (`py -3 -m unittest tests.test_universal_terminal`) only if python touched.

**Verified facts (origin/main = d4f854d, 2026-06-01):**
- `stash@{0}` (95e00c3): only unmerged content is a 3-line `.gitignore` block for `.claude/settings.local.json`. Its `test_journeys.ts` half is ALREADY on main (4e5a442/6012cbd) — do NOT replay it.
- `stash@{1}` (eb89337): net-new files `scripts/simulate-voice.ts`, `tests/helpers/mockLive.ts`, `tests/test_integration.ts`, `tests/test_voice_tools.ts`; a `server.ts` testability seam; `package.json` (`sim`+`test` scripts, `@anthropic-ai/sdk` dep). Its `src/terminal.ts` is the OLD pre-PTY version — EXCLUDE it entirely.
- Current main `server.ts` ALREADY has `async function startServer()` (line ~221), module-level `API_AUTH_TOKEN` (~42), `manager` (~212), `startServer().catch()` autostart (~end), and the live session connect at `sessionAi.live.connect({...})` (~1712). The partial port lives on `rescue/voice-test-harness` (ac6678e): it already exported API_AUTH_TOKEN + manager and checked out the 4 files.

---

## Track A — Rescue the .gitignore line (stash@{0})

### Task A1: Land the `.claude/settings.local.json` ignore rule

**Files:**
- Modify: `.gitignore` (on a fresh branch off origin/main)

- [ ] **Step 1: Branch off latest main**

```bash
cd C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner/.claude/worktrees/wsm-e2e-pinned
git fetch origin --quiet && git switch main && git pull --ff-only origin main
git switch -c rescue/gitignore-local-settings
```

- [ ] **Step 2: Verify the rule is genuinely absent on main, then add it**

```bash
grep -n "settings.local.json" .gitignore && echo "ALREADY PRESENT — skip Track A, drop stash@{0}" || echo "absent, proceed"
```
If absent, append after the existing `dist-tmp/` line:
```
# Claude Code — machine-local settings (plugins, etc.)
.claude/settings.local.json
```

- [ ] **Step 3: Confirm tracked tree otherwise unchanged**

Run: `git diff --stat`
Expected: only `.gitignore` changed, +3 lines.

- [ ] **Step 4: Commit + PR + merge**

```bash
git add .gitignore
git commit -m "chore(gitignore): ignore .claude/settings.local.json (rescue from stash@{0})"
git push -u origin rescue/gitignore-local-settings
gh pr create --base main --title "Rescue: ignore .claude/settings.local.json (stash@{0})" --body "The only unmerged content in stash@{0} (95e00c3). Its test_journeys.ts half is already on main via 4e5a442/6012cbd."
PR=$(gh pr list --head rescue/gitignore-local-settings --json number --jq '.[0].number')
gh pr merge "$PR" --squash --delete-branch
```

- [ ] **Step 5: Drop the now-rescued stash**

```bash
git fetch origin --quiet
git show stash@{0}:.gitignore | grep -q "settings.local.json" && \
  git log origin/main -1 --format='%H' -- .gitignore >/dev/null && \
  grep -q "settings.local.json" <(git show origin/main:.gitignore) && \
  git stash drop stash@{0} || echo "NOT on main yet — do NOT drop"
```
Expected: `Dropped stash@{0}` only after confirming the line is on origin/main.

---

## Track B — Rescue the voice-agent test harness (stash@{1})

> Builds on the partial port already committed to `rescue/voice-test-harness` (ac6678e). The remaining work is the server.ts seam + package.json + getting tests green.

### Task B1: Rebase the partial-port branch onto latest main

**Files:** none (git)

- [ ] **Step 1: Update the rescue branch onto current main**

```bash
git fetch origin --quiet
git switch rescue/voice-test-harness
git rebase origin/main
```
Expected: clean rebase (the 4 added files + the two export-line edits don't collide with main). If conflicts in `server.ts`, keep BOTH main's content and the two added `export` keywords (on `API_AUTH_TOKEN` and `manager`); re-run `git rebase --continue`.

- [ ] **Step 2: Confirm the 4 files + 2 exports are present**

```bash
ls scripts/simulate-voice.ts tests/helpers/mockLive.ts tests/test_integration.ts tests/test_voice_tools.ts
grep -c "export const API_AUTH_TOKEN" server.ts; grep -c "export const manager" server.ts
```
Expected: 4 files exist; both greps return 1.

### Task B2: Add the `liveConnector` injection seam to server.ts

**Files:**
- Modify: `server.ts` (add seam declaration near module top; use it at the `live.connect` call ~1712)

- [ ] **Step 1: Add the seam declaration**

Immediately BEFORE `async function startServer()` (~line 221), add:
```ts
// Test seam: the voice session is created through this indirection so integration
// tests can inject a mock Gemini Live connector (see tests/helpers/mockLive.ts).
// Production default calls the real SDK.
export type LiveConnector = (ai: GoogleGenAI, params: any) => Promise<any>;
let liveConnector: LiveConnector = (ai, params) => ai.live.connect(params);
export function setLiveConnector(fn: LiveConnector) { liveConnector = fn; }
```

- [ ] **Step 2: Route the real connect through the seam**

At `~line 1712`, replace:
```ts
      session = await sessionAi.live.connect({
```
with:
```ts
      session = await liveConnector(sessionAi, {
```
(Leave the params object and the rest of the call unchanged.)

- [ ] **Step 3: Verify it still typechecks**

Run: `npm run lint`
Expected: 0 errors. (If `GoogleGenAI` type isn't in scope at the seam location, it is already imported at server.ts:5 — confirm.)

### Task B3: Make `startServer` lifecycle-controllable (options + RunningServer return + autostart guard)

**Files:**
- Modify: `server.ts` (startServer signature ~221, listen block ~end, autostart line ~end)

The tests call `startServer({ port: 0, enableVite: false })` and use `{ port, manager, close() }`.

- [ ] **Step 1: Add the option/return types before `startServer`**

```ts
export interface StartServerOptions { port?: number; enableVite?: boolean; }
export interface RunningServer {
  app: import("express").Express;
  server: import("http").Server;
  wss: import("ws").WebSocketServer;
  manager: typeof manager;
  port: number;
  close: () => Promise<void>;
}
```

- [ ] **Step 2: Change the signature**

Replace `async function startServer() {` with:
```ts
async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
```

- [ ] **Step 3: Honor `enableVite` (guard the Vite dev-middleware block)**

Find the Vite setup inside startServer (search `createViteServer`). Wrap it:
```ts
  if (options.enableVite !== false) {
    // ...existing Vite middleware setup unchanged...
  }
```
Rationale: tests pass `enableVite:false` to skip Vite (no UI build needed for API/WS tests).

- [ ] **Step 4: Bind to the requested port and resolve the real port + return RunningServer**

Replace the listen block at the end of startServer:
```ts
  const bindHost = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  server.listen(PORT, bindHost, () => {
    console.log(`Server running on http://${bindHost}:${PORT}`);
  });
}
```
with:
```ts
  const bindHost = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  const listenPort = options.port ?? PORT;   // port:0 = OS-assigned ephemeral (tests)
  await new Promise<void>((resolve) => server.listen(listenPort, bindHost, () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : listenPort;
  if (options.port === undefined) console.log(`Server running on http://${bindHost}:${port}`);

  const close = async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { app, server, wss, manager, port, close };
}
```

- [ ] **Step 5: Guard the autostart so tests can own the lifecycle**

Replace the final `startServer().catch(console.error);` with:
```ts
// Tests set JANUS_NO_AUTOSTART=1 before importing so they control the lifecycle.
if (process.env.JANUS_NO_AUTOSTART !== "1") {
  startServer().catch(console.error);
}
export { startServer };
```

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: 0 errors. Fix any type mismatches in the new block (e.g. `server.address()` typing) until clean.

### Task B4: Add package.json deps/scripts the harness needs

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Check whether `@anthropic-ai/sdk` is actually imported by the rescued files**

```bash
grep -rn "@anthropic-ai/sdk" scripts/simulate-voice.ts tests/ || echo "not imported — skip the dep"
```

- [ ] **Step 2: Add only what is used**

If imported, run `npm install @anthropic-ai/sdk@^0.100.1`. Add a `sim` script if `simulate-voice.ts` is meant to be runnable:
```json
"sim": "tsx scripts/simulate-voice.ts"
```
Do NOT change the existing `test` script (main's `tsx --test --test-force-exit tests/*.ts` already globs the new tests).

- [ ] **Step 3: Verify the new tests are picked up and the WS dep exists**

```bash
grep -c '"ws"' package.json   # tests import { WebSocket } from "ws" — must be a dep
```
Expected: ≥1. If 0, `npm install ws @types/ws`.

### Task B5: Run the harness tests green, set JANUS_NO_AUTOSTART

**Files:** none (verification)

- [ ] **Step 1: Run the two new suites with the autostart guard**

```bash
JANUS_NO_AUTOSTART=1 npx tsx --test --test-force-exit tests/test_integration.ts tests/test_voice_tools.ts
```
Expected: PASS. Common fixes if red:
- import path drift → the tests import from `../server` / `../../server`; confirm relative depth.
- a tool name/arg the test asserts (e.g. `create_pane`, `set_global_permissions`) changed on main → update the test's expected tool name to main's current vocabulary (grep server.ts for the tool list).
- `running.manager.globalPermissionsMode` transitions → confirm main still exposes that field (it does via LedgerLike/manager).

- [ ] **Step 2: Full battery**

```bash
npm run lint && npm test && npm run build
```
Expected: all green. The full `npm test` must include the two new suites and stay green.

### Task B6: PR + merge + drop stash@{1}

**Files:** none (git/gh)

- [ ] **Step 1: Commit any seam/test fixups made since the WIP commit**

```bash
git add server.ts package.json package-lock.json tests/ scripts/
git commit -m "test(voice): port offline voice-agent harness + server testability seam (rescue stash@{1})"
```

- [ ] **Step 2: Rebase onto latest main, push, PR**

```bash
git fetch origin --quiet && git rebase origin/main
git push -u origin rescue/voice-test-harness --force-with-lease
gh pr create --base main --title "Rescue: voice-agent test harness + server testability seam (stash@{1})" --body "Ports scripts/simulate-voice.ts, tests/helpers/mockLive.ts, tests/test_integration.ts, tests/test_voice_tools.ts, and the server.ts liveConnector/startServer(opts)/RunningServer/JANUS_NO_AUTOSTART seam from stash@{1} (eb89337). EXCLUDES the stash's pre-PTY src/terminal.ts. Battery green."
PR=$(gh pr list --head rescue/voice-test-harness --json number --jq '.[0].number')
gh pr view "$PR" --json mergeable,mergeStateStatus --jq '{mergeable,mergeStateStatus}'   # expect CLEAN
gh pr merge "$PR" --squash --delete-branch
```

- [ ] **Step 3: Confirm on main, then drop stash@{1}**

```bash
git fetch origin --quiet
git cat-file -e origin/main:tests/test_voice_tools.ts && git cat-file -e origin/main:tests/helpers/mockLive.ts \
  && grep -q "setLiveConnector" <(git show origin/main:server.ts) \
  && git stash drop stash@{1} || echo "NOT fully on main — do NOT drop"
```
Expected: `Dropped stash@{1}` only after all three checks pass.

---

## Track C — Track the push-observation stack (claude/prompt-composer-refactor)

> This is the largest unmerged artifact (11 commits, push-observation P0b: PaneSignalBus, get_pane_delta, classifier, tests, RECONCILIATION.md). It is durably backed up on `origin/claude/prompt-composer-refactor`, so it is PRESERVED and not at risk. A full rescue is a conflict-laden rebase (main added classifySecrets/SecretScan/LedgerLike/capability-gates the branch lacks) and the concurrent session is active in this area — so this plan only TRACKS it; the actual rebase-rescue is a future, dedicated plan.

### Task C1: File the deferred-rescue tracking issue

**Files:** none (beads)

- [ ] **Step 1: Create the bd issue**

```bash
bd create "Rescue push-observation stack from claude/prompt-composer-refactor to main" -p 1 -t feature \
  -d "11 commits on origin/claude/prompt-composer-refactor (c2c6829), NOT on main: PaneSignalBus, paneSignals classifier, get_pane_delta MCP tool + consumeDelta/getPaneDelta on UniversalTerminal, 4 observe test suites, docs/roadmap/RECONCILIATION.md + push-observation plan (both referenced by main's CLAUDE.md/NEXT_STEPS but not landed). This IS P0b keystone ①. Rescue: 'git rebase --onto origin/main 034c206 claude/prompt-composer-refactor' OR cherry-pick 7000333 1284646 45fa3f4 35e3d71 b553a5f 39af8aa a6bf280 d0bb03c dbd5a9d 2e18aa1 3e39170 (skip PR-merge commits #4/#5/#9). CONFLICTS expected in src/terminal.ts + server.ts — KEEP main's classifySecrets/SecretScan/LedgerLike/DEFAULT_CAPABILITY_GATES and LAYER the delta-cursor on top. Coordinate: concurrent session is active in this area." \
  --context "Branch is backed up on origin so work is safe. Landing it also resolves dangling RECONCILIATION.md/push-observation references already shipped in main's CLAUDE.md."
```

- [ ] **Step 2: Confirm the branch is preserved on origin**

```bash
git fetch origin --quiet && git rev-parse --short origin/claude/prompt-composer-refactor
```
Expected: `c2c6829` (or later). DO NOT delete this branch in the cleanup plan until this issue is resolved.

---

## Self-Review

- **Spec coverage:** every unmerged item from the audit has a track — `.gitignore` line (A), the 4 harness files + server seam + package.json (B), the push-observation stack (C, tracked-not-merged with full rescue recipe recorded). The `stash@{1}` `terminal.ts` is explicitly excluded (pre-PTY, would regress).
- **No-loss guarantee:** each stash is dropped ONLY after a positive check that its content is on origin/main (A5, B6 Step 3). Track C's branch stays on origin until its bd issue is resolved. Nothing is deleted on assumption.
- **Type/name consistency:** the seam names (`LiveConnector`, `setLiveConnector`, `liveConnector`, `StartServerOptions`, `RunningServer`, `startServer`, `JANUS_NO_AUTOSTART`) match exactly what the rescued tests import (verified against tests/test_integration.ts:12/20/50/54 and tests/helpers/mockLive.ts:12). `manager`/`API_AUTH_TOKEN` exports match the WIP commit already on the rescue branch.
- **Sequencing with cleanup:** Tracks A and B let the branch-cleanup plan's preserved stashes be dropped; Track C keeps `claude/prompt-composer-refactor` off the delete list until its issue closes.
