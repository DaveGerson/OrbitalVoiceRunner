# OrbitalVoiceRunner — WS-E: Spoken, targeted, safe approvals

**Author:** Expert 1 (Architecture/Design)
**Status:** DESIGN ONLY — no source edits. Build-ready spec for the implementer.
**Closes:** BUG-001, BUG-007, BUG-008, BUG-009, BUG-016, BUG-019, BUG-020.
**Co-lands with:** WS-F (durable + race-safe `pendingApprovals`). This spec defines the
state shape WS-F will harden; it does NOT implement durability/atomicity.
**Builds alongside:** WS-D (proactive audio: earcons + coalescing notification stack +
`attentionQueue`). WS-E reuses WS-D's attention path; it does not duplicate it.

---

## 0. MAINTAINER DECISIONS (BINDING — resolve the §11 escalations R1–R4)

The maintainer reviewed the four escalations. Build to these:

- **R1 — Tool surface: EXTEND, don't split.** Keep ONE gated tool **`propose_command`**, extended
  with `kind: "agent_instruction" (default) | "shell"`. The default makes agent-direction
  first-class; the model must explicitly opt into `kind:"shell"`, which is further constrained by
  the read-only `JANUS_SHELL_ALLOWLIST` (non-allowlisted shell → non-blocking clarify/re-route,
  never a dead-end). Do NOT introduce `direct_agent`/`run_shell`. Pane validation keys on
  `runtimeType` (`interactive_cli` vs `shell`).
- **R2 — Back-compat: KEEP the alias.** Accept the legacy `command` arg and infer `kind` from the
  target pane's `runtimeType` when `kind` is absent, via a thin shim. No hard cutover; the 8
  existing `propose_command` call sites keep working.
- **R3 — Resolution read-back uses a fresh client-content push.** The non-blocking `pending_approval`
  already consumed the original `call.id` (a functionCall is answerable once), so the spoken
  pane+command read-back AND the final resolve/clarify are delivered via a fresh
  `session.sendClientContent(...)` push. **This is NOT the WS-D-declined in-voice path:** WS-D
  declined *unprompted proactive* speech; an approval is an inherently **interactive, operator-
  initiated** voice exchange, so Janus speaking the read-back/result here is correct and in-scope.
  (Earcon + notification for the *arrival* of a pending approval still go through WS-D's path.)
- **R4 — Close the `execute_plan` HiTL bypass IN WS-E (scope expansion).** `execute_plan`
  (`server.ts:~1580`) currently writes step commands to panes WITHOUT passing the effective-mode
  gate — an un-gated execution route that violates the least-authority constraint. Route
  `execute_plan`'s per-step writes through the SAME effective-mode gate + pending-approval path
  WS-E builds, so plan execution also respects Full Auto / Human-in-the-Loop / Read-Only. In HiTL,
  plan steps become spoken pending approvals (reuse the WS-E.1 machinery); keep plans usable in
  Full Auto. Add a test that a HiTL plan step does NOT auto-execute. **Update the WS-E "Closes:"
  set to note the execute_plan gate fix.**

Everything else in this design (the two-phase non-blocking proposal, `parseApprovalIntent`,
most-recently-announced targeting, TTL auto-reject, dead-pane error, WS-D integration, the
WS-F-compatible state shape) stands as written.

---

## 1. Executive summary

The HiTL gate works (it correctly withholds execution), but it is coupled to the *model's
voice*: when `propose_command` hits the Human-in-the-Loop branch (`server.ts:1382–1398`) it
stores a `pendingApprovals` entry and **never sends a tool response**, hard-blocking the
Gemini Live session so Janus goes mute (BUG-001). Voice resolution then resolves the
**oldest** entry (`pendingEntries[0]`, `server.ts:1198`) with a naive substring parser
(`server.ts:1188–1189`) that misfires on negation, ASR apostrophe-drop, and approve/reject
collisions (BUG-007/008). There is no TTL (BUG-019), dead-pane resolution reports false
success (BUG-020), no voice tool lists approvals (BUG-016), and `get_attention_digest` claims
to cover approvals but reads only `attentionQueue` (BUG-009).

**How the BINDING DECISION changes the design vs the plan's original framing.** The plan's
original WS-E framing treated the unit of approval as "Janus runs shell command X on pane Y."
The maintainer decision reframes the **first-class** unit as **"relay this distilled
instruction to agent pane Y"** — Janus *directs*, the agent panes (Claude Code / Codex /
Antigravity) do the heavy lifting. Critically, **the write path is identical** for both cases
(`Terminal.writeInput(text)` → `transport.write(text + "\n")`, `src/terminal.ts:483–491`):
"direct an agent" is *typing an instruction into the agent CLI's stdin*, and "run shell" is
*typing a command into a shell's stdin*. **The difference is purely policy + targeting +
tool-description, not transport.** So WS-E does NOT need a new write mechanism; it needs (a) a
`kind` discriminator on the proposed unit, (b) a policy check that constrains Janus
raw-heavy-shell to a read-only allowlist, (c) instruction-shaping + spoken read-back of the
distilled instruction, and (d) the targeting/parser/TTL/dead-pane fixes. All of it still flows
through the one existing HiTL gate and the existing `pendingApprovals` map (reshaped for WS-F).

---

## 2. The unit of approval — reframed

### 2.1 Decision: extend, don't replace — `propose_command` gains a `kind` discriminator

**Keep `propose_command` as the single gated tool**, extended with a `kind` discriminator,
rather than splitting into two parallel tools. Rationale:

- The gate, the `pendingApprovals` map, the REST resolve path, the voice resolver, and the
  ApprovalDialog UI are all keyed on one tool name (`"propose_command"` appears as the
  `functionResponses[].name` in **8** places: `server.ts:1061,1074,1209,1230,1349,1362,1371,1703`).
  A second tool would fork every one of those.
- The transport is identical, so a second tool buys nothing at the write layer.
- Janus must be *steered* to prefer agent-direction, which is a **tool-description + system-
  instruction + parameter-default** problem, not a tool-count problem.

**Tool surface (the gated tool):**

```
propose_command(
  pane_id: string,            // target pane
  instruction: string,        // the DISTILLED instruction (agent) or command (shell)
  kind: "agent_instruction" | "shell"   // default "agent_instruction"
  // back-compat: accept legacy `command` as an alias for `instruction`; see §11 ESCALATION
)
```

- **`kind: "agent_instruction"` (FIRST-CLASS, default).** The payload is a natural-language /
  targeted instruction typed into an agent pane's stdin. Allowed only when the target pane's
  `runtimeType === "interactive_cli"` (i.e. `toolPreset` ∈ {Claude Code, Codex, Antigravity};
  `src/terminal.ts:191`). This is the path the operator should hear by default.
- **`kind: "shell"` (constrained).** The payload is a raw shell command. Subject to the
  **Janus-raw-shell policy** below. The tool description MUST state that `shell` is for
  *Janus's own small read-only/observe needs only* and that heavy lifting must be delegated to
  an agent pane via `agent_instruction`.

A thin **back-compat shim** (escalate per §11): if `kind` is omitted, infer it from the target
pane's `runtimeType` (`interactive_cli` ⇒ `agent_instruction`, `shell` ⇒ `shell`) and keep
accepting the legacy `command` arg name. This lets WS-E land without breaking any existing
call sites or the live model mid-rollout.

### 2.2 Constraining Janus-runs-raw-shell (three layers, defense in depth)

1. **Tool description (steering).** Rewrite the `propose_command` declaration
   (`server.ts:1703–1712`) to: *"Direct work to the right agent pane. PREFER
   kind='agent_instruction' — relay a focused instruction to the Claude Code / Codex /
   Antigravity agent in that pane and let it do the heavy lifting. kind='shell' is ONLY for
   Janus's own small read-only/observe commands (status checks like git status, ls, cat);
   never author or run heavy/mutating shell yourself — delegate that to an agent pane."*
   Mirror this in the system instruction (`server.ts:1684`), which today says only "propose
   commands for human approval."

2. **Allowlist policy check (enforcement).** Add a `JANUS_SHELL_ALLOWLIST` — a small
   read-only/observe set matched as the **first token** of the command (e.g.
   `git status`, `git log`, `git diff`, `ls`, `cat`, `pwd`, `whoami`, `ps`, `head`, `tail`,
   `grep`, `find`, `df`, `echo`, `which`). When `kind: "shell"` **and** the command's leading
   token is not on the allowlist, the gate does NOT auto-reject — it returns a **non-blocking
   clarification tool response** ("That's heavy-lifting shell — I should hand this to the
   agent in pane Y instead. Want me to do that?") so Janus re-routes to `agent_instruction`.
   This keeps least-authority *advisory-then-enforced* without dead-ending the operator.
   The allowlist lives next to the gate (new const near `server.ts:1038`) and SHOULD be
   operator-editable via the same Settings surface WS-D exposes for message templates.

3. **Default + decomposition (shaping).** The default `kind` is `agent_instruction`, so the
   model must *opt in* to raw shell. Combined with the instruction-shaping flow (§3), the
   normal path never produces raw heavy shell.

### 2.3 Reconciliation with the permission modes (Full Auto / HiTL / Read-Only / Inherit)

**Directing an agent passes through the SAME gate** — `kind` does not bypass permissions. The
effective-mode resolver (`server.ts:1336–1340`: global-first, else pane mode, else
Human-in-the-Loop) is unchanged and runs for **both** kinds:

| Effective mode | `agent_instruction` | `shell` (allowlisted) | `shell` (non-allowlisted) |
|---|---|---|---|
| **Full Auto** | write immediately to pane stdin | write immediately | clarify → re-route to agent (§2.2.2) |
| **Read-Only** | blocked (`writeInput` is a write) | blocked | blocked |
| **Human-in-the-Loop** | two-phase pending approval (§4) | two-phase pending approval | clarify → re-route |

Read-Only blocks both kinds because typing into an agent's stdin is still a write to the pane.
The allowlist check is **in addition to**, not instead of, the permission gate.

---

## 3. Instruction-shaping flow

Janus collaborates with the operator to compress a long-winded dictation into a **focused
instruction** *before* calling `propose_command`. The shaping itself happens in the model
(driven by the system instruction); WS-E's job is to (a) tell Janus to do it, (b) store the
distilled instruction, and (c) read it back before sending.

1. **Compress (model-side).** System-instruction addition: *"When the operator dictates a
   goal, do NOT relay it verbatim. Compress it into a short, targeted instruction list for the
   agent, confirm the distilled version by voice, then call propose_command with that distilled
   instruction. If the goal spans multiple panes, decompose it and propose per pane (or build a
   plan)."*

2. **Read back the DISTILLED instruction (not the raw dictation).** The non-blocking
   `pending_approval` tool response (§4) carries the distilled `instruction`, so Janus speaks
   *"I'll tell the Claude pane to: add a retry to the upload client and run the upload tests —
   approve?"* The operator confirms the **compressed** version. WS-B redaction (§9) runs over
   this spoken/stored string.

3. **Decomposition across panes** maps onto the existing
   `create_orchestrator_plan` / `execute_plan` tools (`server.ts:1545–1566` / `1567+`). For a
   multi-pane goal Janus either (a) emits multiple `propose_command` calls (one per pane, each
   individually gated/read-back), or (b) builds a plan whose **steps are themselves distilled
   per-pane instructions**. NOTE for the implementer: `execute_plan` currently writes step
   commands to panes **without** passing through the HiTL gate (`server.ts:1580`,
   direct `writeInput`). That is a pre-existing gate-bypass; flag it but it is **out of scope
   for WS-E** (escalate, §11) — do not silently widen WS-E to re-gate plans.

4. **What the pending entry stores now** (the reshaped value — see §8 for the full shape):
   the **distilled `instruction`** (renamed conceptually from `cmd`; keep `cmd` as a serialized
   field name for back-compat or migrate in WS-F), `kind`, `terminalId`, `callId`, a
   `rationale` `{ trigger, summary }` where `trigger` is the **raw dictation** (so the UI can
   show "you said X → I distilled Y"), a `timestamp` (§6), and a stable `messageId`.

---

## 4. WS-E.1 — two-phase proposal + speak-before-approve (BUG-001, BUG-016, BUG-009)

### 4.1 Decouple the spoken pre-announcement from the blocking response

In the HiTL branch (`server.ts:1382–1398`), today the code stores the entry and **sends
nothing back**, freezing the session. Change to a **non-blocking `pending_approval` tool
response** sent immediately, so Janus can speak the read-back and keep its turn:

```
// after storing pendingApprovals[messageId] = { ... }
session.sendToolResponse({
  functionResponses: [{
    name: "propose_command",
    id: call.id,
    response: {
      status: "pending_approval",     // <-- NOT a terminal "executed/denied" result
      messageId,
      pane_id: targetId,
      kind,
      instruction: redactSecrets(instruction),
      prompt: `Pending approval: relay "<distilled>" to pane ${targetId}. Read it back and ask the operator to approve or reject.`
    }
  }]
});
```

Key invariant: **`call.id` is consumed exactly once.** The non-blocking response above already
uses `call.id`, so the eventual resolve (REST or voice) must NOT send a *second*
`sendToolResponse` for the same `call.id`. **Resolution becomes a server→model push, not a
tool response.** Two options (escalate the exact mechanism, §11):

- **Preferred:** resolution sends the outcome via WS-D's Seam-B/event path as an *ephemeral
  context turn* (`session.sendClientContent({ turns:[{role:"user",parts:[{text:"Operator
  approved; dispatched to pane Y."}]}], turnComplete:true })`), letting Janus narrate the
  outcome. This is exactly the mechanism WS-D analyzed.
- **Alternative:** keep using `sendToolResponse` but make the *initial* HiTL response a
  short-lived **acknowledgement only** (no `call.id` consumed) — not viable here because the
  Live API requires every functionCall be answered exactly once; hence the push approach.

This single change is the core of BUG-001: Janus is no longer mute, and the read-back happens
*before* any approval can be spoken.

### 4.2 `list_pending_approvals` voice tool (BUG-016)

Declare a new tool in the declarations block (alongside `server.ts:1703`), reading the **same
map** the REST endpoint reads (`server.ts:1040–1047`):

```
list_pending_approvals()  ->  {
  count, items: [{ messageId, pane_id, kind, instruction (redacted), rationale, ageSeconds }]
}
```

Handler mirrors `GET /api/commands/pending` but scoped to the active session and with secrets
redacted. Lets the eyes-off operator ask "what's queued for approval?" and gives Janus an
ordinal/fragment vocabulary for targeting (§5).

### 4.3 Merge `pendingApprovals` into `get_attention_digest` (BUG-009)

The digest handler (`server.ts:1424–1453`) reads only `attentionQueue`. Add a pending-approval
section so "what needs my attention?" includes approvals:

```
const pending = pendingApprovalsForSession(session);   // same filter as voice resolver
if (pending.length) {
  text += ` You also have ${pending.length} command${...} awaiting approval: `;
  pending.forEach((p, i) => { text += `${i+1}. relay "${redactSecrets(p.instruction)}" to pane ${p.terminalId}. `; });
}
```

And **fix the tool description** (`server.ts:1798–1799`) which currently says "this does NOT
include pending command approvals" — reverse it to state approvals ARE included (this is the
WS-A wording reversal the plan flags). Keep one source of truth: have the digest **delegate**
to the same `pendingApprovalsForSession()` helper `list_pending_approvals` uses, so the two
tools never drift.

---

## 5. WS-E.2 — targeting + safer parser (BUG-007, BUG-008)

### 5.1 Targeting: bind to the most-recently-announced id, not `[0]`

Replace `pendingEntries[0]` (`server.ts:1198`) with explicit targeting:

1. Track `lastAnnouncedApprovalId` per session — set it whenever the HiTL branch announces a
   new pending entry (§4.1) **and** whenever Janus reads one back via `list_pending_approvals`.
2. **Fragment matching:** scan the utterance for a token-subsequence match against each
   pending entry's `instruction`/`pane_id` ("approve the **docker** command", "the npm
   install one"). Normalize both sides (lowercase, apostrophe-strip, whitespace-collapse).
3. **Ordinal matching:** "the first/second/last one" → index into the session's pending list
   in **announced order** (maintain an insertion-ordered array, not just the `Record`).
4. **Resolution order:** explicit fragment match > ordinal > `lastAnnouncedApprovalId` >
   (only if exactly one pending) that one. **If 2+ entries match or none match with >1
   pending → CLARIFY** (spoken "I have N pending — which one?"), never default-resolve.
5. **Spoken read-back at resolution:** before dispatching, speak pane + the distilled
   instruction ("Approving: relay '<instruction>' to pane build — dispatching now"). For
   reject, "Rejecting the docker command on pane build."

### 5.2 Harden the parser (`server.ts:1186–1189`)

Replace the flat `.some(includes)` with an intent parser:

- **Apostrophe normalization:** map `'`/`’`/`` ` `` and strip, so `don't`→`dont`, `cant`,
  before matching (ASR drops apostrophes).
- **Explicit pairing as primary trigger:** require an approve/reject verb adjacent to an
  object token ("approve command", "approve the …", "reject command", "cancel the …"). Bare
  ambient words ("execute", "cancel") alone do NOT trigger.
- **Negation window:** before accepting an approve/reject keyword, scan the **3 preceding
  tokens** for `not / no / dont / never / don't`. "I **don't** want to **cancel**" →
  negated → no resolution. "do **not** run it" → negated approve → no dispatch.
- **Collision → clarify, not approve-wins:** if both an approve and a reject intent survive
  (`isApprove && isReject`), send a **clarification** push ("Did you mean approve or reject?")
  instead of the current approve-first/`else`-reject default (`server.ts:1191`).

Implement as a **pure function** `parseApprovalIntent(utterance): { intent: "approve" |
"reject" | "clarify" | "none", targetHint?: { fragment?, ordinal? } }` so it is unit-testable
in isolation (§10) without the Live session.

---

## 6. WS-E.3 — robustness (BUG-019, BUG-020)

### 6.1 Per-entry timestamp + auto-reject expiry (BUG-019)

- Add `timestamp: number` to every pending entry at creation (§8).
- A single periodic sweep (one `setInterval`, e.g. every 30 s; store the handle and
  **`clearInterval` on server close** so the test suite exits clean) auto-rejects entries
  older than a configurable TTL (default 5 min). Auto-reject = resolve the open
  functionCall (consume `call.id`) with a denial + emit a spoken notice via the WS-D push
  ("The docker command on pane build expired after 5 minutes; I cancelled it.") + broadcast a
  UI update + emit a low-severity earcon. No more indefinitely-frozen session.
- The sweep MUST take the same atomic claim WS-F will add (§8) so it cannot race a
  simultaneous voice/REST approve.

### 6.2 Dead-target → spoken error, not false success (BUG-020)

Both resolve paths wrap the write in `if (term)` but report success unconditionally
(REST `server.ts:1052–1084`; voice `server.ts:1202–1225`). Fix: if
`manager.terminals[terminalId]` is missing at resolution time:

- send an **error** outcome to the model (push: "That pane is gone — I could not dispatch
  the command") + a spoken error,
- REST: HTTP 422 + `{ success:false, error:"target pane missing" }`,
- emit an error earcon (WS-D),
- still delete the pending entry (it can never be dispatched) but never claim success.

---

## 7. WS-D integration

Approvals are a **high-severity attention source**; reuse WS-D rather than duplicate:

- **On new pending approval (§4.1):** push an `approval_pending` entry into the
  `attentionQueue` (so it appears in the coalescing notification stack and the digest) and
  fire a **distinct approval earcon** (a tone reserved for "needs your decision", separate
  from done/error tones). The existing `approval_pending` WS broadcast (`server.ts:1391–1397`)
  already drives the ApprovalDialog; WS-D's client just needs the earcon branch + stack entry.
- **On resolve/expire/dead-target:** clear/update the corresponding attention entry (coalesce
  to the latest status, per WS-D Decision 1) and fire the matching earcon
  (approved / rejected / expired / error).
- **Outcome narration** uses WS-D's Seam-B push (`broadcast()` + the `sendClientContent`
  ephemeral-turn path WS-D specs) — WS-E does NOT add a second TTS path. Barge-in / half-duplex
  gating is inherited from WS-D unchanged.
- **`dismiss_attention`** (WS-D) must NOT silently drop an *unresolved* approval entry from the
  queue — dismissing the attention toast hides the notification but leaves the approval pending
  (it still needs an explicit approve/reject). Document this so the two queues don't desync.

---

## 8. WS-F compatibility — state shape (do NOT implement durability here)

Reshape `pendingApprovals` now so WS-F can make it durable + race-safe without a rewrite.

**Current (`server.ts:1038`):**
```
Record<string, { cmd, terminalId, callId, session, rationale? }>
```

**WS-E target shape:**
```ts
interface PendingApproval {
  messageId: string;          // == callId today; keep stable & serializable
  instruction: string;        // distilled (was `cmd`); keep `cmd` alias in serialization for back-compat
  kind: "agent_instruction" | "shell";
  terminalId: string;
  callId: string;             // the Live functionCall id (consumed exactly once)
  rationale?: { trigger: string; summary: string };   // trigger = raw dictation
  timestamp: number;          // creation epoch ms — drives TTL (§6.1)
  claimed?: boolean;          // WS-F: atomic-claim flag, set before writeInput
  // NOTE: `session` is a live handle — NOT serializable. See below.
}
const pendingApprovals: Record<string, PendingApproval> = {};
```

WS-F guidance baked into the shape:

- **Separate the non-serializable `session` handle from the serializable record.** Keep the
  live `session`/`sessionId` in a **side map** keyed by `messageId` (or store a `sessionId`
  string on the record and resolve the live handle via the single-active-session registry WS-D
  uses). This lets WS-F persist the record verbatim and re-attach the session on reconnect.
- **`messageId` is the durable primary key** and must be stable across restart (it already is —
  it's the Live `call.id`). Maintain an **insertion-ordered index array** alongside the Record
  for ordinal targeting (§5.1) — also trivially serializable.
- **`claimed` flag** is the seam for WS-F's atomic claim (read-then-set-before-`writeInput`)
  that prevents the REST+voice double-dispatch (finding N-1). WS-E SHOULD already set/check it
  (cheap, single-threaded JS event loop makes it correct today; WS-F upgrades it to survive
  persistence). **Every** dispatch path — REST (`server.ts:1057`), voice (`server.ts:1205`),
  and the TTL sweep (§6.1) — must `if (entry.claimed) return; entry.claimed = true;` before
  `writeInput`.
- **Session-close cleanup** (`server.ts:1999–2017`) currently **`delete`s** orphaned entries.
  Leave a TODO marker only: WS-F will change this to *persist + re-announce* rather than purge.
  WS-E must not make the purge harder to remove (don't scatter session-equality checks; route
  them through one `pendingApprovalsForSession()` helper).

---

## 9. Integration points, back-compat, and what to preserve

### 9.1 File:line table

| Area | Location | WS-E change |
|---|---|---|
| `pendingApprovals` decl | `server.ts:1038` | reshape to `PendingApproval` (§8); add ordered index + session side-map |
| `GET /api/commands/pending` | `server.ts:1040–1047` | add `kind`, `ageSeconds`; redact `instruction` |
| REST resolve | `server.ts:1049–1088` | atomic claim; dead-target → 422 + error (§6.2); no second `call.id` response |
| Voice utterance parse | `server.ts:1186–1189` | replace with `parseApprovalIntent()` pure fn (§5.2) |
| Voice resolver targeting | `server.ts:1191–1247` | targeting (§5.1); claim; dead-target error; read-back; clarify path |
| HiTL gate branch | `server.ts:1382–1398` | non-blocking `pending_approval` response (§4.1); `kind`; allowlist clarify (§2.2.2); timestamp |
| Effective-mode resolver | `server.ts:1336–1340` | unchanged; reused for both kinds (verify) |
| `propose_command` decl | `server.ts:1703–1712` | add `kind` + `instruction`; rewrite description (§2.2.1) |
| `get_attention_digest` handler | `server.ts:1424–1453` | merge pending approvals (§4.3) |
| `get_attention_digest` decl | `server.ts:1798–1799` | reverse wording — approvals ARE included |
| New `list_pending_approvals` | declare near `server.ts:1703`; handle near `server.ts:1454` | §4.2 |
| System instruction | `server.ts:1684` | add instruction-shaping + agent-direction steering (§3.1, §2.2.1) |
| Session-close cleanup | `server.ts:1999–2017` | TODO for WS-F (persist not purge); route via helper |
| TTL sweep | new `setInterval` near gate; `clearInterval` on close | §6.1 |
| Write path | `src/terminal.ts:483–491` | unchanged — identical for both kinds (confirmed) |
| ApprovalDialog UI | `src/components/ApprovalDialog.tsx` | optional: show `kind` badge + "you said → distilled"; back-compat with `cmd` prop |

### 9.2 Back-compat

- `propose_command` name and `functionResponses[].name` stay `"propose_command"` everywhere.
- Accept legacy `command` arg as alias for `instruction`; infer `kind` from `runtimeType` when
  omitted (§2.1). Serialize the entry with a `cmd` field too if the UI reads it.
- `approval_pending` WS event keeps its existing fields (`messageId, cmd, terminalId,
  rationale`); add `kind` and `instruction` additively so `ApprovalDialog.tsx:4–14` (which
  reads `cmd`) keeps working without edits.

### 9.3 What to preserve

- **WS-B redaction:** `redactSecrets()` runs over **every** instruction/command before it is
  spoken (read-back), stored in `rationale`, returned by `list_pending_approvals`, or merged
  into the digest. The dispatched payload (`writeInput`) is the **un-redacted** real
  instruction — redaction is for the model/operator-facing surfaces only.
- **WS-C status:** targeting/read-back may quote pane status but must call `list_panes` for
  truth (don't read stale system-instruction state).
- **WS-D announcements/barge-in:** reuse Seam-B + earcons; inherit half-duplex gating.
- **ApprovalDialog UI** stays functional (visual approve/reject unchanged; voice is additive).

---

## 10. Test plan (node:test + tsx; suite MUST exit clean — no leaked handles/timers)

1. **Parser table tests** (`parseApprovalIntent`, pure fn — no session):
   - negation window: "I don't want to cancel the build" → `none`; "do not run it" → `none`.
   - apostrophe drop: "dont run" → reject; "cant approve that" → not approve.
   - collision: "approve but actually reject" → `clarify`.
   - bare ambient: "we execute carefully" → `none` (no explicit pairing).
   - explicit pairing: "approve command" → approve; "reject the docker one" → reject + fragment.
2. **Multi-pending targeting:** seed 3 entries (npm install, rm -rf build, docker build);
   "approve the npm install" dispatches **only** that entry's `instruction` to **its**
   `terminalId` (assert the exact `writeInput` arg + pane); ordinal "reject the second one"
   hits the second in announced order; ambiguous "approve it" → `clarify`, zero dispatches.
3. **TTL expiry:** create an entry with a back-dated `timestamp`; run one sweep tick; assert
   the entry is removed, a denial outcome is emitted, and a spoken/earcon notice fires.
   Use a fake clock or injected `now`; **`clearInterval` in test teardown**.
4. **Dead-pane error:** pending entry whose `terminalId` is removed; resolve via REST → 422 +
   `success:false`; resolve via voice → error outcome, no `writeInput`, entry cleared.
5. **Real gate-path integration test (not just React state — part of BUG-038):** drive the
   actual HiTL branch with a fake Live `session` (records `sendToolResponse` /
   `sendClientContent` calls) and a fake `Terminal` (records `writeInput`). Assert:
   (a) HiTL proposal sends a non-blocking `pending_approval` (Janus not muted);
   (b) a subsequent approve calls `writeInput` exactly once and consumes `call.id` exactly once;
   (c) `kind:"agent_instruction"` only allowed on an `interactive_cli` pane;
   (d) `kind:"shell"` non-allowlisted → clarify, no dispatch.
6. **Double-dispatch guard (WS-F seam, light):** fire REST approve and voice approve for the
   same `messageId` in the same tick; assert `writeInput` called **once** (the `claimed` flag).
7. **Digest merge:** with 2 pending approvals, `get_attention_digest` output mentions both.

Use injected fakes for `session`/`Terminal`/clock; no real PTY, no real Gemini, no real
network. Verify the process exits 0 with no open handles (close server, clear all intervals).

---

## 11. Risk register + escalations

| # | Risk / decision | Disposition |
|---|---|---|
| R1 | **Tool naming/surface for the agent-direction reframe.** Extend `propose_command` with `kind` vs introduce a `direct_agent`/`send_to_agent` tool. | **ESCALATE.** This spec recommends *extend* (one tool, one gate, one map) and keep `propose_command` as the name. Maintainer to confirm before the implementer touches the declaration. |
| R2 | **Keep `propose_command` as a back-compat alias / legacy `command` arg?** | **ESCALATE.** Recommended yes (shim infers `kind` from `runtimeType`, accepts `command`) so rollout doesn't break the live model. Maintainer to confirm whether a hard cutover is preferred. |
| R3 | **Resolution mechanism** — server→model push via `sendClientContent` ephemeral turn (WS-D) vs the (now-impossible) second tool response. | **ESCALATE (couples to WS-D).** Recommended: the WS-D Seam-B/`sendClientContent` push, since `call.id` is consumed by the non-blocking `pending_approval` response. Confirm the WS-D push is available when WS-E lands. |
| R4 | **`execute_plan` bypasses the HiTL gate** (`server.ts:1580` direct `writeInput`). | **ESCALATE — out of scope for WS-E.** Flag only; re-gating plans is a separate decision (WS-K territory). Do not silently widen WS-E. |
| R5 | **Janus-shell allowlist contents** (which read-only commands are safe). | Operator-editable default list (§2.2.2); start conservative. Low risk; not a blocker. |
| R6 | **TTL default (5 min) + sweep interval (30 s)** may be wrong for long agent tasks. | Make both configurable (Settings); default conservative; the TTL governs the *approval decision* window, not the agent's run time, so 5 min is reasonable. |
| R7 | **`session` handle in the pending record is non-serializable** — could trip WS-F if left in. | Mitigated by §8 (side-map / `sessionId`). Implement the side-map in WS-E so WS-F has nothing to untangle. |
| R8 | **Double-dispatch race** if `claimed` is omitted. | WS-E sets `claimed` on all three dispatch paths now (§8); WS-F upgrades it to survive persistence. |

---

### Appendix — code-grounded facts established during investigation

- **Write path is identical for agent vs shell.** `Terminal.writeInput(cmd)` →
  `transport.write(cmd + "\n")` (`src/terminal.ts:483–491`); no agent/shell branching. The
  "direct an agent" vs "run shell" distinction is **policy + targeting + tool-description +
  the `kind` discriminator**, NOT a different transport. (Answers the brief's precision ask.)
- **Agent vs shell panes are distinguishable** via `runtimeType` (`interactive_cli` for
  Claude Code / Codex / Antigravity, `shell` for Custom; `src/terminal.ts:191`) and
  `toolPreset` — this is the field the `kind` validation keys on.
- **The FIFO bug is real:** `pendingEntries[0]` with a comment claiming a sort that does not
  exist (`server.ts:1195–1198`).
- **The mute bug is real:** HiTL branch stores the entry and sends no tool response
  (`server.ts:1382–1398`, comment at `:1398` "We do NOT send tool response here").
- **`get_attention_digest` reads only `attentionQueue`** (`server.ts:1424–1453`); its
  declaration explicitly disclaims approvals (`server.ts:1799`) — that wording must reverse.
- **REST + voice both report unconditional success** past an `if (term)` guard
  (`server.ts:1052–1084`, `:1202–1225`) — BUG-020 confirmed in both paths.
