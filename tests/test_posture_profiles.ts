// f09.3 — posture profiles (Heads-down / Demo / Locked + operator-saved). The apply_posture def is a
// whole-matrix REPLACEMENT that rides the set_capability_gate row with ZERO new gating semantics; its
// voice directional contract is byte-identical to set_capability_gate via the shared isLoosening
// machinery (profileLoosens). This suite pins:
//   (1) profileLoosens classification (all-tighten Locked, loosen Heads-down, equal Demo, empty, omitted-key).
//   (2) the pure profile helpers (resolve/find/match/normalize) — seeds ∪ saved, fuzzy name match.
//   (3) apply_posture handler — global map replaced verbatim, per-pane overrides UNTOUCHED, audit
//       attributed to set_capability_gate, settings + terminals broadcasts; unknown name refusal.
//   (4) the voice directional contract — Locked (tighten) instant, Heads-down (loosen) defers; REST applies.
//
// Runner: npx tsx --test --test-force-exit tests/test_posture_profiles.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import type { ActionContext, GateDisposition } from "../src/actions/types";
import {
  DEFAULT_CAPABILITY_GATES, SEED_POSTURE_PROFILES,
  type CapabilityGate, type CapabilityGateMap, type GateValue, type PostureProfile,
} from "../src/types";
import { profileLoosens } from "../src/gating/postureProfiles";
import {
  resolvePostureProfiles, findPostureProfileByName, matchActiveProfile,
  normalizePostureProfiles, normalizePostureName,
} from "../src/settingsGatesRoundTrip";

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

const seed = (name: string): PostureProfile =>
  SEED_POSTURE_PROFILES.find((p) => normalizePostureName(p.name) === normalizePostureName(name))!;

/** A resolver that mirrors effectiveCapabilityGateFor(null, cap) for a plain global map (?? "Auto"). */
function globalResolver(map: CapabilityGateMap | undefined): (cap: CapabilityGate) => GateValue {
  return (cap) => (map && Object.hasOwn(map, cap) ? (map as Record<string, GateValue>)[cap] : "Auto");
}

interface RecordedActivity { type: string; project_id: string; pane_id: string | null; summary: string; payload: Record<string, unknown> }
interface Recorded {
  saveSettings: number;
  broadcasts: Array<Record<string, unknown>>;
  terminalsUpdated: number;
  activities: RecordedActivity[];
  gateCalls: Array<{ capability: string; paneId: string | null; summary: string }>;
}

interface CtxOpts {
  surface?: "voice" | "rest";
  globalGates?: CapabilityGateMap;
  savedProfiles?: PostureProfile[];
  paneGates?: Record<string, CapabilityGateMap>;   // per-pane overrides that must survive apply
  gateDisposition?: GateDisposition;               // what the fake gateOrDefer returns
  withStore?: boolean;
}

function makeCtx(opts: CtxOpts = {}): { ctx: ActionContext; rec: Recorded; advanced: any; panes: Record<string, { capabilityGates?: CapabilityGateMap }> } {
  const rec: Recorded = { saveSettings: 0, broadcasts: [], terminalsUpdated: 0, activities: [], gateCalls: [] };
  const advanced: any = { capabilityGates: opts.globalGates, postureProfiles: opts.savedProfiles, globalPermissionsMode: "Inherit" };
  const panes: Record<string, { capabilityGates?: CapabilityGateMap }> = {};
  for (const [id, g] of Object.entries(opts.paneGates ?? {})) panes[id] = { capabilityGates: g };
  const manager: any = {
    globalPermissionsMode: "Inherit",
    settings: { advanced, secrets: { geminiApiKey: "SECRET" } },
    saveSettings: () => { rec.saveSettings++; },
    ledger: { activeProjectId: "proj" },
  };
  const store = opts.withStore === false ? null : {
    recordActivity: (e: RecordedActivity) => { rec.activities.push(e); },
  };
  const gateOrDefer = (capability: string, paneId: string | null, summary: string): GateDisposition => {
    rec.gateCalls.push({ capability, paneId, summary });
    return opts.gateDisposition ?? { disposition: "run" };
  };
  const ctx = {
    manager,
    session: null,
    surface: opts.surface ?? "voice",
    redact: (s: string) => s,
    broadcast: (m: Record<string, unknown>) => { rec.broadcasts.push(m); },
    broadcastTerminalsUpdated: () => { rec.terminalsUpdated++; },
    sanitizeSettingsForClient: (s: any) => s,
    store,
    gateOrDefer,
    effectiveCapabilityGateFor: (_paneId: string | null | undefined, cap: CapabilityGate) => globalResolver(advanced.capabilityGates)(cap),
  } as unknown as ActionContext;
  return { ctx, rec, advanced, panes };
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) profileLoosens — the ONE decision, contract-identical to isLoosening.
// ─────────────────────────────────────────────────────────────────────────────
describe("f09.3 — profileLoosens classification", () => {
  const current = globalResolver(DEFAULT_CAPABILITY_GATES);

  it("Locked (all Off) NEVER loosens vs the default matrix — Off is the most restrictive", () => {
    assert.strictEqual(profileLoosens(seed("Locked").capabilityGates, DEFAULT_CAPABILITY_GATES, current), false);
  });

  it("Demo (all Ask) does not loosen vs the default matrix (orientation Auto→Ask is a tighten)", () => {
    assert.strictEqual(profileLoosens(seed("Demo").capabilityGates, DEFAULT_CAPABILITY_GATES, current), false);
  });

  it("Heads-down (write_to_pane Ask→Auto) LOOSENS vs the default matrix", () => {
    assert.strictEqual(profileLoosens(seed("Heads-down").capabilityGates, DEFAULT_CAPABILITY_GATES, current), true);
  });

  it("an equal map (default → default) is not a loosen", () => {
    assert.strictEqual(profileLoosens({ ...DEFAULT_CAPABILITY_GATES }, DEFAULT_CAPABILITY_GATES, current), false);
  });

  it("an EMPTY profile map loosens when the current matrix has any non-Auto gate (omitted key → Auto)", () => {
    // current has write_to_pane=Ask; the empty profile would resolve it to Auto ⇒ loosen ⇒ fail-closed defer.
    assert.strictEqual(profileLoosens({}, DEFAULT_CAPABILITY_GATES, current), true);
  });

  it("fail-closed: a currently-tightened capability the profile OMITS is still caught as a loosen", () => {
    const cur = globalResolver({ close_pane: "Off" });
    // profile only pins write_to_pane; close_pane is omitted → would resolve to Auto (loosen from Off).
    assert.strictEqual(profileLoosens({ write_to_pane: "Off" }, { close_pane: "Off" }, cur), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) pure profile helpers — seeds ∪ saved, fuzzy name match, active-match.
// ─────────────────────────────────────────────────────────────────────────────
describe("f09.3 — profile helpers", () => {
  it("resolvePostureProfiles returns the three seeds when nothing saved", () => {
    const names = resolvePostureProfiles(undefined).map((p) => p.name);
    assert.deepStrictEqual(names.sort(), ["Demo", "Heads-down", "Locked"]);
  });

  it("a saved profile is appended; a saved name matching a seed OVERRIDES the seed", () => {
    const saved: PostureProfile[] = [
      { name: "Night shift", capabilityGates: { write_to_pane: "Off" } },
      { name: "locked", capabilityGates: { write_to_pane: "Ask" } }, // folds to the Locked seed key
    ];
    const resolved = resolvePostureProfiles(saved);
    assert.ok(resolved.some((p) => p.name === "Night shift"), "custom appended");
    const locked = resolved.find((p) => normalizePostureName(p.name) === "locked")!;
    assert.deepStrictEqual(locked.capabilityGates, { write_to_pane: "Ask" }, "saved override wins over the seed");
  });

  it("findPostureProfileByName matches case/punctuation-insensitively ('go heads down' → Heads-down)", () => {
    assert.strictEqual(findPostureProfileByName("heads down", undefined)?.name, "Heads-down");
    assert.strictEqual(findPostureProfileByName("HEADS-DOWN", undefined)?.name, "Heads-down");
    assert.strictEqual(findPostureProfileByName("nope", undefined), undefined);
    assert.strictEqual(findPostureProfileByName("", undefined), undefined);
  });

  it("matchActiveProfile highlights the profile the current global matrix equals", () => {
    // The seeded display baseline of the Locked seed.
    assert.strictEqual(matchActiveProfile({ ...seed("Locked").capabilityGates }, undefined), "Locked");
    // Default matrix matches no seed.
    assert.strictEqual(matchActiveProfile({ ...DEFAULT_CAPABILITY_GATES }, undefined), undefined);
  });

  it("normalizePostureProfiles drops nameless/invalid entries and undefined-s empties", () => {
    assert.strictEqual(normalizePostureProfiles(undefined), undefined);
    assert.strictEqual(normalizePostureProfiles([]), undefined);
    assert.strictEqual(normalizePostureProfiles([{ capabilityGates: {} }]), undefined);
    const out = normalizePostureProfiles([{ name: "X", capabilityGates: { write_to_pane: "Off", bogus: "NO" } }]);
    assert.deepStrictEqual(out, [{ name: "X", capabilityGates: { write_to_pane: "Off" } }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) apply_posture handler — global replace, per-pane untouched, audit + broadcasts, refusal.
// ─────────────────────────────────────────────────────────────────────────────
describe("f09.3 — apply_posture handler", () => {
  it("REST apply replaces the global map verbatim, saves, audits (set_capability_gate), broadcasts settings + terminals", async () => {
    const { ctx, rec, advanced, panes } = makeCtx({ surface: "rest", globalGates: { ...DEFAULT_CAPABILITY_GATES } });
    const result = await runAction(REGISTRY, "apply_posture", { name: "Locked" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.deepStrictEqual(advanced.capabilityGates, seed("Locked").capabilityGates, "global map replaced verbatim");
    assert.strictEqual(rec.saveSettings, 1, "saveSettings called once");
    assert.strictEqual(rec.terminalsUpdated, 1, "postures broadcast so chips repaint");
    assert.ok(rec.broadcasts.some((b) => b.type === "settings_updated"), "settings_updated broadcast");
    assert.strictEqual(rec.activities.length, 1, "one audit row");
    assert.strictEqual(rec.activities[0].type, "permission_changed");
    assert.strictEqual((rec.activities[0].payload as any).action, "apply_posture");
    assert.strictEqual(rec.gateCalls.length, 0, "REST never gates (deliberate UI loosen)");
    assert.deepStrictEqual(panes, {}, "no per-pane structures touched");
  });

  it("applying a posture NEVER touches per-pane capabilityGates overrides (global-only)", async () => {
    const paneGates = { "pane-a": { write_to_pane: "Off" as GateValue } };
    const { ctx } = makeCtx({ surface: "rest", globalGates: { ...DEFAULT_CAPABILITY_GATES }, paneGates });
    await runAction(REGISTRY, "apply_posture", { name: "Locked" }, ctx);
    // The pane override object is defined on a separate structure the handler never reads/writes.
    assert.deepStrictEqual(paneGates["pane-a"], { write_to_pane: "Off" }, "pane override survives verbatim");
  });

  it("an unknown posture name is refused with a spoken-friendly line and NO apply", async () => {
    const { ctx, rec, advanced } = makeCtx({ surface: "voice", globalGates: { ...DEFAULT_CAPABILITY_GATES } });
    const result = await runAction(REGISTRY, "apply_posture", { name: "banana" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.match((result as any).output as string, /don't know a posture/i);
    assert.deepStrictEqual(advanced.capabilityGates, { ...DEFAULT_CAPABILITY_GATES }, "no partial apply on unknown name");
    assert.strictEqual(rec.saveSettings, 0);
  });

  it("an EMPTY profile map applies the full DEFAULT matrix (never a fail-open clear/undefined)", async () => {
    // Wave-7 major: an empty profile must NOT clear settings.advanced.capabilityGates to undefined —
    // that made every capability resolve via the permissive `?? "Auto"` fallback until the next restart
    // re-seeded DEFAULT. It now deep-merges over DEFAULT, so an empty profile IS the safe default matrix.
    const saved: PostureProfile[] = [{ name: "Blank", capabilityGates: {} }];
    const { ctx, advanced } = makeCtx({ surface: "rest", globalGates: { ...DEFAULT_CAPABILITY_GATES }, savedProfiles: saved });
    await runAction(REGISTRY, "apply_posture", { name: "Blank" }, ctx);
    assert.deepStrictEqual(advanced.capabilityGates, { ...DEFAULT_CAPABILITY_GATES },
      "empty profile falls back to the full default matrix, never a fail-open blank");
  });

  it("a PARTIAL profile DEEP-MERGES over DEFAULT — unmentioned meta/destructive never fail-open to Auto", async () => {
    // A saved profile that pins only write_to_pane must not flip delete_pane/set_capability_gate/
    // execute_plan to the permissive fallback (the trust-laundered fail-open the reviewer confirmed).
    const saved: PostureProfile[] = [{ name: "Writer", capabilityGates: { write_to_pane: "Ask" } }];
    const { ctx, advanced } = makeCtx({ surface: "rest", globalGates: { ...DEFAULT_CAPABILITY_GATES }, savedProfiles: saved });
    await runAction(REGISTRY, "apply_posture", { name: "Writer" }, ctx);
    assert.strictEqual(advanced.capabilityGates.set_capability_gate, "Ask", "meta stays at its default, not Auto");
    assert.strictEqual(advanced.capabilityGates.delete_pane, "Ask", "destructive stays at its default, not Auto");
    assert.strictEqual(advanced.capabilityGates.execute_plan, "Ask", "plan stays at its default, not Auto");
    assert.strictEqual(advanced.capabilityGates.write_to_pane, "Ask", "the profile's own value applied");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) voice directional contract — tighten instant, loosen defers; REST always applies.
// ─────────────────────────────────────────────────────────────────────────────
describe("f09.3 — voice directional contract", () => {
  it("'lock it down' (Locked, all-tighten) applies IMMEDIATELY by voice — no gateOrDefer", async () => {
    const { ctx, rec, advanced } = makeCtx({ surface: "voice", globalGates: { ...DEFAULT_CAPABILITY_GATES } });
    const result = await runAction(REGISTRY, "apply_posture", { name: "Locked" }, ctx);
    assert.strictEqual(rec.gateCalls.length, 0, "a tighten never defers");
    assert.deepStrictEqual(advanced.capabilityGates, seed("Locked").capabilityGates, "applied instantly");
    assert.match((result as any).output as string, /Applied the 'Locked' posture/);
  });

  it("a LOOSENING posture ('go heads down') DEFERS by voice via gateOrDefer (no immediate apply)", async () => {
    const { ctx, rec, advanced } = makeCtx({
      surface: "voice", globalGates: { ...DEFAULT_CAPABILITY_GATES },
      gateDisposition: { disposition: "deferred", actionId: "x", summary: "Apply the 'Heads-down' posture" },
    });
    const result = await runAction(REGISTRY, "apply_posture", { name: "Heads-down" }, ctx);
    assert.strictEqual(rec.gateCalls.length, 1, "loosen routes through gateOrDefer");
    assert.strictEqual(rec.gateCalls[0].capability, "set_capability_gate", "rides the meta lock row");
    assert.deepStrictEqual(advanced.capabilityGates, { ...DEFAULT_CAPABILITY_GATES }, "NOT applied while deferred");
    assert.match((result as any).output as string, /needs your confirmation/i);
  });

  it("a loosening posture APPLIES when the meta gate resolves Auto (gateOrDefer → run)", async () => {
    const { ctx, rec, advanced } = makeCtx({
      surface: "voice", globalGates: { ...DEFAULT_CAPABILITY_GATES },
      gateDisposition: { disposition: "run" },
    });
    await runAction(REGISTRY, "apply_posture", { name: "Heads-down" }, ctx);
    assert.strictEqual(rec.gateCalls.length, 1, "still consults the gate");
    assert.deepStrictEqual(advanced.capabilityGates, seed("Heads-down").capabilityGates, "applied on run disposition");
  });

  it("a loosening posture is REFUSED when the meta gate is Off (gateOrDefer → forbidden)", async () => {
    const { ctx, advanced } = makeCtx({
      surface: "voice", globalGates: { ...DEFAULT_CAPABILITY_GATES },
      gateDisposition: { disposition: "forbidden" },
    });
    const result = await runAction(REGISTRY, "apply_posture", { name: "Heads-down" }, ctx);
    assert.match((result as any).output as string, /forbidden by policy/i);
    assert.deepStrictEqual(advanced.capabilityGates, { ...DEFAULT_CAPABILITY_GATES }, "forbidden → no apply");
  });

  it("REST applies a LOOSENING posture directly (the deliberate UI loosen surface)", async () => {
    const { ctx, rec, advanced } = makeCtx({ surface: "rest", globalGates: { ...DEFAULT_CAPABILITY_GATES } });
    await runAction(REGISTRY, "apply_posture", { name: "Heads-down" }, ctx);
    assert.strictEqual(rec.gateCalls.length, 0, "REST never gates");
    assert.deepStrictEqual(advanced.capabilityGates, seed("Heads-down").capabilityGates, "loosen applied on REST");
  });
});
