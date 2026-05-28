# Fit-for-Use Assessment — Target Tool Runtime (Do the agent CLIs actually run inside this?)

## Reviewer

**Hiroshi Tan** — Engineer who builds and ships interactive terminal agent CLIs (the
Claude Code / Codex / Aider class). Lens: not generic code review — strictly *does Orbital
Harness fit the runtime reality of the tools it claims to orchestrate?* I read the code that
decides runtime behavior (`src/terminal.ts`, `server.ts`, `src/types.ts`), the presets, the
specs, and the standalone Python port. The question I answer: spawn a real Claude Code or
Codex session through this harness — is it observable, and is it steerable? Everything below
is judged against how these programs *actually behave* at runtime against a TTY.

---

## Executive verdict

Orbital Harness spawns its panes with `spawn('/bin/sh', ['-c', cmd])` and **default stdio
pipes — there is no PTY anywhere** (`src/terminal.ts:169-172`; `package.json` has no
`node-pty`). Every target preset (Claude Code, Codex, Antigravity) is a full-screen Ink/TUI
agent that calls `isatty()` on startup; against a pipe they either refuse to launch, drop to a
degraded non-interactive mode, or block-buffer their output — so the model's "live pane
summary" loop sees nothing, and `writeInput(cmd + "\n")` (`src/terminal.ts:222-226`) does not
reach a TUI's keypress reader. Compounding this, the output path *strips* ANSI but never
*interprets* cursor motion, so even when bytes do arrive the buffer is a scrambled,
de-duplicated mess that misrepresents the screen. The prior backend assessment already flagged
the PTY gap as fit-breaking #1; my domain read confirms it and adds that **input fidelity, ANSI
re-assembly, and prompt/keypress semantics are all independently broken** — fixing PTY alone is
necessary but not sufficient. **Readiness rating: Demo-only.** A scripted/echoing fake CLI will
look great on stage; a real Claude Code session will not be observable or steerable today.

---

## Area 1 — TTY/PTY: pipes vs pseudo-terminal

**Evidence.** `src/terminal.ts:169-172`:

```ts
this.process = spawn(executable, args, { cwd: this.cwd, env: process.env });
```

No `stdio` override, so Node defaults to `['pipe','pipe','pipe']`. No `node-pty`, no
`pty.spawn`, no `setRawMode`, no cols/rows, no `TERM`/`COLUMNS`/`LINES` injected (`env` is just
`process.env`, line 171). The child's stdin/stdout/stderr are anonymous pipes. From the
program's point of view, `process.stdout.isTTY === undefined` and `isatty(0/1) === 0`.

The presets that get launched into this are all interactive TUI agents
(`src/terminal.ts:49-51`, restart map `server.ts:116-118`):
`npx @anthropic-ai/claude …`, `npx codex-cli …`, `npx antigravity …`. These are Ink/React-in-
terminal or equivalent full-screen apps. Concrete per-tool failure modes against a pipe:

- **Claude Code (Ink/React TUI).** Ink renders to an alternate screen using cursor
  addressing and requires raw-mode keyboard input. With `stdin` not a TTY it cannot enter raw
  mode; Ink's `useInput`/raw-mode path throws or warns ("Raw mode is not supported on the
  current process.stdin") and the interactive UI does not start. At best it falls back to a
  non-interactive path; at worst it exits. The slash-command box the preset claims to want
  (`--with-open-textbox`, line 49) is exactly the raw-mode interactive surface that cannot
  exist over a pipe. **Net: the headline tool does not present a usable, drivable session.**

- **Codex CLI (TUI / REPL).** Same class. It detects a non-TTY and either disables its
  interactive prompt or switches to a one-shot/print mode. Either way there is no persistent
  REPL to stream commands into, which is what the orchestrator's whole "propose_command →
  stdin" model assumes.

- **Antigravity (preset seeds `--dangerously-skip-permissions`, Full-Auto).** Skipping the
  permission prompt removes *one* interactive gate, but the agent is still a TUI; it still wants
  a terminal for its progress/spinner/diff UI. Skipping permissions does not make it pipe-safe;
  it just makes the broken session also auto-execute. This is the worst combination.

- **Custom shell (`bash`, `cmd.exe`).** A bare non-interactive `sh -c "bash"` reads EOF-less
  from a pipe with `PS1` unset: no prompt is rendered, no job control, line-editing/readline is
  disabled, and `bash` itself notices it is non-interactive. The default `primary-cli` pane
  (`server.ts:16`) is exactly this and will sit there emitting nothing.

**Cross-cutting pipe symptom — block buffering.** Even programs that *do* run non-interactively
over a pipe switch stdout from line-buffered (TTY) to fully-buffered (pipe) in libc. The model's
observation loop (`get_pane_summary`) will see nothing until a 4–8 KB buffer flushes or the
process exits — defeating the real-time "what is the agent doing right now" premise. Terminal
size is also unknown to the child (no `TIOCGWINSZ`), so any tool that lays out by width
mis-wraps or refuses.

**Bottom line for Area 1:** the spawn primitive is fundamentally wrong for the target class.
This is the root fit blocker; nothing downstream can compensate.

---

## Area 2 — Output fidelity: does the buffer represent the screen?

Even granting bytes arrive, the capture path corrupts the picture.

**ANSI is stripped, never interpreted** (`src/terminal.ts:56-60, 184-185, 200-201`):

```ts
const cleanLines = stripAnsiSequences(decoded).split(/\r?\n/).filter(l => l.trim() !== '');
this.outputBuffer.push(...cleanLines);
```

The regex (line 58) removes CSI color/style sequences, but TUI agents do not "print lines."
They paint a screen with **cursor-move sequences, line-clears (`\x1b[2K`), cursor-home
(`\x1b[H`), and carriage returns** to redraw spinners and progress bars in place. Concrete
breakage:

- **`\r`-redrawn progress/spinners.** A spinner emits `⠋ working\r⠙ working\r…`. The regex does
  not touch `\r`; `split(/\r?\n/)` treats the whole thing as one line, so the buffer accumulates
  a single megaline of concatenated spinner frames instead of one updating status. Progress
  bars (`[####    ] 40%\r[#####   ] 50%\r`) become hundreds of stale fragments.

- **Cursor addressing is discarded, not applied.** When Claude Code repaints row 3 with
  `\x1b[3;1H…`, the harness strips the `\x1b[3;1H` and keeps the *text*, appending it as a new
  line. The buffer is therefore an append-only log of every intermediate frame the TUI ever
  painted — the opposite of the current screen. The model reading `get_pane_summary` sees a
  jumbled history, not state.

- **`filter(l.trim() !== '')` drops structure.** Blank lines that separate sections (diffs,
  tool output blocks) are removed, collapsing visually-distinct regions together.

- **Partial lines / chunk splitting.** `data` events fire on arbitrary byte boundaries. A
  decode can split a UTF-8 multibyte char (`data.toString('utf-8')` per chunk, line 179, has no
  carry-over decoder) **and** split an ANSI escape across two chunks — so a half-escape leaks
  through the regex as literal garbage, and the other half corrupts the next line. There is no
  reassembly buffer.

- **Bounded ring buffer (`maxBufferLines = 100`, lines 67, 186-188).** Because every redraw
  frame is stored as "new lines," a single active spinner can blow through 100 lines in
  milliseconds and **evict the actual content** (the diff, the question the agent asked). The
  cap that was meant to bound tokens instead guarantees the meaningful output scrolls out of the
  window under any TUI.

- **The "semantic delta filter" is a stub** (`getPaneSummary`, `src/terminal.ts:415-422`): it
  just wraps `getRecentOutput(20)` in a code fence. There is no delta, no read cursor, no
  diffing. Consecutive calls re-emit overlapping slices, and there is no screen reconstruction.

**Net:** what the model and operator see does **not** represent what the agent is doing. For a
non-TUI line-oriented tool it would be roughly OK; for the exact tools this product targets it is
actively misleading.

---

## Area 3 — Input fidelity: does `writeInput` drive these tools?

`writeInput(command)` does `this.process.stdin.write(command + "\n")` (`src/terminal.ts:222-226`),
i.e. it writes bytes + `\n` to a pipe. This is the only input path; `propose_command`/approval
both funnel here (`server.ts:283, 383`). Reality check against interactive agents:

- **TUI keypress readers, not line readers.** Ink/raw-mode apps read **individual keystrokes**
  off a raw TTY, not newline-terminated lines off a pipe. Writing `"do X\n"` to a pipe stdin is
  not the same event stream as a human typing — many TUIs won't even be listening to a pipe
  stdin, and `\n` is "Enter" (submit) but the per-character path that builds the input box never
  ran. So the text often never lands in the agent's prompt box at all.

- **Interactive y/N permission prompts.** A real Claude Code/Codex permission prompt
  ("Allow edit to file? (y/n)") is a single-keypress selector on the TTY. The harness can only
  shove `y\n` down the pipe; whether that reaches the selector depends entirely on a TTY existing
  (it doesn't). Note the irony: the product's *entire HITL value prop* is mediating these
  prompts, but it cannot reliably answer them.

- **No control-character / signal support.** There is no way to send **Ctrl-C** (`\x03`),
  **Ctrl-D** (EOF), Esc, arrow keys, Tab-completion, or Ctrl-C-twice-to-exit. You cannot
  interrupt a runaway agent, dismiss a menu, or navigate a file picker. `writeInput` only does
  line-text-plus-newline.

- **Slash commands & multi-step flows.** `/model`, `/clear`, file pickers, multi-select — all
  are TUI interactions, not lines. A "type `/help` and Enter" only works if the raw-mode input
  box is alive, which (Area 1) it isn't.

- **Paste / multi-line.** Bracketed-paste mode (`\x1b[200~ … \x1b[201~`) is never emitted, so a
  multi-line command is interpreted as multiple submits.

- **No echo / no confirmation of receipt.** Because there's no PTY echo, the operator and model
  get no feedback that input was accepted; combined with Area 2, you're flying blind.

**Net:** `writeInput` can drive a dumb line-oriented program (`cat`, a script reading stdin). It
cannot reliably drive a single one of the named agent CLIs.

---

## Area 4 — Lifecycle fit

- **Process groups / `npx` grandchildren.** Panes run `sh -c "npx … agent …"`. That's a tree:
  `sh` → `npx`(node) → the agent(node). `stop()` calls `this.process.kill()` on the *shell* only
  (`src/terminal.ts:232-237`); without `detached:true` + `process.kill(-pid)` and a
  SIGTERM→SIGKILL escalation, the `npx`/node grandchild **orphans and keeps running** (and keeps
  holding the session/lock). There's no server `SIGINT/SIGTERM` reaper, so Ctrl-C on the harness
  leaves every agent alive.

- **`idleTimer` leaks across stop/restart.** Set on every chunk (`:155-162`), never cleared in
  `stop()`; `restart` (`server.ts:106-107`) calls `stop()` then `start()` synchronously with no
  wait-for-exit, so the new spawn races the old teardown and the stale timer can flip a dead
  pane's status.

- **Idle/status accuracy.** Status is purely "did stdout emit in the last 2s" (`:155-162`). A
  TUI that repaints a spinner every 80 ms reads as *permanently Running* even while *blocked
  waiting for your y/N* — exactly inverting the signal the voice agent needs ("is it waiting for
  me?"). A genuinely-thinking agent that's quiet reads as Idle. `is_busy`/`alive`
  (`:402-405`) inherit this.

- **Session resumption is cosmetic.** `sessionId` is either a fabricated
  `claude-code-session-<rand>` (`:104-110`) or regex-scraped from stdout (`checkForSessionId`,
  `:135-153`) — and the first matcher block is a no-op (`:136-138`). Real Claude Code session IDs
  are UUIDs surfaced via `--resume`/`-r` semantics, not printed in a "Session ID:" banner the
  regex expects. On restart the harness re-launches the *base* command (`server.ts:116-118`)
  **dropping the original flags entirely** — including any `--resume`, so "persistentRestore"
  does not actually resume the upstream agent session.

- **`cpuUsage` is `Math.random()`** (`:127-133`) surfaced as real telemetry — unrelated to fit
  but it means the one "is it working hard?" number the operator sees is fabricated.

---

## Area 5 — The honest bottom line

**Would a real Claude Code / Codex session be observable and steerable through this today? No.**
- *Observable:* No — it likely won't start its TUI over a pipe; if it produces any output it's
  block-buffered and then mangled by ANSI-strip-without-cursor-interpretation into an append-log
  that evicts real content from a 100-line ring.
- *Steerable:* No — `writeInput` writes lines to a pipe a raw-mode keypress reader isn't reading;
  no Ctrl-C, no y/N, no slash commands, no navigation.

What *will* demo perfectly: a fake/echoing CLI or a plain shell script that reads lines from
stdin and prints lines to stdout. The architecture above (permissions gate, ledger, voice tool
calls) is coherent and correctly shaped — it's just sitting on a process substrate that doesn't
match the target programs.

---

## Decisive fit blockers, ranked

1. **No PTY (pipes).** `src/terminal.ts:169-172`. Breaks startup, raw-mode input, flushing, and
   terminal size for *every* target preset. Root cause; everything else is downstream.
2. **Input model can't drive a TUI.** `writeInput` = line+`\n` to a pipe (`:222-226`); no
   control chars, no keystroke semantics, no Ctrl-C, no y/N, no slash commands.
3. **Output is stripped, not screen-reconstructed.** No ANSI/cursor interpreter; `\r` and cursor
   moves corrupt the buffer; spinners evict real content from the 100-line ring (`:56-60,
   184-188`). The model sees a misleading log.
4. **No terminal emulation / no real delta.** `get_pane_summary` is a code-fence stub
   (`:415-422`); no read cursor, no current-screen snapshot.
5. **Lifecycle leaks & wrong status.** Shell-only kill leaves orphaned `npx`/node agents;
   idle/status inverts for spinner-painting TUIs; "resume" drops flags and is cosmetic
   (`:104-153`, `server.ts:106-118`).

---

## Minimum-viable-fit — shortest path to actually running these CLIs

1. **Adopt a PTY.** Replace `spawn` with `node-pty`'s `pty.spawn(shell, args, { name:'xterm-256color',
   cols, rows, cwd, env })`. This single change gives the child `isatty()===true`, line-flushing,
   raw-mode input, and a window size — unblocking startup for Claude Code/Codex/Antigravity. This
   is the non-negotiable first move. (L)
2. **Run a terminal emulator over the PTY output**, not a regex. Feed bytes into a headless
   `xterm.js` / `@xterm/headless` (or `node-pty` + a VT parser) and read back the *rendered screen
   buffer*. `get_pane_summary` then returns the actual current screen (+ a real since-last-read
   delta via a row cursor), and the model finally sees state, not history. Drop
   `stripAnsiSequences`/`filter(blank)`; keep a streaming UTF-8 decoder to fix split multibyte/
   escape chunks. (M)
3. **Make input a keystroke channel.** `writeInput` should write raw bytes to the PTY master and
   expose control sequences: an explicit `sendKey` for Enter/Esc/Ctrl-C(`\x03`)/Ctrl-D/arrows,
   and bracketed-paste for multi-line. Give the voice agent a way to answer y/N prompts as
   keypresses. Add resize (`pty.resize(cols,rows)`) wired to the UI. (M)
4. **Real status from the PTY + emulator.** Derive "waiting for input" from the screen state
   (cursor at a prompt / a known y/N pattern) rather than a 2s stdout timer, so the voice agent
   can say "it's asking you to approve an edit." (S–M)
5. **Fix process-group lifecycle.** `detached:true` + `process.kill(-pid)`, SIGTERM→timeout→
   SIGKILL, clear `idleTimer` in `stop()`, await exit in `restart`, preserve original launch flags
   (incl. `--resume`) on restore, and add a server-level reaper. (M)

Steps 1–3 are the line between "demo of a fake CLI" and "actually observing/steering a real
Claude Code session." Until at least those land, the product's headline capability does not
function for its named target tools.

---

*Analysis only — no source modified except this file. Evidence cited inline as `file:line`.*
