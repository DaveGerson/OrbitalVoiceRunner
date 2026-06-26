// tests/test_approval_flip.ts — Inc 2 task 2.1: THE FLIP. parseApprovalIntent goes Python-PRIMARY with
// the TS twin as the fail-closed floor, behind setApprovalPythonPrimary (default OFF = shadow). These
// are the load-bearing locks the flip-PR merge gate signs off on:
//   • SHADOW (default): resolveApprovalIntent is byte-identical to the authoritative TS parse.
//   • FLIP: Python's result is PRIMARY (returned, not TS).
//   • FAIL-CLOSED: on Python null / timeout / error / no-recorder / recorder-throw, the conservative TS
//     twin is returned — NEVER a stale Python answer, NEVER "fail open" to a more permissive intent.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createApprovalShadowRecorder,
  installApprovalShadow,
  setApprovalPythonPrimary,
  isApprovalPythonPrimary,
  resolveApprovalIntent,
  type ApprovalShadowRecorder,
} from "../src/approvalShadow";
import { parseApprovalIntent } from "../src/approvalIntent";
import type { WireParsedApproval } from "../src/memory/types";

const tick = () => new Promise((r) => setImmediate(r));

// Reset the process-wide module state after every test so flag/recorder never bleed across cases.
afterEach(() => { installApprovalShadow(null); setApprovalPythonPrimary(false); });

/** Install a real recorder whose Python `parse` is the supplied fn (resolve/null/throw/hang as needed). */
function installPython(parse: (t: string) => Promise<WireParsedApproval | null>): ApprovalShadowRecorder {
  const rec = createApprovalShadowRecorder({ parse });
  installApprovalShadow(rec);
  return rec;
}

test("SHADOW (default): returns the TS twin even when Python would disagree", async () => {
  installPython(async () => ({ intent: "reject" })); // Python says reject…
  const got = await resolveApprovalIntent("approve"); // …TS says approve, and TS is authoritative
  assert.deepEqual(got, parseApprovalIntent("approve"));
  assert.equal(got.intent, "approve");
});

test("FLIP: Python is PRIMARY — its result is returned, not the TS twin's", async () => {
  const rec = installPython(async () => ({ intent: "reject" }));
  setApprovalPythonPrimary(true);
  const got = await resolveApprovalIntent("approve"); // TS=approve, Python=reject
  assert.equal(got.intent, "reject", "Python primary must win when it answers");
  assert.equal(rec.stats().compared, 1); // and the diff was still counted
});

test("FLIP fail-closed: Python returns null ⇒ the TS twin (floor)", async () => {
  installPython(async () => null);
  setApprovalPythonPrimary(true);
  const got = await resolveApprovalIntent("approve");
  assert.deepEqual(got, parseApprovalIntent("approve"));
});

test("FLIP fail-closed: Python times out ⇒ floor within the budget (no hang)", async () => {
  installPython(() => new Promise(() => { /* never resolves */ }));
  setApprovalPythonPrimary(true, 30); // 30ms budget
  const t0 = Date.now();
  const got = await resolveApprovalIntent("reject the deploy");
  const dt = Date.now() - t0;
  assert.deepEqual(got, parseApprovalIntent("reject the deploy"));
  // Sharp enough to catch a regression that waited the full transport expiry (~2000ms) instead of the
  // 30ms flip budget, with comfortable margin for a loaded CI box.
  assert.ok(dt < 500, `must fall to the floor near the 30ms budget, not hang (took ${dt}ms)`);
});

test("FLIP fail-closed: Python throws ⇒ floor", async () => {
  installPython(async () => { throw new Error("daemon exploded"); });
  setApprovalPythonPrimary(true);
  const got = await resolveApprovalIntent("approve");
  assert.deepEqual(got, parseApprovalIntent("approve"));
});

test("FLIP fail-closed: no recorder installed ⇒ TS twin", async () => {
  installApprovalShadow(null);
  setApprovalPythonPrimary(true);
  const got = await resolveApprovalIntent("approve");
  assert.deepEqual(got, parseApprovalIntent("approve"));
});

test("FLIP fail-closed: a recorder whose resolve() throws ⇒ TS twin (belt-and-suspenders)", async () => {
  installApprovalShadow({
    record: () => { /* noop */ },
    resolve: async () => { throw new Error("resolve bug"); },
    stats: () => ({ compared: 0, match: 0, mismatch: 0, missing: 0 }),
  });
  setApprovalPythonPrimary(true);
  const got = await resolveApprovalIntent("approve");
  assert.deepEqual(got, parseApprovalIntent("approve"));
});

test("FLIP NEVER fails open: ambiguous utterance + Python down ⇒ TS's conservative clarify, not approve", async () => {
  // The security-critical lock: a Python outage must degrade to the conservative TS twin, which
  // returns `clarify` on a collision — it must NEVER silently resolve to approve/reject.
  installPython(async () => null);
  setApprovalPythonPrimary(true);
  const got = await resolveApprovalIntent("approve but reject");
  assert.equal(got.intent, "clarify");
  assert.deepEqual(got, parseApprovalIntent("approve but reject"));
});

test("FLIP: a LATE Python answer (past the budget) is counted but never used (no stale)", async () => {
  let release!: (v: WireParsedApproval | null) => void;
  const rec = installPython(() => new Promise<WireParsedApproval | null>((r) => { release = r; }));
  setApprovalPythonPrimary(true, 20);
  const got = await resolveApprovalIntent("approve"); // times out at 20ms → floor (approve)
  assert.equal(got.intent, "approve");
  release({ intent: "reject" }); // Python answers LATE with a different intent
  await tick(); await tick();
  const s = rec.stats();
  assert.equal(s.compared, 1, "the late answer is still counted");
  assert.equal(s.mismatch, 1, "…as a mismatch (reject != approve) — but it was never returned");
});

test("isApprovalPythonPrimary reflects the flag (and resetting works)", () => {
  setApprovalPythonPrimary(true);
  assert.equal(isApprovalPythonPrimary(), true);
  setApprovalPythonPrimary(false);
  assert.equal(isApprovalPythonPrimary(), false);
});
