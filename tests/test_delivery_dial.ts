// tests/test_delivery_dial.ts — fikj.12 RED: the D4 delivery-mode dial becomes operator-tunable.
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md §3.2 (D4 "A dial, with a floor");
// beads fikj.12. Task 1 pins the arbiter's live re-dial seam (updateMatrix); Task 2 pins the
// settings boundary (clamp + violations, never a silent value); Task 3 pins the live
// completionAnnounce read at the idle edge (source-conformance, the test_turn_arbiter_journeys
// item-2/3 idiom).
//
// Runner: npx tsx --test --test-force-exit tests/test_delivery_dial.ts

process.env.JANUS_NO_AUTOSTART = "1";
if (!process.env.JANUS_DB) process.env.JANUS_DB = ":memory:";

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnArbiter, DEFAULT_DELIVERY_MATRIX } from "../src/voice/turnArbiter";

type AnyRec = Record<string, any>;
const T0 = 1_700_000_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ── Task 1: TurnArbiter.updateMatrix ───────────────────────────────────────────────────────────

test("updateMatrix exists and re-dials a class without dropping queued items", () => {
  const arb: AnyRec = createTurnArbiter();
  assert.strictEqual(typeof arb.updateMatrix, "function",
    "fikj.12 feature absent: TurnArbiter.updateMatrix(raw) must exist (live re-dial, no reconstruction)");
  arb.submit({ facts: "pane p1 finished", cls: 3, paneId: "p1" });
  const result = arb.updateMatrix({ "3": "passive-context" });
  assert.deepStrictEqual(result.violations, [], "an in-floor dial produces no violations");
  const d = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.mode, "passive-context",
    "an item queued BEFORE the dial drains under the NEW mode (the matrix is swapped, the queue is not touched)");
});

test("updateMatrix clamps under-floor values and reports the violation (classes 0/2 refuse passive)", () => {
  const arb: AnyRec = createTurnArbiter();
  const result = arb.updateMatrix({ "0": "passive-context", "2": "passive-context" });
  assert.strictEqual(result.violations.length, 2, "one violation per clamped class");
  assert.strictEqual(result.matrix[0], "steered-digest", "class 0 clamps to the steered-digest floor");
  assert.strictEqual(result.matrix[2], "steered-digest", "class 2 clamps to the steered-digest floor");
  arb.submit({ facts: "correction: pane p1 — retracting", cls: 0, paneId: "p1" });
  const d = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.notStrictEqual(d.mode, "passive-context", "the never-silent floor holds in the live decision core");
});

test("updateMatrix falls back to per-class defaults on garbage and reports class-1 dial attempts", () => {
  const arb: AnyRec = createTurnArbiter();
  const result = arb.updateMatrix({ "3": "silent", "1": "forced-turn" });
  assert.ok(result.violations.some((v: string) => v.includes("class 3")), "the invalid class-3 value is reported");
  assert.ok(result.violations.some((v: string) => v.includes("class 1")), "class 1 has no dial — reported, ignored");
  assert.strictEqual(result.matrix[3], DEFAULT_DELIVERY_MATRIX[3], "garbage falls back to the class default, never a throw");
});
