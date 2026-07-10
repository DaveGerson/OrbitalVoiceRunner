/**
 * src/orbital/InstructionWorkbench.test.tsx — component test for the Instruction Workbench panel
 * (Phase 3, Step 3.3; spec docs/superpowers/specs/2026-07-09-instruction-routing.md §5).
 *
 * Covers: full draft-state rendering (target/objective/constraints/requested output/completion
 * signal/readiness/approval/version), the three real controls (revise/cancel/send) firing the exact
 * callback the caller passes in (the SAME canonical action path TerminalWindow wires — this test
 * mocks the dispatch seam at the callback boundary, matching the repo's existing component-test
 * idiom in src/orbital/paneInputGuard.test.tsx), the stale-approval indicator, the zero-visual-delta
 * no-exchange regression, and keyboard accessibility (tab order + aria).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstructionWorkbench, ExchangeStateChip, approvalChipSkin, targetLabel } from './InstructionWorkbench';
import type { ExchangeDraftView } from '../types';

afterEach(() => {
  cleanup();
});

function makeExchange(overrides: Partial<ExchangeDraftView> = {}): ExchangeDraftView {
  return {
    exchangeId: 'exch_1',
    target: { projectId: 'proj_1', paneId: 'pane_1' },
    objective: 'Fix the retry bug in the webhook handler',
    relevantContext: ['the last deploy regressed this'],
    constraints: ['keep the public API unchanged'],
    requestedOutput: 'a one-paragraph summary',
    completionSignal: 'say DONE when the tests are green',
    draftVersion: 1,
    sentVersions: [],
    readiness: { ready: true },
    ...overrides,
  };
}

describe('InstructionWorkbench — no-exchange regression (zero visual delta)', () => {
  it('renders nothing when exchange is null', () => {
    const { container } = render(
      <InstructionWorkbench exchange={null} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('instruction-workbench')).toBeNull();
  });
});

describe('InstructionWorkbench — draft state rendering', () => {
  it('shows target, objective, context, constraints, requested output, completion signal, and version', () => {
    render(
      <InstructionWorkbench exchange={makeExchange()} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />,
    );
    expect(screen.getByTestId('instruction-workbench')).toBeInTheDocument();
    expect(screen.getByTestId('exchange-target')).toHaveTextContent('pane_1 (proj_1)');
    expect(screen.getByTestId('exchange-objective')).toHaveTextContent('Fix the retry bug in the webhook handler');
    expect(screen.getByTestId('exchange-context')).toHaveTextContent('the last deploy regressed this');
    expect(screen.getByTestId('exchange-constraints')).toHaveTextContent('keep the public API unchanged');
    expect(screen.getByTestId('exchange-requested-output')).toHaveTextContent('a one-paragraph summary');
    expect(screen.getByTestId('exchange-completion-signal')).toHaveTextContent('say DONE when the tests are green');
    expect(screen.getByTestId('exchange-version')).toHaveTextContent('v1');
  });

  it('omits optional field rows entirely when the operator never stated them', () => {
    render(
      <InstructionWorkbench
        exchange={makeExchange({ relevantContext: [], constraints: [], requestedOutput: null, completionSignal: null })}
        dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('exchange-context')).toBeNull();
    expect(screen.queryByTestId('exchange-constraints')).toBeNull();
    expect(screen.queryByTestId('exchange-requested-output')).toBeNull();
    expect(screen.queryByTestId('exchange-completion-signal')).toBeNull();
  });

  it('honestly names the missing target when unresolved, and gates Send', () => {
    render(
      <InstructionWorkbench
        exchange={makeExchange({ target: null, readiness: { ready: false, missing: 'target', clarification: 'Which pane should this go to?' } })}
        dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()}
      />,
    );
    expect(screen.getByTestId('exchange-target')).toHaveTextContent('no pane targeted yet');
    expect(screen.getByTestId('exchange-readiness')).toHaveTextContent('Not ready — Which pane should this go to?');
    expect(screen.getByTestId('exchange-send')).toBeDisabled();
  });
});

describe('InstructionWorkbench — approval / stale-approval state', () => {
  it("'not sent' when the draft has never been delivered", () => {
    render(<InstructionWorkbench exchange={makeExchange({ draftVersion: 1, sentVersions: [] })} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByTestId('exchange-approval-chip')).toHaveTextContent('not sent');
    expect(screen.getByTestId('exchange-approval-chip')).toHaveAttribute('data-approval-state', 'none');
  });

  it("'delivered' when the current draft_version matches the last delivered version", () => {
    render(<InstructionWorkbench exchange={makeExchange({ draftVersion: 2, sentVersions: [1, 2] })} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByTestId('exchange-approval-chip')).toHaveTextContent('delivered');
    expect(screen.getByTestId('exchange-approval-chip')).toHaveAttribute('data-approval-state', 'sent');
  });

  it("'revised since delivery' (stale) when draft_version has moved past the last delivered version", () => {
    render(<InstructionWorkbench exchange={makeExchange({ draftVersion: 3, sentVersions: [1] })} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByTestId('exchange-approval-chip')).toHaveTextContent('revised since delivery');
    expect(screen.getByTestId('exchange-approval-chip')).toHaveAttribute('data-approval-state', 'stale');
  });

  it('an optimisticDeliveredVersion (REST Workbench-lane send ack) covers the delivered/stale states honestly', () => {
    const { rerender } = render(
      <InstructionWorkbench exchange={makeExchange({ draftVersion: 1, sentVersions: [] })} optimisticDeliveredVersion={1} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />,
    );
    expect(screen.getByTestId('exchange-approval-chip')).toHaveAttribute('data-approval-state', 'sent');
    rerender(
      <InstructionWorkbench exchange={makeExchange({ draftVersion: 2, sentVersions: [] })} optimisticDeliveredVersion={1} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />,
    );
    expect(screen.getByTestId('exchange-approval-chip')).toHaveAttribute('data-approval-state', 'stale');
  });
});

describe('InstructionWorkbench — controls fire the canonical actions', () => {
  it('Revise calls onRevise (focuses the existing composer — no network call of its own)', async () => {
    const user = userEvent.setup();
    const onRevise = vi.fn();
    render(<InstructionWorkbench exchange={makeExchange()} dark={false} onRevise={onRevise} onCancel={vi.fn()} onSend={vi.fn()} />);
    await user.click(screen.getByTestId('exchange-revise'));
    expect(onRevise).toHaveBeenCalledTimes(1);
  });

  it('Cancel calls onCancel (the SAME clear-the-draft effect the existing Scrap control fires)', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<InstructionWorkbench exchange={makeExchange()} dark={false} onRevise={vi.fn()} onCancel={onCancel} onSend={vi.fn()} />);
    await user.click(screen.getByTestId('exchange-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Send calls onSend (the SAME POST …/draft/send effect the Order Pad Send button fires) when ready', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<InstructionWorkbench exchange={makeExchange()} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={onSend} />);
    await user.click(screen.getByTestId('exchange-send'));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('Send is disabled (never fires onSend) while the draft is not ready', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <InstructionWorkbench
        exchange={makeExchange({ readiness: { ready: false, missing: 'objective', clarification: 'What should I ask it to do?' } })}
        dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={onSend}
      />,
    );
    await user.click(screen.getByTestId('exchange-send'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Retarget is an honest, non-mutating, keyboard-focusable affordance (no fake network effect)', async () => {
    const user = userEvent.setup();
    render(<InstructionWorkbench exchange={makeExchange()} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />);
    const retarget = screen.getByTestId('exchange-retarget');
    expect(retarget).toHaveAttribute('aria-disabled', 'true');
    retarget.focus();
    expect(retarget).toHaveFocus();
    await user.keyboard('{Enter}');
    // No assertion of any dispatched effect exists to make here — the point of this control is
    // that it does NOT silently claim to do something it can't (see the file's header comment).
  });
});

describe('InstructionWorkbench — keyboard accessibility', () => {
  it('tabs through Revise → Retarget → Cancel → Send in document order', async () => {
    const user = userEvent.setup();
    render(<InstructionWorkbench exchange={makeExchange()} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />);
    await user.tab();
    expect(screen.getByTestId('exchange-revise')).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('exchange-retarget')).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('exchange-cancel')).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('exchange-send')).toHaveFocus();
  });

  it('names the controls group and exposes a live readiness status region', () => {
    render(<InstructionWorkbench exchange={makeExchange()} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Instruction draft controls' })).toBeInTheDocument();
    const status = screen.getByTestId('exchange-readiness');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status')).toBe(status);
  });

  it('the panel itself is a labeled landmark (a <section> with aria-label is an ARIA "region")', () => {
    render(<InstructionWorkbench exchange={makeExchange()} dark={false} onRevise={vi.fn()} onCancel={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Instruction draft' })).toBe(screen.getByTestId('instruction-workbench'));
  });
});

describe('ExchangeStateChip — the compact pane-card indicator', () => {
  it('renders nothing for a null/undefined exchange', () => {
    const { container: c1 } = render(<ExchangeStateChip exchange={null} />);
    expect(c1).toBeEmptyDOMElement();
    cleanup();
    const { container: c2 } = render(<ExchangeStateChip exchange={undefined} />);
    expect(c2).toBeEmptyDOMElement();
  });

  it('shows the state chip and, when not ready, the waiting reason', () => {
    render(<ExchangeStateChip exchange={makeExchange({ readiness: { ready: false, missing: 'objective', clarification: 'What should I ask it to do?' } })} />);
    expect(screen.getByTestId('exchange-card-chip')).toHaveTextContent('not sent');
    expect(screen.getByTestId('exchange-card-waiting')).toHaveTextContent('What should I ask it to do?');
  });

  it('shows no waiting reason once ready', () => {
    render(<ExchangeStateChip exchange={makeExchange({ draftVersion: 1, sentVersions: [1] })} />);
    expect(screen.getByTestId('exchange-card-chip')).toHaveTextContent('delivered');
    expect(screen.queryByTestId('exchange-card-waiting')).toBeNull();
  });
});

describe('pure helpers', () => {
  it('approvalChipSkin covers all three states with distinct labels', () => {
    expect(approvalChipSkin('none').label).toBe('not sent');
    expect(approvalChipSkin('sent').label).toBe('delivered');
    expect(approvalChipSkin('stale').label).toBe('revised since delivery');
  });

  it('targetLabel names the pane, or honestly says none is targeted yet', () => {
    expect(targetLabel({ projectId: 'proj_1', paneId: 'pane_1' })).toBe('pane_1 (proj_1)');
    expect(targetLabel(null)).toBe('no pane targeted yet');
  });
});
