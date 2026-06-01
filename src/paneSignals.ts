import { SHELL_PROMPT } from "./statusConstants";

export type PaneSignalKind = "idle" | "error" | "prompt" | "exited";

export interface PaneSignal {
  paneId: string;
  kind: PaneSignalKind;
  detail?: string; // compact; MUST already be redacted before formatting
}

export interface OutputClass {
  kind: "error" | "prompt";
  detail: string;
}

// Cheap, high-precision error/test-failure cues. Intentionally conservative — a false
// "error" push is noisier than a missed one, so we only match strong signals.
const ERROR_RE =
  /\b(error|build failed|exception|panic|traceback|FAILED|\d+\s+fail(?:ed|ing)|Tests?:\s*\d+\s+failed)\b/i;

/** Classify a chunk of ALREADY-ANSI-STRIPPED pane output. Returns the strongest
 *  signal found, or null. Errors win over prompts. */
export function classifyPaneOutput(cleanText: string): OutputClass | null {
  const lines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  for (const line of lines) {
    if (ERROR_RE.test(line)) return { kind: "error", detail: line.slice(0, 160) };
  }
  const last = lines[lines.length - 1];
  if (SHELL_PROMPT.test(last)) return { kind: "prompt", detail: last.slice(0, 80) };
  return null;
}

/** Compact, operator-facing text injected into the live session. Mirrors the
 *  approval-narration convention: a user-role nudge the model may speak, then stop. */
export function formatPaneSignal(s: PaneSignal): string {
  const verb =
    s.kind === "idle" ? "went idle (finished)"
    : s.kind === "error" ? "reported an error"
    : s.kind === "prompt" ? "is waiting at a prompt"
    : "exited";
  const tail = s.detail ? `: ${s.detail}` : "";
  return `PANE STATUS (mention to the operator if relevant, then stop): pane ${s.paneId} ${verb}${tail}`;
}
