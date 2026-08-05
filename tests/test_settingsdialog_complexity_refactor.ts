/**
 * Pure-helper unit tests for the SettingsDialog cyclomatic-complexity refactor.
 *
 * The refactor relocated SettingsDialog.tsx's pure logic (preset rebuild literals, initial-settings
 * default resolution, JSON-tab value derivation, terminal⇄preset matching, preset status/footprint
 * formatting, and the tab className builders) into src/components/settingsDialogHelpers.ts. These
 * tests import the REAL helpers (no mirror copies) and pin every branch so the behavior is locked
 * GREEN before and after the .tsx refactor. They are pure function calls — no DOM / React.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildPresetFromArrayItem,
  presetDisplayName,
  buildPresetFromObjectEntry,
  deriveServerFields,
  deriveVoiceFields,
  deriveProjectFields,
  deriveAdvancedFields,
  coerceSynthStatus,
  jsonServerPatch,
  jsonVoicePatch,
  jsonProjectsPatch,
  jsonAdvancedPatch,
  jsonHasAdvancedGates,
  mergeAnnouncements,
  terminalMatchesPreset,
  derivePresetStatus,
  formatContextFootprint,
  topTabClass,
  subTabClass,
  secretsTabClass,
} from "../src/components/settingsDialogHelpers";

// ─── buildPresetFromArrayItem ─────────────────────────────────────────────────
describe("buildPresetFromArrayItem", () => {
  it("applies all defaults for an empty/undefined item", () => {
    const p = buildPresetFromArrayItem(undefined);
    assert.deepEqual(p, {
      id: "",
      name: "",
      command: "",
      enabled: true,
      permissionsMode: "Human-in-the-Loop",
      windowMode: "Standard Split-Pane",
      visualTheme: "Default Green Mono",
      persistentRestore: false,
      dangerouslySkipPermissions: false,
      sessionResume: true,
      portOffset: "",
      customEnvVars: "",
    });
  });

  it("coerces and preserves provided values", () => {
    const p = buildPresetFromArrayItem({
      id: 42,
      name: "My Shell",
      command: "zsh",
      enabled: false,
      permissionsMode: "Full Auto",
      windowMode: "Side Dock Panel",
      visualTheme: "Cosmic Slate",
      persistentRestore: true,
      dangerouslySkipPermissions: true,
      sessionResume: false,
      portOffset: 8080,
      customEnvVars: "A=1",
    });
    assert.equal(p.id, "42");
    assert.equal(p.name, "My Shell");
    assert.equal(p.command, "zsh");
    assert.equal(p.enabled, false);
    assert.equal(p.permissionsMode, "Full Auto");
    assert.equal(p.windowMode, "Side Dock Panel");
    assert.equal(p.visualTheme, "Cosmic Slate");
    assert.equal(p.persistentRestore, true);
    assert.equal(p.dangerouslySkipPermissions, true);
    assert.equal(p.sessionResume, false);
    assert.equal(p.portOffset, "8080");
    assert.equal(p.customEnvVars, "A=1");
  });

  it("enabled/sessionResume default to true only when nullish (not when false)", () => {
    assert.equal(buildPresetFromArrayItem({ enabled: false }).enabled, false);
    assert.equal(buildPresetFromArrayItem({ enabled: undefined }).enabled, true);
    assert.equal(buildPresetFromArrayItem({ sessionResume: false }).sessionResume, false);
  });

  it("portOffset/customEnvVars become '' when absent, '0' is stringified (not dropped)", () => {
    assert.equal(buildPresetFromArrayItem({ portOffset: 0 }).portOffset, "0");
    assert.equal(buildPresetFromArrayItem({}).portOffset, "");
  });
});

// ─── presetDisplayName ────────────────────────────────────────────────────────
describe("presetDisplayName", () => {
  it("maps the three known keys", () => {
    assert.equal(presetDisplayName("claudeCode"), "Claude Code");
    assert.equal(presetDisplayName("codex"), "Codex CLI");
    assert.equal(presetDisplayName("antigravity"), "Antigravity Agent");
  });
  it("title-cases an unknown key", () => {
    assert.equal(presetDisplayName("foo"), "Foo");
    assert.equal(presetDisplayName("bar"), "Bar");
  });
  it("empty key returns empty string", () => {
    assert.equal(presetDisplayName(""), "");
  });
});

// ─── buildPresetFromObjectEntry ───────────────────────────────────────────────
describe("buildPresetFromObjectEntry", () => {
  it("uses key as id and display name fallback", () => {
    const p = buildPresetFromObjectEntry("claudeCode", {});
    assert.equal(p.id, "claudeCode");
    assert.equal(p.name, "Claude Code");
  });
  it("prefers explicit name over display fallback", () => {
    const p = buildPresetFromObjectEntry("codex", { name: "Custom" });
    assert.equal(p.name, "Custom");
  });
  it("defaults match the array form for an empty value", () => {
    const p = buildPresetFromObjectEntry("foo", undefined);
    assert.equal(p.id, "foo");
    assert.equal(p.name, "Foo");
    assert.equal(p.command, "");
    assert.equal(p.enabled, true);
    assert.equal(p.permissionsMode, "Human-in-the-Loop");
    assert.equal(p.sessionResume, true);
    assert.equal(p.portOffset, "");
  });
});

// ─── deriveServerFields ───────────────────────────────────────────────────────
describe("deriveServerFields", () => {
  it("defaults for null settings", () => {
    assert.deepEqual(deriveServerFields(null), { port: 3000, host: "0.0.0.0", appUrl: "" });
  });
  it("passes through provided values, including falsy ones (port 0, empty host)", () => {
    const r = deriveServerFields({ server: { port: 0, host: "", appUrl: "x" } } as any);
    assert.equal(r.port, 0);
    assert.equal(r.host, "");
    assert.equal(r.appUrl, "x");
  });
});

// ─── deriveVoiceFields ────────────────────────────────────────────────────────
describe("deriveVoiceFields", () => {
  it("all defaults for null", () => {
    assert.deepEqual(deriveVoiceFields(null), {
      voice: "Zephyr",
      voiceStyle: "Creative",
      volume: 80,
      isMicMuted: false,
      model: "gemini-3.1-flash-live-preview",
      systemPrompt: "",
      groundingEnabled: false,
      silenceGate: false,
      // fikj.12: the D4 dial fields ride the voice group; absent settings resolve to the spec
      // defaults (tests/test_delivery_dial_settings.ts pins the derivation itself).
      deliveryMatrix: { "0": "forced-turn", "2": "forced-turn", "3": "steered-digest", "4": "steered-digest", "5": "passive-context" },
      completionAnnounce: "dispatched",
    });
  });
  it("preserves provided values incl. volume 0 and explicit false toggles", () => {
    const r = deriveVoiceFields({
      voiceAi: { voice: "Puck", voiceStyle: "Direct", volume: 0, isMicMuted: true, model: "m", systemPrompt: "p", groundingEnabled: true, silenceGate: true },
    } as any);
    assert.equal(r.voice, "Puck");
    assert.equal(r.voiceStyle, "Direct");
    assert.equal(r.volume, 0);
    assert.equal(r.isMicMuted, true);
    assert.equal(r.model, "m");
    assert.equal(r.systemPrompt, "p");
    assert.equal(r.groundingEnabled, true);
    assert.equal(r.silenceGate, true);
  });
});

// ─── deriveProjectFields ──────────────────────────────────────────────────────
describe("deriveProjectFields", () => {
  it("defaults for null", () => {
    assert.deepEqual(deriveProjectFields(null), { activeContext: "default_project", localWorkspacePath: "" });
  });
  it("passes provided values", () => {
    const r = deriveProjectFields({ projects: { activeContext: "proj", localWorkspacePath: "/tmp" } } as any);
    assert.equal(r.activeContext, "proj");
    assert.equal(r.localWorkspacePath, "/tmp");
  });
});

// ─── deriveAdvancedFields ─────────────────────────────────────────────────────
describe("deriveAdvancedFields", () => {
  it("all defaults for null", () => {
    assert.deepEqual(deriveAdvancedFields(null), {
      maxBufferLines: 100,
      idleTimeoutMs: 2000,
      agentIdleTimeoutMs: 3500,
      defaultShellCommand: "bash",
      globalPermissionsMode: "Inherit",
      historyMaxCommands: 50,
      historyMaxOutputLength: 5000,
      memoryPythonEnabled: true,
      memorySynthTimeoutMs: 150,
    });
  });
  it("preserves provided values incl. memoryPythonEnabled=false and timeout 0", () => {
    const r = deriveAdvancedFields({
      advanced: { maxBufferLines: 1, idleTimeoutMs: 2, agentIdleTimeoutMs: 3, defaultShellCommand: "sh", globalPermissionsMode: "Read-Only", historyMaxCommands: 4, historyMaxOutputLength: 5, memoryPythonEnabled: false, memorySynthTimeoutMs: 0 },
    } as any);
    assert.equal(r.maxBufferLines, 1);
    assert.equal(r.defaultShellCommand, "sh");
    assert.equal(r.globalPermissionsMode, "Read-Only");
    assert.equal(r.memoryPythonEnabled, false);
    assert.equal(r.memorySynthTimeoutMs, 0); // derive does NOT clamp; only the JSON patch clamps
  });
});

// ─── coerceSynthStatus ────────────────────────────────────────────────────────
describe("coerceSynthStatus", () => {
  it("python/fallback pass through", () => {
    assert.equal(coerceSynthStatus("python"), "python");
    assert.equal(coerceSynthStatus("fallback"), "fallback");
  });
  it("anything else → unknown", () => {
    assert.equal(coerceSynthStatus("unknown"), "unknown");
    assert.equal(coerceSynthStatus(undefined), "unknown");
    assert.equal(coerceSynthStatus(null), "unknown");
    assert.equal(coerceSynthStatus("xyz"), "unknown");
  });
});

// ─── jsonServerPatch ──────────────────────────────────────────────────────────
describe("jsonServerPatch", () => {
  it("absent server → empty patch", () => {
    assert.deepEqual(jsonServerPatch({}), {});
  });
  it("only defined keys are copied", () => {
    assert.deepEqual(jsonServerPatch({ server: { port: 1 } }), { port: 1 });
    assert.deepEqual(jsonServerPatch({ server: { port: 1, host: "h", appUrl: "u" } }), { port: 1, host: "h", appUrl: "u" });
  });
  it("undefined keys are not copied", () => {
    assert.deepEqual(jsonServerPatch({ server: { port: undefined, host: "h" } }), { host: "h" });
  });
});

// ─── jsonVoicePatch ───────────────────────────────────────────────────────────
describe("jsonVoicePatch", () => {
  it("absent voiceAi → empty patch", () => {
    assert.deepEqual(jsonVoicePatch({}), {});
  });
  it("plain-copy fields", () => {
    assert.deepEqual(jsonVoicePatch({ voiceAi: { voice: "x", volume: 3 } }), { voice: "x", volume: 3 });
  });
  it("systemPrompt null coerces to ''", () => {
    assert.deepEqual(jsonVoicePatch({ voiceAi: { systemPrompt: null } }), { systemPrompt: "" });
    assert.deepEqual(jsonVoicePatch({ voiceAi: { systemPrompt: "p" } }), { systemPrompt: "p" });
  });
  it("grounding/silence coerce to boolean", () => {
    assert.deepEqual(jsonVoicePatch({ voiceAi: { groundingEnabled: 1, silenceGate: 0 } }), { groundingEnabled: true, silenceGate: false });
  });
  it("absent coerced fields are omitted (not forced false)", () => {
    const r = jsonVoicePatch({ voiceAi: { voice: "x" } });
    assert.equal("groundingEnabled" in r, false);
    assert.equal("systemPrompt" in r, false);
  });
});

// ─── jsonProjectsPatch ────────────────────────────────────────────────────────
describe("jsonProjectsPatch", () => {
  it("absent → empty", () => {
    assert.deepEqual(jsonProjectsPatch({}), {});
  });
  it("copies defined keys", () => {
    assert.deepEqual(jsonProjectsPatch({ projects: { activeContext: "a" } }), { activeContext: "a" });
  });
});

// ─── jsonAdvancedPatch ────────────────────────────────────────────────────────
describe("jsonAdvancedPatch", () => {
  it("absent → empty", () => {
    assert.deepEqual(jsonAdvancedPatch({}), {});
  });
  it("copies plain numeric/string fields", () => {
    assert.deepEqual(jsonAdvancedPatch({ advanced: { maxBufferLines: 9, defaultShellCommand: "sh" } }), {
      maxBufferLines: 9,
      defaultShellCommand: "sh",
    });
  });
  it("memoryPythonEnabled coerces to boolean", () => {
    assert.deepEqual(jsonAdvancedPatch({ advanced: { memoryPythonEnabled: 1 } }), { memoryPythonEnabled: true });
    assert.deepEqual(jsonAdvancedPatch({ advanced: { memoryPythonEnabled: 0 } }), { memoryPythonEnabled: false });
  });
  it("memorySynthTimeoutMs clamps: valid positive kept", () => {
    assert.deepEqual(jsonAdvancedPatch({ advanced: { memorySynthTimeoutMs: 300 } }), { memorySynthTimeoutMs: 300 });
  });
  it("memorySynthTimeoutMs clamps 0/negative/NaN/non-finite to 150", () => {
    assert.deepEqual(jsonAdvancedPatch({ advanced: { memorySynthTimeoutMs: 0 } }), { memorySynthTimeoutMs: 150 });
    assert.deepEqual(jsonAdvancedPatch({ advanced: { memorySynthTimeoutMs: -5 } }), { memorySynthTimeoutMs: 150 });
    assert.deepEqual(jsonAdvancedPatch({ advanced: { memorySynthTimeoutMs: "abc" } }), { memorySynthTimeoutMs: 150 });
    assert.deepEqual(jsonAdvancedPatch({ advanced: { memorySynthTimeoutMs: "250" } }), { memorySynthTimeoutMs: 250 });
  });
  it("does NOT carry capabilityGates (handled separately)", () => {
    const r = jsonAdvancedPatch({ advanced: { capabilityGates: { write_to_pane: "Auto" } } });
    assert.equal("capabilityGates" in r, false);
  });
});

// ─── jsonHasAdvancedGates ─────────────────────────────────────────────────────
describe("jsonHasAdvancedGates", () => {
  it("true only when advanced.capabilityGates is present", () => {
    assert.equal(jsonHasAdvancedGates({ advanced: { capabilityGates: {} } }), true);
    assert.equal(jsonHasAdvancedGates({ advanced: {} }), false);
    assert.equal(jsonHasAdvancedGates({}), false);
    assert.equal(jsonHasAdvancedGates({ advanced: { capabilityGates: undefined } }), false);
  });
});

// ─── mergeAnnouncements ───────────────────────────────────────────────────────
describe("mergeAnnouncements", () => {
  it("merges parsed over prev (parsed wins)", () => {
    assert.deepEqual(mergeAnnouncements({ a: "1", b: "2" }, { b: "9" }), { a: "1", b: "9" });
  });
  it("undefined/empty parsed leaves prev intact", () => {
    assert.deepEqual(mergeAnnouncements({ a: "1" }, undefined), { a: "1" });
    assert.deepEqual(mergeAnnouncements({ a: "1" }, {}), { a: "1" });
  });
});

// ─── terminalMatchesPreset ────────────────────────────────────────────────────
describe("terminalMatchesPreset", () => {
  const preset = (id: string, name = "n", command = "cmd") => ({ id, name, command } as any);
  const term = (o: any) => ({ tool_preset: "", id: "", command: "", ...o });

  it("alias: claudeCode ↔ 'claude code'", () => {
    assert.equal(terminalMatchesPreset(term({ tool_preset: "Claude Code" }), preset("claudeCode")), true);
  });
  it("alias: codex ↔ 'codex'", () => {
    assert.equal(terminalMatchesPreset(term({ tool_preset: "Codex" }), preset("codex")), true);
  });
  it("alias: antigravity ↔ 'antigravity'", () => {
    assert.equal(terminalMatchesPreset(term({ tool_preset: "Antigravity" }), preset("antigravity")), true);
  });
  it("tool_preset equals preset name (case-insensitive)", () => {
    assert.equal(terminalMatchesPreset(term({ tool_preset: "MyShell" }), preset("x", "myshell")), true);
  });
  it("terminal id contains preset id", () => {
    assert.equal(terminalMatchesPreset(term({ id: "abc-x-1" }), preset("x", "zzz", "nomatch")), true);
  });
  it("terminal id contains preset name", () => {
    assert.equal(terminalMatchesPreset(term({ id: "node-myname" }), preset("zzz", "myname", "nomatch")), true);
  });
  it("command substring fallback", () => {
    assert.equal(terminalMatchesPreset(term({ id: "zzz", command: "run bash now" }), preset("q", "q", "bash")), true);
  });
  it("no match → false", () => {
    assert.equal(terminalMatchesPreset(term({ id: "aaa", tool_preset: "ppp", command: "ccc" }), preset("xxx", "yyy", "zzz")), false);
  });
  it("null tool_preset does not throw", () => {
    assert.equal(terminalMatchesPreset(term({ tool_preset: null, id: "no", command: "no" }), preset("xxx", "yyy", "zzz")), false);
  });
});

// ─── derivePresetStatus ───────────────────────────────────────────────────────
describe("derivePresetStatus", () => {
  it("no active → 'No Live Processes'", () => {
    const r = derivePresetStatus({ numActive: 0, hasAlert: false, anyRunning: false });
    assert.equal(r.statusLabel, "No Live Processes");
    assert.match(r.statusBadgeStyle, /text-zinc-500/);
    assert.equal(r.dotColor, "bg-zinc-600");
  });
  it("alert takes priority", () => {
    const r = derivePresetStatus({ numActive: 2, hasAlert: true, anyRunning: true });
    assert.match(r.statusLabel, /ALERT: AWAITING APPROVAL/);
    assert.equal(r.dotColor, "bg-amber-500 animate-ping");
  });
  it("running when active, no alert, anyRunning", () => {
    const r = derivePresetStatus({ numActive: 1, hasAlert: false, anyRunning: true });
    assert.match(r.statusLabel, /RUNNING ACTIVE COMMAND/);
    assert.equal(r.dotColor, "bg-green-500 animate-pulse");
  });
  it("idle when active, no alert, not running", () => {
    const r = derivePresetStatus({ numActive: 1, hasAlert: false, anyRunning: false });
    assert.match(r.statusLabel, /IDLE OPERATING READY/);
    assert.equal(r.dotColor, "bg-yellow-500");
  });
});

// ─── formatContextFootprint ───────────────────────────────────────────────────
describe("formatContextFootprint", () => {
  it("under 1000 chars: raw ch + token count", () => {
    assert.equal(formatContextFootprint(0), "0 ch (~0 t)");
    assert.equal(formatContextFootprint(400), "400 ch (~100 t)");
  });
  it("ch crosses into k but tokens still < 1000", () => {
    assert.equal(formatContextFootprint(2000), "2.0k ch (~500 t)");
  });
  it("both ch and tokens in k range", () => {
    assert.equal(formatContextFootprint(8000), "8.0k ch (~2.0k t)");
  });
  it("token estimate uses ceil of /4", () => {
    assert.equal(formatContextFootprint(5), "5 ch (~2 t)");
  });
});

// ─── className builders ───────────────────────────────────────────────────────
describe("topTabClass", () => {
  it("active vs inactive differ and share the base", () => {
    const a = topTabClass(true);
    const i = topTabClass(false);
    assert.match(a, /px-4 py-3 border-b-2/);
    assert.match(a, /border-cyan-500 text-cyan-400/);
    assert.match(i, /border-transparent text-zinc-400/);
    assert.notEqual(a, i);
  });
});

describe("subTabClass", () => {
  it("active highlights cyan; inactive is transparent", () => {
    assert.match(subTabClass(true), /bg-cyan-950\/40 border border-cyan-500\/20 text-cyan-400 font-bold/);
    assert.match(subTabClass(false), /border border-transparent text-zinc-400/);
  });
});

describe("secretsTabClass", () => {
  it("active highlights red/rose; inactive is transparent", () => {
    assert.match(secretsTabClass(true), /bg-red-950\/30 border border-red-500\/20 text-rose-400 font-bold/);
    assert.match(secretsTabClass(false), /border border-transparent text-zinc-400/);
  });
});
