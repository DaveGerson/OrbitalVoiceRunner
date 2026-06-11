// Nova Sonic 2 — provider selection + AWS credential resolution (pure, no AWS, no server.ts import).
// Pins the routing decision (which backend?) and the settings-vs-env credential precedence that the
// realLiveConnector branch depends on, so the prod-only routing path is covered without a live socket.
//
// Runner: npx tsx --test --test-force-exit tests/test_nova_routing.ts

import { test } from "node:test";
import assert from "node:assert";
import { resolveVoiceProvider, resolveNovaAuth } from "../src/voice/novaRouting";
import type { SystemSettings } from "../src/types";

const voiceAi = (over: Partial<SystemSettings["voiceAi"]> = {}): SystemSettings["voiceAi"] =>
  ({ voice: "Zephyr", voiceStyle: "Creative", volume: 80, speechSpeed: 1, isMicMuted: false, model: "gemini-3.1-flash-live-preview", ...over });

const settings = (voiceAiOver: Partial<SystemSettings["voiceAi"]> = {}, secrets: Partial<SystemSettings["secrets"]> = {}): SystemSettings =>
  ({ voiceAi: voiceAi(voiceAiOver), secrets: { geminiApiKey: "", ...secrets } } as SystemSettings);

// ── resolveVoiceProvider ─────────────────────────────────────────────────────────────────────

test("resolveVoiceProvider: default (absent provider, gemini model) is gemini — existing configs unchanged", () => {
  assert.strictEqual(resolveVoiceProvider(voiceAi()), "gemini");
  assert.strictEqual(resolveVoiceProvider(undefined), "gemini");
});

test("resolveVoiceProvider: explicit provider wins over the model id", () => {
  assert.strictEqual(resolveVoiceProvider(voiceAi({ provider: "nova" })), "nova");
  // Explicit gemini beats an amazon.nova model id (operator override is authoritative).
  assert.strictEqual(resolveVoiceProvider(voiceAi({ provider: "gemini", model: "amazon.nova-2-sonic-v1:0" })), "gemini");
});

test("resolveVoiceProvider: model-id sniff is the fallback when provider is unset", () => {
  assert.strictEqual(resolveVoiceProvider(voiceAi({ model: "amazon.nova-2-sonic-v1:0" })), "nova");
  assert.strictEqual(resolveVoiceProvider(voiceAi({ model: "gemini-2.5-flash" })), "gemini");
});

// ── resolveNovaAuth ──────────────────────────────────────────────────────────────────────────

test("resolveNovaAuth: settings credentials win over env", () => {
  const auth = resolveNovaAuth(
    settings({ awsRegion: "us-west-2" }, { awsAccessKeyId: "AKIA_SETTINGS", awsSecretAccessKey: "secret-settings" }),
    { AWS_ACCESS_KEY_ID: "AKIA_ENV", AWS_SECRET_ACCESS_KEY: "secret-env", AWS_REGION: "ap-northeast-1" },
  );
  assert.strictEqual(auth.accessKeyId, "AKIA_SETTINGS");
  assert.strictEqual(auth.secretAccessKey, "secret-settings");
  assert.strictEqual(auth.region, "us-west-2");
});

test("resolveNovaAuth: falls back to env when settings are blank or the CONFIGURED_IN_ENV sentinel", () => {
  const auth = resolveNovaAuth(
    settings({}, { awsAccessKeyId: "", awsSecretAccessKey: "CONFIGURED_IN_ENV" }),
    { AWS_ACCESS_KEY_ID: "AKIA_ENV", AWS_SECRET_ACCESS_KEY: "secret-env" },
  );
  assert.strictEqual(auth.accessKeyId, "AKIA_ENV");
  assert.strictEqual(auth.secretAccessKey, "secret-env");
});

test("resolveNovaAuth: region defaults to us-east-1 when neither settings nor env set it", () => {
  const auth = resolveNovaAuth(settings(), {});
  assert.strictEqual(auth.region, "us-east-1");
  assert.strictEqual(auth.accessKeyId, "");        // blank when nothing configured (connector then rejects)
  assert.strictEqual(auth.secretAccessKey, "");
});

test("resolveNovaAuth: STS session token is threaded through from env when present (and omitted otherwise)", () => {
  assert.strictEqual("sessionToken" in resolveNovaAuth(settings(), {}), false);
  const auth = resolveNovaAuth(settings(), { AWS_SESSION_TOKEN: "tok-123" });
  assert.strictEqual(auth.sessionToken, "tok-123");
});
