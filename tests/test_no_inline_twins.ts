// tests/test_no_inline_twins.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { INLINE_EXCEPTIONS } from "../src/actions/inlineExceptions";

// Same server.ts-as-text pattern the c55 batch cutover guards use (tests/test_c55_batch_a.ts).
const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

// Match every Express registration with a STRING path literal:
//   app.get('/api/x', …)  app.post("/api/y/:id", …)  app.use('/api', …)  app.get('*', …)
// app.use(express.json()), app.use(fn), app.use(vite.middlewares), app.use(express.static(…)) have NO
// string path → not matched → not required in the catalog (they are not addressable routes).
// NOTE (known limitation, by design): this is a raw-text scan, not a TS parser, so a
// COMMENTED-OUT app.<verb>('<path>') line is also matched. Today the only commented route
// (server.ts ~646, `// app.use("/api", …)`) dedups into the live "use /api" key, so it's a
// no-op. If you comment OUT a live route and this guard flips red ("undeclared"/"stale"),
// that's why — uncomment it, or remove its catalog entry in src/actions/inlineExceptions.ts.
const ROUTE_RE = /\bapp\.(get|post|put|delete|use)\(\s*(['"`])([^'"`]+)\2/g;

function scanInlineRoutes(src: string): Set<string> {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = ROUTE_RE.exec(src)) !== null) found.add(`${m[1]} ${m[3]}`);
  return found;
}

const actual = scanInlineRoutes(serverSrc);
const declared = new Set(INLINE_EXCEPTIONS.map((e) => `${e.method} ${e.path}`));

describe("no-twin guard — server.ts inline routes are fully declared in inlineExceptions", () => {
  it("has NO UNDECLARED inline route (a new route must be a registry def OR a documented exception)", () => {
    const undeclared = [...actual].filter((r) => !declared.has(r)).sort();
    assert.deepStrictEqual(
      undeclared, [],
      `Undeclared inline app.* route(s) in server.ts. Convert to a registry def, or add a documented ` +
      `entry to src/actions/inlineExceptions.ts:\n  ${undeclared.join("\n  ")}`,
    );
  });

  it("has NO STALE catalog entry (every declared exception still exists in server.ts)", () => {
    const stale = [...declared].filter((r) => !actual.has(r)).sort();
    assert.deepStrictEqual(
      stale, [],
      `Stale entry(ies) in src/actions/inlineExceptions.ts (route removed from server.ts — delete them):` +
      `\n  ${stale.join("\n  ")}`,
    );
  });
});
