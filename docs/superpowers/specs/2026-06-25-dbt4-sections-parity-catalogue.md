# dbt4 App.tsx decomposition — section-components parity catalogue

**Effort:** the final dbt4 wave — decompose the `AppRaw` god-component's render tree into focused
`src/classic/components/` units. **Pure architectural refactor: zero intended end-user behavior change.**

**Result:** `src/App.tsx` **3,201 → 1,339 lines (−1,862, −58%)** across **7 chunks**, each its own
PR, each gated by up-front tests → adversarial review → Windows-local E2E/pixel parity → green CI
before merge. Builds on the earlier hooks/keystone waves; `src/classic/` now holds **24 components,
8 helpers, 7 hooks**.

## The safety contract (why "nothing changed" is trustworthy)

Every chunk passed, first-hand on Windows, before merge:

| Layer | Tool | What it proves |
|---|---|---|
| **Adversarial byte-fidelity review** | fresh reviewer agent, read-only `git diff` | the moved JSX is char-identical (testids, keys, guards, classNames, rendered text) |
| **Characterization** | `node:test` (`tsx --test`) | each pure derivation hoisted out of a section is byte-exact, both/all branches pinned |
| **E2E view parity** | 178-case Playwright mock lane (`?mock=1`) | the visible DOM around every named testid is unchanged |
| **Pixel parity** | Playwright same-machine before/after (opt-in, win32) | no visual drift the DOM assertions miss |
| **Type/complexity** | `tsc --noEmit`, eslint (CC ≤ 10 / cognitive ≤ 15 / rules-of-hooks, 0 suppressions) | no type regression; AppRaw complexity drops as IIFEs become `<Component/>` nodes |

### The harness contract (the load-bearing invariant)

`App.tsx` threads a setter bag into `useE2EHarness` **and** `dispatchWsMessage`:
`setPendingCommands, setPendingActions, setActiveTerminalId, setTerminals, setFrozen,
setFrozenRunning, setLedger, setIsMicMuted, setTranscript`. **Rule honored in every chunk:** any
extracted component that uses one of these receives it as the **same callback reference**, passed
straight through — never wrapped, renamed, or recreated. The boot effects, the 20s poll, every
mutation handler, the `useE2EHarness` wiring, and the derived-value glue **stay in `App.tsx`** and
are passed *down* as props. Drift here silently desyncs the harness/WS path; the reviews verified it
explicitly each time.

---

## The 7 chunks

| # | PR | Chunk | Components | App.tsx | Headline parity proof |
|---|----|-------|-----------|---------|----------------------|
| 1 | #100 | warmup-leaves | `GenericPromptModal`, `ToastNotificationStack`, `FrozenBanner`, `MobileNavBar` | 3201→3117 | pixel: FROZEN banner 0-diff; mock-e2e toast/nav |
| 2 | #101 | composer-cluster | `PromptSynchronizerPanel` (+4 internal sub-closures), `HelperPanelTabHeader` | 3117→2934 | mock-e2e all 6 `draft_badge` (U3) specs |
| 3 | #102 | telemetry-voice-transcript | `TerminalHealthHeatmap`, `SynergyMatrixPanel`, `TranscriptPanel`, `SystemStatusBar` | 2934→2539 | mock-e2e `transcript`+`voice_grounding`; **voice-label trap caught** |
| 4 | #103 | sidebar-swiper | `WorkspaceSidebar`, `MobileTerminalSwiperBar` | 2536→2338 | **bespoke sidebar pixel before/after 2/2 0-diff** (AnimatePresence) |
| 5 | #104 | modal-queues + header | `ApprovalQueue`, `ActionConfirmQueue`, `AppHeader` | 2338→2166 | pixel: approval + action dialogs 0-diff (direct) |
| 6 | #105 | terminal/dashboard chrome | `ActivePaneHeaderBar`, `PaneHistorySidebar`, `DashboardHeader`, `ArtifactsRegistryPanel`, `ArchivePanel` | 2166→1767 | mock-e2e archive Restore + pane exit/back-to-grid; `gate-chip-header` |
| 7 | #106 | pane-grid (atomic) | `PaneGridSection` (4 mode cards + empty state) | 1767→1339 | **bespoke grid pixel before/after 0-diff** (AnimatePresence popLayout) |

*(Chunk 3 + chunk 1 also folded in `SystemStatusBar`/`MobileNavBar` that an earlier reader had
mis-scoped; chunk 1 promoted `GenericPromptModal` first so chunk 5's queues didn't reach into App scope.)*

---

## Characterization test catalogue (each test's intent)

Every section that carried inline pure logic had that logic hoisted to a tested helper **before** the
move. JSX is never characterized — only the pure decision inside it.

| Test file | Helper(s) pinned | Intent — the decision that must not drift |
|---|---|---|
| `tests/test_toast_logic.ts` | `rawKeyToneContainerClass/TitleClass/Glyph` | raw-key toast tone → amber/⏳ (deferred) vs red/⛔ (else); both branches |
| `tests/test_composer_draft_pending.ts` | `computeDraftPending` | `sync-spec-draft-badge` predicate (`buffer.trim()` OR any WIP); **intentionally ≠ the mobile-nav dot** |
| `tests/test_telemetry_voice_transcript.ts` | `voiceAgentStatusLabel`, `specBufferBadge`, `heatmapSnippetLines`, `transcriptSourceLabel` | the Synergy AGENT STATUS strings (+ a loop asserting they **never** collapse to the header's distinct `geminiVoiceLabel`); spec-buffer char count; heatmap tail; grounding source label |
| `tests/test_app_header_derivations.ts` | `headerStatusDotClass`, `headerRunningCount` | brand live-status dot (3 branches); running count with the load-bearing `\|\|` alive-pane fallback |
| `tests/test_app_registry_history.ts` | `isPaneLive`, `historyEntryIsSelected` | Active-RAM vs Idle-Registry badge; history row selection (command+timestamp, null-safe) |
| `tests/test_pane_grid_logic.ts` | `paneHasPendingCommand`, `isRecentlyIdled`, `tailOutputLines`, `chooseChronicleSource` | card `isAlertActive`; idle heartbeat; videowall output tail; detailed-card note-chronicle source precedence |

## Pixel-parity specs (opt-in, `PIXEL_PARITY=1` + win32; baselines gitignored)

Bespoke before/after specs were added for the chunks whose surfaces have **no testids** and carry
**framer-motion `AnimatePresence`** (the top visual-drift risk). Same-machine: baseline on
pre-extraction code, re-compared after the move; 0 diff == parity.

| Spec | Surfaces | Why bespoke |
|---|---|---|
| `e2e/ledger_data_pixel_parity.spec.ts` *(prior wave)* | boot cockpit, FROZEN banner, approval modal, action dialog | reused every chunk as a collateral-drift guard; directly proves chunks 1 & 5 |
| `e2e/sidebar_pixel_parity.spec.ts` | `WorkspaceSidebar` default + active-pane | sidebar has no testids; `AnimatePresence initial={false}` `key={pane.pane_id}` is load-bearing |
| `e2e/grid_pixel_parity.spec.ts` | dashboard grid (compact cards) | grid container has no testid; `AnimatePresence mode="popLayout"` + highest closure capture |

**Why a static snapshot is enough:** these specs capture the *settled* frame and guard
layout/className drift. The `AnimatePresence` **key-reconciliation** correctness (enter/exit
animation identity) is guarded separately by the adversarial byte-fidelity review, which verified
`key={pane.pane_id}` and the `AnimatePresence` props were preserved verbatim on the same element.

## Honest caveats

- **Pixel coverage is targeted, not exhaustive.** Bespoke pixel was added where DOM assertions are
  thin (sidebar, grid). For most chunks the primary "E2E view parity" net is the 178-case mock lane
  (DOM around every testid) + byte-fidelity review; pure JSX-move extractions with verified
  byte-identical class strings make additional pixel low-marginal-value.
- **Grid pixel snapshots compact mode only** (the default, and the riskiest card — `raw-key-bar-grid`
  + `writeControlKeyFromGrid`). The other three card modes are covered by the mock-e2e DOM lane and
  the atomic extraction (all 4 renderers move together by one mechanism).
- **One behavior-neutral cast** (chunk 5, `ApprovalQueue`): `rationale` is passed with a
  compile-time narrowing because `PendingCommand.rationale.trigger` is optional while `ApprovalDialog`
  requires it; the **runtime value is identical** to the inline original, so DOM is unchanged.
- **7 pre-existing unused lucide imports** remain in `App.tsx` (line 12). They predate this entire
  effort (not orphaned by any chunk), so they were left out of scope; a future cleanup pass can prune
  them. Imports each chunk's *own* extraction orphaned were removed in that chunk.

## Reproduce

```bash
npm run lint                       # tsc --noEmit
npm run complexity                 # eslint CC<=10
npm test                           # full unit incl. the 6 char files above
npm run test:e2e                   # 178-case mock lane (pixel specs skip)
PIXEL_PARITY=1 npx playwright test ledger_data_pixel_parity sidebar_pixel_parity grid_pixel_parity   # win32, after writing baselines on pre-extraction code
```
