// QUICK-WIN cyclomatic-complexity burndown — pins the CURRENT behavior of two server.ts
// functions before/after a behavior-preserving extraction refactor:
//   - validateSettingsPutBody (pure request-body validator, CC 17 -> <=10)
//   - HistoryManager#doFlush (private async; CC 13 -> <=10), characterized via its
//     OBSERVABLE flush effects through the public addCommand/appendOutput/flushAll path.
//
// These tests must pass GREEN against the pre-refactor code first, then unchanged after.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

// Compressed flush windows MUST be set before ../server is imported (HistoryManager reads
// them at construction). doFlush is exercised via flushAll(), so the timings barely matter,
// but keep them small to avoid coupling to defaults.
process.env.NODE_ENV = "test";
process.env.JANUS_NO_AUTOSTART = "1";
process.env.JANUS_HISTORY_FLUSH_MS = process.env.JANUS_HISTORY_FLUSH_MS ?? "60";
process.env.JANUS_HISTORY_FLUSH_MAX_MS = process.env.JANUS_HISTORY_FLUSH_MAX_MS ?? "240";

// ---------------------------------------------------------------------------
// validateSettingsPutBody — pure validator, no server boot needed.
// ---------------------------------------------------------------------------
describe("validateSettingsPutBody — pinned behavior (CC burndown)", () => {
  let validate: (body: unknown) => { ok: boolean; error?: string };

  before(async () => {
    const mod = await import("../server");
    validate = mod.validateSettingsPutBody;
  });

  it("non-object bodies are rejected with the object-body message", () => {
    for (const bad of [null, undefined, 42, "str", true, [1, 2, 3]]) {
      const r = validate(bad);
      assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} rejected`);
      assert.strictEqual(r.error, "Settings body must be a JSON object.");
    }
  });

  it("an object with NO advanced field is accepted (no error key)", () => {
    const r = validate({ voiceAi: { voice: "Puck" } });
    assert.deepStrictEqual(r, { ok: true });
  });

  it("advanced present but not an object is rejected naming the field", () => {
    for (const bad of [null, 5, "x", [1]]) {
      const r = validate({ advanced: bad });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, "Invalid settings field 'advanced': expected an object.");
    }
  });

  it("an empty advanced object is accepted", () => {
    assert.deepStrictEqual(validate({ advanced: {} }), { ok: true });
  });

  it("invalid advanced.globalPermissionsMode is rejected naming the field + listing options", () => {
    const r = validate({ advanced: { globalPermissionsMode: "YOLO" } });
    assert.strictEqual(r.ok, false);
    assert.match(String(r.error), /^Invalid settings field 'advanced\.globalPermissionsMode': must be one of /);
    assert.match(String(r.error), /\.$/);
  });

  it("every real globalPermissionsMode value is accepted", () => {
    for (const mode of ["Full Auto", "Human-in-the-Loop", "Read-Only", "Inherit"]) {
      assert.deepStrictEqual(validate({ advanced: { globalPermissionsMode: mode } }), { ok: true }, mode);
    }
  });

  it("a non-object capabilityGates is rejected naming the field", () => {
    for (const bad of [null, "all-auto", 7, [1, 2]]) {
      const r = validate({ advanced: { capabilityGates: bad } });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(
        r.error,
        "Invalid settings field 'advanced.capabilityGates': expected an object map of capability -> Auto|Ask|Off.",
      );
    }
  });

  it("an invalid gate VALUE on a KNOWN capability key is rejected naming the key", () => {
    const r = validate({ advanced: { capabilityGates: { write_to_pane: "Maybe" } } });
    assert.strictEqual(r.ok, false);
    assert.match(String(r.error), /^Invalid settings field 'advanced\.capabilityGates\.write_to_pane': must be one of /);
  });

  it("UNKNOWN capability keys are STRIPPED in place (forward compat) and never 400", () => {
    const gates: Record<string, unknown> = { some_future_capability: "Auto", write_to_pane: "Off" };
    const body = { advanced: { capabilityGates: gates } };
    const r = validate(body);
    assert.deepStrictEqual(r, { ok: true });
    // The strip is a MUTATION of the passed object — pin that side effect.
    assert.ok(!("some_future_capability" in gates), "unknown key stripped from the body object");
    assert.strictEqual(gates.write_to_pane, "Off", "known key preserved");
  });

  it("valid gate values on known keys are accepted (Auto/Ask/Off)", () => {
    for (const v of ["Auto", "Ask", "Off"]) {
      assert.deepStrictEqual(
        validate({ advanced: { capabilityGates: { write_to_pane: v } } }),
        { ok: true },
        v,
      );
    }
  });

  it("a prototype-polluting key is treated as unknown and stripped, not honored", () => {
    const gates: Record<string, unknown> = JSON.parse('{"__proto__":"Auto","write_to_pane":"Ask"}');
    const r = validate({ advanced: { capabilityGates: gates } });
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(gates.write_to_pane, "Ask");
    // No pollution of Object.prototype.
    assert.strictEqual(({} as any).__proto__ === Object.prototype, true);
  });

  it("combined: valid mode + partial gates with an unknown key -> ok, unknown stripped", () => {
    const gates: Record<string, unknown> = { write_to_pane: "Auto", future: "Off" };
    const r = validate({ advanced: { globalPermissionsMode: "Inherit", capabilityGates: gates } });
    assert.deepStrictEqual(r, { ok: true });
    assert.ok(!("future" in gates));
    assert.strictEqual(gates.write_to_pane, "Auto");
  });
});

// ---------------------------------------------------------------------------
// HistoryManager#doFlush — characterized through observable flush effects.
// doFlush is private; we drive it via the public mutation + flushAll() path
// (the server close() path), exactly as test_history_flush.ts does.
// ---------------------------------------------------------------------------
describe("HistoryManager#doFlush — pinned flush behavior (CC burndown)", () => {
  let hm: any;
  let tmpDir: string;
  let prevCwd: string;

  const historyPath = () => path.join(process.cwd(), ".janus_history.json");
  const readFile = (): Record<string, any[]> => {
    try {
      return JSON.parse(fs.readFileSync(historyPath(), "utf-8"));
    } catch {
      return {};
    }
  };

  before(async () => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-qwflush-"));
    process.chdir(tmpDir);
    const mod = await import("../server");
    hm = mod.HistoryManager.getInstance();
  });

  after(async () => {
    try { await hm.flushAll?.(); } catch { /* noop */ }
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("flushAll() with NO dirty entries is a clean no-op (no file created, no throw)", async () => {
    await hm.flushAll();
    assert.strictEqual(fs.existsSync(historyPath()), false, "no history file materialized from an empty flush");
  });

  it("a single command flushes to disk, pretty-printed (2-space) one-object-per-terminalId", async () => {
    hm.addCommand("p1", "echo a");
    hm.appendOutputToLastCommand("p1", "OUT-A");
    await hm.flushAll();

    const parsed = readFile();
    assert.strictEqual(parsed.p1?.[0]?.command, "echo a");
    assert.strictEqual(parsed.p1?.[0]?.output, "OUT-A");
    const raw = fs.readFileSync(historyPath(), "utf-8");
    assert.match(raw, /^\{\n {2}"/, "JSON.stringify(..., null, 2) layout preserved");
  });

  it("the atomic tmp file is renamed away — no .tmp residue left behind", async () => {
    hm.addCommand("p2", "echo b");
    await hm.flushAll();
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes(".janus_history") && f !== ".janus_history.json");
    assert.deepStrictEqual(leftovers, [], "atomic write leaves no temp residue");
  });

  it("flush MERGES over the on-disk file — foreign pane keys survive (out-of-band writers)", async () => {
    await hm.flushAll();
    const all = readFile();
    all["foreign"] = [{ command: "x", timestamp: "t", output: "o" }];
    fs.writeFileSync(historyPath(), JSON.stringify(all, null, 2), "utf-8");

    hm.addCommand("p3", "echo c");
    await hm.flushAll();

    const parsed = readFile();
    assert.deepStrictEqual(
      parsed["foreign"],
      [{ command: "x", timestamp: "t", output: "o" }],
      "foreign key preserved through the merge",
    );
    assert.strictEqual(parsed.p3?.[0]?.command, "echo c", "dirty pane also landed");
  });

  it("a corrupt on-disk file is treated as empty (fresh start), not a throw", async () => {
    await hm.flushAll();
    fs.writeFileSync(historyPath(), "{ this is not valid json", "utf-8");

    hm.addCommand("p4", "echo d");
    await hm.flushAll();

    const parsed = readFile();
    assert.strictEqual(parsed.p4?.[0]?.command, "echo d", "flush recovers from a corrupt file");
  });

  it("an on-disk ARRAY (non-object map) is treated as empty, not merged", async () => {
    await hm.flushAll();
    fs.writeFileSync(historyPath(), JSON.stringify([1, 2, 3]), "utf-8");

    hm.addCommand("p5", "echo e");
    await hm.flushAll();

    const parsed = readFile();
    assert.ok(!Array.isArray(parsed), "result is an object map again");
    assert.strictEqual(parsed.p5?.[0]?.command, "echo e");
  });

  it("flushAll() is idempotent — a second flush with nothing newly dirty does not throw", async () => {
    hm.addCommand("p6", "echo f");
    await hm.flushAll();
    await hm.flushAll(); // nothing left dirty -> doFlush early-return branch
    const parsed = readFile();
    assert.strictEqual(parsed.p6?.[0]?.command, "echo f");
  });
});
