import { test } from "node:test";
import assert from "node:assert";

// BUG-043 (P3, misleading health signal) — RED TDD pins for the smoke:claude readiness/timeout fix.
//
// scripts/smoke-claude-pane.ts hardcodes STARTUP_MS=6000 / RESPONSE_MS=25000 and BLINDLY submits the
// prompt after a fixed 6s sleep. A plugin-heavy Claude (e.g. a memory plugin that stands up its own
// service) is still initializing well past 6s, so the prompt is submitted before the CLI can accept
// it and the smoke false-FAILs a healthy pane.
//
// Required post-fix behavior these tests pin (see scratchpad/design/W1-delivery.md for the contract):
//   (a) A PURE exported helper resolveSmokeTimeouts(env) -> { startupMs, responseMs }:
//         - env-overridable via JANUS_SMOKE_STARTUP_MS / JANUS_SMOKE_RESPONSE_MS
//         - guarded parsing: non-numeric / negative / zero / empty -> the default
//         - defaults RAISED: startupMs 15000, responseMs 40000
//   (b) A readiness gate exported as waitForReady(term, opts): instead of a fixed 6s sleep it waits
//       for the terminal's onReady edge (first PTY data) PLUS a short output-quiescence window before
//       submitting. Injectable clock (setTimer/clearTimer) + injectable signals (term.onReady /
//       term.onOutput) make it unit-testable WITHOUT a live claude binary.
//
// RED status: resolveSmokeTimeouts and waitForReady do NOT yet exist as exports of
// scripts/smoke-claude-pane.ts, so this file fails to load / the calls throw (planned-but-missing
// export — acceptable per the campaign brief). The fix ALSO guards the module's main() behind a
// direct-run check so this import is side-effect-free (no pane spawn) once it lands.
import { resolveSmokeTimeouts, waitForReady } from "../scripts/smoke-claude-pane";

// A deterministic, injectable clock: no wall-clock, no mock.timers, no real setTimeout. `advance`
// fires due timers in time order and tolerates re-arm/clear from within a fired callback.
class ManualClock {
  now = 0;
  private q: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  setTimer = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.q.push({ at: this.now + ms, fn, id });
    return id;
  };
  clearTimer = (id: number): void => {
    this.q = this.q.filter((t) => t.id !== id);
  };
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let idx = -1;
      for (let i = 0; i < this.q.length; i++) {
        if (this.q[i].at <= target && (idx < 0 || this.q[i].at < this.q[idx].at)) idx = i;
      }
      if (idx < 0) break;
      const t = this.q[idx];
      this.q.splice(idx, 1);
      this.now = t.at;
      t.fn();
    }
    this.now = target;
  }
}

// ---------------------------------------------------------------------------------------------
// (a) resolveSmokeTimeouts — pure env parsing
// ---------------------------------------------------------------------------------------------

test("resolveSmokeTimeouts returns the RAISED defaults when the env is unset", () => {
  const { startupMs, responseMs } = resolveSmokeTimeouts({});
  assert.strictEqual(startupMs, 15000, "startup default raised to 15000ms (was a hardcoded 6000)");
  assert.strictEqual(responseMs, 40000, "response default raised to 40000ms (was a hardcoded 25000)");
});

test("resolveSmokeTimeouts honors numeric env overrides", () => {
  const r = resolveSmokeTimeouts({ JANUS_SMOKE_STARTUP_MS: "20000", JANUS_SMOKE_RESPONSE_MS: "50000" });
  assert.strictEqual(r.startupMs, 20000, "JANUS_SMOKE_STARTUP_MS override wins");
  assert.strictEqual(r.responseMs, 50000, "JANUS_SMOKE_RESPONSE_MS override wins");
});

test("resolveSmokeTimeouts falls back to defaults on non-numeric / negative / zero / empty input", () => {
  assert.deepStrictEqual(
    resolveSmokeTimeouts({ JANUS_SMOKE_STARTUP_MS: "abc", JANUS_SMOKE_RESPONSE_MS: "-5" }),
    { startupMs: 15000, responseMs: 40000 },
    "non-numeric startup + negative response both fall back",
  );
  assert.deepStrictEqual(
    resolveSmokeTimeouts({ JANUS_SMOKE_STARTUP_MS: "0", JANUS_SMOKE_RESPONSE_MS: "" }),
    { startupMs: 15000, responseMs: 40000 },
    "zero and empty-string are not usable timeouts — fall back to defaults",
  );
});

// ---------------------------------------------------------------------------------------------
// (b) waitForReady — onReady + output-quiescence gate (no fixed 6s sleep)
// ---------------------------------------------------------------------------------------------

test("waitForReady does NOT submit at a fixed 6s — it waits for onReady AND an output-quiescence window", async () => {
  const clock = new ManualClock();
  const term: { onReady?: (id: string) => void; onOutput?: (id: string, chunk: string) => void } = {};
  const p = waitForReady(term, {
    startupMs: 15000,
    quietMs: 1500,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  let settled = false;
  p.then(() => { settled = true; });

  clock.advance(6000); // the OLD blind-submit point
  await Promise.resolve();
  assert.strictEqual(settled, false, "must NOT be ready at the old fixed 6s mark — the child has not signalled onReady");

  term.onReady!("smoke"); // first PTY data == readiness edge; the quiescence window now begins
  clock.advance(1000); // < quietMs
  term.onOutput!("smoke", "startup banner..."); // more startup output RE-ARMS the quiet window
  await Promise.resolve();
  assert.strictEqual(settled, false, "still not ready: output must be quiet for quietMs AFTER onReady");

  clock.advance(1500); // quietMs of silence after the last chunk
  const res = await p;
  assert.strictEqual(settled, true, "resolves once the pane is ready and output has quiesced");
  assert.deepStrictEqual(res, { ready: true, reason: "quiescent" });
});

test("waitForReady gates a LATE-readying (plugin-heavy) child: onReady at t+10s, then quiescence — the BUG-043 scenario", async () => {
  const clock = new ManualClock();
  const term: { onReady?: (id: string) => void; onOutput?: (id: string, chunk: string) => void } = {};
  const p = waitForReady(term, {
    startupMs: 30000,
    quietMs: 1500,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  let settled = false;
  p.then(() => { settled = true; });

  clock.advance(10000); // plugin service still standing up — well past the old 6s
  term.onReady!("smoke");
  await Promise.resolve();
  assert.strictEqual(settled, false, "not ready on first data alone — the quiescence window is still pending");

  clock.advance(1500);
  const res = await p;
  assert.deepStrictEqual(res, { ready: true, reason: "quiescent" }, "a child that readies at t+10s still gates correctly");
});

test("waitForReady resolves via the startup CAP if the child never signals ready (belt-and-suspenders)", async () => {
  const clock = new ManualClock();
  const term: { onReady?: (id: string) => void; onOutput?: (id: string, chunk: string) => void } = {};
  const p = waitForReady(term, {
    startupMs: 15000,
    quietMs: 1500,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  clock.advance(15000); // never fired onReady/onOutput — the hard cap must still resolve (never hang)
  const res = await p;
  assert.deepStrictEqual(
    res,
    { ready: false, reason: "startup-timeout" },
    "the cap resolves with ready:false so the smoke never hangs on a silent/degraded child",
  );
});
