// tests/test_arbiter_drain_delivered.ts — bead r59t RED: `arbiter_drain` telemetry over-counts
// deliveries.
//
// THE DEFECT. sendArbiterDigest (src/voice/index.ts) catches the sendClientContent throw, keeps
// `sent=false` for the drain tick's never-drop resubmission (f30c914) — and then calls
// store.recordArbiterDrain UNCONDITIONALLY, with no field saying whether anything actually reached
// the model. So one real delivery that failed twice writes THREE rows that read identically to
// three deliveries. The v02l watch gate (`npm run telemetry:arbiter`) judges the D2 headline +
// counted-tail policy off the drain_size distribution over those rows, so every failed attempt and
// every retry skews the number a P1 gate is decided on. This is the J0 utterance⇄state divergence
// class at the telemetry layer: the ledger claims a delivery the operator never heard.
//
// THE CONTRACT PINNED HERE (the fix shape from the bead):
//   1. `arbiter_drain` rows carry a `delivered` flag — read back as SqlBool (0|1, the repo's raw-row
//      convention, e.g. PendingApprovalRow.claimed) or a real boolean. ABSENT/NULL on a row the
//      current code just wrote is the defect.
//   2. sendArbiterDigest writes that flag from its OWN send verdict — the same `sent` it returns.
//      Failed attempt -> delivered false; the resubmitted retry that lands -> delivered true. Rows
//      are still recorded for BOTH attempts (never-drop telemetry, pinned by
//      tests/test_vcd_producer_completion.ts) — the fix DISTINGUISHES them, it does not drop them.
//      Invariant: #rows marked delivered === #digests that actually reached the session.
//   3. scripts/arbiter-telemetry.ts surfaces it: the drain_size distribution the v02l watch reads is
//      over DELIVERED rows only, and the undelivered attempts are reported separately — their count
//      AND their sizes (excluded from the delivery distribution, never hidden from the reviewer).
//   4. SCHEMA: a NEW numbered migration in src/store/schema.ts (+ SCHEMA_VERSION bump), never an
//      edit to the v14 DDL — an existing .janus.db must upgrade in place with its old rows intact.
//      Pre-column rows read back with delivered NULL and must still COUNT as drains (backward
//      compatible: they predate the flag, they are not failures).
//
// Idiom: real in-memory/temp-file JanusStore through the real record/read API (the
// tests/test_arbiter_telemetry.ts idiom), the real arbiter + real sendArbiterDigest end to end (the
// tests/test_vcd_producer_completion.ts never-drop idiom), and the MIGRATIONS-prefix fixture
// technique from tests/test_store_migration.ts. No new harness, no SQL duplication.
//
// Runner: npx tsx --test --test-force-exit tests/test_arbiter_drain_delivered.ts
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { JanusStore } from "../src/store/sqliteStore";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/store/schema";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import * as voiceIndexModule from "../src/voice/index";
import { buildArbiterTelemetryReport } from "../scripts/arbiter-telemetry";

type AnyRec = Record<string, any>;
const voiceIndex = voiceIndexModule as AnyRec;
const T0 = 1_700_000_000_000;
/** The schema version that shipped `arbiter_drain` WITHOUT a delivered flag (bead v02l's T4 tables). */
const V14 = 14;
/** ack state with a long-silent operator: shouldSpeakReadyAck === "speak", so no jump_over row is
 *  ever recorded and the reports below are pure drain reports. */
const QUIET_ACK = { lastOperatorSpeechAt: 0, interrupted: false, now: T0 };

/** The `delivered` flag as the fix must surface it on a row this code path just WROTE. Accepts
 *  0|1 (SqlBool) or a boolean; absent/NULL is the r59t defect. */
function deliveredFlag(row: AnyRec, where: string): boolean {
  const v = row.delivered;
  assert.ok(
    v !== undefined && v !== null,
    `r59t: the arbiter_drain row for ${where} carries NO \`delivered\` flag (row.delivered === ${JSON.stringify(v)}). ` +
      "recordArbiterDrain is called unconditionally after the send, so a failed send — and each " +
      "never-drop retry of it — is stored indistinguishably from a real delivery, inflating the " +
      "drain-size distribution the v02l watch gate is judged on. Add a `delivered` column " +
      "(new src/store/schema.ts migration + SCHEMA_VERSION bump), persist it in recordArbiterDrain, " +
      "and write it from sendArbiterDigest's own send verdict.",
  );
  return v === true || v === 1;
}

/** The report's drain-size distribution line for DELIVERED drains: the `min=… p50=… p90=… max=…`
 *  line that is NOT labelled as the undelivered/failed one. */
function deliveredSizeDist(out: string): { min: number; p50: number; p90: number; max: number } {
  const distLines = out.split("\n").filter((l) => /min=\d+/.test(l));
  assert.ok(distLines.length > 0, `no drain_size distribution line in the report:\n${out}`);
  const line = distLines.find((l) => !/undeliver|not delivered|fail/i.test(l));
  assert.ok(line, `no DELIVERED drain_size distribution line in the report:\n${out}`);
  const m = line!.match(/min=(\d+)\s*p50=(\d+)\s*p90=(\d+)\s*max=(\d+)/);
  assert.ok(m, `malformed drain_size distribution line ${JSON.stringify(line)}`);
  return { min: Number(m![1]), p50: Number(m![2]), p90: Number(m![3]), max: Number(m![4]) };
}

/** The report line (if any) that talks about undelivered/failed attempts. */
function failureLine(out: string): string | undefined {
  return out.split("\n").find((l) => /undeliver|not delivered|fail/i.test(l));
}

/** Drain `n` fresh class-3 items out of a real arbiter -> a real Digest of drain_size n. */
function drainOfSize(arb: AnyRec, n: number, now: number): AnyRec {
  for (let i = 0; i < n; i++) arb.submit({ facts: `pane p${now}-${i} finished`, cls: 3, paneId: `p${now}-${i}` });
  const d = arb.evaluate({ now, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain", "harness precondition: the arbiter must drain the submitted items");
  assert.strictEqual(1 + d.digest.tailCount, n, `harness precondition: drain_size ${n}`);
  return d;
}

// ── 1. The core defect, end to end through the REAL choke point + the REAL store ────────────────

test("r59t: a thrown send records an UNDELIVERED drain row; only the retry that lands counts as a delivery", () => {
  const send = voiceIndex.sendArbiterDigest;
  assert.strictEqual(typeof send, "function", "precondition: src/voice/index.ts exports sendArbiterDigest");
  const store = new JanusStore(":memory:");
  store.init();
  const arb = createTurnArbiter() as AnyRec;
  try {
    // The digest that FAILS is a fat one (headline + 2 tail = drain_size 3); the one that LANDS is a
    // lone item (drain_size 1). Distinct sizes tie each stored row to its attempt unambiguously —
    // and they are exactly the skew bead r59t is about: a size-3 attempt nobody heard would sit in
    // the v02l distribution next to real deliveries.
    const dead = { sendClientContent: () => { throw new Error("socket died mid-send"); } };
    const landed: AnyRec[] = [];
    const live = { sendClientContent: (c: AnyRec) => { landed.push(c); } };

    const failed = drainOfSize(arb, 3, T0);
    const sentFail = send(dead, store, "sess-r59t", QUIET_ACK, failed.digest, failed.mode);
    assert.strictEqual(sentFail, false, "precondition (f30c914): a throwing send REPORTS failure");

    const ok = drainOfSize(arb, 1, T0 + 5_000);
    const sentOk = send(live, store, "sess-r59t", QUIET_ACK, ok.digest, ok.mode);
    assert.strictEqual(sentOk, true, "precondition: a healthy send reports success");
    assert.strictEqual(landed.length, 1, "precondition: exactly ONE digest actually reached the model");

    const rows = store.getArbiterDrains(0) as AnyRec[];
    assert.strictEqual(rows.length, 2,
      "both attempts stay recorded (never-drop telemetry) — r59t makes them DISTINGUISHABLE, it does not drop rows");

    // The invariant the v02l watch needs: deliveries on the ledger === digests that reached the model.
    const deliveredCount = rows.filter((r) => deliveredFlag(r, `the drain_size-${r.drain_size} attempt`)).length;
    assert.strictEqual(deliveredCount, landed.length,
      `arbiter_drain must record ${landed.length} delivery, not ${deliveredCount}: a swallowed send throw is not a delivery`);

    const failedRow = rows.find((r) => r.drain_size === 3)!;
    const okRow = rows.find((r) => r.drain_size === 1)!;
    assert.strictEqual(deliveredFlag(failedRow, "the size-3 digest whose send threw"), false,
      "the drain whose sendClientContent threw must be stored delivered:false — the operator never heard it");
    assert.strictEqual(deliveredFlag(okRow, "the size-1 digest that landed"), true,
      "the drain that actually reached the session must be stored delivered:true");
  } finally {
    store.close();
  }
});

// ── 2. The store API round-trips the flag ──────────────────────────────────────────────────────

test("r59t: recordArbiterDrain persists `delivered` and getArbiterDrains reads it back", () => {
  const store = new JanusStore(":memory:");
  store.init();
  try {
    const rec = (store as AnyRec).recordArbiterDrain.bind(store);
    rec({ ts: T0, sessionId: "s1", mode: "forced-turn", headlineCls: 2, drainSize: 2, tailCount: 1, delivered: false });
    rec({ ts: T0 + 1_000, sessionId: "s1", mode: "steered-digest", headlineCls: 3, drainSize: 1, tailCount: 0, delivered: true });

    const rows = store.getArbiterDrains(0) as AnyRec[];
    assert.strictEqual(rows.length, 2, "both rows persisted");
    const undelivered = rows.find((r) => r.drain_size === 2)!;
    const delivered = rows.find((r) => r.drain_size === 1)!;
    assert.strictEqual(deliveredFlag(undelivered, "an explicitly UNDELIVERED write"), false,
      "recordArbiterDrain({delivered:false}) must persist false, not drop the field");
    assert.strictEqual(deliveredFlag(delivered, "an explicitly DELIVERED write"), true,
      "recordArbiterDrain({delivered:true}) must persist true");
    // The pre-existing columns keep their meaning (purely additive change).
    assert.strictEqual(undelivered.mode, "forced-turn");
    assert.strictEqual(delivered.headline_cls, 3);
  } finally {
    store.close();
  }
});

// ── 3. The v02l watch surface: the distribution is over DELIVERED rows only ─────────────────────

test("r59t: the telemetry report keeps failed attempts OUT of the drain-size distribution and reports their count", () => {
  const store = new JanusStore(":memory:");
  store.init();
  try {
    const rec = (store as AnyRec).recordArbiterDrain.bind(store);
    // Two real deliveries (sizes 1 and 2) and one fat attempt (size 7) that never reached the model.
    rec({ ts: T0, sessionId: "s1", mode: "steered-digest", headlineCls: 3, drainSize: 1, tailCount: 0, delivered: true });
    rec({ ts: T0 + 1_000, sessionId: "s1", mode: "steered-digest", headlineCls: 3, drainSize: 2, tailCount: 1, delivered: true });
    rec({ ts: T0 + 2_000, sessionId: "s1", mode: "forced-turn", headlineCls: 2, drainSize: 7, tailCount: 6, delivered: false });

    const out = buildArbiterTelemetryReport(store, { sinceTs: 0 });

    const dist = deliveredSizeDist(out);
    assert.strictEqual(dist.max, 2,
      "the drain_size distribution the v02l gate reads must cover DELIVERED drains only — the size-7 " +
        `attempt that never reached the model must not skew it (got max=${dist.max}):\n${out}`);
    assert.strictEqual(dist.min, 1, `delivered-only min over [1,2] (got ${dist.min}):\n${out}`);
    assert.strictEqual(dist.p50, 1, `delivered-only p50, nearest-rank over [1,2] (got ${dist.p50}):\n${out}`);

    const failed = failureLine(out);
    assert.ok(failed, `the report must SURFACE the undelivered attempts, not hide them:\n${out}`);
    assert.match(failed!, /\b1\b/,
      `the undelivered attempt count (1) must appear on its own line (got ${JSON.stringify(failed)}):\n${out}`);
    assert.match(out, /\b7\b/,
      "the undelivered attempts must stay READABLE, not merely excluded — print their sizes too (their " +
        "own size line, or the rows), so a v02l reviewer can see WHAT failed to land:\n" + out);
  } finally {
    store.close();
  }
});

// ── 4. Schema: an existing .janus.db upgrades in place; pre-column rows still count ─────────────

test("r59t: a v14 .janus.db migrates in place — old arbiter_drain rows survive and still count as drains", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-r59t-"));
  const dbPath = path.join(dir, ".janus.db");

  // A REAL pre-fix ledger: schema exactly v14 (MIGRATIONS prefix, the test_store_migration idiom)
  // with two rows written before the delivered column existed.
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  for (let i = 0; i < V14; i++) MIGRATIONS[i](raw);
  raw.pragma(`user_version = ${V14}`);
  const preCols = (raw.prepare("PRAGMA table_info(arbiter_drain)").all() as AnyRec[]).map((c) => c.name);
  assert.ok(!preCols.includes("delivered"), "fixture precondition: a v14 arbiter_drain has no delivered column");
  const insert = raw.prepare(
    `INSERT INTO arbiter_drain(ts,session_id,mode,headline_cls,drain_size,tail_count) VALUES(?,?,?,?,?,?)`,
  );
  insert.run(T0, "legacy-sess", "steered-digest", 3, 5, 4);
  insert.run(T0 + 1_000, "legacy-sess", "forced-turn", 2, 1, 0);
  raw.close();

  const store = new JanusStore(dbPath);
  try {
    store.init(); // the real applyMigrations, on a real on-disk pre-fix DB

    assert.ok(SCHEMA_VERSION > V14,
      `r59t: the delivered column must land as a NEW numbered migration with a SCHEMA_VERSION bump ` +
        `(still ${SCHEMA_VERSION}) — editing the v14 DDL in place would leave every existing .janus.db without the column`);
    assert.strictEqual(store.db.pragma("user_version", { simple: true }), SCHEMA_VERSION,
      "an existing DB must end up at the current SCHEMA_VERSION after init()");
    const cols = (store.db.prepare("PRAGMA table_info(arbiter_drain)").all() as AnyRec[]).map((c) => c.name);
    assert.ok(cols.includes("delivered"), `arbiter_drain must gain a delivered column post-migration (got ${cols.join(",")})`);

    const rows = store.getArbiterDrains(0) as AnyRec[];
    assert.strictEqual(rows.length, 2, "the column add must not lose a single pre-existing row");
    assert.deepStrictEqual(rows.map((r) => r.drain_size).sort((a, b) => a - b), [1, 5],
      "pre-existing rows keep their values across the migration");

    // Backward compatibility: rows written before the flag existed are historical DRAINS, not
    // failures — the script must still count them, and must not blame them as undelivered.
    const out = buildArbiterTelemetryReport(store, { sinceTs: 0 });
    const dist = deliveredSizeDist(out);
    assert.strictEqual(dist.max, 5,
      `a pre-column row (delivered NULL) must still count in the drain distribution — the script stays ` +
        `backward-compatible instead of dropping history (got max=${dist.max}):\n${out}`);
    const failed = failureLine(out);
    if (failed) {
      assert.match(failed, /\b0\b|none/i,
        `legacy rows predate the delivered flag and must NOT be counted as failed attempts (got ${JSON.stringify(failed)}):\n${out}`);
    }
  } finally {
    store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
});

// ── the UNMIGRATED read: `delivered` is ABSENT, not null ────────────────────────────────────────
//
// Adversarial-review finding: test 4 above calls store.init(), so its legacy rows read back
// `delivered: null`. But scripts/arbiter-telemetry.ts deliberately NEVER migrates — it opens the
// operator's real .janus.db read-only (`new JanusStore(dbPath)` with no init()). Against a pre-v15
// DB, `SELECT *` therefore yields rows with NO `delivered` property at all: `undefined`, a shape
// nothing else in this suite exercises. `wasDelivered`'s `r.delivered !== 0` is correct for both,
// but a future rewrite to `=== null` / `?? `-narrowing (invited by a non-optional type) would
// reclassify every historical row on an unmigrated DB as a FAILED send with every other test green.
// That is why ArbiterDrainRow.delivered is declared OPTIONAL. This pins the behavior, not the type.

test("r59t: the telemetry script reads an UNMIGRATED v14 DB — absent `delivered` counts as a drain, not a failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-r59t-nomigrate-"));
  const dbPath = path.join(dir, ".janus.db");

  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  for (let i = 0; i < V14; i++) MIGRATIONS[i](raw);
  raw.pragma(`user_version = ${V14}`);
  raw.prepare(
    `INSERT INTO arbiter_drain(ts,session_id,mode,headline_cls,drain_size,tail_count) VALUES(?,?,?,?,?,?)`,
  ).run(T0, "legacy-sess", "steered-digest", 3, 7, 6);
  raw.close();

  // EXACTLY what the CLI does: open, never init/migrate.
  const store = new JanusStore(dbPath);
  try {
    assert.strictEqual(store.db.pragma("user_version", { simple: true }), V14,
      "fixture precondition: the DB must stay at v14 — this test is about the NEVER-MIGRATED read path");

    const rows = store.getArbiterDrains(0) as AnyRec[];
    assert.strictEqual(rows.length, 1, "the unmigrated read still returns the row");
    assert.ok(!("delivered" in rows[0]),
      "fixture precondition: on a v14 table `SELECT *` yields NO delivered property — this is the " +
        `\`undefined\` shape (distinct from the migrated NULL), got ${JSON.stringify(rows[0])}`);

    const out = buildArbiterTelemetryReport(store, { sinceTs: 0 });
    const dist = deliveredSizeDist(out);
    assert.strictEqual(dist.max, 7,
      "r59t: a row whose `delivered` property is ABSENT (unmigrated DB) is a historical drain and must " +
        `still count in the distribution. A \`delivered === null\` check would silently drop it:\n${out}`);
    const failed = failureLine(out);
    if (failed) {
      assert.match(failed, /\b0\b|none/i,
        `r59t: an absent flag must NEVER be blamed as a failed send (got ${JSON.stringify(failed)}):\n${out}`);
    }
  } finally {
    store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
});
