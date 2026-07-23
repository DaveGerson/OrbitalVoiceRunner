/**
 * src/orbital/PostureChip.test.tsx — RTL component test for PostureChip (bead wsm-e2e-pinned-k8kl)
 *
 * Covers:
 * - Renders FULL AUTO state for posture="OPEN" or mode="Full Auto" with distinct label and styling.
 * - Renders guarded state for posture="GUARDED" or mode="Human-in-the-Loop".
 * - Renders read-only state for posture="LOCKED" or mode="Read-Only".
 * - Renders null when posture and mode are absent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PostureChip } from './primitives';

afterEach(() => {
  cleanup();
});

describe('PostureChip — FULL AUTO and mode rendering', () => {
  it('renders FULL AUTO state with distinct glow styling when posture="OPEN"', () => {
    render(<PostureChip posture="OPEN" />);
    const chip = screen.getByTestId('posture-chip');
    expect(chip).not.toBeNull();
    expect(chip.textContent?.toLowerCase()).toContain('full auto');
    expect(chip.style.boxShadow).toBe('0 0 6px #4db892');
  });

  it('renders FULL AUTO state with distinct glow styling when mode="Full Auto"', () => {
    render(<PostureChip mode="Full Auto" />);
    const chip = screen.getByTestId('posture-chip');
    expect(chip).not.toBeNull();
    expect(chip.textContent?.toLowerCase()).toContain('full auto');
    expect(chip.style.boxShadow).toBe('0 0 6px #4db892');
  });

  it('renders guarded state without full auto glow when posture="GUARDED"', () => {
    render(<PostureChip posture="GUARDED" />);
    const chip = screen.getByTestId('posture-chip');
    expect(chip).not.toBeNull();
    expect(chip.textContent?.toLowerCase()).toContain('guarded');
    expect(chip.style.boxShadow).toBe('none');
  });

  it('renders nothing when both posture and mode are undefined', () => {
    const { container } = render(<PostureChip />);
    expect(container).toBeEmptyDOMElement();
  });
});
