# OrbitalVoiceRunner — Final Independent Technical Review (Step 7)

> **Role:** Final, independent technical architect — adversarial QA on the review
> itself. The job is not to re-derive the bug log but to *validate* it: re-read the
> code for the highest-stakes claims, confirm or refute each, flag exaggeration, find
> what was missed, and deliver a candid readiness verdict.
>
> **Method:** Every claim below was re-verified directly against the source
> (`server.ts`, `src/terminal.ts`, `src/ledger.ts`, `src/App.tsx`, `src/types.ts`,
> `tests/*`). Line citations were read in this session, not copied from the bug log.
>
> **Modality lens (inherited and endorsed):** voice-only, hands-free, eyes-off. A
> defect that misinforms or mis-acts is graded by what it does to an operator who
> *cannot glance at the screen to recover.*

---

## 1. Audit Verdict

**The bug log is accurate, well-evidenced, and well-prioritized. Overall confidence in
it: HIGH (~92%).** Of the eight highest-stakes claims I re-verified line-by-line, **8 of
8 CONFIRM** at the cited file:line. The few inaccuracies I found are minor citation
drift (off-by-a-few-lines on a multi-line construct) and one place where the bug log is
slightly *harsher* than the code warrants (BUG-017 — see §2 and §3). I found **no
fabricated defects** and **no confirmed-solid claim that is actually broken**, with one
"works" item I would downgrade from "solid" to "solid-but-fragile" (the PTY lifecycle —
§4, §5).

Strengths of the review:
- It correctly separates **nouns that work** (real PTY, atomic ledger, durable notes,
  trustworthy `alive`, the gate logic itself) from **verbs at the seams that break**
  (context propagation, spoken pending layer, multi-pane targeting, effective-permission
  truth, proactive push, redaction). That framing is exactly right and is corroborated
  by the synthesis docs.
- Severity is judged by eyes-off operator impact rather than generic severity, which is
  the correct rubric for this product. The "confidently-false-information is a P0"
  stance is sound.
- De-duplication into systemic root causes (§4 of the bug log) is genuinely useful and
  accurate.

Weaknesses / completeness gaps (expanded in §4):
- **Concurrency/races are under-covered.** `pendingApprovals` and `attentionQueue` are
  shared mutable maps touched by both the REST path and the WS path with no guard; the
  bug log treats these only as *persistence* problems, not *race* problems.
- **The detached-PTY orphan risk is under-weighted** — the bug log does not mention it.
  It is real but narrower than one might fear (graceful shutdown is handled).
- **BUG-017's threat model is overstated** ("any browser tab") given that `/api` and the
  WS are both behind a shared auth token. The P2 ranking is nonetheless correct.

Net: this is a trustworthy bug log. A reader can act on it. My re-ranking and additions
are at the margins, not the core.

---

## 2. Independent Re-Verification of the 8 Highest-Stakes Claims

For each: the bug log's characterization, what the code actually says (file:line read
this session), and an explicit **CONFIRM / REFUTE** with any fairness note.

### 2.1 ~~Dead `gemini-3.5-flash` summarizer~~ (BUG-005) — ~~CONFIRM~~ **RETRACTED**

> **Correction (post-review, per maintainer):** `gemini-3.5-flash` is a **valid**
> current Google model ID. The premise below ("not a released model… will throw") is
> wrong, so this confirmation and BUG-005 are **retracted**. Consequence: the summarizer
> is *live*, so its raw-output send is an **active** unredacted leak (finding N-5, §4) —
> making WS-B redaction more urgent, not less. Original reasoning kept below for the record.

- `server.ts:210` — `model: "gemini-3.5-flash"`. That is not a released Google model
  ID, so `generateContent` will throw at runtime.
- `server.ts:214–216` — the `catch` returns the literal `"Execution finished
  successfully."` for **every** failure, including failed commands.
- `server.ts:209–212`, `:230–231` — the result is written into `lastEntry.finalResponse`
  and persisted to history; `get_pane_command_history` reads `entry.finalResponse` first
  (`server.ts:1244`); the handoff packet is built from the same history.
- **Verdict:** CONFIRM, fully. The characterization "every command outcome is a static
  placeholder; failures read as success; contaminates J1/J4/J6/J8" is exact. This is the
  single highest-leverage one-line fix in the repo.

### 2.2 Global override silently total (BUG-003) — **CONFIRM**
- Resolver `server.ts:1272–1276` reads `manager.globalPermissionsMode` first and only
  falls through to the pane's own mode when global `=== "Inherit"`. Confirmed global-first.
- Handler `set_pane_permissions` `server.ts:1542–1557` sets `term.setPermissionsMode`
  and the ledger pane mode, then **unconditionally** returns
  `"...updated to ${permissions_mode} successfully."` (`:1556`) without ever reading
  `globalPermissionsMode`.
- **Verdict:** CONFIRM. When global ≠ Inherit, per-pane changes are silent no-ops at the
  gate while Janus confirms success. The reverse (promote a pane under global HiTL) is
  equally inert. P0 is correct — this is a safety-posture betrayal an eyes-off operator
  cannot detect.

### 2.3 FIFO approval pick + the phantom sort comment (BUG-007) — **CONFIRM**
- `server.ts:1133` filters `pendingApprovals` by `details.session === session`.
- `server.ts:1135` comment: `// Sort to resolve the earliest/most relative first`.
- `server.ts:1136` `const [messageId, pending] = pendingEntries[0];` — **no `.sort()`
  call exists anywhere in this block.** It is plain insertion-order (FIFO) selection.
- **Verdict:** CONFIRM, including the "phantom sort comment" characterization. The
  comment actively lies about logic that does not exist. With multiple panes pending
  (the *normal* fan-out state), "approve the npm install" can resolve an older
  `rm -rf`-style entry on a different pane, with no spoken read-back. P0 correct.

### 2.4 The 1s timeout + prompt-regex `is_busy` heuristic (BUG-006) — **CONFIRM**
- `src/terminal.ts:163` — the regex
  `/([\?$#>]|\[[yY]\/[nN]\]|\([yY]\/[nN]\)|password:|confirm\??)\s*$/i`. Any line ending
  in `$`, `#`, `>`, or `?` flips status to `Idle`.
- `src/terminal.ts:160` — it is tested against the last 5 buffered lines (`fullStripped`),
  amplifying false positives.
- `src/terminal.ts:179–187` — the silence path hardcodes a `1000` ms timer to `Idle`.
  (Minor citation note: the bug log cites `:189` for the timeout; the `setTimeout` opens
  at `:179` and the `1000` literal is at `:187`. Substantively identical.)
- `is_busy` is then derived as `term.status === "Running"` (`src/terminal.ts:579`).
- **Verdict:** CONFIRM. A 2-minute compile that prints nothing for >1 s, or whose last
  line ends in `>`/`?`, reads `Idle`. The downstream consequence — plans/watch rules
  fire prematurely and status read-back lies — is correct. P0 correct.

### 2.5 Unredacted output to Gemini + lying tool description (BUG-002) — **CONFIRM**
- `src/terminal.ts:56–60` `stripAnsiSequences` removes only ANSI escapes — no secret
  patterns.
- `src/terminal.ts:593–598` `getPaneSummary` wraps the raw recent output in a code fence;
  no scan, no `[REDACTED]`.
- `server.ts:1249–1254` forwards that string verbatim to the model. The same raw snapshot
  is embedded in the HiTL approval rationale (`server.ts:1322–1324`).
- `server.ts:1611` tool description: *"Return the clean, redacted markdown delta..."* —
  none of "clean", "redacted", or "delta" is implemented.
- **Verdict:** CONFIRM. Secrets printed to a pane reach Google's API verbatim, and the
  false "redacted" contract suppresses the model's own caveat reflex. P0 correct. The
  "delta" half is also a real lie (no cursor exists — see BUG-030).

### 2.6 In-memory volatile state lost on restart (BUG-013) — **CONFIRM**
- `pendingApprovals` — plain in-memory `Record` at `server.ts:978`.
- `promptBufferText` — module-level `let` at `server.ts:133`, mutated at `:1120`/`:1200`,
  never serialized.
- `lastSessionResumptionToken` — module-level `let` at `server.ts:1030`.
- `attentionQueue` — in-memory array on the manager (`src/terminal.ts:383`).
- Ledger persists **only** `activeProjectId`, `workspaces`, `watchRules`, `plans`
  (`src/ledger.ts:91–96`, `:115–119`) — none of the above.
- WS-close cleanup `server.ts:1879–1883` silently `delete`s every pending approval for
  the closing session with no operator alert and no re-queue.
- **Verdict:** CONFIRM. A network blip during a pending approval loses the command
  silently and leaves the agent task half-done. P0 correct, and correctly tagged
  *systemic*.

### 2.7 Session-unscoped REST approve (BUG-017) — **CONFIRM (with a fairness correction)**
- `server.ts:989–1028` looks up `pendingApprovals[messageId]` and acts with **no
  session/identity comparison**, unlike the voice path which filters
  `details.session === session` (`server.ts:1133`). IDs are observable via
  `GET /api/commands/pending` (`server.ts:980–987`).
- **However**, the bug log's phrasing ("any browser tab ... can approve another session's
  command") overstates the surface: `app.use("/api", authMiddleware)` (`server.ts:173`)
  gates all `/api` routes behind a token, and the WS upgrade checks the same token
  (`server.ts:1033–1034`). The token is a single shared `API_AUTH_TOKEN`
  (`server.ts:17`).
- **Verdict:** CONFIRM the defect (no per-session scoping; one authenticated client can
  resolve another's approval). REFINE the framing: the attacker must already hold the
  shared token, so this is privilege-confusion *between trusted tabs*, not an open
  endpoint. The bug log's **P2** ranking and "mitigated by trusted-LAN posture" caveat
  are therefore correct; only the one-line "any browser tab" prose is too strong.

### 2.8 `switch_context` not syncing UI + unhandled WS events (BUG-012, BUG-010) — **CONFIRM**
- `switch_context` (`server.ts:1255–1266`) updates the ledger + settings and calls
  `broadcastLedgerUpdate()` only; there is **no** `context_switched` event.
- `App.tsx` `ledger_updated` handler (`src/App.tsx:897–898`) calls `setLedger(msg.ledger)`
  only — never `setActiveProjectId` / `setActiveTerminalId`. So voice focus and UI focus
  diverge until a manual click.
- The system instruction is a template literal **inside the config object passed to
  `session.connect()`** (`server.ts:1568`, connect at `server.ts:1073`) — evaluated once,
  freezing the pane list/status at connect (BUG-012/BUG-022 root).
- The `App.tsx` `ws.onmessage` handler (`src/App.tsx:870–927`) handles exactly: `audio`,
  `interrupted`, `approval_pending`, `prompt_buffer_updated`, `terminals_updated`,
  `ledger_updated`, `settings_updated`, `command_auto_executed`, `command_blocked`,
  `stdout_chunk`, `transcript_text`, `error`. It has **no branch** for `attention_updated`,
  `plans_updated`, `watch_rules_updated`, `pane_transition`, `plan_step_completed`,
  `plan_completed`, `plan_paused`, `history_updated`, or `watch_rule_fired` — all of which
  the server broadcasts. UI relies on a poll instead.
- **Verdict:** CONFIRM both. The push infrastructure exists server-side and is inert on
  the client; structural changes never refresh model context or UI focus.

**Re-verification scorecard: 8 CONFIRM / 0 REFUTE.** One framing correction (2.7). The
bug log's evidence quality is high and its citations are reliable to within a few lines.

---

## 3. Priority Challenges

The eight P0s and the rubric hold up well. My specific challenges:

**All 8 P0s are genuinely P0.** Each one either (a) makes the operator act wrongly while
believing they acted safely (BUG-001 blind approval, BUG-007 mis-targeted approval,
BUG-008 parser misfire, BUG-003 silent permission no-op), (b) exfiltrates secrets
(BUG-002), (c) feeds confidently false information into the next decision (BUG-005,
BUG-006), or (d) silently loses in-flight safety state (BUG-013). All four are explicit
P0 criteria for an eyes-off operator. I would not demote any.

**One P1 I would promote to P0: BUG-024 (no proactive audio push).** The product's
entire thesis is "eyes-off." A pure pull model means a build that fails at minute 3 is
*never announced*; the operator only learns by asking, and (via BUG-006) the answer is
often a false "idle/done." That is not merely "materially degraded" — for the
defining capability (C4 Proactive awareness, which the matrix itself marks **Missing**),
it is a core promise that is fundamentally non-functional. The bug log's own §4 lists it
as systemic root cause #7. **Recommend P0.** (Caveat: it depends on BUG-010 client
wiring, so it is a structural P0, not a quick win.)

**One P1 borderline-promote: BUG-012 (frozen context / UI divergence).** After
`create_pane`, Janus believes zero panes exist and may propose to a pane it thinks is
absent; after voice `switch_context`, the UI highlights the wrong project indefinitely.
Eyes-off, this is undetectable and can cause commands to land in the wrong place. I would
not insist on P0, but it is the strongest P1 and should be sequenced immediately after
the P0 block.

**Confirm P2, not P1, for BUG-017** (see §2.7) — the shared-token auth gate justifies P2.

**One P3 I would consider P2: BUG-038 (untested status heuristic + mock-mode false
flow).** Normally test debt is P3, but here the *single most failure-prone runtime
heuristic* (`updateStatusOnOutput`, BUG-006) has **zero** behavioral coverage — tests set
`term.status` directly (`tests/test_journeys.ts:221–222`, `tests/test_terminal_manager.ts:19,27`),
so the regex/timer can regress invisibly, and the mock-mode UI (`src/App.tsx`
`handleApprove`/`handleReject`) trains operators on an instant-success model the real
path does not deliver. Given that this debt sits directly under two P0s, **P2** is the
honest rank. Minor, but worth noting.

No other re-rankings. The P1/P2/P3 partitioning is otherwise defensible.

---

## 4. Coverage Gaps in the Review (Missed / Under-Weighted)

New or under-weighted findings, with file:line:

**N-1 — Concurrency races on shared mutable maps (NOT flagged; ~P2).**
`pendingApprovals` (`server.ts:978`) and `attentionQueue` (`src/terminal.ts:383`) are
mutated from **both** the Express REST handlers (`server.ts:989–1028`, `:755–767`) and
the WS/voice path (`server.ts:1133–1185`, `:1324`) with no locking or
read-then-delete atomicity. The bug log treats these purely as *persistence* defects
(BUG-013) and *security* (BUG-017) but never as *races*. Realistic interleaving: a REST
approve and a voice "approve" arriving close together can both read the same `pending`
before either `delete`s it, double-dispatching the command to the PTY
(`term.writeInput` at `:997` and `:1143`). For an eyes-off operator a *double-executed*
command is a distinct hazard from a mis-targeted one. **Recommend adding as a new bug
(~P2), folded into the durable-queue work.**

**N-2 — Detached PTY orphans on crash, not graceful exit (under-weighted; ~P3).**
Children are spawned `detached: true` (`src/terminal.ts:258`) with no `proc.unref()`.
The bug log does not mention orphan risk at all. In fairness, graceful shutdown *is*
handled: `process.on("SIGINT"/"SIGTERM", shutdown)` (`server.ts:1922–1923`) and
`stop()` kills the whole process group via `process.kill(-pid, ...)`
(`src/terminal.ts:352`, `:363`). The real gap is the **crash / SIGKILL / uncaught
exception** path — there is no `uncaughtException`/`unhandledRejection` handler, so a
server crash leaves detached agent CLIs (and `claude`/`codex` subprocesses) running and
unowned. **Recommend a new P3 bug:** add crash handlers and/or track child PIDs in a file
for reap-on-restart. (This pairs naturally with BUG-013 persistence.)

**N-3 — `idleTimeoutMs` setting genuinely ignored, and it weakens BUG-006's fix
(already BUG-034, but under-weighted).** `getDefaultSettings` advertises
`idleTimeoutMs` (`src/terminal.ts:423`) but the timers hardcode `1000`
(`src/terminal.ts:187`, and again at spawn `:267`). The bug log files this P3, which is
fine in isolation — but note that **any** BUG-006 remediation that keeps a timer must
also honor this setting, or the fix re-introduces the same untuned-magic-number problem.
Flagging the coupling, not re-ranking.

**N-4 — `syncLedger` can clobber a persisted `permissions_mode` with the live value
(partially noted under BUG-026, deserves emphasis).** `src/terminal.ts:582` writes the
live `permissions_mode` back into the ledger pane during sync. Combined with BUG-003 and
BUG-015 (the live flag never re-spawns), an operator's persisted intent can be silently
overwritten by the spawn-time default on the next sync. This compounds the
permission-truth problem and deserves more than a sub-bullet in a P2.

**N-5 — `summarizeCommandOutcome` sends raw output to a *second, separate* Gemini call
with no redaction either (extends BUG-002 scope).** `server.ts:202–212` sends
`rawOutput.slice(-3000)` straight to the model. Even once BUG-005's model name is fixed,
this is a **second unredacted exfiltration path** the bug log's BUG-002 does not
enumerate (BUG-002 focuses on `get_pane_summary` and the approval rationale). The
redaction layer must cover this call too, or fixing BUG-005 silently *opens* a new leak.
**This is the most important new finding** — it means the BUG-005 quick win and the
BUG-002 redaction work are coupled, and shipping BUG-005 alone (turning the summarizer
*on*) without redaction would make the secret-exfiltration surface *worse*, not better.

No defect in the bug log was found to be non-existent or mis-attributed.

---

## 5. "What Works" Sanity Check

I re-verified the verified-solid inventory. It mostly holds; one downgrade.

- **Real concurrent PTY spawn** — CONFIRM. `spawn(..., { detached: true })`
  (`src/terminal.ts:255–259`), genuine child processes, real stdout/stderr wiring
  (`:270–302`). Solid. *Caveat:* see N-2 — solid for normal operation, **fragile on
  crash** (orphan risk). I would relabel this "**solid, with a crash-cleanup gap**" rather
  than unqualified "solid."
- **Atomic ledger persistence** — CONFIRM. Write-temp-then-rename in both async
  (`src/ledger.ts:89–98`) and sync (`:113–122`) paths. Genuinely robust.
- **Durable note capture** — CONFIRM as *durable*, but note the bug log's own BUG-029:
  `addPaneNote` silently no-ops on a bad pane ID (`src/ledger.ts:158–163`) while the
  handler reports success. So "the most reliable verb" is reliable only on the happy
  path; the failure mode is silent. The bug log captures this in BUG-029 — consistent,
  no contradiction, but worth holding the praise to "durable when it lands."
- **`alive` is trustworthy** — CONFIRM. Driven by real `exit`/`close`/`error` events
  (`src/terminal.ts:304–315`); `alive: term.status !== "Exited"` (`:580`). Solid.
- **HiTL gate itself enforces correctly** — CONFIRM. The three-branch resolver
  (`server.ts:1272–1335`) blocks/auto-runs/read-only-rejects correctly *given correct
  inputs*; per-session voice filtering (`:1133`) prevents cross-session voice leakage.
  Solid — the defects (BUG-001 muteness, BUG-007 targeting, BUG-003 effective mode) are
  around the gate, not in its core branch logic.
- **`switch_context` briefing payload** — CONFIRM. `getProjectBriefing`
  (`src/ledger.ts:197–209`) returns notes + pane meta + directory + key terms intact. The
  defect is propagation/UI sync, exactly as claimed.
- **`get_pane_summary` ANSI stripping** — CONFIRM. The 100-line ring buffer is real and
  bounded (`src/terminal.ts:280–283`), `stripAnsiSequences` is well-formed (`:56–60`).
  Stripping is solid; the defects are redaction/delta/windowing.

**Net:** the "what works" list is honest. Only one item (PTY lifecycle) is over-graded —
downgrade from "solid" to "solid with a crash-cleanup gap." Nothing claimed solid is
actually broken on its happy path.

---

## 6. Remediation Roadmap (P0-first, ordered)

Effort: **S** ≈ <½ day, **M** ≈ 1–3 days, **L** ≈ multi-day/structural.

### Quick wins — ship first (S, mostly one-liners; high leverage)
1. **BUG-005 model-name fix** *(S)* — `server.ts:210` → a real model
   (`gemini-2.5-flash` / `gemini-2.0-flash`). **DEPENDENCY/GATING:** do **not** ship this
   alone — turning the summarizer on routes raw output (incl. secrets) to Gemini
   (`server.ts:202–212`, finding N-5). Sequence it *with or after* the redaction layer
   (item 9), or temporarily clamp/disable the summarizer until redaction lands.
2. **Delete the phantom sort comment** *(S)* — `server.ts:1135`. Remove the lie now; real
   targeting is item 7.
3. **Fix the false tool descriptions** *(S)* — `get_pane_summary` "clean, redacted ...
   delta" (`server.ts:1611`) and `get_attention_digest` "...approvals" (`server.ts:1683`).
   Rewrite to the *true current* behavior immediately (stop mis-steering the model);
   restore the aspirational wording only once the behavior exists.
4. **Doc corrections** *(S)* — `JOURNEYS_DESIGN.md:82,113`, `README` permission note,
   `App.tsx:1593` "(session only — not saved)" qualifier. (BUG-033, BUG-039.)
5. **Validate `set_pane_permissions` inputs + surface failures** *(S)* — enum guard +
   error on missing pane (`server.ts:1542–1557`); make `addPaneNote` return success/throw
   (`src/ledger.ts:158–163`) so BUG-029/BUG-026 stop reporting false success.
6. **Global-override rider** *(S→M)* — in `set_pane_permissions` read
   `globalPermissionsMode`; if ≠ Inherit, return the spoken caveat (BUG-003). Closes the
   most dangerous *silent* P0 with a small change.

### Structural P0/P1 work (M–L; the real backbone)
7. **Reliable status signal** *(L)* — replace the 1 s timer + prompt regex
   (`src/terminal.ts:163–187`) with an authoritative signal (PTY sentinel echo on
   return-to-prompt, or `/proc/[pid]` subprocess polling); honor `idleTimeoutMs` (N-3);
   add elapsed-time/`last_command` (BUG-025). **Blocks BUG-006, feeds 8.** Add the
   missing heuristic tests (BUG-038) as part of this.
8. **Proactive audio event bus** *(L)* — wire the unhandled WS events into `App.tsx`
   (BUG-010) **and** push an audio/TTS interrupt into the Janus session on
   Running→Idle / new high-severity attention (BUG-024). **Depends on 7** (must not fire
   on false idle). This is the C4 fix and, per §3, should be treated as P0-grade.
9. **Redaction layer** *(M)* — single redaction pass (AWS keys, `eyJ…` JWTs,
   `BEGIN…PRIVATE KEY`, common `.env` shapes) applied at **both** `getPaneSummary`
   (`src/terminal.ts:593`) **and** `summarizeCommandOutcome` (`server.ts:207`, N-5) and
   the approval rationale snapshot (`server.ts:1322`). **Gates item 1.** (BUG-002.)
10. **Two-phase proposal + spoken pre-announcement** *(L)* — decouple "block execution"
    from "block voice" (BUG-001): send a non-blocking `pending_approval` so Janus speaks
    "I want to run X on pane Y," track the open vote on a side channel, resolve via voice
    intercept / REST. Pairs with a `list_pending_approvals` tool (BUG-016) and a corrected
    digest (BUG-009).
11. **Multi-pane targeting + safer parser** *(M)* — bind resolution to the
    most-recently-announced pending ID; support fragment/ordinal targeting; speak the
    pane+command read-back (BUG-007). Add negation window, apostrophe normalization,
    explicit pairing, and clarify-on-collision (BUG-008). **Depends on 10.**
12. **Durable + race-safe approval queue** *(L)* — persist `pendingApprovals`,
    `promptBufferText`, `lastSessionResumptionToken`, and the attention queue alongside
    the ledger; on reconnect restore and re-issue `approval_pending`; **add
    read-then-delete atomicity / a lock** to close N-1's double-dispatch race; alert (not
    silently purge) on WS close (`server.ts:1879–1883`). (BUG-013, BUG-014, BUG-019,
    N-1.)
13. **Context propagation** *(M)* — emit `context_switched` (carry `activeProjectId`),
    handle it in `App.tsx` to set active project/terminal; inject an ephemeral context
    update (or force `list_panes`) after any structural change; drop live status from the
    static system instruction (BUG-012, BUG-022).

### Lower-priority hardening (after the loop is safe)
14. `restart_pane` voice tool + `restartRequired` flag so Full Auto reaches the live PTY
    (BUG-015) *(M)*; collapse the three divergent restart command strings (BUG-032) *(M)*.
15. `NoteEntry[]` model + `get_project_notes`/`search_notes`/`delete`/`amend` +
    `commit_spec_buffer` voice tools (BUG-021, BUG-027, BUG-028) *(M)*.
16. Delta cursor + pagination + semantic error extraction for `get_pane_summary`
    (BUG-030, BUG-031) *(M)*.
17. Per-session REST scoping (BUG-017) *(S)*; distinct earcons (BUG-018) *(S)*; crash
    handlers + child-PID reaping (N-2) *(S)*; `create_project` `key_terms` schema
    (BUG-036) *(S)*; ARIA on the approval dialog (BUG-037) *(S)*.

**Critical sequencing call-out:** items **9 → 1** and **7 → 8** are hard dependencies.
Shipping BUG-005 (1) before redaction (9) actively *worsens* the security posture;
shipping proactive push (8) before a reliable status signal (7) just announces false
completions confidently.

---

## 7. Final Sign-Off

**What this product is today:** a well-built *backbone* with broken *connective tissue*.
The nouns are real and trustworthy — genuine concurrent PTYs, atomic durable ledger,
durable notes, an honest `alive` signal, and a HiTL gate whose core branch logic is
correct. The synthesis docs' framing — "the journeys share a backbone but do not chain"
— is accurate and well-evidenced. Against its 8 stated journeys, **0 are fully solid
eyes-off**: every journey works in isolation for a sighted user but degrades, misleads,
or silently fails at exactly the seam an eyes-off operator cannot recover from.

**It is NOT hands-free-safe today.** Three properties an eyes-off operator must be able
to trust are all violated: (1) *"what I'm about to approve is what I was told"* — false
(BUG-001 blind, BUG-007 mis-targeted, BUG-008 parser); (2) *"the status I'm told is
true"* — false (BUG-006 false idle, BUG-005 false success); (3) *"my safety settings and
secrets are honored"* — false (BUG-003 silent override, BUG-002 + N-5 unredacted
exfiltration). A confidently-wrong voice assistant for a user who cannot see the screen
is worse than no assistant.

**Non-negotiable fixes before "hands-free-safe" can be claimed (the gate):**
1. **Redaction layer covering BOTH output paths** (BUG-002 + N-5) — no secret reaches
   Gemini; *and only then* re-enable the summarizer (BUG-005).
2. **Spoken pre-announcement of every proposed command** before approval (BUG-001) — no
   blind approvals.
3. **Correct multi-pane targeting with spoken read-back** (BUG-007), plus a parser that
   cannot silently approve on ambiguity/negation (BUG-008).
4. **A reliable busy/idle signal** (BUG-006) — status must never confidently say "done"
   mid-run.
5. **Effective-permission truth** (BUG-003) — never confirm a permission change that the
   gate will ignore.
6. **Durable, race-safe, non-silent in-flight state** (BUG-013 + N-1) — pending approvals
   must survive a blip and never double-dispatch or vanish unannounced.
7. **Proactive audio on completion/error** (BUG-024 + BUG-010) — the eyes-off premise is
   void without it.

Until items 1–7 ship, OrbitalVoiceRunner should be positioned as a **sighted-assisted /
demo** orchestrator, not an accessibility-first hands-free product. The bug log is a
sound, trustworthy basis for getting there; this review affirms it, promotes BUG-024 to
P0-grade, adds the second-exfiltration-path (N-5) and double-dispatch-race (N-1)
findings, and downgrades the PTY-lifecycle "solid" claim to "solid with a crash-cleanup
gap."

*— Final independent technical review. Code re-verified this session; no code or other
files modified.*
