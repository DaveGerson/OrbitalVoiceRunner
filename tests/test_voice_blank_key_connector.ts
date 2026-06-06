// tests/test_voice_blank_key_connector.ts — bead 9fz: pre-validate a BLANK Gemini key at the REAL
// connector boundary + nudge a reconnect when a non-empty key is set via the settings PUT.
//
// ROOT CAUSE THIS LOCKS: a blank/absent Gemini key made the server attempt a KEYLESS ai.live.connect()
// that can only close with 1007 ("API key not valid") — wasting a handshake and a (bounded) reconnect
// budget slot, and leaving the operator stuck until a full reload. The fix pre-validates the key at the
// REAL connector boundary (the DEFAULT liveConnector) so a blank key short-circuits BEFORE any connect.
//
// CRITICAL HARNESS INVARIANT: installMockLive() deliberately connects with NO key. The short-circuit
// must therefore live in the REAL connector ONLY — a mock installed via setLiveConnector replaces the
// connector wholesale and must STILL connect keylessly. We assert both halves here.
//
// SECRET INVARIANT: the reconnect-nudge decision only fires for a real, non-masked, non-env-sentinel
// key; it never logs or persists the key.
//
// Runner: npx tsx --test --test-force-exit tests/test_voice_blank_key_connector.ts

import { test } from "node:test";
import assert from "node:assert";
import { isBlankApiKey, shouldNudgeReconnectOnSettingsKey } from "../src/voiceResumption";
import {
  realLiveConnector,
  setLiveConnector,
  getLiveConnector,
} from "../server";

// ── Part 1: the REAL connector short-circuits a blank key WITHOUT attempting a connect ───────────
test("realLiveConnector: a BLANK key short-circuits — ai.live.connect is NEVER called", async () => {
  for (const blank of ["", "   ", null, undefined]) {
    let connectCalls = 0;
    const fakeAi: any = { live: { connect: async () => { connectCalls++; return { fake: true }; } } };
    await assert.rejects(
      () => realLiveConnector(fakeAi, { model: "m" }, blank as any),
      /no Gemini API key|blank|API key/i,
      `blank key ${JSON.stringify(blank)} must reject at the connector boundary`,
    );
    assert.strictEqual(connectCalls, 0, `blank key ${JSON.stringify(blank)} must NOT reach ai.live.connect`);
    assert.strictEqual(isBlankApiKey(blank as any), true, "precondition: the key is blank");
  }
});

test("realLiveConnector: a NON-blank key DOES attempt the real ai.live.connect (no short-circuit)", async () => {
  let connectCalls = 0;
  const params = { model: "m" };
  const fakeAi: any = { live: { connect: async (p: any) => { connectCalls++; assert.strictEqual(p, params); return { live: true }; } } };
  const session = await realLiveConnector(fakeAi, params, "AIzaSy-a-real-looking-key");
  assert.strictEqual(connectCalls, 1, "a real key reaches ai.live.connect exactly once");
  assert.deepStrictEqual(session, { live: true }, "the connector returns the live session verbatim");
});

// ── Part 1b: a MOCK connector (installed via setLiveConnector) still connects KEYLESSLY ──────────
test("the MOCK connector path remains functional with NO key (the harness invariant)", async () => {
  const prev = getLiveConnector();
  try {
    let mockCalls = 0;
    setLiveConnector(async (_ai, _params) => { mockCalls++; return { mock: true }; });
    const connector = getLiveConnector();
    // Invoke exactly as the server would for a keyless mock session — the mock ignores the key arg.
    const session = await connector({} as any, { model: "m" }, "" as any);
    assert.strictEqual(mockCalls, 1, "the mock connector connects even with a blank key");
    assert.deepStrictEqual(session, { mock: true }, "the mock session is returned");
  } finally {
    setLiveConnector(prev); // restore the real connector so we never poison a sibling suite.
  }
});

// ── Part 2: the settings-PUT reconnect-nudge decision (pure) ─────────────────────────────────────
test("shouldNudgeReconnectOnSettingsKey: a real non-empty key TRIGGERS a reconnect nudge", () => {
  assert.strictEqual(shouldNudgeReconnectOnSettingsKey("AIzaSy-real-key-0123456789"), true);
});

test("shouldNudgeReconnectOnSettingsKey: blank / masked / env-sentinel keys NEVER nudge", () => {
  for (const k of ["", "   ", null, undefined, "AIzaSy••••••••1234", "CONFIGURED_IN_ENV"]) {
    assert.strictEqual(
      shouldNudgeReconnectOnSettingsKey(k as any),
      false,
      `${JSON.stringify(k)} must NOT trigger a reconnect nudge`,
    );
  }
});
