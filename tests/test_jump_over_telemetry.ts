// tests/test_jump_over_telemetry.ts — Wave 4 RED: T4 telemetry — the `jump_over` counter and the
// drain-size distribution, written via JanusStore.
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md §4-W4, §5-T4. The jump_over
// counter records ANY forced turn (turnComplete:true) landing mid-answer/mid-utterance. Post-
// arbiter it should be STRUCTURALLY ZERO — the row exists to PROVE it (the mute-rate precedent:
// the +14d watch bead reads this counter; the bead itself is the orchestrator's at land, NOT
// asserted here). Drain-size rows give the distribution D2's headline+counted-tail policy is
// judged by during the watch.
//
// Store idiom mirrored from the v9/v10 telemetry spine — gemini_turn_usage (schema v9,
// recordGeminiTurnUsage's fail-soft try/catch writer) and context_injections (schema v10,
// tests/test_context_telemetry_store.ts's review-hardened reader: fail-soft, newest-first,
// deterministic rowid tiebreak). Retention rides pruneIncremental on the same 30d posture as its
// v9 siblings (the context_injections review pinned "a telemetry table with NO retention" as a
// real defect — not repeated here).
//
// ── Pinned Wave-4 contract (the implementer builds EXACTLY this seam) ──────────────────────────
//  1. Schema migration (SCHEMA_VERSION bumps 13 -> >= 14), additive + self-contained:
//       CREATE TABLE jump_over(
//         id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
//         session_id TEXT, producer TEXT, cls INTEGER, detail TEXT);
//       CREATE INDEX idx_jump_over_ts ON jump_over(ts);
//       CREATE TABLE arbiter_drain(
//         id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
//         session_id TEXT, mode TEXT, headline_cls INTEGER,
//         drain_size INTEGER NOT NULL, tail_count INTEGER NOT NULL);
//       CREATE INDEX idx_arbiter_drain_ts ON arbiter_drain(ts);
//  2. JanusStore writers/readers (fail-soft BOTH ways — telemetry must never throw into the live
//     voice loop, and a closed handle must read as []):
//       recordJumpOver({ ts, sessionId, producer, cls, detail }): void
//       getJumpOvers(sinceTs: number, limit = 100): JumpOverRow[]           // newest-first
//       recordArbiterDrain({ ts, sessionId, mode, headlineCls, drainSize, tailCount }): void
//       getArbiterDrains(sinceTs: number, limit = 100): ArbiterDrainRow[]   // newest-first
//     drain_size === 1 + tail_count (headline + tail) is the caller's invariant; the distribution
//     is the analysis unit.
//  3. Retention: both tables prune at the SAME 30d default cadence as gemini_turn_usage inside
//     pruneIncremental (own try/catch so a pre-v14 DB skips gracefully — house pattern).
//  4. The pure classifier, exported from src/voice/index.ts (turn-timing derivation stays in-process
//     TS — LOCKED seam rule; derived from shouldSpeakReadyAck, never a parallel clock):
//       isJumpOverSend(opts: { turnComplete: boolean; cls?: 0|1|2|3|4|5; ack: AckTurnState }): boolean
//     - false when turnComplete is false (passive context can never jump anything);
//     - false when cls === 1 (operator-response is exempt — the turn is the operator's own; same
//       reason family D tool responses never count);
//     - otherwise true iff shouldSpeakReadyAck(ack) !== "speak" (mid-utterance OR barge-in).
//  5. Wiring (source-anchored — the send closures are unreachable from a unit test; the
//     tests/test_answer_first_ordering.ts technique): src/voice/index.ts consumes the classifier
//     (>= 2 non-comment mentions: definition + a call at a forced-send choke point), records
//     jump-overs (recordJumpOver mentioned) and records a drain row per arbiter drain
//     (recordArbiterDrain mentioned on the drain path).
//
// Runner: npx tsx --test --test-force-exit tests/test_jump_over_telemetry.ts

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { applyMigrations, SCHEMA_VERSION } from "../src/store/schema";
import { JanusStore } from "../src/store/sqliteStore";
import { pruneIncremental } from "../src/store/retention";
import { OPERATOR_HOLD_MS, type AckTurnState } from "../src/voiceAckGate";
import { createTurnArbiter } from "../src/voice/turnArbiter";
// Namespace import (test_answer_first_ordering.ts idiom): the missing export reads back as
// `undefined` for a clean per-test failure instead of a module-link crash.
import * as voiceIndexModule from "../src/voice/index";

type AnyRec = Record<string, any>;

const voiceIndex = voiceIndexModule as AnyRec;
const isJumpOverSend = voiceIndex.isJumpOverSend as
  | ((opts: { turnComplete: boolean; cls?: number; ack: AckTurnState }) => boolean)
  | undefined;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const T = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function seed(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

/** Every store test asserts the writer exists FIRST — a clean, diagnosable Wave-4-absent failure
 *  instead of an opaque "s.recordJumpOver is not a function" TypeError. */
function assertStoreSeam(s: AnyRec, name: string): void {
  assert.strictEqual(typeof s[name], "function",
    `Wave-4 feature absent: JanusStore must expose ${name}(...) (T4 telemetry via JanusStore — ` +
      "the gemini_turn_usage/context_injections writer-reader idiom)");
}

// ── (1) schema migration ───────────────────────────────────────────────────────────────────────

test("migration creates jump_over + arbiter_drain with ts indexes on a fresh db; SCHEMA_VERSION bumps past 13", () => {
  const db = new Database(":memory:");
  applyMigrations(db);

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as AnyRec[]).map((r) => r.name);
  assert.ok(tables.includes("jump_over"),
    "Wave-4 feature absent: the jump_over table must exist (T4 — the counter that proves the " +
      "arbiter made forced mid-utterance turns structurally impossible)");
  assert.ok(tables.includes("arbiter_drain"),
    "Wave-4 feature absent: the arbiter_drain table must exist (T4 drain-size distribution)");
  assert.ok(SCHEMA_VERSION >= 14, "SCHEMA_VERSION must bump for the Wave-4 telemetry migration (was 13)");
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);

  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as AnyRec[]).map((r) => r.name);
  assert.ok(indexes.includes("idx_jump_over_ts"), "idx_jump_over_ts should exist (the v9 naming idiom)");
  assert.ok(indexes.includes("idx_arbiter_drain_ts"), "idx_arbiter_drain_ts should exist");
  db.close();
});

test("the telemetry migration applies on the v13 user_version bump path (additive + self-contained)", () => {
  // Same isolation rationale as the v10 bump-path test in tests/test_context_telemetry_store.ts:
  // the new migration must be additive with no FK into earlier tables, so exercising ONLY the bump
  // is legal — full-chain fresh-db behavior is the previous test's job.
  const db = new Database(":memory:");
  db.pragma("user_version = 13");

  applyMigrations(db);

  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION, "version bumps to SCHEMA_VERSION");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as AnyRec[]).map((r) => r.name);
  assert.ok(tables.includes("jump_over"), "the Wave-4 migration should have run on the bump path");
  assert.ok(tables.includes("arbiter_drain"));
  db.close();
});

test("applyMigrations stays idempotent with the Wave-4 migration present", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  const v = db.pragma("user_version", { simple: true });
  assert.ok((v as number) >= 14, "Wave-4 feature absent: the schema never reached the telemetry version");
  assert.doesNotThrow(() => applyMigrations(db));
  assert.equal(db.pragma("user_version", { simple: true }), v);
  db.close();
});

// ── (2) jump_over writer/reader ────────────────────────────────────────────────────────────────

test("recordJumpOver stores and getJumpOvers retrieves the row column-for-column", () => {
  const s: AnyRec = seed();
  assertStoreSeam(s, "recordJumpOver");
  assertStoreSeam(s, "getJumpOvers");
  s.recordJumpOver({ ts: T, sessionId: "sess-a", producer: "approval-narration", cls: 2, detail: "last-call:d1" });

  const rows = s.getJumpOvers(0);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ts, T);
  assert.strictEqual(rows[0].session_id, "sess-a");
  assert.strictEqual(rows[0].producer, "approval-narration");
  assert.strictEqual(rows[0].cls, 2);
  assert.strictEqual(rows[0].detail, "last-call:d1");
  s.close();
});

test("getJumpOvers filters by sinceTs, orders newest-first, and respects limit (default 100)", () => {
  const s: AnyRec = seed();
  assertStoreSeam(s, "getJumpOvers");
  for (let i = 0; i < 5; i++) {
    s.recordJumpOver({ ts: T + i, sessionId: "sess-a", producer: "ack", cls: 4, detail: null });
  }
  assert.strictEqual(s.getJumpOvers(T + 3).length, 2, "sinceTs is inclusive-from (ts >= since)");
  const limited = s.getJumpOvers(0, 2);
  assert.strictEqual(limited.length, 2);
  assert.deepStrictEqual(limited.map((r: AnyRec) => r.ts), [T + 4, T + 3], "newest-first");
  assert.strictEqual(s.getJumpOvers(0).length, 5, "default limit admits all 5");
  s.close();
});

test("the jump_over baseline is ZERO on a fresh store — the structurally-zero proof the watch bead reads", () => {
  const s: AnyRec = seed();
  assertStoreSeam(s, "getJumpOvers");
  assert.deepStrictEqual(s.getJumpOvers(0), [],
    "post-arbiter the counter's steady state is zero rows; any row is a regression the +14d watch surfaces");
  s.close();
});

test("recordJumpOver/getJumpOvers are fail-soft — a closed handle never throws into the voice loop", () => {
  const s: AnyRec = seed();
  assertStoreSeam(s, "recordJumpOver");
  s.close();
  assert.doesNotThrow(() => s.recordJumpOver({ ts: T, sessionId: null, producer: "ack", cls: 4, detail: null }),
    "the writer must swallow its own failure (recordGeminiTurnUsage's try/catch shape)");
  let rows: unknown;
  assert.doesNotThrow(() => { rows = s.getJumpOvers(0); });
  assert.deepStrictEqual(rows, [], "the reader degrades to [] (context_injections' hardened reader shape)");
});

// ── (3) arbiter_drain writer/reader + the distribution ─────────────────────────────────────────

test("recordArbiterDrain stores and getArbiterDrains retrieves the row column-for-column", () => {
  const s: AnyRec = seed();
  assertStoreSeam(s, "recordArbiterDrain");
  assertStoreSeam(s, "getArbiterDrains");
  s.recordArbiterDrain({ delivered: true, ts: T, sessionId: "sess-a", mode: "forced-turn", headlineCls: 2, drainSize: 5, tailCount: 4 });

  const rows = s.getArbiterDrains(0);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ts, T);
  assert.strictEqual(rows[0].session_id, "sess-a");
  assert.strictEqual(rows[0].mode, "forced-turn");
  assert.strictEqual(rows[0].headline_cls, 2);
  assert.strictEqual(rows[0].drain_size, 5);
  assert.strictEqual(rows[0].tail_count, 4);
  s.close();
});

test("drain-size distribution: rows aggregate by drain_size (the T4 analysis unit)", () => {
  const s: AnyRec = seed();
  assertStoreSeam(s, "recordArbiterDrain");
  // Three drains: two singletons and one 3-item digest — the shape the watch bead trends.
  s.recordArbiterDrain({ delivered: true, ts: T + 1, sessionId: "sess-a", mode: "steered-digest", headlineCls: 4, drainSize: 1, tailCount: 0 });
  s.recordArbiterDrain({ delivered: true, ts: T + 2, sessionId: "sess-a", mode: "passive-context", headlineCls: 5, drainSize: 1, tailCount: 0 });
  s.recordArbiterDrain({ delivered: true, ts: T + 3, sessionId: "sess-a", mode: "forced-turn", headlineCls: 2, drainSize: 3, tailCount: 2 });

  const rows = s.getArbiterDrains(0);
  assert.strictEqual(rows.length, 3);
  const distribution = new Map<number, number>();
  for (const r of rows) {
    assert.strictEqual(r.drain_size, 1 + r.tail_count, "drain_size === 1 + tail_count (headline + tail)");
    distribution.set(r.drain_size, (distribution.get(r.drain_size) ?? 0) + 1);
  }
  assert.strictEqual(distribution.get(1), 2);
  assert.strictEqual(distribution.get(3), 1);
  s.close();
});

test("recordArbiterDrain/getArbiterDrains are fail-soft on a closed handle", () => {
  const s: AnyRec = seed();
  assertStoreSeam(s, "recordArbiterDrain");
  s.close();
  assert.doesNotThrow(() => s.recordArbiterDrain({ delivered: true, ts: T, sessionId: null, mode: "forced-turn", headlineCls: 2, drainSize: 1, tailCount: 0 }));
  let rows: unknown;
  assert.doesNotThrow(() => { rows = s.getArbiterDrains(0); });
  assert.deepStrictEqual(rows, []);
});

// ── (4) retention: 30d default, same cadence as the v9 telemetry siblings ──────────────────────

test("pruneIncremental sweeps jump_over + arbiter_drain at the 30d default, keeping fresh rows", () => {
  const s: AnyRec = seed();
  assertStoreSeam(s, "recordJumpOver");
  assertStoreSeam(s, "recordArbiterDrain");
  const NOW = T + 365 * DAY;
  s.recordJumpOver({ ts: NOW - 31 * DAY, sessionId: "sess-old", producer: "ack", cls: 4, detail: "stale" });
  s.recordJumpOver({ ts: NOW - 1 * DAY, sessionId: "sess-new", producer: "ack", cls: 4, detail: "fresh" });
  s.recordArbiterDrain({ delivered: true, ts: NOW - 31 * DAY, sessionId: "sess-old", mode: "forced-turn", headlineCls: 2, drainSize: 2, tailCount: 1 });
  s.recordArbiterDrain({ delivered: true, ts: NOW - 1 * DAY, sessionId: "sess-new", mode: "forced-turn", headlineCls: 2, drainSize: 1, tailCount: 0 });

  pruneIncremental((s as AnyRec).db, { now: NOW, eventsTtlDays: 30, archiveTtlDays: 14 });

  const jumpRows = s.getJumpOvers(0);
  assert.deepStrictEqual(jumpRows.map((r: AnyRec) => r.session_id), ["sess-new"],
    "a >30d jump_over row is pruned; the fresh row survives (gemini_turn_usage's exact posture)");
  const drainRows = s.getArbiterDrains(0);
  assert.deepStrictEqual(drainRows.map((r: AnyRec) => r.session_id), ["sess-new"],
    "a >30d arbiter_drain row is pruned; the fresh row survives");
  s.close();
});

// ── (5) the pure jump-over classifier ──────────────────────────────────────────────────────────

function ack(overrides: Partial<AckTurnState> = {}): AckTurnState {
  // Baseline: turn CLEAR — operator last spoke well past the hold window, no barge-in.
  return { lastOperatorSpeechAt: T - 10 * OPERATOR_HOLD_MS, interrupted: false, now: T, ...overrides };
}

test("isJumpOverSend is exported from src/voice/index.ts as a pure classifier", () => {
  assert.strictEqual(typeof isJumpOverSend, "function",
    "Wave-4 feature absent: src/voice/index.ts must export isJumpOverSend({ turnComplete, cls?, ack }) " +
      "— the pure classifier the jump_over counter records against (derived from shouldSpeakReadyAck, " +
      "in-process TS per the LOCKED seam rule; never a parallel clock)");
});

test("isJumpOverSend truth table: only a forced turn over a non-clear floor counts", () => {
  assert.strictEqual(typeof isJumpOverSend, "function",
    "Wave-4 feature absent: isJumpOverSend must exist first (see the export test)");
  const midUtterance = ack({ lastOperatorSpeechAt: T - 100 }); // inside OPERATOR_HOLD_MS
  const bargeIn = ack({ interrupted: true });
  const clear = ack();

  // Passive context can never jump anything, whatever the floor state.
  assert.strictEqual(isJumpOverSend!({ turnComplete: false, cls: 5, ack: midUtterance }), false);
  assert.strictEqual(isJumpOverSend!({ turnComplete: false, cls: 5, ack: bargeIn }), false);
  // A forced turn on a CLEAR floor is legitimate — the arbiter's whole steady state.
  assert.strictEqual(isJumpOverSend!({ turnComplete: true, cls: 2, ack: clear }), false);
  // A forced turn mid-utterance or over a barge-in IS the jump-over.
  assert.strictEqual(isJumpOverSend!({ turnComplete: true, cls: 2, ack: midUtterance }), true,
    "a forced turn inside the operator-hold window is the audit's §2.1 defect — it must classify true");
  assert.strictEqual(isJumpOverSend!({ turnComplete: true, ack: midUtterance }), true,
    "an unclassed forced send (a rogue producer) still counts — the ratchet's belt gets braces");
  assert.strictEqual(isJumpOverSend!({ turnComplete: true, cls: 3, ack: bargeIn }), true);
  // Class-1 exemption: the operator just spoke — the turn is THEIRS to fill (spec §3.1 class 1;
  // the same reason family D tool responses are exempt).
  assert.strictEqual(isJumpOverSend!({ turnComplete: true, cls: 1, ack: midUtterance }), false,
    "operator-response echoes are exempt: answering the operator mid-utterance is not a hijack");
});

test("structurally zero: a digest drained at turn-clear can never classify as a jump-over", () => {
  assert.strictEqual(typeof isJumpOverSend, "function",
    "Wave-4 feature absent: isJumpOverSend must exist first (see the export test)");
  // The REAL arbiter only ever returns "drain" when the caller reports turnClear — and turnClear
  // is derived from the SAME ack state the classifier reads (shouldSpeakReadyAck === "speak").
  // Composing the two proves the invariant the counter exists to watch: arbiter-timed sends are
  // jump-over-free BY CONSTRUCTION, not by luck.
  const arb = createTurnArbiter();
  arb.submit({ facts: "approval d1 expires in a minute", cls: 2, coalesceKey: "last-call:d1" });
  const clear = ack();
  const turnClear = true; // === (shouldSpeakReadyAck(clear) === "speak") — the drain precondition
  const d: AnyRec = arb.evaluate({ now: T, floorHeld: false, turnClear });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(isJumpOverSend!({ turnComplete: true, cls: d.digest.headline.cls, ack: clear }), false,
    "a drain fired at genuine turn-clear classifies false — the steady-state jump_over count is zero");
  // And the arbiter refuses to drain when the floor ISN'T clear — the other half of the proof.
  const arb2 = createTurnArbiter();
  arb2.submit({ facts: "approval d2 expires in a minute", cls: 2, coalesceKey: "last-call:d2" });
  assert.strictEqual(arb2.evaluate({ now: T, floorHeld: true, turnClear: false }).action, "hold",
    "no drain exists to send mid-floor, so nothing arbiter-timed can ever be recorded as a jump-over");
});

// ── (6) wiring: the classifier + writers are consumed at the real choke points ─────────────────

test("src/voice/index.ts consumes isJumpOverSend and records jump_over + arbiter_drain rows", () => {
  const src = fs.readFileSync(path.join(repoRoot, "src", "voice", "index.ts"), "utf8");
  const lines = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));

  const classifierMentions = lines.filter((l) => /\bisJumpOverSend\b/.test(l)).length;
  assert.ok(classifierMentions >= 2,
    "Wave-4 feature absent: src/voice/index.ts must define isJumpOverSend AND call it at a " +
      "forced-send choke point (a classifier nobody calls counts nothing) — found " +
      `${classifierMentions} non-comment mention(s), need the definition plus a call site`);

  const jumpWrites = lines.filter((l) => /\brecordJumpOver\b/.test(l)).length;
  assert.ok(jumpWrites >= 1,
    "Wave-4 feature absent: the jump_over counter must actually be WRITTEN from the voice send " +
      "path (store.recordJumpOver) — zero rows must mean 'no jump-overs happened', never " +
      "'nobody was counting'");

  const drainWrites = lines.filter((l) => /\brecordArbiterDrain\b/.test(l)).length;
  assert.ok(drainWrites >= 1,
    "Wave-4 feature absent: every arbiter drain must write its distribution row " +
      "(store.recordArbiterDrain) on the drain path");
});
