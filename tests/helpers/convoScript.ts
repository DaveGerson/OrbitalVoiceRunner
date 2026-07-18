// tests/helpers/convoScript.ts — bead wsm-e2e-pinned-x58c: a small declarative DSL for multi-turn
// voice-conversation scenarios, generalizing the single-purpose harness in
// tests/test_voice_thought_buffer.ts into a reusable runner.
//
// A scenario is an ORDERED list of steps (operator says X / model thinks [fragments] / model
// speaks / turnComplete / generationComplete / interrupted / toolCall) executed against the REAL
// server via the mockLive harness (tests/helpers/mockLive.ts) — same boot pattern as
// test_voice_thought_buffer.ts / test_voice_tool_goldens.ts: real WS client, real onmessage
// dispatch, real SQLite-ledger draft, real recentTurns ring, real interaction-log JSONL.
//
// This module is intentionally SERVER-AGNOSTIC about pane/project setup (that stays in the test
// file, mirroring registerActivePane / StubTerminal / registerLedgerPane in the sibling suites) —
// it only knows how to (a) turn a step into a synthetic LiveServerMessage / tool call and (b)
// collect + assert the resulting outcome (transcript_text frames, draft text, recentTurns,
// interaction-log kind counts). For RICH outputs (e.g. an approval lifecycle, where a generated
// messageId is a volatile substring) callers normalize() the capture and compare it against a
// committed golden fixture, REG1-style (tests/test_voice_tool_goldens.ts).

import assert from "node:assert";
import fs from "fs";
import type { MockLiveHandle, MockLiveSession } from "./mockLive";

// ── Step DSL ─────────────────────────────────────────────────────────────────────────────────

export interface StepOperatorSay { type: "operatorSay"; text: string; }
export interface StepModelThinks { type: "modelThinks"; fragments: string[]; }
export interface StepModelSpeaks { type: "modelSpeaks"; text: string; }
export interface StepTurnComplete { type: "turnComplete"; }
export interface StepGenerationComplete { type: "generationComplete"; }
export interface StepInterrupted { type: "interrupted"; }
export interface StepToolCall {
  type: "toolCall";
  name: string;
  args?: Record<string, any>;
  id?: string;
  /** Label to file the response under in ConvoOutcome.toolResponses (defaults to `name`). */
  capture?: string;
  /** Default true: await the tool response before moving to the next step. */
  waitForResponse?: boolean;
}
export interface StepSettle { type: "settle"; ms?: number; }

export type ConvoStep =
  | StepOperatorSay
  | StepModelThinks
  | StepModelSpeaks
  | StepTurnComplete
  | StepGenerationComplete
  | StepInterrupted
  | StepToolCall
  | StepSettle;

// Step builders — scenarios are DATA (arrays of these), not bespoke per-scenario code.
export const operatorSay = (text: string): ConvoStep => ({ type: "operatorSay", text });
export const modelThinks = (...fragments: string[]): ConvoStep => ({ type: "modelThinks", fragments });
export const modelSpeaks = (text: string): ConvoStep => ({ type: "modelSpeaks", text });
export const turnComplete = (): ConvoStep => ({ type: "turnComplete" });
export const generationComplete = (): ConvoStep => ({ type: "generationComplete" });
export const interrupted = (): ConvoStep => ({ type: "interrupted" });
export const toolCall = (
  name: string,
  args: Record<string, any> = {},
  opts: { id?: string; capture?: string; waitForResponse?: boolean } = {}
): ConvoStep => ({ type: "toolCall", name, args, ...opts });
export const settle = (ms?: number): ConvoStep => ({ type: "settle", ms });

// ── Production bullet formats (src/voice/index.ts handleOperatorUtterance/handleModelUtterance) ──
// Kept here as named helpers so scenario `expect` blocks stay declarative and never hand-format
// the exact bullet markdown themselves (a drift-prone duplication the DSL exists to avoid).
export const agenticThoughtBullet = (text: string): string => `* **Agentic Thought**: *${text}*`;
export const userDictationBullet = (text: string): string => `* **User Dictation**: ${text}`;

// ── Environment the runner drives — supplied by the test file, mirrors the boot pattern in
// tests/test_voice_thought_buffer.ts / tests/test_voice_tool_goldens.ts. ──────────────────────
export interface ConvoEnv {
  session: () => MockLiveSession;
  mock: MockLiveHandle;
  waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;
  /** The live-growing array of every WS frame the test's real client socket has received. */
  clientMessages: any[];
  getDraftText: () => string | undefined;
  recentTurnsSize: () => number;
  recentTurnsLatest: (author: "janus" | "user") => string | undefined;
  logSize: () => number;
  logSince: (offset: number) => any[];
  /** Final settle window after the last step, letting async WS delivery land. Default 200ms. */
  settleMs?: number;
}

export interface ConvoOutcome {
  /** transcript_text (Janus/User) frames, in order, since the scenario started. */
  frames: { sender: string; text: string }[];
  /** EVERY WS frame (any type) the client received since the scenario started, in order — for
   *  assertions the generic `frames` projection doesn't cover (approval_pending, command_*, etc). */
  rawMessages: any[];
  draftText: string | undefined;
  recentTurnsSize: number;
  recentTurnsLatestJanus: string | undefined;
  recentTurnsLatestUser: string | undefined;
  /** Interaction-log rows appended since the scenario started (byte-offset read). */
  logs: any[];
  logKindCounts: Record<string, number>;
  toolResponses: Record<string, { callId: string; response: any }>;
}

/** Run one scenario's steps against the real server, then collect the outcome. Each `emit()` call
 *  runs the server's onmessage synchronously up to its first await (see test_voice_thought_buffer.ts
 *  settle() comment) — the only genuinely async hops are toolCall responses and the final WS-delivery
 *  settle window. */
export async function runConvoScenario(env: ConvoEnv, steps: ConvoStep[]): Promise<ConvoOutcome> {
  const seenIdx = env.clientMessages.length;
  const logOffset = env.logSize();
  const toolResponses: Record<string, { callId: string; response: any }> = {};

  for (const step of steps) {
    switch (step.type) {
      case "operatorSay":
        env.session().emit({ serverContent: { inputTranscription: { text: step.text } } });
        break;
      case "modelThinks":
        for (const fragment of step.fragments) {
          env.session().emit({ serverContent: { outputTranscription: { text: fragment } } });
        }
        break;
      case "modelSpeaks":
        env.session().emit({ serverContent: { modelTurn: { parts: [{ text: step.text }] } } });
        break;
      case "turnComplete":
        env.session().emit({ serverContent: { turnComplete: true } });
        break;
      case "generationComplete":
        env.session().emit({ serverContent: { generationComplete: true } } as any);
        break;
      case "interrupted":
        env.session().emit({ serverContent: { interrupted: true } });
        break;
      case "toolCall": {
        const callId = env.session().emitToolCall(step.name, step.args ?? {}, step.id);
        if (step.waitForResponse !== false) {
          const response = await env.waitFor(() => env.mock.rawResponseFor(callId));
          toolResponses[step.capture ?? step.name] = { callId, response };
        }
        break;
      }
      case "settle":
        await new Promise((r) => setTimeout(r, step.ms ?? 50));
        break;
      /* istanbul ignore next -- exhaustiveness guard: TS errors at compile time on a missed variant */
      default: {
        const _exhaustive: never = step;
        throw new Error(`convoScript: unhandled step ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  await new Promise((r) => setTimeout(r, env.settleMs ?? 200));

  const rawMessages = env.clientMessages.slice(seenIdx);
  const frames = rawMessages
    .filter((m) => m?.type === "transcript_text")
    .map((m) => ({ sender: m.sender, text: m.text }));
  const logs = env.logSince(logOffset);
  const logKindCounts: Record<string, number> = {};
  for (const l of logs) {
    const kind = typeof l?.kind === "string" ? l.kind : "unknown";
    logKindCounts[kind] = (logKindCounts[kind] ?? 0) + 1;
  }

  return {
    frames,
    rawMessages,
    draftText: env.getDraftText(),
    recentTurnsSize: env.recentTurnsSize(),
    recentTurnsLatestJanus: env.recentTurnsLatest("janus"),
    recentTurnsLatestUser: env.recentTurnsLatest("user"),
    logs,
    logKindCounts,
    toolResponses,
  };
}

// ── Expected-outcome block + assertion ──────────────────────────────────────────────────────────

export interface ExpectedFrame { sender: "Janus" | "User"; text: string; }
export interface ExpectedRecentTurns {
  size?: number;
  /** null explicitly asserts "no janus turn yet" (recentTurns.latest("janus") === undefined). */
  latestJanus?: string | null;
  latestUser?: string | null;
}
export interface ConvoExpectation {
  /** Ordered transcript_text (Janus/User) frames expected since the scenario started. */
  frames?: ExpectedFrame[];
  /** Exact final draft text. `null` asserts NO draft was appended (draftText === undefined). */
  draftText?: string | null;
  /** Alternative/additional check: number of `\n`-joined lines in the draft. */
  draftBulletCount?: number;
  recentTurns?: ExpectedRecentTurns;
  /** Expected interaction-log row counts, by `kind`. Checked as exact equality per named kind. */
  logKinds?: Record<string, number>;
}

/** Assert a ConvoOutcome against a ConvoExpectation. `label` prefixes every failure message so a
 *  red assertion names the scenario it came from without extra digging. */
export function assertConvoOutcome(outcome: ConvoOutcome, expected: ConvoExpectation, label = "scenario"): void {
  if (expected.frames) {
    assert.strictEqual(
      outcome.frames.length,
      expected.frames.length,
      `[${label}] expected ${expected.frames.length} transcript_text frame(s), got ${outcome.frames.length}: ${JSON.stringify(outcome.frames)}`
    );
    expected.frames.forEach((f, i) => {
      assert.strictEqual(outcome.frames[i]?.sender, f.sender, `[${label}] frame[${i}].sender`);
      assert.strictEqual(outcome.frames[i]?.text, f.text, `[${label}] frame[${i}].text`);
    });
  }
  if (expected.draftText !== undefined) {
    if (expected.draftText === null) {
      assert.strictEqual(outcome.draftText, undefined, `[${label}] expected NO draft append, got ${JSON.stringify(outcome.draftText)}`);
    } else {
      assert.strictEqual(outcome.draftText, expected.draftText, `[${label}] draft text`);
    }
  }
  if (expected.draftBulletCount !== undefined) {
    const lines = outcome.draftText ? outcome.draftText.split("\n") : [];
    assert.strictEqual(lines.length, expected.draftBulletCount, `[${label}] draft bullet count (draft: ${JSON.stringify(outcome.draftText)})`);
  }
  if (expected.recentTurns) {
    const rt = expected.recentTurns;
    if (rt.size !== undefined) {
      assert.strictEqual(outcome.recentTurnsSize, rt.size, `[${label}] recentTurns.size()`);
    }
    if (rt.latestJanus !== undefined) {
      assert.strictEqual(outcome.recentTurnsLatestJanus, rt.latestJanus ?? undefined, `[${label}] recentTurns.latest("janus")`);
    }
    if (rt.latestUser !== undefined) {
      assert.strictEqual(outcome.recentTurnsLatestUser, rt.latestUser ?? undefined, `[${label}] recentTurns.latest("user")`);
    }
  }
  if (expected.logKinds) {
    for (const [kind, count] of Object.entries(expected.logKinds)) {
      assert.strictEqual(
        outcome.logKindCounts[kind] ?? 0,
        count,
        `[${label}] interaction-log kind "${kind}" count (all counts: ${JSON.stringify(outcome.logKindCounts)})`
      );
    }
  }
}

export interface ConvoScenario {
  name: string;
  steps: ConvoStep[];
  expect: ConvoExpectation;
}

// ── REG1-style normalize() + golden-fixture comparison, for scenarios whose captured output is
// rich enough to carry volatile substrings (generated ids) — mirrors tests/test_voice_tool_goldens.ts
// exactly so this suite is reviewable by the same discipline. ──────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const ID_KEYS = new Set(["messageId", "actionId", "callId", "id", "gate_approval_id", "session_id"]);
const TS_KEYS = new Set(["timestamp", "captured_at", "created_at", "at"]);

/** Recursively replace volatile fields (generated ids, timestamps) with stable placeholders, so a
 *  rich capture (e.g. an approval lifecycle) can be compared byte-for-byte against a committed
 *  golden fixture across runs. Structure + stable text is preserved — that is the contract. */
export function normalizeConvo(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeConvo);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      if (v === undefined) continue;
      if (v === null) { out[k] = null; continue; }
      if (ID_KEYS.has(k) && typeof v === "string") { out[k] = "<ID>"; continue; }
      if (TS_KEYS.has(k) && (typeof v === "string" || typeof v === "number")) { out[k] = "<TS>"; continue; }
      out[k] = normalizeConvo(v);
    }
    return out;
  }
  if (typeof value === "string" && ISO_RE.test(value)) return "<TS>";
  return value;
}

/** Load the committed golden fixture (or {} if it doesn't exist yet). */
export function loadGoldenFixture(fixturePath: string): Record<string, any> {
  return fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : {};
}

/** Persist freshly-captured goldens, sorted by label for a stable diff (REG1 convention). */
export function writeGoldenFixture(fixturePath: string, captured: Record<string, any>): void {
  const sorted: Record<string, any> = {};
  for (const k of Object.keys(captured).sort()) sorted[k] = captured[k];
  fs.writeFileSync(fixturePath, JSON.stringify(sorted, null, 2) + "\n");
}

/** Assert a normalized capture deep-equals the committed golden fixture entry, REG1-style. No-op
 *  (capture-only) when `rewrite` is true — callers persist via writeGoldenFixture in their own
 *  after() once all labels for the run are captured. */
export function assertGoldenLabel(label: string, captured: any, fixture: Record<string, any>, rewrite: boolean): void {
  if (rewrite) return;
  assert.ok(
    Object.prototype.hasOwnProperty.call(fixture, label),
    `fixture is missing convo golden "${label}" — run with JANUS_GOLDEN_REWRITE=1 to (re)generate it deliberately`
  );
  assert.deepStrictEqual(
    captured,
    fixture[label],
    `convo golden "${label}" diverged from the committed fixture. If this change is INTENTIONAL, update the fixture deliberately (JANUS_GOLDEN_REWRITE=1) and review the diff.`
  );
}
