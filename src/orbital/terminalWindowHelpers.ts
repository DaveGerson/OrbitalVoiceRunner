// ---------------------------------------------------------------------------
// Pure helpers for TerminalWindow's complexity-refactor (CC burndown).
//
// Extracted into this CSS-free module (TerminalWindow.tsx is a .tsx that
// imports xterm/css via TerminalView, which the node test runner cannot load)
// so unit tests import the REAL implementations rather than mirror copies.
// All helpers are pure and deterministic — no React, no I/O, no side effects.
// ---------------------------------------------------------------------------

/**
 * Formats a raw timestamp string into a locale time string.
 * Falls back to the raw string if the value is not a valid date (or throws).
 */
export function formatHistoryTimestamp(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    if (!isNaN(d.getTime())) return d.toLocaleTimeString();
  } catch { /* raw string — fall through */ }
  return timestamp;
}

/**
 * Builds the text content for the history output `<pre>`.
 * - Trims trailing whitespace from raw output.
 * - Truncates to the last 4000 chars when the output is very long.
 * - Appends the final-response line when present.
 * - Returns "(no recorded output)" when there is nothing to show.
 */
export function buildHistoryOutputText(
  output: string | undefined,
  finalResponse: string | undefined,
): string {
  const preview = (output ?? "").trim();
  const body = preview
    ? (preview.length > 4000 ? preview.slice(-4000) : preview)
    : "(no recorded output)";
  return body + (finalResponse ? `\n— ${finalResponse}` : "");
}

/** Returns the status text shown in the terminal pane header bar. */
export function deriveStatusLineText(status: string, live: boolean): string {
  if (live) return "live on the burner";
  if (status === "Exited") return "process ended";
  if (status === "Needs Input") return "waiting on you, Chef";
  return "idle — prompt ready";
}

/** Returns the title attribute for the 86 button based on pane status. */
export function derive86Title(status: string): string {
  return status === "Exited"
    ? "86 this station (it already exited — straight to the freezer, recoverable)"
    : "86 this station (stop the process and freeze it — recoverable)";
}

/** Returns the background and color CSS values for the 86 button. */
export function derive86ButtonStyle(confirm86: boolean): { background: string; color: string } {
  return confirm86
    ? { background: "#e23a3a", color: "#fff4de" }
    : { background: "#fff4de", color: "#a8151a" };
}

/** Returns the label text for the 86 button. */
export function derive86ButtonLabel(confirm86: boolean): string {
  return confirm86 ? "Sure, Chef? Tap again" : "86 this station";
}

/** Maps a note type string to the TICKET_KINDS key used for display. */
export function resolveNoteTicketKey(noteType: string): "bug" | "todo" | "note" {
  if (noteType === "warning") return "bug";
  if (noteType === "todo") return "todo";
  return "note";
}
