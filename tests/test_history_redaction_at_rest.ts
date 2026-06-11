// Q2 — Secrets-at-rest on the HISTORY write path.
//
// CONTRACT under test: no credential-shaped secret may appear VERBATIM in
// .janus_history.json at rest — neither in a command string nor in output. The
// HistoryManager funnels every mutation (addCommand / appendOutputToLastCommand /
// clearHistory) through saveHistory, which now redacts each entry's `command` and
// `output` via redactSecrets BEFORE the maxOutput tail-slice. Redaction must be
// robust to secrets that:
//   - sit in the command string,
//   - sit in the output,
//   - span two appended chunks (chunk-boundary), and
//   - sit near the maxOutput tail boundary (redact-before-slice ordering).
//
// Pattern follows tests/test_secrets_at_rest.ts + tests/test_history_flush.ts:
// mkdtemp + process.chdir, drive the real HistoryManager seam, read the on-disk file,
// and assert the synthetic credential is ABSENT verbatim while a [REDACTED] marker is present.
//
// Runner: npx tsx --test --test-force-exit tests/test_history_redaction_at_rest.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

// Synthetic credentials — NEVER real keys, only prove the redactor by SHAPE.
const FAKE_AWS = "AKIA" + "ABCDEFGHIJKLMNOP";        // AKIA + 16 [0-9A-Z] → \bAKIA[0-9A-Z]{16}\b
const FAKE_GOOGLE = "AIza" + "Sy" + "Z".repeat(33);   // AIza + 35 chars → \bAIza[0-9A-Za-z_-]{35}\b

function historyPath(): string {
  return path.join(process.cwd(), ".janus_history.json");
}
function readHistoryFile(): Record<string, any[]> {
  try {
    return JSON.parse(fs.readFileSync(historyPath(), "utf-8"));
  } catch {
    return {};
  }
}

describe("Q2 HistoryManager redacts secrets at rest", () => {
  let hm: any;
  let tmpDir: string;
  let prevCwd: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-histredact-"));
    process.chdir(tmpDir);
    const serverMod = await import("../server");
    hm = serverMod.HistoryManager.getInstance();
  });

  after(async () => {
    try { await hm.flushAll?.(); } catch { /* noop */ }
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("redacts a secret embedded in the COMMAND string", async () => {
    hm.addCommand("cmd-pane", `aws configure set ${FAKE_AWS}`);
    await hm.flushAll();
    const raw = fs.readFileSync(historyPath(), "utf-8");
    assert.ok(!raw.includes(FAKE_AWS), "AWS key must NOT appear verbatim in the command string at rest");
    assert.match(raw, /\[REDACTED/, "a redaction marker must be present");
    const parsed = readHistoryFile();
    assert.match(parsed["cmd-pane"][0].command, /\[REDACTED:aws-key\]/, "command was redacted");
  });

  it("redacts a secret embedded in OUTPUT", async () => {
    hm.addCommand("out-pane", "print-key");
    hm.appendOutputToLastCommand("out-pane", `the key is ${FAKE_GOOGLE} done`);
    await hm.flushAll();
    const raw = fs.readFileSync(historyPath(), "utf-8");
    assert.ok(!raw.includes(FAKE_GOOGLE), "Google API key must NOT appear verbatim in output at rest");
    const parsed = readHistoryFile();
    assert.match(parsed["out-pane"][0].output, /\[REDACTED:google-api-key\]/, "output was redacted");
  });

  it("redacts a secret SPLIT across two appended chunks (chunk-boundary)", async () => {
    hm.addCommand("split-pane", "leak");
    // Split the AWS key right down the middle across two appends.
    const half = Math.floor(FAKE_AWS.length / 2);
    hm.appendOutputToLastCommand("split-pane", "prefix " + FAKE_AWS.slice(0, half));
    hm.appendOutputToLastCommand("split-pane", FAKE_AWS.slice(half) + " suffix");
    await hm.flushAll();
    const raw = fs.readFileSync(historyPath(), "utf-8");
    assert.ok(!raw.includes(FAKE_AWS), "a chunk-split secret must NOT reassemble verbatim at rest");
    const parsed = readHistoryFile();
    assert.match(parsed["split-pane"][0].output, /\[REDACTED:aws-key\]/, "reassembled secret was redacted");
  });

  it("redacts a secret near the maxOutput TAIL boundary (redact-before-slice)", async () => {
    // Default maxOutput is 5000. Push the accumulated output well past it so the tail-slice
    // fires, with the secret near the retained-tail boundary. The redact-before-slice order
    // must ensure the slice never cuts a still-unredacted secret into an unmatched fragment.
    hm.addCommand("tail-pane", "spew");
    // Filler so total length >> maxOutput, then the secret close to the very end.
    hm.appendOutputToLastCommand("tail-pane", "X".repeat(6000));
    hm.appendOutputToLastCommand("tail-pane", ` tailing ${FAKE_AWS} END`);
    await hm.flushAll();
    const raw = fs.readFileSync(historyPath(), "utf-8");
    assert.ok(!raw.includes(FAKE_AWS), "a tail-boundary secret must NOT survive verbatim at rest");
    const parsed = readHistoryFile();
    const out = parsed["tail-pane"][0].output;
    assert.ok(out.length <= 5000, "output is still capped at maxOutput after redaction");
    assert.match(out, /\[REDACTED:aws-key\]/, "tail-boundary secret was redacted");
  });
});
