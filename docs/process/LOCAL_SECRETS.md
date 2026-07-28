# Local secrets — Windows Credential Manager, not `.env`

**TL;DR:** on Windows, put `GEMINI_API_KEY` in the **Credential Manager** and load it with a
gitignored wrapper under `scripts/local/`. Do not put it in `.env`.

## Why not `.env`

`.gitignore` already covers `.env*`, so a key there will not be committed by accident. But
gitignored is not the same as safe:

- **Plaintext at rest.** Any process running as you can read it — including anything you `npm
  install`. A postinstall script that greps for `.env` is a real, repeatedly-observed attack.
- **It survives.** Backups, sync clients, and editor "recently opened" indexes all pick it up.
- **`git add -f` defeats it,** as does a future `.gitignore` edit that narrows the pattern.

Credential Manager stores the secret under **DPAPI, encrypted to your Windows account**. It is
never on disk in plaintext, never on a command line (so never visible in the process table), and
never in shell history when entered via the GUI.

This also matches how the server already treats the key at runtime: **in memory only**. There is
deliberately no `geminiApiKey` field persisted to `.janus_settings.json` — a `.env` would be a
strictly weaker posture than what the running system already commits to.

## Setup (once)

Store the key. Either the CLI:

```powershell
cmdkey /generic:JanusGeminiApiKey /user:gemini /pass:<your AI Studio key>
```

…or, to keep it out of shell history entirely, the GUI:
**Control Panel → Credential Manager → Windows Credentials → Add a generic credential**

| Field | Value |
|---|---|
| Internet or network address | `JanusGeminiApiKey` |
| User name | `gemini` |
| Password | *your AI Studio key* |

## Use

`scripts/local/` is gitignored, so these two files live only on your machine:

| File | Role |
|---|---|
| `get-credential.ps1` | P/Invokes `advapi32!CredReadW`, writes one secret to stdout. Exits 1 and prints nothing on stdout when the credential is absent (fail-closed). |
| `with-secrets.mjs` | Reads the configured secrets, injects them into a child process's environment, and execs your command. Logs **names only**, never values. |

```powershell
node scripts/local/with-secrets.mjs npm run verify:live-voice
node scripts/local/with-secrets.mjs npm run smoke:voice-synth
```

An already-exported `GEMINI_API_KEY` wins over the vault, so a one-off override needs no vault
edit. Rotate by re-running `cmdkey` (it overwrites); revoke with `cmdkey /delete:JanusGeminiApiKey`.

> **Implementation note.** `Windows.Security.Credentials.PasswordVault` (WinRT) is *not* usable
> from Windows PowerShell 5.1 — the type fails to project. Use the `advapi32` P/Invoke path;
> `CRED_TYPE_GENERIC` (`1`) is what `cmdkey /generic:` and the GUI write.

## Recreating the loader

Because `scripts/local/` is gitignored, a fresh clone will not have it. That is intentional — the
loader is machine-specific and there is nothing to review or share. It contains **no secret**, only
retrieval logic, so if it ever becomes useful to more than one person it can be promoted to a
committed script without any security change; it is kept local today purely to keep the repo's
secret-handling surface as small as possible.

## Rule

**Never** echo a secret into the terminal, a log, a commit message, a PR body, or an AI assistant
transcript — not even a prefix or a length. Pass it by reference (credential name), never by value.
