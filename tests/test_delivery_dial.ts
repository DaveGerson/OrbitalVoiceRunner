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

test("updateMatrix is a FULL REPLACE: classes absent from a later call revert to their defaults (never pass a delta)", () => {
  const arb: AnyRec = createTurnArbiter();
  arb.updateMatrix({ "4": "forced-turn" });
  const second = arb.updateMatrix({ "3": "passive-context" });
  assert.strictEqual(second.matrix[4], DEFAULT_DELIVERY_MATRIX[4],
    "class 4 reverted to its default -- a delta call un-dials every unspecified class");
  arb.submit({ facts: "pane p1 acked", cls: 4, paneId: "p1" });
  const d = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.mode, DEFAULT_DELIVERY_MATRIX[4],
    "the live drain uses the reverted default, not the stale earlier dial");
});

test("class 1 (operator-response) is dial-immune: the immediate path drains forced-turn regardless of the matrix", () => {
  const arb: AnyRec = createTurnArbiter();
  arb.updateMatrix({ "0": "steered-digest", "2": "steered-digest", "3": "passive-context", "4": "passive-context", "5": "passive-context" });
  arb.submit({ facts: "answering the operator", cls: 1 });
  const d = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.mode, "forced-turn", "the class-1 immediate path is not dialable");
});

// ── Task 2: the settings boundary (server.ts validateSettingsPutBody) ──────────────────────────
// server.ts is imported DEFERRED (env guards at module top of this file) — the same preamble
// tests/helpers/mockLive.ts uses, so no real listener boots.

const { validateSettingsPutBody } = await import("../server");

test("PUT boundary: an under-floor deliveryMatrix CLAMPS in place and surfaces dialViolations (never a 400)", () => {
  const body: AnyRec = { voiceAi: { deliveryMatrix: { "0": "passive-context", "3": "passive-context" } } };
  const v: AnyRec = validateSettingsPutBody(body);
  assert.strictEqual(v.ok, true, "an under-floor value is a policy clamp, not a rejection");
  assert.ok(Array.isArray(v.dialViolations), "fikj.12 feature absent: validateSettingsPutBody must return dialViolations");
  assert.strictEqual(v.dialViolations.length, 1, "exactly the class-0 clamp is reported");
  assert.strictEqual(body.voiceAi.deliveryMatrix["0"], "steered-digest", "clamped IN PLACE — the persisted value is the clamped truth");
  assert.strictEqual(body.voiceAi.deliveryMatrix["3"], "passive-context", "class 3 has no floor — passes through");
});

test("PUT boundary: unknown matrix class keys are dropped by normalization; garbage values fall back + report", () => {
  const body: AnyRec = { voiceAi: { deliveryMatrix: { "7": "forced-turn", "4": "loud" } } };
  const v: AnyRec = validateSettingsPutBody(body);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(body.voiceAi.deliveryMatrix["7"], undefined, "unknown class stripped (the full normalized matrix replaces the raw map)");
  assert.strictEqual(body.voiceAi.deliveryMatrix["4"], DEFAULT_DELIVERY_MATRIX[4], "garbage value -> the class default");
  assert.ok(v.dialViolations.some((s: string) => s.includes("class 4")), "the fallback is reported");
});

test("PUT boundary: a non-enum completionAnnounce is a 400 naming the field (retired 'focused' included)", () => {
  const v: AnyRec = validateSettingsPutBody({ voiceAi: { completionAnnounce: "focused" } });
  assert.strictEqual(v.ok, false, "strict-when-present, same as voiceUx.sitrepShape");
  assert.ok(String(v.error).includes("voiceAi.completionAnnounce"), `error names the field, got: ${v.error}`);
  const ok: AnyRec = validateSettingsPutBody({ voiceAi: { completionAnnounce: "exceptions" } });
  assert.strictEqual(ok.ok, true);
});

test("PUT boundary: absent voiceAi / absent dial fields are untouched (back-compat)", () => {
  const v1: AnyRec = validateSettingsPutBody({ advanced: { globalPermissionsMode: "Inherit" } });
  assert.strictEqual(v1.ok, true);
  assert.deepStrictEqual(v1.dialViolations ?? [], [], "no dial fields -> no violations");
  const v2: AnyRec = validateSettingsPutBody({ voiceAi: { voice: "Zephyr" } });
  assert.strictEqual(v2.ok, true, "a voiceAi block without dial fields validates exactly as before");
});

test("server.ts constructs the boot arbiter FROM settings and wires the PUT re-dial (source conformance)", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "server.ts"), "utf-8");
  assert.ok(src.includes("createTurnArbiter({ matrix: manager.settings.voiceAi?.deliveryMatrix })"),
    "fikj.12 feature absent: the boot arbiter must be constructed from the persisted deliveryMatrix");
  assert.ok(src.includes("applyDialAndCollectFragment(validated.dialViolations, applyDeliveryDial)"),
    "fikj.12 feature absent: the settings PUT must re-dial the LIVE arbiter (applyDeliveryDial dep)");
  assert.ok(src.includes("turnArbiter.updateMatrix(manager.settings.voiceAi?.deliveryMatrix)"),
    "the re-dial must read the (already clamped + persisted) settings value");
});

// ── Task 3: the idle-edge completion policy reads LIVE settings ────────────────────────────────

test("the idle-edge completionNarration site reads voiceAi.completionAnnounce, not the hardcoded default", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "src/voice/index.ts"), "utf-8");
  assert.ok(src.includes("normalizeCompletionAnnounce(manager.settings.voiceAi?.completionAnnounce)"),
    "fikj.12 feature absent: the production completionNarration call site must read the live setting");
  assert.ok(!src.includes("policy: DEFAULT_COMPLETION_ANNOUNCE"),
    "the hardcoded spec default must not remain at the production call site");
});
