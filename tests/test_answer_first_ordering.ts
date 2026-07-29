// tests/test_answer_first_ordering.ts — bead wsm-e2e-pinned-fikj.8 (vc-F2): "answer-first ordering".
//
// BUG: once deferred background briefs (pane-signal news, memory-brief context) pile in, nothing
// stops the model opening a spoken turn with that background news instead of answering what the
// director just asked. Director-approved fix is BELT AND BRACES (Option C):
//
//   Leg A (prompt rule)   — DEFAULT_SYSTEM_PROMPT's "[7. VOICE OUTPUT RULES]" section gets a rule:
//                           answer the director's question FIRST; mention new/background context
//                           only after, and only if relevant or if it supersedes the current task.
//   Leg B (mechanical)    — passively-injected context text (pushSignal's pane-signal send AND the
//                           memory-brief send downstream of synthesizeAsync) is prefixed with a
//                           ONE-LINE "BACKGROUND — do not change subject..." preamble, applied by a
//                           PURE EXPORTED composition helper (no live session needed to unit-test
//                           it). It applies ONLY to passive (turnComplete:false) sends — forced
//                           spoken turns (pushAck, pushApprovalNarration; both turnComplete:true)
//                           must never carry it, and it must not double-apply on reinjection.
//
// This file is RED-phase only: `applyBackgroundFraming` does not exist yet in src/voice/index.ts,
// and DEFAULT_SYSTEM_PROMPT's section 7 does not yet carry the answer-first rule. Every test below
// is expected to FAIL until both legs are implemented.
//
// Content-invariant style for Leg A borrows the idiom from tests/test_system_prompt.ts (content
// invariants on the rendered DEFAULT, not a byte-identical pin) — but lives here per the workstream
// split, not in that file.
//
// Runner: npx tsx --test --test-force-exit tests/test_answer_first_ordering.ts

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemInstruction } from "../src/voice/systemPrompt";
// Namespace import (NOT a named import of the not-yet-existing helper): a static named import of a
// binding a module doesn't export is a hard module-link crash that would take down every test in
// this file before any of them run. The namespace object always resolves; the missing helper simply
// reads back as `undefined`, which each test below asserts on explicitly (a clean, diagnosable
// per-test failure — not a file-load crash).
import * as voiceIndexModule from "../src/voice/index";

// ── Leg A: the system-prompt rule ──────────────────────────────────────────────────────────────

const SAMPLE_ACTIVE_PROJECT_ID = "alpha-proj";
const SAMPLE_WORKSPACES = "alpha-proj (Alpha), beta-proj (Beta)";

/** Extract just the "[7. VOICE OUTPUT RULES]" section body so assertions can't accidentally match
 *  unrelated prose elsewhere in the prompt (e.g. section 4's "PROPOSE" or section 8's examples). */
function section7Of(rendered: string): string {
  const startIdx = rendered.indexOf("[7. VOICE OUTPUT RULES]");
  assert.ok(startIdx >= 0, "expected DEFAULT_SYSTEM_PROMPT to contain the '[7. VOICE OUTPUT RULES]' section header");
  const endIdx = rendered.indexOf("[8. EXAMPLES]", startIdx);
  assert.ok(endIdx >= 0, "expected DEFAULT_SYSTEM_PROMPT to contain the '[8. EXAMPLES]' section header after section 7");
  return rendered.slice(startIdx, endIdx);
}

test("[7. VOICE OUTPUT RULES] instructs the model to answer the director's question FIRST", () => {
  const rendered = buildSystemInstruction({
    activeProjectId: SAMPLE_ACTIVE_PROJECT_ID,
    workspaces: SAMPLE_WORKSPACES,
  });
  const section7 = section7Of(rendered);
  assert.ok(
    /answer[\s\S]{0,100}first/i.test(section7),
    "section 7 must contain a rule telling the model to answer the director's actual question FIRST " +
      "(current DEFAULT_SYSTEM_PROMPT section 7 has no such rule yet)",
  );
});

test("[7. VOICE OUTPUT RULES]'s answer-first rule only allows background/new context AFTER the answer, and only if relevant or superseding", () => {
  const rendered = buildSystemInstruction({
    activeProjectId: SAMPLE_ACTIVE_PROJECT_ID,
    workspaces: SAMPLE_WORKSPACES,
  });
  const section7 = section7Of(rendered);
  assert.ok(
    /background[\s\S]{0,150}(relevant|supersede)/i.test(section7),
    "section 7 must gate mentioning new/background context on it being relevant or superseding the " +
      "current task (current DEFAULT_SYSTEM_PROMPT section 7 never mentions 'background' at all)",
  );
});

// ── Leg B: the mechanical BACKGROUND-framing composition helper ───────────────────────────────

// Deliberately `any`-cast: the union/module doesn't have this member yet. Each test below asserts
// `typeof === "function"` FIRST as its own diagnosable failure, rather than letting a bare
// `undefined(...)` call crash the test with an opaque TypeError.
const applyBackgroundFraming = (voiceIndexModule as any).applyBackgroundFraming as
  | ((text: string, turnComplete: boolean) => string)
  | undefined;

test("applyBackgroundFraming is exported as a PURE composition helper from src/voice/index.ts", () => {
  assert.strictEqual(
    typeof applyBackgroundFraming,
    "function",
    "expected src/voice/index.ts to export a pure `applyBackgroundFraming(text, turnComplete)` helper " +
      "(repo idiom: pure + exported for unit coverage, like stampDeferred/resolveBriefPane in the same file) " +
      "so the BACKGROUND framing is unit-testable without a live Gemini session",
  );
});

test("prepends a ONE-LINE BACKGROUND preamble ahead of the text for a passive (turnComplete:false) send", () => {
  assert.strictEqual(typeof applyBackgroundFraming, "function", "applyBackgroundFraming must exist first");
  const raw = "Pane 2 just went idle after a 4-minute build.";
  const framed = applyBackgroundFraming!(raw, false);

  const newlineIdx = framed.indexOf("\n");
  assert.ok(newlineIdx > 0, "framed text must separate a preamble line from the body with a newline");
  const preambleLine = framed.slice(0, newlineIdx);
  const body = framed.slice(newlineIdx + 1);

  assert.ok(/^BACKGROUND\b/.test(preambleLine), "the preamble line must start with the 'BACKGROUND' label");
  assert.ok(/do not change subject/i.test(preambleLine), "the preamble must say not to change subject to it");
  // VERIFIER PATCH: the spec substance carries TWO exits — "unless asked" AND "or it supersedes
  // the current task". The original assertions only pinned the second.
  assert.ok(/ask/i.test(preambleLine), "the preamble must carve out the 'unless asked' exception (the director asking IS permission to change subject)");
  assert.ok(/supersedes the current task/i.test(preambleLine), "the preamble must carve out the 'supersedes the current task' exception");
  assert.strictEqual(body, raw, "the original passive text must follow the preamble completely unchanged");
});

test("the BACKGROUND preamble is a single compact line (it counts against the brief's 4.8k-char budget)", () => {
  assert.strictEqual(typeof applyBackgroundFraming, "function", "applyBackgroundFraming must exist first");
  const raw = "example passively-injected body text";
  const framed = applyBackgroundFraming!(raw, false);
  const newlineIdx = framed.indexOf("\n");
  assert.ok(newlineIdx > 0, "framed text must contain a newline separating the preamble from the body");
  const preambleLine = framed.slice(0, newlineIdx);
  assert.ok(!preambleLine.includes("\n"), "the preamble itself must not embed a second newline (ONE line)");
  assert.ok(
    preambleLine.length > 0 && preambleLine.length <= 120,
    `the preamble should be short (<=120 chars) to protect the 4.8k-char brief budget; got ${preambleLine.length} chars`,
  );
});

test("does NOT alter the text when turnComplete is true (operator turns / forced spoken turns)", () => {
  assert.strictEqual(typeof applyBackgroundFraming, "function", "applyBackgroundFraming must exist first");
  const raw = "Opening the pane now.";
  const result = applyBackgroundFraming!(raw, true);
  assert.strictEqual(
    result,
    raw,
    "turnComplete:true sends (operator-authored turns, forced spoken acks/narrations) must come back BYTE-IDENTICAL — no BACKGROUND preamble",
  );
});

test("is idempotent — re-applying the framing to already-framed text does not double the preamble", () => {
  assert.strictEqual(typeof applyBackgroundFraming, "function", "applyBackgroundFraming must exist first");
  const raw = "pane 3 finished: agent_complete";
  const once = applyBackgroundFraming!(raw, false);
  const twice = applyBackgroundFraming!(once, false);
  assert.strictEqual(
    twice,
    once,
    "a text that passes through the framing helper twice (e.g. re-narrated/re-injected) must not accumulate a second BACKGROUND preamble",
  );
  const occurrences = (twice.match(/^BACKGROUND\b/gm) ?? []).length;
  assert.strictEqual(occurrences, 1, `expected exactly one BACKGROUND preamble line, found ${occurrences}`);
});

// ── Leg B wiring: the two real send sites, verified by source inspection ──────────────────────
//
// pushSignal and the memory-brief `sendClientContent` call are closures with no live-session-free
// entry point (confirming the task's own instruction that the helper itself, not these closures, is
// the unit under test). We still pin that the ACTUAL call sites the model reads from are wired to
// the helper, via content-anchored source slices (the same technique tests/test_import_hygiene.ts
// and tests/test_pane_signal_bus.ts already use in this suite) — anchored on stable code strings,
// not line numbers, so a few lines of drift elsewhere in this ~3,200-line file doesn't false-fail.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const voiceIndexSource = fs.readFileSync(path.join(repoRoot, "src", "voice", "index.ts"), "utf8");

function sliceBetween(content: string, startMarker: string, endMarker: string): string {
  const startIdx = content.indexOf(startMarker);
  assert.ok(startIdx >= 0, `expected to find anchor ${JSON.stringify(startMarker)} in src/voice/index.ts`);
  const endIdx = content.indexOf(endMarker, startIdx + startMarker.length);
  assert.ok(endIdx >= 0, `expected to find anchor ${JSON.stringify(endMarker)} after the start anchor in src/voice/index.ts`);
  return content.slice(startIdx, endIdx);
}

// Anchors verified against src/voice/index.ts at commit e595db2 (re-verified this session).
const PUSH_SIGNAL_START = "const pushSignal = (sig: PaneSignal) => {";
const PUSH_SIGNAL_END = "const armReadyDrain = () => {";

const MEMORY_BRIEF_START = "brief = await memory.service.synthesizeAsync(";
const MEMORY_BRIEF_END = "// PLM4 (2): AUTO-RECONNECT";

const PUSH_ACK_START = "function pushAck(session: any, text: string): void {";
const PUSH_ACK_END = "function applyDraftEditFrame(";

const PUSH_APPROVAL_START = "export function pushApprovalNarration(session: any, text: string): boolean {";
const PUSH_APPROVAL_END = "// ── 3V.2: WS keepalive";

// VERIFIER PATCH (both wiring tests): calling the helper with a literal `true` second argument is
// a NO-OP by the helper's own contract — a lazy implementation could "wire" both sites that way,
// pass a bare `includes("applyBackgroundFraming(")` check, and change nothing. Both passive sites
// must classify themselves passive (the helper's boolean is the CALLER's passive/forced
// classification — see the file-header note; it is deliberately decoupled from whatever literal
// `turnComplete` the site ultimately passes to Gemini's sendClientContent).
const NOOP_FRAMING_CALL_RE = /applyBackgroundFraming\([^)]*,\s*true\s*\)/;

test("pushSignal (pane-signal passive send, :2384-2396, turnComplete:false) applies the BACKGROUND framing helper", () => {
  const slice = sliceBetween(voiceIndexSource, PUSH_SIGNAL_START, PUSH_SIGNAL_END);
  assert.ok(
    slice.includes("applyBackgroundFraming("),
    "pushSignal must run its outgoing text through applyBackgroundFraming(...) before sendClientContent " +
      "— a turnComplete:false passive injection must carry the BACKGROUND preamble",
  );
  assert.ok(
    !NOOP_FRAMING_CALL_RE.test(slice),
    "pushSignal must not call applyBackgroundFraming(..., true) — that is the helper's no-op branch; " +
      "the pane-signal send is a PASSIVE injection and must classify itself passive",
  );
});

test("the memory-brief send (downstream of synthesizeAsync, ~:1172) applies the BACKGROUND framing helper", () => {
  const slice = sliceBetween(voiceIndexSource, MEMORY_BRIEF_START, MEMORY_BRIEF_END);
  assert.ok(
    slice.includes("applyBackgroundFraming("),
    "the synthesized memory-brief's sendClientContent call must run brief.text through " +
      "applyBackgroundFraming(...) before it reaches Gemini",
  );
  assert.ok(
    !NOOP_FRAMING_CALL_RE.test(slice),
    "the memory-brief send must not call applyBackgroundFraming(..., true) — that is the helper's " +
      "no-op branch; the brief is a PASSIVE background injection and must classify itself passive " +
      "regardless of the protocol-level turnComplete literal the site sends to Gemini",
  );
});

test("forced spoken turns (pushAck, pushApprovalNarration; both turnComplete:true) never carry the BACKGROUND preamble", () => {
  // Precondition: the helper must exist at all — this is what makes this test genuinely RED today
  // (rather than vacuously green because nothing currently calls a helper that doesn't exist).
  // VERIFIER PATCH: checked at RUNTIME (module namespace) rather than by source regex — an
  // `export { applyBackgroundFraming }` list-style export would have false-failed the old
  // /export\s+(function|const)\s+applyBackgroundFraming/ source pattern despite being a
  // perfectly valid implementation.
  assert.strictEqual(
    typeof (voiceIndexModule as any).applyBackgroundFraming,
    "function",
    "expected src/voice/index.ts to export a pure `applyBackgroundFraming` composition helper",
  );

  const pushAckSlice = sliceBetween(voiceIndexSource, PUSH_ACK_START, PUSH_ACK_END);
  assert.ok(
    !pushAckSlice.includes("applyBackgroundFraming("),
    "pushAck is a forced spoken-turn ack (turnComplete:true) — it must NEVER be framed with the BACKGROUND preamble",
  );

  const pushApprovalSlice = sliceBetween(voiceIndexSource, PUSH_APPROVAL_START, PUSH_APPROVAL_END);
  assert.ok(
    !pushApprovalSlice.includes("applyBackgroundFraming("),
    "pushApprovalNarration is a forced SYSTEM EVENT spoken turn (turnComplete:true) — it must NEVER be framed with the BACKGROUND preamble",
  );
});
