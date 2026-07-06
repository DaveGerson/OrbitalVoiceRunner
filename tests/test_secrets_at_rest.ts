// Secrets-at-rest hardening: the Gemini API key is an IN-MEMORY-ONLY secret. It lives in
// manager.settings.secrets for the running server session (so voice works once the operator enters
// it in the UI) but is NEVER written to disk — neither the .janus_settings.json file nor the durable
// SQLite settings_kv store. A restart drops it; the operator re-enters it. (Director decision
// 2026-06-05: the key must never be persisted at rest — not even in env.)
//
// These tests pin BOTH persistence choke-points:
//   1. OrchestratorManager.saveSettings (the .janus_settings.json write path).
//   2. migrateFromObjects (the one-time JSON->SQLite import that previously flattened secrets.* into
//      settings_kv — the path that actually leaked the key into .janus.db on the 2026-06-05 boot).
//
// Runner: npx tsx --test --test-force-exit tests/test_secrets_at_rest.ts

import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { migrateFromObjects } from "../src/store/migrate";

// A 39-char Gemini-FORMAT placeholder. NEVER a real key — only proves the strip logic by shape.
const FAKE_KEY = "AIzaSy" + "Z".repeat(33);

test("saveSettings keeps the Gemini key in memory but NEVER writes it to .janus_settings.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-secret-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const store = new JanusStore(":memory:");
    store.init();
    const m = new OrchestratorManager({ ledger: store });
    m.updateSettings({ secrets: { geminiApiKey: FAKE_KEY } });
    // In-memory: the running session HAS the key, so voice works after the operator enters it.
    assert.strictEqual(m.settings.secrets.geminiApiKey, FAKE_KEY, "key stays in memory for the session");
    // On disk: the key is stripped — a settings file must never carry the secret.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, ".janus_settings.json"), "utf8"));
    assert.strictEqual(onDisk.secrets?.geminiApiKey ?? "", "", "the Gemini key must NOT be persisted to .janus_settings.json");
    // Sanity: non-secret settings DO still persist (we strip ONLY the secret).
    assert.ok(onDisk.voiceAi, "non-secret settings still persist to disk");
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sa4: voiceAi.systemPrompt survives updateSettings AND persists to disk (it is config, not a secret)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-sysprompt-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const store = new JanusStore(":memory:");
    store.init();
    const m = new OrchestratorManager({ ledger: store });
    const customPrompt = "custom voice prompt {{activeProjectId}}";
    // Set both a secret AND the system prompt in the same update.
    m.updateSettings({
      secrets: { geminiApiKey: FAKE_KEY },
      voiceAi: { systemPrompt: customPrompt } as any,
    });
    // In-memory merge keeps the system prompt (updateSettings merges voiceAi).
    assert.strictEqual(m.settings.voiceAi.systemPrompt, customPrompt, "systemPrompt is merged into in-memory settings");
    // On disk: the secret is blanked but the system prompt PERSISTS (unlike geminiApiKey).
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, ".janus_settings.json"), "utf8"));
    assert.strictEqual(onDisk.secrets?.geminiApiKey ?? "", "", "the Gemini key must NOT persist");
    assert.strictEqual(onDisk.voiceAi?.systemPrompt, customPrompt, "voiceAi.systemPrompt MUST persist to disk — it is config, not a secret");
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the JSON->SQLite migration imports config but NEVER stores secrets in settings_kv", () => {
  const store = new JanusStore(":memory:");
  store.init();
  try {
    migrateFromObjects(store, {
      settings: { voiceAi: { model: "gemini-x" }, secrets: { geminiApiKey: FAKE_KEY } },
    });
    // Non-secret config IS migrated to the durable store...
    assert.strictEqual(store.getSettings("voiceAi.model"), "gemini-x", "non-secret config migrates to settings_kv");
    // ...but the secret is NEVER written to the durable store (this is what leaked the key into .janus.db).
    assert.strictEqual(store.getSettings("secrets.geminiApiKey"), null, "the Gemini key must NOT land in the SQLite settings_kv");
  } finally {
    store.close();
  }
});
