// tests/test_turn_arbiter_matrix.ts — Wave 1 RED: the delivery-mode matrix (D4 — "a dial, with a floor").
//
// Pins spec §3.2 (docs/superpowers/specs/2026-07-29-turn-arbiter-design.md): per-class delivery mode
// `forced-turn | steered-digest | passive-context`, capability-gate settings idiom. The floor is the
// standing invariant made mechanical: classes 0-2 refuse `passive-context` (minimum steered-digest),
// NO class can be configured silent (no "off"/silent value exists at all), and class 1 has no dial.
// Validation lives at the settings boundary (normalizeDeliveryMatrix — the pure validator the
// settings PUT will call) AND inside the core (defense in depth, covered here + in
// tests/test_turn_arbiter_core.ts).
//
// Pinned validator contract:
//   normalizeDeliveryMatrix(raw: unknown): { matrix; violations: string[] }
//     - matrix keys: classes 0,2,3,4,5 ONLY (class 1 is undialed — always immediate).
//     - absent/undefined input → DEFAULT_DELIVERY_MATRIX, violations [].
//     - a VALID but under-floor value (passive-context on class 0-2) → clamped to "steered-digest",
//       violation recorded (told-more: never silently accepted, never silently dropped).
//     - an INVALID value (off/silent/none/garbage/non-string) → that class falls back to its
//       DEFAULT, violation recorded. No input can ever produce a silent class.
//     - an attempt to dial class 1 → stripped from the matrix, violation recorded.
//     - pure: the raw input object is never mutated.
//
// Defaults (D4): 0=forced-turn, 2=forced-turn, 3=steered-digest, 4=steered-digest, 5=passive-context.
//
// Runner: npx tsx --test --test-force-exit tests/test_turn_arbiter_matrix.ts

import { test } from "node:test";
import assert from "node:assert";

type AnyRec = Record<string, any>;

// Computed specifier: keeps `npm run lint` (tsc) green while the module is unimplemented; tsx
// resolves it at runtime. Every test fails "Wave-1 feature absent" until turnArbiter.ts exists.
const ARBITER_SPEC = ["..", "src", "voice", "turnArbiter"].join("/");

async function loadArbiter(): Promise<AnyRec> {
  try {
    return await import(ARBITER_SPEC);
  } catch (e: any) {
    return assert.fail(
      "Wave-1 feature absent: src/voice/turnArbiter.ts is not implemented yet " +
        `(turn-arbiter spec §3.2) — import failed: ${e?.message ?? e}`,
    );
  }
}

const EXPECTED_DEFAULTS: Record<string, string> = {
  "0": "forced-turn",
  "2": "forced-turn",
  "3": "steered-digest",
  "4": "steered-digest",
  "5": "passive-context",
};

const VALID_MODES = new Set(["forced-turn", "steered-digest", "passive-context"]);

/** String-keyed snapshot so numeric/string key drift can't hide a wrong shape. */
function snapshot(matrix: AnyRec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(matrix ?? {})) out[String(k)] = matrix[k];
  return out;
}

test("DEFAULT_DELIVERY_MATRIX pins the D4 defaults exactly — and class 1 is undialed", async () => {
  const mod = await loadArbiter();
  assert.deepStrictEqual(
    snapshot(mod.DEFAULT_DELIVERY_MATRIX),
    EXPECTED_DEFAULTS,
    "defaults: 0=forced, 2=forced, 3=steered, 4=steered, 5=passive; NO class-1 entry exists",
  );
});

test("absent input normalizes to the defaults with zero violations", async () => {
  const mod = await loadArbiter();
  const r = mod.normalizeDeliveryMatrix(undefined);
  assert.deepStrictEqual(snapshot(r.matrix), EXPECTED_DEFAULTS);
  assert.deepStrictEqual(r.violations, [], "nothing to report on a clean default config");
});

test("a valid override is accepted cleanly and merged over the defaults", async () => {
  const mod = await loadArbiter();
  const r = mod.normalizeDeliveryMatrix({ 3: "forced-turn", 5: "steered-digest" });
  assert.deepStrictEqual(snapshot(r.matrix), {
    ...EXPECTED_DEFAULTS,
    "3": "forced-turn",
    "5": "steered-digest",
  });
  assert.deepStrictEqual(r.violations, []);
});

test("D4 floor: classes 0 and 2 refuse passive-context — clamped to steered-digest WITH a violation", async () => {
  const mod = await loadArbiter();
  const raw = { 0: "passive-context", 2: "passive-context" };
  const r = mod.normalizeDeliveryMatrix(raw);
  assert.strictEqual(r.matrix[0], "steered-digest", "class 0 (corrections) minimum is steered-digest");
  assert.strictEqual(r.matrix[2], "steered-digest", "class 2 (deadline narrations) minimum is steered-digest");
  assert.ok(r.violations.length >= 2, "an under-floor config is REJECTED loudly, never silently accepted");
  assert.deepStrictEqual(
    raw,
    { 0: "passive-context", 2: "passive-context" },
    "normalizeDeliveryMatrix must be pure — the raw settings object is never mutated",
  );
});

test("classes 3+ may legitimately be dialed passive-context", async () => {
  const mod = await loadArbiter();
  const r = mod.normalizeDeliveryMatrix({ 3: "passive-context", 4: "passive-context" });
  assert.strictEqual(r.matrix[3], "passive-context");
  assert.strictEqual(r.matrix[4], "passive-context");
  assert.deepStrictEqual(r.violations, [], "the dial exists — only the floor is non-negotiable");
});

test("no silent value exists: off/silent/none/false/null/0 can never pass through for ANY class", async () => {
  const mod = await loadArbiter();
  const hostiles: any[] = ["off", "silent", "none", "mute", false, null, 0, "passive"];
  for (const hostile of hostiles) {
    for (const cls of ["0", "2", "5"]) {
      const r = mod.normalizeDeliveryMatrix({ [cls]: hostile });
      assert.ok(
        VALID_MODES.has(r.matrix[cls]),
        `class ${cls} dialed to ${JSON.stringify(hostile)} must normalize to a real mode, got ${JSON.stringify(r.matrix[cls])}`,
      );
      assert.strictEqual(
        r.matrix[cls],
        EXPECTED_DEFAULTS[cls],
        `an INVALID value falls back to the class default (told-more beats silently-missed)`,
      );
      assert.ok(
        r.violations.length > 0,
        `dialing class ${cls} to ${JSON.stringify(hostile)} must be reported as a violation`,
      );
    }
  }
});

test("class 1 has no dial: attempts to configure it are stripped and reported", async () => {
  const mod = await loadArbiter();
  const r = mod.normalizeDeliveryMatrix({ 1: "passive-context" });
  assert.ok(!("1" in snapshot(r.matrix)), "operator-response (class 1) is always immediate — no matrix entry");
  assert.ok(r.violations.length > 0, "the attempt is reported, not silently ignored");
  assert.deepStrictEqual(
    { ...snapshot(r.matrix) },
    EXPECTED_DEFAULTS,
    "the rest of the matrix stays at defaults",
  );
});

test("the matrix drives the drain mode at the core (headline class selects the mode)", async () => {
  const mod = await loadArbiter();
  const drainModeFor = (opts: AnyRec | undefined, item: AnyRec): string => {
    const arb = mod.createTurnArbiter(opts);
    arb.submit(item);
    const d = arb.evaluate({ now: 1_000_000, floorHeld: false, turnClear: true });
    assert.strictEqual(d.action, "drain");
    return d.mode;
  };
  // Defaults: class 2 → forced-turn; class 4 → steered-digest; class 5 → passive-context.
  assert.strictEqual(drainModeFor(undefined, { facts: "last call", cls: 2, coalesceKey: "last-call:m1" }), "forced-turn");
  assert.strictEqual(drainModeFor(undefined, { facts: "ack", cls: 4, paneId: "p1" }), "steered-digest");
  assert.strictEqual(drainModeFor(undefined, { facts: "context", cls: 5, paneId: "p1" }), "passive-context");
  // Dialed: class 3 → forced-turn via a normalized override.
  const { matrix } = mod.normalizeDeliveryMatrix({ 3: "forced-turn" });
  assert.strictEqual(drainModeFor({ matrix }, { facts: "pane 1 finished", cls: 3, paneId: "p1" }), "forced-turn");
});

test("defense in depth: a raw unnormalized matrix fed straight to the core still obeys floor AND fallback", async () => {
  const mod = await loadArbiter();
  // Under-floor VALID value on class 0 → clamped to the steered floor.
  const clamped = mod.createTurnArbiter({ matrix: { 0: "passive-context" } });
  clamped.submit({ facts: "correction: restart failed", cls: 0, coalesceKey: "correction:p9" });
  const d0 = clamped.evaluate({ now: 1_000_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d0.action, "drain");
  assert.strictEqual(d0.mode, "steered-digest", "core clamps under-floor passive to the steered floor");
  // INVALID value on class 2 → falls back to the class DEFAULT (forced-turn), never silence.
  const fellBack = mod.createTurnArbiter({ matrix: { 2: "off" } });
  fellBack.submit({ facts: "last call", cls: 2, coalesceKey: "last-call:m2" });
  const d2 = fellBack.evaluate({ now: 1_000_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d2.action, "drain");
  assert.strictEqual(d2.mode, "forced-turn", "an invalid dial can never mute a deadline narration");
});
