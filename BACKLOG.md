# Backlog

Aspirational user journeys that require **new capability** before they can be
genuinely supported. Tracked here so the core, already-working journeys in
[`docs/USER_JOURNEYS.md`](docs/USER_JOURNEYS.md) get priority first.

Each item notes the journey and the missing capability that blocks it.

## Aspirational journeys

### Proactive monitoring — "tell me when a pane finishes / breaks"
Janus alerts you, unprompted, when a long-running job completes or fails.
- **Blocked on:** server→client *spoken* completion/failure alerts. Today the
  server only emits `stdout_chunk` / `terminals_updated`, and status is only
  surfaced when the operator asks (`list_panes`). There is no push path that
  turns a pane state change into a proactive voice notification.
- **Status:** not started.

### Proactive failure triage
When something errors, Janus volunteers which pane failed and why, rather than
waiting to be asked.
- **Blocked on:** the proactive monitoring capability above (it builds on the
  same push/alert mechanism).
- **Status:** not started.

### Read a document shared on screen
Dictate or refine a spec while referencing a document visible on screen (the
"…or a document shared on the screen" half of the dictation journey).
- **Blocked on:** a screen/vision input modality — e.g. Gemini Live video or
  screen capture. Current input is audio only.
- **Status:** not started.

### Walk through non-terminal on-screen content
Perform a live walk-through of an arbitrary on-screen artifact (not terminal
output) and capture every change that needs to be made.
- **Blocked on:** the same screen/vision input modality as above.
- **Status:** not started.

## Deprioritized (supported today, parked)

Journeys the tool can already do but that are not headline journeys for now.

### Locked-down exploration
Browse an unfamiliar or untrusted repository in Read-Only — observe and ask
questions with zero write risk.
- **Blocked on:** nothing; Read-Only mode already supports this. Parked to keep
  the primary journey set focused.
- **Status:** supported, deprioritized.
