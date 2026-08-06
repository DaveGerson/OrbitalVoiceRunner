# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Platform Notes (Windows / PowerShell — read first)

This project runs on Windows 11. The single largest source of wasted session time in past
sessions was shell-idiom mismatch. Internalize these before running any command:

**Shell routing (the #1 failure class):**
- The **Bash tool** runs Git Bash (`/usr/bin/bash`). Use POSIX syntax only — never PowerShell
  (`$x = ...`, `Write-Output`, `2>$null`, `[string]::...`).
- The **PowerShell tool** runs Windows PowerShell 5.1. Use PowerShell syntax only — never POSIX
  (`grep`, `cat`, `head`, `awk`, `2>/dev/null`, `&&`/`||` chains).
- A syntax error in ONE call of a parallel Bash batch **cancels every sibling call** in that
  batch. Do not mix shells in one call; do not parallelize shell calls that might error.

**Prefer dedicated tools over shell commands:**
- Read files with the **Read tool**, not `cat`. Reading a file via `cat` does NOT mark it read —
  the Edit tool will then fail with "File has not been read yet."
- Search with the **Grep** and **Glob** tools, not `grep` / `find`.
- Inspect ports/processes with PowerShell `Get-NetTCPConnection` / `Get-Process`, not `netstat | grep`.

**Paths:**
- In Read/Edit/Glob/Grep tool calls, always use absolute Windows paths (`C:/Users/gerso/...`).
  Forward slashes are fine and preferred.
- Hook and statusLine command strings run through Git Bash — use forward slashes there too, or
  they silently no-op (blank status line / dead hook).
- Avoid `/tmp/` in Bash (Git Bash maps it to a transient location subagents can't reach); use
  `$env:TEMP` or `C:/Users/gerso/AppData/Local/Temp`.

**PowerShell gotchas:**
- Logs written by PowerShell/Tee-Object are UTF-16. Don't Read `dev-server.log` directly; use
  `Get-Content -Raw -Encoding UTF8`.
- A `NativeCommandError` wrapping node's stderr is a display artifact, not a crash — confirm
  health by the actual log line (e.g. "Server running on ...").
- Set `$env:PYTHONIOENCODING='utf-8'` before any `py -3` invocation (Windows defaults to cp1252).

**server.ts navigation:**
- `server.ts` lives at the **repo root** (not `src/`) and is ~3,200 lines. Never Read it without
  an `offset`. **Grep for the handler/function name first**, then Read a tight `offset`+`limit`
  (<= 60 lines) window.

**Session start:**
- Read CLAUDE.md and memory files as sequential calls *before* firing Bash for git status — do
  not parallelize orientation Reads with a Bash command (a Bash EOF cascades and cancels the Reads).

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

## Repository Default: Agent Commit + Push Policy

> This section overrides the Conservative default inside the Beads block. The Beads block is
> issue-tracker scaffolding; git authority is set here.

The default profile for agents on this repo is **team-maintainer-scoped** (not Conservative):

- **In an isolated worktree**, once the full quality gate passes (adversarial review → e2e →
  loop-until-clean → lint → unit tests → build → smoke where applicable), agents **commit and push
  to a feature branch** without waiting for explicit approval.
- **Open a PR** from that branch — it is the audit trail and the CI trigger, **not** a wait-for-human
  gate.
- **Agents MERGE their own PR into `main`** once, and only once, all three hold (operator, 2026-08-06
  — this has always been the intended workflow; earlier wording here wrongly implied a human had to
  click merge):
  1. **CI/CD is green and clean** — every required check SUCCESS on the PR's *current* head SHA (not a
     stale run: re-verify after any sync/rebase push), and `mergeStateStatus` is `CLEAN`.
  2. **The local quality gate passed** — lint/`tsc`, `npm run complexity` (zero suppressions), unit
     suite, e2e where applicable.
  3. **An adversarial review passed** — a *fresh* reviewer (a different agent/model, ideally a
     different family) that is instructed to REFUTE the work, whose findings were then applied or
     explicitly, honestly dispositioned (e.g. filed as beads with the reason they were out of scope).
     Self-review does not satisfy this.
- **If any of the three fails, do not merge** — report the exact failing check/finding and stop.
  Merging is the one action where "probably fine" is not good enough.
- **Direct push to `main` (bypassing a PR) stays prohibited.** Main is reached by *merging* a PR, so
  the branch, its checks, and the review remain on the record.
- **Close the beads after the merge lands**, not on a green branch — the tracker describes `main`.
- **Outside an isolated worktree** (the shared main checkout), fall back to Conservative: report
  changed files + proposed commands, and wait for approval.
- An explicit "do not commit / do not push / do not merge" instruction in the current session still
  wins.

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
npm run complexity                             # lint gates (eslint): McCabe complexity<=10 + cognitive-complexity<=15 + react-hooks/rules-of-hooks (all ERROR). Burndown COMPLETE — eslint-suppressions.json is empty; exit 2 = a stale suppression, run `npx eslint . --prune-suppressions`
npm run complexity:report                      # churn × complexity hotspot ranking (what to refactor next)
```

> Gotchas:
> - The unit runner needs `--test-force-exit` (a PTY keeps the loop alive otherwise).
> - **Any pull/checkout that changes `package*.json` must be followed by `npm ci`** before
>   lint/test/dev — git does NOT reinstall on pull, so a new dependency (e.g. the Wave D `zod`
>   add) leaves `node_modules` stale and `tsc` fails with a cryptic "cannot find module". The
>   `post-merge`/`post-checkout` hooks warn about this automatically once installed via
>   `sh scripts/install-wt-lock.sh` (they run `node scripts/check-deps.mjs --warn`, fail-open).
> - The catalog drift guard (`scripts/catalog.ts`) normalizes CRLF→LF before comparing, so it
>   won't false-fail on Windows; a real drift means the registry changed — run `npm run catalog`.
> - Lint gates (`eslint.config.js`): McCabe `complexity<=10`, `sonarjs/cognitive-complexity<=15`,
>   and `react-hooks/rules-of-hooks` are all **errors**; `react-hooks/exhaustive-deps` is advisory
>   `warn` (the codebase's unstable-body-fn idiom makes erroring it disable-noisy). The complexity
>   **burndown is COMPLETE**: `eslint-suppressions.json` is empty, `RATCHET_CEILING` is `0`
>   (`tests/test_complexity_ratchet.ts`), and the whole tree passes at CC ≤ 10 with **zero
>   suppressions** — any new violation must be FIXED (the ratchet only ever shrinks). Design,
>   decisions, and the completed burn-down: `docs/superpowers/specs/2026-06-19-cyclomatic-complexity.md`.

## Architecture Overview

Voice-driven orchestrator for live Claude/Codex CLI panes. `server.ts` is the WS/REST hub;
`src/terminal.ts` (`OrchestratorManager` + `UniversalTerminal`) owns pane lifecycle over a
real PTY (`src/ptyTransport.ts`, node-pty/ConPTY). State persists through a **SQLite ledger**
(`src/store/`, `JanusStore`) — the ONLY backend since dbt3 (2026-07-02) retired the legacy
in-memory/JSON ledger and its `JANUS_LEDGER_BACKEND=legacy` escape hatch; a store-init failure
is now a fatal boot error (there is no fallback). The one-way JSON→SQLite boot migration for
operators upgrading from pre-WS-M on-disk data is unaffected and still runs. Safety is the
**capability-gate matrix** (per-capability Auto/Ask/Off, global + per-pane), the choke-point
every pane-mutating action routes through.

### Python ⇄ TS boundary (the seam — read before adding "logic")

**Direction (operator, 2026-06-19): Python owns decisions; TypeScript owns the frontend and the
I/O shell.** New decision-logic is born in Python; existing pure-logic ports to Python only when a
file is *already* being changed (opportunistic, not a rewrite). Rationale: a forthcoming Python
agent/LLM layer, team/language fit, separation of concerns. Full ADR:
`docs/design/2026-06-19-python-ts-seam.md`.

| Goes to **Python** (the brain) | Stays in **TypeScript** (frontend + shell) |
|---|---|
| Agent/LLM/planning logic (the new layer) | React/Vite **frontend — exclusively TS** |
| Memory/RAG scoring, context synthesis (`python/synthesizer/`, already there) | WS/REST transport, `node-pty`/ConPTY pane lifecycle |
| Policy *evaluation*, classification, non-hot validation/normalization | Capability-gate **enforcement** choke-point (sync, fail-closed) |
| Pure, deterministic, no Node-object coupling, not per-frame/keystroke/spawn | Real-time audio/streaming, hot paths, SQLite I/O |

- **Bridge:** the stdio-JSON daemon pattern — `src/memory/pythonClient.ts` ⇄ `python/<module>/__main__.py`, one JSON object per line. New Python logic modules follow that exact shape; do NOT invent a second transport.
- **Don't cross the seam on a hot path.** Anything called per-keystroke / per-audio-frame / per-spawn (e.g. preset normalization) stays TS — the stdio round-trip costs more than the work.
- **The gate is special:** its *decision* is portable in principle, but it's a synchronous, fail-closed security choke-point — do NOT move it across the boundary casually.

## Conventions & Patterns

- **Task tracking & memory: use `bd` (beads)** — `bd ready` / `bd create` / `bd update --claim`
  / `bd close`; `bd remember` for persistent knowledge. Run `bd prime` for full workflow context.
- **`TaskCreate` / `TaskUpdate` / `TodoWrite` are PROHIBITED here.** They appear in the tool/skill
  list (and the `superpowers:using-superpowers` flowchart says "Create TodoWrite todo per item"),
  but they do **not** persist across sessions and they bypass `bd`, so task state is lost at every
  session boundary. Use `bd create` / `bd update --claim` / `bd close` instead — when a skill
  diagram calls for a todo list, satisfy it with `bd`.
- **Priority order is LOCKED**: see `docs/roadmap/RECONCILIATION.md` §4 (P0a → P0b → P1 → P2).
- **Panes boot INERT** (no auto-spawn) — start one explicitly via `/restart` or the UI.
- TDD for features/fixes; verify with the battery above before claiming done.
