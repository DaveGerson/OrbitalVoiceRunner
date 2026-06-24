// Flat ESLint config (ESM) — complexity gates (McCabe + cognitive) + react-hooks.
//
// Gate: `complexity: ['error', 10]`                  (McCabe / NIST path count)
// Gate: `sonarjs/cognitive-complexity: ['error', 15]` (human-readability / nesting)
// Gate: `react-hooks/rules-of-hooks: 'error'`         (hook-order correctness)
// Advisory: `react-hooks/exhaustive-deps: 'warn'`     (stale-closure hints; the codebase's
//           unstable-body-fn idiom makes erroring it disable-noisy — kept advisory on purpose)
//
// The sonarjs plugin is REGISTERED but we enable ONLY its cognitive-complexity
// rule — we deliberately do NOT adopt its full recommended rule set as policy.
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import reactHooks from 'eslint-plugin-react-hooks';

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
      // Nested git worktrees (.claude/worktrees/<task>) carry foreign/older code — and a
      // bare `eslint .` from the repo root would otherwise descend into them and lint that
      // code against this tree's gates, producing false-reds. Never lint .claude/ from root.
      '.claude/**',
      'stubs/**',
      'public/**',
      'python/**',
      '**/*.generated.ts',
      'playwright.config*',
      'vite.config*',
      // vitest.config.ts / vitest.setup.ts are test-runner config (same class as vite.config*):
      // infra, not first-party product logic, so they're exempt from the CC gate.
      'vitest.config*',
      'vitest.setup*',
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
      'react-hooks': reactHooks,
    },
    rules: {
      complexity: ['error', 10],
      'sonarjs/cognitive-complexity': ['error', 15],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
