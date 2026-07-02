// scripts/checkE2ePortsFree.mjs — post-run port-leak diagnostic (BEAD wsm-e2e-pinned-rwnq).
//
// WHY THIS EXISTS: when a stuck E2E run was SIGKILLed from outside Playwright, its webServer child
// (`vite --port 5173` for the mock lane, `tsx server.ts` on 3117 for the live lane) survived and
// kept listening. The leak was only ever discovered by manual artifact spelunking. This tool makes
// the leak self-reporting: after a lane's wrapper tears the child down, it probes the lane's
// port(s) and prints an unambiguous FREE / BUSY line per port.
//
// DELIBERATELY REPORT-ONLY: it NEVER kills the owner of a busy port. A human's own dev server can
// legitimately be bound to 5173/3117 outside a test run, so auto-killing an unknown PID would be a
// footgun. It prints the platform-appropriate command to find the owner instead. Exit code stays 0
// unless `--strict` is passed, so it is safe to wire into a `finally` today without breaking a
// green build; a future CI step can opt into `--strict` to hard-fail on a real leak.
//
// CLI:  node scripts/checkE2ePortsFree.mjs [--strict] [port...]   (default ports: 5173 3117)
//
// CONSTRAINT: Node built-ins only (mirrors check-deps.mjs / run-unit.mjs).

import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { MOCK_PORT, LIVE_PORT } from "./e2eBudgets.mjs";

/**
 * Pure: classify the result of attempting to bind a port.
 *   - `null` error (the listen succeeded) => 'FREE' (nothing else holds the port).
 *   - EADDRINUSE / EACCES => 'BUSY' (someone is holding it — a possible leak).
 *   - anything else => 'UNKNOWN' (we could not determine; do not claim a leak).
 */
export function classifyPortProbe(err) {
  if (!err) return "FREE";
  if (err.code === "EADDRINUSE" || err.code === "EACCES") return "BUSY";
  return "UNKNOWN";
}

/** Platform-appropriate hint for finding the PID that owns a port (printed, never executed). */
export function ownerHint(port, platform = process.platform) {
  return platform === "win32"
    ? `netstat -ano | findstr :${port}`
    : `lsof -i :${port}`;
}

/**
 * Probe a single port by attempting to listen on it, then immediately closing. Resolves to the
 * classification string. Best-effort and side-effect-free on success (the throwaway server is
 * always closed). Binds on 0.0.0.0 to match how the webServers bind.
 */
export function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err) => {
      resolve(classifyPortProbe(err));
    });
    srv.once("listening", () => {
      srv.close(() => resolve(classifyPortProbe(null)));
    });
    srv.listen(port, "0.0.0.0");
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes("--strict");
  const portArgs = argv.filter((a) => a !== "--strict").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const ports = portArgs.length > 0 ? portArgs : [MOCK_PORT, LIVE_PORT];

  let anyBusy = false;
  for (const port of ports) {
    const verdict = await probePort(port);
    if (verdict === "BUSY") {
      anyBusy = true;
      console.error(`[check-ports] BUSY  :${port} — a process is still listening (possible E2E leak). Find it with: ${ownerHint(port)}`);
    } else if (verdict === "UNKNOWN") {
      console.warn(`[check-ports] UNKNOWN :${port} — could not determine port state.`);
    } else {
      console.log(`[check-ports] FREE  :${port}`);
    }
  }

  if (anyBusy && strict) process.exit(1);
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
