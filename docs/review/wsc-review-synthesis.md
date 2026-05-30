# WS-C Busy/Idle Status Detection — Review Synthesis

**Commit:** `d641547`. **Inputs:** three lensed reviews (ACCURACY, SIMPLICITY,
MAINTAINABILITY) + the design (`wsc-status-design.md`) and stage-3 review
(`wsc-stage3-review.md`). **Mode:** read-only; this synthesis drives the next fix round.
The two stage-3 P0s (interactive_cli permanent-busy; fallback `onIdle` suppression) and the
stage-3 P1 (`wmic`→PowerShell) / P2s (TDZ, `last_command` redaction) are **confirmed already
fixed in this commit** and are NOT re-opened here.

---

## 1. Executive summary

The WS-C change is **structurally healthy and correct for Linux/macOS shell panes**, with a
genuinely-tested pure-function seam (`parseProcTree`/`parsePsTree`/`parseProcessList`/
`decideStatus`) and good timer hygiene. The Linux `/proc` resting-shell rule (`pid==pgrp==tpgid`)
is verified correct against a real node-pty tree, and the two stage-3 P0s are fixed.

**The single most important thing to fix:** the **Windows shell-pane "busy forever" defect**
(accuracy P1). On the stated #1 platform, an interactive Custom (`shell`) pane is spawned as
`cmd.exe /c cmd.exe`, so the inner interactive `cmd` is a permanent live descendant of the PTY
root; the Windows probe's `hasDescendant` "any-descendant ⇒ busy" rule therefore reports the pane
`Running` forever, never debounces to Idle, and never fires `onIdle`. The stage-3 P0-1
`runProbeTick` gate downgrades only `interactive_cli` panes — Windows `shell` panes still receive
the authoritative any-descendant probe. **I verified this with the real parser** (see §below).
This is the same defect class P0-1 fixed for agents, left unfixed for Windows shells. Everything
else is correctness-neutral polish (dead code, dedup, naming).

### Load-bearing verifications (code-grounded)

- **(a) Windows shell "busy forever" — CONFIRM (P1).**
  - `runProbeTick` (`terminal.ts:354-357`) downgrades to fallback **only** for
    `runtimeType === "interactive_cli"`; a Custom pane is `runtimeType === "shell"`
    (`terminal.ts:190`) and falls through to the authoritative probe (`:358-364`).
  - Windows probe uses `hasDescendant` = any-descendant ⇒ busy (`statusProbe.ts:265-275`,
    via `parseProcessList:232`). It is NOT foreground-aware (unlike Linux/macOS).
  - node-pty Windows spawn is `cmd.exe /c <finalCommand>` (`ptyTransport.ts:197-200`); a Custom
    pane's `finalCommand` defaults to `cmd.exe` (`defaultShellCommand`, `terminal.ts:578` →
    `shellCmd` → `finalCommand` `terminal.ts:405`). So the PTY root is the outer `/c` cmd and the
    interactive inner cmd is a permanent resting descendant.
  - **Verified with the real parser:** `parseProcessList("…cmd.exe,500,100 / cmd.exe,100,200", 100)
    === true` (busy) for a resting `cmd /c cmd` tree. The committed test
    `tests/test_status_parsers.ts:184-194` demonstrates the same `true` result but frames it only
    as the agent case — it is *also* the unfixed shell case.
  - Ruling: **genuine P1 on the #1 platform.** The review is accurate, not overstated. (Minor
    nuance: it relies on the Windows runtime keeping the inner `cmd` alive interactively under
    `/c`, which is the real ConPTY behavior; sound by construction.)

- **(b) Dead `idleTimer`/`SHELL_PROMPT` prompt-gating branch — CONFIRM (flagged by all 3).**
  In `decideStatus` (`statusMachine.ts:155-161`), the `runtimeType === "shell"` branch returns
  `setIdle()` **in both arms** — with a prompt (`:157`) and without (`:160`) — and the
  `interactive_cli` arm (`:163`) also returns `setIdle()`. `lastLineIsPrompt(recentTail)` has no
  effect on the decision; the `runtimeType` dispatch is inert. The doc/comment overstates a
  "quiescence + narrowed prompt" gate that the code does not enforce. Behavior is correct
  (quiescence-only idle, "no worse than today"), so impact is **maintainability, not correctness**.

- **(c) `usingNodePty` tracked-but-never-used — CONFIRM (maintainability H1 / simplicity M2).**
  `usingNodePty` is set in `start()` (`terminal.ts:422`) but never read for any branch.
  `statusProbe` is selected at construction (`terminal.ts:192`) independently of transport, and
  `runProbeTick` consults `runtimeType`/platform, never `usingNodePty`. The `nodePtyAvailable`
  import (`terminal.ts:6`) is unused. **The legacy path does NOT downgrade probe confidence as the
  comments (`terminal.ts:166`, `ptyTransport.ts:14-15`) claim.** Real behavior on Linux legacy
  transport: node-pty unavailable → `LegacyChildProcessTransport` spawns `script -q -f -c <cmd>
  /dev/null` (`ptyTransport.ts:216-221`); the constructor-selected `LinuxProcProbe` still runs and
  still returns `confidence:"authoritative"`, probing the `script` process tree as the root. So the
  pane keeps authoritative-driven idle on the legacy path rather than the documented graceful
  fallback. **Impact nuance:** this is a broken-comment / latent-correctness trap, NOT an active
  bug today — node-pty is confirmed loadable in the target env, so the legacy path is never taken
  in practice and is entirely untested. Rank P2 (correctness-adjacent), not P1.

  > Judgment call: the two suggested remediations diverge. Maintainability H1 says **wire
  > `!usingNodePty` → `FallbackProbe`** (make the comment true). Simplicity M2 says **delete the
  > field + comment** (the probe already self-reports fallback on `execSync` failure). Given the
  > legacy path probes `script` (not a real shell-rooted PTY) and its tree shape is unvalidated, the
  > **safer call is maintainability H1's wiring** — degrade to quiescence when on the legacy
  > transport — *plus* a test. Pure deletion leaves an unproven authoritative probe running over a
  > `script` root. See §5.

---

## 2. Consolidated, de-duplicated findings table

Severity judged by real impact: Windows is the #1 platform; correctness > polish. "Reviewers"
notes convergence.

| ID | Title | Sev | Reviewers | file:line | Recommended action |
|----|-------|-----|-----------|-----------|--------------------|
| **C1** | Windows `shell` pane reads busy forever (`cmd /c cmd` + any-descendant rule; P0-1 gate misses `shell`) | **P1** | Accuracy P1 (stage-3 noted the agent half only) | `statusProbe.ts:265-275`,`210-263`; `ptyTransport.ts:197-200`; `terminal.ts:354-357` | Make the Windows probe foreground-aware (count non-shell descendants / detect resting shell leaf via `Name`/`SHELL_COMMS`). **Short term:** extend the `runProbeTick` gate so Windows `shell` panes also downgrade to fallback/quiescence until the foreground-aware rule lands. Add a `parseProcessList` test asserting resting `cmd/c cmd` ⇒ `false`. |
| **C2** | `usingNodePty` set but never consulted; legacy transport does NOT downgrade confidence; comments lie | **P2** | Maint H1, Simpl M2, Maint M5 (dead `nodePtyAvailable` import) | `terminal.ts:6,166-167,422`; `ptyTransport.ts:14-15` | Wire `!usingNodePty → this.statusProbe = new FallbackProbe()` in `start()` (or downgrade in `runProbeTick`), making the comment true; remove the unused `nodePtyAvailable` import. Add a legacy-path test. |
| **C3** | Windows CSV parser splits on `,` ignoring quoted fields; a comma in `Name` shifts columns → child dropped → false idle | **P2** | Accuracy P2 | `statusProbe.ts:218,223` | Drop `Name` from the `Select-Object`/`wmic` projection (only the two numeric IDs are used) **or** add RFC-4180 quote-aware split. Add a quoted-comma fixture. (Verified: returns `false`/wrongly-idle.) |
| **C4** | `idleTimeoutMs < probeIntervalMs` opens a false-"done" race in authoritative mode | **P2** | Accuracy P2 | `terminal.ts` idle-timer arm vs `probeIntervalMs=500` (`:157`) | Floor effective debounce at `>= 2*probeIntervalMs` in authoritative mode, or require N consecutive no-child probes (design R4). Add a small-timeout race test. |
| **D1** | Dead `idleTimer`/`lastLineIsPrompt`/`runtimeType` branch in `decideStatus` (both arms `setIdle()`); doc overstates a prompt gate | **P2** (maint) | **All 3** (Acc P2, Simpl H1, Maint H2) | `statusMachine.ts:143-164`,`59-61` | **Decide intent.** If quiescence-only is the design: collapse to a single `return setIdle()`, delete `lastLineIsPrompt`. If prompt-gating is desired: return `NO_CHANGE` on the no-prompt shell arm (correctness change — needs a test + design update). Recommend collapse + honest doc. |
| **D2** | `SHELL_PROMPT` exported from `statusMachine.ts` but used in `server.ts` for an independent purpose; cross-module coupling | P3 | Simpl H2, Maint L2 | `statusMachine.ts:20`; `server.ts:11,422` | Move `SHELL_PROMPT` to `statusProbe.ts` (with `SHELL_COMMS`) or a `statusConstants.ts`; import in both. |
| **D3** | `server.ts` prompt label runs `SHELL_PROMPT` on the whole chunk with non-multiline `$`; any output ending in `$#%>` mislabels Idle→"prompt" | P3 (cosmetic) | Accuracy P2 (sub-point) | `server.ts:421-423` | Anchor per-line (`/m`) and test the last non-empty line. Only mislabels an already-Idle pane's attention type. |
| **D4** | Tree-walk duplicated 3× (`treeMembers` / inlined in `parsePsTree` / `parseProcessList`); will drift | P3 | Simpl H3, Maint H4 | `statusProbe.ts:74-93,161-174,211-232` | Extract one `buildChildMap`/`buildDescendantSet`; call from all three. |
| **D5** | `hasDescendant` `seen`/loop after `return true` is dead; reads like BFS but is "root has any child" | P3 | Simpl H3/L5, Maint M7 | `statusProbe.ts:265-275` | Simplify to `(childrenOf.get(root)?.length ?? 0) > 0` **only after** C1 is resolved (the Windows rule itself is what's wrong; don't bake the broken any-child rule into a tidy one-liner). |
| **D6** | `process` dead field; `spawn`/`ChildProcess` unused imports in `terminal.ts` | P3 | Maint H3 | `terminal.ts:1,136` | Remove unused imports; remove/repurpose `public process` (expose `get pid()` from transport if needed). |
| **D7** | `types.ts:PaneMeta`/`Workspace` are stale duplicates missing the 3 WS-C fields | P3 | Maint H5 | `types.ts:23-35` vs `ledger.ts:4-21` | Delete the `types.ts` copies; re-export from `ledger.ts` if needed. |
| **D8** | Legacy transport fires `exitCbs` up to 3× (error+exit+close), no dedup | P3 | Simpl M3, Maint M3 | `ptyTransport.ts:137-145` | Add a one-shot `exited` guard. Safe today (subscribers idempotent); future-proofs the contract. |
| **D9** | CIM Key=Value parser branch unreachable (probe always emits CSV) | P3 | Simpl M4 | `statusProbe.ts:235-262` | Optional: delete + comment "CSV only", or keep with a clear "not exercised" note. Low value either way. |
| **D10** | macOS no-`comm` fallback branch unreachable + untested + opposite (idle) bias | P3 | Accuracy P2 | `statusProbe.ts:176,183-191` | Delete the dead branch, or make its default busy-biased (I2) and cover it. |
| **D11** | `FallbackProbe` class is a stateless no-op | P3 | Simpl M1 | `statusProbe.ts:344-349` | Optional: object literal / `FALLBACK_PROBE` const. (Note: C2's fix re-uses this class — keep it.) |
| **D12** | `applyStatusEvent` P0-2 / `sawWorkSinceIdle` logic duplicated in prod and replay harness | P3 | Simpl M5, Maint L3 | `terminal.ts:280-316`; `test_status_machine.ts` | Extract a pure `shouldCountOutputAsWork(...)` both call. Low risk under existing tests. |
| **D13** | Magic constants unnamed/unconfigurable: `probeIntervalMs` 500, `getRecentOutput(5)`, scrollback 512KB, probe timeouts | P3 | Maint M1,M4,M8,M9 | `terminal.ts:157,292,392`; `statusProbe.ts:304,326,335` | Promote to named constants; consider wiring `probeIntervalMs` to `advanced` settings. |
| **D14** | `runtimeType` preset mapping is an undocumented binary ternary; new presets silently mis-route | P3 | Maint M6 | `terminal.ts:190` | Replace with an exhaustive `Record<toolPreset, RuntimeType>` so a new preset fails to compile until mapped. |
| **D15** | Micro-cleanups: `return haveComm` (L1), late `require("fs")` (L3), exhaustive-switch `never` (L4), invariant block comment (L1), `haveComm` system-wide scan (L6) | P3 | Simpl L1/L3/L4, Maint L1/L6 | `statusProbe.ts:191,284`; `statusMachine.ts:166` | Batch with the cleanup pass. |

---

## 3. Correctness blockers vs. polish

**MUST fix before WS-C is "done" (correctness, eyes-off safety):**

- **C1 — Windows shell busy-forever (P1).** Confirmed on the #1 platform. Until fixed, every
  Windows interactive shell pane reports "still running" forever; `onIdle`/watch-rules/plans/
  auto-summary/attention-digest never fire for them. This is the analogue of the stage-3 P0 left
  unfixed for `shell` panes.
- **C2 — legacy-transport confidence not downgraded (P2, latent).** Not an active bug (node-pty
  loads in the target env), but the legacy path silently runs an unvalidated authoritative probe
  over a `script` root and the comments claim the opposite. Fix before anyone relies on the
  documented graceful-degradation guarantee.
- **C3, C4 (P2)** — real false-idle / false-done corner cases (quoted Windows process name;
  small `idleTimeoutMs`). Lower likelihood but they violate I1/I3 when hit.

**Polish / follow-up (no behavior change, can batch):** D1 (dead branch — correct today, just
misleading), D2–D15. None of these change observable behavior except D1's *optional* enforce-prompt
variant (which would be a deliberate correctness/design change, not cleanup).

---

## 4. Recommended fix batch (ordered, concrete)

1. **C1 — Windows shell idle (do first).**
   - Short-term, low-risk: in `runProbeTick` (`terminal.ts:345-357`), extend the gate so
     `process.platform === "win32" && runtimeType === "shell"` also emits
     `{hasRunningChild:false, confidence:"fallback"}` (quiescence-driven idle) until a
     foreground-aware Windows rule exists.
   - Proper fix: make `parseProcessList`/`hasDescendant` foreground-aware — pull `Name` (already
     `Select`ed, `statusProbe.ts:322`) into the tree and treat a tree whose only live leaf is a
     known shell comm (`SHELL_COMMS`) as idle; count **non-shell** descendants for busy.
   - **Tests:** `parseProcessList` resting `cmd /c cmd` ⇒ `false`; a `runProbeTick`-level test for a
     Windows `shell` pane reaching Idle.

2. **C2 — legacy-transport downgrade.** In `start()` after `this.usingNodePty = usingNodePty`
   (`terminal.ts:422`), add `if (!usingNodePty) this.statusProbe = new FallbackProbe();` (keep the
   `FallbackProbe` class — see D11). Remove the unused `nodePtyAvailable` import (`terminal.ts:6`).
   Fix the comments at `terminal.ts:166` / `ptyTransport.ts:14-15` to match.
   **Tests:** construct a terminal with node-pty forced unavailable (inject the legacy transport or
   a `usingNodePty:false` factory) and assert quiescence drives idle / probe confidence is fallback.

3. **C3 — Windows CSV quoting.** Drop `Name` from the `Select-Object`/`wmic` projection
   (`statusProbe.ts:322,334`) since only the two numeric IDs are consumed (simplest, also helps C1
   only if C1 keeps `Name` — sequence C1 first, then decide). Otherwise add a quote-aware split.
   **Test:** fixture with `"weird,name.exe"` ⇒ child still detected.

4. **C4 — idle-debounce floor.** In the idle-timer arm (`terminal.ts:322-328`) use
   `Math.max(idleTimeoutMs, 2*probeIntervalMs)` in authoritative mode, or require N consecutive
   no-child probes (design R4). **Test:** `idleTimeoutMs=200` does not produce a spurious `onIdle`.

5. **D1 — collapse the dead branch.** Replace `statusMachine.ts:143-164` shell/interactive arms
   with a single `return setIdle()`; delete `lastLineIsPrompt` (`:59-61`) and update the comment /
   design to state plainly "fallback idle is quiescence-only." (If the team instead wants the
   prompt gate, that is a separate correctness change with its own test — do not silently keep the
   inert scaffolding.)

6. **Cleanup pass (D2, D4, D5, D6, D7, D8, D12, D13, D14, D15):** move `SHELL_PROMPT`; extract one
   tree-walk helper and use it in all three sites; simplify `hasDescendant` (only after C1);
   remove dead imports/`process` field; de-dupe `types.ts`; one-shot legacy exit guard; extract
   `shouldCountOutputAsWork`; name the magic constants; exhaustive preset `Record`.

7. **D3 — server prompt label:** anchor `SHELL_PROMPT` per-line (`/m`) and match the last non-empty
   line (`server.ts:421-423`).

### Coverage gaps to close (from the accuracy review — currently ZERO direct tests)

- `runProbeTick` gating (authoritative vs downgrade per `runtimeType`/platform) — exactly where C1
  lives. Add a Windows `shell` and `interactive_cli` gate test.
- `applyStatusEvent` on the real `UniversalTerminal` (the replay harness only re-implements it).
  Add one integration test driving the real method + real (or faked) timers end-to-end.
- Legacy-transport (node-pty-unavailable) path — never exercised (C2).
- Windows CSV quoting (C3), macOS no-`comm` branch (D10), small-`idleTimeoutMs` race (C4).

---

## 5. Disagreements / nuance (with my call)

- **`usingNodePty`: wire vs delete (Maint H1 vs Simpl M2).** **Call: wire (Maint H1) + test.** The
  legacy path probes a `script` root whose tree shape is unvalidated and authoritative; deleting
  the field leaves that unproven probe live. Downgrading to fallback on `!usingNodePty` honors the
  design's I5 graceful-degradation guarantee and makes the lying comment true. Keep `FallbackProbe`
  (so reject the part of Simpl M1 that would delete the class — C2 needs it).

- **Is the `PtyTransport`/`StatusProbe` abstraction over-built (Simplicity) or appropriately
  extensible (Maintainability)?** **Call: appropriately extensible — do NOT collapse it.** Both
  reviewers actually *agree* here: the simplicity review's "What Is Appropriately Simple Already"
  section explicitly blesses both interfaces and factories as earning their cost (two real
  transports; platform-dispatched probe; the DI seam is what makes the Windows logic testable
  without a Windows runtime). The only YAGNI nits inside are `FallbackProbe`-as-class (M1) and the
  CIM Key=Value branch (M4/D9) — both minor and the former is now load-bearing for C2.

- **D5 `hasDescendant` one-liner.** Simplicity/maintainability both want to reduce it to
  `(childrenOf.get(root)?.length ?? 0) > 0`. **Call: do it only AFTER C1.** The any-child rule is
  the *cause* of the Windows defect; baking it into a tidy one-liner before fixing the rule would
  enshrine the bug. If C1's proper fix makes the Windows probe foreground-aware, this helper changes
  shape anyway.

- **D1 enforce-prompt vs collapse.** Accuracy and Simplicity lean "collapse (it's correct today,
  comment is wrong)"; Maintainability offers both. **Call: collapse + honest doc.** The design's
  "prompt-gated idle" never shipped and there is no evidence quiescence-only is wrong; adding a real
  gate now would *reduce* idle detection for fallback shells with no demonstrated benefit.

---

## 6. What to explicitly NOT do (over-corrections to avoid)

- **Do NOT** simplify `hasDescendant` to the one-liner before fixing C1 (enshrines the Windows bug).
- **Do NOT** delete `FallbackProbe` (Simpl M1) — C2's fix re-uses it.
- **Do NOT** add a real prompt-gate to `decideStatus` (the "enforce" variant of D1) as if it were
  cleanup — it is a behavior change that *reduces* fallback idle detection with no demonstrated need.
- **Do NOT** re-open the stage-3 items already fixed in this commit (interactive_cli permanent-busy
  P0-1; fallback `onIdle` P0-2; `wmic`→PowerShell P1; `stop()` TDZ; `last_command` redaction).
- **Do NOT** collapse the `PtyTransport`/`StatusProbe` abstractions — both lenses agree they earn
  their cost and they are the testability seam.
- **Do NOT** over-invest in the CIM Key=Value branch (D9) or macOS no-`comm` branch (D10): they are
  unreachable; a delete-or-comment is enough — don't build fixtures/hardening for dead paths beyond
  a single guard test if kept.
