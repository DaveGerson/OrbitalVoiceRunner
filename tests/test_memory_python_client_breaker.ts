import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPythonSynthClient } from "../src/memory/pythonClient";

class FakeChild extends EventEmitter {
  stdin = { write: (s: string) => { this.written.push(s); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  kill() {}
  ping() { this.stdout.emit("data", Buffer.from(JSON.stringify({ id: "__ping__", v: 1, ok: true, pong: true, synthVersion: "1.0.0" }) + "\n")); }
  crash() { this.emit("exit", { exitCode: 1 }); }
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

test("a crash triggers a backed-off respawn that becomes available again", async () => {
  const spawned: FakeChild[] = [];
  const client = createPythonSynthClient({
    moduleDir: "/m", repoRoot: "/r", existsSync: () => true, log: () => {},
    backoffBaseMs: 10, backoffMaxMs: 20, breakerThreshold: 3, breakerWindowMs: 1000, cooldownMs: 50,
    spawnImpl: (() => { const c = new FakeChild(); spawned.push(c); return c; }) as any,
  });
  await delay(1); spawned[0].ping(); await delay(1);
  assert.equal(client.available(), true);
  spawned[0].crash();
  assert.equal(client.available(), false);
  await delay(30); // wait out the backoff respawn
  assert.equal(spawned.length, 2);
  spawned[1].ping(); await delay(1);
  assert.equal(client.available(), true);
  client.dispose();
});

test("3 crashes within the window trip the breaker → fallback for the cooldown", async () => {
  const spawned: FakeChild[] = [];
  const client = createPythonSynthClient({
    moduleDir: "/m", repoRoot: "/r", existsSync: () => true, log: () => {},
    backoffBaseMs: 5, backoffMaxMs: 5, breakerThreshold: 3, breakerWindowMs: 1000, cooldownMs: 60,
    spawnImpl: (() => { const c = new FakeChild(); spawned.push(c); return c; }) as any,
  });
  await delay(1); spawned[0].ping(); await delay(1);
  spawned[0].crash(); await delay(10);   // respawn 1
  spawned[1].crash(); await delay(10);   // respawn 2
  spawned[2].crash(); await delay(10);   // 3rd failure → breaker OPEN
  assert.equal(client.synthesizerState(), "fallback");
  const countAtTrip = spawned.length;
  await delay(20); // still inside cooldown → no new spawn
  assert.equal(spawned.length, countAtTrip);
  await delay(60); // cooldown elapsed → exactly one probe spawn
  assert.equal(spawned.length, countAtTrip + 1);
  client.dispose();
});
