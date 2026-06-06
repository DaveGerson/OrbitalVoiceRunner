// tests/test_no_inline_twins.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { INLINE_EXCEPTIONS } from "../src/actions/inlineExceptions";
import { REGISTRY } from "../src/actions/registry";

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

// ── shadow detection (c55.16 / Batch H): the production mountRestRoutes call no longer passes an
// `only:` allow-filter, so the registry auto-mounts EVERY rest-surface def. A declared inline
// exception that shares verb+path with a MOUNTED def is a silent double-registration — Express keeps
// the FIRST-registered handler (the inline route registers before mountRestRoutes runs), so the
// registry handler is dead. This guard makes that loud. Param names are normalized (Express treats
// :id and :project_id as the same positional wildcard), so `/api/plans/:id/execute` collides with a
// hypothetical `/api/plans/:plan_id/execute`. The two legacy checks above stay string-exact: they
// compare server.ts text to the catalog, both of which use the SAME literal param names, so
// normalizing there would only LOOSEN them.

/** Collapse every `:param` segment to a single placeholder so param-name skew can't hide a collision. */
function normalizePath(p: string): string {
  return p
    .split("/")
    .map((seg) => (seg.startsWith(":") ? ":*" : seg))
    .join("/");
}

/** verb + normalized-path keys for every def mountRestRoutes WOULD register (surfaces:rest && def.rest). */
const mountedDefKeys = new Set(
  REGISTRY.filter((d) => d.surfaces.has("rest") && !!d.rest).map(
    (d) => `${d.rest!.method} ${normalizePath(d.rest!.path)}`,
  ),
);

describe("no-twin guard — no inline exception SHADOWS a mounted registry def (c55.16)", () => {
  it("has NO inline exception sharing verb+path with a def the registry would mount", () => {
    const shadows = INLINE_EXCEPTIONS
      // infra rows (`use /api`, `get *`) are not addressable action routes and never collide.
      .filter((e) => e.category !== "infra")
      .map((e) => ({ entry: e, key: `${e.method} ${normalizePath(e.path)}` }))
      .filter(({ key }) => mountedDefKeys.has(key))
      .map(({ entry }) => `${entry.method} ${entry.path}  [${entry.category}]`)
      .sort();
    assert.deepStrictEqual(
      shadows, [],
      `Inline exception(s) SHADOW a mounted registry def (Express keeps the inline handler — the ` +
      `registry def is dead). Resolve by CONVERGING the route (delete the inline route + catalog ` +
      `row; the def now serves it) OR by removing the def's rest binding so it does not mount:\n  ` +
      `${shadows.join("\n  ")}`,
    );
  });

  // Required fix #4 (adversarial review): without the `only:` allow-filter, the ONLY thing that keeps
  // collision-freedom is structural path-disjointness across the WHOLE registry. The shadow check
  // above only catches a def colliding with an INLINE route; it does not catch two MOUNTED defs that
  // co-claim a path (e.g. if set_capability_gate's rest binding had not been dropped, it would
  // co-claim the capability-gates path with the new set_pane_gates). Express would keep whichever
  // registered first and silently shadow the other. This makes the design's "collision-freedom PROVEN
  // by the guard" claim actually hold for the registry itself.
  it("has NO two MOUNTED registry defs sharing verb+normalized-path (def-vs-def uniqueness)", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const d of REGISTRY) {
      if (!d.surfaces.has("rest") || !d.rest) continue;
      const key = `${d.rest.method} ${normalizePath(d.rest.path)}`;
      const prior = seen.get(key);
      if (prior) {
        collisions.push(`${key}  <-  ${prior} AND ${d.name}`);
      } else {
        seen.set(key, d.name);
      }
    }
    collisions.sort();
    assert.deepStrictEqual(
      collisions, [],
      `Two rest-mounted defs share verb+normalized-path — Express keeps the first-registered and the ` +
      `other is silently dead. Repoint or drop one def's rest binding:\n  ${collisions.join("\n  ")}`,
    );
  });
});

describe("no-twin guard — no `held` rows remain in the catalog (c55.16 terminal state)", () => {
  // The machine gate for dropping opts.only (design §5.4): the shadow check only catches the THREE
  // path-colliding held rows; this additionally forces the non-colliding dispositions
  // (attention/clear path-alias; execute_plan in the C9-EXCEPTION branch) to be explicitly
  // re-categorized `held`->`exception` rather than left dangling. Together they fully pin the terminal
  // catalog: every surviving inline route is a permanent, deliberate `exception` (or `infra`).
  it("has NO `held` rows left (every held collision converged or downgraded to exception)", () => {
    const held = INLINE_EXCEPTIONS.filter((e) => e.category === "held")
      .map((e) => `${e.method} ${e.path}`)
      .sort();
    assert.deepStrictEqual(
      held, [],
      `Unresolved held row(s) — cannot drop opts.only until each is converged (delete route+row) or ` +
      `downgraded to "exception":\n  ${held.join("\n  ")}`,
    );
  });
});
