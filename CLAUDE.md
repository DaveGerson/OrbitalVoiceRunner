# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Worktree Isolation (REQUIRED for commit-authorized agents)

Concurrent **team-maintainer** agents share one git store; in a shared working tree they stash/commit/switch over each other and over human WIP. (2026-06-01: a team-maintainer session stashed + branch-switched the shared main checkout, absorbing in-progress `.gitignore`/`server.ts` edits.) **This policy governs MUTATION (commits/writes), not reads** — see "Reads vs. writes" below.

- **Isolate before committing** — any commit-authorized agent works in its **own worktree**, never the shared main checkout. Launch with `dev <task>` (or `claude --worktree`); keep `worktree.bgIsolation: "worktree"`.
- **Main = integration-only** — review, merges, `git pull`; no autonomous commits there.
- **One committer per tree** — never `git stash`/`reset`/`checkout`/`add -A`/rebase against a tree you don't exclusively own. Find foreign uncommitted changes? **STOP and report** — don't rescue/park/stash them. (This is about **mutation**: stash/reset/checkout/add/commit/rebase. Read-only inspection of another tree is always fine — next bullet.)
- **Reads vs. writes** — the single-owner rule is about WRITES. **READS are always safe and never gated:** any number of agents may concurrently read, explore, and run `git -C <path> diff` / `git -C <path> status` / `git -C <path> log` against ANY worktree, including one another agent is actively editing. The lock only ever fires on `git commit`. This makes **multi-agent read-only review of in-progress feature work** a blessed pattern — see the recipe in [`docs/process/WORKTREE_LOCK.md`](docs/process/WORKTREE_LOCK.md#recipe-multi-agent-read-only-review-of-an-existing-worktree). To review uncommitted work in a feature worktree, point reviewers at its absolute path and keep them read-only — do NOT use `isolation:'worktree'` (that branches a FRESH tree off main, so it can't see the feature tree's uncommitted changes).
- Prefer sibling worktrees (`../<repo>-wt/<task>`) over nested `.claude/worktrees/`.
- **Enforcement (opt-in):** a `pre-commit` worktree-mutex lock backs this policy — advisory by default (warns), blocking via `JANUS_WT_LOCK=strict`. It gates **commits only**; reads are never touched. Enable per clone: `sh scripts/install-wt-lock.sh` (or `.ps1`). Clear a dead lock: `node scripts/wt-lock.mjs release --force`. Full details: `docs/process/WORKTREE_LOCK.md`.

## Build & Test

```bash
npm install                                    # deps (incl. native better-sqlite3)
npm run lint                                   # tsc --noEmit
npm test                                       # unit suite (tsx --test --test-force-exit)
npm run test:e2e                               # Playwright (auto-starts Vite, ?mock=1 harness)
npm run build                                  # vite + esbuild → dist/server.cjs
npm run smoke:claude                           # live pane smoke (needs authed Claude binary)
node scripts/check-deps.mjs                     # verify node_modules is in sync with package.json
```

> Gotchas:
> - The unit runner needs `--test-force-exit` (a PTY keeps the loop alive otherwise).
> - **Any pull/checkout that changes `package*.json` must be followed by `npm ci`** before
>   lint/test/dev — git does NOT reinstall on pull, so a new dependency (e.g. the Wave D `zod`
>   add) leaves `node_modules` stale and `tsc` fails with a cryptic "cannot find module". The
>   `post-merge`/`post-checkout` hooks warn about this automatically once installed via
>   `sh scripts/install-wt-lock.sh` (they run `node scripts/check-deps.mjs --warn`, fail-open).

## Architecture Overview

Voice-driven orchestrator for live Claude/Codex CLI panes. `server.ts` is the WS/REST hub;
`src/terminal.ts` (`OrchestratorManager` + `UniversalTerminal`) owns pane lifecycle over a
real PTY (`src/ptyTransport.ts`, node-pty/ConPTY). State persists through a **SQLite ledger**
(`src/store/`, `JanusStore`) — the default backend as of WS-M; opt out with
`JANUS_LEDGER_BACKEND=legacy`. Safety is the **capability-gate matrix** (per-capability
Auto/Ask/Off, global + per-pane), the choke-point every pane-mutating action routes through.

## Conventions & Patterns

- **Task tracking & memory: use `bd` (beads)** — `bd ready` / `bd create` / `bd update --claim`
  / `bd close`; `bd remember` for persistent knowledge. Run `bd prime` for full workflow context.
- **Priority order is LOCKED**: see `docs/roadmap/RECONCILIATION.md` §4 (P0a → P0b → P1 → P2).
- **Panes boot INERT** (no auto-spawn) — start one explicitly via `/restart` or the UI.
- TDD for features/fixes; verify with the battery above before claiming done.
