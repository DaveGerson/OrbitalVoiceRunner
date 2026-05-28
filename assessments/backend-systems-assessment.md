# Backend / Distributed Systems Assessment — Orbital Harness / Janus Terminal Orchestrator

## Reviewer

**Marcus Chen** — Senior Backend / Distributed Systems Engineer (12 yrs). Lens: real-time
streaming, child-process orchestration, WebSocket/session lifecycle, concurrency, persistence
durability, and resource management. I evaluated the server, terminal, and persistence layers for
**capability** (what works today) and **fit** (does the architecture hold up under real,
multi-pane, long-running, crash-prone usage).

---

## Executive Summary

The codebase is a clean, readable proof-of-concept that wires a browser mic to a Gemini Live
session and brokers tool calls into local `child_process` terminals with a permissions gate. The
happy path is coherent and the layering (server → `OrchestratorManager` → `UniversalTerminal` →
ledger/settings) is sensible. However, the systems substrate is **not** built for the stated goal
of orchestrating *multiple, long-running, interactive* CLI agents: terminals are spawned via
`spawn('/bin/sh', ['-c', ...])` with **pipes, not a PTY**, which breaks every interactive TUI agent
the product is designed around (Claude Code, Codex, etc.). The session/WebSocket layer has **no
reconnection, no resumption wiring, no backpressure, and a single shared `pendingApprovals` map**,
and persistence does **synchronous, unthrottled, racy whole-file writes** on every event. Several
features (`cpuUsage`, session-ID scraping, "semantic delta filter") are stubs/simulations. This is a
strong demo skeleton that needs a real PTY layer, durable async persistence, and a hardened session
lifecycle before it survives production use.

---

## Strengths (what is genuinely good)

- **Clean layering and separation of concerns.** `OrchestratorManager` (lifecycle/registry),
  `UniversalTerminal` (process wrapper), and `Ledger` (persistence) are well-separated with narrow
  interfaces. `server.ts:14`, `src/terminal.ts:240`, `src/ledger.ts:26`.
- **The permissions gate is conceptually correct and centralized.** The three-mode policy
  (`Full Auto` / `Human-in-the-Loop` / `Read-Only`) plus a global `Inherit` override is resolved in
  one place before any `writeInput`, and HITL correctly *withholds* the tool response until operator
  approval. `server.ts:373-432`. This is the right shape for a command-gating system.
- **Output is normalized for token economy.** ANSI stripping (`stripAnsiSequences`,
  `src/terminal.ts:56`) plus a bounded ring buffer (`maxBufferLines`, `src/terminal.ts:186-188`)
  keeps the model's observation cheap, matching the "token-light, pull-not-push" design intent.
- **Broadcast fan-out is defensive.** `broadcast()` checks `readyState === 1` and try/catches each
  send so one dead socket cannot crash the loop. `server.ts:37-48`.
- **Settings/ledger loading is defensive with deep-merged defaults.** `loadSettings()` merges
  per-section defaults and never throws on a corrupt file (`src/terminal.ts:292-316`); API-key
  responses are masked (`server.ts:240-245`) and write-backs preserve the real key when the masked
  placeholder is sent back (`server.ts:251-253`). Good instincts.
- **Tests exist for the deterministic core** (ANSI strip, spawn+capture, ledger persistence
  round-trip): `tests/test_server.ts`, `tests/test_ledger.ts`.

---

## Weaknesses / Risks (ranked, with evidence and impact)

### 1. Pipes instead of a PTY — interactive CLI agents will not work (CRITICAL / fit-breaking)
`src/terminal.ts:169-172` spawns with default stdio **pipes**. The product's entire premise is
driving interactive agent CLIs (Claude Code, Codex, Antigravity — see presets at
`src/terminal.ts:49-51`). Those tools detect `isatty() === false` and either refuse to run, disable
their TUI/prompts, or buffer output (no line-buffered flushing). Symptoms under real use:
- No terminal echo, no prompt rendering, no arrow-key/REPL behavior.
- stdout block-buffered by libc → the model sees nothing until a 4–8 KB buffer fills or the process
  exits, defeating the live "pane summary" loop.
- `writeInput(cmd + "\n")` (`src/terminal.ts:222-226`) writes to a pipe, not a TTY, so programs that
  read from the controlling terminal (password prompts, `less`, full-screen UIs) never receive it.

**Impact:** The headline capability is non-functional for its target programs. **Fix requires
`node-pty`** (or equivalent). This is the single biggest fit gap.

### 2. No WebSocket/session reconnection or resumption wiring (HIGH)
`wss.on("connection", ...)` (`server.ts:307`) creates a fresh Gemini Live session per socket and
**`clientWs.on("close")` does nothing to tear the session down** (`server.ts:597-603`). Problems:
- **Session leak:** every browser reconnect (network blip, tab refresh, laptop sleep) opens a *new*
  Gemini Live session and orphans the old one. There is no `session.close()` anywhere. Over a long
  workday this leaks upstream sessions and audio streams.
- `sessionResumption: {}` and `contextWindowCompression` are passed in config (`server.ts:468-474`)
  but **resumption handles are never captured or replayed** — `onmessage` ignores
  `sessionResumptionUpdate`. So the "resume" is cosmetic; a dropped socket loses all conversation
  state.
- `activeFrontendWs` (`server.ts:34`, `:308`, `:599`) is a single-client global; the `clients` Set
  implies multi-client, but session brokering assumes exactly one. Two tabs → two sessions writing
  to the same shared terminals and the same `pendingApprovals` map with no isolation.

**Impact:** Unreliable over real networks/long sessions; upstream resource leak; broken multi-client
story.

### 3. Synchronous, unthrottled, racy whole-file persistence (HIGH)
`Ledger.save()` and `saveSettings()` use blocking `fs.writeFileSync` of the entire JSON document
(`src/ledger.ts:49-59`, `src/terminal.ts:318-324`), and `save()` is invoked on **every** mutation —
including inside `syncLedger()`'s per-terminal loop (`src/terminal.ts:411` → `updatePane` →
`save()`), which runs on every `list_panes` call. With N panes that's N full-file rewrites per
orientation call.
- **Blocking the event loop:** synchronous disk writes stall the WS broadcast and audio relay path.
- **Lost-update races:** `save()` is non-atomic (no temp-file + rename). A crash mid-write, or two
  near-simultaneous mutations (e.g. an HTTP `PUT /permissions` at `server.ts:166-185` racing a
  `syncLedger` write), can produce a truncated/corrupt `.janus_ledger.json`. There is no lock and no
  write coalescing.
- `getRecentOutput`/buffer mutation and `save()` interleave without any guard.

**Impact:** Latency hiccups in the realtime path; risk of corrupting the durable state the whole
product is built around.

### 4. Process teardown is incomplete — zombie/leaked child processes (HIGH)
`stop()` calls `this.process.kill()` (default `SIGTERM`) then immediately nulls the reference
(`src/terminal.ts:232-237`). Issues:
- Because children are spawned as `/bin/sh -c "<cmd>"`, killing the **shell** does not necessarily
  kill the **grandchild** (`npx ...` → node → the actual agent). No process-group kill
  (`detached: true` + `process.kill(-pid)`) and no `SIGKILL` escalation/timeout. Long-lived agents
  will survive as orphans.
- `idleTimer` is **never cleared on stop()** (`src/terminal.ts:74`, set at `:159`). After `stop()`
  the timer can still fire and flip a dead terminal's `status` — and on `restart` (`server.ts:106-107`)
  the old timer is leaked.
- Restart calls `stop()` then `start()` synchronously (`server.ts:106-107`) with no wait for exit;
  the new spawn can race the old one's teardown.
- No global shutdown hook (`SIGINT`/`SIGTERM` on the server) to reap all children — Ctrl-C leaves
  every pane's process tree running.

**Impact:** Resource/process leaks accumulate over a session; "restart" is unreliable.

### 5. No backpressure on stdout fan-out (MEDIUM-HIGH)
`onOutput` pushes **every** raw stdout chunk straight to `broadcast()` → `client.send()`
(`src/terminal.ts:181-183` → `server.ts:50-56`). `ws` buffers unbounded in `socket.bufferedAmount`
when the client is slow. A chatty pane (a build, `yarn install`, a log tail) emits megabytes; with a
slow/backgrounded browser tab, server memory grows without bound. There is no coalescing, no
`bufferedAmount` check, no chunk rate-limiting, and the raw chunk is *also* re-buffered and ANSI-
processed on every event.

**Impact:** Unbounded server memory under large output; the exact "large output" stress case called
out in the brief.

### 6. `JSON.parse` on inbound WS messages is unguarded (MEDIUM)
`clientWs.on("message", (data) => { const msg = JSON.parse(data.toString()); ... })`
(`server.ts:581-582`) has **no try/catch**. A single malformed frame throws inside the handler;
depending on ws internals this is an unhandled error per-connection. Audio frames arrive constantly,
so this is a real liveness risk, not theoretical.

### 7. `pendingApprovals` keyed by `call.id` with no expiry, capture, or isolation (MEDIUM)
`server.ts:265`, `:421-422`. The map is module-scoped and shared across all sockets. The stored
`session` reference (`:422`) is captured at approval time; if the originating socket/session has
since closed, `pending.session.sendToolResponse(...)` (`:283`, `:292`) will throw against a dead
session (no guard). Entries never expire — an operator who ignores a prompt leaks it forever, and
the model is left waiting on a tool response that may never come (Gemini Live will stall that turn).

### 8. Command injection / no validation on `propose_command` and `/api/terminals` (MEDIUM, security-adjacent)
`writeInput` writes arbitrary strings into a shell stdin; `addTerminal` spawns
`/bin/sh -c <command>` from request body (`server.ts:89-99`) with no allow-list, no path
confinement, and `env: process.env` (full host env, incl. secrets, exported to every child —
`src/terminal.ts:171`). `Full Auto` mode auto-dispatches model-proposed commands with zero human
review (`server.ts:380-395`). For a localhost tool this is "by design," but there is no auth on the
HTTP/WS surface at all, so anything on the host (or LAN, given `host: 0.0.0.0` at
`src/terminal.ts:253` / `server.ts:621`) can spawn shells and run commands.

### 9. Simulated / stub telemetry presented as real (LOW-MEDIUM, correctness/trust)
- `cpuUsage` returns `Math.random()`-based fake numbers (`src/terminal.ts:127-133`) yet is surfaced
  through `/api/terminals` and into the ledger as `cpu_usage`. Operators will trust fabricated load
  data.
- `checkForSessionId` regex-scrapes stdout for a session id (`src/terminal.ts:135-153`) — brittle,
  and the first matcher block is a no-op (`:136-138`).
- "Semantic Delta Filter" is a stub that just wraps recent output in a code fence
  (`getPaneSummary`, `src/terminal.ts:415-422`) — there is no actual *delta*; the model re-reads
  overlapping buffer slices each call, wasting tokens (contradicting the stated token-light goal).

### 10. `idleTimer`-driven status is not a real busy/idle signal (LOW)
"Running vs Idle" is purely "did stdout emit in the last 2s" (`src/terminal.ts:155-162`). A process
silently waiting on input reads as `Idle`; a process spewing logs while truly stuck reads as
`Running`. `is_busy`/`alive` in the ledger inherit this imprecision (`src/terminal.ts:402-405`).

---

## Capability Gaps (missing functionality for the stated goal)

- **No PTY** → interactive agents, prompts, TUIs, and proper line buffering are unsupported (see #1).
- **No reconnection/resumption** → long sessions and flaky networks lose all state (see #2).
- **No session teardown / process-group reaping** → leaks (see #2, #4).
- **No real "delta" observation** → `get_pane_summary` re-sends overlapping output; no diffing,
  no scroll cursor, no per-pane "since last read" watermark (see #9).
- **No output persistence/scrollback beyond 100 in-memory lines** — server restart or pane restart
  loses all terminal history; the ledger stores metadata only, not transcripts.
- **No auth / no CSRF / no origin check** on the HTTP+WS control plane.
- **No rate limiting or audio backpressure**, despite `rateLimitRequestsPerMin`/`audioBufferSize`
  settings existing in the schema (`src/types.ts:76-88`) — they are defined but never enforced.
- **No structured logging / metrics / health endpoint** for a system meant to run many long-lived
  processes; debugging a stuck pane means reading `console.log`.
- **No concurrency control on the ledger** for the documented multi-pane case.
- **Single active client assumption** conflicts with the multi-client `clients` Set.

---

## Recommendations (effort S/M/L · impact High/Med/Low)

1. **Adopt `node-pty` for `UniversalTerminal`.** Replace `spawn` pipes with a pseudo-terminal;
   resize support, real TTY semantics, proper flushing. (L · **High**) — *unblocks the core product.*
2. **Harden the session lifecycle.** On `clientWs.close`, call `session.close()`; capture
   `sessionResumptionUpdate` handles and replay on reconnect; guard `sendToolResponse` against closed
   sessions. (M · **High**)
3. **Make persistence async, atomic, and coalesced.** Switch to `fs.promises.writeFile` to a temp
   file + `rename`; debounce/queue writes (single in-flight writer, dirty flag); stop calling
   `save()` inside the per-pane `syncLedger` loop. (M · **High**)
4. **Fix process teardown.** Spawn `detached: true`, kill the process group, `SIGTERM`→timeout→
   `SIGKILL`; clear `idleTimer` in `stop()`; add a server `SIGINT`/`SIGTERM` handler that reaps all
   terminals; make `restart` await exit. (M · **High**)
5. **Add stdout backpressure + coalescing.** Buffer chunks per pane, flush on a small interval or
   size threshold, skip/drop-coalesce when `client.bufferedAmount` exceeds a watermark. (M · **High**)
6. **Wrap inbound WS `JSON.parse` in try/catch** and validate message shape. (S · **Med**)
7. **Expire `pendingApprovals`** (TTL + timeout tool-response), key by `{socketId, callId}`, and
   isolate per session. (S · **Med**)
8. **Replace simulated `cpuUsage`** with real metrics (`pidusage`) or remove it from the API/ledger
   to avoid fabricated telemetry. (S · **Med**)
9. **Implement a real delta in `get_pane_summary`** (per-pane read cursor; only emit new lines). (S · **Med**)
10. **Add minimal auth + origin/CORS checks** on HTTP/WS, and stop binding `0.0.0.0` by default
    (use `127.0.0.1`). Scrub `env` passed to children. (M · **High** for any non-localhost use)
11. **Add structured logging + a `/healthz`** and persist scrollback (rotating file per pane). (M · **Med**)

---

## Top 5 Prioritized Roadmap Items

1. **PTY backend (`node-pty`)** — without it the product does not do what it claims. (L · High)
2. **Process-group teardown + global shutdown reaper + `idleTimer` cleanup** — stop leaking
   processes/timers across restarts and Ctrl-C. (M · High)
3. **Async, atomic, debounced persistence** — remove blocking writes from the realtime path and
   eliminate ledger-corruption races. (M · High)
4. **Session lifecycle: close on disconnect + real resumption + closed-session guards** — make long,
   flaky sessions survivable and stop leaking upstream Gemini sessions. (M · High)
5. **stdout backpressure/coalescing + guarded WS message parsing** — survive large output and bad
   frames without unbounded memory or per-connection crashes. (M · High)

---

*Evidence cited inline as `file:line`. No source code was modified; this assessment is the only
artifact produced.*
