# WS-C Status Detection — Accuracy / Correctness Review

**Reviewer lens:** correctness/accuracy ONLY. **Mode:** read-only (no source edits).
**Commit:** `d641547`. **Build:** `npx tsc --noEmit` → clean (EXIT=0).
`tsx --test tests/test_status_*.ts` → 22/22 pass (EXIT=0).
**Scope:** finds NEW accuracy issues beyond the two P0s already fixed in this commit
(interactive_cli permanent-busy; fallback onIdle suppression). Those are confirmed fixed and
are NOT re-litigated here.

---

## Overall verdict: CORRECT FOR LINUX/macOS; one platform-1 (Windows) correctness defect remains.

The Linux `/proc` and macOS `ps` probes are genuinely correct — I verified the Linux probe
against a **real node-pty process tree**: a resting Custom shell reads idle, a `sleep 3` child
reads busy, and it returns to idle after — the BUG-006 false-idle is truly fixed for shell panes.
The state machine's invariants (busy-bias, debounce, exactly-one-onIdle, the `sawWorkSinceIdle`
gate) hold under the events the replay harness exercises. **But the Windows probe uses a crude
"any-descendant ⇒ busy" rule that — combined with the `cmd.exe /c …` PTY wrapper — makes every
interactive Windows *shell* pane read busy forever.** The P0-1 gate fixed this for `interactive_cli`
but NOT for Windows `shell` panes, which is the #1-priority platform. Plus several lower-severity
parser/representativeness gaps.

---

## P1 — Windows shell panes read "busy" forever (any-descendant rule + `cmd /c` wrapper)

**Where:** `src/statusProbe.ts:265-275` (`hasDescendant`) used by `parseProcessList`
(`:210-263`); combined with `src/ptyTransport.ts:197-200` (`cmd.exe /c <finalCommand>`) and the
`runProbeTick` gate at `src/terminal.ts:354-357` which only downgrades `interactive_cli`.

**Why it's wrong:** Linux/macOS use the precise *foreground-resting-shell* rule
(`pid==pgrp==tpgid`, `statusProbe.ts:121` / the `+` flag, `:179-182`) which correctly survives a
nested wrapper shell. Windows uses **`hasDescendant` = "any descendant at all ⇒ busy"**
(`:272`). But on Windows node-pty always spawns `cmd.exe /c <finalCommand>` (`ptyTransport.ts:199`),
and a Custom shell pane's `finalCommand` is the shell itself (`defaultShellCommand: "cmd.exe"`,
`terminal.ts:578`). So the PTY root is the outer `/c` cmd and the **interactive inner cmd is a
permanent live descendant at rest** → `hasDescendant` returns `true` → the pane is `Running`
forever, never debounces to Idle, never fires `onIdle`. This is the *same* defect class the
stage-3 P0-1 fixed for agents, but the `runProbeTick` gate (`terminal.ts:354`) only catches
`runtimeType === "interactive_cli"`; a Windows Custom **shell** pane (`runtimeType === "shell"`)
still receives the authoritative any-descendant probe.

**Repro (verified, no Windows runtime needed):**
```
parseProcessList(
  "Node,Name,ParentProcessId,ProcessId\r\nHOST,cmd.exe,500,100\r\nHOST,cmd.exe,100,200",
  100) === true   // outer cmd 100 at rest with inner cmd 200 ⇒ reports BUSY (should be idle)
```
(The committed test `agent-at-rest under cmd.exe reads BUSY … justifies P0-1 on Windows`,
`tests/test_status_parsers.ts:184-194`, literally demonstrates this same `true` result but only
frames it as the agent case — it is *also* the unfixed shell case.)

**Behavioral impact:** On the stated #1 platform, every interactive shell pane is reported "still
running" to the eyes-off operator forever; `onIdle` (watch rules / plans / auto-summary,
`server.ts:226-252`) and the attention digest never fire for Windows shell panes. Violates the
idle half of I1/I3 for that platform.

**Suggested fix:** Make the Windows probe foreground-aware instead of any-descendant. CIM exposes
no `tpgid`, but you can apply the same resting-shell shape as Linux: idle iff the *only* live
member of the tree below the PTY root is a single shell process (a `cmd`/`powershell`/`pwsh` whose
own only child is itself absent), i.e. count *non-shell* descendants rather than any descendant; or
detect "the deepest leaf is a known shell comm." Pull `Name` (already selected) into
`parseProcessList` and use a SHELL_COMMS check on leaves. Short term: extend the `runProbeTick`
gate so that on Windows, shell panes are also driven by quiescence (downgrade to fallback) until a
foreground-aware Windows rule exists. Add a `parseProcessList` test asserting the resting
`cmd /c cmd` tree returns `false`.

---

## P2 — Windows CSV parser splits on commas without honoring quoted fields

**Where:** `src/statusProbe.ts:223` (`line.split(",")`).

**Why it's wrong:** `ConvertTo-Csv`/`wmic /format:csv` quote any field containing a comma, but the
parser does a naive `split(",")`. A process whose **Name** contains a comma shifts all subsequent
column indices, so `ProcessId`/`ParentProcessId` are read from the wrong cells → `parseInt` → NaN
→ that row is dropped from the tree (`:227`). If the dropped row is the only running child, the
pane reads idle ⇒ false "done" (I1). The probe selects `Name` (`statusProbe.ts:322`), so the
vulnerable column is always present and is the one realistic source of embedded commas (window
titles, some installer process names).

**Repro (verified):**
```
parseProcessList(
  'Node,Name,ParentProcessId,ProcessId\r\nHOST,"weird,name.exe",100,200\r\nHOST,cmd.exe,500,100',
  100) === false   // the only child (200) is dropped ⇒ wrongly idle
```

**Suggested fix:** Parse CSV with quote awareness (a small RFC-4180 split, or drop `Name` from the
`Select-Object`/`wmic` projection entirely since only the two numeric ID columns are used). Add a
fixture with a quoted, comma-containing name.

---

## P2 — `idleTimeoutMs < probeIntervalMs` opens a false-"done" race (authoritative mode)

**Where:** `src/terminal.ts:322-328` (idle timer arm) vs `:461` (500ms `probeIntervalMs`),
honoring user `advanced.idleTimeoutMs` (`:636-640`).

**Why it's wrong:** In authoritative mode the debounce relies on the next probe tick (≤500ms)
re-observing the running child before the armed idle timer elapses (mitigation R4). That holds for
the default `idleTimeoutMs=2000`. But the value is user-configurable; if set below ~600ms, a brief
gap where the probe momentarily sees no child (e.g. a just-issued `writeInput` whose child has not
yet forked — R4's exact scenario) arms an idle timer that fires *before* the next 500ms probe
re-confirms busy. Because `writeInput` set `sawWorkSinceIdle=true`, the suppression gate does NOT
catch it → a spurious `onIdle`/false "done" fires, then the pane flaps back to Running on the next
probe.

**Repro (argument):** `idleTimeoutMs=200`. t=0 `writeInput` → setRunning, sawWork=true; t=200
probe (child not yet forked) → armIdle@400; t=400 idleTimer → setIdle, fireOnIdle, realDone=true →
**onIdle fires (false done)**; t=500 probe child=true → setRunning.

**Suggested fix:** Floor the effective idle debounce at `>= probeIntervalMs + margin` in
authoritative mode (e.g. `Math.max(idleTimeoutMs, 2*probeIntervalMs)`), or require N consecutive
"no child" probes before idling (the design's R4 "require N consecutive idle probes"), independent
of the wall-clock timer.

---

## P2 — `lastLineIsPrompt` / `SHELL_PROMPT` narrowing is effectively dead in `decideStatus`

**Where:** `src/statusMachine.ts:155-161` (idleTimer, fallback, shell branch).

**Why it's wrong (accuracy of the stated guarantee):** the design (§3 tier C) and the function's
doc claim shell panes idle on "quiescence **+ a narrowed prompt**", implying the prompt regex
gates idling. But both arms of the shell branch `return setIdle()` — with a prompt and without one
— so `lastLineIsPrompt(recentTail)` (`:156`) has no effect on the decision. The narrowing the
design sells (defeating the over-broad `:229` regex) does not actually constrain Idle here;
fallback shell panes idle on **pure quiescence**, exactly "no worse than today" but not the
stronger prompt-gated behavior the comments assert. Additionally, in production `recentTail` is
built from `getRecentOutput(5)` (`terminal.ts:292`) whose buffer has **blank lines filtered out**
(`:440`), so the design's "prompt on an otherwise-empty trailing line" can never be observed even
if the branch mattered.

**Impact:** low — behavior is correct (quiescence idle), but the code/comments overstate the
guarantee, and the only *live* consumer of `SHELL_PROMPT` (`server.ts:422`, prompt-vs-idle
attention label) runs the regex on the whole raw chunk with a non-multiline `$` anchor, so any
program output ending in `$ # % >` is labeled "prompt" rather than "idle" (verified:
`"Building project... done? $"` and `"still compiling > "` both match). This only mislabels an
already-Idle pane's attention type, so impact is cosmetic.

**Suggested fix:** Either make the prompt actually gate idling for fallback shell panes, or delete
the dead `lastLineIsPrompt` branch and update the doc/design to state plainly that fallback shell
idle is quiescence-only. For the server label, anchor `SHELL_PROMPT` per-line (`/m`) and test
against the last non-empty line, not the whole chunk.

---

## P2 — macOS `comm`-absent fallback branch is unreachable in production and untested

**Where:** `src/statusProbe.ts:176`, `:183-191` (`haveComm === false` path).

**Why it's wrong:** `MacPsProbe` always requests `comm=` (`:304`), so `haveComm` is effectively
always true; the entire no-comm fallback (which flips the idle/busy default, `:191`) is dead in the
real probe and has **zero test coverage**. If that branch were ever reached (e.g. a future probe
variant), its default (`return false` ⇒ idle when no non-root foreground process is seen) is the
*opposite* bias (idle-biased) from the rest of the busy-biased machine — a latent I2 violation.

**Suggested fix:** Either delete the unreachable branch, or cover it with a fixture and make its
default busy-biased to match I2.

---

## Verified-correct (spot-checked or proven)

- **Linux `/proc` field indexing** — verified against real `/proc/self/stat`
  (`29112 (cat) R 28756 29112 28756 0 -1 …`): after `)`, f[0]=state, f[1]=ppid, f[2]=pgrp,
  f[5]=tpgid — matches `parseProcRecords` (`statusProbe.ts:62-66`). `(comm)` extraction via
  `indexOf("(")`/`lastIndexOf(")")` correctly tolerates spaces/parens/inner `()` (verified with
  `npm run (build)`); a comm containing a newline stays within the single per-file entry string so
  the slice still works.
- **Linux probe against a REAL node-pty tree** (live test): `/bin/sh -c "bash"` leaves the root
  `sh` waiting (tpgid points at the bash group) and a child `bash` with `pid==pgrp==tpgid` ⇒
  `parseProcTree` returns `false` (idle) at rest, `true` during `sleep 3`, `false` after. The
  busy-bias and resting-shell rule are sound for shell panes and genuinely defeat BUG-006.
- **macOS `parsePsTree`** — correct for both wrapper shapes (root `sh` + foreground `bash S+`,
  and an exec-replaced `bash` as root); busy when a command holds the `+` group. Basename
  extraction via `split("/").pop()` handles full-path/`App Name` comms.
- **State machine invariants** under the exercised events: busy-bias (authoritative busy wins,
  cancels idle timer), `armIdleOnce` does not perpetually re-arm (the debounce actually fires),
  Tier-0 Exited is terminal, exactly one onIdle per real Running→Idle edge, and the
  `sawWorkSinceIdle` gate suppresses the startup-settle spurious "done" while still firing on a
  writeInput- or authoritative-busy-driven completion. The replay harness faithfully mirrors
  `applyStatusEvent` bookkeeping (confidence / idleTimerArmed / sawWorkSinceIdle / P0-2 output-work).
- **Already-fixed P0s confirmed present:** the `runProbeTick` `interactive_cli` gate
  (`terminal.ts:354-357`) and the fallback output-as-work P0-2 logic (`terminal.ts:309-316`,
  mirrored in the harness) are both in place; the agent-at-rest and fallback-shell onIdle tests pass.
- **`stop()` TDZ fix** (`terminal.ts:500-507`): `killTimeout` is declared before `done`, guarded
  with `if (killTimeout)`; synchronous `onExit` / throwing `kill` no longer ReferenceError.
- **Preserved behavior:** `redactSecrets` still wired in `getPaneSummary` (`terminal.ts:765`) and
  now also on `last_command` in the digest (`server.ts:1396`); `alive` via real `onExit`
  (`terminal.ts:449-457`); ANSI strip unchanged; atomic ledger untouched; new `PaneMeta` fields
  optional so old ledgers load. systemInstruction correctly drops the frozen status snapshot.
- **Timer hygiene:** `probeTimer` (`setInterval`) and `killTimeout` are `.unref()`'d; both timers
  cleared on `onExit` and `stop()`; suite exits cleanly (EXIT=0).

---

## Coverage gaps (correctness-critical paths with ZERO coverage)

1. **`runProbeTick` gating itself is untested.** Every test exercises the *pure* `decideStatus` or
   the *pure* parsers; the actual class method that decides "authoritative vs downgrade-to-fallback
   per `runtimeType`/platform" has no test. This is exactly where the unfixed Windows-shell defect
   (P1) lives and would be caught — a `parseProcessList` "resting `cmd /c cmd`" assertion plus a
   `runProbeTick`-level test for a Windows `shell` pane.
2. **No `applyStatusEvent` integration test on the real `UniversalTerminal`.** The replay harness
   re-implements the bookkeeping; a regression in `applyStatusEvent` (e.g. the `lastConfidence`
   update order, the P0-2 condition) would not be caught because no test drives the real method +
   real timers. (Tests confirm timers don't leak, not that transitions are correct end-to-end.)
3. **Windows CSV quoting** (P2): no fixture with a quoted/comma-containing `Name`.
4. **macOS no-`comm` fallback** (P2): unreachable and untested branch with opposite (idle) bias.
5. **`idleTimeoutMs < probeIntervalMs`** (P2): no test for the small-timeout false-done race.
6. **interactive_cli mid-turn quiescence pause:** an agent that goes silent >idleTimeoutMs mid-turn
   (tool call / thinking) will false-idle; this is an inherent quiescence limitation (documented in
   the design), but there is no test pinning the chosen trade-off or the timeout value.
7. **Legacy-transport (node-pty unavailable) path** is never exercised; all tests run with node-pty
   present, so the fallback `confidence:"fallback"` + quiescence path is unvalidated against a real
   `script`/`cmd.exe` spawn.
