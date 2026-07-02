// tests/test_check_e2e_ports_free.ts — validates the post-run port-leak diagnostic
// (scripts/checkE2ePortsFree.mjs) for BEAD wsm-e2e-pinned-rwnq.
//
// Two layers, mirroring run-unit's "pure decision table + validate against REAL behavior" pattern:
//   1. classifyPortProbe / ownerHint as pure decision tables.
//   2. probePort against a REAL socket: BUSY while a server holds an ephemeral port, FREE after it
//      closes — proving the actual socket-level behavior, not just the branch logic.
//
// Runner: npx tsx --test --test-force-exit tests/test_check_e2e_ports_free.ts

import { test } from "node:test";
import assert from "node:assert";
import net from "node:net";

import { classifyPortProbe, ownerHint, probePort } from "../scripts/checkE2ePortsFree.mjs";

test("classifyPortProbe: successful listen (null err) => FREE", () => {
  assert.equal(classifyPortProbe(null), "FREE");
  assert.equal(classifyPortProbe(undefined), "FREE");
});

test("classifyPortProbe: EADDRINUSE / EACCES => BUSY", () => {
  assert.equal(classifyPortProbe({ code: "EADDRINUSE" }), "BUSY");
  assert.equal(classifyPortProbe({ code: "EACCES" }), "BUSY");
});

test("classifyPortProbe: any other error code => UNKNOWN (never a false leak claim)", () => {
  assert.equal(classifyPortProbe({ code: "ECONNRESET" }), "UNKNOWN");
  assert.equal(classifyPortProbe({ code: "SOMETHING_ELSE" }), "UNKNOWN");
});

test("ownerHint: platform-appropriate, port-specific, printed-not-executed", () => {
  assert.match(ownerHint(5173, "win32"), /netstat -ano \| findstr :5173/);
  assert.match(ownerHint(3117, "linux"), /lsof -i :3117/);
  assert.match(ownerHint(3117, "darwin"), /lsof -i :3117/);
});

test("probePort: BUSY while a real server holds the port, FREE after it closes", async () => {
  // Grab an ephemeral free port by listening on 0, then read the assigned port number.
  const holder = net.createServer();
  const port: number = await new Promise((resolve) => {
    holder.listen(0, "0.0.0.0", () => {
      const addr = holder.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  // While the holder is bound, the probe must see BUSY.
  assert.equal(await probePort(port), "BUSY", "held port must probe BUSY");

  // Release it, then the same port must probe FREE.
  await new Promise<void>((resolve) => holder.close(() => resolve()));
  assert.equal(await probePort(port), "FREE", "released port must probe FREE");
});
