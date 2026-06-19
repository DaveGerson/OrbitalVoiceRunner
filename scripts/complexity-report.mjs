// scripts/complexity-report.mjs — churn × complexity HOTSPOT report (evaluation, not a gate).
//
// WHAT IT MEASURES
//   For every function in the gated source set (server.ts, src/**/*.ts, scripts/**/*.ts)
//   it extracts the function's cyclomatic complexity (CC) straight out of ESLint, then
//   weights each file by how often it changes (git churn). The headline metric is:
//
//       score = churn * sumCC          (sumCC = sum of CC over functions with CC > 10)
//
//   i.e. files that are BOTH actively edited AND structurally complex float to the top.
//   Simple files (no function over the limit) score 0 and drop out of the ranking.
//
// HOW PER-FUNCTION CC IS OBTAINED
//   ESLint's built-in `complexity` rule embeds the computed number in its message
//   ("...has a complexity of N..."). We lint with an INLINE override config of
//   `complexity: ['warn', 0]` — a max of 0 forces the rule to report EVERY function,
//   so each message yields that function's CC, which we parse with /complexity of (\d+)/.
//   This pass is deliberately INDEPENDENT of the production gate and the committed
//   eslint-suppressions.json baseline: we want to see ALL values, including the ones
//   that are baselined out of the production gate.
//
// WHY IT EXISTS
//   This drives Phase 6 target selection: rank by score, refactor the top hotspots first.
//
// USAGE
//   node scripts/complexity-report.mjs [--limit N] [--format table|json]
//     --limit  N      rows to print (default 30)
//     --format table  human-readable aligned table (default)
//     --format json   array of { file, churn, violations, maxCC, sumCC, score }
//
// No extra dependencies: built only from the ESLint Node API + git.

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const CC_GATE = 10; // production threshold; functions strictly above this are "violations"

function parseArgs(argv) {
  const args = { limit: 30, format: 'table' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      args.limit = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(args.limit) || args.limit <= 0) args.limit = 30;
    } else if (a === '--format') {
      const v = argv[++i];
      if (v === 'table' || v === 'json') args.format = v;
    }
  }
  return args;
}

// Count commits that touched a file. Files with no history (new/untracked) fall back to 1
// so their score isn't zeroed out by churn alone.
function churnFor(relPath) {
  try {
    const out = execFileSync('git', ['rev-list', '--count', 'HEAD', '--', relPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1; // no git / no history
  }
}

async function collect() {
  // Inline override: max 0 makes the rule report EVERY function (independent of the
  // production config / suppressions). Same parser as production.
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        rules: { complexity: ['warn', 0] },
      },
    ],
  });

  // Same gated source set as the production gate.
  const results = await eslint.lintFiles(['server.ts', 'src/**/*.ts', 'scripts/**/*.ts']);

  const rows = [];
  for (const res of results) {
    const ccs = [];
    for (const m of res.messages) {
      if (m.ruleId !== 'complexity') continue;
      const match = /complexity of (\d+)/.exec(m.message);
      if (match) ccs.push(Number.parseInt(match[1], 10));
    }
    if (ccs.length === 0) continue;

    const maxCC = Math.max(...ccs);
    const over = ccs.filter((c) => c > CC_GATE);
    const violations = over.length;
    const sumCC = over.reduce((a, b) => a + b, 0);

    const relPath = path.relative(repoRoot, res.filePath).split(path.sep).join('/');
    const churn = churnFor(relPath);
    const score = churn * sumCC;

    rows.push({ file: relPath, churn, violations, maxCC, sumCC, score });
  }

  rows.sort((a, b) => b.score - a.score || b.sumCC - a.sumCC || b.maxCC - a.maxCC);
  return rows;
}

function printTable(rows) {
  const cols = [
    { key: 'score', label: 'SCORE', align: 'right' },
    { key: 'churn', label: 'CHURN', align: 'right' },
    { key: 'violations', label: 'VIOL', align: 'right' },
    { key: 'maxCC', label: 'MAXCC', align: 'right' },
    { key: 'sumCC', label: 'SUMCC', align: 'right' },
    { key: 'file', label: 'FILE', align: 'left' },
  ];
  const widths = {};
  for (const c of cols) {
    widths[c.key] = c.label.length;
    for (const r of rows) {
      widths[c.key] = Math.max(widths[c.key], String(r[c.key]).length);
    }
  }
  const fmt = (val, c) => {
    const s = String(val);
    return c.align === 'right' ? s.padStart(widths[c.key]) : s.padEnd(widths[c.key]);
  };
  const header = cols.map((c) => fmt(c.label, c)).join('  ');
  console.log(header);
  console.log(cols.map((c) => '-'.repeat(widths[c.key])).join('  '));
  for (const r of rows) {
    console.log(cols.map((c) => fmt(r[c.key], c)).join('  '));
  }
  if (rows.length === 0) {
    console.log('(no functions over CC ' + CC_GATE + ' found)');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = await collect();
  const ranked = all.filter((r) => r.score > 0).slice(0, args.limit);

  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(ranked, null, 2) + '\n');
  } else {
    printTable(ranked);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
