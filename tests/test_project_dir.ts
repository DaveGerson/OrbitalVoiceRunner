import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveProjectDir, isBadProjectDir } from "../src/projectDir";

describe("G5 — resolveProjectDir / isBadProjectDir", () => {
  // A path we are confident does NOT exist on any runner (Win + POSIX).
  const BOGUS = path.join(os.tmpdir(), "janus_g5_does_not_exist_" + Date.now());

  it("flags a non-existent, non-blank dir as bad (THE failing test first)", () => {
    assert.strictEqual(fs.existsSync(BOGUS), false, "precondition: bogus path must be absent");
    assert.strictEqual(isBadProjectDir(BOGUS), true);
  });

  it("resolves a bad dir to the fallback instead of storing it", () => {
    assert.strictEqual(resolveProjectDir(BOGUS, process.cwd()), process.cwd());
  });

  it("treats '.' as 'use the fallback' (valid intent, not bad)", () => {
    assert.strictEqual(isBadProjectDir("."), false);
    assert.strictEqual(resolveProjectDir(".", process.cwd()), process.cwd());
  });

  it("treats blank / undefined as the fallback (not bad)", () => {
    assert.strictEqual(isBadProjectDir(""), false);
    assert.strictEqual(isBadProjectDir(undefined), false);
    assert.strictEqual(resolveProjectDir("", "/tmp/x"), "/tmp/x");
    assert.strictEqual(resolveProjectDir(undefined, "/tmp/x"), "/tmp/x");
  });

  it("keeps a real, existing directory verbatim (trimmed)", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "janus_g5_real_"));
    try {
      assert.strictEqual(isBadProjectDir(real), false);
      assert.strictEqual(resolveProjectDir("  " + real + "  "), real); // trims
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it("flags a path that exists but is a FILE (not a directory) as bad", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "janus_g5_f_")), "afile.txt");
    fs.writeFileSync(f, "x");
    try {
      assert.strictEqual(isBadProjectDir(f), true);
      assert.strictEqual(resolveProjectDir(f, process.cwd()), process.cwd());
    } finally {
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    }
  });
});

import { OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";

// SQLite is the only ledger backend (dbt3) — an in-memory store is the lightweight fixture here.
function newManager(): OrchestratorManager {
  const store = new JanusStore(":memory:");
  store.init();
  return new OrchestratorManager({ ledger: store });
}

describe("G5 — create_project never persists a bad dir (handler contract)", () => {
  const BOGUS = path.join(os.tmpdir(), "janus_g5_handler_absent_" + Date.now());

  // Mirror the handler decision the server now makes (Changes C & D):
  //   if (isBadProjectDir(dir)) -> reject, do NOT addProject
  //   else                      -> addProject(id, resolveProjectDir(dir), ...)
  function simulateCreateProject(mgr: OrchestratorManager, id: string, dir: unknown): boolean {
    if (isBadProjectDir(dir)) return false;            // rejected, nothing stored
    mgr.ledger.addProject(id, resolveProjectDir(dir), "", []);
    return true;
  }

  it("rejects a bad dir on the voice/REST contract — nothing is stored", () => {
    const mgr = newManager();
    const ok = simulateCreateProject(mgr, "proj_bad", BOGUS);
    assert.strictEqual(ok, false);
    assert.strictEqual(mgr.ledger.getProject("proj_bad"), null);
  });

  it("stores the RESOLVED (not raw) dir for a blank/'.' create", () => {
    const mgr = newManager();
    simulateCreateProject(mgr, "proj_dot", ".");
    const ws = mgr.ledger.getProject("proj_dot");
    assert.ok(ws);
    assert.strictEqual(ws!.directory, process.cwd());   // resolved, never the literal "."
  });
});
