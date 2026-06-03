# kzt — Durable deferred actions across a process restart (WS-F follow-up, scope B)

**Bead:** `wsm-e2e-pinned-kzt` (P3 · TASK · backend)
**Builds on (closed, on-branch):** U1 `wsm-e2e-pinned-9fe` (voice resolves a staged `pendingAction`, commit `290e970`) + G6 `wsm-e2e-pinned-9tv` (REST spawn routes through `gateOrDefer`, commit `25b6f49`)
**Mirrors (closed, on `main`):** nzt `wsm-e2e-pinned-nzt` (durable `PendingApprovalStore` over `JanusStore`, commit `56e4960`)
**Worktree (ALL edits here):** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes` (branch `feat/session-fixes`)

---

## BLUF

`PendingActionStore` (`src/pendingActions.ts`) holds a **non-serializable `run()` closure** — the deferred side-effect for an `Ask`-tier non-PTY mutator (`create_pane`, `set_pane_permissions`, `set_global_permissions`, `apply_recipe`). It is purely in-memory: a staged action survives a WS disconnect (it is not session-bound) but is **silently lost on a process restart**. The fix mirrors the nzt pattern, with one extra move forced by the closure: we persist the action's **intent** (capability + the serializable `args` that the closure captured), add a `pending_actions` SQLite table + store methods, inject the durable `JanusStore` into `PendingActionStore`, and on boot **rebuild `run()` from the persisted intent via a capability-keyed effect registry** owned by the server. When `store === null` (legacy/init-failed), behavior is byte-for-byte the current in-memory store.

**The one structural difference vs. nzt:** a `PendingApproval` is *already* fully serializable (it just carries `instruction`/`terminalId` and the resolver re-derives the write). A `PendingAction` is **not** — its whole payload is a closure. So durability for actions requires a serialize step (`intent`) on `add()` and a **deserialize+rebuild** step (`rebuildRun(intent)`) on hydrate. That registry is the heart of this task.

---

## 1. Problem & Root Cause (code-anchored to the CURRENT branch)

### 1a. The closure is the durability hole

`PendingAction.run` is explicitly flagged non-serializable (`src/pendingActions.ts:37-38`):

```ts
/** The deferred side effect. Returns a model/operator-facing result string. NOT serializable. */
run: () => string;
```

`PendingActionStore` has **no durable backend at all** — it is two in-memory structures (`src/pendingActions.ts:52-53`):

```ts
private records = new Map<string, PendingAction>();
private order: string[] = [];
```

The `lastCallAt` doc-comment already states the consequence (`src/pendingActions.ts:30-35`): *"IN-MEMORY ONLY … PendingActionStore has no durable backend."*

### 1b. Where it is constructed (the injection seam)

`server.ts:1405` constructs it with **no argument**, right next to the *already-durable* approvals store:

```ts
const pendingApprovals = new PendingApprovalStore(store);   // ← durable (nzt)
const pendingActions   = new PendingActionStore();          // ← in-memory ONLY (this task)
```

`store` is the module-scope `JanusStore | null` (`server.ts:183-212`). The asymmetry on these two adjacent lines is the entire bug surface.

### 1c. The four staging sites (what each closure captures — the intent we must persist)

Every `Ask`-tier deferral flows through `gateOrDefer(...)` (`server.ts:1503-1524`), which stages the closure (`server.ts:1517`):

```ts
pendingActions.add({ id: actionId, capability, summary, timestamp: Date.now(), run });
```

The four callers and the **serializable params each `run` closes over** (verified):

| Caller (server.ts) | capability | params captured by the closure (→ must persist) |
|---|---|---|
| voice `create_pane` `2305-2322` | `create_pane` | `project_id`, `pane_id`, `command`, `tool_preset`, `permissions_mode` |
| REST `POST /api/terminals` `768-774` | `create_pane` | `terminalId`, `resolvedCwd`, `command`, `toolPreset`, `permissionsMode`, `sessionId`, `projectId` |
| REST `POST /api/recipes/apply` (per pane) `1293-1305` | `create_pane` | `p.id`, `proj.directory`, `bareShell`, `p.preset`, `p.permissionsMode`, `p.startupCommand`, `activeProjectId` |
| voice `set_global_permissions` `2333-2344` | `set_global_permissions` | `permissions_mode` |
| voice `set_pane_permissions` `2823-2834` | `set_pane_permissions` | `project_id`, `pane_id`, `permissions_mode` |

These params are **all JSON-serializable scalars** — that is the load-bearing fact that makes intent-persistence possible without serializing the closure.

### 1d. What "rebuild on boot" must reproduce

On confirm, the closure: (1) calls `manager.addTerminal(...)` / `manager.globalPermissionsMode = …` / `term.setPermissionsMode(...)`, (2) calls `broadcastLedgerUpdate()` + `broadcast({type:"terminals_updated"})` (or `settings_updated`), (3) returns a string. After a restart, `manager`, `broadcast`, `broadcastLedgerUpdate` are **fresh references inside the new `startServer()` closure** — so a deserialized closure could never re-bind them. The rebuild MUST happen **inside `startServer()`** where those references live. This dictates the architecture in §2: the store persists *intent*; the **server** owns the registry that turns intent → a fresh `run` bound to the live `manager`/`broadcast`.

### 1e. The nzt pattern we mirror (the durable seam, verified on-branch)

`src/pendingApprovals.ts` is the template:
- A structural `ApprovalDurableStore` interface (`:28-34`) — minimal surface, not the whole `JanusStore`.
- Constructor takes `JanusStore | ApprovalDurableStore | null` and `hydrateFromStore()` on construct (`:506-509`).
- `add()` dual-writes: in-memory mirror first, then `store.insertPendingApproval(...)` (`:551-577`).
- `claim()` defers to the atomic SQL `claimApproval` when a store is present (`:628-641`).
- `delete()` removes the durable row too (`:591-598`).
- `hydrateFromStore()` repopulates the in-memory working set from unclaimed survivors on construct (`:518-531`).
- A `hydrateApproval(row)` inverse-mapper (`:792-814`).
- The store methods on `JanusStore` (`src/store/sqliteStore.ts:208-228`): `insertPendingApproval` (INSERT OR REPLACE), `claimApproval` (UPDATE … WHERE claimed=0), `deletePendingApproval`, `getPendingApprovals`, `getExpiredApprovals`.
- The `pending_approvals` table (`src/store/schema.ts:91-102`).
- Test file `tests/test_pendingApprovals_durable.ts` uses a **temp file** (not `:memory:`) so a *second* `JanusStore` reopens the same DB and sees survivors.

We reproduce every one of these for actions.

---

## 2. The Exact Changes (`file:location:change`)

> **Design choice (LOCKED).** Two seams, mirroring nzt's "store persists, class hydrates" split, plus the registry forced by §1d:
> 1. **Store + schema**: a `pending_actions` table and `StoredPendingAction` row + five `JanusStore` methods (exact analogues of the approval methods).
> 2. **Store class**: `PendingActionStore` gains an optional `ActionDurableStore` backend + constructor injection + dual-write `add` + durable `claim` + durable `remove` + `hydrateFromStore()` returning the persisted **intents** (NOT a runnable record — the class cannot rebuild `run`).
> 3. **Server registry**: a pure, server-owned `buildActionRun(intent, deps)` that maps a persisted intent → a fresh `run` closure bound to the live `manager`/`broadcast`. Called once per survivor at boot to re-stage runnable records.
>
> **VERIFIED CONSTRAINT (same as G6):** `server.ts` ends with `startServer().catch(console.error)` at module scope; importing `../server` boots a real listener. Therefore any pure helper the unit tests import (the registry mapper) lives in a **new module `src/actionEffects.ts`**, NOT exported from `server.ts`.

### Change A — `src/store/types.ts`: the durable row shape (append after `StoredPendingApproval`, ~`:28`)

```ts
/**
 * A deferred non-PTY action staged under an `Ask` gate (G1/U1/G6). Unlike StoredPendingApproval,
 * the side effect is a CLOSURE — so we persist the INTENT (capability + the JSON params the closure
 * captured) and rebuild the closure on boot via the server's actionEffects registry. `params` is a
 * JSON string of the capability-specific arg bag (see src/actionEffects.ts for the per-capability shape).
 */
export interface StoredPendingAction {
  id: string;
  capability: string;
  summary: string;
  params: string;        // JSON-encoded intent params (capability-specific)
  claimed: boolean;
  timestamp: number;
  expires_at: number;    // timestamp + ttlMs (parity with pending_approvals; drives boot/sweep prune)
}
```

### Change B — `src/store/schema.ts`: migration v4 (the table)

Bump `SCHEMA_VERSION` `3 → 4` (`schema.ts:4`) and append a 4th migration entry to `MIGRATIONS` (after the v3 entry, `schema.ts:189-195`). The migration is purely additive (new table; no ALTER of existing tables), so it is safe for an existing `.janus.db`:

```ts
// v4: durable deferred ACTIONS (G1/U1/G6 follow-up, bead wsm-e2e-pinned-kzt). Sibling of
// pending_approvals: holds the serializable INTENT of an Ask-tier non-PTY mutator so a deferred
// action survives a process restart (the run() closure is rebuilt on boot from `params`).
(db) => {
  db.exec(`
    CREATE TABLE pending_actions (
      id TEXT PRIMARY KEY NOT NULL,
      capability TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      params TEXT NOT NULL DEFAULT '{}',
      claimed INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
},
```

> The `db.pragma("user_version = …")` bump is automatic — `applyMigrations` (`schema.ts:199-209`) sets `user_version = i+1` per applied migration, so adding the 4th array entry + bumping `SCHEMA_VERSION` is the entire schema change. Confirm `tests/test_store_schema.ts` / `test_store_boot_migration.ts` assertions on `SCHEMA_VERSION` are updated (see §3e).

### Change C — `src/store/sqliteStore.ts`: five methods (mirror approvals, after `getExpiredApprovals`, ~`:228`)

```ts
insertPendingAction(a: StoredPendingAction): void {
  this.db.prepare(
    `INSERT OR REPLACE INTO pending_actions(id,capability,summary,params,claimed,timestamp,expires_at)
     VALUES(@id,@capability,@summary,@params,@claimed,@timestamp,@expires_at)`
  ).run({ ...a, claimed: a.claimed ? 1 : 0 });
}
/** Atomic claim: flips 0->1 only if currently 0. True == this caller won (exactly-once seam). */
claimAction(id: string): boolean {
  return this.db.prepare("UPDATE pending_actions SET claimed=1 WHERE id=? AND claimed=0").run(id).changes === 1;
}
deletePendingAction(id: string): void {
  this.db.prepare("DELETE FROM pending_actions WHERE id=?").run(id);
}
/** All unclaimed actions, oldest first (boot hydration order == insertion order, ts ASC). */
getPendingActions(): StoredPendingAction[] {
  return (this.db.prepare("SELECT * FROM pending_actions WHERE claimed=0 ORDER BY timestamp ASC").all() as any[])
    .map(r => ({ ...r, claimed: Boolean(r.claimed) }));
}
/** Unclaimed actions past expiry (durable sweep parity with getExpiredApprovals). */
getExpiredActions(now = Date.now()): StoredPendingAction[] {
  return (this.db.prepare("SELECT * FROM pending_actions WHERE claimed=0 AND expires_at<? ORDER BY expires_at ASC").all(now) as any[])
    .map(r => ({ ...r, claimed: Boolean(r.claimed) }));
}
```

Add `StoredPendingAction` to the type import at `sqliteStore.ts:5`.

> **Note on the boot prune (mirrors the nzt follow-up hazard).** Like `pending_approvals`, `pruneOnBoot` (`src/store/retention.ts`) never touches this table, so a claimed-but-undeleted row (crash between `claimAction` and `deletePendingAction`) would leak. This is **out of scope** (it is the identical, already-accepted nzt hazard, tracked separately). Do NOT expand scope to fix retention here — file a follow-up bead and reference it (§5, Risk 5).

### Change D — `src/actionEffects.ts`: the intent ⇄ run registry (NEW, pure, server-imports-it)

This is the only genuinely new concept. It is **side-effect-free** (so unit tests import it, never `../server`) and is parameterized by a `deps` bag the server supplies at boot (the live `manager` + broadcasters). It does the `serialize` (extract params from a staging call) and the `rebuild` (params → a fresh `run`).

```ts
import type { GateValue } from "./types"; // (only if needed; otherwise no server imports)

/** The serializable intent of a deferred action: capability + a capability-specific param bag. */
export interface ActionIntent {
  capability: string;
  params: Record<string, unknown>;
}

/** The live references a rebuilt run() needs. Supplied by server.ts at boot (fresh per process). */
export interface ActionEffectDeps {
  manager: any;                 // OrchestratorManager (typed loosely to avoid a server import cycle)
  broadcast: (msg: any) => void;
  broadcastLedgerUpdate: () => void;
  sanitizeSettingsForClient: (s: any) => any;
}

/**
 * Rebuild the deferred side effect from a persisted intent, bound to the live deps. Mirrors the
 * literal closures at the four staging sites (server.ts:2305 / 768 / 1293 / 2333 / 2823) EXACTLY,
 * so a confirm-after-restart produces byte-identical effects + broadcasts. Unknown capability =>
 * a no-op run that returns an explanatory string (never throw on hydrate; a corrupt/legacy row must
 * not crash boot — the action is simply un-runnable and gets cancelled).
 */
export function buildActionRun(intent: ActionIntent, deps: ActionEffectDeps): () => string {
  const p = intent.params as any;
  switch (intent.capability) {
    case "create_pane":
      return () => {
        const projectId = p.projectId ?? "";
        if (projectId && !deps.manager.ledger.getProject(projectId)) {
          deps.manager.ledger.addProject(projectId, p.cwd || ".", "Co-created with pane");
        }
        const result = deps.manager.addTerminal(
          p.paneId, p.cwd || process.cwd(), p.command,
          p.toolPreset || "Custom", p.permissionsMode || "Human-in-the-Loop",
          p.sessionId || "", projectId
        );
        if (p.startupCommand) deps.manager.ledger.addPaneNote(projectId, p.paneId, `Suggested startup command: ${p.startupCommand}`);
        deps.broadcastLedgerUpdate();
        deps.broadcast({ type: "terminals_updated" });
        return `Pane ${p.paneId} created. ${result}`;
      };
    case "set_global_permissions":
      return () => {
        deps.manager.globalPermissionsMode = p.permissionsMode;
        deps.manager.settings.advanced.globalPermissionsMode = p.permissionsMode;
        deps.manager.saveSettings();
        deps.broadcast({ type: "settings_updated", globalPermissionsMode: p.permissionsMode, settings: deps.sanitizeSettingsForClient(deps.manager.settings) });
        return `Global permissions updated to ${p.permissionsMode}.`;
      };
    case "set_pane_permissions":
      return () => {
        if (deps.manager.terminals[p.paneId]) deps.manager.terminals[p.paneId].setPermissionsMode(p.permissionsMode);
        const ws = deps.manager.ledger.getProject(p.projectId);
        if (ws && ws.panes[p.paneId]) { ws.panes[p.paneId].permissions_mode = p.permissionsMode; deps.manager.ledger["save"](); }
        deps.broadcastLedgerUpdate();
        deps.broadcast({ type: "terminals_updated" });
        return `Safety permission mode for pane ${p.paneId} updated to ${p.permissionsMode}.`;
      };
    default:
      return () => `Cannot replay deferred action: unknown capability "${intent.capability}".`;
  }
}
```

> **Critical lockstep rule (call out in review).** `buildActionRun` is a *re-derivation* of the four literal closures. Any future edit to a staging-site closure MUST be mirrored here, or a confirm-after-restart diverges from a confirm-in-process. The §3 test that pins "in-process confirm output == rebuilt-from-intent confirm output" is the guard against drift — keep it.
>
> **Recipe note.** The recipe per-pane closure is a `create_pane` variant (it also adds a startup-command note); the `create_pane` rebuild above folds in `startupCommand`, so a deferred recipe pane replays correctly. The recipe's whole-layout `apply_recipe=Off` veto returns `403` *synchronously* (`server.ts:1283`) and is never staged, so there is no `apply_recipe` intent to persist — only `create_pane` rows from `gateOrDefer` inside the loop.

### Change E — `src/pendingActions.ts`: durable backend + injection (mirror nzt)

1. **Add the structural durable interface + intent on the record** (top of file):

```ts
import type { StoredPendingAction } from "./store/types";

/** Durable backend contract PendingActionStore depends on. JanusStore implements it; null => pure in-memory. */
export interface ActionDurableStore {
  insertPendingAction(a: StoredPendingAction): void;
  claimAction(id: string): boolean;
  deletePendingAction(id: string): void;
  getPendingActions(): StoredPendingAction[];
}

/** Fallback TTL when add() supplies no ttl (mirror APPROVAL_DEFAULT_TTL_MS / server APPROVAL_TTL_MS). */
export const ACTION_DEFAULT_TTL_MS = 5 * 60 * 1000;
```

2. **Extend `PendingAction`** with the serializable intent the store persists (the closure stays for the live path):

```ts
export interface PendingAction {
  id: string;
  capability: string;
  summary: string;
  /** Serializable intent the durable row persists; rebuilt into `run` on boot. Optional on the
   *  legacy/in-memory path (only the closure is needed there). */
  params?: Record<string, unknown>;
  timestamp: number;
  claimed?: boolean;
  lastCallAt?: number;     // (unchanged) IN-MEMORY ONLY transient
  run: () => string;       // (unchanged) NOT serializable
  /** ttl override for the durable expires_at (defaults to ACTION_DEFAULT_TTL_MS). */
  ttlMs?: number;
}
```

3. **Constructor injection + hydrate-intents** (mirror `pendingApprovals.ts:487-509`):

```ts
private readonly store: ActionDurableStore | null;
constructor(store: ActionDurableStore | null = null) {
  this.store = store ?? null;
}
```

> **DELIBERATE divergence from nzt:** the *store class* does NOT hydrate runnable records on construct (it cannot rebuild `run`). Instead it exposes the persisted **intents** for the server to rebuild + re-stage:

```ts
/** Persisted survivors as bare intents (no run yet). The SERVER rebuilds run via actionEffects and
 *  re-stages each through add(). Empty when store===null. Ordered by durable timestamp ASC. */
hydrateIntents(): StoredPendingAction[] {
  return this.store ? this.store.getPendingActions() : [];
}
```

4. **Dual-write `add()`** (mirror `pendingApprovals.ts:551-577`). The in-memory path is unchanged; when a store is present AND the record carries `params`, also persist the row. (A re-staged survivor at boot already has its row, so re-inserting is a harmless INSERT OR REPLACE.)

```ts
add(rec: Omit<PendingAction, "claimed">): PendingAction {
  const full: PendingAction = { ...rec };
  this.records.set(full.id, full);
  this.order.push(full.id);
  if (this.store && full.params) {
    const ttlMs = full.ttlMs ?? ACTION_DEFAULT_TTL_MS;
    this.store.insertPendingAction({
      id: full.id, capability: full.capability, summary: full.summary,
      params: JSON.stringify(full.params), claimed: full.claimed ?? false,
      timestamp: full.timestamp, expires_at: full.timestamp + ttlMs,
    });
  }
  return full;
}
```

5. **Durable `claim()` + durable `remove()`** (mirror `pendingApprovals.ts:591-598, 628-641`). `confirm`/`cancel`/`expire` already funnel through `claim()`/`remove()`, so the change is localized to those two privates:

```ts
private remove(id: string): void {
  if (this.store) this.store.deletePendingAction(id);
  this.records.delete(id);
  this.order = this.order.filter((x) => x !== id);
}
private claim(id: string): boolean {
  if (this.store) {
    const won = this.store.claimAction(id);
    if (won) { const rec = this.records.get(id); if (rec) rec.claimed = true; }
    return won;
  }
  const rec = this.records.get(id);
  if (!rec || rec.claimed) return false;
  rec.claimed = true;
  return true;
}
```

> **CAREFUL — `cancel()` and `expire()` currently set `record.claimed = true` directly, bypassing `claim()`** (`pendingActions.ts:108, 123`). On the durable path that would NOT flip the SQL `claimed` column, so a cancelled-but-not-deleted row could re-hydrate after a crash mid-cancel. **Route both through `this.claim(id)`** so the durable claim fires before `remove()`. Concretely: in `cancel()`/`expire()`, replace the `if (record.claimed) return {lost_race}; record.claimed = true;` pair with `if (!this.claim(id)) return { reason: "lost_race", record };` then `this.remove(id)`. `confirm()` already uses `this.claim(id)` (`:97`) — leave it. (Verify the resulting reason mapping against `tests/test_pending_actions.ts` — those tests must stay green.)

### Change F — `server.ts`: inject the store + rebuild survivors at boot

1. **Inject** (`server.ts:1405`):

```ts
const pendingActions = new PendingActionStore(store);   // ← durable (was: no arg)
```

2. **Persist intent at each staging site.** `gateOrDefer` (`server.ts:1503`) gains a `params` parameter that it forwards into `pendingActions.add(...)` (`:1517`):

```ts
function gateOrDefer(capability, paneId, summary, run, params?: Record<string, unknown>) { … }
//   …Ask branch (:1517):
pendingActions.add({ id: actionId, capability, summary, params, timestamp: Date.now(), run });
```

Then each of the four callers passes the param bag the closure captured (the §1c table). Examples:

```ts
// voice create_pane (server.ts:2322):
gateOrDefer("create_pane", pane_id ?? null, `Create pane ${pane_id} (${command}) in ${project_id}`, createPaneEffect,
  { paneId: pane_id, cwd: manager.ledger.workspaces[project_id]?.directory, command, toolPreset: tool_preset, permissionsMode: permissions_mode, projectId: project_id });
// REST /api/terminals (server.ts:774):
gateOrDefer("create_pane", terminalId, `Create pane ${terminalId} (${command})`, spawnEffect,
  { paneId: terminalId, cwd: resolvedCwd, command, toolPreset, permissionsMode, sessionId, projectId: projectId || "" });
// REST recipe pane (server.ts:1305):
gateOrDefer("create_pane", p.id, `Create pane ${p.id} (recipe ${recipe.id})`, spawnPane,
  { paneId: p.id, cwd: proj.directory, command: bareShell, toolPreset: p.preset, permissionsMode: p.permissionsMode, startupCommand: p.startupCommand, projectId: activeProjectId });
// voice set_global_permissions (server.ts:2344):
gateOrDefer("set_global_permissions", null, `Set global permissions to ${permissions_mode}`, applyGlobalPerms,
  { permissionsMode: permissions_mode });
// voice set_pane_permissions (server.ts:2834):
gateOrDefer("set_pane_permissions", pane_id ?? null, `Set pane ${pane_id} permissions to ${permissions_mode}`, applyPanePerms,
  { paneId: pane_id, projectId: project_id, permissionsMode: permissions_mode });
```

> Keep `params` keys in lockstep with `buildActionRun` (Change D). The param-key contract is the seam — name it once, use it on both ends.

3. **Rehydrate at boot** — re-stage each survivor with a rebuilt `run`, placed right after the `pendingActions` construction (`server.ts:~1406`), where `manager`, `broadcast`, `broadcastLedgerUpdate`, `sanitizeSettingsForClient` are already in scope:

```ts
// kzt: rebuild deferred-action survivors from durable intent. The run() closure is non-serializable,
// so we persisted the INTENT (capability+params) and rebuild it here, bound to the LIVE manager/broadcast.
// Re-staging via add() carries the existing durable row (INSERT OR REPLACE is a no-op rewrite) and makes
// the survivor confirmable/cancellable exactly as before the restart.
for (const row of pendingActions.hydrateIntents()) {
  let params: Record<string, unknown> = {};
  try { params = JSON.parse(row.params); } catch { /* corrupt -> empty params; run() degrades gracefully */ }
  const run = buildActionRun({ capability: row.capability, params }, { manager, broadcast, broadcastLedgerUpdate, sanitizeSettingsForClient });
  pendingActions.add({ id: row.id, capability: row.capability, summary: row.summary, params, timestamp: row.timestamp, run, ttlMs: Math.max(0, row.expires_at - row.timestamp) });
  if (store) { try { store.recordActivity({ type: "permission_changed", project_id: "default_project", pane_id: null, summary: `REHYDRATED deferred ${row.capability}: ${row.summary}`, payload: { capability: row.capability, action: "rehydrated", action_id: row.id } }); } catch {} }
}
```

Add the import at the top of `server.ts` (alongside `./src/pendingActions`, `:38`):

```ts
import { buildActionRun } from "./src/actionEffects";
```

> **Ordering constraint:** this loop must run *after* `manager` is constructed and *after* `pendingActions` is constructed, but *before* the first WS connection / first sweep tick. Placing it immediately after `server.ts:1405` satisfies all three (manager is built far earlier; the sweep timer is set at `:1766`; `wss.on("connection")` at `:1771`).

---

## 3. TEST-FIRST Plan (repo runners; RED first, confirm it fails for the right reason)

> **Runners:** `npm test` = `tsx --test --test-force-exit tests/*.ts`; `npm run lint` = `tsc --noEmit`; `npm run build` = vite+esbuild. Baseline is **478 pass / 0 fail** — do not regress. New tests go in two files: a store-level durability suite (temp-file, mirrors `test_pendingApprovals_durable.ts`) and a registry/round-trip suite (pure, mirrors `test_pending_actions.ts`).

### 3a. THE FAILING TEST TO WRITE FIRST

**File:** `tests/test_pendingActions_durable.ts` (NEW) — modeled byte-for-byte on `tests/test_pendingApprovals_durable.ts` (temp-file harness, `mkdtempSync` + `afterEach` cleanup, two `JanusStore`s over the same path).

**First failing assertion (RED on a missing method / un-injected store):**

```ts
import { test, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { JanusStore } from "../src/store/sqliteStore";
import { PendingActionStore } from "../src/pendingActions";

const TTL = 5 * 60 * 1000;
const tmpDirs: string[] = [];
function tmpDbPath() { const d = mkdtempSync(join(tmpdir(), "janus-actions-")); tmpDirs.push(d); return join(d, "actions.db"); }
afterEach(() => { while (tmpDirs.length) { try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch {} } });

test("durable: a staged action's INTENT survives a store reopen (hydrateIntents)", () => {
  const path = tmpDbPath();
  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingActionStore(store1);
  s1.add({ id: "act1", capability: "create_pane", summary: "Create pane build-1",
           params: { paneId: "build-1", command: "bash", projectId: "p1" },
           timestamp: Date.now(), ttlMs: TTL, run: () => "ran" });
  store1.close();

  // "restart": fresh store + fresh PendingActionStore over the SAME file.
  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingActionStore(store2);
  const intents = s2.hydrateIntents();                      // <- RED first: method does not exist
  assert.deepStrictEqual(intents.map(i => i.id), ["act1"], "survivor intent must reopen");
  assert.strictEqual(JSON.parse(intents[0].params).paneId, "build-1");
  store2.close();
});
```

This fails first at compile/import on `hydrateIntents` (Change E) / `insertPendingAction` (Change C) / the missing table (Change B). Confirm the failure is *"`hydrateIntents` is not a function" / "no such table: pending_actions"* — not an unrelated error — before implementing.

### 3b. Round-trip: rebuilt run() == in-process run() (the registry guard)

**File:** `tests/test_actionEffects.ts` (NEW, pure — imports `../src/actionEffects`, NEVER `../server`).

Pin that `buildActionRun(intent)` reproduces the literal staging-site effects against a **fake `manager`/`broadcast` deps bag**, and that the output + the manager mutation match what an in-process confirm would have produced:

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildActionRun } from "../src/actionEffects";

function fakeDeps() {
  const calls: any = { added: [], broadcasts: [], ledgerBroadcasts: 0, perms: null };
  const manager: any = {
    ledger: { getProject: () => ({ panes: {} }), addProject() {}, addPaneNote() {}, save() {} },
    terminals: {},
    addTerminal(...a: any[]) { calls.added.push(a); return "OK"; },
    saveSettings() {}, settings: { advanced: {} },
    set globalPermissionsMode(v: any) { calls.perms = v; }, get globalPermissionsMode() { return calls.perms; },
  };
  return { calls, deps: { manager, broadcast: (m: any) => calls.broadcasts.push(m), broadcastLedgerUpdate: () => calls.ledgerBroadcasts++, sanitizeSettingsForClient: (s: any) => s } };
}

describe("kzt — buildActionRun rebuilds deferred effects from intent", () => {
  it("create_pane intent -> addTerminal + terminals_updated broadcast", () => {
    const { calls, deps } = fakeDeps();
    const run = buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "p1" } }, deps as any);
    const out = run();
    assert.strictEqual(calls.added.length, 1, "addTerminal called once");
    assert.ok(calls.broadcasts.some((b: any) => b.type === "terminals_updated"));
    assert.match(out, /pane x/i);
  });
  it("set_global_permissions intent -> sets mode + settings_updated broadcast", () => {
    const { calls, deps } = fakeDeps();
    buildActionRun({ capability: "set_global_permissions", params: { permissionsMode: "Read-Only" } }, deps as any)();
    assert.strictEqual(calls.perms, "Read-Only");
    assert.ok(calls.broadcasts.some((b: any) => b.type === "settings_updated"));
  });
  it("unknown capability -> safe no-op run (never throws on hydrate)", () => {
    const { deps } = fakeDeps();
    const out = buildActionRun({ capability: "bogus", params: {} }, deps as any)();
    assert.match(out, /unknown capability/i);
  });
});
```

### 3c. End-to-end durability: stage → reopen → REBUILD → confirm runs exactly once

The load-bearing acceptance test — proves a deferred action survives a restart *and* the rebuilt closure executes on confirm (using `buildActionRun` to model the server's boot loop, since the server itself can't be imported):

```ts
import { buildActionRun } from "../src/actionEffects";

test("durable e2e: stage -> reopen -> rebuild -> confirm runs the effect exactly once", () => {
  const path = tmpDbPath();
  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingActionStore(store1);
  s1.add({ id: "act1", capability: "create_pane", summary: "Create pane build-1",
           params: { paneId: "build-1", command: "bash", projectId: "p1" }, timestamp: Date.now(), ttlMs: TTL,
           run: () => { throw new Error("original run must NOT be used after restart"); } });
  store1.close();

  // Restart: rebuild survivors exactly as server.ts boot loop does.
  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingActionStore(store2);
  const calls: any[] = [];
  const deps = { manager: { ledger: { getProject: () => null, addProject(){}, addPaneNote(){} }, addTerminal: (...a:any[]) => { calls.push(a); return "OK"; } },
                 broadcast: () => {}, broadcastLedgerUpdate: () => {}, sanitizeSettingsForClient: (s:any)=>s };
  for (const row of s2.hydrateIntents()) {
    const params = JSON.parse(row.params);
    s2.add({ id: row.id, capability: row.capability, summary: row.summary, params, timestamp: row.timestamp,
             run: buildActionRun({ capability: row.capability, params }, deps as any), ttlMs: TTL });
  }
  // Confirm the rebuilt action: the REBUILT run fires (not the dead original), exactly once.
  const r = s2.confirm("act1");
  assert.strictEqual(r.reason, "confirmed");
  assert.strictEqual(calls.length, 1, "rebuilt addTerminal ran exactly once");
  assert.strictEqual(s2.has("act1"), false);
  // A fresh reopen sees the durable row gone (confirm deleted it durably).
  store2.close();
  const store3 = new JanusStore(path); store3.init();
  assert.strictEqual(new PendingActionStore(store3).hydrateIntents().length, 0);
  store3.close();
});
```

### 3d. Durable claim survives reopen + N-1 race (mirror nzt 75-110)

```ts
test("durable: a claimed-but-undeleted action row stays claimed across reopen (no double-run)", () => {
  const path = tmpDbPath();
  const store1 = new JanusStore(path); store1.init();
  new PendingActionStore(store1).add({ id: "act1", capability: "create_pane", summary: "x",
    params: { paneId: "x", command: "bash" }, timestamp: Date.now(), ttlMs: TTL, run: () => "ran" });
  assert.strictEqual(store1.claimAction("act1"), true);   // claimed, not deleted (crash sim)
  store1.close();
  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingActionStore(store2);
  assert.deepStrictEqual(s2.hydrateIntents().map(i => i.id), [], "claimed survivor is NOT re-hydrated (getPendingActions filters claimed=0)");
  store2.close();
});
```

> This pins the §1d crash-window semantics: a row claimed before the process died does NOT replay (it is excluded by the `claimed=0` filter in `getPendingActions`), matching the approval store's behavior and preserving exactly-once across a restart.

### 3e. Schema-version guard (don't break existing store tests)

`SCHEMA_VERSION` is asserted in `tests/test_store_schema.ts` and the boot-migration suite (`tests/test_store_boot_migration.ts`). Bumping `3→4` will RED those until updated. **Update those assertions to `4`** and add one assertion that the `pending_actions` table exists after `init()`:

```ts
const cols = (s.db.prepare("PRAGMA table_info(pending_actions)").all() as any[]).map(c => c.name);
assert.deepStrictEqual(cols.sort(), ["capability","claimed","expires_at","id","params","summary","timestamp"].sort());
```

Also confirm `tests/test_store_migrate.ts` / `test_store_parity.ts` don't hardcode the migration count; bump if they do.

### Test execution order

1. Write §3a (`tests/test_pendingActions_durable.ts`) → `npm test` → **RED** (`no such table` / `hydrateIntents` undefined).
2. Land Changes A, B, C (types + schema v4 + store methods) → `npm test` → §3a goes GREEN; §3e schema tests RED until their version assertion is bumped.
3. Update §3e assertions (`SCHEMA_VERSION → 4` + table-exists) → `npm test` GREEN.
4. Write §3b (`tests/test_actionEffects.ts`) → RED (no `src/actionEffects.ts`). Land Change D → GREEN.
5. Land Change E (`PendingActionStore` injection/dual-write/durable claim) → `npm test` → existing `tests/test_pending_actions.ts` stays GREEN (legacy `store=null` path unchanged); add §3c, §3d → GREEN.
6. Land Change F (server injection + boot rebuild + per-site params) → `npm run lint` (`tsc --noEmit`) GREEN.
7. Full `npm test` (478 + new) + `npm run build` GREEN.

---

## 4. Verify Commands

```bash
cd "C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes"
npm run lint          # tsc --noEmit — server.ts gateOrDefer signature + actionEffects deps typing
npm test              # tsx --test --test-force-exit tests/*.ts — new durable + registry suites + full baseline (478)
npm run build         # vite + esbuild -> dist/server.cjs — confirms the actionEffects module split resolves
py -3 -m unittest tests.test_universal_terminal   # unaffected; run as a regression spot-check
```

Run from the feature worktree root. `git status --short` must be clean after commit.

---

## 5. Risks

1. **Closure/registry drift (HIGHEST).** `buildActionRun` re-derives the four literal staging closures. If a staging-site effect changes and the registry isn't updated in lockstep, a confirm-after-restart silently diverges from a confirm-in-process. **Mitigation:** the §3b/§3c tests pin the rebuilt effect's shape; add a code comment at each staging site pointing to `actionEffects.ts`. Accept this as the cost of persisting a closure-shaped record.
2. **Param-key contract is stringly-typed.** The `params` bag keys (`paneId`, `cwd`, `command`, …) must match between the staging sites (Change F) and `buildActionRun` (Change D). A typo persists a bad intent that replays wrong. **Mitigation:** define the per-capability param shape as a TS interface in `actionEffects.ts` and type both the `add` calls and the `switch` against it (catches mismatches at `tsc --noEmit`).
3. **`addTerminal` re-spawn on a stale pane id.** A `create_pane` rebuilt + confirmed after restart calls `manager.addTerminal(paneId, …)`. If a pane with that id already exists post-restart (it shouldn't — panes boot INERT per CLAUDE.md, and a deferred-but-unconfirmed pane never spawned), `addTerminal`'s own guard handles it. **Mitigation:** none needed; note for review. Worst case is `addTerminal` returning an "already exists" string, which is surfaced verbatim.
4. **`set_global_permissions` / `set_pane_permissions` replay applies a possibly-stale intent.** A permission change deferred before a restart, confirmed after, applies the *originally-requested* mode — correct (the operator's queued intent is honored). No staleness check needed; the action is still UN-confirmed (re-requires the conscious yes via the resumption digest, `server.ts:1543-1576`).
5. **Claimed-row leak (inherited nzt hazard, OUT OF SCOPE).** `pruneOnBoot` doesn't sweep `pending_actions`; a crash between `claimAction` and `deletePendingAction` leaks a `claimed=1` row (invisible to `getPendingActions`/hydrate, so harmless to correctness — just unbounded growth). **Mitigation:** file a follow-up bead "boot-prune pending_actions WHERE claimed=1 OR expires_at < now-grace" (mirror the nzt follow-up). Do NOT expand scope here.
6. **Importing `../server` boots the listener (CONFIRMED).** Same constraint as G6: `server.ts` tail runs `startServer()`. The pure registry lives in `src/actionEffects.ts`; tests import that, never `../server`. The server's boot-rebuild loop is modeled in §3c using `buildActionRun` directly.
7. **Migration ordering with a live `.janus.db`.** v4 is purely additive (new table), so it applies cleanly to an existing DB at the next `init()`. Confirm `test_store_boot_migration.ts` (which exercises upgrade-from-older-version) still passes after the version bump.
8. **`expires_at` parity / sweep.** Persisting `expires_at = timestamp + ttlMs` lets a future durable sweep (`getExpiredActions`) match the approval pattern. The in-process sweep (`server.ts:1752`) still uses the in-memory `expired(ttlMs, now)` (unchanged) — so no behavioral change to expiry timing; the durable column is forward-looking parity, not wired into the sweep in this task (keep scope tight). Note in review.

---

## 6. Acceptance Criteria (from the bead, made checkable)

- [ ] **Action intent persists.** A staged `Ask`-tier action writes a `pending_actions` row (capability + JSON params + ttl) via `JanusStore.insertPendingAction`.
- [ ] **Survives a process restart.** After a fresh `JanusStore` reopens the same DB, `hydrateIntents()` surfaces the survivor and the server boot-loop re-stages it with a rebuilt `run` (§3a, §3c).
- [ ] **Rebuilt effect == in-process effect.** `buildActionRun(intent)` reproduces the literal staging-site closure (addTerminal/perms + broadcasts), guarded by §3b.
- [ ] **Exactly-once across restart.** A claimed-but-undeleted row stays claimed (not re-hydrated); confirm-after-rebuild runs the effect once and deletes the durable row (§3c, §3d).
- [ ] **Legacy path unchanged.** `new PendingActionStore()` / `new PendingActionStore(null)` behaves byte-for-byte as today; `tests/test_pending_actions.ts` stays green.
- [ ] **`cancel`/`expire` flip the durable claim** (route through `claim()`), so a mid-cancel crash doesn't re-replay.
- [ ] **Schema v4 is additive + clean** on an existing `.janus.db`; `test_store_schema.ts` / `test_store_boot_migration.ts` updated and green.
- [ ] **`npm run lint`, `npm test` (478 + new, 0 fail), `npm run build` all green.**
