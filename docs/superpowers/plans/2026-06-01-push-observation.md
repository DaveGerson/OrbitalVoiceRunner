# Push-Based Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Janus *push* compact, redacted status signals (a pane went idle, hit an error, or is waiting at a prompt) into the live Gemini session — and let the model pull true line-deltas — instead of only ever pulling a 20-line snapshot.

**Architecture:** Two new focused modules (`src/paneSignals.ts` = classifier + formatter; `src/paneSignalBus.ts` = a subscribe/publish bus with per-pane-per-kind debounce). A monotonic line cursor on `UniversalTerminal` enables true deltas via a new `consumeDelta()` + `get_pane_delta` tool. `server.ts` instantiates one bus, each `/live` WebSocket connection subscribes its `session.sendClientContent` to the bus, and the existing global `manager.onIdle` / `manager.onOutput` callbacks publish signals. This bridges the known scope gap (global pane callbacks ↔ per-connection session) without touching the announcement/UI path.

**Tech Stack:** TypeScript, Node `node:test` runner via `tsx --test`, `@google/genai` live session (`sendClientContent`).

**Scope:** This plan delivers `idle`, `error`, and `prompt` signals + line-deltas. The `exited` signal is a documented fast-follow (Task 7 note) — it needs a new `UniversalTerminal.onExit` → `manager.onExit` hook chain whose wiring isn't covered here. The busy/idle heuristic the roadmap flagged (hardcoded 1s timer) is **already fixed** (configurable `idleTimeoutMs=2000` + `statusMachine.ts`), so it is not re-addressed.

**Pre-req baseline (run once before Task 1):** `npm run typecheck` (expect exit 0) and `npm run test:unit` (expect `pass 206 / fail 0`). If the baseline is red, stop and report.

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/paneSignals.ts` | `PaneSignal` type, `classifyPaneOutput()` (error/prompt detection), `formatPaneSignal()` (compact model text) | **Create** |
| `src/paneSignalBus.ts` | `PaneSignalBus` — subscribe/publish with per-(pane,kind) debounce | **Create** |
| `src/terminal.ts` | Add monotonic `totalLines` + `consumeDelta()` to `UniversalTerminal`; add `getPaneDelta()` to the manager | **Modify** (`:492-506`, `:555`, `:849-859`) |
| `server.ts` | Instantiate bus; subscribe per-connection session; publish from `onIdle`/`onOutput`; add `get_pane_delta` tool | **Modify** (`:273`, `:612`, `:1609-1626`, `:1755`, `:2529`, `:2905`) |
| `tests/test_pane_signals.ts` | Unit tests for classifier + formatter | **Create** |
| `tests/test_pane_signal_bus.ts` | Unit tests for the bus + debounce | **Create** |
| `tests/test_pane_delta.ts` | Unit tests for `consumeDelta` + `getPaneDelta` | **Create** |
| `tests/test_push_observation_integration.ts` | End-to-end: output → classify → bus → fake session | **Create** |

---

## Task 1: Delta cursor on `UniversalTerminal`

**Files:**
- Modify: `src/terminal.ts` (fields near `:150`; append site `:492-506`; new method near `:557`)
- Test: `tests/test_pane_delta.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_pane_delta.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";

// Helper: push clean lines straight into the model-lane buffer the way onData does,
// without spinning up a real PTY. We exercise the public delta surface only.
function feed(term: any, text: string) {
  const cleanLines = text.split(/\r?\n/).filter((l: string) => l.trim() !== "");
  term.outputBuffer.push(...cleanLines);
  if (term.outputBuffer.length > term.maxBufferLines) {
    term.outputBuffer.splice(0, term.outputBuffer.length - term.maxBufferLines);
  }
  term.totalLines += cleanLines.length;
}

describe("UniversalTerminal.consumeDelta", () => {
  it("returns all lines on first read, then nothing until new output", () => {
    const t: any = new UniversalTerminal("p1", "shell");
    feed(t, "alpha\nbeta\n");
    let d = t.consumeDelta();
    assert.strictEqual(d.lines, "alpha\nbeta");
    assert.strictEqual(d.dropped, 0);

    d = t.consumeDelta();
    assert.strictEqual(d.lines, "", "no new output => empty delta");
    assert.strictEqual(d.dropped, 0);

    feed(t, "gamma\n");
    d = t.consumeDelta();
    assert.strictEqual(d.lines, "gamma");
  });

  it("reports dropped lines when the buffer cap evicts unread output", () => {
    const t: any = new UniversalTerminal("p2", "shell");
    t.maxBufferLines = 3;
    feed(t, "1\n2\n3\n4\n5\n"); // 5 lines pushed, buffer keeps last 3 (3,4,5)
    const d = t.consumeDelta();
    assert.strictEqual(d.dropped, 2, "lines 1-2 evicted before first read");
    assert.strictEqual(d.lines, "3\n4\n5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/test_pane_delta.ts`
Expected: FAIL — `t.consumeDelta is not a function` / `totalLines` is NaN.

- [ ] **Step 3: Add the cursor fields and method**

In `src/terminal.ts`, next to `public outputBuffer: string[] = [];` / `public maxBufferLines = 100;` (~`:150`), add:

```typescript
  // Push-observation delta cursor. `totalLines` is monotonic (never decremented by
  // the buffer cap splice); `modelCursor` is the absolute line index the model has
  // consumed up to. Together they yield only-new-since-last-read deltas.
  public totalLines = 0;
  private modelCursor = 0;
```

In the `transport.onData` append block (`:502-505`), immediately after the existing
`this.outputBuffer.push(...cleanLines);` line, add the counter bump:

```typescript
      this.outputBuffer.push(...cleanLines);
      this.totalLines += cleanLines.length;
      if (this.outputBuffer.length > this.maxBufferLines) {
        this.outputBuffer.splice(0, this.outputBuffer.length - this.maxBufferLines);
      }
```

Add the method just after `getRecentOutput` (`:557`):

```typescript
  /** Only-new-since-last-read lines (model lane). Advances the model cursor.
   *  `dropped` counts unread lines the buffer cap evicted before this read. */
  consumeDelta(): { lines: string; dropped: number } {
    const bufStart = this.totalLines - this.outputBuffer.length; // absolute idx of buffer[0]
    let from = this.modelCursor;
    let dropped = 0;
    if (from < bufStart) { dropped = bufStart - from; from = bufStart; }
    const lines = this.outputBuffer.slice(from - bufStart).join("\n");
    this.modelCursor = this.totalLines;
    return { lines, dropped };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/test_pane_delta.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/terminal.ts tests/test_pane_delta.ts
git commit -m "feat(observe): per-pane line-delta cursor on UniversalTerminal"
```

---

## Task 2: Manager `getPaneDelta()` + `get_pane_delta` tool

**Files:**
- Modify: `src/terminal.ts` (manager method near `getPaneSummary` `:849-859`)
- Modify: `server.ts` (tool handler near `:1755`; function declaration near `:2529`)
- Test: `tests/test_pane_delta.ts` (extend)

- [ ] **Step 1: Add the failing test (manager level)**

Append to `tests/test_pane_delta.ts`:

```typescript
import { OrchestratorManager } from "../src/terminal";

describe("manager.getPaneDelta", () => {
  it("returns a redacted, fenced delta and a no-output sentinel", () => {
    const m: any = new OrchestratorManager();
    const t: any = new UniversalTerminal("p3", "shell");
    m.terminals["p3"] = t;
    t.outputBuffer.push("hello", "AKIA1234567890ABCD99"); // 2nd line is an AWS-key shape
    t.totalLines += 2;

    const out = m.getPaneDelta("p3");
    assert.match(out, /hello/);
    assert.match(out, /\[REDACTED/i, "secret-shaped tokens are scrubbed");
    assert.match(out, /```/, "fenced block");

    assert.strictEqual(m.getPaneDelta("p3"), "[No new output since last read]");
    assert.match(m.getPaneDelta("missing"), /does not exist/);
  });
});
```

> If `OrchestratorManager` is not the exact exported class name, grep `export class` in `src/terminal.ts` and use the manager class that owns `getPaneSummary`/`this.terminals`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/test_pane_delta.ts`
Expected: FAIL — `m.getPaneDelta is not a function`.

- [ ] **Step 3: Implement `getPaneDelta` on the manager**

In `src/terminal.ts`, directly below the existing `getPaneSummary` method (`:849-859`), add:

```typescript
  /** Push-observation pull side: only-new lines since the model last read this pane,
   *  ANSI already stripped (model lane) and secret-redacted. */
  getPaneDelta(paneId: string): string {
    const term = this.terminals[paneId];
    if (!term) {
      return `Error: Pane ${paneId} does not exist.`;
    }
    const { lines, dropped } = term.consumeDelta();
    if (!lines) {
      return "[No new output since last read]";
    }
    const note = dropped > 0 ? `[... ${dropped} earlier line(s) evicted from buffer ...]\n` : "";
    return "```\n" + note + redactSecrets(lines) + "\n```";
  }
```

(`redactSecrets` is already imported in this file — it is used by `getPaneSummary`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/test_pane_delta.ts`
Expected: PASS (3 tests total).

- [ ] **Step 5: Wire the Gemini tool**

In `server.ts`, add the handler beside `get_pane_summary` (`:1755-1760`):

```typescript
        } else if (name === "get_pane_delta") {
          const targetId = args.pane_id;
          const out = manager.getPaneDelta(targetId);
          session.sendToolResponse({
            functionResponses: [{ name, id: call.id, response: { output: out } }],
          });
```

In the tool/function declarations block (next to the `get_pane_summary` declaration `:2529`), add a sibling declaration:

```typescript
        {
          name: "get_pane_delta",
          description:
            "Return ONLY the pane output that is new since you last read this pane " +
            "(true incremental delta; ANSI-stripped, secret-redacted). Advances a per-pane " +
            "read cursor, so repeated calls won't re-show old lines. Prefer this over " +
            "get_pane_summary when tracking progress.",
          parameters: {
            type: Type.OBJECT,
            properties: { pane_id: { type: Type.STRING, description: "The pane id." } },
            required: ["pane_id"],
          },
        },
```

> Match the exact `Type.*` import / declaration style used by the adjacent `get_pane_summary` entry (copy its shape verbatim, only changing name/description).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` → expect exit 0.

```bash
git add src/terminal.ts server.ts tests/test_pane_delta.ts
git commit -m "feat(observe): get_pane_delta tool returns true line-deltas"
```

---

## Task 3: Output classifier + signal formatter

**Files:**
- Create: `src/paneSignals.ts`
- Test: `tests/test_pane_signals.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_pane_signals.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyPaneOutput, formatPaneSignal } from "../src/paneSignals";

describe("classifyPaneOutput", () => {
  it("flags error lines", () => {
    const c = classifyPaneOutput("compiling...\nError: cannot find module 'x'\n");
    assert.strictEqual(c?.kind, "error");
    assert.match(c!.detail, /cannot find module/);
  });

  it("flags test-failure summaries", () => {
    const c = classifyPaneOutput("Tests: 3 failed, 10 passed\n");
    assert.strictEqual(c?.kind, "error");
  });

  it("flags a trailing shell prompt", () => {
    const c = classifyPaneOutput("done\nuser@host:~/proj$ ");
    assert.strictEqual(c?.kind, "prompt");
  });

  it("returns null for benign output", () => {
    assert.strictEqual(classifyPaneOutput("building module 2 of 5\n"), null);
  });
});

describe("formatPaneSignal", () => {
  it("produces compact operator-facing text with the pane id", () => {
    const text = formatPaneSignal({ paneId: "build-1", kind: "error", detail: "boom" });
    assert.match(text, /build-1/);
    assert.match(text, /error/i);
    assert.match(text, /boom/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/test_pane_signals.ts`
Expected: FAIL — cannot find module `../src/paneSignals`.

- [ ] **Step 3: Implement the module**

Create `src/paneSignals.ts`:

```typescript
import { SHELL_PROMPT } from "./statusConstants";

export type PaneSignalKind = "idle" | "error" | "prompt" | "exited";

export interface PaneSignal {
  paneId: string;
  kind: PaneSignalKind;
  detail?: string; // compact; MUST already be redacted before formatting
}

export interface OutputClass {
  kind: "error" | "prompt";
  detail: string;
}

// Cheap, high-precision error/test-failure cues. Intentionally conservative — a false
// "error" push is noisier than a missed one, so we only match strong signals.
const ERROR_RE =
  /\b(error|build failed|exception|panic|traceback|FAILED|\d+\s+fail(?:ed|ing)|Tests?:\s*\d+\s+failed)\b/i;

/** Classify a chunk of ALREADY-ANSI-STRIPPED pane output. Returns the strongest
 *  signal found, or null. Errors win over prompts. */
export function classifyPaneOutput(cleanText: string): OutputClass | null {
  const lines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  for (const line of lines) {
    if (ERROR_RE.test(line)) return { kind: "error", detail: line.slice(0, 160) };
  }
  const last = lines[lines.length - 1];
  if (SHELL_PROMPT.test(last)) return { kind: "prompt", detail: last.slice(0, 80) };
  return null;
}

/** Compact, operator-facing text injected into the live session. Mirrors the
 *  approval-narration convention: a user-role nudge the model may speak, then stop. */
export function formatPaneSignal(s: PaneSignal): string {
  const verb =
    s.kind === "idle" ? "went idle (finished)"
    : s.kind === "error" ? "reported an error"
    : s.kind === "prompt" ? "is waiting at a prompt"
    : "exited";
  const tail = s.detail ? `: ${s.detail}` : "";
  return `PANE STATUS (mention to the operator if relevant, then stop): pane ${s.paneId} ${verb}${tail}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/test_pane_signals.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paneSignals.ts tests/test_pane_signals.ts
git commit -m "feat(observe): pane output classifier + signal formatter"
```

---

## Task 4: `PaneSignalBus` (subscribe / publish / debounce)

**Files:**
- Create: `src/paneSignalBus.ts`
- Test: `tests/test_pane_signal_bus.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_pane_signal_bus.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { PaneSignalBus } from "../src/paneSignalBus";

describe("PaneSignalBus", () => {
  it("fans out to every subscriber and respects unsubscribe", () => {
    const bus = new PaneSignalBus(0); // no debounce
    const a: any[] = [];
    const b: any[] = [];
    const off = bus.subscribe((s) => a.push(s));
    bus.subscribe((s) => b.push(s));

    bus.publish({ paneId: "p1", kind: "idle" });
    off();
    bus.publish({ paneId: "p1", kind: "error", detail: "x" });

    assert.strictEqual(a.length, 1, "unsubscribed observer stops receiving");
    assert.strictEqual(b.length, 2);
  });

  it("debounces repeat (pane,kind) within the window but lets other kinds through", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, () => now);
    const seen: string[] = [];
    bus.subscribe((s) => seen.push(`${s.paneId}:${s.kind}`));

    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error" }), true);
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error" }), false, "coalesced");
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "prompt" }), true, "different kind ok");
    now += 3001;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error" }), true, "window elapsed");

    assert.deepStrictEqual(seen, ["p1:error", "p1:prompt", "p1:error"]);
  });

  it("an observer that throws does not break the fan-out", () => {
    const bus = new PaneSignalBus(0);
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((s) => seen.push(s.paneId));
    bus.publish({ paneId: "p9", kind: "idle" });
    assert.deepStrictEqual(seen, ["p9"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/test_pane_signal_bus.ts`
Expected: FAIL — cannot find module `../src/paneSignalBus`.

- [ ] **Step 3: Implement the bus**

Create `src/paneSignalBus.ts`:

```typescript
import type { PaneSignal } from "./paneSignals";

type Observer = (signal: PaneSignal) => void;

/** Bridges global pane-event callbacks to N per-connection live sessions.
 *  Per-(pane,kind) debounce keeps a chatty pane from spamming the model. */
export class PaneSignalBus {
  private observers = new Set<Observer>();
  private lastPushAt = new Map<string, number>();

  constructor(
    private debounceMs = 3000,
    private now: () => number = () => Date.now(),
  ) {}

  /** Returns an unsubscribe function. */
  subscribe(observer: Observer): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  /** Fan out unless this (pane,kind) fired within the debounce window.
   *  Returns true if delivered, false if coalesced. */
  publish(signal: PaneSignal): boolean {
    const key = `${signal.paneId}:${signal.kind}`;
    const last = this.lastPushAt.get(key) ?? Number.NEGATIVE_INFINITY;
    const t = this.now();
    if (t - last < this.debounceMs) return false;
    this.lastPushAt.set(key, t);
    for (const observer of this.observers) {
      try { observer(signal); }
      catch (e) { console.error("PaneSignalBus observer failed:", e); }
    }
    return true;
  }

  get observerCount(): number { return this.observers.size; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/test_pane_signal_bus.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paneSignalBus.ts tests/test_pane_signal_bus.ts
git commit -m "feat(observe): PaneSignalBus with per-(pane,kind) debounce"
```

---

## Task 5: Wire the bus into `server.ts`

**Files:**
- Modify: `server.ts` (imports; bus instance near `:273`; publish in `onIdle` `:305` and `onOutput` `:612`; subscribe in `/live` handler `:1626`; unsubscribe on close `:2905`)
- Test: covered by Task 6 + `npm run test:unit` regression + `npm run typecheck`

- [ ] **Step 1: Add imports**

Near the other `src/*` imports at the top of `server.ts`, add:

```typescript
import { PaneSignalBus } from "./src/paneSignalBus";
import { classifyPaneOutput, formatPaneSignal } from "./src/paneSignals";
```

> Match the existing relative-path style of sibling imports in `server.ts` (e.g. how `terminal`/`statusConstants` are imported) — adjust `./src/` vs `./` accordingly.

- [ ] **Step 2: Instantiate the bus**

Immediately before `manager.onIdle = async (terminalId) => {` (`:273`), add:

```typescript
  // Push-observation: one bus per server; each /live connection subscribes its session.
  const paneSignalBus = new PaneSignalBus();
```

- [ ] **Step 3: Publish on idle**

Inside `manager.onIdle`, right after `announcementBus.enqueue({ kind: "completion", terminalId, summary: summaryText });` (`:305`), add:

```typescript
      paneSignalBus.publish({ paneId: terminalId, kind: "idle", detail: summaryText.slice(0, 160) });
```

- [ ] **Step 4: Publish error/prompt on output**

Inside `manager.onOutput = (terminalId, chunk) => {` (`:612`), at the top of the body, add:

```typescript
    const cls = classifyPaneOutput(stripAnsiSequences(chunk));
    if (cls) {
      paneSignalBus.publish({ paneId: terminalId, kind: cls.kind, detail: cls.detail });
    }
```

> `stripAnsiSequences` is already imported in `server.ts` (used at `:285`). If `onOutput`'s second parameter isn't named `chunk`, use its actual name.

- [ ] **Step 5: Subscribe the live session**

In the `/live` connection handler, immediately after the session is created (`:1626`, after the `session = await sessionAi.live.connect({...})` block), add:

```typescript
      const unsubscribePaneSignals = paneSignalBus.subscribe((sig) => {
        try {
          session.sendClientContent({
            turns: [{ role: "user", parts: [{ text: formatPaneSignal(sig) }] }],
            turnComplete: true,
          });
        } catch (e) {
          console.error("Failed to push pane signal to session:", e);
        }
      });
```

In the connection's close handler, next to `session.close()` (`:2905`), add:

```typescript
      unsubscribePaneSignals();
```

> `unsubscribePaneSignals` must be declared in the same closure scope as `session` so the close handler can see it. If `session.close()` sits in a different scope, hoist `let unsubscribePaneSignals: (() => void) | null = null;` beside `let session: any = null;` (`:1492`) and assign it in Step 5.

- [ ] **Step 6: Typecheck + full regression**

Run: `npm run typecheck` → expect exit 0.
Run: `npm run test:unit` → expect `fail 0` (count ≥ 206 + the new tests).

- [ ] **Step 7: Commit**

```bash
git add server.ts
git commit -m "feat(observe): push pane idle/error/prompt signals into live session"
```

---

## Task 6: End-to-end integration test

**Files:**
- Create: `tests/test_push_observation_integration.ts`

- [ ] **Step 1: Write the test (composes the real modules, fake session)**

Create `tests/test_push_observation_integration.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { PaneSignalBus } from "../src/paneSignalBus";
import { classifyPaneOutput, formatPaneSignal } from "../src/paneSignals";

// A stand-in for the Gemini live session: records what would be spoken.
class FakeSession {
  spoken: string[] = [];
  sendClientContent(arg: any) {
    this.spoken.push(arg.turns[0].parts[0].text);
  }
}

describe("push-observation end-to-end (classify -> bus -> session)", () => {
  it("an error chunk reaches the subscribed session as compact narration", () => {
    const bus = new PaneSignalBus(0);
    const fake = new FakeSession();
    bus.subscribe((sig) =>
      fake.sendClientContent({
        turns: [{ role: "user", parts: [{ text: formatPaneSignal(sig) }] }],
        turnComplete: true,
      }),
    );

    // Simulate manager.onOutput for pane "build-1".
    const chunk = "webpack compiled\nError: Module not found: ./missing\n";
    const cls = classifyPaneOutput(chunk);
    assert.ok(cls, "classifier should fire");
    bus.publish({ paneId: "build-1", kind: cls!.kind, detail: cls!.detail });

    assert.strictEqual(fake.spoken.length, 1);
    assert.match(fake.spoken[0], /build-1/);
    assert.match(fake.spoken[0], /error/i);
    assert.match(fake.spoken[0], /Module not found/);
  });

  it("benign output produces no push", () => {
    const bus = new PaneSignalBus(0);
    const fake = new FakeSession();
    bus.subscribe((sig) => fake.sendClientContent({ turns: [{ role: "user", parts: [{ text: formatPaneSignal(sig) }] }] }));
    const cls = classifyPaneOutput("building 2 of 5\n");
    if (cls) bus.publish({ paneId: "build-1", kind: cls.kind, detail: cls.detail });
    assert.strictEqual(fake.spoken.length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx tsx --test tests/test_push_observation_integration.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Full suite green**

Run: `npm run test:unit` → expect `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add tests/test_push_observation_integration.ts
git commit -m "test(observe): end-to-end push-observation signal path"
```

---

## Task 7: Wrap-up notes (no code)

- [ ] **`exited` signal (fast-follow):** add `public onExit?: (terminalId: string) => void;` to `UniversalTerminal`, fire it inside the existing `transport.onExit` block (`src/terminal.ts:510-518`), wire the manager to forward it to a `manager.onExit` (mirror how `onIdle`/`onOutput` are forwarded per-terminal), then `paneSignalBus.publish({ paneId, kind: "exited" })` in `server.ts`. Deferred because the per-terminal hook forwarding isn't mapped in this plan.
- [ ] **Live verification (manual):** push signals only exercise fully against a real Gemini session. After Task 5, run `npm run dev`, trigger a pane error, and confirm Janus speaks the status. Headless tests cannot prove the `sendClientContent` leg.
- [ ] **Tuning:** if the model narrates too eagerly, raise `PaneSignalBus` debounce (constructor arg in Task 5 Step 2) or tighten `ERROR_RE` in `src/paneSignals.ts`.

---

## Self-Review

- **Spec coverage (RECONCILIATION.md §4 "push-observation"):** delta cursor ✅ (T1–2), event classifier idle/error/prompt ✅ (T3, T5), push-to-model bridging the scope gap ✅ (T4–6), busy/idle heuristic — already fixed, noted ✅, `exited` — explicitly deferred ✅ (T7).
- **Placeholder scan:** every code step has complete code; the three `>` notes flag *real-codebase verification points* (exact class name, import path, param name, closure scope), not missing content.
- **Type consistency:** `PaneSignal`/`PaneSignalKind` defined once in `paneSignals.ts`, imported by `paneSignalBus.ts` and used unchanged in `server.ts`; `classifyPaneOutput` returns `OutputClass` whose `kind` is a subset of `PaneSignalKind`, so `cls.kind` flows into `publish` without a cast; `consumeDelta()` shape `{lines, dropped}` is consumed identically in T1 test and T2 `getPaneDelta`.

---

## Implementation status (2026-06-01)

**IMPLEMENTED** on branch `worktree-push-observation` (off `main` @ `d4f854d`), bead `wsm-e2e-pinned-yul`. Tasks 1–6 complete and committed; typecheck = 0; full unit suite **320 pass / 0 fail**.

- **Anchor drift:** every `:line` ref in this plan was stale (written pre-`d4f854d`); each was re-anchored against the live tree before editing. Final anchors — `terminal.ts`: fields @192, `onData` bump @543, `consumeDelta` after `getRecentOutput` @598, `getPaneDelta` after `getPaneSummary` @914; `server.ts`: imports @11, bus + `onIdle` @303, `onOutput` @645, `/live` `session`/subscribe in the `connect` try, unsubscribe in the `close` handler.
- **Plan defect corrected:** `new UniversalTerminal("p1","shell")` (2 args) fails `tsc` — the constructor requires a 3rd `shellCmd` arg. Tests pass `("pX","shell","bash")`; behavior unaffected (no PTY started).
- **Deferred — `exited` signal:** tracked as bead `wsm-e2e-pinned-y09` (per Task 7).
- **Still pending — manual live verification:** the `session.sendClientContent` leg is only exercised against a real Gemini session. Run `npm run dev`, trigger a pane error, confirm Janus speaks the status. Headless tests cannot prove it.
- **Tuning knobs:** `PaneSignalBus` debounce (default 3000ms) and `ERROR_RE` in `src/paneSignals.ts` if narration is too eager.
