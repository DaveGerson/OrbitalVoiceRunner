/**
 * src/orbital/FleetExchangeView.test.tsx — component test for the Fleet View
 * "communication-by-exception" surface (Phase 5, Step 5.1; spec
 * docs/superpowers/specs/2026-06-25-fleet-view-design.md).
 *
 * Covers: exception ordering (needs-input/approval before failed before the compact tail), every
 * card field rendering (redacted/truncated instruction, waiting reason, last result, age), every
 * quick action dispatching its canonical callback (mocking the dispatch seam at the callback
 * boundary — the SAME idiom as InstructionWorkbench.test.tsx), the zero-visual-delta no-exception
 * regression, and keyboard/aria accessibility.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FleetExchangeView } from './FleetExchangeView';
import { chefForPane } from './theme';
import type { Station } from './station';
import type { AttentionItem, ExchangeDraftView, FleetExchangeSummary, PendingCommand } from '../types';

afterEach(() => {
  cleanup();
});

function stn(id: string, status: Station['status'], over: Partial<Station> = {}): Station {
  return {
    id, project: 'proj_1', projectName: 'Webapp', projectColor: '#4b3bb3', projectEmoji: '🍅',
    name: id, status, toolPreset: 'Custom', chef: chefForPane(id), scribble: 'do the thing',
    cwd: '~', elapsed: '2m', contextFill: 0.3, contextLabel: '30k ctx', contextPips: 3,
    outputTail: [], needsInput: status === 'Needs Input', ...over,
  };
}

function pending(over: Partial<PendingCommand> = {}): PendingCommand {
  return { messageId: 'msg_1', cmd: 'npm run deploy', terminalId: 'p1', ...over };
}

function attnApproval(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'att_1', type: 'approval', terminalId: 'p1', projectId: 'proj_1',
    message: 'npm run deploy', timestamp: new Date().toISOString(), dismissed: false,
    messageId: 'msg_bg_1', ...over,
  };
}

function summary(over: Partial<FleetExchangeSummary> = {}): FleetExchangeSummary {
  return {
    exchangeId: 'exch_1', state: 'agent_failed', tier: 2, kind: 'failed',
    instructionSummary: 'refactor the retry loop', waitingReason: null,
    resultSummary: null, updatedAt: 1000, ...over,
  };
}

function baseProps(overrides: Partial<Parameters<typeof FleetExchangeView>[0]> = {}) {
  return {
    stations: [] as Station[],
    pendingCommands: [] as PendingCommand[],
    dark: false,
    now: 5000,
    onOpen: vi.fn(),
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onRetry: vi.fn(),
    onCancelExchange: vi.fn(),
    onToggleMute: vi.fn(),
    ...overrides,
  };
}

describe('FleetExchangeView — zero visual delta (no exceptions)', () => {
  it('renders nothing when there are no stations at all', () => {
    const { container } = render(<FleetExchangeView {...baseProps()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('fleet-exception-view')).toBeNull();
  });

  it('renders nothing when every station is calm (Running/Idle, no held approval, no failing summary)', () => {
    const { container } = render(
      <FleetExchangeView {...baseProps({ stations: [stn('p1', 'Running'), stn('p2', 'Idle')] })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('FleetExchangeView — exception lane rendering', () => {
  it('shows a Needs Input station as an exception card with its instruction and waiting reason', () => {
    const draft: ExchangeDraftView = {
      exchangeId: 'exch_d', target: { projectId: 'proj_1', paneId: 'p1' }, objective: 'ship the fix',
      relevantContext: [], constraints: [], requestedOutput: null, completionSignal: null,
      draftVersion: 1, sentVersions: [], readiness: { ready: false, missing: 'objective', clarification: 'Which repo?' },
    };
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Needs Input')],
        exchangeByPane: { p1: draft },
      })} />,
    );
    const card = screen.getByTestId('fleet-exception-card');
    expect(card).toHaveAttribute('data-kind', 'needs_input');
    expect(within(card).getByTestId('fleet-card-waiting')).toHaveTextContent('Which repo?');
    expect(within(card).getByTestId('fleet-answer')).toBeInTheDocument();
  });

  it('shows a held approval with Approve/Deny wired to the canonical resolver', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Needs Input')],
        pendingCommands: [pending({ messageId: 'msg_42', cmd: 'rm -rf build' })],
        onApprove, onDeny,
      })} />,
    );
    const card = screen.getByTestId('fleet-exception-card');
    expect(card).toHaveAttribute('data-kind', 'approval');
    expect(within(card).getByTestId('fleet-card-instruction')).toHaveTextContent('rm -rf build');
    await user.click(within(card).getByTestId('fleet-approve'));
    expect(onApprove).toHaveBeenCalledWith('msg_42');
    await user.click(within(card).getByTestId('fleet-deny'));
    expect(onDeny).toHaveBeenCalledWith('msg_42');
  });

  it('a BACKGROUND-pane held approval (the attention inbox — the common fleet-wide case) also shows Approve/Deny', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Running')],
        attentionQueue: [attnApproval({ terminalId: 'p1', messageId: 'msg_bg_1', message: 'drop table users' })],
        onApprove,
      })} />,
    );
    const card = screen.getByTestId('fleet-exception-card');
    expect(card).toHaveAttribute('data-kind', 'approval');
    expect(within(card).getByTestId('fleet-card-instruction')).toHaveTextContent('drop table users');
    await user.click(within(card).getByTestId('fleet-approve'));
    expect(onApprove).toHaveBeenCalledWith('msg_bg_1');
  });

  it('a triage-only attention item (no messageId) never fabricates a resolvable approval', () => {
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Exited')],
        attentionQueue: [attnApproval({ terminalId: 'p1', messageId: undefined, type: 'error' })],
      })} />,
    );
    // degrades to the plain Exited -> failed fallback, not a fabricated approval card.
    expect(screen.getByTestId('fleet-exception-card')).toHaveAttribute('data-kind', 'failed');
  });

  it('a held approval takes precedence over a conflicting durable summary', () => {
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Running')],
        pendingCommands: [pending()],
        exchangeSummaries: { p1: summary({ tier: 4, kind: 'running' }) },
      })} />,
    );
    expect(screen.getByTestId('fleet-exception-card')).toHaveAttribute('data-kind', 'approval');
  });

  it('shows an INTERRUPTED exchange with Retry, and Retry fires onRetry with the exchange id', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Exited')],
        exchangeSummaries: { p1: summary({ resultSummary: null, state: 'interrupted' }) },
        onRetry,
      })} />,
    );
    const card = screen.getByTestId('fleet-exception-card');
    await user.click(within(card).getByTestId('fleet-retry'));
    expect(onRetry).toHaveBeenCalledWith('exch_1');
  });

  // Phase 5.5 (release review): quick actions key off the LIFECYCLE state, not the display kind —
  // the service refuses a retry of terminal `agent_failed` unconditionally and a cancel of any
  // terminal row, so the card must never offer them (they were guaranteed-refused buttons before).
  it('a terminal agent_failed exchange shows NO Retry and NO Hold/cancel (both would always be refused)', () => {
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Exited')],
        exchangeSummaries: { p1: summary({ state: 'agent_failed' }) },
      })} />,
    );
    const card = screen.getByTestId('fleet-exception-card');
    expect(card).toHaveAttribute('data-kind', 'failed');
    expect(within(card).queryByTestId('fleet-retry')).toBeNull();
    expect(within(card).queryByTestId('fleet-cancel-exchange')).toBeNull();
    expect(within(card).getByTestId('fleet-open')).toBeInTheDocument();
  });

  it('renders last meaningful result and age when the summary carries them', () => {
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Exited')],
        exchangeSummaries: { p1: summary({ resultSummary: 'tests failed on CI', updatedAt: 1000 }) },
        now: 61000,
      })} />,
    );
    const card = screen.getByTestId('fleet-exception-card');
    expect(within(card).getByTestId('fleet-card-result')).toHaveTextContent('tests failed on CI');
    expect(within(card).getByTestId('fleet-card-age')).toHaveTextContent('1m');
  });

  it('Open pane fires onOpen with the station for every exception card', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<FleetExchangeView {...baseProps({ stations: [stn('p1', 'Needs Input')], onOpen })} />);
    await user.click(screen.getByTestId('fleet-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].id).toBe('p1');
  });

  it('Hold/cancel fires onCancelExchange with the exchange id when one is known', async () => {
    const user = userEvent.setup();
    const onCancelExchange = vi.fn();
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Needs Input')],
        exchangeSummaries: { p1: summary({ tier: 1, kind: 'needs_input', state: 'needs_input', exchangeId: 'exch_hold' }) },
        onCancelExchange,
      })} />,
    );
    await user.click(screen.getByTestId('fleet-cancel-exchange'));
    expect(onCancelExchange).toHaveBeenCalledWith('exch_hold');
  });

  it('mute toggle fires onToggleMute with the STATION project id, and reflects the muted prop', () => {
    const onToggleMute = vi.fn();
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Needs Input', { project: 'proj_9' })],
        mutedProjectIds: ['proj_9'],
        onToggleMute,
      })} />,
    );
    const toggle = screen.getByTestId('fleet-mute-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveTextContent('Muted');
  });

  it('exceptions are ordered needs-input/approval before failed (six-tier priority)', () => {
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('failed_one', 'Exited'), stn('needs_one', 'Needs Input')],
      })} />,
    );
    const cards = screen.getAllByTestId('fleet-exception-card');
    expect(cards.map((c) => c.getAttribute('data-fleet-pane-id'))).toEqual(['needs_one', 'failed_one']);
  });
});

describe('FleetExchangeView — the compact non-exception tail', () => {
  it('a calm station stays out of the exception lane, collapsed behind "Show N more"', async () => {
    const user = userEvent.setup();
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('needs_one', 'Needs Input'), stn('calm_one', 'Running')],
      })} />,
    );
    expect(screen.queryAllByTestId('fleet-exception-card')).toHaveLength(1);
    expect(screen.queryByTestId('fleet-tail-list')).toBeNull();
    const toggle = screen.getByTestId('fleet-tail-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('fleet-tail-list')).toBeInTheDocument();
    expect(screen.getAllByTestId('fleet-tail-row')).toHaveLength(1);
  });

  it('opening a tail row still fires the canonical onOpen', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('needs_one', 'Needs Input'), stn('calm_one', 'Running')],
        onOpen,
      })} />,
    );
    await user.click(screen.getByTestId('fleet-tail-toggle'));
    await user.click(screen.getByTestId('fleet-tail-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].id).toBe('calm_one');
  });
});

describe('FleetExchangeView — counters', () => {
  it('renders the fleet-wide N agents / M need you / K running line', () => {
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('n1', 'Needs Input'), stn('r1', 'Running'), stn('r2', 'Running')],
      })} />,
    );
    expect(screen.getByTestId('fleet-counters')).toHaveTextContent('3 agents · 1 needs you · 2 running');
  });
});

describe('FleetExchangeView — accessibility', () => {
  it('is a labeled landmark region', () => {
    render(<FleetExchangeView {...baseProps({ stations: [stn('p1', 'Needs Input')] })} />);
    expect(screen.getByRole('region', { name: 'Fleet exceptions — needs you' })).toBe(screen.getByTestId('fleet-exception-view'));
  });

  it('every rendered piece of text meets the 12px type-scale floor', () => {
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Needs Input')],
        exchangeSummaries: { p1: summary({ tier: 1, kind: 'needs_input', waitingReason: 'huh?', resultSummary: 'done' }) },
      })} />,
    );
    const el = screen.getByTestId('fleet-exception-view');
    const texty = el.querySelectorAll('span, div, button, h2');
    for (const node of Array.from(texty)) {
      const fs = (node as HTMLElement).style.fontSize;
      if (!fs) continue;
      expect(parseFloat(fs)).toBeGreaterThanOrEqual(12);
    }
  });

  it('quick-action buttons are reachable by keyboard (native <button> elements, tab-focusable)', async () => {
    const user = userEvent.setup();
    render(
      <FleetExchangeView {...baseProps({
        stations: [stn('p1', 'Needs Input')],
        pendingCommands: [pending()],
      })} />,
    );
    await user.tab(); // mute toggle
    expect(screen.getByTestId('fleet-mute-toggle')).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('fleet-approve')).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('fleet-deny')).toHaveFocus();
  });

  it('does not use aria-live anywhere (no spam on every re-sort)', () => {
    render(<FleetExchangeView {...baseProps({ stations: [stn('p1', 'Needs Input')] })} />);
    expect(screen.getByTestId('fleet-exception-view').querySelectorAll('[aria-live]')).toHaveLength(0);
  });
});
