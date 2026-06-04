/**
 * src/actions/gemini.ts — the Gemini voice surface, DERIVED from the registry (§5.1 / §5.6 / §9).
 *
 * Four exports:
 *   - zodToGeminiSchema(schema)  : ONE zod object schema -> Gemini { type:OBJECT, properties, required }.
 *   - toGeminiDeclarations(reg)  : the functionDeclarations[] for every voice-surface action.
 *   - runAction(name,args,ctx)   : the single dispatch choke-point. NEVER throws; returns ActionResult.
 *   - resultToToolResponse(...)   : ActionResult -> exactly ONE session.sendToolResponse (§9 voice col).
 *
 * The whole point (Decision 5): there is ONE place that parses args, ONE place that resolves the
 * capability gate, ONE place that redacts, and ONE try/catch. No handler re-checks permissions; no
 * surface bypasses them. runAction is that place.
 */

import { Type } from "@google/genai";
import { z } from "zod";
import { ALWAYS_ALLOWED } from "./types";
import type {
  ActionContext,
  ActionDef,
  ActionResult,
  LiveSessionLike,
} from "./types";

/**
 * Per-action deadline ceiling (ms) used when an ActionDef does not set `timeoutMs`. The deadline is
 * a CEILING, not a delay — a fast handler returns immediately. ALWAYS_ALLOWED (the emergency brake)
 * is EXEMPT: a brake call must always run to completion, never be timed out.
 */
export const DEFAULT_ACTION_TIMEOUT_MS = 30000;

/** A Gemini FunctionDeclaration (the subset we emit). `parameters` is always an OBJECT schema. */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiSchema;
}

/** The Gemini schema node shape we generate (a strict subset of the SDK's Schema). */
export interface GeminiSchema {
  type: Type;
  description?: string;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  enum?: string[];
  items?: GeminiSchema; // element schema for Type.ARRAY (e.g. create_project.key_terms: string[])
}

/** Unwrap zod 4 wrappers (optional/default/nullable) down to the inner concrete node. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  let inner = schema as z.ZodTypeAny;
  let optional = false;
  // zod 4: wrappers carry `.def.innerType`; optional/default/nullable make a field non-required.
  // Loop because they can nest (e.g. .optional().default()).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const def = (inner as { def?: { type?: string; innerType?: z.ZodTypeAny } }).def;
    const t = def?.type;
    if ((t === "optional" || t === "default" || t === "nullable") && def?.innerType) {
      if (t === "optional" || t === "nullable") optional = true;
      inner = def.innerType;
      continue;
    }
    break;
  }
  return { inner, optional };
}

/** Map ONE non-object zod leaf to its Gemini scalar schema. Throws on an unsupported shape (R4). */
function leafToGemini(schema: z.ZodTypeAny): GeminiSchema {
  const def = (schema as { def?: { type?: string; entries?: Record<string, string>; element?: z.ZodTypeAny } }).def;
  const t = def?.type;
  switch (t) {
    case "string":
      return { type: Type.STRING };
    case "number":
      return { type: Type.NUMBER };
    case "boolean":
      return { type: Type.BOOLEAN };
    case "enum": {
      // zod 4 enum: def.entries is a { value: value } record; the keys are the literal members.
      const values = Object.values(def?.entries ?? {}).map((v) => String(v));
      return { type: Type.STRING, enum: values };
    }
    case "array": {
      // zod 4 array: def.element is the element schema. Unwrap any optional/default/nullable on the
      // element, then recurse (e.g. create_project.key_terms: z.array(z.string()) -> items STRING).
      const element = def?.element;
      if (!element) throw new Error(`zodToGeminiSchema: z.array with no element type`);
      return { type: Type.ARRAY, items: leafToGemini(unwrap(element).inner) };
    }
    case "object":
      // Nested objects recurse through the top-level converter.
      return zodToGeminiSchema(schema as z.ZodObject<z.ZodRawShape>);
    default:
      throw new Error(
        `zodToGeminiSchema: unsupported zod type "${String(t)}" — only object/string/number/boolean/enum/array/optional are supported`
      );
  }
}

/**
 * zodToGeminiSchema(schema) — a zod OBJECT schema -> Gemini { type:OBJECT, properties, required }.
 * Optional fields (`.optional()`/`.nullable()`/`.default()`) are omitted from `required`. Empty
 * schemas yield `properties: {}` (pins §8.2 #8). Throws on a non-object top level or an unsupported
 * leaf (§8.2 #7 covers the supported shapes; R4 makes the rest a build-time error, not runtime).
 */
export function zodToGeminiSchema(schema: z.ZodTypeAny): GeminiSchema {
  const { inner } = unwrap(schema);
  const def = (inner as { def?: { type?: string; shape?: Record<string, z.ZodTypeAny> } }).def;
  if (def?.type !== "object" || !def.shape) {
    throw new Error(
      `zodToGeminiSchema: top-level params must be a z.object (got "${String(def?.type)}")`
    );
  }
  const properties: Record<string, GeminiSchema> = {};
  const required: string[] = [];
  for (const [key, fieldSchema] of Object.entries(def.shape)) {
    const { inner: fieldInner, optional } = unwrap(fieldSchema);
    properties[key] = leafToGemini(fieldInner);
    if (!optional) required.push(key);
  }
  const out: GeminiSchema = { type: Type.OBJECT, properties };
  // Only attach `required` when non-empty so empty-params tools emit a clean `{ properties: {} }`.
  if (required.length) out.required = required;
  return out;
}

/**
 * toGeminiDeclarations(registry) — the functionDeclarations[] passed to ai.live.connect. Filters
 * to voice-surface actions and maps each ActionDef's zod params via zodToGeminiSchema. This REPLACES
 * the hand-written functionDeclarations literal in server.ts; the generated name set IS the voice
 * surface (§8.2 #6 — parity by construction).
 */
export function toGeminiDeclarations(registry: readonly ActionDef[]): GeminiFunctionDeclaration[] {
  return registry
    .filter((def) => def.surfaces.has("voice"))
    .map((def) => ({
      name: def.name,
      description: def.description,
      parameters: zodToGeminiSchema(def.params),
    }));
}

/**
 * runAction(name, rawArgs, ctx) — the SINGLE dispatch wrapper (§5.6). The entire Gemini tool
 * dispatch collapses into this: lookup -> coerceArgs -> params.parse -> handler -> redact if readOnly
 * -> return. ONE try/catch wraps everything; it NEVER throws — a missing action, a bad arg, or a
 * handler throw all return a typed { kind:"error" } ActionResult (so the surface can still answer
 * call.id exactly once).
 *
 * GATE MODEL — HANDLER-OWNED (Decision: model B; the gating in server.ts is heterogeneous, not a
 * uniform central gate). runAction does NOT apply a capability gate. WHY NOT a central gate:
 *
 *   1. DURABLE-REPLAY (kzt) CORRECTNESS. A central gate could only pass a GENERIC run-thunk to
 *      gateOrDefer. The scaffold passed `() => summary` — a NO-OP. An Ask-deferred action would then
 *      stage a no-op closure; buildActionRun (src/actionEffects.ts) only re-derives 5 known
 *      capability/op cases from `params`, so any other deferred tool replays as the `default` no-op
 *      and LOSES its side effect after confirm/restart. The HANDLER, by contrast, hands gateOrDefer
 *      the SAME real `run` closure + the SAME `params` bag buildActionRun already mirrors — exactly
 *      as today. Closure ⇄ params stay in lockstep by construction.
 *   2. THE GATING IS HETEROGENEOUS. Mutators call gateOrDefer themselves (tool-specific summary +
 *      real run + durable params + optional requestedMode rider); propose_command/deliver_handoff/
 *      execute_plan route through dispatchProposal (its own gate + HiTL staging + DispatchOutcome);
 *      apply_recipe rides the lighter Off-veto gateCapability; and SEVERAL tools are intentionally
 *      UNGATED (drafts, notes, focus, mute, handoff staging). No single central gate reproduces this.
 *   3. ZERO-BEHAVIOR-CHANGE. Each handler faithfully ports its branch, so the 38 voice-tool goldens
 *      stay a TRUE no-behavior-change oracle. "Enforce every capability uniformly" is a real Phase-2
 *      enhancement (needs a buildActionRun entry per newly-deferrable tool) — out of Phase-1 scope.
 *
 * gateOrDefer / dispatchProposal / gateCapability remain THE single enforcement FUNCTIONS (one impl
 * each, injected on ctx); handlers merely call them. `def.capability` stays declared for the matrix
 * projection + docs; runAction does not read it to gate (ALWAYS_ALLOWED is no longer special-cased
 * here — the brake handlers simply never call a gate).
 *
 * @param registry the canonical ActionDef[] to dispatch against (injected so tests pass a fixture).
 */
export async function runAction(
  registry: readonly ActionDef[],
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ActionContext
): Promise<ActionResult> {
  try {
    const def = registry.find((d) => d.name === name);
    if (!def) {
      return { kind: "error", message: `unknown action ${name}` };
    }

    // 1 validation point: coerce legacy arg shapes, then parse against the zod schema.
    const coerced = def.coerceArgs ? def.coerceArgs(rawArgs) : rawArgs;
    let args: unknown;
    try {
      args = def.params.parse(coerced);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return { kind: "error", message: `invalid arguments for ${name}: ${msg}` };
    }

    // 1 execution point. The HANDLER owns gating: it calls ctx.gateOrDefer / ctx.dispatchProposal /
    // ctx.gateCapability exactly where and how its legacy server.ts branch does (or not at all, for
    // the intentionally-ungated tools). runAction applies no gate of its own.
    //
    // PLM1 — per-action timeout. NON-ALWAYS_ALLOWED handlers race a deadline ceiling so a wedged tool
    // can never hang the dispatch loop; ALWAYS_ALLOWED (the emergency brake) is EXEMPT — a brake call
    // must always run to completion. Elapsed ms is measured around the handler with performance.now()
    // (high-resolution) and fed to the audit seam below.
    const start = performance.now();
    let result: ActionResult;
    if (def.capability === ALWAYS_ALLOWED) {
      result = await def.handler(args as never, ctx);
    } else {
      result = await raceDeadline(
        () => Promise.resolve(def.handler(args as never, ctx)),
        def.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
        name
      );
    }
    const ms = performance.now() - start;

    // 1 redaction point: readOnly results never leave the process un-redacted (mandatory, §5.6).
    const finalResult: ActionResult = def.readOnly ? redactResult(result, ctx.redact) : result;

    // audit() seam — best-effort, fired exactly once per dispatch. The store wiring (-> JanusStore,
    // which stamps `ts` + applies redaction) is done later in server.ts; here we only define + call.
    // The try/catch NEVER rethrows: an audit sink fault must not break dispatch.
    try {
      ctx.audit?.({
        name,
        capability: def.capability,
        resultKind: finalResult.kind,
        ms,
        args, // parsed args (NOT raw); the store applies redaction later
        surface: ctx.trigger,
      });
    } catch {
      // swallow — audit must never break the dispatch path.
    }

    return finalResult;
  } catch (e) {
    // ONE try/catch. A throwing handler becomes a typed error, answered once by the surface.
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Race a handler thunk against a deadline ceiling. If the deadline wins, resolve EXACTLY ONCE with a
 * typed timeout error; the handler's eventual settle is then ignored. The timer is ALWAYS cleared
 * (no dangling setTimeout) whether the handler or the deadline wins, or the handler throws.
 */
function raceDeadline(
  run: () => Promise<ActionResult>,
  ms: number,
  name: string
): Promise<ActionResult> {
  return new Promise<ActionResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "error", message: `action ${name} exceeded its ${ms}ms deadline` });
    }, ms);
    // node timers: don't keep the event loop alive on account of this watchdog.
    (timer as { unref?: () => void }).unref?.();
    run().then(
      (r) => {
        clearTimeout(timer);
        if (settled) return; // deadline already answered — ignore the late settle.
        settled = true;
        resolve(r);
      },
      (err) => {
        clearTimeout(timer);
        if (settled) return; // deadline already answered — ignore the late throw.
        settled = true;
        reject(err); // surfaced to the outer try/catch -> typed error, answered once.
      }
    );
  });
}

/** Redact string leaves of a readOnly result so secrets never leave the process. */
function redactResult(result: ActionResult, redact: (s: string) => string): ActionResult {
  if (result.kind === "ok") {
    return { kind: "ok", output: redactDeep(result.output, redact) };
  }
  if (result.kind === "clarify") {
    return { kind: "clarify", text: redact(result.text) };
  }
  // pending/blocked/error carry no model-bound read payload to redact.
  return result;
}

/** Recursively redact every string in a value (strings, arrays, plain objects). */
function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, redact);
    }
    return out;
  }
  return value;
}

/**
 * resultToToolResponse(result, session, callId) — map an ActionResult to EXACTLY ONE
 * session.sendToolResponse call (the §9 "Voice" column). This is the structural pin on the WS-E.1
 * "answer call.id once" invariant: every branch calls sendToolResponse exactly once. A null session
 * (REST/WS path) is a no-op (those surfaces map via resultToHttp instead).
 */
export function resultToToolResponse(
  result: ActionResult,
  session: LiveSessionLike | null,
  name: string,
  callId?: string
): void {
  if (!session) return;
  const response = voiceResponse(result);
  session.sendToolResponse({
    functionResponses: [{ name, id: callId, response }],
  });
}

/** The §9 voice-column mapping: ActionResult -> the `response` object inside functionResponses. */
function voiceResponse(result: ActionResult): Record<string, unknown> {
  switch (result.kind) {
    case "ok":
      return { output: result.output };
    case "pending":
      return { status: "pending_approval", messageId: result.messageId, ...(result.extra ?? {}) };
    case "clarify":
      return { status: "clarify", output: result.text };
    case "blocked":
      return { output: result.reason };
    case "error":
      return { output: `Internal error: ${result.message}` };
  }
}
