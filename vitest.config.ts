/**
 * Vitest config — the component-test runner (bead dbt4, PR-B).
 *
 * This is the SECOND test runner in the repo, deliberately partitioned from the existing
 * node:test unit lane:
 *   - node:test owns  tests/*.ts          (the 3000+ logic/server suite, run via `npm test`)
 *   - vitest   owns  src/**\/*.test.tsx   (jsdom + RTL component tests, run via `test:component`)
 * The globs are disjoint so the two runners can never pick up each other's files.
 *
 * We MERGE the real vite.config.ts rather than re-declaring the @ alias / react() plugin /
 * tailwind, so the component tests resolve imports exactly the way the app does.
 */
import {defineConfig, mergeConfig} from 'vitest/config';
import viteConfig from './vite.config';

// vite.config.ts exports a CONFIG FUNCTION (defineConfig(() => ({...}))), and mergeConfig only
// merges plain config objects — so resolve it for the test command/mode first. This reuses the
// app's @ alias + react() + tailwind without re-declaring any of them.
const resolvedViteConfig = viteConfig({command: 'serve', mode: 'test'});

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: false, // tests import {describe,it,expect,vi} from 'vitest' explicitly.
      setupFiles: ['./vitest.setup.ts'],
      include: ['src/**/*.test.{tsx,jsx}'],
      // Keep the node:test suites (tests/**) and Playwright specs (e2e/**) out of vitest;
      // 'default' preserves vitest's own ignores (node_modules, dist, .git, ...).
      exclude: ['e2e/**', 'tests/**', '**/node_modules/**', '**/dist/**'],
      // Do NOT parse CSS — components import xterm.css / index.css transitively and there is
      // no styling under test; parsing it only adds cost and a tailwind/postcss failure surface.
      css: false,
    },
  }),
);
