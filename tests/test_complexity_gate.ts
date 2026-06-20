// Proves the cyclomatic-complexity gate is CORRECT, not merely present:
//   1. ESLint reports the EXACT hand-counted complexity of a known function.
//   2. The rule fires when complexity > max and passes when complexity <= max.
//
// The boundary is proven by varying `max` against ONE realistic fixture — ESLint's
// threshold logic (`complexity > max`) is identical at any number, so there's no need
// for a contrived function pinned to 10. The PRODUCTION threshold (10) firing on real
// over-limit code is covered end-to-end by tests/test_complexity_ratchet.ts (the smoke
// test through the real eslint.config.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixture = path.join(repoRoot, 'tests', 'fixtures', 'complexity', 'username-validator.ts');
const prodConfig = path.join(repoRoot, 'eslint.config.js');

// validateUsername's hand-counted cyclomatic complexity (see the fixture's comment).
const FIXTURE_CC = 6;

function eslintAt(max: number): ESLint {
  return new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      // A `files` pattern is REQUIRED in flat config — without it ESLint silently
      // ignores the file and returns zero messages, a false pass for any
      // "expect no violations" assertion.
      files: ['**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      },
      rules: { complexity: ['error', max] },
    },
  });
}

function complexityMessages(result: ESLint.LintResult) {
  return result.messages.filter((m) => m.ruleId === 'complexity');
}

test(`reports the exact hand-counted complexity (${FIXTURE_CC})`, async () => {
  // max:0 => the rule reports every function, embedding its computed CC in the message.
  const [res] = await eslintAt(0).lintFiles([fixture]);
  const msgs = complexityMessages(res);
  assert.equal(msgs.length, 1, `expected exactly one complexity message, got ${msgs.length}`);
  assert.match(msgs[0].message, new RegExp(`complexity of ${FIXTURE_CC}\\b`), msgs[0].message);
});

test('passes when complexity <= max (boundary: equal is allowed)', async () => {
  const [res] = await eslintAt(FIXTURE_CC).lintFiles([fixture]);
  assert.equal(complexityMessages(res).length, 0);
});

test('fails when complexity > max (boundary: one over is flagged)', async () => {
  const [res] = await eslintAt(FIXTURE_CC - 1).lintFiles([fixture]);
  assert.equal(complexityMessages(res).length, 1);
});

test('production eslint.config.js loads without a config error', async () => {
  const eslint = new ESLint({ overrideConfigFile: prodConfig });
  await eslint.calculateConfigForFile(path.join(repoRoot, 'server.ts'));
});
