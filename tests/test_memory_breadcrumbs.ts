import { test } from "node:test";
import assert from "node:assert/strict";
import { BreadcrumbRing } from "../src/memory/breadcrumbs";

test("recent() returns newest-first, age-filtered, capped", () => {
  const ring = new BreadcrumbRing({ breadcrumbMax: 2, breadcrumbMaxAgeMs: 1000 });
  ring.add({ ts: 100, paneId: "p1", text: "old" });
  ring.add({ ts: 900, paneId: "p1", text: "mid" });
  ring.add({ ts: 1000, paneId: "p2", text: "new" });
  const r = ring.recent(1500); // now=1500 → age cutoff = 500; "old"(age 1400) dropped
  assert.deepEqual(r.map(b => b.text), ["new", "mid"]); // newest-first, capped to 2
});

test("add() hard-caps stored size to avoid unbounded growth", () => {
  const ring = new BreadcrumbRing({ breadcrumbMax: 3, breadcrumbMaxAgeMs: 1e9 });
  for (let i = 0; i < 100; i++) ring.add({ ts: i, paneId: null, text: `b${i}` });
  // recent() still returns at most breadcrumbMax, newest-first
  const r = ring.recent(1000);
  assert.equal(r.length, 3);
  assert.equal(r[0].text, "b99");
});

test("per-pane fairness: a noisy pane cannot evict quiet panes' latest breadcrumbs", () => {
  // breadcrumbMax=4, but the noisy pane alone produces >4 in-window breadcrumbs.
  // Under the OLD global-recency cut, the two quiet panes' single events (which are
  // OLDER than the noisy pane's newest 4) would be sliced out entirely. The new
  // fairness rule must guarantee each quiet pane keeps its single most-recent crumb.
  const ring = new BreadcrumbRing({ breadcrumbMax: 4, breadcrumbMaxAgeMs: 10_000 });
  // Quiet panes fire early (smaller ts) so they lose a pure recency race.
  ring.add({ ts: 100, paneId: "quietA", text: "quietA-latest" });
  ring.add({ ts: 200, paneId: "quietB", text: "quietB-latest" });
  // Noisy pane floods with the newest events.
  ring.add({ ts: 1000, paneId: "noisy", text: "noisy1" });
  ring.add({ ts: 1001, paneId: "noisy", text: "noisy2" });
  ring.add({ ts: 1002, paneId: "noisy", text: "noisy3" });
  ring.add({ ts: 1003, paneId: "noisy", text: "noisy4" });
  ring.add({ ts: 1004, paneId: "noisy", text: "noisy5" });

  const r = ring.recent(2000);
  const texts = r.map(b => b.text);

  // Still capped at breadcrumbMax and newest-first.
  assert.equal(r.length, 4);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].ts >= r[i].ts, "newest-first preserved");

  // BOTH quiet panes keep their single most-recent breadcrumb despite the flood.
  assert.ok(texts.includes("quietA-latest"), "quietA's latest survives the noisy flood");
  assert.ok(texts.includes("quietB-latest"), "quietB's latest survives the noisy flood");
  // The noisy pane still appears, filling the remaining capacity by recency.
  assert.ok(texts.some(t => t.startsWith("noisy")), "noisy pane still represented");
});

test("per-pane fairness: null paneId (system) is its own bucket", () => {
  const ring = new BreadcrumbRing({ breadcrumbMax: 3, breadcrumbMaxAgeMs: 10_000 });
  ring.add({ ts: 100, paneId: null, text: "system-latest" });
  ring.add({ ts: 1000, paneId: "noisy", text: "n1" });
  ring.add({ ts: 1001, paneId: "noisy", text: "n2" });
  ring.add({ ts: 1002, paneId: "noisy", text: "n3" });
  const r = ring.recent(2000);
  const texts = r.map(b => b.text);
  assert.equal(r.length, 3);
  assert.ok(texts.includes("system-latest"), "null-pane (system) breadcrumb gets its guaranteed slot");
});

// ── Phase 2 Step 2.5 (fix of the Step 2.4 pinned cross-project leak): project scoping ──────────
test("recent(now, projectId) scopes crumbs to the brief's project; unstamped crumbs always pass", () => {
  const ring = new BreadcrumbRing({ breadcrumbMax: 12, breadcrumbMaxAgeMs: 10_000 });
  ring.add({ ts: 100, paneId: "a1", projectId: "projA", text: "a-crumb" });
  ring.add({ ts: 200, paneId: "b1", projectId: "projB", text: "b-crumb" });
  ring.add({ ts: 300, paneId: null, text: "system-crumb" }); // no stamp — global
  ring.add({ ts: 400, paneId: "x1", projectId: null, text: "unresolved-crumb" }); // explicit null — global

  const forB = ring.recent(2000, "projB").map(b => b.text);
  assert.ok(forB.includes("b-crumb"), "the project's own crumb renders");
  assert.ok(!forB.includes("a-crumb"), "another project's crumb NEVER leaks into this project's view");
  assert.ok(forB.includes("system-crumb") && forB.includes("unresolved-crumb"), "unstamped/null-stamped crumbs stay globally visible (pre-scoping floor)");

  // Omitting projectId (every pre-existing call site) keeps the original unscoped behavior.
  const unscoped = ring.recent(2000).map(b => b.text);
  assert.deepEqual(unscoped, ["unresolved-crumb", "system-crumb", "b-crumb", "a-crumb"]);
  // Passing null is the explicit "no active project" floor — also unscoped.
  assert.deepEqual(ring.recent(2000, null).map(b => b.text), unscoped);
});

test("project scoping composes with the age window and per-pane fairness", () => {
  const ring = new BreadcrumbRing({ breadcrumbMax: 2, breadcrumbMaxAgeMs: 1000 });
  ring.add({ ts: 100, paneId: "b1", projectId: "projB", text: "b-too-old" });
  ring.add({ ts: 1600, paneId: "a1", projectId: "projA", text: "a-new" });
  ring.add({ ts: 1700, paneId: "b1", projectId: "projB", text: "b-new1" });
  ring.add({ ts: 1800, paneId: "b2", projectId: "projB", text: "b-new2" });
  ring.add({ ts: 1900, paneId: "b2", projectId: "projB", text: "b-new3" });
  const r = ring.recent(2000, "projB").map(b => b.text);
  // Filtered to projB, aged, then fairness/cap applied over the SURVIVORS only:
  // b1 keeps its newest (b-new1) despite b2's flood; a-new never competes for a slot.
  assert.deepEqual(r, ["b-new3", "b-new1"]);
});

test("per-pane fairness fallback: more distinct in-window panes than breadcrumbMax", () => {
  // 5 distinct panes, each ONE crumb, but breadcrumbMax=3 — we cannot give every pane a slot.
  // Fallback: keep the most-recent crumb of the breadcrumbMax MOST-RECENTLY-ACTIVE panes.
  const ring = new BreadcrumbRing({ breadcrumbMax: 3, breadcrumbMaxAgeMs: 10_000 });
  ring.add({ ts: 100, paneId: "p1", text: "p1" });
  ring.add({ ts: 200, paneId: "p2", text: "p2" });
  ring.add({ ts: 300, paneId: "p3", text: "p3" });
  ring.add({ ts: 400, paneId: "p4", text: "p4" });
  ring.add({ ts: 500, paneId: "p5", text: "p5" });
  const r = ring.recent(2000);
  const texts = r.map(b => b.text);
  assert.equal(r.length, 3);
  // The 3 most-recently-active panes (by newest ts) are p5, p4, p3.
  assert.deepEqual(texts, ["p5", "p4", "p3"], "keep the breadcrumbMax most-recently-active panes");
});
