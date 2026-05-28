# Security & DevOps Assessment — Orbital Harness / Janus Terminal Orchestrator

## Reviewer

**Sofia Almeida** — Principal Security & Platform/DevOps Engineer.
Lens: application security, secrets management, and production readiness for tools
that execute commands. I threat-modeled this as what it actually is — a network
service that turns voice/HTTP input into arbitrary shell execution on the operator's
host. The whole product *is* the attack surface, so I weighed real exploitability
over theoretical hygiene.

---

## Executive summary

This is a remote-controlled arbitrary-code-execution engine with **no authentication
or authorization on any trust boundary**, bound to `0.0.0.0` by default. The
human-in-the-loop permissions model is a reasonable *product* idea, but it is
advisory rather than enforced: the same unauthenticated HTTP API that the approval
flow relies on can also create `Full Auto` panes, flip a pane to `Full Auto`, or
write directly to a child process — bypassing approval entirely. Commands are run
through `/bin/sh -c <string>`, so any place an attacker reaches `writeInput` or
`spawn` gets a full shell. Secrets handling is partially thought-through (env-key
masking on GET) but leaks the real key back on PUT and persists it in plaintext to a
file that is **not gitignored**. There is no CI, no dependency scanning, no rate
limiting, no audit log, and error handling is thin. Net: the safety mechanisms that
exist are real but sit *above* an unguarded foundation, so the blast radius of any
browser tab, LAN peer, or prompt-injection is full host compromise as the server's
user.

---

## Trust boundaries

| # | Boundary | Protection today | Verdict |
|---|----------|------------------|---------|
| 1 | Browser/HTTP client ↔ Node server (REST `/api/*` + WS `/live`) | **None** — no auth token, no session, no CORS check, no WS origin check, binds `0.0.0.0` | Critically under-protected |
| 2 | Gemini Live model ↔ server (tool calls) | Permissions model gates `propose_command` only; model output is otherwise trusted | Under-protected (prompt-injection → command proposal) |
| 3 | Server ↔ shell (`spawn('/bin/sh', ['-c', cmd])` + `stdin.write`) | None — full shell, full `process.env`, runs as server user | By-design dangerous; needs containment |

The product's stated control (the permissions model) only sits on boundary #2, the
*one* boundary an attacker does not need. Boundaries #1 and #3 are wide open.

---

## Strengths (safety mechanisms that exist and work)

- **Permissions model is conceptually layered.** Global override → per-pane mode →
  `Human-in-the-Loop` default is computed deterministically in `server.ts:373-432`,
  and the three branches (Full Auto / Read-Only / HITL) behave as documented. The
  HITL path correctly withholds the Gemini tool response until operator action
  (`server.ts:431`), so the model genuinely blocks pending approval.
- **No `shell: true` on user-supplied args path.** `spawn` is called with an explicit
  executable and arg array (`src/terminal.ts:169-172`); the shell parsing is confined
  to the deliberate `-c <cmd>` design, not accidental argument interpolation.
- **API-key masking on read.** `GET /api/settings` masks the key to `prefix••••suffix`
  (`server.ts:240-245`) and the env-configured key is stored as the sentinel
  `"CONFIGURED_IN_ENV"` rather than the literal value (`src/terminal.ts:287`).
- **Preset normalization is defensive.** `parsePresetsSafe` (`src/terminal.ts:6-53`)
  coerces every field with `String(...)`/`Boolean(...)`, avoiding prototype-pollution
  and type-confusion from imported config.
- **Output buffer is bounded.** `maxBufferLines` splice (`src/terminal.ts:186-188`,
  `200-204`) caps memory growth from chatty processes.
- **Honest security note in the README.** `README.md:160-166` correctly states the API
  has no auth and warns against `Full Auto` for untrusted input. Documented risk is
  better than hidden risk.
- **Tests exist for core logic.** `tests/test_ledger.ts`, `tests/test_server.ts` cover
  ledger persistence, pane lifecycle, ANSI stripping.

---

## Weaknesses / risks (ranked by severity)

### CRITICAL

**C1 — No authentication/authorization on the HTTP API or WebSocket; binds `0.0.0.0`.**
Evidence: `server.ts:23` (`WebSocketServer({ server, path: "/live" })` — no
`verifyClient`/origin check), all `app.*` routes `server.ts:66-305` have zero auth
middleware, and `server.ts:621` binds `"0.0.0.0"`. Default settings also set
`host: "0.0.0.0"` (`src/terminal.ts:254`).
Impact: any host on the LAN/network (or any process on the box) can `POST
/api/terminals` to spawn an arbitrary command, or `PUT
/api/projects/:p/panes/:id/permissions` to set `Full Auto`, then drive
`propose_command`. Full RCE as the server user with the server's full environment. No
credential is required at any step.

**C2 — Permissions model is bypassable via the unauthenticated REST API.**
Evidence: `POST /api/terminals` (`server.ts:89-99`) calls `manager.addTerminal(...)`,
which immediately `start()`s a `/bin/sh -c <command>` child (`src/terminal.ts:366-370`)
with **no permissions check at all** — the gating logic only lives in the
`propose_command` tool handler. Separately, `PUT
/api/projects/:projectId/panes/:paneId/permissions` (`server.ts:166-185`) lets any
caller set a pane to `Full Auto` with no authz, and `POST /api/commands/approve`
(`server.ts:275-305`) lets any caller approve any pending command by guessing/reading
the `messageId` (which is exposed by `GET /api/commands/pending`, `server.ts:267-273`).
Impact: the human-in-the-loop guarantee is not a security boundary — it is a UI
convenience that an attacker simply routes around. This directly undermines the
product's core safety claim.

**C3 — Arbitrary command string executed via `sh -c` with inherited environment.**
Evidence: `src/terminal.ts:166-172` runs `spawn("/bin/sh", ["-c", this.shellCmd], {
cwd, env: process.env })`; `writeInput` pipes raw strings to stdin with a newline
(`src/terminal.ts:222-226`). `shellCmd` originates from `POST /api/terminals` body and
from preset `command` strings.
Impact: command injection is the *intended* capability, but because `env:
process.env` is passed wholesale, every executed command (and every agent in a pane)
inherits `GEMINI_API_KEY` and any other host secrets — so a single injected command
(`env`, `cat ~/.aws/credentials`) exfiltrates everything. No env allow-listing, no
sandbox, no `cwd` restriction.

### HIGH

**H1 — Gemini API key written to disk in plaintext and not gitignored.**
Evidence: `saveSettings` writes the full `settings` object — including
`secrets.geminiApiKey` — to `.janus_settings.json` (`src/terminal.ts:318-324`,
`340-343`). `.gitignore` (lines 1-11) lists `.janus_ledger.json` and
`.janus_ledger_test.json` but **omits `.janus_settings.json`**.
Impact: a user who sets the key via the Settings dialog has it persisted in cleartext
in the repo working tree, and an inattentive `git add .` commits it. Key leakage →
billing abuse / model access under the victim's account.

**H2 — `PUT /api/settings` reflects the real (unmasked) key back to the client.**
Evidence: `server.ts:249-261` — after merging, the handler responds with
`{ settings: manager.settings, ... }`, i.e. the *unmasked* `geminiApiKey`, unlike the
GET path which masks it. The `settings_updated` WS broadcast (`server.ts:255-259`)
also pushes full `manager.settings` to **all** connected clients.
Impact: any client that triggers a settings update (or merely listens on the WS)
receives the plaintext API key, widening exposure beyond the masking effort made on
GET. Combined with C1, an unauthenticated peer can read the key.

**H3 — Antigravity preset ships `Full Auto` + `--dangerously-skip-permissions` by
default.** Evidence: `src/terminal.ts:51` default preset has
`permissionsMode: "Full Auto"`, `dangerouslySkipPermissions: true`, and a command
string already containing `--dangerously-skip-permissions`. `setPermissionsMode`
auto-appends the flag for any non-custom preset switched to Full Auto
(`src/terminal.ts:113-125`).
Impact: an out-of-the-box preset disables both the orchestrator's approval gate *and*
the downstream tool's own permission prompts. The most dangerous configuration is a
one-click default, not an opt-in. Insecure-by-default.

**H4 — Prompt injection → command proposal with no command allow/deny-listing.**
Evidence: `propose_command` accepts any `args.command` string (`server.ts:370-371`)
and, under `Full Auto`, executes it verbatim (`server.ts:383`). Pane stdout is fed
back to the model via `get_pane_summary` (`src/terminal.ts:415-422`) with only ANSI
stripping — no redaction despite the tool description claiming "redacted."
Impact: malicious content in any file/repo/web output the agent reads can instruct
the model to propose destructive commands. With a Full Auto pane (H3) this is direct
RCE; with HITL it is a social-engineering vector against the operator. There is no
denylist (e.g. `rm -rf`, `curl | sh`, credential paths) anywhere.

### MEDIUM

**M1 — No origin/CSRF protection on state-changing endpoints.** Evidence: no CORS
config, no CSRF token, all mutations are simple `POST/PUT/DELETE` with JSON bodies
(`server.ts:89-305`). Impact: a malicious web page the operator visits can issue
cross-origin `fetch`/`no-cors` form posts to `http://localhost:3000/api/terminals`
and spawn commands (drive-by RCE on `localhost`). Express `express.json()` requires
`Content-Type: application/json`, which mitigates simple-form CSRF somewhat, but a
`text/plain` or fetch-based attack from a permissive browser still reaches it.

**M2 — Path/identifier injection into runtime files and cwd is unvalidated.**
Evidence: `cwd` from `POST /api/terminals` flows unchecked into `spawn({ cwd })`
(`src/terminal.ts:169`); project/pane IDs flow into ledger object keys
(`src/ledger.ts:61-124`). `directory` is attacker-controlled and used as the spawn
working directory. Impact: arbitrary working directory selection; no traversal of the
ledger *file path* (it is fixed), but unvalidated IDs allow ledger pollution / DoS via
unbounded key growth. Lower severity because the file path itself is constant.

**M3 — `JSON.parse` on WS and HTTP input without try/catch can crash the process.**
Evidence: `clientWs.on("message", (data) => { const msg = JSON.parse(...) })`
(`server.ts:581-582`) has no try/catch; a malformed frame throws in the handler.
Several REST handlers destructure `req.body` without validating shape (e.g.
`server.ts:131-164`). Impact: trivial unauthenticated DoS — one bad WS frame can throw
an unhandled exception. Combined with no process supervisor, the orchestrator (and all
its child terminals) can go down.

**M4 — No audit logging of executed/approved commands.** Evidence: execution paths
(`server.ts:383`, `server.ts:282`) only `console.log`/echo to the model; nothing
records *who* approved *what* *when* to durable storage. The ledger stores notes/panes
but not a command history. Impact: after an incident there is no forensic trail of
what the agent ran or who approved it — unacceptable for a tool whose purpose is
executing commands.

### LOW

**L1 — `cpuUsage` is fabricated with `Math.random()`** (`src/terminal.ts:127-133`) and
surfaced via `GET /api/terminals` and the ledger. Operationally misleading telemetry;
remove or label as simulated.

**L2 — `manager.ledger["save"]()` bracket-access "to bypass bracket checks"**
(`server.ts:180`, comment). Reaching into a private method via string index is a code
smell that signals the API boundary is being worked around; refactor to a public
method.

**L3 — Session-ID scraping from stdout via regex** (`src/terminal.ts:135-153`) parses
untrusted child output into `sessionId` shown in the UI/ledger — minor injection/UX
risk if a process prints attacker-chosen "Session ID:" lines.

**L4 — `Math.random()` used for session identifiers** (`src/terminal.ts:106`) — not
cryptographically random; fine for display, not for anything security-bearing.

---

## Capability gaps (missing controls for the stated goal)

For a tool whose explicit purpose is gated remote command execution, these are
*expected* controls that are absent:

1. **AuthN/AuthZ layer** — no bearer token, no localhost-only bind option enforced, no
   per-client identity. There is no way to distinguish the operator's browser from any
   other client.
2. **Enforced (not advisory) permissions** — the gate must live at the *execution*
   chokepoint (`writeInput`/`addTerminal`/`spawn`), not only inside one Gemini tool
   handler. Today three REST routes and one WS tool can each execute independently.
3. **Sandboxing / least privilege** — no container, no seccomp, no `cwd` jail, no env
   scrubbing. The orchestrator should never hand `process.env` (with the API key) to
   child shells.
4. **Command policy engine** — no allowlist/denylist, no dry-run, no per-pane command
   budget/rate limit (the `rateLimitRequestsPerMin` setting at `src/terminal.ts:281`
   is defined but never enforced anywhere).
5. **Secrets management** — no OS keychain / vault integration, plaintext-on-disk only,
   no rotation, key echoed on PUT.
6. **Observability** — no structured audit log, no metrics, fabricated CPU stats, no
   correlation IDs across propose→approve→execute.
7. **Supply chain / CI** — no CI workflow, no `npm audit`/Dependabot, no lockfile
   integrity gate, no SAST. The build (`package.json:8`) bundles the server with
   esbuild but nothing scans it.
8. **Hardening** — no `helmet`, no body-size limit on `express.json()`, no WS message
   size/rate caps, no timeouts on child processes.

---

## Recommendations (effort S/M/L · impact High/Med/Low)

| # | Recommendation | Effort | Impact |
|---|----------------|--------|--------|
| R1 | Add a mandatory shared-secret bearer token (env-provisioned) checked by Express middleware **and** WS `verifyClient`; reject mismatched `Origin`. | S | High |
| R2 | Default-bind to `127.0.0.1`; make `0.0.0.0` an explicit, warned opt-in. | S | High |
| R3 | Move permission enforcement to a single `executeCommand` chokepoint that *all* paths (REST create, approve, Full Auto, tool call) must pass through; remove the ability to create panes/flip permissions without authz. | M | High |
| R4 | Stop passing `process.env` to children; inject only an explicit allowlist (and never `GEMINI_API_KEY`). | S | High |
| R5 | Add `.janus_settings.json` to `.gitignore`; stop reflecting the unmasked key on `PUT /api/settings` and in the `settings_updated` broadcast; prefer env/keychain over file persistence for secrets. | S | High |
| R6 | Change the Antigravity (and any) default preset off `Full Auto`/`dangerouslySkipPermissions`; require explicit operator opt-in with a confirmation. | S | High |
| R7 | Wrap all `JSON.parse(req/ws)` in try/catch; add `express.json({ limit })`, WS message-size caps, and validate request body schemas (zod). | S | Med |
| R8 | Add a durable, append-only audit log (timestamp, source, pane, command, decision, approver) for every propose/approve/execute. | M | High |
| R9 | Introduce a command policy engine (denylist + optional allowlist) and enforce the already-defined `rateLimitRequestsPerMin`. | M | Med |
| R10 | Run command execution in a sandbox (container/`cwd` jail/least-priv user); document the threat model. | L | High |
| R11 | Add CI: `npm run lint`, `npm test`, `npm audit --audit-level=high`, Dependabot. | S | Med |
| R12 | Add `helmet`, remove fabricated `cpuUsage` or label it simulated, refactor `ledger["save"]()` to a public method. | S | Low |

---

## Top 5 prioritized roadmap items

1. **Authenticate every boundary + bind localhost (R1, R2).** Without this, all other
   controls are moot — anyone on the network has unauthenticated RCE today.
2. **Make the permissions gate the single, enforced execution chokepoint (R3).** Close
   the REST create / approve / Full Auto bypass so "human-in-the-loop" is a real
   boundary, not UI decoration.
3. **Fix secrets handling end-to-end (R5, R4).** Gitignore the settings file, stop
   echoing/broadcasting the unmasked key, and keep host secrets out of child-process
   environments.
4. **Flip insecure defaults + add command policy (R6, R9).** No preset should ship
   `Full Auto` + `--dangerously-skip-permissions`; add a denylist and enforce rate
   limits before defaults become incidents.
5. **Add audit logging, input hardening, and CI/dependency scanning (R8, R7, R11).**
   Make misuse observable and the pipeline accountable.
