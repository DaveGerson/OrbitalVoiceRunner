# n2r — Crash-safety + render fallbacks for the shipped gate UI

**Bead:** `wsm-e2e-pinned-n2r` (WS-L rescoped: "eyes-off polish + crash-safety on the gate UI")
**Issue:** n2r (priority P3, type feature, kind **ui** — SPEC REQUIRED)
**Status:** Design — implementation-ready. No source changed in this pass (only this doc).
**Builds on:** U2 / bead `wsm-e2e-pinned-cbo` (commit `1162c25`) — the per-pane capability-matrix
surface (`GateChip`, `CapabilityMatrixTab`, `gateSurface.ts`) is already landed on `feat/session-fixes`.
**Surfaces touched (when implemented):** `src/gateSurface.ts`, `src/components/GateChip.tsx`,
`src/components/CapabilityMatrixTab.tsx`, `src/App.tsx` (one local boundary mount + mock-mode label),
`src/e2e/harness.ts` + `e2e/fixtures.ts` (a malformed-posture injection hook), plus new unit + e2e tests.
**No server / store / PTY changes.**

---

## BLUF

The gate cockpit (`GateChip` + popover, `CapabilityMatrixTab`) renders **directly off
server-provided `effective_gates` + `posture`** with only null-guards. A single **malformed**
payload — a posture word that isn't `OPEN|GUARDED|LOCKED`, or a gate value that isn't
`Auto|Ask|Off` — indexes an undefined style record and throws a `TypeError`, which bubbles to the
**one global `ErrorBoundary`** (`src/App.tsx:4235`) and **white-screens the entire cockpit** to the
"Critical Sandbox Error" fault page. **Fix = three layers of defense, no behavior change on the happy
path:** (1) a pure `normalizePosturePayload()` in `gateSurface.ts` that coerces any server payload to
a known-good shape (unknown posture → `GUARDED`, unknown gate value → `Ask`), (2) `GateChip` /
`CapabilityMatrixTab` render strictly from the normalized shape with hard style-lookup fallbacks, and
(3) a **GateChip-local error boundary** so even an unforeseen render fault degrades to *no chip*, never
a dead app. Plus the eyes-off honesty item in scope: relabel mock mode as a non-representative demo.

Degraded-state philosophy (locked): **fail safe = fail GUARDED.** An unparseable posture must never
read OPEN (would imply "Janus acts freely" when we don't actually know) and must never silently vanish
the safety surface. Unknown → GUARDED + a one-line "posture unavailable" tell.

---

## 1. Problem & root cause (code-anchored to current branch state)

### 1.1 The render path is server-trusting with only null-guards

`GateChip` (`src/components/GateChip.tsx`) renders from two props the server attaches to every
terminal (`src/types.ts:101-102`, `Terminal.effective_gates?` + `Terminal.posture?`). Its only guard
is null/undefined:

```tsx
// GateChip.tsx:82
if (!posture || !effectiveGates) return null;
const gates = effectiveGates;
const style = POSTURE_STYLE[posture];   // line 85
```

`POSTURE_STYLE` (`GateChip.tsx:32-36`) and `GATE_STYLE` (`:39-43`) are `Record<PostureWord,…>` /
`Record<GateValue,…>` — **closed-union lookups with no default branch**. The `if (!posture …)` guard
only rejects `null`/`undefined`/empty-string. It does **not** reject a *present but unrecognized
string*.

### 1.2 The exact white-screen crash surfaces

**Surface A — malformed posture word (primary white-screen).**
If the server (or a future stop-all overlay, or a serialization bug, or a stale client against a newer
server) sends `posture: "FROZEN"` / `"open"` / any non-canonical string, line 85 yields
`style === undefined`. The very next dereference throws:

- `GateChip.tsx:94` `title={`${style.label} …`}` → `Cannot read properties of undefined (reading 'label')`.
- Also `:95` `style.ring`/`style.text`, `:98` `style.dot`, `:111-115` `style.text`/`style.dot`/`style.label`.

The throw is *during render*, so React unwinds to the nearest boundary — the **global**
`ErrorBoundary` at `src/App.tsx:4382` (`<ErrorBoundary><AppRaw/></ErrorBoundary>`) — and the whole
cockpit is replaced by the full-screen red "Critical Sandbox Error" page (`:4250-4274`). One bad pane
posture kills every pane, the transcript, the composer, and voice controls.

**Surface B — malformed gate value (popover white-screen).**
Inside the open popover, `GateChip.tsx:123-124`:

```tsx
const value = gates[cap] ?? "Auto";   // ?? only catches null/undefined, NOT "Allow"/"auto"/123
const g = GATE_STYLE[value];          // undefined for any non-Auto|Ask|Off value
```

`?? "Auto"` rescues a *missing* key but **passes through any present-but-wrong value** (e.g.
`"Allow"`, lowercase `"off"`, a number). `GATE_STYLE[value]` is then `undefined` and `:130` `g.dot`
/ `:131`-area `g.text` throws the moment the popover renders — same global-boundary white-screen, just
triggered on hover/click instead of mount.

**Surface C — `effective_gates` not an object.**
`GateChip.tsx:82` `!effectiveGates` is `false` for a *truthy non-object* (a non-empty string, a
number, `true`). Then `spotlightActive` (`:61-65`) does `gates[cap]` (returns `undefined` — tolerable)
but Surface B's `gates[cap] ?? "Auto"` path and the popover still execute against a non-map. An array
`effective_gates: []` slips the guard too (`[] ` is truthy; `Array.isArray` is never checked).

**Surface D — `CapabilityMatrixTab` mirrors the same trust.**
`CapabilityMatrixTab.tsx:163` `const p = GATE_PRESENTATION[opt]` is safe (it iterates the constant
`GATE_OPTIONS`), but `valueOf(cap)` (`:82` `current[cap]`) feeds `selected = value === opt` (`:162`)
off a map that, for the **pane scope**, comes straight from `paneGatesFor(paneId)` →
`term.effective_gates` (server payload). A malformed value there won't crash the toggle (it just shows
nothing selected), but `gatesForScope` (`:61-70`) assumes the scope map is a real object; a non-object
`effective_gates` makes `current[cap]` throw on a primitive in some engines and silently misrenders in
others. Lower severity than A/B, but the same root cause — **no input normalization at the boundary.**

### 1.3 Why the existing ErrorBoundary is necessary-but-insufficient

`src/App.tsx:4235-4277` is a real, working class boundary — but there is exactly **one**, at the app
root. Its blast radius is the entire app. For a *peripheral, server-fed, non-load-bearing* widget like
a posture chip, "any render fault nukes the cockpit" is the wrong failure mode. The director is
eyes-off; a transient bad frame from the WS `terminals_updated` broadcast (`src/App.tsx:1161-1162` →
`fetchTerminals()`) should **lose the chip, not the cockpit.**

### 1.4 Mock-mode honesty (in-scope eyes-off item)

`isMockMode` (`src/App.tsx:43`) drives the `?mock=1` harness. Under mock mode the GateChip renders a
seeded posture (`src/e2e/harness.ts:117-156`, `DEFAULT_MOCK_GATES` → GUARDED) that is **not** a real
server resolution. There is currently **no on-screen label** distinguishing the demo gate from a live
one, so a screenshot/demo of mock mode could be mistaken for the real safety surface. Bead acceptance:
"mock mode labeled non-representative." This is a pure additive label — no logic.

### 1.5 Scope boundary (what this bead is NOT)

- **NOT** the stop-all / frozen subsystem (bead `wsm-e2e-pinned-ms7`). We do not add
  `applyFrozenShortCircuit`, `persistFrozen`, or a `FROZEN` posture. We only make the chip *survive*
  an unknown posture string should one ever arrive.
- **NOT** the earcon / a11y / PTY-reaping items in the broader n2r bead body. Those are separate
  follow-ups; this pass is strictly the "guard against missing/partial/malformed posture payloads,
  undefined gate maps, render fallbacks so a bad payload never white-screens; graceful degraded
  states" slice from the SCOPE NOTE.
- **NOT** a server-side validation change. The fix is client robustness; the server payload contract
  (`server.ts:1454-1464`) is unchanged.

---

## 2. The exact changes (file : location : change)

### Change 1 — `src/gateSurface.ts` : new pure normalizers (END of file, after `CAPABILITY_CATEGORIES`)

Add three small, pure, frontend-safe, unit-testable functions + a runtime posture set. These are the
**single normalization choke-point**; both components consume them.

```ts
/** Runtime guard set for the closed PostureWord union (the surface’s only valid posture words). */
const POSTURE_WORDS: ReadonlySet<string> = new Set<PostureWord>(["OPEN", "GUARDED", "LOCKED"]);
/** Runtime guard set for the closed GateValue union. */
const GATE_VALUES: ReadonlySet<string> = new Set<GateValue>(["Auto", "Ask", "Off"]);

/** Coerce an unknown server posture to a known word. Unknown/absent → "GUARDED" (fail-safe: never
 *  imply OPEN/free-to-act, never imply LOCKED/can’t-type, when we genuinely don’t know). Returns null
 *  ONLY for the legitimate "no posture at all" case so the caller can render nothing (back-compat). */
export function normalizePostureWord(posture: unknown): PostureWord | null {
  if (posture == null) return null;                       // genuinely absent → caller renders no chip
  if (typeof posture === "string" && POSTURE_WORDS.has(posture)) return posture as PostureWord;
  return "GUARDED";                                       // present but malformed → fail-safe GUARDED
}

/** Coerce one unknown gate value to a known one. Missing → "Auto" (legacy default). Present-but-bad
 *  → "Ask" (fail-safe: surface friction rather than silently imply Auto/Allowed). */
export function normalizeGateValue(value: unknown): GateValue {
  if (value == null) return "Auto";
  if (typeof value === "string" && GATE_VALUES.has(value)) return value as GateValue;
  return "Ask";
}

/** Coerce an unknown effective-gates payload to a TOTAL, well-typed map (all 16 caps, every value a
 *  valid GateValue). Non-object/array/primitive input → all-Auto. This is what GateChip/MatrixTab
 *  iterate, so neither component ever indexes a style record with an unknown key. */
export function normalizeEffectiveGates(raw: unknown): Record<CapabilityGate, GateValue> {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<CapabilityGate, GateValue>;
  for (const cap of ALL_CAPABILITIES) out[cap] = normalizeGateValue(src[cap]);
  return out;
}
```

Rationale for the fail-safe directions (locked design decisions, see §3): unknown **posture →
GUARDED** (D1) and unknown **gate value → Ask** (D2) both bias toward *more* friction, consistent with
the project's "when uncertain, ask" capability-gate philosophy.

### Change 2 — `src/components/GateChip.tsx` : render off the normalized shape + style fallbacks

- **Import** the new helpers: `import { …, normalizePostureWord, normalizeEffectiveGates } from "../gateSurface";`
- **Replace the guard + derive** (current `:82-86`):

  ```tsx
  // BEFORE
  if (!posture || !effectiveGates) return null;
  const gates = effectiveGates;
  const style = POSTURE_STYLE[posture];
  const focused = spotlightActive(gates, isActivePane);
  // AFTER
  const safePosture = normalizePostureWord(posture);
  if (safePosture === null) return null;                    // genuinely absent → no chip (back-compat)
  const gates = normalizeEffectiveGates(effectiveGates);    // TOTAL, validated map (never throws below)
  const style = POSTURE_STYLE[safePosture] ?? POSTURE_STYLE.GUARDED;  // belt-and-suspenders
  const focused = spotlightActive(gates, isActivePane);
  const degraded = posture != null && safePosture !== posture;  // server sent a bad word
  ```

- **Use `safePosture`** everywhere `posture` was used for styling/text (`:89` `data-posture`, `:99`
  the word, `:113` the popover header). Keep `data-posture={safePosture}` so e2e asserts the
  *rendered* word.
- **Popover gate rows** (`:122-136`): replace `const value = gates[cap] ?? "Auto";` with
  `const value = gates[cap];` (already normalized → always valid) and
  `const g = GATE_STYLE[value] ?? GATE_STYLE.Ask;` (hard fallback; with normalization this is
  unreachable, but it makes the component **provably non-throwing** regardless of upstream changes).
- **Degraded tell** (graceful degraded state, eyes-off): when `degraded`, render a tiny
  `data-testid="gate-chip-degraded"` marker in the popover header (e.g. a muted "posture unavailable —
  showing safe default" line). No color alarm; calm.

### Change 3 — `src/components/GateChip.tsx` : a LOCAL error boundary wrapper

Add a minimal class boundary in this file and wrap the chip's exported surface so an *unforeseen*
fault (not just the two known surfaces) degrades to nothing instead of the global fault page:

```tsx
class GateChipBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.error("[GateChip] render fault (degraded to no chip)", e); }
  render() { return this.state.failed ? null : this.props.children; }
}
// Rename the current implementation to GateChipInner; export a thin wrapper:
export function GateChip(props: GateChipProps) {
  return <GateChipBoundary><GateChipInner {...props} /></GateChipBoundary>;
}
```

This is the defense-in-depth layer: even if a *future* edit reintroduces an unguarded lookup, the
blast radius is one chip. **The global ErrorBoundary stays** as the last resort for everything else.

### Change 4 — `src/components/CapabilityMatrixTab.tsx` : normalize the scope map

- **Import** `normalizeEffectiveGates` (and reuse `normalizeGateValue` if convenient).
- **`gatesForScope` (`:61-70`)**: wrap the returned map so a malformed pane payload can't break the
  toggles. Simplest: in the `pane` branch, return `normalizeEffectiveGates(paneGatesFor(scope.paneId))`
  is **wrong** (that would fabricate all-16 Auto and destroy the "no override" semantics). Instead add
  a lightweight `sanitizePartialGateMap(raw): CapabilityGateMap` (also in gateSurface) that keeps only
  keys in `ALL_CAPABILITIES` whose value is a valid `GateValue`, dropping anything malformed — so an
  unknown value in a pane override is **ignored** (falls back to global) rather than crashing or
  showing a phantom selection. Apply it to all three scope branches.
- **`valueOf` (`:82`)** then reads from the sanitized partial map — `current[cap]` is always either a
  valid `GateValue` or `undefined` (the legitimate "no override" state the reset affordance depends on).

> Note: this keeps the pane scope's partial-map semantics intact (absent = "follow global"), only
> stripping *invalid* entries. The matrix never auto-fills 16 values for a pane scope.

### Change 5 — `src/App.tsx` : mock-mode honesty label

At the GateChip mount sites and/or the global mock banner, render a non-representative-demo tag when
`isMockMode` is true. Lowest-touch placement: a small `data-testid="mock-mode-banner"` pill near the
header chip (`src/App.tsx:3076-3082`) reading e.g. "DEMO — gates are mock, not live", gated on
`isMockMode`. No logic change; one conditional span. (If a global mock banner already exists, extend
it; otherwise add this local pill.)

### Change 6 — harness + fixtures : malformed-posture injection hook (test-support only)

- `src/e2e/harness.ts`: add `injectMalformedPosture(posture: string, effectiveGates: unknown)` to
  `OrbitalE2EHooks` (and the wiring block ~`:248`). It re-seeds the mock terminal with an
  **intentionally invalid** `posture` (e.g. `"FROZEN"`) and/or a malformed `effective_gates` (e.g.
  `{ write_to_pane: "Allow" }` or `"not-an-object"`). `?mock=1`-gated; no-op for real users. The
  existing `setPostureMock` is typed to the valid union, so a *separate* loosely-typed hook is needed
  to drive the crash case.
- `e2e/fixtures.ts`: mirror the hook in the `Window.__ORBITAL_E2E__` decl (`:11-22`) and add an
  `injectMalformedPosture(page, posture, gates)` helper (twin of `setPostureMock`, `:84-93`).

---

## 3. Resolved design decisions (chosen option each)

| # | Decision | Options | **Chosen** | Why |
|---|----------|---------|-----------|-----|
| D1 | Unknown posture word → ? | (a) hide chip (b) OPEN (c) LOCKED (d) **GUARDED** | **(d) GUARDED** | Fail-safe middle: never falsely imply "free to act" (OPEN) nor falsely imply "can't type" (LOCKED). Surfaces *some* friction + a degraded tell. Hiding (a) is worse for eyes-off — the safety surface silently vanishes. |
| D2 | Unknown gate value → ? | (a) Auto (b) **Ask** (c) Off | **(b) Ask** | Consistent with "when uncertain, ask." Auto would imply Allowed on bad data (unsafe); Off would over-alarm. |
| D3 | Absent posture (`null`/`undefined`) | (a) GUARDED (b) **render nothing** | **(b) render nothing** | Back-compat: older payloads/mocks legitimately omit posture (`types.ts:99-100`). Coercing absent→GUARDED would paint a chip on every legacy pane. `normalizePostureWord` returns `null` ONLY here. |
| D4 | Boundary granularity | (a) rely on global ErrorBoundary (b) **add GateChip-local boundary** | **(b)** | A peripheral widget must not have app-wide blast radius. Local boundary = lose the chip, keep the cockpit. Global boundary stays as last resort. |
| D5 | Normalization home | (a) inline in each component (b) **pure helpers in gateSurface.ts** | **(b)** | gateSurface is already the frontend-safe single-source-of-truth (header: "single source of truth"), unit-testable with `node:test` (no jsdom). One choke-point, two consumers, fully testable without React. |
| D6 | `effective_gates` non-object/array | (a) treat truthy as map (b) **coerce to all-Auto map** | **(b)** | `normalizeEffectiveGates` rejects non-plain-object/array via `typeof === "object" && !Array.isArray`. Guarantees a TOTAL valid map so no downstream lookup throws. |
| D7 | Pane-scope override with a bad value | (a) crash (b) show phantom (c) **strip invalid keys** | **(c)** | `sanitizePartialGateMap` keeps the partial-map "absent = follow global" semantics; invalid entries are dropped (→ fall back to global) rather than rendered or thrown. |
| D8 | Degraded visual treatment | (a) red alarm (b) **calm muted tell** | **(b)** | Eyes-off polish: a malformed frame is a transient infra hiccup, not an operator emergency. Calm "posture unavailable — safe default" in the popover, no flashing. |

---

## 4. TEST-FIRST plan (failing test first, then implement, then green)

Runners (from the worktree): `npm run lint` (tsc, exit 0) · `npm test` (`tsx --test --test-force-exit
tests/*.ts`) · `npx playwright test e2e/<spec>` (`?mock=1`). Baseline to protect: **478 pass / 0 fail.**
No jsdom/RTL in the repo, so **component crash-safety is proven two ways**: (a) pure unit tests on the
normalizers (the actual logic), and (b) Playwright e2e that injects a malformed payload and asserts the
app *does not* show the fault page (the integration proof that the chip no longer white-screens).

### 4.1 Unit — `tests/test_gate_surface_normalize.ts` (NEW, `node:test`)

Fail-first: the file imports `normalizePostureWord`, `normalizeGateValue`, `normalizeEffectiveGates`,
`sanitizePartialGateMap` from `../src/gateSurface` — which **do not exist yet**, so `tsc` (lint) and
the import fail. Then implement Change 1 to green. Assertions (each maps to a decision):

- `normalizePostureWord`:
  - `"OPEN" | "GUARDED" | "LOCKED"` → identity (3 cases).
  - `"FROZEN" | "open" | "" ` (present-but-bad / wrong-case / empty) → `"GUARDED"` (D1).
  - `123 | {} | [] | true` (non-string) → `"GUARDED"` (D1).
  - `null | undefined` → `null` (D3 — render-nothing signal).
- `normalizeGateValue`:
  - `"Auto" | "Ask" | "Off"` → identity.
  - `"Allow" | "auto" | "OFF"` → `"Ask"` (D2).
  - `null | undefined` → `"Auto"` (legacy default).
  - `5 | {}` → `"Ask"` (D2).
- `normalizeEffectiveGates`:
  - `undefined | null | "x" | 7 | []` → a TOTAL map of all 16 caps, **every value `"Auto"`** (D6).
  - `{ write_to_pane: "Off", close_pane: "Allow", bogus_cap: "Auto" }` →
    `write_to_pane==="Off"`, `close_pane==="Ask"` (bad value coerced, D2), `bogus_cap` **absent**,
    all other 15 canonical caps present and `"Auto"`. Assert `Object.keys(out).length === 16` and
    every key ∈ `ALL_CAPABILITIES` (totality, mirrors the existing §6 totality test style).
  - **Never throws** for any of the above inputs (wrap each in a no-throw assertion).
- `sanitizePartialGateMap`:
  - `{ write_to_pane: "Ask", close_pane: "Allow", bogus: "Auto" }` → `{ write_to_pane: "Ask" }`
    (keeps valid, drops bad-value `close_pane`, drops unknown key `bogus`) — proves the **partial**
    map keeps "absent = follow global" while stripping invalid entries (D7).
  - `undefined | "x" | []` → `{}` (no crash, empty partial).

### 4.2 e2e — `e2e/gate_chip_crashsafe.spec.ts` (NEW, Playwright `?mock=1`)

Depends on Change 6 (the `injectMalformedPosture` harness hook). Fail-first: write the spec against a
hook that doesn't exist yet → the test errors; then add the hook + Changes 2-3 to green.

- **Test 1 — malformed posture word does not white-screen.**
  `gotoMockedApp(page)`; `injectMalformedPosture(page, "FROZEN", ALL_AUTO)`. Assert:
  - the global fault page is **absent**: `await expect(page.getByText("Critical Sandbox Error")).toHaveCount(0)`.
  - the cockpit is alive: `await expect(page.getByTestId("terminal-pane")).toBeVisible()`.
  - the chip degraded safely: `data-posture` is `"GUARDED"` (D1) and the degraded tell renders
    after opening the popover (`gate-chip-degraded` visible).
- **Test 2 — malformed gate value in the popover does not white-screen.**
  Inject `effective_gates: { ...ALL_AUTO, write_to_pane: "Allow" }` with a valid `"GUARDED"` posture;
  open the popover; assert no fault page, popover visible, and the `write_to_pane` row renders a valid
  word (coerced to "Asks first" per D2) rather than crashing.
- **Test 3 — non-object `effective_gates` does not white-screen.**
  Inject `posture: "OPEN"`, `effective_gates: "not-an-object"`. Assert no fault page; chip renders
  `data-posture="OPEN"`; popover lists all 16 rows (all coerced to Auto/"Allowed" per D6).
- **Test 4 — happy path unchanged (regression guard).**
  Re-run an existing assertion shape: `setPostureMock(page, "OPEN", ALL_AUTO)` → `data-posture="OPEN"`,
  no degraded tell. Proves normalization is transparent on good data.

### 4.3 e2e — `e2e/mock_mode_label.spec.ts` (NEW or fold into existing) — Change 5

- `gotoMockedApp(page)` → `await expect(page.getByTestId("mock-mode-banner")).toBeVisible()` and it
  contains a "demo"/"not live"/"mock" string. (Real mode has no such banner — not asserted here since
  the harness is always mock; the presence-under-mock assertion is the contract.)

### 4.4 Regression battery (must stay green, no new failures)

- `tests/test_gate_surface.ts` (19) — unchanged behavior; normalizers are additive.
- `e2e/gate_chip.spec.ts` (existing) + `e2e/capability_matrix.spec.ts` — must stay green (Change 2/4
  are transparent on valid input).
- Full `npm test` ≥ 478 pass / 0 fail; `npm run lint` exit 0; `npx playwright test` green.

### 4.5 Order of operations (TDD)

1. Write `tests/test_gate_surface_normalize.ts` → run `npm test`, confirm it **fails on missing
   imports** (right reason). 2. Implement Change 1 → green. 3. Write `e2e/gate_chip_crashsafe.spec.ts`
   → run, confirm it **fails** (missing hook / current code white-screens — verify it actually hits the
   fault page before the fix, the worthwhile-failure check). 4. Implement Changes 2-3-6 → green.
5. Implement Change 4 (+ extend unit test for `sanitizePartialGateMap`) → green. 6. Implement Change 5
   + its e2e → green. 7. Full battery + lint + build.

---

## 5. Risks & mitigations

- **R1 — `data-posture` semantics shift.** Existing `e2e/gate_chip.spec.ts` asserts
  `data-posture` equals the seeded word. We render `safePosture`, which is identical for valid input,
  so those tests stay green. *Mitigation:* keep `data-posture={safePosture}`; Test 4 pins the happy
  path. **Low.**
- **R2 — Local boundary masks a real bug.** A GateChip-local boundary could hide a genuine logic
  defect by silently dropping the chip. *Mitigation:* `componentDidCatch` logs `[GateChip] render
  fault` to console; the normalizers make the *known* surfaces unreachable, so the boundary only ever
  fires on a genuinely *new* fault — which we then see in logs. **Low.**
- **R3 — lockstep drift with `pendingApprovals.ts`.** gateSurface mirrors the server resolver
  (file header §13-16). The normalizers are *new* surface-only concerns (no server twin needed) —
  they don't touch precedence, so no lockstep obligation is created. *Mitigation:* document in the
  function comments that these are presentation-normalizers, not policy. **Low.**
- **R4 — Over-coercion hides a server bug.** Silently coercing `"Allow"→"Ask"` could mask a real
  server serialization regression. *Mitigation:* the degraded tell (`gate-chip-degraded`) + the
  console log surface that *something* arrived malformed without crashing; this is the right tradeoff
  for an eyes-off director (visible-but-non-fatal beats white-screen). **Accepted.**
- **R5 — Mock banner clutter.** A demo pill could crowd the header. *Mitigation:* tiny, muted,
  `isMockMode`-only; invisible in production. **Low.**
- **R6 — No jsdom for component unit tests.** Can't unit-test the JSX render directly. *Mitigation:*
  the *logic* is fully unit-tested in the pure normalizers (§4.1); the *render* crash-safety is
  proven by Playwright (§4.2). This split mirrors the existing 8sq test strategy (pure unit +
  Playwright, no RTL). **Accepted.**

---

## 6. Acceptance criteria (maps to bead, scoped slice)

- [ ] A malformed posture word (`"FROZEN"`/wrong-case/non-string) **never** white-screens the app:
      no "Critical Sandbox Error" page; cockpit + `terminal-pane` stay visible; chip degrades to
      `data-posture="GUARDED"` with a calm degraded tell (D1/D8). *(e2e Test 1)*
- [ ] A malformed gate value (`"Allow"`/lowercase) in the popover **never** white-screens; the row
      renders a valid coerced word ("Asks first", D2). *(e2e Test 2)*
- [ ] A non-object/array `effective_gates` **never** white-screens; chip + 16-row popover render
      (all coerced Auto, D6). *(e2e Test 3)*
- [ ] Happy-path rendering is byte-unchanged for valid payloads (no degraded tell on good data).
      *(e2e Test 4 + existing gate_chip/capability_matrix specs stay green)*
- [ ] `normalizePostureWord` / `normalizeGateValue` / `normalizeEffectiveGates` /
      `sanitizePartialGateMap` are pure, total, and **never throw** for any input; full unit coverage
      of the decision table. *(unit suite §4.1)*
- [ ] GateChip is wrapped in a local error boundary: an unforeseen render fault degrades to **no
      chip**, not the global fault page; the global `ErrorBoundary` remains for everything else (D4).
- [ ] `CapabilityMatrixTab` pane scope strips invalid override entries (keeps partial-map "follow
      global" semantics), never crashes on a malformed pane payload (D7).
- [ ] Mock mode is labeled non-representative (`mock-mode-banner` visible under `?mock=1`). *(§4.3)*
- [ ] `npm run lint` exit 0 · `npm test` ≥ 478 pass / 0 fail (no regression) · `npx playwright test`
      green · `npm run build` clean.
- [ ] No stop-all / frozen / `applyFrozenShortCircuit` symbol introduced (stays out of n2r; that's
      `wsm-e2e-pinned-ms7`).

---

## 7. Out of scope (explicit, this pass)

- Distinct earcons (approval_pending vs command_blocked), `gate_changed` announcement,
  `announcementKinds.ts` KIND_META — separate n2r sub-items, not the crash-safety slice.
- a11y `role="dialog"` / `aria-modal` / `aria-live` on the two gate modals + auto Notification request
  — separate n2r sub-item.
- Crash-safe PTY reaping (`uncaughtException`/`unhandledRejection` draining spawned PTYs) — server
  concern, separate n2r sub-item.
- The stop-all / frozen subsystem (bead `wsm-e2e-pinned-ms7`).
- Any server-side payload validation (this is a client-robustness pass only).
