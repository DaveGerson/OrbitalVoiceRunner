// tests/test_type_scale_floor.ts — TYPE-SCALE FLOOR GUARD (bead 5n7, operator decision D3).
//
// Floors sub-12px Tailwind font classes in the CLASSIC UI surface at 12px (`text-xs`). The ONLY
// permitted sub-12px escape hatch is the single CSS var `--text-nano` (.625rem / 10px), used via
// `text-[var(--text-nano)]` and reserved for genuinely load-bearing 10px text.
//
// PURE structural test over the on-disk source — no server boot, no Gemini key, no PTY (mirrors
// tests/test_action_test_presence.ts: synchronous fs reads only). It is the deterministic, fast,
// reviewable guard against a literal `text-[9px]` (etc.) surviving the migration sweep or a new one
// landing later. The Playwright spec (e2e/type_scale_floor.spec.ts) is the complementary RUNTIME
// guard: it asserts no VISIBLE text renders below the floor at 100% and 80% zoom.
//
// SCOPE: the classic React surface the bead enumerates — App.tsx + src/components/*.tsx. The orbital
// "kitchen" UI (src/orbital/**) sizes text through inline `style={{ fontSize }}` numerics, a separate
// mechanism + surface, and is intentionally NOT covered here (tracked as follow-up).
//
// Runner: npx tsx --test --test-force-exit tests/test_type_scale_floor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

// The classic surface the migration covers: App.tsx + every component .tsx. Resolved dynamically so a
// NEW classic component is automatically guarded (no allow-list to forget to update).
function classicFiles(): string[] {
  const files = [path.join(SRC, "App.tsx")];
  const compDir = path.join(SRC, "components");
  for (const f of fs.readdirSync(compDir).sort()) {
    if (f.endsWith(".tsx")) files.push(path.join(compDir, f));
  }
  return files;
}

// Any Tailwind arbitrary font-size class below the 12px floor, in px OR rem form. `text-xs` (the floor)
// is a named utility, never an arbitrary value, so it is structurally outside this pattern. The lone
// permitted escape, `text-[var(--text-nano)]`, references a var rather than a literal length, so it
// likewise never matches — only RAW sub-12px literals are flagged.
//   px:  text-[8px], text-[8.5px] … text-[11.5px]   (integer OR fractional, value < 12)
//   rem: text-[0.NNNrem] < 0.75rem  (anything starting 0.0–0.7 is < 12px; 0.75rem === 12px is allowed)
// The migration originally missed the fractional px form (text-[8.5px]) — the runtime Playwright guard
// surfaced it; this matcher now covers BOTH so the static guard is a true superset.
const SUB12_PX = /text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/g;
const SUB12_REM = /text-\[0\.(?:0\d*|[1-6]\d*|7[0-4]\d*)rem\]/g;

function findViolations(text: string): string[] {
  return [...(text.match(SUB12_PX) ?? []), ...(text.match(SUB12_REM) ?? [])];
}

describe("type-scale floor guard (classic UI: no sub-12px font literals)", () => {
  const files = classicFiles();

  it("sanity: the classic file set resolved and is readable", () => {
    assert.ok(files.length >= 5, `expected the classic surface (App.tsx + components/*.tsx); got ${files.length}`);
    for (const f of files) assert.ok(fs.existsSync(f), `missing classic file: ${f}`);
  });

  it("no classic file uses a sub-12px Tailwind font literal (floor at text-xs; --text-nano is the only escape)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
      const hits = findViolations(text);
      if (hits.length > 0) {
        const counts = hits.reduce<Record<string, number>>((m, h) => ((m[h] = (m[h] ?? 0) + 1), m), {});
        const detail = Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(", ");
        offenders.push(`${path.relative(ROOT, f)}: ${detail}`);
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `sub-12px font literal(s) below the floor:\n  ${offenders.join("\n  ")}\n` +
        `Replace with \`text-xs\` (12px). Where 10px is GENUINELY load-bearing, use ` +
        `\`text-[var(--text-nano)]\` (the .625rem var defined in src/index.css) sparingly.`,
    );
  });

  it("the --text-nano escape var is defined exactly once in src/index.css (so the escape hatch is real)", () => {
    const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
    const defs = css.match(/--text-nano\s*:/g) ?? [];
    assert.strictEqual(
      defs.length,
      1,
      `expected exactly one \`--text-nano:\` definition in src/index.css, found ${defs.length}`,
    );
    assert.match(css, /--text-nano\s*:\s*0?\.625rem/, "`--text-nano` must be 0.625rem (10px)");
  });
});
