// Offline voice-agent simulator.
//
//   npm run sim
//
// Boots the real server with a FAKE Gemini Live session (no API key, no
// microphone), connects as a browser client, and drives a scripted voice
// scenario through the genuine tool-dispatch + approval pipeline — printing a
// readable trace of every tool call, tool response and broadcast event.
//
// Use it to exercise / demo the orchestration logic end-to-end without any
// external dependencies.

import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const isWin = process.platform === "win32";
const shell = isWin ? "cmd.exe" : "/bin/sh";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
};

function banner(text: string) {
  console.log(`\n${C.cyan}━━ ${text} ${"━".repeat(Math.max(0, 60 - text.length))}${C.reset}`);
}

async function main() {
  process.env.NODE_ENV = "test"; // keep it quiet / no vite
  process.env.JANUS_NO_AUTOSTART = "1"; // we own the server lifecycle here
  // Run against a throwaway working dir so the simulation never pollutes the
  // repo with .janus_* runtime files. server.ts builds its OrchestratorManager
  // (which restores panes from the cwd ledger) at module load, so it must be
  // imported *after* chdir — hence the dynamic imports below.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-sim-"));
  process.chdir(tmpDir);

  const { installMockLive, waitFor } = await import("../tests/helpers/mockLive");
  const { startServer, API_AUTH_TOKEN } = await import("../server");

  const mock = installMockLive();
  const running = await startServer({ port: 0, enableVite: false });
  const base = `http://127.0.0.1:${running.port}`;

  const api = (p: string, init: RequestInit = {}) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-token": API_AUTH_TOKEN,
        ...(init.headers || {}),
      },
    });

  const client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
    headers: { Cookie: `auth_token=${API_AUTH_TOKEN}` },
  });
  client.on("message", (d) => {
    try {
      const m = JSON.parse(d.toString());
      // Surface the orchestration broadcasts; skip chatty audio/transcript frames.
      if (["approval_pending", "command_auto_executed", "command_blocked", "pane_transition"].includes(m.type)) {
        console.log(`   ${C.magenta}«event» ${m.type}${C.reset} ${C.dim}${JSON.stringify({ terminalId: m.terminalId, cmd: m.cmd, transition: m.transition, messageId: m.messageId })}${C.reset}`);
      }
    } catch {}
  });
  await new Promise<void>((resolve, reject) => {
    client.on("open", () => resolve());
    client.on("error", reject);
  });

  const session = await waitFor(() => mock.latest());
  console.log(`${C.green}✓ Mock Live session established${C.reset} ${C.dim}(model: ${session.params.model})${C.reset}`);

  // Helper: emit a tool call and print the response the agent would receive.
  async function call(name: string, args: Record<string, any> = {}) {
    console.log(`${C.yellow}→ tool_call${C.reset} ${name} ${C.dim}${JSON.stringify(args)}${C.reset}`);
    const id = session.emitToolCall(name, args);
    const output = await waitFor(() => mock.responseFor(id), 4000);
    const printable = typeof output === "string" ? output : JSON.stringify(output);
    console.log(`   ${C.green}← response${C.reset} ${printable.slice(0, 300)}`);
    return { id, output };
  }

  banner("1. Create a project workspace");
  await call("create_project", { project_id: "demo", directory: ".", summary: "Simulated demo workspace" });

  banner("2. Spin up a Full-Auto build pane");
  await call("create_pane", { project_id: "demo", pane_id: "builder", command: shell, permissions_mode: "Full Auto" });

  banner("3. Orient with list_panes");
  await call("list_panes");

  banner("4. Propose a command on the Full-Auto pane (runs immediately)");
  await call("propose_command", { pane_id: "builder", command: "echo building..." });

  banner("5. Spin up a Human-in-the-Loop deploy pane");
  await call("create_pane", { project_id: "demo", pane_id: "deployer", command: shell, permissions_mode: "Human-in-the-Loop" });

  banner("6. Propose a command on the HITL pane (waits for operator approval)");
  const proposeId = session.emitToolCall("propose_command", { pane_id: "deployer", command: "echo deploying to prod" });
  console.log(`${C.yellow}→ tool_call${C.reset} propose_command ${C.dim}{pane_id:"deployer"}${C.reset}`);
  const pending = await waitFor(() =>
    // The approval is exposed over REST for the operator UI.
    fetch(`${base}/api/commands/pending`, { headers: { "x-api-token": API_AUTH_TOKEN } })
      .then((r) => r.json())
      .then((list: any[]) => list.find((p) => p.cmd === "echo deploying to prod"))
      .catch(() => undefined)
  );
  console.log(`   ${C.dim}pending approval queued: ${pending.messageId}${C.reset}`);
  console.log(`   ${C.dim}...operator clicks Approve...${C.reset}`);
  await api("/api/commands/approve", {
    method: "POST",
    body: JSON.stringify({ messageId: pending.messageId, approved: true }),
  });
  const approvedOutput = await waitFor(() => mock.responseFor(proposeId), 4000);
  console.log(`   ${C.green}← response${C.reset} ${approvedOutput}`);

  banner("7. Block a command under Read-Only");
  await call("set_global_permissions", { permissions_mode: "Read-Only" });
  await call("propose_command", { pane_id: "builder", command: "rm -rf /" });
  await call("set_global_permissions", { permissions_mode: "Inherit" });

  banner("Done — tearing down");
  client.close();
  await running.close();
  console.log(`${C.green}✓ Simulation complete.${C.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
