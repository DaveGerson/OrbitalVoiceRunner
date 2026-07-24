/**
 * BUG-037 (a) — ApprovalDialog accessibility. The staged-write approval modal
 * (src/components/ApprovalDialog.tsx) ships with ZERO ARIA: the root div (:196) carries only a
 * data-testid, the heading (:204) and command <p> (:208) are unlabelled, and the command text is
 * not in a live region. A screen-reader user gets no announcement that a command is awaiting their
 * approval — the exact audience an eyes-off approval flow exists for.
 *
 * REQUIRED POST-FIX BEHAVIOR pinned here:
 *   - root: role="alertdialog" + aria-modal="true"
 *   - aria-labelledby -> the heading ("Proposed Command Execution")
 *   - aria-describedby -> the command <p> (the actual command text)
 *   - the command text lives in an aria-live="assertive" region
 *
 * Harness: vitest + jsdom + RTL (src/**\/*.test.tsx lane; setup in vitest.setup.ts), matching
 * src/components/EmergencyStop.test.tsx.
 *
 * Runner: npx vitest run --config vitest.config.ts src/components/ApprovalDialog.a11y.test.tsx
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ApprovalDialog } from "./ApprovalDialog";

const CMD = "rm -rf build/artifacts";

function renderDialog() {
  return render(
    <ApprovalDialog
      messageId="m_a11y"
      terminalId="pane_a11y"
      cmd={CMD}
      onApprove={vi.fn()}
      onReject={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("BUG-037 (a) — ApprovalDialog ARIA semantics", () => {
  it("exposes the modal as role=alertdialog with aria-modal=true", () => {
    renderDialog();
    const dialog = screen.queryByRole("alertdialog");
    // RED: today the root div has no role, so queryByRole('alertdialog') returns null.
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("labels the dialog by its heading via aria-labelledby", () => {
    renderDialog();
    const dialog = screen.queryByRole("alertdialog");
    expect(dialog).toBeInTheDocument();
    const labelId = dialog?.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const label = labelId ? document.getElementById(labelId) : null;
    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent(/proposed command execution/i);
  });

  it("describes the dialog by the command text via aria-describedby", () => {
    renderDialog();
    const dialog = screen.queryByRole("alertdialog");
    expect(dialog).toBeInTheDocument();
    const descId = dialog?.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    const desc = descId ? document.getElementById(descId) : null;
    expect(desc).toBeInTheDocument();
    expect(desc).toHaveTextContent(CMD);
  });

  it("announces the command through an aria-live=assertive region", () => {
    const { container } = renderDialog();
    const live = container.querySelector('[aria-live="assertive"]');
    // RED: today no element carries aria-live, so this query returns null.
    expect(live).not.toBeNull();
    expect(live).toHaveTextContent(CMD);
  });
});
