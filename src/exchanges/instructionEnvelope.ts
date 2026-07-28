// src/exchanges/instructionEnvelope.ts
//
// InstructionEnvelope — Orbital's *communication* contract for one instruction to one pane
// (Phase 3, Step 3.2/3.3; spec docs/superpowers/specs/2026-07-09-instruction-routing.md §1-§2,
// §5-§6). Pure, no I/O, no Date — the src/templates.ts posture: this module builds, revises,
// assesses, and renders envelopes; it never talks to the store, the PTY, or the gate. Callers
// (the exchange service, the voice action defs) own persistence and delivery.
//
// Anti-fabrication invariant (normative, spec §1): every content string traces to something the
// operator said. buildEnvelope/reviseDraft NORMALIZE (trim, drop empties, preserve order) and
// NEVER invent constraints, acceptance criteria, tech choices, file lists, or test demands.
// Missing content is reported (assessReadiness's clarification), never guessed.

import { z } from "zod";
// FLAG COLLAPSE (2026-07, refactor/collapse-exchange-flags): this module used to read its OWN
// independent env var (JANUS_INSTRUCTION_ENVELOPE, off/shadow/primary). That independent var is
// GONE — instruction-envelope mode is now ENTIRELY DERIVED from the exchange spine's own mode
// (src/exchanges/flag.ts's FLAG LATTICE doc comment). Importing that VALUE from src/exchanges/
// flag.ts directly (rather than from the side-effect-free src/exchanges/flagReader.ts) is still a
// real hazard, though — see flagReader.ts's doc comment for the regression this caught: this
// module is imported all over the codebase/tests for PURE, flag-agnostic reasons (buildEnvelope,
// createDraft, renderEnvelope, …), so importing flag.ts here would transitively freeze ITS eager
// `EXCHANGE_SPINE_MODE` the moment anything imports so much as `buildEnvelope` for an unrelated
// pure-logic assertion — well before a test's own deliberate env-var setup. `readExchangeSpineMode`/
// `legacyFlagRetirementWarning` therefore both come from flagReader.ts, and this module computes
// its OWN independently-frozen copy of the spine mode below (`SPINE_MODE_AT_LOAD`), exactly
// mirroring flag.ts's own "read once at module load" idiom rather than sharing its freeze point.
import { legacyFlagRetirementWarning, readExchangeSpineMode, type ExchangeSpineMode } from "./flagReader";
import { mintSeqId } from "./types";

// ── schema (zod, matching the repo's zod usage — src/voice/policyClient.ts's op-local pattern) ──

/** Canonical InstructionEnvelope shape (program spec §1; stored redacted in
 *  agent_exchanges.instruction_envelope_json, src/exchanges/types.ts:71, schema v12). */
export const InstructionEnvelopeSchema = z.object({
  objective: z.string(),
  relevant_context: z.array(z.string()),
  constraints: z.array(z.string()),
  requested_output: z.string().nullable(),
  completion_signal: z.string().nullable(),
  operator_language: z.string(),
});

export type InstructionEnvelope = z.infer<typeof InstructionEnvelopeSchema>;

export interface EnvelopeTarget {
  projectId: string;
  paneId: string;
}

export interface EnvelopeDraft {
  exchangeId: string;
  target: EnvelopeTarget | null;
  envelope: InstructionEnvelope;
  /** Starts at 1; every revise() bumps it (mirrors the exchange spine's draft_version, spec §5). */
  draftVersion: number;
  /** Versions already sent — the send-idempotency key (spec §5.3). */
  sentVersions: readonly number[];
}

// ── §2.2 the deterministic readiness predicate ──────────────────────────────────────────────────

export type ReadinessResult =
  | { ready: true }
  | { ready: false; missing: "target" | "objective"; clarification: string };

/**
 * Pure, ordered, single-answer (spec §2.2): target missing outranks objective missing — exactly
 * ONE targeted clarification per unready check, in the fixed priority order (target -> objective).
 * Readiness gates COMMUNICATION completeness only; it is never permission (§2.2's "Readiness ≠
 * permission" — the capability gate is a separate, downstream choke-point this module never
 * touches).
 */
export function assessReadiness(draft: EnvelopeDraft): ReadinessResult {
  if (draft.target === null) {
    return {
      ready: false,
      missing: "target",
      clarification: "Which pane should this go to?",
    };
  }
  if (draft.envelope.objective.trim() === "") {
    return {
      ready: false,
      missing: "objective",
      clarification: "What should I ask it to do?",
    };
  }
  return { ready: true };
}

// ── §1 envelope build (normalization only, never fabrication) ──────────────────────────────────

function normalizeList(items: string[] | undefined): string[] {
  return (items ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

function normalizeNullable(s: string | null | undefined): string | null {
  if (s == null) return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface BuildEnvelopeInput {
  objective?: string;
  relevantContext?: string[];
  constraints?: string[];
  requestedOutput?: string | null;
  completionSignal?: string | null;
  operatorLanguage?: string; // defaults to "en"
}

/**
 * Assemble an InstructionEnvelope from already-extracted operator statements. Normalizes
 * (trim, drop empties, preserve order) — NEVER invents content (spec §1's anti-fabrication
 * invariant). Absent optionals stay empty-array/null; absence is valid, not a gap to fill.
 */
export function buildEnvelope(input: BuildEnvelopeInput): InstructionEnvelope {
  const operatorLanguage = (input.operatorLanguage ?? "en").trim() || "en";
  return {
    objective: (input.objective ?? "").trim(),
    relevant_context: normalizeList(input.relevantContext),
    constraints: normalizeList(input.constraints),
    requested_output: normalizeNullable(input.requestedOutput),
    completion_signal: normalizeNullable(input.completionSignal),
    operator_language: operatorLanguage,
  };
}

// ── §5 draft creation / revision / send idempotency ─────────────────────────────────────────────

/** Mint a fresh envelope-draft id via the shared `<prefix>_<epoch36>_<seq36>` factory
 *  (src/exchanges/types.ts `mintSeqId`, the same one backing `mintExchangeId`). This is the
 *  ENVELOPE draft's own local id when the caller does not already have a real exchange_id to bind
 *  to (createDraft accepts one). */
const mintDraftExchangeId = mintSeqId("envd");

export interface CreateDraftInput {
  exchangeId?: string;
  target?: EnvelopeTarget | null;
  envelope: InstructionEnvelope;
}

export function createDraft(input: CreateDraftInput): EnvelopeDraft {
  return {
    exchangeId: input.exchangeId ?? mintDraftExchangeId(),
    target: input.target ?? null,
    envelope: input.envelope,
    draftVersion: 1,
    sentVersions: [],
  };
}

export interface ReviseDraftPatch {
  objective?: string;
  relevantContext?: string[];
  constraints?: string[];
  requestedOutput?: string | null;
  completionSignal?: string | null;
  target?: EnvelopeTarget | null;
}

/**
 * PURE revise: returns a NEW draft with draftVersion+1 (mirrors the exchange spine's
 * draft_revised rule — spec §5, spine §3). Field-level patch (voice) or a retarget (spec §5.3);
 * either kind of change is a revision. `sentVersions` carries forward unchanged (send idempotency
 * is per-version, not reset by a revise). Never mutates its input.
 */
export function reviseDraft(draft: EnvelopeDraft, patch: ReviseDraftPatch): EnvelopeDraft {
  const nextEnvelope = buildEnvelope({
    objective: patch.objective !== undefined ? patch.objective : draft.envelope.objective,
    relevantContext: patch.relevantContext !== undefined ? patch.relevantContext : draft.envelope.relevant_context,
    constraints: patch.constraints !== undefined ? patch.constraints : draft.envelope.constraints,
    requestedOutput: patch.requestedOutput !== undefined ? patch.requestedOutput : draft.envelope.requested_output,
    completionSignal: patch.completionSignal !== undefined ? patch.completionSignal : draft.envelope.completion_signal,
    operatorLanguage: draft.envelope.operator_language,
  });
  return {
    ...draft,
    envelope: nextEnvelope,
    target: patch.target !== undefined ? patch.target : draft.target,
    draftVersion: draft.draftVersion + 1,
  };
}

export type RecordSendResult =
  | { ok: true; draft: EnvelopeDraft }
  | { ok: false; reason: "duplicate_version" | "not_ready" };

/**
 * Idempotent send per draft version (spec §5.3, spine §2): readiness must pass FIRST (§2.2 —
 * communication completeness, not permission), then a repeat send of the SAME version is a
 * refused no-op (a double-click or replayed voice send can never double-type into a live agent).
 * A revise-then-send at the new version succeeds again.
 */
export function recordSend(draft: EnvelopeDraft): RecordSendResult {
  const readiness = assessReadiness(draft);
  if (!readiness.ready) return { ok: false, reason: "not_ready" };
  if (draft.sentVersions.includes(draft.draftVersion)) {
    return { ok: false, reason: "duplicate_version" };
  }
  return {
    ok: true,
    draft: { ...draft, sentVersions: [...draft.sentVersions, draft.draftVersion] },
  };
}

// ── §6 adapter rendering contract ───────────────────────────────────────────────────────────────

export type RenderPreset = "Claude Code" | "Codex" | "Antigravity" | "Custom";

export interface RenderProfile {
  preset: RenderPreset;
  headingStyle: "plain" | "markdown";
  requestCompletionEnvelope: boolean;
  escapeStyle: "strip-control";
  eol: "\n" | "\r\n";
  submitSequence: "enter";
  maxChars: number;
}

/** The ONE fixed protocol line requestCompletionEnvelope may append — communication framing, not
 *  a technical requirement (spec §6.2). The only non-operator content the renderer ever adds.
 *
 *  Coherence with `JANUS_AGENT_COMPLETION_PROMPT` (Phase 4, Step 4.1, src/exchanges/resultEnvelope.ts;
 *  post-2026-07-collapse name for the old JANUS_AGENT_RESULT_ENVELOPE "request" rung): that flag does
 *  NOT introduce a second, competing "please answer in JSON" prompt string. This line is the ONE
 *  invitation an adapter ever appends; a terminal agent may answer it
 *  either in plain prose (picked up by the conservative legacy finalResponse heuristic,
 *  src/observe/index.ts) or with a structured result envelope (picked up by
 *  resultEnvelope.ts's scanner) — both funnel into the same trust boundary and settlement path
 *  (`ExchangeService.recordReportedOutcome`). Keep it that way: do not add a JSON-specific request
 *  line here without updating that module's JANUS_AGENT_COMPLETION_PROMPT flag note to match. */
export const COMPLETION_REQUEST_LINE: string =
  "When you finish, report completion clearly (e.g. a final line stating done or blocked, and why).";

/** Default profile table (spec §6.2's shape is the contract; defaults tunable). Claude Code /
 *  Codex — markdown headings, completion envelope on. Antigravity — plain, on. Custom — plain,
 *  completion envelope OFF (a shell pane gets bare operator prose). */
export const RENDER_PROFILES: Record<RenderPreset, RenderProfile> = {
  "Claude Code": {
    preset: "Claude Code",
    headingStyle: "markdown",
    requestCompletionEnvelope: true,
    escapeStyle: "strip-control",
    eol: "\n",
    submitSequence: "enter",
    maxChars: 8000,
  },
  Codex: {
    preset: "Codex",
    headingStyle: "markdown",
    requestCompletionEnvelope: true,
    escapeStyle: "strip-control",
    eol: "\n",
    submitSequence: "enter",
    maxChars: 8000,
  },
  Antigravity: {
    preset: "Antigravity",
    headingStyle: "plain",
    requestCompletionEnvelope: true,
    escapeStyle: "strip-control",
    eol: "\n",
    submitSequence: "enter",
    maxChars: 8000,
  },
  Custom: {
    preset: "Custom",
    headingStyle: "plain",
    requestCompletionEnvelope: false,
    escapeStyle: "strip-control",
    eol: "\n",
    submitSequence: "enter",
    maxChars: 8000,
  },
};

/** Formatting-only key-set audit guard (spec §6.2: "profiles control formatting ONLY"). Runs at
 *  module load over every entry in RENDER_PROFILES so a future edit that accidentally widens a
 *  profile with a target/gate/exchange-state key fails loudly at import time, not at render time. */
const RENDER_PROFILE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "preset", "headingStyle", "requestCompletionEnvelope", "escapeStyle", "eol", "submitSequence", "maxChars",
]);

function assertFormattingOnly(profile: RenderProfile): void {
  for (const key of Object.keys(profile)) {
    if (!RENDER_PROFILE_ALLOWED_KEYS.has(key)) {
      throw new Error(`RenderProfile['${profile.preset}'] carries a non-formatting key: ${key}`);
    }
  }
}

for (const preset of Object.keys(RENDER_PROFILES) as RenderPreset[]) {
  assertFormattingOnly(RENDER_PROFILES[preset]);
}

const CONTROL_BYTE_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g; // preserves \t \n \r — eol owns those

function applyEscapeStyle(text: string, style: RenderProfile["escapeStyle"]): string {
  if (style === "strip-control") return text.replace(CONTROL_BYTE_RE, "");
  return text;
}

function applyEol(text: string, eol: RenderProfile["eol"]): string {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function pushSection(lines: string[], label: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push("");
  lines.push(label);
  for (const item of items) lines.push(`- ${item}`);
}

/**
 * Deterministic pure renderer (spec §6.2): same (envelope, profile) -> byte-identical output,
 * always. Output contains ONLY operator-provided content plus fixed section labels (and, when
 * requested, the ONE fixed COMPLETION_REQUEST_LINE). Empty optional sections are omitted
 * ENTIRELY, label included. Profiles control formatting ONLY — this function never sees target,
 * gates, or exchange state (only the envelope + the formatting-only RenderProfile).
 */
export function renderEnvelope(envelope: InstructionEnvelope, profile: RenderProfile): string {
  const contextLabel = profile.headingStyle === "markdown" ? "## Context" : "Context:";
  const constraintsLabel = profile.headingStyle === "markdown" ? "## Constraints" : "Constraints:";

  const lines: string[] = [envelope.objective];
  pushSection(lines, contextLabel, envelope.relevant_context);
  pushSection(lines, constraintsLabel, envelope.constraints);

  if (envelope.requested_output !== null) {
    lines.push("");
    lines.push(`Respond with: ${envelope.requested_output}`);
  }
  if (envelope.completion_signal !== null) {
    lines.push("");
    lines.push(`When done: ${envelope.completion_signal}`);
  }
  if (profile.requestCompletionEnvelope) {
    lines.push("");
    lines.push(COMPLETION_REQUEST_LINE);
  }

  const body = applyEscapeStyle(lines.join("\n"), profile.escapeStyle);
  return applyEol(body, profile.eol);
}

/**
 * §6.2 size-ceiling guard: how many characters a rendered instruction is OVER the profile's
 * maxChars (0 when within limit). The renderer itself NEVER truncates (spec §6.2: "over-limit
 * REFUSES at send … never silent truncation") — send lanes (send_instruction, the Workbench
 * POST /draft/send) call this and REFUSE with a clarify/400 naming the overflow, leaving the
 * draft open so the operator can shorten it. Pure.
 */
export function renderedOverflow(rendered: string, profile: RenderProfile): number {
  return Math.max(0, rendered.length - profile.maxChars);
}

// ── §7 feature flag — DERIVED from JANUS_EXCHANGE_SPINE (flag collapse, 2026-07) ───────────────
//
// This module no longer reads an env var of its own. Instruction-envelope mode used to be the
// independent JANUS_INSTRUCTION_ENVELOPE off|shadow|primary flag; per src/exchanges/flag.ts's FLAG
// LATTICE it is now DERIVED 1:1 from the exchange spine's own mode (off -> off, `record` -> the old
// shadow-equivalent, `authoritative` -> the old primary-equivalent):
//
//   spine off (default)   — no envelope structures are built; target resolution, drafts, and sends
//                            run today's paths byte-identically.
//   spine "record"        — envelopes are built and stored, the renderer's output is computed for
//                            fidelity telemetry; deliveries still go out on today's raw
//                            distilled_instruction path.
//   spine "authoritative" — the rendered envelope IS the delivered instruction; the target-resolver
//                            decision governs routing; the Workbench bridge (spec §5.2) is live.
//
// `instructionEnvelopeActive`/`instructionEnvelopeIsPrimary` keep their pre-collapse NAMES and
// zero-arg call shape (every real call site in this codebase calls them with no args) — only what
// feeds them changed, from an independent cached constant to a copy of the spine's mode. That copy
// is THIS module's own (`SPINE_MODE_AT_LOAD` below), frozen at ITS OWN first import — NOT
// src/exchanges/flag.ts's `EXCHANGE_SPINE_MODE` (see this file's import comment for why importing
// that constant directly is a real freeze-order hazard, not merely a style preference).
const SPINE_MODE_AT_LOAD: ExchangeSpineMode = readExchangeSpineMode();

// LEGACY VAR (back-compat, never an error): an operator who still has JANUS_INSTRUCTION_ENVELOPE
// set gets a one-line startup warning (via the shared, pure `legacyFlagRetirementWarning`,
// src/exchanges/flagReader.ts) that the var is now ignored — never a crash, never a behavior
// change from what JANUS_EXCHANGE_SPINE alone dictates.
const legacyInstructionEnvelopeWarning = legacyFlagRetirementWarning(
  "JANUS_INSTRUCTION_ENVELOPE",
  "it has been subsumed into JANUS_EXCHANGE_SPINE — record/authoritative now imply the old shadow/primary instruction-envelope behavior automatically.",
);
if (legacyInstructionEnvelopeWarning) console.warn(legacyInstructionEnvelopeWarning);

export function instructionEnvelopeActive(mode: ExchangeSpineMode = SPINE_MODE_AT_LOAD): boolean {
  return mode !== "off";
}

export function instructionEnvelopeIsPrimary(mode: ExchangeSpineMode = SPINE_MODE_AT_LOAD): boolean {
  return mode === "authoritative";
}
