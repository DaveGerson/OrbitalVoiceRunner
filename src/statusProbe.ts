import { execSync } from "child_process";
import { SHELL_COMMS } from "./statusConstants";

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

/**
 * Set of `root` plus all its transitive descendants, given a parent→children map.
 * The single shared tree-walk used by every platform parser (Linux /proc, macOS
 * ps, and the Windows process list) so the descendant logic cannot drift.
 */
function buildDescendantSet(childrenOf: Map<number, number[]>, root: number): Set<number> {
  const members = new Set<number>([root]);
  const stack = [root];
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

/** Build a parent→children adjacency map from {pid, ppid} records. */
function childrenMap(recs: { pid: number; ppid: number }[]): Map<number, number[]> {
  const childrenOf = new Map<number, number[]>();
  for (const r of recs) {
    const arr = childrenOf.get(r.ppid) || [];
    arr.push(r.pid);
    childrenOf.set(r.ppid, arr);
  }
  return childrenOf;
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
  const members = buildDescendantSet(childrenMap(recs), shellPid);
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
  const members = buildDescendantSet(childrenMap(recs), shellPid);

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

interface WinProcRec { pid: number; ppid: number; name: string; }

/**
 * Split one CSV line into fields, honoring RFC-4180 double-quoted fields so a
 * value that itself contains a comma (e.g. a process Name `"weird,name.exe"`)
 * does not shift the column count and drop a row (C3). A doubled `""` inside a
 * quoted field is an escaped quote.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map(f => f.trim());
}

/**
 * Windows: parse `Get-CimInstance Win32_Process | ConvertTo-Csv` / `wmic process`
 * CSV output (or legacy "Key : Value" CIM blocks) into a process tree and decide
 * busy/idle by the SAME philosophy as Linux/macOS: a pane is IDLE iff the only
 * live descendants under the PTY root are known shells (SHELL_COMMS), and BUSY iff
 * any non-shell command process is alive in the tree.
 *
 * This fixes the "busy forever" defect (C1): a Custom shell pane is spawned
 * `cmd.exe /c cmd.exe`, so the inner interactive `cmd.exe` is a PERMANENT
 * descendant of the PTY root. The old "any descendant ⇒ busy" rule therefore read
 * such a resting pane as Running forever. By treating shell descendants as inert,
 * a resting `cmd.exe → cmd.exe` reads IDLE while `cmd.exe → node.exe` reads BUSY.
 *
 * Validated WITHOUT a Windows runtime against synthetic CIM/wmic fixtures
 * (design §2.1/§7.2). Busy-biased (I2): on parse failure / no usable records we
 * return false (fallback) at the probe layer, but a tree we cannot resolve a Name
 * for is treated as a non-shell process ⇒ busy.
 *
 * Accepts two shapes:
 *  - CSV (PREFERRED, deterministic): a header line containing ProcessId and
 *    ParentProcessId (and, for the shell check, Name) columns, then one row per
 *    process. This is what both `ConvertTo-Csv -NoTypeInformation` and
 *    `wmic ... /format:csv` emit, so the probe always hits this branch in practice.
 *  - Legacy CIM Format-List "Key : Value" blocks separated by blank lines. The
 *    blank line is the AUTHORITATIVE record boundary (P2 hardening): the previous
 *    record is flushed at each blank line, so a record missing one of the two keys
 *    no longer mis-pairs with the next record's fields. (CIM blocks carry no Name
 *    in the committed fixtures, so a descendant with unknown Name reads busy.)
 */
export function parseProcessList(rawText: string, shellPid: number): boolean {
  const recs: WinProcRec[] = [];
  const rawLines = rawText.split(/\r?\n/);
  const lines = rawLines.map(l => l.trim()).filter(l => l.length > 0);

  // PREFERRED: CSV header containing both ProcessId and ParentProcessId columns.
  const header = lines.find(l => /ProcessId/i.test(l) && /ParentProcessId/i.test(l) && l.includes(","));
  if (header) {
    const cols = splitCsvLine(header).map(c => c.replace(/^"|"$/g, ""));
    const pidIdx = cols.findIndex(c => /^ProcessId$/i.test(c));
    const ppidIdx = cols.findIndex(c => /^ParentProcessId$/i.test(c));
    const nameIdx = cols.findIndex(c => /^Name$/i.test(c));
    for (const line of lines) {
      if (line === header) continue;
      const cells = splitCsvLine(line);
      if (cells.length <= Math.max(pidIdx, ppidIdx)) continue;
      const pid = parseInt(cells[pidIdx], 10);
      const ppid = parseInt(cells[ppidIdx], 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      const name = nameIdx >= 0 && nameIdx < cells.length ? cells[nameIdx] : "";
      recs.push({ pid, ppid, name });
    }
    return treeHasNonShellDescendant(recs, shellPid);
  }

  // Legacy CIM "Key : Value" Format-List blocks. Use the BLANK LINE as the
  // record boundary (deterministic) rather than guessing from a repeated key,
  // which mis-pairs when a record lacks one of the two fields.
  let curPid: number | null = null;
  let curPpid: number | null = null;
  let curName = "";
  const flush = () => {
    if (curPid !== null && curPpid !== null) {
      recs.push({ pid: curPid, ppid: curPpid, name: curName });
    }
    curPid = null;
    curPpid = null;
    curName = "";
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
    const nameMatch = line.match(/^Name\s*[=:]\s*(.+)$/i);
    if (ppidMatch) curPpid = parseInt(ppidMatch[1], 10);
    if (pidMatch) curPid = parseInt(pidMatch[1], 10);
    if (nameMatch) curName = nameMatch[1].trim();
  }
  flush();
  return treeHasNonShellDescendant(recs, shellPid);
}

/**
 * Shell-aware Windows busy rule (mirrors the Linux/macOS resting-shell philosophy):
 * BUSY iff the PTY root's descendant tree contains a process whose Name is NOT a
 * known shell. A descendant with an empty/unknown Name is treated as non-shell
 * (busy-biased, I2) so we never falsely report idle when the Name column is absent.
 */
function treeHasNonShellDescendant(recs: WinProcRec[], root: number): boolean {
  const members = buildDescendantSet(childrenMap(recs), root);
  for (const r of recs) {
    if (r.pid === root || !members.has(r.pid)) continue; // skip the root itself
    if (!SHELL_COMMS.has(r.name.toLowerCase())) {
      return true; // a non-shell descendant command is running ⇒ busy
    }
  }
  return false; // only shell descendants (or none) ⇒ idle
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
      // Name is REQUIRED for the shell-aware busy rule (resting cmd.exe ⇒ idle).
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
