#!/usr/bin/env node
// scripts/worktree-changeset.mjs
//
// Print the FULL uncommitted change set of a worktree — including untracked
// files, which a plain `git diff` omits. Built for the "multi-agent read-only
// review of an existing worktree" recipe (see docs/process/WORKTREE_LOCK.md).
//
// This tool is STRICTLY READ-ONLY. It runs only `git status` / `git diff` /
// `git rev-parse` against the target tree. It never writes the index, HEAD,
// stash, or working tree, so it is always safe to point at a worktree another
// agent is actively editing, and it never trips the worktree-mutex lock (that
// hook fires only on `git commit`).
//
// Usage:
//   node scripts/worktree-changeset.mjs [<worktree-path>] [--stat] [--name-only]
//
//   <worktree-path>  Absolute or relative path to the worktree to inspect.
//                    Defaults to the current directory's worktree.
//   --stat           (default) Show tracked diff as a --stat summary.
//   --name-only      Show tracked changes as names only (terser).
//   --full           Show the full tracked unified diff instead of --stat.
//
// Exit code is 0 on success, 1 only if the target path is not a git worktree.
// (It is a read tool; it does not gate anything.)

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const pathArg = argv.find((a) => !a.startsWith("-"));
  const target = resolve(pathArg ?? process.cwd());

  let top, branch;
  try {
    top = git(["rev-parse", "--show-toplevel"], target).trim();
  } catch {
    process.stderr.write(`[changeset] '${target}' is not inside a git worktree.\n`);
    process.exit(1);
  }
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], top).trim();
  } catch {
    branch = "DETACHED";
  }

  // Porcelain status: covers staged, unstaged, AND untracked (??) in one pass.
  const status = git(["status", "--short", "--untracked-files=all"], top);
  const lines = status.split(/\r?\n/).filter(Boolean);

  const untracked = lines.filter((l) => l.startsWith("??")).map((l) => l.slice(3));
  const tracked = lines.filter((l) => !l.startsWith("??"));

  process.stdout.write(`# Changeset for worktree: ${top}\n`);
  process.stdout.write(`# Branch: ${branch}\n`);
  process.stdout.write(
    `# ${tracked.length} tracked change(s), ${untracked.length} untracked file(s)\n\n`,
  );

  // --- Tracked changes ---
  process.stdout.write(`## Tracked changes\n`);
  if (tracked.length === 0) {
    process.stdout.write(`(none)\n\n`);
  } else {
    let diffArgs;
    if (flags.has("--full")) diffArgs = ["diff", "HEAD"];
    else if (flags.has("--name-only")) diffArgs = ["diff", "HEAD", "--name-only"];
    else diffArgs = ["diff", "HEAD", "--stat"]; // default
    // `diff HEAD` shows staged + unstaged together.
    try {
      process.stdout.write(git(diffArgs, top));
    } catch {
      // No HEAD yet (unborn branch) — fall back to plain status lines.
      process.stdout.write(tracked.join("\n") + "\n");
    }
    process.stdout.write(`\n`);
  }

  // --- Untracked files (the part `git diff` hides) ---
  process.stdout.write(`## Untracked files (NOT shown by 'git diff')\n`);
  if (untracked.length === 0) {
    process.stdout.write(`(none)\n`);
  } else {
    for (const f of untracked) process.stdout.write(`?? ${f}\n`);
    process.stdout.write(
      `\nRead these directly to review their contents (they have no diff yet).\n`,
    );
  }
}

main();
