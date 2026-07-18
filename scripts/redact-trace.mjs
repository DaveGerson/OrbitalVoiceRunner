#!/usr/bin/env node
// scripts/redact-trace.mjs — BEAD wsm-e2e-pinned-arkr deliverable 5: operator-facing redaction tool
// for raw Gemini Live capture traces (.janus_traces/*.jsonl, written when
// JANUS_CAPTURE_LIVE_TRACES=1 — see src/voice/liveTraceCapture.ts).
//
// WHY THIS EXISTS: a raw capture records the UNREDACTED LiveServerMessage envelope verbatim —
// operator speech, model speech, tool args, all of it. `.janus_traces/` is gitignored specifically
// so a raw capture is NEVER committed directly. This script is the ONLY sanctioned path from a raw
// capture to something a human can review and then commit: it masks CANDIDATE secrets/PII in TEXT
// (string) fields, leaves every non-string (structural: ts, seq, booleans, counts) field and all
// JSON structure/key-order/line-cadence byte-identical, and prints a MANDATORY review summary
// (every masked span + every string that matched NOTHING) so a human — not the heuristic — makes
// the final call before anything is committed. See docs/process/LIVE_TRACE_CAPTURE.md for the full
// operator workflow (capture -> redact -> review -> commit).
//
// The masking rules are HEURISTIC, not exhaustive — that is exactly why the review step is
// "mandatory", not decorative. Never treat `*.redacted.jsonl` as safe without reading the summary.
//
// CLI: node scripts/redact-trace.mjs <path/to/trace.jsonl>
//      writes <path/to/trace.redacted.jsonl> next to it, prints the review summary to stdout.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Masking rules — ORDER MATTERS. Specific, structured patterns (JWT/AWS/Google/GitHub/Slack/PEM/
// email) run BEFORE the generic catch-alls (credential assignment, long digit runs) so a specific
// match is fully consumed (replaced by a `[REDACTED-<kind>]` placeholder, which contains no digits
// or `@`/key-shaped substrings) before the generic rules get a chance to mis-tag a fragment of it. ──
const RULES = [
  { kind: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // A free-text "name-that-looks-like-a-credential = high-entropy value" assignment. Masks the
  // WHOLE match (key AND value) — unlike the structured rules above we cannot safely assume a
  // user-authored key name is itself safe to keep.
  { kind: "credential", re: /\b[A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|password|passwd)[A-Za-z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{8,}["']?/gi },
  // Long digit runs (phone numbers, card numbers, SSNs, account numbers, raw epoch-ms leaking into
  // spoken text, …). 9+ consecutive digits: long enough to leave small counts/ids alone, short
  // enough to still catch a 9-digit SSN.
  { kind: "digits", re: /\b\d{9,}\b/g },
];

/**
 * Pure: mask candidate secrets/PII in one string. Returns the masked string plus every matched
 * span (kind + the ORIGINAL matched text, for the mandatory review summary). Never throws — a
 * non-string input is returned unmodified with no spans.
 */
export function maskText(text) {
  if (typeof text !== "string" || text.length === 0) return { masked: text, spans: [] };
  const spans = [];
  let masked = text;
  for (const rule of RULES) {
    masked = masked.replace(rule.re, (match) => {
      spans.push({ kind: rule.kind, original: match });
      return `[REDACTED-${rule.kind}]`;
    });
  }
  return { masked, spans };
}

function joinPath(prefix, key) {
  if (prefix === "") return String(key);
  return typeof key === "number" ? `${prefix}[${key}]` : `${prefix}.${key}`;
}

/**
 * Pure: recursively walk a parsed JSON value, masking every string leaf via maskText(). Non-string
 * leaves (numbers, booleans, null) and ALL structure (object key order, array order/length) pass
 * through byte-identical. Returns the redacted value plus flat, path-annotated lists of every
 * masked span and every non-empty string leaf that matched NOTHING — both feed the review summary.
 */
export function redactValue(value, pathPrefix = "") {
  const spans = [];
  const unmasked = [];

  const walk = (v, p) => {
    if (typeof v === "string") {
      const { masked, spans: hits } = maskText(v);
      if (hits.length > 0) {
        for (const span of hits) spans.push({ path: p, ...span });
      } else if (v.trim().length > 0) {
        unmasked.push({ path: p, text: v });
      }
      return masked;
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, joinPath(p, i)));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k], joinPath(p, k));
      return out;
    }
    return v; // number / boolean / null / undefined — untouched.
  };

  const redacted = walk(value, pathPrefix);
  return { redacted, spans, unmasked };
}

/** Redact one already-parsed trace line ({ts, seq, message, ...}). Numeric ts/seq pass through
 *  redactValue untouched automatically (they are not strings); only string leaves are visited. */
export function redactTraceLine(line, lineNo) {
  const { redacted, spans, unmasked } = redactValue(line, "");
  return {
    redacted,
    spans: spans.map((s) => ({ ...s, line: lineNo })),
    unmasked: unmasked.map((u) => ({ ...u, line: lineNo })),
  };
}

/**
 * Redact a full raw trace file's text (one JSON object per line). Blank lines and malformed
 * (non-JSON) lines pass through byte-identical — never dropped, never crash the tool. Preserves
 * line COUNT and line ORDER exactly (structure/cadence), only rewriting the JSON lines' text
 * fields.
 */
export function redactTraceText(rawText) {
  const lines = rawText.split(/\r?\n/);
  const outLines = [];
  const allSpans = [];
  const allUnmasked = [];
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (line.trim().length === 0) { outLines.push(line); return; }
    let parsed;
    try { parsed = JSON.parse(line); } catch {
      // Not JSON — pass through untouched rather than blindly masking raw text with no path/
      // structure info (a malformed line was never one of our minted {ts,seq,message} records).
      outLines.push(line);
      return;
    }
    const { redacted, spans, unmasked } = redactTraceLine(parsed, lineNo);
    outLines.push(JSON.stringify(redacted));
    allSpans.push(...spans);
    allUnmasked.push(...unmasked);
  });
  return { text: outLines.join("\n"), spans: allSpans, unmasked: allUnmasked };
}

/** `<name>.jsonl` -> `<name>.redacted.jsonl` (any other/no extension -> `<name>.redacted.jsonl` too,
 *  since a trace file with no `.jsonl` suffix should still land as `.jsonl`). */
export function redactedPathFor(inputPath) {
  const ext = path.extname(inputPath);
  const base = ext ? inputPath.slice(0, inputPath.length - ext.length) : inputPath;
  return `${base}.redacted.jsonl`;
}

function printReviewSummary(inputPath, outputPath, spans, unmasked) {
  console.log(`\n=== MANDATORY REVIEW before committing ${outputPath} ===`);
  console.log(`Source (raw, NEVER commit): ${inputPath}`);
  console.log(`Redacted output:            ${outputPath}`);
  console.log(`\n-- ${spans.length} masked span(s) --`);
  if (spans.length === 0) console.log("(none)");
  for (const s of spans) {
    console.log(`  line ${s.line} [${s.kind}] ${s.path}: "${s.original}" -> [REDACTED-${s.kind}]`);
  }
  console.log(`\n-- ${unmasked.length} unmasked text field(s) (eyeball these too — the rules are heuristic, not exhaustive) --`);
  if (unmasked.length === 0) console.log("(none)");
  for (const u of unmasked) {
    console.log(`  line ${u.line} ${u.path}: "${u.text}"`);
  }
  console.log(`\nReview BOTH lists above. If — and only if — everything looks safe, commit ONLY`);
  console.log(`${path.basename(outputPath)} — never the raw source file.\n`);
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node scripts/redact-trace.mjs <path/to/trace.jsonl>");
    process.exitCode = 1;
    return;
  }
  const resolved = path.resolve(inputPath);
  const raw = fs.readFileSync(resolved, "utf8");
  const { text, spans, unmasked } = redactTraceText(raw);
  const outputPath = redactedPathFor(resolved);
  fs.writeFileSync(outputPath, text);
  printReviewSummary(resolved, outputPath, spans, unmasked);
}

// Run main() only when invoked directly, not when imported by the test (mirrors scripts/run-unit.mjs).
const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
