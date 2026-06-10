# Live-Validation Checklist — Phase PR Stack (#64–#68)

> Companion to `EXECUTION-PLAN-V2.md`. Every PR in the stack is green on the automated gates
> (full unit battery, mock e2e, build; #68 additionally on the live-server e2e lane). This
> document classifies the changes by what automation **could not** verify, so merges can be
> sequenced by safety. Verdict per PR, then the concrete live tests with commands.
>
> Two facts frame the classification:
> 1. **This container is Linux.** Everything Windows-specific (ConPTY, PowerShell CIM probes,
>    file renames under AV) shipped verified-by-construction + unit tests, but has never
>    executed on Windows in this stack. The production host is Windows 11.
> 2. **Mock e2e can't drive real browser permissions, real audio, or a real Gemini session.**
>    Those paths are typechecked and unit-tested but not experienced.

## Per-PR safety verdicts

| PR | Verdict | Why |
|----|---------|-----|
| #63 docs | **Merge anytime** | No executable change. |
| #64 Phase 0 | **Merge without live testing** | Timer-ref semantics are only observable in drained-loop contexts (tests/scripts); a running server's loop is held by the listener regardless. Full battery + CI prove the change. |
| #65 Phase 1 | **Merge without live testing; 10-min browser pass recommended after** | Every change either adds a failure handler (`.catch`, `res.ok`, error boundary — cannot alter the happy path), fixes an inverted guard with real-PTY test coverage (restart wedge), or is display/narration logic that fails toward the previous behavior. The browser pass is to *see* the new states (MIC BLOCKED, TUNING IN…), not to de-risk regressions. |
| #66 Phase 2 | **Merge without live testing, with one ritual: back up `.janus.db` first** | Server logic is deterministic and heavily unit-tested; schema **v8 is additive ALTERs** but it's the first migration on the real production DB in this stack — standard backup caution, not a code concern. Desktop notifications need a real browser to observe. |
| #67 Phase 3 | **Gate on a live session — this PR concentrates the real-regression-risk changes** | Two-socket client refactor, WS heartbeat, voice-session generation guards, SIGKILL/ConPTY latch change, DB quarantine renames. All tested against fakes/stubs/Linux; the real Gemini session, real network sleep/wake, and the Windows host are the residual unknowns. |
| #68 Phase 4 | **Gate on the Windows pass (Linux-only deployments could merge on green)** | History flush (tmp+rename under Windows AV), async PowerShell CIM probe path — the two changes whose failure modes are data-loss/status-blindness and whose changed code is Windows-specific. Defer/digest/surfaces are unit+e2e covered; their live check is about spoken feel, not correctness. |

## The five regression-risk changes (where live testing is REQUIRED, not nice-to-have)

1. **Two-socket split + terminal resync** (#67, client). Risk: stream regression where it
   previously worked. Test: real browser, real server — open a busy burner; sleep/wake the
   laptop (expect the dim "— reconnected; replayed from snapshot —" marker, no duplicates);
   toggle the Kitchen Radio repeatedly mid-stream (expect zero loss/clearing).
2. **WS heartbeat** (#67, server). Risk: terminating healthy-but-slow clients. Test: leave the
   kitchen open idle 5+ minutes (no spurious disconnect toasts); then hard-drop the network for
   45s and confirm the ghost client is reaped server-side (log line) and the UI reconnects clean.
3. **Voice-session generation guards + last-call ack** (#67). Risk: reconnect regression against
   the REAL Gemini Live API (fake-connector tested only). Test: with a real key, tune in, talk,
   kill wifi mid-utterance, restore — expect "voice channel lost" → "Back on the air.", mic
   works after recovery, exactly one live session (watch server logs for duplicate-session
   warnings); stage an approval and let it reach last-call — it must be SPOKEN before any
   auto-reject. `npm run verify:modeswitch` exercises the live pane path.
4. **SIGKILL escalation / ConPTY latch** (#67, Windows). Risk: regressing the historical ConPTY
   double-dispose crash ("AttachConsole failed") the latch existed for. Test on the Windows box:
   full `npm test` ×3 (the teardown flake was nondeterministic), then live-kill a pane running
   a SIGTERM-ignoring child and confirm no zombie (`Get-Process`) and no conout crash.
5. **History flush + async CIM probe** (#68, Windows). Risk: history data-loss under AV
   file-locking (tmp+rename), and status-detection blindness if `execFile powershell` behaves
   differently than `execSync` did. Test on the Windows box: run a chatty pane 10 min (build
   loop), confirm `.janus_history.json` stays current + uncorrupted across a server restart;
   confirm shell-pane Idle/Running edges still fire (watch the board), and voice latency
   no longer spikes with a shell pane open (the point of the change).

## The Windows pass (one sitting, ~30 min, covers #67+#68 platform risk)

```powershell
git fetch origin claude/phase4-longevity && git checkout claude/phase4-longevity
npm ci                       # package-lock changed (playwright project, scripts)
npm test                     # x3 — watch for the old ConPTY teardown signature
npm run dev                  # then live: start a pane, restart it, kill it externally,
                             # run a chatty build, clear-exited, stop-all engage/release
npm run test:e2e:live        # the live lane must also pass on Windows
```

## The browser/voice pass (one sitting, ~15 min, covers the experiential items in #65–#68)

1. Fresh Chrome profile: deny mic → chip must read MIC BLOCKED (not "● LIVE").
2. Normal profile: tune in → TUNING IN… → LIVE; say "mute the mic" → chip MUTED and mic
   genuinely stops; volume slider audibly changes the Chef's voice.
3. Background the tab; let a command finish → desktop notification arrives.
4. Stage an approval, say "hold that for now" → it parks and re-asks later (not cancelled).
5. Stage 3 approvals, press Escape once → only the top dialog dismisses.
6. Tune out for 5 minutes while a pane finishes and one errors; tune back in → the
   "while you were away" digest mentions both.
7. Keyboard only: Tab to a station, Enter opens it, Escape closes, hold Space on the
   emergency stop → stage-2 kill fires.

## Why the stack was NOT physically re-ordered by safety

The existing merge order already approximates safety order (#63/#64 risk-free → #65/#66
merge-safe → #67/#68 live-gated), and the risky items depend on earlier commits (the client
refactor builds on Phase 1's handlers; the probe change builds on Phase 0's timer rule).
Re-authoring the branches into risk tiers would invalidate five CI-verified states and the
per-phase review narratives for no change in the practical merge sequence: merge #63→#66 on
green, run the two passes above, then merge #67→#68.
