// tests/helpers/agentBins.ts — PATH fixture for the create_pane spawn preflight (bead
// wsm-e2e-pinned-0bof). Suites that drive create_pane with an AGENT preset (Claude Code / Codex /
// Antigravity) spy addTerminal and never spawn, so they historically never cared whether the
// claude/codex/agy binaries were installed — the preflight (src/binaryOnPath.ts) now resolves the
// derived binary against the REAL PATH before the handler proceeds. Seed a throwaway dir with
// bare-named stand-ins (never executed) and prepend it to PATH so those suites stay host/CI
// independent, exactly as they were before the preflight existed. Call the returned restore() in
// after() — leaking the prepended PATH across suites would mask a genuinely broken preflight.
import fs from "fs";
import os from "os";
import path from "path";

export function seedAgentBinsOnPath(bins: string[] = ["claude", "codex", "agy"]): () => void {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-agent-bins-"));
  for (const bin of bins) fs.writeFileSync(path.join(binDir, bin), "");
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ""}`;
  return () => { process.env.PATH = prevPath; };
}
