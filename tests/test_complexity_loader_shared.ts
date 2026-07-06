// tests/test_complexity_loader_shared.ts — DRIFT GUARD for the orbital
// complexity-refactor characterization tests (bead wsm-e2e-pinned-cdo).
//
// A handful of `*_complexity_refactor.ts` tests load a .tsx component graph that
// pulls in Vite-only imports (icons.svg?raw, react). Each used to carry its OWN
// inline copy of the ESM stub loader (module.register data-URL hook). Those copies
// DRIFTED: only some had the .svg/?raw fix, which is exactly how the bug hid in a
// 6th file mid-session.
//
// Invariant enforced here: the vite-stub loader lives in EXACTLY ONE place
// (tests/helpers/viteStubLoader.ts). No complexity-refactor test may reimplement
// it inline. (Most of these tests import pure .ts modules and need no loader at
// all — this guard does NOT force them to; it only forbids inline copies.)
//
// Runner: npx tsx --test --test-force-exit tests/test_complexity_loader_shared.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith("_complexity_refactor.ts"))
  .sort();

// Signatures of an inline vite-stub loader. Any match means a copy has been
// pasted into a test instead of importing the shared helper.
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /from\s+["']node:module["']/, why: "imports node:module — register() belongs only in the shared helper" },
  { re: /\bhookSource\b/, why: "defines an inline hookSource — hoist it to the shared helper" },
  { re: /react\/jsx-runtime/, why: "inlines a react stub — hoist it to the shared helper" },
  { re: /\bregister\s*\(\s*[`'"]data:text\/javascript/, why: "registers a data-URL ESM hook inline — use the shared helper" },
];

test("complexity-refactor characterization tests exist to guard", () => {
  assert.ok(files.length >= 1, "expected at least one *_complexity_refactor.ts file in tests/");
});

for (const f of files) {
  test(`${f} carries no inline vite-stub loader`, () => {
    const src = readFileSync(join(here, f), "utf8");
    for (const { re, why } of FORBIDDEN) {
      assert.doesNotMatch(src, re, `${f}: ${why} (see tests/helpers/viteStubLoader.ts)`);
    }
  });
}

// The single source of truth must exist and actually be wired into at least one
// test — so this guard fails loudly if someone deletes the helper and re-inlines.
test("the shared vite-stub loader exists and is wired in", () => {
  assert.ok(
    existsSync(join(here, "helpers", "viteStubLoader.ts")),
    "tests/helpers/viteStubLoader.ts must exist (the one shared loader)",
  );
  const anyUses = files.some((f) =>
    /registerViteStubs/.test(readFileSync(join(here, f), "utf8")),
  );
  assert.ok(
    anyUses,
    "at least one complexity-refactor test must import registerViteStubs from the shared helper",
  );
});
