import { describe, it } from "node:test";
import assert from "node:assert";

import {
  POSTURE_STYLE,
  GATE_STYLE,
  deriveActionDivergence,
  type PostureWord,
} from "../src/gateSurface";
import type { GateValue } from "../src/types";

/**
 * rbh (wsm-e2e-pinned-rbh) — the confirmation dialogs render the EFFECTIVE posture using the SAME
 * palette the chip uses. To guarantee dialog == chip == engine (D4, single palette source), the
 * posture/gate swatch maps must live in gateSurface (frontend-safe) so BOTH the chip and the two
 * dialogs import ONE copy. This suite pins:
 *   1. POSTURE_STYLE / GATE_STYLE are exported FROM gateSurface (the move actually happened).
 *   2. Each map is TOTAL over its closed union (every posture word / gate value present).
 *   3. The canonical plain-word map is preserved (Allowed | Asks first | Blocked).
 *
 * Why it fails first: before the move these symbols live ONLY in GateChip.tsx, so the import throws
 * / tsc is red. A test that passed before the move would be worthless.
 */

const ALL_POSTURES: PostureWord[] = ["OPEN", "GUARDED", "LOCKED"];
const ALL_GATES: GateValue[] = ["Auto", "Ask", "Off"];

describe("gateSurface — shared dialog/chip posture palette (rbh)", () => {
  it("POSTURE_STYLE is TOTAL over the PostureWord union", () => {
    for (const p of ALL_POSTURES) {
      const s = POSTURE_STYLE[p];
      assert.ok(s, `POSTURE_STYLE missing entry for ${p}`);
      // l1c: assert the class strings are the RIGHT KIND of Tailwind token (dot = a bg- color, text =
      // a text- color), and the label reads like plain language (a multi-word sentence) — content
      // checks that catch a wrong/blank class, not just non-emptiness.
      assert.match(s.dot, /\bbg-/, `${p}.dot must be a bg- color class`);
      assert.match(s.text, /\btext-/, `${p}.text must be a text- color class`);
      assert.match(s.label, /\w+\s+\w+/, `${p}.label must be plain-language prose`);
    }
    // No keys outside the union (map is exactly the union).
    assert.deepStrictEqual(Object.keys(POSTURE_STYLE).sort(), [...ALL_POSTURES].sort());
  });

  it("GATE_STYLE is TOTAL over the GateValue union with the canonical plain words", () => {
    for (const g of ALL_GATES) {
      const s = GATE_STYLE[g];
      assert.ok(s, `GATE_STYLE missing entry for ${g}`);
      // l1c: dot is a bg- color class; word is a single plain-language word (letters only).
      assert.match(s.dot, /\bbg-/, `${g}.dot must be a bg- color class`);
      assert.match(s.word, /^[A-Za-z ]+$/, `${g}.word must be a plain word, got ${JSON.stringify(s.word)}`);
    }
    assert.deepStrictEqual(Object.keys(GATE_STYLE).sort(), [...ALL_GATES].sort());
    // The plain gate-language words the operator reads (no raw Auto/Ask/Off jargon in the dialog rider).
    assert.strictEqual(GATE_STYLE.Auto.word, "Allowed");
    assert.strictEqual(GATE_STYLE.Ask.word, "Asks first");
    assert.strictEqual(GATE_STYLE.Off.word, "Blocked");
  });
});

describe("gateSurface — deriveActionDivergence (rbh confirm-dialog truth)", () => {
  it("clean: requested mode matches effective mode, gate not Off => none", () => {
    assert.strictEqual(deriveActionDivergence("Full Auto", "Full Auto", "Auto"), "none");
  });

  it("global override: requested Full Auto but global mode resolves Read-Only => global (root cause)", () => {
    // The BUG-003 case: operator asks Full Auto while global is Read-Only. The write gate is ALSO Off
    // downstream, but the mode is the root cause, so we surface "global" not "gate".
    assert.strictEqual(deriveActionDivergence("Full Auto", "Read-Only", "Off"), "global");
  });

  it("global override wins even if the gate is also Off (mode is the root cause)", () => {
    assert.strictEqual(deriveActionDivergence("Human-in-the-Loop", "Read-Only", "Off"), "global");
  });

  it("bare gate veto: mode matches the request but the capability gate is Off => gate", () => {
    assert.strictEqual(deriveActionDivergence("Full Auto", "Full Auto", "Off"), "gate");
  });

  it("no requested mode (e.g. create_pane) => never a mode rider", () => {
    assert.strictEqual(deriveActionDivergence(undefined, "Read-Only", "Off"), "none");
  });

  it("requested mode present, no effective mode supplied, gate Auto => none (degrade-safe)", () => {
    assert.strictEqual(deriveActionDivergence("Full Auto", undefined, "Auto"), "none");
  });

  // ── concern-3 precision: the explicit globalOverrides signal disambiguates a real global override
  // from a staged-but-not-yet-applied mode change under Inherit ──────────────────────────────────
  it("PRECISION: mode mismatch but globalOverrides=false (global Inherit) => NOT global; gate Auto => none", () => {
    // The operator staged Full Auto on a pane that is CURRENTLY Human-in-the-Loop; global is Inherit,
    // so the requested change WILL take effect on confirm. This is staging, NOT a global override.
    assert.strictEqual(deriveActionDivergence("Full Auto", "Human-in-the-Loop", "Auto", false), "none");
  });

  it("PRECISION: mode mismatch + globalOverrides=false but gate Off => falls through to gate (not global)", () => {
    assert.strictEqual(deriveActionDivergence("Full Auto", "Human-in-the-Loop", "Off", false), "gate");
  });

  it("PRECISION: globalOverrides=true with a real mismatch => global (the genuine override case)", () => {
    assert.strictEqual(deriveActionDivergence("Full Auto", "Read-Only", "Off", true), "global");
  });

  it("PRECISION: globalOverrides=true but NO mode mismatch => not global (signal alone never invents one)", () => {
    // Defensive: even if the caller passes globalOverrides=true, with no actual mode mismatch we must
    // not fabricate a "global" rider; fall through to gate/none.
    assert.strictEqual(deriveActionDivergence("Full Auto", "Full Auto", "Off", true), "gate");
    assert.strictEqual(deriveActionDivergence("Full Auto", "Full Auto", "Auto", true), "none");
  });

  it("BACK-COMPAT: omitting globalOverrides falls back to the raw mode mismatch (legacy 3-arg callers)", () => {
    assert.strictEqual(deriveActionDivergence("Full Auto", "Read-Only", "Off"), "global");
    assert.strictEqual(deriveActionDivergence("Full Auto", "Full Auto", "Auto"), "none");
  });
});
