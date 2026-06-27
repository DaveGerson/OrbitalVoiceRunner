// tests/test_wire_version_parity.ts — the cross-language WIRE_VERSION drift tripwire (seam task 1.4).
// TS and Python each declare their own WIRE_VERSION constant (they cannot literally share one). The
// runtime ping handshake already FAILS CLOSED on a mismatch (daemon treated unavailable -> fallback),
// so drift is never dangerous — but it IS silent. This test makes drift LOUD at build time: it reads
// the authoritative Python constant out of dispatch.py and asserts it equals the TS constant. Bump
// one without the other and this goes red before the daemon ever boots.
import { describe, it } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { WIRE_VERSION } from "../src/memory/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH_PY = path.join(here, "..", "python", "synthesizer", "dispatch.py");

describe("wire-version parity (TS <-> Python)", () => {
  it("python/synthesizer/dispatch.py WIRE_VERSION equals src/memory/types.ts WIRE_VERSION", () => {
    const src = fs.readFileSync(DISPATCH_PY, "utf-8");
    const m = src.match(/^WIRE_VERSION\s*=\s*(\d+)/m);
    assert.ok(m, "could not find `WIRE_VERSION = <n>` in dispatch.py");
    const pyVersion = Number(m![1]);
    assert.equal(
      pyVersion,
      WIRE_VERSION,
      `WIRE_VERSION drift: Python=${pyVersion} TS=${WIRE_VERSION} — bump BOTH sides and re-run the golden sweep`,
    );
  });
});
