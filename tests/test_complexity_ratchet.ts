// tests/test_complexity_ratchet.ts — the complexity gate's RATCHET guard.
//
// Two guarantees, both CI-enforced:
//   1. The committed suppression baseline (eslint-suppressions.json) can only ratchet DOWN.
//      We assert the total suppressed `complexity` count is <= RATCHET_CEILING. If anyone
//      re-baselines upward (e.g. `--suppress-all` to silence a NEW violation) instead of
//      fixing or inline-disabling it, this test fails CI. We also assert cognitive-complexity
//      is NOT suppressed — it's an advisory `warn`, it must stay visible.
//   2. The production gate actually BITES end-to-end: linting an over-limit source string
//      through the real eslint.config.js produces a `complexity` error (severity 2). This
//      proves config + glob + rule wiring flag new over-limit code, not just that a number
//      exists in a JSON file.
//
// Runner: npx tsx --test --test-force-exit tests/test_complexity_ratchet.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// RATCHET_CEILING: the current baselined `complexity` suppression total. LOWER THIS when
// suppressions are pruned (`eslint . --prune-suppressions`). It must NOT be raised to silence
// a NEW violation — that's what the per-file guard (scripts/check-suppressions-ratchet.mjs)
// prevents. The ONLY legitimate raise is a deliberate, reviewed GATE-SCOPE EXPANSION.
// 85 -> 80: Phase 7 refactored src/voice/index.ts under CC 10 and pruned its 5 suppressions.
// 80 -> 119: scope expansion — the gate now also covers .tsx React components and .mjs scripts
//   (previously ungated); +39 pre-existing violations baselined. This is a one-time scope raise.
// 119 -> 110: Phase 7b refactored src/terminal.ts under CC 10 and pruned its 9 suppressions.
// 110 -> 103: burndown refactored src/gating/index.ts under CC 10 and pruned its 7 suppressions.
// 103 -> 99: burndown refactored src/store/sqliteStore.ts under CC 10 and pruned its 4 suppressions.
// 99 -> 87: burndown refactored approvalIntent/actionEffects/observe under CC 10 and pruned their 5+3+4 suppressions.
// 87 -> 78: burndown refactored actions registry (handoff/locks/reads/gemini) under CC 10 and pruned their 3+2+2+2 suppressions.
// 78 -> 75: burndown refactored src/statusProbe.ts (parseProcRecords/parsePsTree/parseProcessList) under CC 10 and pruned its 3 suppressions.
// 75 -> 72: burndown refactored ledger.getNotes, paneOwnership.findPaneOwningProject, voiceApprovalRouting.resolvePendingActionByVoice under CC 10 and pruned their 1+1+1 suppressions.
// 72 -> 66: burndown refactored actions/defs/layouts.applyLayout, dispatch/paneWrite.applyDispatchDecision, memory/pythonClient (createPythonSynthClient/onLine/spawnDaemon), orbital/station.deriveStations under CC 10 and pruned their 1+1+3+1 suppressions.
// 66 -> 61: burndown refactored eventBus.effectForEvent, announcementBus.pruneAttentionQueue, memory/assembler.assembleBrief, voice/speakGate.shouldSpeak, liveTranscripts.extractTranscripts under CC 10 and pruned their 5 suppressions (1 each).
// 61 -> 54: burndown refactored actions/defs/{orchestration,dispatch_group,panes_write}, dispatch/joinTracker, handoffFlow, liveGrounding, pendingApprovals under CC 10 and pruned their 7 suppressions (1 each).
// 54 -> 48: quick-win burndown refactored server.validateSettingsPutBody + HistoryManager.doFlush (2 of server's 3) and scripts catalog.renderCatalog / wt-lock.main / verify-live-modeswitch.main / live-smoke-kitchen.main under CC 10; pruned 2 (server 3->1) + 4 (scripts ->0).
// 48 -> 45: burndown refactored store/migrate.ts (migrateFromObjects txn arrow), orbital/useFocusTrap.ts (onKey), scripts/smoke-handoff.ts (main) under CC 10 and pruned their 3 suppressions (1 each).
// 45 -> 42: burndown refactored .tsx leaves GateChip.GateChipInner, ServiceMode (.map cb), ApprovalDialog under CC 10 (pure helpers + inline render-fns, no new components/hooks) and pruned their 3 suppressions (1 each).
const RATCHET_CEILING = 42;

function readSuppressions() {
  const raw = readFileSync(path.join(repoRoot, 'eslint-suppressions.json'), 'utf8');
  return JSON.parse(raw);
}

test('complexity suppressions ratchet down: total <= RATCHET_CEILING', () => {
  const suppressions = readSuppressions();
  let total = 0;
  for (const file of Object.keys(suppressions)) {
    const entry = suppressions[file];
    if (entry && entry.complexity && typeof entry.complexity.count === 'number') {
      total += entry.complexity.count;
    }
  }
  assert.ok(
    total <= RATCHET_CEILING,
    `complexity suppressions total ${total} exceeds RATCHET_CEILING ${RATCHET_CEILING}; ` +
      'the baseline may only shrink — fix/inline-disable the new violation instead of re-baselining up',
  );
});

test('cognitive-complexity is advisory and must NOT be suppressed', () => {
  const raw = readFileSync(path.join(repoRoot, 'eslint-suppressions.json'), 'utf8');
  assert.ok(
    !/cognitive-complexity/.test(raw),
    'cognitive-complexity is a `warn` advisory and must stay unsuppressed; found it in eslint-suppressions.json',
  );
});

// Smoke: prove the PRODUCTION config flags new over-limit code end-to-end. The source
// below is DELIBERATELY synthetic — its exact shape is irrelevant; it only needs to be
// comfortably over the limit. We assert a complexity ERROR (severity 2) is raised through
// the real eslint.config.js, proving config + glob + rule wiring catch new code (not just
// that a number sits in a JSON file). Unlike a fixture, no exact count is asserted.
function overcomplexSource() {
  const branches = Array.from({ length: 12 }, (_, i) => `  if (a === ${i}) return ${i};`).join('\n');
  return `export function overcomplex(a: number): number {\n${branches}\n  return -1;\n}\n`;
}

test('production gate flags new over-limit code (complexity error, severity 2)', async () => {
  const eslint = new ESLint({ overrideConfigFile: path.join(repoRoot, 'eslint.config.js') });
  // filePath matches the production src/** glob so eslint.config.js applies.
  const [res] = await eslint.lintText(overcomplexSource(), {
    filePath: path.join(repoRoot, 'src', '__complexity_smoke__.ts'),
  });
  const errors = (res?.messages ?? []).filter((m) => m.ruleId === 'complexity' && m.severity === 2);
  assert.ok(
    errors.length >= 1,
    'production eslint.config.js did not flag over-limit code as a complexity error (severity 2)',
  );
});
