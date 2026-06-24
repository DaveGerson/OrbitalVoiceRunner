/**
 * EmergencyStop — RTL component test of the two-stage STOP-ALL state machine (bead dbt4, PR-B).
 *
 * This is the harness proof: it exercises the REAL interaction flow (Stage-1 freeze trigger,
 * the frozen banner's running-count copy, the hold-to-fire kill that only fires after the full
 * HOLD_MS, early-release cancellation, and the clean release) — not "renders without crashing".
 * It also proves jsdom + RTL + jest-dom matchers + the rAF/AudioContext/matchMedia shims work.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {EmergencyStop} from './EmergencyStop';

const HOLD_MS = 1000; // mirrors the component's hold-to-fire duration.

function makeHandlers() {
  return {onFreeze: vi.fn(), onKill: vi.fn(), onRelease: vi.fn()};
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('EmergencyStop — Stage 1 (not frozen)', () => {
  it('shows the Stop Everything trigger and freezes on click', async () => {
    const h = makeHandlers();
    const user = userEvent.setup();
    render(<EmergencyStop frozen={false} runningCount={3} {...h} />);

    const trigger = screen.getByTestId('stop-all-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent(/stop everything/i);
    // The frozen banner must NOT be present in Stage 1.
    expect(screen.queryByTestId('frozen-banner')).not.toBeInTheDocument();

    await user.click(trigger);
    expect(h.onFreeze).toHaveBeenCalledTimes(1);
    expect(h.onKill).not.toHaveBeenCalled();
  });
});

describe('EmergencyStop — frozen banner', () => {
  it('renders the running-count copy and both affordances when panes remain', () => {
    const h = makeHandlers();
    render(<EmergencyStop frozen runningCount={2} {...h} />);

    expect(screen.getByTestId('frozen-banner')).toBeInTheDocument();
    // Plural running-count copy.
    expect(screen.getByText(/2 panes are still running/i)).toBeInTheDocument();
    // Both the kill and release affordances exist.
    expect(screen.getByTestId('stop-all-kill')).toBeInTheDocument();
    expect(screen.getByTestId('stop-all-release')).toBeInTheDocument();
    expect(screen.getByTestId('stop-all-kill')).toHaveTextContent(/hold to kill 2 panes/i);
  });

  it('uses singular copy and hides the kill button when no panes remain', () => {
    const h = makeHandlers();
    render(<EmergencyStop frozen runningCount={0} {...h} />);

    expect(screen.getByText(/no panes are still running/i)).toBeInTheDocument();
    // Nothing to kill -> the irreversible button is absent; release is still offered.
    expect(screen.queryByTestId('stop-all-kill')).not.toBeInTheDocument();
    expect(screen.getByTestId('stop-all-release')).toBeInTheDocument();
  });

  it('clears the freeze via Release without killing anything', async () => {
    const h = makeHandlers();
    const user = userEvent.setup();
    render(<EmergencyStop frozen runningCount={1} {...h} />);

    await user.click(screen.getByTestId('stop-all-release'));
    expect(h.onRelease).toHaveBeenCalledTimes(1);
    expect(h.onKill).not.toHaveBeenCalled();
  });
});

describe('EmergencyStop — hold-to-fire kill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('fires onKill only after the full hold completes', () => {
    const h = makeHandlers();
    render(<EmergencyStop frozen runningCount={4} {...h} />);
    const kill = screen.getByTestId('stop-all-kill');

    fireEvent.mouseDown(kill);
    // Partway through the hold: not yet fired.
    vi.advanceTimersByTime(HOLD_MS / 2);
    expect(h.onKill).not.toHaveBeenCalled();

    // Past the full hold window: the irreversible kill fires exactly once.
    vi.advanceTimersByTime(HOLD_MS);
    expect(h.onKill).toHaveBeenCalledTimes(1);
  });

  it('cancels the kill when released before the hold completes', () => {
    const h = makeHandlers();
    render(<EmergencyStop frozen runningCount={4} {...h} />);
    const kill = screen.getByTestId('stop-all-kill');

    fireEvent.mouseDown(kill);
    vi.advanceTimersByTime(HOLD_MS / 2);
    fireEvent.mouseUp(kill); // release early -> cancel
    vi.advanceTimersByTime(HOLD_MS * 2);

    expect(h.onKill).not.toHaveBeenCalled();
  });

  it('cancels the kill when the pointer leaves before completion', () => {
    const h = makeHandlers();
    render(<EmergencyStop frozen runningCount={4} {...h} />);
    const kill = screen.getByTestId('stop-all-kill');

    fireEvent.mouseDown(kill);
    vi.advanceTimersByTime(HOLD_MS / 2);
    fireEvent.mouseLeave(kill); // pointer leaves -> cancel
    vi.advanceTimersByTime(HOLD_MS * 2);

    expect(h.onKill).not.toHaveBeenCalled();
  });
});
