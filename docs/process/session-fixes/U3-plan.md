# U3 — Composer "draft pending" + target-pane visibility on desktop

**Bead:** `wsm-e2e-pinned-dlj`
**Issue:** U3 (priority 2, type feature, kind **ui** — SPEC REQUIRED)
**Status:** Design — implementation-ready. No code changed in this pass.
**Surfaces touched:** `src/App.tsx` only (client render). No server/store/PTY changes.

---

## BLUF

The desktop **Sync Spec** tab has *zero* draft-pending indicator, so an operator sitting on the
Orchestrate/Alerts tab cannot tell a command is being drafted ("it was in the corner... I don't
know what is going on"). The mobile nav already has a dot; desktop does not. **Ship a cyan
`animate-pulse` badge on the Sync Spec tab button, gated on `promptBuffer.trim().length > 0 ||
wipDrafts.length > 0`, with a `data-testid` for e2e.** The "which pane does this draft target"
half of the felt problem is *already solved* in the composer header and Send button
(`→ {activePaneName}`); we keep that, pin it with a `data-testid`, and **defer** any composer
relocation. Net change is ~10 lines + one harness hook + one new e2e spec.

---

## 1. Problem & root cause (code-anchored)

### 1.1 The verified gap

The tab bar `renderHelperPanelTabs()` (`src/App.tsx:2001-2045`) renders three buttons:
**Sync Spec** (`buffer`, lines 2005-2015), **Orchestrate** (lines 2016-2026), **Alerts** (lines
2027-2042). Only **Alerts** carries a status badge — the red unread-count pill gated on
`unreadCount > 0` (lines 2037-2041):

```tsx
{unreadCount > 0 && (
  <span className="bg-red-500 text-black font-sans font-black text-[8px] h-4 min-w-4 px-1 rounded-full flex items-center justify-center animate-pulse">
    {unreadCount}
  </span>
)}
```

The **Sync Spec** button (2005-2015) has no equivalent. When the operator is on Orchestrate or
Alerts and a draft is filling in `promptBuffer` (dictation, a Janus suggestion, or a `+ Task`
click), nothing on the tab bar signals it. The draft is one tab away and invisible.

### 1.2 Why "it was in the corner"

`renderHelperPanelTabs()` is rendered in **two** places (verified):

- **Desktop aside** — `src/App.tsx:4054-4062` (`<aside className="hidden lg:flex w-[400px] ...">`),
  call site line 4059.
- **Mobile buffer view** — `src/App.tsx:4045-4051` (`<section className="... lg:hidden ...">`),
  call site line 4048.

Because both surfaces share the *same* `renderHelperPanelTabs()` function, a badge added there
appears on **both** desktop and mobile tab bars — one edit, both surfaces.

The **only** existing draft indicator today is a separate hand-rolled dot on the **mobile sticky
nav** (`src/App.tsx:4135-4137`, inside the `lg:hidden` mobile nav bar at 4121):

```tsx
{promptBuffer.length > 0 && (
  <span className="absolute top-2.5 right-8 w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse"></span>
)}
```

Note two defects in that existing dot we should *not* replicate:
1. It gates on `promptBuffer.length > 0` (raw length) — a draft that is pure whitespace lights it
   up. We will gate the new badge on `promptBuffer.trim().length > 0` to match the Send-enable
   semantics (`composer-send` is disabled on `!promptBuffer.trim()`, line 1990).
2. It ignores `wipDrafts` entirely — a draft staged for a *non-active* pane (the "WIP elsewhere"
   register) does not light it. Our badge will also fire on `wipDrafts.length > 0`.

### 1.3 The target-pane half is already built (do NOT rebuild)

The dossier asks the spec to weigh a "drafting -> pane X" affordance. **It already exists** in the
composer (`renderPromptSynchronizerPanel`, `src/App.tsx:1854-1999`):

- **Header chip** (lines 1867-1869): `→ {activePaneName}` in a cyan pill with
  `title="The pane this draft will be sent to"`.
- **Send button** (line 1994): `Send → {activePaneName}`.
- **Context block** (line 1937): `Context · {activePaneName}`.

`activePaneName` is derived at line 1855:
`const activePaneName = activePaneMeta?.name || activeTerminalId || "no pane open";`
where `activePaneMeta` is resolved from the ledger at lines 1404-1416.

So "which pane does this draft target" is unambiguous **once the composer is open**. The real
residual gap is purely the *tab-level* pending signal — you can't see it without already being on
the tab. That is exactly what the badge fixes. **Recommendation: ship the badge, pin the existing
target label with a `data-testid`, and defer a composer relocation.**

---

## 2. Resolved design decisions

| Decision | Options | **Chosen** | Rationale |
|---|---|---|---|
| **Port vs. merge** | (a) Hand-roll a fresh badge on Sync Spec; (b) reuse the Alerts pill markup; (c) reuse the mobile cyan-dot markup | **(c) cyan dot, corrected** | Matches the *draft* semantic (the Alerts pill is a numeric count; a draft is binary present/absent). Reuse the dot idiom from line 4136 but fix its gate (`.trim()` + `wipDrafts`). Visually consistent with the existing mobile dot and the codebase `animate-pulse` idiom. |
| **Frozen-coupling** | (a) Badge gates on `promptBuffer` only; (b) gates on `promptBuffer.trim() || wipDrafts` | **(b)** | A draft staged for a *non-active* pane (`wipDrafts`, line 219) is still "pending work" the operator should see. Whitespace-only `promptBuffer` must NOT trigger it — align with `composer-send` disable logic (line 1990). |
| **Save-preservation** | n/a (badge is read-only derived state) | **No persistence change** | The badge derives from existing reactive state (`promptBuffer`, `wipDrafts`). Per-pane draft persistence is already handled (header strip line 1890: "Saved per-pane — switching panes never loses your draft"). Zero ledger/store impact. |
| **Staging / scope** | (a) Badge only; (b) badge + scoped target label pin; (c) badge + full composer relocation | **(b) — ship now; (c) deferred** | Badge + a `data-testid` on the already-built `→ {activePaneName}` chip closes the felt problem and is e2e-pinnable. A full composer move (always-visible drafting strip outside the tab) is a larger UX change — file a follow-up bead, do not block U3. |
| **Test driver for `wipDrafts` toggle** | (a) Extend the e2e harness with an `injectWipDraft` hook; (b) assert the `wipDrafts` branch via unit-level reasoning only | **(a)** | The `?mock=1` harness (`src/e2e/harness.ts`) has no `wipDrafts` injection today. Add a tiny `injectWipDraft` hook so the e2e can prove BOTH gate clauses. Small, isolated, mirrors the existing `inject*` pattern. |

---

## 3. Exact changes (file : location : change)

### Change A — Badge on the Sync Spec tab button (the core fix)

**File:** `src/App.tsx`
**Location:** inside `renderHelperPanelTabs()`, the Sync Spec `<button>` at lines 2005-2015.

1. At the top of `renderHelperPanelTabs()` (alongside `const unreadCount = ...`, line 2002), add a
   derived flag:
   ```tsx
   const draftPending = promptBuffer.trim().length > 0 || wipDrafts.length > 0;
   ```
2. Add `relative` to the Sync Spec button's className (the Alerts button already has `relative` at
   line 2029 so its badge can absolutely-position; the Sync Spec button at 2007 does not). Mirror it.
3. Inside the Sync Spec button, after the `<span>Sync Spec</span>` (line 2014), add the badge:
   ```tsx
   {draftPending && (
     <span
       data-testid="sync-spec-draft-badge"
       title="A prompt draft is pending"
       className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shrink-0"
     ></span>
   )}
   ```

> Note: because `renderHelperPanelTabs()` is shared (§1.2), this badge lands on **both** the desktop
> aside (4059) and the mobile buffer-view tab bar (4048). The standalone mobile *nav* dot at
> 4135-4137 is a different element on a different bar; leave it as-is (or optionally align its gate
> in a follow-up — out of scope for U3).

### Change B — Pin the existing target-pane label with a testid

**File:** `src/App.tsx`
**Location:** composer header chip, lines 1867-1869.

Add `data-testid="composer-target-pane"` to the existing cyan pill so the e2e can assert it reflects
the active pane. No behavior change:
```tsx
<span
  data-testid="composer-target-pane"
  className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 truncate"
  title="The pane this draft will be sent to"
>
  → {activePaneName}
</span>
```

### Change C — Harness hook to drive the `wipDrafts` gate branch (test-support only)

**File:** `src/e2e/harness.ts`
**Locations:**
- `OrbitalE2EHooks` interface (lines 19-41): add `injectWipDraft: (paneId: string, text: string) => void;`
- `E2EHarnessDeps` interface (lines 46-56): add a `setWipDrafts` dep whose type **exactly** matches
  the `useState` shape at `src/App.tsx:219` (note the optional `updatedBy?: string`):
  ```ts
  setWipDrafts: (
    updater: (prev: { paneId: string; draft: { text: string; updatedAt: string; updatedBy?: string } }[])
      => { paneId: string; draft: { text: string; updatedAt: string; updatedBy?: string } }[],
  ) => void;
  ```
  (Mismatching this signature is the single most likely `tsc --noEmit` break — keep it byte-for-byte
  aligned with line 219.)
- `hooks` object (lines 143-194): add
  ```ts
  injectWipDraft: (paneId, text) =>
    deps.setWipDrafts((prev) => [...prev, { paneId, draft: { text, updatedAt: new Date().toISOString() } }]),
  ```

**File:** `src/App.tsx`
**Location:** the `useE2EHarness({...})` deps call site. Pass `setWipDrafts` (state setter from
line 219) into the deps object.

**File:** `e2e/fixtures.ts`
**Location:** the `Window.__ORBITAL_E2E__` typing (lines 12-20) and a new exported helper, mirroring
`injectPendingAction` (lines 53-58):
```ts
injectWipDraft: (paneId: string, text: string) => void;  // in the interface
// ...
export async function injectWipDraft(page: Page, paneId: string, text: string): Promise<void> {
  await page.evaluate(
    ([p, t]) => window.__ORBITAL_E2E__?.injectWipDraft(p, t),
    [paneId, text] as const,
  );
}
```

> Note: the harness seeds the active pane as `MOCK_TERMINAL_ID` ("mock_pane_1"). To exercise the
> `wipDrafts` clause specifically (a draft for a *different* pane), inject for a non-active id, e.g.
> `"mock_pane_2"`. `wipDrafts.length > 0` is what the badge checks, so any id works for the gate.

---

## 4. TEST-FIRST plan (aligned to repo runners)

**Runner:** Playwright e2e — `npm run test:e2e` (auto-starts Vite, `?mock=1` harness).
**New file:** `e2e/draft_badge.spec.ts`, modeled on `e2e/composer.spec.ts` (viewport 1440×900 for
desktop, `gotoMockedApp`, `getByTestId`).

### 4.1 The FIRST failing test to write (write it, watch it fail RED before any App.tsx change)

```ts
import { test, expect, gotoMockedApp } from "./fixtures";

test.describe("sync-spec draft badge (U3)", () => {
  test("badge is absent on a clean load and appears when promptBuffer fills", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMockedApp(page);

    // Clean harness load: no draft text, no wipDrafts -> badge MUST be absent.
    await expect(page.getByTestId("sync-spec-draft-badge")).toHaveCount(0);

    // Fill the composer draft via the real input path.
    await page.getByTestId("composer-edit-toggle").click();
    await page.getByTestId("composer-input").fill("ship the badge");

    // Badge now present and visible.
    await expect(page.getByTestId("sync-spec-draft-badge")).toBeVisible();
  });
});
```

This fails RED today because `sync-spec-draft-badge` does not exist (`toHaveCount(0)` passes
trivially, but `toBeVisible()` fails). Implement Change A to turn it green.

### 4.2 Remaining assertions (same spec file, added after the first goes green)

- **Whitespace does not trigger (frozen-coupling decision):** fill `composer-input` with `"   "`
  (spaces only) → `sync-spec-draft-badge` has count 0; clear and fill with real text → visible.
  Pins the `.trim()` gate vs. the buggy raw-`length` mobile dot.
- **`wipDrafts` clause (Change C harness hook):** with an empty `promptBuffer`, call
  `injectWipDraft(page, "mock_pane_2", "queued elsewhere")` → `sync-spec-draft-badge` becomes
  visible. Proves the second OR-clause independently.
- **Clearing removes it:** fill the draft → badge visible → click the composer **Clear** button
  (the red button at lines 1978-1984 calls `handlePromptBufferChange("")`) → badge returns to
  count 0.
- **Target-pane label reflects active pane (Change B):**
  `await expect(page.getByTestId("composer-target-pane")).toContainText("mock_pane_1");`
  (Under `?mock=1` the ledger is empty so `activePaneMeta` is null and `activePaneName` falls back
  to `activeTerminalId` = `"mock_pane_1"` — verified against `src/App.tsx:1855` and the harness
  seeding `setActiveTerminalId(MOCK_TERMINAL_ID)` at `src/e2e/harness.ts:131`.)

### 4.3 Key assertions summary

1. `sync-spec-draft-badge` count is 0 on clean load.
2. It becomes visible when `composer-input` holds non-whitespace text.
3. Whitespace-only text does NOT make it visible (`.trim()` gate).
4. `injectWipDraft` for a non-active pane makes it visible with an empty composer.
5. Clearing the draft removes it.
6. `composer-target-pane` contains the active pane id (`mock_pane_1`).

---

## 5. Verify commands

Run from the feature worktree `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes`:

```bash
npm run lint            # tsc --noEmit — catches the new harness/dep typings
npm run test:e2e        # Playwright; expect e2e/draft_badge.spec.ts green, existing specs unaffected
npm test                # unit suite — must stay green (no logic touched, but confirm no regressions)
npm run build           # vite + esbuild — confirm the client still builds
```

> Windows gotcha (from CLAUDE.md): the unit runner needs `--test-force-exit` (already in `npm test`).
> Do not invoke `python3`; this change touches no python.

---

## 6. Risks

- **Shared-render blast radius:** `renderHelperPanelTabs()` is rendered on both desktop and mobile
  (§1.2). The badge intentionally shows on both. Confirm the mobile buffer-view tab bar still lays
  out (the badge is a 1.5×1.5 dot inside a flex button — negligible). Low risk.
- **Duplicate indicators on mobile:** mobile now has *two* draft signals — the existing nav dot
  (4135-4137) and the new tab-bar badge. Acceptable (different bars); optionally de-dupe in a
  follow-up. Not a blocker.
- **Harness surface growth (Change C):** adding `injectWipDraft` widens the e2e injection API. It is
  `?mock=1`-gated and a no-op for real users (same guarantee as every other `inject*`). Keep the
  `setWipDrafts` typing in `E2EHarnessDeps` exact or `tsc --noEmit` will fail — this is the most
  likely lint break; the signature must match the `useState` shape at `src/App.tsx:219`.
- **`activePaneName` fallback assumption:** the target-pane assertion relies on the mock ledger being
  empty so the label is the raw pane id. If a future harness change seeds `ledger`, the assertion
  text must switch from `"mock_pane_1"` to the seeded `name`. Anchored and called out so it is not a
  silent break.

---

## 7. Acceptance criteria

- [ ] Desktop **Sync Spec** tab shows an unmistakable cyan `animate-pulse` badge whenever
      `promptBuffer.trim().length > 0 || wipDrafts.length > 0`, and **none** otherwise.
- [ ] Whitespace-only drafts do NOT trigger the badge.
- [ ] The composer header continues to show `→ {activePaneName}` (now `data-testid`-pinned) so the
      operator can see which pane the draft targets.
- [ ] `e2e/draft_badge.spec.ts` is green (badge-toggle on both gate clauses + clear + target label).
- [ ] `npm run lint`, `npm test`, `npm run build` all green; existing e2e specs unaffected.
- [ ] A follow-up bead is filed for the deferred always-visible composer-relocation / drafting-strip
      UX (decision §2, staging row).

---

## 8. Out of scope (deferred, file follow-up beads)

- Full composer relocation / always-visible "drafting → pane X" strip outside the tab.
- De-duplicating the legacy mobile nav dot (4135-4137) against the new tab badge.
- Numeric draft count (vs. binary dot) on the Sync Spec tab.
