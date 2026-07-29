// tests/test_send_site_ratchet.ts — Wave 1 T1: the model-bound SEND-SITE RATCHET.
//
// Spec §5-T1 (docs/superpowers/specs/2026-07-29-turn-arbiter-design.md): one module must come to
// own every model-bound send. Wave 1 makes ZERO call-site re-routes, so this ratchet pins TODAY's
// production producer inventory EXACTLY (audit docs/design/2026-07-29-comm-flow-smoothness-audit.md
// §1) — any NEW direct `sendClientContent` caller or forced-narration (`pushApprovalNarration`)
// caller fails CI on arrival and must route through the turn-arbiter instead. Later waves shrink
// these allowlists as producers are re-homed (W2: the five gating timer sites; W3: briefs/signals);
// family D tool responses (`sendToolResponse`) stay exempt forever — the turn is the operator's own.
//
// Counting rules (deliberately simple + hand-verified):
//   - scope: server.ts (repo root) + every .ts/.tsx under src/ — the production runtime.
//     scripts/ is excluded on purpose: scripts/verify-grounding-acceptance.ts:111 sends a probe
//     turn on its OWN scripted session (an offline acceptance probe, not the operator's live
//     conversation). tests/ and dist/ are not production.
//   - a "call site" is a line matching `.sendClientContent(` (dot-call — a fake's property
//     DEFINITION like scriptedLiveConnector's does not count) or `pushApprovalNarration(`/
//     `pushApprovalNarrationDep(` (the injected-slot identity in src/voice/index.ts is the same
//     producer surface — see src/gating/index.ts:110's injection seam).
//   - lines that START as comments (`//`, `/*`, `*`) are skipped; the definition line
//     `function pushApprovalNarration(` is excluded. Type/wiring mentions (`pushApprovalNarration:`)
//     never match because the regex requires an immediate `(`.
//
// The two arbiter tests at the bottom are Wave-1 RED: they pin the designated owner
// (src/voice/turnArbiter.ts) into existence and pin its purity (no send, no timers, no wall-clock
// — the caller supplies `now`; turn timing stays in-process synchronous TS, the LOCKED seam rule).
//
// Runner: npx tsx --test --test-force-exit tests/test_send_site_ratchet.ts

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ── THE ALLOWLISTS (repo-relative path → exact call-site count) ────────────────────────────────
// Update these ONLY when a wave deliberately re-homes a producer through the arbiter (count goes
// DOWN) or the director approves a new producer (goes UP — should be ~never; submit to the arbiter
// instead). Site-by-site provenance, hand-verified 2026-07-29:
//
// sendClientContent — src/voice/index.ts ×5:
//   :412  pushApprovalNarration (family A — forced SYSTEM EVENT narration)
//   :516  pushAck               (family A sibling — natural-cadence spawn acks)
//   :1246 injectMemoryBrief     (family B — memory-brief context injection)
//   :2427 pushSignal            (family C — passive pane-signal context)
//   sendArbiterDigest (Wave 4, spec §3.3/§4-W4): the ONE choke point every drained
//     turn-arbiter Digest becomes an actual injection through — 4->5 is the program's OWN
//     consolidation site, not a new bypass: it is the ONLY site a DrainDecision (which every
//     re-homed producer — gating's five timer call-sites, vc-C completions, class-4/5 pane
//     signals — now funnels through submit()/evaluate()) ever reaches Gemini from. A future
//     wave that folds pushSignal's own immediate class-5 push through the SAME arbiter queue
//     would shrink this back toward 4, not grow it further.
//
// pushApprovalNarration(/Dep) callers:
//   src/gating/index.ts ×14 (Wave 3, spec §3.3 row 7, re-verified) — the LEGACY (no-arbiter) arm of
//     each Wave-2/3 site: autonomy warn (:815) / expire (:833), stop-all (:912/:923/:978), the
//     reconnect survivors digest + away digest now share ONE extracted `narrateReconnect` helper
//     (:990 — a deliberate consolidation, hence 15->14, not a new producer), approve/dead-pane/
//     reject/TTL-expiry (:1190/:1196/:1202/:1217), deferral cap + hold ack (:1347/:1362), sweep
//     last-calls ×2 (:1441/:1492). Seven of these are the timer-driven jump-over family (audit
//     §2.1) that W2/W3 re-route as class-2/5 submits when an arbiter is injected.
//   src/voice/index.ts ×4 — hands-free routing narrate cbs (:1004/:1836/:1849), macro read-back
//     (:1886), all via the injected pushApprovalNarrationDep identity.
const SEND_ALLOWLIST: Record<string, number> = {
  "src/voice/index.ts": 5,
};
const NARRATE_ALLOWLIST: Record<string, number> = {
  "src/gating/index.ts": 14,
  "src/voice/index.ts": 4,
};

const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*)/;

function walkTs(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      walkTs(p, out);
      continue;
    }
    if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function productionFiles(): string[] {
  const files = walkTs(path.join(repoRoot, "src"), []);
  const serverTs = path.join(repoRoot, "server.ts");
  if (existsSync(serverTs)) files.push(serverTs);
  return files;
}

function countCallSites(file: string, callRe: RegExp, excludeRe?: RegExp): number {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let n = 0;
  for (const line of lines) {
    if (COMMENT_LINE_RE.test(line)) continue;
    if (excludeRe && excludeRe.test(line)) continue;
    const m = line.match(callRe);
    if (m) n += m.length;
  }
  return n;
}

function inventory(callRe: RegExp, excludeRe?: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of productionFiles()) {
    const n = countCallSites(file, callRe, excludeRe);
    if (n > 0) found[path.relative(repoRoot, file).split(path.sep).join("/")] = n;
  }
  return found;
}

test("T1 ratchet: direct sendClientContent production call sites are pinned exactly", () => {
  const found = inventory(/\.sendClientContent\s*\(/g);
  assert.deepStrictEqual(
    found,
    SEND_ALLOWLIST,
    "sendClientContent producer inventory drifted. A NEW model-bound send must NOT be added " +
      "directly — submit({facts, cls, ...}) to the turn-arbiter (src/voice/turnArbiter.ts) instead. " +
      "If a wave deliberately re-homed a site through the arbiter, shrink the allowlist in this test.",
  );
});

test("T1 ratchet: forced-narration (pushApprovalNarration) caller inventory is pinned exactly", () => {
  const found = inventory(
    /\bpushApprovalNarration(?:Dep)?\s*\(/g,
    /\bfunction pushApprovalNarration\b/,
  );
  assert.deepStrictEqual(
    found,
    NARRATE_ALLOWLIST,
    "forced-narration caller inventory drifted. pushApprovalNarration sends a FORCED spoken turn " +
      "with zero turn-gating (audit §2.1 — the jump-over family). New producers must submit to the " +
      "turn-arbiter; deliberate wave re-routes shrink the allowlist here.",
  );
});

// ── Wave-1 RED: the designated owner must exist, and must be pure ──────────────────────────────

// Computed specifier so tsc doesn't resolve it while unimplemented (lint stays green during RED).
const ARBITER_SPEC = ["..", "src", "voice", "turnArbiter"].join("/");

test("W1: the designated send-owner exists — src/voice/turnArbiter.ts exports the decision surface", async () => {
  let mod: any;
  try {
    mod = await import(ARBITER_SPEC);
  } catch (e: any) {
    assert.fail(
      "Wave-1 feature absent: src/voice/turnArbiter.ts is not implemented yet (spec §3.1) — " +
        `import failed: ${e?.message ?? e}`,
    );
  }
  assert.strictEqual(typeof mod.createTurnArbiter, "function");
  assert.strictEqual(typeof mod.normalizeDeliveryMatrix, "function");
  assert.strictEqual(mod.TTL_FLOOR_EXTENSION_CAP_MS, 60_000);
});

test("W1: the arbiter core is PURE — no send, no timers, no wall-clock (caller supplies now)", () => {
  const p = path.join(repoRoot, "src", "voice", "turnArbiter.ts");
  assert.ok(
    existsSync(p),
    "Wave-1 feature absent: src/voice/turnArbiter.ts does not exist yet (spec §3.1)",
  );
  const src = readFileSync(p, "utf8");
  for (const banned of ["sendClientContent", "setTimeout", "setInterval", "Date.now"]) {
    assert.ok(
      !src.includes(banned),
      `turnArbiter.ts must stay a pure synchronous decision module (spec §3.1: no I/O, no timers ` +
        `of its own; the caller supplies now) — found "${banned}"`,
    );
  }
});
