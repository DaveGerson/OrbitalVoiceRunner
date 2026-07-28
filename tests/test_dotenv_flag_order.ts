// tests/test_dotenv_flag_order.ts — bead ih56 acceptance: feature flags set ONLY in a cwd .env
// file (not real environment variables) must be honored by the module-load flag readers.
//
// THE BUG SHAPE: server.ts imported dotenv but called dotenv.config() AFTER its import block, and
// that import block transitively evaluates every module-load flag reader (src/exchanges/flag.ts
// JANUS_EXCHANGE_SPINE, src/exchanges/resultEnvelope.ts JANUS_AGENT_COMPLETION_PROMPT, the
// transcript sink flag, …). Each caches its value from process.env at first evaluation — so a
// .env-only flag was read as its DEFAULT because the flag module froze before dotenv.config()
// populated process.env. Real env vars and .janus_settings.json were unaffected.
//
// WHY A SUBPROCESS: the freeze under test is process-global and fires exactly once per process at
// import time — it cannot be observed by importing server.ts inside this test's own (already
// booted, already frozen) process. Same probe shape as tests/test_server_import_side_effects.ts:
// a temp .mjs file run via `npx tsx <path>` (inline `-e` scripts die on POSIX /bin/sh — see
// tests/test_mocklive_loader.ts).
//
// THE TWO PROBED FLAGS cover both directions of the failure:
//   - JANUS_AGENT_COMPLETION_PROMPT=on  (.env turns a default-off flag ON)
//   - JANUS_EXCHANGE_SPINE=off          (.env engages the default-record ESCAPE HATCH — the
//     safety-relevant direction: an operator disabling the subsystem via .env must not silently
//     keep it running)
//
// Runner: npx tsx --test --test-force-exit tests/test_dotenv_flag_order.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const serverPath = path.join(repoRoot, "server.ts");
const resultEnvelopePath = path.join(repoRoot, "src", "exchanges", "resultEnvelope.ts");
const flagPath = path.join(repoRoot, "src", "exchanges", "flag.ts");

test("flags set only in a cwd .env are honored by the module-load flag readers (subprocess)", () => {
  // The child's cwd IS the tmpdir: dotenv reads cwd/.env, and any stray store/settings write
  // lands in the tmpdir, never the repo root.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-dotenv-flag-order-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      "JANUS_AGENT_COMPLETION_PROMPT=on\nJANUS_EXCHANGE_SPINE=off\n",
      "utf8",
    );
    // Value-import server.ts FIRST (evaluating its whole import graph, freezing every flag
    // module), then read the frozen constants back out of the (already-cached) flag modules.
    const probeSrc = `
      import { pathToFileURL } from "node:url";
      await import(pathToFileURL(${JSON.stringify(serverPath)}).href);
      const { AGENT_COMPLETION_PROMPT_MODE } = await import(pathToFileURL(${JSON.stringify(resultEnvelopePath)}).href);
      const { EXCHANGE_SPINE_MODE } = await import(pathToFileURL(${JSON.stringify(flagPath)}).href);
      console.log("FLAGS " + JSON.stringify({ completionPrompt: AGENT_COMPLETION_PROMPT_MODE, spine: EXCHANGE_SPINE_MODE }));
      process.exit(0);
    `;
    const scriptPath = path.join(tmpDir, "probe.mjs");
    fs.writeFileSync(scriptPath, probeSrc, "utf8");

    // The .env file must be the ONLY source of these flags — delete any ambient values (and the
    // legacy spellings resultEnvelope's back-compat shim also consults) so the test cannot be
    // greened or reddened by the parent environment.
    const childEnv = { ...process.env };
    delete childEnv.JANUS_AGENT_COMPLETION_PROMPT;
    delete childEnv.JANUS_EXCHANGE_SPINE;
    delete childEnv.JANUS_AGENT_RESULT_ENVELOPE;
    delete childEnv.JANUS_INSTRUCTION_ENVELOPE;
    delete childEnv.JANUS_NO_AUTOSTART;
    delete childEnv.JANUS_DB;

    const child = spawnSync("npx", ["tsx", scriptPath], {
      cwd: tmpDir,
      env: childEnv,
      encoding: "utf8",
      shell: true,
      timeout: 60000,
    });

    const combined = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    assert.equal(child.status, 0, `probe child exited ${child.status}. stdout/stderr:\n${combined}`);
    const line = (child.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("FLAGS "));
    assert.ok(line, `probe printed no FLAGS line. stdout/stderr:\n${combined}`);
    const flags = JSON.parse(line.slice("FLAGS ".length));
    assert.equal(
      flags.completionPrompt,
      "on",
      ".env-only JANUS_AGENT_COMPLETION_PROMPT=on must be read as 'on', not the cached default",
    );
    assert.equal(
      flags.spine,
      "off",
      ".env-only JANUS_EXCHANGE_SPINE=off (the escape hatch) must be read as 'off', not the cached default",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
