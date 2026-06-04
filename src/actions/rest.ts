/**
 * src/actions/rest.ts — the REST surface, DERIVED from the registry (§5.1 / §9).
 *
 * mountRestRoutes(app, registry, ctxFactory) registers one Express route per rest-surface action
 * (using its explicit `def.rest` binding), validates the body against the SAME zod schema the voice
 * path uses, builds a per-request ActionContext (session:null), runs the SAME runAction choke-point,
 * and maps the ActionResult to HTTP via resultToHttp. So a REST button and a voice command execute
 * the identical handler, gate, and redaction (G3 — "one path").
 *
 * This file is Phase-A scaffolding: it wires the seam. server.ts is NOT modified in this phase
 * (that is REG1 Phase C); the existing hand-written routes still serve traffic until the cutover.
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
 * Arg precedence in the handler is query params (lowest) < route params < body (highest), so a GET
 * route can carry filters via `?limit=…` while a path/body still wins on collision.
 */
export function mountRestRoutes(
  app: RestApp,
  registry: readonly ActionDef[],
  ctxFactory: RestContextFactory,
  opts?: { only?: ReadonlySet<string> }
): void {
  for (const def of registry) {
    if (!def.surfaces.has("rest") || !def.rest) continue;
    if (opts?.only && !opts.only.has(def.name)) continue;
    const { method, path } = def.rest;
    const handler: RestHandler = async (req, res) => {
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
      resultToHttp(result, res);
    };
    app[method](path, handler);
  }
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
