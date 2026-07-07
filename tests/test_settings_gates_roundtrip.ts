// Settings capabilityGates round-trip regression suite (bead 8sq BACKEND slice, spec §3 / §2.B).
//
// PINS THE DROP-ON-SAVE DATA-LOSS BUG: before the fix, SettingsDialog.getCompiledSettings()
// rebuilt `advanced` from a literal that omitted capabilityGates, and parsePresetsSafe() rebuilt
// each preset field-by-field dropping per-preset capabilityGates. Every save SILENTLY ERASED both
// the global default matrix and every per-preset matrix.
//
// The fix extracts the gate-preserving logic into src/settingsGatesRoundTrip.ts (pure, frontend-
// safe) and has SettingsDialog delegate to it. This suite asserts those pure helpers preserve the
// gates so a save->reload no longer loses them — across both scopes (global advanced + per-preset).

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizeGateMap,
  preservePresetGates,
  withAdvancedGates,
  preservePostureProfiles,
  normalizePostureProfiles,
} from "../src/settingsGatesRoundTrip";
import { parsePresetsSafe as serverParsePresetsSafe } from "../src/terminal";
import { SEED_POSTURE_PROFILES } from "../src/types";
import type { CliPreset, PostureProfile } from "../src/types";

describe("settings capabilityGates round-trip (drop-on-save regression)", () => {
  describe("normalizeGateMap", () => {
    it("keeps only valid Auto/Ask/Off values", () => {
      const out = normalizeGateMap({ write_to_pane: "Ask", close_pane: "Off", bogus: "Maybe", n: 3 });
      assert.deepStrictEqual(out, { write_to_pane: "Ask", close_pane: "Off" });
    });
    it("normalizes an empty/absent map to undefined (never persists a masking {})", () => {
      assert.strictEqual(normalizeGateMap(undefined), undefined);
      assert.strictEqual(normalizeGateMap(null), undefined);
      assert.strictEqual(normalizeGateMap({}), undefined);
      assert.strictEqual(normalizeGateMap({ x: "nope" }), undefined);
    });
  });

  describe("preservePresetGates (per-preset scope)", () => {
    it("carries a preset's capabilityGates through the field-by-field rebuild", () => {
      // Simulate parsePresetsSafe: the rebuilt preset has NO capabilityGates (the bug),
      // but the raw source DID carry them.
      const rebuilt: CliPreset = { id: "claude", name: "Claude Code", command: "claude", enabled: true };
      const rawSource = { id: "claude", capabilityGates: { write_to_pane: "Auto", close_pane: "Ask" } };
      const out = preservePresetGates(rebuilt, rawSource);
      assert.deepStrictEqual(out.capabilityGates, { write_to_pane: "Auto", close_pane: "Ask" });
      // The other fields are untouched.
      assert.strictEqual(out.command, "claude");
    });
    it("leaves a preset without source gates unchanged (no empty map injected)", () => {
      const rebuilt: CliPreset = { id: "codex", name: "Codex", command: "codex", enabled: true };
      const out = preservePresetGates(rebuilt, { id: "codex" });
      assert.strictEqual(out.capabilityGates, undefined);
    });

    it("full parsePresetsSafe-shaped round-trip preserves gates per preset", () => {
      // The exact shape parsePresetsSafe consumes: an array of raw preset objects with gates.
      const rawPresets = [
        { id: "a", name: "A", command: "a", enabled: true, capabilityGates: { write_to_pane: "Off" } },
        { id: "b", name: "B", command: "b", enabled: true }, // no gates
      ];
      const parsed = rawPresets.map((item) =>
        preservePresetGates(
          { id: String(item.id), name: item.name, command: item.command, enabled: item.enabled },
          item,
        ),
      );
      assert.deepStrictEqual(parsed[0].capabilityGates, { write_to_pane: "Off" });
      assert.strictEqual(parsed[1].capabilityGates, undefined);
    });
  });

  describe("withAdvancedGates (global default scope)", () => {
    it("re-attaches the global default matrix to a freshly-built advanced literal", () => {
      const advanced = { globalPermissionsMode: "Inherit", maxBufferLines: 100 };
      const out = withAdvancedGates(advanced, { write_to_pane: "Ask", set_global_permissions: "Ask" });
      assert.deepStrictEqual(out.capabilityGates, { write_to_pane: "Ask", set_global_permissions: "Ask" });
      // Pre-existing advanced fields survive.
      assert.strictEqual(out.globalPermissionsMode, "Inherit");
      assert.strictEqual(out.maxBufferLines, 100);
    });
    it("omits capabilityGates entirely when there is no matrix (back-compat: absent => all Auto)", () => {
      const out = withAdvancedGates({ globalPermissionsMode: "Inherit" }, undefined);
      assert.ok(!("capabilityGates" in out), "no empty capabilityGates key injected");
    });
  });

  // f09.3: the SAME silent-erase class for the new advanced.postureProfiles field. The landmine is
  // identical — getCompiledSettings rebuilds `advanced` from a literal that omits postureProfiles, so
  // without preservePostureProfiles every save would delete the operator's saved profiles.
  describe("preservePostureProfiles (f09.3 posture profiles round-trip)", () => {
    it("re-attaches operator-saved profiles to a freshly-built advanced literal", () => {
      const advanced = { globalPermissionsMode: "Inherit", capabilityGates: { write_to_pane: "Off" } };
      const profiles: PostureProfile[] = [{ name: "Night shift", capabilityGates: { write_to_pane: "Off", close_pane: "Off" } }];
      const out = preservePostureProfiles(advanced, profiles);
      assert.deepStrictEqual(out.postureProfiles, profiles, "profiles carried through the rebuild");
      // A save with BOTH present must erase NEITHER (the landmine guard extended).
      assert.deepStrictEqual(out.capabilityGates, { write_to_pane: "Off" }, "capabilityGates untouched by the profiles carry");
    });

    it("preserves the three seeds PLUS a custom through the round-trip when all are present", () => {
      const withSeeds: PostureProfile[] = [...SEED_POSTURE_PROFILES, { name: "Custom", capabilityGates: { write_to_pane: "Auto" } }];
      const out = preservePostureProfiles({ globalPermissionsMode: "Inherit" }, withSeeds);
      assert.strictEqual(out.postureProfiles?.length, 4, "seeds + custom all survive");
      assert.ok(out.postureProfiles?.some((p) => p.name === "Custom"));
      assert.ok(out.postureProfiles?.some((p) => p.name === "Locked"));
    });

    it("omits postureProfiles entirely when there are none (no empty [] injected)", () => {
      const out = preservePostureProfiles({ globalPermissionsMode: "Inherit" }, undefined);
      assert.ok(!("postureProfiles" in out), "no empty postureProfiles key injected");
      assert.ok(!("postureProfiles" in preservePostureProfiles({ x: 1 }, [])), "empty array normalizes to omission");
    });

    it("normalizePostureProfiles keeps a valid globalPermissionsMode and drops an invalid one", () => {
      const out = normalizePostureProfiles([
        { name: "A", capabilityGates: { write_to_pane: "Off" }, globalPermissionsMode: "Read-Only" },
        { name: "B", capabilityGates: {}, globalPermissionsMode: "Nonsense" },
      ]);
      assert.strictEqual(out?.[0].globalPermissionsMode, "Read-Only");
      assert.strictEqual(out?.[1].globalPermissionsMode, undefined, "invalid mode dropped");
    });
  });

  describe("server-side persistence choke-point (src/terminal.ts parsePresetsSafe)", () => {
    it("preserves per-preset capabilityGates through the save persistence path (array input)", () => {
      // This is the SERVER path: PUT /api/settings -> manager.updateSettings -> parsePresetsSafe.
      // Before the fix it dropped capabilityGates here even when the client sent them.
      const out = serverParsePresetsSafe([
        { id: "claude", name: "Claude Code", command: "claude", enabled: true, capabilityGates: { write_to_pane: "Auto", close_pane: "Off" } },
      ]);
      assert.deepStrictEqual(out[0].capabilityGates, { write_to_pane: "Auto", close_pane: "Off" }, "server persistence keeps the preset gates");
    });
    it("preserves per-preset capabilityGates through the save persistence path (object input)", () => {
      const out = serverParsePresetsSafe({
        codex: { name: "Codex", command: "codex", enabled: true, capabilityGates: { deliver_handoff: "Ask" } },
      });
      const codex = out.find((p) => p.id === "codex")!;
      assert.deepStrictEqual(codex.capabilityGates, { deliver_handoff: "Ask" });
    });
    it("a preset with no gates is left clean (no empty map injected)", () => {
      const out = serverParsePresetsSafe([{ id: "x", name: "X", command: "x", enabled: true }]);
      assert.strictEqual(out[0].capabilityGates, undefined);
    });
  });
});
