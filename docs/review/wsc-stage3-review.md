# WS-C Stage 3 — Independent Code Review (Busy/Idle Status Detection)

**Reviewer:** Member 3 (adversarial code review). **Mode:** read-only; no source edits.
**Build:** `npx tsc --noEmit` → clean (EXIT=0). `tsx --test tests/test_status_*.ts` → 17/17 pass.
`tsx --test tests/test_server.ts` → 8/8 pass, EXIT=0.

---

## Overall verdict: CHANGES REQUIRED — NOT commit-ready.

The PTY-transport rewrite, the pure parsers (for *shell* panes), the state-machine extraction,
the timer-leak hygiene, and the server-side wiring are solid and well-tested. **But the design's
own PRIMARY use case — `interactive_cli` agent panes — is functionally broken: they are reported
permanently "Running" and never fire `onIdle`.** A second, independent defect drops completion
notifications in fallback (legacy-transport) mode. Both must be fixed before commit.

---

## PRIORITY-1 HYPOTHESIS: **CONFIRMED.**

**Interactive_cli (agent) panes are reported permanently "Running" and never fire `onIdle`.**

### Code evidence
- `runProbeTick` (`src/terminal.ts:344-355`) runs `this.statusProbe.probe(this.shellPid)` for **every**
  pane regardless of `runtimeType`. The result feeds `applyStatusEvent({kind:"probe",...})`.
- The Linux probe's pure core `parseProcTree` (`src/statusProbe.ts:113-126`) declares **idle only if it
  finds a process in the tree that is BOTH (a) a known shell comm (`SHELL_COMMS`, `:36-39`) AND (b) the
  resting foreground job (`pid==pgrp==tpgid`, `:121`)**. Otherwise it returns `true` (busy) — busy-biased.
- An agent pane is spawned as `/bin/sh -c "<agent cmd>"` (`src/ptyTransport.ts:201-203`). `sh -c` with a
  single command **exec-replaces** itself, so the PTY root *is the agent* (comm `claude`/`node`/`python`,
  none of which are in `SHELL_COMMS`). Even if a wrapper shell survived, the agent child is still not a
  shell comm. Therefore **no "resting foreground shell" ever exists** for an agent at its own prompt.
- Result: `parseProcTree` returns `hasRunningChild=true`, `confidence:"authoritative"` forever.
- In `decideStatus` (`src/statusMachine.ts:107-114`): authoritative + `hasRunningChild` ⇒ `setRunning()`
  on every 500ms tick; the idle path (`armIdleOnce`) is never reached → status never becomes `Idle` →
  `fireOnIdle` never true.

### Reproduced (no real agent needed)
```
parseProcTree(["100 (claude) S 50 100 100 34816 100 ... "], 100) === true   // expected false (idle)
parseProcTree(["100 (node)   S 50 100 100 34816 100 ... "], 100) === true   // expected false
parseProcessList("Node,Name,ParentProcessId,ProcessId\nH,cmd.exe,50,100\nH,claude.exe,100,200", 100)
    === true   // Windows: any-descendant rule ⇒ agent-at-rest reads busy too
```

### Windows: same defect, confirmed.
`parseProcessList` (`:204-256` / `hasDescendant :258-268`) is "any descendant ⇒ busy". A real agent CLI
under `cmd.exe` is a live descendant of the shell root at all times, so a resting agent reads busy forever.

### Behavioral impact
Breaks Journey 6 (status), proactive completion (`onIdle` → watch rules / plans / auto-summary at
`server.ts:226-252`), and the attention digest for the PRIMARY pane type. Janus would tell an eyes-off
operator every agent is "still running" forever and never announce a finished turn.

### Correct fix (minimal)
Agent panes must NOT let the OS-process probe drive Idle, because an agent at its prompt is
process-indistinguishable from an agent mid-turn (both are one blocked process with no foreground child-
shell). Drive their idle from **output quiescence** instead. Concretely, gate in `runProbeTick`:

```ts
private runProbeTick() {
  if (this.status === "Exited" || this.shellPid === undefined) return;
  // interactive_cli panes have no resting-shell signal; never trust the authoritative
  // probe to declare idle for them — downgrade to fallback so quiescence drives idle.
  if (this.runtimeType === "interactive_cli") {
    this.applyStatusEvent({ kind: "probe", probe: { hasRunningChild: false, confidence: "fallback" } });
    return;
  }
  ... existing authoritative probe ...
}
```
This routes agent panes into the fallback/quiescence path (`decideStatus` output→arm-timer→idleTimer).
**It is necessary but NOT sufficient** — see P0-2: the fallback path currently swallows `onIdle`. Both
fixes are required together for agents to ever report "done."

---

## Severity-ranked findings

### P0-1 — interactive_cli permanently "Running", never fires onIdle (the hypothesis)
- **Where:** `src/terminal.ts:344-355` (`runProbeTick`) + `src/statusProbe.ts:113-126` / `:204-268`.
- **Why wrong:** authoritative probe is applied to agent panes whose process tree has no resting
  foreground shell; the busy-biased rule then reports busy forever.
- **Fix:** gate `runProbeTick` so `interactive_cli` panes never receive an `authoritative` busy probe
  (downgrade to `confidence:"fallback"` as above), letting quiescence drive idle. Same gate covers
  Windows. Add a replay/unit test for an agent-at-rest tree asserting eventual Idle + one onIdle.

### P0-2 — Fallback mode (and post-P0-1 agent panes) never fires onIdle on output-driven completion
- **Where:** `src/terminal.ts:271-280` (`sawWorkSinceIdle` gate) + `src/statusMachine.ts:121-159`.
- **Why wrong:** `sawWorkSinceIdle` is set ONLY by `kind:"input"` or by an **authoritative**
  `hasRunningChild` probe (`:272-279`). In fallback mode there is no authoritative busy probe, and panes
  that do work via **output without a preceding `writeInput`** (legacy `script`/`cmd.exe` transport when
  node-pty fails to load — exactly I5's path; and every `interactive_cli` pane after the P0-1 fix, whose
  turns are not all driven through `writeInput`) reach the `idleTimer` with `sawWorkSinceIdle=false`.
  `setIdle()` returns `fireOnIdle:true` but the terminal's gate (`:294-300`) suppresses the call.
- **Reproduced:** output→idleTimer in fallback shell mode yields status `Idle` but `onIdle` NOT fired.
  This is **worse than today** (today any output armed the timer and the timer fired onIdle), violating I5.
- **Fix:** count genuine output as work in fallback mode. Either set `sawWorkSinceIdle=true` on
  `kind:"output"` when `this.lastConfidence==="fallback"`, or (cleaner) set it whenever an `output` event
  transitions the pane to `Running` from a non-Running state. Add a fallback-mode replay test asserting
  exactly one onIdle on output-then-quiescence.

### P1 — Windows probe shells out to `wmic`, which is removed on modern Windows
- **Where:** `src/statusProbe.ts:309-312` (`WindowsProbe.probe`).
- **Why wrong:** the design specified `Get-CimInstance Win32_Process`; the impl hardcodes
  `wmic process get ... /format:csv`. `wmic` is deprecated and **absent by default on Windows 11 24H2+ /
  Server 2025**. There it throws ⇒ `confidence:"fallback"` ⇒ (with P0-2 unfixed) no completion ever fires
  on the #1 target platform. Even with P0-2 fixed, Windows silently loses the authoritative probe.
- **Fix:** call PowerShell `Get-CimInstance Win32_Process | ... ConvertTo-Csv` (or `tasklist`), with
  `wmic` as a secondary fallback. The `parseProcessList` CSV branch already handles CSV.

### P2 — `stop()` has a temporal-dead-zone reference to `killTimeout`
- **Where:** `src/terminal.ts:471-498`. `done()` (`:474`) calls `clearTimeout(killTimeout)`, but
  `const killTimeout` is declared at `:490`, AFTER `transport.onExit(done)` (`:480`) and the
  `catch{ done(); return; }` (`:486`). If `transport.kill("SIGTERM")` throws (already-dead pid) or the
  transport fires `onExit` synchronously, `done()` runs while `killTimeout` is in the TDZ →
  `ReferenceError`, rejecting the `stop()` promise.
- **Fix:** declare `let killTimeout: NodeJS.Timeout | undefined;` before `done`, and guard
  `if (killTimeout) clearTimeout(killTimeout)`.

### P2 — `decideStatus` `output` event in authoritative mode cancels a pending idle timer
- **Where:** `src/statusMachine.ts:121-126`. In authoritative mode `output ⇒ setRunning()` which returns
  `clearIdleTimer:true`. A resting shell/agent that emits any async byte (clock, notification) flips
  Running and cancels the armed idle timer. It self-heals on the next no-child probe (~500ms + debounce),
  so impact is a small idle-detection delay, but it can also briefly mis-report Running on `list_panes`.
- **Fix:** in authoritative mode, on `output` keep `Running` but do NOT clear the idle timer (let the
  probe own idle); or only `setRunning` when currently `Idle`. Low priority.

### P2 — Windows CIM "Key=Value" parser is fragile / fixture not representative
- **Where:** `src/statusProbe.ts:228-256`. The blank-line-stripped record-boundary heuristic mis-pairs
  records when a record lacks one of the two keys (a `ProcessId`-only record returns a missed child).
  Reproduced: `parseProcessList("ProcessId:100\n\nParentProcessId:100\nProcessId:200",100)===false`
  (expected true). Real default `Get-CimInstance` output is tabular, not Format-List, and is never
  exercised by a representative fixture (the test uses synthetic two-line blocks). The CSV path (what the
  probe actually calls today) is fine; this matters once P1's PowerShell path lands.
- **Fix:** parse the CSV/`ConvertTo-Csv` shape only (deterministic columns); drop or fully harden the
  ad-hoc CIM Key=Value parser, and add a fixture captured from real CIM output.

### P2 — Uncommitted scratch artifacts would be committed
- **Where:** working tree: `_ptyprobe_test.cjs`, `_ptyprobe_test2.cjs`, `_ptyprobe_test3.cjs`, `dist-tmp/`
  (untracked, not gitignored) and a modified `.janus_ledger_journeys_test.json` (test side-effect).
- **Fix:** delete the scratch files / `dist-tmp`, restore the ledger fixture, or add to `.gitignore`.

### P2 — `last_command` shows the raw command incl. for agent panes; not redacted in digest
- **Where:** `server.ts:1396` (`timing += ... last command was '${term.lastCommand}'`) and
  `src/terminal.ts:715`. `lastCommand` is the verbatim `writeInput` string; if a command contains a
  secret/token it is spoken/surfaced unredacted. WS-B redaction (`redactSecrets`) is wired in
  `getPaneSummary` (`src/terminal.ts:735`) but not on `last_command`.
- **Fix:** run `redactSecrets(term.lastCommand)` before placing it in the digest / `PaneMeta`.

---

## What's correct / solid

- **PTY transport seam** (`src/ptyTransport.ts`): clean `PtyTransport` interface, node-pty preferred
  with verbatim legacy `script`/`cmd.exe` fallback behind `try{require}catch`, `nodePtyAvailable()`
  surfacing confidence. node-pty installed and real bash-in-PTY verified (test_server green).
- **Linux/macOS pure parsers for SHELL panes** are correct. `/proc/[pid]/stat` field indexing verified
  against real `/proc/self/stat`: after `)` → state f[0], ppid f[1], pgrp f[2], session f[3], tty f[4],
  **tpgid f[5]** — matches `parseProcRecords` (`:62-66`). The `(comm)` extraction via
  `indexOf("(")`/`lastIndexOf(")")` correctly handles spaces/parens (`npm run (build)` test passes). The
  resting-shell `pid==pgrp==tpgid` rule and busy-bias are sound for shell panes and correctly defeat the
  BUG-006 silent-build false-idle.
- **State machine** `decideStatus` is genuinely pure (no side effects/timers), and the replay harness
  faithfully mirrors `applyStatusEvent` (same confidence/idleTimerArmed/sawWorkSinceIdle bookkeeping).
- **Idle-timer re-arm fix is correct:** `armIdleOnce` arms only when `!idleTimerArmed`, and the timer
  callback nulls `this.idleTimer` before re-entering, so a stream of "no child" probes lets the debounce
  actually fire (test "repeated 'no child' probes ... actually fires" passes).
- **Timer-leak hygiene:** `probeTimer` (`setInterval`) and the `stop()` `killTimeout` are both `.unref()`'d;
  `stop()` and `onExit` clear `probeTimer`+`idleTimer`. This is why the suite exits cleanly (EXIT=0) —
  confirmed: even an un-stopped pane cannot hold the event loop open. The real server path clears timers on
  pane exit and stop, so no leak there either.
- **Preserved invariants hold:** `redactSecrets` still wired in `getPaneSummary` (`:735`); atomic ledger
  untouched; `alive` via real `onExit`; ANSI strip unchanged; exit→`Exited` semantics preserved and made
  terminal in `decideStatus` (Tier 0). **No existing test assertions were weakened** — `tests/test_server.ts`
  and `tests/test_terminal_manager.ts` are UNMODIFIED (the design's proposed writeInput-test edit was not
  needed; they pass as-is under node-pty). Note this also means the P0 interactive_cli path has ZERO test
  coverage — every test pane is `runtime_type:"shell"`, which is why the suite is green despite P0-1.
- **server.ts changes are sound:** `detectAndTriggerTransitions` now defers idle/prompt to the machine
  using the shared narrowed `SHELL_PROMPT`, gated to shell panes (I4) — no broken refs. systemInstruction
  correctly drops the frozen status snapshot and instructs live `list_panes`. Digest enrichment references
  (`manager.terminals[item.terminalId]`, `term.lastStatusChangeAt/.lastCommand/.status`) are all valid.

---

## Minimal changes required before commit-ready (Expert 2)

1. **P0-1:** In `runProbeTick` (`src/terminal.ts`), gate `interactive_cli` panes off the authoritative
   probe — emit `{hasRunningChild:false, confidence:"fallback"}` for them so quiescence drives idle.
2. **P0-2:** Make output count as work in fallback mode so `onIdle` fires (set `sawWorkSinceIdle` on an
   `output`-driven Running transition when confidence is fallback). Without this, fix #1 leaves agents
   stuck never-idle and the legacy transport silently drops completions (worse than today, breaks I5).
3. **Tests:** add (a) a parser/probe test for an agent-at-rest tree, and (b) a fallback-mode replay test
   asserting exactly one `onIdle` on output→quiescence. These encode the two P0 fixes and close the
   interactive_cli coverage gap.
4. **P1:** Replace hardcoded `wmic` with `Get-CimInstance ... | ConvertTo-Csv` (wmic as secondary).
5. **P2 quick wins:** fix the `killTimeout` TDZ in `stop()`; redact `last_command` in the digest; remove
   scratch artifacts (`_ptyprobe_test*.cjs`, `dist-tmp/`) and restore `.janus_ledger_journeys_test.json`.

Re-run `npx tsc --noEmit` and the `tests/test_status_*.ts` + `tests/test_server.ts` after the changes.
