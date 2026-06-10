// Phase 2 Track S — CARD 2S.1: a PARTIAL settings PUT must not open the safety gates.
//
// PINS THE FAIL-OPEN BUG: OrchestratorManager.updateSettings did a SHALLOW merge of
// `advanced` — a PUT carrying a partial `capabilityGates` map REPLACED the whole matrix,
// and every capability missing from the PUT then resolved through the permissive fallback
// (resolveCapabilityGateWithContext: globalGate ?? "Auto"). loadSettings already deep-merges
// DEFAULT_CAPABILITY_GATES under the parsed file; updateSettings must mirror that exactly.
//
// ALSO pins: DEFAULT_CAPABILITY_GATES carries clear_history: "Ask" (CAPABILITY_DEFS declares
// defaultGate "Ask" for clear_history — the default map omitted it, so it fell open to Auto).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { OrchestratorManager } from "../src/terminal";
import { DEFAULT_CAPABILITY_GATES } from "../src/types";
import { resolveCapabilityGateWithContext } from "../src/pendingApprovals";

let tmpDir: string;
let prevSettingsPath: string | undefined;

before(() => {
  // The manager persists settings on every updateSettings(); anchor the file in a tmp dir so the
  // suite never writes into the repo working tree.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-upd-gates-"));
  prevSettingsPath = process.env.JANUS_SETTINGS_PATH;
  process.env.JANUS_SETTINGS_PATH = path.join(tmpDir, ".janus_settings.json");
});

after(() => {
  if (prevSettingsPath === undefined) delete process.env.JANUS_SETTINGS_PATH;
  else process.env.JANUS_SETTINGS_PATH = prevSettingsPath;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("2S.1 — partial settings PUT cannot open the safety gates", () => {
  it("DEFAULT_CAPABILITY_GATES pins clear_history to Ask (parity with CAPABILITY_DEFS defaultGate)", () => {
    assert.strictEqual(
      DEFAULT_CAPABILITY_GATES.clear_history,
      "Ask",
      "clear_history must default Ask in the global matrix (CAPABILITY_DEFS declares defaultGate 'Ask')",
    );
  });

  it("updateSettings with a PARTIAL capabilityGates map keeps every unmentioned default (no fail-open)", () => {
    const m = new OrchestratorManager();
    // Sanity: the fresh default matrix has the sharp edges gated Ask.
    assert.strictEqual(m.settings.advanced.capabilityGates?.delete_project, "Ask");

    // The PUT-shaped partial update: ONE gate mentioned, everything else absent.
    m.updateSettings({ advanced: { capabilityGates: { write_to_pane: "Auto" } } as any });

    const gates = m.settings.advanced.capabilityGates!;
    assert.strictEqual(gates.write_to_pane, "Auto", "the mentioned gate lands");
    // The unmentioned sharp-edge defaults MUST survive the partial update.
    assert.strictEqual(gates.delete_project, "Ask", "delete_project stays Ask after a partial gates PUT");
    assert.strictEqual(gates.close_pane, "Ask", "close_pane stays Ask after a partial gates PUT");
    assert.strictEqual(gates.set_global_permissions, "Ask", "set_global_permissions stays Ask");
    assert.strictEqual(gates.clear_history, "Ask", "clear_history stays Ask after a partial gates PUT");

    // And the RESOLVER (the consumer of this map) no longer falls through to the permissive
    // "Auto" fallback for an unmentioned capability.
    assert.strictEqual(
      resolveCapabilityGateWithContext(undefined, gates.delete_project, "delete_project", false),
      "Ask",
      "delete_project resolves Ask (not the permissive Auto fallback) after a partial gates PUT",
    );
  });

  it("an advanced update that carries NO capabilityGates leaves the existing matrix untouched", () => {
    const m = new OrchestratorManager();
    m.updateSettings({ advanced: { capabilityGates: { write_to_pane: "Off" } } as any });
    m.updateSettings({ advanced: { maxBufferLines: 1234 } as any });
    const gates = m.settings.advanced.capabilityGates!;
    assert.strictEqual(gates.write_to_pane, "Off", "a non-gates advanced update preserves the prior override");
    assert.strictEqual(gates.delete_project, "Ask", "…and the defaults");
    assert.strictEqual(m.settings.advanced.maxBufferLines, 1234, "the non-gates field landed");
  });
});
