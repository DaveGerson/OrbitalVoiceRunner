// tests/test_redact_trace.ts — BEAD wsm-e2e-pinned-arkr deliverable 5: unit tests for the raw-trace
// redaction tool (scripts/redact-trace.mjs), on SYNTHETIC lines only — never against a real capture.
//
// Runner: npx tsx --test --test-force-exit tests/test_redact_trace.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  maskText,
  redactValue,
  redactTraceLine,
  redactTraceText,
  redactedPathFor,
} from "../scripts/redact-trace.mjs";

describe("redact-trace — maskText (single-string masking rules)", () => {
  it("masks an email address", () => {
    const { masked, spans } = maskText("please reach me at operator@example.com for approval");
    assert.strictEqual(masked, "please reach me at [REDACTED-email] for approval");
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].kind, "email");
    assert.strictEqual(spans[0].original, "operator@example.com");
  });

  it("masks an AWS-shaped access key id", () => {
    const { masked, spans } = maskText("key is AKIAABCDEFGHIJKLMNOP in the log");
    assert.strictEqual(masked, "key is [REDACTED-aws-key] in the log");
    assert.strictEqual(spans[0].kind, "aws-key");
  });

  it("masks a Google-shaped API key", () => {
    const key = "AIza" + "S".repeat(35);
    const { masked, spans } = maskText(`use ${key} please`);
    assert.strictEqual(masked, "use [REDACTED-google-api-key] please");
    assert.strictEqual(spans[0].kind, "google-api-key");
  });

  it("masks a JWT-shaped string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123DEF456";
    const { masked, spans } = maskText(`bearer ${jwt}`);
    assert.strictEqual(masked, "bearer [REDACTED-jwt]");
    assert.strictEqual(spans[0].kind, "jwt");
  });

  it("masks a GitHub-shaped token and a Slack-shaped token", () => {
    const gh = maskText("token ghp_" + "a".repeat(36));
    assert.strictEqual(gh.spans[0].kind, "github-token");
    const slack = maskText("token xox" + "b-1234567890-abcdefghij");
    assert.strictEqual(slack.spans[0].kind, "slack-token");
  });

  it("masks a PEM private key block, across newlines", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG\n-----END PRIVATE KEY-----";
    const { masked, spans } = maskText(`here is the key:\n${pem}\nend`);
    assert.strictEqual(masked, "here is the key:\n[REDACTED-private-key]\nend");
    assert.strictEqual(spans[0].kind, "private-key");
  });

  it("masks a free-text credential assignment (key name + high-entropy value, whole span)", () => {
    const { masked, spans } = maskText("my api_key: sk_live_abcDEF123456 is the one to use");
    assert.strictEqual(masked, "my [REDACTED-credential] is the one to use");
    assert.strictEqual(spans[0].kind, "credential");
  });

  it("masks a long digit run (9+ digits) but leaves short digit runs alone", () => {
    const { masked, spans } = maskText("card ending 4111111111111111, item count 42, code 007");
    assert.strictEqual(masked, "card ending [REDACTED-digits], item count 42, code 007");
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].kind, "digits");
  });

  it("masks EVERY occurrence when multiple candidates appear in one string", () => {
    const { masked, spans } = maskText("email a@b.com or call 5551234567 about it");
    assert.strictEqual(masked, "email [REDACTED-email] or call [REDACTED-digits] about it");
    assert.strictEqual(spans.length, 2);
  });

  it("leaves ordinary text completely unchanged, with no spans", () => {
    const text = "The draft is ready for test-2 now. Say 'send it' to submit.";
    const { masked, spans } = maskText(text);
    assert.strictEqual(masked, text);
    assert.deepStrictEqual(spans, []);
  });

  it("is a safe no-op on non-string / empty input", () => {
    assert.deepStrictEqual(maskText(""), { masked: "", spans: [] });
    assert.deepStrictEqual(maskText(null), { masked: null, spans: [] });
    assert.deepStrictEqual(maskText(42), { masked: 42, spans: [] });
    assert.deepStrictEqual(maskText(undefined), { masked: undefined, spans: [] });
  });
});

describe("redact-trace — redactValue (recursive walk: structure preserved, only strings masked)", () => {
  it("preserves object key order, array order, and ALL non-string leaves untouched", () => {
    const input = {
      ts: 1752701460000,
      seq: 3,
      ok: true,
      nested: null,
      message: {
        serverContent: {
          outputTranscription: { text: "email me at ops@example.com" },
        },
        list: ["fine", "call 5551234567 ok", { deeper: "clean text" }],
      },
    };
    const { redacted, spans, unmasked } = redactValue(input);

    // Non-string leaves byte-identical (same VALUE, not just deep-equal — a long numeric ts must
    // never be treated as a "long digit run"; only STRING leaves are ever visited).
    assert.strictEqual(redacted.ts, 1752701460000);
    assert.strictEqual(redacted.seq, 3);
    assert.strictEqual(redacted.ok, true);
    assert.strictEqual(redacted.nested, null);

    // Structure (key order, array shape) preserved.
    assert.deepStrictEqual(Object.keys(redacted), ["ts", "seq", "ok", "nested", "message"]);
    assert.strictEqual(redacted.message.list.length, 3);

    // String leaves: masked where they matched, untouched where they didn't.
    assert.strictEqual(redacted.message.serverContent.outputTranscription.text, "email me at [REDACTED-email]");
    assert.strictEqual(redacted.message.list[0], "fine");
    assert.strictEqual(redacted.message.list[1], "call [REDACTED-digits] ok");
    assert.strictEqual(redacted.message.list[2].deeper, "clean text");

    assert.strictEqual(spans.length, 2);
    assert.strictEqual(spans.find((s) => s.kind === "email").path, "message.serverContent.outputTranscription.text");
    assert.strictEqual(spans.find((s) => s.kind === "digits").path, "message.list[1]");

    assert.strictEqual(unmasked.length, 2, "the two clean strings ('fine', 'clean text') are reported unmasked for human eyeballing");
    assert.ok(unmasked.some((u) => u.path === "message.list[0]" && u.text === "fine"));
    assert.ok(unmasked.some((u) => u.path === "message.list[2].deeper" && u.text === "clean text"));
  });

  it("redactTraceLine stamps every span/unmasked entry with the given line number", () => {
    const { spans, unmasked } = redactTraceLine({ ts: 1, seq: 0, message: { a: "call me at a@b.com", b: "plain" } }, 7);
    assert.strictEqual(spans[0].line, 7);
    assert.strictEqual(unmasked[0].line, 7);
  });
});

describe("redact-trace — redactTraceText (full file: one JSON object per line)", () => {
  it("redacts every JSON line's text fields, preserves blank lines and malformed lines verbatim, keeps line count", () => {
    const raw = [
      JSON.stringify({ ts: 1, seq: 0, message: { serverContent: { outputTranscription: { text: "hi a@b.com" } } } }),
      "",
      "not json at all {{{",
      JSON.stringify({ ts: 2, seq: 1, message: { serverContent: { turnComplete: true } } }),
    ].join("\n");

    const { text, spans, unmasked } = redactTraceText(raw);
    const outLines = text.split("\n");
    assert.strictEqual(outLines.length, 4, "line count preserved exactly, including the blank line");
    assert.strictEqual(outLines[1], "", "blank line passes through untouched");
    assert.strictEqual(outLines[2], "not json at all {{{", "malformed (non-JSON) line passes through untouched, never crashes");

    const line1 = JSON.parse(outLines[0]);
    assert.strictEqual(line1.ts, 1);
    assert.strictEqual(line1.message.serverContent.outputTranscription.text, "hi [REDACTED-email]");

    const line4 = JSON.parse(outLines[3]);
    assert.deepStrictEqual(line4, { ts: 2, seq: 1, message: { serverContent: { turnComplete: true } } }, "a line with no string leaves to mask is byte-identical");

    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].line, 1);
    assert.strictEqual(unmasked.length, 0, "turnComplete:true has no non-empty string leaves to report");
  });
});

describe("redact-trace — redactedPathFor (output naming)", () => {
  it("inserts .redacted before a .jsonl extension", () => {
    assert.strictEqual(redactedPathFor("foo.jsonl"), "foo.redacted.jsonl");
    assert.strictEqual(redactedPathFor(path.join("dir", "name.jsonl")), path.join("dir", "name.redacted.jsonl"));
  });

  it("still lands on .redacted.jsonl for a file with a different or no extension", () => {
    assert.strictEqual(redactedPathFor("foo.txt"), "foo.redacted.jsonl");
    assert.strictEqual(redactedPathFor("foo"), "foo.redacted.jsonl");
  });
});

describe("redact-trace — end-to-end file round trip (synthetic, on disk)", () => {
  let tmpDir: string;

  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-redact-")); });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("writes <name>.redacted.jsonl next to a synthetic raw trace, masking only its text fields", () => {
    const inputPath = path.join(tmpDir, "synthetic.jsonl");
    const raw = [
      JSON.stringify({ ts: 1752701460000, seq: 0, message: { serverContent: { inputTranscription: { text: "call me at 5551234567 or a@b.com" } } } }),
      JSON.stringify({ ts: 1752701460500, seq: 1, message: { serverContent: { turnComplete: true } } }),
    ].join("\n") + "\n";
    fs.writeFileSync(inputPath, raw);

    const { text } = redactTraceText(fs.readFileSync(inputPath, "utf8"));
    const outputPath = redactedPathFor(inputPath);
    fs.writeFileSync(outputPath, text);

    assert.ok(fs.existsSync(outputPath));
    assert.strictEqual(outputPath, path.join(tmpDir, "synthetic.redacted.jsonl"));
    const lines = fs.readFileSync(outputPath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    assert.strictEqual(lines.length, 2);
    const row0 = JSON.parse(lines[0]);
    assert.strictEqual(row0.ts, 1752701460000, "structural ts untouched");
    assert.strictEqual(row0.seq, 0, "structural seq untouched");
    assert.strictEqual(
      row0.message.serverContent.inputTranscription.text,
      "call me at [REDACTED-digits] or [REDACTED-email]"
    );
    // The original raw file is untouched — the tool must never mutate its source.
    assert.strictEqual(fs.readFileSync(inputPath, "utf8"), raw);
  });
});
