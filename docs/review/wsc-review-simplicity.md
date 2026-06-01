# WS-C Simplicity Review — Busy/Idle Status Detection

**Reviewer lens:** SIMPLICITY only. Correctness already audited in `wsc-stage3-review.md`.
**Commit:** `d641547`
**Files in scope:** `src/statusProbe.ts`, `src/statusMachine.ts`, `src/ptyTransport.ts`,
`src/terminal.ts` (status-related sections), `src/ledger.ts`, `server.ts` (status-related),
`tests/test_status_machine.ts`, `tests/test_status_parsers.ts`.

Priority scale: **High** (removes real confusion or a whole class of future bugs),
**Med** (nice cleanup, low risk), **Low** (cosmetic / micro).

---

## High Priority

---

### H1 — `idleTimer` case in `decideStatus` is unconditionally `setIdle()` — the `runtimeType` and `lastLineIsPrompt` branches are dead code

**File:** `src/statusMachine.ts:143–164`

**Current shape:**
```ts
case "idleTimer": {
  if (confidence === "authoritative") {
    return setIdle();
  }
  // Fallback mode: gate by runtime_type (I4). Shell panes idle on
  // quiescence + a narrowed prompt; interactive_cli idles on quiescence only
  // and NEVER on a prompt-looking line.
  if (runtimeType === "shell") {
    if (lastLineIsPrompt(recentTail)) {
      return setIdle();
    }
    // No prompt visible — quiescence alone (no worse than today).
    return setIdle();          // <--- same result whether or not the prompt matched
  }
  // interactive_cli in fallback: idle purely on quiescence, never prompt regex.
  return setIdle();            // <--- also setIdle()
}
```

Every branch — `confidence === "authoritative"`, `runtimeType === "shell"` with prompt,
`runtimeType === "shell"` without prompt, and `interactive_cli` fallback — returns
`setIdle()`. The `runtimeType` dispatch and `lastLineIsPrompt` call are never observable;
both arms of the inner `if` return the same thing. The `lastLineIsPrompt` wrapper function
(lines 59–61) exists solely to serve this dead branch.

The dead code is misleading: a future reader (or the machine that generated this code)
might believe the prompt check *does* gate idle in fallback mode, which it does not.
The design doc (§3 tier C) says the narrowed prompt is a *fallback* gate, but the
implementation dropped the gate while keeping the if/else scaffolding around it.

**Simpler alternative:**
```ts
case "idleTimer":
  // Timer fires only when armed: in authoritative mode after a no-child probe,
  // or in fallback mode after output quiescence. Either way → Idle.
  return setIdle();
```

Remove `lastLineIsPrompt`, `SHELL_PROMPT` export (if it has no other consumer — see H2),
and the `runtimeType` parameter from `DecideInputs` if nothing else uses it.

**Risk:** Behavior change only if `lastLineIsPrompt` or `runtimeType` was supposed to
*gate* `setIdle()` (i.e. not call it at all in fallback+no-prompt). That was the design
intent, but the implementation already dropped the gate. If the gate is desired as a
future invariant, the correct fix is to add `return NO_CHANGE(currentStatus)` on the
no-prompt shell arm — which is a correctness/design decision, not a simplification.
As written, removing the dead scaffolding changes nothing observable. **Low correctness
risk; no behavior change.**

---

### H2 — `SHELL_PROMPT` is exported from `statusMachine.ts` and used in `server.ts` for a purpose independent of the state machine

**File:** `src/statusMachine.ts:20`; `server.ts:11, 422`

**Current shape:** `SHELL_PROMPT` is defined in `statusMachine.ts` and re-exported so
`server.ts` can use it inside `detectAndTriggerTransitions` to refine an already-Idle
pane into a `"prompt"` attention event. This couples `server.ts` to `statusMachine.ts`
for what is essentially a regex constant.

More importantly: `detectAndTriggerTransitions` (server.ts:386–460) now only references
`term.status === "Idle"` (the machine already decided idle) and then does a secondary
`"prompt"` refinement using `SHELL_PROMPT` on the *current chunk*, not on `recentTail`.
This secondary use is a distinct concern from the machine's idle decision.

Given H1, if `SHELL_PROMPT` is removed from `statusMachine.ts`, `server.ts` will need
its own copy (one line). Alternatively the constant belongs in a shared `constants.ts` or
directly inline in `server.ts` (it is only ~40 chars). The current placement in
`statusMachine.ts` implies it drives the state machine's decisions, which H1 shows it
does not.

**Simpler alternative:** Inline the regex literal in `server.ts:422` or move it to
`src/statusProbe.ts` alongside `SHELL_COMMS`, where shell-identification constants live.
Either way, remove the cross-module export from the state-machine file.

**Risk:** None — pure rename/relocation. **No behavior change.**

---

### H3 — `parsePsTree` duplicates the parent→child tree-walk that `treeMembers` already implements; `parseProcessList` duplicates the same walk a third time

**File:** `src/statusProbe.ts:74–93` (`treeMembers`), `src/statusProbe.ts:161–174`
(inlined in `parsePsTree`), `src/statusProbe.ts:211–232` (inlined in `parseProcessList`)

**Current shape:**

`treeMembers` (lines 74–93) builds a `childrenOf` map and does a stack-based BFS/DFS to
collect all descendants. `parsePsTree` (lines 161–174) repeats the same map-build and
stack-walk inline. `parseProcessList` (lines 211–232 in the CSV branch) builds the same
`childrenOf` map and then delegates to `hasDescendant` (line 232) — but `hasDescendant`
(265–275) only walks *one level deep before returning `true`* (it returns immediately on
the first descendant found, never pushing to `stack`), making its `seen` set and further
iterations dead. The CSV branch therefore ends up with a correct but unnecessarily complex
single-entry walk.

The three sites all implement: "given a list of (pid, ppid) pairs, is any descendant of
`shellPid` present?" They differ in what they do with the answer, but the tree-walk is
identical.

**Simpler alternative:** Extract one shared helper:
```ts
function buildChildMap(pairs: {pid: number; ppid: number}[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const {pid, ppid} of pairs) {
    const a = m.get(ppid) ?? [];
    a.push(pid);
    m.set(ppid, a);
  }
  return m;
}
```
`treeMembers` uses it; `parsePsTree` uses `treeMembers` (or the same helper);
`parseProcessList` builds the map once and calls `hasDescendant` (simplified to a trivial
`(childrenOf.get(root) ?? []).length > 0` since it only needs to know if *any* direct or
indirect descendant exists, and any first-level child is already a descendant).

Also simplify `hasDescendant`: since it returns `true` on the very first item in the
stack, it never pushes anything to `stack` or uses `seen` — the `while` loop body after
the `return true` is unreachable. The function is equivalent to:
```ts
function hasDescendant(childrenOf: Map<number, number[]>, root: number): boolean {
  return (childrenOf.get(root)?.length ?? 0) > 0;
}
```
(For the Windows case the tree is only one level from `root` to immediate children, then
the question is just "does root have any child?" which is the above. If multi-level is
needed, a proper recursive check is cleaner than the dead-loop form.)

**Risk:** The simplified `hasDescendant` is correct for the Windows case (any descendant =
any child of root since the code never iterates deeper before returning). A full
multi-level walk is not exercised by the current code path. If a deep Windows tree is ever
needed, the refactor should preserve proper DFS. Flag and document. **Low behavioral
risk if the simplified version is confirmed correct for the Windows tree shape.**

---

## Medium Priority

---

### M1 — `FallbackProbe` class is YAGNI — `selectProbe` can return a plain function or object literal

**File:** `src/statusProbe.ts:344–349`, `src/statusProbe.ts:351–357`

**Current shape:**
```ts
export class FallbackProbe implements StatusProbe {
  probe(_shellPid: number): ProbeResult {
    return { hasRunningChild: false, confidence: "fallback" };
  }
}

export function selectProbe(platform = process.platform): StatusProbe {
  if (platform === "win32") return new WindowsProbe();
  if (platform === "darwin") return new MacPsProbe();
  if (platform === "linux") return new LinuxProcProbe();
  return new FallbackProbe();
}
```

`FallbackProbe` is a class with no state that always returns the same literal. It is never
referenced in tests or anywhere else under its class name — it is only used as the
return value of the `else` arm of `selectProbe`.

**Simpler alternative:**
```ts
export function selectProbe(platform = process.platform): StatusProbe {
  if (platform === "win32") return new WindowsProbe();
  if (platform === "darwin") return new MacPsProbe();
  if (platform === "linux") return new LinuxProcProbe();
  return { probe: () => ({ hasRunningChild: false, confidence: "fallback" }) };
}
```

Or, if a named export is useful for tests that want to inject a known-fallback probe:
```ts
export const FALLBACK_PROBE: StatusProbe = {
  probe: () => ({ hasRunningChild: false, confidence: "fallback" }),
};
```

**Risk:** None. **No behavior change.** The class is purely a named wrapper; an object
literal satisfies the interface identically.

---

### M2 — `usingNodePty` public field on `UniversalTerminal` is set but never read outside `terminal.ts`; the `nodePtyAvailable` import is unused

**File:** `src/terminal.ts:6` (import), `src/terminal.ts:167` (field), `src/terminal.ts:422` (set)

**Current shape:** `usingNodePty` is assigned in `start()` from the `createPtyTransport`
return value, but no code path in `server.ts`, the tests, or elsewhere reads
`term.usingNodePty`. The design says it should gate `confidence:"fallback"` advertising
(design §6, R1), but the actual confidence decision in `runProbeTick` is driven entirely
by whether the probe returns `"authoritative"` or `"fallback"` — the transport type is
not consulted. The `nodePtyAvailable` import at line 6 is also unused (tsc would flag it
as unused if `noUnusedLocals` were on).

**Simpler alternative:** Remove `usingNodePty` from `UniversalTerminal` and remove the
`nodePtyAvailable` import from `terminal.ts`. The intended "advertise fallback when legacy
transport is active" behavior should be implemented by having `createPtyTransport` (or
the probe) set `confidence:"fallback"` directly — which is already what the `FallbackProbe`
path through `selectProbe` achieves. If the field is kept for future diagnostic use,
make it `private` and add a comment noting it is not yet consumed.

**Risk:** Removing a public field is a minor API surface reduction. If any external code
(a test or UI extension) reads `term.usingNodePty` reflectively or via JSON serialization
it would break, but no such use was found. **No behavior change.**

---

### M3 — `LegacyChildProcessTransport` fires `exitCbs` up to three times (error + exit + close) without deduplication

**File:** `src/ptyTransport.ts:137–145`

**Current shape:**
```ts
this.proc.on("error", () => { for (const cb of this.exitCbs) cb({ exitCode: -1 }); });
this.proc.on("exit",  () => { for (const cb of this.exitCbs) cb({ exitCode: 0 }); });
this.proc.on("close", () => { for (const cb of this.exitCbs) cb({ exitCode: 0 }); });
```

A normal process lifecycle emits both `exit` and `close`; an errored process emits
`error` then `close`. The `onExit` subscriber in `terminal.ts:449` sets
`status = "Exited"` idempotently, but `stop()` registers a *second* `onExit` subscriber
(line 510) that calls `done()` which is guarded by `resolved`. Still, firing registered
callbacks multiple times for a single logical process termination is surprising and could
cause issues if future subscribers are not idempotent.

**Simpler alternative:** Add a `once` flag:
```ts
let exited = false;
const fireExit = (info: {exitCode: number; signal?: number}) => {
  if (exited) return;
  exited = true;
  for (const cb of this.exitCbs) cb(info);
};
this.proc.on("error", () => fireExit({ exitCode: -1 }));
this.proc.on("exit",  () => fireExit({ exitCode: 0 }));
this.proc.on("close", () => fireExit({ exitCode: 0 }));
```

**Risk:** The current code works because the existing subscribers happen to be idempotent.
The simplification makes the behavior explicit and safe for future non-idempotent
subscribers. **Strictly safer, no behavior change for current subscribers.**

---

### M4 — The CIM Key=Value parser branch in `parseProcessList` is dead in practice but kept "for legacy"

**File:** `src/statusProbe.ts:235–262`

**Current shape:** `parseProcessList` first looks for a CSV header; if found it takes the
CSV path (lines 216–233). The Key=Value branch runs only when there is no CSV header. The
`WindowsProbe` always requests `ConvertTo-Csv` (PowerShell path, line 321) or
`/format:csv` (wmic path, line 334) — both produce CSV. The Key=Value format is what
`Get-CimInstance | Format-List` emits, but that command is never issued by `WindowsProbe`.
The only test coverage for the Key=Value branch is synthetic (`test_status_parsers.ts:121`).

This is a speculative YAGNI path: it was added because the design mentioned "CIM
Format-List" as a possible alternative output, but the probe commands were written to
always produce CSV, making this branch unreachable in production.

**Simpler alternative:** Remove the Key=Value branch (lines 235–262) and the `flush`
closure. Keep only the CSV parser. If a Key=Value caller is ever needed, it can be added
then. Removing it also removes the `flush`/`curPid`/`curPpid` state, which is the most
complex part of the function.

**Risk:** Any caller that passes Key=Value text to `parseProcessList` would silently get
`false` (no descendants found) instead of the correct result. Since no current caller
does this, the risk is contained. Add a comment: "CSV only; Key=Value not supported."
**Behavior change only for paths not currently exercised.**

---

### M5 — `applyStatusEvent` in `terminal.ts` duplicates the `sawWorkSinceIdle` update logic that the replay harness also re-implements

**File:** `src/terminal.ts:280–316`; `tests/test_status_machine.ts:54–98`

**Current shape:** The "record genuine work" logic and the "P0-2 output-driven Running
transition in fallback counts as work" logic appear twice — once in
`UniversalTerminal.applyStatusEvent` (lines 280–316) and once in the replay harness's
`apply()` function (test lines 54–98). The test comment says: "This mirrors
`UniversalTerminal.applyStatusEvent` exactly so the replay is a true test of production
behavior, not a parallel reimplementation of policy."

The duplication is an acknowledged tradeoff (the replay harness needs to simulate side
effects), but it means any future change to `sawWorkSinceIdle` logic must be made in two
places, and the comment's guarantee can drift.

**Simpler alternative:** Extract the `sawWorkSinceIdle` bookkeeping into a small pure
helper that both `applyStatusEvent` and the replay harness call:
```ts
// src/statusMachine.ts — alongside decideStatus
export function updateSawWork(
  sawWork: boolean,
  event: StatusEvent,
  result: DecideResult,
  prevStatus: Status,
  confidence: "authoritative" | "fallback"
): boolean {
  if (event.kind === "input") return true;
  if (event.kind === "probe" && event.probe.confidence === "authoritative" && event.probe.hasRunningChild) return true;
  if (event.kind === "output" && confidence === "fallback" && result.status === "Running" && prevStatus !== "Running") return true;
  return sawWork;
}
```

The replay harness calls `updateSawWork` instead of repeating the conditions inline.

**Risk:** Refactoring a subtle piece of P0-2 logic. Requires careful test coverage (which
already exists in the machine tests). **Low risk if done with existing tests as the guard.**

---

## Low Priority

---

### L1 — `return haveComm ? true : false` should be `return haveComm`

**File:** `src/statusProbe.ts:191`

**Current:** `return haveComm ? true : false;`
**Simpler:** `return haveComm;`

`haveComm` is already a `boolean`. **No behavior change.**

---

### L2 — `lastLineIsPrompt` is a one-line wrapper that adds no value

**File:** `src/statusMachine.ts:59–61`

**Current shape:**
```ts
function lastLineIsPrompt(tail: string): boolean {
  return SHELL_PROMPT.test(tail);
}
```

This function is called in exactly one place (line 156) and does nothing beyond forwarding
to the regex. If H1 is applied and the call site is removed, this function disappears
automatically. If H1 is not applied, inline the call: `SHELL_PROMPT.test(recentTail)`.

**Risk:** None. **No behavior change.**

---

### L3 — `LinuxProcProbe.probe` uses a late `require("fs")` instead of the top-level `import fs`

**File:** `src/statusProbe.ts:284`

**Current:** `const fs = require("fs") as typeof import("fs");` inside the `probe()` method.

The file already imports `execSync` from `"child_process"` at the top. `fs` could be
imported at the top level alongside it:
```ts
import { execSync } from "child_process";
import fs from "fs";
```

The late `require` pattern is sometimes used to defer a module load (lazy loading), but
`fs` is a built-in Node module with zero load cost; there is no benefit to deferring it.

**Risk:** None. **No behavior change.**

---

### L4 — `NO_CHANGE` helper returns a new object on every call; could be a single shared constant for the most common case

**File:** `src/statusMachine.ts:63–68`

**Current:**
```ts
const NO_CHANGE = (status: Status): DecideResult => ({
  status,
  armIdleTimer: false,
  clearIdleTimer: false,
  fireOnIdle: false,
});
```

Called with `currentStatus` in several places. Since `DecideResult` is a plain value
object (not mutated), callers could receive the same reference. However, the `status`
field varies, so a single constant is not directly possible. This is micro-optimization
territory; call it out only if allocations matter (they don't here).

Actual simplification: the `default:` branch at line 166 (`return NO_CHANGE(currentStatus)`)
is unreachable because the `switch` is exhaustive over a discriminated union. Either add
a TypeScript `never` assertion or remove the branch:
```ts
default: {
  const _: never = event;  // compile-time exhaustiveness check
  return NO_CHANGE(currentStatus);
}
```

**Risk:** None either way. The `never` assertion is strictly better for maintainability.

---

### L5 — `hasDescendant` `seen` set and loop body after `return true` are unreachable

**File:** `src/statusProbe.ts:265–275` (also noted in H3)

**Current:**
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

The `return true` is the first reachable non-`continue` statement inside the loop body.
Any code after it (`stack.push(...)` for deeper traversal, if it existed) would be
unreachable. The `seen` set is checked before `return true` but is never populated
(the `seen.add(pid)` on the line before `return true` runs, but `seen` is never consulted
again). The loop only ever checks the direct children of `root`. The function is equivalent to
`(childrenOf.get(root)?.length ?? 0) > 0` — which is clearer about what it actually tests.

**Risk:** Simplification to the one-liner is safe if the intent is "root has any child"
(which it is for the Windows any-descendant rule). Noted under H3 as well.

---

## What Is Appropriately Simple Already

The following parts of the change are well-scoped and should not be second-guessed:

- **`PtyTransport` interface and `createPtyTransport` factory** — two concrete
  implementations (node-pty preferred, legacy fallback) behind a single interface is the
  minimum needed to satisfy the node-pty/fallback requirement without rewriting all call
  sites. The abstraction earns its cost.

- **`StatusProbe` interface and `selectProbe`** — single method, platform dispatch is
  a clear 3-way if/else. The injection point for tests is necessary and well-placed.
  No over-engineering here.

- **`parseProcTree` and `parseProcRecords`** — the Linux /proc parser is inherently
  detailed (the stat file format requires careful field splitting around the `comm` parens),
  but the code is laid out clearly and the helper split is appropriate.

- **`decideStatus` as a pure function** — separating the decision from timer side-effects
  is the right call and directly enables the replay harness. The function shape is clean
  given the number of event kinds it handles.

- **The replay harness structure** (`test_status_machine.ts`) — the virtual-clock
  approach is the correct way to test a debounced state machine without real timers. The
  approach is not over-engineered for what it tests.

- **`sawWorkSinceIdle` gate** — the two-variable pattern (`sawWorkSinceIdle` in
  `terminal.ts`, mirrored in the harness) is the minimal way to distinguish a "freshly
  spawned shell settling to a prompt" from a "real command that ran and finished."
  The flag earns its complexity.

- **`PtySpawnOptions` struct** — grouping `cwd/env/cols/rows` into a named type is
  strictly cleaner than a 4-argument function signature.

---

## Summary Table

| # | Priority | File(s) | Finding | Behavior change? |
|---|----------|---------|---------|-----------------|
| H1 | High | `statusMachine.ts:143–164` | `idleTimer` case is unconditionally `setIdle()`; `runtimeType`/`lastLineIsPrompt` branches are dead | No |
| H2 | High | `statusMachine.ts:20`, `server.ts:11,422` | `SHELL_PROMPT` exported from machine file but used for an independent purpose in server; cross-module coupling | No |
| H3 | High | `statusProbe.ts:74–93,161–174,211–232,265–275` | Three inline tree-walk copies; `hasDescendant` loop is effectively dead after the first child | Low risk |
| M1 | Med | `statusProbe.ts:344–357` | `FallbackProbe` class is a stateless no-op; object literal suffices | No |
| M2 | Med | `terminal.ts:6,167,422` | `usingNodePty` public field is set but never read; `nodePtyAvailable` import is unused | No |
| M3 | Med | `ptyTransport.ts:137–145` | Legacy transport fires `exitCbs` up to 3x per termination without deduplication | No (currently idempotent) |
| M4 | Med | `statusProbe.ts:235–262` | CIM Key=Value parser branch is unreachable in production (probe always requests CSV) | Only for unused paths |
| M5 | Med | `terminal.ts:280–316`, `test_status_machine.ts:54–98` | `sawWorkSinceIdle` P0-2 logic duplicated verbatim in prod and replay harness | No |
| L1 | Low | `statusProbe.ts:191` | `return haveComm ? true : false` → `return haveComm` | No |
| L2 | Low | `statusMachine.ts:59–61` | `lastLineIsPrompt` is a pointless one-liner wrapper | No |
| L3 | Low | `statusProbe.ts:284` | Late `require("fs")` inside a method; should be a top-level import | No |
| L4 | Low | `statusMachine.ts:166` | `default:` branch in exhaustive switch is unreachable; add `never` assertion | No |
| L5 | Low | `statusProbe.ts:265–275` | `hasDescendant` `seen` set and everything after `return true` is dead code | No |
