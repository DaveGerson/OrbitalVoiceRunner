// tests/test_transcript_sink.ts
//
// Durable transcript sink (bead 98f2) — OPT-IN persistence of BOTH voice channels (operator ASR +
// Janus narration) fed from src/liveTranscripts.ts's extractTranscripts, REDACTED at write per the
// boundary invariant, TTL-pruned like exchange_events. Drives `recordLiveTranscripts` directly with
// an explicit `enabled` flag so the read-once-at-boot module const (src/transcripts/flag.ts) is not
// needed to flip in-test.

import { describe, it } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import { recordLiveTranscripts } from "../src/transcripts/sink";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

const CTX = { sessionId: "sess-1", projectId: "proj-1", paneId: "pane-1", interactionId: "ixn-1" };

describe("transcript sink: OFF by default", () => {
  it("writes ZERO rows when enabled=false", () => {
    const s = freshStore();
    recordLiveTranscripts(s, { operator: "x", model: "", modelThinking: "y" }, CTX, false);
    assert.deepStrictEqual(s.listTranscriptsSince(0), []);
    s.close();
  });
});

describe("transcript sink: opted in — BOTH channels persist", () => {
  it("persists exactly two rows, one per channel", () => {
    const s = freshStore();
    recordLiveTranscripts(
      s,
      { operator: "approve that", model: "", modelThinking: "checking the exporter now" },
      CTX,
      true,
    );
    const rows = s.listTranscriptsSince(0);
    assert.strictEqual(rows.length, 2);
    const operatorRow = rows.find((r) => r.channel === "operator");
    const modelRow = rows.find((r) => r.channel === "model");
    assert.ok(operatorRow, "operator channel row missing");
    assert.ok(modelRow, "model channel row missing");
    assert.strictEqual(operatorRow!.text_redacted, "approve that");
    assert.strictEqual(modelRow!.text_redacted, "checking the exporter now");
    s.close();
  });
});

describe("transcript sink: redaction boundary", () => {
  it("scrubs a secret-shaped token in EITHER channel before it reaches disk", () => {
    const s = freshStore();
    const secret = "AIza" + "A".repeat(35); // matches redactSecrets' google-api-key pattern
    recordLiveTranscripts(
      s,
      { operator: `here is the key ${secret}`, model: "", modelThinking: `noted: ${secret}` },
      CTX,
      true,
    );
    const rows = s.listTranscriptsSince(0);
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
      assert.ok(!row.text_redacted.includes(secret), `raw secret leaked into row: ${row.text_redacted}`);
    }
    const operatorRow = rows.find((r) => r.channel === "operator")!;
    assert.ok(operatorRow.text_redacted.includes("[REDACTED"), "expected a scrub placeholder in operator text");
  });
});

describe("transcript sink: empty channels skipped", () => {
  it("writes ZERO rows when all three fields are blank", () => {
    const s = freshStore();
    recordLiveTranscripts(s, { operator: "", model: "", modelThinking: "" }, CTX, true);
    assert.deepStrictEqual(s.listTranscriptsSince(0), []);
    s.close();
  });
});

describe("transcript sink: ctx correlation columns round-trip", () => {
  it("persists session_id/project_id/pane_id/interaction_id onto each row", () => {
    const s = freshStore();
    recordLiveTranscripts(s, { operator: "hello", model: "", modelThinking: "" }, CTX, true);
    const [row] = s.listTranscriptsSince(0);
    assert.strictEqual(row.session_id, CTX.sessionId);
    assert.strictEqual(row.project_id, CTX.projectId);
    assert.strictEqual(row.pane_id, CTX.paneId);
    assert.strictEqual(row.interaction_id, CTX.interactionId);
    s.close();
  });
});

describe("transcript sink: TTL prune parity with exchange_events", () => {
  it("a 31-day-old row is pruned by bootMaintenance; a fresh row survives", () => {
    const s = freshStore();
    const now = Date.now();
    const old = now - 31 * 86_400_000;
    // Directly stamp ts values via recordTranscript to isolate the TTL boundary precisely.
    s.recordTranscript({ channel: "operator", text_redacted: "ancient words", ts: old, ...CTX });
    s.recordTranscript({ channel: "operator", text_redacted: "fresh words", ts: now, ...CTX });

    s.bootMaintenance({
      now,
      eventsTtlDays: 30,
      archiveTtlDays: 14,
      scrollbackDirs: [],
      transcriptsTtlDays: 30,
    });

    const remaining = s.listTranscriptsSince(0).map((r) => r.text_redacted);
    assert.ok(!remaining.includes("ancient words"), "31-day-old row must be pruned");
    assert.ok(remaining.includes("fresh words"), "fresh row must survive");
    s.close();
  });

  it("sweepMaintenance also prunes a stale row (batched TTL path)", () => {
    const s = freshStore();
    const now = Date.now();
    const old = now - 31 * 86_400_000;
    s.recordTranscript({ channel: "model", text_redacted: "ancient narration", ts: old, ...CTX });
    s.recordTranscript({ channel: "model", text_redacted: "fresh narration", ts: now, ...CTX });

    s.sweepMaintenance({
      now,
      eventsTtlDays: 30,
      archiveTtlDays: 14,
      transcriptsTtlDays: 30,
    });

    const remaining = s.listTranscriptsSince(0).map((r) => r.text_redacted);
    assert.ok(!remaining.includes("ancient narration"), "31-day-old row must be pruned by sweep");
    assert.ok(remaining.includes("fresh narration"), "fresh row must survive sweep");
    s.close();
  });
});
