# Security & Platform Assessment — Orbital Harness (Janus Terminal Orchestrator)

**Reviewer:** Devon Park, Senior Platform & Security Engineer
**Date:** 2026-05-28
**Scope:** Whether this tool *works* (the permissions/approval/execution machinery is complete and correct) and whether it *fits* (a security-conscious engineer would trust this loop driving AI agents on a dev machine).

---

## Persona summary

I gate what gets to run shell commands on developer machines. I do not care about the voice UX, the "Cosmic Slate" theme, or how clever the ledger is. I care about exactly one thing: when Project Janus says "run X on pane Y," can I trust that (a) the policy I set is actually enforced, (b) the command I approved in the dialog is byte-for-byte what hits the shell, and (c) there is no path where something runs that I did not authorize. Everything below is judged against that bar.

## Methodology

Read in full: `README.md`, `SETTINGS_SPEC.md`, `server.ts`, `src/terminal.ts`, `src/types.ts`, `src/ledger.ts`, `src/App.tsx`, `src/components/ApprovalDialog.tsx`, `src/components/SettingsDialog.tsx`, `src/components/CreateTerminalDialog.tsx`, `src/utils/api.ts`, `universal_terminal.py`, `tests/test_approvals.ts`, `tests/test_server.ts`, `.env.example`, `.gitignore`, `.janus_settings.json`, `package.json`.

Ran:
- `npm run lint` (`tsc --noEmit`) → **exit 0**, clean.
- `npm test` (`tsx --test tests/*.ts`) → **13 pass, 0 fail**.

Traced `propose_command` end to end: tool-call dispatch (`server.ts:627`) → effective-mode computation (`server.ts:631-636`) → Full Auto / Read-Only / HITL branches (`server.ts:638-695`) → approval store (`pendingApprovals`, `server.ts:452`) → `/api/commands/approve` (`server.ts:463`) → `term.writeInput` (`src/terminal.ts:308`).

---

## Does it work?

Mostly the wiring is real. There is a genuine `child_process` spawn (`src/terminal.ts:245`), real stdin writes (`src/terminal.ts:308-312`), a real gate, and a real approval round-trip. But there are correctness defects in the gate and the approval UI that matter to me directly.

### What is correct

- **Approved command == executed command.** The HITL path stores the exact `cmd` from the tool call (`server.ts:684`) and `/api/commands/approve` writes that same stored string (`server.ts:471`, `pending.cmd`). `writeInput` only appends `"\n"` (`src/terminal.ts:308-312`) — no re-templating, no shell-string reconstruction, no edit step. The dialog cannot edit the command, so there is no approved-vs-executed drift. Good. This is the one property I most needed and it holds.
- **The three branches dispatch the right tool responses** and notify the UI (`command_auto_executed`, `command_blocked`, `approval_pending`). Read-Only genuinely refuses to write (`server.ts:664-677`) — it returns an error to the model and never calls `writeInput`.
- **Per-message approval keying is sound.** Each pending command is keyed by `call.id` (`server.ts:680,684`), and approve/reject deletes only that key (`server.ts:497`). The multi-pane queue test (`test_approvals.ts:8`) reflects real behavior.
- **The WS boundary is actually enforced.** Both REST (`authMiddleware`, `server.ts:138-149`) and the `/live` socket (`server.ts:507-513`) check the `API_AUTH_TOKEN`. This is better than the README's own "no authentication" disclaimer (`README.md:162`) — the README undersells what's there. Token is httpOnly/SameSite=strict cookie, seeded on page render (`server.ts:124-136`).

### Defects that affect the gate / UI fidelity

1. **The approval dialog does not show the rationale the backend went to the trouble of computing.** The server builds `rationale = { trigger, summary }` and ships it in `approval_pending` (`server.ts:681-693`); `App.tsx` even stores it in the pending command (`App.tsx:355-364`). But the `ApprovalDialog` invocation at `App.tsx:633-641` passes only `messageId`, `terminalId`, `cmd`, `onApprove`, `onReject` — **`rationale` is never passed in**. So the "Heard trigger / context" and "Proposed rationale / summary" panels (`ApprovalDialog.tsx:53-66`) are dead code in practice. As the approver, I am shown a bare command string and a pane ID, with zero context about *why* the agent wants to run it or *what the agent claims it saw*. That is precisely the information I need to make an approval decision. The dialog under-represents the decision.

2. **Enter-to-approve is a footgun on a destructive action.** `ApprovalDialog.tsx:21-34` binds a global `keydown`: Enter → approve, Escape → reject. A modal that fires a shell command on a stray Enter keypress, with no focus requirement and no defaulting to the safe choice, is the wrong default for a confirm-to-execute gate. Combined with #1 (no context shown), a distracted operator approves blind.

3. **Only one pending approval is ever rendered.** `App.tsx:633` renders `pendingCommands[0]` only. The backend and state happily queue N concurrent approvals (the test even celebrates this), but the operator only ever sees the first. If three agents propose commands, two are invisible in the dialog until the first is resolved — and the Enter binding means resolving the first can immediately surface the next under the same keypress muscle-memory. The "queue works" test (`test_approvals.ts:8-41`) tests a data structure, not the UI that gates on it.

4. **Stale/orphaned approvals are never cleaned up, contradicting the test that claims they are.** `test_approvals.ts:44-72` asserts a server-side `onCloseCleanup` that "purges pending entries linked to a closed session." **No such code exists in `server.ts`.** The real `clientWs.on("close")` handler (`server.ts:864-877`) deletes the client, nulls `activeFrontendWs`, and closes the Gemini session — it does **not** touch `pendingApprovals` (confirmed: the only mutations of that map are at `server.ts:497` and `:684`). Consequences: (a) `pendingApprovals` grows unbounded across reconnects/sessions; (b) a stored `pending.session` points at a closed session, so on approve the `writeInput` *still fires* (the command runs) but the `sendToolResponse` throws into a catch (`server.ts:480-482`) — the command executes while the model is told nothing. This is a green test asserting a safeguard that isn't implemented. That erodes my confidence in the whole suite.

5. **Reconnect re-arms the whole tool surface with no re-consent.** The frontend auto-reconnects every 3s on unexpected close (`App.tsx:391-409`), and the server re-establishes a fresh Gemini Live session with the full tool set and session resumption each time (`server.ts:541`, `lastSessionResumptionToken` at `:504`). A flapping connection silently keeps the command channel hot.

### Lower-severity / non-security correctness notes

- `--dangerously-skip-permissions` is *only* string-appended for the child agent's own internal policy (`src/terminal.ts:94-103`, `:117-129`); it has **no bearing** on Janus's gate. Two unrelated "permissions" concepts share a name, which is confusing but not itself a bypass of the Janus gate. However, the default `parsePresetsSafe` antigravity preset ships `permissionsMode: "Full Auto"` with `--dangerously-skip-permissions` baked in (`src/terminal.ts:51`) — a default toward maximum autonomy.
- `OrchestratorManager` is constructed at module load (`server.ts:115`) and immediately spawns a `bash`/`cmd.exe` pane (`server.ts:117`) **before** any client connects or authenticates. The default pane exists with whatever mode the loaded settings imply.
- The Python port (`universal_terminal.py`) is a reference shell runner with **no gate at all** — `write_input` (`:65`) writes whatever it's given. It's not in the server path, but it's shipped and shaped like a drop-in.

---

## Trust / workflow fit

The intended loop is: talk to Janus, it proposes shell commands across panes driving Claude/Codex/Antigravity, I approve. For that to be adoptable, the gate has to be the strong, legible part of the system. Here it is the weakest-presented part.

- **The effective-mode logic is correct but the safe default is fragile.** Global overrides local unless global is `Inherit`, then local applies, defaulting to HITL (`server.ts:631-636`; mirrors `README.md:41-52`). Fine. But `Full Auto` is one dropdown selection away at the global level (`App.tsx:680-689`) and is the *shipped default* for the Antigravity preset. One UI click flips every pane to fire-and-forget with no per-command visibility beyond a 4-second toast (`App.tsx:374-377`). For a voice-driven system where the trigger is fallible speech transcription (`currentSessionUserUtterance`, `server.ts:681`), Full Auto on a dev machine is a hard no.
- **The approval UI does not give me what I need to approve responsibly** (defects #1–#3). A command string with no rationale, Enter-to-fire, and hidden siblings is not a trustworthy human-in-the-loop. HITL is the *entire* value proposition for a skeptic, and it's the part that's under-wired.
- **Secret handling is mostly OK, with leaks.** GET `/api/settings` masks the key (`server.ts:425-434`) and PUT preserves the existing key when the masked sentinel comes back (`server.ts:438-440`). But the key is accepted and stored in plaintext in `.janus_settings.json` via the Settings dialog (`SettingsDialog.tsx:1037-1043`, written by `saveSettings`, `src/terminal.ts:449-455`), and `.janus_settings.json` is **not** in `.gitignore` (only `.janus_ledger.json` and `*.log` are — `.gitignore:6-11`). A user who types their key into the UI instead of `.env` gets it persisted to a file that is not ignored. The SettingsDialog also claims local subshells "run with raw subprocess Python execution... strictly local" (`SettingsDialog.tsx:1058-1064`) — that's marketing text describing a Python path the Node server does not use; the actual shell exec is `script`/`spawn` in `src/terminal.ts`. Misleading.
- **No rate limiting / no command audit beyond history.** `rateLimitRequestsPerMin` exists in settings (`types.ts:83`) but is never read or enforced anywhere in `server.ts`. `HistoryManager` logs commands+output to `.janus_history.json` (`server.ts:93-112`), which is a forensic trail of everything that ran — useful, but also another plaintext sink of potentially sensitive output written next to the repo.
- **`0.0.0.0` bind is the default** (`server.ts:910`, `.janus_settings.json:4`). The token gate mitigates this, but the combination of "spawns a bash pane at boot," "binds all interfaces," and "auto-reconnects" means the blast radius of a token leak is a live shell.

---

## Severity-ranked concerns

| # | Severity | Concern | Evidence |
|---|----------|---------|----------|
| 1 | **High** | HITL dialog hides the rationale/context the backend computed; operator approves a bare command string blind. | `App.tsx:633-641` omits `rationale`; `ApprovalDialog.tsx:53-66` |
| 2 | **High** | Test asserts a `pendingApprovals` session-close cleanup that does not exist; orphaned approvals persist and still `writeInput` on approval after session death. | `test_approvals.ts:44-72` vs `server.ts:864-877`, `:471`, `:480` |
| 3 | **Med-High** | Enter-to-approve global keybind on a command-execution modal; wrong default for a destructive gate. | `ApprovalDialog.tsx:21-34` |
| 4 | **Med-High** | Only `pendingCommands[0]` is ever shown; concurrent approvals are invisible until the first resolves. | `App.tsx:633` |
| 5 | **Medium** | Full Auto is a one-click global flip / shipped default for Antigravity; only a 4s toast, no per-command visibility. | `App.tsx:680-689`; `src/terminal.ts:51`; `server.ts:638-654` |
| 6 | **Medium** | API key persisted plaintext to `.janus_settings.json`, which is **not** gitignored. | `SettingsDialog.tsx:1037-1043`; `src/terminal.ts:451`; `.gitignore:1-11` |
| 7 | **Medium** | Default shell pane spawned at module load, before any auth/connection; `0.0.0.0` bind; auto-reconnect keeps channel hot. | `server.ts:115-117`, `:910`; `App.tsx:391-409` |
| 8 | **Low** | `rateLimitRequestsPerMin` defined but never enforced; command history is another plaintext output sink. | `types.ts:83` (no reader); `server.ts:93-112` |
| 9 | **Low** | Misleading "strictly local Python subprocess / no keys" copy describing a path the server doesn't use. | `SettingsDialog.tsx:1058-1064` |

---

## Bottom line

**Would I let this run on my machine today? No.**

The core property I cared most about holds — *what you approve is what runs* (`server.ts:471` → `terminal.ts:308`, no edit/re-template step) — and the auth boundary is real on both REST and WS, which is more than the README admits. Lint and tests are green. So this isn't a non-functional toy; the plumbing largely works.

But the human-in-the-loop gate, which is the *only* reason a skeptic would tolerate an LLM holding a shell, is the least trustworthy surface in the system: the approval dialog shows me a naked command with **no rationale** (the context exists server-side and is simply never passed to the component), it fires on a stray **Enter**, it **hides** concurrent proposals, and the suite contains a **green test for a cleanup safeguard that isn't implemented** — which means I can't take the test suite at face value either. Add a one-click path to Full Auto (and an "Antigravity = Full Auto + skip-permissions" default), plaintext key persistence to a non-gitignored file, and a `0.0.0.0`-bound server that spawns a shell before anyone connects, and the residual risk is concentrated in exactly the places I'm not willing to hand-wave.

It "works" in the demo sense. It does not yet *fit* a security-conscious adoption decision. I'd revisit only after the HITL dialog faithfully shows rationale + all pending commands, the approve action stops defaulting to fire, the orphaned-approval cleanup actually exists (and the test stops lying about it), and key/secret persistence is locked down. Until then: not on my machine.
