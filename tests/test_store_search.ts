// tests/test_store_search.ts
import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";

test("search returns ranked hits across notes and events; noise excluded", () => {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id:"p1", name:"P1", directory:"", summary:"", key_terms:[], created_at:0, updated_at:0 });
  s.addNote("p1", "decided to use a token-bucket rate limiter", { type:"decision" });
  s.addNote("p1", "lunch order is pizza", {});
  s.appendEvent({ type: "command_outcome" as any, project_id:"p1", summary:"rate limiter tests passed" });

  const hits = s.search("rate limiter");
  const texts = hits.map(h => h.snippet.toLowerCase());
  assert.ok(hits.length >= 2);
  assert.ok(texts.some(t => t.includes("rate")));
  assert.ok(!texts.some(t => t.includes("pizza")));
  s.close();
});
