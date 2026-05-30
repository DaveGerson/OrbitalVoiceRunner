# WS-C Busy/Idle Status Detection — Maintainability Review

**Reviewer:** Maintainability lens only.
**Commit:** `d641547` — cross-platform busy/idle status detection rewrite.
**Files reviewed:** `src/statusProbe.ts`, `src/statusMachine.ts`, `src/ptyTransport.ts`,
`src/terminal.ts` (status-related portions), `src/ledger.ts`, `server.ts` (status portions),
`tests/test_status_machine.ts`, `tests/test_status_parsers.ts`, `tests/fixtures/status/*`.

Correctness is already covered in `wsc-stage3-review.md` and is not re-reported here.

---

## Priority findings

### HIGH

---

**H1 — `usingNodePty` is tracked but never used to change probe confidence.**
`src/terminal.ts:166–167`, `src/ptyTransport.ts:15`

The comment on line 166 says *"panes advertise `confidence:"fallback"` when `usingNodePty` is
false (design §6, R1)"*, and the `ptyTransport.ts` module-level comment repeats the same
promise. The implementation never fulfills it. `statusProbe` is selected at constructor time
via `selectProbe()` (line 192) — completely independently of whether `start()` later chooses
the legacy transport. When node-pty fails to load, `usingNodePty` is set to `false` on line
422, but the probe selected in the constructor is still the platform-native `LinuxProcProbe`
(or `MacPsProbe`), which keeps returning `confidence:"authoritative"`. The field `usingNodePty`
is therefore dead state: it is written, never read downstream for any branching decision.

The design intent (graceful degradation to fallback when on the legacy transport) is not
implemented. The consequence is that on the legacy `script` path, the authoritative probe still
drives idle transitions — but it probes the `script` process as the shell root, not a real PTY
shell, which may or may not behave correctly depending on how `script` arranges its process
group.

**Suggested fix:** In `start()`, after `this.usingNodePty = usingNodePty;`, add:
```ts
if (!usingNodePty) {
  this.statusProbe = new FallbackProbe(); // legacy transport: degrade to quiescence
}
```
Or pass `usingNodePty` into `runProbeTick()` and return a synthetic fallback result when
`!usingNodePty`. Either way the comment must match the code, or the comment must be removed and
the field removed if the behavior is intentionally not enforced.

---

**H2 — Dead branch in `decideStatus` idleTimer/fallback path erases the `runtimeType`
distinction.**
`src/statusMachine.ts:143–163`

In the `"idleTimer"` + fallback-confidence branch, the code reads:
```ts
if (runtimeType === "shell") {
  if (lastLineIsPrompt(recentTail)) {
    return setIdle();
  }
  // No prompt visible — quiescence alone (no worse than today).
  return setIdle();  // ← unconditional regardless of whether prompt matched
}
// interactive_cli in fallback: idle purely on quiescence, never prompt regex.
return setIdle();
```

Both the `if` and the `else` of the `lastLineIsPrompt` check call `setIdle()`. The prompt check
is thus completely inert — the result is identical whether or not a prompt is present, and
identical to the `interactive_cli` branch. The comment claims the shell branch checks for a
prompt ("Shell panes idle on quiescence + a narrowed prompt") but the code doesn't enforce it.

This will mislead anyone who later tries to differentiate shell vs agent behavior on the idle
timer. If the intent is "quiescence alone is sufficient" (the current fallback design), the two
branches and the dead inner `if` should be collapsed into a single `return setIdle();`. If the
intent is to require a prompt for shell panes, the `else` branch should _not_ call `setIdle()`.

**Suggested fix (enforce-prompt intent):**
```ts
case "idleTimer": {
  if (confidence === "authoritative") return setIdle();
  // Fallback: shell panes require a prompt; interactive_cli idles on quiescence only.
  if (runtimeType === "shell" && !lastLineIsPrompt(recentTail)) return NO_CHANGE(currentStatus);
  return setIdle();
}
```
Or, if quiescence-only is truly the design for all types, collapse to `return setIdle()` and
remove the dead conditional entirely.

---

**H3 — `spawn` and `ChildProcess` are imported but unused; `public process` is a dead field.**
`src/terminal.ts:1`, `src/terminal.ts:136`

`import { spawn, ChildProcess } from "child_process"` (line 1) remains from the pre-WS-C code.
`spawn` is never called in `terminal.ts` (all spawn is delegated to `ptyTransport.ts`).
`ChildProcess` is only referenced at `public process: ChildProcess | null = null` (line 136),
which is initialized to `null` and never assigned anywhere in the new code. Any future reader
will assume `process` is the active child process and try to read/use it — only to discover it
is permanently `null`. The real process handle lives in `this.transport`, which is `private`.

**Suggested fix:** Remove the `spawn` import and `ChildProcess` import. Remove or
document-clearly `public process`. If external code (tests, server) ever needs the underlying
process PID, expose `get pid(): number | undefined { return this.transport?.pid; }` instead.

---

**H4 — `parsePsTree` inlines a copy of `treeMembers` rather than calling it.**
`src/statusProbe.ts:160–175` (vs. `src/statusProbe.ts:74–93`)

`parseProcTree` delegates tree-building to `treeMembers()`. `parsePsTree` contains a 15-line
verbatim re-implementation of the same BFS/DFS tree walk (builds `childrenOf`, sets `members`,
iterates a `stack`). These must stay in sync. Any future fix to the cycle-detection or the
BFS logic (e.g. handling a PID that appears as its own parent) must be applied in both places.

**Suggested fix:** Extract a shared helper `buildDescendantSet(recs: {pid,ppid}[], rootPid:
number): Set<number>` (or adapt `treeMembers` to accept a generic `{pid,ppid}[]`), and call it
from both `parseProcTree` and `parsePsTree`. `parseProcTree` already uses `treeMembers`; the
change would be to thread `parsePsTree`'s inline `Rec[]` through the same helper.

---

**H5 — `types.ts:PaneMeta` is a stale duplicate that diverges from `ledger.ts:PaneMeta`.**
`src/types.ts:23–35`, `src/ledger.ts:4–21`

There are two `PaneMeta` interfaces: one in `ledger.ts` (the authoritative one used by
`terminal.ts`) and one in `src/types.ts` that is exported but not imported by any
WS-C-touched file. The `types.ts` copy lacks all three WS-C additions (`last_status_change_at`,
`last_command`, `elapsed_ms`). Similarly `Workspace` is duplicated. A future maintainer
importing from `types.ts` will see a `PaneMeta` that silently hides the new fields.

**Suggested fix:** Delete `PaneMeta` and `Workspace` from `types.ts` and add
`export { PaneMeta, Workspace } from "./ledger"` if they need to be re-exported from that
module. One canonical definition, one place to update.

---

### MEDIUM

---

**M1 — `probeIntervalMs` (500 ms) is a private magic constant, not configurable.**
`src/terminal.ts:157`

`idleTimeoutMs` is a public field wired to `settings.advanced.idleTimeoutMs` and propagated
through `OrchestratorManager.updateSettings()`. The probe interval (`probeIntervalMs = 500`) is
an equivalent "tuning knob" that affects responsiveness vs CPU cost, but it is a hard-coded
private constant with no setting, no named exported constant, and no path for the operator to
adjust it. It is referenced by a comment on line 459 (`// Run the ~500ms process-state probe`),
which will go stale if the default changes.

**Suggested fix:** Promote to a named constant:
```ts
const DEFAULT_PROBE_INTERVAL_MS = 500;
```
And wire it to `settings.advanced` (or at minimum make the field `public` like `idleTimeoutMs`
so integration tests can override it without reflection).

---

**M2 — `NodePtyTransport.proc` is typed `any`, bypassing the available `IPty` type.**
`src/ptyTransport.ts:67`

`node-pty` ships `typings/node-pty.d.ts` with a fully typed `IPty` interface. The field is
typed `any`, the constructor does `pty.spawn(...)` as `any`, and `loadNodePty()` returns `any`.
This means `onData`, `onExit`, `write`, `kill`, and `pid` are all untyped access paths. If the
module ever changes its API (e.g. the `onExit` callback shape, which already has a known v0.x
vs v1.x difference), TypeScript won't catch the mismatch.

**Suggested fix:** Import the type with `import type { IPty, IBasePtyForkOptions } from
"@homebridge/node-pty-prebuilt-multiarch"` and cast the result of `pty.spawn(...)` to `IPty`.
Keep `loadNodePty()` returning `any` since it's a dynamic require, but narrow `this.proc` to
`IPty` after the cast.

---

**M3 — The `LegacyChildProcessTransport` can fire `onExit` up to three times per process
lifecycle.**
`src/ptyTransport.ts:137–145`

The constructor registers handlers for all three of `error`, `exit`, and `close` on the child
process. Node.js emits these in sequence for a failing process (error → exit → close) and in
sequence for a normal process (exit → close). The `transport.onExit()` callbacks are therefore
called 2–3 times per lifecycle. `terminal.ts:stop()` registers another `onExit(done)` to
resolve its promise; it guards with a `resolved` flag, so that call-site is safe. But
`transport.onExit()` in `start()` (which sets `this.status = "Exited"`) will be called multiple
times too — meaning `clearProbeTimer()` and the timer-clear block run redundantly. It is
harmless today (idempotent calls) but creates confusion about the contract of `onExit`.

**Suggested fix:** Guard in `LegacyChildProcessTransport` with a one-shot flag:
```ts
private exited = false;
private fireExit(info: ...) { if (this.exited) return; this.exited = true; for (const cb of this.exitCbs) cb(info); }
```
This matches the node-pty transport's single-fire semantics and makes the interface contract
unambiguous.

---

**M4 — `recentTail` is assembled from 5 lines of the stripped `outputBuffer`, but this
magic number has no named constant and no doc for why 5.**
`src/terminal.ts:292`

```ts
const recentTail = stripAnsiSequences(this.getRecentOutput(5));
```

The value `5` determines how many buffered lines of output the prompt regex inspects. Too low
and the regex may miss a multi-line prompt preceded by a trailing blank; too high and it
evaluates against irrelevant prior command output. The number is not named, not adjustable, and
not explained. The default for `getRecentOutput` is `10` (line 475), making `5` feel like an
arbitrary reduction.

**Suggested fix:** Extract:
```ts
private static readonly PROMPT_TAIL_LINES = 5; // inspect only the final N lines for prompt detection
```
and add a brief comment explaining the tradeoff.

---

**M5 — `nodePtyAvailable` is imported in `terminal.ts` but never called.**
`src/terminal.ts:6`

The import `nodePtyAvailable` is present alongside `createPtyTransport`, but it appears nowhere
in the file body (all uses are via the `usingNodePty` return value from `createPtyTransport`).
This is a consequence of the unimplemented H1 behavior: if the fallback-downgrade were
implemented, this function would be the obvious tool to use. As-is it is dead import noise.

**Suggested fix:** Remove from the import line until it has a call-site (or implement H1 using
it).

---

**M6 — `runtimeType` mapping is implicit and fragile for new presets.**
`src/terminal.ts:190`

```ts
this.runtimeType = toolPreset === "Custom" ? "shell" : "interactive_cli";
```

This binary mapping encodes a consequential behavioral distinction (probe gating, prompt-regex
gating, onIdle semantics) in a single ternary with no documentation of the invariant. If a
future maintainer adds a new `toolPreset` value (e.g. a "Browser" or "REPL" preset), they must
know to update this line, but there is no type system enforcement nor any comment pointing here
as the dispatch point.

**Suggested fix:** Make the mapping explicit and exhaustive:
```ts
const RUNTIME_TYPE_BY_PRESET: Record<typeof toolPreset, RuntimeType> = {
  "Claude Code": "interactive_cli",
  "Codex":        "interactive_cli",
  "Antigravity":  "interactive_cli",
  "Custom":       "shell",
};
this.runtimeType = RUNTIME_TYPE_BY_PRESET[toolPreset];
```
TypeScript will then fail to compile when a new `toolPreset` value is added without updating the
map.

---

**M7 — `hasDescendant` returns early after confirming the first descendant, silently
ignoring the rest of the tree; comment is misleading.**
`src/statusProbe.ts:265–275`

```ts
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
```

The function stops as soon as it finds _any_ descendant and returns `true`. The `while` loop
body only ever executes one useful iteration (the first non-root, non-seen pid), then
immediately returns. The `seen` set and the stack never accumulate beyond one entry. The
behavior is correct (any descendant ⇒ busy) but the code looks like a full BFS, misleading
readers into thinking it walks the whole tree. The comment `// any descendant at all` helps but
does not redeem the structure.

**Suggested fix:** Simplify to make the intent obvious:
```ts
function hasDescendant(childrenOf: Map<number, number[]>, root: number): boolean {
  return (childrenOf.get(root)?.length ?? 0) > 0; // any direct child means a command is running
}
```
If deep descendants are needed in the future, the full BFS is easy to restore; as-is, a direct
child check is all that is actually used (Windows any-descendant rule).

---

**M8 — `scrollback` 512 KB limit is an unnamed magic number.**
`src/terminal.ts:392`

```ts
if (stat.size > 1024 * 512) { // 512KB limit
```

The inline comment helps, but this threshold is not wired to any setting and has no named
constant. If `maxBufferLines` is operator-configurable but the underlying file limit is not, the
two limits can diverge inconsistently.

**Suggested fix:** Promote to a named constant near the `maxBufferLines` field:
```ts
private static readonly SCROLLBACK_MAX_BYTES = 512 * 1024; // 512 KB pruning threshold
```

---

**M9 — Probe exec timeouts (2000 ms, 4000 ms, 3000 ms) are unnamed magic literals.**
`src/statusProbe.ts:304`, `src/statusProbe.ts:326`, `src/statusProbe.ts:335`

The `ps`, PowerShell, and wmic `execSync` calls each have ad-hoc timeouts that are undocumented
as to why they differ. They are not configurable and not referenced in any test. A slow system
could cause the probe to silently fall back to `confidence:"fallback"` without the operator
knowing.

**Suggested fix:** Name them:
```ts
const PS_PROBE_TIMEOUT_MS   = 2000;
const PS_CMD_TIMEOUT_MS     = 4000; // PowerShell startup is slower than ps
const WMIC_TIMEOUT_MS       = 3000;
```
And add a brief note on why the PowerShell timeout is longer.

---

**M10 — Extension point for new probes is not documented in `selectProbe`.**
`src/statusProbe.ts:352–357`

`selectProbe` is a dispatch function that maps `process.platform` to a concrete `StatusProbe`.
It is the single place to update when adding a new platform. The function has a one-line comment
but no "how to add a new platform probe" note. Someone adding FreeBSD or WASM support will have
to reverse-engineer the pattern.

**Suggested fix:** Add a JSDoc block to `selectProbe`:
```ts
/**
 * Select the platform probe by process.platform (overridable for tests).
 *
 * TO ADD A NEW PLATFORM:
 *  1. Implement `StatusProbe` with a pure `parse<Platform>Tree()` function (unit-tested).
 *  2. Export the probe class from this file.
 *  3. Add a `if (platform === "<key>") return new YourProbe();` line here.
 *  4. Add fixtures under tests/fixtures/status/ and cover the parser in test_status_parsers.ts.
 */
```

---

### LOW

---

**L1 — `invariants I1–I6` are referenced by label in code comments but are only defined
in the design doc, not discoverable from the code.**
Multiple files: `statusMachine.ts`, `statusProbe.ts`, `terminal.ts`

Comments like `// I2 — authoritative busy wins` and `// I4/I5` are meaningful if you have the
design doc open, but they are opaque to a reader without it. The invariants themselves (6 lines
of text) would fit in a comment block in `statusMachine.ts`.

**Suggested fix:** Add a collapsed `/* INVARIANTS ... */` block at the top of
`statusMachine.ts` with the one-line definition of each invariant, so the label references are
self-contained. Cross-reference the design doc for the full rationale.

---

**L2 — `SHELL_PROMPT` is exported from `statusMachine.ts` and re-used in `server.ts`,
creating an unexpected import dependency.**
`server.ts:11`, `src/statusMachine.ts:20`

`server.ts` imports `SHELL_PROMPT` from `./src/statusMachine`. The state machine module's
primary contract is `decideStatus()`; exporting a regex that `server.ts` uses independently for
its `detectAndTriggerTransitions` transition classifier means `statusMachine.ts` is now a
"utils" module as well as a state machine. If someone moves or refines `SHELL_PROMPT` in the
machine (e.g. makes it configurable), they must remember the server-side use.

**Suggested fix:** Move `SHELL_PROMPT` to a dedicated `src/statusConstants.ts` (or into
`statusProbe.ts` where SHELL_COMMS also lives), and import from there in both
`statusMachine.ts` and `server.ts`. Keeps the machine's public surface purely about
`decideStatus`.

---

**L3 — Test: `replay()` mirrors `applyStatusEvent()` with duplicated P0-2 logic, creating
two places to keep in sync.**
`tests/test_status_machine.ts:75–85`, `src/terminal.ts:304–315`

The replay harness re-implements the P0-2 `sawWorkSinceIdle` promotion block (7 lines) verbatim
from `terminal.ts`. The test-file comment even says "mirror UniversalTerminal". If the P0-2
logic changes in `terminal.ts`, the test harness must be updated identically. There is no
compiler or lint enforcement that they match.

**Suggested fix:** Extract the P0-2 promotion logic into a pure function in `statusMachine.ts`:
```ts
export function shouldCountOutputAsWork(
  event: StatusEvent, confidence: Confidence, prevStatus: Status, nextStatus: Status
): boolean { ... }
```
Both `terminal.ts` and the replay harness call the same function. Any divergence becomes a
compile-time error if the signature changes.

---

**L4 — `getRecentOutput`'s docstring comment (line 762) claims it "already strips ANSI"
but it does not; stripping happens in the caller.**
`src/terminal.ts:762`, `src/terminal.ts:475–477`

`getPaneSummary` comments: *"WS-B: redactSecrets runs AFTER ANSI stripping (getRecentOutput
already strips ANSI)."* `getRecentOutput` returns `outputBuffer.slice(-linesCount).join('\n')`.
`outputBuffer` is populated with ANSI-stripped lines (the `cleanLines` from line 440), so the
buffer contents are already stripped, and the comment is accidentally correct — but the
stripping happens in the `onData` handler, not in `getRecentOutput`. This misleads anyone who
calls `getRecentOutput` on a hypothetical future buffer that contains raw output.

**Suggested fix:** Update the comment: *"outputBuffer is ANSI-stripped at insertion (see
onData:440); getRecentOutput returns already-clean lines."*

---

**L5 — `FallbackProbe` ignores the `_shellPid` parameter without a comment.**
`src/statusProbe.ts:345–349`

The underscore prefix is a TypeScript convention for "intentionally unused". A brief inline
comment explaining _why_ (the fallback probe has no process-tree access) would help a reader
understand this is not a bug.

---

**L6 — `haveComm` shortcut in `parsePsTree` evaluates to `true` whenever any record has a
non-empty comm, including non-tree members.**
`src/statusProbe.ts:176`

```ts
const haveComm = recs.some(r => r.comm.length > 0);
```

This checks all records from the full `ps -ax` output, not just descendants of `shellPid`. If
an unrelated process happens to have a comm name, `haveComm` is `true` even if the tree
members have no comm. In practice `ps -ax` almost always has comms, so this is unlikely to
matter, but the invariant being tested ("does the tree have comm info?") and the implementation
("does any process in the system have comm info?") are different. Adding `&& members.has(r.pid)`
would make the check accurate.

---

## What is well-done

- **Module boundary is clean and coherent.** The three-way split — `statusProbe.ts` (platform
  parsers + probe classes), `statusMachine.ts` (pure decision function), `ptyTransport.ts`
  (spawn/IO seam) — maps precisely onto the design's §2/§3/§2.4 sections. Each module has a
  single clear responsibility.

- **Pure-function seam is well-exposed and genuinely tested.** `parseProcTree`,
  `parsePsTree`, `parseProcessList`, and `decideStatus` are all pure functions with no I/O.
  The test files exercise them directly against synthetic fixtures. The Windows parser is
  validated without a Windows runtime.

- **Comments explain the WHY where it matters most.** The foreground-resting-shell rule
  (`parseProcTree` JSDoc, `runProbeTick` P0-1 comment, `applyStatusEvent` P0-2 comment) are all
  clear enough that a reader can understand the subtle invariant without the design doc. The
  invariant labels (I1/I2/I4) in hot-path comments are genuinely useful cross-references.

- **`decideStatus` is readable and complete.** The input/output types (`DecideInputs`,
  `DecideResult`) with JSDoc fields, the named helper closures (`setRunning`, `armIdleOnce`,
  `setIdle`, `NO_CHANGE`), and the switch-on-event-kind structure make the logic followable.
  The `fireOnIdle` flag cleanly separates the state transition from the side-effect decision.

- **Replay harness is a genuine regression guard.** The virtual-clock approach in
  `test_status_machine.ts` correctly simulates the debounce logic without real timers. The
  BUG-006 fixture is self-documenting (JSONL with a `_comment` header line), and the test
  assertions encode each invariant by name.

- **Dependency injection for the probe is complete and unambiguous.** The constructor
  accepts an optional `StatusProbe` (line 183), defaults to `selectProbe()`, and every test
  that needs a controlled probe can supply one. The `FallbackProbe` class is available as a
  test-friendly no-op.

- **Timer hygiene is thorough.** Both `probeTimer` (interval) and `idleTimer` (timeout) are
  cleared in `stop()`, on `Exited`, and the probe timer uses `.unref()` so it does not keep
  the Node.js process alive. The `stop()` SIGTERM→SIGKILL escalation with a guarded `done()`
  closure is correct and robust.

- **Backward compatibility is preserved by design.** The three new `PaneMeta` fields are all
  `optional`, so existing persisted ledgers load unchanged. The legacy transport path is kept
  verbatim inside `LegacyChildProcessTransport`.

---

## Summary

Overall maintainability verdict: **Good structural foundation with two high-priority maintenance
traps.** The new modules are well-separated, the pure-function seams are real and well-tested,
and the comments on the subtle logic are excellent. The main risks are: (1) a broken promise
between `usingNodePty` and probe confidence that will silently misbehave when the legacy
transport activates, (2) a dead branch in the `idleTimer` fallback case that makes the
`runtimeType` check look meaningful when it is not, and (3) a duplicated tree-walk in
`parsePsTree` that will diverge from `treeMembers` on the next fix.

**Top 3 improvements:**

1. **H1 — Wire `usingNodePty=false` to `FallbackProbe`** (`terminal.ts:start()`): the comment
   promising this behavior is wrong; fix or remove it before it misleads the next change.
2. **H2 — Collapse or fix the dead `idleTimer` branch** (`statusMachine.ts:155–163`): the
   prompt check is inert; either enforce it (require a prompt for shell) or delete the
   conditional so the intent is honest.
3. **H4 — Deduplicate the tree-walk in `parsePsTree`** (`statusProbe.ts:160–175`): extract a
   shared helper so a future bug-fix to cycle-detection or ancestor-walk only needs to happen
   once.
