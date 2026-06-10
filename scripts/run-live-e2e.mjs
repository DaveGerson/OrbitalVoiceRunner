// Live-lane e2e runner (4U.4). Exists ONLY to set PW_LIVE=1 portably — npm scripts can't set an
// env var cross-platform (POSIX `PW_LIVE=1 …` breaks under cmd.exe on the Windows dev box).
// PW_LIVE=1 flips playwright.config.ts into the "live" project: the REAL `tsx server.ts` webServer
// on a fresh temp JANUS_DB, no ?mock=1. Extra CLI args pass through (e.g. --headed, -g).
import { spawnSync } from "node:child_process";

const r = spawnSync(
  "npx",
  ["playwright", "test", "--project=live", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, PW_LIVE: "1" },
    shell: process.platform === "win32",
  },
);
process.exit(r.status ?? 1);
