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
