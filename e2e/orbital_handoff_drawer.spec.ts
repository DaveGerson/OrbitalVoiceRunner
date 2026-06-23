import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// j4e1 — the handoff LINE DRAWER (operator decision D1: a per-station drawer on The Line, NOT a Pass
// card). The compose/revise/stage/deliver/reject lifecycle is server-tested but had ZERO UI; this
// drawer FOREGROUNDS the three hero actions (deliver / revise / reject) for handoffs bound to a
// station (to_pane).
//
// DATA SEAM: the drawer's live spine is the `handoffs_updated` observe-lane frame. The harness is
// client-only (no real WS under ?mock=1), so we drive it through window.__ORBITAL_E2E__.injectWsFrame
// — the SAME reducer the live socket uses (useOrbitalData.handleObserveFrame → handoffsFromFrame →
// normalizeHandoffRows). The frame carries the full (cv2-shaped) rows.
//
// REST TWINS: the deliver/revise/reject buttons fire the canonical cv2 handoff REST twins,
// registry-derived from src/actions/defs/handoff.ts (read_handoff = GET /api/handoffs/:handoff_id, so
// the lifecycle twins are POST /api/handoffs/:id/<verb>). This spec MOCKS those twins (page.route) per
// the cross-branch contract: the convergence cv2 branch ships the server twins; this branch ships the
// UI + asserts the wire. The two must be integrated together.

const HANDOFF_ID = "ho_test_1";

/** Seed a staged handoff TO mock_pane_2 ("Python Backend") via the real observe-lane reducer. */
async function seedHandoff(page: Page, over: Record<string, unknown> = {}) {
  await page.evaluate(([id, extra]) => {
    window.__ORBITAL_E2E__?.injectWsFrame({
      type: "handoffs_updated",
      handoffs: [{
        id, workspace_id: "mock_project", from_pane: "mock_pane_1", to_pane: "mock_pane_2",
        kind: "agent_instruction", composed_prompt: "Run the auth test suite and report failures",
        source_context: "{}", source_context_refs: "[]", state: "staged", gate_approval_id: null,
        approved_by: null, approved_via: null, revision_count: 0, created_at: 1, staged_at: 2,
        delivered_at: null, consumed_at: null, terminal_at: null, expires_at: null, ...(extra as object),
      }],
    });
  }, [HANDOFF_ID, over] as const);
}

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await expect(page.getByTestId("station-card")).toHaveCount(2);
}

/** The drawer lives inside the to_pane station card; open it. */
async function openDrawerOn(page: Page, paneId: string) {
  const card = page.locator(`[data-pane-id="${paneId}"]`);
  await card.getByTestId("handoff-drawer-toggle").click();
  await expect(card.getByTestId("handoff-drawer-body")).toBeVisible();
  return card;
}

test.describe("Orbital Kitchen — the handoff line drawer", () => {
  test("a handoff surfaces ONLY on its target station's drawer", async ({ page }) => {
    await gotoKitchen(page);
    await seedHandoff(page);
    // the drawer toggle appears on the to_pane (mock_pane_2) card …
    await expect(page.locator('[data-pane-id="mock_pane_2"]').getByTestId("handoff-drawer-toggle")).toBeVisible();
    // … and NOT on the unrelated station (mock_pane_1)
    await expect(page.locator('[data-pane-id="mock_pane_1"]').getByTestId("handoff-drawer-toggle")).toHaveCount(0);
  });

  test("the drawer shows from→to, the status chip, and the composed-prompt summary", async ({ page }) => {
    await gotoKitchen(page);
    await seedHandoff(page);
    const card = await openDrawerOn(page, "mock_pane_2");
    await expect(card.getByTestId("handoff-row")).toContainText("mock_pane_1 → mock_pane_2");
    await expect(card.getByTestId("handoff-status")).toHaveAttribute("data-state", "staged");
    await expect(card.getByTestId("handoff-status")).toContainText("Staged");
    await expect(card.getByTestId("handoff-summary")).toContainText("Run the auth test suite");
  });

  test("Deliver fires POST /api/handoffs/:id/deliver", async ({ page }) => {
    let delivered: string | null = null;
    await page.route(/\/api\/handoffs\/.+\/deliver$/, (route) => {
      delivered = route.request().url();
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"Delivered."}' });
    });
    await gotoKitchen(page);
    await seedHandoff(page);
    const card = await openDrawerOn(page, "mock_pane_2");
    const req = page.waitForRequest((r) => /\/api\/handoffs\/.+\/deliver$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await card.getByTestId("handoff-deliver").click();
    await req;
    expect(delivered).toContain(`/api/handoffs/${HANDOFF_ID}/deliver`);
  });

  test("Reject fires POST /api/handoffs/:id/reject and flips the chip optimistically", async ({ page }) => {
    await page.route(/\/api\/handoffs\/.+\/reject$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"Rejected."}' }));
    await gotoKitchen(page);
    await seedHandoff(page);
    const card = await openDrawerOn(page, "mock_pane_2");
    const req = page.waitForRequest((r) => /\/api\/handoffs\/.+\/reject$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await card.getByTestId("handoff-reject").click();
    await req;
    // optimistic flip: the chip now reads "rejected"
    await expect(card.getByTestId("handoff-status")).toHaveAttribute("data-state", "rejected");
  });

  test("Revise edits the prompt and fires POST /api/handoffs/:id/revise with new_draft_text", async ({ page }) => {
    let body: { new_draft_text?: string } | null = null;
    await page.route(/\/api\/handoffs\/.+\/revise$/, (route) => {
      if (route.request().method() === "POST") body = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"Revised."}' });
    });
    await gotoKitchen(page);
    await seedHandoff(page);
    const card = await openDrawerOn(page, "mock_pane_2");
    await card.getByTestId("handoff-revise").click();
    await card.getByTestId("handoff-revise-input").fill("Run only the failing auth tests");
    const req = page.waitForRequest((r) => /\/api\/handoffs\/.+\/revise$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await card.getByTestId("handoff-revise-save").click();
    await req;
    expect(body?.new_draft_text).toBe("Run only the failing auth tests");
    // optimistic: the summary reflects the new text
    await expect(card.getByTestId("handoff-summary")).toContainText("Run only the failing auth tests");
  });

  test("Deliver is disabled for a non-staged handoff (honest affordance)", async ({ page }) => {
    await gotoKitchen(page);
    await seedHandoff(page, { state: "composing" });
    const card = await openDrawerOn(page, "mock_pane_2");
    await expect(card.getByTestId("handoff-deliver")).toBeDisabled();   // deliver needs `staged`
    await expect(card.getByTestId("handoff-revise")).toBeEnabled();     // revise still valid while composing
    await expect(card.getByTestId("handoff-reject")).toBeEnabled();
  });
});
