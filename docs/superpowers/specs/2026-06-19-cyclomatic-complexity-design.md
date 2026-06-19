# Cyclomatic Complexity — Measure, Gate, and Evaluate

- **Bead:** _(to file)_ `cyclomatic-complexity-gate` — "Measure, gate, and trend per-function cyclomatic complexity across the TS codebase"
- **Date:** 2026-06-19
- **Status:** Design / TDD — open questions resolved 2026-06-19 (see §9 Decisions); no production tooling wired in this pass.
- **Author context:** requested by operator — "develop a spec and plan to test for and evaluate Cyclomatic complexity."
- **Scope:** all first-party TypeScript under `server.ts`, `src/**`, `scripts/**`. Excludes `tests/**`, `dist/**`, `node_modules/**`, generated files (`*.generated.ts`), and Python.
- **Depends on (today):** nothing — this is greenfield tooling. The repo has **no ESLint and no complexity tooling** today; `npm run lint` is `tsc --noEmit` only.
- **Blocks / enables:** a maintainability ratchet on the five 1K+ LOC hotspots; a refactor-prioritization signal (churn × complexity) for roadmap planning.

---

## 1. BLUF

We want two things the title asks for, kept distinct:

1. **Test for** complexity — a deterministic, CI-enforceable **gate** that fails when a function exceeds a cyclomatic-complexity threshold, plus **tests that prove the gate itself is correct** (it reports the hand-computed number, and it fails when it should).
2. **Evaluate** complexity — a **report** that ranks the codebase's hotspots (and weights them by git churn) so we know *what to refactor first*, surfaced as a CI artifact rather than a hard gate.

**Decision: use ESLint's built-in `complexity` rule as the gate, `eslint-plugin-sonarjs`'s `cognitive-complexity` as an advisory readability signal, and `code-complexity` (churn × complexity) for the evaluation report.** Rationale below (§3). We adopt a **baseline + ratchet** rollout (ESLint Bulk Suppressions) so CI goes green on day one despite the existing 1K+ LOC hotspots, while *new and changed* code is held to McCabe's limit of 10 immediately.

This is a net-new dependency footprint for a repo that is deliberately hermetic, so §3.4 weighs the "add ESLint" cost explicitly and offers a zero-ESLint fallback.

---

## 2. Background — what cyclomatic complexity is, and the current state

### 2.1 The metric

Cyclomatic complexity (McCabe, 1976) counts the **linearly independent paths** through a function. Computed the practical way: **start at 1, add 1 per decision point.** Decision points: `if` / `else if` (bare `else` adds nothing), `for` / `for…of` / `for…in` / `while` / `do…while`, each `case` (classic mode), `catch`, each `&&` and `||`, and each ternary `?:`. The number equals the **minimum test cases for branch coverage**, which is exactly why it's a testability metric and a good hard gate: it's standardized, deterministic, and hand-verifiable.

It deliberately does **not** measure readability. A flat 30-case `switch` scores 30 but reads trivially; three shallow nested loops score less but read worse. That gap is what **cognitive complexity** (SonarSource) fixes — it ignores readable shorthand (a whole `switch` is +1, not per-case) and adds a **nesting penalty** so deeply-nested code is punished. We therefore use cyclomatic as the **gate** and cognitive as an **advisory** signal; they answer different questions and we want both.

### 2.2 Current state of this repo (verified 2026-06-19)

- **No ESLint, no Prettier, no complexity tooling** in `devDependencies`. `npm run lint` === `npm run typecheck` === `tsc --noEmit`.
- Tests run on the **Node built-in test runner via `tsx`** (`tsx --test --test-force-exit`, wrapped by `scripts/run-unit.mjs`). No Jest/Vitest.
- CI is `.github/workflows/ci.yml` (lint → unit → e2e-mock → e2e-live) plus `linux-verify.yml`. **No quality gate beyond type-checking.**
- Existing quality-gate scripts are the model to follow: `scripts/catalog.ts` (drift guard, `CATALOG_CHECK=1` fails CI), `scripts/check-deps.mjs` (dep-sync guard, wired into git hooks).
- **Complexity hotspots** (largest first-party `.ts` by LOC) — these are where the gate would bite if applied retroactively, hence the ratchet:

  | File | LOC |
  |---|---|
  | `src/orbital/useOrbitalData.ts` | 1,666 |
  | `src/terminal.ts` | 1,659 |
  | `server.ts` (repo root) | 1,626 |
  | `src/voice/index.ts` | 1,466 |
  | `src/store/sqliteStore.ts` | 1,147 |
  | `src/gating/index.ts` | 1,082 |
  | `src/pendingApprovals.ts` | 857 |

  (Note: CLAUDE.md says `server.ts` is ~3,200 lines; current measurement is 1,626. Re-verify during implementation — the discrepancy doesn't change the design.)

---

## 3. Tooling decision

### 3.1 Gate — ESLint built-in `complexity` rule  ✅ primary

- Core ESLint, no plugin; TS parsed via `typescript-eslint`. Per-function granularity, `warn`/`error` severity, per-glob overrides, inline `/* eslint-disable-next-line complexity */` escape hatches, non-zero exit fails CI for free.
- **ESLint's default for this rule is 20** — we set it **explicitly to 10** (McCabe / NIST limit).
- The violation **message embeds the computed number** ("…has a complexity of 5…"), which is what makes the gate **self-testable** (§6).
- Cost: this is the one real decision — it adds ESLint to a repo that has none (§3.4).

### 3.2 Advisory — `eslint-plugin-sonarjs` `cognitive-complexity`  ✅ secondary

- The canonical cognitive-complexity implementation, same ESLint plumbing, runs in the same pass. Set to `warn` at 15 (its default). Surfaces genuinely-hard-to-read code that McCabe misses. We scope the plugin to just this rule to avoid importing its full ~268-rule set as policy.

### 3.3 Evaluation report — `code-complexity`  ✅ report-only

- `npx code-complexity . --sort score --complexity cyclomatic --format json` ranks files by **churn × complexity** (reads git history → needs `fetch-depth: 0` in CI). No native fail/threshold — we **do not gate on it**; it's uploaded as a CI artifact for refactor prioritization. This is the "evaluate" deliverable distinct from the "test for" gate.

### 3.4 Rejected / deferred

- **`tsc`-only / do nothing** — rejected: the ask is explicitly to test *and* evaluate.
- **`typhonjs-escomplex` / `escomplex` / `plato`** — rejected: effectively unmaintained (last meaningful release ~7 years), choke on modern TS syntax.
- **SonarQube / SonarCloud** — deferred: needs a server/token; heavier than a small repo wants for *just* complexity. The SonarJS engine value is already available via the ESLint plugin. Revisit if we want stored trends/quality-gate dashboards.
- **`cyclomatic-complexity` (pilotpirxie) standalone CLI** — this is the **zero-ESLint fallback** (§3.5), not the primary, because it can't also give us cognitive complexity or editor integration.
- **Biome** — does not currently ship a cyclomatic-complexity rule, so not a substitute.

### 3.5 Zero-ESLint fallback (if operator declines adding ESLint)

If we want to keep the dependency surface minimal, replace §3.1/§3.2 with the standalone **`cyclomatic-complexity`** CLI (`npx cyclomatic-complexity './src/**/*.ts' --threshold-errors 10 --json`) wired into a small `scripts/complexity-gate.mjs` that owns the baseline/ratchet logic (§5.3). This loses per-editor feedback and cognitive complexity but adds essentially no standing config. **Open question O-1 (§9) — operator picks.**

---

## 4. Thresholds

| Cyclomatic | Meaning | Action |
|---|---|---|
| 1–10 | Simple, easily testable | pass |
| 11–15 | Moderate; extra tests warranted | `warn` (allowed with review) |
| 16+ | Complex / high-risk | `error` (gate fails) |

- **Gate target: `complexity: ['error', 10]`** — McCabe's original limit, endorsed by NIST SP 500-235 (which permits up to 15 only with strong supporting practices). We adopt 10 for *new/changed* code.
- **Cognitive advisory: `sonarjs/cognitive-complexity: ['warn', 15]`** (plugin default).
- During rollout the *effective* ceiling for legacy code is "whatever is already there," held in the suppressions baseline (§5) and ratcheted down — we never flip a strict number on day one and turn CI red.

---

## 5. Rollout — baseline + ratchet (no big-bang refactor)

The hotspots in §2.2 will violate `max: 10` heavily. To gate new code *now* without a blocking refactor:

### 5.1 Mechanism: ESLint Bulk Suppressions (preferred)

ESLint ≥ 9.24 (April 2025) ships first-class suppressions:

1. Set the rule to **`error`** (suppressions apply to `error`-level rules only, not `warn`).
2. Run once: `npx eslint . --suppress-all` → writes **`eslint-suppressions.json`** listing every existing violation. **Commit it.**
3. CI runs plain `eslint .`: pre-existing violations are silenced; **any new violation, or a new occurrence in an already-listed file, fails the build.**
4. As code is refactored, `npx eslint . --prune-suppressions` removes fixed entries. The committed suppression count is a **one-way ratchet** — it only shrinks. A tiny CI check (or `betterer`, §5.3) can assert it never grows.

### 5.2 Why not `warn`-only

`warn` never fails CI, so complexity would rot silently. `error` + suppressions gives us a hard gate on new code while keeping the build green on legacy — the best of both.

### 5.3 Alternatives if not on ESLint 9.24+ / not using ESLint

- **`betterer`** — define "ESLint `complexity` violations must not increase," snapshot to `.betterer.results`, fail CI on growth. Supports deadlines.
- **Hand-rolled `scripts/complexity-gate.mjs`** — parse `eslint --format json` (or `cyclomatic-complexity --json`), compare per-file counts to a committed `complexity-baseline.json`, fail on any increase, auto-rewrite baseline downward on improvement. ~40 lines; this is also the home for the §3.5 fallback. Mirrors the existing `scripts/catalog.ts` drift-guard pattern this repo already trusts.

---

## 6. Evaluation / test methodology — proving the gate is correct

We do not trust the gate until it's proven on **known-value fixtures** and shown to **fail when it should**. This is the "test for" half done rigorously.

### 6.1 Known-value fixtures (`tests/fixtures/complexity/`)

Each fixture's McCabe value is hand-computed by the "1 + decision points" rule and asserted exactly. Graduated fixtures bracket each threshold (one just below, one just above) to catch off-by-one config:

```ts
// tests/fixtures/complexity/cc-05.ts — expected cyclomatic = 5
export function classify(n: number, flag: boolean): string {
  if (n > 0 && flag) return 'a';   // if (+1), && (+1)
  for (let i = 0; i < n; i++) {     // for (+1)
    if (i % 2 === 0) continue;      // if (+1)
  }
  return 'b';                        // base 1  → total 5
}
```

Provide fixtures for expected **1, 10, 11, 15, 16** (the warn/error boundaries).

### 6.2 Assert against the tool (Node `tsx --test`)

Run ESLint via its Node API and assert on the structured result — pins both "rule is active" and "it computes the number I hand-counted":

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

test('complexity rule reports the hand-computed value', async () => {
  const eslint = new ESLint({ overrideConfigFile: 'eslint.config.js' });
  const [res] = await eslint.lintFiles(['tests/fixtures/complexity/cc-05.ts']);
  const msgs = res.messages.filter(m => m.ruleId === 'complexity');
  assert.equal(msgs.length, 1);              // with a max:4 test config
  assert.match(msgs[0].message, /complexity of 5/);  // exact computed value
});

test('a sub-threshold fixture produces no violation', async () => {
  const eslint = new ESLint({ overrideConfigFile: 'eslint.config.js' });
  const [res] = await eslint.lintFiles(['tests/fixtures/complexity/cc-10.ts']);
  assert.equal(res.messages.filter(m => m.ruleId === 'complexity').length, 0);
});
```

(For the fallback CLI, parse its `--json` and assert the same numbers.)

### 6.3 Unit-test the ratchet/gate script (if §5.3 is used)

Test the decision logic in isolation — feed synthetic analyzer output:

```ts
test('fails when a file regresses above baseline', () => {
  const r = evaluateGate({ baseline: { 'src/x.ts': 3 }, current: { 'src/x.ts': 4 } });
  assert.equal(r.ok, false);
});
test('passes and ratchets baseline down on improvement', () => {
  const r = evaluateGate({ baseline: { 'src/x.ts': 3 }, current: { 'src/x.ts': 1 } });
  assert.equal(r.ok, true);
  assert.equal(r.newBaseline['src/x.ts'], 1);
});
```

Explicitly test the boundary (count == threshold) to lock `>` vs `>=`.

### 6.4 End-to-end smoke

One CI-level test that runs the **actual** gate command against a deliberately over-complex fixture and asserts a **non-zero exit** — proving config discovery, globbing, and exit-code wiring, not just unit logic. Mirrors the repo's existing `smoke:*` convention.

---

## 7. CI integration

Add a dedicated lane (keeps the existing `ci.yml` lanes untouched and lets complexity be read/triaged independently):

```yaml
# .github/workflows/complexity.yml
name: complexity
on: [pull_request]
jobs:
  complexity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # full history for churn report
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx eslint . --max-warnings 0  # hard gate (cyclomatic) + surfaces cognitive warns
      - run: npx code-complexity . --sort score --limit 30 --complexity cyclomatic --format json > complexity-report.json
        if: always()                         # report even if the gate failed
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: complexity-report, path: complexity-report.json }
```

- **Gate vs report:** `eslint . --max-warnings 0` fails the build on any `error` (and any `warn`, to keep cognitive honest); `code-complexity` is artifact-only.
- Optionally add an `npm run complexity` script and a `pre-commit` step (the repo already has an opt-in `.githooks` install path via `scripts/install-wt-lock.sh`) — advisory locally, authoritative in CI.

---

## 8. Implementation plan (phased, TDD)

Tracked in `bd`; each phase is a separate bead under `cyclomatic-complexity-gate`.

- **Phase 0 — Decide (blocking).** Resolve O-1 (ESLint vs zero-ESLint fallback) and O-2 (lane vs fold into `ci.yml`) with the operator (§9). *Exit:* decisions recorded on the bead.
- **Phase 1 — Fixtures & gate tests first (red).** Add `tests/fixtures/complexity/*` with hand-computed values and the §6.2 assertions. They fail (no config yet). *Exit:* failing tests committed.
- **Phase 2 — Wire the analyzer (green).** Add ESLint + `typescript-eslint` + `eslint-plugin-sonarjs` (or the fallback CLI), `eslint.config.js` per §3/§4, and a test-only config with `max:4` for fixture assertions. Run `node scripts/check-deps.mjs` after install. *Exit:* §6 tests pass; `npm run lint` still green (ESLint runs *alongside* `tsc`, doesn't replace it).
- **Phase 3 — Baseline the legacy.** `eslint . --suppress-all`, commit `eslint-suppressions.json`. *Exit:* `eslint .` exits 0 on the current tree.
- **Phase 4 — Ratchet guard + report.** Add the no-growth check on the suppressions count (or `scripts/complexity-gate.mjs` + its unit tests, §6.3) and the `code-complexity` artifact step. *Exit:* §6.4 smoke passes.
- **Phase 5 — CI.** Add `.github/workflows/complexity.yml` (or fold into `ci.yml`). *Exit:* lane green on a PR; a deliberately-complex test PR goes red.
- **Phase 6 — Docs & follow-up beads.** Update CLAUDE.md "Build & Test" with `npm run complexity`; file refactor beads for the top hotspots ranked by the Phase 4 report.

---

## 9. Decisions (locked 2026-06-19, operator interview)

- **D-1 (was O-1) — Toolchain: add the ESLint stack.** `eslint` + `typescript-eslint` + `eslint-plugin-sonarjs`. Per-function granularity, editor feedback, and cognitive complexity in one pass. The zero-ESLint fallback (§3.5) is dropped.
- **D-2 (was O-2) — CI: separate `complexity.yml` lane** first (easy to keep non-blocking while tuning), fold into `ci.yml` once stable.
- **D-3 (was O-3) — Threshold: cyclomatic `error` at 10** (McCabe/NIST) for new code; cognitive `warn` at 15 (advisory).
- **D-4 (was O-4) — Enforcement: fail on new/changed violations immediately.** Bulk suppressions keep legacy green; cognitive stays advisory.
- **D-5 (new) — Refactor appetite: measure first, then refactor the top 3 files now.** After baselining, refactor the *violating functions* in the 3 highest-priority files (ranked by churn × complexity); produce a next-step burn-down plan for the remaining hotspots. Not an open-ended whole-repo refactor in this effort.
- **D-6 (new) — Safety net: characterization tests first for core machinery.** Before refactoring `server.ts` (WS/REST hub) and `src/terminal.ts` (PTY lifecycle), pin current behavior with tests, then refactor strictly behavior-preserving. Lower-risk files (`src/orbital/useOrbitalData.ts`, etc.) may rely on the existing suite.

> Sequencing consequence of D-5: complexity is a **per-function** metric, so refactor targets are unknown until the analyzer runs. The measure → baseline → report steps (Phases 1–5 of the plan) therefore precede any refactoring (Phases 6+).

---

## 10. Key numbers to cite

- McCabe / NIST SP 500-235 limit: **10** (up to **15** with strong practices).
- ESLint `complexity` rule **default 20** → we set **10**.
- `eslint-plugin-sonarjs` cognitive-complexity **default 15**.
- ESLint **Bulk Suppressions** shipped **v9.24 (April 2025)**: `--suppress-all`, `eslint-suppressions.json`, `--prune-suppressions`; suppresses `error`-level rules only.

## 11. Sources

- ESLint `complexity` rule — https://eslint.org/docs/latest/rules/complexity
- ESLint Bulk Suppressions — https://eslint.org/docs/latest/use/suppressions · https://eslint.org/blog/2025/04/introducing-bulk-suppressions/
- `eslint-plugin-sonarjs` cognitive-complexity — https://github.com/SonarSource/eslint-plugin-sonarjs/blob/master/docs/rules/cognitive-complexity.md
- SonarSource Cognitive Complexity whitepaper — https://www.sonarsource.com/docs/CognitiveComplexity.pdf
- `code-complexity` — https://github.com/simonrenoult/code-complexity
- `cyclomatic-complexity` (fallback CLI) — https://github.com/pilotpirxie/cyclomatic-complexity
- NIST Structured Testing (McCabe) — https://www.mccabe.com/nist/nist_pub.php
- typescript-eslint flat config — https://typescript-eslint.io/packages/typescript-eslint/
