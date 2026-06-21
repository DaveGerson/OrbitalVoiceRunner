// tests/test_station_complexity_refactor.ts
//
// Behavior-pinning tests for src/orbital/station.ts deriveStations() — written FIRST to lock the
// CURRENT output of the high-complexity map callback (CC 25) before a verbatim, behavior-preserving
// extraction refactor. Every branch / fallback / clamp of the per-terminal Station shaping is
// exercised here so the refactor can be proven semantics-identical.
//
// Cross-checks formatElapsed / formatTokens / deriveProjects too, since the refactor lives in the
// same module and we want the whole derivation contract green before AND after.

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  deriveStations,
  deriveProjects,
  formatElapsed,
  formatTokens,
  type Station,
} from "../src/orbital/station";
import { chefForPane, skinForProject } from "../src/orbital/theme";
import type { PendingCommand, Terminal, Workspace } from "../src/types";

// ── minimal builders ─────────────────────────────────────────────────────
function term(over: Partial<Terminal> = {}): Terminal {
  return {
    id: "t1",
    cwd: "",
    command: "",
    output: "",
    status: "Running",
    ...over,
  } as Terminal;
}

function ws(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    name: "Proj One",
    directory: "/proj/one",
    summary: "",
    notes: [],
    panes: {},
    ...over,
  } as Workspace;
}

function pane(over: Record<string, unknown> = {}): any {
  return {
    pane_id: "t1",
    name: "Pane Name",
    runtime_type: "claude",
    last_known_state: "Running",
    is_busy: false,
    alive: true,
    notes: [],
    permissions_mode: "Full Auto",
    session_id: "s1",
    tool_preset: "Codex",
    context_size: 0,
    ...over,
  };
}

function pending(over: Partial<PendingCommand> = {}): PendingCommand {
  return {
    messageId: "m1",
    cmd: "ls",
    terminalId: "t1",
    ...over,
  } as PendingCommand;
}

// ── formatElapsed ─────────────────────────────────────────────────────────
describe("formatElapsed", () => {
  it("returns dash for undefined / zero / negative", () => {
    assert.equal(formatElapsed(undefined), "—");
    assert.equal(formatElapsed(0), "—");
    assert.equal(formatElapsed(-5), "—");
  });
  it("seconds under a minute", () => {
    assert.equal(formatElapsed(500), "0s");
    assert.equal(formatElapsed(59_000), "59s");
  });
  it("minutes under an hour", () => {
    assert.equal(formatElapsed(60_000), "1m");
    assert.equal(formatElapsed(59 * 60_000), "59m");
  });
  it("hours otherwise", () => {
    assert.equal(formatElapsed(60 * 60_000), "1h");
    assert.equal(formatElapsed(3 * 60 * 60_000 + 5_000), "3h");
  });
});

// ── formatTokens ──────────────────────────────────────────────────────────
describe("formatTokens", () => {
  it("zero / undefined / negative -> 0", () => {
    assert.equal(formatTokens(undefined), "0");
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(-10), "0");
  });
  it("raw under 1000", () => {
    assert.equal(formatTokens(1), "1");
    assert.equal(formatTokens(999), "999");
  });
  it("thousands: one decimal under 10k, none at/over 10k", () => {
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(9999), "10.0k");
    assert.equal(formatTokens(10_000), "10k");
    assert.equal(formatTokens(32_000), "32k");
    assert.equal(formatTokens(999_000), "999k");
  });
  it("millions: one decimal", () => {
    assert.equal(formatTokens(1_000_000), "1.0m");
    assert.equal(formatTokens(2_500_000), "2.5m");
  });
});

// ── deriveStations: full mapping contract ─────────────────────────────────
describe("deriveStations", () => {
  it("empty terminals -> empty", () => {
    assert.deepEqual(deriveStations([], {}, []), []);
  });

  it("fully-populated, workspace-owned pane with pending approval (Needs Input + clamps)", () => {
    const t = term({
      id: "t1",
      cwd: "/cwd/here",
      command: "ignored-when-pane-has-last_command",
      output: "a\nb\n\nc\nd\ne",
      status: "Running",
      context_size: 250_000, // over budget -> fill clamps to 1
      tool_preset: "Claude Code",
      posture: "OPEN",
      permissions_mode: "Read-Only",
    } as Partial<Terminal>);
    const workspace = ws({
      id: "w1",
      name: "Proj One",
      directory: "/proj/one",
      panes: {
        t1: pane({
          name: "My Pane",
          last_command: "npm test",
          elapsed_ms: 65_000,
          context_size: 999, // overridden by terminal.context_size (non-zero)
          tool_preset: "Codex",
          permissions_mode: "Full Auto",
        }),
      },
    });
    const [s] = deriveStations([t], { w1: workspace }, [pending({ terminalId: "t1" })]);
    const skin = skinForProject("w1");
    const expected: Station = {
      id: "t1",
      project: "w1",
      projectName: "Proj One",
      projectColor: skin.color,
      projectEmoji: skin.emoji,
      name: "My Pane",
      status: "Needs Input",
      toolPreset: "Claude Code",
      chef: chefForPane("t1"),
      scribble: "npm test",
      cwd: "/cwd/here",
      elapsed: "1m",
      contextFill: 1,
      contextLabel: `${formatTokens(250_000)} ctx`,
      contextPips: 8,
      outputTail: ["b", "c", "d", "e"], // last 4 non-empty lines
      needsInput: true,
      posture: "OPEN",
      mode: "Read-Only", // terminal.permissions_mode wins over pane
    };
    assert.deepEqual(s, expected);
  });

  it("unassigned pane (no workspace): defaults + skin keyed off terminal id", () => {
    const t = term({ id: "lonely", output: "", context_size: 0 });
    const [s] = deriveStations([t], {}, []);
    const skin = skinForProject("lonely"); // projId "" falsy -> skinForProject(t.id)
    assert.equal(s.project, "");
    assert.equal(s.projectName, "Unassigned");
    assert.equal(s.projectColor, skin.color);
    assert.equal(s.projectEmoji, skin.emoji);
    assert.equal(s.name, "lonely"); // pane?.name falsy -> t.id
    assert.equal(s.cwd, "~"); // no cwd, no ws.directory
    assert.equal(s.toolPreset, "Custom"); // both presets absent
    assert.equal(s.scribble, ""); // no last_command, no command
    assert.equal(s.elapsed, "—"); // no elapsed_ms
    assert.equal(s.contextFill, 0);
    assert.equal(s.contextPips, 0);
    assert.deepEqual(s.outputTail, []);
    assert.equal(s.needsInput, false);
    assert.equal(s.status, "Running");
    assert.equal(s.posture, undefined);
    assert.equal(s.mode, undefined);
  });

  it("context_size falls back to pane.context_size when terminal omits it; mid-range fill rounds pips", () => {
    const t = term({ id: "t1", context_size: undefined });
    const workspace = ws({
      id: "w1",
      panes: { t1: pane({ context_size: 100_000 }) }, // 0.5 of 200k
    });
    const [s] = deriveStations([t], { w1: workspace }, []);
    assert.equal(s.contextFill, 0.5);
    assert.equal(s.contextPips, 4); // round(0.5 * 8)
    assert.equal(s.contextLabel, `${formatTokens(100_000)} ctx`);
  });

  it("scribble prefers pane.last_command, else terminal.command", () => {
    const tWith = term({ id: "t1", command: "term-cmd" });
    const wsLast = ws({ id: "w1", panes: { t1: pane({ last_command: "pane-cmd" }) } });
    assert.equal(deriveStations([tWith], { w1: wsLast }, [])[0].scribble, "pane-cmd");

    const wsNoLast = ws({ id: "w1", panes: { t1: pane({ last_command: undefined }) } });
    assert.equal(deriveStations([tWith], { w1: wsNoLast }, [])[0].scribble, "term-cmd");
  });

  it("cwd prefers terminal.cwd, else ws.directory, else ~", () => {
    const wsDir = ws({ id: "w1", directory: "/ws/dir", panes: { t1: pane() } });
    assert.equal(deriveStations([term({ id: "t1", cwd: "/t/cwd" })], { w1: wsDir }, [])[0].cwd, "/t/cwd");
    assert.equal(deriveStations([term({ id: "t1", cwd: "" })], { w1: wsDir }, [])[0].cwd, "/ws/dir");
  });

  it("toolPreset prefers terminal.tool_preset, else pane.tool_preset, else Custom", () => {
    const w = ws({ id: "w1", panes: { t1: pane({ tool_preset: "Antigravity" }) } });
    assert.equal(deriveStations([term({ id: "t1", tool_preset: "Codex" })], { w1: w }, [])[0].toolPreset, "Codex");
    assert.equal(deriveStations([term({ id: "t1", tool_preset: undefined })], { w1: w }, [])[0].toolPreset, "Antigravity");
  });

  it("mode falls back to pane.permissions_mode when terminal omits it", () => {
    const w = ws({ id: "w1", panes: { t1: pane({ permissions_mode: "Human-in-the-Loop" }) } });
    const [s] = deriveStations([term({ id: "t1", permissions_mode: undefined })], { w1: w }, []);
    assert.equal(s.mode, "Human-in-the-Loop");
  });

  it("status mapping: Exited / Idle / Running, and Needs Input overrides all", () => {
    assert.equal(deriveStations([term({ id: "t1", status: "Exited" })], {}, [])[0].status, "Exited");
    assert.equal(deriveStations([term({ id: "t1", status: "Idle" })], {}, [])[0].status, "Idle");
    assert.equal(deriveStations([term({ id: "t1", status: "Running" })], {}, [])[0].status, "Running");
    // Needs Input wins even over Exited
    assert.equal(
      deriveStations([term({ id: "t1", status: "Exited" })], {}, [pending({ terminalId: "t1" })])[0].status,
      "Needs Input",
    );
  });

  it("outputTail: undefined output -> [], strips empty lines, keeps last 4", () => {
    assert.deepEqual(deriveStations([term({ id: "t1", output: undefined as any })], {}, [])[0].outputTail, []);
    assert.deepEqual(
      deriveStations([term({ id: "t1", output: "1\r\n2\n\n3\n4\n5\n6" })], {}, [])[0].outputTail,
      ["3", "4", "5", "6"],
    );
  });

  it("pending command for a DIFFERENT pane does not mark needsInput", () => {
    const [s] = deriveStations([term({ id: "t1" })], {}, [pending({ terminalId: "other" })]);
    assert.equal(s.needsInput, false);
    assert.equal(s.status, "Running");
  });

  it("findWorkspace picks the workspace whose panes map contains the id", () => {
    const a = ws({ id: "wa", name: "A", panes: { x: pane({ pane_id: "x" }) } });
    const b = ws({ id: "wb", name: "B", panes: { t1: pane({ pane_id: "t1", name: "from-B" }) } });
    const [s] = deriveStations([term({ id: "t1" })], { wa: a, wb: b }, []);
    assert.equal(s.project, "wb");
    assert.equal(s.projectName, "B");
    assert.equal(s.name, "from-B");
  });
});

// ── deriveProjects (same module — keep contract green) ────────────────────
describe("deriveProjects", () => {
  it("lists ledger workspaces and folds in station-only projects", () => {
    const w = ws({ id: "w1", name: "Proj One", directory: "/proj/one" });
    const stations = deriveStations(
      [term({ id: "t1" }), term({ id: "t2" })],
      {
        w1: ws({ id: "w1", name: "Proj One", directory: "/proj/one", panes: { t1: pane() } }),
        // t2 references no ledger ws -> unassigned
      },
      [],
    );
    const projs = deriveProjects(stations, { w1: w });
    const ids = projs.map((p) => p.id);
    assert.ok(ids.includes("w1"));
    const p1 = projs.find((p) => p.id === "w1")!;
    const skin = skinForProject("w1");
    assert.equal(p1.name, "Proj One");
    assert.equal(p1.color, skin.color);
    assert.equal(p1.emoji, skin.emoji);
    assert.equal(p1.cwd, "/proj/one");
    // unassigned station has project "" -> not folded in (falsy guard)
    assert.ok(!ids.includes(""));
  });

  it("folds a station-referenced project missing from the ledger with cwd ~", () => {
    const stations: Station[] = [
      {
        id: "t1",
        project: "ghost",
        projectName: "Ghost Proj",
        projectColor: "#111",
        projectEmoji: "👻",
        name: "n",
        status: "Running",
        toolPreset: "Custom",
        chef: chefForPane("t1"),
        scribble: "",
        cwd: "~",
        elapsed: "—",
        contextFill: 0,
        contextLabel: "0 ctx",
        contextPips: 0,
        outputTail: [],
        needsInput: false,
      },
    ];
    const projs = deriveProjects(stations, {});
    const ghost = projs.find((p) => p.id === "ghost")!;
    assert.equal(ghost.name, "Ghost Proj");
    assert.equal(ghost.color, "#111");
    assert.equal(ghost.emoji, "👻");
    assert.equal(ghost.cwd, "~");
  });
});
