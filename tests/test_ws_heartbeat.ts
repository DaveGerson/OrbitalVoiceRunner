// tests/test_ws_heartbeat.ts
//
// CARD 3V.2 — WS keepalive + half-open cleanup. There was NO ping/pong anywhere: a half-open
// client (network drop without a TCP FIN) buffered broadcasts unboundedly, pinned
// coreState.activeFrontendWs/activePaneId, and kept the Gemini session alive forever.
//
// The fix is the standard ws keepalive: every connection is marked isAlive=true on accept and on
// every pong; ONE shared unref'd interval per WebSocketServer sweeps all clients — a client that
// missed the previous ping's pong is terminate()d (which fires the existing 'close' cleanup), every
// surviving client is marked isAlive=false and ping'd again.
//
// Per the card: NO flaky timing test. The sweep decision logic is extracted into the pure
// `sweepHeartbeats(clients)` helper and unit-tested here with scripted fake clients; the interval
// wiring in attachVoiceSession is verified by lint + the 3V.2 review notes.

import { describe, it } from "node:test";
import assert from "node:assert";
import { sweepHeartbeats, HEARTBEAT_INTERVAL_MS, type HeartbeatClient } from "../src/voice";

function makeClient(isAlive: boolean | undefined): HeartbeatClient & { pings: number; terminated: boolean } {
  const c = {
    isAlive,
    pings: 0,
    terminated: false,
    ping() { c.pings++; },
    terminate() { c.terminated = true; },
  };
  return c;
}

describe("3V.2 sweepHeartbeats — the keepalive sweep decision", () => {
  it("a responsive client (isAlive=true) is pinged and flipped to isAlive=false, NOT terminated", () => {
    const c = makeClient(true);
    const terminated = sweepHeartbeats([c]);
    assert.strictEqual(c.terminated, false, "a responsive client is never terminated");
    assert.strictEqual(c.pings, 1, "the sweep pings the responsive client");
    assert.strictEqual(c.isAlive, false, "isAlive flips false until the next pong");
    assert.deepStrictEqual(terminated, [], "nothing was terminated");
  });

  it("a client that ponged between sweeps (isAlive re-set true) survives the next sweep", () => {
    const c = makeClient(true);
    sweepHeartbeats([c]);          // ping #1, isAlive -> false
    c.isAlive = true;              // the 'pong' handler fired
    sweepHeartbeats([c]);          // ping #2 — still alive
    assert.strictEqual(c.terminated, false, "a pong between sweeps keeps the client alive");
    assert.strictEqual(c.pings, 2, "each sweep re-pings the live client");
  });

  it("a client that MISSED the previous pong (isAlive=false) is terminated, not pinged again", () => {
    const c = makeClient(true);
    sweepHeartbeats([c]);          // ping #1, isAlive -> false; client never pongs
    const terminated = sweepHeartbeats([c]);
    assert.strictEqual(c.terminated, true, "a half-open client is terminate()d on the second sweep");
    assert.strictEqual(c.pings, 1, "no further ping is wasted on a dead client");
    assert.deepStrictEqual(terminated, [c], "the terminated client is reported");
  });

  it("a client with NO isAlive mark yet (undefined) is treated as alive (never terminated on its first sweep)", () => {
    // Defensive: a connection accepted between mark and sweep must not be killed before it ever had
    // a chance to pong (undefined !== false).
    const c = makeClient(undefined);
    sweepHeartbeats([c]);
    assert.strictEqual(c.terminated, false, "an unmarked client is given a full ping/pong window");
    assert.strictEqual(c.pings, 1);
    assert.strictEqual(c.isAlive, false, "it is enrolled into the keepalive cycle");
  });

  it("a throwing ping/terminate never breaks the sweep of the OTHER clients", () => {
    const dead = makeClient(false);
    dead.terminate = () => { throw new Error("socket already destroyed"); };
    const throwingPing = makeClient(true);
    throwingPing.ping = () => { throw new Error("EPIPE"); };
    const healthy = makeClient(true);
    assert.doesNotThrow(() => sweepHeartbeats([dead, throwingPing, healthy]));
    assert.strictEqual(healthy.pings, 1, "the healthy client is still swept after siblings threw");
    assert.strictEqual(healthy.isAlive, false);
  });

  it("mixed set: terminates exactly the silent ones, pings exactly the live ones", () => {
    const live1 = makeClient(true);
    const silent = makeClient(false);
    const live2 = makeClient(true);
    const terminated = sweepHeartbeats([live1, silent, live2]);
    assert.deepStrictEqual(terminated, [silent]);
    assert.strictEqual(live1.pings + live2.pings, 2);
    assert.strictEqual(silent.pings, 0);
  });

  it("the shared interval cadence is the standard 30s", () => {
    assert.strictEqual(HEARTBEAT_INTERVAL_MS, 30_000);
  });
});
