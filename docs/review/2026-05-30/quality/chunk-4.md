# Chunk 4 — Status Detection, Monitoring, Attention & Proactive Alerts — Quality & Correctness

**Score: 6/10** — The status state-machine + process-tree probe are carefully designed and well-tested, and the announcement bus de-spam logic is solid, but pane EXIT produces no alert at all, the error/build classifier fires on substrings of ordinary output, watch rules write un-gated, and the probes do blocking syscalls on the event loop.

## Findings

- **`server.ts:515-558` + transport `onExit` — HIGH — A pane process exiting produces NO operator notification.** `detectAndTriggerTransitions` only runs from `manager.onOutput` (a data event). When a process exits it emits no further output, so the `term.status === "Exited" => transition = "exited"` branch (520-521) is effectively dead — nothing calls it. There is no `manager.onExit`/transport-exit → attention/announcement wiring anywhere (`onIdle` exists, `onExit` does not). Net effect: a crashed/exited agent pane is silently dead; no earcon, no attention item, no `pane_transition:"exited"`, no desktop notification. This defeats the core "what died / what needs attention" monitoring promise (Journey 6). Fix: wire `UniversalTerminal.onExit` through to an `exited` announcement + attention push.

- **`server.ts:336-362` (`handleWatchRulesTrigger`) — HIGH — Watch-rule actions write to the target pane WITHOUT the permissions gate.** `targetTerm.writeInput(rule.actionCommand)` (345) runs whenever the trigger fires, ignoring the target pane's effective mode. If the operator sets the action pane to `Read-Only`, an armed watch rule still injects commands into it. Watch rules are operator-armed automation, but they should still honor Read-Only / least-authority (the rest of the system routes every write through `effectiveModeFor`). Real-world impact: a Read-Only pane is not actually write-protected against automation.

- **`server.ts:536-542` (error classifier) — MED — Substring matching on `"Error:"`/`"Exception:"`/`"fatal: "` fires spurious error attention + alert earcons on normal output.** Any chunk containing the literal `Error:` (an agent narrating "No Error: encountered", a test runner printing "Error: handled correctly", a stack-trace echo) is classified `error`, pushing an attention item and an alert earcon. The classifier is content-based and status-independent (it fires even on a Running pane mid-log). High false-positive rate undermines trust in the alerting. Fix: scope to recent tail + require stronger signals (line-anchored, exit-code aware).

- **`src/statusProbe.ts:326-388` (probes use `execSync`/sync `readFileSync` on the event loop) — MED — Every probe tick blocks the Node event loop.** `MacPsProbe`/`WindowsProbe` call `execSync("ps …")` / `execSync("powershell …")` with 2-4s timeouts every 500ms PER pane; `LinuxProcProbe` synchronously reads every `/proc/<pid>/stat` every 500ms per pane. With several panes (or a slow `ps`/`powershell` spawn), this stalls the WS/audio bridge and stdout streaming on the main thread. The `interactive_cli` downgrade (`terminal.ts:365`) spares agent panes, but every Custom/shell pane on macOS/Windows pays an `execSync` per tick. Fix: async exec, longer interval, or a shared single process snapshot per tick across all panes.

- **`server.ts:560-562` (`lastStates` edge-dedup) — MED — A second identical-type event on a pane is suppressed even when it is a genuinely new event.** `lastStates[terminalId]` holds the last transition; a pane that errors, then the operator dismisses, then errors AGAIN with the same `error` type emits no new attention/earcon because `transition === previousState`. Two distinct build failures in a row are coalesced into one alert. For a flapping build this is intentional de-spam, but for two genuine sequential failures it loses the second signal entirely.

- **`src/announcementBus.ts:207` + `flush` ordering — LOW — Rate-limit "wait" can re-order/age out lower-priority items.** When the token bucket is empty, `flush` re-arms and keeps items; on the next flush, items older than `itemTtlMs` are dropped. A burst of low-severity completions can therefore be silently dropped while high-severity ones survive — acceptable by design, but a completion the operator was waiting on can vanish with no trace.

- **`server.ts:1352` — LOW — `exited` AnnouncementKind reused for "Awaiting your approval".** The pending-approval path enqueues `kind:"exited"` (alert earcon) purely to borrow the high-severity bucket. Semantically wrong — the operator hears the "process exited" tone for a pending approval, and any future per-kind handling of `exited` will mis-treat approvals. Should be its own kind.

## Does-it-do-the-job verdict
Busy/idle detection and the completion announcement are genuinely good and the de-spam plumbing is thoughtful, so "is it busy / did it finish" works. But the monitoring story has a hole at its center — process EXIT is not surfaced — and the error alerting is noisy enough (substring matches) to erode trust, so the proactive-attention feature is only partially fit for purpose.

## Top fixes
1. **HIGH** — Wire transport `onExit` to an `exited` attention item + announcement so a dead pane actually alerts.
2. **HIGH** — Route watch-rule `actionCommand` writes through `effectiveModeFor` (at least honor Read-Only).
3. **MED** — Replace substring `Error:`/`Exception:` matching with line-anchored / exit-code-aware classification to kill false positives.
4. **MED** — Make the status probes async (or share one process snapshot per tick) so they don't block the event loop.
5. **LOW** — Give pending-approval its own AnnouncementKind instead of reusing `exited`.
