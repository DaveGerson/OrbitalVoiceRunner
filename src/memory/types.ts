// src/memory/types.ts — shared shapes for the in-process memory layer (P0a).
// Budget is CHAR-based (≈4 chars/token) to avoid a tokenizer dependency in v1.
import { z } from "zod";

export interface ProjectTier {
  projectId: string;
  name: string;
  summary: string;
  keyTerms: string[];
  recentDecisions: string[];   // redacted, newest-first
}
export interface PaneTier {
  paneId: string;
  name: string;
  runtimeType: string;
  status: string;              // "Running" | "Idle" | "Exited"
  lastCommand: string | null;  // redacted
  recent: string[];            // redacted recent pane lines/outcomes, newest-first
}
export interface BoardEntry { paneId: string; name: string; status: string; }
export interface JanusFrame {
  role: string;
  gatePosture: string;         // global permissions mode summary
  prefs: string[];             // redacted global operator prefs, may be empty
}
export interface Breadcrumb { ts: number; paneId: string | null; text: string; } // text already redacted

export interface MemoryTiers {
  project: ProjectTier | null;
  pane: PaneTier | null;       // the ACTIVE pane (focus)
  board: BoardEntry[];
  frame: JanusFrame;
  breadcrumbs: Breadcrumb[];   // newest-first, already age/cap filtered
}

export interface BudgetWeights {
  project: number; pane: number; breadcrumbs: number; board: number; frame: number;
}
export interface MemoryConfig {
  totalBudgetChars: number;    // default 4800 (~1200 tokens)
  weights: BudgetWeights;      // fractions, sum ≈ 1
  breadcrumbMax: number;       // default 12
  breadcrumbMaxAgeMs: number;  // default 15 min
}
export interface SynthesizedBrief {
  text: string;
  perTierChars: Record<string, number>;
  activePaneId: string | null;
  source: "fallback" | "python";  // P0a always "fallback"
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  totalBudgetChars: 4800,
  weights: { project: 0.40, pane: 0.30, breadcrumbs: 0.15, board: 0.10, frame: 0.05 },
  breadcrumbMax: 12,
  breadcrumbMaxAgeMs: 15 * 60 * 1000,
};

/** The NDJSON wire protocol version. A mismatch ⇒ daemon treated as unavailable ⇒ fallback.
 *  SINGLE SOURCE for the TS side; Python's copy lives in python/synthesizer/dispatch.py. The two are
 *  kept equal by tests/test_wire_version_parity.ts (a red test on any silent drift) — see seam plan
 *  task 1.4. Bump here AND there in the same change, then re-run the golden sweep. */
export const WIRE_VERSION = 1;

/** Shape of the brief Python returns (TS stamps `source` authoritatively; Python cannot claim it). */
export const PythonBriefSchema = z.object({
  text: z.string(),
  perTierChars: z.record(z.string(), z.number()),
  activePaneId: z.string().nullable(),
});

export const PingResponseSchema = z.object({
  id: z.string(),
  v: z.literal(WIRE_VERSION),
  ok: z.literal(true),
  pong: z.literal(true),
  synthVersion: z.string(),
});

export const SynthesizeResponseSchema = z.union([
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    brief: PythonBriefSchema,
    meta: z.object({ strategy: z.string(), synthVersion: z.string() }).optional(),
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type PingResponse = z.infer<typeof PingResponseSchema>;
export type SynthesizeResponse = z.infer<typeof SynthesizeResponseSchema>;

// ── approval.parse op envelope (seam Inc 1, task 1.4) ─────────────────────────────────────────────
// Request payload: { transcript: string }. Response payload: the ParsedApproval-shaped `parsed`.
// This is the WIRE contract the approval typed facade validates; the parser's own TS type lives in
// src/approvalIntent.ts (ParsedApproval) and is structurally identical to `z.infer<ParsedApprovalSchema>`.
export const ApprovalIntentSchema = z.enum(["approve", "reject", "defer", "clarify", "none"]);

/** A target hint: a 1-based ordinal (-1 = last) and/or a named fragment. Both keys optional; the
 *  parser OMITS a key it did not set (matching the TS `JSON.stringify(undefined)` drop). */
export const TargetHintSchema = z.object({
  fragment: z.string().optional(),
  ordinal: z.number().optional(),
});

export const ParsedApprovalSchema = z.object({
  intent: ApprovalIntentSchema,
  targetHint: TargetHintSchema.optional(),
});

export const ApprovalParseResponseSchema = z.union([
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    parsed: ParsedApprovalSchema,
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type WireParsedApproval = z.infer<typeof ParsedApprovalSchema>;
export type ApprovalParseResponse = z.infer<typeof ApprovalParseResponseSchema>;
