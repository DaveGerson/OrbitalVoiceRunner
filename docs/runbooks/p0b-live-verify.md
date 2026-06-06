# P0b live-verify runbook

**Purpose:** Confirm pane-switch memory synthesis and silent fallback in a *real* Gemini Live voice
session. This is the one residual manual step that cannot be automated — it requires a live mic,
a real Gemini Live WebRTC connection, and a human observer.

Everything else is covered by the automated harness in
`tests/test_memory_live_verify.ts` (run with `npx tsx --test tests/test_memory_live_verify.ts`).

---

## Pre-flight

- Node 20+, a Python 3.x interpreter on PATH, and a valid `GEMINI_API_KEY` in the environment.
- Run the automated harness first. All three tests (A1/A2/A3) must pass (or skip cleanly on A1 if
  Python is absent). Do not proceed manually if A3 fails — that indicates a regression in the
  fallback path.

```
npx tsx --test tests/test_memory_live_verify.ts
```

---

## Step 1 — start the server

```
npm start
```

Wait until the console prints `Janus server listening on :3000` (or your configured port).

Confirm the health endpoint shows the synthesizer state:

```
curl http://localhost:3000/api/health
```

Expected (python available):

```json
{ "status": "ok", "memory": { "synthesizer": "python" }, ... }
```

Expected (python absent / fallback):

```json
{ "status": "ok", "memory": { "synthesizer": "fallback" }, ... }
```

**Pass criterion:** the `memory.synthesizer` field is present. Note its current value.

---

## Step 2 — open two panes

In the Janus UI:

1. Open **Pane A** — e.g. a bash shell.  Give it a recognizable name such as `shell-1`.
2. Open **Pane B** — e.g. a second bash shell or a Claude agent pane.  Name it `shell-2`.
3. Run at least one command in each pane so the WorldModel has recent activity.
4. Leave **Pane A** as the active (focused) pane.

---

## Step 3 — start a Gemini Live voice session

1. Click **Start Voice** (or press the configured PTT / hands-free toggle).
2. Wait for the session status indicator to show `LIVE`.
3. Say any short phrase to confirm the session is receiving audio (e.g. "Janus, status check").
4. Observe the Janus UI: a memory note (the synthesized brief) should appear in the notes panel
   for **Pane A** (the currently active pane).

**Pass criterion 1:** a single memory note appears and its content references `shell-1` / Pane A.

---

## Step 4 — switch the active pane mid-session

While the Gemini Live session is still open:

1. Click **Pane B** to make it the active pane.
2. Wait 1-2 seconds.
3. Observe: a fresh memory note should appear for **Pane B** (`shell-2`).
4. The note from Step 3 (Pane A) must NOT reappear — the latest-wins guard (I3) discards stale
   briefs computed before the switch.

**Pass criterion 2:** exactly one new note for Pane B appears; no duplicate Pane A note is
injected after the switch.

---

## Step 5 — verify the health endpoint again

```
curl http://localhost:3000/api/health
```

If the Python daemon is running, `memory.synthesizer` must still be `"python"`.

**Pass criterion 3:** `memory.synthesizer` matches the value observed in Step 1.

---

## Step 6 — test the silent fallback path

1. Open **Settings** in the Janus UI (gear icon or `/settings`).
2. Locate **Memory** > **Python synthesizer** (toggle labeled `memoryPythonEnabled` or similar).
3. **Disable** it and save.
4. Switch the active pane back to **Pane A**.
5. Wait 1-2 seconds.

**Pass criterion 4:** a memory note still appears for Pane A — the in-process fallback synthesizer
is producing briefs silently. No error toast, no missing note.

Re-check health:

```
curl http://localhost:3000/api/health
```

**Pass criterion 5:** `memory.synthesizer` is now `"fallback"`.

---

## Pass / fail checklist

| # | Criterion | Pass | Fail |
|---|-----------|------|------|
| 1 | `/api/health` shows `memory.synthesizer` field on start | | |
| 2 | Memory note appears for Pane A after first voice interaction | | |
| 3 | Switching to Pane B produces a fresh note for Pane B | | |
| 4 | No stale Pane A note reinjected after pane switch | | |
| 5 | `memory.synthesizer` still `"python"` after pane switch (when Python available) | | |
| 6 | Note still appears for Pane A after disabling `memoryPythonEnabled` (fallback) | | |
| 7 | `memory.synthesizer` is `"fallback"` after disabling Python synthesizer | | |

All seven criteria must be marked **Pass** to declare P0b verified in a live session.

---

## Notes

- If the Python daemon is not on PATH, criteria 1/2/3/5 switch to the fallback variants — that is
  still a valid verification of the fallback path, but Python synthesis itself remains unverified.
- The automated harness (`test_memory_live_verify.ts`) covers A1 (real daemon round-trip), A2
  (latest-wins predicate), and A3 (silent fallback) without a mic or live session. This runbook
  covers only the residual human observation step.
