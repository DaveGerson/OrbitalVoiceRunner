// Flat ESLint config (ESM) — TEST-ONLY, for the complexity-gate fixtures.
//
// Uses `complexity: ['error', 4]` so that EVERY fixture (cc-05 and up) exceeds
// the max. When the threshold is lower than a function's actual complexity, the
// rule message embeds the exact computed value (e.g. "has a complexity of 5"),
// which is what `tests/test_complexity_gate.ts` asserts against.
//
// Deliberately NO ignores — the fixtures live under tests/, which the production
// config ignores; here we want them linted.
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  rules: {
    complexity: ['error', 4],
  },
});
