/**
 * src/actions/types.ts — the ActionDef registry contract (REG1 Phase A scaffolding).
 *
 * One canonical ActionDef per operation: name, params (zod), capability gate, redaction policy,
 * surfaces, and ONE handler. Every surface (Gemini voice, REST, WS) is DERIVED from these defs
 * (see gemini.ts / rest.ts / capabilities.ts / coverage.ts). This file is the spec §5.0 contract,
 * transcribed verbatim except where the GROUNDING (real server.ts) requires a precise signature.
 *
 * IMPORTANT (grounding): gateOrDefer / effectiveCapabilityGateFor / dispatchProposal are NESTED
 * CLOSURES inside server.ts over heavy server state — they cannot be imported or lifted. They are
 * INJECTED through ActionContext. The GateOrDefer type below MATCHES the real server.ts signature
 * (server.ts:1753) exactly, including the optional `params` (durable-restart intent) and
 * `requestedMode` (the permission-handler divergence rider).
 */

import type { z } from "zod";
import type { OrchestratorManager } from "../terminal";

/** Which surfaces expose this action. Goal is convergence; the flag makes drift explicit. */
export type Surface = "voice" | "rest" | "ws";

/** A capability = one row of the matrix. The set is DERIVED from the registry, not hand-listed. */
export type Capability = string; // closed at runtime by the registry; see deriveCapabilities()

/** One capability-matrix row. The metadata (label/category/default) lives in CAPABILITY_DEFS. */
export interface CapabilityDef {
  id: Capability;                 // e.g. "write_to_pane", "read_pane", "archive_pane"
  label: string;                  // plain language, no jargon (matrix + voice read-backs)
  category: string;               // grouping for the matrix editor
  defaultGate: "Auto" | "Ask" | "Off"; // behavior-preserving default (Decision 6)
  spotlightEligible?: boolean;    // may loosen to Auto on the active pane (today: write_to_pane, deliver_handoff)
}

/** Discriminated result so one handler can express every existing response shape (§9 wire map). */
export type ActionResult =
  | { kind: "ok"; output: unknown }                                  // normal read/write success
  | { kind: "pending"; messageId: string; summary: string; extra?: Record<string, unknown> } // HiTL / deferred
  | { kind: "clarify"; text: string }                                // re-route / disambiguate (e.g. non-allowlisted shell)
  | { kind: "blocked"; reason: string }                              // gate Off / forbidden
  | { kind: "error"; message: string };                              // handler failure (still answered once)

/**
 * The exact disposition union the real server.ts gateOrDefer returns (server.ts:1768). runAction
 * branches on `.disposition`: "run" -> invoke handler, "forbidden" -> blocked, "deferred" -> pending.
 */
export type GateDisposition =
  | { disposition: "run" }
  | { disposition: "forbidden" }
  | { disposition: "deferred"; actionId: string; summary: string };

/**
 * The injected gate choke-point. Signature MATCHES server.ts:1753 verbatim — do NOT change the
 * parameter order/optionality: it is the same function object the voice path calls today, handed in
 * via ActionContext. (capability is typed `string` here, not the CapabilityGate union, because the
 * registry owns a SUPERSET of capabilities — the 16 existing + the promoted reads/focus/etc. The
 * real server widens its CapabilityGate union as those promotions land in Phase B/C.)
 */
export type GateOrDefer = (
  capability: string,
  paneId: string | null,
  summary: string,
  run: () => string,
  params?: Record<string, unknown>,
  requestedMode?: string
) => GateDisposition;

/**
 * A minimal structural shape for the Gemini Live session object on the voice path. We only ever
 * call sendToolResponse on it (resultToToolResponse, §9). `null` on the REST/WS path.
 */
export interface LiveSessionLike {
  sendToolResponse: (payload: {
    functionResponses: Array<{ name: string; id?: string; response: Record<string, unknown> }>;
  }) => void;
}

/**
 * Everything a handler needs, INJECTED (never reached out to). The heavy server closures
 * (gateOrDefer, broadcast) are passed in so handlers stay thin and testable.
 */
export interface ActionContext {
  manager: OrchestratorManager;
  session: LiveSessionLike | null;     // present on the voice path; null for REST/WS
  callId?: string;                     // Gemini call.id on the voice path
  trigger?: string;                    // operator utterance / "REST" / "WS"
  broadcast: (msg: unknown) => void;
  gateOrDefer: GateOrDefer;            // the existing choke-point, injected (not re-implemented)
  redact: (s: string) => string;      // redactSecrets, injected
}

/**
 * The canonical, single-source-of-truth definition of one action. `S` is the zod schema; `z.infer<S>`
 * is the validated arg type the handler receives. ALWAYS_ALLOWED is the sentinel for the emergency
 * brake — runAction bypasses the gate for it (and ONLY it).
 */
export interface ActionDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;                        // canonical snake_case (the Gemini + dispatch + REST key)
  description: string;                 // operator-facing; fed verbatim to Gemini
  params: S;                           // ONE schema -> Gemini params + REST/WS validation
  capability: Capability | "ALWAYS_ALLOWED"; // MANDATORY — every action is a matrix entry (Decision 5)
  readOnly: boolean;                   // true => result text is redacted before leaving the process
  surfaces: ReadonlySet<Surface>;      // where it is exposed (drift made explicit & testable)
  rest?: { method: "get" | "post" | "put" | "delete"; path: string }; // optional explicit route binding
  handler: (args: z.infer<S>, ctx: ActionContext) => Promise<ActionResult> | ActionResult;
  /** Optional arg coercion for back-compat (e.g. propose_command: command -> instruction). */
  coerceArgs?: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/** The ALWAYS_ALLOWED sentinel, exported so generators/tests reference one string. */
export const ALWAYS_ALLOWED = "ALWAYS_ALLOWED" as const;
