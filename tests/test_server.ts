import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { UniversalTerminal, OrchestratorManager, stripAnsiSequences } from "../src/terminal";

// IDs of scrollback files created by this test suite
const SUITE_SCROLLBACK_IDS = ["test-1", "test-input", "term-1", "pane_1"];

function deleteScrollback(id: string): void {
  const p = `.janus_scrollback_${id}.log`;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

describe("Orchestrator Terminal Logic Test Suite", () => {
  const TEST_LEDGER = ".janus_ledger.json";

  after(() => {
    SUITE_SCROLLBACK_IDS.forEach(deleteScrollback);
  });

  beforeEach(() => {
    if (fs.existsSync(TEST_LEDGER)) {
      fs.unlinkSync(TEST_LEDGER);
    }
  });

  it("should correctly strip ANSI sequences from text", () => {

    const textWithAnsi = "\x1b[31;1mCritical Error:\x1b[0m \x1b[32mSystem rebooting...\x1b[0m";
    const cleanText = stripAnsiSequences(textWithAnsi);
    assert.strictEqual(cleanText, "Critical Error: System rebooting...");
  });

  describe("UniversalTerminal", () => {
    let term: UniversalTerminal;

    after(async () => {
      // Real ConPTY pane: await stop(), which now internally drains node-pty's delayed
      // conout-worker teardown (a worker_threads.Worker = a libuv uv_async_t) so
      // --test-force-exit can't uv_close() it mid-terminate (src\win\async.c:76 abort).
      if (term) await term.stop();
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
      await manager.terminals["term-1"].stop();
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

      await manager.terminals["pane_1"].stop();
    });

    it("should get pane summary", async () => {
      manager.addTerminal("pane_1", process.cwd(), process.platform === "win32" ? "echo 'summary test'" : "echo 'summary test'");
      // Poll for the captured echo instead of a single fixed sleep: under full-suite
      // parallel ConPTY load the PTY-capture latency can exceed any fixed wait (this step
      // has been observed taking ~3s), so a hard `setTimeout(500)` race-flakes. Poll
      // getPaneSummary until the echoed line lands, with a generous ceiling.
      let summary = manager.getPaneSummary("pane_1");
      const deadline = Date.now() + 15000;
      while (!summary.includes("summary test") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        summary = manager.getPaneSummary("pane_1");
      }
      assert.ok(summary.includes("summary test"));
      assert.ok(summary.startsWith("```"));

      await manager.terminals["pane_1"].stop();
    });

    it("should manage and access attentionQueue and automation items layout structures", () => {
      assert.strictEqual(manager.attentionQueue.length, 0);

      // Add dummy attention item
      manager.attentionQueue.push({
        id: "att_foo",
        type: "build-failed",
        terminalId: "pane_x",
        projectId: "default_project",
        message: "Module build failed on Vite packager",
        timestamp: new Date().toISOString(),
        dismissed: false
      });

      assert.strictEqual(manager.attentionQueue.length, 1);
      assert.strictEqual(manager.attentionQueue[0].type, "build-failed");
      assert.strictEqual(manager.attentionQueue[0].dismissed, false);
    });

    it("should register plans and watch rules inside OrchestratorManager ledger storage block", () => {
      assert.strictEqual(manager.ledger.watchRules.length, 0);
      assert.strictEqual(manager.ledger.plans.length, 0);

      // Create dummy structures
      const rule = {
        id: "rule_x",
        triggerTerminalId: "pane_a",
        triggerTransition: "exited" as const,
        actionTerminalId: "pane_b",
        actionCommand: "npm run dev",
        enabled: true,
        oneShot: false
      };
      manager.ledger.watchRules.push(rule);

      const plan = {
        id: "plan_y",
        name: "CI pipeline",
        steps: [
          { id: "step_0", terminalId: "pane_a", command: "npm test", expectedTransition: "idle" as const, status: "pending" as const }
        ],
        currentStepIndex: 0,
        status: "idle" as const
      };
      manager.ledger.plans.push(plan);

      assert.strictEqual(manager.ledger.watchRules.length, 1);
      assert.strictEqual(manager.ledger.plans.length, 1);
      assert.strictEqual(manager.ledger.plans[0].name, "CI pipeline");
    });
  });
});
