# Instruction Routing — InstructionEnvelope, target resolution, draft convergence (Phase 3, Step 3.1)

- **Date:** 2026-07-09
- **Status:** Design contract (architect step 3.1). RED-first suites land with this doc:
  `tests/test_instruction_envelope.ts` (imports `src/exchanges/instructionEnvelope` — does **not**
  exist yet) and `tests/test_target_resolver.ts` (imports `src/voice/targetResolver` — does **not**
  exist yet). Step 3.3 implements both against these tests.
- **Related:** exchange spine `docs/superpowers/specs/2026-07-09-agent-exchange-spine.md`
  (envelopes bind to exchanges; `agent_exchanges.instruction_envelope_json` already exists —
  `src/exchanges/types.ts:71`, schema v12) · voice-UX wave 3 focus resolution
  (`src/voice/focusResolver.ts`, `src/voice/policyClient.ts`) · Python/TS seam ADR
  `docs/design/2026-06-19-python-ts-seam.md` · z5c session pool / Phase 2 context versions.

## BLUF

The **InstructionEnvelope** is Orbital's *communication* contract for one instruction to one pane:
`{ objective, relevant_context[], constraints[], requested_output|null, completion_signal|null,
operator_language }`. It is **never a technical plan** — Orbital listens, understands, drafts,
routes, correlates, and reports; the terminal agents do all engineering. Three pieces land here:

1. a **deterministic readiness predicate** (target + objective required; everything else optional
   and operator-stated-only; exactly ONE targeted clarification per unready check);
2. a **target resolver** (`src/voice/targetResolver.ts`) that EXTENDS the existing
   focus-resolution pattern (`literalResolve` TS floor + Python `focus.resolve` ranking,
   null-on-miss) to instruction routing — it returns a **decision**, never binds focus itself;
3. **draft convergence**: one durable exchange draft per pane, bridged onto the EXISTING
   `panes.draft` Workbench store (schema v3) so voice and typed edits mutate the SAME draft, with
   send idempotent per `draft_version` (the exchange-spine CAS rules), plus a **deterministic
   per-adapter renderer** whose profiles control formatting ONLY.

Flag-gated `JANUS_INSTRUCTION_ENVELOPE: off | shadow | primary`, mirroring
`JANUS_EXCHANGE_SPINE` (`src/exchanges/flag.ts:39-53`).

---

## 1. InstructionEnvelope schema

Canonical shape (program spec, stored redacted in `agent_exchanges.instruction_envelope_json`,
`src/exchanges/types.ts:71` / schema v12 `src/store/schema.ts`):

```ts
interface InstructionEnvelope {
  objective: string;                 // what the operator asked for, distilled — REQUIRED
  relevant_context: string[];        // operator-stated context items only; [] when none
  constraints: string[];             // operator-stated constraints only; [] when none
  requested_output: string | null;   // only when the operator asked for a specific response shape
  completion_signal: string | null;  // only when the operator asked to be told something specific
  operator_language: string;         // BCP-47-ish tag of the operator's speech (e.g. "en")
}
```

**Anti-fabrication invariant (normative, the product boundary):** every content string in the
envelope traces to something the operator said. `buildEnvelope` assembles fields from
already-extracted operator statements — it normalizes (trim, drop empties, preserve order) and
**never invents** constraints, acceptance criteria, tech choices, file lists, or test demands.
This is the `instantiateTemplate` posture — missing content is *reported*, never guessed
(`src/templates.ts:40-49`, "callers clarify, not guess"). The RED suite pins it: renderer output
must contain ONLY operator-provided content plus fixed section labels.

The envelope binds to an exchange: it IS the structured form of
`agent_exchanges.distilled_instruction`, versioned by the exchange's `draft_version`
(`src/exchanges/lifecycle.ts:226-243` — `reviseDraft` bumps the version and invalidates any
outstanding approval binding; spine spec §3).

---

## 2. Prompt-readiness contract

### 2.1 Required vs. material-optional

| Field | Required before send? | Rule |
|---|---|---|
| target (project + pane, resolved & bound) | **YES** | An exchange is one instruction to one pane (`agent_exchanges.pane_id NOT NULL`). |
| `objective` (non-whitespace) | **YES** | An empty objective is nothing to send. |
| `relevant_context` | no | Included only when the operator stated context. `[]` is valid and common. |
| `constraints` | no | Only when material — i.e. only when the operator stated one. Never asked for. |
| `requested_output` | no | Only when the operator asked for a specific response shape. Never asked for. |
| `completion_signal` | no | Only when the operator asked to be told something specific. Never asked for. |
| `operator_language` | no (defaulted) | Defaults to the session language; never gates readiness. |

**Orbital never asks a clarification for an optional field.** "Only when material" means: present
iff operator-stated. Absence of constraints is a valid envelope, not a gap to fill.

### 2.2 The deterministic readiness predicate

```ts
type ReadinessResult =
  | { ready: true }
  | { ready: false; missing: "target" | "objective"; clarification: string };

function assessReadiness(draft: EnvelopeDraft): ReadinessResult
```

Pure, ordered, single-answer:

1. `draft.target === null` → `{ ready:false, missing:"target", clarification: <which pane?> }`
2. `draft.envelope.objective.trim() === ""` → `{ ready:false, missing:"objective",
   clarification: <what should it do?> }`
3. otherwise → `{ ready: true }`

Exactly **one** targeted clarification per unready check — the FIRST missing field in the fixed
priority order (target → objective), matching the exchange spine's one-question
`awaiting_clarification` leg (`draft → awaiting_clarification → draft(version++)`,
spine spec §1.3 / `src/exchanges/lifecycle.ts:245-254`). Both missing → ask target first; the
next readiness check asks objective. Clarification prose vocabulary follows the focus resolver's
clarify idiom (`clarifyNoMatch`, `src/voice/focusResolver.ts:233-239` — name what's visible, ask
one question).

**Readiness ≠ permission.** A ready envelope still routes through the capability-gate choke-point
(`decideProposal` → `applyDispatchDecision`, `src/dispatch/paneWrite.ts:169-185`); a gate of Ask
produces the existing pending approval. The envelope layer never gates and never bypasses.

---

## 3. Target resolution — `src/voice/targetResolver.ts`

**EXTENDS `focusResolver`, never duplicates it.** It reuses:

- the candidate set: `collectFocusCandidates` shape / `FocusCandidate`
  (`src/voice/focusResolver.ts:25-38`, `src/voice/policyClient.ts:27-38`);
- the Python ranking seam: the EXISTING `focus.resolve` op via `ctx.policies?.resolveFocus`
  (`src/voice/policyClient.ts:308-321`; deterministic scorer `python/policies/focus.py:1-12`),
  injected as an optional `rank` function with the same **null-on-ANY-miss** fallback contract
  (`policyClient.ts:7-10`) — a dead daemon must NEVER widen matching (D2,
  `focusResolver.ts:108-113`);
- the classification tiers: confidence ≥ 1 = exact silent-bind; alternatives within the 0.15
  margin = multiple; fuzzy-unique otherwise (`classifyResolution`, `focusResolver.ts:182-192`).

**What it adds** (why it's a new module, not a `focusResolver` edit): a fourth deterministic
floor tier (exact role/preset-token uniqueness), anaphora + cross-project classification, and —
critically — it returns a **decision object instead of binding**. `runFocusPane` binds via
`bindFocus` (`focusResolver.ts:154-166`); the target resolver NEVER mutates focus or the draft's
binding. Focus/binding mutations stay on the authoritative paths (`bindFocus` /
`switch_active_pane`, `src/actions/defs/panes_write.ts:47-80`; draft binding through the exchange
service).

```ts
type TargetDecision =
  | { kind: "bind";    paneId: string; projectId: string }
  | { kind: "confirm"; reason: "fuzzy" | "cross_project" | "multiple";
      candidates: Array<{ paneId: string; projectId: string }>; prompt: string }
  | { kind: "clarify"; prompt: string };
```

### 3.1 The TS floor (fail-closed, never fuzzy)

Tiers 1–3 are `literalResolve` verbatim (`focusResolver.ts:114-138`): case-insensitive exact
pane name/id → unique name prefix → exact ordinal word/digit. Tier 4 is new but equally
structural: **exact role/preset-token equality** — the reference's role token ("claude",
"claude code", "codex", "antigravity", "custom") matched against `normalizePreset` vocabulary
(`src/actions/defs/panes_write.ts:152-165` enumerates the accepted spellings) over candidates'
`presetLabel`, binding **only when exactly one candidate carries that preset**. Two carriers →
multiple; zero → none. No token similarity, no substring scoring — a dead/absent/`null`-returning
ranker leaves ONLY these exact tiers (the floor never widens; fuzzy is Python-only, ranking-only).

### 3.2 Decision table (normative)

Input classes (columns are resolver states):

| Input class | Exact unique match | Multiple candidates | None |
|---|---|---|---|
| **Explicit pane id / name** ("pane build-1", "janus-dev") | **bind silently** | confirm(`multiple`) with named candidates | clarify ("no pane named X; panes I see: …") |
| **Role / preset reference** ("the Codex pane") | **bind silently** (exactly one pane runs that preset — tier 4) | confirm(`multiple`) | clarify |
| **Ordinal** ("pane two") | **bind silently** | n/a (ordinals are unique by construction) | clarify ("I don't see a pane two") |
| **Anaphora** ("that", "that one", "it") | **bind silently** to the recent referent when one exists | confirm(`multiple`) when the recent referent and the active pane disagree and both are plausible | **clarify** when no recent referent exists |
| **Cross-project reference** (matched pane lives outside the active/draft project) | **confirm(`cross_project`)** — NEVER a silent bind, even for an exact name, and regardless of whether the operator named the project | confirm(`multiple`, candidates across projects) | clarify |
| **No referent** (nothing target-shaped in the utterance) | — if the pane-scoped draft already has a bound target, keep it (no re-resolution); otherwise **clarify** | — | **clarify** |
| **Fuzzy** (ranker-only match, confidence < 1, no close alternatives) | confirm(`fuzzy`) — "Did you mean X?" | confirm(`multiple`) (0.15-margin rule) | clarify |

Hard rules:

- **Exact beats the ranker.** A tier-1/2/3/4 floor match resolves BEFORE consulting `rank`; the
  ranker can never override or hijack an exact reference (ranking is additive recall for fuzzy
  references only).
- **Never guess.** No decision path ever binds a below-1-confidence match silently.
- **`focusBindPolicy` (`echo`/`tiered`) does NOT apply here** — deliberate divergence from
  `applyFuzzyPolicy` (`focusResolver.ts:242-256`). A wrong *focus* is a recoverable glance; a
  wrong *instruction target* delivers work to the wrong agent. Fuzzy targets always confirm,
  regardless of the operator's focus-bind preference.
- **Recent-referent register** (anaphora source): a small per-connection record of the last
  successfully bound instruction target (set on each `target_resolved` event, TTL-bounded),
  following the bounded per-conversation register idiom of `recentTurns`
  (`src/voice/recentTurns.ts:10-16` — pushed once per completed turn, never per frame). The
  resolver only *receives* it as input; it never maintains it.
- The resolver is **pure data-in / data-out**: no ctx, no I/O handles in the decision, input never
  mutated (pinned by the RED suite via frozen inputs + JSON-round-trip equality).

---

## 4. Confirmation rules

| Situation | Confirm? | Mechanism |
|---|---|---|
| Exact unique target + explicit send verb ("send it") | **No extra confirmation.** | The gate still applies: Full Auto lands via `applyAutoExecute`; Ask stages the existing approval (`applyPendingApproval`, `src/dispatch/paneWrite.ts:280-329`). The approval **is** the confirmation when the gate demands one — never a second voice loop on top. |
| Fuzzy target (confidence < 1) | **Yes** — spoken confirm turn before binding. | `TargetDecision.confirm(fuzzy)`; one question, one answer. |
| Multiple candidates | **Yes** — pick from named candidates. | `confirm(multiple)`, prose per `clarifyMultiple`'s idiom (`focusResolver.ts:228-231`). |
| Cross-project retarget | **Yes, always** — even exact-name matches. | `confirm(cross_project)`. Retargeting across projects also re-evaluates context + posture (§5.3). |
| Anaphora resolved to a live recent referent | No (binds silently — the operator is continuing the same thread). | Recent-referent register (§3.2). |
| Material scope change on revise (objective replaced / retarget while an approval is outstanding) | **Structural, not conversational:** `draft_revised` bumps `draft_version` and invalidates the approval binding (`lifecycle.ts:226-243`; spine §3), so the revised draft must be read back and re-approved through the normal flow. | Exchange-spine CAS — the old approval can never fire against new text. |
| Capability gate already Ask on the target pane | **Yes** — the EXISTING approval flow, unchanged. | `decideProposal` → pending approval; resolved only through `applyResolution` (`src/gating/index.ts`). |
| Destructive class (delete_pane / delete_project / clear_history) | Unchanged `spokenConfirm` phrase window. | The envelope layer **never adds entries to `CONFIRM_PHRASES`** (`src/voice/spokenConfirm.ts:40-44`) and never opens its own confirm-window store — envelope confirmations are ordinary clarify/confirm conversation turns, exactly like the focus resolver's. `spokenConfirm.intercept` keeps its precedence (`spokenConfirm.ts:193-195`). |

---

## 5. Draft convergence — ONE durable draft per pane

### 5.1 What exists today (verified)

- **Workbench WIP draft**: `panes.draft` ledger column (schema v3), read/written via
  `ledger.getDraft/setDraft/appendDraft` (`src/ledger.ts:63-65`,
  `src/store/sqliteStore.ts:708-737`). Client side: `useComposer` — the prompt buffer IS the
  active pane's persisted draft (`src/classic/hooks/useComposer.ts:87-98`), typed edits go WS
  `draft_edit` or REST PUT (`useComposer.ts:111-129`, gate =
  `shouldSendDraftOverWs`, `src/classic/helpers/composerLogic.ts:18-23`; server routes
  `server.ts:1056-1069`, broadcast `server.ts:1393-1401`).
- **Voice draft compose**: `update_draft_prompt` writes the SAME ledger column
  (`src/actions/defs/panes_write.ts:104-134`) — active pane only, ungated (Off-veto only).
- **Send lanes diverge today**: the Workbench Send is operator-direct **above the gate**
  (`POST /api/panes/:projectId/:paneId/draft/send`, `server.ts:1076-1091` — writes immediately,
  clears the draft); voice instructions route through the gate
  (`propose_command` → `dispatchProposal` → `applyDispatchDecision`,
  `src/actions/registry.ts:191-248`, `src/dispatch/paneWrite.ts:169-185`).
- **No linkage**: the spine spec §3 already documents that the Workbench draft has no
  draft-version/approval binding. That is the gap this section closes.

### 5.2 The bridge (no rival store)

**`panes.draft` remains the single durable prose surface.** The envelope layer adds structure
*behind* it, not beside it:

- Under `shadow`/`primary`, a pane's WIP draft is backed by **at most one open exchange** in
  `draft`/`awaiting_clarification`/`awaiting_approval` state for that pane (enforced in
  `ExchangeService` — a new envelope utterance for a pane with an open draft **revises** it,
  never creates a sibling). The structured envelope lives in
  `instruction_envelope_json`; the exchange's `distilled_instruction` holds the rendered prose.
- **Render→mirror:** every envelope render is mirrored into the ledger draft
  (`ledger.setDraft(projectId, paneId, renderedText, "janus")` + `broadcastDraft`) — so the
  Workbench buffer shows byte-for-byte what will be sent, with **zero client change**
  (`useComposer.fetchActiveDraft` and the e2e harness coupling, `useComposer.ts:18-21`, are
  untouched).
- **Typed edits converge:** the server's `draft_edit` WS handler and REST PUT, under the flag,
  ALSO call `exchangeService.reviseDraft(exchangeId, text)` — `draft_version`++ and any
  outstanding approval invalidated (spine §3). The envelope enters **prose-authoritative mode**
  (`instruction_envelope_json.prose_override = true`): the operator's hand-edited text is never
  clobbered by a re-render. A subsequent voice field revision clears the override, re-renders,
  and bumps the version again. Rule of record: **both surfaces mutate the SAME exchange draft;
  last writer wins the prose; every write bumps the same `draft_version`.**

### 5.3 Verb semantics

- **revise** — field-level change (voice) or prose edit (typed) → `reviseDraft`: version++,
  approval invalidated, re-render (unless prose-override), re-mirror.
- **retarget** — re-run the target resolver on the new reference. Allowed only in draft states.
  On a confirmed retarget: `pane_id` (and possibly `project_id`) update + version++; the old
  pane's ledger draft is cleared, the new pane's is written; **project context is re-evaluated**
  (re-stamp `context_version` from the new project's latest context delivery — Phase 2) and
  **safety posture is re-read** (`effectiveCapabilityGateFor` / `posturePayloadForPane` for the
  NEW pane — what the operator is approving *into* changes with the target,
  `paneWrite.ts:317-326`). Cross-project retarget always confirms (§4). If the new pane already
  has its own open draft → clarify (replace vs. keep), never silently merge.
- **cancel** — exchange → `cancelled`; the mirrored ledger draft is cleared
  (`setDraft(…, "", …)` — the existing clearing idiom, `server.ts:1089`).
- **send** — readiness predicate must pass (§2.2), then:
  - **voice lane**: through `propose_command`/`dispatchProposal` with `deps.exchangeId` threaded
    (already supported — `src/dispatch/paneWrite.ts:99-107`); the gate decides auto/ask/off.
  - **Workbench lane**: `POST /draft/send` stays operator-direct above the gate
    (`server.ts:1076-1091`); under `primary` it stamps the same exchange through
    `staged → delivery_attempted → delivered`.
  - **Idempotent per draft version** (spine §2): the `staged` CAS + the
    `(exchange_id, draft_version, delivery_attempt)` intent key make a repeat send of the same
    version a recorded no-op — a double-click or replayed voice send can never double-type into
    a live agent. A re-send after revision is a NEW version (and, if gated, needs a fresh
    approval — `markDeliveryFailed` clears the binding, `lifecycle.ts:306-310`).

---

## 6. Adapter rendering contract

### 6.1 Grounding — where adapters live

Per-CLI differences live in **`src/agents/`**: one `AgentAdapter` per pane, selected by
`tool_preset` via `createAdapter` (`src/agents/index.ts:85-97`), preset union
`"Claude Code" | "Codex" | "Antigravity" | "Custom"` (`index.ts:37`). Adapters today own
spawn/launch/resume argv, permission-mode plans, session pinning, and capability flags
(`index.ts:36-65`) — **no prompt-rendering surface exists in them today** (verified: the only
instruction-text path is `writeInput`). The submit mechanics are owned by
`UniversalTerminal`: `writeInput` → `deliverSubmit` writes the BODY and the terminating CR as
two writes with a configurable gap so ConPTY-hosted TUIs register a discrete Enter
(`src/terminal.ts:1134-1161`, `DEFAULT_PTY_SUBMIT_DELAY_MS` at `:411-416`).

### 6.2 The contract

One **deterministic pure renderer** (the `src/templates.ts` posture — no I/O, no Date):

```ts
renderEnvelope(envelope: InstructionEnvelope, profile: RenderProfile): string
// same (envelope, profile) -> byte-identical output, always
```

Output shape (plain style; sections with empty content are omitted ENTIRELY, label included;
`null` requested_output / completion_signal lines are omitted):

```
<objective>

Context:
- <relevant_context item>…

Constraints:
- <constraints item>…

Respond with: <requested_output>
When done: <completion_signal>
```

Per-adapter **`RenderProfile`** — a small table keyed by the same preset union as
`createAdapter` (a sibling of the adapter, NOT new `AgentAdapter` methods, so the verified
adapter interface stays untouched):

```ts
interface RenderProfile {
  preset: "Claude Code" | "Codex" | "Antigravity" | "Custom";
  headingStyle: "plain" | "markdown";     // section label rendering
  requestCompletionEnvelope: boolean;     // append the ONE fixed protocol line asking the agent
                                          // to report completion in a parseable form
  escapeStyle: "strip-control";           // control-byte hygiene for TUI paste (v1: one value)
  eol: "\n" | "\r\n";                     // body-internal line endings
  submitSequence: "enter";                // v1: deliverSubmit's body+CR split stays the ONLY writer
  maxChars: number;                       // size ceiling; over-limit REFUSES at send (clarify to
                                          // shorten) — never silent truncation
}
```

**Profiles control formatting ONLY.** Adapters/profiles never see, reinterpret, or carry
target, gates, capability values, or exchange state — the renderer receives ONLY the envelope
(pinned by the RED suite's profile key-set audit). The `requestCompletionEnvelope` line is the
single permitted non-operator addition: a fixed, exported protocol constant (communication
framing, not a technical requirement), and profiles that disable it produce
100%-operator-content output. The actual PTY write path is unchanged `writeInput`; a future
`submitSequence` value (e.g. bracketed paste) would extend `deliverSubmit`, never bypass it.

Default profile table (defaults tunable at implementation; the SHAPE is the contract):
Claude Code / Codex — markdown headings, completion envelope on; Antigravity — plain, on;
Custom — plain, completion envelope OFF (a shell pane gets bare operator prose).

---

## 7. Feature flag — `JANUS_INSTRUCTION_ENVELOPE: off | shadow | primary`

Exactly the `flag.ts` idiom (`src/exchanges/flag.ts:39-53` — validated set, `off` default,
testable `read…(env)` + module-cached constant):

- **`off` (default):** no envelope structures are built; target resolution, drafts, and sends run
  today's paths byte-identically.
- **`shadow`:** envelopes are built and stored on exchanges (`instruction_envelope_json`), the
  renderer's output is computed and compared against what the legacy path actually sent
  (fidelity telemetry, the exchange-spine shadow posture — `flag.ts:10-13`); deliveries still go
  out on today's raw `distilled_instruction` path; the target resolver runs and LOGS its decision
  but focus/binding behavior is unchanged. Never throws into a caller (spine §9.6 posture,
  `src/exchanges/spine.ts:14-18`).
- **`primary`:** the rendered envelope IS the delivered instruction; the target-resolver decision
  governs routing (bind/confirm/clarify); the Workbench bridge (§5.2) is live. The capability
  gate, `resolveDecision`'s claim, and `applyResolution` remain untouched and authoritative for
  permission.

Rollback = flip the env var.

---

## 8. Non-goals / boundary (normative)

1. **No technical planning.** The envelope never contains implementation steps, file lists,
   architecture decisions, or fabricated acceptance criteria. Objective + operator-stated
   context/constraints only.
2. **No verification.** `requested_output`/`completion_signal` ask the agent to *report*;
   Orbital never verifies the engineering (spine §9.3).
3. **No gate authority.** Readiness gates *communication completeness*; permission is
   exclusively the capability-gate choke-point.
4. **No new confirm store.** Confirmations are conversation turns + the existing
   approval/spokenConfirm machinery.
5. **One instruction, one pane.** Fan-out remains N sibling exchanges (spine §9.1).
6. **The resolver never mutates.** Focus moves only through `bindFocus`/`switch_active_pane`;
   draft binding only through the exchange service.

**Real-code discoveries recorded here** (they shaped the design): (a) the Workbench draft/send is
operator-direct ABOVE the gate while voice sends are gated — the two lanes are kept but converge
on the same exchange + version idempotency (§5.3); (b) `update_draft_prompt` is active-pane-only
(no pane_id param) — envelope compose inherits the pane-scoped draft rather than adding a
targeted-compose verb; (c) `focusBindPolicy: echo/tiered` permits unconfirmed fuzzy *focus*
binds — instruction targeting deliberately does NOT honor it (§3.2); (d) adapters have no
rendering surface today, so the render profile is a sibling table, not an interface change.

---

## 9. Test plan (RED-first, landing with this doc)

- `tests/test_instruction_envelope.ts` — imports `../src/exchanges/instructionEnvelope` (does not
  exist; RED until step 3.3): readiness matrix (each required-field-missing → which single
  clarification; fixed priority order; optionals never gate), envelope build normalization + no
  fabrication, deterministic rendering (byte-identical; only-operator-content line audit;
  empty-section omission; eol/profile knobs; profile key-set = formatting-only), draft-version
  bump on revise, idempotent send per draft version.
- `tests/test_target_resolver.ts` — imports `../src/voice/targetResolver` (does not exist): the
  full §3.2 decision table, exact-beats-ranker precedence, the TS floor never widening on a dead
  ranker, anaphora with/without a recent referent, cross-project confirm, and the resolver's
  pure-decision (no mutation, no side-effect handles) property.

Idiom matched to the suite: `node:test` `describe/it` + `node:assert`
(`tests/test_exchange_lifecycle.ts`), run by `tsx --test --test-force-exit`.
