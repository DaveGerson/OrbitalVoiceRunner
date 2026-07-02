# Wave 3 Design: Conversational Voice UX — SITREP, Focus Resolver, Spoken Confirm

Operator-approved design (2026-07-02 brainstorm) for the three P1 epic leads:
`wsm-e2e-pinned-hwu.1` (get_status_summary), `wsm-e2e-pinned-8fz.1` (conversational-focus
resolver), `wsm-e2e-pinned-f09.1` (spoken confirm protocol). Architecture **Approach B**:
Python owns the ranking/scoring policies (per the 2026-06-19 Python⇄TS seam ADR), TypeScript
owns session state, transport, rendering, and the safety-critical confirm protocol.

## Operator decision record (binding)

1. **SITREP shape**: prioritized, needs-action first, then the review pass. Shape/verbosity is
   an operator config preference. A follow-up "action panel" (`wsm-e2e-pinned-hwu.7`) will later
   render the same composed payload visually — the composer must be renderer-agnostic.
2. **Focus binding**: editable config; **default = confirm before any fuzzy bind**. Exact unique
   matches bind silently. Ambiguity asks, listing top 2–3 candidates.
3. **Confirm phrase**: action-echo phrase + timeout. Verbatim read-back, then the action word
   ("confirm delete") required within ~10s; bare "yes" rejected for the destructive class with
   one re-prompt; silence auto-cancels the spoken prompt.
4. **Approach B** over all-TS / TS-behind-interfaces: fuzzy scoring and urgency ranking are
   textbook non-hot policy evaluation (Python column of the ADR); the stdio bridge already sits
   in the live path (synthesizer precedent).

## Design

### D1. One focus, not two
`focus_pane(reference)` resolves speech to a pane id and routes through the EXISTING
setActivePane path. Conversational focus **is** the active pane — no per-session
`focusedPaneId` shadow state (deliberate deviation from the bead's literal seam sketch).
Every existing wrong-pane write guard remains the enforcement layer, unchanged.

### D2. Python policy callables, TS shell
New `python/policies/` daemon on the exact stdio-JSON pattern (`src/memory/pythonClient.ts` ⇄
`python/<module>/__main__.py`, one JSON object per line — do NOT invent a second transport).
Two callables, one file each:
- `resolve_focus(reference, candidates[]) → {paneId|null, confidence, alternatives[]}`
  (`python/policies/focus.py`)
- `rank_sitrep(payload) → ordered sections, needs-action first` (`python/policies/sitrep.py`)

Every TS→Python call is timeout-bounded (~300 ms) with **fail-closed TS fallbacks**: focus
degrades to exact/prefix literal matching + spoken clarify; SITREP degrades to a fixed
deterministic order (approvals → busy panes → attention → idle). A dead daemon dulls the
experience; it never kills the voice loop and never widens matching.

### D3. get_status_summary (hwu.1)
TS composer gathers pane metadata + elapsed, pending approvals, attention digest, and
executing-plan progress into one structured payload. Python ranks it; a pure TS renderer
produces the spoken text honoring `voiceUx.sitrepShape` (`brief` default | `walk` | `full`).
Composes only already-ungated orientation/alert surfaces (the rm4-documented read-gating
boundary), so the tool registers ALWAYS_ALLOWED with the same rationale as
`get_attention_digest` — document this at the def. Payload is renderer-agnostic for hwu.7;
no WS frame ships in this wave (YAGNI).

### D4. Focus resolver (8fz.1)
Candidate space: pane names, project names, preset/agent labels, ordinals (display order),
states ("the stuck one", "the busy one"), recency ("that one"). Binding policy from
`voiceUx.focusBindPolicy` (`confirm` default | `echo` | `tiered`): exact unique → silent bind;
fuzzy unique → "Did you mean X?" gate (default) before binding; multiple → ask with top 2–3;
none → clarify listing pane names. Capability: the existing promoted `focus_pane` row
(Auto default) — no new gate row.

### D5. Spoken confirm (f09.1) — a resolution path, not a second store
No `pendingConfirmations` map. A destructive action gated to Ask creates the same
`pendingApprovals` record as today; the voice lane reads it back verbatim and opens a
`voiceUx.confirmTimeoutMs` (10 s default) phrase window. Action-echo phrases from a static TS
table: `confirm delete` (delete_pane / delete_project), `confirm clear` (clear_history) —
extensible list, explicitly enumerated. Bare "yes"/affirmatives rejected for the destructive
class with exactly one re-prompt. **Window expiry cancels the spoken prompt only** — the
underlying approval keeps its own TTL and stays resolvable via UI/typed SURE. Resolution rides
the existing claim-and-delete exactly-once machinery (hardened in 4s2). Entirely synchronous
TS — same fail-closed reasoning as the capability gate. Non-destructive approvals keep the
existing voiceApprovalRouting behavior unchanged.

### D6. Config
One new settings block on the existing settings store (no new persistence):
`voiceUx: { sitrepShape: 'brief'|'walk'|'full', focusBindPolicy: 'confirm'|'echo'|'tiered',
confirmTimeoutMs: number }`.

### D7. Testing
- Unit: renderer determinism (golden spoken text per shape), resolver fallback behavior
  (daemon down → literal only), confirm state machine under fake timers (happy, wrong phrase,
  bare-yes rejection, single re-prompt, timeout), candidate collection.
- Journeys (mockLive idiom, in-proc server): SITREP round-trip; focus-then-bare-command
  targeting; confirm exactly-once including the 5b failure-injection patterns (session drop
  mid-window).
- Python: pytest for both callables (deterministic fixtures; matches CI's python lanes).
- Catalog + voice-tool goldens regenerate for the new tools (intended diff only).

### D8. Non-goals (this wave)
Capability-gate/approval semantic changes; any new UI surface (hwu.7 is the follow-up);
earcons (8fz.4); wake word / half-duplex (8fz.5); persistence of focus across server restarts.

## Hard constraints (from standing project rules)
Panes boot inert; no live API keys in tests; redaction invariants preserved; complexity gates
(CC ≤ 10 / cognitive ≤ 15, zero suppressions) are hard errors; TDD for behavioral changes.
