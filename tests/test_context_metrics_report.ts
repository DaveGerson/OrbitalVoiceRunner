// tests/test_context_metrics_report.ts — Phase C: report-shape unit test on a SEEDED temp DB.
// Spec: docs/superpowers/specs/2026-07-02-cortex-context-telemetry.md §11, §18.6.
//
// This file is scoped to ONE thing: hand-insert a small, fully-controlled set of context_injections
// rows into a real (in-memory) JanusStore, run the exported aggregation function
// (src/memory/contextMetricsReport.ts's buildContextMetricsReport), and assert the EXACT resulting
// JSON — not just "some plausible number". The smoke journeys (tests/test_context_smoke_journeys.ts)
// exercise the same function against organically-produced rows from a real server boot; this file is
// the one place the report's ARITHMETIC is pinned against hand-computed expected values.
//
// Not duplicated here: schema v10 migration / writer-reader round-trip / hash+token helper unit
// tests (tests/test_context_telemetry_store.ts), the real injectMemoryBrief choke-point behavior
// (tests/test_context_injection_telemetry.ts).

import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import {
  buildContextMetricsReport,
  DEFAULT_CONTEXT_COST_CONFIG,
  DEDUPE_NOTE,
  SESSION_ID_NOTE,
  NOT_DERIVABLE_NOTE,
} from "../src/memory/contextMetricsReport";
import type { ContextInjectionEvent } from "../src/memory/contextTelemetry";

function seed(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

const BASE_TS = 1_700_000_000_000;

/** The seven hand-crafted rows this file's expected-JSON math is computed against. Field-by-field
 *  rationale for each row is in the comment beside it. */
function seedRows(store: JanusStore): void {
  const rows: ContextInjectionEvent[] = [
    // 1: session_start / injected — first session_id ("sess-1"), hash H1, 100 tokens, focus correct.
    {
      id: "e-1", ts: BASE_TS + 1, session_id: "sess-1", interaction_id: "ixn-1", inject_id: "inj-1",
      trigger: "session_start", active_project_id: "proj-a", active_pane_id: "pane-p1",
      brief_active_pane_id: "pane-p1", source: "fallback", disposition: "injected",
      skipped_reason: null, source_snapshot_hash: null, brief_hash: "hash-h1",
      brief_chars: 400, estimated_tokens: 100, elapsed_ms: 5, error: null,
    },
    // 2: pane_switch / injected — second distinct session_id ("sess-2"), hash H2, 50 tokens.
    {
      id: "e-2", ts: BASE_TS + 2, session_id: "sess-2", interaction_id: "ixn-2", inject_id: "inj-2",
      trigger: "pane_switch", active_project_id: "proj-a", active_pane_id: "pane-p2",
      brief_active_pane_id: "pane-p2", source: "fallback", disposition: "injected",
      skipped_reason: null, source_snapshot_hash: null, brief_hash: "hash-h2",
      brief_chars: 200, estimated_tokens: 50, elapsed_ms: 3, error: null,
    },
    // 3: pane_switch / injected — REPEATS session_id "sess-1" and brief_hash H1 (the A->B->A case).
    {
      id: "e-3", ts: BASE_TS + 3, session_id: "sess-1", interaction_id: "ixn-3", inject_id: "inj-3",
      trigger: "pane_switch", active_project_id: "proj-a", active_pane_id: "pane-p1",
      brief_active_pane_id: "pane-p1", source: "fallback", disposition: "injected",
      skipped_reason: null, source_snapshot_hash: null, brief_hash: "hash-h1",
      brief_chars: 400, estimated_tokens: 100, elapsed_ms: 4, error: null,
    },
    // 4: pane_switch / skipped_stale_brief — the operator moved focus mid-synthesis; no hash, no tokens.
    {
      id: "e-4", ts: BASE_TS + 4, session_id: null, interaction_id: "ixn-4", inject_id: "inj-4",
      trigger: "pane_switch", active_project_id: "proj-a", active_pane_id: "pane-p3",
      brief_active_pane_id: null, source: "fallback", disposition: "skipped_stale_brief",
      skipped_reason: "operator switched the active pane before synthesis completed",
      source_snapshot_hash: null, brief_hash: null, brief_chars: 0, estimated_tokens: 0,
      elapsed_ms: 2, error: null,
    },
    // 5: reconnect / failed — a brief WAS assembled (hash H3) but sendClientContent threw; must NOT
    //    count toward contextInjectionCount or estimatedInputTokens (it never reached Gemini).
    {
      id: "e-5", ts: BASE_TS + 5, session_id: null, interaction_id: "ixn-5", inject_id: "inj-5",
      trigger: "reconnect", active_project_id: "proj-a", active_pane_id: "pane-p1",
      brief_active_pane_id: "pane-p1", source: "fallback", disposition: "failed",
      skipped_reason: null, source_snapshot_hash: null, brief_hash: "hash-h3",
      brief_chars: 80, estimated_tokens: 20, elapsed_ms: 6, error: "redacted: boom",
    },
    // 6: project_switch / skipped_no_session — pre-mint disposition (inject_id null), matching the
    //    real choke point's contract for this disposition.
    {
      id: "e-6", ts: BASE_TS + 6, session_id: null, interaction_id: "ixn-6", inject_id: null,
      trigger: "project_switch", active_project_id: null, active_pane_id: null,
      brief_active_pane_id: null, source: "none", disposition: "skipped_no_session",
      skipped_reason: "no active gemini session", source_snapshot_hash: null, brief_hash: null,
      brief_chars: 0, estimated_tokens: 0, elapsed_ms: null, error: null,
    },
    // 7: pane_switch / injected — a FOCUS MISMATCH (active_pane_id !== brief_active_pane_id), hash
    //    H4, 30 tokens. Synthetic (the real guard would drop this before injecting), included
    //    specifically to prove focusCorrectnessRate is computed, not hardcoded to 1.
    {
      id: "e-7", ts: BASE_TS + 7, session_id: null, interaction_id: "ixn-7", inject_id: "inj-7",
      trigger: "pane_switch", active_project_id: "proj-a", active_pane_id: "pane-p4",
      brief_active_pane_id: "pane-p5", source: "fallback", disposition: "injected",
      skipped_reason: null, source_snapshot_hash: null, brief_hash: "hash-h4",
      brief_chars: 120, estimated_tokens: 30, elapsed_ms: 7, error: null,
    },
  ];
  for (const r of rows) store.recordContextInjection(r);
}

test("buildContextMetricsReport produces the exact expected JSON for a hand-seeded 7-row DB (default cost config)", () => {
  const s = seed();
  seedRows(s);

  const report = buildContextMetricsReport(s, { sinceMs: 0 });

  assert.deepStrictEqual(report, {
    sinceMs: 0,
    rowCount: 7,
    sessions: 2, // distinct non-null session_id: "sess-1", "sess-2"
    contextInjectionCount: 4, // rows 1,2,3,7 (disposition === "injected")
    injectionsByTrigger: {
      session_start: 1,
      pane_switch: 4, // rows 2,3,4,7
      reconnect: 1,
      project_switch: 1,
    },
    skippedCount: 3, // rows 4,5,6 (everything not "injected")
    skippedByDisposition: {
      skipped_stale_brief: 1,
      failed: 1,
      skipped_no_session: 1,
    },
    // hashed rows: h1,h2,h1,h3,h4 (5 total, 4 distinct) -> (5-4)/5
    briefHashRepeatRate: 0.2,
    // injected rows' estimated_tokens: 100+50+100+30
    estimatedInputTokens: 280,
    // 280 tokens / 1e6 * default $0.5 per 1M
    estimatedTextInputCostUsd: (280 / 1_000_000) * DEFAULT_CONTEXT_COST_CONFIG.textInputUsdPer1M,
    // injected rows: 1(match),2(match),3(match),7(mismatch) -> 3/4
    focusCorrectnessRate: 0.75,
    durableDuplicatePaneCount: null,
    wrongPaneRefusals: null,
    approvalExactlyOnceSuccessRate: null,
    notes: [DEDUPE_NOTE, SESSION_ID_NOTE, NOT_DERIVABLE_NOTE],
  });

  s.close();
});

test("buildContextMetricsReport honors a costConfig override", () => {
  const s = seed();
  seedRows(s);

  const report = buildContextMetricsReport(s, { sinceMs: 0, costConfig: { textInputUsdPer1M: 10 } });
  assert.strictEqual(report.estimatedInputTokens, 280);
  assert.strictEqual(report.estimatedTextInputCostUsd, (280 / 1_000_000) * 10);
});

test("buildContextMetricsReport respects sinceMs — rows before the cutoff are excluded", () => {
  const s = seed();
  seedRows(s);

  const report = buildContextMetricsReport(s, { sinceMs: BASE_TS + 5 });
  assert.strictEqual(report.rowCount, 3, "only rows 5,6,7 have ts >= BASE_TS+5");
  assert.strictEqual(report.contextInjectionCount, 1, "only row 7 is injected in this window");
});

test("buildContextMetricsReport on an empty DB returns a well-formed zeroed/null report, not a throw", () => {
  const s = seed();
  const report = buildContextMetricsReport(s);
  assert.strictEqual(report.rowCount, 0);
  assert.strictEqual(report.sessions, 0);
  assert.strictEqual(report.contextInjectionCount, 0);
  assert.deepStrictEqual(report.injectionsByTrigger, {});
  assert.strictEqual(report.skippedCount, 0);
  assert.deepStrictEqual(report.skippedByDisposition, {});
  assert.strictEqual(report.briefHashRepeatRate, 0);
  assert.strictEqual(report.estimatedInputTokens, 0);
  assert.strictEqual(report.estimatedTextInputCostUsd, 0);
  assert.strictEqual(report.focusCorrectnessRate, null, "correctness of zero injections is undefined, not 1");
  assert.strictEqual(report.durableDuplicatePaneCount, null);
  assert.strictEqual(report.wrongPaneRefusals, null);
  assert.strictEqual(report.approvalExactlyOnceSuccessRate, null);
});

test("buildContextMetricsReport is deterministic — the same seeded DB yields byte-identical JSON across repeated calls", () => {
  const s = seed();
  seedRows(s);
  const a = JSON.stringify(buildContextMetricsReport(s, { sinceMs: 0 }));
  const b = JSON.stringify(buildContextMetricsReport(s, { sinceMs: 0 }));
  assert.strictEqual(a, b);
});
