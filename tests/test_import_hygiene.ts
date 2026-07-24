// tests/test_import_hygiene.ts — bead c1ky (insight c): a guard that fails if ANY tests/ file
// STATICALLY value-imports root server.ts.
//
// WHY THIS IS A NODE:TEST FILE, NOT AN ESLINT RULE: tests/** is globally UNLINTED
// (eslint.config.js only globs src/**, scripts/**, *.tsx — see its ignores/includes), so an
// eslint no-restricted-imports rule would never even run against tests/. This guard is a plain
// regex sweep over tests/**/*.ts instead.
//
// WHAT IT BANS: a top-of-file `import ... from "../server"` / `"../../server"` VALUE import —
// the pattern that drags server.ts's eager module-scope boot (autostart bind, JanusStore root)
// into every importing test FILE at load time, before any hook can set JANUS_NO_AUTOSTART or
// chdir into a tmpdir (bead wsm-e2e-pinned-bxpk's fingerprint). `import type { ... } from
// "../server"` and `await import("../server")` are both fine (type-only erases at compile time;
// dynamic import defers evaluation until the call site, which every server-booting suite already
// gates behind a chdir/env-guard) — the guard must NOT flag either.
//
// Runner: npx tsx --test --test-force-exit tests/test_import_hygiene.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const testsDir = path.join(repoRoot, "tests");

// Bans a static VALUE import of root server.ts (any depth of "../"), e.g.:
//   import { setLiveConnector } from "../../server";
//   import server from "../server";
// but NOT:
//   import type { RunningServer } from "../server";
//   await import("../server");
const BANNED_IMPORT = /^\s*import\s+(?!type\b)[^;]*\bfrom\s*['"](?:\.\.\/)+server['"]/;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function findOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of walkTsFiles(testsDir)) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (BANNED_IMPORT.test(line)) {
        offenders.push(`${rel}:${idx + 1}`);
      }
    });
  }
  return offenders.sort();
}

test("no tests/** file statically value-imports root server.ts", () => {
  const offenders = findOffenders();
  assert.deepEqual(
    offenders,
    [],
    `static value-import(s) of root server.ts found (drags eager module-scope boot into ` +
      `import-time): ${offenders.join(", ")}. Use "await import(...)" or "import type" instead.`,
  );
});

test("positive control: `import type` from server is NOT flagged", () => {
  assert.equal(BANNED_IMPORT.test('import type { RunningServer } from "../server";'), false);
  assert.equal(
    BANNED_IMPORT.test('import type { RunningServer, StartServerOptions } from "../server";'),
    false,
  );
});

test("positive control: dynamic `await import(...)` is NOT flagged", () => {
  assert.equal(BANNED_IMPORT.test('const serverMod = await import("../server");'), false);
  assert.equal(BANNED_IMPORT.test('await import("../../server");'), false);
});

test("negative control: a bare value-import of server IS flagged", () => {
  assert.equal(BANNED_IMPORT.test('import { setLiveConnector } from "../../server";'), true);
  assert.equal(BANNED_IMPORT.test('import server from "../server";'), true);
});
