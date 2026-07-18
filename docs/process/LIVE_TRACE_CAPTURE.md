# Raw Gemini Live trace capture — operator workflow

**Bead:** `wsm-e2e-pinned-arkr`. **Code:** `src/voice/liveTraceCapture.ts` (the tap),
`tests/helpers/traceReplay.ts` (the replay driver), `scripts/redact-trace.mjs` (the redaction tool).

## Why this exists

The interaction log (`.janus_interaction_log.jsonl`) only ever records what the server has already
*derived* from a Gemini Live message (`gemini_thinking`, `gemini_text`, …) — never the raw
`LiveServerMessage` envelope. That means production message-shape drift (fragment cadence,
`turnComplete` vs `generationComplete` timing, an unused flag Gemini adds tomorrow) is invisible to
tests until it causes a visible bug. This tap captures the raw envelope so a real incident can be
turned into a committed, replayable regression test.

## The workflow: capture → session → redact → review → commit

### 1. Capture

Set the flag before starting the dev server, then reproduce the behavior you want to capture:

```powershell
$env:JANUS_CAPTURE_LIVE_TRACES = "1"
npm run dev
```

Every voice WS connection made while the flag is set writes one file,
`.janus_traces/<voiceSessionId>.jsonl` (relative to the server's cwd) — one JSON line per inbound
Gemini Live message, in arrival order: `{"ts": <epoch ms>, "seq": <int>, "message": <raw envelope>}`.

- **Off by default.** No flag => no directory, no file, and the tap adds no cost beyond a single
  already-paid env lookup at connect time.
- **Fail-soft.** A write error (disk full, permissions) never breaks the voice session — worst case
  you silently lose the capture, never the call.
- `.janus_traces/` is in `.gitignore`. **A raw capture is UNREDACTED** — it can contain everything
  the operator said, everything the model said, and every tool-call argument (which can include
  pasted secrets if the operator dictated one). **Never `git add` anything under `.janus_traces/`
  directly.**

When you're done reproducing, unset the flag (or just stop the dev server) — `$env:JANUS_CAPTURE_LIVE_TRACES = $null`.

### 2. Redact

Run the redaction tool against the raw capture you want to turn into a fixture:

```powershell
node scripts/redact-trace.mjs .janus_traces/<voiceSessionId>.jsonl
```

This writes `<voiceSessionId>.redacted.jsonl` next to the raw file. It masks candidate secrets/PII
— emails, key-shaped strings (AWS/Google/GitHub/Slack tokens, JWTs, PEM blocks, generic
`key=value`-style credential assignments), and long digit runs (9+) — as `[REDACTED-<kind>]`,
**inside text (string) fields only**. Every non-string field (`ts`, `seq`, booleans, counts) and all
JSON structure/line cadence is left byte-identical, so the redacted file still replays exactly like
the original through `tests/helpers/traceReplay.ts`.

The rules are **heuristic, not exhaustive** — that's the entire reason step 3 is mandatory.

### 3. Review — MANDATORY, every time

The tool prints a review summary to stdout: every masked span (so you can sanity-check it caught
what it should have, and didn't over-redact something load-bearing to the test) **and** every text
field that matched nothing at all (so you can eyeball those too — a false negative is a silent leak,
and the rules will never catch everything). Read both lists before doing anything else.

If you find something the tool missed, hand-edit the `.redacted.jsonl` file directly (it's just
JSONL) before committing — never patch the masking rules under time pressure while a real secret is
sitting in a to-be-committed file; fix the rule in a follow-up with its own tests instead.

### 4. Commit

Commit **only** the `*.redacted.jsonl` file, normally into `tests/fixtures/traces/` alongside a
short provenance note (see `tests/fixtures/traces/README.md` for the format — what incident it's
from, which fields if any were hand-edited after the tool ran). **Never commit anything from
`.janus_traces/` itself.**

## Replaying a committed trace in a test

```ts
import { loadTrace, replayTrace, replayTraceFile } from "./helpers/traceReplay";

// one-shot:
await replayTraceFile(liveSession, "tests/fixtures/traces/my-incident.jsonl");

// or load once, inspect, then replay:
const entries = loadTrace("tests/fixtures/traces/my-incident.jsonl");
await replayTrace(liveSession, entries);
```

`liveSession` is a `MockLiveSession` from `tests/helpers/mockLive.ts` (`installMockLive()` +
`running._testActiveLiveSession!()`), exactly like `tests/helpers/convoScript.ts`'s harness. Each
`message` in the trace is emitted through the session's real `.emit()`, so it runs through the
server's genuine `onmessage` dispatcher — the same code path production traffic takes, not a
reinterpretation of it.

See `tests/test_trace_replay.ts` for a full worked example, including the tap round-trip pattern
(capture a synthetic session with the flag on, then replay the captured file and assert identical
downstream behavior).
