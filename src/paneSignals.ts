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
  return `PANE STATUS (mention to the operator if relevant, then stop): pane ${s.paneId} ${verb}${tail}`;
}
