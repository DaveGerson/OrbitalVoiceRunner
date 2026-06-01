# Branch Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete every branch/stash/worktree-state that is provably redundant, and leave a written record so nothing untracked remains — while explicitly NOT touching anything that still holds unmerged work (that is the companion plan `2026-06-01-rescue-unmerged-work.md`).

**Architecture:** Verify-then-delete. Each destructive task re-proves safety with a live git check immediately before acting (never trust a prior audit blindly), then acts only if the check passes. Order: safe deletions first, then the session-ledger record, then a final guard confirming the unmerged artifacts are still preserved.

**Tech Stack:** git, gh CLI. Run everything from the worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner/.claude/worktrees/wsm-e2e-pinned` unless a step says otherwise.

**Audit basis (verified 2026-06-01, origin/main = d4f854d):**
- SAFE (content fully on main): `origin/feat/handoff-merge` (8867680), `origin/feat/handoff-hardening` (fe23061), `origin/feat/e2e-harness-module` (512ed78), `origin/chore/beads-integration` (fb83365, squash-phantom of PR #13).
- DETACHED but safe: main repo working dir at 3752298 (= ancestor of origin/main).
- PRESERVE — has unmerged work (do NOT delete here): `claude/prompt-composer-refactor` (c2c6829, push-observation stack), `stash@{1}` (eb89337, voice harness), `stash@{0}` (95e00c3, .gitignore line), `rescue/voice-test-harness` (ac6678e, partial port WIP).

---

### Task 1: Re-verify the safe-delete set is still 0-ahead

**Files:** none (verification only)

- [ ] **Step 1: Fetch + prune, then assert each candidate has zero unmerged patches**

Run:
```bash
cd C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner/.claude/worktrees/wsm-e2e-pinned
git fetch origin --prune
for b in feat/handoff-merge feat/handoff-hardening feat/e2e-harness-module chore/beads-integration; do
  ahead=$(git rev-list --count origin/main..origin/$b 2>/dev/null)
  unmerged=$(git cherry origin/main origin/$b 2>/dev/null | grep -c '^+')
  echo "origin/$b ahead=$ahead cherry_unmerged=$unmerged"
done
```
Expected: every line shows `ahead=0` AND `cherry_unmerged=0`.

- [ ] **Step 2: STOP-gate**

If ANY branch shows `ahead>0` or `cherry_unmerged>0`, do NOT delete it. Record it in Task 4's ledger as "newly-diverged — re-audit" and exclude it from Task 2. Report to the human. Only proceed for branches that pass.

---

### Task 2: Delete the verified-safe remote branches

**Files:** none (remote refs)

- [ ] **Step 1: Delete each branch that passed Task 1**

Run (only for branches confirmed `ahead=0 cherry_unmerged=0`):
```bash
git push origin --delete feat/handoff-merge
git push origin --delete feat/handoff-hardening
git push origin --delete feat/e2e-harness-module
git push origin --delete chore/beads-integration
```
Expected: each prints `- [deleted]   <branch>`.

- [ ] **Step 2: Prune local tracking refs**

Run: `git remote prune origin`
Expected: prunes the deleted `origin/*` refs.

- [ ] **Step 3: Verify they are gone**

Run: `git for-each-ref --format='%(refname:short)' refs/remotes/origin/ | grep -v HEAD`
Expected: only `origin/main`, `origin/claude/prompt-composer-refactor`, and any rescue branches remain (NOT the 4 deleted).

---

### Task 3: Re-attach the detached-HEAD main repo

**Files:** none (the OTHER working tree at the repo root)

> The main repo working dir is in detached HEAD at 3752298. Re-attaching is safe (it is an ancestor of origin/main). This is the ONE step that touches the concurrent session's working directory — if that session is mid-edit, SKIP and record in the ledger instead.

- [ ] **Step 1: Check the main repo working tree is clean before switching**

Run: `git -C C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner status --porcelain=v1 --untracked-files=no`
Expected: empty (no tracked changes). If NON-empty, STOP — the concurrent session has uncommitted work; do not switch. Record "detached HEAD left as-is (main repo dir busy)" in the ledger and skip to Task 4.

- [ ] **Step 2: Switch to main and fast-forward**

Run:
```bash
git -C C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner switch main
git -C C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner pull --ff-only origin main
```
Expected: `Switched to branch 'main'` and up-to-date/fast-forwarded to d4f854d (or later).

---

### Task 4: Write the SESSION_LEDGER.md record

**Files:**
- Create: `docs/SESSION_LEDGER.md` (on a fresh branch off origin/main)

- [ ] **Step 1: Branch off latest main**

Run:
```bash
git switch main && git pull --ff-only origin main
git switch -c chore/session-ledger
```

- [ ] **Step 2: Write `docs/SESSION_LEDGER.md`**

Write the full disposition table (every branch/stash/worktree state, its SHA, status, proof, and disposition) plus an "Open deferred item" section for `claude/prompt-composer-refactor`. Use the `sessionRecord` content produced by the audit workflow as the body (it is already a complete markdown table). Ensure it lists: the 4 deleted branches, the detached-HEAD re-attach, the preserved refactor branch, and both stashes with their rescue status.

- [ ] **Step 3: Commit**

```bash
git add docs/SESSION_LEDGER.md
git commit -m "docs: session ledger — prior-session artifact disposition + cleanup record"
```

- [ ] **Step 4: PR + squash-merge**

```bash
git push -u origin chore/session-ledger
gh pr create --base main --title "docs: session ledger (cleanup record)" --body "Records the disposition of every prior-session branch/stash so history survives branch deletion. Companion to the branch-cleanup + rescue plans."
PR=$(gh pr list --head chore/session-ledger --json number --jq '.[0].number')
gh pr view "$PR" --json mergeable,mergeStateStatus --jq '{mergeable,mergeStateStatus}'   # expect CLEAN/MERGEABLE
gh pr merge "$PR" --squash --delete-branch
```
Expected: merged; origin/main advances.

---

### Task 5: Final guard — confirm unmerged work is still preserved

**Files:** none (verification only)

- [ ] **Step 1: Assert the preserved artifacts still exist and are intact**

Run:
```bash
cd C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner/.claude/worktrees/wsm-e2e-pinned
git fetch origin --quiet
echo "refactor on origin:"; git rev-parse --short origin/claude/prompt-composer-refactor
echo "stashes:"; git stash list
echo "rescue branch:"; git rev-parse --short rescue/voice-test-harness 2>/dev/null || echo "MISSING"
```
Expected: `origin/claude/prompt-composer-refactor` still resolves (c2c6829); BOTH stashes still listed; `rescue/voice-test-harness` still resolves. If any are missing, STOP — work may have been lost; recover via `git reflog` / `git fsck --lost-found` and report.

- [ ] **Step 2: Report cleanup complete**

State plainly: which branches were deleted, whether the detached HEAD was re-attached or skipped, that the ledger is on main, and that all unmerged artifacts remain preserved pending the rescue plan.

---

## Self-Review

- **Coverage:** every artifact from the audit is handled — 4 safe branches deleted (T2), detached HEAD re-attached (T3), record written (T4), unmerged work explicitly preserved + guarded (T1 stop-gate, T5). No artifact is silently dropped.
- **No destructive action without a fresh check:** T1 re-verifies before T2 deletes; T3 checks the working tree before switching; T5 confirms nothing was lost.
- **Out of scope (handled by the rescue plan):** deleting `claude/prompt-composer-refactor`, dropping the stashes, deleting `rescue/voice-test-harness`. Those happen only AFTER their content lands on main.
