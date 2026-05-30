# OrbitalVoiceRunner — Busy/Idle Status Detection Redesign

**Author:** Expert 1 (Architecture/Design)
**Status:** DESIGN ONLY — no source edits. Build-ready spec for the implementer.
**Scope:** Replace the unreliable busy/idle heuristic (BUG-006) with a platform-aware
status state machine. Windows-first, then Linux, then macOS.

---

## Executive Summary (~10 lines)

- **Problem:** Status is driven by a 1–2s silence timer + an over-broad prompt regex
  (`src/terminal.ts:222-255`, `:229`). Any line ending in `$ # > ?` flips to Idle, and any
  command silent for `idleTimeoutMs` reads Idle. This causes false "done" reports to the
  eyes-off operator and premature watch-rule/plan firing. The system has never been run, so all
  current behavior is unproven (BUG-038: zero behavioral coverage).
- **Primary mechanism — all platforms: adopt a unified PTY layer via
  `@homebridge/node-pty-prebuilt-multiarch`**, replacing both `cmd.exe /c` (Windows, `:302-304`)
  and UNIX `script` (`:305-316`). This gives Windows a real ConPTY (today it has none) and a
  uniform process-tree to probe. I verified in this Linux container that the prebuilt installs
  with `exit=0` and spawns a working PTY shell (no native compile needed) — see §6.
- **Authoritative busy/idle signal — process-state probe** of the PTY's child process tree:
  Linux `/proc/[pid]/stat` (+ descendant/foreground-pgid), macOS `ps`/`libproc`, Windows
  job-object/child-count + ConPTY. **Output quiescence and a narrowed prompt regex are
  demoted to a conservative fallback only.**
- **Correctness bar:** never report Idle/done while a child command runs. The state machine is
  **busy-biased**: any positive "still running" signal wins; Idle requires *both* quiescence
  *and* no running foreground child (or, in fallback mode, quiescence + a prompt on an otherwise
  empty line + honored `idleTimeoutMs`).
- **Dependency go/no-go: GO** for `@homebridge/node-pty-prebuilt-multiarch`, gated behind a
  runtime `try/require` with graceful degradation to the current `script`/`cmd.exe` path +
  fallback regex, so no platform ends up worse than today even if the native module fails to load.
- **Data model:** add `last_status_change_at`, `last_command`, and derived `elapsed_ms` to
  `PaneMeta`, surface them in `list_panes` + the attention digest (BUG-025), and **remove the
  frozen live-status snapshot from the static `systemInstruction`** (BUG-022, `server.ts:1590`).
- **Biggest risk:** the native module fails to load on a target Windows host (Electron ABI / AV
  quarantine / missing VC runtime). Mitigated by the injectable probe + `script`/`cmd.exe`
  fallback and by the replay harness, which tests the state machine as a pure function with the
  platform probe dependency-injected — Windows logic is validated without a Windows runtime.

---

## 1. Goal & Invariants

### Definitions
- **busy (`is_busy = true`):** the pane is actively executing a foreground command/agent turn —
  i.e. there exists a live child of the PTY's shell/agent process that is the controlling
  foreground job, OR (fallback) output is still flowing and no input prompt is present.
- **idle (`is_busy = false`, `alive = true`):** the pane process is alive and waiting for input —
  the PTY shell/agent is at rest with no running foreground child (or, fallback: output has been
  quiescent for `idleTimeoutMs` AND the last non-empty line is an input prompt on an otherwise
  empty line).
- **exited (`alive = false`):** the PTY process emitted a real `exit`/`close`/`error`. This is
  already correct (`src/terminal.ts:370-381`) and is **kept verbatim** — it is the one signal
  that is reliable today.

### Invariants (the eyes-off correctness bar)
1. **I1 — No false done.** The system MUST NOT transition Running→Idle (and MUST NOT fire
   `onIdle`, watch rules, plans, or the auto-summary at `server.ts:226-252`) while a foreground
   child command is running. Idle is a claim of completion; a wrong claim is the worst failure.
2. **I2 — Busy is sticky / busy-biased.** When signals conflict, busy wins. Idle is only declared
   when the *authoritative* probe says no running child, or — in fallback-only mode — when *both*
   quiescence and prompt conditions hold.
3. **I3 — Monotonic, debounced transitions.** Every status change stamps `last_status_change_at`.
   Idle is debounced by `idleTimeoutMs` (honored, not hardcoded). Rapid Running↔Idle flapping is
   not allowed to fire downstream effects more than once per real transition.
4. **I4 — No stdin corruption.** Detection MUST NOT write sentinels/markers to a pane's stdin if
   the pane runs a full-screen interactive TUI (Claude Code, Codex). Sentinel injection, if used
   at all, is gated to `runtime_type === "shell"` panes only (see §3, fallback tier C).
5. **I5 — Graceful degradation.** If the platform probe or native PTY is unavailable, the pane
   falls back to a *narrowed* quiescence+prompt heuristic that is **no worse than today**, and
   never silently claims a stronger guarantee than it has.
6. **I6 — Preserve verified-solid behavior.** Concurrent spawn, atomic ledger
   (`src/ledger.ts:81-127`), `alive` via real process events, ANSI stripping
   (`src/terminal.ts:56-60`) and secret redaction (`:71-123`) are unchanged.

---

## 2. Per-Platform Detection Mechanism

The current split — `cmd.exe /c <command>` on Windows (`src/terminal.ts:302-304`) vs UNIX
`script` (`:305-316`) — is replaced by **one PTY layer** with a **platform-specific process-state
probe** behind a single interface. Recommendation: **move to a unified PTY layer** (see §2.4).

### 2.0 The probe interface (the seam)

```ts
// New file: src/statusProbe.ts  (pure, injectable, platform-dispatched)
export type ProbeResult = {
  hasRunningChild: boolean;   // authoritative "busy" signal; null-ish => unknown
  confidence: "authoritative" | "fallback";
};
export interface StatusProbe {
  // shellPid = the PTY's shell/agent root pid. Returns whether a foreground
  // child command is currently running under it.
  probe(shellPid: number): ProbeResult;
}
```

The state machine (§3) consumes `ProbeResult` plus output events. The probe is selected once at
startup by `process.platform` and is **dependency-injected** so tests can supply a fake (§7).

### 2.1 Windows (PRIORITY 1)

**Current state:** `cmd.exe /c <finalCommand>` (`src/terminal.ts:302-304`). This is *not* a PTY:
it runs one command and exits, so `stdin` interactivity and prompt rendering are impossible, and
prompt-based detection cannot work at all. Windows is effectively broken today.

**Decision: adopt ConPTY via `@homebridge/node-pty-prebuilt-multiarch`.** node-pty wraps the
Win10+ ConPTY API (`winpty` fallback on older OS). This gives a real interactive console the
agent CLIs need, and a stable process root to probe.

**Busy/idle determination on Windows (no `/proc`):**
- **Authoritative (primary):** the PTY's shell root process is wrapped in a **Windows Job Object**;
  busy = "the job/process tree contains a live child process other than the shell root itself."
  node-pty exposes the root `pid`; child enumeration uses `wmic`/`Get-CimInstance Win32_Process`
  (parent-pid walk) or `ps-list`. If exactly the shell root is alive ⇒ idle; if a descendant
  command process is alive ⇒ busy. This is the Windows analogue of "foreground child running."
- **child-exit:** ConPTY/node-pty `onExit` ⇒ exited (maps to the existing exit/close handler).
- **Output quiescence + narrowed prompt regex:** fallback only (tier B/C, §3), e.g. `C:\...>` for
  `cmd`, `PS C:\...>` for PowerShell, on an otherwise-empty line.

We do **not** rely on `/proc`. We do **not** inject sentinels into agent TUIs (I4).

**Validation without a Windows runtime (TEST ENV IS LINUX-ONLY):** the Windows probe is a pure
function `parseProcessList(rawWmicOutput, shellPid) -> hasRunningChild`. We unit-test it against
**captured/synthetic `wmic`/CIM output fixtures** (idle prompt vs running `npm run build`), and
the state machine is tested with the probe injected (§7). ConPTY itself is reviewer-verified
by-construction (node-pty is a widely-used, audited wrapper); we add a CI job stub for Windows
(`runs-on: windows-latest`) that the maintainer can enable, but green Linux CI does not depend on
it.

### 2.2 Linux

**Decision: `/proc/[pid]/stat` foreground-child probe (authoritative).**
- Read `/proc/[shellPid]/stat` and walk descendants (or read the tty's foreground process group
  via the shell's controlling terminal). busy = "a descendant of the PTY shell other than the
  shell itself is in state `R`/`D`/`S` and is the foreground job"; idle = "only the shell remains,
  parked reading input (`S`)."
- Concretely: enumerate `/proc/*/stat`, build the parent→child tree rooted at `shellPid`
  (field 4 = `ppid`), and check for any descendant whose `pid != shellPid`. A bare interactive
  shell at the prompt has **no command child**; a running command does. This sidesteps the
  ambiguity of shell state alone (an idle bash is `S`, but so is a sleeping child).
- This probe is `/proc`-confirmed available in this container (`/proc/self/stat` readable; field
  parse verified). `pidusage` (already a dependency, `package.json:21`) reads `/proc` and can be
  reused for liveness, but tree-walking is done directly for the child-presence signal.
- **Rejected for primary:** prompt sentinel (violates I4 for agent TUIs), output quiescence
  (the BUG-006 root cause — long silent builds read Idle).

### 2.3 macOS

**Decision: `ps`-based foreground-child probe (authoritative), equivalent to Linux.**
- No `/proc`. Use `ps -o pid=,ppid=,stat= -ax` (or `proc_pidinfo`/`libproc` if a native helper is
  ever added) to build the same parent→child tree rooted at the PTY shell pid; same idle/busy
  rule as §2.2. `ps` is universally present; no extra dependency.
- The `script -q /dev/null ...` macOS quirk (`src/terminal.ts:309-311`) disappears once we move to
  node-pty (single spawn path), removing a platform-specific footgun.

### 2.4 Keep `script` or unify? — **Unify, with `script`/`cmd.exe` as the fallback transport.**

Move to a single PTY layer (node-pty) for the spawn transport on all platforms. Rationale:
- It is the *only* way to give Windows a real PTY (the stated #1 priority).
- It collapses three spawn code paths (`:302-316`) into one, removing the macOS `script` arg
  quirk and the Windows non-PTY defect in one change.
- The process-state probe needs a single, well-defined process root (the PTY shell pid); node-pty
  gives exactly that on every platform.

**Back-compat seam:** the PTY transport is abstracted behind a `PtyTransport` interface with two
implementations: `NodePtyTransport` (preferred) and `LegacyChildProcessTransport` (the current
`spawn("script"|"cmd.exe", …)` code, lifted verbatim from `:302-325`). Selection is a single
`try { require(node-pty) } catch { legacy }` at startup (I5). The legacy transport keeps the
fallback heuristic (§3 tier C) so degradation is graceful and never worse than today.

---

## 3. Unified Detection Design — one status state machine

A single state machine per pane consumes whatever signals the platform provides, in a strict
priority order. Implemented as a pure-ish method replacing `updateStatusOnOutput`
(`src/terminal.ts:222-255`); the timer-arming side effects stay in the class but the
**decision** is a pure function for testability (§7).

### Signal tiers (highest priority wins — busy-biased per I2)

- **Tier 0 — Lifecycle (authoritative, already correct):** PTY `exit`/`close`/`error`
  (`src/terminal.ts:370-381`) ⇒ `Exited`. Terminal and immune to all lower tiers.
- **Tier A — Process-state probe (authoritative):** `StatusProbe.probe(shellPid)` (§2).
  - `hasRunningChild === true` ⇒ `Running` (cancel any pending idle timer).
  - `hasRunningChild === false` ⇒ eligible for `Idle`, but still debounced by `idleTimeoutMs`
    to avoid flapping between two quick commands.
  - The probe runs on a short interval (e.g. 500ms) **and** is kicked on each output chunk and on
    each `writeInput` (an input is a strong "about to be busy" hint — arm Running optimistically).
- **Tier B — Output quiescence (fallback signal, not a done-claim):** used only when the probe is
  `confidence: "fallback"` (probe unavailable/unknown). Quiescence = no output for
  `idleTimeoutMs`. By itself it NEVER claims Idle for a probe-capable pane.
- **Tier C — Narrowed prompt regex (fallback only, gated):** replaces the over-broad
  `:229` pattern. New pattern matches a prompt **only on an otherwise-empty trailing line**, not
  any line that happens to end in punctuation:

  ```ts
  // Anchored: the ENTIRE last line is a shell prompt, optionally followed by cursor.
  // Note ^…$ on the final line (multiline), not a loose "ends in $#>?" test.
  const SHELL_PROMPT = /(^|\n)[^\n]{0,80}?[\$#%>]\s?$/;  // narrowed; shell panes only
  ```

  Tier C is applied **only when `runtime_type === "shell"`** (I4 — never for Claude Code/Codex
  TUIs, whose `runtime_type === "interactive_cli"`). For interactive_cli panes in fallback mode,
  Idle is driven by quiescence + probe-absence only, never by prompt regex, and the system is
  explicit that this is a lower-confidence signal.

### Decision order (pseudocode for the replacement of `updateStatusOnOutput`)

```
on signal (output chunk | probe tick | writeInput):
  if status == Exited: return
  if probe.confidence == "authoritative":
     if probe.hasRunningChild: setRunning()           # I2
     else: armIdleTimer(idleTimeoutMs)                # debounce, then setIdle()
  else:  # fallback
     if outputJustArrived: setRunning(); armIdleTimer(idleTimeoutMs)
     on idleTimer fire:
        if runtime_type == "shell" and lastLineIsPrompt(): setIdle()
        elif quiescentFor(idleTimeoutMs): setIdle()    # no-worse-than-today
setRunning()/setIdle() stamp last_status_change_at and fire onIdle ONLY on real Running->Idle.
```

`onIdle` (and thus watch rules / plans / auto-summary) fires **only** on a genuine
authoritative-or-debounced Running→Idle edge, fixing premature firing.

---

## 4. Data-Model Additions

### 4.1 `PaneMeta` (`src/ledger.ts:4-16`) — add three fields

```ts
export interface PaneMeta {
  // …existing fields unchanged…
  context_size: number;
  last_status_change_at?: string;   // ISO timestamp of last Running/Idle/Exited transition
  last_command?: string;            // most recent command written (from writeInput/history)
  elapsed_ms?: number;              // derived at read time: now - last_status_change_at
}
```

All three are **optional** so existing persisted ledgers load unchanged (`src/ledger.ts:40-53`).

### 4.2 Populate in the terminal + `syncLedger`
- `UniversalTerminal` gains `lastStatusChangeAt: number` and `lastCommand: string`, set by the
  state machine and by `writeInput` (`src/terminal.ts:384-388`).
- `syncLedger` (`src/terminal.ts:636-663`) writes `last_status_change_at`, `last_command`, and a
  freshly-computed `elapsed_ms = Date.now() - term.lastStatusChangeAt` into the `PaneMeta` it
  already builds at `:646-658`.

### 4.3 Surface in `list_panes` + attention digest (BUG-025)
- `list_panes` already returns `Object.values(ws.panes)` (`src/terminal.ts:629`), so the new
  fields flow through automatically once in `PaneMeta`. Update the tool description at
  `server.ts:1601-1602` to mention `elapsed_ms`/`last_command` so Janus can say *"build pane has
  been running 4 minutes."*
- `get_attention_digest` (`server.ts:1370-1383`): include elapsed time and `last_command` in the
  spoken text, e.g. *"Pane build has been busy 4 minutes running `npm run build`."*

### 4.4 Remove frozen live-status snapshot from system instruction (BUG-022)
`server.ts:1590` interpolates `t.status` and the live pane list **once at session creation**, so
it freezes and goes stale immediately. **Fix:** strip the `Live Terminal Panes: …${t.status}…`
clause from the static `systemInstruction` and instead instruct Janus to call `list_panes` for
live status. Keep the static routing context (active project, workspace names) since those are
stable; only the per-pane *status* must come from the live tool, never the frozen string.

---

## 5. Exact Integration Points & Back-Compat

| Location | Change |
|---|---|
| `src/terminal.ts:139-143` | Keep `idleTimer`, `idleTimeoutMs`; add `statusProbe: StatusProbe`, `probeTimer`, `lastStatusChangeAt`, `lastCommand`, `runtimeType`. |
| `src/terminal.ts:222-255` (`updateStatusOnOutput`) | Replace body with the §3 state machine. Decision logic extracted to a pure `decideStatus(inputs)` function for replay tests. Remove the over-broad `:229` regex; introduce narrowed gated `SHELL_PROMPT`. |
| `src/terminal.ts:286-334` (`start`) | Replace `spawn("script"\|"cmd.exe", …)` with `PtyTransport` (node-pty preferred, legacy fallback). Capture the shell root pid for the probe. Start the 500ms `probeTimer`. Keep `loadScrollback`, scrollback append, ANSI strip, `checkForSessionId`, `onOutput` wiring (`:336-368`) **unchanged** — they consume the PTY data stream the same way. |
| `src/terminal.ts:370-381` (exit/close/error) | Unchanged in semantics; map node-pty `onExit` to the same `status="Exited"`. Clear `probeTimer` on exit. |
| `src/terminal.ts:384-388` (`writeInput`) | Set `lastCommand`; optimistically `setRunning()` + kick the probe (an input means a turn is starting). |
| `src/terminal.ts:394-442` (`stop`) | Clear `probeTimer` alongside `idleTimer`. node-pty `.kill()` replaces `process.kill(-pid,…)`; keep SIGTERM→SIGKILL escalation semantics. |
| `src/terminal.ts:636-663` (`syncLedger`) | Add the three new `PaneMeta` fields. `is_busy`/`alive`/`last_known_state` mapping unchanged. |
| `src/ledger.ts:4-16` | Add the three optional fields (§4.1). |
| `server.ts:1590` | Remove frozen per-pane status from `systemInstruction` (§4.4). |
| `server.ts:1370-1383` | Enrich digest with elapsed/last_command. |
| `server.ts:385-454` (`detectAndTriggerTransitions`) | Keep the error/build-failed content classifiers (orthogonal to busy/idle). Its `:414` prompt regex (the `Idle→prompt` branch) is replaced with the same narrowed gated `SHELL_PROMPT`; the `else => "idle"` branch (`:419`) now defers to `term.status` rather than re-deriving idle from a content chunk. |

### Back-compat with existing tests
- **`tests/test_terminal_manager.ts`** asserts a manual `term.status = "Running"/"Idle"` →
  `syncLedger` mapping (`:18-32`). It sets `status` directly and never exercises the heuristic, so
  it **stays green unchanged** — the `is_busy`/`last_known_state` mapping at
  `src/terminal.ts:650-651` is preserved. (New fields are additive and optional.)
- **`tests/test_server.ts`** asserts `is_busy` is a boolean, `alive === true`, and
  `last_known_state` is truthy (`:84-86`), plus `echo`/`writeInput` capture and pane summary.
  These remain valid under node-pty (PTY still captures `echo` output; verified bash-in-PTY works
  in this container). The `writeInput` test (`:40-53`) uses a real shell — node-pty makes this
  *more* reliable than `script`. **Justified change:** if node-pty is selected at runtime, the
  `should write input` test should send `\r`-style input through the PTY; assertion content
  unchanged.
- **New required coverage (closes BUG-038):** the replay harness in §7 — the heuristic currently
  has zero behavioral tests; this is the main net-new test surface.

---

## 6. Dependency Decision — **GO (gated)**

**Recommend:** add `@homebridge/node-pty-prebuilt-multiarch` as the PTY transport, behind a
runtime `try/require` with fallback.

**Evidence gathered in THIS Linux container (cwd reset between calls; absolute paths used):**
- Build toolchain present: `gcc`, `g++`, `make`, `python3` all found ⇒ even a source build of
  node-gyp modules is feasible here.
- **Prebuilt install succeeded:** `npm install @homebridge/node-pty-prebuilt-multiarch` returned
  `exit=0`, "found 0 vulnerabilities", **no native compile required** (prebuilt binary used).
- **Runtime load + real PTY verified:** spawning a `bash` PTY and writing `echo hello_pty\r`
  returned a rendered colored bash prompt
  (`…/tmp/ptytest[00m# `), proving ConPTY-equivalent PTY semantics work and the module
  loads in this environment.

**Why the `-prebuilt-multiarch` variant:** ships prebuilt binaries for common Node ABIs / arches,
minimizing the native-build risk that plain `node-pty` carries on Windows CI/end-user machines.
Alternatives considered: `@lydell/node-pty` (newer, fewer prebuilts), plain `node-pty` (highest
build risk). Recommend the homebridge prebuilt for breadth of prebuilt coverage.

**Risks & mitigations:**
- *ABI mismatch / Electron:* if the host Node/Electron ABI lacks a prebuilt and no toolchain
  exists, `require` throws. **Mitigation:** the `try/require` falls back to the legacy
  `script`/`cmd.exe` transport + fallback heuristic (I5) — no crash, no regression below today.
- *AV quarantine of the `.node` on Windows:* same fallback path applies; logged as a degraded
  capability, surfaced (the pane advertises `confidence: "fallback"`).
- *Container/CI:* verified GO here; if a future locked-down CI blocks the binary, the legacy path
  keeps tests green because the replay harness injects a fake probe (§7) and does not require a
  real PTY.

**Go/no-go: GO**, gated behind runtime detection. **Escalate to maintainer** before implementation
(per instructions) because it adds a native dependency to a project that currently has none of
this kind. If the maintainer says no-go, the fallback design (narrowed regex + quiescence +
`/proc`/`ps` probe over the existing `script` transport on UNIX) still fixes BUG-006 on Linux/mac
and leaves Windows at "no worse than today, documented as unsupported PTY."

---

## 7. Test Plan

### 7.1 Replay harness (primary, closes BUG-038)
- **Mechanism:** record real raw output chunk sequences (with ANSI) as fixtures — e.g. a long
  silent `npm run build`, an interactive `[y/N]` prompt, a Claude Code agent turn, a bare bash
  prompt return. Feed them through `decideStatus()` (the pure decision function extracted from
  `updateStatusOnOutput`) together with a **scripted `ProbeResult` timeline** and assert the
  resulting **status timeline** (array of `{t, status}`).
- **Key assertions (encode the invariants):**
  - Long-silent build with `probe.hasRunningChild=true` ⇒ stays `Running` for the whole silence
    (I1 — the exact BUG-006 failure today must now pass).
  - Output line `Building project... done? $` while probe says busy ⇒ stays `Running`
    (kills the over-broad `:229` regex).
  - Probe flips to `hasRunningChild=false` + `idleTimeoutMs` elapsed ⇒ exactly one Running→Idle,
    exactly one `onIdle` (I3).
  - Interactive_cli pane in fallback mode never Idles on a prompt-looking line (I4).
- Fixtures live under `tests/fixtures/status/*.jsonl`; harness is a new `tests/test_status_*.ts`
  run by the existing `tsx --test tests/*.ts` (`package.json:10`).

### 7.2 Validating Windows logic without a Windows runtime
- **Pure-function seam:** the Windows probe is `parseProcessList(rawCimOutput, shellPid)`. Unit-
  test it against captured/synthetic `Get-CimInstance Win32_Process` / `wmic` text fixtures:
  one "idle prompt" snapshot (only shell root alive) ⇒ `hasRunningChild=false`; one "running
  `npm run build`" snapshot ⇒ `hasRunningChild=true`.
- **Dependency injection:** the state machine takes `StatusProbe` as a constructor/param dep, so
  tests inject a fake `WindowsProbe` whose `probe()` returns scripted results — the *decision
  logic* is exercised identically to Linux without ConPTY.
- **Optional Windows CI stub:** a `runs-on: windows-latest` job that smoke-tests node-pty load
  and one `dir` capture; **not** a gate for Linux CI (the maintainer enables it). Documented as
  reviewer-verified-by-construction otherwise.

### 7.3 Linux/macOS probe tests
- Linux: spawn a known sleeper under a PTY, assert `probe(shellPid).hasRunningChild===true` while
  it runs and `false` after; verified `/proc/[pid]/stat` parse against `/proc/self/stat` shape.
- macOS: same with a `ps`-output fixture parser unit test (no mac runtime needed for the parser).

### 7.4 Regression guards
- Keep `tests/test_terminal_manager.ts` and `tests/test_server.ts` green (§5). Add an assertion
  that `last_status_change_at` is set after a transition and that `is_busy` never reports `false`
  while the injected probe reports a running child.

---

## 8. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | node-pty native module fails to load on a target host (ABI/AV/no toolchain). | Med | High | `try/require` → legacy `script`/`cmd.exe` transport + fallback heuristic (I5). Pane advertises `confidence:"fallback"`. Verified GO in this container. |
| R2 | False-Idle persists (the BUG-006 failure) if probe is wrongly trusted as fallback. | Med | High (I1) | Busy-biased state machine (I2): authoritative probe required to declare Idle; quiescence alone never claims done. Replay test asserts the long-silent-build case. |
| R3 | Sentinel/marker corrupts an interactive agent TUI. | Low | High | No sentinels in the primary design. Tier-C prompt regex gated to `runtime_type==="shell"` only (I4). |
| R4 | Process-tree walk races a just-forked child (probe says idle during fork). | Med | Med | Debounce Idle by `idleTimeoutMs`; treat `writeInput` as optimistic Running; require N consecutive idle probes before Idle. |
| R5 | Moving off `script`/`cmd.exe` regresses output capture or `stop()` teardown. | Med | High | `PtyTransport` interface keeps legacy path verbatim; map node-pty `onExit`→existing handlers; preserve SIGTERM→SIGKILL escalation. Existing capture tests guard this. |
| R6 | Frozen-status removal changes Janus phrasing/behavior. | Low | Med | Janus already has `list_panes` (`server.ts:1601`); description updated to instruct live querying. Static routing context retained. |
| R7 | Performance: per-pane 500ms probe + `/proc` scan across many panes. | Low | Low | Single shared scan tick across panes; reuse `pidusage` where possible; interval tunable. |
| R8 | New native dep added to a no-native-dep project without maintainer sign-off. | — | Med | Explicit GO-but-escalate (§6); fallback design works without the dep. |

---

## Appendix — Cited code locations
- Broken heuristic: `src/terminal.ts:222-255`, over-broad regex `:229`; duplicate at `server.ts:414`.
- Windows non-PTY defect: `src/terminal.ts:302-304`. UNIX `script`: `:305-316`.
- Reliable lifecycle/exit (keep): `src/terminal.ts:370-381`. ANSI strip: `:56-60`. Redaction: `:71-123`.
- `idleTimeoutMs` default/plumbing: `src/terminal.ts:143`, `:489`, `:548-552`, `:607`.
- `syncLedger` mapping: `src/terminal.ts:636-663` (state→`is_busy`/`alive` at `:650-651`).
- `PaneMeta`: `src/ledger.ts:4-16`. Atomic save: `:81-127`. `updatePane`: `:192-199`.
- `list_panes`: `src/terminal.ts:623-633` + `server.ts:1231-1235`, decl `:1601-1602`.
- `get_attention_digest`: `server.ts:1370-1383`, decl `:1704-1710`. `onIdle`: `server.ts:226-252`.
- `detectAndTriggerTransitions`: `server.ts:385-454`. Frozen systemInstruction: `server.ts:1590`.
- Tests: `tests/test_terminal_manager.ts:18-32`; `tests/test_server.ts:40-53`, `:77-89`.
- Dep already present: `pidusage` (`package.json:21`). Reference impl: `universal_terminal.py:23-44`.
