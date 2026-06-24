# Operator direct-typing into the xterm pane (`pane_input`)

**Date:** 2026-06-24 · **Status:** shipped · **Branch:** `feat/pane-direct-typing`

## BLUF

The operator can now type keystrokes straight into a focused xterm pane; they stream to the live
backend PTY. Previously the pane was display-only (output + an allowlisted control-key button strip),
so the only way to send free text was the voice channel or the Order Pad. This adds the missing input
edge as a deliberately **ungated, operator-direct** write — the human at the keyboard is above the
capability gate, exactly like clicking "Send to the line" on the Order Pad.

## The path (keyboard → PTY)

```
xterm.onData(bytes)                         src/components/TerminalView.tsx  (onInput prop)
  → buildPaneInputFrame(paneId, bytes)      src/orbital/paneInputClient.ts   (pins the wire shape)
  → ws.send({type:"pane_input", paneId, data})   over the observe/voice socket (same socket as draft_edit)
  → applyPaneInputFrame(msg, manager, coreState)  src/voice/paneInputFrame.ts (dispatch in src/voice/index.ts)
  → term.writeRaw(data)                     src/terminal.ts:1140  (verbatim, single transport.write)
  → real PTY → stdout → xterm display
```

`writeRaw` (not `writeInput`) is the correct primitive: it writes the bytes in one `transport.write`
with **no appended `\r`** (xterm already sends Enter as a `\r` inside `data`) and **no optimistic
"Running" status kick** (a keystroke stream must not be misread as the start of a command run).

## The central decision: intentionally ungated

Operator keystrokes bypass the capability gate — no gate, no `isKnownRawKey` allowlist, no approval,
no log. Rationale: **the gate exists to mediate the model's autonomous writes, not the human's hands.**
A human typing into a pane they have focused is direct control of their own terminal; gating it would
be both pointless (they can always `/restart` or close the pane) and hostile (a prompt per keystroke).

### Honest peer comparison

The right analogue is **not** `draft_edit` (which writes inert text to a DB draft row, executed later
*through* the gate). It is the **raw-input REST route** (`POST /api/terminals/:id/raw-input`) — the
*other* `writeRaw` surface. Relative to that route we made one deliberate relaxation and kept its two
safety scopings:

| | raw-input route | `pane_input` | rationale |
|---|---|---|---|
| `isKnownRawKey` allowlist | **enforced** (11 control keys; blocks arbitrary shell lines) | **dropped** | arbitrary printable input *is* the feature; an allowlist defeats it |
| WS / request auth | route auth | **observe/voice socket auth** (cookie ≠ `API_AUTH_TOKEN` ⇒ close 4001; httpOnly + SameSite=strict) | only the authenticated operator's own browser can send a frame — no cross-origin/unauth PTY write |
| single-active-pane guard (`isPaneActiveForWrite`) | **enforced** | **enforced** | keystrokes may only reach the ONE pane the operator has open; a stale/raced/hand-crafted off-target frame is dropped |

Dropping the allowlist is the conscious bit: it reopens the "arbitrary bytes to the PTY" that the
allowlist (bead ym3) closed on the REST route — accepted here because it is scoped to *the
authenticated operator, on their own active pane*, which is the whole point of the feature.

## Deliberately NOT done (with rationale)

- **No allowlist** — see above; would defeat free typing.
- **No STOP-ALL freeze block** — the operator stays above the gate (consistent with the always-allowed
  Ctrl+C brake): you must be able to type a recovery command after hitting stop. Flagged as a follow-up
  bead if it should ever change.
- **No typing-mode indicator** — pane focus is the only mode signal.

## Known caveat

Bytes typed in the brief ConPTY spawn window (transport set, child stdin reader not yet attached) go
straight through `writeRaw` and may be **dropped** — they are *not* buffered like `writeInput`'s
`pendingInput` queue (that queue flushes via `deliverSubmit`, which appends a CR and would mangle raw
bytes). In practice the operator sees the shell prompt before typing, so the window is tiny. Documented,
not buffered; a follow-up bead tracks it.

## Testing

- **Unit** `tests/test_pane_input.ts` — `applyPaneInputFrame`: verbatim write, activePaneId fallback,
  single-active-pane guard (off-target dropped), unknown/dead pane no-op, empty/non-string no-op, and a
  module-level gate-absence assertion. `tests/test_pane_input_client.ts` — `buildPaneInputFrame` pins
  the `type`/`paneId`/`data` wire field names the server reads (a typo there would otherwise only
  surface in the live e2e).
- **Live e2e** `e2e/live_pane_typing.spec.ts` (live lane only — no backend in the mock lane, and
  `pane_input` has no REST fallback) — boots a real server + bash PTY, focuses the xterm, types a
  uniquely-seeded `echo`, and asserts the marker round-trips back into the terminal.

## Files

`src/components/TerminalView.tsx` (onInput edge), `src/orbital/TerminalWindow.tsx` + `src/App.tsx`
(frame send at both `<TerminalView>` sites), `src/orbital/paneInputClient.ts` (new, client frame
builder), `src/voice/paneInputFrame.ts` (new, server helper) + `src/voice/index.ts` (dispatch at both
socket handlers), `tests/test_pane_input.ts` + `tests/test_pane_input_client.ts` + `e2e/live_pane_typing.spec.ts`.
