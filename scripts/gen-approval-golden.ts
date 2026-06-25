/**
 * Golden-master generator for the Python⇄TS seam (plan task 1.7).
 *
 * Drives the AUTHORITATIVE TypeScript `parseApprovalIntent` across a dense, boundary-focused grid of
 * utterances and freezes {transcript, expected} vectors to `tests/fixtures/approval_intent_golden.json`.
 * Both languages then assert against the SAME frozen file:
 *   - `tests/test_approval_golden_parity.ts` re-runs TS over the grid and asserts it still reproduces
 *     every frozen output (a regression lock — if the parser changes, this fails first, signalling
 *     "regenerate + re-verify the Python port").
 *   - `python/synthesizer/tests/test_approval.py` asserts the Python port reproduces every vector.
 *
 * The grid is hand-curated for BOUNDARIES (not sampled): empty/whitespace, the <=2/<=3 length guards,
 * the negation window, the full defer phrase ladder + its negator suppression, apostrophe-drop,
 * approve/reject collisions, ordinals, and named fragments. Regenerate with:
 *   npx tsx scripts/gen-approval-golden.ts
 */
import { parseApprovalIntent } from "../src/approvalIntent";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ── The boundary grid (inputs only; expected outputs are computed from the authoritative parser) ──
const GRID: string[] = [
  // ── empty / whitespace / noise ──────────────────────────────────────────────
  "", "   ", "\t\n", ".", "?!", "um", "uh huh",

  // ── bare yes/no family (<=2 tokens) ─────────────────────────────────────────
  "yes", "Yes.", "yep", "yeah", "approved", "ok", "okay", "affirmative",
  "no", "No!", "nope", "nah", "negative",
  "yes no", "no yes", "yes please", "no thanks", "ok no",

  // ── bare skip family (<=2 tokens, no "for now" rider -> reject) ──────────────
  "skip", "skip it", "skip that", "skip this", "skip the deploy",

  // ── defer phrase table (clause by clause) ───────────────────────────────────
  // (1) short utterance (<=3 tokens) containing "later"
  "later", "maybe later", "do later", "much later please later",
  // (2) "<me|again|it|that|them|you> later" bigram
  "ask me later", "remind me again later", "do it later", "leave that later",
  "approve it later", "run that later",
  // (3) not now / not yet / not right now
  "not now", "not yet", "not right now", "no not now",
  // (4) hold <particle> / on hold
  "hold on", "hold off", "hold that", "hold it", "hold them", "on hold", "hold",
  "hold the deploy", "please hold on a sec",
  // (5) in a <unit>
  "in a minute", "in a moment", "in a bit", "in a second", "in a sec", "in a while", "in a few",
  "give me a minute", "in a jiffy",
  // (6) "for now" + a parking verb anywhere
  "skip that for now", "leave it for now", "hold the npm install for now",
  "wait on the deploy for now", "park the docker build for now", "pass for now",
  "for now", "leave it alone for now",
  // negator suppression of defer ("dont hold it" must NOT defer)
  "dont hold it", "do not hold that", "dont leave it later", "never hold on",

  // ── negation window (verb negated within 3 preceding tokens) ────────────────
  "do not run it", "do not run the command", "dont run", "dont go", "dont execute",
  "never run it", "never go", "please do not cancel it", "i dont want to cancel",
  "do not approve", "dont approve", "dont confirm", "do not reject it", "dont reject it",
  "do not stop the build",

  // ── leading-negator directive (contracted negator + ambient action verb) ────
  "dont run", "dont go", "dont execute", "dont proceed", "dont dispatch", "dont send",
  "never run", "never execute", "dont cancel", "dont stop", "dont skip",

  // ── strong approve verbs (trigger without an object) ────────────────────────
  "approve", "approve.", "approved", "accept", "accepted", "confirm", "confirmed",
  "authorize", "authorized", "go ahead and approve",

  // ── strong reject verbs ─────────────────────────────────────────────────────
  "reject", "rejected", "deny", "denied", "decline", "discard", "reject it",
  "please reject the command",

  // ── weak verbs: bare (no object) vs paired (with object) ────────────────────
  "run", "go", "stop", "proceed", "execute", "dispatch", "send", "cancel", "abort", "nevermind",
  "run it", "go it", "send it", "go ahead", "lets go", "run the command", "cancel it",
  "cancel that", "stop the build", "abort the deploy", "execute the task", "proceed with it",
  "run the npm install command", "cancel the docker deploy",

  // ── approve / reject collisions (must clarify, never default-approve) ────────
  "approve but reject", "approve and reject it", "reject the approve one",
  "yes but cancel it", "approve it but stop", "confirm and deny", "accept and decline it",

  // ── ordinals + named fragments (target hints) ───────────────────────────────
  "approve the first one", "approve the second one", "reject the last one",
  "approve the third command", "cancel the previous one", "approve the latest one",
  "approve the npm install command", "reject the docker deploy",
  "approve the first one and reject the second", "confirm the build step",
  "run the migration script please", "approve the test suite one",

  // ── apostrophe / casing / punctuation normalization ─────────────────────────
  "Don't run it", "DON'T GO", "Approve!", "  reject  ", "yes, approve the deploy",
  "can't cancel that", "won't approve", "approve—the second—one",

  // ── longer ambient speech that must resolve to none ─────────────────────────
  "i think we should look at the logs", "the build is running fine",
  "lets talk about the approve button later actually", "what does this command do",
  "we run tests every morning", "the second pane looks idle",
];

function main(): void {
  // Dedupe while preserving order (the grid is hand-authored; guard against accidental repeats).
  const seen = new Set<string>();
  const vectors = GRID.filter((t) => (seen.has(t) ? false : (seen.add(t), true))).map((transcript) => ({
    transcript,
    expected: parseApprovalIntent(transcript),
  }));

  const outDir = path.join(here, "..", "tests", "fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "approval_intent_golden.json");
  const payload = {
    // Provenance so a reader knows this is generated, not hand-maintained.
    _generator: "scripts/gen-approval-golden.ts",
    _parser: "src/approvalIntent.ts :: parseApprovalIntent",
    count: vectors.length,
    vectors,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  console.log(`wrote ${vectors.length} golden vectors -> ${path.relative(process.cwd(), outFile)}`);
}

main();
