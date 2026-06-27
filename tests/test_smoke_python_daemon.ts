// tests/test_smoke_python_daemon.ts — pins the three-way EXIT CONTRACT of scripts/smoke-python-daemon.ts
// WITHOUT a real interpreter, by driving the exported main() with an injected discover + spawnImpl
// (the same injected-spawnImpl pattern proven in scripts/run-pytests.ts and tests/test_daemon_state_callback.ts).
//
// The contract (documented in the script header):
//   exit 2 = SKIP   — no Python interpreter candidates at all (genuinely python-less box).
//   exit 1 = FAIL   — a real-world failure. CRITICALLY: an interpreter is PRESENT but the daemon never
//                     returns a valid PONG (broken daemon) is a FAIL, NOT a skip. (s18-smoke-exit-codes:
//                     before the fix the timeout path returned 2, hiding a broken live lane.)
//   exit 0 = PASS   — the daemon answered ping + synthesize + approval.parse correctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { main, type SmokeDeps } from "../scripts/smoke-python-daemon";
import { discoverPythonInterpreter } from "../src/memory/pythonClient";
import { WIRE_VERSION } from "../src/memory/types";

// ── fake child harness (ported from tests/test_daemon_state_callback.ts) ───────────────────────────
// A fake child process: captures stdin writes; the test (or an auto-responder) emits stdout NDJSON lines.
class FakeChild extends EventEmitter {
  stdin = { write: (s: string) => { this.onWrite(s); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killed = false;
  // What to do with each written request line. SILENT (default) never answers → the client's
  // ping-handshake times out → main() must FAIL (exit 1), proving "present but no pong".
  onWrite: (s: string) => void = () => {};
  // Idempotent + ASYNC exit, mirroring a real OS child (the transition sub-check kills then waits):
  // a synchronous re-entrant emit re-enters onDown before respawn and starves the self-heal.
  kill() { if (this.killed) return true; this.killed = true; setImmediate(() => this.emit("exit")); return true; }
  unref() {}
  emitLine(obj: Record<string, unknown>) { this.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n")); }
}

// The golden approval grid main() asserts (kept in lock-step with the `cases` array in the script).
const APPROVAL_GOLDEN: Record<string, unknown> = {
  "approve the second one": { intent: "approve", targetHint: { ordinal: 2 } },
  "skip that for now": { intent: "defer" },
  "dont run": { intent: "reject" },
  "approve but reject": { intent: "clarify" },
  "what does this do": { intent: "none" },
};

// A HEALTHY auto-responder: answers ping → pong, synthesize → a valid brief, approval.parse → the
// golden `parsed`. Each request is replied to on the next microtask (setImmediate) so the client is
// fully wired before the first stdout line lands — matching how the real daemon answers asynchronously.
function wireHealthyResponder(child: FakeChild): void {
  child.onWrite = (s: string) => {
    const req = JSON.parse(s);
    setImmediate(() => {
      if (req.id === "__ping__") {
        child.emitLine({ id: "__ping__", v: WIRE_VERSION, ok: true, pong: true, synthVersion: "1.0.0-fake" });
      } else if (req.op === "synthesize") {
        child.emitLine({ id: req.id, v: WIRE_VERSION, ok: true, brief: { text: "FAKE BRIEF", perTierChars: {}, activePaneId: null } });
      } else if (req.op === "approval.parse") {
        const parsed = APPROVAL_GOLDEN[req.transcript];
        child.emitLine({ id: req.id, v: WIRE_VERSION, ok: true, parsed });
      }
    });
  };
}

// One interpreter candidate — enough for the zero-candidate gate to PASS so we exercise the live path.
const ONE_CANDIDATE: ReturnType<typeof discoverPythonInterpreter> = [{ cmd: "py", baseArgs: ["-3"] }];
const baseDeps = (over: Partial<SmokeDeps>): SmokeDeps => ({
  env: { JANUS_PYTHON: "py" }, // pin discovery deterministic for the client's internal discover too
  platform: "linux",
  cwd: () => "/repo",
  spawnImpl: (() => new FakeChild()) as never,
  discover: () => ONE_CANDIDATE,
  existsSync: () => true,       // pretend python/synthesizer/__main__.py exists so the client spawns
  ...over,
});

test("(a) no interpreter at all → exit 2 (SKIP, never 1)", async () => {
  // discover returns [] → the zero-candidate gate fires; main() must NOT build a client at all.
  let spawned = false;
  const code = await main(baseDeps({
    discover: () => [],
    spawnImpl: (() => { spawned = true; return new FakeChild(); }) as never,
  }));
  assert.equal(code, 2, "a genuinely python-less box is the ONLY legitimate SKIP=2");
  assert.equal(spawned, false, "the zero-candidate gate must short-circuit before any spawn");
});

test("(b) interpreter PRESENT but daemon never pongs → exit 1 (FAIL, NOT skip) — the s18 fix", { timeout: 30_000 }, async () => {
  // discover finds a candidate, but the fake child stays SILENT → the ping handshake times out and
  // waitAvailable(core, 8000) returns false. Before the fix this returned 2 (mis-skip); it must be 1.
  const code = await main(baseDeps({
    // every spawn (eager + any respawn) hands back a silent fake → no valid pong ever
    spawnImpl: (() => new FakeChild()) as never,
  }));
  assert.equal(code, 1, "present-but-broken daemon is a real-world failure and must go RED (exit 1)");
});

test("(c) healthy daemon (ping + synthesize + approval.parse all answer correctly) → exit 0", { timeout: 30_000 }, async () => {
  const code = await main(baseDeps({
    spawnImpl: (() => { const c = new FakeChild(); wireHealthyResponder(c); return c; }) as never,
  }));
  assert.equal(code, 0, "a daemon that answers every op correctly is a PASS (exit 0)");
});
