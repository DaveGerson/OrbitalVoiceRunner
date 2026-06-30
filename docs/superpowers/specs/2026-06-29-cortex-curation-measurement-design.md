# Cortex Curation + Measurement Spine — B-3 v0.2.0 Design

- **Date:** 2026-06-29
- **Status:** Approved (brainstorm), ready for implementation plan
- **Seam plan:** `docs/superpowers/plans/2026-06-27-seam-completion-plan.md` (task B-3)
- **Flip readiness:** `docs/superpowers/plans/2026-06-29-cortex-seam-flip-readiness.md`
- **Cortex SHADOW design:** `docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md`

---

## BLUF

B-3 ships **dumb-but-safe curation rules** plus a **measurement spine** that marries every
cortex curation action to the Gemini turn it shaped — response **and token cost**. The rules
stay minimal on purpose: we lack the expertise to curate aggressively, and Gemini Live is a
"dumber" TTS-class model whose context management we can only tune with data we don't have yet.
The spine is how we earn that data, so v0.3.0 rules are evidence-driven, not guessed.

## Why this shape (operator direction)

- **Gates are GUI-only / user-direct.** The emergency brake stops the REST API from firing; it
  must NOT reshape what the engine remembers. The agent only needs *awareness* it's frozen, which
  the always-kept `frame` tier already carries. → no `frozen-posture` rule.
- **Coarse status/time signals can't judge relevance.** An *idle* pane often means a task *just
  finished* — peak relevance. Confidently deciding otherwise needs log/content analysis (a future
  layer). → keep idle panes; only drop the *unambiguously dead*.
- **Instrument first, optimize later.** Curation quality, conversation quality, and token cost all
  need close measurement before we can tune. Ship a starting point we can build on; don't
  overcomplicate.

---

## Part 1 — Minimal curation rules (`cortex.decide`, v0.2.0)

Bump `CORTEX_VERSION → "0.2.0"`. Replace the single `baseline-identity` strategy with a small,
ordered ladder evaluated in `python/synthesizer/cortex.py`:

1. **`exited-pane`** — when the active pane's `status == "Exited"` (process dead), drop the `pane`
   detail tier (its "running X / last: Y" is stale/misleading). `keep = [project, breadcrumbs,
   board, frame]`. The board still lists the pane, so its existence is never lost.
2. **`baseline-identity`** — default: keep all present tiers in canonical order, no drops, no
   rerank (today's behavior).

**Deliberately NOT in v0.2.0** (documented so the omission is a decision, not an oversight):
- No `frozen-posture` (gates are GUI/user-controlled; awareness via `frame` suffices).
- No idle-pane drop (idle ≈ "just finished" ≈ relevant; needs log analysis to judge).
- No `post-approval-focus` rerank (marginal impact on a fully-injected brief; trivial later add).
- No content/log-aware relevance (the future "smart" layer this spine exists to inform).

`frame` remains structurally always-kept (the renderer has no null-frame guard; already enforced
by the FLIP filter in `src/memory/cortexShadow.ts`).

## Part 2 — The measurement spine (the real deliverable)

Every `cortex.decide` already emits a structured `trace` (`ruleFired`, `output.orderedKeep` /
`dropped`, `inputs.tierChars`, `shadowBudget.{perTierChars,textLen}`). The spine makes that trace
**joinable** to the Gemini turn it shaped and the tokens that turn cost.

1. **Correlation key.** A per-injection `injectId` (monotonic counter or short id) is minted once at
   `injectMemoryBrief` (`src/voice/index.ts`) and threaded through, alongside `sessionId`,
   `activePaneId`, and `ts`. This is the join spine.
2. **Persist the decision.** `observeCortexShadow` writes the cortex decision record (the trace +
   the correlation key) to the durable store — reusing the existing `action_log` infrastructure
   (`src/store/`) as a `cortex.decide` record (or a sibling table if the schema is cleaner), so it
   inherits timestamping, retention, and query for free.
3. **Stamp the injection.** The injected brief is logged with the same `injectId` (the brief that
   actually entered Gemini), so *decision ↔ injected brief* join exactly.
4. **Capture token cost (the one net-new hook).** At the Gemini Live event boundary in
   `src/voice/`, capture per-turn `usageMetadata` (prompt/response/total token counts) and persist
   it keyed by `sessionId + ts`, joined to the nearest preceding `injectId` by time. Token usage is
   currently surfaced UI-only (no backend persistence); this closes the loop to **cost**.

**Result — an offline-joinable dataset:** *"@T the cortex (would-)drop `pane` (−N chars, rule
`exited-pane`) → brief `injectId=k` injected → Gemini turn used M tokens."* That is the evidence
base for v0.3.0 rules.

## Part 3 — SHADOW vs FLIP measurement semantics

- **SHADOW (today, flag default-off):** the decision is logged but not applied. The record is the
  **counterfactual** ("would have dropped `pane`, would have saved N chars") correlated to the real
  full-brief turn → sizes the curation opportunity at **zero risk**.
- **After FLIP (`JANUS_CORTEX_PRIMARY=1`):** the decision is applied; the record is the **realized**
  curation correlated to the turn → measures actual cost/quality impact. The flip becomes a
  *measured experiment*, not a leap of faith.

The spine is identical in both modes; only the meaning of "the brief that was injected" changes
(full vs curated). A `source` field (`fallback` / `python` / `cortex-primary`) already distinguishes
them on the brief.

## Part 4 — How it builds into the seam

- **Sits on the existing SHADOW tap.** Measurement rides `observeCortexShadow` (fire-and-forget),
  so it inherits the B-6 hysteresis guard and the I-P1..I-P3 parity invariants — it can never affect
  `synthesizeAsync` or the rendered brief.
- **Feeds the B-1 activation decision.** The shadow counterfactual sizes the divergence the
  flip-trust-threshold gate (`|Δ textLen|/textLen < 5%`) is measured against.
- **Feeds the B-4 RETIRE gate.** The realized records (post-flip) are how `cortexFallbackRate ≈ 0`
  and "curation helped, not hurt" get confirmed over the operator window before `synth.py` is deleted.
- **The drift tripwire still holds.** The B-5 golden (`cortex_decide_golden.json`) + the parity
  battery regenerate against the new `0.2.0` traces; any shape change goes red before boot.

---

## Components & boundaries

| Unit | Lives in | Responsibility | Depends on |
|---|---|---|---|
| Curation ladder | `python/synthesizer/cortex.py` (`_apply_rules`) | Pure: `(tiers, ctx, now) → decision` | stdlib only |
| Decision persistence | `src/memory/index.ts` (`observeCortexShadow`) | Write the trace+key to the store | store, cortex client |
| Correlation key | `src/voice/index.ts` (`injectMemoryBrief`) | Mint `injectId`; thread it | — |
| Token capture | `src/voice/` (Gemini Live event handler) | Persist per-turn `usageMetadata` under the key | store |
| Store records | `src/store/` (schema + writer) | Durable, retained, queryable rows | SQLite |

Boundary respected: **Python owns the decision; TS owns the I/O shell + persistence.** Curation is
not a hot path (per brief-inject, not per keystroke/frame), so the existing stdio round-trip is fine.

## Data flow

```
injectMemoryBrief(mint injectId)
  ├─ synthesizeAsync ─→ brief (source: fallback|python|cortex-primary) ─→ Gemini  ──┐
  ├─ observeCortexShadow(injectId) ─→ cortex.decide ─→ trace ─→ store[cortex.decide] │ (join by
  └─ (brief logged with injectId) ──────────────────────────────────────────────────┤  injectId,
Gemini turn-complete ─→ usageMetadata ─→ store[token_usage keyed sessionId+ts] ──────┘  sessionId+ts)
```

## Error handling

- Measurement is **fire-and-forget and never-throws** — a store write failure or a missing
  `usageMetadata` is swallowed (logged to stderr), never blocking injection or the voice turn.
- SHADOW invariants I-P1..I-P3 unchanged: the decision is observed, never applied (flag-off).
- `cortex.decide` failures surface as `CORTEX_FAILED` (existing dispatch contract); the record is
  simply absent for that turn.

## Testing

- **Python:** extend `test_cortex.py` — `exited-pane` drops `pane` and keeps the rest; non-Exited
  status → identity; `CORTEX_VERSION == "0.2.0"`. Regenerate `cortex_decide_golden.json` (B-5) and
  the parity battery against 0.2.0; the drift tripwire must go red on a mutated trace.
- **TS:** `observeCortexShadow` writes exactly one decision record per (non-hysteresis-suppressed)
  inject, carrying the `injectId`; a store-write throw does not surface; I-P1..I-P3 stay green.
  Token-capture: a turn with `usageMetadata` persists one row under the correlation key; a turn
  without it is a no-op.
- **Gates:** `npm run lint && npm run complexity && npm test`, `py -3 -m unittest`.

## Out of scope / future (explicitly deferred)

- `post-approval-focus` rerank (fork ② — excluded from v0.2.0).
- Idle-recency drop (needs a `lastActivityTs` signal).
- Content/log-aware relevance — the "smart" curation layer this spine exists to inform.
- Analytics/measurement tooling (dashboards, joins-as-a-query) — we ship the *records*, not the
  analysis surface.

## Forks resolved (from the brainstorm)

- **① Token capture: IN.** Per-turn `usageMetadata` persisted under the correlation key now — it's
  what makes the cost-marriage real, and token cost is the headline metric.
- **② `post-approval-focus`: OUT** of v0.2.0. The spine demonstrates correlation on its own; the
  rerank is a trivial later add.
