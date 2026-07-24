// tests/test_persona_docs_banner.ts — BEAD 6opi.
//
// The three round-one persona docs under docs/roadmap/ are dated 2026-05-28 assessments that
// conclude "would not use today", citing blockers (no voice-approval path, dead transcripts,
// blind approvals, orphaned approvals) that were demonstrably fixed on main after PR134. Without a
// prominent banner, a reader can mistake these for current fact. This test pins that each doc
// carries a historical-assessment banner at the very top (before the "## Methodology" section),
// dated round-one 2026-05-28, stating the cited blockers are superseded/resolved, and pointing
// forward to docs/roadmap/next-level as the current wishlist.
//
// Pure fs read — no server boot, no PTY. Normalizes CRLF -> LF before matching (Windows).
//
// Runner: npx tsx --test --test-force-exit tests/test_persona_docs_banner.ts

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const DOCS = [
  "docs/roadmap/01-power-user-maya.md",
  "docs/roadmap/02-security-platform-devon.md",
  "docs/roadmap/03-voice-first-sam.md",
];

function readNormalized(relPath: string): string {
  const raw = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return raw.replace(/\r\n/g, "\n");
}

for (const doc of DOCS) {
  test(`${doc}: carries a prominent historical-assessment banner at the top`, () => {
    const content = readNormalized(doc);
    const top = content.slice(0, 1200);

    assert.match(top, /HISTORICAL ASSESSMENT/i, `${doc}: banner must exist within the first ~1200 chars`);
    assert.match(top, /2026-05-28|round one/i, `${doc}: banner must date the assessment as round-one`);
    assert.match(
      top,
      /SUPERSEDED|resolved|no longer|since fixed/i,
      `${doc}: banner must state the cited blockers are fixed on main after PR134`,
    );
    assert.match(top, /next-level/i, `${doc}: banner must point forward to docs/roadmap/next-level`);

    const bannerIdx = content.indexOf("HISTORICAL ASSESSMENT");
    const methodologyIdx = content.indexOf("## Methodology");
    assert.notStrictEqual(bannerIdx, -1, `${doc}: banner marker not found`);
    assert.notStrictEqual(methodologyIdx, -1, `${doc}: expected a "## Methodology" section`);
    assert.ok(
      bannerIdx < methodologyIdx,
      `${doc}: banner must appear BEFORE the ## Methodology section (found banner @${bannerIdx}, methodology @${methodologyIdx})`,
    );
  });
}
