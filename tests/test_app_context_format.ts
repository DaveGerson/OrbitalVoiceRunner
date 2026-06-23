// tests/test_app_context_format.ts — CHARACTERIZATION tests for the context-size / token formatters
// extracted out of src/App.tsx (bead dbt4 — App.tsx decomposition, round 2). App.tsx rendered the
// same `n < 1000 ? \`${n} <suffix>\` : \`${(n/1000).toFixed(1)}k <suffix>\`` ternary at SIX sites with
// FOUR distinct suffix spellings (capital "Chars"/"k Chars", capital "Chars"/lowercase "k chars",
// "B"/"k c", and a bare token count), plus the `Math.ceil(n/4)` token estimate at THREE sites. Each
// suffix spelling was relocated VERBATIM into its own pure helper in src/appHelpers.ts so the JSX is
// a single import call and the BYTE-EXACT output is independently testable. App.tsx renders the
// helper's return value unchanged — nothing observable differs.
//
// Runner: npx tsx --test --test-force-exit tests/test_app_context_format.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  formatCharCount,
  formatCharCountLower,
  formatCompactBytes,
  formatTokenCount,
  estimateTokens,
} from "../src/appHelpers";

// ═════════════════════════════════════════════════════════════════════════════
// formatCharCount — capital "Chars" / "k Chars" (detailed card + pane-detail row).
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — formatCharCount (Chars / k Chars)", () => {
  it("< 1000 -> '<n> Chars' (no thousands division)", () => {
    assert.strictEqual(formatCharCount(0), "0 Chars");
    assert.strictEqual(formatCharCount(999), "999 Chars");
  });
  it(">= 1000 -> '<n/1000 to 1dp>k Chars' (boundary at exactly 1000)", () => {
    assert.strictEqual(formatCharCount(1000), "1.0k Chars");
    assert.strictEqual(formatCharCount(1500), "1.5k Chars");
    assert.strictEqual(formatCharCount(20000), "20.0k Chars");
    // toFixed(1) rounds half-to-even-ish per JS spec; pin the observed value.
    assert.strictEqual(formatCharCount(1234), "1.2k Chars");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// formatCharCountLower — capital "Chars" but LOWERCASE "k chars" (header + system bar).
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — formatCharCountLower (Chars / k chars)", () => {
  it("< 1000 -> '<n> Chars' (capital, same as formatCharCount)", () => {
    assert.strictEqual(formatCharCountLower(0), "0 Chars");
    assert.strictEqual(formatCharCountLower(500), "500 Chars");
  });
  it(">= 1000 -> '<n/1000 to 1dp>k chars' (LOWERCASE k chars — differs from formatCharCount)", () => {
    assert.strictEqual(formatCharCountLower(1000), "1.0k chars");
    assert.strictEqual(formatCharCountLower(42000), "42.0k chars");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// formatCompactBytes — "B" / "k c" (compact + videowall card density readout).
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — formatCompactBytes (B / k c)", () => {
  it("< 1000 -> '<n> B'", () => {
    assert.strictEqual(formatCompactBytes(0), "0 B");
    assert.strictEqual(formatCompactBytes(999), "999 B");
  });
  it(">= 1000 -> '<n/1000 to 1dp>k c'", () => {
    assert.strictEqual(formatCompactBytes(1000), "1.0k c");
    assert.strictEqual(formatCompactBytes(8500), "8.5k c");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// formatTokenCount — bare count, no unit suffix on the small arm ("12" / "1.5k").
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — formatTokenCount (bare / k)", () => {
  it("< 1000 -> bare '<n>' (NO unit)", () => {
    assert.strictEqual(formatTokenCount(0), "0");
    assert.strictEqual(formatTokenCount(999), "999");
  });
  it(">= 1000 -> '<n/1000 to 1dp>k' (k suffix, no space)", () => {
    assert.strictEqual(formatTokenCount(1000), "1.0k");
    assert.strictEqual(formatTokenCount(2500), "2.5k");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// estimateTokens — Math.ceil(n / 4), the 4-chars-per-token approximation.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — estimateTokens (ceil(n/4))", () => {
  it("rounds UP to the next whole token", () => {
    assert.strictEqual(estimateTokens(0), 0);
    assert.strictEqual(estimateTokens(1), 1);
    assert.strictEqual(estimateTokens(4), 1);
    assert.strictEqual(estimateTokens(5), 2);
    assert.strictEqual(estimateTokens(20000), 5000);
  });
});
