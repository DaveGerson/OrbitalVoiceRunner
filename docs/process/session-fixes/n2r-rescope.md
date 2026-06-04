# n2r RE-SCOPE — gate-UI crash-safety, anchored to CURRENT main (#26 + #27)

**Bead:** `wsm-e2e-pinned-n2r` (WS-L rescoped slice: "crash-safety on the gate UI")
**Kind:** ui · **Status:** Design — re-scope pass, no source changed (this doc only).
**Base:** current `main` = `a38a3cc` (9 landed session-fixes + **PR #26** capability-matrix surface +
**PR #27** notes-recall). The re-scope branch `feat/session-fixes-rescope` is checked out in the
`session-fixes` worktree.
**Original impl read from:** `feat/session-fixes` (the U2-based draft) via `git show` / `git diff main..feat/session-fixes`.
**Coordination:** runs **AFTER rbh** (`wsm-e2e-pinned-rbh`). Both touch `gateSurface.ts` + `GateChip.tsx`.
n2r wraps rbh's additions (the divergence dialogs) in the same guards.

---

## BLUF — RECOMMENDATION: **implement-delta** (NOT superseded)

PR #26 shipped the gate cockpit (`gateSurface.ts`, `GateChip.tsx`, `CapabilityMatrixTab.tsx`, the
posture payload on `/api/terminals`, the per-pane `PUT /capability-gates`, the Settings gates tab) —
but it shipped it with the **exact null-only guards the original n2r diagnosed**, so **the
white-screen crash surface is still live on main today.** Nothing on #26/#27 normalizes a *malformed*
posture/gate payload; nothing wraps the chip in a local boundary. The genuine n2r delta —
`normalizePostureWord` / `normalizeGateValue` / `normalizeEffectiveGates` / `sanitizePartialGateMap` +
a `GateChip`-local error boundary + the calm degraded tell — is **100% additive over #26** and
**unblocked by it**. The only thing that changed vs. the original draft is the **base the patch sits
on** (rebase, not rewrite): the original n2r diff was cut against U2's gateSurface; #26's gateSurface
is functionally identical surface-wise, so the delta ports almost verbatim, with three precise
adjustments documented in §3.

The **only** thing that could make a sub-part redundant is rbh: rbh moves `POSTURE_STYLE`/`GATE_STYLE`
into `gateSurface.ts`. Since n2r runs **after** rbh, n2r simply **imports** those palettes from
gateSurface (matching the original draft) — it does **not** re-do the move. See §5.

---

## 1. The DIFF, decoded — original n2r (on feat/session-fixes) vs what #26 put on main

Command run: `git diff main..feat/session-fixes -- src/gateSurface.ts src/components/GateChip.tsx
src/components/CapabilityMatrixTab.tsx src/App.tsx tests/test_gate_surface_normalize.ts`.

Stat: `gateSurface.ts +143`, `GateChip.tsx +93/-`, `CapabilityMatrixTab.tsx +19/-`, `App.tsx`
(258 lines, **almost all of which is unrelated WS churn** — App.tsx diverged broadly between the two
branches; only ~1–2 lines are n2r), `tests/test_gate_surface_normalize.ts +172` (new).

That raw diff **overstates** the n2r delta because `feat/session-fixes` carries the whole 13-fix /
rbh / dialogs stack. To isolate n2r I read the **components on current main** (the #26 versions) and
matched them against the n2r-specific hunks. The breakdown:

| Concern | What #26 has on main NOW | What the original n2r added | Verdict |
|---|---|---|---|
| `gateSurface.ts` normalizers | **NONE** — file ends at `CAPABILITY_CATEGORIES` (line 147). No `normalizePostureWord`/`normalizeGateValue`/`normalizeEffectiveGates`/`sanitizePartialGateMap`, no `POSTURE_WORDS`/`GATE_VALUES` runtime sets. | The full normalizer block (the `n2r` section). | **GENUINE DELTA — port it.** |
| `GateChip.tsx` guard | `if (!posture \|\| !effectiveGates) return null;` then `POSTURE_STYLE[posture]` — **closed-union lookup, no default branch** (`GateChip.tsx:82-85`). Popover row: `const value = gates[cap] ?? "Auto"; const g = GATE_STYLE[value];` (`:123-124`) — `??` rescues missing, **passes through bad values**. | Normalize at the boundary (`safePosture`/`normalizeEffectiveGates`), hard style fallbacks (`?? POSTURE_STYLE.GUARDED`, `?? GATE_STYLE.Ask`), degraded tell, **local error boundary** (`GateChipInner` + `GateChipBoundary`). | **GENUINE DELTA — port it.** The crash is reproducible on main today. |
| `CapabilityMatrixTab.tsx` scope map | `gatesForScope` returns raw `paneGatesFor(...) ?? {}` (`:67-70`); `valueOf` reads `current[cap]` — a non-object pane payload can throw / phantom-select. | `sanitizePartialGateMap(...)` wrapped around all three scope branches. | **GENUINE DELTA — port it** (small). |
| `POSTURE_STYLE`/`GATE_STYLE` location | **LOCAL in `GateChip.tsx:32-43`** (#26 did NOT move them). | Imported FROM `gateSurface` (the original draft assumed rbh's move had already landed). | **NOT an n2r delta — owned by rbh.** See §5. |
| `App.tsx` | `{term?.posture && <GateChip …/>}` (`:3151`, `:3212`) — outer truthiness guard already gates the render. | (draft) a boundary mount + a mock label — but the boundary now lives **inside** GateChip; App churn is unrelated WS noise. | **Mostly NOT n2r.** Keep App.tsx's outer guard; n2r is self-contained in the components. See §3.3. |
| `tests/test_gate_surface_normalize.ts` | **Does not exist on main** (main has `tests/test_gate_surface.ts` — the #26 8sq suite, a *different* file). | New 172-line `node:test` suite for the four normalizers. | **GENUINE DELTA — port it. No filename collision.** |

**Net:** the original n2r is **not superseded by #26** — #26 is precisely the surface n2r hardens, and
it shipped *without* the hardening. The delta is real, additive, and reproducible-on-main.

---

## 2. Redundant-with-main vs. genuine delta (explicit)

**Redundant with main (DROP from the re-scope — already on #26, do not re-add):**
- The matrix surface itself: `GateChip`, `CapabilityMatrixTab`, `gateSurface.ts` derivations
  (`deriveEffectiveGates`, `derivePostureWord`, `CAPABILITY_LABELS`, `CAPABILITY_CATEGORIES`,
  `ALL_CAPABILITIES`, `SPOTLIGHT_CAPABILITIES`). All present and identical-in-spirit on main.
- The posture payload (`Terminal.posture` / `effective_gates` on `/api/terminals`), the per-pane
  `PUT /capability-gates`, the Settings gates tab, the e2e harness `setPostureMock` +
  `DEFAULT_MOCK_GATES` + `e2e/gate_chip.spec.ts` + `e2e/capability_matrix.spec.ts`. All on main.
- The `data-posture` chip contract the existing e2e asserts. Unchanged by n2r.

**Owned by rbh (DROP from n2r — rbh lands it first):**
- Moving `POSTURE_STYLE`/`GATE_STYLE` from `GateChip.tsx` into `gateSurface.ts` (rbh-plan §3 D4, §"files").
  n2r consumes the moved palettes; it does not perform the move.

**Genuine n2r delta (KEEP — the whole point of this bead's crash-safety slice):**
1. `gateSurface.ts`: the four pure normalizers + the two runtime guard sets (`POSTURE_WORDS`,
   `GATE_VALUES`). Fail-safe directions locked: bad posture → `GUARDED` (D1); bad gate → `Ask` (D2);
   absent posture → `null` (D3, render-nothing); non-object gates → all-`Auto` (D6); pane override bad
   entry → stripped, stays partial (D7).
2. `GateChip.tsx`: render off the normalized shape (`safePosture` + `normalizeEffectiveGates`), hard
   style fallbacks, the calm degraded tell (D8), and the **GateChip-local error boundary**
   (`GateChipInner` wrapped by `GateChipBoundary`; the global `ErrorBoundary` stays as last resort, D4).
3. `CapabilityMatrixTab.tsx`: `sanitizePartialGateMap` around all three scope branches in
   `gatesForScope`.
4. `tests/test_gate_surface_normalize.ts`: the failing-first unit suite for the four normalizers.
5. **(rbh-coordination)** wrap rbh's `ActionConfirmDialog`/`ApprovalDialog` posture/gate lookups in
   the same normalizers (see §5.2). This is the "wrap rbh additions in the guards" mandate.

**Explicitly OUT of this re-scope (the broader n2r bead's other items — separate slices/follow-ups):**
distinct earcons (`approval_pending` vs `command_blocked`) + `gate_changed` announcement +
`announcementKinds.ts` KIND_META; a11y `role="dialog"`/`aria-modal`/`aria-live` on the modals +
auto-Notification; crash-safe PTY reaping (`uncaughtException`/`unhandledRejection`); mock-mode label.
None are the crash-safety slice and none are in the diff under review. The original draft's "Change 5
(mock label)" and "Change 6 (malformed-posture harness hook + e2e)" are **deferred to a follow-up**
(see §6) so this re-scope stays a tight, low-risk, regression-proof crash-safety patch.

---

## 3. Re-scope adjustments vs. the original draft (where the rebase actually bites)

The original `n2r-plan.md` (Changes 1–6) was cut against `feat/session-fixes`. Three concrete deltas
vs. that draft, forced by anchoring to **current main**:

### 3.1 The normalizers port verbatim — but assert against main's `ALL_CAPABILITIES`
`gateSurface.ts` on main already exports `ALL_CAPABILITIES` (16 caps, line 32) and the
`CapabilityGate`/`GateValue`/`CapabilityGateMap` types from `./types`. The normalizer block from the
draft compiles against main **unchanged**. The new test imports `ALL_CAPABILITIES` from
`../src/gateSurface` (main exports it) — no edit needed.

### 3.2 GateChip palette import: depends on rbh having run (it will)
The original n2r `GateChip` diff begins:
`import { …, POSTURE_STYLE, GATE_STYLE, normalizePostureWord, normalizeEffectiveGates, type PostureWord } from "../gateSurface";`
— i.e. it imports `POSTURE_STYLE`/`GATE_STYLE` **from gateSurface**, which only works **after rbh moves
them there.** Since n2r runs after rbh, this is correct as-is. **Contingency if rbh is NOT yet landed
when n2r is implemented:** keep `POSTURE_STYLE`/`GATE_STYLE` as the existing **local** consts in
`GateChip.tsx` (main's current state) and import only the **normalizers** from gateSurface. The
crash-safety delta (boundary + normalize + fallbacks) is **independent of where the palette lives** —
do not let n2r perform rbh's move (that would create a merge collision on the same hunk). The hard
fallback `POSTURE_STYLE[safePosture] ?? POSTURE_STYLE.GUARDED` works against either a local or an
imported `POSTURE_STYLE`.

### 3.3 App.tsx: keep #26's outer `term?.posture &&` guard — do NOT remove it
Main renders `{term?.posture && <GateChip …/>}` (`App.tsx:3151`, `:3212`). The n2r normalizer D3
(`normalizePostureWord(null) === null → return null`) makes GateChip *self-guarding* against absent
posture, so the outer `term?.posture &&` is now **belt-and-suspenders, not load-bearing**. **Decision:
leave it in place.** Removing it is pure churn, risks the #26 chip e2e, and gains nothing (the chip
returns `null` either way). n2r touches **zero** App.tsx lines — the boundary lives inside GateChip,
not at the App mount site (a refinement over the original draft, which floated an App-level boundary
mount). This shrinks the integration surface to exactly two component files + one test file.

---

## 4. Files to touch (this re-scope) + the failing-test-first sequence

| File | Change |
|---|---|
| `tests/test_gate_surface_normalize.ts` (**NEW**) | The four-normalizer `node:test` suite. **Write FIRST.** Imports `normalizePostureWord`/`normalizeGateValue`/`normalizeEffectiveGates`/`sanitizePartialGateMap` from `../src/gateSurface` — which **do not exist on main yet**, so `tsc` (lint) + the run fail on the missing exports. That is the right-reason failure. |
| `src/gateSurface.ts` | Append the n2r normalizer block (after `CAPABILITY_CATEGORIES`, line 147): `POSTURE_WORDS`, `GATE_VALUES`, `normalizePostureWord`, `normalizeGateValue`, `isPlainObject`, `normalizeEffectiveGates`, `sanitizePartialGateMap`. Pure, total, never-throwing. Greens the unit suite. |
| `src/components/GateChip.tsx` | Import the normalizers; replace the `:82-86` null-only guard with `safePosture` + `normalizeEffectiveGates`; hard style fallbacks (`?? POSTURE_STYLE.GUARDED`, `?? GATE_STYLE.Ask`); `data-posture={safePosture}`; the `degraded` tell (`gate-chip-degraded`); rename body to `GateChipInner` and export `GateChip` wrapped in `GateChipBoundary`. Palette import per §3.2. |
| `src/components/CapabilityMatrixTab.tsx` | Import `sanitizePartialGateMap`; wrap all three `gatesForScope` branches with it. |
| `src/components/ActionConfirmDialog.tsx`, `src/components/ApprovalDialog.tsx` | **Only after rbh lands these.** Wrap the rbh `posture ? POSTURE_STYLE[posture] : undefined` / `effectiveGate ? GATE_STYLE[…] : undefined` lookups in `normalizePostureWord` / `normalizeGateValue` so a malformed rider payload can't throw in a modal either (§5.2). If rbh has not landed when n2r runs, file as a one-line follow-up on the rbh dialogs and skip — do not pre-create the dialogs. |

**Failing-test-first (the one the workflow asks for):** `tests/test_gate_surface_normalize.ts`.
Confirm it fails on **missing imports** (not a logic mismatch) before implementing the gateSurface
block — i.e. run `npm test` and see the four symbols unresolved / `tsc` red, then add Change 1 to green.

**TDD order:** (1) write the unit suite → red on missing imports. (2) gateSurface normalizers → green.
(3) GateChip boundary + normalize + fallbacks. (4) CapabilityMatrixTab `sanitizePartialGateMap`.
(5) full battery: `npm run lint` (0) · `npm test` (538 → 538+ new, 0 fail) · `npx playwright test
e2e/gate_chip.spec.ts e2e/capability_matrix.spec.ts` (stay green) · `npm run build`.

---

## 5. rbh coordination (both touch gateSurface + GateChip)

rbh runs **before** n2r. The two interact on exactly two surfaces:

### 5.1 The palette move (rbh owns it; n2r consumes)
rbh-plan §3 D4 + §"files" move `POSTURE_STYLE`/`GATE_STYLE` from `GateChip.tsx:32-43` into
`gateSurface.ts` (so the chip and rbh's divergence dialogs share one palette). **n2r must NOT also
perform this move** — doing so double-touches the identical hunk and guarantees a conflict. After rbh:
n2r's GateChip imports both palettes from gateSurface (matches the original draft). The n2r boundary +
normalize edits sit in *different* hunks (`:82-86`, the popover rows, the export) than rbh's palette
extraction, so they compose cleanly. The hard fallbacks (`?? POSTURE_STYLE.GUARDED`) reference the
palette by name regardless of where it's defined.

### 5.2 Wrap rbh's divergence dialogs in the guards (the mandate)
rbh adds `deriveActionDivergence` to `gateSurface.ts` and two dialogs —
`ActionConfirmDialog.tsx` / `ApprovalDialog.tsx` — that render a posture badge + an effective-gate row
from **props threaded from the server** (`posture ? POSTURE_STYLE[posture] : undefined`,
`effectiveGate ? GATE_STYLE[effectiveGate] : undefined`). Those are the **same closed-union lookups**
that white-screen the chip — now in a modal. Per the bead ("wrap rbh additions in the guards"), n2r
hardens them: route `posture` through `normalizePostureWord` and `effectiveGate`/`writeGate` through
`normalizeGateValue` before the style lookup, with the same `?? …GUARDED` / `?? …Ask` hard fallback.
A malformed rider payload then degrades the badge calmly instead of throwing inside an approval modal
(which would be *worse* than the chip case — it blocks the operator's confirm path). **n2r does NOT
re-derive rbh's divergence decision** — `deriveActionDivergence` stays rbh's; n2r only sanitizes the
inputs to the *presentation* lookup. (If rbh's dialogs are not yet on the branch when n2r is
implemented, file this as a tiny follow-up keyed to rbh and skip — never pre-create rbh's files.)

---

## 6. Deferred out of this re-scope (filed, not dropped)
- **Mock-mode label** (`mock-mode-banner`, original Change 5) + **malformed-posture e2e harness hook**
  (`injectMalformedPosture` + `e2e/gate_chip_crashsafe.spec.ts`, original Change 6). These are valuable
  but (a) the harness hook is net-new test infra and (b) the crash-safety *logic* is fully proven by the
  pure unit suite (the normalizers ARE the fix; the e2e is an integration witness). Keeping them out
  makes this re-scope a minimal, conflict-free, regression-proof patch. **Recommendation:** file a P3
  follow-up bead (`discovered-from: n2r`) for the e2e witness + mock label once rbh + this land.
- The broader n2r bead's earcon / a11y / PTY-reaping items — orthogonal, not crash-safety, not in scope.

---

## 7. Integration risks (how this could regress #26 / #27) + mitigations

**Against #26 (capability-matrix surface) — the real exposure:**
- **R1 — `data-posture` contract drift breaks `e2e/gate_chip.spec.ts`.** #26's chip e2e asserts
  `data-posture` equals the seeded word. n2r renders `data-posture={safePosture}`; for **valid** input
  `safePosture === posture`, so the rendered attribute is byte-identical. *Mitigation:* keep
  `data-posture={safePosture}`; the happy-path is provably unchanged for `OPEN|GUARDED|LOCKED`. Run
  `e2e/gate_chip.spec.ts` green before commit. **Low.**
- **R2 — popover row text shift.** #26 renders `gates[cap] ?? "Auto"` then `GATE_STYLE[value]`; n2r
  renders `gates[cap]` off the normalized (already-total) map. For valid payloads every cap is present
  and identical, so the popover rows are unchanged. *Mitigation:* `normalizeEffectiveGates` is identity
  on a well-formed 16-cap map (every value passes `GATE_VALUES.has`); the existing popover e2e assertions
  hold. **Low.**
- **R3 — the GateChip-local boundary masks a genuine #26 logic bug.** A local boundary could silently
  swallow a real render fault and hide it. *Mitigation:* `componentDidCatch` logs `[GateChip] render
  fault` to console; the normalizers make the two *known* surfaces unreachable, so the boundary only
  fires on a genuinely new fault (then visible in logs). The global `ErrorBoundary` is untouched. **Low.**
- **R4 — CapabilityMatrixTab reset/override semantics regress.** #26's per-pane reset affordance depends
  on `valueOf(cap) === undefined` meaning "no override → follow global." `normalizeEffectiveGates` would
  destroy that (it fabricates 16 Autos). *Mitigation:* the pane/global/preset scopes use
  **`sanitizePartialGateMap`** (stays partial — strips invalid entries, never fabricates), exactly to
  preserve "absent = follow global." A targeted `sanitizePartialGateMap` unit test (the
  `{bogus}` → `{}` and valid-round-trip cases) pins this. **Medium → mitigated.**
- **R5 — palette double-move collision with rbh.** If n2r also moved `POSTURE_STYLE`/`GATE_STYLE` it
  would conflict with rbh's identical move and could leave the chip importing a non-existent symbol.
  *Mitigation:* §5.1 — n2r **never** moves the palette; it imports post-rbh (or keeps the local consts
  pre-rbh). The boundary/normalize hunks are disjoint from rbh's extraction hunk. **Low.**

**Against #27 (notes-recall) — essentially none:**
- **R6 — shared-file collision.** n2r touches only `gateSurface.ts`, `GateChip.tsx`,
  `CapabilityMatrixTab.tsx`, `tests/test_gate_surface_normalize.ts` (+ optionally rbh's two dialogs).
  #27 lives in the notes/deferred-action path (`amend_note`, voice tools, durable notes,
  `tests/test_notes_recall.ts`) — **zero file overlap.** *Mitigation:* `tests/test_notes_recall.ts`
  must stay green in the full `npm test` run; it cannot be touched by these component-only edits.
  **None / Low.**
- **R7 — baseline count regression.** Baseline is **538 pass / 0 fail** (verified). The new unit suite
  is purely additive (no existing test is modified). *Mitigation:* full `npm test` after each step;
  `tests/test_gate_surface.ts` (#26 8sq totality suite) and `tests/test_notes_recall.ts` (#27) must both
  stay green. **Low.**

**Verified pre-state on main (anchors above):** `gateSurface.ts` ends at line 147 with **no**
normalizers; `GateChip.tsx:82` is the null-only `if (!posture || !effectiveGates) return null;` with a
closed-union `POSTURE_STYLE[posture]` lookup at `:85`; `CapabilityMatrixTab.gatesForScope` returns raw
maps; `tests/test_gate_surface.ts` (≠ the n2r file) is the only gateSurface test; baseline
**538/0**, `npm run lint` exit 0.
