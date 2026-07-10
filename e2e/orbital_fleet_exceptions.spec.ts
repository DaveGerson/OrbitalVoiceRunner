import { expect, test, type Page } from "@playwright/test";
import { armE2EWire, injectApprovalPendingFrame, MOCK_TERMINAL_ID, MOCK_TERMINAL_ID_2 } from "./fixtures";

// Phase 5, Step 5.1 — Fleet View "communication-by-exception" (spec
// docs/superpowers/specs/2026-06-25-fleet-view-design.md). The kitchen's default landing is
// already the All-Projects/Fleet scope (resolveStartProject -> "all"), so FleetExchangeView is
// live on every ordinary gotoKitchen() call — these specs pin it directly, no extra navigation.
//
// Mirrors the established idiom: gotoKitchen (?ui=kitchen&mock=1, armE2EWire), then drive REAL
// frames through window.__ORBITAL_E2E__.injectWsFrame (the same dispatch the live socket uses).
// Approvals are seeded via `injectApprovalPendingFrame` targeting the BACKGROUND pane
// (MOCK_TERMINAL_ID_2 — MOCK_TERMINAL_ID/mock_pane_1 is the harness's default ACTIVE pane), which
// routes to the attention inbox rather than popping the blocking ApprovalDialog modal (bead 8xn) —
// the common fleet-wide case, since the fleet spans every project and most panes are not "active".
// `injectFleetSummary` seeds the additive `fleet_exchange_summary_updated` frame (the e2e-test
// seam documented in useOrbitalData.ts's handleObserveFrame — the real server never sends it;
// fleetExchangeSummaries is otherwise fetch-refreshed).

async function gotoKitchen(page: Page): Promise<void> {
  await armE2EWire(page);
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
}

async function injectFleetSummary(
  page: Page,
  summaries: Record<string, {
    exchangeId: string; state: string; tier: number; kind: string;
    instructionSummary: string | null; waitingReason: string | null; resultSummary: string | null; updatedAt: number;
  }>,
): Promise<void> {
  await page.evaluate(
    (s) => window.__ORBITAL_E2E__?.injectWsFrame({ type: "fleet_exchange_summary_updated", summaries: s }),
    summaries,
  );
}

async function injectProactiveNotification(page: Page, terminalId: string, message: string): Promise<void> {
  await page.evaluate(
    ([t, m]) => window.__ORBITAL_E2E__?.injectWsFrame({ type: "proactive_notification", terminalId: t, message: m, severity: "normal" }),
    [terminalId, message] as const,
  );
}

test.describe("Orbital Kitchen — Fleet View exceptions (Phase 5.1)", () => {
  test("zero visual delta: a calm fleet (both seeded panes Running, no exchange data) shows no exception lane", async ({ page }) => {
    await gotoKitchen(page);
    await expect(page.getByTestId("fleet-exception-view")).toHaveCount(0);
    // the rest of the board is byte-identical to today (still both station cards, unmodified).
    await expect(page.getByTestId("station-card")).toHaveCount(2);
  });

  test("a background pane's held approval surfaces as a fleet exception card, and Approve resolves it through the canonical resolver", async ({ page }) => {
    await gotoKitchen(page);
    await injectApprovalPendingFrame(page, "npm run deploy", MOCK_TERMINAL_ID_2, "msg_fleet_1");
    // The modal never pops (this pane isn't active) — only the fleet card + attention inbox.
    await expect(page.getByTestId("approval-dialog")).toHaveCount(0);
    await expect(page.getByTestId("fleet-exception-view")).toBeVisible();
    const card = page.getByTestId("fleet-exception-card");
    await expect(card).toHaveAttribute("data-kind", "approval");
    await expect(card).toContainText("npm run deploy");
    await card.getByTestId("fleet-approve").click();
    await expect(page.getByTestId("toast")).toContainText("Order up");
    // resolved — the fleet is calm again.
    await expect(page.getByTestId("fleet-exception-view")).toHaveCount(0);
  });

  test("Deny holds the command back", async ({ page }) => {
    await gotoKitchen(page);
    await injectApprovalPendingFrame(page, "drop table users", MOCK_TERMINAL_ID_2, "msg_fleet_2");
    await page.getByTestId("fleet-deny").click();
    await expect(page.getByTestId("toast")).toContainText("86'd it");
  });

  test("a needs-input exchange summary (no held approval) offers Answer, which opens/focuses the pane", async ({ page }) => {
    await gotoKitchen(page);
    await injectFleetSummary(page, {
      [MOCK_TERMINAL_ID_2]: {
        exchangeId: "exch_q1", state: "needs_input", tier: 1, kind: "needs_input",
        instructionSummary: "run the migration", waitingReason: "Which environment?", resultSummary: null,
        updatedAt: Date.now(),
      },
    });
    const card = page.getByTestId("fleet-exception-card");
    await expect(card).toHaveAttribute("data-kind", "needs_input");
    await expect(card.getByTestId("fleet-card-waiting")).toContainText("Which environment?");
    await card.getByTestId("fleet-answer").click();
    // Answer routes through the SAME jump-to-pane the board's own cards use — the STATION card
    // (not the fleet card, which also carries a pane-id-scoped attribute) shows the active badge.
    await expect(page.locator(`[data-testid="station-card"][data-pane-id="${MOCK_TERMINAL_ID_2}"]`)).toContainText("active");
  });

  test("a failed exchange offers Retry, which honestly cannot confirm the outcome in this harness", async ({ page }) => {
    await gotoKitchen(page);
    await injectFleetSummary(page, {
      [MOCK_TERMINAL_ID]: {
        exchangeId: "exch_fail1", state: "agent_failed", tier: 2, kind: "failed",
        instructionSummary: "deploy the release", waitingReason: null, resultSummary: null,
        updatedAt: Date.now(),
      },
    });
    const card = page.getByTestId("fleet-exception-card");
    await expect(card).toHaveAttribute("data-kind", "failed");
    await card.getByTestId("fleet-retry").click();
    // NEVER a false "done" — mock mode has no real spine to confirm against.
    await expect(page.getByTestId("toast")).toContainText("can't confirm");
  });

  test("Hold/cancel dismisses a live exchange", async ({ page }) => {
    await gotoKitchen(page);
    await injectFleetSummary(page, {
      [MOCK_TERMINAL_ID]: {
        exchangeId: "exch_c1", state: "agent_failed", tier: 2, kind: "failed",
        instructionSummary: null, waitingReason: null, resultSummary: null, updatedAt: Date.now(),
      },
    });
    await page.getByTestId("fleet-cancel-exchange").click();
    await expect(page.getByTestId("toast")).toContainText("Held it back");
  });

  test("a finished exchange surfaces its last meaningful result, non-exception (compact tail)", async ({ page }) => {
    await gotoKitchen(page);
    // Pair a genuine exception (so the view mounts) with a calm completed exchange on the OTHER pane.
    await injectFleetSummary(page, {
      [MOCK_TERMINAL_ID]: {
        exchangeId: "exch_need", state: "needs_input", tier: 1, kind: "needs_input",
        instructionSummary: "confirm the plan", waitingReason: "proceed?", resultSummary: null, updatedAt: Date.now(),
      },
      [MOCK_TERMINAL_ID_2]: {
        exchangeId: "exch_done", state: "agent_complete", tier: 3, kind: "complete",
        instructionSummary: null, waitingReason: null, resultSummary: "tests green, PR opened", updatedAt: Date.now(),
      },
    });
    await expect(page.getByTestId("fleet-exception-card")).toHaveCount(1); // only the needs-input one
    await page.getByTestId("fleet-tail-toggle").click();
    await expect(page.getByTestId("fleet-tail-row")).toContainText("tests green, PR opened");
  });

  test("muting a project silences its proactive announcements; un-muting restores them", async ({ page }) => {
    await gotoKitchen(page);
    // Unmuted: a proactive notification for the project reaches the toast.
    await injectProactiveNotification(page, MOCK_TERMINAL_ID, "First announcement");
    await expect(page.getByTestId("toast")).toContainText("First announcement");

    // Seed an exception so the mute control is on screen, then mute the project.
    await injectApprovalPendingFrame(page, "npm run deploy", MOCK_TERMINAL_ID_2, "msg_fleet_mute");
    const muteToggle = page.getByTestId("fleet-mute-toggle").first();
    await muteToggle.click();
    await expect(muteToggle).toHaveAttribute("aria-pressed", "true");

    // Muted: a FRESH notification for the same project never reaches the toast.
    await injectProactiveNotification(page, MOCK_TERMINAL_ID, "Second announcement should be muted");
    await page.waitForTimeout(300);
    await expect(page.getByTestId("toast")).not.toContainText("Second announcement should be muted");

    // Un-mute: the very next announcement is heard again.
    await muteToggle.click();
    await expect(muteToggle).toHaveAttribute("aria-pressed", "false");
    await injectProactiveNotification(page, MOCK_TERMINAL_ID, "Third announcement after unmute");
    await expect(page.getByTestId("toast")).toContainText("Third announcement after unmute");
  });
});
