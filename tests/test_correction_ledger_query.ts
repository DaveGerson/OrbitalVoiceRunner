// tests/test_correction_ledger_query.ts — fikj.11 RED: the latestSpokenClaim producer query.
// The ledger stays CLOCK-FREE (no staleness path — co-design §D revision); kind + recency policy
// live at the PRODUCER (src/voice/index.ts completionContradiction, Task 8), which needs this read.
// Runner: npx tsx --test --test-force-exit tests/test_correction_ledger_query.ts
import { test } from "node:test";
import assert from "node:assert";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";

type AnyRec = Record<string, any>;
const T0 = 1_700_000_000_000;

test("latestSpokenClaim resolves the newest SPOKEN claim on a pane ({claimId, kind, assertedAt})", () => {
  const led: AnyRec = createCorrectionLedger({ arbiter: createTurnArbiter() });
  assert.strictEqual(typeof led.latestSpokenClaim, "function",
    "fikj.11 feature absent: correctionLedger.latestSpokenClaim(paneId)");
  assert.strictEqual(led.latestSpokenClaim("p1"), undefined, "no claims -> undefined");
  led.record({ claimId: "c1", paneId: "p1", kind: "dispatch", assertedText: "Dispatching now.", assertedAt: T0, spoken: true });
  led.record({ claimId: "c2", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0 + 500, spoken: true });
  assert.deepStrictEqual(led.latestSpokenClaim("p1"), { claimId: "c2", kind: "completion", assertedAt: T0 + 500 });
});

test("latestSpokenClaim ignores unspoken claims (a suppressed ack is not an operative belief)", () => {
  const led: AnyRec = createCorrectionLedger({ arbiter: createTurnArbiter() });
  led.record({ claimId: "c1", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0, spoken: true });
  led.record({ claimId: "c2", paneId: "p1", kind: "readiness", assertedText: "pane p1 ready", assertedAt: T0 + 100, spoken: false });
  assert.deepStrictEqual(led.latestSpokenClaim("p1"), { claimId: "c1", kind: "completion", assertedAt: T0 });
});

test("latestSpokenClaim is pane-scoped", () => {
  const led: AnyRec = createCorrectionLedger({ arbiter: createTurnArbiter() });
  led.record({ claimId: "c1", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0, spoken: true });
  assert.strictEqual(led.latestSpokenClaim("p2"), undefined);
});
