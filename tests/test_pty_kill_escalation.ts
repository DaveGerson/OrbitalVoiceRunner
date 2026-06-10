// tests/test_pty_kill_escalation.ts — CARD 3P.2: SIGKILL escalation actually escalates.
//
// THE BUG: NodePtyTransport.kill() latches `if (this._killed) return` on the FIRST kill, so
// UniversalTerminal.stop()'s SIGTERM→SIGKILL escalation (`transport.kill("SIGKILL")` after the
// killTimeout) is a SILENT NO-OP. A SIGTERM-resistant child becomes a permanent zombie while
// stop() reports success.
//
// THE FIX: latch per-(effective)-signal. A repeat of the SAME effective signal still no-ops —
// this preserves the Windows double-dispose protection the latch exists for: on win32
// killSignalForPlatform maps EVERY signal to the bare unconditional kill(), so a second call
// (including the SIGTERM→SIGKILL escalation) is a same-effective-signal repeat and must not
// re-enter WindowsPtyAgent.kill()/ConoutConnection.dispose() (the src\win\async.c:76 abort).
// On POSIX, SIGKILL passes exactly once after a SIGTERM; once a SIGKILL has been dispatched,
// every later kill no-ops.
//
// Harness: NodePtyTransport's proc is its only seam — build the instance via
// Object.create(prototype) and inject a fake proc that records the signals reaching proc.kill.
// (The constructor would spawn a real pty; these tests never do.) Class-field initializers do
// not run under Object.create, so the latch state must behave correctly from `undefined` —
// which also pins that the implementation can't depend on constructor-time latch setup.
//
// Runner: npx tsx --test --test-force-exit tests/test_pty_kill_escalation.ts

import { test } from "node:test";
import assert from "node:assert";
import { NodePtyTransport, killSignalForPlatform } from "../src/ptyTransport";

function makeTransport(): { t: NodePtyTransport; kills: Array<string | undefined> } {
  const kills: Array<string | undefined> = [];
  const t = Object.create(NodePtyTransport.prototype) as NodePtyTransport;
  (t as any).proc = {
    pid: 1234,
    kill: (sig?: string) => { kills.push(sig); },
  };
  return { t, kills };
}

// These tests run on POSIX (linux/darwin) where killSignalForPlatform preserves signals. The
// Windows mapping (every signal -> bare kill, so escalation collapses into a same-signal repeat)
// is pinned by test_pty_kill.ts; assert the precondition explicitly so a win32 run skips loudly.
const POSIX = process.platform !== "win32";

test("3P.2: SIGTERM then SIGKILL — the escalation REACHES proc.kill (not a latched no-op)", { skip: !POSIX }, () => {
  const { t, kills } = makeTransport();
  t.kill("SIGTERM");
  t.kill("SIGKILL");
  assert.deepStrictEqual(
    kills,
    [killSignalForPlatform(process.platform, "SIGTERM"), killSignalForPlatform(process.platform, "SIGKILL")],
    "both SIGTERM and the SIGKILL escalation must reach proc.kill",
  );
});

test("3P.2: a second SIGTERM still no-ops (same-signal repeat protection preserved)", { skip: !POSIX }, () => {
  const { t, kills } = makeTransport();
  t.kill("SIGTERM");
  t.kill("SIGTERM");
  assert.deepStrictEqual(kills, ["SIGTERM"], "a same-signal repeat must not re-enter proc.kill");
});

test("3P.2: SIGKILL twice — the second no-ops", { skip: !POSIX }, () => {
  const { t, kills } = makeTransport();
  t.kill("SIGKILL");
  t.kill("SIGKILL");
  assert.deepStrictEqual(kills, ["SIGKILL"], "a repeated SIGKILL must not re-enter proc.kill");
});

test("3P.2: nothing escalates past a dispatched SIGKILL (later kills no-op)", { skip: !POSIX }, () => {
  const { t, kills } = makeTransport();
  t.kill("SIGTERM");
  t.kill("SIGKILL");
  t.kill("SIGTERM");
  t.kill("SIGKILL");
  assert.deepStrictEqual(kills, ["SIGTERM", "SIGKILL"], "after SIGKILL every further kill is a no-op");
});

test("3P.2: full stop() sequence shape — SIGTERM, escalate SIGKILL, repeat-stop SIGTERM no-ops", { skip: !POSIX }, () => {
  const { t, kills } = makeTransport();
  t.kill("SIGTERM");  // stop() initial
  t.kill("SIGKILL");  // stop() killTimeout escalation
  t.kill("SIGTERM");  // a racing second stop()'s initial signal
  assert.deepStrictEqual(kills, ["SIGTERM", "SIGKILL"], "exactly one SIGTERM and one SIGKILL dispatched");
});
