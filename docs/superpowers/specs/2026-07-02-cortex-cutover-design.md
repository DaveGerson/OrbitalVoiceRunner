# Wave 4 Design: The Cortex Cutover — Curation Policy, Inject Gate, Migration to Primary

Operator-approved design (2026-07-02 brainstorm) for the cortex-brain wave:
`wsm-e2e-pinned-qky` (curation policy), `wsm-e2e-pinned-e6s` (outcome-triggers + inject-gate),
`wsm-e2e-pinned-icn` (hysteresis callable), `wsm-e2e-pinned-4ey` (stale snapshot state),
`wsm-e2e-pinned-896` (the flip). `wsm-e2e-pinned-z5c` (session management) is **deferred**
to its own brainstorm.

Parent spec: `docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md` (SHADOW
scaffold, locked decisions). Seam ADR: `docs/design/2026-06-19-python-ts-seam.md`.

## Empirical basis

PR #121's telemetry, read 2026-07-02 (`npx tsx scripts/context-metrics-report.ts`):
**495 injections, `briefHashRepeatRate` = 0.994** — 99.4% of injected briefs were
byte-identical to the previous one. Redundant re-sends are the dominant waste today, and
adding command-outcome triggers without a gate would multiply injection frequency straight
into that redundancy. The diff-gate is therefore the load-bearing piece of this wave, not
polish. (All 495 rows are `session_start`; `skippedByDisposition` is empty because dedupe
was metric-only in #121 — the schema already has the skip columns this wave fills.)

## Operator decision record (binding, 2026-07-02)

1. **e6s inject-gate**: diff-gated change-detector + debounce floor. Inject only if the
   composed brief's hash changed since the last *injected* brief AND ≥3s (default) since the
   last injection; `session-start` bypasses both checks. Rejected: debounce-only (still
   re-sends the measured 99.4% redundancy), significance-filter (judgment-laden rule table —
   YAGNI while the diff-gate is unproven in prod).
2. **qky curation policy**: **trigger-aware profile table** — a fixed, deterministic profile
   per trigger. `session-start` = full brief; `pane-switch` = active-pane-first;
   `command-outcome` = outcome-frame leads. Matches the "live/streaming feel" the operator
   chose for triggers on 2026-06-27. Rejected: uniform single profile (dulls the streaming
   feel), delta-only re-injects (bets on Gemini retaining prior context — contradicts the
   weak-working-memory premise the cortex exists to fix).
3. **896 flip = test-then-migrate** (the WS-M SQLite lifecycle: parity → evaluative testing →
   cutover → simplify). The trust gate is **the journey/smoke battery running with cortex
   primary ON** — not a runtime trust-dossier. Battery green + live smoke → **primary becomes
   the default in this wave**. `JANUS_CORTEX_PRIMARY=0` is the escape hatch (the
   `JANUS_LEDGER_BACKEND=legacy` analog); unset or `1` = primary.
   **This retires the standing "cortex primary never default-on" constraint** — operator-
   ratified 2026-07-02 ("perform evaluative testing using our journey smoke tests … then flip
   the migration to simplify the workflow"; "python cortex should aim to be the primary").
4. **One brain, not two**: post-migration the cortex decides (keep/drop/rerank + budget) and
   the TS synthesizer is a *renderer* in both paths. The "floor" is "render in default order
   when no decision arrives" — per-call, fail-closed, permanent. There is no second decision
   engine to maintain or retire later.
5. **Accepted trade-off — bounded blocking**: shadow was fire-and-forget; primary awaits the
   cortex, raced at 300ms (the `policyClient` idiom). Injection is per
   session-start/pane-switch/outcome — never per keystroke — and a warm daemon answers in
   single-digit ms. A miss costs at most 300ms once and falls to the floor for that call.
6. **z5c deferred** — session/connection management is a different arc (lifecycle/failover
   policy) sharing only the daemon; it gets its own brainstorm. Bead stays open.

## Design

### D1. Command-outcome trigger (e6s, TS side)
The observe layer's existing command-completion detection fires a fourth trigger,
`command-outcome`, into the same `injectMemoryBrief` path as today's three
(`session-start` / `pane-switch` / `catch-up`). No new transport, no new state store. The
trigger carries the affected paneId so the profile can lead with it.

### D2. Inject gate (e6s, TS side — the choke point)
The gate lives in TS at `injectMemoryBrief`, per the seam ADR's hot-path column: a per-event
hash compare + timestamp check, synchronous and fail-closed. It runs **before** any cortex
call — the gate hashes the **input tier snapshot** (the `_lastSnapshotHash` machinery from
the shadow slice), so a skipped event costs zero Python round-trips. Because `cortex.decide`
is deterministic (I-P4), unchanged input ⇒ unchanged brief; an unchanged world arriving under
a different trigger label is not new information and intentionally skips.

- **Skip `unchanged-brief`**: snapshot hash equals the hash at the last *injected* brief.
- **Skip `debounce`**: snapshot changed but < the config floor (default 3000ms) since the
  last injection. No trailing-edge timer in this wave — the next trigger re-evaluates
  (outcome events are bursty; a trailing re-check is a noted follow-up, YAGNI).
- **`session-start` bypasses both** (a fresh Gemini session has empty context by definition).
- Every skip is recorded to the existing telemetry columns
  (`skippedByDisposition: 'unchanged-brief' | 'debounce'`). Expected post-land: repeat rate
  on *injected* rows collapses from 0.994 toward ~0.

### D3. Curation profiles (qky, Python side)
`python/synthesizer/cortex.py` replaces the `baseline-identity` strategy with a fixed,
deterministic profile table keyed by `ctx.trigger`. Normative rules (exact per-tier rows are
pinned by the implementation against the real `MemoryTiers` struct and reviewed in the trace
goldens):

- `session-start`: keep all non-empty tiers, canonical full order, full char budget.
- `pane-switch`: active-pane tier first; background-pane content trimmed hardest on overflow.
- `command-outcome`: outcome frame first, affected pane next; stale/unaffected tiers dropped
  first on overflow.
- `catch-up`: full order like session-start (re-orientation), budget per session-start.
- Budget: **the cortex owns the char budget** (locked 2026-06-27) — each profile allocates
  per-tier caps; overflow trims lowest-priority-first within the profile's order.
- Trace: `strategy: "profile:<trigger>"`, `ruleFired` per decision, dropped tiers listed with
  the rule that dropped them. Over-document every row (locked 2026-06-27).
- Empty/hostile tiers never raise; unknown trigger falls back to the `session-start` profile
  with a trace note.

### D4. Hysteresis callable (icn) — pure core, external state
Locked 2026-06-27: decision-memory lives in the memory/context module, NOT the cortex core.

- TS (`src/memory/`) keeps a small ring buffer of the last **K=8** decisions
  `{droppedTiers, trigger, ts}` and passes it into `cortex.decide` as `ctx.history`.
- Python rule: a tier dropped within the last **3** decides is not re-surfaced unless the
  trigger is `session-start` OR the tier's content hash changed since the drop (a "strong
  trigger"). Parameters `RESURFACE_FLOOR_DECIDES=3`, `HISTORY_K=8` are named constants with
  rationale comments — reviewable defaults, not magic numbers.
- The core stays pure: identical `(tiers, ctx, now)` → identical decision. History is input,
  never retained daemon-side.

### D5. The migration (896 + 4ey)
- **Apply path**: in primary mode, `injectMemoryBrief` awaits `cortex.decide` raced at
  300ms. On `ok`, the synthesizer renders per the ordered keep + budget. On any miss
  (timeout / error / off-schema / daemon dead), it renders today's default composition —
  byte-identical to the pre-cortex baseline — and records disposition `cortex-miss`.
- **Mode**: `JANUS_CORTEX_PRIMARY` unset or `1` → primary; `0` → floor-only plus the
  existing shadow observation (diagnostics preserved). Boot-time read, unchanged.
- **4ey fix**: snapshot/hysteresis bookkeeping (`_lastSnapshotHash`, `_lastCortexFiredAt`,
  the D4 ring buffer) advances in BOTH modes — state updates happen before the mode branch,
  so a future runtime toggle can never inherit stale state.
- **Telemetry**: report gains `cortexPrimaryRate` and `cortexFallbackRate`
  (`cortex-miss` / injections). Post-land health check: fallback <1% on a warm daemon.

### D6. Config
The debounce floor joins the existing settings surface as one number
(`contextInjectDebounceMs`, default 3000) with the same PUT validation + unknown-key
stripping idiom as `voiceUx`. Profile tables and hysteresis constants are code, not config —
YAGNI until an operator need shows up.

### D7. Testing (the trust gate — this IS the flip criterion)
- **Python pytest**: each profile (order, budget, drops) deterministic against fixtures;
  hysteresis rule (dropped-recently suppressed, strong-trigger override); hostile input
  (empty tiers, unknown trigger, malformed history) returns, never raises; dispatch survives
  bad `ctx.history` (`CORTEX_FAILED`, other ops still answer).
- **TS unit**: inject gate under fake timers (unchanged-hash skip, debounce skip,
  changed-hash inject, session-start bypass, disposition recording); apply-path byte-parity
  (cortex dead/slow/erroring → brief identical to baseline — I-P1 repurposed as the floor
  invariant); 4ey regression (state advances in primary mode).
- **Journeys** (mockLive, in-proc): the full existing journey suite runs with primary as the
  default — CI itself becomes the battery. New journeys: daemon killed mid-session → floor
  takes over on that call, loop uninterrupted; command-outcome → gate → inject round-trip;
  brief redaction-clean under cortex composition (every string still through the redaction
  pass); decision determinism across identical snapshots.
- **Live smoke** (`npm run smoke:claude` + live e2e) green before merge, per the standing
  done-pipeline.
- Existing parity tests that assert shadow-mode byte-identity are updated to assert the
  **floor** invariant instead (they were the SHADOW slice's contract; the contract this wave
  is "miss ⇒ baseline bytes").

### D8. Non-goals (this wave)
z5c session management; runtime flag toggling; significance-filtering or trailing-edge
debounce re-checks; any capability-gate/approval semantic change (locked posture: cortex
proposes, TS gate disposes — untouched); persistence of the hysteresis ring buffer across
restarts.

## Hard constraints (standing project rules)
Panes boot inert; no live API keys in tests; redaction invariants preserved (every injected
string through the redaction pass regardless of who composed it); complexity gates (CC ≤ 10 /
cognitive ≤ 15, zero suppressions) are hard errors; TDD for behavioral changes; beads claimed
on start, closed with provenance on land.
