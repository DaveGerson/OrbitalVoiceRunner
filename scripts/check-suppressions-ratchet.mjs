// scripts/check-suppressions-ratchet.mjs — the REAL ratchet guard.
//
// The committed complexity baseline (eslint-suppressions.json) may only SHRINK.
// This catches the `eslint . --suppress-all` bypass: adding a new over-limit
// function and silencing it by re-baselining. The total-count ceiling in
// tests/test_complexity_ratchet.ts cannot catch that on its own — once any
// improvement frees headroom, a total <= ceiling check can't distinguish
// "fixed file A, added a violation in file B" from real progress.
//
// We compare the current suppressions against the BASE ref's version and fail if
// any file's `complexity` count INCREASED or a NEW file key appeared. Legitimate,
// reviewed baseline growth (initial bootstrap, deliberate scope expansion) is
// allowed via ALLOW_SUPPRESSION_GROWTH=1.
//
// CLI: node scripts/check-suppressions-ratchet.mjs [--base <gitref>]
//   base defaults to origin/main (override via --base or RATCHET_BASE).
//   If the base ref has no eslint-suppressions.json (bootstrapping), it passes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SUPP = 'eslint-suppressions.json';

// Extract { file -> complexity suppression count } from a suppressions object.
export function complexityCounts(suppressions) {
  const out = {};
  for (const [file, rules] of Object.entries(suppressions || {})) {
    if (rules && rules.complexity && typeof rules.complexity.count === 'number') {
      out[file] = rules.complexity.count;
    }
  }
  return out;
}

// Pure: returns { ok, growth: [{ file, base, current }] }. A file counts as growth
// if its current complexity count exceeds the base count (0 when the file is new).
export function evaluateRatchet(baseSuppressions, currentSuppressions) {
  const base = complexityCounts(baseSuppressions);
  const cur = complexityCounts(currentSuppressions);
  const growth = [];
  for (const [file, count] of Object.entries(cur)) {
    const baseCount = base[file] ?? 0;
    if (count > baseCount) growth.push({ file, base: baseCount, current: count });
  }
  return { ok: growth.length === 0, growth };
}

function parseBase(argv) {
  const i = argv.indexOf('--base');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.env.RATCHET_BASE || 'origin/main';
}

// DELTA(plan): The z5c sandbox runs under a different Windows user than the clone owner. Child
// git calls in this ratchet must trust this repo path explicitly; otherwise HEAD looks unresolved
// and the unit battery false-reds while still failing closed in genuinely missing-base clones.
function git(args, opts) {
  return execFileSync('git', ['-c', `safe.directory=${process.cwd().replace(/\\/g, '/')}`, ...args], opts);
}

// Does the base ref actually resolve to a commit in this clone?
function refResolves(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const base = parseBase(process.argv.slice(2));
  const current = JSON.parse(readFileSync(SUPP, 'utf8'));

  // FAIL CLOSED if the base ref doesn't resolve (shallow/fork CI clone, unfetched remote).
  // Otherwise the guard would green-light a `--suppress-all` re-baseline by mistaking an
  // unreachable ref for "no baseline yet". This is the bug the adversarial review caught.
  if (!refResolves(base)) {
    if (process.env.ALLOW_MISSING_BASE === '1') {
      console.warn(`[ratchet] base ref '${base}' does not resolve; ALLOW_MISSING_BASE=1 set — skipping (NOT recommended in CI).`);
      process.exit(0);
    }
    console.error(`[ratchet] FAIL — base ref '${base}' does not resolve, so the baseline cannot be verified. Fetch it (e.g. 'git fetch origin main') or, only if you know the base genuinely has no baseline, set ALLOW_MISSING_BASE=1. Refusing to pass blind.`);
    process.exit(1);
  }

  let baseObj;
  try {
    const raw = git(['show', `${base}:${SUPP}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    baseObj = JSON.parse(raw);
  } catch {
    // Ref resolves but carries no suppressions file yet — genuine bootstrap, pass.
    console.log(`[ratchet] base '${base}' resolves but has no ${SUPP} (bootstrapping baseline) — nothing to compare; passing.`);
    process.exit(0);
  }
  const { ok, growth } = evaluateRatchet(baseObj, current);
  if (ok) {
    console.log(`[ratchet] OK — no complexity suppression grew vs ${base}.`);
    process.exit(0);
  }
  if (process.env.ALLOW_SUPPRESSION_GROWTH === '1') {
    console.warn(`[ratchet] ALLOW_SUPPRESSION_GROWTH=1 — permitting ${growth.length} grown/new suppression(s):`);
    for (const g of growth) console.warn(`  ${g.file}: ${g.base} -> ${g.current}`);
    process.exit(0);
  }
  console.error(`[ratchet] FAIL — complexity suppressions grew vs ${base} (a NEW violation may have been re-baselined instead of fixed):`);
  for (const g of growth) console.error(`  ${g.file}: ${g.base} -> ${g.current}`);
  console.error("Fix the new violation (or inline-disable with a justification). If this is an intentional, reviewed baseline expansion, set ALLOW_SUPPRESSION_GROWTH=1.");
  process.exit(1);
}

// Run main() only as a CLI, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
