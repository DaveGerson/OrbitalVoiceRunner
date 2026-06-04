// scripts/check-deps.mjs — fast "is node_modules in sync with package.json?" guard.
//
// WHY THIS EXISTS: a pull/checkout that changes package.json (e.g. Wave D adding `zod`) does NOT
// reinstall node_modules. The next `tsc --noEmit` then fails with a cryptic "cannot find module
// 'zod'". This turns that into an actionable message and is wired into the post-merge/post-checkout
// git hooks (warn mode) so the gap is caught right after the pull that caused it.
//
// CONSTRAINT: uses ONLY Node built-ins. It must run even when node_modules is broken — a guard that
// depended on tsx/zod could not run in exactly the situation it is meant to detect.
//
// CLI:  node scripts/check-deps.mjs          -> exit 1 if any declared dep is missing (CI/preflight)
//       node scripts/check-deps.mjs --warn   -> print the warning but always exit 0 (git hooks)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure: returns the names of declared dependencies (deps + devDeps) whose
 * node_modules/<name>/package.json is absent under `root`. Empty array = in sync.
 */
export function findMissingDeps(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return Object.keys(declared).filter(
    (name) => !fs.existsSync(path.join(root, "node_modules", name, "package.json")),
  );
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const warnOnly = process.argv.includes("--warn");
  const missing = findMissingDeps(root);
  if (missing.length > 0) {
    process.stderr.write(
      `⚠ node_modules is out of sync with package.json — missing: ${missing.join(", ")}.\n` +
        `  A recent pull/checkout changed dependencies. Run \`npm ci\` (or \`npm install\`) before lint/test/dev.\n`,
    );
    process.exit(warnOnly ? 0 : 1);
  }
  const count = Object.keys({
    ...(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies ?? {}),
  }).length;
  process.stdout.write(`deps ok (${count} runtime packages present)\n`);
}

// Run main() only when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
