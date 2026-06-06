// BEAD aqx (build-out): extractGrounding pulls the Google-Search grounding sources + queries off a
// Gemini LiveServerMessage so a grounded answer can SHOW where it came from. Pure, never throws —
// mirrors src/liveTranscripts.ts. The shape under test: serverContent.groundingMetadata with
// webSearchQueries: string[] and groundingChunks[].web.{uri,title} (confirmed @google/genai v2.6.0
// LiveServerContent.groundingMetadata, node.d.ts:7891 / GroundingChunkWeb node.d.ts:6015).
//
// Runner: npx tsx --test --test-force-exit tests/test_grounding.ts

import { test } from "node:test";
import assert from "node:assert";
import { extractGrounding, hasGrounding } from "../src/liveGrounding";

const msgWith = (groundingMetadata: any) => ({ serverContent: { groundingMetadata } });

test("returns empty for null / missing serverContent / missing groundingMetadata (never throws)", () => {
  assert.deepStrictEqual(extractGrounding(null), { queries: [], sources: [] });
  assert.deepStrictEqual(extractGrounding(undefined), { queries: [], sources: [] });
  assert.deepStrictEqual(extractGrounding({}), { queries: [], sources: [] });
  assert.deepStrictEqual(extractGrounding({ serverContent: {} }), { queries: [], sources: [] });
  assert.deepStrictEqual(extractGrounding(msgWith(undefined)), { queries: [], sources: [] });
});

test("extracts web search queries (filtering non-strings / empties)", () => {
  const out = extractGrounding(msgWith({ webSearchQueries: ["node lts version", "", "react 19 release", 42, null] }));
  assert.deepStrictEqual(out.queries, ["node lts version", "react 19 release"]);
});

test("extracts web grounding sources (uri + title) from groundingChunks", () => {
  const out = extractGrounding(msgWith({
    groundingChunks: [
      { web: { uri: "https://nodejs.org/en/about/releases", title: "Node.js Releases" } },
      { web: { uri: "https://react.dev/blog", title: "React Blog" } },
    ],
  }));
  assert.deepStrictEqual(out.sources, [
    { uri: "https://nodejs.org/en/about/releases", title: "Node.js Releases" },
    { uri: "https://react.dev/blog", title: "React Blog" },
  ]);
});

test("skips chunks with no web / no uri; falls back title -> domain -> '' ", () => {
  const out = extractGrounding(msgWith({
    groundingChunks: [
      { web: { uri: "https://a.com/x", title: "A" } },
      { web: { title: "no uri so dropped" } },     // no uri => dropped
      { retrievedContext: { uri: "ignored" } },     // not a web chunk => dropped
      { web: { uri: "https://b.com/y", domain: "b.com" } }, // no title => fall back to domain
      { web: { uri: "https://c.com/z" } },          // no title/domain => ''
      null,                                          // malformed => skipped
    ],
  }));
  assert.deepStrictEqual(out.sources, [
    { uri: "https://a.com/x", title: "A" },
    { uri: "https://b.com/y", title: "b.com" },
    { uri: "https://c.com/z", title: "" },
  ]);
});

test("dedupes sources by uri (first occurrence wins)", () => {
  const out = extractGrounding(msgWith({
    groundingChunks: [
      { web: { uri: "https://dup.com", title: "First" } },
      { web: { uri: "https://dup.com", title: "Second (dropped)" } },
      { web: { uri: "https://other.com", title: "Other" } },
    ],
  }));
  assert.deepStrictEqual(out.sources, [
    { uri: "https://dup.com", title: "First" },
    { uri: "https://other.com", title: "Other" },
  ]);
});

test("hasGrounding helper: true only when there is at least one query or source", () => {
  assert.strictEqual(hasGrounding({ queries: [], sources: [] }), false);
  assert.strictEqual(hasGrounding({ queries: ["x"], sources: [] }), true);
  assert.strictEqual(hasGrounding({ queries: [], sources: [{ uri: "u", title: "t" }] }), true);
});
