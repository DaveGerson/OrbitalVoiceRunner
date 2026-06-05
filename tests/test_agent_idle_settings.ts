import { describe, it } from "node:test";
import assert from "node:assert";
import { OrchestratorManager, UniversalTerminal } from "../src/terminal";

/**
 * Conservative Phase 2 settings plumbing: the low-risk agent idle-timing safeguard
 * (`advanced.agentIdleTimeoutMs`) must round-trip through the manager and be applied to
 * live interactive_cli terminals — on addTerminal AND on updateSettings — while shell
 * panes stay on the existing idleTimeoutMs (no regression). Mirrors the idleTimeoutMs
 * propagation pattern (terminal.ts updateSettings).
 */

describe("agentIdleTimeoutMs settings plumbing (Conservative Phase 2)", () => {
  it("updateSettings({advanced:{agentIdleTimeoutMs}}) propagates to live terminals", () => {
    const manager = new OrchestratorManager();
    // Insert a terminal WITHOUT spawning a PTY (start() is what spawns; we never call it).
    const agent = new UniversalTerminal("agent1", ".", "claude", "Claude Code", "Human-in-the-Loop", "", "default_project");
    const shell = new UniversalTerminal("shell1", ".", "bash", "Custom", "Human-in-the-Loop", "", "default_project");
    manager.terminals["agent1"] = agent;
    manager.terminals["shell1"] = shell;

    manager.updateSettings({ advanced: { agentIdleTimeoutMs: 4200 } as any });

    assert.strictEqual(agent.agentIdleTimeoutMs, 4200, "live agent pane picks up the new agentIdleTimeoutMs");
    assert.strictEqual(shell.agentIdleTimeoutMs, 4200, "the field propagates to every term (only consumed by interactive_cli)");
    // The shell pane's shell idleTimeoutMs is independent and untouched by this update.
    assert.strictEqual(shell.idleTimeoutMs, 2000, "shell panes keep the documented 2000ms idle timeout");
  });

  it("updateSettings idleTimeoutMs and agentIdleTimeoutMs are independent (no cross-talk)", () => {
    const manager = new OrchestratorManager();
    const agent = new UniversalTerminal("agent2", ".", "claude", "Claude Code", "Human-in-the-Loop", "", "default_project");
    manager.terminals["agent2"] = agent;

    manager.updateSettings({ advanced: { idleTimeoutMs: 1500 } as any });
    assert.strictEqual(agent.idleTimeoutMs, 1500, "idleTimeoutMs update lands");
    // The default agent timeout is unchanged by a pure idleTimeoutMs update.
    assert.strictEqual(agent.agentIdleTimeoutMs, 3500, "agentIdleTimeoutMs default survives an idleTimeoutMs-only update");

    manager.updateSettings({ advanced: { agentIdleTimeoutMs: 6000 } as any });
    assert.strictEqual(agent.agentIdleTimeoutMs, 6000, "agentIdleTimeoutMs update lands");
    assert.strictEqual(agent.idleTimeoutMs, 1500, "the earlier idleTimeoutMs is not clobbered");
  });

  it("addTerminal applies settings.advanced.agentIdleTimeoutMs to a freshly created interactive_cli pane", async () => {
    const manager = new OrchestratorManager();
    manager.updateSettings({ advanced: { agentIdleTimeoutMs: 4800 } as any });

    // addTerminal spawns a PTY; tear it down after the assertion.
    manager.addTerminal("agent3", ".", "echo hi", "Claude Code");
    const term = manager.terminals["agent3"];
    try {
      assert.ok(term, "agent3 was created");
      assert.strictEqual(term.agentIdleTimeoutMs, 4800, "addTerminal seeds agentIdleTimeoutMs from settings");
    } finally {
      await term?.stop();
    }
  });
});
