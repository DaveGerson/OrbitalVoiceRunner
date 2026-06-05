// Cross-platform `test:py` runner. Reuses the D4 interpreter discovery. EXITS 0 with a notice
// when no interpreter exists, so the JS battery stays green on a Python-less dev box.
import { spawnSync } from "node:child_process";
import { discoverPythonInterpreter } from "../src/memory/pythonClient";

const cands = discoverPythonInterpreter(process.env, process.platform);
for (const c of cands) {
  const probe = spawnSync(c.cmd, [...c.baseArgs, "--version"], { stdio: "ignore" });
  if (probe.status === 0) {
    const r = spawnSync(
      c.cmd,
      [...c.baseArgs, "-X", "utf8", "-m", "unittest", "discover", "-s", "python/synthesizer/tests", "-p", "test_*.py", "-v"],
      { stdio: "inherit", env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } },
    );
    process.exit(r.status ?? 1);
  }
}
console.error("[test:py] no Python interpreter found — skipping python tests (this is OK on a Python-less box)");
process.exit(0);
