import { SHELL_PROMPT } from "./statusConstants";
import { redactSecrets } from "./terminal";

export type PaneSignalKind = "idle" | "error" | "prompt" | "exited" | "created" | "running" | "quiescing" | "closed";

export interface PaneSignal {
  paneId: string;
  kind: PaneSignalKind;
  detail?: string; // compact and secret-redacted — safe to inject into the model
}

export interface OutputClass {
  kind: "error" | "prompt";
  detail: string;
}

// Cheap, high-precision error/test-failure cues. Intentionally conservative — a false
// "error" push is noisier than a missed one, so we only match strong signals. The
// (?![-./]) guard after `error` avoids false positives on kebab/dotted/path filenames
// that HMR/build panes print constantly (e.g. "error-handling.ts", "/src/error.ts").
const ERROR_RE =
  /\b(error(?![-./])|build failed|exception|panic|traceback|FAILED|\d+\s+fail(?:ed|ing)|Tests?:\s*\d+\s+failed)\b/i;

// BUG-031 semantic-extraction lane. These REUSE the ERROR_RE above verbatim (do NOT duplicate or
// perturb it — it also serves the proactive-push classifier). WARN_RE is word-anchored so it fires
// on `Warning:` / `npm WARN` / `... is deprecated` but not on substrings like `warnings: 0`.
const WARN_RE = /\b(warning|npm warn|deprecated)\b/i;
// Matches `process exited with code 1`, `exit code 0`, `Command exited with status 127`. Group 1 =
// the numeric code (a zero code is a legitimate capture — the caller must NOT treat it as falsy).
const EXIT_RE = /\b(?:process\s+)?exit(?:ed)?(?:\s+with)?\s+(?:code|status)\s+(\d+)\b/i;
// Pure-noise pre-filter: progress bars, hex dumps, bare ISO timestamps. Belt-and-suspenders — such
// lines carry no error/warning word so they never enter the arrays anyway; this just short-circuits.
const NOISE_RE = /^(\[[#=>\s.-]*\]\s*\d+%|(?:[0-9a-f]{2}\s+){4,}[0-9a-f]{2}|\d{4}-\d\d-\d\dT[\d:.]+Z)\b/i;
// FC(5): a GREEN test summary ("Tests: 0 failed, 25 passed") matches ERROR_RE via the shared
// `\d+\s+fail(?:ed|ing)` alternative, so a passing run would narrate as failed. This suppresses a
// zero-count fail/failing ONLY in the extraction lane below — classifyPaneOutput / the proactive
// push lane are intentionally untouched (they reuse ERROR_RE verbatim and must not be perturbed).
const ZERO_FAIL_RE = /\b0\s+fail(?:ed|ing)\b/i;

/** Classify a chunk of ALREADY-ANSI-STRIPPED pane output. Returns the strongest
 *  signal found, or null. Errors win over prompts. `detail` is secret-redacted here
 *  (at the boundary) so the invariant holds regardless of caller — the signal may be
 *  injected straight into the live model session. */
export function classifyPaneOutput(cleanText: string): OutputClass | null {
  const lines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  for (const line of lines) {
    if (ERROR_RE.test(line)) return { kind: "error", detail: redactSecrets(line).slice(0, 160) };
  }
  // SHELL_PROMPT is shared with the status machine, so we don't tighten it here.
  // Known limitation: a last line ending in '>' (e.g. a JSX/HTML tag like "</Provider>")
  // can read as a prompt. Benign next to an error false-positive; tune during live testing.
  const last = lines[lines.length - 1];
  if (SHELL_PROMPT.test(last)) return { kind: "prompt", detail: redactSecrets(last).slice(0, 80) };
  return null;
}

/**
 * BUG-031: structured signal extraction over ALREADY-ANSI-STRIPPED pane output. Pure + deterministic.
 * REUSES ERROR_RE (errors win over warnings on a line that matches both) and adds WARN_RE / EXIT_RE.
 * Each captured line is `redactSecrets`'d at the boundary (same convention as classifyPaneOutput), so
 * the invariant holds regardless of caller. The LAST exit line wins (the most recent termination). A
 * `code 0` exit yields `exitCode === 0` — the caller must merge with `??`, never `||`.
 */
export function extractOutputSignals(cleanText: string): { errors: string[]; warnings: string[]; exitCode?: number } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let exitCode: number | undefined;
  for (const raw of cleanText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || NOISE_RE.test(line)) continue;
    const m = EXIT_RE.exec(line);
    if (m) exitCode = Number(m[1]); // LAST match wins; Number("0") === 0 survives (not dropped)
    // errors win over warnings — but FC(5): a zero-count "0 failed"/"0 failing" line is a PASS, not
    // a failure, so it must not land in errors[] (extraction lane only).
    if (ERROR_RE.test(line) && !ZERO_FAIL_RE.test(line)) { errors.push(redactSecrets(line)); continue; }
    if (WARN_RE.test(line)) warnings.push(redactSecrets(line));
  }
  return { errors, warnings, exitCode };
}

/**
 * Verb table for formatPaneSignal — verbatim extraction of the inline ternary chain.
 * A plain object lookup carries zero cognitive complexity (no branches in the function body).
 * Each entry is VERBATIM from the original chain; the "exited" default is the fallback below.
 *
 * "closed" is the OPERATOR-initiated exit+archive completion (close_pane / UI Exit), distinct
 * from "exited" (a pane that ended on its own, detected by the state machine). It is turn-gated
 * in voice/index.ts so the confirmation never talks over the operator.
 *
 * "running" is the BEGINNING edge (Phase 1 "ears"). It MUST be in the table: omitting it would
 * fall through to the "exited" default, mis-narrating a start as an end — actively misleading the model.
 *
 * "quiescing" is the Conservative Phase 2 HUMBLE pre-idle nudge: the pane has gone quiet but is NOT
 * yet declared done (inside the idle-debounce window the state machine already arms). Wording stays
 * tentative ("appears to be wrapping up") — must NOT read as completion.
 */
const PANE_SIGNAL_VERBS: Partial<Record<PaneSignalKind, string>> = {
  created:   "is up and ready",
  closed:    "is exited and archived (recoverable)",
  idle:      "went idle (finished)",
  error:     "reported an error",
  prompt:    "is waiting at a prompt",
  running:   "started working (cooking)",
  quiescing: "appears to be wrapping up (still cooking — not yet confirmed complete)",
};

/** Compact, operator-facing text injected into the live session. Mirrors the
 *  approval-narration convention: a user-role nudge the model may speak, then stop. */
export function formatPaneSignal(s: PaneSignal): string {
  const verb = PANE_SIGNAL_VERBS[s.kind] ?? "exited";
  const tail = s.detail ? `: ${s.detail}` : "";
  return `PANE STATUS UPDATE (context only — do not speak unless the operator asks): pane ${s.paneId} ${verb}${tail}`;
}
