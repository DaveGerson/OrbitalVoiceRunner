// tests/test_suppressions_ratchet.ts — unit tests for the per-file ratchet guard's
// pure logic (scripts/check-suppressions-ratchet.mjs). Proves the guard catches the
// `eslint . --suppress-all` bypass that the total-count ceiling alone cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRatchet, complexityCounts } from '../scripts/check-suppressions-ratchet.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'check-suppressions-ratchet.mjs');

const supp = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).map(([f, c]) => [f, { complexity: { count: c } }]));

test('FAIL: an existing file’s complexity count increases', () => {
  const r = evaluateRatchet(supp({ 'a.ts': 3 }), supp({ 'a.ts': 4 }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.growth, [{ file: 'a.ts', base: 3, current: 4 }]);
});

test('FAIL: a NEW file key appears (the --suppress-all bypass signature)', () => {
  const r = evaluateRatchet(supp({ 'a.ts': 3 }), supp({ 'a.ts': 3, 'b.ts': 2 }));
  assert.equal(r.ok, false);
  assert.ok(r.growth.some((g) => g.file === 'b.ts' && g.base === 0 && g.current === 2));
});

test('PASS: counts shrink / files pruned (legitimate ratchet down)', () => {
  // b.ts fixed & pruned, a.ts reduced 3 -> 1
  const r = evaluateRatchet(supp({ 'a.ts': 3, 'b.ts': 2 }), supp({ 'a.ts': 1 }));
  assert.equal(r.ok, true);
  assert.equal(r.growth.length, 0);
});

test('PASS: identical baselines', () => {
  const r = evaluateRatchet(supp({ 'a.ts': 3 }), supp({ 'a.ts': 3 }));
  assert.equal(r.ok, true);
});

test('cognitive-complexity entries are ignored (only complexity is gated)', () => {
  const cur = { 'a.ts': { 'sonarjs/cognitive-complexity': { count: 9 } } };
  assert.deepEqual(complexityCounts(cur), {});
  assert.equal(evaluateRatchet({}, cur).ok, true);
});

// The CLI must FAIL CLOSED when the base ref doesn't resolve (shallow/fork clone),
// instead of mistaking it for "no baseline yet" and passing blind.
test('CLI exits non-zero when the base ref is unresolvable (fail closed)', () => {
  let code = 0;
  try {
    execFileSync('node', [SCRIPT, '--base', 'definitely-not-a-ref-xyz123'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err: any) {
    code = err.status ?? 1;
  }
  assert.equal(code, 1, 'expected fail-closed exit 1 for an unresolvable base ref');
});

test('CLI passes against a resolvable base (HEAD) — current tree does not grow vs HEAD', () => {
  // HEAD always resolves and matches the committed baseline, so this is a clean pass.
  execFileSync('node', [SCRIPT, '--base', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] });
});
