/**
 * DaemonStateBadge — RTL component tests (inc2 A-1a).
 *
 * Verifies:
 *   • the badge renders when state === "fallback" (the degraded path operators need to see)
 *   • the badge is absent when state === "python" (normal operation — no visual noise)
 *   • the badge is absent when state === null (not yet received)
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DaemonStateBadge } from "./DaemonStateBadge";

afterEach(() => {
  cleanup();
});

describe("DaemonStateBadge — fallback state", () => {
  it('renders the badge when state is "fallback"', () => {
    render(<DaemonStateBadge state="fallback" />);
    const badge = screen.getByTestId("daemon-state-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/approver fallback/i);
  });

  it("renders the amber indicator dot inside the badge", () => {
    render(<DaemonStateBadge state="fallback" />);
    expect(screen.getByTestId("daemon-state-badge-dot")).toBeInTheDocument();
  });
});

describe('DaemonStateBadge — python state (normal operation)', () => {
  it('is hidden when state is "python"', () => {
    render(<DaemonStateBadge state="python" />);
    expect(screen.queryByTestId("daemon-state-badge")).not.toBeInTheDocument();
  });
});

describe("DaemonStateBadge — null state (not yet received)", () => {
  it("is hidden when state is null", () => {
    render(<DaemonStateBadge state={null} />);
    expect(screen.queryByTestId("daemon-state-badge")).not.toBeInTheDocument();
  });
});
