// tests/test_approval_golden_parity.ts — the TS half of the dual-language golden-master lock for the
// Python⇄TS seam (plan task 1.7). The golden vectors in tests/fixtures/approval_intent_golden.json
// are generated FROM this parser (scripts/gen-approval-golden.ts). This test re-runs the authoritative
// parser over the frozen transcripts and asserts it STILL reproduces every frozen output.
//
// Why this exists even though the vectors came from this parser: it is the drift TRIPWIRE. If anyone
// changes parseApprovalIntent's behavior, this test goes red FIRST — the signal to (1) regenerate the
// vectors and (2) re-port the Python side (python/synthesizer/approval.py) so both languages stay in
// lockstep. A green here + green python/.../test_approval.py == the seam's parity is intact.
//
// PURE: imports ../src/approvalIntent ONLY. Runner: npx tsx --test --test-force-exit <file>.
import { describe, it } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { parseApprovalIntent } from "../src/approvalIntent";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "approval_intent_golden.json");

interface GoldenVector {
  transcript: string;
  expected: ReturnType<typeof parseApprovalIntent>;
}

function loadVectors(): GoldenVector[] {
  const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf-8"));
  return raw.vectors as GoldenVector[];
}

describe("approval golden-master parity (TS regression lock)", () => {
  const vectors = loadVectors();

  it("the frozen grid is present and dense (boundary-focused, not sampled)", () => {
    assert.ok(vectors.length >= 100, `expected a dense grid, got ${vectors.length} vectors`);
  });

  it("locks at least one BOTH-KEYS targetHint (ordinal AND fragment) — the FLIP-path shape", () => {
    // Adversarial-review coverage gap: the parity grid must freeze the key-set for a hint carrying
    // BOTH an ordinal and a named fragment (e.g. "approve the first npm install"). Without a vector
    // of this shape, a port that emitted only one of the two keys could pass parity undetected.
    const bothKeys = vectors.filter(
      (v) => v.expected?.targetHint?.ordinal !== undefined && !!v.expected?.targetHint?.fragment,
    );
    assert.ok(bothKeys.length >= 1, "no ordinal+fragment vector in the grid — regenerate with one");
  });

  it("parseApprovalIntent reproduces every frozen vector exactly", () => {
    const mismatches: string[] = [];
    for (const v of vectors) {
      const got = parseApprovalIntent(v.transcript);
      if (JSON.stringify(got) !== JSON.stringify(v.expected)) {
        mismatches.push(
          `  ${JSON.stringify(v.transcript)}\n     expected ${JSON.stringify(v.expected)}\n     got      ${JSON.stringify(got)}`,
        );
      }
    }
    assert.equal(
      mismatches.length,
      0,
      `${mismatches.length}/${vectors.length} vectors drifted — regenerate vectors + re-port Python:\n${mismatches.join("\n")}`,
    );
  });
});
