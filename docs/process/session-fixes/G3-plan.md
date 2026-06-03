# G3 — stdin/TTY readiness race: queue `writeInput` until spawn-ready

**Bead:** `wsm-e2e-pinned-b0h` · **Priority:** P3 · **Type:** bug · **Kind:** backend
**Files:** `src/terminal.ts`, `src/ptyTransport.ts`
**Status:** design complete, ready to implement (TDD). Code refs verified against `main` checkout `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner` on 2026-06-02.

---

## BLUF

`UniversalTerminal.writeInput()` writes to the transport **synchronously and unconditionally** (`src/terminal.ts:597-599`). On a freshly spawned ConPTY child, the agent's stdin reader has not yet attached, so the earliest bytes are dropped on the floor. The spawned **Claude CLI** then prints `Warning: no stdin data received in 3s` and may exit — surfacing as "panes never hold a live session."

Fix: gate `writeInput` behind a `spawnReady` flag. Buffer input into a `pendingInput[]` queue while not ready; flush **in order** on the first `onData` from the transport, with a ~750ms `unref`'d fallback timer so a silent child (no banner) still drains the queue. node-pty is **already a declared dependency** (`package.json:24`) — there is no package.json edit.

Two things from the dossier that must NOT be over-implemented (verified against code):
- The "node-pty is an absent dependency" framing is **wrong** — node-pty resolves fine (`tests/test_pty_transport.ts` asserts `nodePtyAvailable() === true`). Keep ONLY the readiness-queue mechanism.
- The "downgrade win32 hard-fail preflight to a warning" sub-item is a **no-op against current code**: grep confirms there is no win32 refuse-to-boot preflight and no `"no stdin"` string anywhere in `src/`. The warning is emitted by the child CLI, not by us. This plan therefore drops that sub-item (see Risks → "Scope guard").

---

## Problem & root cause (code-anchored)

### The unguarded write
`src/terminal.ts:592-600`:
```ts
writeInput(command: string) {
  this.lastCommand = command;
  this.applyStatusEvent({ kind: "input" });
  if (this.transport) {
    this.transport.write(command + "\n");   // <-- fires the instant transport exists
  }
}
```
`this.transport` is assigned at `src/terminal.ts:519` inside `start()`, the same synchronous tick as the spawn (`createPtyTransport`, `src/terminal.ts:513`). So `transport.write()` can run **before the child's stdin is readable**. node-pty's `write()` itself never throws here (`NodePtyTransport.write` swallows in a try/catch, `src/ptyTransport.ts:120-126`), so the loss is silent — the bytes go into a ConPTY master that the child has not yet wired its reader to.

### Why the bytes vanish
The race window is: `pty.spawn()` returns a handle synchronously (`src/ptyTransport.ts:99-105`), but the child process (`cmd.exe /c claude …`, `src/ptyTransport.ts:263-271`) takes real wall-clock time to exec and attach its stdin reader to the ConPTY. Any `write()` in that gap is delivered to the PTY before the consumer exists. The Claude CLI's own 3s stdin-watchdog then fires.

### The natural readiness signal we already have
`start()` already subscribes to `transport.onData` (`src/terminal.ts:538-553`). **First data out = the child is alive and has attached its PTY** — a reliable "ready" edge that costs nothing extra. We piggyback the flush on it. The 750ms timer is the belt to that suspenders: a child that produces no output before we need to write still gets its queue drained.

### No existing seam for tests
`start()` calls `createPtyTransport` directly (`src/terminal.ts:513`). There is currently **no injection point**, so the readiness/queue behavior is untestable without spawning a real ConPTY. The fix adds a minimal `transportFactory` seam (default = `createPtyTransport`) so a fake transport can be injected — matching the existing "test the contract without spawning" pattern in `tests/test_terminal_resize.ts:24-29`.

---

## Exact changes (file : location : change)

### Change 1 — `src/terminal.ts` : new private state (near the transport field, ~line 190)
Add alongside `private transport: PtyTransport | null = null;`:
```ts
// G3: stdin/TTY readiness gate. A freshly spawned ConPTY child has not yet
// attached its stdin reader, so the earliest writeInput() bytes are lost and the
// agent CLI prints "Warning: no stdin data received in 3s". We buffer input until
// the child proves itself ready (first onData) or a short fallback timer fires.
private spawnReady = false;
private pendingInput: string[] = [];
private readyFallbackTimer: NodeJS.Timeout | null = null;
private static readonly READY_FALLBACK_MS = 750;
```

### Change 2 — `src/terminal.ts` : injectable transport factory (constructor + field)
Add an optional last constructor param and a field so tests can swap the spawn.
- Field (near the other private fields):
  ```ts
  // Injectable spawn seam (tests inject a fake transport; prod uses node-pty/legacy).
  private transportFactory: typeof createPtyTransport = createPtyTransport;
  ```
- Constructor signature (`src/terminal.ts:244-253`): append one optional param
  `transportFactory?: typeof createPtyTransport` AFTER `statusProbe?`, and in the body:
  ```ts
  if (transportFactory) this.transportFactory = transportFactory;
  ```
  (Keep it last + optional so every existing `new UniversalTerminal(...)` call site —
  including `OrchestratorManager.addTerminal` at `src/terminal.ts:851` — is unchanged.)

### Change 3 — `src/terminal.ts` : `start()` uses the factory and resets readiness (~line 513)
- Replace the direct call `const { transport, usingNodePty } = createPtyTransport(finalCommand, {…})`
  with `… = this.transportFactory(finalCommand, {…})`.
- Immediately after `this.transport = transport;` (currently `src/terminal.ts:519`), reset the gate
  for this (re)spawn:
  ```ts
  this.spawnReady = false;
  this.pendingInput = [];
  this.armReadyFallback();
  ```

### Change 4 — `src/terminal.ts` : flush on first data (inside the existing `onData` handler, ~line 538)
As the FIRST statement inside the `transport.onData((decoded) => { … })` callback (`src/terminal.ts:538`):
```ts
if (!this.spawnReady) this.markSpawnReady();
```
(Placed first so the queued input is flushed before this same chunk advances the status machine — keeps causal ordering: our queued command precedes the child's response to it.)

### Change 5 — `src/terminal.ts` : readiness helpers (new private methods, near `writeInput`)
```ts
/** Arm the belt-and-suspenders fallback: if no data arrives, still flush soon so a
 *  silent child does not strand queued input. unref'd so it never holds the loop. */
private armReadyFallback() {
  if (this.readyFallbackTimer) clearTimeout(this.readyFallbackTimer);
  this.readyFallbackTimer = setTimeout(
    () => this.markSpawnReady(),
    UniversalTerminal.READY_FALLBACK_MS
  );
  if (this.readyFallbackTimer.unref) this.readyFallbackTimer.unref();
}

/** Mark the child ready and flush any queued input IN ORDER. Idempotent. */
private markSpawnReady() {
  if (this.spawnReady) return;
  this.spawnReady = true;
  if (this.readyFallbackTimer) {
    clearTimeout(this.readyFallbackTimer);
    this.readyFallbackTimer = null;
  }
  const queued = this.pendingInput;
  this.pendingInput = [];
  for (const data of queued) {
    if (this.transport) this.transport.write(data);
  }
}
```

### Change 6 — `src/terminal.ts` : `writeInput()` queues until ready (`src/terminal.ts:592-600`)
```ts
writeInput(command: string) {
  this.lastCommand = command;
  this.applyStatusEvent({ kind: "input" });
  const data = command + "\n";
  if (!this.transport) return;
  if (this.spawnReady) {
    this.transport.write(data);
  } else {
    this.pendingInput.push(data);   // flushed in order by markSpawnReady()
  }
}
```
The `applyStatusEvent({ kind: "input" })` stays BEFORE the gate so the optimistic
Running-transition / `sawWorkSinceIdle` semantics (`src/terminal.ts:356-363`) are
unchanged — only the byte delivery is deferred, not the status intent.

### Change 7 — `src/terminal.ts` : clear the fallback timer on `stop()`/exit
- In `transport.onExit(...)` (`src/terminal.ts:557-565`) and in `stop()` (`src/terminal.ts:618-625`),
  add to the existing timer-teardown block:
  ```ts
  if (this.readyFallbackTimer) {
    clearTimeout(this.readyFallbackTimer);
    this.readyFallbackTimer = null;
  }
  ```
  Prevents a dangling timer (and a flush into a dead transport) after teardown — and keeps
  the unit runner clean even without relying solely on `unref` (`npm test` uses `--test-force-exit`).

### Change 8 — `src/ptyTransport.ts` : LOUD-warning posture, no behavior change
There is **no win32 hard-fail preflight to downgrade** (verified). The only adjustment is to make the
silent legacy fallback observable so this class of issue is diagnosable. In `createPtyTransport`
(`src/ptyTransport.ts:254-290`), when `nodePtyAvailable()` is false and we build the
`LegacyChildProcessTransport`, emit one `console.warn(...)` noting the pane is on the non-PTY legacy
path (piped stdin), which is the deliberate fallback, not a failure. Keep it a single line; do NOT throw.
> This is the entire "downgrade refuse-to-boot to a loud warning" item, reframed to match reality:
> there's nothing that refuses to boot today; we just make the existing silent fallback loud.

---

## Test-first plan (write these BEFORE touching `src/`)

Runner: `npm test` → `tsx --test --test-force-exit tests/*.ts`. New file lives at the top level
`tests/` (the glob is `tests/*.ts`, NOT recursive — confirmed `package.json:13`). Use `node:test` +
`node:assert`, matching `tests/test_terminal_resize.ts:1-3`.

**New file:** `tests/test_terminal_stdin_readiness.ts`

### Fake transport (test double)
A minimal `PtyTransport` that records writes and lets the test drive `onData`/`onExit` manually:
```ts
class FakeTransport implements PtyTransport {
  writes: string[] = [];
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  pid = 4242;
  onData(cb) { this.dataCb = cb; }
  onExit(cb) { this.exitCb = cb; }
  write(d) { this.writes.push(d); }
  resize() {}
  kill() {}
  emitData(d: string) { this.dataCb?.(d); }   // test drives "child produced output"
  emitExit() { this.exitCb?.({ exitCode: 0 }); }
}
```
Inject via the new factory: `new UniversalTerminal(id, ".", "cmd", "Custom", "Human-in-the-Loop",
"", "p", undefined, () => ({ transport: fake, usingNodePty: true }))`.

### THE FAILING TEST TO WRITE FIRST (watch it fail before any src change)
> **"writeInput before spawn-ready queues, then flushes in original order on first data"**

```ts
test("writeInput before ready queues, then flushes in order on first onData", () => {
  const fake = new FakeTransport();
  const term = new UniversalTerminal(
    "g3a", ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined, () => ({ transport: fake, usingNodePty: true })
  );
  term.start();                       // spawns fake; spawnReady starts false

  term.writeInput("first");           // pre-ready -> queued, NOT written
  term.writeInput("second");          // pre-ready -> queued, NOT written
  assert.deepStrictEqual(fake.writes, [], "no input written before child is ready");

  fake.emitData("welcome\n");         // first data == child attached -> flush

  assert.deepStrictEqual(
    fake.writes,
    ["first\n", "second\n"],          // flushed IN ORDER, newline-terminated
    "queued input flushed in submission order once ready"
  );
});
```
On today's code this FAILS at the first assertion: `writeInput` writes immediately, so
`fake.writes` is `["first\n","second\n"]` before any `emitData`. (And the factory param does not
exist yet — the test also forces Change 2.)

### Supporting assertions / additional tests
1. **Post-ready writes pass straight through (no queue):**
   after `emitData(...)`, a later `term.writeInput("third")` writes immediately →
   `fake.writes` ends with `"third\n"`, nothing stuck in the queue.
2. **Fallback timer drains a silent child:** with fake timers
   (`import { mock } from "node:test"` / `mock.timers.enable({ apis: ["setTimeout"] })`),
   queue two inputs, advance `750`ms WITHOUT any `emitData`, assert both flushed in order.
   (Asserts the belt path independent of output.)
3. **First-data flush precedes status churn / no double-write:** drive `emitData` once,
   then a second `emitData`; assert each queued command appears exactly once
   (`markSpawnReady` idempotency — guards Change 5's early-return).
4. **Empty queue is a no-op:** `start()` then `emitData` with nothing queued →
   `fake.writes` stays `[]`; no throw.
5. **Exit before ready does not flush into a dead transport:** queue input, `fake.emitExit()`,
   then (defensively) assert no late write / no dangling timer keeps the runner alive
   (passes under `--test-force-exit`; the explicit timer-clear in Change 7 is what this pins).

### Regression guard (existing suites must stay green)
- `tests/test_terminal_resize.ts` — constructs `UniversalTerminal` with the OLD 3-arg and
  manager forms; the new constructor param is optional+last, so these must keep passing untouched.
- `tests/test_pty_transport.ts` — `nodePtyAvailable() === true` must remain true (we touched only
  the fallback `console.warn`, not the loader). Change 8 must not alter the happy path.
- `tests/test_terminal_manager.ts`, `tests/test_status_machine.ts` — `addTerminal`/status flow
  unchanged because `applyStatusEvent({kind:"input"})` ordering is preserved (Change 6).

---

## Verify commands

```bash
# from the feature worktree: C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes
npm run lint     # tsc --noEmit — typechecks the new factory param + helpers
npm test         # tsx --test --test-force-exit tests/*.ts — new file + full unit suite green
```
Optional live confirmation (needs an authed Claude binary; not required for merge):
```bash
npm run smoke:claude   # a real pane that previously hit "no stdin in 3s" now holds the session
```

---

## Risks

- **Scope guard — do NOT chase the "absent node-pty" or "win32 refuse-to-boot preflight" framings.**
  Both are false against current code (node-pty resolves; no preflight exists; no `"no stdin"` string
  in `src/`). The only real defect is the unguarded synchronous write. Over-reaching here adds churn
  with no payoff and risks regressing the verified-good loader (`tests/test_pty_transport.ts`).
- **Fallback timer tuning (750ms):** too short and a slow-to-exec child could miss the first-data edge
  and still drain into a not-quite-ready PTY (partial regression); too long and the operator perceives
  lag on the first command. 750ms sits comfortably under the CLI's own 3s watchdog while covering
  normal ConPTY exec latency. Keep it a named const so it's tunable.
- **Ordering invariant:** the flush MUST preserve submission order (FIFO `pendingInput`) AND run
  before the triggering `onData` chunk mutates the status machine — otherwise a fast child could
  appear to "respond before we asked." Change 4 (flush as the first statement in `onData`) + the
  test's order assertion pin this.
- **Re-spawn / restart:** `start()` can run again on `/restart`. Change 3 resets `spawnReady`,
  clears `pendingInput`, and re-arms the timer so a restarted pane re-enters the gated state rather
  than inheriting a stale `spawnReady === true`.
- **Teardown safety:** without Change 7, the unref'd timer is harmless to the loop but could fire a
  flush into a killed transport. Clearing it on exit/stop removes that window.
- **Constructor-signature creep:** adding a param to a widely-constructed class. Mitigated by making
  it optional + last; no existing call site changes. If a future refactor prefers it, the factory can
  instead be a public settable field — equivalent seam, same tests.

---

## Acceptance criteria

- [ ] Input issued via `writeInput` **before** spawn-ready is queued, not written, and is flushed
      **in original order** on the first `onData` (failing-test-first assertion passes).
- [ ] Input issued **after** ready writes through immediately with no queue residue.
- [ ] A silent child (no output) still drains the queue within the ~750ms fallback.
- [ ] No lost early input; no double-writes (idempotent `markSpawnReady`).
- [ ] Teardown clears the fallback timer; no flush into a dead transport; runner exits clean.
- [ ] `npm run lint` and `npm test` are green; existing suites (`test_terminal_resize`,
      `test_pty_transport`, `test_terminal_manager`, `test_status_machine`) unchanged and passing.
- [ ] `package.json` is **untouched** (node-pty already declared at line 24).
```
