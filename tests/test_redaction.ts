import { describe, it } from "node:test";
import assert from "node:assert";
import { redactSecrets, stripAnsiSequences, UniversalTerminal, OrchestratorManager } from "../src/terminal";

// ---------------------------------------------------------------------------
// Table-driven unit tests for redactSecrets()
// ---------------------------------------------------------------------------

describe("redactSecrets – individual pattern coverage", () => {

  // PEM private-key block (multiline)
  it("redacts PEM RSA private key block", () => {
    const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4sNGwJH0EFUMO
-----END RSA PRIVATE KEY-----`;
    const out = redactSecrets(input);
    assert.ok(out.includes("[REDACTED:private-key]"), "PEM block must be redacted");
    assert.ok(!out.includes("BEGIN RSA PRIVATE KEY"), "raw PEM header must not appear");
    assert.ok(!out.includes("MIIEow"), "raw PEM body must not appear");
  });

  it("redacts PEM OPENSSH PRIVATE KEY block", () => {
    const input = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA=\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactSecrets(input);
    assert.ok(out.includes("[REDACTED:private-key]"));
    assert.ok(!out.includes("b3BlbnNzaC"));
  });

  it("redacts a bare PKCS#8 'BEGIN PRIVATE KEY' block (no algorithm prefix)", () => {
    const input = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj=\n-----END PRIVATE KEY-----";
    const out = redactSecrets(input);
    assert.ok(out.includes("[REDACTED:private-key]"), "bare PKCS#8 key must be redacted");
    assert.ok(!out.includes("MIIEvQ"), "raw PKCS#8 body must not appear");
  });

  // JWT
  it("redacts a JWT token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactSecrets(`Bearer ${jwt}`);
    assert.ok(out.includes("[REDACTED:jwt]"), "JWT must be redacted");
    assert.ok(!out.includes("eyJhbGci"), "raw JWT header must not appear");
  });

  // AWS access key ID
  it("redacts AWS access key ID (AKIA…)", () => {
    // AKIA + exactly 16 uppercase alphanumeric chars = 20-char valid AWS access key ID
    const out = redactSecrets("export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    assert.ok(out.includes("[REDACTED:aws-key]"), "AWS key ID must be redacted");
    assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"), "raw AKIA key must not appear");
  });

  // AWS secret access key assignment
  it("redacts aws_secret_access_key=<40-char value>", () => {
    const out = redactSecrets("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    assert.ok(out.includes("[REDACTED:aws-key]"), "AWS secret key must be redacted");
    assert.ok(!out.includes("wJalrXUtnFEMI"), "raw AWS secret value must not appear");
  });

  // Google API key
  it("redacts a Google API key (AIza…)", () => {
    // 35 chars after AIza
    const key = "AIzaSyA" + "a".repeat(32);  // AIza + 35 = AIza + 3 + 32 = correct 39 total
    // Spec: AIza[0-9A-Za-z_-]{35} → total length = 4 + 35 = 39
    const googleKey = "AIzaSy" + "B".repeat(33); // AIza + Sy + 33 = 4+2+33=39 chars ✓
    const out = redactSecrets(`API key is ${googleKey} now`);
    assert.ok(out.includes("[REDACTED:google-api-key]"), "Google API key must be redacted");
    assert.ok(!out.includes("AIzaSy"), "raw Google key must not appear");
  });

  // GitHub tokens
  it("redacts a GitHub personal access token (ghp_…)", () => {
    const ghp = "ghp_" + "A".repeat(36);
    const out = redactSecrets(`GITHUB_TOKEN=${ghp}`);
    assert.ok(out.includes("[REDACTED:github-token]") || out.includes("[REDACTED:secret]"), "GitHub token must be redacted");
    assert.ok(!out.includes(ghp), "raw ghp_ token must not appear");
  });

  it("redacts GitHub gho_ and ghs_ tokens", () => {
    const gho = "gho_" + "Z".repeat(36);
    const ghs = "ghs_" + "Z".repeat(40);
    assert.ok(!redactSecrets(gho).includes(gho), "gho_ token redacted");
    assert.ok(!redactSecrets(ghs).includes(ghs), "ghs_ token redacted");
  });

  // Slack tokens
  it("redacts Slack bot tokens (xoxb-…)", () => {
    // Built from parts so the source contains no contiguous token literal (avoids
    // secret-scanner false positives); the runtime value still matches the regex.
    const slack = "xox" + "b-" + "EXAMPLE-NOT-A-REAL-" + "0".repeat(20);
    const out = redactSecrets(`SLACK_TOKEN=${slack}`);
    assert.ok(out.includes("[REDACTED:slack-token]") || out.includes("[REDACTED:secret]"), "Slack token must be redacted");
    assert.ok(!out.includes("xoxb-"), "raw xoxb- token must not appear");
  });

  it("redacts Slack user/app tokens (xoxp-, xoxa-, xoxs-)", () => {
    const variants = ["p", "a", "s"].map((c) => "xox" + c + "-EXAMPLE-FAKE-VALUE");
    for (const tok of variants) {
      assert.ok(!redactSecrets(tok).includes(tok), `${tok} must be redacted`);
    }
  });

  // Generic key=value
  it("redacts generic API_KEY=<value> assignments, keeping key name", () => {
    const out = redactSecrets("API_KEY=supersecretvalue123");
    assert.ok(out.includes("[REDACTED:secret]"), "generic API_KEY= value must be redacted");
    assert.ok(out.includes("API_KEY"), "key name must be preserved");
    assert.ok(!out.includes("supersecretvalue123"), "raw value must not appear");
  });

  it("redacts generic PASSWORD: 'hunter2x' style assignments", () => {
    const out = redactSecrets("PASSWORD: 'hunter2x'");
    assert.ok(out.includes("[REDACTED:secret]"), "PASSWORD value must be redacted");
    assert.ok(!out.includes("hunter2x"), "raw password value must not appear");
  });

  it("redacts generic SECRET= (no quotes)", () => {
    const out = redactSecrets("SECRET=abc123xyz");
    assert.ok(out.includes("[REDACTED:secret]"), "SECRET= value must be redacted");
    assert.ok(!out.includes("abc123xyz"), "raw secret value must not appear");
  });

  it("redacts bearer token assignment (bearer=…)", () => {
    // The generic pattern matches 'bearer' as a standalone keyword followed by = or :
    const out = redactSecrets("bearer=abc123xyz789");
    assert.ok(out.includes("[REDACTED:secret]"), "bearer value must be redacted");
    assert.ok(!out.includes("abc123xyz789"), "raw bearer token must not appear");
  });

});

// ---------------------------------------------------------------------------
// Multi-secret blob test
// ---------------------------------------------------------------------------

describe("redactSecrets – multi-secret blob", () => {
  it("redacts all secret types present in a single blob of text", () => {
    // AKIA + exactly 16 uppercase alphanumeric chars = valid 20-char AWS access key ID
    const awsKey = "AKIAIOSFODNN7EXAMPLE";  // 4 + 16 = 20 chars
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const ghToken = "ghp_" + "X".repeat(36);
    const slackToken = "xox" + "b-" + "EXAMPLE-PLACEHOLDER-" + "1".repeat(12);
    const googleKey = "AIzaSy" + "B".repeat(33);

    const blob = [
      `AWS_ACCESS_KEY_ID=${awsKey}`,
      `Authorization: Bearer ${jwt}`,
      `GITHUB_TOKEN=${ghToken}`,
      `SLACK_BOT_TOKEN=${slackToken}`,
      `GOOGLE_API_KEY=${googleKey}`,
      `PASSWORD=correctHorseBattery1`,
      `Normal log line: build succeeded in 3.2s`,
    ].join("\n");

    const out = redactSecrets(blob);

    // All raw secrets must be gone
    assert.ok(!out.includes(awsKey), "AWS key must be redacted from blob");
    assert.ok(!out.includes("eyJhbGci"), "JWT must be redacted from blob");
    assert.ok(!out.includes(ghToken), "GitHub token must be redacted from blob");
    assert.ok(!out.includes("xoxb-"), "Slack token must be redacted from blob");
    assert.ok(!out.includes("AIzaSy"), "Google API key must be redacted from blob");
    assert.ok(!out.includes("correctHorseBattery1"), "password value must be redacted from blob");

    // Non-secret line must survive
    assert.ok(out.includes("Normal log line: build succeeded in 3.2s"), "normal output must be preserved");
    assert.ok(out.includes("AWS_ACCESS_KEY_ID"), "key name must be preserved after redaction");
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE test: ordinary terminal output is returned unchanged
// ---------------------------------------------------------------------------

describe("redactSecrets – negative (no false positives)", () => {
  it("does NOT mangle normal terminal output, paths, numbers, or prompts", () => {
    const normalLines = [
      "user@hostname:~/projects/my-app$ npm test",
      "  PASS  src/utils.test.ts (12.4s)",
      "  ✓ parses config correctly",
      "Build succeeded in 3.14159 seconds.",
      "Server listening on http://localhost:3000",
      "Error: Cannot find module './missing'",
      "Copying /etc/hosts to /tmp/hosts.bak",
      "Token count: 1024",
      "eyJ: not a real jwt because no dots",
      "AKIA_SHORT_NOT_KEY",
      "password: ''",          // empty value — too short to trigger (6+ chars required)
      "key=abc",               // value only 3 chars — below 6-char minimum
    ].join("\n");

    const out = redactSecrets(normalLines);
    assert.strictEqual(out, normalLines, "Ordinary terminal output must pass through unchanged");
  });

  it("preserves ANSI-stripped output that contains no secrets", () => {
    // Simulate output that already had ANSI stripped (getRecentOutput does this)
    const plain = [
      "> tsc --noEmit",
      "src/terminal.ts(672,5): note: redactSecrets applied",
      "Compilation finished with 0 errors.",
    ].join("\n");
    assert.strictEqual(redactSecrets(plain), plain, "Plain compiler output must pass through unchanged");
  });
});

// ---------------------------------------------------------------------------
// Integration: the REAL OrchestratorManager.getPaneSummary redacts secrets that
// appear in a pane's ring buffer.
//
// Strategy: invoke the real method via its prototype against a non-started
// UniversalTerminal (the constructor neither spawns a process nor sets timers,
// so this is deterministic and leaves no handles open to hang the test runner).
// ---------------------------------------------------------------------------

function paneSummaryFor(bufferLines: string[]): string {
  const term = new UniversalTerminal("p", ".", "bash"); // constructor does NOT spawn
  term.outputBuffer = bufferLines;
  const fakeManager: any = Object.create(OrchestratorManager.prototype);
  fakeManager.terminals = { p: term };
  // Calls the genuine getPaneSummary (real getRecentOutput + real redactSecrets wiring).
  return OrchestratorManager.prototype.getPaneSummary.call(fakeManager, "p", 20);
}

describe("getPaneSummary – integration redaction (spawn-free, real method)", () => {
  it("returns [REDACTED:aws-key] and not the raw AWS key in the pane summary", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE"; // AKIA + 16 chars = valid AKIA format
    const summary = paneSummaryFor([`export AWS_ACCESS_KEY_ID=${awsKey}`, "$ "]);
    assert.ok(summary.includes("[REDACTED:aws-key]"), `expected [REDACTED:aws-key], got: ${summary}`);
    assert.ok(!summary.includes(awsKey), "getPaneSummary must NOT contain the raw AWS key");
    assert.ok(summary.includes("```"), "output should still be markdown-fenced");
  });

  it("returns [REDACTED:jwt] and not the raw JWT in the pane summary", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const summary = paneSummaryFor([jwt, "$ "]);
    assert.ok(summary.includes("[REDACTED:jwt]"), `expected [REDACTED:jwt], got: ${summary}`);
    assert.ok(!summary.includes("eyJhbGci"), "getPaneSummary must NOT contain the raw JWT header");
  });
});
