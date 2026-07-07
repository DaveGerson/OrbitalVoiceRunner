// tests/test_orbitalapp_complexity_refactor.ts — CHARACTERIZATION tests for the
// cyclomatic-complexity burndown refactor of src/orbital/OrbitalApp.tsx
// (OrbitalApp CC 37 → 7).
//
// Pins every branch of the pure helpers extracted into
// src/orbital/orbitalAppHelpers.ts:
//   - resolveStartView        (URL search → "line"|"pantry"|"boh")
//   - resolveStartProject     (URL search → project slug or "all")
//   - getLocationSearch       (browser-safe location.search accessor)
//   - resolveServiceId        (GlobalMode → ServiceModeId, Inherit→HiTL)
//   - resolvePassProjectId    (selectedProject, stations, activeId, projects → id|null)
//   - resolvePassProjectName  (passProjectId, projects → name|"a kitchen")
//   - matchVoiceCall          (phrase, stations → discriminated VoiceCallAction)
//
// Runner: npx tsx --test --test-force-exit tests/test_orbitalapp_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveStartView,
  resolveStartProject,
  getLocationSearch,
  resolveServiceId,
  resolvePassProjectId,
  resolvePassProjectName,
  matchVoiceCall,
  labelForPill,
  type View,
  type VoiceCallAction,
} from "../src/orbital/orbitalAppHelpers.ts";
import type { Station, StationProject } from "../src/orbital/station.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for building minimal test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeStation(id: string, name: string, project = "proj1"): Station {
  return {
    id, name, project, projectName: "Test Project", projectColor: "#000",
    projectEmoji: "🍳", status: "Running", toolPreset: "Claude Code", chef: "gordon",
    scribble: "", cwd: "", elapsed: "0s", contextFill: 0, contextLabel: "",
    contextPips: 0, outputTail: [], needsInput: false,
  };
}

function makeProject(id: string, name: string): StationProject {
  return { id, name, color: "#aaa", emoji: "🍕", cwd: "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. resolveStartView
// Branches: included "boh" → "boh"; included "pantry" → "pantry";
//           missing/other → "line"; empty string → "line".
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveStartView", () => {
  it("no params → 'line'", () => {
    assert.equal(resolveStartView(""), "line");
  });

  it("?view=line → 'line'", () => {
    assert.equal(resolveStartView("?view=line"), "line");
  });

  it("?view=boh → 'boh'", () => {
    assert.equal(resolveStartView("?view=boh"), "boh");
  });

  it("?view=pantry → 'pantry'", () => {
    assert.equal(resolveStartView("?view=pantry"), "pantry");
  });

  it("unknown view value → falls back to 'line'", () => {
    assert.equal(resolveStartView("?view=dashboard"), "line");
  });

  it("?view= empty string value → 'line'", () => {
    assert.equal(resolveStartView("?view="), "line");
  });

  it("other param, no view → 'line'", () => {
    assert.equal(resolveStartView("?project=abc"), "line");
  });

  it("multiple params including view=boh → 'boh'", () => {
    assert.equal(resolveStartView("?project=x&view=boh"), "boh");
  });

  it("return type is 'line' | 'pantry' | 'boh'", () => {
    const views: View[] = ["line", "pantry", "boh"];
    for (const v of views) {
      const result = resolveStartView(`?view=${v}`);
      assert.ok(views.includes(result), `Expected one of ${views.join(",")} but got ${result}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. resolveStartProject
// Branches: ?project= present → return it; absent → "all".
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveStartProject", () => {
  it("no params → 'all'", () => {
    assert.equal(resolveStartProject(""), "all");
  });

  it("?project=proj1 → 'proj1'", () => {
    assert.equal(resolveStartProject("?project=proj1"), "proj1");
  });

  it("?project=all (explicit) → 'all'", () => {
    assert.equal(resolveStartProject("?project=all"), "all");
  });

  it("other params, no project → 'all'", () => {
    assert.equal(resolveStartProject("?view=boh"), "all");
  });

  it("?project=my-workspace → 'my-workspace'", () => {
    assert.equal(resolveStartProject("?project=my-workspace"), "my-workspace");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. getLocationSearch
// Branches: location defined → location.search; typeof location undefined → "".
// Note: in the node test runner, 'location' is NOT defined, so we always get "".
// The browser-side branch is exercised by e2e tests.
// ─────────────────────────────────────────────────────────────────────────────
describe("getLocationSearch", () => {
  it("returns '' in node environment (location is undefined)", () => {
    assert.equal(typeof location, "undefined", "location should be undefined in node");
    assert.equal(getLocationSearch(), "");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. resolveServiceId
// Branches: "Inherit" → "hitl"; "Full Auto" → "auto"; "Human-in-the-Loop" → "hitl";
//           "Read-Only" → "read".
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveServiceId", () => {
  it("'Inherit' → 'hitl' (substituted as Human-in-the-Loop)", () => {
    assert.equal(resolveServiceId("Inherit"), "hitl");
  });

  it("'Human-in-the-Loop' → 'hitl'", () => {
    assert.equal(resolveServiceId("Human-in-the-Loop"), "hitl");
  });

  it("'Full Auto' → 'auto'", () => {
    assert.equal(resolveServiceId("Full Auto"), "auto");
  });

  it("'Read-Only' → 'read'", () => {
    assert.equal(resolveServiceId("Read-Only"), "read");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. resolvePassProjectId
// Branches:
//   a) selectedProject !== "all" → return selectedProject
//   b) selectedProject === "all", active station found → station.project
//   c) selectedProject === "all", no active station, projects[0] exists → projects[0].id
//   d) selectedProject === "all", no active station, no projects → null
// ─────────────────────────────────────────────────────────────────────────────
describe("resolvePassProjectId", () => {
  const s1 = makeStation("t1", "Alice", "proj1");
  const s2 = makeStation("t2", "Bob", "proj2");
  const p1 = makeProject("proj1", "Project One");
  const p2 = makeProject("proj2", "Project Two");

  it("selected project is not 'all' → returns selectedProject directly", () => {
    assert.equal(resolvePassProjectId("proj2", [s1, s2], "t1", [p1, p2]), "proj2");
  });

  it("selected='all', active terminal matches station → station.project", () => {
    assert.equal(resolvePassProjectId("all", [s1, s2], "t2", [p1, p2]), "proj2");
  });

  it("selected='all', no active terminal match, first project exists → projects[0].id", () => {
    assert.equal(resolvePassProjectId("all", [s1, s2], null, [p1, p2]), "proj1");
  });

  it("selected='all', active terminal not in stations, first project exists → projects[0].id", () => {
    assert.equal(resolvePassProjectId("all", [s1, s2], "t999", [p1, p2]), "proj1");
  });

  it("selected='all', no stations, no projects → null", () => {
    assert.equal(resolvePassProjectId("all", [], null, []), null);
  });

  it("selected='all', no projects, active station has empty project string → null (empty string is falsy)", () => {
    const bare = makeStation("t3", "Empty", "");
    assert.equal(resolvePassProjectId("all", [bare], "t3", []), null);
  });

  it("selected='all', active terminal undefined → falls back to projects[0].id", () => {
    assert.equal(resolvePassProjectId("all", [s1], undefined, [p1]), "proj1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. resolvePassProjectName
// Branches: project found → project.name; not found → "a kitchen".
// ─────────────────────────────────────────────────────────────────────────────
describe("resolvePassProjectName", () => {
  const projects = [makeProject("proj1", "The Lab"), makeProject("proj2", "Sous Vide")];

  it("known projectId → project name", () => {
    assert.equal(resolvePassProjectName("proj1", projects), "The Lab");
  });

  it("second known projectId → correct name", () => {
    assert.equal(resolvePassProjectName("proj2", projects), "Sous Vide");
  });

  it("unknown projectId → 'a kitchen'", () => {
    assert.equal(resolvePassProjectName("mystery", projects), "a kitchen");
  });

  it("null projectId → 'a kitchen'", () => {
    assert.equal(resolvePassProjectName(null, projects), "a kitchen");
  });

  it("empty projects array → 'a kitchen'", () => {
    assert.equal(resolvePassProjectName("proj1", []), "a kitchen");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. matchVoiceCall
// Branches (each `if` in the original handleCall, now encoded in matchVoiceCall):
//   a) "open <name>" with matching station → { kind: "open", stationId }
//   b) "open <name>" with no match → falls through to coaching
//   c) "let 'em cook" → { kind: "setMode", mode: "Full Auto" }
//   d) "taste every plate" → { kind: "setMode", mode: "Human-in-the-Loop" }
//   e) "hands off — read only" → { kind: "setMode", mode: "Read-Only" }
//   f) "all hands — stop the line" → { kind: "stopFreeze" }
//   g) "kill the burners" → { kind: "stopFreeze" } (||  branch)
//   h) "back to service" → { kind: "stopRelease" }
//   i) anything else → { kind: "coaching", phrase }
//   j) phrase matching is case-insensitive and trims whitespace
// ─────────────────────────────────────────────────────────────────────────────
describe("matchVoiceCall", () => {
  const stations = [
    makeStation("t1", "Alice"),
    makeStation("t2", "Bob"),
    makeStation("t3", "The Grill"),
  ];

  it("'open alice' (exact lowercase match) → { kind: 'open', stationId: 't1' }", () => {
    const a = matchVoiceCall("open alice", stations) as Extract<VoiceCallAction, { kind: "open" }>;
    assert.equal(a.kind, "open");
    assert.equal(a.stationId, "t1");
  });

  it("'Open Bob' (mixed case) → { kind: 'open', stationId: 't2' }", () => {
    const a = matchVoiceCall("Open Bob", stations) as Extract<VoiceCallAction, { kind: "open" }>;
    assert.equal(a.kind, "open");
    assert.equal(a.stationId, "t2");
  });

  it("'open the grill' → matches 'The Grill' station", () => {
    const a = matchVoiceCall("open the grill", stations) as Extract<VoiceCallAction, { kind: "open" }>;
    assert.equal(a.kind, "open");
    assert.equal(a.stationId, "t3");
  });

  it("'open nonexistent' (no match) → coaching fallback", () => {
    const a = matchVoiceCall("open nonexistent", stations) as Extract<VoiceCallAction, { kind: "coaching" }>;
    assert.equal(a.kind, "coaching");
  });

  it("\"let 'em cook\" → { kind: 'setMode', mode: 'Full Auto' }", () => {
    const a = matchVoiceCall("let 'em cook", stations) as Extract<VoiceCallAction, { kind: "setMode" }>;
    assert.equal(a.kind, "setMode");
    assert.equal(a.mode, "Full Auto");
  });

  it("'taste every plate' → { kind: 'setMode', mode: 'Human-in-the-Loop' }", () => {
    const a = matchVoiceCall("taste every plate", stations) as Extract<VoiceCallAction, { kind: "setMode" }>;
    assert.equal(a.kind, "setMode");
    assert.equal(a.mode, "Human-in-the-Loop");
  });

  it("'hands off — read only' → { kind: 'setMode', mode: 'Read-Only' }", () => {
    const a = matchVoiceCall("hands off — read only", stations) as Extract<VoiceCallAction, { kind: "setMode" }>;
    assert.equal(a.kind, "setMode");
    assert.equal(a.mode, "Read-Only");
  });

  it("'all hands — stop the line' → { kind: 'stopFreeze' }", () => {
    assert.equal(matchVoiceCall("all hands — stop the line", stations).kind, "stopFreeze");
  });

  it("'kill the burners' → { kind: 'stopFreeze' } (|| branch)", () => {
    assert.equal(matchVoiceCall("kill the burners", stations).kind, "stopFreeze");
  });

  it("'back to service' → { kind: 'stopRelease' }", () => {
    assert.equal(matchVoiceCall("back to service", stations).kind, "stopRelease");
  });

  it("arbitrary phrase → { kind: 'coaching', phrase }", () => {
    const a = matchVoiceCall("what's good today?", stations) as Extract<VoiceCallAction, { kind: "coaching" }>;
    assert.equal(a.kind, "coaching");
    assert.equal(a.phrase, "what's good today?");
  });

  it("coaching preserves original phrase (not lowercased)", () => {
    const phrase = "Any specials tonight?";
    const a = matchVoiceCall(phrase, stations) as Extract<VoiceCallAction, { kind: "coaching" }>;
    assert.equal(a.phrase, phrase);
  });

  it("whitespace-padded command is still recognized (trims)", () => {
    assert.equal(matchVoiceCall("  back to service  ", stations).kind, "stopRelease");
  });

  it("'KILL THE BURNERS' (uppercase) → stopFreeze (case-insensitive)", () => {
    assert.equal(matchVoiceCall("KILL THE BURNERS", stations).kind, "stopFreeze");
  });

  it("no stations: 'open any' → coaching (no match possible)", () => {
    const a = matchVoiceCall("open any", []) as Extract<VoiceCallAction, { kind: "coaching" }>;
    assert.equal(a.kind, "coaching");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. labelForPill (Wave 5 minor fix — no doubled bullet)
// The nav ConversationalPill draws its OWN status dot span, so a shared LABELS
// entry that already carries a leading bullet (LABELS.listening = '● LIVE',
// byte-pinned to the KitchenRadio chip's e2e strings) would render '● ● LIVE'.
// labelForPill strips a single leading bullet+space for the PILL only — the
// shared LABELS map (and the chip that pins it) is untouched.
// ─────────────────────────────────────────────────────────────────────────────
describe("labelForPill — the pill draws its own dot, so the label must not carry a second bullet", () => {
  it("strips a leading '● ' so '● LIVE' renders 'LIVE' (no bullet doubled next to the pill's own dot)", () => {
    assert.equal(labelForPill("● LIVE"), "LIVE");
  });

  it("the pill label carries no bullet glyph at all once stripped", () => {
    assert.equal(labelForPill("● LIVE").includes("●"), false);
  });

  it("passes every non-bulleted label through unchanged", () => {
    for (const l of ["OFF AIR", "TUNING IN…", "MIC BLOCKED", "RECONNECTING…", "MUTED", "SPEAKING…", "WAITING ON YOU", "EXECUTING…", "THINKING…"]) {
      assert.equal(labelForPill(l), l);
    }
  });

  it("is idempotent — re-applying never strips further and a bare label is untouched", () => {
    assert.equal(labelForPill(labelForPill("● LIVE")), "LIVE");
    assert.equal(labelForPill("LIVE"), "LIVE");
  });
});
