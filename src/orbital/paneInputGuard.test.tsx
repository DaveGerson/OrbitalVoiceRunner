/**
 * src/orbital/paneInputGuard.test.tsx — component test for the `TerminalView onInput=` send guard
 * (bead wsm-e2e-pinned-vs7).
 *
 * The guard — `if (isMock && !wireArmed) return; if (ws?.readyState !== OPEN) return;` — lives
 * inline at BOTH real call sites (App.tsx's live pane and TerminalWindow.tsx's kitchen burner) and
 * was previously untested: the mock e2e lane has no observe socket, and the live lane always runs
 * with isMock=false, so neither branch was ever exercised by any existing test.
 * `buildPaneInputFrame` is unit-pinned for frame shape (tests/test_pane_input_client.ts), but the
 * guard that decides WHETHER to call it at all was not.
 *
 * Per the bead, the guard closure was extracted into a pure, testable predicate —
 * `shouldSendPaneInput` (src/orbital/paneInputClient.ts) — used verbatim at both call sites. This
 * test mounts a tiny React component whose onInput handler is the EXACT wiring copied from those
 * call sites (predicate + buildPaneInputFrame + ws.send), so it pins the real production guard
 * behavior rather than a reimplementation of it, with a ws.send spy standing in for the socket.
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {useRef} from 'react';
import {buildPaneInputFrame, shouldSendPaneInput} from './paneInputClient';

afterEach(() => {
  cleanup();
});

interface FakeSocket {
  readyState: number;
  send: (payload: string) => void;
}

function makeSocket(readyState: number): FakeSocket {
  return {readyState, send: vi.fn()};
}

/**
 * Mirrors the onInput wiring at both real call sites verbatim: a button press stands in for the
 * xterm `onData` callback firing with `data`.
 */
function PaneInputProbe({
  isMock,
  wireArmed,
  ws,
  paneId = 'pane-1',
  data = 'ls\r',
}: {
  isMock: boolean;
  wireArmed: boolean;
  ws: FakeSocket | null;
  paneId?: string;
  data?: string;
}) {
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const onInput = (d: string) => {
    const socket = wsRef.current;
    if (!shouldSendPaneInput(isMock, wireArmed, socket)) return;
    socket!.send(JSON.stringify(buildPaneInputFrame(paneId, d)));
  };
  return (
    <button data-testid="type" onClick={() => onInput(data)}>
      type
    </button>
  );
}

const OPEN = 1;
const CLOSED = 3;

describe('pane_input send guard — mock-mode branch', () => {
  it('suppresses the send under plain mock mode (e2e wire NOT armed), even with an OPEN socket', async () => {
    const user = userEvent.setup();
    const ws = makeSocket(OPEN);
    render(<PaneInputProbe isMock wireArmed={false} ws={ws} />);

    await user.click(screen.getByTestId('type'));

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends when mock mode is on but the e2e wire IS armed (Playwright needs real frames)', async () => {
    const user = userEvent.setup();
    const ws = makeSocket(OPEN);
    render(<PaneInputProbe isMock wireArmed ws={ws} paneId="mock_pane_1" data={"echo hi\r"} />);

    await user.click(screen.getByTestId('type'));

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual({
      type: 'pane_input',
      paneId: 'mock_pane_1',
      data: 'echo hi\r',
    });
  });
});

describe('pane_input send guard — socket-not-OPEN branch', () => {
  it('suppresses the send when the socket is CLOSED, even live and wire-armed', async () => {
    const user = userEvent.setup();
    const ws = makeSocket(CLOSED);
    render(<PaneInputProbe isMock={false} wireArmed ws={ws} />);

    await user.click(screen.getByTestId('type'));

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('suppresses the send when there is no socket at all', async () => {
    const user = userEvent.setup();
    render(<PaneInputProbe isMock={false} wireArmed ws={null} />);

    // FALSIFIABLE null-socket pin: jsdom reports an event-handler throw via the window `error`
    // event (user.click still RESOLVES), so `resolves.not.toThrow()` could never fail here. If
    // shouldSendPaneInput regressed to return true for a null socket, the handler's `socket!.send`
    // throws a TypeError and this spy catches it. (The predicate's null branch is also pinned
    // directly in tests/test_pane_input_client.ts.)
    const onWindowError = vi.fn();
    window.addEventListener('error', onWindowError);
    try {
      await user.click(screen.getByTestId('type'));
    } finally {
      window.removeEventListener('error', onWindowError);
    }
    expect(onWindowError).not.toHaveBeenCalled();
  });
});

describe('pane_input send guard — positive control', () => {
  it('live (isMock=false) with an OPEN socket sends the exact pane_input frame', async () => {
    const user = userEvent.setup();
    const ws = makeSocket(OPEN);
    render(<PaneInputProbe isMock={false} wireArmed={false} ws={ws} paneId="pane-7" data={"echo hi\r"} />);

    await user.click(screen.getByTestId('type'));

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual({
      type: 'pane_input',
      paneId: 'pane-7',
      data: 'echo hi\r',
    });
  });
});
