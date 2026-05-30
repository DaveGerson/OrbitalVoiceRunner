# Chunk 2 — Terminal / Pane Lifecycle & Live I/O — Quality & Correctness

**Score: 6.5/10** — Pane spawn/stream/stdin and the node-pty-vs-legacy transport seam are solid and the status-machine plumbing is careful, but the restart path has a real async race, several tool/REST entrypoints skip input validation, and stdout for not-yet-known panes is silently dropped.

## Findings

- **`server.ts:686-694` (restart route) — HIGH — `term.stop()` not awaited before `term.start()`.** `UniversalTerminal.stop()` is async (returns a Promise; SIGTERM then SIGKILL after 1s). The route calls `term.stop(); term.start();` synchronously. `start()` immediately reassigns `this.transport` to a fresh PTY, but the OLD transport's `onExit` handler (registered in the old `start()`) is still live and, when the killed process finally exits, runs `this.status = "Exited"` + `clearProbeTimer()` on the **restarted** terminal — flipping a healthy, just-restarted pane to Exited and tearing down its probe timer. Also two PTYs briefly co-exist writing to the same scrollback file. Fix: `await term.stop()` before `start()` (make the handler async), or have `stop()` detach its old callbacks.

- **`src/App.tsx:301-310` (queueStdoutChunk flush) — MED — stdout for a pane not yet in `terminals` state is silently discarded.** The flush maps over `prev` terminals and only applies `currentBuffers[t.id]` when `t.id` matches an existing row. A pane created via `create_pane`/`POST /api/terminals` streams `stdout_chunk` immediately, but `terminals` is refreshed asynchronously via `fetchTerminals()`; any chunks that arrive before the fetch completes are dropped (the buffer was already cleared at line 299). First lines of a new pane's output can be lost from the live view.

- **`server.ts:1674-1687` (`create_pane`) — MED — no validation of `pane_id`/`command`.** Unlike `POST /api/terminals` (which 400s on missing fields, `server.ts:667`), the tool passes `command` straight to `addTerminal`. A model call with `command` undefined yields `shellCmd=undefined` and `createPtyTransport(undefined,…)` spawns `/bin/sh -c undefined`. Should validate and return a tool error.

- **`src/terminal.ts:716-718` (`addTerminal` duplicate id) — MED — duplicate id returns a string instead of erroring, and the caller treats it as success.** `addTerminal` returns `"Terminal '…' already exists."` (a plain string, no throw). `POST /api/terminals` and `create_pane` both wrap that string in `{ success: true, result }` / a success tool response, so the operator/model is told the pane was created when it was not (the existing pane is untouched, no new PTY). Misleading control flow.

- **`server.ts:612-631` (server stdout coalescer) — LOW — `outputBuffers[terminalId]` is never deleted when a pane is removed/exits.** Unbounded key growth across a long session with many short-lived panes (small leak). Also a single shared `flushTimeout` is fine, but a dead pane's last partial chunk can still be flushed after deletion.

- **`src/ptyTransport.ts:141-146` (LegacyChildProcessTransport) — LOW — `exit` AND `close` AND `error` all fan out to `exitCbs`.** A process that errors then closes (or exits then closes) invokes every registered exit callback up to 2-3 times. In `terminal.ts` `onExit` flips status to Exited (idempotent) so it's benign there, but `stop()`'s `done()` is guarded by `resolved` so also safe — still, double-firing exit semantics is fragile if a future onExit isn't idempotent.

- **`src/terminal.ts:451-454` — LOW — `appendScrollback` + `applyStatusEvent` + `checkForSessionId` run on every raw chunk synchronously inside `onData`.** `checkForSessionId` runs 5 regexes over each decoded chunk and `appendScrollback` does a synchronous `fs.appendFileSync` + `statSync` per chunk; under a high-throughput build (e.g. webpack progress) this is blocking I/O on the event loop per PTY data event. Performance, not correctness, but can stall the WS bridge.

## Does-it-do-the-job verdict
Core create→spawn→stream→stdin works and the transport abstraction with fallback-probe degradation is well thought through, so day-to-day pane operation is functional. But the un-awaited restart race can zombify a pane's status/probe, and dropped early-stdout plus silent duplicate-id "success" undermine reliability of the lifecycle for the orchestration use case.

## Top fixes
1. **HIGH** — `await term.stop()` before `term.start()` in the restart route (and/or have `stop()` unsubscribe the old transport callbacks) so the dying PTY can't flip the restarted pane to Exited.
2. **MED** — In `queueStdoutChunk`, retain buffered chunks for unknown pane ids (or merge against a ref keyed by id, not against `terminals` rows) so a new pane's first output isn't lost.
3. **MED** — Validate `command`/`pane_id` in `create_pane` and surface duplicate-id as an explicit error (not `success:true`) in both the REST route and the tool.
4. **LOW** — Delete `outputBuffers[id]` when a pane is stopped/removed.
5. **LOW** — Make `appendScrollback` async/batched to avoid sync fs I/O on the event loop per data event.
