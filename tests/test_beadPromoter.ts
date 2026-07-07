/**
 * tests/test_beadPromoter.ts — the constrained note→bead promoter (hwu.4). Pins the PURE deterministic
 * composer, the injectable exec seam (applyApprovedBead runs the seam exactly once), the default-seam
 * override plumbing, and the deny/marker helpers. No real `bd`, no child process.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert";

import {
  composeBead, applyApprovedBead, setBeadExec, resolveBeadExec, defaultBeadExec,
  markNoteStatus, denyBeadProposal, type ComposedBead, type BeadExec,
} from "../src/beadPromoter";
import type { NoteType } from "../src/store/types";

afterEach(() => setBeadExec(null)); // always restore the production default

test("composeBead is deterministic: same note → identical composed bead", () => {
  const note = { text: "TODO cap the retry backoff", type: "todo" as NoteType };
  assert.deepStrictEqual(composeBead(note), composeBead(note));
});

test("composeBead keeps the FULL note text in the description (untruncated) and a one-line title", () => {
  const long = "First line is the gist.\n" + "x".repeat(500);
  const c = composeBead({ text: long, type: "note" });
  assert.ok(c.description.includes("x".repeat(500)), "description must carry the full untruncated body");
  assert.ok(c.title.length <= 72, "title is a capped one-liner");
  assert.equal(c.title, "First line is the gist.", "title is the first non-empty line");
  assert.ok(!c.title.includes("\n"), "title never contains a newline");
});

test("composeBead maps note type → bead issue type + priority deterministically", () => {
  const cases: Array<[NoteType, string, number]> = [
    ["warning", "bug", 1],
    ["todo", "task", 2],
    ["decision", "chore", 2],
    ["handoff", "task", 2],
    ["note", "task", 3],
  ];
  for (const [type, issueType, priority] of cases) {
    const c = composeBead({ text: "body", type });
    assert.equal(c.issueType, issueType, `type=${type} → issueType`);
    assert.equal(c.priority, priority, `type=${type} → priority`);
  }
});

test("applyApprovedBead runs the exec seam EXACTLY ONCE and returns its result", () => {
  const calls: ComposedBead[] = [];
  const mock: BeadExec = (c) => { calls.push(c); return { ok: true, id: "bd-99" }; };
  const composed = composeBead({ text: "do the thing", type: "todo" });
  const res = applyApprovedBead(composed, mock);
  assert.equal(calls.length, 1, "exec called exactly once");
  assert.deepStrictEqual(calls[0], composed, "exec receives the composed bead verbatim");
  assert.deepStrictEqual(res, { ok: true, id: "bd-99" });
});

test("setBeadExec overrides resolveBeadExec; passing null restores defaultBeadExec", () => {
  const mock: BeadExec = () => ({ ok: true, id: "x" });
  setBeadExec(mock);
  assert.strictEqual(resolveBeadExec(), mock);
  setBeadExec(null);
  assert.strictEqual(resolveBeadExec(), defaultBeadExec, "null restores the production default");
});

test("applyApprovedBead surfaces an exec failure as { ok:false, error } — never throws", () => {
  const res = applyApprovedBead(composeBead({ text: "x", type: "note" }), () => ({ ok: false, error: "boom" }));
  assert.equal(res.ok, false);
  assert.equal(res.error, "boom");
});

test("markNoteStatus / denyBeadProposal write through a store with setNoteBeadStatus and no-op otherwise", () => {
  const calls: Array<{ id: string; status: string | null }> = [];
  const store = { setNoteBeadStatus: (id: string, status: string | null) => calls.push({ id, status }) };
  markNoteStatus(store, "n1", "created");
  denyBeadProposal(store, "n1");
  assert.deepStrictEqual(calls, [{ id: "n1", status: "created" }, { id: "n1", status: "denied" }]);
  // A store/double lacking the method must not throw.
  assert.doesNotThrow(() => markNoteStatus({}, "n1", "proposed"));
  assert.doesNotThrow(() => denyBeadProposal(null, "n1"));
});
