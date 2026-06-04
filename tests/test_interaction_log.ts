// tests/test_interaction_log.ts — the correlated interaction log (Issue #1 instrumentation + the
// "capture voice + thinking + actions + system, analyzed together" ask).
//
// One interaction_id threads an operator TURN across every leg: voice_in (operator ASR) ->
// gemini_thinking / gemini_text (model) -> tool_call -> action_result -> approval -> pty. Each leg is
// ONE redacted JSON line, so the stream is greppable/tailable and groupByInteraction() reconstructs a
// turn's timeline (which is exactly how you SEE the approve→dispatch lag of Issue #1).
//
// Runner: npx tsx --test --test-force-exit tests/test_interaction_log.ts

import { test } from "node:test";
import assert from "node:assert";
import { InteractionLogger, redactDeep, groupByInteraction } from "../src/interactionLog";

function makeLogger(extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  let t = 1000;
  const logger = new InteractionLogger({
    sink: (l: string) => lines.push(l),
    now: () => t,
    redact: (s: string) => s.replace(/SECRET/g, "***"),
    ...extra,
  });
  return { logger, lines, setNow: (n: number) => { t = n; } };
}

test("mint() returns unique, ixn-prefixed ids", () => {
  const { logger } = makeLogger();
  const a = logger.mint();
  const b = logger.mint();
  assert.notStrictEqual(a, b);
  assert.match(a, /^ixn_/);
});

test("log() writes one parseable JSON line per leg, carrying ts + interaction_id + kind", () => {
  const { logger, lines } = makeLogger();
  logger.log({ interactionId: "ixn_1", kind: "voice_in", text: "create a pane" });
  assert.strictEqual(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec.interaction_id, "ixn_1");
  assert.strictEqual(rec.kind, "voice_in");
  assert.strictEqual(rec.ts, 1000);
  assert.strictEqual(rec.text, "create a pane");
});

test("log() redacts secrets in BOTH text and structured data (line is still valid JSON)", () => {
  const { logger, lines } = makeLogger();
  logger.log({
    interactionId: "ixn_1",
    kind: "tool_call",
    text: "token SECRET",
    data: { args: { key: "SECRET" }, name: "propose_command" },
  });
  const rec = JSON.parse(lines[0]); // must not throw
  assert.ok(!JSON.stringify(rec).includes("SECRET"), "no secret survives anywhere in the line");
  assert.strictEqual(rec.text, "token ***");
  assert.strictEqual(rec.data.args.key, "***");
  assert.strictEqual(rec.data.name, "propose_command");
});

test("log() includes pane_id when given and omits absent optional fields", () => {
  const { logger, lines } = makeLogger();
  logger.log({ interactionId: "ixn_1", kind: "pty", paneId: "claude_1", text: "PONG" });
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec.pane_id, "claude_1");
  assert.ok(!("data" in rec), "no empty data key");
});

test("redactDeep recurses objects and arrays", () => {
  const r = redactDeep(
    { a: "SECRET", b: ["x", "SECRET"], c: { d: "SECRET", n: 7 } },
    (s: string) => s.replace(/SECRET/g, "***"),
  );
  assert.deepStrictEqual(r, { a: "***", b: ["x", "***"], c: { d: "***", n: 7 } });
});

test("groupByInteraction groups parsed lines by interaction_id, preserving per-turn order", () => {
  const { logger, lines } = makeLogger();
  logger.log({ interactionId: "A", kind: "voice_in", text: "hi" });
  logger.log({ interactionId: "B", kind: "voice_in", text: "yo" });
  logger.log({ interactionId: "A", kind: "tool_call", data: { name: "create_pane" } });
  const groups = groupByInteraction(lines);
  assert.deepStrictEqual([...groups.keys()], ["A", "B"]);
  assert.strictEqual(groups.get("A")!.length, 2);
  assert.strictEqual(groups.get("A")![1].kind, "tool_call");
});

test("groupByInteraction tolerates blank/garbage lines", () => {
  const groups = groupByInteraction(['{"interaction_id":"A","kind":"voice_in","ts":1}', "", "not json", "  "]);
  assert.strictEqual(groups.size, 1);
  assert.strictEqual(groups.get("A")!.length, 1);
});

test("a logger with no redactor passes text through unchanged", () => {
  const lines: string[] = [];
  const logger = new InteractionLogger({ sink: (l: string) => lines.push(l), now: () => 5 });
  logger.log({ interactionId: "x", kind: "system", text: "plain" });
  assert.strictEqual(JSON.parse(lines[0]).text, "plain");
});
