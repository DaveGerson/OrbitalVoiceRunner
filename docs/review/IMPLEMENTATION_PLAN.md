# OrbitalVoiceRunner — Implementation Plan

> **Scope:** A build-ready remediation plan for the 39 defects in
> [`BUG_LOG.md`](BUG_LOG.md) plus the new findings from
> [`final-review.md`](final-review.md) (N-1 double-dispatch race, N-2 crash
> orphans, N-5 second exfiltration path). It turns the prioritized findings into
> sequenced workstreams with concrete file/function targets, data-model and
> tool-schema changes, acceptance criteria, and tests.
>
> **North-star goal:** move OrbitalVoiceRunner from *"a solid backbone with broken
> connective tissue — not hands-free-safe"* to a product that satisfies the seven
> non-negotiable **hands-free-safe gate** properties (see [§7](#7-definition-of-done--the-hands-free-safe-gate)).
>
> **Lens (unchanged):** voice-only, hands-free, eyes-off. Priority = operator
> impact when the operator *cannot glance at the screen to recover*.
>
> **Preserve, do not regress:** the verified-solid "nouns" — real concurrent PTY
> spawn, atomic ledger, durable note write, trustworthy `alive`, correct HiTL gate
> branch logic, ANSI stripping, barge-in. Every change below must leave these intact.

---

## 1. How this plan is organized

The 39 bugs do not map cleanly one-to-one onto pull requests — many share a root
cause. The plan groups them into **12 workstreams (WS-A … WS-L)**, each a coherent
unit of work with its own tests and acceptance criteria, then sequences the
workstreams across **four milestones (M0–M3)** driven by the hard dependencies the
audit identified:

- **`redaction (WS-B) → summarizer-on (WS-A item)`** — turning the summarizer on
  before redaction *worsens* secret exfiltration (finding N-5).
- **`reliable status (WS-C) → proactive audio (WS-D)`** — pushing completions
  before status is trustworthy just announces false "done" confidently.
- **`two-phase proposal (WS-E core) → targeting + parser (WS-E rest)`** — you must
  be able to *speak* the pending command before you can safely disambiguate it.

Effort key: **S** ≈ <½ day · **M** ≈ 1–3 days · **L** ≈ multi-day / structural.

---

## 2. Milestone overview

| Milestone | Theme | Workstreams | Gate-properties advanced |
|---|---|---|---|
| **M0 — Stop lying** | One-liners & honest contracts; nothing that needs structure. Ship immediately. | WS-A | Removes confidently-false signals; unblocks nothing dangerous. |
| **M1 — The safety gate** | The seven non-negotiables. This is the bulk of the work and the bar for "hands-free-safe." | WS-B, WS-C, WS-D, WS-E, WS-F, WS-G, WS-H | (1) redaction, (2) spoken approval, (3) targeting+parser, (4) reliable status, (5) permission truth, (6) durable/race-safe state, (7) proactive audio — **all of them**. |
| **M2 — Continuity & comprehension** | Make the loop *good*, not just safe: real knowledge model, richer summaries, parallel fan-out. | WS-I, WS-J, WS-K | Continuity (C3), knowledge recall, J8 comprehension, J1 parallelism. |
| **M3 — Hardening & polish** | Security scoping, earcons, crash safety, docs/tests/a11y. | WS-L | Robustness, accessibility, test fidelity. |

> **Critical-path note:** M1 is **not** parallelizable end-to-end. Within M1 the
> hard ordering is `WS-B before WS-A's summarizer flip`, and `WS-C before WS-D`.
> WS-E/F/G/H can proceed concurrently with WS-B/C once M0 lands, but the durable
> queue (WS-F) and the two-phase proposal (WS-E) should land together because they
> touch the same `pendingApprovals` lifecycle.

---

## 3. Dependency graph (hard edges only)

```
M0 ─ WS-A (honesty/quick wins, minus summarizer flip)
        │
        ▼
M1 ─ WS-B  redaction layer ───────────────► WS-A* (flip summarizer model on)
     WS-C  reliable status ───────────────► WS-D  proactive audio + event bus
     WS-E  two-phase proposal ───────────► WS-E' targeting + safer parser
     WS-F  durable + race-safe state ◄──── (co-lands with WS-E; shared pendingApprovals)
     WS-G  permission truth (independent)
     WS-H  context propagation (independent)
        │
        ▼
M2 ─ WS-I notes model · WS-J summary richness · WS-K parallel plans
        │
        ▼
M3 ─ WS-L hardening/polish (REST scoping, earcons, crash handlers, docs, tests, a11y)
```

`WS-A*` = the single line `server.ts:210` model-name change, deliberately deferred
out of M0 into M1 *behind* WS-B.

---

## 4. Workstreams

Each workstream lists the bugs it closes, the concrete changes (file:line targets
from the bug log/audit), new tool/data-model surface, acceptance criteria, and tests.

---

### WS-A — Honesty & quick wins  *(M0, effort S)*
**Closes:** BUG-005 *(comment/flag only in M0; model flip deferred)*, the doc half of
BUG-002/BUG-009/BUG-030/BUG-033/BUG-039, BUG-026 (validation), BUG-029 (surface
failure), BUG-036.
**Goal:** stop the codebase and the model from asserting things that are not true.
Nothing here is structurally risky; all of it is shippable in one PR.

| Change | Target | Detail |
|---|---|---|
| Delete the phantom sort comment | `server.ts:1135` | Remove the `// Sort to resolve the earliest…` comment (no sort exists). Real targeting is WS-E'. |
| Fix `get_pane_summary` description | `server.ts:1611` | Replace "clean, redacted markdown delta" with the *true* current behavior ("last N lines of raw, ANSI-stripped pane output"). Restore richer wording only when WS-B/WS-J ship. |
| Fix `get_attention_digest` description | `server.ts:1683` | Remove "approvals" until the digest actually merges `pendingApprovals` (WS-E/BUG-009). |
| Doc corrections | `JOURNEYS_DESIGN.md:82,113`, `README.md:41–56`, `src/App.tsx:1593` | Correct the system-instruction claim, the J8 "redacted/analyzed" claim, add the global-override consequence to the permissions table, add "(session only — not saved)" to the spec-buffer label. Reconcile the "6 journeys" → 8 claim. |
| `set_pane_permissions` input guard | `server.ts:1542–1557` | Reject modes not in `["Full Auto","Human-in-the-Loop","Read-Only"]`; return an error tool response if neither terminal nor ledger pane exists. (BUG-026) |
| Surface note-write failures | `src/ledger.ts:158–163`; `server.ts:1342–1347` | `addPaneNote`/`addNote` return a boolean (or throw); handler reports an error to the model on miss instead of unconditional success. (BUG-029) |
| `create_project` schema | `server.ts:1690–1700` | Add `key_terms: array` to the function declaration (handler already reads it). (BUG-036) |
| Honor `idleTimeoutMs` | `src/terminal.ts:187,189,267,423` | Read `this.idleTimeoutMs` instead of hardcoded `1000`. (BUG-034 — also a prerequisite for WS-C not re-introducing magic numbers, per N-3.) |

**Acceptance:** no tool description claims behavior the code does not implement;
`set_pane_permissions` and note tools never return success on a no-op; grep for the
phantom comment and the hardcoded `1000` returns nothing.
**Tests:** unit tests asserting (a) invalid permission mode → error, (b) `addPaneNote`
to a bad id → failure surfaced, (c) idle timer reads the configured value.

---

### WS-B — Output safety / redaction layer  *(M1, effort M)*  ⛔ gates WS-A* summarizer flip
**Closes:** BUG-002, and finding **N-5** (the second, separate exfiltration path).
**Root cause:** no secret-scrubbing exists anywhere; raw pane output reaches Gemini
through *three* paths.

**Implementation:**
1. Add a single `redactSecrets(text: string): string` utility (co-locate with
   `stripAnsiSequences`, `src/terminal.ts:56`). Patterns to scrub → `[REDACTED:<type>]`:
   - AWS access keys `AKIA[0-9A-Z]{16}` and secret-key shapes;
   - JWTs `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`;
   - PEM blocks `-----BEGIN [A-Z ]*PRIVATE KEY-----` … `END`;
   - common `.env` token shapes `(?i)(api[_-]?key|secret|token|password|passwd|bearer)\s*[=:]\s*\S+`;
   - GitHub/Slack/Google token prefixes (`ghp_`, `xox[baprs]-`, `AIza…`).
2. Apply it at **all three** sinks (the audit's key correction — N-5):
   - `getPaneSummary` before fencing — `src/terminal.ts:593–599`;
   - the HiTL approval **rationale snapshot** — `server.ts:1322–1324`;
   - `summarizeCommandOutcome`'s `rawOutput.slice(-3000)` send — `server.ts:202–212`.
3. Make redaction a defense-in-depth default-on; expose a settings flag only to
   *tighten*, never to disable silently.
4. Re-introduce the honest "redacted" wording in the `get_pane_summary` description
   (`server.ts:1611`) **now that it is true** (reverses the WS-A placeholder).

**Acceptance:** a pane printing an AWS key / JWT / `.env` line yields `[REDACTED:*]`
in (a) the `get_pane_summary` tool response, (b) the approval rationale, (c) the
summarizer input — verified by test. No raw secret string crosses the Gemini boundary.
**Tests:** table-driven unit tests over each pattern at each of the three sinks; a
negative test that ordinary output is untouched.

---

### WS-A* — Re-enable the summarizer  *(M1, effort S; strictly after WS-B)*
**Closes:** BUG-005 (the actual fix).
**Change:** `server.ts:210` `model: "gemini-3.5-flash"` → a real model
(`gemini-2.5-flash`). Keep the `catch` fallback but log the error (don't swallow it
silently) so a future model break is visible.
**Why gated:** turning the summarizer on routes `rawOutput.slice(-3000)` to Gemini;
without WS-B this *opens* a new leak (N-5). Do not ship before WS-B.
**Acceptance:** an integration smoke test asserts `summarizeCommandOutcome` returns a
non-placeholder, non-empty, command-specific summary for a known command, and that a
*failed* command summary is distinguishable from a success (no more universal
"Execution finished successfully.").

---

### WS-C — Reliable busy/idle signal  *(M1, effort L)*  ⛔ gates WS-D
**Closes:** BUG-006, BUG-025, BUG-022 (stale snapshot), the heuristic half of BUG-038;
folds in N-3.
**Root cause:** a 1 s silence timer + an over-broad prompt regex
(`src/terminal.ts:160–189`) used as the authoritative busy signal.

**Implementation (pick the strongest feasible, in order of preference):**
1. **PTY prompt sentinel (preferred).** After each command write, emit a unique
   marker (e.g. `printf '\x1f<nonce>\x1f'` appended to the command, or a shell
   `PROMPT_COMMAND`/`PS1` sentinel) and treat *return of the sentinel* as the
   authoritative return-to-prompt. Status is `Running` until the sentinel for the
   in-flight command is observed.
2. **`/proc/[pid]/stat` fallback** (Linux) for panes where a sentinel can't be
   injected (raw agent CLIs): poll the child/descendant process state (`R`/`S`/`D`)
   and foreground pgid to infer busy.
3. Narrow the existing regex to a genuine *prompt-only* line (anchored, on an
   otherwise-empty line) and use it only as a tertiary hint — never as the sole
   trigger. Honor `idleTimeoutMs` (N-3) where a timer is still used.
4. Add `last_status_change_at` to `PaneMeta` (`src/ledger.ts:4–16`), set it in
   `syncLedger` (`src/terminal.ts:564–591`), surface elapsed time + the
   `last_command` string in `list_panes` and the attention digest (BUG-025).
5. Remove live `t.status` from the static system instruction (`server.ts:1568`) so
   Janus relies on `list_panes` for current state (BUG-022).

**Acceptance:** a command that runs >1 s while silent, and a command whose output
ends in `>`/`?`, both report `Running` until genuinely complete; a hung pane reports
a large elapsed time distinct from a fresh one.
**Tests (this is BUG-038's core):** feed recorded raw output chunks through
`updateStatusOnOutput`/the sentinel logic and assert the status timeline — the first
behavioral coverage of the most failure-prone heuristic in the repo.

---

### WS-D — Proactive audio + event bus  *(M1, effort L; strictly after WS-C)*
**Closes:** BUG-024 (**promoted to P0-grade** by the audit), BUG-010.
**Root cause:** server detects completions/errors but only feeds watch-rules and a
browser badge; the client drops 9 broadcast event types and polls every 3 s.

**Implementation:**
1. **Client wiring (BUG-010):** add `ws.onmessage` branches in `App.tsx`
   (`src/App.tsx:870–927`) for `attention_updated`, `plans_updated`,
   `watch_rules_updated`, `pane_transition`, `plan_step_completed`, `plan_completed`,
   `plan_paused`, `history_updated`, `watch_rule_fired`; drive the matching setters
   and earcons from the pushed payload; reduce reliance on the 3 s poll.
2. **Audio push (BUG-024):** on `onIdle` after a *genuine* Running→Idle (WS-C) and on
   new high-severity attention items (`detectAndTriggerTransitions`,
   `server.ts:430–442`), emit a typed event the client converts into a Janus TTS
   interrupt / earcon (e.g. "Tests pane finished; exit code 0" / "Build pane errored").
   Respect barge-in and the half-duplex gate so pushes don't talk over the operator.
3. Add a `dismiss_attention` voice tool and cap/TTL-evict `attentionQueue`
   (BUG-035 — pulled forward here since it shares the queue).

**Acceptance:** with the operator silent, a pane that finishes or errors produces a
spoken announcement within ~1 s of the *true* transition (never on a false idle —
guaranteed by the WS-C dependency).
**Tests:** simulate a Running→Idle transition and assert a push event is emitted;
assert no push fires on a false-idle input (regression guard for the WS-C coupling).

---

### WS-E — Spoken, targeted, safe approvals  *(M1, effort L)*
**Closes:** BUG-001, BUG-007, BUG-008, BUG-009, BUG-016, BUG-019, BUG-020.
**Root cause:** "block execution" is coupled to "block the model's voice"; the voice
parser is a naive substring match; multi-pending resolves FIFO.

**Implementation — in two sub-steps (ordering matters):**

**WS-E.1 Two-phase proposal + speak-before-approve (BUG-001, BUG-016, BUG-009):**
1. Decouple the spoken pre-announcement from the blocking tool response. When
   `propose_command` hits the HiTL branch (`server.ts:1318–1334`), instead of going
   silent, send a *non-blocking* `pending_approval` result so Janus speaks
   *"I want to run `X` on pane `Y` — approve?"*; track the open vote on a side channel
   keyed by message id.
2. Add a `list_pending_approvals` voice tool (declare in `server.ts:1577–1834`,
   reading the same map `GET /api/commands/pending` uses, `server.ts:980–987`):
   returns pane, command, rationale, count.
3. Fix `get_attention_digest` to **merge** `pendingApprovals` (or delegate to the new
   tool) so "what needs my attention?" includes approvals (BUG-009), and restore the
   "approvals" wording reversed in WS-A.

**WS-E.2 Targeting + safer parser (BUG-007, BUG-008) — depends on E.1:**
4. Bind voice resolution to the **most-recently-announced** pending id (not
   `pendingEntries[0]`, `server.ts:1133–1136`); support fragment/ordinal targeting
   ("approve the docker command", "reject the second one"); **speak the pane+command
   read-back** at/just before resolution.
5. Harden the parser (`server.ts:1128–1139`): add a 3-token **negation window**
   (`not/no/don't/never`), normalize apostrophes (ASR drops them), require explicit
   pairing ("approve command"/"reject command") as the primary trigger, and on
   `isApprove && isReject` send a **clarification** tool response instead of
   defaulting to approve.

**WS-E.3 Robustness (BUG-019, BUG-020):**
6. Add a `timestamp` per pending entry + periodic cleanup that **auto-rejects expired
   entries** via `sendToolResponse` and speaks a timeout note (BUG-019) — no more
   indefinitely-frozen session.
7. If the target terminal is gone at resolution time, send an *error* tool response
   and spoken error instead of unconditional success (BUG-020;
   `server.ts:994–1028`, `:1141+`).

**Acceptance:** every voice approval is preceded by a spoken command read-back; with
3 panes pending, "approve the npm install" resolves *that* command (verified) and
speaks which pane; "I don't want to cancel" does **not** reject; an unresolved
approval auto-expires with a spoken notice; approving a dead pane yields a spoken
error.
**Tests:** parser table tests (negation, apostrophe, collision→clarify); a
multi-pending targeting test; a TTL-expiry test; an integration test of the real
gate path (not just React state — closes part of BUG-038).

---

### WS-F — Durable & race-safe in-flight state  *(M1, effort L; co-lands with WS-E)*
**Closes:** BUG-013, BUG-014, and finding **N-1** (double-dispatch race).
**Root cause:** `pendingApprovals`, `promptBufferText`, `lastSessionResumptionToken`,
`attentionQueue` are all in-memory and lost on restart; the maps are mutated from both
REST and WS paths with no atomicity.

**Implementation:**
1. **Persist** the four pieces of volatile state alongside the ledger (extend
   `src/ledger.ts:89–96`/`115–119` serialization or a sidecar file using the same
   atomic write-then-rename): `pendingApprovals` (`server.ts:978`), `promptBufferText`
   (`server.ts:133`), `lastSessionResumptionToken` (`server.ts:1030`), and a
   capped `attentionQueue`.
2. **Reconnect restore:** on WS open, reload pending approvals and **re-issue**
   `approval_pending` events; re-attach the Gemini session via the resumption token
   with a TTL check (BUG-014).
3. **Stop silent purge:** the WS-close cleanup (`server.ts:1879–1883`) must *persist*
   pending entries and alert, not silently `delete` them.
4. **Race safety (N-1):** wrap the read-then-delete of a pending entry in an atomic
   claim (a per-message-id `claimed` flag set before `term.writeInput`, or a simple
   mutex/queue) so a near-simultaneous REST + voice approve **cannot double-dispatch**
   the command to the PTY (`server.ts:997` and `:1143`).

**Acceptance:** a server restart mid-approval preserves the pending command and
re-announces it on reconnect; a dictated spec fragment survives restart; firing a REST
approve and a voice approve for the same id concurrently dispatches the command
**exactly once** (verified by a contention test).
**Tests:** persistence round-trip test; a concurrency test that races the two approve
paths and asserts a single `writeInput`.

---

### WS-G — Permission truth  *(M1, effort S→M; independent)*
**Closes:** BUG-003, BUG-015, BUG-026 (runtime half), finding **N-4**.
**Root cause:** global-first resolver makes per-pane changes silent no-ops; the
Full-Auto flag never reaches the live PTY; `syncLedger` can clobber persisted intent.

**Implementation:**
1. **Global-override rider (BUG-003):** in `set_pane_permissions`
   (`server.ts:1542–1557`) read `globalPermissionsMode`; if ≠ `Inherit`, return a
   spoken caveat ("global mode is X, so this pane change won't affect gating until you
   set global to Inherit"). Mirror the rule in the tool description and system
   instruction so Janus can warn *proactively*.
2. **`restart_pane` voice tool (BUG-015):** declare it (`server.ts:1577–1834`), wired
   to `term.stop(); term.start()`; have `setPermissionsMode` (`src/terminal.ts:118–130`)
   return a `restartRequired` flag and have Janus offer/perform the restart so Full
   Auto actually reaches the live subprocess. Drain/cancel pending approvals for a pane
   on promotion (links to WS-E/WS-F).
3. **Don't clobber persisted intent (N-4):** in `syncLedger` (`src/terminal.ts:582`)
   prefer the persisted ledger `permissions_mode` over the live spawn-time default.

**Acceptance:** promoting a pane while global=Full-Auto produces a spoken caveat;
`restart_pane` makes a Full-Auto promotion take effect on the live process; a sync
does not silently revert an operator's persisted mode.
**Tests:** resolver truth-table test; a `restart_pane` integration test; a sync test
asserting persisted mode wins.

---

### WS-H — Context propagation  *(M1, effort M; independent)*
**Closes:** BUG-012, and the dynamic half of BUG-022.
**Root cause:** structural changes (create pane, switch context) emit no event that
the model context or UI focus consumes; system prompt frozen at connect.

**Implementation:**
1. Emit a `context_switched` WS event from `switch_context` (`server.ts:1255–1266`)
   carrying the new `activeProjectId` (+ active terminal).
2. Handle it in `App.tsx` (`src/App.tsx:897–898`) to call
   `setActiveProjectId`/`setActiveTerminalId` — voice focus and UI focus stop
   diverging.
3. After any structural change (`create_pane`, `create_project`, `switch_context`),
   inject an ephemeral context update into the session **or** instruct Janus to
   re-call `list_panes`, so newly created panes become visible without a reconnect.
4. Drop the frozen live-status snapshot from the static system instruction (shared
   with WS-C item 5).

**Acceptance:** after a voice `switch_context`, the UI highlights the new project;
after `create_pane`, Janus can immediately address the new pane without a manual
`list_panes`.
**Tests:** a UI-state test asserting `activeProjectId` updates on `context_switched`;
a model-context test that a freshly created pane is referenceable.

---

### WS-I — Knowledge & notes model  *(M2, effort M)*
**Closes:** BUG-021, BUG-023, BUG-027, BUG-028, BUG-029 (model half).
**Root cause:** notes are flat `string[]` with no metadata or recall; handoff produces
no retrievable artifact.

**Implementation:**
1. Replace `string[]` notes with `NoteEntry[]` (`src/types.ts:30,43`):
   `{ id, text, timestamp, type: 'decision'|'todo'|'warning'|'note', author, paneId? }`;
   migrate existing string notes on load (wrap as `type:'note'`).
2. Add voice tools: `get_project_notes`, `search_notes`, `delete_note`/`amend_note`
   (id-based), and `commit_spec_buffer` (passes the **full** prompt buffer — no 100-char
   truncation — to `addNote`, replacing the keyboard-only path
   `src/App.tsx:222–232`). (BUG-027, BUG-028, BUG-021 recall.)
3. Default `add_pane_note`'s `pane_id` to the active pane: propagate
   `activeTerminalId` (`src/App.tsx:222`) to the server. (BUG-028)
4. Typed `handoffs[]` array on `Workspace` (`src/types.ts:37–45`):
   `{ id, timestamp, sourcePane, targetPane, contextNotes, lastCommands }`; keep the
   stdin injection only as a *structured* bonus channel the agent understands, not the
   system of record. (BUG-023)

**Acceptance:** Janus can answer "what decisions did we make?" without a
`switch_context`; a dictated spec commits in full by voice; a handoff is retrievable
("show me the last handoff"); a note can be deleted/amended by voice.
**Tests:** note CRUD + search round-trip; migration test (old `string[]` → `NoteEntry[]`);
handoff artifact persistence test.

---

### WS-J — Pane-summary richness  *(M2, effort M)*
**Closes:** BUG-030, BUG-031.
**Root cause:** fixed last-20-line tail, no delta, no scrollback access, no semantic
extraction — audio-hostile.

**Implementation:**
1. Add `limit`/`offset`/`keyword` params to `get_pane_summary`
   (`server.ts:1612–1619`) and a per-pane `lastSummarisedIndex` cursor; return
   `[No new output since last summary]` when unchanged (true delta). (BUG-030)
2. Add a `search_pane_output` tool that reads the existing 512 KB scrollback file
   (`src/terminal.ts:204–218`), which is currently written but never read. (BUG-030)
3. Add a pre-processor / `get_pane_errors` tool that annotates the payload with
   `{ errors, warnings, exit_code, last_command }` (scan `error:`/`FAILED`/`Warning:`/
   `npm ERR!`) so the operator hears signal, not log noise. (BUG-031)

**Acceptance:** "anything new since last time?" returns only new lines; a 200-line
build is searchable beyond the last 20; "any errors?" returns extracted errors, not
raw scrollback.
**Tests:** delta-cursor test; scrollback search test; error-extraction test over
sample logs.

---

### WS-K — Parallel fan-out  *(M2, effort M)*
**Closes:** BUG-011.
**Root cause:** `execute_plan` advances `currentStepIndex` strictly serially;
the `Plan` type has no concurrent step group.

**Implementation:** add a `parallel_group` step type to `Plan` (`types.ts:130–136`);
in `handlePlansTrigger` (`server.ts:294–377`) dispatch all members of a group
simultaneously and join when all reach their expected transition (leans on the WS-C
reliable transition signal to know when each member is genuinely done).

**Acceptance:** a plan with a parallel group runs its members concurrently and only
advances after all complete.
**Tests:** a plan-execution test asserting concurrent dispatch + join semantics.

---

### WS-L — Hardening, security scoping & polish  *(M3, effort S each)*
**Closes:** BUG-017, BUG-018, BUG-032, BUG-035*, BUG-037, BUG-038 (remainder), N-2;
mock-mode relabel.

| Item | Target | Detail |
|---|---|---|
| REST session scoping (BUG-017) | `server.ts:989–1028` | Add a session/identity check to `/api/commands/approve` (or scope the map per connection) so one authenticated tab can't resolve another's approval. *(P2 — mitigated by the shared-token gate; audit refined the threat model.)* |
| Distinct earcons (BUG-018) | `src/App.tsx:876–911`; `server.ts:1553–1557` | Per-event-class earcons (pending vs blocked vs permission-changed vs note-saved vs completion); emit a `permission_changed` event with old+new mode; add a destructive-command risk earcon. |
| Collapse restart command strings (BUG-032) | `src/terminal.ts:49,410,506`; `server.ts:551` | Derive the restore command from the ledger `session_id` + settings presets; one code path; validate flags against the installed CLI. |
| Crash-safe PTY reaping (N-2) | `server.ts` (add handlers); `src/terminal.ts:255–259` | Add `uncaughtException`/`unhandledRejection` handlers and/or track child PIDs in a file for reap-on-restart; consider `proc.unref()`. Graceful SIGINT/SIGTERM is already handled. |
| ApprovalDialog a11y (BUG-037) | `src/components/ApprovalDialog.tsx:34–36`; `src/App.tsx:153–175` | `role="dialog"` + `aria-modal` + an `aria-live="assertive"` region reading the command; auto-request notification permission on first `approval_pending`. |
| Mock-mode honesty (BUG-038) | `src/App.tsx:660–693` | Relabel mock-mode as a non-representative UI demo (it short-circuits the real gate with hardcoded output). |

\* `attentionQueue` cap/TTL + `dismiss_attention` (BUG-035) is pulled forward into
WS-D since it shares the queue; only any residual polish remains here.

**Acceptance:** cross-tab approval is rejected; each audio event is distinguishable;
restored panes launch the originally-configured CLI; a server crash leaves no orphaned
agent CLIs; the approval dialog is screen-reader-legible.

---

## 5. Sequencing & effort summary

| Order | Workstream | Milestone | Effort | Hard dependency |
|---|---|---|---|---|
| 1 | WS-A (honesty/quick wins) | M0 | S | — |
| 2 | WS-B (redaction) | M1 | M | — (gates 3) |
| 3 | WS-A* (summarizer model flip) | M1 | S | **after WS-B** |
| 4 | WS-C (reliable status) | M1 | L | — (gates 5) |
| 5 | WS-D (proactive audio + event bus) | M1 | L | **after WS-C** |
| 6 | WS-E (spoken/targeted/safe approvals) | M1 | L | E.2 after E.1 |
| 7 | WS-F (durable + race-safe state) | M1 | L | co-land with WS-E |
| 8 | WS-G (permission truth) | M1 | S→M | — |
| 9 | WS-H (context propagation) | M1 | M | — |
| 10 | WS-I (notes model) | M2 | M | — |
| 11 | WS-J (summary richness) | M2 | M | — |
| 12 | WS-K (parallel fan-out) | M2 | M | leans on WS-C |
| 13 | WS-L (hardening/polish) | M3 | S×6 | — |

**M1 is the bar for "hands-free-safe."** M0 can ship today; M2/M3 make the loop good
and robust but are not gating for the safety claim.

---

## 6. Testing strategy

The audit's BUG-038 finding is that the **most failure-prone logic has zero behavioral
coverage**. Each workstream above ships its own tests; in addition:

- **Heuristic harness (new):** replay recorded raw PTY output chunks through the status
  logic and assert the status timeline (WS-C). This is the single highest-value test
  gap to close.
- **Redaction table tests (WS-B):** every secret pattern at every one of the three
  sinks, plus negative tests.
- **Voice-parser table tests (WS-E):** negation, apostrophe-drop, collision→clarify,
  explicit-pairing.
- **Approval integration tests (WS-E/WS-F):** exercise the *real* server gate + voice
  intercept + REST path (today `tests/test_approvals.ts` only touches React state), plus
  the concurrency/double-dispatch race (N-1).
- **Journey tests for J7 & J8 (BUG-033/BUG-038):** currently absent
  (`tests/test_journeys.ts` ends at J6).
- **Regression guard:** assert WS-D never pushes on a WS-C false-idle input.

Run: `npx tsx --test tests/*.ts` (existing harness).

---

## 7. Definition of done — the "hands-free-safe" gate

Adapted directly from the final review's non-negotiables. The product may be called
**accessibility-first / hands-free-safe** only when **all seven** hold (each maps to a
milestone-M1 workstream):

1. **No secret reaches Gemini** — redaction across all three sinks (WS-B), and only
   then the summarizer is on (WS-A*).
2. **No blind approvals** — every proposed command is spoken before approval (WS-E.1).
3. **Right command, right pane** — multi-pane targeting + spoken read-back, and a
   parser that clarifies rather than silently approves on ambiguity/negation (WS-E.2).
4. **Status never lies** — a reliable busy/idle signal; never a confident "done"
   mid-run (WS-C).
5. **Permission truth** — never confirm a permission change the gate will ignore; Full
   Auto reaches the live process (WS-G).
6. **Durable, race-safe, non-silent in-flight state** — pending approvals survive a
   blip, never double-dispatch, never vanish unannounced (WS-F + N-1).
7. **Proactive audio** — completions and errors are announced, not polled (WS-D).

> Until items 1–7 ship (all of M1), position OrbitalVoiceRunner as a
> **sighted-assisted / demo** orchestrator, not an accessibility-first hands-free
> product.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Shipping the summarizer flip (WS-A*) before redaction (WS-B)** opens a new exfiltration path (N-5). | Hard gate in the plan + sequencing table; keep the summarizer disabled/clamped until WS-B lands. |
| **Proactive push (WS-D) on a false idle (WS-C not done)** trains operators to distrust announcements. | WS-D strictly depends on WS-C; add a regression test that no push fires on a known false-idle input. |
| **Status sentinel injection** may interfere with interactive agent CLIs (Claude Code, Codex). | Prefer `/proc`-based detection for raw agent panes; gate sentinel injection behind a per-preset capability flag; fall back to the narrowed regex. |
| **Notes data-model migration** could drop existing string notes. | Migrate-on-load wrapping old strings as `type:'note'`; round-trip migration test; atomic ledger write (already solid) protects the swap. |
| **Race-safety changes (WS-F/N-1)** could deadlock the approval path. | Use a lightweight per-id claim flag rather than a global lock; contention test asserts exactly-once dispatch and no hang. |
| **Regressing the working "nouns."** | Explicit "preserve" list (top of doc); the verified-solid inventory in BUG_LOG §5 is the regression checklist. |

---

## 9. Suggested PR breakdown

One PR per workstream keeps reviews tractable and the dependency edges enforceable:

1. `M0: honesty & quick wins` (WS-A)
2. `M1: secret redaction layer` (WS-B) → 3. `M1: re-enable command summarizer` (WS-A*)
4. `M1: reliable busy/idle signal + status tests` (WS-C) → 5. `M1: proactive audio + event bus` (WS-D)
6. `M1: two-phase spoken approvals` (WS-E.1) → 7. `M1: approval targeting + safe parser` (WS-E.2) → 8. `M1: approval robustness (TTL, missing-pane)` (WS-E.3)
9. `M1: durable + race-safe in-flight state` (WS-F)
10. `M1: permission truth + restart_pane` (WS-G)
11. `M1: context propagation` (WS-H)
12. `M2: structured notes + recall + handoff artifacts` (WS-I)
13. `M2: pane-summary delta/search/error-extraction` (WS-J)
14. `M2: parallel fan-out plans` (WS-K)
15. `M3: hardening, scoping, earcons, crash-safety, a11y, docs` (WS-L)

---

*Plan derived from the consolidated [`BUG_LOG.md`](BUG_LOG.md) (39 defects) and the
independent [`final-review.md`](final-review.md) (8/8 confirmed; +N-1/N-2/N-5). This is
an analysis/plan artifact — no production code is modified by it.*
