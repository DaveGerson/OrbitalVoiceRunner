// tests/test_instruction_envelope.ts
//
// InstructionEnvelope — RED-FIRST contract suite (Phase 3, step 3.1; spec
// docs/superpowers/specs/2026-07-09-instruction-routing.md §1-§2, §5-§6).
//
// This suite imports `../src/exchanges/instructionEnvelope`, which DOES NOT EXIST YET — the suite
// must fail (ERR_MODULE_NOT_FOUND) until step 3.3 implements it. It is the executable contract:
//   - the deterministic readiness predicate: target + objective REQUIRED, fixed priority order
//     (target first), exactly ONE targeted clarification per unready check; optional fields
//     (relevant_context / constraints / requested_output / completion_signal) NEVER gate
//     readiness and are NEVER asked for (spec §2);
//   - envelope build from operator-language pieces: normalization only, NEVER fabrication —
//     absent optionals stay empty/null (spec §1, anti-fabrication invariant);
//   - deterministic rendering: same (envelope, profile) -> byte-identical prose; renderer output
//     contains ONLY operator-provided content plus the fixed section labels (spec §6.2);
//   - profiles control FORMATTING ONLY (heading style / completion-envelope request / escapes /
//     line endings / submit sequence / max size) — never target, gates, or exchange state;
//   - draft-version bump on revise (mirrors the exchange spine's §3 rule);
//   - idempotent send per draft version (a repeat send of the same version is a refused no-op).
//
// Contract expected from src/exchanges/instructionEnvelope (pure, no I/O — the src/templates.ts
// posture):
//   export interface InstructionEnvelope {
//     objective: string;
//     relevant_context: string[];
//     constraints: string[];
//     requested_output: string | null;
//     completion_signal: string | null;
//     operator_language: string;
//   }
//   export interface EnvelopeTarget { projectId: string; paneId: string; }
//   export interface EnvelopeDraft {
//     exchangeId: string;
//     target: EnvelopeTarget | null;
//     envelope: InstructionEnvelope;
//     draftVersion: number;                 // starts at 1
//     sentVersions: readonly number[];      // versions already sent (send idempotency key)
//   }
//   export type ReadinessResult =
//     | { ready: true }
//     | { ready: false; missing: "target" | "objective"; clarification: string };
//   export function assessReadiness(draft: EnvelopeDraft): ReadinessResult;
//   export function buildEnvelope(input: {
//     objective?: string;
//     relevantContext?: string[];
//     constraints?: string[];
//     requestedOutput?: string | null;
//     completionSignal?: string | null;
//     operatorLanguage?: string;            // defaults to "en"
//   }): InstructionEnvelope;                // trims, drops empty strings, preserves order,
//                                           // NEVER invents content
//   export function createDraft(input: {
//     exchangeId?: string;
//     target?: EnvelopeTarget | null;
//     envelope: InstructionEnvelope;
//   }): EnvelopeDraft;                      // draftVersion 1, sentVersions []
//   export function reviseDraft(draft: EnvelopeDraft, patch: {
//     objective?: string;
//     relevantContext?: string[];
//     constraints?: string[];
//     requestedOutput?: string | null;
//     completionSignal?: string | null;
//     target?: EnvelopeTarget | null;
//   }): EnvelopeDraft;                      // PURE: returns a new draft, draftVersion+1
//   export function recordSend(draft: EnvelopeDraft):
//     | { ok: true; draft: EnvelopeDraft }  // sentVersions now includes draftVersion
//     | { ok: false; reason: "duplicate_version" | "not_ready" };
//   export type RenderPreset = "Claude Code" | "Codex" | "Antigravity" | "Custom";
//   export interface RenderProfile {
//     preset: RenderPreset;
//     headingStyle: "plain" | "markdown";
//     requestCompletionEnvelope: boolean;
//     escapeStyle: "strip-control";
//     eol: "\n" | "\r\n";
//     submitSequence: "enter";
//     maxChars: number;
//   }
//   export const RENDER_PROFILES: Record<RenderPreset, RenderProfile>;
//   export const COMPLETION_REQUEST_LINE: string;  // the ONE fixed protocol line appended when
//                                                  // requestCompletionEnvelope is true
//   export function renderEnvelope(envelope: InstructionEnvelope, profile: RenderProfile): string;
//
// Rendering shape contract (plain style; spec §6.2): objective first; then, ONLY when non-empty,
// a "Context:" section of "- <item>" lines; then a "Constraints:" section likewise; then
// "Respond with: <requested_output>" when non-null; then "When done: <completion_signal>" when
// non-null. Empty sections are omitted ENTIRELY (label included). Markdown style uses
// "## Context" / "## Constraints" headings instead of the "Context:" / "Constraints:" labels.

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  assessReadiness,
  buildEnvelope,
  createDraft,
  reviseDraft,
  recordSend,
  renderEnvelope,
  RENDER_PROFILES,
  COMPLETION_REQUEST_LINE,
  type EnvelopeDraft,
  type InstructionEnvelope,
  type RenderProfile,
} from "../src/exchanges/instructionEnvelope";

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

const TARGET = { projectId: "proj-a", paneId: "pane-build" };

function minimalEnvelope(objective = "fix the login redirect loop"): InstructionEnvelope {
  return buildEnvelope({ objective, operatorLanguage: "en" });
}

function readyDraft(): EnvelopeDraft {
  return createDraft({ target: TARGET, envelope: minimalEnvelope() });
}

/** A plain, no-protocol-line profile: with requestCompletionEnvelope OFF the output must be
 *  100% operator content + fixed section labels. Custom is that profile per the spec's default
 *  table (§6.2); fall back to a hand-built plain profile if defaults change shape. */
function plainProfile(): RenderProfile {
  return { ...RENDER_PROFILES["Custom"], headingStyle: "plain", requestCompletionEnvelope: false, eol: "\n" };
}

// ── §2.2 readiness predicate ────────────────────────────────────────────────────────────────────

describe("instructionEnvelope: readiness predicate (spec §2.2)", () => {
  it("missing target -> not ready, missing:'target', ONE clarification that asks about the pane", () => {
    const draft = createDraft({ target: null, envelope: minimalEnvelope() });
    const r = assessReadiness(draft);
    assert.strictEqual(r.ready, false);
    if (r.ready === false) {
      assert.strictEqual(r.missing, "target");
      assert.ok(r.clarification.length > 0, "clarification must be non-empty");
      assert.match(r.clarification, /pane|project|where|which/i, "target clarification asks WHERE the instruction goes");
    }
  });

  it("empty objective -> not ready, missing:'objective', clarification asks WHAT to do", () => {
    const draft = createDraft({ target: TARGET, envelope: buildEnvelope({ objective: "", operatorLanguage: "en" }) });
    const r = assessReadiness(draft);
    assert.strictEqual(r.ready, false);
    if (r.ready === false) {
      assert.strictEqual(r.missing, "objective");
      assert.match(r.clarification, /what|objective|do/i);
    }
  });

  it("whitespace-only objective is treated as missing (the .trim() gate idiom)", () => {
    const draft = createDraft({ target: TARGET, envelope: buildEnvelope({ objective: "   \n\t ", operatorLanguage: "en" }) });
    const r = assessReadiness(draft);
    assert.strictEqual(r.ready, false);
    if (r.ready === false) assert.strictEqual(r.missing, "objective");
  });

  it("both missing -> asks target FIRST (fixed priority order, exactly one clarification)", () => {
    const draft = createDraft({ target: null, envelope: buildEnvelope({ objective: "", operatorLanguage: "en" }) });
    const r = assessReadiness(draft);
    assert.strictEqual(r.ready, false);
    if (r.ready === false) assert.strictEqual(r.missing, "target", "target outranks objective in the clarification order");
  });

  it("target + objective with EVERY optional field absent is READY (optionals never gate, never asked for)", () => {
    const env = buildEnvelope({ objective: "rename the settings tab", operatorLanguage: "en" });
    assert.deepStrictEqual(env.relevant_context, []);
    assert.deepStrictEqual(env.constraints, []);
    assert.strictEqual(env.requested_output, null);
    assert.strictEqual(env.completion_signal, null);
    const r = assessReadiness(createDraft({ target: TARGET, envelope: env }));
    assert.deepStrictEqual(r, { ready: true });
  });

  it("readiness is deterministic — same draft assessed twice gives deep-equal results", () => {
    const draft = createDraft({ target: null, envelope: minimalEnvelope() });
    assert.deepStrictEqual(assessReadiness(draft), assessReadiness(draft));
  });
});

// ── §1 envelope build (normalization, never fabrication) ───────────────────────────────────────

describe("instructionEnvelope: buildEnvelope from operator language (spec §1)", () => {
  it("minimal build: empty-array/null defaults for everything the operator did not say", () => {
    const env = buildEnvelope({ objective: "add a dark theme toggle", operatorLanguage: "en" });
    assert.strictEqual(env.objective, "add a dark theme toggle");
    assert.deepStrictEqual(env.relevant_context, []);
    assert.deepStrictEqual(env.constraints, []);
    assert.strictEqual(env.requested_output, null);
    assert.strictEqual(env.completion_signal, null);
    assert.strictEqual(env.operator_language, "en");
  });

  it("provided fields are preserved verbatim and in order (normalization only, no rewriting)", () => {
    const env = buildEnvelope({
      objective: "  speed up the boot sequence  ",
      relevantContext: ["the operator saw a 9s boot yesterday", "panes boot inert"],
      constraints: ["do not touch the migration code", "keep the current flag default"],
      requestedOutput: "a one-line summary of what changed",
      completionSignal: "say BOOT-DONE when finished",
      operatorLanguage: "en",
    });
    assert.strictEqual(env.objective, "speed up the boot sequence", "objective is trimmed, otherwise verbatim");
    assert.deepStrictEqual(env.relevant_context, ["the operator saw a 9s boot yesterday", "panes boot inert"]);
    assert.deepStrictEqual(env.constraints, ["do not touch the migration code", "keep the current flag default"]);
    assert.strictEqual(env.requested_output, "a one-line summary of what changed");
    assert.strictEqual(env.completion_signal, "say BOOT-DONE when finished");
  });

  it("empty-string items are dropped, never kept and never replaced with invented content", () => {
    const env = buildEnvelope({
      objective: "fix the flaky earcon",
      relevantContext: ["", "  ", "it only happens on reconnect"],
      constraints: ["", "   "],
      operatorLanguage: "en",
    });
    assert.deepStrictEqual(env.relevant_context, ["it only happens on reconnect"]);
    assert.deepStrictEqual(env.constraints, [], "all-blank constraints collapse to [] — absence is valid, not a gap to fill");
  });

  it("operator_language defaults when unstated and never gates anything", () => {
    const env = buildEnvelope({ objective: "x" });
    assert.strictEqual(typeof env.operator_language, "string");
    assert.ok(env.operator_language.length > 0);
  });
});

// ── §6 deterministic rendering ──────────────────────────────────────────────────────────────────

describe("instructionEnvelope: deterministic rendering (spec §6.2)", () => {
  const RICH = buildEnvelope({
    objective: "make the login flow remember the last-used account",
    relevantContext: ["the operator mentioned users complain about re-typing emails", "staging showed the same behavior"],
    constraints: ["do not change the password rules"],
    requestedOutput: "tell me which files you touched",
    completionSignal: "say LOGIN-MEMORY-DONE",
    operatorLanguage: "en",
  });

  it("same envelope + same profile -> byte-identical prose", () => {
    const p = plainProfile();
    assert.strictEqual(renderEnvelope(RICH, p), renderEnvelope(RICH, p));
    const m = { ...RENDER_PROFILES["Claude Code"] };
    assert.strictEqual(renderEnvelope(RICH, m), renderEnvelope(RICH, m));
  });

  it("output contains ONLY operator-provided content plus fixed section labels (no fabrication)", () => {
    const text = renderEnvelope(RICH, plainProfile());
    const operatorContent = [
      RICH.objective,
      ...RICH.relevant_context,
      ...RICH.constraints,
      RICH.requested_output as string,
      RICH.completion_signal as string,
    ];
    const FIXED_LABELS = /^(Context:|Constraints:|-\s|Respond with:|When done:)/;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const isOperatorContent = operatorContent.some((c) => trimmed.includes(c));
      const isLabeledOperatorLine = FIXED_LABELS.test(trimmed) && (
        operatorContent.some((c) => trimmed.includes(c)) || /^(Context:|Constraints:)$/.test(trimmed)
      );
      assert.ok(
        isOperatorContent || isLabeledOperatorLine,
        `renderer fabricated a line the operator never said: ${JSON.stringify(line)}`
      );
    }
    // And it must never smuggle in classic fabricated-requirement vocabulary the operator did not use.
    for (const invented of ["unit test", "acceptance criteria", "refactor", "TypeScript"]) {
      assert.ok(!text.toLowerCase().includes(invented.toLowerCase()), `fabricated requirement: ${invented}`);
    }
  });

  it("empty optional sections are omitted ENTIRELY — labels included", () => {
    const bare = minimalEnvelope("just the objective");
    const text = renderEnvelope(bare, plainProfile());
    assert.ok(text.includes("just the objective"));
    assert.ok(!/Context:/.test(text), "no Context section for an empty relevant_context");
    assert.ok(!/Constraints:/.test(text), "no Constraints section for empty constraints");
    assert.ok(!/Respond with:/.test(text), "no requested-output line for null requested_output");
    assert.ok(!/When done:/.test(text), "no completion line for null completion_signal");
  });

  it("eol knob is honored: a \\r\\n profile emits CRLF, a \\n profile emits no CR at all", () => {
    const lf = renderEnvelope(RICH, { ...plainProfile(), eol: "\n" });
    const crlf = renderEnvelope(RICH, { ...plainProfile(), eol: "\r\n" });
    assert.ok(!lf.includes("\r"), "LF profile output must contain no carriage returns");
    assert.ok(crlf.includes("\r\n"), "CRLF profile output must use CRLF line endings");
  });

  it("requestCompletionEnvelope appends EXACTLY the one fixed protocol constant (and nothing else)", () => {
    const off = renderEnvelope(RICH, { ...plainProfile(), requestCompletionEnvelope: false });
    const on = renderEnvelope(RICH, { ...plainProfile(), requestCompletionEnvelope: true });
    assert.ok(!off.includes(COMPLETION_REQUEST_LINE));
    assert.ok(on.includes(COMPLETION_REQUEST_LINE));
    const extra = on.replace(off, "");
    assert.ok(
      extra.trim() === COMPLETION_REQUEST_LINE.trim(),
      "the ONLY non-operator addition permitted is the fixed completion-request line"
    );
  });

  it("profiles exist for all four presets and control FORMATTING ONLY (no target/gate/exchange keys)", () => {
    const ALLOWED = new Set([
      "preset", "headingStyle", "requestCompletionEnvelope", "escapeStyle", "eol", "submitSequence", "maxChars",
    ]);
    for (const preset of ["Claude Code", "Codex", "Antigravity", "Custom"] as const) {
      const profile = RENDER_PROFILES[preset];
      assert.ok(profile, `missing RenderProfile for ${preset}`);
      assert.strictEqual(profile.preset, preset);
      for (const key of Object.keys(profile)) {
        assert.ok(ALLOWED.has(key), `RenderProfile['${preset}'] carries a non-formatting key: ${key}`);
      }
      assert.strictEqual(typeof profile.maxChars, "number");
      assert.ok(profile.maxChars > 0);
    }
  });
});

// ── §5 draft versioning ─────────────────────────────────────────────────────────────────────────

describe("instructionEnvelope: draft versioning (spec §5, spine §3)", () => {
  it("createDraft starts at draftVersion 1 with no sent versions", () => {
    const d = readyDraft();
    assert.strictEqual(d.draftVersion, 1);
    assert.deepStrictEqual([...d.sentVersions], []);
  });

  it("revise bumps draftVersion and applies the patch (pure — the input draft is untouched)", () => {
    const d1 = readyDraft();
    const d2 = reviseDraft(d1, { objective: "fix the login redirect loop on Safari only" });
    assert.strictEqual(d2.draftVersion, 2);
    assert.strictEqual(d2.envelope.objective, "fix the login redirect loop on Safari only");
    assert.strictEqual(d1.draftVersion, 1, "reviseDraft must not mutate its input");
    assert.strictEqual(d1.envelope.objective, "fix the login redirect loop");
  });

  it("a retarget is a revision too: changing target bumps the version", () => {
    const d1 = readyDraft();
    const d2 = reviseDraft(d1, { target: { projectId: "proj-b", paneId: "pane-docs" } });
    assert.strictEqual(d2.draftVersion, 2);
    assert.deepStrictEqual(d2.target, { projectId: "proj-b", paneId: "pane-docs" });
  });
});

// ── §5.3 idempotent send per draft version ──────────────────────────────────────────────────────

describe("instructionEnvelope: idempotent send per draft version (spec §5.3, spine §2)", () => {
  it("sending a ready draft succeeds and records the version", () => {
    const r = recordSend(readyDraft());
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.deepStrictEqual([...r.draft.sentVersions], [1]);
  });

  it("re-sending the SAME version is a refused no-op (duplicate_version)", () => {
    const first = recordSend(readyDraft());
    assert.strictEqual(first.ok, true);
    if (first.ok) {
      const second = recordSend(first.draft);
      assert.deepStrictEqual(second, { ok: false, reason: "duplicate_version" });
    }
  });

  it("revise-then-send succeeds again at the NEW version", () => {
    const first = recordSend(readyDraft());
    assert.strictEqual(first.ok, true);
    if (first.ok) {
      const revised = reviseDraft(first.draft, { objective: "fix the login redirect loop, Safari first" });
      assert.strictEqual(revised.draftVersion, 2);
      const second = recordSend(revised);
      assert.strictEqual(second.ok, true);
      if (second.ok) assert.deepStrictEqual([...second.draft.sentVersions].sort(), [1, 2]);
    }
  });

  it("an unready draft refuses to send (not_ready) — readiness gates communication, not the capability gate", () => {
    const noTarget = createDraft({ target: null, envelope: minimalEnvelope() });
    assert.deepStrictEqual(recordSend(noTarget), { ok: false, reason: "not_ready" });
    const noObjective = createDraft({ target: TARGET, envelope: buildEnvelope({ objective: " ", operatorLanguage: "en" }) });
    assert.deepStrictEqual(recordSend(noObjective), { ok: false, reason: "not_ready" });
  });
});
