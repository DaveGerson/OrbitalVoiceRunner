/**
 * src/orbital/CaptionBar.test.tsx — RTL component test for CaptionBar (bead wsm-e2e-pinned-a4uw)
 *
 * Covers:
 * - Off-air and disabled states: returns null when radio is off-air or captions are toggled off.
 * - Empty / idle state: persistently mounts caption-bar and empty caption-janus aria-live region when live.
 * - Populated caption text: renders latest User utterance (non-announced) and latest Janus line (aria-live="polite").
 * - Toast double-announce guard: sets aria-live="off" when Janus entry was minted from a toast.
 * - Pure selector unit test for captionTail.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CaptionBar, captionTail } from './CaptionBar';
import type { TranscriptEntry } from './useOrbitalData';

afterEach(() => {
  cleanup();
});

function baseProps(overrides: Partial<Parameters<typeof CaptionBar>[0]> = {}) {
  return {
    transcript: [] as TranscriptEntry[],
    live: true,
    captionsOn: true,
    dark: false,
    ...overrides,
  };
}

describe('CaptionBar — off-air and disabled states', () => {
  it('renders nothing when radio channel is off-air (live: false)', () => {
    const { container } = render(<CaptionBar {...baseProps({ live: false })} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('caption-bar')).toBeNull();
  });

  it('renders nothing when captions are toggled off (captionsOn: false)', () => {
    const { container } = render(<CaptionBar {...baseProps({ captionsOn: false })} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('caption-bar')).toBeNull();
  });
});

describe('CaptionBar — empty and idle state', () => {
  it('renders empty caption bar with pre-mounted empty Janus live region when transcript is empty', () => {
    render(<CaptionBar {...baseProps({ transcript: [] })} />);
    expect(screen.getByTestId('caption-bar')).toBeInTheDocument();
    
    const janusEl = screen.getByTestId('caption-janus');
    expect(janusEl).toBeInTheDocument();
    expect(janusEl).toHaveTextContent('');
    expect(janusEl).toHaveAttribute('aria-live', 'polite');

    expect(screen.queryByTestId('caption-user')).toBeNull();
  });
});

describe('CaptionBar — populated caption rendering', () => {
  it('renders visible populated user and janus text from transcript', () => {
    const transcript: TranscriptEntry[] = [
      { sender: 'User', text: 'Run tests on station prep.', timestamp: new Date('2026-07-21T10:00:00Z') },
      { sender: 'Janus', text: 'Running tests on prep station now.', timestamp: new Date('2026-07-21T10:00:02Z') },
    ];
    render(<CaptionBar {...baseProps({ transcript })} />);

    expect(screen.getByTestId('caption-user')).toHaveTextContent('Run tests on station prep.');
    expect(screen.getByTestId('caption-janus')).toHaveTextContent('Running tests on prep station now.');
  });

  it('sets aria-live="off" on Janus caption when entry was minted from a toast (double-announce guard)', () => {
    const transcript: TranscriptEntry[] = [
      { sender: 'Janus', text: 'Back on the air.', timestamp: new Date('2026-07-21T10:00:00Z'), fromToast: true },
    ];
    render(<CaptionBar {...baseProps({ transcript })} />);

    const janusEl = screen.getByTestId('caption-janus');
    expect(janusEl).toHaveTextContent('Back on the air.');
    expect(janusEl).toHaveAttribute('aria-live', 'off');
  });
});

describe('captionTail pure selector', () => {
  it('returns nulls for empty transcript', () => {
    expect(captionTail([])).toEqual({ janus: null, user: null, janusFromToast: false });
  });

  it('extracts the latest Janus and User entries from transcript tail', () => {
    const transcript: TranscriptEntry[] = [
      { sender: 'User', text: 'First user message', timestamp: new Date(1) },
      { sender: 'Janus', text: 'First janus response', timestamp: new Date(2) },
      { sender: 'User', text: 'Latest user message', timestamp: new Date(3) },
      { sender: 'Janus', text: 'Latest janus response', timestamp: new Date(4), fromToast: true },
    ];
    expect(captionTail(transcript)).toEqual({
      janus: 'Latest janus response',
      user: 'Latest user message',
      janusFromToast: true,
    });
  });
});
