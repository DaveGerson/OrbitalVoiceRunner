// tests/test_vcd_journeys.ts — fikj.11: (a) server.ts wiring conformance (the
// test_turn_arbiter_journeys item-3 idiom — the shared instance must reach every producer seam or
// record()/invalidate() silently never fire in production, the exact fikj.11 gap), and (b) the
// cross-producer journey (Task 10): all three producers against ONE real ledger + ONE real
// arbiter, ending in exactly one truthful class-0 retraction.
// Runner: npx tsx --test --test-force-exit tests/test_vcd_journeys.ts
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGating } from "../src/gating";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";
import { respawnPane } from "../src/actions/defs/panes_rest";
import * as voiceIndexModule from "../src/voice/index";

type AnyRec = Record<string, any>;
const voiceIndex = voiceIndexModule as AnyRec;
const T0 = 1_700_000_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

test("server.ts constructs ONE correction ledger on the shared arbiter and threads it into every producer seam", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "server.ts"), "utf-8");
  assert.ok(src.includes("createCorrectionLedger({ arbiter: turnArbiter })"),
    "fikj.11 feature absent: server.ts must construct the ledger on the SHARED arbiter (class-0 submissions only — no new send site)");
  const passthroughs = (src.match(/^\s*correctionLedger,\s*$/gm) ?? []).length;
  assert.ok(passthroughs >= 3,
    `correctionLedger must be threaded into createGating, attachVoiceSession, AND buildRestActionContext (found ${passthroughs} pass-throughs)`);

  // ── SAME-INSTANCE pins (Task 8 review rider): presence alone can't prove the ledger wraps the
  // ONE shared arbiter. If it wrapped a different arbiter, class-0 corrections would submit into a
  // queue no session drains: permanent silence. Pin (1) exactly one arbiter construction, (2)
  // exactly one ledger construction, (3) source order — the ledger line sits AFTER the boot
  // arbiter line, so `turnArbiter` in its deps bag can only bind the shared boot instance.
  const arbiterCalls = (src.match(/createTurnArbiter\(/g) ?? []).length;
  assert.strictEqual(arbiterCalls, 1,
    `server.ts must call createTurnArbiter( EXACTLY once (found ${arbiterCalls}) — a second arbiter would give the ledger a queue no session drains`);
  const ledgerCalls = (src.match(/createCorrectionLedger\(/g) ?? []).length;
  assert.strictEqual(ledgerCalls, 1,
    `server.ts must call createCorrectionLedger( EXACTLY once (found ${ledgerCalls}) — TWO ledgers would split the truth plane (supersession/resolution would miss claims recorded on the other instance)`);
  const arbiterAt = src.indexOf("const turnArbiter = createTurnArbiter(");
  assert.ok(arbiterAt !== -1,
    "boot anchor missing: `const turnArbiter = createTurnArbiter(` — the shared-arbiter construction the ledger must bind to");
  const ledgerAt = src.indexOf("createCorrectionLedger({ arbiter: turnArbiter })");
  assert.ok(ledgerAt > arbiterAt,
    "the ledger construction must appear AFTER the shared boot-arbiter construction in source order — otherwise `turnArbiter` cannot be the drained instance");
});
