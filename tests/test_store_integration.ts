import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JanusStore } from "../src/store/sqliteStore";

test("pending approvals + resumption token survive a 'restart' (reopen same file)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-"));
  const dbPath = path.join(dir, "janus.db");
  const s1 = new JanusStore(dbPath); s1.init();
  s1.insertPendingApproval({ id:"a1", session_id:"s1", workspace_id:"p1", pane_id:"t1",
    command:"npm test", kind:"agent_instruction", rationale:null, claimed:false, timestamp:1, expires_at: 9_999_999_999_999 });
  s1.setKV("lastSessionResumptionToken", "tok-123");
  s1.close();
  const s2 = new JanusStore(dbPath); s2.init();
  assert.equal(s2.getPendingApprovals("s1").length, 1);
  assert.equal(s2.getKV("lastSessionResumptionToken"), "tok-123");
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
