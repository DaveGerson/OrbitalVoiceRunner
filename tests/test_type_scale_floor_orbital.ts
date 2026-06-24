// tests/test_type_scale_floor_orbital.ts — TYPE-SCALE FLOOR GUARD for the KITCHEN surface (bead 5n7).
//
// PR #89 floored sub-12px fonts in the CLASSIC React surface (App.tsx + src/components/*.tsx), where
// sizing is done through Tailwind font classes (`text-[9px]` → `text-xs`); that guard lives in
// tests/test_type_scale_floor.ts. The orbital "kitchen" — the DEFAULT surface — sizes text through a
// DIFFERENT mechanism: inline `style={{ fontSize: <number> }}` numerics. This guard is the kitchen's
// equivalent: it floors those inline numeric font sizes at 12px.
//
// PURE structural test over the on-disk source — no server boot, no Gemini key, no PTY (mirrors
// tests/test_type_scale_floor.ts: synchronous fs reads only). It is the deterministic, fast guard
// against a literal `fontSize: 9` (etc.) surviving the sweep or a new one landing later.
//
// SCOPE: every .tsx under src/orbital/** (recursively, incl. views/). Resolved dynamically so a NEW
// kitchen component is automatically guarded (no allow-list to forget to update).
//
// WHAT COUNTS AS A VIOLATION: a `fontSize:` followed by a NUMERIC LITERAL < 12 (integer or decimal).
// Non-literal sizes — `fontSize: fs`, `fontSize: size * 0.42` (a computed avatar glyph) — are NOT
// literals and never match. SVG glyph sizing via `size={N}` is a different prop (not `fontSize:`) and
// is likewise never matched. Emoji decorations in the kitchen all sit at >= 12, so the floor leaves
// them alone.
//
// Runner: npx tsx --test --test-force-exit tests/test_type_scale_floor_orbital.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORBITAL = path.join(ROOT, "src", "orbital");

const FLOOR_PX = 12;

// Recursively collect every .tsx under src/orbital/** (the kitchen surface).
function orbitalFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...orbitalFiles(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// `fontSize:` + optional ws + a numeric literal (int or decimal). We re-check < 12 in code so the
// floor value (12) and any larger size never flag, while `fontSize: fs` (non-numeric) never matches.
const FONT_SIZE_LITERAL = /fontSize:\s*(\d+(?:\.\d+)?)\b/g;

function findSubFloor(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(FONT_SIZE_LITERAL)) {
    if (parseFloat(m[1]) < FLOOR_PX) hits.push(`fontSize: ${m[1]}`);
  }
  return hits;
}

describe("type-scale floor guard (kitchen/orbital UI: no sub-12px inline fontSize literals)", () => {
  const files = orbitalFiles(ORBITAL);

  it("sanity: the orbital file set resolved and is readable", () => {
    assert.ok(files.length >= 10, `expected the kitchen surface (src/orbital/**/*.tsx); got ${files.length}`);
    for (const f of files) assert.ok(fs.existsSync(f), `missing orbital file: ${f}`);
  });

  it("no orbital file sets an inline fontSize below the 12px floor", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
      const hits = findSubFloor(text);
      if (hits.length > 0) {
        const counts = hits.reduce<Record<string, number>>((m, h) => ((m[h] = (m[h] ?? 0) + 1), m), {});
        const detail = Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(", ");
        offenders.push(`${path.relative(ROOT, f)}: ${detail}`);
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `inline fontSize literal(s) below the ${FLOOR_PX}px floor:\n  ${offenders.join("\n  ")}\n` +
        `Raise each to \`fontSize: ${FLOOR_PX}\` (the kitchen type-scale floor). Emoji/icon glyphs ` +
        `already sit at >= ${FLOOR_PX}; SVG sizing uses \`size={…}\`, not \`fontSize:\`.`,
    );
  });
});
