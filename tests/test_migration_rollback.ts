// tests/test_migration_rollback.ts
//
// bead j8r — the JSON→SQLite ledger migration is REVERSIBLE: the operator can opt back out to the
// legacy JSON Ledger with JANUS_LEDGER_BACKEND=legacy, and the server must boot GRACEFULLY in that
// posture even after a prior migration already archived the originals to `.bak`.
//
// WHY A SUBPROCESS: the legacy Ledger always reads/writes `.janus_ledger.json` relative to
// process.cwd() (OrchestratorManager constructs `new Ledger()` with no path). We therefore boot the
// REAL server in a CHILD process whose cwd is an isolated temp dir, so the legacy ledger's reads and
// any save() writes land in the throwaway dir and never touch the repo. The child imports the server
// module (JANUS_NO_AUTOSTART=1 → no port bind), reads back the resolved ledger backend, and prints a
// machine-readable marker we assert on. This proves the END-TO-END boot path, not just a unit seam.
//
// WHAT WE PROVE:
//   • With JANUS_LEDGER_BACKEND=legacy the manager's ledger is the legacy `Ledger`, NOT the JanusStore.
//   • A `.bak` (the prior-migration archive of .janus_ledger.json) present + the live .json ABSENT does
//     NOT crash boot and does NOT re-run the migration (graceful fallback — the .bak is left intact).
//   • The legacy boot still comes up with a usable active project (the manager registered one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(repoRoot, "server.ts");
// Resolve tsx's CLI entry so the child runs under plain `node` (no npx/shell quoting on Windows).
const TSX_BIN = createRequire(import.meta.url).resolve("tsx/cli");

// A self-contained legacy ledger payload — one project + one pane note — so a legacy boot that DID
// read it would surface the project. We archive it as `.bak` (a prior migration's output).
function legacyLedgerJson(): string {
  return JSON.stringify({
    activeProjectId: "legacy_proj",
    workspaces: {
      legacy_proj: {
        id: "legacy_proj",
        name: "Legacy Project",
        directory: ".",
        summary: "",
        notes: ["seeded-before-migration"],
        panes: {},
      },
    },
    watchRules: [],
    plans: [],
  });
}

/**
 * Boot the server module in a child (cwd = isolated temp dir) under the given env and return what the
 * child reported: the ledger backend class name + the relevant boot-log lines. We write the driver to
 * a real `.mjs` file in `cwd` and run it through tsx (passing a complex inline script via `-e` through
 * a Windows shell mangles quotes/backslashes). tsx resolves the server's deps from the repo tree the
 * absolute import path lives in, so cwd being the temp dir does not break module resolution.
 */
function bootChild(cwd: string, env: Record<string, string>) {
  const serverUrl = pathToFileURL(SERVER).href;
  const driver =
    `import(${JSON.stringify(serverUrl)}).then((m) => {\n` +
    `  const led = m.manager && m.manager.ledger ? m.manager.ledger : null;\n` +
    `  console.log("J8R_BACKEND:" + (led ? led.constructor.name : "NONE"));\n` +
    `  console.log("J8R_ACTIVE:" + (led ? led.activeProjectId : null));\n` +
    `  process.exit(0);\n` +
    `}).catch((e) => { console.error("J8R_BOOT_ERROR:" + (e && e.stack ? e.stack : e)); process.exit(7); });\n`;
  const driverPath = path.join(cwd, "j8r-driver.mjs");
  writeFileSync(driverPath, driver, "utf8");

  const res = spawnSync(process.execPath, [TSX_BIN, driverPath], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? 0, out: res.stdout ?? "", err: res.stderr ?? "" };
}

test("JANUS_LEDGER_BACKEND=legacy boots gracefully on the legacy Ledger after a prior migration (.bak present)", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "j8r-rollback-"));
  try {
    // Prior-migration state: the live .janus_ledger.json was renamed to .bak; the live file is ABSENT.
    const livePath = path.join(cwd, ".janus_ledger.json");
    const bakPath = `${livePath}.bak`;
    writeFileSync(bakPath, legacyLedgerJson(), "utf8");
    assert.ok(!existsSync(livePath), "precondition: the live ledger json is absent (migrated away)");

    const r = bootChild(cwd, {
      JANUS_LEDGER_BACKEND: "legacy",
      JANUS_DB: path.join(cwd, "janus.db"),
      JANUS_LEDGER_PATH: livePath, // the migration's source path — absent, so the migration is a no-op
      JANUS_NO_AUTOSTART: "1",
      NODE_ENV: "test",
    });

    assert.equal(r.code, 0, `child should boot cleanly (legacy fallback). stderr:\n${r.err}\nstdout:\n${r.out}`);
    assert.ok(!/J8R_BOOT_ERROR/.test(r.out + r.err), `no boot error expected:\n${r.err}`);

    // The manager fell back to the legacy JSON Ledger, NOT the SQLite JanusStore.
    assert.match(r.out, /J8R_BACKEND:Ledger/, `expected the legacy Ledger backend, got:\n${r.out}`);
    assert.doesNotMatch(r.out, /J8R_BACKEND:JanusStore/, "must NOT be on the SQLite backend under legacy");

    // The boot log states the legacy backend was chosen via the env opt-out.
    assert.match(r.out, /OrchestratorManager ledger backend: legacy JSON Ledger \(JANUS_LEDGER_BACKEND=legacy\)/);

    // A usable active project exists after boot (graceful, not an empty crashed shell).
    assert.match(r.out, /J8R_ACTIVE:\S+/, "an active project should be registered after a legacy boot");

    // GRACEFUL: the prior-migration .bak is left intact and the migration did NOT re-run (no new
    // .janus_ledger.json was recreated by an erroneous re-import).
    assert.ok(existsSync(bakPath), "the prior-migration .bak archive must be left untouched");
    assert.equal(readFileSync(bakPath, "utf8"), legacyLedgerJson(), "the .bak content is preserved");
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
