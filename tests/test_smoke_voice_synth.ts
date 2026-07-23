// tests/test_smoke_voice_synth.ts — Unit 5 offline test suite for smoke-voice-synth
// bead wsm-e2e-pinned-t5hb (LIVE-SYNTH lane Unit 5)

import { describe, it } from "node:test";
import assert from "node:assert";
import { main, type SmokeDeps } from "../scripts/smoke-voice-synth";
import { createConductor, type Conductor } from "../src/voice/synthLane/conductor";
import { type ScoreName } from "../src/voice/synthLane/scores";

function feedCannedFrames(
  scoreName: ScoreName,
  conductor: Conductor,
  opts: { omitApprovalResolved?: boolean } = {}
): void {
  let now = 1000;
  conductor.onClock(now);

  if (scoreName === "spike") {
    conductor.step();
    conductor.onFrame({ type: "transcript_text", sender: "User", text: "This is a microphone check..." });
    conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Microphone check received." });
    now += 1500;
    conductor.onClock(now);
    conductor.step();
  } else if (scoreName === "dictation") {
    conductor.step();
    conductor.onFrame({ type: "transcript_text", sender: "User", text: "First dictation phrase" });
    conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Bubble 1" });
    now += 1500;
    conductor.onClock(now);
    conductor.step();
    now += 600;
    conductor.onClock(now);
    conductor.step();
    conductor.step();
    conductor.onFrame({ type: "transcript_text", sender: "User", text: "Second dictation phrase" });
    conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Bubble 2" });
    now += 1500;
    conductor.onClock(now);
    conductor.step();
    now += 600;
    conductor.onClock(now);
    conductor.step();
  } else if (scoreName === "approval") {
    conductor.step();
    conductor.onFrame({ type: "transcript_text", sender: "User", text: "Please run..." });
    conductor.onFrame({ type: "approval_pending" });
    conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Command proposed." });
    now += 1500;
    conductor.onClock(now);
    conductor.step();
    conductor.step();
    conductor.onFrame({ type: "transcript_text", sender: "User", text: "approve" });
    if (!opts.omitApprovalResolved) {
      conductor.onFrame({ type: "approval_resolved", outcome: "approved" });
    }
    conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Approved." });
    now += 1500;
    conductor.onClock(now);
    conductor.step();
  } else if (scoreName === "bargein") {
    conductor.step();
    conductor.onFrame({ type: "audio" });
    conductor.step();
    conductor.onFrame({ type: "interrupted" });
    conductor.onFrame({ type: "transcript_text", sender: "Janus", text: "Partial explanation..." });
    now += 1500;
    conductor.onClock(now);
    conductor.step();
  }
}

function checkOutcomeForTest(
  scoreName: ScoreName,
  conductor: Conductor
): { ok: boolean; reason?: string } {
  const outcome = conductor.outcome();
  switch (scoreName) {
    case "spike":
      if (outcome.userTranscripts < 1) return { ok: false, reason: "spike userTranscripts < 1" };
      return { ok: true };
    case "dictation":
      if (outcome.userTranscripts < 2) return { ok: false, reason: "dictation userTranscripts < 2" };
      return { ok: true };
    case "approval":
      if (!outcome.approvalResolved) return { ok: false, reason: "approval not resolved" };
      return { ok: true };
    case "bargein":
      if (!outcome.interrupted || outcome.janusTranscripts < 1) {
        return { ok: false, reason: "bargein not interrupted or missing transcript" };
      }
      return { ok: true };
  }
}

describe("smoke:voice-synth offline unit tests", () => {
  it("(1) key resolver returns { found: false } => main returns 2 (SKIP) and server boot fake never called", async () => {
    let bootCalled = false;
    const logs: string[] = [];
    const deps: SmokeDeps = {
      resolveKey: async () => ({ found: false }),
      startServer: async () => {
        bootCalled = true;
        return {};
      },
      log: (line) => logs.push(line),
    };

    const code = await main(deps);
    assert.strictEqual(code, 2, "exit code must be 2 for SKIP");
    assert.strictEqual(bootCalled, false, "server boot fake must not be called when key not found");
    assert.ok(logs.some((l) => l.includes("SKIP")), "log must mention SKIP");
  });

  it("(2) key resolved + fake frame source feeds canned frames into REAL conductor => returns 0; env vars recorded", async () => {
    const envRecorded: Record<string, string> = {};
    const logs: string[] = [];
    const scoresRun: string[] = [];

    const deps: SmokeDeps = {
      resolveKey: async () => ({ found: true, source: "env", key: "test-secret-key-xyz" }),
      setEnv: (k, v) => { envRecorded[k] = v; },
      startServer: async () => ({ manager: { ledger: { addProject: () => {}, updatePane: () => {} } } }),
      teardownServer: async () => {},
      log: (line) => logs.push(line),
      runScore: async (scoreName, score) => {
        scoresRun.push(scoreName);
        const conductor = createConductor(score);
        feedCannedFrames(scoreName, conductor);
        return checkOutcomeForTest(scoreName, conductor);
      },
    };

    const code = await main(deps);
    assert.strictEqual(code, 0, "exit code must be 0 for PASS");
    assert.deepStrictEqual(scoresRun, ["spike", "dictation", "approval", "bargein"]);
    assert.strictEqual(envRecorded["GEMINI_API_KEY"], "test-secret-key-xyz");
    assert.strictEqual(envRecorded["JANUS_CAPTURE_LIVE_TRACES"], "1");
  });

  it("(3) approval score withholds approval_resolved => retries once then returns 1 (FAIL)", async () => {
    const scoresRun: string[] = [];
    const deps: SmokeDeps = {
      resolveKey: async () => ({ found: true, source: "env", key: "test-secret-key-xyz" }),
      startServer: async () => ({}),
      teardownServer: async () => {},
      log: () => {},
      runScore: async (scoreName, score) => {
        scoresRun.push(scoreName);
        const conductor = createConductor(score);
        if (scoreName === "approval") {
          feedCannedFrames(scoreName, conductor, { omitApprovalResolved: true });
        } else {
          feedCannedFrames(scoreName, conductor);
        }
        return checkOutcomeForTest(scoreName, conductor);
      },
    };

    const code = await main(deps);
    assert.strictEqual(code, 1, "exit code must be 1 for FAIL");
    const approvalCount = scoresRun.filter((s) => s === "approval").length;
    assert.strictEqual(approvalCount, 2, "approval scenario must retry once (run twice)");
  });

  it("(4) resolved key string is NEVER logged", async () => {
    const secretKey = "SUPER_SECRET_GEMINI_KEY_999";
    const logs: string[] = [];
    const deps: SmokeDeps = {
      resolveKey: async () => ({ found: true, source: "env", key: secretKey }),
      startServer: async () => ({}),
      teardownServer: async () => {},
      log: (line) => logs.push(line),
      runScore: async (scoreName, score) => {
        const conductor = createConductor(score);
        feedCannedFrames(scoreName, conductor);
        return { ok: true };
      },
    };

    await main(deps);
    for (const logLine of logs) {
      assert.strictEqual(
        logLine.includes(secretKey),
        false,
        `Secret key appeared in log line: ${logLine}`
      );
    }
  });
});
