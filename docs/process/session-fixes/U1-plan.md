# U1 — Spoken "approve" cannot create a terminal — voice resolver never consults the pendingActions queue

**Bead:** `wsm-e2e-pinned-9fe`
**Priority:** P1
**Type:** feature · **Kind:** backend
**Worktree (all edits land here):** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes` (branch `feat/session-fixes`)

---

## BLUF

The hands-free voice resolver does ALL of its work *inside* `if (pendingApprovals.forSession(session).length > 0)` (`server.ts:1863`). A voice-driven `create_pane` under the **Ask** tier is not a pane write — it is staged by `gateOrDefer` into the **global `pendingActions` store** (`server.ts:1407-1412`), which today is resolvable **only by a REST click** (`POST /api/actions/:id/confirm`, `server.ts:1560-1572`). So with zero pending *approvals*, a spoken "approve" parses correctly (`parseApprovalIntent` → `"approve"`) but falls through the `entries.length > 0` guard and is a **silent no-op** — the pane is never created.

**Fix:** add a **fallback branch** to the voice-resolve block: when `pendingApprovals.forSession(session)` is empty but `pendingActions.all()` is non-empty, resolve a `pendingAction` by voice. On `approve` → `pendingActions.confirm(id)` + `broadcast({ type: "action_resolved", actionId, outcome: "confirmed" })` + narrate; on `reject` → `pendingActions.cancel(id)` + `outcome: "cancelled"` + narrate. **Mirror the REST handlers byte-for-byte** so the `claim()` seam preserves exactly-once. **`pendingApprovals` precedence stays FIRST** — pending actions are only consulted when no pending approval exists for the session.

**Proof without a live binary:** a new unit test drives the real `PendingActionStore` + `parseApprovalIntent` through a trimmed re-implementation of the new fallback (same pattern as the existing `makeHarness` sim in `tests/test_approvals_wse.ts`), asserting: single staged action + "approve" runs the effect exactly once; "reject"/"cancel that command" cancels with no run; a double-confirm loses the claim (no double-run); and **precedence** — when an approval AND an action both exist, "approve" resolves the approval and leaves the action untouched.

---

## 1. Problem & Root Cause (code-anchored)

### The choke point that never fires

`server.ts:1860-1882` (confirmed identical in `main`; this worktree branches off it):

```ts
const parsed = parseApprovalIntent(cleanUtter);
if (parsed.intent !== "none") {
  const entries = pendingApprovals.forSession(session);
  if (entries.length > 0) {                        // <-- 1863: the gate that swallows the action case
    if (parsed.intent === "clarify") {
      pushApprovalNarration(session, `I heard both approve and reject — which did you mean ...`);
    } else {
      const target = selectApprovalTarget(/* ... */);
      if (target.ambiguous || !target.messageId) {
        // ... clarify, list pending
      } else {
        resolveApprovalByVoice(session, target.messageId, parsed.intent === "approve");
      }
    }
  }
  // <-- NO `else` branch: pendingApprovals empty -> "approve" is a NO-OP
}
```

The entire body — including the only call that resolves anything (`resolveApprovalByVoice`) — is nested under `entries.length > 0`. There is no `else`. So when `pendingApprovals.forSession(session)` is empty, a parsed `approve`/`reject`/`clarify` does nothing.

### Why a voice `create_pane` lands in a DIFFERENT store

`create_pane` (and the other non-PTY mutators) do not hold an in-flight pane write, so they do **not** go through `PendingApprovalStore`. They route through `gateOrDefer` (`server.ts:1395-1416`). On the **Ask** tier:

```ts
// server.ts:1407-1412
if (gate === "Ask") {
  const actionId = `act_${Date.now()}_${pendingActionSeq++}`;
  pendingActions.add({ id: actionId, capability, summary, timestamp: Date.now(), run });
  // ... audit ...
  broadcast({ type: "action_pending", actionId, capability, summary });
  return { disposition: "deferred", actionId, summary };
}
```

The `create_pane` tool handler stages exactly this (`server.ts:2164`):

```ts
const g = gateOrDefer("create_pane", pane_id ?? null,
  `Create pane ${pane_id} (${command}) in ${project_id}`, createPaneEffect);
```

`pendingActions` is the **global** `PendingActionStore` constructed once at `server.ts:1328` (`const pendingActions = new PendingActionStore();`). It has **no session binding** — unlike `pendingApprovals`, which is keyed by session via `forSession()`. This is a real sharp edge (see Risks §6).

### Where it CAN be resolved today (REST only)

`server.ts:1560-1572` (confirm) and `1574-1580` (cancel):

```ts
app.post("/api/actions/:id/confirm", (req, res) => {
  const { id } = req.params;
  if (!pendingActions.has(id)) { res.status(404).json({ error: "Pending action not found" }); return; }
  try {
    const result = pendingActions.confirm(id);
    if (result.reason === "lost_race") { res.json({ success: true, already: true }); return; }
    if (result.reason === "not_found") { res.status(404).json({ error: "Pending action not found" }); return; }
    broadcast({ type: "action_resolved", actionId: id, outcome: "confirmed" });
    res.json({ success: true, output: result.output });
  } catch (e) { /* 500 */ }
});

app.post("/api/actions/:id/cancel", (req, res) => {
  const { id } = req.params;
  if (!pendingActions.has(id)) { res.status(404).json({ error: "Pending action not found" }); return; }
  const result = pendingActions.cancel(id);
  broadcast({ type: "action_resolved", actionId: id, outcome: "cancelled" });
  res.json({ success: true, already: result.reason === "lost_race" });
});
```

The fallback we add MUST mirror these exactly (same store calls, same broadcast shape) so the two resolve paths stay byte-for-byte consistent and the `claim()` seam keeps exactly-once across a REST+voice race.

### The store seam guarantees exactly-once

`src/pendingActions.ts:94-126`. `confirm(id)` does: lookup → `claim(id)` (returns `false` if already claimed) → `remove(id)` → `record.run()`. `cancel(id)` does: lookup → reject if `record.claimed` → set claimed → `remove(id)` (no `run`). So a REST-confirm racing a voice-confirm: the second caller's `confirm()` returns `{ reason: "lost_race" }` with **no second `run()`**. The voice path must treat `lost_race`/`not_found` exactly as REST does (no narration of success, no double-broadcast of a created pane).

### Why the parser already satisfies the user need

`src/approvalIntent.ts` (confirmed): the **strong** approve verbs include `approve`/`approved`/`accept`/`confirm`/`authorize` (`APPROVE_STRONG`, line 39) and trigger without an object token; bare `"yes"` resolves via `BARE_YES` (line 33, `tokens.length <= 2` block at 142-148). Strong reject verbs include `reject`/`deny`/`decline`/`discard` (`REJECT_STRONG`, line 41). So "approve" / "yes" / "confirm" already parse to `approve`, and "reject" parses to `reject` — **routing alone** (this plan) closes the user gap; no parser change is required.

### Verified against code (no stale refs)

| Claim | Source | Status |
|---|---|---|
| Voice-resolve body nested under `entries.length > 0`, no `else` | `server.ts:1861-1882` | ✅ verified |
| `gateOrDefer` Ask branch stages into `pendingActions` + broadcasts `action_pending` | `server.ts:1407-1412` | ✅ verified |
| `create_pane` rides `gateOrDefer`, summary `Create pane ${pane_id} (${command}) in ${project_id}` | `server.ts:2146-2164` | ✅ verified |
| `pendingActions` is global, session-agnostic (`new PendingActionStore()`) | `server.ts:1328` | ✅ verified |
| REST confirm/cancel handlers + exact `action_resolved` `{actionId, outcome}` shape | `server.ts:1560-1580` | ✅ verified |
| `confirm()` claims-then-runs; `cancel()` claims-then-drops; `lost_race`/`not_found` reasons | `src/pendingActions.ts:94-126` | ✅ verified |
| `PendingActionStore` exported from `src/pendingActions.ts` | `src/pendingActions.ts:51` | ✅ verified |
| Client drops the chip on `action_resolved` keyed on `actionId` (ignores `outcome`) | `src/App.tsx:1117-1119` | ✅ verified |
| `ActionConfirmDialog.tsx` is presentational only (no WS handler) | `src/components/ActionConfirmDialog.tsx:10-65` | ✅ verified |
| `"approve"`/`"yes"`/`"confirm"` → approve; `"reject"`/`"cancel that command"` → reject; bare `"cancel"` → none | `src/approvalIntent.ts:39-42,137-209`; `tests/test_approvals_wse.ts:48,57,63-69` | ✅ verified |
| Test harness pattern: `node:test`, `FakeSession`/`FakeTerm`, `makeHarness` | `tests/test_approvals_wse.ts:1-26,338-421` | ✅ verified |

---

## 2. The Exact Changes (`file:location:change`)

### Change A — `server.ts` (~1861-1882): add the pendingActions fallback to the voice-resolve block

**Anchor:** the `if (parsed.intent !== "none") { const entries = pendingApprovals.forSession(session); if (entries.length > 0) { ... } }` block at `server.ts:1861-1882`.

**Change:** add an `else` to the `entries.length > 0` gate that consults `pendingActions`. Keep the existing approval body **unchanged and FIRST** (precedence). Shape:

```ts
const parsed = parseApprovalIntent(cleanUtter);
if (parsed.intent !== "none") {
  const entries = pendingApprovals.forSession(session);
  if (entries.length > 0) {
    /* ... existing approval body, UNCHANGED ... */
  } else {
    // U1 (bead wsm-e2e-pinned-9fe): no pending pane-WRITE approval for this session, but a
    // gated NON-PTY mutator (create_pane / set_*_permissions) may be staged in the GLOBAL
    // pendingActions store (gateOrDefer Ask branch, server.ts:1407). Resolve it by voice,
    // MIRRORING the REST handlers (server.ts:1560-1580) so the claim() seam keeps exactly-once.
    // NOTE: pendingActions is GLOBAL (not session-scoped like pendingApprovals) — a sharp edge
    // in multi-session setups; here the single live session owns the queue.
    const actions = pendingActions.all();
    if (actions.length > 0) {
      const target = selectPendingAction(actions, parsed.targetHint); // disambiguation helper, below
      if (parsed.intent === "clarify") {
        pushApprovalNarration(session, `I heard both approve and reject — which of the ${actions.length} pending action${actions.length === 1 ? "" : "s"} did you mean?`);
      } else if (!target) {
        // >1 staged and nothing disambiguates -> read back the SUMMARIES (never the empty terminalId).
        const list = actions.map((a, i) => `${i + 1}. ${redactSecrets(a.summary)}`).join("; ");
        pushApprovalNarration(session, `I have ${actions.length} pending action${actions.length === 1 ? "" : "s"}: ${list}. Which one?`);
      } else if (parsed.intent === "approve") {
        const result = pendingActions.confirm(target.id);
        if (result.reason === "confirmed") {
          broadcast({ type: "action_resolved", actionId: target.id, outcome: "confirmed" });
          pushApprovalNarration(session, `Done — ${redactSecrets(target.summary)}.`);
        } // lost_race / not_found -> a concurrent REST already resolved it; stay silent (no double-narration).
      } else { // reject
        const result = pendingActions.cancel(target.id);
        broadcast({ type: "action_resolved", actionId: target.id, outcome: "cancelled" });
        pushApprovalNarration(session, `Cancelled — ${redactSecrets(target.summary)}.`);
      }
    }
  }
}
```

**`selectPendingAction` disambiguation helper** (place alongside the block, or inline): with `actions.length === 1`, return that single action. With `>1`, use `parsed.targetHint` (ordinal → `actions[ordinal-1]` / `actions[length-1]` for `-1`; fragment → unique substring match against `a.summary` via `normalizeUtterance`). Return `undefined` when `>1` and nothing uniquely resolves → the caller reads back the **summaries** (the verifier-mandated correction: actions have no meaningful `terminalId`, so read back `a.summary`, NOT an empty pane id).

> Implementation note: the existing `selectApprovalTarget` is typed for `PendingApproval` entries (`messageId`/`instruction`/`terminalId`). Do **not** reuse it directly for actions (the `terminalId` read-back is wrong for actions). Write a small `selectPendingAction(actions, hint)` in `src/approvalIntent.ts` (pure, unit-testable) OR inline the single-vs-many logic in `server.ts`. **Prefer pure + exported** so it can be unit-tested without the server closure (mirrors how `selectApprovalTarget` is tested).

### Change B — `src/approvalIntent.ts` (optional, ONLY if disambiguation is extracted): export `selectPendingAction`

If extracted, add a pure helper next to `selectApprovalTarget` (line 233):

```ts
export interface PendingActionLike { id: string; summary: string; }
export interface ActionTargetResult { id?: string; summary?: string; ambiguous?: boolean; via?: "only" | "ordinal" | "fragment"; }

export function selectPendingAction(
  actions: PendingActionLike[],
  hint: TargetHint | undefined
): ActionTargetResult {
  if (actions.length === 0) return {};
  if (actions.length === 1) return { id: actions[0].id, summary: actions[0].summary, via: "only" };
  if (hint?.ordinal !== undefined) {
    const idx = hint.ordinal === -1 ? actions.length - 1 : hint.ordinal - 1;
    if (idx >= 0 && idx < actions.length) return { id: actions[idx].id, summary: actions[idx].summary, via: "ordinal" };
    return { ambiguous: true };
  }
  if (hint?.fragment) {
    const needle = normalizeUtterance(hint.fragment).split(" ").filter(Boolean);
    const matches = actions.filter((a) => { const hay = normalizeUtterance(a.summary); return needle.every((t) => hay.includes(t)); });
    if (matches.length === 1) return { id: matches[0].id, summary: matches[0].summary, via: "fragment" };
    return { ambiguous: true };
  }
  return { ambiguous: true }; // >1, no hint -> clarify (read back summaries)
}
```

**DO NOT** relax `APPROVE_WEAK`/`OBJECT_TOKENS` to add `"create"`/`"make"`. The verifier correction is explicit: any parser relaxation must NOT drop the `tokens.length > 2` weak-verb guard (`approvalIntent.ts:194`), and the bare single-pending case is handled in the **server** (single action ⇒ resolve on any strong approve/reject), not by widening the pure parser. Bare "approve"/"yes"/"confirm" already parse to `approve`, so no parser change is needed for the acceptance criteria.

### Change C — `src/components/ActionConfirmDialog.tsx` / `src/App.tsx`: verify only (no edit expected)

`App.tsx:1117-1119` already drops the chip on `action_resolved` keyed on `msg.actionId` and **ignores `outcome`**, so voice-confirmed and voice-cancelled both clear the UI chip correctly via the same broadcast the REST path emits. `ActionConfirmDialog.tsx` is presentational (`onConfirm(actionId)`/`onCancel(actionId)`), no WS handler. **No client change required** — confirm during implementation and add a one-line note to the PR if anything drifted.

---

## 3. Test-First Plan (aligned to the repo runners)

**Runner:** `npm test` (`tsx --test --test-force-exit`). Extend the existing `tests/test_approvals_wse.ts` (the `node:test` + `FakeSession`/`FakeTerm` + `makeHarness` file). Follow its convention: pure-module assertions + a trimmed harness re-implementing the server wiring over the **real** store — no PTY, no Gemini, no timers armed.

### The failing test to write FIRST (watch it FAIL before any server edit)

Add a new `describe("U1 — voice resolves a staged pendingAction (bead wsm-e2e-pinned-9fe)", …)` block. Build a tiny `resolveActionByVoice` harness fn that re-implements **Change A**'s fallback over a real `PendingActionStore` (import `PendingActionStore` from `../src/pendingActions`) and the real `parseApprovalIntent` + `selectPendingAction`. The first test:

```ts
it("single staged create_pane + spoken 'approve' runs the effect exactly once", () => {
  const actions = new PendingActionStore();
  let ran = 0;
  actions.add({ id: "act_1", capability: "create_pane",
    summary: "Create pane claude_new (claude) in proj", timestamp: Date.now(),
    run: () => { ran++; return "Pane claude_new created."; } });

  const sess = new FakeSession();
  resolveActionByVoice(sess, actions, "approve");      // <-- the new routing under test

  assert.strictEqual(ran, 1, "the staged create_pane effect ran exactly once");
  assert.strictEqual(actions.has("act_1"), false, "the action was removed from the queue");
  assert.ok(sess.clientContents.length >= 1, "operator was narrated the result");
});
```

Before Change A exists, the harness `resolveActionByVoice` has no fallback (or the test imports a not-yet-written `selectPendingAction`) → **RED**. This is the test to watch fail first.

### Full assertion set (all in the new describe block)

1. **Single approve runs exactly once** (above): `ran === 1`, `has(id) === false`, narrated.
2. **Reject cancels, never runs** — `"reject"` and `"cancel that command"` both: `ran === 0`, `has(id) === false`, narrated "Cancelled". (Verifier correction: use `"reject"` or `"cancel that command"` — **bare `"cancel that"` parses to NONE** and must NOT resolve.)
3. **Exactly-once under a confirm race** — stage one action, call the voice approve, then call REST-equivalent `actions.confirm(id)` again: the second `confirm` returns `lost_race`, `ran` stays `1` (no double-run).
4. **Multi-pending clarify reads back SUMMARIES** — stage two actions (`"Create pane A …"`, `"Set global permissions to Full Auto"`), speak bare `"approve"` (no hint): the narration text **contains both `a.summary` fragments** and does NOT contain an empty/`undefined` terminalId. `ran === 0` (nothing resolved on an ambiguous multi-pending).
5. **Ordinal disambiguation** — two staged actions, `"approve the second one"` → only `actions[1]` confirmed, `actions[0]` still present.
6. **Precedence: approvals resolve BEFORE actions** — drive the *combined* path (extend `makeHarness` or compose both stores): one pending **approval** for the session AND one staged **action**; speak `"approve"`. The **approval** is resolved (its pane write lands / its store entry is gone) and the **action is untouched** (`actions.has(id) === true`, its `run` never called). This pins the `entries.length > 0`-first ordering.
7. **Parser regression guard (no relaxation)** — assert the existing table rows still hold after any optional `approvalIntent` edit: `"cancel"` → `"none"`, `"execute"` → `"none"`, `"send it"` → `"none"` (re-asserting `tokens.length > 2` guard intact). If `selectPendingAction` is extracted, add pure unit rows for it (single → `via:"only"`; ordinal `2` → second; fragment unique → that one; `>1` no-hint → `ambiguous`).

### Test files

- `tests/test_approvals_wse.ts` — **extend** (new `describe` block + a `resolveActionByVoice` harness fn; import `PendingActionStore` from `../src/pendingActions`).

---

## 4. Verify Commands

Run from the feature worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes`:

```bash
npm test                                   # unit suite (tsx --test --test-force-exit) — new U1 block must pass
npm run lint                               # tsc --noEmit — no type regressions from the fallback / optional helper
npm run build                              # vite + esbuild -> dist/server.cjs — server.ts still compiles
```

Optional (no behavior change expected, but cheap confidence): `npm run test:e2e` (Playwright `?mock=1`) to confirm the UI chip still clears on `action_resolved`. The python suite (`py -3 -m unittest tests.test_universal_terminal`) is unaffected by this backend-only change.

**TDD order:** write the failing test → run `npm test`, watch the U1 block go RED → apply Change A (+ optional B) → `npm test` GREEN → `npm run lint` → `npm run build`.

---

## 5. Risks

1. **`pendingActions` is GLOBAL, not session-scoped** (`server.ts:1328`). `pendingApprovals.forSession(session)` scopes by session; `pendingActions.all()` does not. In a single-live-session deployment (the norm here) this is fine, but in a hypothetical multi-session setup one session could voice-resolve another's staged action. Document with the inline comment (Change A) and the test comment (verifier-mandated). Out of scope to fix here.
2. **Precedence inversion** — if the fallback is wired as a sibling `if` instead of the `else` of `entries.length > 0`, a session with BOTH a pending approval and a staged action could resolve the wrong queue. Mitigation: the fallback MUST be the `else` branch; test #6 pins it.
3. **Double-resolution race (REST + voice)** — handled by the `claim()` seam, but only if the voice path treats `lost_race`/`not_found` exactly as REST does (no success narration, no pane re-broadcast). Mitigation: mirror the REST handler branches; test #3 pins exactly-once.
4. **Read-back leaking an empty `terminalId`** — actions have no meaningful pane id; reusing `selectApprovalTarget`'s instruction/pane read-back would narrate an empty/`undefined` pane. Mitigation: dedicated `selectPendingAction` reading back `a.summary`; test #4 pins it.
5. **`redactSecrets` import scope** — the narration/list uses `redactSecrets` (already imported and used throughout `server.ts`, e.g. line 1449); no new import. Confirm at edit time.
6. **Parser over-reach if `APPROVE_WEAK` is widened** — adding `"create"`/`"make"` would risk ambient over-approve and is explicitly out of scope; the single-pending bare-approve case is handled in the server, not the parser. Mitigation: test #7 guards `"cancel"`/`"execute"`/`"send it"` → `"none"`.

---

## 6. Acceptance Criteria

- [ ] Spoken **"approve"** (or "yes"/"confirm") with exactly **one** staged `create_pane` creates the pane **exactly once** (the deferred `run()` fires once; the action is removed; `action_resolved`/`outcome:"confirmed"` broadcast; operator narrated).
- [ ] Spoken **"reject"** (or **"cancel that command"**) cancels the staged action: no `run()`, action removed, `action_resolved`/`outcome:"cancelled"` broadcast, operator narrated. (Bare **"cancel that"** → no-op, by design.)
- [ ] **Precedence:** when a pending approval AND a staged action both exist for the session, a spoken "approve" resolves the **approval first**; the action is untouched.
- [ ] A REST+voice confirm race resolves **exactly once** (the loser hits `lost_race`, no double-`run`).
- [ ] Multi-pending ambiguity **reads back the action summaries** (not an empty pane id) and resolves nothing.
- [ ] `npm test`, `npm run lint`, and `npm run build` are all **green**; no existing parser/approval test regresses (the `tokens.length > 2` weak-verb guard is intact).

---

## 7. Next Session (copy/paste)

> Implement bead `wsm-e2e-pinned-9fe` (U1) per `docs/process/session-fixes/U1-plan.md` in worktree `OrbitalVoiceRunner-wt/session-fixes`. TDD: add the failing `describe("U1 …")` block to `tests/test_approvals_wse.ts` (single-approve-runs-once), watch it RED, then add the `pendingActions` fallback as the `else` of the `entries.length > 0` gate at `server.ts:1861-1882`, mirroring the REST handlers at `server.ts:1560-1580`. Keep `pendingApprovals` precedence FIRST. Verify `npm test`/`npm run lint`/`npm run build`.
