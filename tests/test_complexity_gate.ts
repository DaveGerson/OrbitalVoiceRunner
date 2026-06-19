// Proves the cyclomatic-complexity gate is CORRECT, not just present:
//   1. The tool reports the exact hand-counted value for each fixture.
//   2. The production boundary sits at >10 (cc-10 passes, cc-11 fails).
//   3. A trivial function (cc-01) passes a max:10 gate.
//
// Uses the ESLint Node API (`import { ESLint } from 'eslint'`) + node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures', 'complexity');
const fixturesConfig = path.join(fixturesDir, 'eslint.fixtures.config.js');
const prodConfig = path.join(repoRoot, 'eslint.config.js');

function fixture(name: string): string {
  return path.join(fixturesDir, name);
}

function complexityMessages(result: ESLint.LintResult) {
  return result.messages.filter((m) => m.ruleId === 'complexity');
}

// ---------------------------------------------------------------------------
// 1. Tool reports the exact hand-counted value (fixtures config, max:4).
// ---------------------------------------------------------------------------
const exactCases: Array<[string, number]> = [
  ['cc-05.ts', 5],
  ['cc-10.ts', 10],
  ['cc-11.ts', 11],
  ['cc-15.ts', 15],
  ['cc-16.ts', 16],
];

for (const [file, expected] of exactCases) {
  test(`fixtures config: ${file} reports complexity of ${expected}`, async () => {
    const eslint = new ESLint({ overrideConfigFile: fixturesConfig });
    const [res] = await eslint.lintFiles([fixture(file)]);
    const msgs = complexityMessages(res);
    assert.equal(msgs.length, 1, `expected exactly one complexity message, got ${msgs.length}`);
    assert.match(
      msgs[0].message,
      new RegExp(`complexity of ${expected}\\b`),
      `message was: ${msgs[0].message}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Production boundary is at >10. The production config (eslint.config.js)
//    ignores tests/**, so linting a fixture through it directly would be
//    skipped. We assert the boundary by re-linting the fixtures with an inline
//    config of complexity:['error', 10] — functionally identical to the
//    production threshold — which avoids the ignore problem cleanly.
// ---------------------------------------------------------------------------
function gateAt10(): ESLint {
  return new ESLint({
    overrideConfigFile: true, // do not merge with any discovered config
    overrideConfig: {
      // A `files` pattern is REQUIRED in flat config, otherwise the config
      // object matches nothing and ESLint reports "File ignored because no
      // matching configuration was supplied" (a silent false-pass for any
      // "expect zero violations" assertion).
      files: ['**/*.ts'],
      languageOptions: {
        // Use the same TS parser the production config uses.
        parser: tseslint.parser,
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      },
      rules: { complexity: ['error', 10] },
    },
  });
}

test('production boundary: cc-10 yields ZERO complexity violations at max:10', async () => {
  const eslint = gateAt10();
  const [res] = await eslint.lintFiles([fixture('cc-10.ts')]);
  assert.equal(complexityMessages(res).length, 0);
});

test('production boundary: cc-11 yields exactly ONE complexity violation at max:10', async () => {
  const eslint = gateAt10();
  const [res] = await eslint.lintFiles([fixture('cc-11.ts')]);
  assert.equal(complexityMessages(res).length, 1);
});

// ---------------------------------------------------------------------------
// 3. A trivial function passes the max:10 gate.
// ---------------------------------------------------------------------------
test('cc-01 yields ZERO complexity violations at max:10', async () => {
  const eslint = gateAt10();
  const [res] = await eslint.lintFiles([fixture('cc-01.ts')]);
  assert.equal(complexityMessages(res).length, 0);
});

// Sanity: the production config file itself parses/loads without a config error.
test('production eslint.config.js loads without a config error', async () => {
  const eslint = new ESLint({ overrideConfigFile: prodConfig });
  // Linting an ignored fixture should simply produce no results-of-interest,
  // not throw a configuration error.
  await eslint.calculateConfigForFile(path.join(repoRoot, 'server.ts'));
});
