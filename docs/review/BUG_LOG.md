# OrbitalVoiceRunner — Consolidated Bug Log (Step 6 Technical Review)

> **Deliverable:** One organized, prioritized, de-duplicated bug log spanning the 8
> user journeys plus the cross-cutting capabilities (graduated permissions, hands-free
> operation, persistence/continuity, proactive awareness, output safety).
>
> **Modality lens:** voice-only, hands-free, eyes-off operator. Janus = Gemini Live
> audio agent. "Content" = terminal output returned via `get_pane_summary`. There is no
> vision; the screen does not exist for the operator. **Every defect is scored by its
> impact on an operator who cannot look at the screen.**
>
> **Method:** all per-journey gap registers + deep-dives + the synthesis docs were read,
> then the most load-bearing claims were re-verified directly against `server.ts`,
> `src/terminal.ts`, `src/ledger.ts`, and `src/App.tsx` (citations below are spot-checked,
> not merely copied). Where two or more journey reports describe the *same* underlying
> defect, they are **merged into a single bug** with all affected journeys listed and all
> source gap IDs cross-referenced.
>
> **Note on `BACKLOG.md`:** `JOURNEYS_DESIGN.md` and the journey narratives imply a
> tracked backlog, but **no `BACKLOG.md` exists anywhere in the repository** (verified by
> filesystem and grep search). This `BUG_LOG.md` effectively stands in for it.

---

## 1. Capability Coverage Matrix

Verdicts: **Working** (verified solid) · **Partial** (works but materially degraded
eyes-off) · **Mocked** (returns placeholder / simulated data, not real behavior) ·
**Broken** (does not do what it claims) · **Missing** (capability absent).

| # | Journey / Capability | Verdict | One-line justification | Controlling bugs |
|---|---|---|---|---|
| J1 | Fan-out / Delegate in Parallel | **Partial** | PTY spawn is real & concurrent, but `execute_plan` is strictly sequential (no parallel primitive), model context freezes at connect, and UI focus diverges from voice focus. | BUG-006, BUG-010, BUG-011, BUG-012, BUG-022 |
| J2 | Supervisor / Air-Traffic Control | **Partial** | WS-E fixed the HiTL voice loop: Janus now speaks the proposal (no longer mute, BUG-001), `list_pending_approvals` exists (BUG-016), the digest merges approvals (BUG-009), and a TTL sweep unblocks stale votes (BUG-019). Remaining: the global-override no-op (BUG-003) and the missing REST broadcast (BUG-004). | BUG-001 ✅, BUG-003, BUG-004, BUG-009 ✅, BUG-016 ✅, BUG-019 ✅ |
| J3 | Review & Approve by Voice | **Partial** (eyes-off) | WS-E closed the blind-approval seam (spoken read-back, BUG-001), targeted multi-pane resolution (clarify-not-approve, BUG-007), the intent parser (negation/ASR/collision, BUG-008), and dead-pane errors (BUG-020). Remaining: pane-output secret redaction (BUG-002) and REST session-scoping (BUG-017). | BUG-001 ✅, BUG-002, BUG-007 ✅, BUG-008 ✅, BUG-017, BUG-020 ✅ |
| J4 | Knowledge Capture & Continuity | **Partial / Mocked** | Note capture is solid and durable, but every command summary is a placeholder, handoffs produce no retrievable artifact, and session memory dies on restart. | BUG-005, BUG-009, BUG-013, BUG-014, BUG-021, BUG-023 |
| J5 | Adjust Autonomy Mid-Session | **Broken** (silently) | A non-`Inherit` global silently nullifies per-pane changes while Janus says "successfully"; Full Auto needs a restart with no voice tool. | BUG-003, BUG-015, BUG-018, BUG-026 |
| J6 | On-Demand Status Check | **Partial** | `alive` is trustworthy but `is_busy` reads false on any non-trivial workload; no elapsed time; no proactive completion/error push. | BUG-006, BUG-010, BUG-024, BUG-025 |
| J7 | Dictate a Specification | **Partial** | Deliberate notes persist atomically, but the ambient prompt buffer is volatile and the only commit path is keyboard-only + 100-char truncated; no voice recall/search/delete. | BUG-013, BUG-021, BUG-027, BUG-028, BUG-029 |
| J8 | Narrate a Terminal Walk-through | **Partial / Unsafe** | ANSI stripping and note capture work, but output is raw (no semantic extraction), only the last 20 lines, no delta, and **no secret redaction** despite a tool description claiming "redacted." | BUG-002, BUG-005, BUG-030, BUG-031, BUG-032 |
| C1 | Graduated permissions (cross-cutting) | **Partial** | Three-branch resolver is correct in principle, but global-first resolution makes per-pane changes silent no-ops and the Full Auto flag never reaches the live PTY. | BUG-003, BUG-015, BUG-018 |
| C2 | Hands-free / eyes-off operation | **Partial** | WS-E made voice approval safe and eyes-off: spoken read-back (BUG-001), targeted resolution (BUG-007), and a robust intent parser (BUG-008). Remaining gaps are non-approval: Full Auto restart (BUG-018) and the volatile/keyboard-only prompt buffer (BUG-027, BUG-028). | BUG-001 ✅, BUG-007 ✅, BUG-008 ✅, BUG-018, BUG-027, BUG-028 |
| C3 | Persistence / continuity | **Partial** | Ledger + notes persist atomically, but pending approvals, prompt buffer, and the session resumption token are all in-memory and lost on restart. | BUG-013, BUG-014, BUG-023 |
| C4 | Proactive awareness | **Missing** | Completions and errors are detected server-side but never pushed to Janus as audio; the model only learns state when explicitly asked. | BUG-024, BUG-022 |
| C5 | Output safety / redaction | **Missing** | No secret/credential redaction before pane output reaches Gemini; the tool contract falsely claims redaction. | BUG-002 |

**Headline verdict:** the *nouns* are solid (real PTY spawn, atomic ledger, durable
notes, trustworthy `alive`), but the *verbs that connect journeys* — context propagation,
a spoken layer over pending state, multi-pane targeting, effective-permission truth,
proactive push, truthful history, and output safety — are missing or cracked. No journey
fully fails in isolation; the failures cluster at the seams, which are exactly where the
eyes-off operator cannot recover by glancing at a screen.

---

## 2. Severity & Priority Scheme

Priority is judged **strictly by hands-free / eyes-off operator impact** — a defect that a
sighted user would shrug off can be a P0 for an operator who cannot see the screen.

- **P0 — Safety / data-loss / core-broken.** The operator can take an unsafe or wrong
  action believing it is safe/correct, irreversible data is lost silently, or a core
  promised capability is fundamentally non-functional. Includes: blind/mis-targeted
  command approval, secret exfiltration, confidently false information, silent permission
  no-ops, and false "idle/done" status that drives the next decision.
- **P1 — Journey materially degraded.** The journey can be completed but with significant
  friction, missing feedback, or partial loss that the operator can eventually detect and
  work around.
- **P2 — Notable friction.** Real but recoverable; degrades efficiency or trust without
  causing wrong actions or data loss.
- **P3 — Polish / hygiene.** Documentation, test-coverage, robustness, and accessibility
  niceties that do not block the journey.

---

## 3. Consolidated Bug Log

Organized **primarily by priority (P0 first)**, then grouped by journey within each
priority. Cross-cutting bugs appear **once** with all affected journeys listed.

---

### P0 — Safety / Data-Loss / Core-Broken

---

#### BUG-001 — Janus is mute during approval wait and never speaks the proposed command (blind voice approval)
- **Priority:** P0
- **Category:** Broken (architecture)
- **Journeys affected:** J2, J3 (and the cross-cutting hands-free contract C2)
- **Evidence:** `server.ts:1318–1334` — the HiTL branch deliberately withholds
  `session.sendToolResponse`, hard-blocking the Gemini Live session so the model cannot
  emit audio or call further tools; `server.ts:1568` system prompt has no instruction to
  verbalize the command before calling `propose_command`. The only signal to the operator
  is the `alert` earcon (`src/App.tsx:876–877`).
- **Root cause:** "Block execution" is coupled to "block the model's voice." The gate
  correctly suspends the tool call but never decouples a spoken pre-announcement from the
  blocking response.
- **Operator impact:** Every voice approval is a *blind* approval — the operator approves a
  command they were never told. This turns the product's core safety harness into a
  blindfold for the exact user it is designed for. **Single most dangerous seam.**
- **Suggested fix:** Two-phase proposal — send an immediate non-blocking
  `pending_approval` tool response (so Janus speaks "I want to run X on pane Y — approve?"),
  track the open vote on a side channel, and resolve it via the voice intercept / REST path.
- **Source gaps:** J2-G1, J3-G1.
- **Status:** ✅ **Resolved (WS-E, `abf2508` + fixes).** Two-phase proposal: the HiTL branch
  answers `call.id` exactly once with a NON-BLOCKING `pending_approval` response, so Janus is
  not muted and speaks the distilled read-back; resolution narrates the outcome via
  `pushApprovalNarration` (`sendClientContent`), never a 2nd `sendToolResponse`.

#### BUG-002 — No secret redaction before pane output reaches Gemini, and the tool contract falsely claims "redacted"
- **Priority:** P0
- **Category:** Security + Inaccurate-doc (honest-tool-contract violation)
- **Journeys affected:** J8 (primary); J2/J3 (the rationale snapshot embeds pane output); J4.
- **Evidence:** `src/terminal.ts:56–60` `stripAnsiSequences` removes only ANSI codes — no
  secret patterns; `src/terminal.ts:593–599` `getPaneSummary` wraps the raw buffer; the raw
  string is forwarded at `server.ts:1249–1254`. The `get_pane_summary` tool description at
  **`server.ts:1611`** reads *"Return the clean, redacted markdown delta…"* — none of
  "clean", "redacted", or "delta" is true.
- **Root cause:** No redaction pass was ever implemented; the tool description was written
  to the aspiration, not the implementation.
- **Operator impact:** Any secret printed to a pane (AWS keys, JWTs, `.env` values, PATs,
  `BEGIN ... PRIVATE KEY`) is sent verbatim to Google's Gemini Live API, invisibly to an
  eyes-off operator. Worse, because the model is *told* the data is redacted, it has no
  reason to caveat or warn — the false contract actively suppresses the safety hedge.
- **Suggested fix:** Add a pattern-scan redaction pass (AWS key shape, `eyJ…` JWTs,
  `BEGIN.*PRIVATE KEY`, common `.env` token shapes) in `getPaneSummary` before assembling
  the tool response; replace matches with `[REDACTED]`. Then rewrite the tool description
  (`server.ts:1611`) and `JOURNEYS_DESIGN.md:113` to state the true behavior.
- **Source gaps:** J8-G1, J8-G2.

#### BUG-003 — Global permission override silently nullifies per-pane changes while Janus reports success
- **Priority:** P0
- **Category:** Broken (safety)
- **Journeys affected:** J5 (primary); J2, J3 (the gate they depend on).
- **Evidence:** Effective-mode resolver at **`server.ts:1272–1276`** reads
  `manager.globalPermissionsMode` first and only consults the pane's own mode when global
  is `"Inherit"`. The `set_pane_permissions` handler (`server.ts:1542–1557`) never inspects
  the global mode and unconditionally returns *"…updated to X successfully."*
- **Root cause:** The resolver is global-first by design, but the mutation handler is
  unaware of that precedence and reports unconditional success.
- **Operator impact:** Operator says "lock down the deploy pane"; Janus confirms; yet every
  subsequent command on that pane still auto-executes because global is `Full Auto`. The
  reverse (promoting a pane while global is HiTL) is equally silent. The operator's safety
  posture is betrayed with a confident "done" over a no-op.
- **Suggested fix:** In `set_pane_permissions`, read `globalPermissionsMode`; if it is not
  `Inherit`, return a spoken rider ("global mode is X, so this pane change has no effect on
  gating until you set global to Inherit"). Mirror the rule in the tool description and the
  system instruction so Janus can warn proactively.
- **Source gaps:** J5-G1.

#### BUG-005 — ~~Dead summarizer model `gemini-3.5-flash`~~ — **RETRACTED (model ID is valid)**

> **Correction (post-review, per maintainer):** `gemini-3.5-flash` is a **valid
> current Google model ID**. This bug's premise is false, so BUG-005 is **retracted** —
> the summarizer works and does not emit a static placeholder on the happy path. Two
> real residuals remain, tracked elsewhere: (a) the error-path fallback used to falsely
> claim "Execution finished successfully." — fixed in M0/WS-A (now a neutral "summary
> unavailable"); (b) the summarizer is live, so it sends raw output to the model
> **unredacted** — that is finding **N-5**, closed by **WS-B**. The superseded original
> analysis is retained below for traceability.

- **Priority:** ~~P0~~ → retracted
- **Category:** Mocked (confidently false data)
- **Journeys affected:** J4 (primary), J1, J6, J8 (all read the contaminated output).
- **Evidence:** `summarizeCommandOutcome` calls **`server.ts:210` `model: "gemini-3.5-flash"`**
  (not a real Google model); the `catch` at `server.ts:214–216` returns the fixed string
  `"Execution finished successfully."`. The wiring (`onIdle` hook, per-pane history,
  configurable limits) is otherwise correct (`server.ts:187–246`).
- **Root cause:** Invalid model name → every API call throws → silent fallback to a fixed
  string for *every* command, including failed ones.
- **Operator impact:** `get_pane_command_history` returns `"Execution finished
  successfully."` for every entry, even failures. The `handoff_context_between_panes`
  packet is built from these (`server.ts:1525–1526`), so handoffs are contaminated too. An
  operator asking "what did Claude do?" hears the same false success line repeatedly — worse
  than no summary, because it actively misinforms across J6/J8/J4.
- **Suggested fix:** Replace with a valid model (`gemini-2.5-flash` / `gemini-2.0-flash`);
  add an integration smoke test asserting a non-placeholder, non-empty summary.
- **Source gaps:** J1-G2, J4-G3.

#### BUG-006 — `is_busy` reports false idle on any non-trivial workload (1-second timeout + prompt-pattern regex)
- **Priority:** P0
- **Category:** Broken (reliability)
- **Journeys affected:** J6 (primary), J1, J5, J8 (all act on the status).
- **Evidence:** `src/terminal.ts:163` regex
  `/([\?$#>]|\[[yY]\/[nN]\]|\([yY]\/[nN]\)|password:|confirm\??)\s*$/i` flips status to
  `Idle` on any line ending in `$`/`#`/`>`/`?`; `src/terminal.ts:189` hardcodes a `1000`ms
  silence timeout. Checked against the last 5 buffered lines (`fullStripped`,
  `src/terminal.ts:160`), amplifying false positives.
- **Root cause:** Output-silence + naive prompt heuristic used as the authoritative busy
  signal, with no real subprocess-state probe.
- **Operator impact:** During a 2-minute compile, `npm install`, test run, or AI "thinking"
  pause, `is_busy` reads `false` and `last_known_state` says `Idle`. The operator asks
  "what's running?" mid-build and is told it is done — the exact opposite of the truth — and
  may then issue a conflicting next command. False idle also fires watch rules / plan steps
  prematurely (`server.ts:445–446`).
- **Suggested fix:** Replace the timer with an authoritative signal — a PTY sentinel echo
  marking return-to-prompt, or `/proc/[pid]/stat` subprocess-state polling. Narrow the regex
  to genuine prompt lines on an otherwise-empty line. Add elapsed-time data (see BUG-025).
- **Source gaps:** J6-G1, J6-G2 (and untested: see BUG-038).

#### BUG-007 — Multi-pane voice approval resolves the oldest (FIFO) entry, not the intended pane, with no spoken read-back
- **Priority:** P0
- **Category:** Broken (safety / operator control)
- **Journeys affected:** J3 (primary), J2, J1.
- **Evidence:** Voice intercept at **`server.ts:1133–1136`** filters `pendingApprovals` by
  session then takes `pendingEntries[0]`. The comment on line 1135 reads *"Sort to resolve
  the earliest/most relative first"* but **no `.sort()` call exists** (verified) — it is
  plain insertion-order FIFO.
- **Root cause:** No targeting logic; the resolver picks the first map entry regardless of
  which command Janus most recently described.
- **Operator impact:** Fan-out's *normal* state is multiple pending commands. Saying
  "approve the npm install" while `rm -rf build/` is older executes the destructive command
  on the wrong pane, with no spoken confirmation of which pane/command was resolved. J1's
  core value (parallelism) directly creates J3's most dangerous ambiguity.
- **Suggested fix:** Bind resolution to the command Janus last described (track the most
  recently announced pending ID); support fragment/ordinal targeting ("approve the docker
  command"); speak the pane + command back before/at resolution.
- **Source gaps:** J3-G3, J2-G7, J1-G7.
- **Status:** ✅ **Resolved (WS-E, `abf2508` + fixes).** `selectApprovalTarget`
  (`src/approvalIntent.ts`) binds resolution to a fragment/ordinal hint then the
  most-recently-announced id (never blind FIFO); a present-but-missed fragment with >1 pending
  → ambiguous/clarify (P0-B), and ambiguity always clarifies rather than resolving the wrong
  pane. The pane + redacted command are spoken back at resolution.

#### BUG-008 — Naive substring voice parser misfires: no negation window, ASR apostrophe drop, and `isApprove` silently wins collisions
- **Priority:** P0
- **Category:** Broken (voice safety)
- **Journeys affected:** J3 (primary), J2.
- **Evidence:** `server.ts:1128–1129` — flat `.some(includes)` over approve keywords
  (incl. bare `"execute"`) and reject keywords (incl. bare `"cancel"`, and `"don't run"`
  with a literal apostrophe). Collision handling: `isApprove` is checked first and
  `isReject` is the `else` (`server.ts:1139`).
- **Root cause:** Substring matching with no intent model, no negation context, no
  apostrophe normalization, and approve-wins-on-tie.
- **Operator impact:** "I don't want to cancel the build" rejects; "we need to execute this
  carefully" approves; spoken "dont run" (ASR drops the apostrophe) fails to match and the
  command stays pending while the operator believes it was rejected; an ambiguous utterance
  silently approves. In a narrating, eyes-off session, incidental speech fires or skips real
  executions.
- **Suggested fix:** Add a negation window (scan 3 preceding tokens for `not/no/don't/never`),
  normalize apostrophes, require explicit pairing ("approve command" / "reject command") as
  the primary trigger, and on `isApprove && isReject` send a clarification tool response
  instead of executing.
- **Source gaps:** J3-G2, J3-G4, J3-G5, J2-G12.
- **Status:** ✅ **Resolved (WS-E, `abf2508` + fixes).** Replaced by the pure
  `parseApprovalIntent` (`src/approvalIntent.ts`): 3-token negation window, apostrophe
  normalization, explicit verb+object pairing (weak/ambient verbs ALWAYS require a nearby
  object — bare "execute"/"send it"/"proceed"/"go ahead" → none, P0-A), and approve+reject
  collision → clarify (never approve-wins). "do not approve"/"dont approve" both → none.

#### BUG-013 — In-memory-only volatile state lost on restart / session drop (`pendingApprovals`, `promptBufferText`, `lastSessionResumptionToken`, `attentionQueue`)
- **Priority:** P0
- **Category:** Broken (data loss / continuity) — *systemic*
- **Journeys affected:** J2, J3, J4, J6, J7.
- **Evidence:** `pendingApprovals` is a plain in-memory `Record` at **`server.ts:978`**, and
  the WS-close cleanup at `server.ts:1878–1884` silently purges all pending entries for the
  closing session with no operator alert or re-queue; `promptBufferText` is a module-level
  `let` at `server.ts:133`, mutated at `server.ts:1120`/`1200`, never written to disk;
  `lastSessionResumptionToken` is a module-level `let` at `server.ts:1030` (populated
  `1078–1080`, replayed `1570`); `attentionQueue` is in-memory (`server.ts:430–442`).
- **Root cause:** None of this state participates in the (otherwise solid) atomic ledger
  persistence; the ledger serializes only `activeProjectId`, `workspaces`, `watchRules`,
  `plans` (`src/ledger.ts:89–96`).
- **Operator impact:** A network drop while an approval is pending loses the command and
  leaves the agent task in an ambiguous half-done state with no notification. A server
  restart wipes every dictated spec fragment (the prompt buffer) and resets Janus's live
  conversation memory to zero, so "pick up where we left off" becomes "start over."
- **Suggested fix:** Serialize `pendingApprovals` (and the resumption token, and the prompt
  buffer) to disk alongside the ledger; on reconnect, restore and re-issue
  `approval_pending` events and re-attach via the resumption token; cap/persist the
  attention queue.
- **Source gaps:** J2-G6, J4-G6, J7-G1 (and J6-G12 for the unbounded queue → BUG-035).

---

### P1 — Journey Materially Degraded

---

#### BUG-009 — `get_attention_digest` tool description claims to cover "approvals" but reads only the attention queue
- **Priority:** P1
- **Category:** Inaccurate-doc (active model-steering defect)
- **Journeys affected:** J2, J3, J4, J6.
- **Evidence:** Description at **`server.ts:1683`** says *"…requiring operator confirmation,
  approvals, or showing error states."* The handler (`server.ts:1360–1373`) reads only
  `manager.attentionQueue` (populated by state transitions, `server.ts:430–442`);
  `pendingApprovals` (`server.ts:978`) is a separate structure never included.
- **Root cause:** Description promises a merge that the implementation does not perform; the
  two data structures are disjoint.
- **Operator impact:** Operator asks "what needs my attention / what's pending for approval?";
  Janus calls the digest tool (steered by the word "approvals"), receives no approval data,
  and confidently answers "nothing pending" while commands wait. Breaks the primary eyes-off
  discovery path for pending approvals.
- **Suggested fix:** Either fold `pendingApprovals` into the digest response, or add a
  dedicated `list_pending_approvals` voice tool (see BUG-016) and correct this description to
  describe only the attention queue.
- **Source gaps:** J2-G3, J3-G8, J3-G13, J6-G8.
- **Status:** ✅ **Resolved (WS-E, `abf2508` + fixes).** `get_attention_digest` now MERGES
  `pendingApprovals.forSession` with the attention queue (one source of truth shared with
  `list_pending_approvals` and `GET /api/commands/pending`), so the digest no longer falsely
  reports "nothing pending" while approvals wait.

#### BUG-016 — No voice tool to list pending approvals
- **Priority:** P1
- **Category:** Missing
- **Journeys affected:** J2, J3.
- **Evidence:** `GET /api/commands/pending` exposes the map to the UI (`server.ts:980–987`)
  but no equivalent appears in the Gemini `functionDeclarations` block
  (`server.ts:1577–1834`).
- **Root cause:** The pending queue was surfaced only to the visual UI, not to the voice
  channel.
- **Operator impact:** An eyes-off operator who missed the (undifferentiated) earcon has no
  way to ask Janus "what's queued for approval?" — there is no tool that can answer.
- **Suggested fix:** Add a `list_pending_approvals` voice tool reading all queued entries
  (pane, command, rationale, count). Pairs with BUG-001's two-phase proposal.
- **Source gaps:** J2-G2.
- **Status:** ✅ **Resolved (WS-E, `abf2508` + fixes).** Added the `list_pending_approvals`
  voice tool, reading the same redacted store (via `serializePending`) as the REST view, scoped
  to the session and marking the last-announced id for targeting.

#### BUG-014 — Session resumption token is in-memory only — live model memory resets on restart
- **Priority:** P1
- **Category:** Broken (continuity) — *covered structurally by BUG-013; listed for J4 visibility*
- **Journeys affected:** J4 (primary), J2.
- **Evidence:** `server.ts:1030` `let lastSessionResumptionToken`; populated
  `server.ts:1078–1080`; replayed on reconnect `server.ts:1570`.
- **Root cause:** Token never persisted.
- **Operator impact:** Notes/history survive on disk, but after a restart Gemini starts a
  fresh conversation with no memory of prior turns — re-briefing from scratch is required.
- **Suggested fix:** Persist to `.janus_ledger.json` (or a sidecar) on every
  `sessionResumptionUpdate`; load at startup with a TTL check. (Implement together with
  BUG-013.)
- **Source gaps:** J4-G6.

#### BUG-010 — Orchestration broadcast events are silently dropped by the frontend; UI relies on a 3-second poll
- **Priority:** P1
- **Category:** Missing
- **Journeys affected:** J1, J6 (and proactive awareness C4).
- **Evidence:** The server broadcasts `attention_updated`, `plans_updated`,
  `watch_rules_updated`, `pane_transition`, `plan_step_completed`, `plan_completed`,
  `plan_paused`, `history_updated`, `watch_rule_fired`. `App.tsx`'s `ws.onmessage` handler
  (verified cases at `src/App.tsx:872–922`) has **no branch** for any of them — only `audio`,
  `interrupted`, `approval_pending`, `prompt_buffer_updated`, `terminals_updated`,
  `ledger_updated`, `settings_updated`, `command_auto_executed`, `command_blocked`,
  `stdout_chunk`, `transcript_text`, `error`. UI state is refreshed by a 3-second
  `setInterval` poll instead (`src/App.tsx:593–601`).
- **Root cause:** Push events were added server-side but never wired into the client handler.
- **Operator impact:** Up to a 3-second lag before an earcon fires for an error; plan-step
  completions never trigger real-time confirmation. The push infrastructure exists but is
  inert.
- **Suggested fix:** Add `else if` branches for each event type and drive the matching
  setters / earcons from the pushed payload.
- **Source gaps:** J1-G5.
- **Status:** ✅ **Resolved (WS-D, `dfb4eba`; review fixes `cb5b0a4` + synthesis round).**
  The 9 push events are now dispatched via a data-driven event bus (`src/eventBus.ts`,
  `effectForEvent`) wired into `App.tsx`'s `ws.onmessage`, each driving its setter + earcon.

#### BUG-011 — `execute_plan` is strictly sequential — no parallel fan-out primitive
- **Priority:** P1
- **Category:** Missing
- **Journeys affected:** J1.
- **Evidence:** `handlePlansTrigger` advances `currentStepIndex` only after the prior step
  transitions (`server.ts:294–377`); the `Plan` type has no parallel step group
  (`types.ts:130–136`).
- **Root cause:** Plan model has no concept of a concurrent step group.
- **Operator impact:** Despite the journey name ("Fan-out / Delegate in *parallel*"),
  "run tests on all three panes at once" executes strictly serially. (Watch rules provide a
  primitive manual coordination workaround.)
- **Suggested fix:** Add a `parallel_group` step type; dispatch all members simultaneously
  and join on all reaching their expected transition.
- **Source gaps:** J1-G4.

#### BUG-012 — Model context frozen at connect: newly created panes are invisible to Janus, and `switch_context` never updates the UI focus
- **Priority:** P1
- **Category:** Sub-capable + Missing — *systemic*
- **Journeys affected:** J1 (primary), J2, J4, J6, J7.
- **Evidence:** The system prompt template literal is evaluated once inside
  `session.connect()` (`server.ts:1568`), capturing the pane list at connect time.
  `switch_context` updates the ledger and calls only `broadcastLedgerUpdate()`
  (verified `server.ts:1255–1265`) — there is no `context_switched` WS event, and
  `App.tsx`'s `ledger_updated` handler (`src/App.tsx:897–898`) calls only `setLedger`,
  never `setActiveProjectId`/`setActiveTerminalId`.
- **Root cause:** Structural changes (create pane, switch context) emit no event that either
  the model context or the UI focus consumes to refresh.
- **Operator impact:** After `create_pane`, Janus still believes zero panes exist until it
  re-calls `list_panes`, so it may propose commands to panes it thinks don't exist. After a
  voice `switch_context`, the UI keeps highlighting the previous project — voice focus and
  visual focus permanently diverge until a manual click. Eyes-off, this is undetectable.
- **Suggested fix:** Emit a `context_switched` WS event (carrying the new `activeProjectId`)
  and handle it in `App.tsx`; inject an ephemeral context update (or instruct Janus to call
  `list_panes`) after any structural change.
- **Source gaps:** J1-G1, J1-G10.

#### BUG-015 — Full Auto promotion never reaches the live PTY, and there is no `restart_pane` voice tool to apply it
- **Priority:** P1
- **Category:** Sub-capable + Missing
- **Journeys affected:** J5 (and hands-free contract C2).
- **Evidence:** `setPermissionsMode` mutates `this.shellCmd` only (`src/terminal.ts:118–130`),
  which is read solely by `start()` at spawn time (`src/terminal.ts:220–259`). The REST
  restart endpoint exists (`server.ts:537–545`) but no `restart_pane` function is declared in
  the tool list (`server.ts:1576–1834`). Antigravity bakes the flag in at launch
  (`src/terminal.ts:51`), so demotion is equally ineffective until restart.
- **Root cause:** The `--dangerously-skip-permissions` flag is applied to the next spawn, not
  the running process, and the only way to re-spawn is a UI button.
- **Operator impact:** Split-brain state — orchestrator says Full Auto but the subprocess
  still prompts internally (or, for Antigravity demotion, still skips prompts). The eyes-off
  operator cannot complete the promotion without reaching for a keyboard.
- **Suggested fix:** Declare a `restart_pane` voice tool wired to `term.stop(); term.start()`;
  return a `restartRequired` flag from `setPermissionsMode` and have Janus offer the restart.
- **Source gaps:** J5-G2, J5-G9, J5-G12.

#### BUG-024 — No proactive audio push on completion or error (pure pull model)
- **Priority:** P1
- **Category:** Missing — *systemic*
- **Journeys affected:** J6 (primary), J1, J2, J5, J8 (proactive awareness C4).
- **Evidence:** `onIdle` fires on Running→Idle (`src/terminal.ts:173–175`, wired
  `539–541`) but the registered handler only feeds watch rules + plan advancement;
  `detectAndTriggerTransitions` (`server.ts:430–442`) broadcasts `attention_updated` to
  browser clients but nothing interrupts the Janus Gemini Live session with audio.
- **Root cause:** No mechanism to push a server-side event into the model's audio output;
  the model only learns state when explicitly asked.
- **Operator impact:** The whole point of eyes-off is to not watch — yet completions and
  errors are never announced. The operator must keep asking "is it done yet?", which (via
  BUG-006) often returns a false answer.
- **Suggested fix:** On `onIdle` after Running→Idle, and on new high-severity attention
  items, emit a typed WS event the client converts into a Janus TTS prompt / earcon.
- **Source gaps:** J6-G5 (depends on BUG-010 for client wiring).
- **Status:** ✅ **Resolved (WS-D, `dfb4eba`; review fixes `cb5b0a4` + synthesis round).**
  Per the binding design (`wsd-proactive-audio-design.md` §0) the push is delivered as
  **earcons + a coalescing on-screen notification stack** (NOT a Gemini in-voice path).
  The `AnnouncementBus` (`src/announcementBus.ts`) fires on the genuine WS-C onIdle edge and
  on high-severity transitions, with per-pane debounce, a 1.5s coalescing window, a
  token-bucket rate limit, severity priority, and TTL. The completion now announces on the
  genuine edge regardless of output volume (synthesis fix #3).

#### BUG-021 — Notes are unstructured `string[]` with no timestamp / type / author / ID, and cannot be recalled in-session
- **Priority:** P1
- **Category:** Sub-capable (data model) + Missing (recall) — *systemic*
- **Journeys affected:** J4, J7, J8.
- **Evidence:** `PaneMeta.notes` and `Workspace.notes` are `string[]` (`src/types.ts:30,43`);
  `addNote`/`addPaneNote` push raw strings (`src/ledger.ts:158–163, 181–186`). Notes
  re-enter Janus's context only via `switch_context`'s full briefing
  (`src/ledger.ts:197–209`, called at `server.ts:1263`); there is no `get_project_notes` /
  `search_notes` tool in `server.ts:1577–1834`, and notes are not in the system prompt.
- **Root cause:** Flat string storage with no metadata and no lightweight retrieval path.
- **Operator impact:** Janus cannot answer "what decisions did we make?" / "what did I just
  note?" without a full context reset; cannot sort, filter, search, or expire notes; handoff
  notes are indistinguishable from regular notes. This blocks search, delete-by-ID, and
  categorized briefing.
- **Suggested fix:** Replace `string[]` with a `NoteEntry[]` (`id`, `text`, `timestamp`,
  `type`, `author`, optional `paneId`); add a `get_project_notes` / `search_notes` voice tool
  callable without `switch_context`.
- **Source gaps:** J4-G1, J4-G8, J7-G3, J7-G5, J7-G7, J8-G8.

#### BUG-030 — `get_pane_summary` returns only the last 20 lines, with no delta cursor and no scrollback access
- **Priority:** P1
- **Category:** Sub-capable + Inaccurate-doc
- **Journeys affected:** J8 (primary), J1, J6.
- **Evidence:** `getRecentOutput` slices the last N of a 100-line ring buffer
  (`src/terminal.ts:324–326`, cap at `:68`); `getPaneSummary` calls it with `limit=20`
  (`src/terminal.ts:593`, default at `server.ts:1251`). A 512 KB scrollback file exists
  (`src/terminal.ts:204–218`) but is never read. The tool exposes no `limit`/`offset`/
  `keyword` parameter (`server.ts:1612–1619`), and no per-pane `lastSummarisedIndex` cursor
  exists. The description calls the output a "delta" (`server.ts:1611`) though no delta logic
  exists.
- **Root cause:** Fixed tail slice with no pagination, search, or change-tracking.
- **Operator impact:** A 200-line build shows only the final 20; mid-run errors are silently
  dropped; "anything new since last time?" re-narrates the identical 20 lines, giving no
  progress signal. The "delta" claim (also part of BUG-002's contract lie) is false.
- **Suggested fix:** Add `limit`/`offset` params and a per-pane `lastSummarisedIndex` cursor
  (return `[No new output since last summary]` when unchanged); add a `search_pane_output`
  tool reading the scrollback file.
- **Source gaps:** J8-G4, J8-G5, J1-G15.

#### BUG-031 — No semantic error/warning extraction — raw log noise read aloud (audio-hostile)
- **Priority:** P1
- **Category:** Sub-capable
- **Journeys affected:** J8.
- **Evidence:** `getPaneSummary` hands the raw joined slice to Gemini
  (`src/terminal.ts:593–599`); no extraction pass for `error:`/`FAILED`/`Warning:`/`npm ERR!`
  patterns or exit codes anywhere in the call chain.
- **Root cause:** No server-side structuring of output before narration.
- **Operator impact:** Eyes-off, every syllable is cognitive load — timestamps, hex
  addresses, progress-bar fragments, and module paths are read aloud verbatim, burying the
  signals (errors, exit codes) the operator actually needs.
- **Suggested fix:** Add a pre-processor that annotates the payload with
  `{errors, warnings, exit_code, last_command}`, or a dedicated `get_pane_errors` tool.
- **Source gaps:** J8-G6.

---

### P2 — Notable Friction

---

#### BUG-004 — REST approval path omits frontend broadcasts (no earcon / toast on UI approve-reject)
- **Priority:** P2
- **Category:** Sub-capable (incomplete implementation)
- **Journeys affected:** J2, J3.
- **Evidence:** The voice path broadcasts `command_auto_executed` / `command_blocked`
  (`server.ts:1157–1184`), which fire earcons/toasts (`src/App.tsx:904–914`). The REST
  handler (`server.ts:989–1028`) broadcasts neither, and does not broadcast
  `terminals_updated`.
- **Operator impact:** An operator who approves via the dialog (keyboard/mouse) gets no audio
  acknowledgment and stale pane badges until the next poll.
- **Suggested fix:** Emit the same `command_auto_executed` / `command_blocked` and a
  `terminals_updated` broadcast inside the REST handler.
- **Source gaps:** J2-G4, J3-G11.

#### BUG-017 — REST `/api/commands/approve` has no session scoping (cross-session command injection)
- **Priority:** P2 (security; P1-leaning, but mitigated by the existing "trusted-LAN-only" posture)
- **Category:** Security
- **Journeys affected:** J3, J2.
- **Evidence:** `pendingApprovals` is server-wide (`server.ts:978`); the REST handler looks up
  `pendingApprovals[messageId]` with no session/identity check (`server.ts:989–1028`),
  whereas the voice path filters `details.session === session` (`server.ts:1133`). IDs are
  observable via `GET /api/commands/pending` (`server.ts:980–987`).
- **Operator impact:** Any browser tab can approve/reject another session's pending command by
  knowing its `messageId`. Real in multi-tab / shared-workstation / demo contexts.
- **Suggested fix:** Add a session/client identity check to the REST handler, or scope the map
  per connection.
- **Source gaps:** J3-G6.

#### BUG-018 — Approval / autonomy transitions lack distinct earcons and a `restart_pane` voice path (eyes-off feedback gaps)
- **Priority:** P2
- **Category:** Sub-capable (audio UX) — *merges several feedback gaps*
- **Journeys affected:** J2, J3, J5, J6, J8.
- **Evidence:** `approval_pending` and `command_blocked` both play the identical `alert`
  earcon (`src/App.tsx:876–877` vs `910–911`). `set_pane_permissions` emits only
  `terminals_updated` → a silent `fetchTerminals()` (`src/App.tsx:895–896`), with no
  `permission_changed` event, no earcon, and no prior-state echo (`server.ts:1553–1557`).
  Note-save and Running→Idle transitions have no earcon either
  (`server.ts:1342–1347`; `src/App.tsx:626–656`). No destructive-command risk earcon
  (`src/App.tsx:877` is unconditional).
- **Operator impact:** Eyes-off, the operator cannot distinguish "act now" from
  "already blocked", cannot hear that autonomy actually changed, and gets no audio confirm
  that a note saved or a pane finished.
- **Suggested fix:** Add distinct earcons per event class (pending vs blocked vs
  permission-changed vs note-saved vs completion); emit a `permission_changed` event with old
  + new mode; add a destructive-command risk earcon; have Janus echo the prior mode.
- **Source gaps:** J2-G8, J3-G14, J5-G3, J6-G13, J8-G7.

#### BUG-019 — No approval TTL — an unresolved approval freezes the Gemini session indefinitely
- **Priority:** P2
- **Category:** Sub-capable (reliability)
- **Journeys affected:** J2, J3.
- **Evidence:** `pendingApprovals` entries carry no timestamp and no expiry
  (`server.ts:978`); the HiTL branch withholds the tool response with no TTL
  (`server.ts:1318–1334`); the only cleanup is WS close (`server.ts:1878–1884`).
- **Operator impact:** If the operator walks away or speaks an unrecognized utterance, the
  session stays hard-blocked and Janus mute for the connection's lifetime.
- **Suggested fix:** Add a `timestamp` per entry and a periodic cleanup that auto-rejects
  expired entries via `sendToolResponse` and speaks a timeout announcement.
- **Source gaps:** J2-G9, J3-G7.
- **Status:** ✅ **Resolved (WS-E, `abf2508` + fixes).** Each entry carries a `timestamp`; an
  unref'd periodic sweep (`sweepExpiredApprovals`) auto-rejects entries older than the TTL and
  speaks a timeout narration. Expiry routes through the SAME mandatory `claim()` gate as approve
  (`resolveDecision`, mode `expire`), so a concurrent approve can't stomp an expiry and vice
  versa. The interval is cleared on shutdown (suite self-exits).

#### BUG-020 — REST/voice approval no-ops when the target terminal is missing but reports success
- **Priority:** P2
- **Category:** Broken (silent failure)
- **Journeys affected:** J2, J3.
- **Evidence:** In the REST handler the write is inside `if (term)` but the outer `if
  (pending)` always sends `sendToolResponse(...successfully...)` and `res.json({ success:
  true })` regardless (`server.ts:994–1028`). The voice path has the same `if (term)` gap
  (`server.ts:1141+`).
- **Operator impact:** If a pane was killed between proposal and approval, Janus is told the
  command executed when nothing ran.
- **Suggested fix:** Detect the missing terminal; send an error tool response and HTTP 422 /
  spoken error.
- **Source gaps:** J2-G10.
- **Status:** ✅ **Resolved (WS-E, `abf2508` + fixes).** `resolveDecision` checks a `paneExists`
  predicate on approve: a dead target returns `dead_pane` (no write, record deleted); the shared
  `applyResolution` thin caller then speaks "that pane is gone — I could not dispatch" and the
  REST endpoint returns HTTP 422, never a false success.

#### BUG-022 — Static system-instruction terminal snapshot becomes stale after session start
- **Priority:** P2
- **Category:** Sub-capable
- **Journeys affected:** J6, J1.
- **Evidence:** The system instruction embeds `t.status` for every terminal at session
  creation (`server.ts:1568`) and never refreshes it.
- **Operator impact:** If Janus reasons from the system instruction rather than calling
  `list_panes`, it speaks stale status. (Closely related to BUG-012's frozen-context root
  cause.)
- **Suggested fix:** Remove live terminal state from the system instruction; rely on
  `list_panes` for current state.
- **Source gaps:** J6-G9 (overlaps J1-G10 / BUG-012).

#### BUG-023 — `handoff_context_between_panes` produces no retrievable artifact and injects a shell comment into stdin
- **Priority:** P2
- **Category:** Sub-capable
- **Journeys affected:** J4, J1.
- **Evidence:** Handoff writes a `# === HANDOFF CONTEXT INTERCEPT ===` comment block to the
  target pane's stdin (`server.ts:1533–1534`) plus one untagged pane note
  (`server.ts:1531`). No `handoffs[]` array on `Workspace` (`src/types.ts:37–45`); the note
  is contaminated by the placeholder summaries (BUG-005).
- **Operator impact:** The stdin comment scrolls away in seconds (and Claude Code may try to
  *run* it as a shell command); the untagged note is unsearchable. No "show me the last
  handoff" is possible. The success string implies a richer artifact than exists.
- **Suggested fix:** Add a typed `handoffs[]` ledger array (id, timestamp, source/target
  pane, context notes, last-N commands); keep stdin injection only as a bonus channel using a
  structured prompt the agent understands.
- **Source gaps:** J4-G5, J1-G12.

#### BUG-025 — No elapsed-time / `last_command` context in `list_panes` (hung pane indistinguishable from a fast one)
- **Priority:** P2
- **Category:** Sub-capable (data richness)
- **Journeys affected:** J6.
- **Evidence:** `PaneMeta` has no timestamp field (`src/ledger.ts:4–16`); `syncLedger`
  records no `last_status_change_at` (`src/terminal.ts:564–591`); `last_known_state` is a
  static string with no running-command reference (`src/terminal.ts:576–578`); the attention
  digest carries no age (`server.ts:1360–1373`).
- **Operator impact:** "Running for 2s" and "running for 18 minutes (probably hung)" sound
  identical; stale 3-hour-old alerts read the same as 10-second-old ones.
- **Suggested fix:** Add `last_status_change_at` to `PaneMeta`; surface the most recent
  command string and compute elapsed time in the digest text.
- **Source gaps:** J6-G4, J6-G7, J6-G11.

#### BUG-027 — Prompt buffer commit is keyboard-only and truncates to 100 chars; no voice commit tool
- **Priority:** P2
- **Category:** Missing (hands-free breakage)
- **Journeys affected:** J7.
- **Evidence:** `handleSyncNoteToActiveNode` is bound to a click-only button and hardcodes
  `promptBuffer.slice(0, 100)` (`src/App.tsx:222–232`); no `commit_spec_buffer` voice tool
  exists in `server.ts:1579–1655`.
- **Operator impact:** A voice-only operator cannot durably commit a dictated spec fragment;
  even via keyboard, everything past 100 chars is silently dropped. Combined with BUG-013
  (volatile buffer), the ambient-capture path has no durable landing zone.
- **Suggested fix:** Add a `commit_spec_buffer` voice tool passing the full buffer (no
  truncation) to `addNote`.
- **Source gaps:** J7-G2.

#### BUG-028 — No voice tool to delete or amend a note; `add_pane_note` requires explicit `pane_id` with no active-pane default
- **Priority:** P2
- **Category:** Missing
- **Journeys affected:** J7, J4, J8.
- **Evidence:** No `delete_*`/`amend_note` tools or ledger methods
  (`server.ts:1632–1654`; `src/ledger.ts` has push-only). `add_pane_note` marks `pane_id`
  required (`server.ts:1644–1654`); the client `activeTerminalId` (`src/App.tsx:222`) is
  never transmitted to the server for injection.
- **Operator impact:** A dictation error is permanent by voice; "note this on the current
  pane" forces Janus to guess or ask, adding friction; a wrong/stale `pane_id` silently
  drops the note (see BUG-029).
- **Suggested fix:** Add `delete_project_note` / `delete_pane_note` / `amend_note` tools
  (note-ID based once BUG-021 lands); propagate `activeTerminalId` and default `pane_id` to it.
- **Source gaps:** J4-G9, J7-G4, J7-G6.

#### BUG-029 — `addPaneNote` silently drops the note on a bad project/pane ID while the handler reports success
- **Priority:** P2
- **Category:** Broken (silent failure)
- **Journeys affected:** J8, J7.
- **Evidence:** `addPaneNote` guards on `if (this.workspaces[projectId] && ...panes[paneId])`
  and silently no-ops otherwise (`src/ledger.ts:158–163`); the handler returns
  `"Note added to pane ${args.pane_id}"` unconditionally (`server.ts:1342–1347`).
- **Operator impact:** A stale/typo'd pane ID (common from ASR) discards the note while Janus
  and the operator both believe it was saved.
- **Suggested fix:** Make `addPaneNote` return a boolean / throw; have the handler surface an
  error to the model on failure.
- **Source gaps:** J8-G10, J7-G6.

#### BUG-026 — `set_pane_permissions` accepts arbitrary mode strings and reports success for non-existent panes
- **Priority:** P2
- **Category:** Sub-capable (robustness)
- **Journeys affected:** J5.
- **Evidence:** No enum guard before `term.setPermissionsMode(permissions_mode)`
  (`server.ts:1542–1557`; `src/terminal.ts:118`); the handler returns success even when
  neither the terminal nor the ledger pane exists (`server.ts:1544–1557`); `syncLedger` can
  overwrite a persisted `permissions_mode` with the live value (`src/terminal.ts:582`); a
  promotion does not drain pending approvals for that pane.
- **Operator impact:** A hallucinated mode string (`"Autonomous"`, wrong casing) is accepted
  silently; a missing pane yields a false confirmation.
- **Suggested fix:** Validate against `["Full Auto","Human-in-the-Loop","Read-Only"]`; return
  an error if neither term nor ledger pane exists; prefer the persisted ledger value in
  `syncLedger`; drain/cancel pending approvals on promotion.
- **Source gaps:** J5-G5, J5-G6, J5-G10, J5-G11.

#### BUG-032 — Three divergent restart command strings break session continuity on restore
- **Priority:** P2
- **Category:** Broken (sub-capable)
- **Journeys affected:** J1, J4.
- **Evidence (verified):** `src/terminal.ts:49`
  `"npx @anthropic-ai/claude --resume-previous-session --with-open-textbox"`;
  `src/terminal.ts:410` `"npx @anthropic-ai/claude"`; `src/terminal.ts:506`
  `"npx @anthropic-ai/claude-code"`. Codex similarly diverges: `npx codex-cli` (`:50,:411`)
  vs `npx codex` (`:507`). The REST restart endpoint uses the constructor-restore path
  (`server.ts:551`).
- **Operator impact:** A pane restored after a server restart launches a different CLI binary
  than originally configured, silently breaking session continuity; speculative
  `--resume-previous-session` / `--with-open-textbox` flags may not exist in the installed
  CLI and can cause spawn failures.
- **Suggested fix:** Derive the restore command from the ledger's `session_id` + settings
  presets; collapse the three code paths into one; validate flags against the installed CLI.
- **Source gaps:** J1-G3, J1-G11, J1-G6.

---

### P3 — Polish / Hygiene

---

#### BUG-040 — `POST /api/plans/:id/execute` REST endpoint writes plan step 0 to a pane un-gated
- **Found by:** WS-E fix-round review (least-authority pane-write audit).
- **Category:** Permission / least-authority bypass (REST surface).
- **Priority:** P2 (un-gated execution route, but UI/REST-initiated by the operator, not model-initiated).
- **Description:** The manual REST plan-start endpoint (`server.ts:~985`) writes the plan's first
  step to the target pane WITHOUT passing the effective-mode gate (Full Auto / Human-in-the-Loop /
  Read-Only). WS-E (R4) gated the *voice* `execute_plan` tool path and plan-step *advancement*
  (steps 2..N now route through `activePlanGate`, including for plans started via this endpoint),
  but step 0 of a REST-initiated plan still bypasses the gate. So a plan launched from the UI while
  a pane is Human-in-the-Loop / Read-Only executes its first step without approval.
- **Operator impact:** A UI-launched plan can run its first command on a pane that should require
  approval (or be read-only), inconsistent with the voice path and the least-authority promise.
- **Suggested fix:** Route the REST endpoint's step-0 write through the same effective-mode +
  pending-approval path as `dispatchProposal` / `activePlanGate`. Relates to WS-G (permission truth)
  and the REST-scoping work in WS-L.
- **Status:** OPEN (logged during WS-E; deferred — outside WS-E's voice scope).

---

#### BUG-033 — Doc discrepancies: README/JOURNEYS_DESIGN claims not matched by code
- **Priority:** P3
- **Category:** Inaccurate-doc
- **Journeys affected:** J4, J8, all.
- **Evidence:** `JOURNEYS_DESIGN.md:82` claims the system instruction is reconstructed with
  "file trees, notes, and live status indicators" — code template at `server.ts:1568`
  contains only project IDs, workspace ID/name pairs, and terminal status/CWD (no notes, no
  file trees). `JOURNEYS_DESIGN.md:113` claims Journey 8 output is "redacted… analyzed… and
  spoken back to notes" — none is true (see BUG-002, BUG-031; notes are operator-dictated,
  not auto-generated). `JOURNEYS_DESIGN.md §4` claims "all 6 developer journeys are tested"
  — there are 8 journeys; J7 and J8 have no journey test.
- **Operator/dev impact:** Misleads contributors into wrong mental models and conceals the
  security gap. (See §6 for the full discrepancy list.)
- **Suggested fix:** Correct the three doc claims or implement them; reconcile journey count.
- **Source gaps:** J4-G7, J8-G3, J8-G2.

#### BUG-034 — `idleTimeoutMs` setting is ignored; idle timers hardcode 1000 ms
- **Priority:** P3
- **Category:** Inaccurate-doc
- **Journeys affected:** J1, J6.
- **Evidence:** `getDefaultSettings` exposes `idleTimeoutMs: 2000` (`src/terminal.ts:423`)
  but the timers hardcode `1000` (`src/terminal.ts:187`/`189`, `:267`).
- **Suggested fix:** Read and apply `this.idleTimeoutMs`. (Interacts with BUG-006.)
- **Source gaps:** J1-G9.

#### BUG-035 — `attentionQueue` grows unboundedly; stale items inflate the spoken digest
- **Priority:** P3
- **Category:** Sub-capable (robustness)
- **Journeys affected:** J6, J1.
- **Evidence:** In-memory array, never evicted (`server.ts:430–442`, `1360–1373`); no voice
  `dismiss_attention` tool (dismiss is REST-only, `server.ts:755–770`).
- **Suggested fix:** Cap/TTL-evict the queue; add a `dismiss_attention` voice tool.
- **Source gaps:** J6-G12, J1-G14.
- **Status:** ✅ **Resolved (WS-D, `dfb4eba`; synthesis round).** `pruneAttentionQueue`
  (`src/announcementBus.ts`) caps the queue (50), TTL-evicts active items (10min) and
  dismissed items (60s), dropping oldest-dismissed-first under cap; an unparseable timestamp
  now evicts rather than pinning forever (synthesis fix #6). The `dismiss_attention` voice
  tool is wired in `server.ts`. The cap/TTL consts are named + exported (synthesis fix #9).

#### BUG-036 — `create_project` tool schema omits `key_terms`
- **Priority:** P3
- **Category:** Inaccurate-doc
- **Journeys affected:** J1.
- **Evidence:** Handler reads `key_terms || []` (`server.ts:1375–1376`) but the function
  declaration has no `key_terms` property (`server.ts:1690–1700`).
- **Suggested fix:** Add `key_terms` (array) to the schema.
- **Source gaps:** J1-G8.

#### BUG-037 — `ApprovalDialog` lacks ARIA roles / live region; desktop notifications not auto-requested
- **Priority:** P3
- **Category:** Sub-capable (accessibility)
- **Journeys affected:** J2.
- **Evidence:** No `role="dialog"`/`aria-modal`/`aria-live` (`src/components/ApprovalDialog.tsx:34–36`);
  notifications require prior opt-in (`src/App.tsx:153–175`, `876–878`).
- **Suggested fix:** Add ARIA roles + an `aria-live="assertive"` region reading the command;
  auto-request notification permission on first `approval_pending`.
- **Source gaps:** J2-G13, J2-G15.

#### BUG-038 — Critical heuristics and flows are untested; mock-mode approval simulates a false flow
- **Priority:** P3
- **Category:** Sub-capable (test fidelity)
- **Journeys affected:** all (J6, J2, J3, J8 most).
- **Evidence:** `is_busy`/`updateStatusOnOutput` heuristic has zero coverage — tests set
  `term.status` directly (`tests/test_journeys.ts:221–222`, `tests/test_terminal_manager.ts:19,27`);
  approval tests exercise only React state, not the server gate/voice intercept/REST path
  (`tests/test_approvals.ts`); no Journey 8 test (`tests/test_journeys.ts`); UI
  `activeProjectId` divergence after `switch_context` untested. Mock-mode `handleApprove`/
  `handleReject` short-circuit before the REST call and append hardcoded output
  (`src/App.tsx:660–693`), training operators on a false instant-success model.
- **Suggested fix:** Add integration tests feeding raw output chunks through the heuristic and
  exercising the real approve path; label mock mode as a non-representative UI demo.
- **Source gaps:** J6-G3, J2-G5, J2-G16, J3-G9, J3-G12, J1-G17, J8-G9.
- **Status:** ⚠️ **Partially resolved (2026-06-11).** Closed halves: (a) the `is_busy` /
  status heuristic now has the `decideStatus` replay harness (`tests/test_status_machine.ts`,
  written against BUG-038/BUG-006); (b) the server-side approval gate / voice-intercept / REST
  paths are exercised by `tests/test_approvals_wse.ts`, `tests/test_store_approvals.ts`,
  `tests/test_voice_approval_routing.ts` and the approval e2e specs; (c) the missing J7/J8
  journey tests (J8-G9, drift item D5) landed in `tests/test_journeys.ts` (`f91e518`), covering
  dictate→durable-note→recall→restart and pane-tail→redaction→note-capture. **Still open:**
  mock-mode `handleApprove`/`handleReject` short-circuit before the REST call and append
  hardcoded output (`src/App.tsx`), and the UI `activeProjectId` divergence after
  `switch_context` remains untested — bead seed `docs/beads/2026-06-11-journey-coverage.jsonl`.

#### BUG-039 — "Shared Spec Sandbox" UI label implies durability the buffer does not have
- **Priority:** P3
- **Category:** Inaccurate-doc
- **Journeys affected:** J7.
- **Evidence:** `src/App.tsx:1593` "Janus reads this buffer in real-time" with no
  "session-only" qualifier; buffer is volatile (`server.ts:133`, see BUG-013).
- **Suggested fix:** Add a "(session only — not saved)" qualifier until persistence lands.
- **Source gaps:** J7-G13.

---

## 4. Systemic / Cross-Cutting Defects

A small number of root causes each break multiple journeys. Fixing these in roughly this
order converts "eight journeys that work alone" into "one loop the operator can live in."

1. **~~Dead command-outcome summarizer (BUG-005)~~ — RETRACTED.** `gemini-3.5-flash` is a
   valid model (maintainer correction); the summarizer works. The real residual is that it
   sends raw output to the model **unredacted** (finding N-5) — closed by WS-B, not by any
   model change.
2. **Unsynced `switch_context` + frozen system prompt + unhandled WS events
   (BUG-012, BUG-010, BUG-022).** Structural changes never propagate to the model context or
   the UI focus, and the server's push events are dropped by the client. Touches all 8
   journeys; the most viral crack.
3. **In-memory-only volatile state (BUG-013, BUG-014).** `pendingApprovals`,
   `promptBufferText`, `lastSessionResumptionToken`, `attentionQueue` all die on restart —
   collapsing continuity (J4), spec capture (J7), and pending approvals (J2/J3).
4. **Unreliable `is_busy` (BUG-006).** False idle on any non-trivial workload feeds a wrong
   status into every downstream decision (J6 core; ripples to J1/J5/J8).
5. **Janus-mute-while-pending + blind/mis-targeted approval (BUG-001, BUG-007, BUG-008).**
   The supervise→review bridge is silence + one undifferentiated earcon; the safety harness
   becomes a blindfold eyes-off (J2/J3).
6. **Global-first permission resolver (BUG-003).** Per-pane autonomy changes are silent
   no-ops whenever global ≠ Inherit; "done" over a no-op (J5; gate they feed, J2/J3).
7. **No proactive audio push (BUG-024).** Completions/errors are detected but never spoken —
   directly contradicts the eyes-off premise (J6 core; J1/J2/J5/J8).
8. **No output redaction (BUG-002).** Secrets flow verbatim to Gemini through every
   `get_pane_summary` and the approval rationale snapshot (J8 primary; J2/J3/J4).
9. **Honest-tool-contract violations (BUG-002, BUG-009, BUG-030, BUG-033).** Tool
   descriptions claim "redacted/clean/delta" and "approvals" that the implementations do not
   deliver — actively mis-steering the model at inference time.

---

## 5. What Genuinely Works (Do Not Over-Correct)

These were verified solid against the code and should be preserved:

- **Real, concurrent PTY spawn (J1).** `create_pane` spins genuine child processes via
  `script -q -f -c` with `detached: true` and a 512 KB scrollback log; multiple panes run
  truly concurrently (`src/terminal.ts:220–316`). This is the foundation the loop stands on.
- **Atomic ledger persistence (cross-cutting).** All saves use a write-then-rename `.tmp`
  swap, both async (debounced) and sync (`src/ledger.ts:88–127`); survives restart and
  concurrent writes without corruption.
- **Durable note capture (J7/J4).** `add_project_note` / `add_pane_note` →
  `Ledger.addNote`/`addPaneNote` → synchronous atomic write before the tool response
  (`src/ledger.ts:158–186`); REST and voice share one code path; round-trip tested
  (`tests/test_ledger.ts:36–50`). The most reliable verb in the system.
- **`alive` is trustworthy (J6).** Driven by real `process.on('exit'|'close'|'error')`
  events (`src/terminal.ts:304–315`); dead panes are reported correctly.
- **The HiTL *gate itself* is correctly enforced (J2/J3).** The three-branch resolver
  (Full Auto / Read-Only / Human-in-the-Loop) and the atomic approve/reject execution path
  unblock the session correctly when the operator already knows what is pending
  (`server.ts:1267–1335`); per-session pending filtering prevents cross-session voice leakage
  (`server.ts:1133`); session cleanup on WS close prevents tool-call leaks.
- **`switch_context` *briefing payload* is intact (J4).** Notes, pane metadata, directory,
  and key terms all return correctly; durable notes from earlier in the session are present
  (`src/ledger.ts:197–209`). (The defect is propagation/UI sync, not the payload.)
- **`get_pane_summary` returns real, correctly ANSI-stripped output (J8).** The 100-line ring
  buffer is genuine; `stripAnsiSequences` is well-formed; markdown fencing is correct; buffer
  overflow is handled without leaks (`src/terminal.ts:56–60, 279–326, 593–599`). (The defects
  are redaction, delta, windowing, and the description — not the stripping.)
- **Differentiated earcons + half-duplex barge-in (audio).** Three distinct synthesized
  earcons (alert/execute/chime) via the Web Audio API; the barge-in guard prevents audio
  loopback (`src/App.tsx:73–151, 857–859`). (The gap is *coverage* of events, not the
  primitive.)
- **Watch rules (J1 coordination).** One-shot "when pane A goes idle, run X on pane B" fires
  reliably (`server.ts:266–292`) — a primitive but working parallel-coordination mechanism.
- **Context-window compression is configured** (`triggerTokens: 25000`,
  `slidingWindow.targetTokens: 16000`, `server.ts:1572–1574`), reducing overflow risk in long
  sessions.

---

## 6. Doc Discrepancies (README / JOURNEYS_DESIGN vs Code)

| # | Doc claim | Reality | Evidence | Bug |
|---|---|---|---|---|
| D1 | `JOURNEYS_DESIGN.md:113`: Journey 8 output is "redacted… analyzed… and spoken back to notes." | No redaction, no server-side analysis, notes are operator-dictated (not auto-generated). | `src/terminal.ts:56–60, 593–599`; `src/ledger.ts:158–163`; `server.ts:1342–1347` | BUG-002, BUG-031, BUG-033 |
| D2 | `server.ts:1611` `get_pane_summary` description: "clean, redacted markdown delta." | Raw, unredacted, full-tail (not a delta) last-20-lines. | `server.ts:1611` vs `src/terminal.ts:324–326, 593–599` | BUG-002, BUG-030 |
| D3 | `server.ts:1683` `get_attention_digest` description: covers "approvals." | Reads only `attentionQueue`; never includes `pendingApprovals`. | `server.ts:1683` vs `server.ts:1360–1373` | BUG-009 |
| D4 | `JOURNEYS_DESIGN.md:82`: system instruction includes "file trees, notes, live status indicators." | Template has project IDs + workspace ID/name + terminal status/CWD only; no notes, no file trees. | `server.ts:1568` | BUG-033 |
| D5 | `JOURNEYS_DESIGN.md §4`: "all 6 developer journeys are tested." | ✅ **Resolved 2026-06-11** — J7/J8 journey tests added (`f91e518`); §4 now states all 8 journeys are tested. | `tests/test_journeys.ts` (J1–J8) | BUG-033, BUG-038 |
| D6 | README permissions table | Accurate, **but** omits that per-pane changes are no-ops while global ≠ Inherit — the silent-override consequence. | `README.md:41–56` vs `server.ts:1272–1276` | BUG-003 (J5-G4) |
| D7 | `src/App.tsx:1593` "Shared Spec Sandbox… reads this buffer in real-time." | Implies durability; the buffer is volatile and lost on restart. | `src/App.tsx:1593` vs `server.ts:133` | BUG-039 |
| D8 | README "Agent tools" / WS message list | Does not document the orchestration tools/events (`create_pane`, `create_project`, `execute_plan`, watch rules, attention digest, handoff) or the dropped push events — understates surface area while overstating what the client consumes. | `server.ts:1577–1834` vs `src/App.tsx:872–922` | BUG-010 |

**Missing `BACKLOG.md`:** `JOURNEYS_DESIGN.md` / the journey narratives imply a tracked
backlog, but no `BACKLOG.md` exists in the repository (verified by filesystem + grep). This
`BUG_LOG.md` stands in for it.

---

*End of consolidated bug log. 39 distinct defects; counts and P0 list in the cover summary.*
