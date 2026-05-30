import { execSync } from "child_process";

/**
 * StatusProbe — the authoritative busy/idle signal source (WS-C design §2.0).
 *
 * A probe answers a single question: given the PTY shell/agent root pid, is a
 * foreground child command currently running under it? The state machine in
 * terminal.ts consumes this (plus output events) and is busy-biased: any positive
 * "still running" signal wins (I2).
 *
 * Each platform probe factors its parsing into a PURE function
 * (parseProcTree / parsePsTree / parseProcessList) so the logic is unit-tested
 * against captured/synthetic text fixtures with no real processes (design §7.2).
 */

export type ProbeResult = {
  /** Authoritative "busy" signal: a descendant command process is alive. */
  hasRunningChild: boolean;
  /** "authoritative" = real process-tree probe; "fallback" = unavailable/unknown. */
  confidence: "authoritative" | "fallback";
};

export interface StatusProbe {
  /**
   * shellPid = the PTY's shell/agent root pid. Returns whether a foreground
   * child command is currently running under it.
   */
  probe(shellPid: number): ProbeResult;
}

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested against text fixtures — design §7.2/§7.3)
// ---------------------------------------------------------------------------

/** Process-table comm names treated as interactive shells (for the prompt-at-rest test). */
const SHELL_COMMS = new Set([
  "sh", "bash", "zsh", "dash", "ash", "fish", "ksh", "tcsh", "csh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);

interface ProcRec {
  pid: number;
  ppid: number;
  pgrp: number;
  tpgid: number;
  comm: string;
  state: string;
}

function parseProcRecords(entries: string[]): ProcRec[] {
  const out: ProcRec[] = [];
  for (const raw of entries) {
    const line = raw.trim();
    if (!line) continue;
    const open = line.indexOf("(");
    const close = line.lastIndexOf(")");
    if (open < 0 || close < 0 || close < open) continue;
    const pid = parseInt(line.slice(0, open).trim(), 10);
    if (!Number.isFinite(pid)) continue;
    const comm = line.slice(open + 1, close);
    // After ')': state ppid pgrp session tty_nr tpgid ...
    const f = line.slice(close + 1).trim().split(/\s+/);
    const state = f[0] || "";
    const ppid = parseInt(f[1], 10);
    const pgrp = parseInt(f[2], 10);
    const tpgid = parseInt(f[5], 10);
    if (!Number.isFinite(ppid)) continue;
    out.push({ pid, ppid, pgrp: pgrp || 0, tpgid: Number.isFinite(tpgid) ? tpgid : -1, comm, state });
  }
  return out;
}

/** Set of shellPid plus all its descendants. */
function treeMembers(recs: ProcRec[], shellPid: number): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const r of recs) {
    const arr = childrenOf.get(r.ppid) || [];
    arr.push(r.pid);
    childrenOf.set(r.ppid, arr);
  }
  const members = new Set<number>([shellPid]);
  const stack = [shellPid];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of childrenOf.get(cur) || []) {
      if (!members.has(c)) {
        members.add(c);
        stack.push(c);
      }
    }
  }
  return members;
}

/**
 * Linux: decide busy/idle from the contents of every /proc/[pid]/stat.
 *
 * A pane is IDLE iff somewhere in the PTY shell's process tree there is an
 * interactive shell that is sitting at its own prompt as the terminal's
 * foreground job — i.e. a shell process with pid == pgrp == tpgid. When a
 * command runs, that shell's tpgid points at the command's process group
 * instead, so no foreground-resting-shell exists and the pane is BUSY.
 *
 * This is robust to node-pty's `sh -c "<cmd>"` wrapper (which leaves a nested
 * leaf shell as a permanent child) — a naive "any descendant exists" rule would
 * read such a pane as permanently busy. Busy-biased (I2): if no resting shell is
 * found, we report busy.
 *
 * `entries` is an array of raw /proc/[pid]/stat file contents (the canonical
 * layout `pid (comm) state ppid pgrp session tty_nr tpgid …`; comm may contain
 * spaces/parens).
 */
export function parseProcTree(entries: string[], shellPid: number): boolean {
  const recs = parseProcRecords(entries);
  if (recs.length === 0) return false;
  const members = treeMembers(recs, shellPid);
  for (const r of recs) {
    if (!members.has(r.pid)) continue;
    const isShell = SHELL_COMMS.has(r.comm.toLowerCase());
    // A shell at its prompt as the foreground job: pid == pgrp == tpgid.
    if (isShell && r.pgrp === r.pid && r.tpgid === r.pid) {
      return false; // resting shell present ⇒ idle
    }
  }
  return true; // no resting foreground shell ⇒ busy (busy-biased)
}

/**
 * macOS / generic ps: parse `ps -o pid=,ppid=,stat=,comm= -ax` output and decide
 * busy/idle by the same "foreground resting shell" rule as Linux.
 *
 * The `stat` column carries a `+` suffix for processes in the controlling
 * terminal's foreground process group. A pane is IDLE iff, within the PTY
 * shell's process tree, an interactive shell is the foreground job (its stat
 * contains `+`); otherwise a command holds the foreground group ⇒ BUSY.
 * Busy-biased (I2): no foreground shell ⇒ busy.
 *
 * Columns per line: `<pid> <ppid> <stat> <comm…>`. comm is optional; when absent
 * the parser still tracks the tree but cannot identify a shell, so it falls back
 * to "any foreground descendant other than the root ⇒ busy".
 */
export function parsePsTree(rawText: string, shellPid: number): boolean {
  interface Rec { pid: number; ppid: number; stat: string; comm: string; }
  const recs: Rec[] = [];
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const stat = parts[2] || "";
    const commRaw = parts.slice(3).join(" ");
    const comm = (commRaw.split("/").pop() || commRaw).toLowerCase();
    recs.push({ pid, ppid, stat, comm });
  }
  if (recs.length === 0) return false;

  // Build descendant set rooted at shellPid (inclusive).
  const childrenOf = new Map<number, number[]>();
  for (const r of recs) {
    const arr = childrenOf.get(r.ppid) || [];
    arr.push(r.pid);
    childrenOf.set(r.ppid, arr);
  }
  const members = new Set<number>([shellPid]);
  const stack = [shellPid];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of childrenOf.get(cur) || []) {
      if (!members.has(c)) { members.add(c); stack.push(c); }
    }
  }

  const haveComm = recs.some(r => r.comm.length > 0);
  for (const r of recs) {
    if (!members.has(r.pid)) continue;
    const isForeground = r.stat.includes("+");
    if (!isForeground) continue;
    if (haveComm) {
      if (SHELL_COMMS.has(r.comm)) return false; // foreground shell at prompt ⇒ idle
    } else {
      // No comm available: a foreground descendant other than the root means a
      // command is running.
      if (r.pid !== shellPid) return true;
    }
  }
  // With comm info: no foreground shell found ⇒ busy. Without comm: no non-root
  // foreground process found ⇒ idle.
  return haveComm ? true : false;
}

/**
 * Windows: parse `Get-CimInstance Win32_Process | ConvertTo-Csv` / `wmic process`
 * CSV output (or legacy "Key : Value" CIM blocks) into a ParentProcessId->ProcessId
 * tree and return true if shellPid has any descendant. Validated WITHOUT a Windows
 * runtime against synthetic CIM/wmic fixtures (design §2.1/§7.2).
 *
 * Accepts two shapes:
 *  - CSV (PREFERRED, deterministic): a header line containing both ProcessId and
 *    ParentProcessId columns, then one row per process. This is what both
 *    `ConvertTo-Csv -NoTypeInformation` and `wmic ... /format:csv` emit, so the
 *    probe always hits this branch in practice.
 *  - Legacy CIM Format-List "Key : Value" blocks separated by blank lines. The
 *    blank line is the AUTHORITATIVE record boundary (P2 hardening): the previous
 *    record is flushed at each blank line, so a record missing one of the two keys
 *    no longer mis-pairs with the next record's fields.
 */
export function parseProcessList(rawText: string, shellPid: number): boolean {
  const childrenOf = new Map<number, number[]>();
  const rawLines = rawText.split(/\r?\n/);
  const lines = rawLines.map(l => l.trim()).filter(l => l.length > 0);

  // PREFERRED: CSV header containing both ProcessId and ParentProcessId columns.
  const header = lines.find(l => /ProcessId/i.test(l) && /ParentProcessId/i.test(l) && l.includes(","));
  if (header) {
    const cols = header.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    const pidIdx = cols.findIndex(c => /^ProcessId$/i.test(c));
    const ppidIdx = cols.findIndex(c => /^ParentProcessId$/i.test(c));
    for (const line of lines) {
      if (line === header) continue;
      const cells = line.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
      if (cells.length <= Math.max(pidIdx, ppidIdx)) continue;
      const pid = parseInt(cells[pidIdx], 10);
      const ppid = parseInt(cells[ppidIdx], 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      const arr = childrenOf.get(ppid) || [];
      arr.push(pid);
      childrenOf.set(ppid, arr);
    }
    return hasDescendant(childrenOf, shellPid);
  }

  // Legacy CIM "Key : Value" Format-List blocks. Use the BLANK LINE as the
  // record boundary (deterministic) rather than guessing from a repeated key,
  // which mis-pairs when a record lacks one of the two fields.
  let curPid: number | null = null;
  let curPpid: number | null = null;
  const flush = () => {
    if (curPid !== null && curPpid !== null) {
      const arr = childrenOf.get(curPpid) || [];
      arr.push(curPid);
      childrenOf.set(curPpid, arr);
    }
    curPid = null;
    curPpid = null;
  };
  for (const raw of rawLines) {
    const line = raw.trim();
    if (line.length === 0) {
      // Blank line = record boundary.
      flush();
      continue;
    }
    const ppidMatch = line.match(/ParentProcessId\s*[=:]\s*(\d+)/i);
    const pidMatch = line.match(/(?<!Parent)ProcessId\s*[=:]\s*(\d+)/i);
    if (ppidMatch) curPpid = parseInt(ppidMatch[1], 10);
    if (pidMatch) curPid = parseInt(pidMatch[1], 10);
  }
  flush();
  return hasDescendant(childrenOf, shellPid);
}

function hasDescendant(childrenOf: Map<number, number[]>, root: number): boolean {
  const stack = [...(childrenOf.get(root) || [])];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (pid === root || seen.has(pid)) continue;
    seen.add(pid);
    return true; // any descendant at all means a child command is running
  }
  return false;
}

// ---------------------------------------------------------------------------
// Platform probes
// ---------------------------------------------------------------------------

export class LinuxProcProbe implements StatusProbe {
  probe(shellPid: number): ProbeResult {
    try {
      const fs = require("fs") as typeof import("fs");
      const pids: string[] = fs.readdirSync("/proc").filter((d: string) => /^\d+$/.test(d));
      const entries: string[] = [];
      for (const pid of pids) {
        try {
          entries.push(fs.readFileSync(`/proc/${pid}/stat`, "utf-8"));
        } catch {
          // process may have exited mid-scan; ignore
        }
      }
      return { hasRunningChild: parseProcTree(entries, shellPid), confidence: "authoritative" };
    } catch {
      return { hasRunningChild: false, confidence: "fallback" };
    }
  }
}

export class MacPsProbe implements StatusProbe {
  probe(shellPid: number): ProbeResult {
    try {
      const raw = execSync("ps -o pid=,ppid=,stat=,comm= -ax", { encoding: "utf-8", timeout: 2000 });
      return { hasRunningChild: parsePsTree(raw, shellPid), confidence: "authoritative" };
    } catch {
      return { hasRunningChild: false, confidence: "fallback" };
    }
  }
}

export class WindowsProbe implements StatusProbe {
  probe(shellPid: number): ProbeResult {
    // P1: prefer PowerShell Get-CimInstance — `wmic` is deprecated and ABSENT by
    // default on Windows 11 24H2+ / Server 2025, where the old wmic call throws
    // and silently downgrades to fallback. ConvertTo-Csv yields the deterministic
    // CSV shape the parseProcessList CSV branch already handles. wmic CSV stays as
    // a SECONDARY fallback for older hosts where PowerShell is unavailable.
    try {
      const psCmd =
        "Get-CimInstance Win32_Process | " +
        "Select-Object Name,ProcessId,ParentProcessId | " +
        "ConvertTo-Csv -NoTypeInformation";
      const raw = execSync(
        `powershell -NoProfile -NonInteractive -Command "${psCmd}"`,
        { encoding: "utf-8", timeout: 4000 }
      );
      return { hasRunningChild: parseProcessList(raw, shellPid), confidence: "authoritative" };
    } catch {
      // PowerShell unavailable/blocked — fall back to legacy wmic CSV.
    }
    try {
      const raw = execSync(
        "wmic process get Name,ParentProcessId,ProcessId /format:csv",
        { encoding: "utf-8", timeout: 3000 }
      );
      return { hasRunningChild: parseProcessList(raw, shellPid), confidence: "authoritative" };
    } catch {
      return { hasRunningChild: false, confidence: "fallback" };
    }
  }
}

/** A probe that always reports "unknown / fallback" — used when no native probe applies. */
export class FallbackProbe implements StatusProbe {
  probe(_shellPid: number): ProbeResult {
    return { hasRunningChild: false, confidence: "fallback" };
  }
}

/** Select the platform probe by process.platform (overridable for tests). */
export function selectProbe(platform: NodeJS.Platform = process.platform): StatusProbe {
  if (platform === "win32") return new WindowsProbe();
  if (platform === "darwin") return new MacPsProbe();
  if (platform === "linux") return new LinuxProcProbe();
  return new FallbackProbe();
}
