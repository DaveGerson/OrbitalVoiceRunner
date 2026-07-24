import { test, mock } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

// BUG-042 (P0, hands-free delivery) — RED TDD pins for the paste-burst submit fix.
//
// deliverSubmit already writes the BODY and a SEPARATE terminating CR (never LF), gated behind
// `submitEnterDelayMs`. The RESIDUAL defect: that gap is a FIXED value, so a long (>=280-char)
// prompt on ConPTY can still be coalesced with its trailing CR into one paste burst — Claude's
// paste-burst detector then keeps the CR as a literal newline and the prompt sits
// staged-but-unsubmitted. The eyes-off operator hears no error and the instruction never runs.
//
// Required post-fix behavior these tests pin (see scratchpad/design/W1-delivery.md for the contract):
//   (a) DEFAULT_PTY_SUBMIT_DELAY_MS raised 20 -> 60ms (env JANUS_PTY_SUBMIT_DELAY_MS still wins;
//       0 still means the synchronous two-write opt-out).
//   (b) The PACED pre-CR gap scales with body length:
//         effectiveGap = max(submitEnterDelayMs, ceil(command.length / 4))  ms
//       so a >=280-char prompt gets a STRICTLY larger gap than a short one.
//   (c) The CR is ALWAYS a separate transport.write from the body — pinned for >=280-char bodies
//       on BOTH the synchronous (gap<=0) and paced (gap>0) paths.
//
// Harness idiom mirrors tests/test_terminal_input.ts + tests/test_terminal_stdin_readiness.ts:
// inject a fake transport that records every write; reach UniversalTerminal internals via
// `(term as any).<private>`; never start() a real PTY. mock.timers drives the paced deferral.

function makeFakeTransport() {
  const writes: string[] = [];
  const transport: PtyTransport = {
    pid: 4242,
    onData() {},
    onExit() {},
    write(data: string) { writes.push(data); },
    resize() {},
    kill() {},
  };
  return { transport, writes };
}

// A 280-char single-line body: ceil(280 / 4) = 70, so the scaled paced gap is 70ms — strictly
// greater than the 20ms base this suite forces. No newlines: the whole thing is one composer line.
const LONG_280 = "A".repeat(280);

// (b) THE DISCRIMINATING RED TEST. On current (fixed-gap) code the CR lands at t=20ms; the fix must
// defer it to the scaled 70ms so ConPTY delivers the CR as its own read instead of one paste burst.
test("paced submit SCALES the pre-CR gap with body length — a 280-char prompt defers its CR to 70ms, not the base 20ms", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const term = new UniversalTerminal("submit-scale-long", ".", "cmd");
    const { transport, writes } = makeFakeTransport();
    (term as any).transport = transport;
    (term as any).spawnReady = true;
    (term as any).submitEnterDelayMs = 20; // force the paced path with a known base

    term.writeInput(LONG_280);
    await Promise.resolve(); await Promise.resolve(); // let the serialized submit microtask write the body
    assert.deepStrictEqual(writes, [LONG_280], "body written immediately; the CR is deferred");

    mock.timers.tick(20); // base gap elapses — on the FIXED-gap (pre-fix) code the CR arrives HERE (RED)
    assert.deepStrictEqual(
      writes,
      [LONG_280],
      "CR STILL deferred at t=20ms: the gap must SCALE past the base for a 280-char body (ceil(280/4)=70)",
    );

    mock.timers.tick(49); // t=69ms total — still one tick short of the scaled 70ms gap
    assert.deepStrictEqual(writes, [LONG_280], "CR still deferred at t=69ms (scaled gap is 70ms)");

    mock.timers.tick(1); // t=70ms total — the scaled gap elapses
    assert.deepStrictEqual(
      writes,
      [LONG_280, "\r"],
      "CR delivered as a SEPARATE write once the scaled 70ms gap elapses",
    );
    assert.ok(!writes.join("").includes("\n"), "submit terminator is CR, never LF, for long bodies");
  } finally {
    mock.timers.reset();
  }
});

// Lower-bound guard (green now AND post-fix): scaling only ever RAISES the gap. A short prompt whose
// ceil(len/4) is below the configured floor keeps the base gap unchanged. Documents that the fix must
// not perturb short-prompt latency.
test("paced submit leaves a SHORT prompt at the base gap (scaling never lowers below the configured floor)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const term = new UniversalTerminal("submit-scale-short", ".", "cmd");
    const { transport, writes } = makeFakeTransport();
    (term as any).transport = transport;
    (term as any).spawnReady = true;
    (term as any).submitEnterDelayMs = 20; // ceil(2/4)=1 -> max(20,1)=20, unchanged

    term.writeInput("go");
    await Promise.resolve(); await Promise.resolve();
    assert.deepStrictEqual(writes, ["go"], "body first, CR deferred");
    mock.timers.tick(20);
    assert.deepStrictEqual(writes, ["go", "\r"], "short prompt still submits at the base 20ms gap");
  } finally {
    mock.timers.reset();
  }
});

// (a) DEFAULT gap raised to >=60ms. The field is seeded from the DEFAULT_PTY_SUBMIT_DELAY_MS module
// const (read from env once at import). Only observable when the env override is absent.
test("DEFAULT submit gap is raised to at least 60ms (BUG-042: 20ms was too short for long ConPTY paste bursts)", (t) => {
  if (process.env.JANUS_PTY_SUBMIT_DELAY_MS !== undefined) {
    t.skip("JANUS_PTY_SUBMIT_DELAY_MS override is set in this environment — the built-in default is not observable");
    return;
  }
  const term = new UniversalTerminal("submit-default-gap", ".", "cmd");
  const gap = (term as any).submitEnterDelayMs;
  assert.ok(
    typeof gap === "number" && gap >= 60,
    `default submit gap must be raised to >=60ms (BUG-042); got ${gap}ms`,
  );
});

// (a)+(c) The 0 opt-out MUST stay a synchronous two-write even for a >=280-char body: length-scaling
// applies ONLY to the paced (gap>0) path, so env=0 / test determinism is preserved. Green now; this
// constrains the fix to keep the `submitEnterDelayMs <= 0` early-return synchronous branch intact.
test("submitEnterDelayMs=0 stays a SYNCHRONOUS two-write for a >=280-char body (scaling must not hijack the opt-out path)", () => {
  const term = new UniversalTerminal("submit-sync-long", ".", "cmd");
  const { transport, writes } = makeFakeTransport();
  (term as any).transport = transport;
  (term as any).spawnReady = true;
  (term as any).submitEnterDelayMs = 0;

  term.writeInput(LONG_280);
  assert.deepStrictEqual(
    writes,
    [LONG_280, "\r"],
    "gap=0 => body then a SEPARATE CR, synchronously; length-scaling does not apply on the opt-out path",
  );
  assert.ok(!writes.join("").includes("\n"), "submit terminator is CR, never LF, for long bodies too");
});
