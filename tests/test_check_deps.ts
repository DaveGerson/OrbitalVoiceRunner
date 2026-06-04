// tests/test_check_deps.ts — guard for the "stale node_modules after a pull" class of failure.
//
// Root cause it defends (Wave D zod incident): a pull updated package.json + package-lock.json to
// add `zod`, but node_modules was NOT reinstalled, so `tsc --noEmit` (lint) broke with a cryptic
// "cannot find module 'zod'". findMissingDeps() turns that into an actionable signal: it lists every
// DECLARED dependency whose node_modules/<name>/package.json is absent.
//
// The implementation lives in scripts/check-deps.mjs and uses ONLY Node built-ins on purpose — it
// must run even when node_modules is broken (a tsx/zod-dependent guard could not).
//
// Runner: npx tsx --test --test-force-exit tests/test_check_deps.ts

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findMissingDeps } from "../scripts/check-deps.mjs";

function scaffold(opts: {
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  present: string[];
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-deps-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: opts.deps ?? {}, devDependencies: opts.devDeps ?? {} }),
  );
  for (const name of opts.present) {
    const p = path.join(dir, "node_modules", name);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "package.json"), JSON.stringify({ name }));
  }
  return dir;
}

test("findMissingDeps flags a declared dep whose node_modules entry is absent (the zod-after-pull case)", () => {
  const dir = scaffold({ deps: { zod: "^4.4.3", express: "^4.21.2" }, present: ["express"] });
  assert.deepStrictEqual(findMissingDeps(dir), ["zod"]);
});

test("findMissingDeps returns [] when every declared dep is installed", () => {
  const dir = scaffold({ deps: { zod: "^4.4.3", express: "^4.21.2" }, present: ["zod", "express"] });
  assert.deepStrictEqual(findMissingDeps(dir), []);
});

test("findMissingDeps checks devDependencies too", () => {
  const dir = scaffold({
    deps: { zod: "^4.4.3" },
    devDeps: { tsx: "^4.21.0", typescript: "~5.8.2" },
    present: ["zod", "tsx"],
  });
  assert.deepStrictEqual(findMissingDeps(dir), ["typescript"]);
});
