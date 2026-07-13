// src/exchanges/resultEnvelope.ts
//
// AgentExchange spine — the agent RESULT ENVELOPE parser (Phase 4, Step 4.1; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §5.6/§9.3, §10.2).
//
// A terminal coding agent MAY print one line of structured JSON reporting its own outcome for the
// instruction it was just handed:
//
//   {"exchange_id":"exch_...","status":"complete"|"failed"|"needs_input",
//    "summary":"...","evidence":["..."],"needs_operator":true|false}
//
// This is a REPORT, never a verification (spec §9.3 — Orbital never runs tests/lints/builds to
// "verify" an exchange); it is also, categorically, UNTRUSTED INPUT: it originates from inside a
// live PTY stream that may echo operator-pasted text, a pasted log, or (in the adversarial case) a
// prompt-injected line crafted to LOOK like a completion report for an exchange that isn't this
// pane's. Every rule below exists to keep a malformed or forged envelope from ever being able to
// settle, or mis-settle, an exchange:
//
//   TRUST BOUNDARY (normative):
//   1. Shape: zod `.strict()` schema — unknown keys, wrong types, or an unrecognized `status`
//      value are REJECTED (never coerced, never "best-effort" accepted).
//   2. Size caps: a bounded scan window, a bounded number of JSON-object candidates per scan, a
//      per-candidate character cap (skip-before-parse), and per-field string/array caps — an
//      attacker cannot use this surface to force a large JSON.parse or an unbounded persisted row.
//   3. Correlation: decoding a well-formed envelope is NOT enough to act on it. The caller (the
//      exchange service, `ExchangeService.recordReportedOutcome`) MUST additionally check the
//      envelope's `exchange_id` against the pane's own ACTIVE delivery marker
//      (`activeExchangeForPane`) before applying anything. A mismatched, stale (superseded-by-
//      retry), or plain-forged id is IGNORED and logged as "uncorrelated" — structured output can
//      never impersonate another exchange, and a stale envelope from an interrupted/superseded
//      delivery can never reach back and settle the exchange that replaced it. This module has no
//      pane/exchange state itself (pure parse/scan), so it cannot enforce this rule alone — it only
//      hands the caller a fully-validated candidate to check.
//   4. Redaction: `summary` and every `evidence` entry are passed through the SAME secret scrubber
//      the rest of the exchange spine uses (`redactSecrets`, src/terminal.ts) before this module
//      ever returns them — the caller persists exactly what it receives here, never the raw text.
//   5. Fail-safe: any parse/shape failure on any candidate is swallowed and the scan simply moves
//      on; this module NEVER throws, and "found nothing valid" is a first-class, silent outcome —
//      never a partial/best-guess application.
//
// DETECTION CONTRACT (normative — keep this in sync with the doc comment on `scanForResultEnvelope`
// and with tests/test_agent_result_envelope.ts's "detection-contract cases"):
//   - Only runs when the mode is not "off" (see the flag section below).
//   - The scan window is the LAST `maxScanChars` characters of the given text (default 8 KiB) —
//     tail-anchored, because a completion report is the agent's LAST line of output for a turn,
//     and bounding the window keeps a multi-megabyte pane-output tail from ever reaching the
//     scanner (defense in depth on top of the caller's own output-length caps).
//   - Within that window, a single left-to-right, O(n), string/escape-aware brace-matching pass
//     (NOT a backtracking regex — no ReDoS surface) extracts every syntactically-balanced top-level
//     `{...}` object substring, up to `maxCandidates` (default 25) candidates.
//   - An unbalanced/truncated trailing `{` (e.g. the window cut a JSON object in half) simply stops
//     the scan at that point — a truncated candidate is never partially parsed.
//   - Each candidate over `MAX_CANDIDATE_CHARS` is skipped without attempting `JSON.parse`.
//   - Each remaining candidate is `JSON.parse`d, then validated against the strict envelope schema.
//     A parse or validation failure is not fatal — the scan continues to the next candidate.
//   - Result rule: the LAST candidate (in appearance order) that both parses and validates WINS —
//     "last valid wins". A later, invalid/truncated fragment can never override an earlier valid
//     one (it simply fails to parse/validate and is skipped); a later, genuinely valid envelope
//     (e.g. the agent printed a corrected one) legitimately supersedes an earlier one in the SAME
//     scan window, mirroring how a human reading the same scrollback would resolve it.
//   - Nothing found/valid => `{ found: false }`. This is the ordinary, expected outcome for the
//     overwhelming majority of scanned output and must never be logged as an error.

import { z } from "zod";
import { redactSecrets } from "../terminal";
// NOTE: imports the side-effect-free src/exchanges/flagReader.ts, NOT src/exchanges/flag.ts — see
// that file's doc comment (importing flag.ts here would transitively trigger ITS eager
// `EXCHANGE_SPINE_MODE` read, a module-load-order hazard).
import { readEnumFlag } from "./flagReader";
import { COMPLETION_REQUEST_LINE } from "./instructionEnvelope";

// Re-exported purely for callers that want the ONE existing "please report completion" prompt
// string without a second import path — see the "request mode coherence" note below.
export { COMPLETION_REQUEST_LINE };

// ── flag: JANUS_AGENT_RESULT_ENVELOPE off | accept | request ───────────────────────────────────
//
// Mirrors the exact env-flag idiom already used twice in this subsystem (src/exchanges/flag.ts's
// JANUS_EXCHANGE_SPINE, src/exchanges/instructionEnvelope.ts's JANUS_INSTRUCTION_ENVELOPE): a
// plain module-level read, default "off", exported as a function so tests can pass an explicit env
// map instead of mutating `process.env`.
//
//   off (default) — this module never scans anything; `scanForResultEnvelope` short-circuits to
//                    `{ found: false }` before touching the input string at all.
//   accept        — scan + parse a well-formed envelope IF the agent happens to print one on its
//                    own initiative. Orbital does not ask for it.
//   request       — same scanning as "accept", PLUS a signal to callers that they may additionally
//                    invite the agent to report clearly. Request-mode coherence (this is the ONLY
//                    thing this file touches in instructionEnvelope.ts's territory, per the task's
//                    "COMPLETION_REQUEST_LINE coherence only" constraint): "request" mode does NOT
//                    mint a second, competing prompt string that asks for JSON specifically. It
//                    reuses the ALREADY-EXISTING, already-wired `COMPLETION_REQUEST_LINE` ("When
//                    you finish, report completion clearly (e.g. a final line stating done or
//                    blocked, and why).") as the one invitation an adapter appends when
//                    `RenderProfile.requestCompletionEnvelope` is true (instructionEnvelope.ts
//                    §6.2). A terminal agent that happens to be trained to answer such a prompt
//                    with a machine-readable line gets picked up by the scanner above; one that
//                    answers in plain prose instead is picked up by the conservative legacy
//                    finalResponse heuristic in src/observe/index.ts. Both funnel into the exact
//                    same trust boundary and settlement path (ExchangeService.recordReportedOutcome)
//                    — "request" changes nothing about HOW a report is validated, only that callers
//                    are told it is worth inviting one.
export type ResultEnvelopeMode = "off" | "accept" | "request";

const RESULT_ENVELOPE_MODES: readonly ResultEnvelopeMode[] = ["off", "accept", "request"];

/** Shared reader (src/exchanges/flag.ts's `readEnumFlag`) — see that module's "FLAG LATTICE" doc
 *  comment for how this flag relates to `JANUS_EXCHANGE_SPINE`. */
export function readResultEnvelopeMode(env: NodeJS.ProcessEnv = process.env): ResultEnvelopeMode {
  return readEnumFlag("JANUS_AGENT_RESULT_ENVELOPE", RESULT_ENVELOPE_MODES, "off", env);
}

/** Cached at module load (the established env-flag idiom) — one process, one mode. */
export const RESULT_ENVELOPE_MODE: ResultEnvelopeMode = readResultEnvelopeMode();

/**
 * `"request"` is an ACCEPTED ALIAS of `"accept"` for every scanning purpose below —
 * `resultEnvelopeActive` treats them identically (both enable `scanForResultEnvelope`); the ONLY
 * behavioral difference the two modes carry anywhere in this codebase is the "request mode
 * coherence" note above (a caller MAY additionally invite a completion report via the
 * already-existing `COMPLETION_REQUEST_LINE` when the mode is `"request"`). No parsing/validation/
 * redaction rule below ever branches on which of the two is active.
 */
export function resultEnvelopeActive(mode: ResultEnvelopeMode = RESULT_ENVELOPE_MODE): boolean {
  return mode === "accept" || mode === "request";
}

// ── schema (zod .strict(): untrusted input, unknown keys and bad enums are REJECTED) ───────────

const MAX_EXCHANGE_ID_CHARS = 128;
const MAX_SUMMARY_CHARS = 2000;
const MAX_EVIDENCE_ITEM_CHARS = 500;
const MAX_EVIDENCE_ITEMS = 20;
/** A single candidate substring longer than this is skipped WITHOUT attempting JSON.parse — a
 *  size cap independent of (and tighter than) the overall scan window, so one pathological
 *  candidate can't dominate the parse budget. */
const MAX_CANDIDATE_CHARS = 8192;
/** The tail-anchored scan window (spec's "last-N-KB JSON extraction"). */
const DEFAULT_MAX_SCAN_CHARS = 8192;
/** Bounded candidate count per scan — caps worst-case work on adversarial input. */
const DEFAULT_MAX_CANDIDATES = 25;

const RawResultEnvelopeSchema = z
  .object({
    exchange_id: z.string().trim().min(1).max(MAX_EXCHANGE_ID_CHARS),
    status: z.enum(["complete", "failed", "needs_input"]),
    summary: z.string().max(MAX_SUMMARY_CHARS).optional().default(""),
    evidence: z.array(z.string().max(MAX_EVIDENCE_ITEM_CHARS)).max(MAX_EVIDENCE_ITEMS).optional().default([]),
    needs_operator: z.boolean().optional().default(false),
  })
  .strict();

export type ResultEnvelopeStatus = z.infer<typeof RawResultEnvelopeSchema>["status"];

/** The fully-validated, ALREADY-REDACTED-AND-CAPPED shape callers receive. `redactedEnvelopeJson`
 *  is the safe-to-persist JSON string (built from the redacted fields, not the raw candidate —
 *  the raw candidate text is never retained past this function). */
export interface ParsedResultEnvelope {
  exchangeId: string;
  status: ResultEnvelopeStatus;
  summary: string;
  evidence: string[];
  needsOperator: boolean;
  redactedEnvelopeJson: string;
}

export interface ScanOptions {
  mode?: ResultEnvelopeMode;
  maxScanChars?: number;
  maxCandidates?: number;
  /** Injectable for tests; defaults to the one production scrubber. */
  redact?: (s: string) => string;
}

export interface ScanResult {
  found: boolean;
  envelope?: ParsedResultEnvelope;
  /** How many candidate `{...}` substrings the scan extracted (parseable or not) — observability
   *  only, never used for control flow by callers. */
  candidatesSeen: number;
  /** How many of those candidates both parsed and validated (0 or 1+ — "last valid wins" means
   *  only the LAST is returned, but earlier valid-then-superseded ones still count here). */
  candidatesValid: number;
}

function capString(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Bounded, string/escape-aware brace-matching scan for top-level `{...}` object substrings.
 * Linear in `text.length` (single left-to-right pass, no backtracking) — NOT a regex, so it
 * carries no ReDoS surface regardless of input shape. An unbalanced trailing `{` (the window cut
 * an object in half) stops the scan at that point rather than guessing where it would have closed.
 */
function findJsonObjectCandidates(text: string, maxCandidates: number): string[] {
  const candidates: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n && candidates.length < maxCandidates) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    const end = scanBalancedObject(text, start);
    if (end === -1) break; // truncated/unbalanced — never guess, stop scanning further.
    candidates.push(text.slice(start, end));
    i = end;
  }
  return candidates;
}

interface BraceScanState {
  depth: number;
  inString: boolean;
  escape: boolean;
}

/** Mutates `state` IN PLACE for one character while inside a string (escape handling, closing
 *  quote) — split out of `scanBalancedObject` purely to keep its own cognitive complexity under
 *  the gate. ONE `state` object is allocated for the whole scan (in `scanBalancedObject`) and
 *  mutated here every call — NOT a fresh `{...state}` copy per character (the prior
 *  stepBraceScan/stepInStringScan split's approach), which was real per-char allocation pressure
 *  on a linear scan that runs over every pane-output flush. */
function applyInStringChar(state: BraceScanState, ch: string): void {
  if (state.escape) state.escape = false;
  else if (ch === "\\") state.escape = true;
  else if (ch === '"') state.inString = false;
}

/**
 * From an opening `{` at `start`, walk forward tracking brace depth and string/escape state.
 * Returns the index just past the matching `}`, or -1 if the object never closes within `text`.
 */
function scanBalancedObject(text: string, start: number): number {
  const state: BraceScanState = { depth: 0, inString: false, escape: false };
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (state.inString) { applyInStringChar(state, ch); continue; }
    if (ch === '"') { state.inString = true; continue; }
    if (ch === "{") { state.depth++; continue; }
    if (ch === "}") {
      state.depth--;
      if (state.depth === 0) return j + 1;
    }
  }
  return -1;
}

/** Validate + redact + cap ONE candidate substring. Returns null on ANY failure (parse error,
 *  schema rejection, oversize) — every failure mode is equally "not a valid envelope", per the
 *  fail-safe detection contract; callers never distinguish "malformed" from "not present". */
function tryParseCandidate(candidate: string, redact: (s: string) => string): ParsedResultEnvelope | null {
  if (candidate.length > MAX_CANDIDATE_CHARS) return null;
  // Cheap prefilter: a valid envelope's schema REQUIRES exchange_id, so a candidate substring that
  // doesn't even mention the key can never validate — skip the JSON.parse + schema round-trip.
  if (!candidate.includes('"exchange_id"')) return null;
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return null;
  }
  const result = RawResultEnvelopeSchema.safeParse(json);
  if (!result.success) return null;
  const v = result.data;
  const summary = capString(redact(v.summary), MAX_SUMMARY_CHARS);
  const evidence = v.evidence
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((e) => capString(redact(e), MAX_EVIDENCE_ITEM_CHARS));
  const exchangeId = v.exchange_id;
  return {
    exchangeId,
    status: v.status,
    summary,
    evidence,
    needsOperator: v.needs_operator,
    redactedEnvelopeJson: JSON.stringify({
      exchange_id: exchangeId,
      status: v.status,
      summary,
      evidence,
      needs_operator: v.needs_operator,
    }),
  };
}

interface ResolvedScanOptions {
  mode: ResultEnvelopeMode;
  maxScanChars: number;
  maxCandidates: number;
  redact: (s: string) => string;
}

/** Apply every `ScanOptions` default in one place — split out purely so `scanForResultEnvelope`
 *  itself stays a flat, low-branch orchestrator (complexity gate). */
function resolveScanOptions(opts: ScanOptions): ResolvedScanOptions {
  return {
    mode: opts.mode ?? RESULT_ENVELOPE_MODE,
    maxScanChars: opts.maxScanChars ?? DEFAULT_MAX_SCAN_CHARS,
    maxCandidates: opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
    redact: opts.redact ?? redactSecrets,
  };
}

/** The tail-anchored scan window (detection contract: "the LAST `maxScanChars` characters"). */
function tailWindow(text: string, maxScanChars: number): string {
  return text.length > maxScanChars ? text.slice(-maxScanChars) : text;
}

/** "Last valid wins" (detection contract): walk every candidate in appearance order, keeping the
 *  most recent one that both parses and validates. */
function pickLastValidCandidate(
  candidates: readonly string[],
  redact: (s: string) => string,
): { best?: ParsedResultEnvelope; validCount: number } {
  let best: ParsedResultEnvelope | undefined;
  let validCount = 0;
  for (const candidate of candidates) {
    const parsed = tryParseCandidate(candidate, redact);
    if (parsed) {
      best = parsed;
      validCount++;
    }
  }
  return { best, validCount };
}

/**
 * Scan `text` for an agent result envelope per the DETECTION CONTRACT documented at the top of
 * this file. Pure, synchronous, never throws. `mode: "off"` (or the module default when unset)
 * short-circuits before even slicing the input.
 *
 * NOTE (trust boundary, repeated from the module doc): a `found: true` result here means "a
 * well-formed envelope was decoded", nothing more. The caller MUST still check `envelope.exchangeId`
 * against the pane's own active delivery marker before applying anything — this function has no
 * pane/exchange context to do that itself.
 */
export function scanForResultEnvelope(text: string, opts: ScanOptions = {}): ScanResult {
  const { mode, maxScanChars, maxCandidates, redact } = resolveScanOptions(opts);
  if (!resultEnvelopeActive(mode) || !text) {
    return { found: false, candidatesSeen: 0, candidatesValid: 0 };
  }
  const window = tailWindow(text, maxScanChars);
  // Cheap whole-window prefilter: every valid envelope's schema REQUIRES exchange_id, so a window
  // that never mentions the key can never contain one — skip the brace-matching scan entirely for
  // the (overwhelmingly common) case of ordinary pane output with no envelope in it at all.
  if (!window.includes('"exchange_id"')) {
    return { found: false, candidatesSeen: 0, candidatesValid: 0 };
  }
  const candidates = findJsonObjectCandidates(window, maxCandidates);
  const { best, validCount } = pickLastValidCandidate(candidates, redact);
  return { found: best !== undefined, envelope: best, candidatesSeen: candidates.length, candidatesValid: validCount };
}
