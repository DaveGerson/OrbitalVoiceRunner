# Next-Level Platform Capabilities — Orbital Harness

**Reviewer:** Devon Park, Senior Platform & Security Engineer
**Date:** 2026-05-28
**Frame:** Round one asked "does the gate work today" (see `assessments/02-security-platform-devon.md`). This is forward-looking: *assuming the P0/P1 trust bugs are fixed*, what net-new platform capabilities does Orbital Harness need before a security-conscious team would adopt and scale it — many panes, many operators, an LLM holding live shells against real repos?

The bar is unchanged: I must be able to bound the blast radius, attribute every action, prove after the fact what ran and who let it, and stop everything in one move. Today the entire policy surface is a single tri-state enum (global `globalPermissionsMode` + per-pane `permissions_mode`, resolved at `server.ts:631-636`). That is a light switch where a control panel needs to be. The items below are what turns this from a clever demo into something I would let near a shared environment.

---

## Part A — Next-level platform features

### A1. Per-command / per-path policy rule engine (allowlist + denylist)
- **Priority: P0-aspirational · Effort: L**
- **Problem it solves.** The gate is binary per pane: Full Auto fires *everything*, HITL asks for *everything*. There is no middle. Real adoption needs "auto-approve `git status`/`ls`/`npm test`, always *ask* for `git push`, *never* run `rm -rf`/`curl | sh`/`sudo`/credential reads — regardless of mode." Right now the only knob to suppress approval fatigue is Full Auto, which is exactly the dangerous one.
- **Sketch.** A `PolicyRuleSet` evaluated inside the `propose_command` handler *before* the mode branch at `server.ts:638`. Rules are ordered `{ match: regex|glob on command, path?: glob on cwd, decision: "auto" | "ask" | "deny", reason }`. Evaluation returns the first match; `deny` short-circuits to a `command_blocked` even in Full Auto; `ask` forces the HITL path even when global mode is Full Auto. Ship a conservative built-in denylist (the `rm -rf /`, fork-bomb, `curl|sh`, `chmod 777`, secret-file-read patterns) that *cannot* be disabled by the autonomy dropdown. Persist rules in `.janus_settings.json` (extend `SystemSettings.advanced`, `src/types.ts:76-90`) with per-preset overrides on `CliPreset` (`src/types.ts:42-55`).
- **Why it's the keystone.** Everything else (risk badges, tiered approval, learning) hangs off having a rule layer to attach to. Without it, "Full Auto" stays all-or-nothing and stays a no.

### A2. Command risk classification + tiered approval
- **Priority: P1 · Effort: M**
- **Problem it solves.** Not all commands deserve the same ceremony. A `git status` and a `git push --force` should not both be a single amber "Confirm & Fire" modal (`ApprovalDialog.tsx:68-81`). Approvers habituate; habituated approvers approve `--force` on muscle memory (the round-one Enter-to-fire footgun, `ApprovalDialog.tsx:21-34`, makes this worse).
- **Sketch.** A `classifyRisk(cmd, cwd) -> { tier: "low"|"medium"|"high"|"critical", signals: string[] }` heuristic (writes outside cwd, deletes, network egress, privilege escalation, package install, history rewrite). The rationale already computed at `server.ts:683` gains a `risk` field carried through `approval_pending` → `pendingApprovals` (`server.ts:452,684`) → the dialog. Tier drives required confirmation: low = one click, high/critical = type-to-confirm (re-enter the pane id or the verb) and *never* Enter-to-approve. Tier also feeds A1 defaults (auto-allow low, force-ask high).
- **Builds on.** The rationale plumbing already exists end-to-end; this rides it.

### A3. Append-only, signed, exportable audit log with replay
- **Priority: P0-aspirational · Effort: M**
- **Problem it solves.** Today the only record is `HistoryManager` writing command+output to a per-cwd `.janus_history.json` (`server.ts:93-112`) — plaintext, mutable, easy to lose, and it captures *what ran* but not *who approved it, under which mode, against which rule, or why*. For any compliance-adjacent conversation I need an immutable "who/what/when/which-policy/which-operator" trail I can hand to an auditor.
- **Sketch.** A dedicated `AuditLog` that records a structured event for every gate decision (`auto_executed`, `approved`, `rejected`, `blocked`, `policy_match`, `mode_change`, `kill`) with operator id (A5), pane, cwd, command, risk tier, rule that fired, and timestamp. Hash-chain each entry (`hash = H(prev_hash + entry)`) so tampering is detectable; optional HMAC with a server key for attribution. Append-only file + a `GET /api/audit?from=&to=&format=json|ndjson|csv` export behind `authMiddleware` (`server.ts:138-149`). "Replay" = render the decision stream read-only in the UI (B3). Keep this *separate* from `HistoryManager` — history is for the model's context, audit is for me.
- **Note.** Also fixes a round-one gap: orphaned/after-death approvals (`server.ts:480`) would at least be *recorded* as anomalies.

### A4. Global kill-switch / emergency stop-all
- **Priority: P0-aspirational · Effort: S**
- **Problem it solves.** When an agent goes wrong across N panes, I need one control that (a) SIGKILLs every pane, (b) drops every pending approval, and (c) refuses new `propose_command` until I re-arm. Today I'd be closing panes one at a time while the model keeps proposing; `pendingApprovals` would even survive (round-one defect #4). The per-pane teardown already exists — `Terminal.stop()` does SIGTERM→SIGKILL on the process group (`src/terminal.ts:318-363`) — there's just no orchestrator-wide trigger or a latch to stop re-arming.
- **Sketch.** `POST /api/emergency-stop`: iterate `manager.terminals` calling `stop()`, `for (k in pendingApprovals) delete` + reject their tool responses, and set a `manager.armed = false` latch checked at the top of the `propose_command` branch (`server.ts:627`) so every subsequent proposal returns blocked until an explicit `POST /api/arm`. Wire it to a hardware-red control in the header (B4) and a keyboard chord. This also needs to gate the auto-reconnect re-arm path (round-one defect #5, `App.tsx:391-409`): a killed-state session must not silently come back hot.

### A5. Multi-operator identity + roles (RBAC)
- **Priority: P1 · Effort: L**
- **Problem it solves.** There is exactly one shared secret (`API_AUTH_TOKEN`, `server.ts:142`) — everyone who has the cookie *is* the same anonymous god-user. The server even binds `0.0.0.0` by default (`server.ts:910`). For a team, "operator" is a single blurry entity: I can't attribute an approval, can't say "Priya may run in staging panes but only request in prod," can't revoke one person.
- **Sketch.** Per-operator tokens/sessions mapped to a role (`owner` / `operator` / `observer`). Roles gate capability: who can flip global mode (`App.tsx:680-689`), who can approve which risk tier (A2), who can edit policy (A1), who can hit emergency-stop, who is read-only. Stamp operator id into every audit event (A3) and into `pendingApprovals` so the dialog shows *who* a proposal is waiting on. Minimum viable version: static operator table in settings + token→operator map; full version: OIDC/SSO. Even the MVP turns "the box" into accountable humans.

### A6. Secrets brokering — keys never reach the model or the pane stdin
- **Priority: P1 · Effort: M**
- **Problem it solves.** Round one flagged the API key persisted plaintext to a non-gitignored `.janus_settings.json` (`SettingsDialog.tsx:1037-1043`). The deeper, scaling problem: when the LLM proposes a command needing a secret, today the only paths are bake-it-into-the-command (so it hits the model's context and the audit log and shell history) or pre-export it into the pane env. Neither is acceptable at team scale.
- **Sketch.** A named-secret broker. The model references a *handle* (`${secret:GH_TOKEN}`) it can never read; on approve, the server substitutes the real value at `writeInput` time (`src/terminal.ts:308`) — after the command is logged with the handle still in place, so the cleartext secret never lands in audit (A3) or history (`server.ts:470`). Secrets live in an encrypted store (OS keychain or age/sops file), not `.janus_settings.json`. Bonus: redaction pass on captured stdout (`src/terminal.ts:261-291`) so an `env` dump doesn't get persisted to scrollback in cleartext.

### A7. Enforced rate limiting + proposal anomaly detection
- **Priority: P2 · Effort: S/M**
- **Problem it solves.** `rateLimitRequestsPerMin` exists in settings (`src/types.ts:83`) but is read by *nothing* — round one confirmed it's never enforced. A misbehaving or prompt-injected agent can spray commands as fast as the model emits tool calls. There's also no notion of "this proposal is weird for this pane."
- **Sketch.** (a) A real token-bucket per pane/operator checked at `server.ts:627` that pushes overflow proposals to `deny` with an audit event. (b) Lightweight anomaly signals layered on A2's classifier: command targets a path the pane has never touched, sudden burst of high-tier proposals, egress to a never-seen host, or a proposal that doesn't match the spoken trigger (`currentSessionUserUtterance`, `server.ts:681`) — surface these as a flag on the approval (B1) rather than auto-blocking. Voice transcription is fallible; an injected/hallucinated command that doesn't match what I *said* is exactly the case I want highlighted.

---

## Part B — Visual / UI improvements (trust legibility)

The principle: **the UI must make the blast radius and the basis-for-decision impossible to miss.** Today the approval modal shows a bare command + pane id (round-one defect #1 — the rationale is computed at `server.ts:681-693` but never passed into the component at `App.tsx:633-641`), and the only "mode" signal is a dropdown in the header (`App.tsx:680-689`).

### B1. Risk badge + signals on the approval dialog
- **Priority: P1 · Effort: S**
- **Problem.** The dialog (`ApprovalDialog.tsx:36-86`) treats `git status` and `rm -rf node_modules` identically — same amber chrome, same "Confirm & Fire [Enter]". I can't see *why* this one is dangerous.
- **Sketch.** Render A2's tier as a colored badge (green/amber/red/critical) at `ApprovalDialog.tsx:44-47`, list the triggering signals ("writes outside cwd", "network egress", "matched deny-rule override"), and switch the chrome + confirmation control by tier (type-to-confirm for high/critical, kill the global Enter binding at `ApprovalDialog.tsx:21-34`). First, just *pass `rationale` in* — it's already in state at `App.tsx:362`.

### B2. Diff / impact preview before approval
- **Priority: P2 · Effort: M**
- **Problem.** I'm asked to approve a command with zero preview of its effect. For a class of commands the effect is cheaply previewable.
- **Sketch.** For known-safe-to-dry-run verbs (`git push` → `git push --dry-run`, file deletes → `ls` the glob, `git commit` → `git diff --cached --stat`), the server runs the preview in the pane's cwd and ships the result alongside the proposal; the dialog shows it in a panel beside the rationale block (`ApprovalDialog.tsx:53-66`). Where a true preview isn't safe, show the static impact summary from A2 ("deletes ~N files under ./dist"). Makes "what will this actually do" legible at decision time.

### B3. Audit timeline panel
- **Priority: P1 · Effort: M**
- **Problem.** There is no in-app way to see the decision history. Auto-executions get a 4-second toast and vanish (`App.tsx:374-377`); blocks get a 4-second toast (`App.tsx:378-380`). After ten minutes I have no idea what ran.
- **Sketch.** A persistent, filterable timeline (drawer or tab) fed by A3's audit stream: each row = timestamp · operator · pane · risk badge · command · decision · rule-that-fired, color-coded, filter by pane/operator/decision/tier, with the export button (A3) right there. This is the "replay" surface and the thing I'd actually screen-share in an incident review.

### B4. Global mode / blast-radius indicator + emergency stop control
- **Priority: P0-aspirational · Effort: S**
- **Problem.** The current-autonomy state is a small dropdown that reads the same whether it says "Read-Only" or "Full Auto (Auto-Approve)" (`App.tsx:678-690`). When every pane is in Full Auto — the *shipped default* for the Antigravity preset (`src/terminal.ts:51`) — nothing screams it. And there is no stop control anywhere.
- **Sketch.** A persistent header banner that changes color/weight by effective blast radius: green (Read-Only), neutral (HITL), and an unmistakable pulsing red bar across the top when *any* pane is in Full Auto, naming how many panes are hot. Next to it, a dedicated red **STOP ALL** button wired to A4 (and a confirm-on-click so it's not itself a footgun), plus a re-arm affordance. The mode must be ambient, not buried in a dropdown.

### B5. Per-pane policy/role status chips
- **Priority: P2 · Effort: S**
- **Problem.** Per-pane mode lives in `PaneMeta.permissions_mode` (`src/types.ts:27`) and the terminal list (`server.ts:226-231`) but isn't surfaced as a glanceable, color-coded indicator on each pane. With multi-operator (A5) I also can't see which panes a given role may act on.
- **Sketch.** A small chip on each pane header: mode (color-coded), active rule-set name (A1), and — once A5 lands — which operators can auto vs. must-ask there. Lets me audit blast radius across a grid of panes at a glance instead of opening each.

---

## Prioritization summary

| ID | Item | Priority | Effort |
|----|------|----------|--------|
| A1 | Per-command/path policy rule engine | P0-aspirational | L |
| A3 | Signed append-only audit log + export/replay | P0-aspirational | M |
| A4 | Global kill-switch / emergency stop-all | P0-aspirational | S |
| B4 | Blast-radius indicator + STOP control | P0-aspirational | S |
| A2 | Risk classification + tiered approval | P1 | M |
| A5 | Multi-operator identity + roles | P1 | L |
| A6 | Secrets brokering | P1 | M |
| B1 | Risk badge + signals on approval dialog | P1 | S |
| B3 | Audit timeline panel | P1 | M |
| A7 | Enforced rate limit + anomaly flags | P2 | S/M |
| B2 | Diff/impact preview before approval | P2 | M |
| B5 | Per-pane policy/role status chips | P2 | S |

**The spine:** A1 (rules) + A3 (audit) + A4/B4 (stop + ambient blast-radius) are the minimum that turns the gate from a binary switch into a *control surface* I can stand behind. A2/B1 ride the rationale plumbing that already exists end-to-end (`server.ts:681-693`) — high value, low cost, and they're the natural follow-on once the round-one fix (pass `rationale` into the dialog) is in. A5 and A6 are what make it *team*-grade rather than single-operator-grade.
