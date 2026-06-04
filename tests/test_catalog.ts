// tests/test_catalog.ts — CAPABILITY CATALOG no-drift guard (REG1 Phase-1 exit, workstream C /
// spec §8.4 #20a, goal G0).
//
// PURE: imports ONLY the catalog generator (scripts/catalog.ts → REGISTRY + CAPABILITY_DEFS). That
// chain has NO module-level side effect (registry.ts does not import server.ts; terminal.ts boots no
// PTY/server), so this test runs with no server boot, no Gemini key, no PTY.
//
// What it pins: re-render the catalog IN-MEMORY and assert it deep-equals the COMMITTED
// docs/CAPABILITIES.md, so CI / the unit suite fails the moment the doc drifts from the registry.
// It also asserts the render is DETERMINISTIC (two renders are byte-identical — no clock/random).
//
// Runner: npx tsx --test --test-force-exit tests/test_catalog.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";

import { renderCatalog, DOC_PATH } from "../scripts/catalog";

describe("capability catalog (docs/CAPABILITIES.md)", () => {
  it("committed doc exists", () => {
    assert.ok(
      fs.existsSync(DOC_PATH),
      `docs/CAPABILITIES.md is missing — run \`npm run catalog\` to generate it.`
    );
  });

  it("committed doc matches the in-memory render (no drift from the registry)", () => {
    const rendered = renderCatalog();
    // Normalize CRLF→LF before comparing. The committed blob is LF (renderCatalog only ever emits
    // LF via `out.join("\n")`), but on a Windows clone with core.autocrlf=true git checks the file
    // out as CRLF and fs.readFileSync returns those raw bytes. This guard's intent is CONTENT drift
    // from the registry, not the on-disk EOL representation (which git/autocrlf controls), so we
    // strip the checkout-injected CR — genuine content drift still fails the assert.
    const committed = fs.readFileSync(DOC_PATH, "utf8").replace(/\r\n/g, "\n");
    assert.strictEqual(
      committed,
      rendered,
      "docs/CAPABILITIES.md is out of sync with the action registry. Run `npm run catalog` and commit the result."
    );
  });

  it("render is deterministic (no timestamps / random)", () => {
    assert.strictEqual(renderCatalog(), renderCatalog());
  });
});
