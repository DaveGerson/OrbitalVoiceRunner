import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { Ledger } from "../src/ledger";

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

