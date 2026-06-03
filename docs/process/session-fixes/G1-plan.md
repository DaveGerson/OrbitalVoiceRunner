# G1 — PTY submit uses LF not CR — prompts never execute

**Bead:** `wsm-e2e-pinned-7u6`
**Priority:** P0 (master defect)
**Type:** bug · **Kind:** backend
**Worktree (all edits land here):** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes` (branch `feat/session-fixes`)

---

## BLUF

`UniversalTerminal.writeInput` terminates every submitted command with `"\n"` (LF). A real ConPTY-hosted TUI agent (Claude/Codex) treats `"\r"` (CR / Enter) as the submit key, so the composed prompt is *typed into the agent input box but never executed*. This is the single master defect behind the observed symptoms: prompts sitting in the editor (the "Notepad" look), empty/idle panes after delivery, and the `claude_new` / `claude_new_2` "retry" loop where the operator re-sends because nothing happened.

**Fix:** flip the terminator at the one choke point — `src/terminal.ts:598` — from `command + "\n"` to `command + "\r"`.

**Proof without a live binary:** a new fake-transport unit test pins the exact bytes (`"ls\r"`, never ending in `"\n"`), and the existing real-cmd.exe ConPTY echo test (`tests/test_server.ts:52-65`) is the regression guard that proves ConPTY still submits on CR. If that guard goes RED on `"\r"`, **STOP** — see [Contradiction & stop-rule](#contradiction--stop-rule).

---

## 1. Problem & Root Cause (code-anchored)

### The choke point

`src/terminal.ts:592-600` (confirmed identical in `main` and the feature worktree):

```ts
writeInput(command: string) {
  // Record the most recent command and optimistically mark Running — an input
  // means a turn is starting (Tier A kick, design §5).
  this.lastCommand = command;
  this.applyStatusEvent({ kind: "input" });
  if (this.transport) {
    this.transport.write(command + "\n");   // <-- line 598: LF, should be CR
  }
}
```

`writeInput` is the **single** path every pane-mutating "type this and run it" action funnels through:
- the server's `deliver_handoff` choke-point (composed prompt → target pane),
- direct REST/WS input,
- the smoke scripts (`scripts/smoke-handoff.ts:135`, `scripts/smoke-claude-pane.ts`).

### Why LF fails on a real agent pane

The active transport for a live pane is `NodePtyTransport` (`src/ptyTransport.ts:94-144`); `write()` forwards bytes verbatim to the ConPTY master (`this.proc.write(data)`, line 120-126). A ConPTY-hosted interactive TUI (Claude/Codex) reads raw keystrokes: **Enter is carriage return `\r` (0x0D)**. Sending `\n` (0x0A) lands in the input line as a literal newline/no-op for the agent's key handler — the text is *staged in the input box but the turn is never submitted*. The pane then sits at its prompt (no foreground child), the `interactive_cli` fallback probe reads quiescence, and the pane reports Idle with the prompt still un-run. That is exactly the Notepad-editor / empty-pane / "nothing happened, resend" symptom cluster.

### Why the existing tests don't catch it today

- `tests/test_server.ts:52-65` ("should write input to a long-running process") spawns **`cmd.exe`** under ConPTY and asserts the echo `output.includes("async_input_received")`. A bare `cmd.exe` shell line-discipline accepts **both** LF and CR as line submit, so this test passes on `"\n"` today — it does not *distinguish* the terminators. (It will keep passing on `"\r"`; that is precisely what makes it the regression guard, not the detector.)
- There is **no** unit that pins the exact bytes `writeInput` emits. That is the gap this plan fills.

### Confirmed against code (no stale refs)

| Claim | Source | Status |
|---|---|---|
| `writeInput` appends `"\n"` | `src/terminal.ts:598` | ✅ verified (main + worktree) |
| `transport` field is `private` | `src/terminal.ts:190` | ✅ verified |
| Private-field test access via `(term as any).x` is an established pattern | `tests/test_status_gating.ts:42,61,…`, `scripts/smoke-handoff.ts:76` | ✅ verified |
| `NodePtyTransport.write` forwards bytes verbatim | `src/ptyTransport.ts:120-126` | ✅ verified |
| `PtyTransport` interface is exported | `src/ptyTransport.ts:32-46` | ✅ verified |
| Regression guard asserts echo content, not terminator | `tests/test_server.ts:52-65` | ✅ verified |
| Unit runner = `tsx --test --test-force-exit tests/*.ts` | `package.json:13` | ✅ verified |

---

## 2. The Exact Change

| # | File:location | Change |
|---|---|---|
| C1 | `src/terminal.ts:598` | Replace `this.transport.write(command + "\n");` with `this.transport.write(command + "\r");`. Add an inline comment: `// CR (\r), not LF — a ConPTY-hosted TUI agent submits on Enter (carriage return); LF leaves the prompt staged-but-unsubmitted (G1).` |

That is the **entire** production change — one terminator at one choke point. No transport-layer change, no per-transport branching (the fallback `cmd.exe`/`script` path accepts CR as submit too — proven by the regression guard staying green; see stop-rule if it does not).

---

## 3. Test-First Plan (write the failing test BEFORE C1)

Runner: `npm test` → `tsx --test --test-force-exit tests/*.ts` (`package.json:13`). New file is auto-discovered by the `tests/*.ts` glob. Tests must be byte-deterministic and spawn **no** real process.

### 3.1 The failing test to write first

Create **`tests/test_terminal_input.ts`**. It injects a fake `PtyTransport` (capturing every `write`) onto a `UniversalTerminal` via the established `(term as any).transport = fake` cast, calls `writeInput("ls")`, and asserts the captured bytes are exactly `"ls\r"`.

```ts
import { test } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

// Minimal fake transport: capture every write, no real process. Mirrors the
// (term as any).<private> seam already used across the suite (test_status_gating,
// smoke-handoff) to reach UniversalTerminal internals in tests.
function makeFakeTransport() {
  const writes: string[] = [];
  const transport: PtyTransport = {
    pid: 4242,
    onData() {},
    onExit() {},
    write(data: string) { writes.push(data); },
    resize() {},
    kill() {},
  };
  return { transport, writes };
}

test("writeInput submits with CR (\\r), not LF — ConPTY Enter is carriage return", () => {
  const term = new UniversalTerminal("test-input-cr", ".", "cmd");
  const { transport, writes } = makeFakeTransport();
  (term as any).transport = transport;   // inject fake; never start() a real PTY

  term.writeInput("ls");

  assert.strictEqual(writes.length, 1, "writeInput should emit exactly one write");
  assert.strictEqual(writes[0], "ls\r", `expected "ls\\r", got ${JSON.stringify(writes[0])}`);
  assert.ok(!writes[0].endsWith("\n"), "submit terminator must NOT be LF");
});

test("writeInput preserves the command body verbatim and appends a single CR", () => {
  const term = new UniversalTerminal("test-input-body", ".", "cmd");
  const { transport, writes } = makeFakeTransport();
  (term as any).transport = transport;

  const prompt = "Reply with PONG. token=JANUS_XQ7";
  term.writeInput(prompt);

  assert.strictEqual(writes[0], prompt + "\r");
  assert.ok(!writes[0].includes("\n"), "no stray LF anywhere in the submitted bytes");
});

test("writeInput records lastCommand even before asserting the wire bytes", () => {
  const term = new UniversalTerminal("test-input-last", ".", "cmd");
  const { transport } = makeFakeTransport();
  (term as any).transport = transport;
  term.writeInput("echo hi");
  assert.strictEqual(term.lastCommand, "echo hi");
});
```

**Watch it fail first:** with the un-flipped source, test 1 fails with `expected "ls\r", got "ls\n"` and the `!endsWith("\n")` assertion trips. That RED is the proof the test actually pins the defect. **Only then** apply C1 → all three go GREEN.

### 3.2 Key assertions (in priority order)

1. **Exact bytes:** `writes[0] === "ls\r"` — the load-bearing pin. (CR present, body intact.)
2. **Negative guard:** `!writes[0].endsWith("\n")` and `!writes[0].includes("\n")` — LF must be gone, no double terminator.
3. **Single write:** `writes.length === 1` — `writeInput` does not split or double-send.
4. **Body fidelity:** a multi-word prompt is preserved verbatim with one trailing `\r` (delivery integrity for `deliver_handoff`).
5. **Side-effect intact:** `term.lastCommand` is still set (the flip doesn't disturb the optimistic Running kick at `terminal.ts:595-596`).

### 3.3 Regression guard (must STAY green — do not edit)

`tests/test_server.ts:52-65` — spawns real `cmd.exe` under ConPTY, sends `writeInput("echo async_input_received")`, asserts the echo appears in `getRecentOutput`. This is the real-PTY proof that **CR submits a line on the live ConPTY transport**. It is the contradiction-resolver: if it stays green on `"\r"`, the global flip is safe for both transports. **This file is NOT modified by G1.**

---

## 4. Verify Commands

Run from the feature worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes`:

```bash
npm run lint        # tsc --noEmit — types of the fake PtyTransport + cast compile clean
npm test            # full unit suite: new test_terminal_input.ts GREEN, test_server.ts:52 STAYS green
```

Manual / out-of-CI confirmation (needs an authed Claude binary — NOT part of the gate, do not block on it):

```bash
npm run smoke:claude    # the live red->green: a real pane now actually EXECUTES the submitted prompt
```

Definition of done for CI: `npm run lint` clean **and** `npm test` fully green (new file green, regression guard green).

---

## 5. Contradiction & Stop-Rule

`scripts/smoke-handoff.ts:16-18` carries a stale comment claiming "node-pty's line discipline accepts LF as the submit … there is no `\r` CR fix in this code path — earlier comments claiming one were inaccurate." **That comment is the artifact of the bug, not evidence against the fix.** It describes the LF-only world that produces the Notepad symptom.

**Resolution without a live binary:** the fake-transport unit (§3.1) pins the contract, and the real-`cmd.exe` ConPTY echo test (`test_server.ts:52`) proves CR submits a line on the live transport. Both run in `npm test`.

**HARD STOP rule:** if, after applying C1, `tests/test_server.ts:52-65` goes **RED** (the cmd.exe echo no longer appears), do **NOT** ship the global flip. That would mean the legacy/cmd.exe ConPTY path does not accept CR as submit. Reassess one of:
- send `"\r"` only for the node-pty transport, keeping legacy `"\n"` (branch in `writeInput` on `this.usingNodePty`), or
- send `"\r\n"` (CRLF) so both line disciplines submit.
Pick the narrowest option that turns both the new unit and the regression guard green; re-spec before coding it. Do not "fix" by editing the regression guard.

Optional cleanup (separate, low-priority follow-up bead — NOT part of G1): correct the stale `scripts/smoke-handoff.ts:16-18` comment once CR ships, so the docs stop asserting the bug.

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Legacy/cmd.exe ConPTY path rejects CR as line submit → regression guard goes RED | Low (cmd.exe accepts CR) | The stop-rule (§5) catches it deterministically in `npm test`; fall back to per-transport `\r` or CRLF. |
| Some downstream consumer relied on the literal `"\n"` terminator | Very low | `writeInput` is a single choke point; grep shows callers pass a command string and expect submit, not a specific terminator. |
| Double-newline / CRLF doubling if a caller already appends a newline | Low | Tests 1-2 assert exactly one trailing `\r` and **no** `\n` anywhere; callers pass bare command strings (verified in smoke scripts). |
| `(term as any).transport` cast drifts if the field is renamed | Low | Same fragility as the existing `(term as any)` casts across the suite; acceptable and consistent. The lint step compiles the cast. |
| Fake transport omits an interface method node `--test` exercises | Very low | The fake implements all six `PtyTransport` members (`pid/onData/onExit/write/resize/kill`); `writeInput` only touches `.write`. |

---

## 7. Acceptance Criteria

- [ ] `src/terminal.ts:598` emits `command + "\r"` (CR), not `"\n"`.
- [ ] New `tests/test_terminal_input.ts` exists, was RED before C1 (`"ls\n"` ≠ `"ls\r"`), and is GREEN after.
- [ ] `tests/test_server.ts:52-65` stays GREEN (real cmd.exe ConPTY echo) — unedited.
- [ ] `npm test` fully green; `npm run lint` clean.
- [ ] No source file other than `src/terminal.ts` (+ the new test) is modified by G1.
- [ ] (Manual, not CI) `npm run smoke:claude` flips red→green on an authed binary: the pane actually executes the submitted prompt instead of leaving it staged.
