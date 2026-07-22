/**
 * src/orbital/KitchenRadio.test.tsx — RTL component test for KitchenRadio
 *
 * Covers:
 * - Populated transcript feed: operator ("User") vs model ("Chef de Cuisine" / "Janus") distinct rendering,
 *   grounding info, and bubble save interaction.
 * - Empty / idle state: off-air vs on-air empty affordance text rendering.
 * - Radio controls & status chips: golive, stoplive, toggle mute, and status chip transitions.
 * - Call sheet overlay: opening call sheet and selecting voice calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KitchenRadio } from './KitchenRadio';
import type { TranscriptEntry } from './useOrbitalData';

afterEach(() => {
  cleanup();
});

function baseProps(overrides: Partial<Parameters<typeof KitchenRadio>[0]> = {}) {
  return {
    dark: false,
    live: false,
    muted: false,
    reconnecting: false,
    connected: false,
    micBlocked: false,
    audioPlaying: false,
    approvalWaiting: false,
    transcript: [] as TranscriptEntry[],
    voiceCues: false,
    stations: [] as { name: string }[],
    onGoLive: vi.fn(),
    onStopLive: vi.fn(),
    onToggleMute: vi.fn(),
    onCall: vi.fn(),
    onSaveBubble: vi.fn(),
    ...overrides,
  };
}

describe('KitchenRadio — empty and idle states', () => {
  it('renders off-air empty affordance when transcript is empty and radio is off-air', () => {
    render(<KitchenRadio {...baseProps({ live: false, transcript: [] })} />);
    expect(screen.getByTestId('kitchen-radio')).toBeInTheDocument();
    expect(screen.getByTestId('radio-transcript')).toHaveTextContent('tune in the radio to talk to the Chef de Cuisine');
  });

  it('renders on-air listening affordance when transcript is empty and radio is live', () => {
    render(<KitchenRadio {...baseProps({ live: true, connected: true, transcript: [] })} />);
    expect(screen.getByTestId('radio-transcript')).toHaveTextContent('listening for you, Chef…');
  });
});

describe('KitchenRadio — populated transcript feed', () => {
  it('renders operator and model entries as distinct visible text', () => {
    const transcript: TranscriptEntry[] = [
      { sender: 'User', text: 'Where is the inventory log?', timestamp: new Date('2026-07-21T10:00:00Z') },
      { sender: 'Janus', text: 'The inventory log is in /var/log/inventory.', timestamp: new Date('2026-07-21T10:00:05Z') },
    ];
    render(<KitchenRadio {...baseProps({ transcript })} />);

    const transcriptEl = screen.getByTestId('radio-transcript');
    expect(within(transcriptEl).getByText('Where is the inventory log?')).toBeInTheDocument();
    expect(within(transcriptEl).getByText('The inventory log is in /var/log/inventory.')).toBeInTheDocument();

    // Model entry has "Chef de Cuisine" label, operator entry does not
    expect(within(transcriptEl).getByText('Chef de Cuisine')).toBeInTheDocument();
  });

  it('renders grounded sources when transcript entry has grounding metadata', () => {
    const transcript: TranscriptEntry[] = [
      {
        sender: 'Janus',
        text: 'Checked line status.',
        timestamp: new Date('2026-07-21T10:00:00Z'),
        grounding: {
          queries: ['line status'],
          sources: [{ uri: 'https://docs.orbital.internal/line', title: 'Line Manual' }],
        },
      },
    ];
    render(<KitchenRadio {...baseProps({ transcript })} />);

    const groundingEl = screen.getByTestId('radio-grounding');
    expect(groundingEl).toBeInTheDocument();
    expect(within(groundingEl).getByText('Line Manual')).toBeInTheDocument();
    expect(within(groundingEl).getByText('Line Manual')).toHaveAttribute('href', 'https://docs.orbital.internal/line');
  });

  it('invokes onSaveBubble when save button on a transcript bubble is clicked', async () => {
    const user = userEvent.setup();
    const onSaveBubble = vi.fn();
    const transcript: TranscriptEntry[] = [
      { sender: 'Janus', text: 'Important note to save', timestamp: new Date('2026-07-21T10:00:00Z') },
    ];
    render(<KitchenRadio {...baseProps({ transcript, onSaveBubble })} />);

    const saveBtn = screen.getByTestId('radio-bubble-save');
    await user.click(saveBtn);
    expect(onSaveBubble).toHaveBeenCalledWith('Important note to save');
  });
});

describe('KitchenRadio — mic controls and live status', () => {
  it('renders Tune in button off-air and fires onGoLive on click', async () => {
    const user = userEvent.setup();
    const onGoLive = vi.fn();
    render(<KitchenRadio {...baseProps({ live: false, onGoLive })} />);

    const goLiveBtn = screen.getByTestId('radio-golive');
    expect(goLiveBtn).toHaveTextContent('Tune in the radio');
    await user.click(goLiveBtn);
    expect(onGoLive).toHaveBeenCalledTimes(1);
  });

  it('renders Sign off and Mute buttons while live and fires canonical callbacks', async () => {
    const user = userEvent.setup();
    const onStopLive = vi.fn();
    const onToggleMute = vi.fn();
    render(<KitchenRadio {...baseProps({ live: true, connected: true, muted: true, onStopLive, onToggleMute })} />);

    const muteBtn = screen.getByTestId('radio-mute');
    expect(muteBtn).toHaveTextContent('Mic off — tap to talk');
    await user.click(muteBtn);
    expect(onToggleMute).toHaveBeenCalledTimes(1);

    const stopLiveBtn = screen.getByTestId('radio-stoplive');
    expect(stopLiveBtn).toHaveTextContent('Sign off');
    await user.click(stopLiveBtn);
    expect(onStopLive).toHaveBeenCalledTimes(1);
  });

  it('reflects mic blocked state in status chip and mic button label', () => {
    render(<KitchenRadio {...baseProps({ live: true, connected: true, micBlocked: true })} />);

    const statusChip = screen.getByRole('status');
    expect(statusChip).toHaveTextContent('MIC BLOCKED');

    const muteBtn = screen.getByTestId('radio-mute');
    expect(muteBtn).toHaveTextContent("Mic's blocked — check browser permissions");
  });
});

describe('KitchenRadio — call sheet modal', () => {
  it('opens call sheet on clicking calls button and dispatches onCall when a call line is clicked', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    render(<KitchenRadio {...baseProps({ stations: [{ name: 'Prep' }], onCall })} />);

    const callsToggle = screen.getByTitle('What can I say?');
    await user.click(callsToggle);

    const callSheet = screen.getByTestId('radio-calls');
    expect(callSheet).toBeInTheDocument();
    expect(within(callSheet).getByText("What're my calls?")).toBeInTheDocument();

    const callBtns = screen.getAllByTestId('radio-call');
    expect(callBtns.length).toBeGreaterThan(0);
    await user.click(callBtns[0]);

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('radio-calls')).toBeNull();
  });
});
