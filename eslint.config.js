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
    // Test code (tests/**, e2e/**) is INTENTIONALLY exempt — it is legitimately branchy
    // and not production logic (same call as excluding tests/**). Everything else that
    // isn't first-party source (build output, vendored stubs, generated, configs) is
    // excluded here rather than by narrowing the `files` set below.
    ignores: [
      'tests/**',
      'e2e/**',
      'dist/**',
      'node_modules/**',
      'stubs/**',
      'public/**',
      'python/**',
      '**/*.generated.ts',
      'playwright.config*',
      'vite.config*',
      'server.js',
    ],
  },
  {
    // Gate by EXTENSION across the whole tree (minus the ignores above) rather than by
    // an allowlist of locations. A location allowlist fails OPEN: a new top-level dir, a
    // new root-level file, or a .jsx/.mts/.cts/.cjs would silently escape the gate. With
    // an extension match, any NEW first-party source is gated by default. JSX is enabled
    // so .tsx React components (where UI complexity concentrates) are covered.
    files: ['**/*.{ts,tsx,mts,cts,mjs,cjs,jsx}'],
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
