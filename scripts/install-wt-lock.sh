#!/bin/sh
# scripts/install-wt-lock.sh — opt-in installer for the Worktree Mutex Lock.
#
# Installs .githooks/pre-commit into THIS CLONE's active hooks directory. This
# is a deliberate, MANUAL, per-clone step. It does NOT modify shared git config
# (it never runs `git config core.hooksPath ...`), so it cannot change behavior
# fleet-wide for other clones.
#
# It installs into the directory git already uses for hooks (core.hooksPath if
# set, else $GIT_COMMON_DIR/hooks). The hooks dir is shared by all worktrees of
# this clone — which is exactly the contention domain the lock guards — so a
# single install binds every worktree of this clone, for Claude, Codex, and
# humans alike.
#
# Usage:
#   sh scripts/install-wt-lock.sh           # install (won't clobber a custom hook)
#   sh scripts/install-wt-lock.sh --force   # overwrite an existing pre-commit
#   sh scripts/install-wt-lock.sh --uninstall
#
set -eu

FORCE=0
UNINSTALL=0
for a in "$@"; do
  case "$a" in
    --force|-f) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "unknown arg: $a" 1>&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
SRC="$ROOT/.githooks/pre-commit"

# Resolve the active hooks dir without changing config.
HOOKS_DIR="$(git config --get core.hooksPath || true)"
if [ -z "$HOOKS_DIR" ]; then
  COMMON="$(git rev-parse --git-common-dir)"
  case "$COMMON" in
    /*|[A-Za-z]:*) : ;;            # already absolute
    *) COMMON="$ROOT/$COMMON" ;;   # make relative path absolute
  esac
  HOOKS_DIR="$COMMON/hooks"
fi

DEST="$HOOKS_DIR/pre-commit"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$DEST" ] && grep -q "Worktree Mutual-Exclusion Lock" "$DEST" 2>/dev/null; then
    rm -f "$DEST"
    echo "[install-wt-lock] removed $DEST"
  else
    echo "[install-wt-lock] no managed pre-commit hook at $DEST (nothing to do)"
  fi
  exit 0
fi

if [ ! -f "$SRC" ]; then
  echo "[install-wt-lock] missing $SRC" 1>&2
  exit 1
fi

mkdir -p "$HOOKS_DIR"

if [ -f "$DEST" ] && [ "$FORCE" -ne 1 ]; then
  if grep -q "Worktree Mutual-Exclusion Lock" "$DEST" 2>/dev/null; then
    # Already our hook — refresh it.
    cp "$SRC" "$DEST"
    chmod +x "$DEST" 2>/dev/null || true
    echo "[install-wt-lock] refreshed existing managed hook at $DEST"
    exit 0
  fi
  echo "[install-wt-lock] a different pre-commit hook already exists at:" 1>&2
  echo "    $DEST" 1>&2
  echo "  Re-run with --force to overwrite, or manually add this line to it:" 1>&2
  echo "    node \"$ROOT/scripts/wt-lock.mjs\" check || exit 1   # only blocks in strict mode" 1>&2
  exit 1
fi

cp "$SRC" "$DEST"
chmod +x "$DEST" 2>/dev/null || true
echo "[install-wt-lock] installed worktree lock hook -> $DEST"
echo "[install-wt-lock] mode: advisory (warn only). For blocking: export JANUS_WT_LOCK=strict"
