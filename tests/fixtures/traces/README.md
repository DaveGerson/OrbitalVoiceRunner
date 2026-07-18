# Raw Gemini Live trace fixtures — bead wsm-e2e-pinned-arkr

Committed replay traces for `tests/helpers/traceReplay.ts`, in the raw `{ts, seq, message}` capture
format `src/voice/liveTraceCapture.ts` writes (see `docs/process/LIVE_TRACE_CAPTURE.md` for the
operator capture workflow that produces these in the field).

## `incident-2026-07-16-chunked-thought.jsonl`

**Provenance:** this is NOT a new capture and contains NO new PII. It is a hand-reconstructed raw
envelope for the incident already documented — and already committed — in
`tests/test_voice_thought_buffer.ts` (bead `wsm-e2e-pinned-zmu5`) and `tests/test_convo_scenarios.ts`
(`scenarioCoalesce`): interaction `ixn_mro7cpfy_9`, 2026-07-16 20:31, where Gemini Live's
`serverContent.outputTranscription` streamed ONE spoken thought as 10 word-fragment messages, which
(pre-fix) fanned out into 10 separate draft bullets instead of coalescing into one. The 10 fragment
strings are copied VERBATIM from the `fragments` constant those two test files already carry; this
fixture just wraps them in the RAW envelope shape (`serverContent.outputTranscription.text` per
fragment, then a `serverContent.turnComplete` message) instead of the derived/summarized form those
tests assert against. `ts`/`seq` values are synthetic (a plausible streaming cadence), not the real
capture's timestamps — the real incident predates this capture tap's existence, so there is no raw
capture file it could have been extracted from verbatim.

Nothing in this file was copied from a live `.janus_interaction_log.jsonl` or a real
`.janus_traces/` capture — only from already-committed test source.

## Format

One JSON object per line: `{"ts": <epoch ms>, "seq": <int>, "message": <raw LiveServerMessage>}` —
exactly what `createLiveTraceWriter` (`src/voice/liveTraceCapture.ts`) appends per inbound message.
`tests/helpers/traceReplay.ts` reads these back and replays `message` through a `MockLiveSession`,
in order.
