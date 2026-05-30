# Chunk 2 — Terminal / Pane Lifecycle & Live I/O — Simplicity & Clarity

**Score: 7/10** — The PtyTransport seam and the status-machine side-effect split are clean and well-documented; the main drags are a fully dead parallel Python implementation, a preset→command map duplicated in three places, and the `--dangerously-skip-permissions` flag-mangling logic copy-pasted between two methods.

## Findings

- `universal_terminal.py` (whole file, 88 LOC) — **Dead code.** The TS runtime spawns exclusively through `createPtyTransport` (node-pty / `LegacyChildProcessTransport`); nothing in `server.ts` or `src/` references this Python module — only `tests/test_universal_terminal.py` imports it. It is a complete second PTY implementation kept alive solely by its own test. Deleting it (and its test) removes an entire parallel mental model of "how a pane is spawned."
- preset→command mapping duplicated 3×: `terminal.ts:690-693` (constructor restore), `server.ts:699-702` (restart-restore), and the defaults baked into `parsePresetsSafe` / `CreateTerminalDialog.tsx:31-39`. All four map `"Claude Code"→"npx @anthropic-ai/claude(-code)"`, `"Codex"→"npx codex(-cli)"`, `"Antigravity"→"npx antigravity"` — and they already disagree (`claude` vs `claude-code`, `codex` vs `codex-cli`). One `commandForPreset(preset)` helper would unify them and kill the drift.
- `--dangerously-skip-permissions` add/strip logic is duplicated verbatim in the constructor (`terminal.ts:196-205`) and `setPermissionsMode` (`terminal.ts:219-231`). Extract a single `applySkipFlag(cmd, mode, preset)` pure helper; right now a fix to one path silently misses the other.
- `parsePresetsSafe` (`terminal.ts:13-60`) builds the same 12-field preset object three times (array branch, object branch, default branch) with slightly different field sources. A single `normalizePreset(raw, idFallback, nameFallback)` would remove ~25 lines of near-duplicate literals.
- `server.ts:686-712` restart route has two divergent paths (live restart vs ledger-restore) that both re-derive the command and both call `broadcastLedgerUpdate()`+`broadcast({type:"terminals_updated"})`. The restore branch re-implements the constructor's restore mapping (another copy of the preset map above). Could collapse to: resolve command once, `addTerminal`, broadcast once.
- `terminal.ts:237-255` `checkForSessionId` opens with a dead `if` block (L238-240) whose body is only a comment ("Keep preset/simulated...") and does nothing — pure noise that reads like it should branch but is a no-op. Delete it.
- `terminal.ts:264-353` `applyStatusEvent` is long (~90 lines) and carries a lot of inline design-rationale prose, but the structure (decide → apply effects: timers, status stamp, onIdle edge) is genuinely clear and the comments are load-bearing. The two `sawWorkSinceIdle = true` assignments (L284-291 and L310-317) are separated by the `decideStatus` call and easy to miss as a pair; a comment cross-link or merge would help, but no real over-engineering here.
- `src/App.tsx:292-313` `queueStdoutChunk` (rAF-batched per-pane buffer flush) is a tidy, well-chosen pattern. The magic `slice(-110)` / `slice(-110)` line cap is unexplained and duplicated against the server's `maxBufferLines=100`; name it.
- `ptyTransport.ts` — Clean. The lazy `loadNodePty` memoization and the two transport classes behind one interface are exactly the right amount of structure. No change.

## Top fixes
1. Delete the dead `universal_terminal.py` (and `tests/test_universal_terminal.py`) — removes an entire redundant spawn implementation.
2. Introduce one `commandForPreset(preset)` helper and replace the 3-4 duplicated/diverging preset→command maps (`terminal.ts:690-693`, `server.ts:699-702`, dialog/defaults).
3. Extract `applySkipFlag(cmd, mode, preset)` to dedupe the `--dangerously-skip-permissions` logic across the constructor and `setPermissionsMode`.
4. Collapse `parsePresetsSafe`'s three near-identical object builders into one `normalizePreset`.
5. Remove the no-op `if` block in `checkForSessionId` (`terminal.ts:238-240`).
