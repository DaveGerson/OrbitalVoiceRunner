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
 */
export function mountRestRoutes(
  app: RestApp,
  registry: readonly ActionDef[],
  ctxFactory: RestContextFactory
): void {
  for (const def of registry) {
    if (!def.surfaces.has("rest") || !def.rest) continue;
    const { method, path } = def.rest;
    const handler: RestHandler = async (req, res) => {
      // Merge route params + body so a route like POST /api/terminals/:id/input can carry both.
      const rawArgs: Record<string, unknown> = { ...(req.params ?? {}), ...(req.body ?? {}) };
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
