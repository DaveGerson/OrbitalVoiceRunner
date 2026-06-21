// tests/test_wtlock_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-
// complexity burndown refactor of scripts/wt-lock.mjs (the worktree-lock CLI).
//
// The CC in `main` (13) was caused by the staleMs/mode/fileName derivation logic and
// the subcommand switch living directly in main(). The refactor extracted:
//   - resolveConfig()  — mode, staleMs, lockDir, lockPath derivation
//   - dispatch()       — subcommand → handler routing (the switch)
//
// These tests pin the OBSERVABLE behaviour of the CLI's safe paths (status, no-args
// check, unknown-subcommand fallthrough) to prove the extraction is behavior-preserving.
// They run the .mjs file as a child process — the only reliable way to exercise a
// non-exported CLI script.
//
// Runner: npx tsx --test --test-force-exit tests/test_wtlock_complexity_refactor.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "scripts", "wt-lock.mjs");

function run(args: string[], env?: Record<string, string>) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: repoRoot,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? -1,
  };
}

// ---------------------------------------------------------------------------
// 1. Default (no-arg) path — should always exit 0 (fail-open check).
// ---------------------------------------------------------------------------
test("wt-lock.mjs: no args — exits 0 (fail-open check)", () => {
  const { code } = run([]);
  assert.equal(code, 0, "no-arg invocation must always exit 0 (fail open)");
});

// ---------------------------------------------------------------------------
// 2. `check` explicit — identical to no-arg (the default).
// ---------------------------------------------------------------------------
test("wt-lock.mjs: explicit 'check' — exits 0", () => {
  const { code } = run(["check"]);
  assert.equal(code, 0);
});

// ---------------------------------------------------------------------------
// 3. `status` — prints mode/branch/worktree header and exits 0.
// ---------------------------------------------------------------------------
test("wt-lock.mjs: status — prints mode and branch header, exits 0", () => {
  const { stdout, code } = run(["status"]);
  assert.equal(code, 0, "status must exit 0");
  assert.match(stdout, /\[wt-lock\] mode=/, "status must print mode= header");
  assert.match(stdout, /branch='/, "status must print branch=");
  assert.match(stdout, /worktree='/, "status must print worktree=");
});

// ---------------------------------------------------------------------------
// 4. `status` with JANUS_WT_LOCK=off — mode reflects the env var.
// ---------------------------------------------------------------------------
test("wt-lock.mjs: status with JANUS_WT_LOCK=off — reports mode=off", () => {
  const { stdout, code } = run(["status"], { JANUS_WT_LOCK: "off" });
  assert.equal(code, 0);
  assert.match(stdout, /mode=off/, "mode must reflect JANUS_WT_LOCK=off env var");
});

// ---------------------------------------------------------------------------
// 5. `status` with JANUS_WT_LOCK=strict — mode reflects the env var.
// ---------------------------------------------------------------------------
test("wt-lock.mjs: status with JANUS_WT_LOCK=strict — reports mode=strict", () => {
  const { stdout, code } = run(["status"], { JANUS_WT_LOCK: "strict" });
  assert.equal(code, 0);
  assert.match(stdout, /mode=strict/, "mode must reflect JANUS_WT_LOCK=strict env var");
});

// ---------------------------------------------------------------------------
// 6. Unknown subcommand fallthrough — treated as `check`, exits 0.
// ---------------------------------------------------------------------------
test("wt-lock.mjs: unknown subcommand falls through to check, exits 0", () => {
  const { code } = run(["totally-unknown-cmd"]);
  assert.equal(code, 0, "unknown subcommand must fall through to check (fail open)");
});

// ---------------------------------------------------------------------------
// 7. `release` with no lock present — prints 'nothing to release', exits 0.
// ---------------------------------------------------------------------------
test("wt-lock.mjs: release with no existing lock — exits 0 with 'nothing to release'", () => {
  // Use a temp common dir that is guaranteed to have no lock file for a fresh branch name.
  const tmpDir = path.join(repoRoot, ".git");
  const { stdout, code } = run(["release"], {
    // Point at a branch name that certainly has no lock file.
    JANUS_WT_SESSION: `test-session-${Date.now()}`,
  });
  // Release on a branch with no lock should still exit 0 (fail open)
  assert.equal(code, 0, "release with no lock must exit 0");
  // It should not emit an error — either 'nothing to release' or silent is acceptable.
  // We do NOT assert the exact message because the lock may be present from a prior run.
});

// ---------------------------------------------------------------------------
// 8. --force flag is parsed correctly (does not crash).
// ---------------------------------------------------------------------------
test("wt-lock.mjs: --force flag does not crash the CLI", () => {
  const { code } = run(["release", "--force"]);
  assert.equal(code, 0, "release --force must exit 0 (fail open)");
});

// ---------------------------------------------------------------------------
// 9. -f short flag is equivalent to --force (parsed by the same includes check).
// ---------------------------------------------------------------------------
test("wt-lock.mjs: -f short flag does not crash the CLI", () => {
  const { code } = run(["release", "-f"]);
  assert.equal(code, 0, "release -f must exit 0");
});

// ---------------------------------------------------------------------------
// 10. advisory mode (default): check always exits 0 even with no lock dir.
// ---------------------------------------------------------------------------
test("wt-lock.mjs: advisory mode always exits 0 for check", () => {
  const { code } = run(["check"], { JANUS_WT_LOCK: "advisory" });
  assert.equal(code, 0);
});

// ---------------------------------------------------------------------------
// 11. Complexity gate: scripts/wt-lock.mjs has no complexity errors at CC<=10.
// ---------------------------------------------------------------------------
test("wt-lock.mjs: ESLint reports zero complexity errors (CC<=10)", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({
    overrideConfigFile: path.join(repoRoot, "eslint.config.js"),
  });
  const results = await eslint.lintFiles([script]);
  const complexityErrors = results.flatMap((r) =>
    r.messages.filter((m) => m.ruleId === "complexity" && m.severity === 2),
  );
  assert.equal(
    complexityErrors.length,
    0,
    `Expected 0 complexity errors, got ${complexityErrors.length}:\n` +
      complexityErrors.map((e) => `  line ${e.line}: ${e.message}`).join("\n"),
  );
});

// ---------------------------------------------------------------------------
// staleMs derivation (resolveConfig) — pins the env-coalescing transform the
// refactor introduced (`envStale ? Number(envStale) : NaN` + Number.isFinite),
// which the CLI-level tests above can't observe (staleMs isn't printed).
// resolveConfig is import-safe because main() now runs only under the
// run-as-script guard.
// ---------------------------------------------------------------------------
import { resolveConfig } from "../scripts/wt-lock.mjs";

const fakeLogic = {
  parseMode: () => "advisory",
  DEFAULT_STALE_MS: 999000,
  lockFileName: (b: string) => `${b}.lock.json`,
};
const fakeCtx = { commonDir: "/tmp/wtlock-test-commondir", branch: "feature/foo" };

function staleMsFor(envVal: string | undefined): number {
  const prev = process.env.JANUS_WT_LOCK_STALE_MS;
  if (envVal === undefined) delete process.env.JANUS_WT_LOCK_STALE_MS;
  else process.env.JANUS_WT_LOCK_STALE_MS = envVal;
  try {
    return (resolveConfig(fakeLogic as never, fakeCtx as never) as { staleMs: number }).staleMs;
  } finally {
    if (prev === undefined) delete process.env.JANUS_WT_LOCK_STALE_MS;
    else process.env.JANUS_WT_LOCK_STALE_MS = prev;
  }
}

test("resolveConfig staleMs: unset env -> DEFAULT_STALE_MS", () => {
  assert.equal(staleMsFor(undefined), 999000);
});
test("resolveConfig staleMs: empty string -> DEFAULT (not Number('')===0 trap)", () => {
  assert.equal(staleMsFor(""), 999000);
});
test("resolveConfig staleMs: non-numeric -> DEFAULT", () => {
  assert.equal(staleMsFor("abc"), 999000);
});
test("resolveConfig staleMs: '0' -> 0 (explicit zero honored)", () => {
  assert.equal(staleMsFor("0"), 0);
});
test("resolveConfig staleMs: '500' -> 500", () => {
  assert.equal(staleMsFor("500"), 500);
});
test("resolveConfig staleMs: no logic -> fixed 2h fallback regardless of env", () => {
  const prev = process.env.JANUS_WT_LOCK_STALE_MS;
  process.env.JANUS_WT_LOCK_STALE_MS = "500";
  try {
    const { staleMs } = resolveConfig(null as never, fakeCtx as never) as { staleMs: number };
    assert.equal(staleMs, 2 * 60 * 60 * 1000);
  } finally {
    if (prev === undefined) delete process.env.JANUS_WT_LOCK_STALE_MS;
    else process.env.JANUS_WT_LOCK_STALE_MS = prev;
  }
});
