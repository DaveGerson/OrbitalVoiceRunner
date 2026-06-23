// tests/test_dbt_typing.ts
// bead dbt-typing: lock the removal of unsafe `as any` casts on SQLite `.all()/.get()` reads
// (dbt1: sqliteStore peer hydrators) and the typed Gemini live envelope (dbt2). The guard half
// asserts the targeted files no longer reintroduce `as any` on the data-row read seam; the
// behavioral half pins that the peer hydrators round-trip boolean/JSON columns byte-identically
// (the typed hydrators must coerce 0/1 -> boolean exactly as the prior inline `Boolean(...)` did).
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredPendingApproval, StoredPendingAction, StoredAttention } from "../src/store/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// ── dbt guard: the targeted files must not reintroduce `as any` on the read seam (the bar for this
// bead). The store file legitimately keeps a FEW non-row casts (Proxy reflection, dynamic keyed-default
// tables); the scope of dbt1/dbt2 is the `.all()/.get()` read seam, so we assert the specific
// anti-patterns the bead removed are gone rather than a blanket zero (which would over-claim).
test("dbt1: sqliteStore no longer casts `.all()`/`.get()` results to `any`", () => {
  const src = read("src/store/sqliteStore.ts");
  // The smell the bead removed: `.all(...) as any[]`, `.get(...) as any`, and `.map((r:any)...`.
  assert.equal(/\.all\([^)]*\)\s+as\s+any\b/.test(src), false, ".all(...) as any survived");
  assert.equal(/\.get\([^)]*\)\s+as\s+any\b/.test(src), false, ".get(...) as any survived");
  assert.equal(/\.map\(\s*\(\s*r\s*:\s*any\s*\)/.test(src), false, ".map((r:any)...) survived");
});

test("dbt2: voice live handlers no longer use `any`-typed Gemini envelopes", () => {
  const src = read("src/voice/index.ts");
  assert.equal(/handleToolCalls\s*=\s*async\s*\(\s*message\s*:\s*any\b/.test(src), false, "handleToolCalls message:any survived");
  assert.equal(/onerror\s*:\s*\(\s*err\s*:\s*any\b/.test(src), false, "onerror err:any survived");
  assert.equal(/onclose\s*:\s*\(\s*info\s*:\s*any\b/.test(src), false, "onclose info:any survived");
});

test("dbt2: server LiveConnector params/return are no longer `any`", () => {
  const src = read("server.ts");
  assert.equal(/export type LiveConnector =[^;]*params:\s*any/.test(src), false, "LiveConnector params:any survived");
  assert.equal(/export type LiveConnector =[^;]*Promise<any>/.test(src), false, "LiveConnector Promise<any> survived");
});

// ── behavioral pin: the peer hydrators must coerce the INTEGER boolean columns to real booleans and
// JSON the `details` column exactly as the prior inline `.map(...)` did. A regression that left them
// as raw 0/1 (or stringified JSON) would change the public read shape — these assert the exact types.
function seed(): JanusStore {
  const s = new JanusStore(":memory:"); s.init();
  s.saveWorkspace({ id: "p1", name: "P1", directory: "", summary: "", key_terms: [], created_at: 0, updated_at: 0 });
  return s;
}

test("dbt1: getPendingApprovals hydrates claimed:0 -> boolean false", () => {
  const s = seed();
  const a: StoredPendingApproval = {
    id: "ap1", session_id: "sess", workspace_id: "p1", pane_id: "t1",
    command: "echo hi", kind: "shell", rationale: null, claimed: false,
    timestamp: 1, expires_at: 10_000,
  };
  s.insertPendingApproval(a);
  const got = s.getPendingApprovals("sess");
  assert.equal(got.length, 1);
  assert.strictEqual(got[0].claimed, false, "claimed is a real boolean, not 0");
  assert.equal(typeof got[0].claimed, "boolean");
  s.close();
});

test("dbt1: getPendingActions hydrates claimed:0 -> boolean false", () => {
  const s = seed();
  const a: StoredPendingAction = {
    id: "act1", capability: "write_to_pane", summary: "do thing",
    params: "{}", claimed: false, timestamp: 1, expires_at: 10_000,
  };
  s.insertPendingAction(a);
  const got = s.getPendingActions();
  assert.equal(got.length, 1);
  assert.strictEqual(got[0].claimed, false, "claimed is a real boolean, not 0");
  assert.equal(typeof got[0].claimed, "boolean");
  s.close();
});

test("dbt1: getAttention hydrates dismissed -> boolean and details -> parsed JSON", () => {
  const s = seed();
  const att: StoredAttention = {
    id: "at1", type: "idle", terminal_id: "t1", project_id: "p1",
    message: "pane idle", timestamp: 1, dismissed: false, details: { foo: "bar" },
  };
  s.upsertAttention(att);
  const got = s.getAttention();
  assert.equal(got.length, 1);
  assert.equal(typeof got[0].dismissed, "boolean");
  assert.strictEqual(got[0].dismissed, false);
  assert.deepEqual(got[0].details, { foo: "bar" }, "details round-trips as parsed JSON");
  s.close();
});
