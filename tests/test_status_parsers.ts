import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseProcTree,
  parsePsTree,
  parseProcessList,
} from "../src/statusProbe";

/**
 * Pure-parser unit tests for the platform process-list parsers (design §7.2/§7.3).
 * Validated entirely against captured/synthetic text fixtures — no real
 * processes, and Windows is validated WITHOUT a Windows runtime.
 *
 * IDLE = an interactive shell sits at its prompt as the terminal's foreground job
 *        (Linux: pid==pgrp==tpgid; mac: shell has the `+` foreground flag).
 * BUSY  = a command holds the foreground group instead.
 */

describe("statusProbe pure parsers", () => {
  describe("Linux parseProcTree (/proc/[pid]/stat)", () => {
    // /proc stat layout: pid (comm) state ppid pgrp session tty_nr tpgid ...
    // The PTY root shell is pid 100; node-pty's `sh -c` wrapper leaves a nested
    // leaf shell 101 — a naive "any descendant" rule would read this as busy.

    const idleTree = [
      // root sh 100: foreground job is the leaf shell 101 (tpgid=101)
      "100 (sh) S 50 100 100 34816 101 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
      // leaf sh 101 at its prompt: pid==pgrp==tpgid==101
      "101 (sh) S 100 101 100 34816 101 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
      // an unrelated process in another tree
      "999 (init) S 1 999 999 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
    ];

    const busyTree = [
      "100 (sh) S 50 100 100 34816 202 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
      // leaf shell's foreground job is now the command group 202 (tpgid=202)
      "101 (sh) S 100 101 100 34816 202 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
      // the running command (e.g. a long build) is the foreground group leader
      "202 (node) R 101 202 100 34816 202 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
    ];

    it("reports idle when the leaf shell is at its prompt (foreground)", () => {
      assert.strictEqual(parseProcTree(idleTree, 100), false);
    });

    it("reports BUSY (BUG-006 case) when a long-running command holds the foreground", () => {
      // The exact false-idle case: a build is silent but the child holds the tty.
      assert.strictEqual(parseProcTree(busyTree, 100), true);
    });

    it("is busy-biased: no resting shell at all ⇒ busy", () => {
      const onlyCommand = [
        "100 (sh) S 50 100 100 34816 300 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
        "300 (make) R 100 300 100 34816 300 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
      ];
      assert.strictEqual(parseProcTree(onlyCommand, 100), true);
    });

    it("agent-at-rest tree (claude/node root, no shell) reads BUSY — justifies the P0-1 gate", () => {
      // An interactive_cli pane is spawned `sh -c "<agent>"`, which exec-replaces
      // itself, so the PTY root IS the agent (comm claude/node/python — none in
      // SHELL_COMMS). An agent waiting at its own prompt is process-identical to an
      // agent mid-turn: one blocked process, no resting foreground child-shell.
      // The busy-biased probe therefore reports BUSY for an agent-at-rest, which is
      // exactly why runProbeTick must GATE interactive_cli off the authoritative
      // probe (P0-1) and let output quiescence drive idle instead.
      const agentRoot = [
        // pid==pgrp==tpgid==100 but comm "claude" is NOT a shell ⇒ no resting shell.
        "100 (claude) S 50 100 100 34816 100 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
      ];
      assert.strictEqual(parseProcTree(agentRoot, 100), true, "agent-at-rest reads busy (no resting shell)");
      const nodeRoot = [
        "100 (node) S 50 100 100 34816 100 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
      ];
      assert.strictEqual(parseProcTree(nodeRoot, 100), true, "node agent root also reads busy");
    });

    it("handles comm names containing spaces and parentheses", () => {
      const tricky = [
        "100 (sh) S 50 100 100 34816 100 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
      ];
      // pid==pgrp==tpgid==100 and comm is a shell ⇒ idle
      assert.strictEqual(parseProcTree(tricky, 100), false);
      const trickyComm = [
        "100 (sh) S 50 100 100 34816 401 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
        "401 (npm run (build)) R 100 401 100 34816 401 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0",
      ];
      assert.strictEqual(parseProcTree(trickyComm, 100), true);
    });
  });

  describe("macOS parsePsTree (ps -o pid=,ppid=,stat=,comm=)", () => {
    // The `+` suffix in stat marks the controlling terminal's foreground group.
    const idle = [
      "  100   50 Ss   /bin/sh",
      "  101  100 S+   /bin/sh", // foreground shell at prompt
    ].join("\n");

    const busy = [
      "  100   50 Ss   /bin/sh",
      "  101  100 S    /bin/sh", // shell no longer foreground
      "  202  101 R+   node",    // command holds the foreground group
    ].join("\n");

    it("reports idle when a foreground shell is present", () => {
      assert.strictEqual(parsePsTree(idle, 100), false);
    });

    it("reports busy when a command holds the foreground group", () => {
      assert.strictEqual(parsePsTree(busy, 100), true);
    });

    it("is busy-biased when no foreground shell exists", () => {
      const onlyCmd = ["  100   50 Ss   /bin/sh", "  303  100 R+   make"].join("\n");
      assert.strictEqual(parsePsTree(onlyCmd, 100), true);
    });
  });

  describe("Windows parseProcessList (CIM / wmic, no Windows runtime)", () => {
    // Synthetic Get-CimInstance "Key : Value" record blocks. shell root = 100.
    const cimIdle = [
      "ProcessId       : 100",
      "ParentProcessId : 50",
      "",
      "ProcessId       : 999",
      "ParentProcessId : 4", // unrelated process, not a descendant of 100
    ].join("\n");

    const cimBusy = [
      "ProcessId       : 100",
      "ParentProcessId : 50",
      "",
      "ProcessId       : 200", // npm run build, child of the shell root
      "ParentProcessId : 100",
    ].join("\n");

    it("reports idle when only the shell root is alive (CIM)", () => {
      assert.strictEqual(parseProcessList(cimIdle, 100), false);
    });

    it("reports busy when a descendant command is alive (CIM)", () => {
      assert.strictEqual(parseProcessList(cimBusy, 100), true);
    });

    it("parses wmic CSV output", () => {
      const csvIdle = [
        "Node,Name,ParentProcessId,ProcessId",
        "HOST,cmd.exe,50,100",
        "HOST,explorer.exe,4,999",
      ].join("\n");
      const csvBusy = [
        "Node,Name,ParentProcessId,ProcessId",
        "HOST,cmd.exe,50,100",
        "HOST,node.exe,100,200",
      ].join("\n");
      assert.strictEqual(parseProcessList(csvIdle, 100), false);
      assert.strictEqual(parseProcessList(csvBusy, 100), true);
    });

    it("CIM blank-line record boundary does not mis-pair a record missing a key (P2 hardening)", () => {
      // Review repro: a ProcessId-only record followed by a ParentProcessId-only
      // record must NOT pair across the blank-line boundary into a phantom child.
      // shell root = 100; 200 is a sibling whose own ParentProcessId is absent, so
      // it must not be attributed as a descendant of 100.
      const missingKey = [
        "ProcessId       : 100",
        "",
        "ParentProcessId : 100",
        "ProcessId       : 200",
      ].join("\n");
      // 200's record DOES carry ParentProcessId:100 in the same block, so this is a
      // genuine descendant ⇒ busy; the boundary fix ensures the first (root-only)
      // record is flushed and does not steal 200's ParentProcessId.
      assert.strictEqual(parseProcessList(missingKey, 100), true);
      // A truly orphaned ParentProcessId-only record (no ProcessId) must be dropped.
      const orphan = [
        "ProcessId       : 100",
        "",
        "ParentProcessId : 100",
      ].join("\n");
      assert.strictEqual(parseProcessList(orphan, 100), false, "orphan ParentProcessId-only record is not a child");
    });

    it("agent-at-rest under cmd.exe reads BUSY (any-descendant rule) — justifies P0-1 on Windows", () => {
      // A live agent CLI is a descendant of the shell root at all times, so the
      // Windows any-descendant probe reads a resting agent as busy forever — the
      // same defect the P0-1 gate fixes on Windows.
      const csvAgent = [
        "Node,Name,ParentProcessId,ProcessId",
        "HOST,cmd.exe,50,100",
        "HOST,claude.exe,100,200",
      ].join("\n");
      assert.strictEqual(parseProcessList(csvAgent, 100), true);
    });

    it("walks a multi-level descendant chain", () => {
      const cimChain = [
        "ProcessId       : 100",
        "ParentProcessId : 50",
        "",
        "ProcessId       : 200",
        "ParentProcessId : 100",
        "",
        "ProcessId       : 300",
        "ParentProcessId : 200",
      ].join("\n");
      assert.strictEqual(parseProcessList(cimChain, 100), true);
    });
  });
});
