import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { Ledger } from "../src/ledger";
import { PaneMeta } from "../src/types";

const TEST_STORAGE = ".janus_ledger_test.json";

describe("Project Ledger", () => {
  let ledger: Ledger;

  beforeEach(() => {
    if (fs.existsSync(TEST_STORAGE)) {
      fs.unlinkSync(TEST_STORAGE);
    }
    ledger = new Ledger(TEST_STORAGE);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_STORAGE)) {
      fs.unlinkSync(TEST_STORAGE);
    }
  });

  it("should initialize with no active project", () => {
    assert.strictEqual(ledger.getActiveProject(), null);
  });

  it("should create a project and allow switching context", () => {
    ledger.addProject("proj_omega", "/home/omega");
    ledger.switchContext("proj_omega");
    
    assert.strictEqual(ledger.getActiveProject()?.id, "proj_omega");
    assert.strictEqual(ledger.getActiveProject()?.directory, "/home/omega");
  });

  it("should add and persist notes for a project", () => {
    ledger.addProject("proj_omega", "/home/omega");
    ledger.addNote("proj_omega", "Use Python 3.11");
    ledger.addNote("proj_omega", "Test driven development");

    const proj = ledger.getProject("proj_omega");
    assert.strictEqual(proj?.notes.length, 2);
    assert.strictEqual(proj?.notes[0], "Use Python 3.11");

    // Test persistence
    const loadedLedger = new Ledger(TEST_STORAGE);
    const loadedProj = loadedLedger.getProject("proj_omega");
    assert.strictEqual(loadedProj?.notes.length, 2);
    assert.strictEqual(loadedProj?.notes[0], "Use Python 3.11");
  });

  it("should format a project briefing", () => {
    ledger.addProject("proj_omega", "/home/omega", "FastAPI backend.");
    ledger.addNote("proj_omega", "Decision: Rotate JWT keys.");
    
    const briefing = ledger.getProjectBriefing("proj_omega");
    assert.strictEqual(briefing?.project_id, "proj_omega");
    assert.strictEqual(briefing?.summary, "FastAPI backend.");
    assert.strictEqual(briefing?.notes.length, 1);
    assert.deepStrictEqual(briefing?.panes, []);
  });

  it("should layer model/human context per pane and surface legacy notes (prompt-composer §4)", () => {
    ledger.addProject("proj_omega", "/home/omega");
    ledger.updatePane("proj_omega", {
      pane_id: "pane_dev",
      name: "dev",
      runtime_type: "shell",
      last_known_state: "Idle",
      is_busy: false,
      alive: true,
      notes: ["legacy flat note"],
      permissions_mode: "Human-in-the-Loop",
      session_id: "sess_1",
      tool_preset: "Claude Code",
      context_size: 0,
    });

    // A pre-existing flat note must remain readable after the refactor.
    assert.strictEqual(ledger.addModelContext("proj_omega", "pane_dev", "build is a Vite + esbuild split", "synthesizer"), true);
    assert.strictEqual(ledger.addHumanContext("proj_omega", "pane_dev", "focus on the auth module"), true);

    // Writing to a non-existent pane is a no-op that reports failure.
    assert.strictEqual(ledger.addModelContext("proj_omega", "ghost", "nope"), false);

    const ctx = ledger.getPaneContext("proj_omega", "pane_dev");
    assert.strictEqual(ctx?.model.length, 1);
    assert.strictEqual(ctx?.model[0].text, "build is a Vite + esbuild split");
    assert.strictEqual(ctx?.model[0].source, "synthesizer");
    assert.ok(ctx?.model[0].at, "model context entry should carry an ISO timestamp");
    assert.strictEqual(ctx?.human.length, 1);
    assert.strictEqual(ctx?.human[0].text, "focus on the auth module");
    assert.deepStrictEqual(ctx?.legacy, ["legacy flat note"]);

    // Layers persist and reload independently.
    const reloaded = new Ledger(TEST_STORAGE);
    const rctx = reloaded.getPaneContext("proj_omega", "pane_dev");
    assert.strictEqual(rctx?.model[0].text, "build is a Vite + esbuild split");
    assert.strictEqual(rctx?.human[0].text, "focus on the auth module");
    assert.deepStrictEqual(rctx?.legacy, ["legacy flat note"]);
  });

  it("should keep a persistent per-pane WIP draft and list non-empty drafts (step 6)", () => {
    ledger.addProject("proj_omega", "/home/omega");
    const mkPane = (id: string): PaneMeta => ({
      pane_id: id, name: id, runtime_type: "shell", last_known_state: "Idle",
      is_busy: false, alive: true, notes: [], permissions_mode: "Human-in-the-Loop",
      session_id: "", tool_preset: "Claude Code", context_size: 0,
    });
    ledger.updatePane("proj_omega", mkPane("frontend"));
    ledger.updatePane("proj_omega", mkPane("backend"));

    // Compose a draft on each pane (as if working with Janus on both).
    assert.strictEqual(ledger.setDraft("proj_omega", "frontend", "Add a loading spinner", "operator"), true);
    assert.strictEqual(ledger.appendDraft("proj_omega", "backend", "Add JWT rotation", "janus"), true);
    assert.strictEqual(ledger.appendDraft("proj_omega", "backend", "Cover the refresh-token path", "operator"), true);

    // A draft for a missing pane is a no-op failure.
    assert.strictEqual(ledger.setDraft("proj_omega", "ghost", "nope"), false);

    const backend = ledger.getDraft("proj_omega", "backend");
    assert.strictEqual(backend?.text, "Add JWT rotation\nCover the refresh-token path");
    assert.strictEqual(backend?.updatedBy, "operator");
    assert.ok(backend?.updatedAt);

    // The WIP register lists every pane with a non-empty draft (switching away loses nothing).
    const drafts = ledger.listDrafts("proj_omega");
    assert.strictEqual(drafts.length, 2);
    assert.deepStrictEqual(drafts.map((d) => d.paneId).sort(), ["backend", "frontend"]);

    // Drafts persist across reload (durable per-terminal record).
    const reloaded = new Ledger(TEST_STORAGE);
    assert.strictEqual(reloaded.getDraft("proj_omega", "frontend")?.text, "Add a loading spinner");
    assert.strictEqual(reloaded.listDrafts("proj_omega").length, 2);
  });

  it("should persist and reload automation watch rules and plans correctly", () => {
    const dummyRule = {
      id: "rule_alpha",
      triggerTerminalId: "pane_a",
      triggerTransition: "idle" as const,
      actionTerminalId: "pane_b",
      actionCommand: "echo 'fired'",
      enabled: true,
      oneShot: true
    };
    ledger.watchRules.push(dummyRule);

    const dummyPlan = {
      id: "plan_beta",
      name: "Upgrade and deploy pipeline",
      steps: [
        { id: "step_0", terminalId: "pane_a", command: "npm test", expectedTransition: "idle" as const, status: "pending" as const }
      ],
      currentStepIndex: 0,
      status: "idle" as const
    };
    ledger.plans.push(dummyPlan);

    ledger.save(true);

    const secondLedger = new Ledger(TEST_STORAGE);
    assert.strictEqual(secondLedger.watchRules.length, 1);
    assert.strictEqual(secondLedger.watchRules[0].id, "rule_alpha");
    assert.strictEqual(secondLedger.watchRules[0].actionCommand, "echo 'fired'");

    assert.strictEqual(secondLedger.plans.length, 1);
    assert.strictEqual(secondLedger.plans[0].id, "plan_beta");
    assert.strictEqual(secondLedger.plans[0].name, "Upgrade and deploy pipeline");
    assert.strictEqual(secondLedger.plans[0].steps.length, 1);
    assert.strictEqual(secondLedger.plans[0].steps[0].command, "npm test");
  });
});

