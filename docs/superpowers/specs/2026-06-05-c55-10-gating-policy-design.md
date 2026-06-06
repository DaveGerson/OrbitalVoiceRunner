# c55.10 — Gating Policy for the 7 "ALWAYS_ALLOWED-during-cutover" defs

**Status:** DESIGN (ready to implement, zero prior context required)
**Date:** 2026-06-05
**Worktree:** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/c55-10-gates`
**Author track:** c55 REST→registry "contract convergence"

---

## BLUF

Seven rest-only ActionDefs were registered `capability: "ALWAYS_ALLOWED"` during the REST→registry
cutover purely to preserve the prior **ungated inline** behavior. We now assign each its REAL gate.
Net effect: **4 defs become GATED** (`send_keys`, `add_watch_rule`, `remove_watch_rule`,
`delete_orchestrator_plan`), **3 stay ungated** (`resize_pane`, `clear_exited`, `clear_history`).

Because the matrix is **cross-pinned across 7 hand-lists** and the catalog is **generated**, the
mechanical cost is the c55.14 additive golden-update discipline: add **3 NEW capability ids**
(`send_keys`, `remove_watch_rule`, `delete_orchestrator_plan`) in lockstep across all pinned sources,
reuse the **existing** `add_watch_rule` matrix row, and rewire 4 handlers to call `ctx.gateOrDefer(...)`.
The 8.1b invariants stay intact: `deriveCapabilities(REGISTRY) ⊆ ALL_CAPABILITIES` (still a subset)
and `ALL_CAPABILITIES === CAPABILITY_DEFS id-set` (preserved because every add lands in BOTH).

---

## 0. Grounding — the actual mechanics (read this first; the task brief's framing is imprecise)

The task brief says "seven capabilities shipped with `defaultGate ALWAYS_ALLOWED`… this task changes
`defaultGate` VALUES… all seven already EXIST as capability ids." **That is not how the code works.**
Verified against the worktree:

1. **There is no `defaultGate` on an ActionDef.** An `ActionDef` (`src/actions/types.ts:370`) carries a
   `capability: Capability | "ALWAYS_ALLOWED"` field. `"ALWAYS_ALLOWED"` is the **sentinel** meaning
   "no matrix row, never gated." `defaultGate` is a field on a **`CapabilityDef`** row
   (`src/actions/capabilities.ts` `CAPABILITY_DEFS`), a *separate* table.

2. **Changing a def's `capability` string is necessary but NOT sufficient to gate it.** `runAction` is
   **handler-owned** (`tests/test_action_registry.ts` §8.3, lines 414–423: "runAction itself applies NO
   gate"). A def is only actually gated when its **handler calls `ctx.gateOrDefer(capability, …)`** and
   branches on the disposition. The canonical template is `respawn_pane`
   (`src/actions/defs/panes_rest.ts:189–206`) and the c55.14 `delete_pane`/`delete_project`
   (`src/actions/defs/lifecycle_rest.ts:87–91, 120–123`).

3. **The "all seven already exist as cap ids" claim is FALSE.** Of the seven, only **two** are matrix
   rows today: `add_watch_rule` (`CAPABILITY_DEFS` line 85, `defaultGate:"Ask"`) and `clear_history`
   (line 72, `defaultGate:"Ask"`). The other five (`send_keys`, `resize_pane`, `clear_exited`,
   `remove_watch_rule`, `delete_orchestrator_plan`) are **NOT** in the `CapabilityGate` union, **NOT**
   in `CAPABILITY_DEFS`, **NOT** in `ALL_CAPABILITIES`. So gating `send_keys`, `remove_watch_rule`,
   `delete_orchestrator_plan` **requires ADDING new cap ids** — exactly the c55.14 additive move.

### The legal gate VALUES (the `CapabilityGate` matrix vs. the `GateValue` per-cap policy)

Two unions are easy to conflate; both are in `src/types.ts`:

- **`CapabilityGate`** (`src/types.ts:13–22`) — the **matrix ROW identifiers** (24 today): `write_to_pane`,
  `deliver_handoff`, `create_pane`, `close_pane`, `delete_pane`, `delete_project`, `restart_pane`,
  `set_pane_permissions`, `set_global_permissions`, `set_capability_gate`, `add_watch_rule`,
  `execute_plan`, `apply_recipe`, `create_project`, `update_metadata`, `switch_context`, `set_voice_mute`,
  `dismiss_attention`, `read_pane`, `read_notes`, `focus_pane`, `compose_draft`, `archive_pane`,
  `clear_history`. A def's `capability` field must be one of these **or** the `"ALWAYS_ALLOWED"` sentinel.
- **`GateValue`** (`src/types.ts:24`) — the per-cap **policy values**: **`"Auto" | "Ask" | "Off"`**. This is
  the `defaultGate` on a `CapabilityDef` row. The legal values are exactly these three.

So "pick the exact gate value" = (a) decide the def's **`capability` row** (a `CapabilityGate` id or the
sentinel), and (b) for a real row, decide its **`defaultGate`** (`Auto`/`Ask`/`Off`). For all four caps
we gate, the chosen `defaultGate` is **`Ask`** (mirrors every other Destructive/Spawning cap and the
c55.14 deletes; `Off` would break the legitimate operator-UI path, `Auto` would be no different from
today's ungated state at the matrix level but with HiTL plumbing available to tighten per-pane).

### The 8.1b invariants (what we must NOT break)

`tests/test_action_registry.ts` §8.1b (lines 205–221) pins TWO things:
- **SUBSET:** `deriveCapabilities(REGISTRY) ⊆ ALL_CAPABILITIES` — every cap a def *uses* is a matrix row.
- **EQUALITY:** `ALL_CAPABILITIES === CAPABILITY_DEFS id-set` — the gateSurface hand-list equals the
  capabilities table (kept a hand-list to dodge a value-import cycle; see `gateSurface.ts:30–39`).

Adding a new cap id and *wiring a def to it* keeps the SUBSET true (the def now uses a row that exists)
and keeps EQUALITY true **iff** we add the id to BOTH `ALL_CAPABILITIES` and `CAPABILITY_DEFS`. Reusing
the already-present `add_watch_rule` row touches neither invariant. This is **gate-tightening only**
(`ALWAYS_ALLOWED → Ask`), strictly more restrictive — no behavior loosens.

---

## 1. Per-capability decision table

| Cap (def file) | Today | P2 class | Decision | `capability` row | `defaultGate` | New cap id? | Voice exposure |
|---|---|---|---|---|---|---|---|
| **send_keys** (`panes_rest.ts:225`) | `ALWAYS_ALLOWED` | **Consequential CLI keystroke act** | **GATE** | `send_keys` (NEW) | **Ask** | **YES** | No (stays rest-only) |
| **resize_pane** (`panes_rest.ts:265`) | `ALWAYS_ALLOWED` | Resize plumbing (Janus-of-Janus) | **STAYS UNGATED** | `ALWAYS_ALLOWED` | n/a | No | No |
| **clear_history** (`panes_rest.ts:299`) | `ALWAYS_ALLOWED` | Display-buffer clear (no live result loss) | **STAYS UNGATED** | `ALWAYS_ALLOWED` | No | No |
| **clear_exited** (`panes_rest.ts:325`) | `ALWAYS_ALLOWED` | Manage plumbing (reversible archive) | **STAYS UNGATED** | `ALWAYS_ALLOWED` | No | No |
| **add_watch_rule** (`watch_rules.ts:104`) | `ALWAYS_ALLOWED` | Automation/safety-config change | **GATE** | `add_watch_rule` (**EXISTS**) | Ask (already) | No (reuse) | No |
| **remove_watch_rule** (`watch_rules.ts:145`) | `ALWAYS_ALLOWED` | Automation/safety-config change | **GATE** | `remove_watch_rule` (NEW) | **Ask** | **YES** | No (stays rest-only) |
| **delete_orchestrator_plan** (`watch_rules.ts:182`) | `ALWAYS_ALLOWED` | Destructive (deletes a plan) | **GATE** | `delete_orchestrator_plan` (NEW) | **Ask** | **YES** | No (stays rest-only) |

### Justification (against the P2 taxonomy in `inlineExceptions.ts:12–19`)

- **send_keys → GATE (Ask).** This is `term.writeInput(command)` straight to the live PTY
  (`panes_rest.ts:240–241`) — a **consequential CLI keystroke act**, the most direct write into a
  pane there is. Leaving it ungated means any REST caller (or a future voice surface) types into the
  terminal with zero checkpoint. It is the rest-only twin of the gated voice write path
  (`propose_command` → `write_to_pane`). We give it its **own** `send_keys` row (rather than reuse
  `write_to_pane`) so the operator can tune the raw-REST keystroke channel independently of the voice
  composer's HiTL — and so the existing `write_to_pane` spotlight semantics aren't silently extended to
  a non-voice path. Default **Ask**.
- **resize_pane → UNGATED.** Pure viewport plumbing (`manager.resize`, `panes_rest.ts:280`). "Janus
  doing the work of Janus" — arranging the display. No CLI act, no result read, no safety change. Stays
  `ALWAYS_ALLOWED`.
- **clear_history → UNGATED.** Clears the **recorded command-history buffer** (`saveHistory(ctx, id, [])`,
  `panes_rest.ts:308`), the `.janus_history.json` list — **not** live pane output and **not** a CLI act.
  The P2 line that's GATED is "reading terminal RESULTS" (privacy + context-window); clearing a local
  metadata list is neither a read nor a consequential act, and it is operator-initiated UI plumbing.
  **NOTE the asymmetry we are deliberately accepting:** a `clear_history` matrix row ALREADY exists with
  `defaultGate:"Ask"` (`CAPABILITY_DEFS:72`) — but that row is **reserved** (no def is wired to it; it is
  a future voice-tool target). The c55 safe-default policy ("preserve current behavior") and the
  display-buffer-vs-result-loss reasoning both say: keep the *rest-only def* `ALWAYS_ALLOWED`. The
  matrix row stays as-is, unwired (it shows in the catalog's "Capabilities without actions" appendix).
  If the director later wants the REST clear gated, flip this one def to `capability:"clear_history"` +
  `gateOrDefer` — no new cap id needed. We are NOT doing that now.
- **clear_exited → UNGATED.** Archives **already-exited** panes (`archiveExitedPanes`,
  `panes_rest.ts:344`) — explicitly **recoverable, not a hard delete** (the def's own description). Manage
  plumbing, reversible. (Conceptually adjacent to the existing `archive_pane` cap, `defaultGate:"Auto"` —
  i.e. even if we *did* gate it, Auto is the established default for archiving. Ungated is the
  behavior-preserving choice; stays `ALWAYS_ALLOWED`.)
- **add_watch_rule → GATE (Ask), reuse existing row.** Creating an autonomous rule that fires a command
  on a pane transition (`watch_rules.ts:112–127`) is a **safety-config / automation change** — it costs
  compute and acts unprompted later. The matrix row `add_watch_rule` already exists (`defaultGate:"Ask"`)
  and the bead note confirms its "Ask row exists but is reserved." This task **un-reserves** it: wire the
  def to it. No new cap id, no golden churn beyond the catalog re-bucketing.
- **remove_watch_rule → GATE (Ask), NEW row.** Deleting an automation rule
  (`watch_rules.ts:153–163`) is the mirror safety-config change to `add_watch_rule`; symmetry says it gets
  the same treatment. No row exists today → add `remove_watch_rule`. Default **Ask**.
- **delete_orchestrator_plan → GATE (Ask), NEW row.** Permanently removes a multi-step plan from the
  board (`watch_rules.ts:190–200`) — **destructive**. Mirrors c55.14's decision to gate the inline
  deletes (`delete_pane`/`delete_project`). No row exists → add `delete_orchestrator_plan`. Default
  **Ask**.

### Voice exposure (P1 — commandability is a SEPARATE dial from proactivity)

All four gated defs **stay rest-only** (`surfaces: new Set(["rest"])` unchanged). Per P1
(`inlineExceptions.ts:13–15`), `surfaces[]` makes an action **commandable**; the Auto/Ask/Off matrix
**alone** governs unprompted proactivity. Adding a gate does **not** require adding a voice surface, and
adding a voice surface would cost extra Gemini tool-description budget for no current product need. A
voice yes/no twin for `remove_watch_rule` / `delete_orchestrator_plan` remains **DEFERRED** (the existing
`coverage.ts:143–151` comment already says so). **We change gating only; we do not touch `surfaces`.**
Consequence: `INTENTIONAL_ASYMMETRY` in `coverage.ts` is **unaffected** (these stay rest-only and are
already allow-listed there).

---

## 2. Exact edit list

> Mirror the c55.14 additive discipline verbatim (reference commit `412ae94` "add delete_pane +
> delete_project capabilities"). For **each NEW cap id** (`send_keys`, `remove_watch_rule`,
> `delete_orchestrator_plan`) the id must be added to **7 places**, all in lockstep. `add_watch_rule`
> reuses its existing row, so it touches **none** of the matrix sources — only its def + the catalog.

### A. The def rewires (the only *behavior* change)

**`src/actions/defs/panes_rest.ts` — `send_keys` (lines 225–245).**
- Change `capability: "ALWAYS_ALLOWED"` → `capability: "send_keys"`.
- Rewrite the handler to gate on `ctx.gateOrDefer("send_keys", id, …)`, mirroring `respawn_pane`
  (`panes_rest.ts:189–206`): resolve the unknown-pane 200 ok-narration BEFORE the gate; wrap the
  `addCommand` + `term.writeInput(command)` + `broadcastLedgerUpdate()` side effects in a synchronous
  `sendEffect` closure; `forbidden → {kind:"blocked", reason:"…'send_keys'…gated Off…"}`;
  `deferred → {kind:"pending", messageId:g.actionId, summary:g.summary}`; `run → {kind:"ok",
  output: sendEffect()}`. Pass durable params `{ ...(ctx.versionStamp ?? {}), origin:"rest", paneId:id }`.
- Update the section header comment (line 210) + the file header GATING block (lines 26–29).

**`src/actions/defs/watch_rules.ts` — `add_watch_rule` (lines 104–128).**
- Change `capability: "ALWAYS_ALLOWED"` → `capability: "add_watch_rule"`.
- Wrap the rule-create + `push` + `save(true)` + `broadcast(watch_rules_updated)` in an `addEffect`
  closure; gate via `ctx.gateOrDefer("add_watch_rule", args.triggerTerminalId, "Add watch rule …",
  addEffect, { ...(ctx.versionStamp ?? {}), origin:"rest" })`. Same 3-arm branch. (paneId arg: the
  trigger terminal id is the natural scope; `null` is also acceptable since the rule spans two panes.)
- Update header comment lines 21–24 + section comment line 80.

**`src/actions/defs/watch_rules.ts` — `remove_watch_rule` (lines 145–164).**
- `capability: "ALWAYS_ALLOWED"` → `capability: "remove_watch_rule"`.
- KEEP the unknown-id → 200 ok-narration resolved **before** the gate (no stage/forbid of a no-op).
  Wrap the `splice` + `save(true)` + broadcast in a `removeEffect` closure; gate via
  `ctx.gateOrDefer("remove_watch_rule", null, "Remove watch rule …", removeEffect, …)`. 3-arm branch.
- Update header comment line 25 + section comment line 131.

**`src/actions/defs/watch_rules.ts` — `delete_orchestrator_plan` (lines 182–200).**
- `capability: "ALWAYS_ALLOWED"` → `capability: "delete_orchestrator_plan"`.
- KEEP unknown-id → 200 ok-narration **before** the gate. Wrap `splice` + `save(true)` + broadcast in a
  `deleteEffect` closure; gate via `ctx.gateOrDefer("delete_orchestrator_plan", null, "Delete plan …",
  deleteEffect, …)`. 3-arm branch.
- Update header comment line 27 + section comment line 166.

> `resize_pane`, `clear_history`, `clear_exited` — **NO edit.** They stay `ALWAYS_ALLOWED`. (Optionally
> tighten the stale "flagged for later tightening" comment on `clear_history` at `panes_rest.ts:27–29`
> to record the c55.10 decision that the *rest def* stays ungated while the matrix row stays reserved.)

### B. The matrix cross-pins — add 3 NEW cap ids (`send_keys`, `remove_watch_rule`, `delete_orchestrator_plan`)

For each of the three new ids, add it to ALL of the following (alphabetical-ish placement matters only
for the golden sorts; the lists are order-stable but membership is what's asserted):

1. **`src/types.ts` `CapabilityGate` union (lines 13–22).** Add the 3 string-literal members. Suggested:
   extend the line with the existing "spawning/safety" siblings, e.g. add a new line
   `| "send_keys" | "remove_watch_rule" | "delete_orchestrator_plan"`. Also bump the "24"-count
   comment at lines 8–12 to **27**.
2. **`src/types.ts` `DEFAULT_CAPABILITY_GATES` (lines 42–61).** Add `send_keys: "Ask"`,
   `remove_watch_rule: "Ask"`, `delete_orchestrator_plan: "Ask"`. (`add_watch_rule:"Ask"` is already
   present at line 53 — leave it.)
3. **`src/gateSurface.ts` `ALL_CAPABILITIES` (lines 41–51).** Add the 3 ids. Bump the "24"-count
   comments (lines 31–39) to **27**.
4. **`src/gateSurface.ts` `CAPABILITY_LABELS` (lines 189–216).** Add plain-language, **no-underscore**
   labels (a §6 test asserts no raw identifier token): e.g.
   `send_keys: "Send keystrokes to a pane"`, `remove_watch_rule: "Remove an automation rule"`,
   `delete_orchestrator_plan: "Delete an orchestrator plan"`.
5. **`src/gateSurface.ts` `CAPABILITY_CATEGORIES` (lines 228–235).** Add `send_keys` to **"Acting in a
   pane"**; `add_watch_rule` is already in **"Spawning work"** — add `remove_watch_rule` there too;
   add `delete_orchestrator_plan` to **"Destructive"**. (Each cap appears in EXACTLY one category — a
   §6 test asserts this.)
6. **`src/actions/capabilities.ts` `CATEGORY` map (lines 24–55).** Add `send_keys: "Acting in a pane"`,
   `remove_watch_rule: "Spawning work"`, `delete_orchestrator_plan: "Destructive"`. **Keep these in
   lockstep with `CAPABILITY_CATEGORIES` above** (they are two copies of the same grouping).
7. **`src/actions/capabilities.ts` `CAPABILITY_DEFS` array (lines 64–93).** Add 3 rows:
   `{ id: "send_keys", label: CAPABILITY_LABELS.send_keys, category: CATEGORY.send_keys, defaultGate: "Ask" }`,
   and likewise for `remove_watch_rule` and `delete_orchestrator_plan` (all `defaultGate:"Ask"`).

### C. The harness + test goldens (must move in lockstep, c55.14 pattern)

8. **`src/e2e/harness.ts` `DEFAULT_MOCK_GATES` (lines 212–231).** Add `send_keys: "Ask"`,
   `remove_watch_rule: "Ask"`, `delete_orchestrator_plan: "Ask"`. (This map is a `CapabilityGateMap`,
   `Partial<Record<CapabilityGate, GateValue>>`, so it's not *required* to be total — but c55.14 added the
   new caps here, and several chip/posture fixtures expect the gated caps present. Add them for parity.)
9. **`tests/test_action_registry.ts` §8.1b `golden` map (lines 241–268).** Add `send_keys: "Ask"`,
   `remove_watch_rule: "Ask"`, `delete_orchestrator_plan: "Ask"`. This is **mandatory**: the test at
   lines 272–275 asserts EVERY `CapabilityDef` has a pinned golden, so a new cap with no golden entry
   fails the build. (`add_watch_rule` is already pinned at line 260.)
10. **`tests/test_gate_surface.ts` local `ALL_CAPABILITIES` (lines 28–37).** Add the 3 ids (this is an
    independent hand-copy of the union used for totality assertions).
11. **`tests/test_gate_surface.ts` `expected` category golden (lines 187–194).** Mirror edit B-5:
    `send_keys` into "Acting in a pane"; `remove_watch_rule` into "Spawning work";
    `delete_orchestrator_plan` into "Destructive".
12. **`tests/fixtures/voice-tool-goldens.json`.** Regenerate (do **not** hand-edit). The voice reads
    `list_capabilities` + `get_pane_gates` enumerate the WHOLE matrix, so the 3 new ids appear in the
    `effective_gates` map + the cap-list golden even though the new defs are rest-only. Regenerate via
    `JANUS_GOLDEN_REWRITE=1` (the env var c55.14 used in commit `8bed5b1`) and inspect the diff is
    additive-only (3 new `"…": "Ask"` entries + 3 new list members).
13. **Stale "22→24" / "24"-count comments.** c55.14 had dedicated commits (`8f27841`, `e1e07e7`,
    `1fcf4c9`) to bump count comments. Grep for `22->24`, `24-row`, `24 caps`, `all 24`, `the 24`,
    `24)` in `src/`, `tests/`, and bump to **27** wherever the count is stated. Known sites:
    `src/types.ts:8–12`, `src/gateSurface.ts:31–39, 162–164, 220–227`,
    `tests/test_action_registry.ts:206`, `tests/test_gate_surface.ts:26–27, 163`. (Cosmetic but the
    c55.14 reviewer flagged them — do it to keep the convergence ledger honest.)

### D. The generated catalog — WILL MOVE; regenerate

14. **`docs/CAPABILITIES.md`.** **Regenerate with `npm run catalog`** (CI runs `CATALOG_CHECK=1` as a
    no-drift gate, `scripts/catalog.ts:198–222`). It moves because (a) the 4 newly-gated defs leave the
    "Always allowed (emergency brake)" group and appear under their own capability sections;
    (b) 3 new wired-capability sections appear (`send_keys`, `remove_watch_rule`,
    `delete_orchestrator_plan`); (c) `add_watch_rule` migrates from the "Capabilities without actions
    (matrix-only)" appendix into a real wired section (a def is now bound to it); (d) the header counts
    `**N** actions across **M** gated capabilities` change (M += 4: the 3 new + add_watch_rule).

### E. What does NOT change (state explicitly so the implementer doesn't over-edit)

- **`src/actions/registry.ts`** — unchanged. We mutate existing def objects in place; the slice spreads
  (`...PANES_REST_ACTIONS`, `...WATCH_RULES_ACTIONS`) already include them.
- **`src/actions/coverage.ts` `INTENTIONAL_ASYMMETRY`** — unchanged. `surfaces` stay rest-only; the
  defs are already allow-listed (lines 92, 148–151).
- **`src/actions/inlineExceptions.ts`** — unchanged. No inline routes are added/removed; the no-twin
  guard (`tests/test_no_inline_twins.ts`) is route-membership, not gating. (No `server.ts` route edit.)
- **`resize_pane` / `clear_history` / `clear_exited` defs** — unchanged (stay `ALWAYS_ALLOWED`).
- **The `clear_history` matrix row** (`CAPABILITY_DEFS:72`, `defaultGate:"Ask"`) — unchanged; it stays
  reserved/unwired (catalog appendix). We do NOT wire the rest def to it.

---

## 3. Bite-sized TDD implementation plan

> Order matters: add the cap ids + goldens FIRST (compile + 8.1b green with the new rows present but
> unused as a strict-subset is fine), then flip the def handlers, then regenerate the generated artifacts.
> Run `npm run lint` (tsc) after every structural step — a missing `CapabilityGate` member is a compile
> error the moment a `Record<CapabilityGate,…>` is built.

1. **RED (write the gate-behavior tests first).** In a new `tests/test_c55_10_gating.ts` (mirror
   `tests/test_c55_14_lifecycle.ts`), assert via `runAction` + a stub ctx (copy `makeCtx` from
   `test_action_registry.ts`): for each of `send_keys`, `add_watch_rule`, `remove_watch_rule`,
   `delete_orchestrator_plan`: (a) `disposition:"run"` → `kind:"ok"` and the side effect happened;
   (b) `disposition:"deferred"` → `kind:"pending"`, `messageId` threaded, side effect NOT run;
   (c) `disposition:"forbidden"` → `kind:"blocked"`. Also assert the gateOrDefer **capability arg** equals
   the new id and `params` carries `{origin:"rest", …}`. Run — these FAIL (defs still ungated).
2. **Add the 3 new cap ids to the matrix sources (edits B-1…B-7).** `CapabilityGate` union,
   `DEFAULT_CAPABILITY_GATES`, `ALL_CAPABILITIES`, `CAPABILITY_LABELS`, `CAPABILITY_CATEGORIES`,
   `capabilities.CATEGORY`, `CAPABILITY_DEFS`. Run `npm run lint` → green.
3. **Add the test goldens (edits C-9, C-10, C-11) + harness (C-8).** Run
   `npx tsx --test --test-force-exit tests/test_gate_surface.ts tests/test_action_registry.ts` → the
   8.1b equality + golden + category totality + label totality tests pass with the 3 new rows.
4. **Flip the 4 def handlers (edits A).** `send_keys`, `add_watch_rule`, `remove_watch_rule`,
   `delete_orchestrator_plan`: change `capability` + wrap side effects in an effect closure + call
   `ctx.gateOrDefer` + 3-arm branch (copy `respawn_pane` / `delete_pane` verbatim in shape). Run the new
   `tests/test_c55_10_gating.ts` → GREEN.
5. **Regenerate goldens fixture (edit C-12).** `JANUS_GOLDEN_REWRITE=1 npx tsx --test
   tests/test_gate_surface.ts` (or whichever test owns the fixture — grep `voice-tool-goldens` to find
   the writer). Inspect the diff is additive-only (3 `"…":"Ask"` + 3 list members). Re-run without the
   env var → GREEN.
6. **Regenerate the catalog (edit D-14).** `npm run catalog`. Then `CATALOG_CHECK=1 npm run catalog`
   (or `npx tsx scripts/catalog.ts --check`) → exit 0. Confirm `add_watch_rule` left the appendix and 3
   new sections exist.
7. **Bump stale count comments (edit C-13).** Grep `24` count sites, set to 27.
8. **Full battery.** `npm run lint` (tsc --noEmit), `npm test` (`tsx --test --test-force-exit`),
   `npm run build`. The no-twin guard (`test_no_inline_twins`) and asymmetry guard
   (`unexpectedAsymmetries`) must stay green (we touched neither routes nor surfaces). Confirm 8.1b:
   `deriveCapabilities(REGISTRY) ⊆ ALL_CAPABILITIES` (still subset — `clear_history` + the unwired rows
   keep it a proper subset) and `ALL_CAPABILITIES === CAPABILITY_DEFS id-set` (equal — we added each id
   to both).

---

## 4. Risks & mitigations

- **8.1b equality drift (HIGH if rushed).** Adding a cap id to `CAPABILITY_DEFS` but missing
  `ALL_CAPABILITIES` (or vice-versa) instantly fails the §8.1b equality assertion. *Mitigation:* the
  7-place checklist in §2.B; the equality test (`test_action_registry.ts:218–220`) is the backstop.
- **Missing golden pin (HIGH).** A new `CapabilityDef` with no entry in the §8.1b `golden` map fails
  `test_action_registry.ts:272–275`. *Mitigation:* edit C-9 is mandatory and listed first in the golden
  set.
- **Label still contains an underscore (MEDIUM).** `CAPABILITY_LABELS`/category names are asserted to
  contain no `_` (`test_gate_surface.ts:152, 180`). *Mitigation:* use the plain-language labels in §2.B-4
  ("Send keystrokes to a pane", etc.), never the raw id.
- **`gateOrDefer` Auto contract (MEDIUM).** On `disposition:"run"`, `gateOrDefer` does NOT invoke `run`
  itself (it stages `run` only on Ask) — the handler must call the effect (`output: sendEffect()`). This
  is the exact `respawn_pane`/`delete_pane` pattern (`panes_rest.ts:203–205`); copy it, don't improvise.
- **Durable Ask-replay limitation (LOW, accepted).** Like `respawn_pane` (`panes_rest.ts:22–25`), an
  Ask→confirm AFTER a process restart degrades to a no-op string because `buildActionRun`
  (`src/actionEffects.ts`) has no case for these new caps. In-process Ask→confirm replays correctly
  (pendingActions holds the live closure). Durable cross-restart replay for these rest-only caps is OUT
  OF SCOPE (matches the c55 batch precedent). *Mitigation:* pass `ctx.versionStamp` in params (so a
  drifted intent quarantines) and document the limitation in the def header.
- **Stale count comments (LOW, cosmetic).** "24-row matrix" comments become wrong → confusing, not
  failing. *Mitigation:* edit C-13.
- **`clear_history` reserved-row confusion (LOW).** A reviewer may expect the existing `clear_history`
  matrix row to get wired since a def with that *name* exists. *Mitigation:* §1 + §2.E explicitly record
  that the rest def stays `ALWAYS_ALLOWED` and the row stays reserved — deliberate, not an oversight.
- **Catalog drift gate (LOW).** Forgetting `npm run catalog` fails CI (`CATALOG_CHECK=1`). *Mitigation:*
  step 6. The guard normalizes CRLF→LF so Windows won't false-fail.

---

## Appendix — file:line citations (all verified by Read against the worktree)

- `src/actions/types.ts:370–400` (ActionDef incl. `capability` field), `:403` (ALWAYS_ALLOWED sentinel).
- `src/types.ts:13–22` (CapabilityGate union, 24 rows), `:24` (GateValue), `:42–61` (DEFAULT_CAPABILITY_GATES).
- `src/gateSurface.ts:41–51` (ALL_CAPABILITIES), `:189–216` (CAPABILITY_LABELS), `:228–235` (CAPABILITY_CATEGORIES).
- `src/actions/capabilities.ts:24–55` (CATEGORY), `:64–93` (CAPABILITY_DEFS; clear_history@72, add_watch_rule@85), `:106–116` (deriveCapabilities).
- `src/actions/defs/panes_rest.ts:189–206` (respawn_pane gate template), `:225–245` (send_keys), `:265–283` (resize_pane), `:299–311` (clear_history), `:325–349` (clear_exited).
- `src/actions/defs/watch_rules.ts:104–128` (add_watch_rule), `:145–164` (remove_watch_rule), `:182–201` (delete_orchestrator_plan).
- `src/actions/defs/lifecycle_rest.ts:59–125` (c55.14 delete_project/delete_pane gate pattern).
- `src/e2e/harness.ts:212–231` (DEFAULT_MOCK_GATES).
- `tests/test_action_registry.ts:205–221` (8.1b subset+equality), `:239–276` (defaultGate golden + "every def pinned").
- `tests/test_gate_surface.ts:28–37` (local ALL_CAPABILITIES), `:145–200` (label/category totality goldens).
- `src/actions/coverage.ts:88–96, 143–151` (rest-only asymmetry allow-list for these defs).
- `scripts/catalog.ts:90–192` (catalog render; buckets by `action.capability`, unwired appendix).
- Reference commits: `412ae94` (cap-add 7-place edit), `8bed5b1` (voice-tool-goldens regen), `6a6a8de` (catalog regen).

---

## Adversarial review (c55-closeout workflow)

**Verdict: sound-with-fixes.** Every load-bearing claim was re-read against the worktree and checks out. The design's central correction over the task brief is CORRECT and important: (1) `ActionDef` has no `defaultGate` field (`src/actions/types.ts:374` carries `capability: Capability | "ALWAYS_ALLOWED"`); (2) `Capability` is an open `string` (`types.ts:33`) while the closed union to extend is `CapabilityGate` in `src/types.ts:13-22`; (3) gating requires the HANDLER to call `ctx.gateOrDefer` and branch — `runAction` applies NO central gate, proven by `tests/test_action_registry.ts:414-423`. The brief's "all seven already exist as cap ids / just change defaultGate values" framing is FALSE: only `add_watch_rule` (`capabilities.ts:85`) and `clear_history` (`capabilities.ts:72`) are matrix rows today; `send_keys`/`resize_pane`/`clear_exited`/`remove_watch_rule`/`delete_orchestrator_plan` are NOT in `CapabilityGate`, `ALL_CAPABILITIES`, or `CAPABILITY_DEFS`.

### Required fixes (all applied in the implementation commit `2cbb55b`)

1. **Surface the default-Ask UX consequence explicitly in the design before implementing.** Because `send_keys`/`add_watch_rule`/`remove_watch_rule`/`delete_orchestrator_plan` are NOT spotlight-eligible, the DEFAULT (off-context) REST result becomes `202` deferred, and the React handlers `handleDeleteWatchRule`/`handleDeletePlan`/`handleCreateWatchRule` (App.tsx:783-804,763-781) and `handleExecuteBroadcast` (App.tsx:850-874) do not branch on `res.ok` / 202 — so the operator gets a success earcon + an unchanged list and no indication the action is pending. Either (i) get explicit director sign-off that "silent defer with no client surface" is acceptable for these operator-UI buttons, or (ii) add a follow-up bead to teach those handlers to surface the 202 pending state. **This is the single load-bearing product decision and must not be buried.**

2. **Add an explicit gate-behavior assertion to the new `tests/test_c55_10_gating.ts` for the 200-vs-202 default.** Confirm that with the global default gate (Ask) and no spotlight, the 4 defs return `kind:'pending'` → 202 (the new default), and only return `kind:'ok'` → 200 when the gate resolves Auto. The c55.14 suite proves status-via-kinds per disposition but the implementer must pin that the EFFECTIVE default for these specific non-spotlight caps is the deferred path, so a future spotlight-eligibility regression is caught.

3. **Mandatory (build-breaking if skipped, in this order):** for EACH of `send_keys`, `remove_watch_rule`, `delete_orchestrator_plan` add the id to ALL of: `src/types.ts` `CapabilityGate` union (13-22) AND `DEFAULT_CAPABILITY_GATES` is optional-but-recommended; `src/gateSurface.ts` `ALL_CAPABILITIES` (41-51), `CAPABILITY_LABELS` (189-216, plain-language NO underscore — `test_gate_surface.ts:152` asserts `!/_/`), `CAPABILITY_CATEGORIES` (228-235, exactly one category — `test_gate_surface.ts:166-176`); `src/actions/capabilities.ts` `CATEGORY` (24-55) and `CAPABILITY_DEFS` (64-93, `defaultGate:'Ask'`); the §8.1b golden map (`test_action_registry.ts:241-268` — MANDATORY, lines 273-275 fail the build if any CapabilityDef lacks a golden pin); `test_gate_surface.ts` local `ALL_CAPABILITIES` (28-37) and expected category golden (187-194). `add_watch_rule` reuses its existing row — touch ONLY its def + catalog.

4. **Flip the 4 def handlers to the verified gate template:** resolve unknown-pane/unknown-id to ok-narration BEFORE the gate; wrap side effects in a synchronous effect closure returning the narration string (`GateOrDefer.run` is `() => string`, `types.ts:83-90`); call `ctx.gateOrDefer(<newCap>, paneId|null, summary, effect, {...(ctx.versionStamp ?? {}), origin:'rest', paneId?})`; 3-arm branch `forbidden->{kind:'blocked'}` / `deferred->{kind:'pending',messageId:g.actionId,summary:g.summary}` / `run->{kind:'ok',output:effect()}`. The Auto/run arm MUST call `effect()` itself — `gateOrDefer` does NOT invoke run on the run disposition (proven by the `makeCtx` stub at `test_c55_14_lifecycle.ts:115-120` and the `respawn_pane` comment at `panes_rest.ts:203-205`). For `add_watch_rule` pass `paneId=args.triggerTerminalId` (it exists, `watch_rules.ts:115`); for `remove_watch_rule`/`delete_orchestrator_plan` pass `null`.

5. **Regenerate (do NOT hand-edit) the generated artifacts and run the no-drift gate:** `npm run catalog` then `CATALOG_CHECK=1 npm run catalog` → exit 0 (`scripts/catalog.ts:198-200`). Confirm `add_watch_rule` leaves the "Capabilities without actions (matrix-only)" appendix (`catalog.ts:175`), the 4 newly-gated defs leave the "Always allowed (emergency brake)" group (`catalog.ts:144`), 3 new wired sections appear, and the header `**N** actions across **M** gated capabilities` (`catalog.ts:135`) increments M by 4. Also regenerate `tests/fixtures/voice-tool-goldens.json` via its writer (grep the env-var rewrite flag in the test that owns it — do NOT assume `JANUS_GOLDEN_REWRITE` without confirming) and verify the diff is additive-only.

6. **Run the full battery to confirm no invariant drift:** `npm run lint` (`tsc --noEmit` — a missing `CapabilityGate` member breaks any `Record<CapabilityGate,...>` at compile time), `npm test` (must include `test_action_registry.ts` §8.1b equality+subset+golden, `test_gate_surface.ts` label/category totality, `test_no_inline_twins`, and the asymmetry guard), and `npm run build`. Note the CLAUDE.md gotcha: tests need `--test-force-exit`.

### Issues / verified findings

- **(a) P2 + 8.1b invariants: PASS.** Adding `send_keys`/`remove_watch_rule`/`delete_orchestrator_plan` to BOTH `gateSurface.ts` `ALL_CAPABILITIES` and `capabilities.ts` `CAPABILITY_DEFS` preserves the EQUALITY invariant (`test_action_registry.ts:218-220` deep-equals the two sorted id-sets); wiring the 4 defs to existing rows preserves the SUBSET invariant (lines 214-217). P2 taxonomy classification is defensible: `send_keys` is `term.writeInput` to the live PTY (`panes_rest.ts:241`) = consequential write → GATE; `resize`/`clear_history`/`clear_exited` = plumbing → ungated; watch-rule add/remove + plan-delete = safety-config/destructive → GATE.
- **(b) HTTP contract: PASS at shape level, but a real SEMANTIC shift the doc under-emphasizes.** `resultToHttp` (`src/actions/rest.ts:142-159`) maps `ok->200{output}`, `pending->202{status:'pending_approval',messageId}`, `blocked->403{error}`. These 4 defs flip from ALWAYS-200 to possibly-202/403. Confirmed SAFE: live xterm (`components/TerminalView.tsx`) is OUTPUT-ONLY (no `term.onData` keystroke path), so the ONLY `.tsx` caller of `POST /api/terminals/:id/input` is `handleExecuteBroadcast` (App.tsx:856) — gating `send_keys` does NOT break live typing. `apiFetch` (`src/utils/api.ts`) does not throw on non-2xx. No body-shape regression, no silent 200-collapse. CAVEAT: default gate is Ask and these caps are NOT spotlight-eligible (only `write_to_pane`/`deliver_handoff` are, `gateSurface.ts:58-61`), so OFF-CONTEXT the default REST result becomes 202-deferred. `handleDeleteWatchRule`/`handleDeletePlan`/`handleCreateWatchRule` (App.tsx:783-804,763-781) do NOT check `res.ok` — they immediately re-fetch and play a success earcon, so the operator sees the rule/plan STILL PRESENT with a success cue and no error: "nothing happened until you approve" is now the default UX, not the exception.
- **(c) No-twin guard: PASS.** `tests/test_no_inline_twins.ts` is pure route-membership (regex scan of server.ts `app.<verb>('<path>')` vs `INLINE_EXCEPTIONS`). The design changes ZERO routes and ZERO `inlineExceptions.ts` rows, so the guard cannot move. `unexpectedAsymmetries` (`coverage.ts:185-193`) keys on action NAME + unchanged surfaces (the 4 defs stay rest-only, already allow-listed at `coverage.ts:92,148-151`), also unaffected. Doc's claim is accurate.
- **(d) Files/symbols/tests REAL:** mostly precise. `makeCtx` exists (`test_action_registry.ts:76`), the `respawn_pane` (`panes_rest.ts:147-206`) and `delete_pane`/`delete_project` (`lifecycle_rest.ts:59-125`) gate templates are exactly as described, the §8.1b golden "every def pinned" assertion is real (`test_action_registry.ts:273-275`), `tests/test_c55_14_lifecycle.ts` exists as the mirror. NOTABLE: the design doc uses the CORRECT path `src/gateSurface.ts` (verified by the import `from "../src/gateSurface"` in `test_gate_surface.ts:10` and `from "../gateSurface"` in `capabilities.ts:17`); the TASK BRIEF's path `src/actions/gateSurface.ts` is WRONG — the doc is right.
- **(e) TDD plan: PASS.** RED-first new test (`tests/test_c55_10_gating.ts`) faithfully mirrors the real `test_c55_14_lifecycle.ts` makeCtx-stub-gateOrDefer pattern; steps add ids+goldens before flipping handlers, lint after each structural step. Risk register correctly flags the gateOrDefer Auto-path-does-NOT-invoke-run contract (must call `sendEffect()` in the ok arm, `panes_rest.ts:203-205`) and the durable cross-restart Ask-replay limitation.
- **MINOR/STALE-COMMENT issues (not failures):** (1) `test_action_registry.ts:208-210` comment says "add_watch_rule are matrix rows RESERVED for future voice tools" — wiring `add_watch_rule` to a def makes this comment stale (no test fails; subset still holds). (2) The doc's §2.B-2 says to add the 3 new ids to `DEFAULT_CAPABILITY_GATES` (`src/types.ts:42-61`); this map is a `Partial<Record<CapabilityGate,GateValue>>` and is NOT pinned by any totality test found, so it's optional-for-correctness but good for behavior parity — the doc slightly overstates it as required. (3) The doc's §2.C-8 claim "c55.14 added the new caps here [DEFAULT_MOCK_GATES]" is accurate (delete_pane/delete_project are at `harness.ts:217-218`) and the map is Partial, so adding 3 more is safe and non-mandatory — doc correctly notes this.

### Implementation outcome (impl phase, commit `2cbb55b` on `feat/c55.10-gate-tightening`)

Implemented, fully green, committed (NO push / bd / gh). Final policy: 4 defs GATED at default Ask via `ctx.gateOrDefer` (`send_keys` NEW cap, `add_watch_rule` existing row un-reserved, `remove_watch_rule` NEW cap, `delete_orchestrator_plan` NEW cap); `resize_pane`/`clear_history`/`clear_exited` stay ungated. Matrix grew 24→27. Required-fix #2 (effective-default assertion) added. Catalog + voice-tool-goldens regenerated (additive-only). Battery green: lint 0, build 0, convergence 50/50, catalog no-drift 0, full suite 1313/1313.

**BLOCKER carried forward (product decision to ratify):** the 4 newly-gated caps are NOT spotlight-eligible, so off-context the DEFAULT REST result is now 202-deferred, not 200. The App.tsx handlers do not branch on res.ok/202 — operator clicks Delete-rule / Create-rule / send-keystrokes, hears success, sees the list UNCHANGED, with no "pending approval" indication. App.tsx was untouched by design. Needs either director sign-off that silent-defer is acceptable, OR a follow-up to teach those handlers to surface the 202 pending state. (See the closeout roadmap's c55.10 row.)

**Accepted scope-out:** durable cross-restart Ask-replay is OUT OF SCOPE (matches c55 batch precedent) — `buildActionRun` (`src/actionEffects.ts`) has no case for the 3 new caps, so an Ask→confirm AFTER a process restart degrades to a no-op string. In-process Ask→confirm replays correctly. `ctx.versionStamp` is passed so a drifted intent quarantines.
