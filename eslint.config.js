// Flat ESLint config (ESM) — cyclomatic-complexity gate + cognitive-complexity advisory.
//
// Gate:     `complexity: ['error', 10]`            (McCabe / NIST limit)
// Advisory: `sonarjs/cognitive-complexity: ['warn', 15]`
//
// The sonarjs plugin is REGISTERED but we enable ONLY its cognitive-complexity
// rule — we deliberately do NOT adopt its full recommended rule set as policy.
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  {
    // Global ignores (a config object with ONLY `ignores` is global per flat-config).
    ignores: [
      'tests/**',
      'dist/**',
      'node_modules/**',
      '**/*.generated.ts',
      'python/**',
      'playwright.config*',
      'vite.config*',
      '**/*.cjs',
      'server.js',
    ],
  },
  {
    // Gate ALL first-party source: .ts/.tsx app code (incl. React components,
    // where UI complexity concentrates) and .ts/.mjs build+CI scripts. Leaving
    // .tsx/.mjs ungated was a real hole — a 13-branch render function would pass.
    files: ['server.ts', 'src/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      sonarjs,
    },
    rules: {
      complexity: ['error', 10],
      'sonarjs/cognitive-complexity': ['warn', 15],
    },
  },
);
