# Worktree Mutual-Exclusion Lock

The enforcement layer behind the **Worktree Isolation** policy (see
`AGENTS.md` / `CLAUDE.md`). It makes "one committer per worktree/branch" a
mechanism, not just a rule, so two concurrent team-maintainer agent sessions
cannot stash / commit / branch-switch over each other on a shared working tree.

## TL;DR

- **Advisory by default**: a contended commit prints a warning and **proceeds**.
  Blocking is opt-in: `export JANUS_WT_LOCK=strict`.
- **Safe by construction**: stale locks auto-expire (2h), corrupt/missing locks
  fail open, and the hook is a no-op if `node` is missing. Nothing here can
  permanently block commits.
- **Not auto-active**: you enable it per clone with one install command. It does
  **not** touch shared git config (`core.hooksPath`), so installing it never
  changes behavior for other clones in the fleet.
- **Cross-tool**: it's a plain `pre-commit` git hook, so it binds Claude, Codex,
  and humans — anything that runs `git commit`.

## Scope: commits/writes only — reads are never gated

This lock — and the whole Worktree Isolation policy behind it — guards **one
thing**: two *writers* colliding on one tree. It fires **only on `git commit`**.
It does **not** intercept, slow, or forbid any read:

- `git -C <path> diff`, `git -C <path> status`, `git -C <path> log`, `git -C <path> show`
- reading any file (tracked or untracked) in any worktree
- any number of agents doing the above **concurrently**, against **any** worktree
  — including one another agent is actively editing.

So **multi-agent read-only review/exploration of in-progress work is always
safe and is never blocked.** The strong policy wording ("never touch a tree you
don't own", "one committer per tree") is about **mutation** — `stash`, `reset`,
`checkout`, `add`, `commit`, `rebase`, `clean`, `restore`, `switch` — not about
reading. If you only need to *look*, none of the isolation rules constrain you.

For the blessed pattern to review another worktree's uncommitted changes, see
[Recipe: multi-agent read-only review of an existing worktree](#recipe-multi-agent-read-only-review-of-an-existing-worktree).

## How it works (the 3B1B picture)

Every worktree of a clone shares **one** `.git` object store. Picture all the
worktrees as doors into the same room. The lock is a single coat hook on the
wall, labeled per branch:

```
$GIT_COMMON_DIR/janus-wt-locks/<branch>.lock.json   (lives INSIDE .git -> never committed)
```

When you `git commit`, the `pre-commit` hook asks `scripts/wt-lock.mjs` one
question: "is someone else's coat already on this branch's hook, and is it
still warm?" The decision is a pure function (`src/wtLock.ts`):

| Lock state on this branch                   | advisory (default) | strict (opt-in) |
| ------------------------------------------- | ------------------ | --------------- |
| none                                        | acquire, allow     | acquire, allow  |
| held by **this** worktree                   | allow              | allow           |
| held by another worktree, **stale** (>2h)   | reclaim, allow     | reclaim, allow  |
| held by another worktree, **live**          | **warn**, allow    | **BLOCK**       |
| corrupt / unreadable / `node` missing       | allow (fail open)  | allow (fail open) |
| `JANUS_WT_LOCK=off`                          | allow              | allow           |

A lock record carries the branch, the **absolute worktree path**, an opaque
**session id**, a timestamp, and a friendly holder label. "Self" is matched by
worktree path *or* session id, so re-committing in your own tree is never
contention.

## Enable it (manual, per clone)

```bash
# macOS / Linux / Git-Bash:
sh scripts/install-wt-lock.sh

# Windows PowerShell:
pwsh scripts/install-wt-lock.ps1
```

This copies `.githooks/pre-commit` into the directory git already uses for hooks
in this clone (`core.hooksPath` if set, else `$GIT_COMMON_DIR/hooks`). That
directory is shared by every worktree of the clone — exactly the contention
domain — so **one install covers all your worktrees**. If a different
`pre-commit` already exists, the installer refuses (re-run with `--force`, or
add the one-liner it prints to your existing hook).

> Why not `git config core.hooksPath .githooks`? Because git config is **shared
> across all worktrees and the main checkout of a clone**, and on multi-clone
> fleets a stray value can surprise other clones. The installer deliberately
> avoids it: it writes a file, it doesn't flip a global switch.

Uninstall: `sh scripts/install-wt-lock.sh --uninstall` (or `-Uninstall` on PS).

## Turn on blocking (strict mode)

```bash
export JANUS_WT_LOCK=strict      # this shell / session only
# PowerShell:  $env:JANUS_WT_LOCK = 'strict'
```

In strict mode a commit that collides with another live worktree's lock exits
non-zero and is blocked. Default (unset / `advisory` / `warn`) only warns.
`JANUS_WT_LOCK=off` disables the check entirely.

Tuning the staleness window (default 2h): `export JANUS_WT_LOCK_STALE_MS=3600000`.

## Recipe: multi-agent read-only review of an existing worktree

**Problem.** A Workflow's implementation phase produces uncommitted work in an
isolated feature worktree (e.g. `feat/odb` at
`../OrbitalVoiceRunner-wt/odb`). In the review phase you want **N parallel
subagents** to review/explore that **in-progress, uncommitted** work.

**Why `isolation:'worktree'` does NOT fit here.** That primitive spins up a
**fresh** worktree branched off the session's HEAD (typically `main`). A fresh
tree off main does **not** contain the feature worktree's uncommitted changes,
so reviewers launched that way literally cannot see the work under review.
`isolation:'worktree'` is for parallel **writers** branching off main — not for
reviewing someone else's in-flight feature tree.

**The pattern (read-only, zero-mutation).** Point reviewers directly at the
feature worktree's **absolute path** and keep them strictly read-only:

1. Give each reviewer the feature worktree path, e.g.
   `C:\Users\you\PycharmProjects\OrbitalVoiceRunner-wt\odb` (an absolute path,
   not a relative one — reviewers may run from anywhere).
2. Reviewers run **only** read-only git, always with `-C <path>` (or `cd`-free
   `git -C`) so they never disturb their own cwd's tree either:
   - `git -C <path> status --short` — see modified **and** untracked files.
   - `git -C <path> diff` — tracked, unstaged changes.
   - `git -C <path> diff --staged` — staged changes.
   - `git -C <path> log --oneline -20` — recent history.
   - read any file directly (tracked or untracked) with normal file tools.
3. Reviewers run **zero** state-mutating git. Forbidden in the reviewed tree
   **and** their own: `stash`, `reset`, `checkout`, `switch`, `restore`,
   `add`, `commit`, `rebase`, `merge`, `clean`, `apply`. None are needed to read.

**Gotcha — `git diff` hides new files.** Plain `git diff` shows only *tracked*
changes; brand-new untracked files (a very common shape for in-progress work)
do **not** appear. Always pair it with `git -C <path> status --short` (untracked
files show as `??`) and read those files directly. The convenience helper
[`scripts/worktree-changeset.mjs`](../../scripts/worktree-changeset.mjs) prints
the **full** change set — tracked diff stat **plus** untracked files — in one
shot:

```bash
node scripts/worktree-changeset.mjs ../OrbitalVoiceRunner-wt/odb
# defaults to the current worktree if no path is given
```

**Safety.** This pattern is safe by construction: it is all reads, and the
`pre-commit` lock does not fire on reads (it runs only on `git commit`). Many
reviewers can hit one feature tree at once with no contention. The single owner
keeps writing in their tree; reviewers only observe. See
[Scope: commits/writes only](#scope-commitswrites-only--reads-are-never-gated).

## Clear a stale / dead lock

A dead session can never permanently block you — locks auto-expire after 2h.
To clear one immediately:

```bash
node scripts/wt-lock.mjs status            # see who holds it
node scripts/wt-lock.mjs release           # release only if THIS worktree owns it
node scripts/wt-lock.mjs release --force   # release regardless of holder (dead session)
```

You can also just delete `$GIT_COMMON_DIR/janus-wt-locks/<branch>.lock.json`.

## Commands

| Command                                  | Effect |
| ---------------------------------------- | ------ |
| `node scripts/wt-lock.mjs check`         | What the hook runs. Acquire/warn/block per the table above. |
| `node scripts/wt-lock.mjs acquire`       | Force-write a lock for this worktree. |
| `node scripts/wt-lock.mjs release [-f]`  | Remove the lock (own only, or `--force` for any). |
| `node scripts/wt-lock.mjs status`        | Print the current lock holder, if any. |

## Files

- `src/wtLock.ts` — pure decision logic + safety contract (unit-tested).
- `scripts/wt-lock.mjs` — git plumbing + file I/O shell around the decision.
- `.githooks/pre-commit` — committed launcher; fails open if anything is off.
- `scripts/install-wt-lock.sh` / `.ps1` — manual per-clone opt-in installer.
- `tests/test_wt_lock.ts` — proves advisory-never-blocks, strict-blocks-live,
  stale-reclaim, and fail-open.

## Manual test (full end-to-end)

The unit suite (`npm test`) covers the decision core. To exercise the real hook:

```bash
# in a throwaway clone with the hook installed and on a feature branch:
node scripts/wt-lock.mjs check && echo allowed     # acquires, allows

# plant a foreign live lock, then:
JANUS_WT_LOCK=strict git commit -m x    # -> blocked, non-zero
git commit -m x                          # advisory (unset) -> warns, succeeds
node scripts/wt-lock.mjs release --force # clears it
```
