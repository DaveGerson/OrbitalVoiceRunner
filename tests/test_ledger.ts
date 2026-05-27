import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { Ledger } from "../src/ledger";

describe("Project Ledger", () => {
  let ledger: Ledger;

  beforeEach(() => {
    ledger = new Ledger();
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
});
