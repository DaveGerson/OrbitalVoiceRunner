// tests/test_voice_ux_settings.ts — the voiceUx settings block (voice-UX wave 3, scaffold-owned).
// Pins: (1) DEFAULT_VOICE_UX values, (2) getDefaultSettings()/loadSettings() shallow-merge (same
// idiom as voiceAi — a persisted file without voiceUx, or with only SOME keys set, still gets the
// DEFAULT_VOICE_UX floor for the rest), (3) validateSettingsPutBody's voiceUx strict-when-present
// validation + forward-compat unknown-key strip (server.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { DEFAULT_VOICE_UX } from "../src/types";
import { REGISTRY } from "../src/actions/registry";

function newManager(): OrchestratorManager {
  const store = new JanusStore(":memory:");
  store.init();
  return new OrchestratorManager({ ledger: store });
}

function inTmpCwd<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-voiceux-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("DEFAULT_VOICE_UX matches the spec defaults", () => {
  assert.deepEqual(DEFAULT_VOICE_UX, {
    sitrepShape: "brief",
    focusBindPolicy: "confirm",
    confirmTimeoutMs: 10_000,
  });
});

test("getDefaultSettings().voiceUx is a fresh DEFAULT_VOICE_UX copy (fresh boot, no persisted file)", () => {
  inTmpCwd(() => {
    const m = newManager();
    assert.deepEqual(m.settings.voiceUx, DEFAULT_VOICE_UX);
  });
});

test("loadSettings: a persisted file with NO voiceUx key still gets the DEFAULT_VOICE_UX floor", () => {
  inTmpCwd(() => {
    const m = newManager();
    const settingsPath = m.getSettingsFilePath();
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    delete onDisk.voiceUx;
    fs.writeFileSync(settingsPath, JSON.stringify(onDisk, null, 2), "utf-8");
    m.loadSettings();
    assert.deepEqual(m.settings.voiceUx, DEFAULT_VOICE_UX);
  });
});

test("loadSettings: a persisted PARTIAL voiceUx shallow-merges over DEFAULT_VOICE_UX (same idiom as voiceAi)", () => {
  inTmpCwd(() => {
    const m = newManager();
    const settingsPath = m.getSettingsFilePath();
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    onDisk.voiceUx = { sitrepShape: "full" };
    fs.writeFileSync(settingsPath, JSON.stringify(onDisk, null, 2), "utf-8");
    m.loadSettings();
    assert.deepEqual(m.settings.voiceUx, {
      sitrepShape: "full",
      focusBindPolicy: DEFAULT_VOICE_UX.focusBindPolicy,
      confirmTimeoutMs: DEFAULT_VOICE_UX.confirmTimeoutMs,
    });
  });
});

test("loadSettings: a fully-overridden voiceUx round-trips exactly", () => {
  inTmpCwd(() => {
    const m = newManager();
    const settingsPath = m.getSettingsFilePath();
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    onDisk.voiceUx = { sitrepShape: "walk", focusBindPolicy: "echo", confirmTimeoutMs: 5000 };
    fs.writeFileSync(settingsPath, JSON.stringify(onDisk, null, 2), "utf-8");
    m.loadSettings();
    assert.deepEqual(m.settings.voiceUx, { sitrepShape: "walk", focusBindPolicy: "echo", confirmTimeoutMs: 5000 });
  });
});

// ── server.ts validateSettingsPutBody — voiceUx strict-when-present validation ──────────────────
test("validateSettingsPutBody: voiceUx absent is accepted", async () => {
  const { validateSettingsPutBody } = await import("../server");
  assert.deepEqual(validateSettingsPutBody({}), { ok: true });
});

test("validateSettingsPutBody: a non-object voiceUx is rejected naming the field", async () => {
  const { validateSettingsPutBody } = await import("../server");
  for (const bad of [null, 5, "x", [1]]) {
    const r = validateSettingsPutBody({ voiceUx: bad });
    assert.equal(r.ok, false);
    assert.equal(r.error, "Invalid settings field 'voiceUx': expected an object.");
  }
});

test("validateSettingsPutBody: an invalid sitrepShape is rejected naming the field", async () => {
  const { validateSettingsPutBody } = await import("../server");
  const r = validateSettingsPutBody({ voiceUx: { sitrepShape: "verbose" } });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /^Invalid settings field 'voiceUx\.sitrepShape': must be one of /);
});

test("validateSettingsPutBody: an invalid focusBindPolicy is rejected naming the field", async () => {
  const { validateSettingsPutBody } = await import("../server");
  const r = validateSettingsPutBody({ voiceUx: { focusBindPolicy: "auto" } });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /^Invalid settings field 'voiceUx\.focusBindPolicy': must be one of /);
});

test("validateSettingsPutBody: confirmTimeoutMs out of [1000,120000] is rejected", async () => {
  const { validateSettingsPutBody } = await import("../server");
  for (const bad of [999, 120_001, NaN, Infinity, -1, "10000"]) {
    const r = validateSettingsPutBody({ voiceUx: { confirmTimeoutMs: bad } });
    assert.equal(r.ok, false, `expected rejection for confirmTimeoutMs=${bad}`);
    assert.equal(r.error, "Invalid settings field 'voiceUx.confirmTimeoutMs': must be a finite number between 1000 and 120000.");
  }
});

test("validateSettingsPutBody: valid voiceUx values (boundary-inclusive) are accepted", async () => {
  const { validateSettingsPutBody } = await import("../server");
  for (const shape of ["brief", "walk", "full"]) {
    assert.deepEqual(validateSettingsPutBody({ voiceUx: { sitrepShape: shape } }), { ok: true }, shape);
  }
  for (const policy of ["confirm", "echo", "tiered"]) {
    assert.deepEqual(validateSettingsPutBody({ voiceUx: { focusBindPolicy: policy } }), { ok: true }, policy);
  }
  for (const ms of [1000, 120_000, 10_000]) {
    assert.deepEqual(validateSettingsPutBody({ voiceUx: { confirmTimeoutMs: ms } }), { ok: true }, String(ms));
  }
});

test("validateSettingsPutBody: UNKNOWN voiceUx keys are STRIPPED in place (forward compat), never 400", () => {
  return (async () => {
    const { validateSettingsPutBody } = await import("../server");
    const voiceUx: Record<string, unknown> = { sitrepShape: "brief", someFutureKnob: true };
    const r = validateSettingsPutBody({ voiceUx });
    assert.deepEqual(r, { ok: true });
    assert.ok(!("someFutureKnob" in voiceUx), "unknown key stripped from the body object");
    assert.equal(voiceUx.sitrepShape, "brief", "known key preserved");
  })();
});

// ── registry wiring sanity (the two voice-UX wave 3 tool defs land exactly once) ────────────────
test("REGISTRY contains get_status_summary (voice-only, ALWAYS_ALLOWED, stub handler wired)", () => {
  const def = REGISTRY.find((d) => d.name === "get_status_summary");
  assert.ok(def, "get_status_summary must be registered");
  assert.equal(def!.capability, "ALWAYS_ALLOWED");
  assert.deepEqual([...def!.surfaces], ["voice"]);
});

test("REGISTRY contains focus_pane (voice-only, capability focus_pane, stub handler wired)", () => {
  const def = REGISTRY.find((d) => d.name === "focus_pane");
  assert.ok(def, "focus_pane must be registered");
  assert.equal(def!.capability, "focus_pane");
  assert.deepEqual([...def!.surfaces], ["voice"]);
});

test("validateSettingsPutBody: combined advanced + voiceUx errors — advanced is checked first", async () => {
  const { validateSettingsPutBody } = await import("../server");
  const r = validateSettingsPutBody({
    advanced: { globalPermissionsMode: "YOLO" },
    voiceUx: { sitrepShape: "verbose" },
  });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /advanced\.globalPermissionsMode/);
});
