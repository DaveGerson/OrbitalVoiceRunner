import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { UniversalTerminal, OrchestratorManager, stripAnsiSequences } from "../src/terminal";

describe("Orchestrator Terminal Logic Test Suite", () => {
  it("should correctly strip ANSI sequences from text", () => {
    const textWithAnsi = "\x1b[31;1mCritical Error:\x1b[0m \x1b[32mSystem rebooting...\x1b[0m";
    const cleanText = stripAnsiSequences(textWithAnsi);
    assert.strictEqual(cleanText, "Critical Error: System rebooting...");
  });

  describe("UniversalTerminal", () => {
    let term: UniversalTerminal;

    after(() => {
      if (term) term.stop();
    });

    it("should start a process and capture output", async () => {
      const isWin = process.platform === "win32";
      const cmd = isWin ? "echo Hello Test" : "echo 'Hello Test'";
      term = new UniversalTerminal("test-1", process.cwd(), cmd);
      term.start();

      await new Promise((resolve) => setTimeout(resolve, 500));
      const output = term.getRecentOutput(10);
      assert.ok(output.includes("Hello Test"), `Output should contain 'Hello Test', got: ${output}`);
    });

    it("should write input to a long-running process", async () => {
      const isWin = process.platform === "win32";
      const cmd = isWin ? "cmd.exe" : "/bin/sh";
      
      term = new UniversalTerminal("test-input", process.cwd(), cmd);
      term.start();

      await new Promise((resolve) => setTimeout(resolve, 500));
      term.writeInput("echo async_input_received");

      await new Promise((resolve) => setTimeout(resolve, 1000));
      const output = term.getRecentOutput(20);
      assert.ok(output.includes("async_input_received"), `Output should contain 'async_input_received', got: ${output}`);
    });
  });

  describe("OrchestratorManager", () => {
    let manager: OrchestratorManager;

    beforeEach(() => {
      manager = new OrchestratorManager();
    });

    it("should manage multiple panes correctly", async () => {
      const res1 = manager.addTerminal("term-1", process.cwd(), process.platform === "win32" ? "echo 1" : "echo 1");
      assert.ok(res1.includes("Created terminal 'term-1'"));
      
      const res2 = manager.addTerminal("term-1", process.cwd(), "echo 2");
      assert.strictEqual(res2, "Terminal 'term-1' already exists.");

      assert.strictEqual(manager.activeId, "term-1");
      assert.ok(manager.terminals["term-1"]);

      await new Promise((resolve) => setTimeout(resolve, 200));
      manager.terminals["term-1"].stop();
    });

    it("should list panes", async () => {
      manager.addTerminal("pane_1", process.cwd(), process.platform === "win32" ? "echo 'test'" : "echo 'test'");
      const list = manager.listPanes();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].project_id, "default_project");
      assert.strictEqual(list[0].panes.length, 1);
      assert.strictEqual(list[0].panes[0].pane_id, "pane_1");
      assert.strictEqual(typeof list[0].panes[0].is_busy, "boolean");
      assert.strictEqual(list[0].panes[0].alive, true);
      assert.ok(list[0].panes[0].last_known_state);

      manager.terminals["pane_1"].stop();
    });

    it("should get pane summary", async () => {
      manager.addTerminal("pane_1", process.cwd(), process.platform === "win32" ? "echo 'summary test'" : "echo 'summary test'");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const summary = manager.getPaneSummary("pane_1");
      assert.ok(summary.includes("summary test"));
      assert.ok(summary.startsWith("```"));

      manager.terminals["pane_1"].stop();
    });
  });
});
