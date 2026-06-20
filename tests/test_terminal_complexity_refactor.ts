// tests/test_terminal_complexity_refactor.ts — CHARACTERIZATION tests for the Phase-7b cyclomatic
// refactor of src/terminal.ts. These pin the CURRENT behaviour of the nine over-limit functions'
// branches that the existing suite covers only thinly, so the behaviour-preserving complexity
// refactor (extract helpers / guard clauses / dispatch tables) can be proven not to change a single
// observable output or side-effect. They are written to be GREEN against the UNREFACTORED code first.
//
// Covered functions (line @ HEAD : current cyclomatic complexity):
//   - parsePresetsSafe array-path map callback (≈L21, CC25): per-field rebuild + preservePresetGates
//     carry, every `||`/`?? default`/`Boolean(...)` coercion.
//   - parsePresetsSafe object-path map callback (≈L37, CC26): displayName id->name mapping
//     (claudeCode / codex / antigravity / capitalize fallback) + per-field rebuild.
//   - normalizePreset (≈L101, CC11): already pinned in test_preset_command.ts — a thin re-pin here.
//   - UniversalTerminal constructor (≈L464, CC12): the supportsResume synthetic-id branch
//     ("<tool>-session-<hex>"), Custom no-session branch, runtimeType derivation.
//   - applyStatusEvent (≈L576, CC26): the Exited early-return guard (re-pinned; the rest is in
//     test_status_gating.ts).
//   - updateSettings (≈L1371, CC16): partial server/voiceAi/projects/announcements merge, the
//     capabilityGates deep-merge, the secrets shallow-merge, and that omitted sections are untouched.
//   - OrchestratorManager constructor (≈L1420, CC11): boots panes INERT (alive=false, is_busy=false,
//     last_known_state="Exited") and elects the active project.
//   - addTerminal (≈L1457, CC15): dup guard, projectId fallback, callback fan-out wiring,
//     active-pane election, the returned message string.
//   - syncLedger (≈L1593, CC22): first-registration (no existingPane) status->last_known_state
//     mapping for Running / Idle / Exited, is_busy/alive flags, session_id fallback.
//
// PURE / in-memory only: UniversalTerminal never spawns in its constructor (only start() does), and
// every manager test uses a JanusStore(":memory:") ledger, so no PTY, no API key, no disk settings.
// Tests that touch the settings file isolate cwd to a tmp dir first (loadSettings reads from cwd).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  parsePresetsSafe,
  normalizePreset,
  UniversalTerminal,
  OrchestratorManager,
} from "../src/terminal";
import { Ledger } from "../src/ledger";
import { JanusStore } from "../src/store/sqliteStore";
import type { PtyTransport, createPtyTransport } from "../src/ptyTransport";

// A no-op capturing transport factory so a constructor under test never spawns a real PTY even if
// start() were reached (it is not here — the constructor never starts).
function makeNoopFactory(): typeof createPtyTransport {
  const transport: PtyTransport = {
    pid: 4242,
    onData(_cb: (data: string) => void) {},
    onExit(_cb: (info: { exitCode: number; signal?: number }) => void) {},
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill(_signal?: string) {},
  };
  return (_finalCommand, _opts) => ({ transport, usingNodePty: true });
}

describe("Phase 7b — parsePresetsSafe characterization (pure)", () => {
  it("array path rebuilds every field, applies defaults, and coerces types verbatim", () => {
    const out = parsePresetsSafe([
      {
        id: 7, // non-string -> String() coercion
        // name omitted -> "" (String(item?.name || ""))
        command: "claude",
        // enabled omitted -> true
        // permissionsMode omitted -> "Human-in-the-Loop"
        // windowMode omitted -> "Standard Split-Pane"
        // visualTheme omitted -> "Default Green Mono"
        persistentRestore: 1, // truthy -> Boolean true
        dangerouslySkipPermissions: 0, // falsy -> Boolean false
        // sessionResume omitted -> true
        portOffset: 5, // -> "5"
        // customEnvVars omitted -> ""
      },
    ]);
    assert.strictEqual(out.length, 1);
    const p = out[0];
    assert.strictEqual(p.id, "7");
    assert.strictEqual(p.name, "");
    assert.strictEqual(p.command, "claude");
    assert.strictEqual(p.enabled, true);
    assert.strictEqual(p.permissionsMode, "Human-in-the-Loop");
    assert.strictEqual(p.windowMode, "Standard Split-Pane");
    assert.strictEqual(p.visualTheme, "Default Green Mono");
    assert.strictEqual(p.persistentRestore, true);
    assert.strictEqual(p.dangerouslySkipPermissions, false);
    assert.strictEqual(p.sessionResume, true);
    assert.strictEqual(p.portOffset, "5");
    assert.strictEqual(p.customEnvVars, "");
  });

  it("array path honors explicit false/empty overrides (not just defaults)", () => {
    const out = parsePresetsSafe([
      {
        id: "x",
        name: "X",
        command: "",
        enabled: false,
        permissionsMode: "Full Auto",
        windowMode: "Floating",
        visualTheme: "Royal Purple",
        persistentRestore: false,
        dangerouslySkipPermissions: true,
        sessionResume: false,
        portOffset: "0",
        customEnvVars: "A=B",
      },
    ]);
    const p = out[0];
    assert.strictEqual(p.enabled, false);
    assert.strictEqual(p.permissionsMode, "Full Auto");
    assert.strictEqual(p.windowMode, "Floating");
    assert.strictEqual(p.visualTheme, "Royal Purple");
    assert.strictEqual(p.persistentRestore, false);
    assert.strictEqual(p.dangerouslySkipPermissions, true);
    assert.strictEqual(p.sessionResume, false);
    assert.strictEqual(p.portOffset, "0");
    assert.strictEqual(p.customEnvVars, "A=B");
  });

  it("object path maps known keys to display names and capitalizes unknown keys", () => {
    const out = parsePresetsSafe({
      claudeCode: { command: "claude" },
      codex: { command: "codex" },
      antigravity: { command: "antigravity" },
      myTool: { command: "mt" }, // unknown -> capitalize first letter
    });
    const byId = Object.fromEntries(out.map((p) => [p.id, p]));
    assert.strictEqual(byId["claudeCode"].name, "Claude Code");
    assert.strictEqual(byId["codex"].name, "Codex CLI");
    assert.strictEqual(byId["antigravity"].name, "Antigravity Agent");
    assert.strictEqual(byId["myTool"].name, "MyTool");
    // The id is the object key verbatim.
    assert.deepStrictEqual(
      out.map((p) => p.id).sort(),
      ["antigravity", "claudeCode", "codex", "myTool"],
    );
  });

  it("object path prefers an explicit val.name over the derived display name", () => {
    const out = parsePresetsSafe({ codex: { name: "Codex Custom", command: "c" } });
    assert.strictEqual(out[0].name, "Codex Custom");
    assert.strictEqual(out[0].id, "codex");
  });

  it("object path applies the same field defaults/coercions as the array path", () => {
    const out = parsePresetsSafe({ foo: {} });
    const p = out[0];
    assert.strictEqual(p.id, "foo");
    assert.strictEqual(p.name, "Foo");
    assert.strictEqual(p.command, "");
    assert.strictEqual(p.enabled, true);
    assert.strictEqual(p.permissionsMode, "Human-in-the-Loop");
    assert.strictEqual(p.windowMode, "Standard Split-Pane");
    assert.strictEqual(p.visualTheme, "Default Green Mono");
    assert.strictEqual(p.persistentRestore, false);
    assert.strictEqual(p.dangerouslySkipPermissions, false);
    assert.strictEqual(p.sessionResume, true);
    assert.strictEqual(p.portOffset, "");
    assert.strictEqual(p.customEnvVars, "");
  });

  it("non-array non-object input returns the seeded canonical trio unchanged", () => {
    const out = parsePresetsSafe(undefined);
    assert.deepStrictEqual(out.map((p) => p.id), ["claudeCode", "codex", "antigravity"]);
    assert.strictEqual(out[0].command, "claude");
    assert.strictEqual(out[1].command, "codex");
    assert.strictEqual(out[2].command, "antigravity");
    assert.strictEqual(out[0].visualTheme, "Royal Purple");
    assert.strictEqual(out[2].permissionsMode, "Full Auto");
    assert.strictEqual(out[2].dangerouslySkipPermissions, true);
  });

  it("normalizePreset re-pin (id|name|union -> union, fail-safe Custom)", () => {
    assert.strictEqual(normalizePreset("codex"), "Codex");
    assert.strictEqual(normalizePreset("Codex CLI"), "Codex");
    assert.strictEqual(normalizePreset("Antigravity Agent"), "Antigravity");
    assert.strictEqual(normalizePreset("Claude Code"), "Claude Code");
    assert.strictEqual(normalizePreset("Custom"), "Custom");
    assert.strictEqual(normalizePreset("garbage"), "Custom");
    assert.strictEqual(normalizePreset(undefined), "Custom");
  });
});

describe("Phase 7b — UniversalTerminal constructor characterization (pure, no spawn)", () => {
  let prevCwd: string;
  let tmpDir: string;
  before(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p7b-term-ctor-"));
    process.chdir(tmpDir);
  });
  after(() => {
    process.chdir(prevCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  const make = (
    id: string,
    preset: "Claude Code" | "Codex" | "Antigravity" | "Custom",
    cmd: string,
    sessionId: string,
  ) =>
    new UniversalTerminal(
      id,
      tmpDir,
      cmd,
      preset,
      "Human-in-the-Loop",
      sessionId,
      "default_project",
      undefined,
      makeNoopFactory(),
    );

  it("Custom pane: runtimeType=shell, no session id, not fresh", () => {
    const t = make("c-custom", "Custom", "bash", "");
    assert.strictEqual(t.runtimeType, "shell");
    assert.strictEqual(t.sessionId, "");
    assert.strictEqual((t as any).sessionIsFresh, false);
  });

  it("Codex (supportsResume, no pin): synthetic '<tool>-session-<hex>' id, not fresh, interactive_cli", () => {
    const t = make("c-codex", "Codex", "codex", "");
    assert.strictEqual(t.runtimeType, "interactive_cli");
    assert.match(t.sessionId, /^codex-session-[0-9a-f]{1,8}$/);
    assert.strictEqual((t as any).sessionIsFresh, false);
  });

  it("Antigravity synthetic id derives the tool slug from a spaced/lowered preset name", () => {
    const t = make("c-agy", "Antigravity", "antigravity", "");
    assert.match(t.sessionId, /^antigravity-session-[0-9a-f]{1,8}$/);
  });

  it("supplied sessionId means RESUME: carried verbatim, not fresh", () => {
    const t = make("c-resume", "Claude Code", "claude", "supplied-id-123");
    assert.strictEqual(t.sessionId, "supplied-id-123");
    assert.strictEqual((t as any).sessionIsFresh, false);
  });

  it("fresh Claude (supportsSessionPin, no sessionId) gets a generated id and is fresh", () => {
    const t = make("c-claude", "Claude Code", "claude", "");
    assert.ok(t.sessionId.length > 0, "claude pins a generated session id");
    assert.strictEqual((t as any).sessionIsFresh, true);
  });
});

describe("Phase 7b — applyStatusEvent Exited guard (real terminal, no spawn)", () => {
  it("an Exited pane ignores every event kind (early return; no status/callback churn)", () => {
    const term = new UniversalTerminal(
      "e1",
      process.cwd(),
      "echo hi",
      "Custom",
      "Human-in-the-Loop",
      "",
      "default_project",
      undefined,
      makeNoopFactory(),
    );
    term.status = "Exited";
    let idle = 0;
    let running = 0;
    let quiescing = 0;
    term.onIdle = () => { idle++; };
    term.onRunning = () => { running++; };
    term.onQuiescing = () => { quiescing++; };
    (term as any).applyStatusEvent({ kind: "input" });
    (term as any).applyStatusEvent({ kind: "output", text: "noise" });
    (term as any).applyStatusEvent({ kind: "idleTimer" });
    (term as any).applyStatusEvent({ kind: "probe", probe: { hasRunningChild: true, confidence: "authoritative" } });
    assert.strictEqual(term.status, "Exited", "Exited is sticky — no event reanimates it");
    assert.strictEqual(idle, 0);
    assert.strictEqual(running, 0);
    assert.strictEqual(quiescing, 0);
  });
});

describe("Phase 7b — OrchestratorManager constructor + addTerminal + updateSettings + syncLedger", () => {
  function makeManager() {
    const store = new JanusStore(":memory:");
    store.init();
    const manager = new OrchestratorManager({ ledger: store });
    return { store, manager };
  }

  it("constructor boots restored panes INERT (alive=false, is_busy=false, Exited)", () => {
    // Uses the legacy JSON Ledger (live-reference backend the boot reconcile loop targets).
    // Isolate cwd so the Ledger's JSON file lands in a throwaway dir.
    const prev = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p7b-inert-boot-"));
    process.chdir(tmp);
    try {
      const ledger = new Ledger();
      const proj = "default_project";
      ledger.addProject(proj, tmp, "ws");
      ledger.switchContext(proj);
      // Stage a pane that LOOKS alive/busy before boot.
      ledger.updatePane(proj, {
        pane_id: "p-alive", name: "p-alive", runtime_type: "interactive_cli",
        tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop", session_id: "",
        last_known_state: "Running active command", is_busy: true, alive: true, context_size: 0,
        last_command: "", elapsed_ms: 0,
      } as any, true);
      assert.strictEqual(ledger.getProject(proj)!.panes["p-alive"].alive, true, "precondition: staged alive");
      const manager = new OrchestratorManager({ ledger });
      const pane = manager.ledger.getProject(proj)!.panes["p-alive"];
      assert.strictEqual(pane.alive, false, "restored pane reconciled to not-alive on boot (no auto-spawn)");
      assert.strictEqual(pane.is_busy, false);
      assert.strictEqual(pane.last_known_state, "Exited");
    } finally {
      process.chdir(prev);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("addTerminal: dup guard returns the 'already exists' message and does not replace", () => {
    const { store, manager } = makeManager();
    const first = manager.addTerminal("d1", process.cwd(), "echo a", "Custom");
    assert.match(first, /^Created terminal 'd1'/);
    const ref = (manager.terminals as any)["d1"];
    const dup = manager.addTerminal("d1", process.cwd(), "echo b", "Custom");
    assert.strictEqual(dup, "Terminal 'd1' already exists.");
    assert.strictEqual((manager.terminals as any)["d1"], ref, "dup must NOT replace the live terminal");
    store.close();
  });

  it("addTerminal: first pane is elected active; projectId falls back to the active project", () => {
    const { store, manager } = makeManager();
    assert.strictEqual(manager.activeId, null);
    manager.addTerminal("a1", process.cwd(), "echo a", "Custom", "Human-in-the-Loop", "", "");
    assert.strictEqual(manager.activeId, "a1", "first added pane becomes active");
    const term = (manager.terminals as any)["a1"];
    assert.strictEqual(term.projectId, manager.ledger.activeProjectId || "default_project");
    // A second pane does NOT steal active.
    manager.addTerminal("a2", process.cwd(), "echo b", "Custom");
    assert.strictEqual(manager.activeId, "a1");
    store.close();
  });

  it("addTerminal: manager callbacks fan out to per-pane callbacks", () => {
    const { store, manager } = makeManager();
    let outSeen = "";
    let idleSeen = "";
    let runningSeen = "";
    manager.onOutput = (tid) => { outSeen = tid; };
    manager.onIdle = (tid) => { idleSeen = tid; };
    manager.onRunning = (tid) => { runningSeen = tid; };
    manager.addTerminal("cb1", process.cwd(), "echo a", "Custom");
    const term = (manager.terminals as any)["cb1"];
    term.onOutput("cb1", "chunk");
    term.onIdle("cb1");
    term.onRunning("cb1");
    assert.strictEqual(outSeen, "cb1");
    assert.strictEqual(idleSeen, "cb1");
    assert.strictEqual(runningSeen, "cb1");
    store.close();
  });

  it("syncLedger first-registration maps live status to last_known_state / is_busy / alive", () => {
    const { store, manager } = makeManager();
    const proj = manager.ledger.activeProjectId!;
    const mk = (id: string, status: "Running" | "Idle" | "Exited") => {
      const t = new UniversalTerminal(id, process.cwd(), "echo hi", "Custom", "Human-in-the-Loop", "", proj, undefined, makeNoopFactory());
      t.status = status;
      (manager.terminals as any)[id] = t;
      return t;
    };
    mk("s-run", "Running");
    mk("s-idle", "Idle");
    mk("s-exit", "Exited");
    manager.refreshLedger(); // public seam over syncLedger
    const panes = store.getProject(proj)!.panes;
    assert.strictEqual(panes["s-run"].last_known_state, "Running active command");
    assert.strictEqual(panes["s-run"].is_busy, true);
    assert.strictEqual(panes["s-run"].alive, true);
    assert.strictEqual(panes["s-idle"].last_known_state, "Idle");
    assert.strictEqual(panes["s-idle"].is_busy, false);
    assert.strictEqual(panes["s-idle"].alive, true);
    assert.strictEqual(panes["s-exit"].last_known_state, "Exited");
    assert.strictEqual(panes["s-exit"].is_busy, false);
    assert.strictEqual(panes["s-exit"].alive, false);
    store.close();
  });

  it("syncLedger carries session_id and tool_preset from the live term on first registration", () => {
    const { store, manager } = makeManager();
    const proj = manager.ledger.activeProjectId!;
    const t = new UniversalTerminal("s-sess", process.cwd(), "codex", "Codex", "Human-in-the-Loop", "", proj, undefined, makeNoopFactory());
    (manager.terminals as any)["s-sess"] = t;
    manager.refreshLedger();
    const pane = store.getProject(proj)!.panes["s-sess"];
    assert.strictEqual(pane.tool_preset, "Codex");
    assert.strictEqual(pane.session_id, t.sessionId, "session_id falls back to the live term id");
    store.close();
  });
});

describe("Phase 7b — updateSettings partial-merge characterization (tmp cwd)", () => {
  let prevCwd: string;
  let tmpDir: string;
  let store: JanusStore;
  let manager: OrchestratorManager;
  before(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p7b-update-settings-"));
    process.chdir(tmpDir);
    store = new JanusStore(":memory:");
    store.init();
    manager = new OrchestratorManager({ ledger: store });
  });
  after(() => {
    store.close();
    process.chdir(prevCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("merges only the provided sections; omitted sections survive untouched", () => {
    const beforeVoiceAi = { ...(manager.settings.voiceAi ?? {}) };
    manager.updateSettings({ server: { port: 9191 } as any });
    assert.strictEqual((manager.settings.server as any).port, 9191, "server section merged");
    // voiceAi object identity / contents are unchanged by a server-only update.
    for (const k of Object.keys(beforeVoiceAi)) {
      assert.deepStrictEqual(
        (manager.settings.voiceAi as any)[k],
        (beforeVoiceAi as any)[k],
        `voiceAi.${k} untouched by a server-only update`,
      );
    }
  });

  it("capabilityGates deep-merge: a partial map layers on top of DEFAULT_CAPABILITY_GATES", () => {
    manager.updateSettings({ advanced: { capabilityGates: { restart_pane: "Off" } } as any });
    const gates = manager.settings.advanced!.capabilityGates!;
    assert.strictEqual((gates as any).restart_pane, "Off", "the provided gate is applied");
    // A capability NOT mentioned in the partial map resolves from defaults, not undefined.
    assert.ok(Object.keys(gates).length > 1, "unmentioned capabilities retained from defaults (no whole-matrix replace)");
  });

  it("advanced.globalPermissionsMode is mirrored onto the manager field", () => {
    manager.updateSettings({ advanced: { globalPermissionsMode: "Read-Only" } as any });
    assert.strictEqual((manager as any).globalPermissionsMode, "Read-Only");
  });

  it("secrets shallow-merge keeps prior secret keys", () => {
    manager.updateSettings({ secrets: { geminiApiKey: "k1", other: "v" } as any });
    manager.updateSettings({ secrets: { geminiApiKey: "k2" } as any });
    assert.strictEqual((manager.settings.secrets as any).geminiApiKey, "k2");
    assert.strictEqual((manager.settings.secrets as any).other, "v", "prior secret key survives a partial secrets update");
  });
});
