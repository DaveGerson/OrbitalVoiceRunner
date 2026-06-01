# Next-Level Capabilities — Maya Chen (Solo Founder / Power User)

*Forward-looking companion to `assessments/01-power-user-maya.md`. Assumes the round-one
P0/P1 bugs (blind approvals, orphaned approvals on reconnect, pane-id ghosting, switch/restart
desync, history clobber) are fixed. This is about what turns a working single-operator harness
into something I'd build my whole day around running 4–6 agents across several repos.*

The through-line: today the tool is **reactive and single-threaded through me**. I am the
only thing that connects pane to pane. Every coordination decision, every "is anyone blocked,"
every "run the tests after the refactor lands" lives in my head. At 2 panes that's fine. At 6,
across 3 projects, I'm the bottleneck and the single point of failure. Everything below is about
moving coordination, triggering, and attention-routing *into the tool* so I can actually walk
away — or at least stop being the message bus.

---

## Next-Level Features

### 1. Watch/Trigger Rules — "when pane X does Y, do Z"
**Priority: P0-aspirational · Effort: M**

**Problem.** My single most common manual ritual: babysit pane A until it finishes, then go
kick off pane B. "When the Codex refactor in `api-svc` finishes, tell the Claude pane in the
same repo to run the test suite." Right now I literally sit and watch for a prompt to appear,
because nothing else will. This is the whole reason I can't leave the room.

**Sketch.** A rule engine keyed off the status-transition signal the system already computes.
`updateStatusOnOutput` (`src/terminal.ts:155-179`) is the exact chokepoint where a pane flips
Running→Idle, and `onOutput` already broadcasts every chunk (`server.ts:182-210`). Add a
`watchRules: { paneId, on: "idle"|"prompt"|"regex"|"exited", action }[]` list. Actions reuse
machinery that already exists: `propose_command` into another pane (`server.ts:627`),
fire a notification, or speak via the Janus session. Expose a `create_watch` tool alongside the
existing function declarations (`server.ts:739`) so I can set one up by voice: *"when this pane
goes idle, run the tests next door."* This is the feature that converts "attended demo" into
"unattended fleet."

### 2. Sequenced Task Plans (DAG) with resumable execution
**Priority: P1 · Effort: L**

**Problem.** Real work has ordering. "Migrate the schema, *then* regenerate the client, *then*
run integration tests, *then* open the PR" — four steps across two or three panes with hard
dependencies. Today I drive that sequence by hand and if I get pulled away mid-chain the plan
just stops, with no record of where it was.

**Sketch.** A `Plan` = ordered/branching steps, each step = `{paneId, command, waitFor:
"idle"|"exit-0"|"regex", onFail: "halt"|"continue"|"notify"}`. Builds directly on rule #1's
trigger primitive — a plan is just chained watch rules. Persist plan state into the ledger
(`src/ledger.ts` Workspace already serializes atomically, `:75-100`), so a plan survives a
server restart or the auto-reconnect loop and resumes from the last completed step. Surface
current step + progress on each pane card. The killer combo: I describe the plan once by voice,
walk away, and Janus narrates "step 3 of 4 complete, tests green, opening PR."

### 3. Cross-Pane Agent Handoff with shared context payload
**Priority: P1 · Effort: M**

**Problem.** When I hand work from one agent to another I'm a copy-paste mule: I read Codex's
output, summarize it, and re-type it into the Claude pane. The receiving agent has zero context
on what the first one did. Pane notes (`ledger.addPaneNote`, `:147`) are per-pane and static —
they don't *travel*.

**Sketch.** A `handoff(fromPane, toPane, note?)` tool that grabs the source pane's recent
summary (`getPaneSummary`, `terminal.ts:550`) plus any pane notes, packages it as a context
blob, and writes it into the target pane as a priming message (or stages it for my approval if
the target is HITL). Janus already has both panes in scope inside one session, so it can author
the handoff summary itself rather than dumping raw scrollback. Show a handoff edge in the UI so
I can see "B is working from A's output."

### 4. Saved Orchestration Recipes / Session Templates
**Priority: P1 · Effort: M**

**Problem.** Every new project, I hand-build the same fleet: a Claude pane + a Codex pane on the
repo, a plain shell for git, all with my usual permission modes. `CreateTerminalDialog` is a
one-pane-at-a-time form. Standing up my standard rig is five minutes of clicking, every time.

**Sketch.** A `template` = a named set of pane specs `{name, cmd, toolPreset, permissionsMode,
cwd-relative-path}` plus optional starter notes and watch rules. "Apply template `feature-rig`
to project X" spawns the whole set in one shot via the existing batch-capable `addTerminal`
(`terminal.ts` / `server.ts:248`). Store templates in settings (the settings file is already
over-built and import/export-capable — finally a good use for that surface). Voice: *"spin up my
standard rig on the payments repo."*

### 5. Attention Queue + Push Notifications when an agent needs me
**Priority: P0-aspirational · Effort: S**

**Problem.** The premise is "pace around the room." But when I'm across the room (or in another
tab, or grabbing coffee), nothing reaches me. The amber ALERT pulse (`App.tsx:855-859`,
`:1152`) only exists on a screen I'm not looking at. If three panes block for approval while I'm
away, I come back to three stalled agents and no idea which blocked first.

**Sketch.** Two parts. (a) A real notification channel: browser Notification API on
`approval_pending`/`command_blocked`/pane-exited (those WS events already fire,
`App.tsx:355-380`), plus an optional webhook so it can hit my phone. (b) An **ordered attention
queue** — a FIFO of everything waiting on me, oldest-first, with pane + reason. Right now the
ApprovalDialog only ever shows `pendingCommands[0]` (`App.tsx:633-641`); there's no concept of a
queue I can triage. Make Janus able to read it to me on demand: *"who needs me?"* → "Three:
api-svc waiting 4 minutes on a migration, then…"

### 6. Push-Based Observation with Deltas (so Janus actually *knows* what's happening)
**Priority: P1 · Effort: M**

**Problem.** From round one: the model only sees a pane when *it* pulls a 100-line tail with no
delta tracking (`server.ts:614`, tool desc falsely claims "delta" at `:762`). For real
multi-agent orchestration the assistant needs continuous, cheap awareness of all panes, not a
snapshot of one when I prompt it. Otherwise it can't reason about "who's blocked" or drive any of
the features above.

**Sketch.** Maintain a per-pane cursor and emit only *new* lines since last read; feed
significant events (status transitions, detected prompts, error patterns) to the session
proactively as compact structured signals rather than raw text. This is the data backbone the
watch rules (#1), plans (#2), and attention queue (#5) all stand on — worth doing once, well.
Pairs with fixing the busy/idle heuristic flagged in round one (`terminal.ts:155-179`).

### 7. Voice Macros / Named Command Groups
**Priority: P2 · Effort: S**

**Problem.** I say the same multi-pane phrases all day: "save and run tests everywhere,"
"git status on all the panes," "commit-wip across the fleet." Each one is currently N separate
voice turns and N separate approvals.

**Sketch.** User-defined macros mapping a phrase to an ordered list of `propose_command` calls
across named panes (single approval-batch if I want it). Thin layer over the existing tool path;
the model already resolves spoken intent to `propose_command`. Effort is small because the
execution primitive is done — this is just naming and replay.

---

## Visual / UI Improvements

*Grounded in the current two-mode layout: a per-pane "Terminal View" (`App.tsx:928-1074`) and a
"Dashboard / Node Configuration Matrix" grid of cards (`App.tsx:1088-1278`), reached via the
"GRID SUMMARY VIEW" button (`:796-809`). The dashboard is the right idea but it's a static
config matrix, not a live operations surface.*

### 8. Live Multi-Pane Output Tiles (the grid should show *output*, not just config)
**Priority: P0-aspirational · Effort: M**

**Problem.** The "Grid Summary View" shows me cards full of session IDs, context meters, and
permission dropdowns (`App.tsx:1118-1275`) — metadata, not *what the agents are doing*. To
actually monitor 6 agents at a glance I need to see the last several lines of each pane's output
simultaneously. Today seeing output means clicking into one pane at a time (`:928`), which is the
opposite of "at a glance across the fleet."

**Sketch.** Make each dashboard card render a live mini-terminal: the last ~8 lines of
`terminal.output` (already streamed to the client via `queueStdoutChunk`, `App.tsx:67-88`) in a
monospace tile, auto-scrolling. Reuse `TerminalView`. A density toggle (2-col / 3-col / compact)
so I can fit my whole fleet on one screen. This is the single biggest legibility win: turn the
config matrix into a video wall.

### 9. Attention-Routing Layout: blocked/needs-me sorts to the top
**Priority: P1 · Effort: S**

**Problem.** Pane cards and the sidebar list render in insertion order (`Object.values(
project.panes).map`, `App.tsx:1090`, `:852`). When one of six panes is blocked, the amber alert
styling exists (`:1121`, `:1152-1161`) but the card stays wherever it was — I have to scan the
whole grid to find who's waiting. Attention doesn't route; I route myself.

**Sketch.** Sort panes by urgency: pending-approval first, then exited/errored, then idle, then
running — across the whole fleet, not just the active project. Add a persistent top strip:
"⚠ 2 panes need you · 1 exited" with click-to-jump. Cheap: it's a comparator over state the
client already holds (`pendingCommands`, `terminals`). High impact because it inverts the
current "I hunt for problems" into "problems come to me."

### 10. Cross-Project Fleet View (drop the single-active-project wall)
**Priority: P1 · Effort: M**

**Problem.** The dashboard only ever renders `activeProject.panes` (`App.tsx:1088`). My agents
live in 3+ projects at once, but I can only see one project's panes at a time; switching projects
(`handleSwitchProject`, `:480`) blanks the view and re-fetches. So I literally cannot see my
whole fleet on one screen — which is the entire job. The header's "Cumulative Context Size"
(`:1488`) is even computed only over the active project, so the one fleet-wide number I have is
lying about scope.

**Sketch.** An "All Projects" mode that flattens every workspace's panes into one urgency-sorted
grid (composes naturally with #8 and #9), with a subtle project tag on each tile. Keep
single-project focus as a filter, not a hard wall. Make the global context/token counters
genuinely fleet-wide. This is what lets me stand in the middle of the room and see everything.

---

## Priority Summary

| # | Item | Category | Priority | Effort |
|---|------|----------|----------|--------|
| 1 | Watch/Trigger rules (when X→do Z) | Feature | P0-asp | M |
| 5 | Attention queue + push notifications | Feature | P0-asp | S |
| 8 | Live multi-pane output tiles | UI | P0-asp | M |
| 2 | Sequenced resumable task plans (DAG) | Feature | P1 | L |
| 3 | Cross-pane agent handoff | Feature | P1 | M |
| 4 | Saved recipes / session templates | Feature | P1 | M |
| 6 | Push-based observation with deltas | Feature | P1 | M |
| 9 | Attention-routing layout (blocked floats up) | UI | P1 | S |
| 10 | Cross-project fleet view | UI | P1 | M |
| 7 | Voice macros / named command groups | Feature | P2 | S |

**If I could only have three:** #1 (watch/trigger — the unlock for unattended operation), #8
(live output tiles — the unlock for monitoring a fleet at a glance), and #5 (attention queue +
notifications — the unlock for actually leaving the room). Those three together are the
difference between "a nice voice wrapper on one terminal" and "the cockpit I run my company from."
