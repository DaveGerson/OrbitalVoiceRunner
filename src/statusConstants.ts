/**
 * Shared status-detection constants (WS-C). Kept in one module so independent
 * consumers (the authoritative probe in statusProbe.ts and the unrelated
 * attention-label refinement in server.ts) do not cross-import each other.
 */

/**
 * Process-table comm/Name values treated as interactive shells. Used by every
 * platform probe to distinguish a resting shell (idle) from a running command
 * (busy). Lower-cased; Windows `.exe` variants are listed explicitly.
 */
export const SHELL_COMMS = new Set([
  "sh", "bash", "zsh", "dash", "ash", "fish", "ksh", "tcsh", "csh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);

/** Narrowed shell prompt: the ENTIRE last line is a prompt (otherwise empty). */
export const SHELL_PROMPT = /(^|\n)[^\n]{0,80}?[\$#%>]\s?$/;
