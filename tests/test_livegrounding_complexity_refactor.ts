// Pins CURRENT behavior of src/liveGrounding.ts (extractGrounding / hasGrounding) before a
// behavior-preserving cyclomatic-complexity refactor (extractGrounding CC 16 -> <=10). Every
// branch and edge of extractGrounding is exercised here so the extraction is provably semantics-
// identical. Pure, never throws (mirrors src/liveTranscripts.ts).
//
// Runner: npx tsx --test --test-force-exit tests/test_livegrounding_complexity_refactor.ts

import { test } from "node:test";
import assert from "node:assert";
import { extractGrounding, hasGrounding } from "../src/liveGrounding";

const msgWith = (groundingMetadata: any) => ({ serverContent: { groundingMetadata } });

// ---- gm absent / falsy branches (gm = message?.serverContent?.groundingMetadata; if (!gm) ...) ----

test("falsy message inputs -> empty result, never throws", () => {
  for (const m of [null, undefined, 0, "", false, NaN]) {
    assert.deepStrictEqual(extractGrounding(m as any), { queries: [], sources: [] });
  }
});

test("missing serverContent / groundingMetadata -> empty result", () => {
  assert.deepStrictEqual(extractGrounding({}), { queries: [], sources: [] });
  assert.deepStrictEqual(extractGrounding({ serverContent: null }), { queries: [], sources: [] });
  assert.deepStrictEqual(extractGrounding({ serverContent: {} }), { queries: [], sources: [] });
  assert.deepStrictEqual(extractGrounding(msgWith(undefined)), { queries: [], sources: [] });
  assert.deepStrictEqual(extractGrounding(msgWith(null)), { queries: [], sources: [] });
  assert.deepStrictEqual(extractGrounding(msgWith(0)), { queries: [], sources: [] });
});

// gm present but empty object: both arrays default to []
test("gm present but no fields -> empty queries + sources", () => {
  assert.deepStrictEqual(extractGrounding(msgWith({})), { queries: [], sources: [] });
});

// ---- webSearchQueries branch ----

test("webSearchQueries: non-array -> []", () => {
  assert.deepStrictEqual(extractGrounding(msgWith({ webSearchQueries: "not an array" })).queries, []);
  assert.deepStrictEqual(extractGrounding(msgWith({ webSearchQueries: null })).queries, []);
  assert.deepStrictEqual(extractGrounding(msgWith({ webSearchQueries: 123 })).queries, []);
});

test("webSearchQueries: filters non-strings and empty strings, preserves order + dupes", () => {
  const out = extractGrounding(
    msgWith({ webSearchQueries: ["a", "", "b", 42, null, undefined, "a", "  "] })
  );
  // empty string dropped; "  " (length>0) kept; duplicate "a" kept (no dedupe on queries)
  assert.deepStrictEqual(out.queries, ["a", "b", "a", "  "]);
});

test("webSearchQueries: all-valid passes through", () => {
  assert.deepStrictEqual(
    extractGrounding(msgWith({ webSearchQueries: ["x", "y", "z"] })).queries,
    ["x", "y", "z"]
  );
});

// ---- groundingChunks branch ----

test("groundingChunks: non-array -> no sources", () => {
  assert.deepStrictEqual(extractGrounding(msgWith({ groundingChunks: "nope" })).sources, []);
  assert.deepStrictEqual(extractGrounding(msgWith({ groundingChunks: null })).sources, []);
  assert.deepStrictEqual(extractGrounding(msgWith({ groundingChunks: {} })).sources, []);
});

test("groundingChunks: malformed entries skipped (null chunk, no web, non-web chunk, no uri)", () => {
  const out = extractGrounding(
    msgWith({
      groundingChunks: [
        null,
        undefined,
        42,
        {},                                  // no web
        { web: null },                       // web falsy
        { web: {} },                         // no uri
        { web: { uri: 123 } },               // uri non-string
        { web: { uri: "" } },                // uri empty
        { retrievedContext: { uri: "ig" } }, // not a web chunk
      ],
    })
  );
  assert.deepStrictEqual(out.sources, []);
});

test("groundingChunks: title falls back title -> domain -> ''", () => {
  const out = extractGrounding(
    msgWith({
      groundingChunks: [
        { web: { uri: "https://a.com", title: "A Title" } },
        { web: { uri: "https://b.com", domain: "b.com" } },          // no title -> domain
        { web: { uri: "https://c.com" } },                            // none -> ""
        { web: { uri: "https://d.com", title: "", domain: "d.com" } },// empty title -> domain
        { web: { uri: "https://e.com", title: 99, domain: "e.com" } },// non-string title -> domain
        { web: { uri: "https://f.com", title: "", domain: "" } },     // both empty -> ""
        { web: { uri: "https://g.com", title: "", domain: 5 } },      // domain non-string -> ""
      ],
    })
  );
  assert.deepStrictEqual(out.sources, [
    { uri: "https://a.com", title: "A Title" },
    { uri: "https://b.com", title: "b.com" },
    { uri: "https://c.com", title: "" },
    { uri: "https://d.com", title: "d.com" },
    { uri: "https://e.com", title: "e.com" },
    { uri: "https://f.com", title: "" },
    { uri: "https://g.com", title: "" },
  ]);
});

test("groundingChunks: dedupe by uri, first occurrence wins", () => {
  const out = extractGrounding(
    msgWith({
      groundingChunks: [
        { web: { uri: "https://dup.com", title: "First" } },
        { web: { uri: "https://dup.com", title: "Second" } },
        { web: { uri: "https://other.com", title: "Other" } },
        { web: { uri: "https://dup.com", title: "Third" } },
      ],
    })
  );
  assert.deepStrictEqual(out.sources, [
    { uri: "https://dup.com", title: "First" },
    { uri: "https://other.com", title: "Other" },
  ]);
});

test("dedupe uses a real Set, so __proto__/constructor uris are treated as data not prototype keys", () => {
  const out = extractGrounding(
    msgWith({
      groundingChunks: [
        { web: { uri: "__proto__", title: "P1" } },
        { web: { uri: "__proto__", title: "P2 dropped" } },
        { web: { uri: "constructor", title: "C1" } },
        { web: { uri: "constructor", title: "C2 dropped" } },
        { web: { uri: "hasOwnProperty", title: "H1" } },
        { web: { uri: "hasOwnProperty", title: "H2 dropped" } },
      ],
    })
  );
  assert.deepStrictEqual(out.sources, [
    { uri: "__proto__", title: "P1" },
    { uri: "constructor", title: "C1" },
    { uri: "hasOwnProperty", title: "H1" },
  ]);
});

test("combined queries + sources extracted together", () => {
  const out = extractGrounding(
    msgWith({
      webSearchQueries: ["q1", "", "q2"],
      groundingChunks: [
        { web: { uri: "https://u1", title: "T1" } },
        { web: { uri: "https://u1", title: "dup" } },
        { web: { uri: "https://u2" } },
      ],
    })
  );
  assert.deepStrictEqual(out, {
    queries: ["q1", "q2"],
    sources: [
      { uri: "https://u1", title: "T1" },
      { uri: "https://u2", title: "" },
    ],
  });
});

// ---- hasGrounding ----

test("hasGrounding: true iff at least one query or source", () => {
  assert.strictEqual(hasGrounding({ queries: [], sources: [] }), false);
  assert.strictEqual(hasGrounding({ queries: ["x"], sources: [] }), true);
  assert.strictEqual(hasGrounding({ queries: [], sources: [{ uri: "u", title: "t" }] }), true);
  assert.strictEqual(hasGrounding({ queries: ["x"], sources: [{ uri: "u", title: "t" }] }), true);
});
