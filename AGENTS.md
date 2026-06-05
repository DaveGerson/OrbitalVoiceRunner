# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

> **Architecture in one line:** Issues live in a local Dolt database
> (`.beads/dolt/`); cross-machine sync uses `bd dolt push/pull` (a
> git-compatible protocol), stored under `refs/dolt/data` on your git
> remote — separate from `refs/heads/*` where your code lives.
> `.beads/issues.jsonl` is a passive export, not the wire protocol.
>
> See [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md)
> for the one-screen overview and anti-patterns (don't treat JSONL as the
> source of truth; don't `bd import` during normal operation; don't
> reach for third-party Dolt hosting before trying the default).

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Worktree Isolation (REQUIRED for commit-authorized agents)

> Repository instruction. The managed Beads block below states that explicit repository instructions override it — this section governs **where** commit-authorized work happens.

Every agent shares **one** git object store. Concurrent **team-maintainer** sessions working in the **same** tree stash, commit, and switch branches over each other — and over any human's uncommitted work. (2026-06-01: a team-maintainer session `git stash`-ed and branch-switched the shared main checkout, absorbing a developer's in-progress `.gitignore`/`server.ts` edits.)

**Scope: this policy governs MUTATION (commits, stash, branch-switch, index writes), NOT reads.** Read-only inspection of any worktree is always safe and is never gated — see "Reads are always safe" below. The rules here exist to prevent two *writers* from colliding on one tree.

- **Isolate before you commit.** Any agent with commit/push authority MUST operate in its **own dedicated worktree**, never the shared main checkout. Start isolated: `dev <task>` (or `claude --worktree <task>` / `EnterWorktree`). Keep `worktree.bgIsolation: "worktree"` so background agents cannot edit the main checkout.
- **Main is integration-only.** The primary checkout is for review, merges, and `git pull` — no feature edits, no autonomous commits.
- **One committer per tree/branch.** Never `git stash`, `reset`, `checkout`, `add -A`, amend, `restore`, `switch`, `clean`, or rebase against a working tree you do not exclusively own. If you find uncommitted changes you did not make, **STOP and report** — do not rescue, park, or stash them. (This bullet is about **mutation** of another tree's working state; it does **not** restrict reading it.)
- **Reads are always safe — multi-agent review is a blessed pattern.** Any number of agents may concurrently read, explore, and run **read-only** git against ANY worktree — including one another agent is actively editing — via `git -C <path> diff`, `git -C <path> status`, `git -C <path> log`, and reading files directly. None of this touches the index, HEAD, stash, or working tree, and the lock only ever fires on `git commit`. To review **in-progress, uncommitted** feature work, pass reviewers the feature worktree's **absolute path**, keep them strictly read-only (no `stash`/`reset`/`checkout`/`add`/`commit`/`rebase`/`clean`/`restore`/`switch`), and have them use `git -C <path> diff` + `git -C <path> status` + reading untracked files directly. Do **not** reach for `isolation:'worktree'` for review — it branches a *fresh* tree off main and therefore cannot see the feature tree's uncommitted changes; it is for parallel *writers*, not reviewers. Full recipe: [`docs/process/WORKTREE_LOCK.md`](docs/process/WORKTREE_LOCK.md#recipe-multi-agent-read-only-review-of-an-existing-worktree).
- **Keep worktrees outside the shared tree.** Prefer a sibling dir (`../<repo>-wt/<task>`) over nested `.claude/worktrees/`, so non-git-aware tooling in the main checkout cannot reach into them.

This binds **every** session — orchestrated, background, scheduled, and interactive alike. (Again: it binds *writers*. Reviewers reading another tree are unaffected.)

**Enforcement — worktree-mutex lock (opt-in).** A committed `pre-commit` hook makes "one committer per tree/branch" a mechanism, not just a rule. It runs **only on `git commit`** — reads (`diff`/`status`/`log`/file reads against any tree) are never intercepted. It is **advisory by default** (warns on contention, never blocks) and **blocks only** when you opt in with `JANUS_WT_LOCK=strict`. Stale locks auto-expire and a dead session can never permanently block commits. Enable it per clone (it does **not** touch shared `core.hooksPath`): `sh scripts/install-wt-lock.sh` — or `pwsh scripts/install-wt-lock.ps1` on Windows. Clear a stale lock with `node scripts/wt-lock.mjs release --force`. Because it's a plain git hook it binds Claude, Codex, and humans alike. Full design + commands: [`docs/process/WORKTREE_LOCK.md`](docs/process/WORKTREE_LOCK.md).

## Multi-Wave Execution Authority

When executing a grounded, spec-driven **multi-wave plan** under a **team-maintainer** profile in
an **isolated worktree**, the user delegates integration:

- Proceed **wave-by-wave without per-wave approval** — self-review each wave, then merge its branch
  into local `main` and roll into the next wave.
- **Hold `git push`** until the user explicitly approves.
- **Surface** product decisions, design ambiguities, and deviations as notes — do not block on them.
- Applies only when (a) a written plan is in place, (b) work is isolated (`dev <task>`), and (c) the
  session has team-maintainer authority. Absent these, fall back to the Conservative profile.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
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
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
