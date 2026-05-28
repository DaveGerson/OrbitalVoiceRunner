# Operator-Workflow Fit Assessment — Orbital Harness / Janus Terminal Orchestrator

## Reviewer / Persona

**Dana Whitfield** — Staff engineer, and the person who would actually *run* this thing
all day. On a normal afternoon I have 4–6 coding-agent terminals open at once (Claude
Code, Codex, a couple of long builds, a test-watcher) and I tab between panes constantly.
The pitch that sold me on Orbital Harness: stop tabbing. Talk to Janus, let it watch the
panes, get spoken summaries of what each agent is doing, approve or deny the commands they
propose, and steer them — hands-free.

My lens is strictly **fit-for-use**: forget code style, forget security-hardening-for-its-
own-sake. The only question I care about is *does the real operator loop work end to end,
and where does it break in practice?* I walked the five workflows below as if it were my
own machine. Evidence is cited `file:line`.

---

## Executive Verdict

**It does not yet fit the core job, and the gap is in the part the product is named after:
observing and steering real interactive agents.** The demo is genuinely seductive — one
WebSocket multiplexes voice, tool calls, approvals, and live stdout, and the approval UX is
clean. But the two things the whole pitch rests on are not real: (1) panes are spawned over
**pipes, not a PTY** (`src/terminal.ts:169-172`), so Claude Code / Codex / Antigravity — the
exact tools in the presets — won't render their TUIs, won't flush output line-by-line, and
won't accept the keystrokes Janus "types"; and (2) `get_pane_summary` is an explicit **stub**
that just re-fences the last 20 buffer lines (`src/terminal.ts:415-422`), so there is no
"semantic delta," no since-last-read cursor, and the "observe → summarize → steer" loop is
mostly theater. On top of that, the multi-pane premise breaks the moment two agents ask for
approval at once (single approval slot, `src/App.tsx:14`, `:215-220`), and a multi-project
ledger reports stale status for every backgrounded project (`syncLedger` only touches the
active project, `src/terminal.ts:392-411`). The voice layer dies invisibly on any network
blip (no reconnect, `src/App.tsx:251-253`) and the Mute button doesn't mute
(`src/App.tsx:201-206`).

**Readiness rating: Demo-only.** It demos beautifully with one `bash` pane on a stable
connection. It is not something I could run my 6-agent afternoon on today.

---

## Workflow-by-Workflow Walkthrough

### 1. First run / onboarding — *partially works, with a silent dead-end*

**What works.** `npm run dev` boots a server on `:3000` and auto-creates a `primary-cli`
pane (`server.ts:16`). The Settings dialog can take a Gemini key at runtime, and the GET
path masks it (`server.ts:240-245`). "Connect" opens the WS and requests the mic
(`src/App.tsx:188-190`). For a first-time user the happy path is short and legible.

**Where it breaks.**
- **Denied/again-prompted mic = stuck "LISTENING…" with a dead mic.** `getUserMedia` is
  awaited *inside* `ws.onopen`, *after* `setIsLive(true)` already ran (`src/App.tsx:188-207`).
  If I deny the mic (extremely common on first run) the promise rejects, the rest of
  `onopen` is skipped, but `isLive` stays `true` and the header proudly shows "LISTENING…"
  (`src/App.tsx:545-546`). There is no permission pre-flight, no "mic blocked" state, no
  recovery. As the operator I have no idea why Janus can't hear me.
- **Bad/missing key fails silently in the UI.** The server *does* emit
  `{type:"error", ...}` on a failed Gemini connect (`server.ts:575-578`), but the client's
  `onmessage` switch has **no `error` case** (`src/App.tsx:209-248`). So a wrong key produces
  a connected socket, a green-ish UI, and total silence. First-run debugging is "why is
  nothing happening," with zero signal.
- **Default pane is `bash`, not an agent.** The onboarding pane (`server.ts:16`) is a raw
  shell, which is the *only* thing that actually works over pipes. The first thing I'd do —
  create a Claude Code pane — lands me straight into workflow #2's core failure.

### 2. Steady state, 4–6 panes: track each agent by voice — *this is where the product fails its own promise*

This is the headline loop. It is largely **stubbed or broken**.

- **No PTY → the target agents don't run as agents.** `spawn("/bin/sh", ["-c", cmd], {...})`
  with default stdio pipes (`src/terminal.ts:169-172`). Claude Code / Codex / Antigravity
  detect `isatty()===false` and either refuse, drop their interactive TUI, or block-buffer
  stdout until a 4–8 KB libc buffer fills. So the "live pane summary" has nothing fresh to
  summarize for minutes at a time, and `writeInput(cmd+"\n")` (`src/terminal.ts:222-226`)
  pipes to a non-TTY that the agent's prompt reader never sees. **The presets at
  `src/terminal.ts:49-51` describe agents this substrate cannot drive.**
- **`get_pane_summary` is a labelled stub.** The tool description promises "the clean,
  redacted markdown **delta**" (`server.ts:498-499`), but the implementation just wraps
  `getRecentOutput(20)` in a code fence with the comment `Stub SDF (Semantic Delta Filter)`
  (`src/terminal.ts:415-422`). There is **no delta**: every call re-sends overlapping buffer
  slices, there is no per-pane "since I last asked" watermark, and nothing is redacted
  despite the description. So when I say "what's the test pane doing," Janus gets the same 20
  lines it got last time, burning tokens and giving me a stale answer. This directly
  contradicts the stated "pull, not push, token-light" design.
- **Status / busy detection is a 2-second stdout heartbeat, not a real signal.** Status flips
  to `Running` on any output and back to `Idle` after 2 s of silence
  (`src/terminal.ts:155-162`). An agent silently *waiting on my input* reads as `Idle`
  (looks done — it isn't); an agent stuck in a retry loop spewing logs reads as `Running`
  (looks busy — it's stuck). `is_busy`/`alive` inherit this (`src/terminal.ts:402-405`). As
  an operator I cannot trust the dots.
- **CPU load is fabricated.** `cpuUsage` is `Math.random()` (`src/terminal.ts:127-133`),
  surfaced as a real meter in the dashboard (`src/App.tsx:816-825`). I'd glance at "CPU 31%"
  to decide which agent is grinding — and it would be a lie.
- **Multi-project status goes stale.** `listPanes()` returns panes for **all** projects
  (`src/terminal.ts:382-388`) but `syncLedger()` only writes live state into the **active**
  project (`src/terminal.ts:392-411`). The instant I `switch_context`, every pane in the
  project I just left stops getting status/CPU/alive updates. So "give me the rundown across
  my projects" returns fresh data for one project and frozen data for the rest — and because
  all terminals share one flat `manager.terminals` map, a pane created under project A gets
  its meta written into whatever project happens to be active when `list_panes` next runs.

**Net:** the observe→summarize→steer loop is real only for a plain `bash` pane on the active
project. For the actual agents, on the actual multi-project setup, it is stubbed or stale.

### 3. Approval flow under realistic concurrency — *the single-slot collapse*

**What works for one command.** HITL is shaped correctly: the server holds the proposal in
`pendingApprovals`, withholds the Gemini tool response until I act, and only `writeInput`s on
approve (`server.ts:419-431`, `:275-305`). The Approval Dialog is the best part of the app —
Enter=approve, Esc=reject, shows the exact command and target pane
(`src/components/ApprovalDialog.tsx:16-29`). For a single agent this loop is satisfying.

**Where it breaks under the multi-pane premise.**
- **Two proposals at once = one is lost.** The client stores `pendingCommand` as a *single*
  object (`src/App.tsx:14`); a second `approval_pending` simply **overwrites** the first
  (`src/App.tsx:215-220`). With 6 agents this happens constantly. The overwritten command's
  server-side `pendingApprovals` entry lives forever (`server.ts:422`) with its tool response
  never sent — which **hangs that Gemini turn indefinitely** (the model is blocked waiting on
  a function response that will never come). So agent #1 silently stalls while I approve
  agent #2, and I never even saw #1's request.
- **No queue, no expiry, no "who's waiting."** There's no stack of pending cards, no TTL,
  no timeout-and-deny. The Settings tab fetches `/api/commands/pending` as a *list*
  (proving the backend can hold several), but the main control surface can only ever show one.
- **Approval routing is fragile across the session.** The pending entry captures the
  `session` object at propose time (`server.ts:422`); if my WS dropped and reconnected
  between propose and approve, `pending.session.sendToolResponse(...)` (`server.ts:283`,
  `:292`) fires against a dead session with no guard.

As the operator running 6 agents, "stay in control of concurrent approvals" is exactly the
thing I'm buying — and it's the thing that breaks first.

### 4. Long session (a real workday) — *leaks and stale state accumulate*

- **Any WS drop kills voice with no recovery.** `ws.onclose` just calls `stopLive()`
  (`src/App.tsx:251-253`); there is no `onerror`, no backoff, no reconnect, no "reconnecting"
  banner. Server restart, laptop sleep, a 2-second wifi blip — voice, mic, and live stdout all
  die, the header dot goes grey, and nothing tells me why or comes back. Over an 8-hour day
  this *will* happen, repeatedly.
- **Every reconnect leaks an upstream Gemini session.** Each WS connection opens a fresh
  Live session (`server.ts:332`) and `clientWs.on("close")` never calls `session.close()`
  (`server.ts:597-603`). `sessionResumption: {}` is passed in config (`server.ts:469`) but the
  resumption handle is **never captured or replayed** — so "resume" is cosmetic and every
  blip both loses my conversation context and orphans a session.
- **Ledger is rewritten synchronously on every mutation, including per-pane in a loop.**
  `save()` is a blocking whole-file `writeFileSync` (`src/ledger.ts:49-59`) called inside
  `syncLedger`'s per-terminal loop (`src/terminal.ts:411`) on **every** `list_panes`. With 6
  panes that's 6 full-file rewrites per orientation call, stalling the audio/WS path and
  racing the HTTP permission writes (`server.ts:166-185`) — non-atomic, so a crash mid-write
  can corrupt the durable state the whole product depends on.
- **Dead child processes leak; restart is unreliable.** `stop()` kills the `sh` parent and
  nulls the ref (`src/terminal.ts:232-237`) but never kills the `npx → node → agent`
  grandchildren (no process-group kill) and **never clears `idleTimer`**
  (`src/terminal.ts:74`, `:158-159`). So a stale timer can flip a dead pane back to a live
  status, and "restart" (`server.ts:106-107`) spawns the new process without waiting for the
  old tree to exit. There's no server shutdown reaper, so Ctrl-C leaves every agent running.
- **Scrollback is 100 in-memory lines, max.** `maxBufferLines` (`src/terminal.ts:186-188`)
  and the UI's even-tighter 40-line cap (`src/App.tsx:242`) mean any history older than the
  last screen is gone; a pane restart or server restart loses the transcript entirely (the
  ledger stores metadata, not output). "What did this agent do an hour ago?" is unanswerable.

### 5. Recovery when something breaks — *the operator is mostly left confused*

- **Mic denied:** stuck "LISTENING…", no error, no retry (workflow #1).
- **Connection drop:** silent death, no reconnect, no banner (workflow #4).
- **Bad API key:** server `error` message is emitted but never rendered (`src/App.tsx:209-248`
  has no `error` case) — silent.
- **Mute that doesn't mute:** the `onaudioprocess` callback closes over `isMicMuted` at
  `startLive` time (always `false`) and is never re-created (`src/App.tsx:201-206`). Clicking
  Mute flips the badge to "MUTED" (`src/App.tsx:527`, `:546`) but **keeps streaming mic PCM**.
  When I think I've muted to take a call, Janus is still listening and may act on what it
  hears. This is a trust-breaker for a hands-free tool.
- **Agent crashes a pane:** the dashboard *does* show `Exited` (red dot) and offers
  Restart/"Recover & Wake up Engine" (`src/App.tsx:1053-1062`) — this is the one recovery
  path that's genuinely decent. But restart rebuilds the command from a hardcoded preset map
  (`server.ts:115-120`) that doesn't match the documented preset commands, and without a PTY
  the recovered agent has the same non-functional substrate as before.

The recurring pattern: failures are *real and frequent*, and the UI gives me a green light,
a grey dot, or silence. As the operator I can rarely tell *what* broke, let alone fix it.

---

## The Gaps That Most Stand Between This and Doing the Job

Ranked by how directly they block *my* daily workflow (not by general severity):

1. **No PTY — the agents don't run as agents.** (`src/terminal.ts:169-172`) Everything
   downstream — summaries, steering, status — is observing a crippled process. This is the
   #1 fit blocker; nothing else matters until panes are real TTYs.
2. **`get_pane_summary` has no delta and no freshness.** (`src/terminal.ts:415-422`) The core
   "tell me what each agent is doing" verb returns stale, overlapping, un-redacted text. The
   observe loop is the product, and it's a stub.
3. **Single-slot approvals collapse under concurrency.** (`src/App.tsx:14`, `:215-220`;
   `server.ts:422`) The multi-agent premise breaks the instant two agents propose at once —
   lost commands and hung agent turns, exactly when I most need control.
4. **No connection resilience + a mute that lies.** (`src/App.tsx:251-253`, `:201-206`) The
   voice channel — my only interface in this product — dies invisibly on any blip and can't be
   trusted to actually stop listening. Over a workday this is disqualifying.
5. **Stale/fabricated state for the multi-project, long-session case.** (`syncLedger`
   active-only `src/terminal.ts:392-411`; fake `cpuUsage` `:127-133`; idle-heartbeat status
   `:155-162`) I make steering decisions off this dashboard, and large parts of it are stale
   or invented.

---

## What "Minimum Viable Fit" Looks Like — the shortest path to a tool I'd use daily

I don't need production hardening, auth, or accessibility to *try* this for real. I need the
core operator loop to be honest and survivable. In rough dependency order:

1. **Put panes on a real PTY (`node-pty`).** Without this the whole product is a mock. This
   single change makes Claude Code / Codex actually run, flush, and accept input. *(Largest
   item, but non-negotiable — it's the floor.)*
2. **Make `get_pane_summary` a real delta.** Per-pane read cursor; emit only lines since my
   last query; keep the ANSI strip. Cheap, and it turns the headline feature from theater into
   function.
3. **Turn approvals into a queue.** `pendingCommand` → `PendingCommand[]`, stacked cards with
   per-item approve/reject, and a server-side TTL that auto-denies (and unblocks the Gemini
   turn) so nothing hangs. Reconcile with the `/api/commands/pending` the backend already
   exposes.
4. **Make the voice channel survivable and honest.** Fix the mute stale-closure (read mute via
   a `useRef` in `onaudioprocess`); add WS reconnect with backoff + a visible
   "reconnecting/disconnected" banner; handle the server's `error` message; render a "mic
   blocked" state instead of fake "LISTENING…". Close the Gemini session on disconnect so I
   stop leaking sessions.
5. **Stop lying on the dashboard.** Sync *all* projects' pane state (not just the active one),
   and either wire real CPU (`pidusage`) or delete the meter. A small derived-state fix that
   restores my trust in the at-a-glance view.

Hit items 1–4 and I'd run a single-project, 3-pane workflow on it daily and tolerate the
rough edges. Add item 5 and the multi-project rundown I actually want becomes trustworthy.
Everything in the other three assessments (auth, sandboxing, xterm.js, a11y, persistence
durability) is real and necessary for *shipping* — but it is not what stands between me and
*using* the tool. The PTY, the real delta, the approval queue, and an honest voice channel
are.

---

*Analysis only — no source code was modified. This file is the only artifact produced.*
