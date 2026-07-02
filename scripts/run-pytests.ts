// Cross-platform `test:py` runner. Reuses the D4 interpreter discovery. EXITS 0 with a notice
// when no interpreter exists, so the JS battery stays green on a Python-less dev box.
import { spawnSync } from "node:child_process";
import { discoverPythonInterpreter } from "../src/memory/pythonClient";

// Voice-UX wave 3: a SECOND discover invocation covers python/policies/tests (the "policies" daemon —
// focus resolution + SITREP ranking), a separate module dir from python/synthesizer. Both suites run;
// a failure in EITHER is a failure of `test:py` (non-zero exit), not just the first.
const TEST_DIRS = ["python/synthesizer/tests", "python/policies/tests"];

function runDiscover(cmd: string, baseArgs: string[], dir: string): number {
  const r = spawnSync(
    cmd,
    [...baseArgs, "-X", "utf8", "-m", "unittest", "discover", "-s", dir, "-p", "test_*.py", "-v"],
    { stdio: "inherit", env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } },
  );
  return r.status ?? 1;
}

const cands = discoverPythonInterpreter(process.env, process.platform);
for (const c of cands) {
  const probe = spawnSync(c.cmd, [...c.baseArgs, "--version"], { stdio: "ignore" });
  if (probe.status === 0) {
    let exitCode = 0;
    for (const dir of TEST_DIRS) {
      const status = runDiscover(c.cmd, c.baseArgs, dir);
      if (status !== 0) exitCode = status;
    }
    process.exit(exitCode);
  }
}
console.error("[test:py] no Python interpreter found — skipping python tests (this is OK on a Python-less box)");
process.exit(0);
