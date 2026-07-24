// tests/test_server_import_side_effects.ts — bead c1ky acceptance: a bare VALUE-import of root
// server.ts in a fresh process must NOT autostart (bind :3000 / set process.exitCode) and must
// NOT create a repo-root .janus.db, even when the importer does NOT set JANUS_NO_AUTOSTART.
//
// WHY A SUBPROCESS: the side effects under test (module-tail autostart, module-scope store init)
// are process-global and fire exactly ONCE per process at import time — they cannot be observed
// by re-importing server.ts inside THIS test's own process (also already running one boot).
//
// THE PROOF SHAPE: this outer node:test file first OCCUPIES 127.0.0.1:3000 with a bare net.Server
// so that, PRE-FIX (autostart gated only by an env flag the importer must remember to set), the
// child's autostart deterministically hits EADDRINUSE and sets process.exitCode=1 — the exact
// bxpk fingerprint. POST-FIX (autostart gated on an entrypoint check), a plain value-import can
// never be the entrypoint, so it never attempts a bind at all and the child exits 0 regardless of
// the occupied port. We deliberately DELETE JANUS_NO_AUTOSTART / JANUS_DB from the child's env so
// the entrypoint gate — not an env flag the caller must remember — is what's under test.
//
// Runner: npx tsx --test --test-force-exit tests/test_server_import_side_effects.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const serverPath = path.join(repoRoot, "server.ts");

const SENTINELS = [".janus.db", ".janus.db-wal", ".janus.db-shm", ".janus_settings.json"];

function snapshotSentinels(): Record<string, boolean> {
  const snap: Record<string, boolean> = {};
  for (const name of SENTINELS) snap[name] = fs.existsSync(path.join(repoRoot, name));
  return snap;
}

function occupyPort3000(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(3000, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

/**
 * Ensure 127.0.0.1:3000 is occupied for the duration of the probe. If we can bind it ourselves,
 * we own teardown. If it's ALREADY occupied (e.g. a dev server left running in another worktree),
 * that's equally good for the proof — an autostart attempt still hits EADDRINUSE — so we just
 * don't own/close anything in that case.
 */
async function ensurePort3000Occupied(): Promise<net.Server | null> {
  try {
    return await occupyPort3000();
  } catch (e: any) {
    if (e && e.code === "EADDRINUSE") return null; // already occupied externally — good enough
    throw e;
  }
}

test("a bare value-import of server.ts does not autostart and does not touch repo-root .janus.db", async () => {
  let occupier: net.Server | undefined;
  const createdByThisTest: string[] = [];
  const before = snapshotSentinels();

  try {
    occupier = (await ensurePort3000Occupied()) ?? undefined;

    const scriptPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "janus-import-side-effect-")),
      "probe.mjs",
    );
    // 5s settle: pre-fix, boot does real async work (Vite middleware setup, the memory/synth
    // daemon ping) BEFORE the listen() call that would hit EADDRINUSE — under-waiting here would
    // let a pre-fix probe exit 0 before autostart ever attempts the bind (a false green).
    const probeSrc = `
      import { pathToFileURL } from "node:url";
      await import(pathToFileURL(${JSON.stringify(serverPath)}).href);
      await new Promise((r) => setTimeout(r, 5000));
      process.exit(process.exitCode ?? 0);
    `;
    fs.writeFileSync(scriptPath, probeSrc, "utf8");

    // Delete JANUS_NO_AUTOSTART / JANUS_DB so the entrypoint gate ALONE — not an env flag the
    // caller must remember to set — is what suppresses autostart/store-rooting.
    const childEnv = { ...process.env };
    delete childEnv.JANUS_NO_AUTOSTART;
    delete childEnv.JANUS_DB;

    const child = spawnSync("npx", ["tsx", scriptPath], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
      shell: true,
      timeout: 30000,
    });

    const combined = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    assert.equal(
      child.status,
      0,
      `value-import must not set process.exitCode (no autostart bind attempt); ` +
        `child exited ${child.status}. stdout/stderr:\n${combined}`,
    );
    assert.ok(
      !/EADDRINUSE|failed to start|Server running on/.test(combined),
      `value-import must not attempt to bind :3000 at all. stdout/stderr:\n${combined}`,
    );

    const after = snapshotSentinels();
    for (const name of SENTINELS) {
      if (!before[name] && after[name]) createdByThisTest.push(name);
      assert.equal(
        after[name],
        before[name],
        `value-import must not create repo-root ${name} (lazy store init)`,
      );
    }
  } finally {
    if (occupier) {
      await new Promise<void>((resolve) => occupier!.close(() => resolve()));
    }
    for (const name of createdByThisTest) {
      try { fs.rmSync(path.join(repoRoot, name), { force: true }); } catch { /* best-effort */ }
    }
  }
});
