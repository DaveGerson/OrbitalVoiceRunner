/**
 * src/actions/rest.ts — the REST surface, DERIVED from the registry (§5.1 / §9).
 *
 * mountRestRoutes(app, registry, ctxFactory) registers one Express route per rest-surface action
 * (using its explicit `def.rest` binding), validates the body against the SAME zod schema the voice
 * path uses, builds a per-request ActionContext (session:null), runs the SAME runAction choke-point,
 * and maps the ActionResult to HTTP via applyResultToHttp. So a REST button and a voice command
 * execute the identical handler, gate, and redaction (G3 — "one path").
 *
 * This file is Phase-A scaffolding: it wires the seam. server.ts is NOT modified in this phase
 * (that is REG1 Phase C); the existing hand-written routes still serve traffic until the cutover.
 *
 * The `rest.toHttp` primitive (c55 Batch E)
 * ----------------------------------------
 * ~99% of routes ride the default `{output:string}` body (200) via `resultToHttp`. A handful of
 * page-load READS return a structured fact-sheet (a rich array/object) the flat string cannot carry,
 * and they fire BEFORE any WebSocket frame exists to lean on. For those only, a def may declare an
 * OPTIONAL, declarative response translator on its REST binding:
 *
 *     rest: { method, path, toHttp?: (result, args) => { status, body } }
 *
 * `mountRestRoutes` dispatches every response through `applyResultToHttp(def, result, args, res)`:
 * if `def.rest.toHttp` is present it re-projects the typed `result.output` into the exact bespoke
 * body and wins; otherwise the unchanged default `resultToHttp` map applies (no regression). The
 * hook is REST-only — the voice path (resultToToolResponse) never consults it, so a `toHttp` def
 * whose output shape is pure-UI must be `surfaces: new Set(['rest'])`. Status-via-kinds (a handler
 * returning `kind:'blocked'`/`kind:'pending'`) is preferred over `toHttp` wherever possible.
 */

import type { ActionContext, ActionDef, ActionResult } from "./types";
import { runAction } from "./gemini";

/** The minimal Express surface mountRestRoutes needs (structural — avoids over-coupling the scaffold). */
export interface RestApp {
  get(path: string, handler: RestHandler): unknown;
  post(path: string, handler: RestHandler): unknown;
  put(path: string, handler: RestHandler): unknown;
  delete(path: string, handler: RestHandler): unknown;
}

export interface RestRequest {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
}

export interface RestResponse {
  status(code: number): RestResponse;
  json(payload: unknown): unknown;
}

export type RestHandler = (req: RestRequest, res: RestResponse) => void | Promise<void>;

/**
 * Builds the per-request ActionContext. session is null on REST (the result maps to HTTP, not a
 * sendToolResponse). The factory closes over the heavy server state (manager, the real gateOrDefer
 * closure, broadcast, redactSecrets) — injected, never imported.
 */
export type RestContextFactory = (req: RestRequest) => ActionContext;

/** Collapse every `:param` segment to a single placeholder so param-name skew (`:id` vs `:pane_id`)
 * can't hide a collision — mirrors tests/test_no_inline_twins.ts's normalizePath. Exported so any
 * caller building a `knownInlinePaths` set (e.g. server.ts, from src/actions/inlineExceptions.ts)
 * normalizes with the SAME rule findKnownRouteCollisions applies to def paths. */
export function normalizeRestPath(p: string): string {
  return p
    .split("/")
    .map((seg) => (seg.startsWith(":") ? ":*" : seg))
    .join("/");
}

/**
 * findKnownRouteCollisions — pure collision check: which of the defs mountRestRoutes is ABOUT TO
 * MOUNT (post `only` filter) share verb+normalized-path with a caller-supplied "known hand-written
 * route" key (`"<method> <normalized-path>"`, e.g. from src/actions/inlineExceptions.ts)?
 *
 * This is a RUNTIME safety net, not the authority — tests/test_no_inline_twins.ts is the actual gate
 * (it fails the suite on any collision). This function exists so mountRestRoutes can also warn loudly
 * at actual boot time, in case the registry/allowlist drifts in a way the test snapshot doesn't catch
 * (e.g. a future non-test caller). Returns the colliding `"<method> <path>  [def=<name>]"` strings.
 */
export function findKnownRouteCollisions(
  registry: readonly ActionDef[],
  knownPaths: ReadonlySet<string>,
  only?: ReadonlySet<string>
): string[] {
  const collisions: string[] = [];
  for (const def of registry) {
    if (!def.surfaces.has("rest") || !def.rest) continue;
    if (only && !only.has(def.name)) continue;
    const key = `${def.rest.method} ${normalizeRestPath(def.rest.path)}`;
    if (knownPaths.has(key)) collisions.push(`${key}  [def=${def.name}]`);
  }
  return collisions;
}

/**
 * mountRestRoutes — register a route for every def that exposes the "rest" surface AND declares an
 * explicit `def.rest` binding. (A rest-surface def without a `rest` binding is a registry error the
 * §8.4 coverage tests catch; here we skip it defensively rather than crash boot.)
 *
 * `opts.only` is an incremental-cutover allow-filter: when provided, ONLY defs whose `name` is in the
 * set are mounted (every other rest-surface def is skipped). Omitting it mounts all rest-surface defs,
 * preserving the current behavior. This lets the registry-derived REST surface be cut over a few
 * routes at a time without colliding with the existing hand-written routes in server.ts.
 *
 * `opts.knownInlinePaths` is an OPTIONAL collision guard (belt-and-suspenders alongside
 * tests/test_no_inline_twins.ts, NOT authoritative on its own): a set of `"<method> <normalized-path>"`
 * keys for hand-written routes registered elsewhere (e.g. server.ts's inline exceptions). If any def
 * about to be mounted shares verb+normalized-path with one, this logs ONE loud `console.warn` listing
 * every colliding path — it never throws, so a false positive can't brick boot (Express's own
 * first-registration-wins would otherwise silently drop a handler with no signal at all).
 *
 * Arg precedence in the handler is query params (lowest) < route params < body (highest), so a GET
 * route can carry filters via `?limit=…` while a path/body still wins on collision.
 */
export function mountRestRoutes(
  app: RestApp,
  registry: readonly ActionDef[],
  ctxFactory: RestContextFactory,
  opts?: { only?: ReadonlySet<string>; knownInlinePaths?: ReadonlySet<string> }
): void {
  if (opts?.knownInlinePaths) {
    const collisions = findKnownRouteCollisions(registry, opts.knownInlinePaths, opts.only);
    if (collisions.length > 0) {
      console.warn(
        `[mountRestRoutes] collision guard: ${collisions.length} rest def(s) share a path with a ` +
          `known hand-written route — Express first-registration-wins means one handler is dead:\n  ` +
          collisions.join("\n  ")
      );
    }
  }
  for (const def of registry) {
    if (!def.surfaces.has("rest") || !def.rest) continue;
    if (opts?.only && !opts.only.has(def.name)) continue;
    const { method, path } = def.rest;
    const handler: RestHandler = async (req, res) => {
      // Belt-and-suspenders: runAction is the never-throw voice choke-point, so today this catch is
      // dead code. But the seam must stay self-contained regardless of a future change to that
      // contract (or to ctxFactory) — an unhandled async rejection escaping an Express handler hangs
      // the request and can crash the process. On any unexpected throw, map it to the same 500-error
      // shape resultToHttp emits for an `error` ActionResult.
      try {
        // Merge query params + route params + body so a route like POST /api/terminals/:id/input can
        // carry both, and a GET /api/... can carry filters via the query string. Precedence (lowest ->
        // highest): query < params < body.
        const rawArgs: Record<string, unknown> = {
          ...(req.query ?? {}),
          ...(req.params ?? {}),
          ...(req.body ?? {}),
        };
        const ctx = ctxFactory(req);
        const result = await runAction(registry, def.name, rawArgs, ctx);
        applyResultToHttp(def, result, rawArgs, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resultToHttp({ kind: "error", message }, res);
      }
    };
    app[method](path, handler);
  }
}

/**
 * applyResultToHttp(def, result, args, res) — the c55 Batch E response-translation dispatcher.
 *
 * If the def declares an optional `rest.toHttp` hook, route through it: it re-projects the typed
 * `result.output` into a bespoke `{ status, body }` (the escape hatch for the ~4 structured page-load
 * reads whose body the flat `{output}` cannot carry) and that response wins. Otherwise fall through to
 * the unchanged default `resultToHttp` map — so any def WITHOUT a hook is byte-identical to the legacy
 * behavior (no regression). This is the single REST projection seam; the voice path never reaches it.
 */
export function applyResultToHttp(
  def: ActionDef,
  result: ActionResult,
  args: Record<string, unknown>,
  res: RestResponse
): void {
  if (def.rest?.toHttp) {
    const { status, body } = def.rest.toHttp(result, args);
    res.status(status).json(body);
    return;
  }
  resultToHttp(result, res);
}

/**
 * resultToHttp(result, res) — the §9 "REST" column: map an ActionResult to one HTTP response.
 *   ok       -> 200 { output }
 *   pending  -> 202 { status:"pending_approval", messageId }
 *   clarify  -> 409 { clarify }
 *   blocked  -> 403 { error }
 *   error    -> 500 { error }
 */
export function resultToHttp(result: ActionResult, res: RestResponse): void {
  switch (result.kind) {
    case "ok":
      res.status(200).json({ output: result.output });
      return;
    case "pending":
      res.status(202).json({ status: "pending_approval", messageId: result.messageId });
      return;
    case "clarify":
      res.status(409).json({ clarify: result.text });
      return;
    case "blocked":
      res.status(403).json({ error: result.reason });
      return;
    case "error":
      res.status(500).json({ error: result.message });
      return;
  }
}
