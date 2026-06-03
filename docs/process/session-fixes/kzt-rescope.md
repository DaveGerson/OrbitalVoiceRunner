# kzt — RE-SCOPE against current main (durable deferred actions)

**Bead:** `wsm-e2e-pinned-kzt` (P3 · TASK · backend)
**Re-scope branch (ALL edits here):** `feat/session-fixes-rescope` in
`C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes`
**Base:** current `main` = `a38a3cc` (9 landed session-fixes + **#26 capability-matrix** + **#27 notes-recall**)
**Original impl under re-scope:** branch `feat/session-fixes` (read-only; never checked out)
**Predecessor plan:** `docs/process/session-fixes/kzt-plan.md` (written against the OLD base — now stale)

---

## BLUF

**Recommendation: `implement-delta`.** kzt is **NOT superseded** — current main still has a
**pure in-memory `PendingActionStore` (`server.ts:1558` constructs it with NO store arg)**, so an
`Ask`-tier deferred action is still silently lost on a process restart. The durability mechanism is
the genuine, un-shipped value.

BUT the **original feat/session-fixes implementation is poisoned** and must NOT be cherry-picked:

1. **Migration-slot collision (HARD):** the original parks `pending_actions` at **schema v4** — but
   on current main **v4 is already taken by #26's `capability_gates` column** (`src/store/schema.ts`,
   bead 8sq). The original diff literally *replaces* the v4 `capability_gates` migration with its own
   table. Cherry-picking it **drops #26's per-pane gate persistence**. → Re-slot to **v5**.
2. **`buildActionRun` is missing #27's capability (the named regression):** `update_metadata`
   (amend_note + delete_note, added by #27) routes through `gateOrDefer` but the original
   `buildActionRun` (`src/actionEffects.ts`) has **no `update_metadata` case** → a rebuilt/replayed
   action returns the no-op `"Cannot replay deferred action: unknown capability"` and applies **no
   text**. This is exactly the `test_notes_recall.ts` "confirm applied the wrong text" failure.
3. **`sqliteStore.ts` reverts #27 + #26 + the close-guard:** the original diff *deletes* the
   `search(opts.source)` param (#27 notes-recall depends on it), *deletes* the `capability_gates`
   savePane/hydrate round-trip (#26), and *reverts* the idempotent `close()` guard. All three are
   artifacts of feat/session-fixes branching from an **older main** — NOT kzt deltas.
4. **server.ts diff is ~782 lines of stale base:** it re-introduces a pre-#26/#27 world (e.g. a
   comment asserting "the frozen / stop-all subsystem … lives on the unmerged branch, not on main" —
   **false**: `frozen` / `applyFrozenShortCircuit` / `releaseStopAll` ARE on current main at
   `server.ts:424/1597/1771`). The server.ts portion must be **re-derived surgically**, never
   diffed in.

**Genuine delta = a narrow, additive slice** re-anchored on current main: (a) v5 `pending_actions`
table + 5 additive `JanusStore` methods, (b) `StoredPendingAction` type, (c) durability wiring in
`PendingActionStore` (constructor store + dual-write + `hydrateIntents`), (d) a **complete**
`buildActionRun` registry covering **every** capability now staged through `gateOrDefer` —
**including `update_metadata` with an amend/delete discriminator**, (e) thread an `intent` bag into
`gateOrDefer` at **all 6 staging sites on current main**, (f) the boot hydration loop. Then keep
`test_notes_recall.ts` green and add a durable round-trip test **per capability**.

---

## 1. Supersession check (is anything already on main?)

| kzt component | On current main? | Verdict |
|---|---|---|
| Durable `PendingActionStore` (survives restart) | **No** — `new PendingActionStore()` at `server.ts:1558`, no store arg | **genuine delta** |
| `pending_actions` table / migration | **No** | genuine (but **re-slot v4→v5**) |
| `StoredPendingAction` type | **No** (`grep` of `src/store/types.ts` finds nothing) | genuine |
| `buildActionRun` / `src/actionEffects.ts` | **No** (file does not exist on main) | genuine |
| `gateOrDefer` deferral of Ask-tier mutators | **Yes** (`server.ts:1628`) — but **in-memory only**; staged `run` dies on restart | the durability is the delta |
| Per-pane `capability_gates` persistence | **Yes (#26, v4)** | **must preserve — original kzt deletes it** |
| `search(opts.source)` note-only filter | **Yes (#27)** | **must preserve — original kzt deletes it** |

**Conclusion: implement-delta.** The feature is real and un-shipped; only the *original patch* is
unusable.

---

## 2. Enumerate EVERY deferred-action capability on CURRENT main

Authoritative `gateOrDefer(...)` call-sites on current `main` (`grep -nE "gateOrDefer\(" server.ts`):

| # | server.ts line | capability | effect (closure) | confirm-string fidelity anchor |
|---|---|---|---|---|
| 1 | `842` | `create_pane` | REST `/api/terminals` `spawnEffect` | `return String(result);` |
| 2 | `1454` | `create_pane` | REST recipe `spawnPane` | `return p.id;` (bare pane id) |
| 3 | `2516` | **`update_metadata`** | **#27 `amendEffect`** → `ledger.amendNote(noteId,newText)` | `Note ${noteId} updated.` |
| 4 | `2530` | **`update_metadata`** | **#27 `deleteEffect`** → `ledger.deleteNote(noteId)` | `Note ${noteId} deleted.` |
| 5 | `2654` | `create_pane` | voice `createPaneEffect` | `Pane ${pane_id} created under project ${project_id}. Result: ${result}` |
| 6 | `2676` | `set_global_permissions` | voice `applyGlobalPerms` | `Global permissions updated to ${permissions_mode}.` |
| 7 | `2816` | `create_pane` | voice recipe `spawnPane` | `return p.id;` (bare pane id) |
| 8 | `3240` | `set_pane_permissions` | voice `applyPanePerms` | `Safety permission mode for pane ${pane_id} updated to ${permissions_mode} successfully.` |

**Distinct capability strings to reconstruct: 4** — `create_pane`, `set_global_permissions`,
`set_pane_permissions`, **`update_metadata`**.

### 2a. Two discriminators are required (capability alone is insufficient)

- **`create_pane` → `origin` ∈ {voice, rest, recipe}.** All three sites run the SAME side effects
  (addTerminal + broadcasts) but return DIFFERENT confirm strings (`String(result)` / bare `p.id` /
  the rich `Pane … Result: …`). The original already modeled this with an `origin` tag — **keep it.**
- **`update_metadata` → `op` ∈ {amend, delete}.** Sites 3 and 4 share the capability string
  `update_metadata` but call DIFFERENT ledger methods (`amendNote` vs `deleteNote`) and return
  DIFFERENT strings (`updated.` vs `deleted.`). **The original `buildActionRun` handled NEITHER.**
  The rebuild MUST carry an `op` discriminator or amend/delete cannot be told apart on replay — this
  is the precise mechanism of the #27 regression.

> Note: `apply_recipe` itself is gated via `gateCapability` (veto-only, `server.ts:1424/1443`), NOT
> `gateOrDefer`. Recipe *panes* defer as `create_pane` (sites 2 & 7). So there is **no** separate
> `apply_recipe` intent to reconstruct — do not invent one.

---

## 3. Per-capability rebuild fidelity (what `buildActionRun` must reproduce)

For each, the **rebuilt closure MUST apply byte-identically to the in-memory closure** at the cited
current-main line. Anchored to the real #26/#27 source.

### 3.1 `create_pane` (sites 1, 2, 5, 7) — KEEP origin tag, RE-ANCHOR cwd

Side effects (all origins): co-create project if missing → `manager.addTerminal(...)` → (recipe only)
`addPaneNote("Suggested startup command: …")` → `broadcastLedgerUpdate()` + a terminals_updated
broadcast. **Fidelity hazards to fix vs. the original rebuild:**

- **cwd resolution differs per site and the original rebuild flattened it.** Persist the
  **already-resolved cwd** in params (REST resolves via `activeProj?.directory || process.cwd()` at
  `server.ts:815`; voice uses `manager.ledger.workspaces[project_id]?.directory || process.cwd()` at
  `2640`; recipe uses `proj.directory || process.cwd()` at `1441`). Persisting the *resolved* string
  (not the raw arg) makes the rebuild independent of post-restart project state — capture at enqueue.
- **broadcast shape:** current main uses `broadcastTerminalsUpdated()` (carries `postures`) at the
  voice/recipe sites and `broadcast({type:"terminals_updated"})` at REST. The rebuild runs at boot
  before any WS client; match whichever the staging site used, but a bare `terminals_updated` is
  acceptable at boot (no client to receive postures yet) — **document the choice, don't drift the
  test on it.** Pin the *return string* (operator-facing), not the transient broadcast payload.
- **origin → return string** (drift guard, unchanged from original): rest→`String(result)`,
  recipe→`p.paneId`, voice/default→`Pane … created under project …. Result: …`.

### 3.2 `set_global_permissions` (site 6) — unchanged from original

`manager.globalPermissionsMode = mode` → `settings.advanced.globalPermissionsMode = mode` →
`saveSettings()` → `broadcast({type:"settings_updated", globalPermissionsMode, settings:
sanitizeSettingsForClient(settings)})` → `return "Global permissions updated to ${mode}."`. The
original rebuild already matches `server.ts:2660-2674`. **Keep.**

### 3.3 `set_pane_permissions` (site 8) — unchanged from original

`if terminals[paneId] setPermissionsMode(mode)` → if ledger pane exists set
`permissions_mode = mode` + `ledger.save()` → broadcasts → `return "Safety permission mode for pane
${paneId} updated to ${mode} successfully."` (keep trailing "successfully."). Matches
`server.ts:3229-3239`. **Keep.** (Params: `{paneId, projectId, permissionsMode}`.)

### 3.4 `update_metadata` (sites 3, 4) — **NEW CASE, the core of the re-scope**

```
case "update_metadata": {
  const p = intent.params as { op: "amend" | "delete"; noteId: string; text?: string };
  return () => {
    if (p.op === "amend") {
      deps.manager.ledger.amendNote(p.noteId, p.text ?? "");
      deps.broadcastLedgerUpdate();
      return `Note ${p.noteId} updated.`;     // EXACT — matches server.ts:2519
    }
    deps.manager.ledger.deleteNote(p.noteId);
    deps.broadcastLedgerUpdate();
    return `Note ${p.noteId} deleted.`;       // EXACT — matches server.ts:2533
  };
}
```

- **Text fidelity is the whole point:** the amend text is bound at *enqueue* time (#27 MUST-FIX #3);
  the persisted `params.text` must be that bound text so confirm-after-restart applies *that* text,
  not whatever the model says next. `test_notes_recall.ts:231-250` pins this in-process; the durable
  test pins it across a reopen.
- `amendNote`/`deleteNote` exist on the ledger on current main (used by the in-memory closures at
  `server.ts:2518/2532`); the rebuild calls the same methods — confirm via the ledger interface.

---

## 4. Files to touch (genuine delta only) and the surgical change in each

| File | Change |
|---|---|
| `src/store/schema.ts` | **APPEND** a new migration as **v5** (`MIGRATIONS[4]`) creating `pending_actions(id PK, capability, summary, params, claimed, timestamp, expires_at)`. **Do NOT touch the v4 `capability_gates` migration** (that is #26 — leave it verbatim). Migration is purely additive (new table). |
| `src/store/types.ts` | **ADD** `StoredPendingAction` interface (id, capability, summary, params:string, claimed:boolean, timestamp, expires_at). Net-new on main. |
| `src/store/sqliteStore.ts` | **ADD ONLY** the 5 additive methods: `insertPendingAction` / `claimAction` / `deletePendingAction` / `getPendingActions` / `getExpiredActions`. **Do NOT** apply the original's deletions of `search(opts.source)`, the `capability_gates` savePane/hydrate block, or the `close()` guard — those are #27/#26/close-guard reversions, not kzt. |
| `src/pendingActions.ts` | **ADD** `ActionDurableStore` structural interface, `ACTION_DEFAULT_TTL_MS`, optional `params?`/`ttlMs?` on `PendingAction`, constructor `store` arg, dual-write in `add()`, `hydrateIntents()`, durable claim/remove in `claim()`/`cancel()`/`expire()`. The original's `pendingActions.ts` diff is clean (additive, on a matching base) — port it as-is. |
| `src/actionEffects.ts` | **NEW.** `buildActionRun` registry — port the original's `create_pane` (origin) / `set_global_permissions` / `set_pane_permissions` cases, **ADD the `update_metadata` (op) case** from §3.4, re-anchor cwd capture per §3.1. |
| `server.ts` | **SURGICAL, re-derived against current main — NOT the original diff.** (i) import `buildActionRun`; (ii) `const pendingActions = new PendingActionStore(store)` at `1558`; (iii) extend `gateOrDefer` signature with an optional `intent` param bag and pass it to `pendingActions.add({…, params})`; (iv) thread an intent at **all 6 staging sites** (842, 1454, 2654, 2676, 2816, 3240) **AND the 2 new `update_metadata` sites (2516, 2530)** — the original MISSED the latter two; (v) add the boot hydration loop (port from original; it is clean) AFTER `manager`+`pendingActions` are built and BEFORE the first WS/sweep tick. |
| `tests/test_actionEffects.ts` | **NEW.** Pure unit: pin the EXACT confirm string per capability/origin/op (the drift guard). Add `update_metadata` amend + delete cases. |
| `tests/test_pendingActions_durable.ts` | **NEW.** Full durable round-trip **per capability** (§6). Add the `update_metadata` round-trip explicitly. |

---

## 5. TDD sequence (failing test FIRST)

1. **Red anchor for the regression (write FIRST):** in a new `tests/test_actionEffects.ts`, assert
   `buildActionRun({capability:"update_metadata", params:{op:"amend", noteId:"n1", text:"BOUND"}}, deps)()`
   calls `deps.manager.ledger.amendNote("n1","BOUND")` and returns `"Note n1 updated."`. Against a
   `buildActionRun` that lacks the case, this fails with the no-op `"Cannot replay … unknown
   capability"` string — **the exact #27 regression, reproduced at the unit level.** Confirm it fails
   for that reason, then add the §3.4 case → green.
2. Add the `delete` case + `create_pane`(×3 origins) + `set_global_permissions` +
   `set_pane_permissions` string-fidelity assertions.
3. Wire durability (`pendingActions.ts` + `sqliteStore` + schema v5 + types), then
   `tests/test_pendingActions_durable.ts`: stage via a real `JanusStore`-backed store, **drop the
   in-memory maps / construct a fresh `PendingActionStore(sameStore)`** (simulated reopen),
   `hydrateIntents()` → `buildActionRun` → `add()` → `confirm()`, assert the rebuilt effect applies
   identically (esp. amend text). One round-trip **per capability**.
4. Run the FULL gates (`npm run lint`, `npm test`) — `test_notes_recall.ts` and the #26 e2e
   (`gate_chip` / `capability_matrix`) MUST stay green. Baseline 538 pass — do not regress.

---

## 6. Integration risks (how this could regress #26 / #27) — and the guard for each

| # | Risk | How the original triggers it | Guard in the re-scope |
|---|---|---|---|
| R1 | **#26 per-pane gate persistence dropped** | Original re-slots the **v4** migration → replaces `capability_gates` with `pending_actions`; also deletes the savePane/hydrate round-trip in `sqliteStore.ts`. | **Re-slot to v5** (append; never edit v4). **Do not port** the `sqliteStore.ts` deletions. Keep `test_pane_gates_rest.ts` + `test_settings_gates_roundtrip.ts` + the `capability_matrix` e2e green. |
| R2 | **#27 notes-recall amend applies WRONG/NO text on confirm** | `buildActionRun` lacks `update_metadata`; amend/delete intents not even threaded → rebuilt/replayed action is the no-op string. | Add §3.4 `update_metadata` (op) case + thread intents at sites 2516/2530 + persist the **enqueue-bound** text. **`test_notes_recall.ts:231-250` stays green** + a durable amend round-trip. |
| R3 | **#27 `search_notes` note-only filter reverted** | Original `sqliteStore.ts` diff deletes the `opts.source` param of `search()`. | **Do not port that hunk.** Leave `search(query, {limit, source})` intact. `test_redaction.ts` / `search_notes` path stays green. |
| R4 | **create_pane confirm-string drift across the 3 origins** | A single rebuild can't tell voice/rest/recipe apart. | Persist `origin`; pin each string in `test_actionEffects.ts` (the lockstep drift guard). |
| R5 | **cwd divergence on replay** (rebuilt pane lands in a different dir than the in-process spawn would have) | Original flattened cwd to `p.cwd || process.cwd()`, losing per-site resolution. | Persist the **already-resolved** cwd at enqueue (§3.1); rebuild uses it verbatim. |
| R6 | **`frozen`/stop-all stale-base damage** | server.ts diff carries a pre-#26 world that omits `applyFrozenShortCircuit` and asserts (wrongly) that frozen "is not on main". | **Never diff server.ts in.** Re-derive only the 4 surgical edits above against current main; leave `frozen`/`releaseStopAll`/posture helpers untouched. |
| R7 | **Migration runs on an existing `.janus.db`** | n/a (additive) | v5 is a `CREATE TABLE` only (no ALTER); `applyMigrations` runs idx 4 once, bumps `user_version` 4→5. Safe for an already-migrated DB. Add a boot-on-existing-db smoke assertion. |
| R8 | **Exactly-once across a reopen** | A claimed-but-undeleted survivor could re-replay. | `getPendingActions()` filters `claimed=0`; `claim()` routes through atomic SQL `claimAction` so a claimed survivor stays `claimed=1` and never re-hydrates (original already does this — keep). |
| R9 | **Boot replay double-fires effects** | Hydration loop calls `add()` which dual-writes; an effect must not run during hydrate. | Hydration only rebuilds + re-stages `run` (does NOT invoke it). Effects run only on explicit `confirm()`. Assert in the durable test that hydrate alone mutates nothing. |

---

## 7. Decision summary

- **recommendation:** `implement-delta`
- **redundantWithMain:** #26 owns schema **v4 = `capability_gates`** + the per-pane gate
  persistence/hydration in `sqliteStore.ts`; #27 owns `search(opts.source)` + the in-memory
  `amend_note`/`delete_note` `gateOrDefer('update_metadata')` deferral. The original kzt patch
  collides with / reverts all of these.
- **genuineDelta:** durability for `PendingActionStore` (survive a process restart) via a **v5**
  `pending_actions` table + 5 additive `JanusStore` methods + `StoredPendingAction` + store wiring in
  `pendingActions.ts` + a **complete** `buildActionRun` registry that reconstructs **all 4**
  capabilities now staged on main — **including the `update_metadata` amend/delete case the original
  omitted** — plus intent threading at all 8 staging sites and a boot hydration loop. Net-new tests:
  `test_actionEffects.ts` (per-capability string fidelity) + `test_pendingActions_durable.ts`
  (per-capability durable round-trip). `test_notes_recall.ts` and the #26 e2e stay green.
- **failingTestFirst:** `tests/test_actionEffects.ts` — assert the rebuilt `update_metadata` amend
  applies the enqueue-bound text and returns `"Note ${noteId} updated."`; it fails (no-op "unknown
  capability" string) until the §3.4 case is added.
