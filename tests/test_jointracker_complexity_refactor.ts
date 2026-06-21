/**
 * tests/test_jointracker_complexity_refactor.ts — BEHAVIOR-PIN for the CC<=10 extraction of
 * DispatchJoinTracker.noteTransition (and its collaborators). These tests exercise every branch
 * and edge of the settle/complete logic so a verbatim helper extraction stays provably identical.
 *
 * Runner: npx tsx --test --test-force-exit tests/test_jointracker_complexity_refactor.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { DispatchJoinTracker } from "../src/dispatch/joinTracker";

describe("noteTransition — settle/complete branch pinning", () => {
  it("prompt edge returns [] and mutates NOTHING (early-return branch)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"], 1000);
    t.noteRunning("p1");
    const out = t.noteTransition("p1", "prompt", 2000);
    assert.deepStrictEqual(out, []);
    assert.strictEqual(g.members[0].status, "running");
    assert.strictEqual(g.completed, false);
    assert.strictEqual(g.completedAt, undefined);
  });

  it("idle settles running->done WITHOUT a detail; stamps completedAt with `now`", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"], 1000);
    t.noteRunning("p1");
    const out = t.noteTransition("p1", "idle", 7777);
    assert.deepStrictEqual(out.map((x) => x.id), [g.id]);
    assert.strictEqual(g.members[0].status, "done");
    assert.strictEqual(g.members[0].detail, undefined, "the done branch must NOT write a detail");
    assert.strictEqual(g.completed, true);
    assert.strictEqual(g.completedAt, 7777);
  });

  for (const edge of ["error", "build-failed", "exited"] as const) {
    it(`${edge} settles running->error WITH detail "pane ${edge}"`, () => {
      const t = new DispatchJoinTracker();
      const g = t.create("brief", "x", ["p1"], 1000);
      t.noteRunning("p1");
      const out = t.noteTransition("p1", edge, 3030);
      assert.strictEqual(g.members[0].status, "error");
      assert.strictEqual(g.members[0].detail, `pane ${edge}`);
      assert.deepStrictEqual(out.map((x) => x.id), [g.id]);
      assert.strictEqual(g.completedAt, 3030);
    });
  }

  it("skips already-completed groups (the `g.completed` continue)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1"], 1000);
    t.noteRunning("p1");
    t.noteTransition("p1", "idle", 1100);
    const before = { ...g.members[0] };
    const out = t.noteTransition("p1", "error", 1200);
    assert.deepStrictEqual(out, [], "a settled group is never re-reported");
    assert.deepStrictEqual({ ...g.members[0] }, before, "a completed group's members are frozen");
    assert.strictEqual(g.completedAt, 1100, "completedAt is not overwritten");
  });

  it("only RUNNING members on the matching pane settle (staged + wrong-pane untouched)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1", "p2", "p3"], 1000);
    t.noteRunning("p2"); // p2 running; p1 + p3 still staged
    const out = t.noteTransition("p1", "idle", 1500); // p1 is staged -> no settle, group not touched
    assert.deepStrictEqual(out, [], "an idle on a STAGED member settles nothing");
    assert.strictEqual(g.members[0].status, "staged");
    assert.strictEqual(g.members[1].status, "running", "the wrong-pane running member is untouched");
    assert.strictEqual(g.members[2].status, "staged");
    assert.strictEqual(g.completed, false);
  });

  it("a group completes only when NO member is staged/running (partial -> full)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1", "p2"], 1000);
    t.noteRunning("p1");
    t.noteRunning("p2");
    const first = t.noteTransition("p1", "idle", 2000);
    assert.deepStrictEqual(first, [], "one member still running -> not complete, not returned");
    assert.strictEqual(g.completed, false);
    const second = t.noteTransition("p2", "idle", 2100);
    assert.deepStrictEqual(second.map((x) => x.id), [g.id], "the LAST settle completes + returns the group");
    assert.strictEqual(g.completedAt, 2100);
  });

  it("a member that touched but a STAGED sibling remains does NOT complete", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1", "p2"], 1000);
    t.noteRunning("p1"); // p2 stays staged
    const out = t.noteTransition("p1", "idle", 2000);
    assert.deepStrictEqual(out, [], "touched=true but a staged member blocks completion");
    assert.strictEqual(g.members[0].status, "done");
    assert.strictEqual(g.members[1].status, "staged");
    assert.strictEqual(g.completed, false);
  });

  it("one edge can complete MULTIPLE groups sharing the pane (each returned once)", () => {
    const t = new DispatchJoinTracker();
    const g1 = t.create("a", "x", ["p1"], 1000);
    const g2 = t.create("b", "x", ["p1"], 1001);
    t.noteRunning("p1");
    const out = t.noteTransition("p1", "idle", 3000);
    assert.deepStrictEqual(
      out.map((x) => x.id).sort(),
      [g1.id, g2.id].sort(),
      "both groups with a running member on p1 complete on the shared edge"
    );
    assert.ok(g1.completed && g2.completed);
  });

  it("a settled member is NOT re-settled by a later edge (idempotent per member)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["p1", "p2"], 1000);
    t.noteRunning("p1");
    t.noteRunning("p2");
    t.noteTransition("p1", "idle", 2000); // p1 -> done
    const out = t.noteTransition("p1", "error", 2050); // p1 already done; nothing running on p1
    assert.deepStrictEqual(out, [], "no running member on p1 -> nothing happens");
    assert.strictEqual(g.members[0].status, "done", "done is not flipped to error by a later edge");
    assert.strictEqual(g.completed, false, "p2 still running keeps the group open");
  });

  it("prototype-pollution-safe paneId keys settle normally (no Map/object-key guard regression)", () => {
    const t = new DispatchJoinTracker();
    const g = t.create("brief", "x", ["__proto__", "constructor"], 1000);
    t.noteRunning("__proto__");
    t.noteRunning("constructor");
    const out1 = t.noteTransition("__proto__", "idle", 2000);
    assert.deepStrictEqual(out1, [], "first of two still has a running sibling");
    const out2 = t.noteTransition("constructor", "error", 2100);
    assert.deepStrictEqual(out2.map((x) => x.id), [g.id]);
    assert.strictEqual(g.members[0].status, "done");
    assert.strictEqual(g.members[1].status, "error");
    assert.strictEqual(g.members[1].detail, "pane error");
  });
});
