# Janus Memory Synthesis — P0a (TS Anti-Rot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Janus an always-fresh, scoped, token-budgeted working context that re-focuses on pane switch — entirely in TypeScript, in-process — so Gemini Live never boots on rotted context, with zero dependency on the (later) Python synthesizer.

**Architecture:** A new `src/memory/` module. `WorldModel` reads live `OrchestratorManager` state + `JanusStore` and exposes five redacted tier extractors (Project / active Pane / Board / Janus frame / decaying Breadcrumbs). `FallbackAssembler` deterministically blends those tiers into one char-budgeted brief. `MemoryService.synthesize()` is the single entry point (P0a = fallback; P0b will swap in Python behind it). Integration feeds breadcrumbs from the existing "ears" edges and (re)synthesizes on pane switch / session start, injecting the brief via the existing `session.sendClientContent` channel.

**Tech Stack:** TypeScript (Node), existing `better-sqlite3` `JanusStore`, `node:test` + `tsx` unit runner (`--test-force-exit`), existing `redactSecrets`. No new runtime deps. Budgeting is char-based (≈4 chars/token) to avoid a tokenizer dependency.

**Spec:** `docs/superpowers/specs/2026-06-05-janus-memory-synthesis-design.md` (decisions M1–M11). This plan implements P0a (M10). P0b (Python) and RAG are out of scope here.

**Scope note (mergeable tonight):** P0a is self-contained and ships value alone. P0b (greenfield Python on Windows) and deferred RAG are separate follow-on plans/beads — NOT in this plan.

---

## File Structure

**Create (new module `src/memory/`):**
- `src/memory/types.ts` — tier/brief/config interfaces + defaults. One responsibility: shared types.
- `src/memory/breadcrumbs.ts` — `BreadcrumbRing` (recency-decaying short-term trail). Pure, no deps.
- `src/memory/assembler.ts` — `assembleBrief()` deterministic budgeted blend. Pure, no deps.
- `src/memory/worldModel.ts` — `WorldModel` tier extractors over injected manager/store/redact.
- `src/memory/index.ts` — `MemoryService` facade (`synthesize`) + `createMemoryService()` wiring.

**Create (tests):**
- `tests/test_memory_breadcrumbs.ts`
- `tests/test_memory_assembler.ts`
- `tests/test_memory_worldmodel.ts`
- `tests/test_memory_refocus.ts` — the M2 regression guard (pane-switch re-focus).
- `tests/test_memory_integration.ts` — breadcrumb feed + freshness-trigger injection (mock session).

**Modify (integration; read exact surrounding code first):**
- `src/observe/index.ts` — in `onRunning`/`onIdle`/`onQuiescing`, also push a breadcrumb (redacted) into the ring (via an injected `onBreadcrumb` dep — do NOT import server.ts).
- `server.ts` — construct `MemoryService`; wire breadcrumb dep into `attachObserve`; on pane switch + `/live` session start, call `memory.synthesize(activeId)` and inject via `session.sendClientContent({turns:[{role:"user",parts:[{text}]}],turnComplete:true})`.
- `src/actions/defs/orient.ts` — `switch_context` already calls `manager.refreshLedger()`; after it, request a fresh synthesis + inject (the explicit "catch me up" path).
- `src/types.ts` — add `advanced.memoryBudgetChars?`, `advanced.breadcrumbMax?`, `advanced.breadcrumbMaxAgeMs?` (all optional, additive).

**Conventions:** all pane/command/output text passes through `redactSecrets` BEFORE entering any tier or breadcrumb (the spec's hard invariant). New files follow the observe-pipeline pattern: depend only on injected deps + pure helpers + types, never re-import `server.ts`.

---

## Task 1: Types & defaults

**Files:**
- Create: `src/memory/types.ts`

- [ ] **Step 1: Write the types + defaults**

```ts
// src/memory/types.ts — shared shapes for the in-process memory layer (P0a).
// Budget is CHAR-based (≈4 chars/token) to avoid a tokenizer dependency in v1.

export interface ProjectTier {
  projectId: string;
  name: string;
  summary: string;
  keyTerms: string[];
  recentDecisions: string[];   // redacted, newest-first
}
export interface PaneTier {
  paneId: string;
  name: string;
  runtimeType: string;
  status: string;              // "Running" | "Idle" | "Exited"
  lastCommand: string | null;  // redacted
  recent: string[];            // redacted recent pane lines/outcomes, newest-first
}
export interface BoardEntry { paneId: string; name: string; status: string; }
export interface JanusFrame {
  role: string;
  gatePosture: string;         // global permissions mode summary
  prefs: string[];             // redacted global operator prefs, may be empty
}
export interface Breadcrumb { ts: number; paneId: string | null; text: string; } // text already redacted

export interface MemoryTiers {
  project: ProjectTier | null;
  pane: PaneTier | null;       // the ACTIVE pane (focus)
  board: BoardEntry[];
  frame: JanusFrame;
  breadcrumbs: Breadcrumb[];   // newest-first, already age/cap filtered
}

export interface BudgetWeights {
  project: number; pane: number; breadcrumbs: number; board: number; frame: number;
}
export interface MemoryConfig {
  totalBudgetChars: number;    // default 4800 (~1200 tokens)
  weights: BudgetWeights;      // fractions, sum ≈ 1
  breadcrumbMax: number;       // default 12
  breadcrumbMaxAgeMs: number;  // default 15 min
}
export interface SynthesizedBrief {
  text: string;
  perTierChars: Record<string, number>;
  activePaneId: string | null;
  source: "fallback" | "python";  // P0a always "fallback"
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  totalBudgetChars: 4800,
  weights: { project: 0.40, pane: 0.30, breadcrumbs: 0.15, board: 0.10, frame: 0.05 },
  breadcrumbMax: 12,
  breadcrumbMaxAgeMs: 15 * 60 * 1000,
};
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run lint`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/memory/types.ts
git commit -m "feat(memory): P0a tier/brief/config types + defaults"
```

---

## Task 2: BreadcrumbRing (recency decay)

**Files:**
- Create: `src/memory/breadcrumbs.ts`
- Test: `tests/test_memory_breadcrumbs.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BreadcrumbRing } from "../src/memory/breadcrumbs";

test("recent() returns newest-first, age-filtered, capped", () => {
  const ring = new BreadcrumbRing({ breadcrumbMax: 2, breadcrumbMaxAgeMs: 1000 });
  ring.add({ ts: 100, paneId: "p1", text: "old" });
  ring.add({ ts: 900, paneId: "p1", text: "mid" });
  ring.add({ ts: 1000, paneId: "p2", text: "new" });
  const r = ring.recent(1500); // now=1500 → age cutoff = 500; "old"(age 1400) dropped
  assert.deepEqual(r.map(b => b.text), ["new", "mid"]); // newest-first, capped to 2
});

test("add() hard-caps stored size to avoid unbounded growth", () => {
  const ring = new BreadcrumbRing({ breadcrumbMax: 3, breadcrumbMaxAgeMs: 1e9 });
  for (let i = 0; i < 100; i++) ring.add({ ts: i, paneId: null, text: `b${i}` });
  // recent() still returns at most breadcrumbMax, newest-first
  const r = ring.recent(1000);
  assert.equal(r.length, 3);
  assert.equal(r[0].text, "b99");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_memory_breadcrumbs.ts`
Expected: FAIL (cannot find module `../src/memory/breadcrumbs`).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/memory/breadcrumbs.ts — Janus's decaying short-term working memory ("post-it notes").
import type { Breadcrumb } from "./types";

export class BreadcrumbRing {
  private items: Breadcrumb[] = [];
  constructor(private cfg: { breadcrumbMax: number; breadcrumbMaxAgeMs: number }) {}

  add(b: Breadcrumb): void {
    this.items.push(b);
    // Keep a bounded buffer (a few × breadcrumbMax) so recent() always has enough to pick from
    const hardCap = Math.max(this.cfg.breadcrumbMax * 4, 64);
    if (this.items.length > hardCap) this.items.splice(0, this.items.length - hardCap);
  }

  recent(now: number): Breadcrumb[] {
    const cutoff = now - this.cfg.breadcrumbMaxAgeMs;
    return this.items
      .filter(b => b.ts >= cutoff)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, this.cfg.breadcrumbMax);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --test-force-exit tests/test_memory_breadcrumbs.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory/breadcrumbs.ts tests/test_memory_breadcrumbs.ts
git commit -m "feat(memory): BreadcrumbRing recency-decay working memory + tests"
```

---

## Task 3: FallbackAssembler (deterministic budgeted blend)

**Files:**
- Create: `src/memory/assembler.ts`
- Test: `tests/test_memory_assembler.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBrief } from "../src/memory/assembler";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";

function tiers(activePane = "p1"): MemoryTiers {
  return {
    project: { projectId: "proj", name: "Janus", summary: "voice orchestrator", keyTerms: ["pty","gemini"], recentDecisions: ["chose stdio seam"] },
    pane: { paneId: activePane, name: activePane, runtimeType: "interactive_cli", status: "Running", lastCommand: "npm test", recent: ["running tests"] },
    board: [{ paneId: "p1", name: "p1", status: "Running" }, { paneId: "p2", name: "p2", status: "Idle" }],
    frame: { role: "Janus orchestrator", gatePosture: "Human-in-the-Loop", prefs: [] },
    breadcrumbs: [{ ts: 2, paneId: "p2", text: "was on p2: ran build" }],
  };
}

test("brief is deterministic and includes every non-empty tier in weight order", () => {
  const a = assembleBrief(tiers(), DEFAULT_MEMORY_CONFIG, 1000);
  const b = assembleBrief(tiers(), DEFAULT_MEMORY_CONFIG, 1000);
  assert.equal(a.text, b.text);                       // deterministic
  assert.match(a.text, /Janus/);                      // project
  assert.match(a.text, /ACTIVE PANE.*p1/s);           // focus pane labeled
  assert.match(a.text, /was on p2/);                  // breadcrumb
  assert.equal(a.source, "fallback");
  assert.equal(a.activePaneId, "p1");
  assert.ok(a.text.length <= DEFAULT_MEMORY_CONFIG.totalBudgetChars * 1.2); // budget respected (+headers slack)
});

test("each tier is truncated to its char slice under pressure", () => {
  const big = tiers();
  big.project!.summary = "x".repeat(10000); // overflow the project slice
  const a = assembleBrief(big, { ...DEFAULT_MEMORY_CONFIG, totalBudgetChars: 400 }, 1000);
  assert.ok(a.perTierChars.project <= Math.ceil(400 * 0.40) + 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_memory_assembler.ts`
Expected: FAIL (cannot find module `../src/memory/assembler`).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/memory/assembler.ts — deterministic, no-LLM blend of tiers into one budgeted brief.
// This is the anti-rot guarantee: it always produces a FRESH brief with Python absent (spec M8).
import type { MemoryTiers, MemoryConfig, SynthesizedBrief } from "./types";

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

export function assembleBrief(tiers: MemoryTiers, cfg: MemoryConfig, _now: number): SynthesizedBrief {
  const B = cfg.totalBudgetChars, w = cfg.weights;
  const perTierChars: Record<string, number> = {};
  const blocks: string[] = [];

  // PROJECT (mid-ground)
  if (tiers.project) {
    const p = tiers.project;
    const body = cap(
      `PROJECT ${p.name}: ${p.summary}` +
      (p.keyTerms.length ? ` | terms: ${p.keyTerms.join(", ")}` : "") +
      (p.recentDecisions.length ? ` | decisions: ${p.recentDecisions.slice(0, 3).join("; ")}` : ""),
      Math.floor(B * w.project));
    perTierChars.project = body.length; blocks.push(body);
  }
  // ACTIVE PANE (sharp foreground)
  if (tiers.pane) {
    const pn = tiers.pane;
    const body = cap(
      `ACTIVE PANE ${pn.name} (${pn.status}, ${pn.runtimeType})` +
      (pn.lastCommand ? ` last: ${pn.lastCommand}` : "") +
      (pn.recent.length ? ` | recent: ${pn.recent.slice(0, 4).join("; ")}` : ""),
      Math.floor(B * w.pane));
    perTierChars.pane = body.length; blocks.push(body);
  }
  // BREADCRUMBS (decaying working memory)
  if (tiers.breadcrumbs.length) {
    const body = cap(`RECENTLY: ${tiers.breadcrumbs.map(b => b.text).join(" · ")}`, Math.floor(B * w.breadcrumbs));
    perTierChars.breadcrumbs = body.length; blocks.push(body);
  }
  // BOARD (perception)
  if (tiers.board.length) {
    const body = cap(`BOARD: ${tiers.board.map(b => `${b.name}=${b.status}`).join(", ")}`, Math.floor(B * w.board));
    perTierChars.board = body.length; blocks.push(body);
  }
  // JANUS FRAME (self-model)
  {
    const f = tiers.frame;
    const body = cap(`FRAME ${f.role} | gates: ${f.gatePosture}` + (f.prefs.length ? ` | prefs: ${f.prefs.join("; ")}` : ""),
      Math.floor(B * w.frame));
    perTierChars.frame = body.length; blocks.push(body);
  }

  return {
    text: blocks.join("\n"),
    perTierChars,
    activePaneId: tiers.pane?.paneId ?? null,
    source: "fallback",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --test-force-exit tests/test_memory_assembler.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory/assembler.ts tests/test_memory_assembler.ts
git commit -m "feat(memory): deterministic FallbackAssembler (budgeted tier blend) + tests"
```

---

## Task 4: WorldModel (tier extractors) + MemoryService facade

**Files:**
- Create: `src/memory/worldModel.ts`, `src/memory/index.ts`
- Test: `tests/test_memory_worldmodel.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldModel } from "../src/memory/worldModel";
import { BreadcrumbRing } from "../src/memory/breadcrumbs";

function fakeDeps() {
  const breadcrumbs = new BreadcrumbRing({ breadcrumbMax: 5, breadcrumbMaxAgeMs: 1e9 });
  const manager = {
    activeId: "p1",
    terminals: {
      p1: { name: "p1", runtimeType: "interactive_cli", status: "Running", lastCommand: "export TOKEN=sk-secret123 && npm test" },
      p2: { name: "p2", runtimeType: "shell", status: "Idle", lastCommand: "ls" },
    },
    ledger: { activeProjectId: "proj" },
    settings: { globalPermissionsMode: "Human-in-the-Loop" },
    listPanes: () => [{ project_id: "proj", panes: [
      { pane_id: "p1", name: "p1", last_known_state: "Running" },
      { pane_id: "p2", name: "p2", last_known_state: "Idle" },
    ]}],
  };
  const store = {
    getProject: (_id: string) => ({ id: "proj", name: "Janus", summary: "orchestrator", key_terms: ["pty"] }),
    getProjectBriefing: (_id: string) => ({ summary: "orchestrator", recentNotes: [] }),
  };
  const redact = (s: string) => s.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]");
  return { manager, store, redact, breadcrumbs };
}

test("getPaneTier redacts lastCommand and reflects live status", () => {
  const wm = new WorldModel(fakeDeps() as any);
  const t = wm.getPaneTier("p1")!;
  assert.equal(t.status, "Running");
  assert.doesNotMatch(t.lastCommand!, /sk-secret/);  // secret scrubbed
  assert.match(t.lastCommand!, /\[REDACTED\]/);
});

test("getBoardTier lists all panes; getTiers foregrounds the active pane", () => {
  const wm = new WorldModel(fakeDeps() as any);
  const board = wm.getBoardTier();
  assert.equal(board.length, 2);
  const tiers = wm.getTiers("p1", 1000);
  assert.equal(tiers.pane!.paneId, "p1");
  assert.equal(tiers.project!.name, "Janus");
  assert.equal(tiers.frame.gatePosture, "Human-in-the-Loop");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_memory_worldmodel.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/memory/worldModel.ts — the in-process raw-truth reader. Pure reads off live manager + store;
// every text field is redacted at this boundary (spec invariant). No server.ts import.
import type { BreadcrumbRing } from "./breadcrumbs";
import type { MemoryTiers, ProjectTier, PaneTier, BoardEntry, JanusFrame } from "./types";

export interface WorldModelDeps {
  manager: {
    activeId: string | null;
    terminals: Record<string, { name?: string; runtimeType?: string; status?: string; lastCommand?: string | null }>;
    ledger: { activeProjectId?: string | null };
    settings: { globalPermissionsMode?: string };
    listPanes: () => Array<{ project_id: string; panes: Array<{ pane_id: string; name?: string; last_known_state?: string }> }>;
  };
  store: { getProject: (id: string) => any | null; getProjectBriefing: (id: string) => any | null };
  redact: (s: string) => string;
  breadcrumbs: BreadcrumbRing;
}

export class WorldModel {
  constructor(private deps: WorldModelDeps) {}

  getProjectTier(projectId: string): ProjectTier | null {
    const ws = this.deps.store.getProject(projectId);
    if (!ws) return null;
    return {
      projectId,
      name: ws.name ?? projectId,
      summary: this.deps.redact(ws.summary ?? ""),
      keyTerms: Array.isArray(ws.key_terms) ? ws.key_terms : [],
      recentDecisions: [], // P0a: kept simple; P0b enriches from notes(type=decision)
    };
  }

  getPaneTier(paneId: string): PaneTier | null {
    const t = this.deps.manager.terminals[paneId];
    if (!t) return null;
    return {
      paneId,
      name: t.name ?? paneId,
      runtimeType: t.runtimeType ?? "",
      status: t.status ?? "Idle",
      lastCommand: t.lastCommand ? this.deps.redact(t.lastCommand) : null,
      recent: [],
    };
  }

  getBoardTier(): BoardEntry[] {
    const out: BoardEntry[] = [];
    for (const grp of this.deps.manager.listPanes()) {
      for (const p of grp.panes) out.push({ paneId: p.pane_id, name: p.name ?? p.pane_id, status: p.last_known_state ?? "Idle" });
    }
    return out;
  }

  getJanusFrameTier(): JanusFrame {
    return {
      role: "Janus — voice orchestrator for live CLI panes",
      gatePosture: this.deps.manager.settings.globalPermissionsMode ?? "Human-in-the-Loop",
      prefs: [],
    };
  }

  getTiers(activePaneId: string | null, now: number): MemoryTiers {
    const projectId = this.deps.manager.ledger.activeProjectId ?? "";
    return {
      project: projectId ? this.getProjectTier(projectId) : null,
      pane: activePaneId ? this.getPaneTier(activePaneId) : null,
      board: this.getBoardTier(),
      frame: this.getJanusFrameTier(),
      breadcrumbs: this.deps.breadcrumbs.recent(now),
    };
  }
}
```

```ts
// src/memory/index.ts — the public facade. P0a synthesizes via the deterministic fallback;
// P0b will route to the Python synthesizer here, falling back to assembleBrief on timeout/error.
import { WorldModel, type WorldModelDeps } from "./worldModel";
import { BreadcrumbRing } from "./breadcrumbs";
import { assembleBrief } from "./assembler";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig, type SynthesizedBrief, type Breadcrumb } from "./types";

export { WorldModel } from "./worldModel";
export { BreadcrumbRing } from "./breadcrumbs";
export * from "./types";

export class MemoryService {
  constructor(private wm: WorldModel, private cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG) {}
  synthesize(activePaneId: string | null, now: number): SynthesizedBrief {
    return assembleBrief(this.wm.getTiers(activePaneId, now), this.cfg, now);
  }
}

export interface CreatedMemory {
  service: MemoryService;
  breadcrumbs: BreadcrumbRing;
  addBreadcrumb: (b: Breadcrumb) => void;
}

/** Build the wired memory service from the live manager/store + redactor. */
export function createMemoryService(
  deps: Omit<WorldModelDeps, "breadcrumbs">,
  cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): CreatedMemory {
  const breadcrumbs = new BreadcrumbRing(cfg);
  const wm = new WorldModel({ ...deps, breadcrumbs });
  return { service: new MemoryService(wm, cfg), breadcrumbs, addBreadcrumb: (b) => breadcrumbs.add(b) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --test-force-exit tests/test_memory_worldmodel.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory/worldModel.ts src/memory/index.ts tests/test_memory_worldmodel.ts
git commit -m "feat(memory): WorldModel tier extractors + MemoryService facade + tests"
```

---

## Task 5: Re-focus regression guard (spec M2)

**Files:**
- Test: `tests/test_memory_refocus.ts`

- [ ] **Step 1: Write the test (this is the core guarantee)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryService } from "../src/memory";

function mkManager() {
  return {
    activeId: "p1" as string | null,
    terminals: {
      p1: { name: "p1", runtimeType: "interactive_cli", status: "Running", lastCommand: "edit server.ts" },
      p2: { name: "p2", runtimeType: "interactive_cli", status: "Idle", lastCommand: "npm test" },
    } as Record<string, any>,
    ledger: { activeProjectId: "proj" },
    settings: { globalPermissionsMode: "Human-in-the-Loop" },
    listPanes: () => [{ project_id: "proj", panes: [
      { pane_id: "p1", name: "p1", last_known_state: "Running" },
      { pane_id: "p2", name: "p2", last_known_state: "Idle" },
    ]}],
  };
}

test("switching active pane re-focuses: new pane sharp, old pane demoted to breadcrumb, project stable", () => {
  const manager = mkManager();
  const store = { getProject: () => ({ id: "proj", name: "Janus", summary: "orchestrator", key_terms: [] }), getProjectBriefing: () => null };
  const redact = (s: string) => s;
  const { service, addBreadcrumb } = createMemoryService({ manager: manager as any, store: store as any, redact });

  // Focused on p2 first
  manager.activeId = "p2";
  const before = service.synthesize("p2", 1000);
  assert.match(before.text, /ACTIVE PANE p2/);
  assert.match(before.text, /npm test/);            // p2's detail is in focus

  // Operator switches to p1; p2's work demotes to a breadcrumb
  addBreadcrumb({ ts: 1500, paneId: "p2", text: "was on p2: npm test" });
  manager.activeId = "p1";
  const after = service.synthesize("p1", 2000);

  assert.match(after.text, /ACTIVE PANE p1/);        // p1 now sharp
  assert.match(after.text, /edit server\.ts/);       // p1 detail present
  assert.doesNotMatch(after.text, /ACTIVE PANE p2/); // p2 NO LONGER in focus (no rot)
  assert.match(after.text, /was on p2/);             // p2 demoted to breadcrumb
  assert.match(after.text, /PROJECT Janus/);         // project continuity preserved
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx tsx --test --test-force-exit tests/test_memory_refocus.ts`
Expected: PASS (1 test). (No new production code — this exercises Tasks 1–4. If it fails, fix the modules, not the test.)

- [ ] **Step 3: Commit**

```bash
git add tests/test_memory_refocus.ts
git commit -m "test(memory): pane-switch re-focus regression guard (spec M2)"
```

---

## Task 6: Breadcrumb feed from the ears edges

**Files:**
- Modify: `src/observe/index.ts` (the `ObserveDeps` bag + `onRunning`/`onIdle`/`onQuiescing`)
- Test: extend `tests/test_memory_integration.ts`

**First read** `src/observe/index.ts` (the `ObserveDeps` interface and the `onRunning`/`onIdle`/`onQuiescing` handlers — already present). Add an optional `onBreadcrumb?: (b: { ts: number; paneId: string | null; text: string }) => void` to `ObserveDeps`, and call it from each edge with a redacted one-liner.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachObserve } from "../src/observe";

// Minimal manager + deps double; we only assert onBreadcrumb fires on the Running edge.
test("onRunning pushes a redacted breadcrumb via onBreadcrumb dep", () => {
  const crumbs: any[] = [];
  const manager: any = { terminals: { p1: { lastCommand: "deploy KEY=sk-abc" } } };
  const deps: any = {
    broadcast() {}, announcementBus: { enqueue() {} }, paneSignalBus: { publish() {} },
    pruneAttention() {}, interactionLog: { log() {} }, getLastInteractionId: () => null,
    redact: (s: string) => s.replace(/sk-[a-z]+/g, "[R]"),
    historyManager: { loadHistory: () => [], saveHistory() {}, appendOutputToLastCommand() {} },
    ai: {} as any,
    onBreadcrumb: (b: any) => crumbs.push(b),
  };
  const h = attachObserve(manager, deps);
  h.onRunning("p1");
  assert.equal(crumbs.length, 1);
  assert.equal(crumbs[0].paneId, "p1");
  assert.match(crumbs[0].text, /\[R\]/);          // redacted
  assert.doesNotMatch(crumbs[0].text, /sk-abc/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_memory_integration.ts`
Expected: FAIL (`onBreadcrumb` not called / undefined).

- [ ] **Step 3: Implement — add `onBreadcrumb` to `ObserveDeps` and call it**

In `src/observe/index.ts`, add to `ObserveDeps`:
```ts
  // P0a memory: optional sink for decaying cross-pane breadcrumbs (redacted one-liners).
  onBreadcrumb?: (b: { ts: number; paneId: string | null; text: string }) => void;
```
Destructure it in `attachObserve` (`const { ..., onBreadcrumb } = deps;`) and call it inside the existing `onRunning`/`onIdle`/`onQuiescing` handlers, e.g. in `onRunning`:
```ts
    if (onBreadcrumb) {
      const lc = term?.lastCommand ? redact(term.lastCommand).slice(0, 80) : "";
      onBreadcrumb({ ts: Date.now(), paneId: terminalId, text: `pane ${terminalId} started${lc ? `: ${lc}` : ""}` });
    }
```
Mirror with `idle` ("finished") and `quiescing` ("wrapping up") wording. (Use `Date.now()` — production runtime; tests stub it implicitly via real time, assertions don't depend on the value.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --test-force-exit tests/test_memory_integration.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/observe/index.ts tests/test_memory_integration.ts
git commit -m "feat(memory): feed decaying breadcrumbs from the ears edges (onRunning/onIdle/onQuiescing)"
```

---

## Task 7: Wire freshness triggers + injection (server.ts + orient.ts)

**Files:**
- Modify: `server.ts`, `src/actions/defs/orient.ts`, `src/types.ts`

**First read** the relevant `server.ts` regions: where `attachObserve(...)` is invoked (~line 401+), where the `/live` session is established and pane signals are forwarded to it (search `formatPaneSignal` / `sendClientContent` in `src/voice/`), and where the active pane changes (search `activeId =` / a `switch`/`setActive` action).

- [ ] **Step 1: Add settings knobs (`src/types.ts`)**

In the `advanced` settings interface, add (additive, optional):
```ts
    memoryBudgetChars?: number;   // default 4800
    breadcrumbMax?: number;       // default 12
    breadcrumbMaxAgeMs?: number;  // default 900000
```

- [ ] **Step 2: Construct the memory service in `server.ts`**

Near where `attachObserve` deps are built:
```ts
import { createMemoryService } from "./src/memory";
// ...
const memory = createMemoryService(
  { manager, store /* the JanusStore */, redact: redactSecrets },
  {
    totalBudgetChars: settings?.advanced?.memoryBudgetChars ?? 4800,
    weights: { project: 0.40, pane: 0.30, breadcrumbs: 0.15, board: 0.10, frame: 0.05 },
    breadcrumbMax: settings?.advanced?.breadcrumbMax ?? 12,
    breadcrumbMaxAgeMs: settings?.advanced?.breadcrumbMaxAgeMs ?? 900_000,
  },
);
```
Pass `onBreadcrumb: memory.addBreadcrumb` into the `attachObserve(manager, { ... })` deps bag.

- [ ] **Step 3: Inject a fresh brief on session start + pane switch**

Define a helper near the live-session wiring (where `session.sendClientContent` is available):
```ts
function injectMemoryBrief(session: any, activeId: string | null) {
  try {
    const brief = memory.service.synthesize(activeId, Date.now());
    if (brief.text.trim()) {
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: `CONTEXT (situational, do not read aloud):\n${brief.text}` }] }],
        turnComplete: true,
      });
    }
  } catch (e) { console.error("[memory] brief injection failed:", e); }
}
```
Call `injectMemoryBrief(session, manager.activeId)` (a) once right after the `/live` session connects, and (b) at the point the active pane changes (the same place that elects `activeId`).

- [ ] **Step 4: Fresh brief on `switch_context` (`src/actions/defs/orient.ts`)**

`switch_context` already calls `manager.refreshLedger()`. After it builds the briefing, also trigger a memory synthesis for the now-active pane (thread the memory service through the action ctx, mirroring how other shared services reach actions; if no ctx seam exists, inject from the server-side handler after the action returns).

- [ ] **Step 5: Verify build + lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server.ts src/actions/defs/orient.ts src/types.ts
git commit -m "feat(memory): wire freshness triggers (session start / pane switch / switch_context) + brief injection"
```

---

## Task 8: Full battery + PR

- [ ] **Step 1: Run the full battery**

Run: `npm run lint; npm test; npm run build` (PowerShell: separate or `;`-chained). Set `$env:PYTHONIOENCODING='utf-8'` first.
Expected: lint clean; all unit tests pass (≥ prior count + new memory tests); build emits `dist/server.cjs`.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/janus-memory-synthesis
gh pr create --title "feat(memory): Janus Memory Synthesis P0a — anti-rot context + pane-switch re-focus" --body "<summary + spec link + test evidence>"
```

- [ ] **Step 3: Squash-merge after green (the night's final merge)**

```bash
gh pr merge <#> --squash --delete-branch
```

---

## Self-Review (run before execution)

- **Spec coverage:** M1 (faithful recall) → Tasks 4–5; M2 (re-focus on switch) → Task 5; M5/M6 (tiers incl. breadcrumbs) → Tasks 1–4, 6; M7 (TS world-model) → Task 4; M8 (fallback = anti-rot) → Task 3; M10 (P0a first) → whole plan; M11 (extractive, no model call) → Task 3 is pure/deterministic. M3/M4/M9 (Python/stdio/RAG) intentionally deferred — out of P0a scope. ✓
- **Placeholder scan:** integration Tasks 6–7 say "read exact surrounding code first" — intentional (they touch large existing files: `server.ts` ~3200 lines, `observe/index.ts`); the *contract* (new dep name, call shape, injection payload) is concrete. ✓
- **Type consistency:** `MemoryService.synthesize(activePaneId, now)`, `assembleBrief(tiers,cfg,now)`, `BreadcrumbRing.recent(now)`, `createMemoryService(deps,cfg)` used consistently across tasks. ✓

## Follow-on (NOT this plan — file as beads)
- **P0b — Python Context Synthesizer** (stdio seam, budget/extractive trim, optional bounded LLM summary) swapping in behind `MemoryService.synthesize`.
- **Deferred — semantic/RAG** (embeddings, pattern recall) as an optional synthesizer input.
