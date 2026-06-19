// tests/test_suppressions_ratchet.ts — unit tests for the per-file ratchet guard's
// pure logic (scripts/check-suppressions-ratchet.mjs). Proves the guard catches the
// `eslint . --suppress-all` bypass that the total-count ceiling alone cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRatchet, complexityCounts } from '../scripts/check-suppressions-ratchet.mjs';

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
