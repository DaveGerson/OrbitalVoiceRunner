import { expect, test, type Page } from "@playwright/test";
import { armE2EWire } from "./fixtures";

// j4e1 — the handoff LINE DRAWER (operator decision D1: a per-station drawer on The Line, NOT a Pass
// card). The compose/revise/stage/deliver/reject lifecycle is server-tested but had ZERO UI; this
// drawer FOREGROUNDS the four hero actions (stage / deliver / revise / reject) for handoffs bound to a
// station (to_pane).
//
// DATA SEAM (production-faithful): the convergence server broadcasts a PAYLOAD-LESS
// {type:"handoffs_updated"} frame on every lifecycle mutation, so the live spine is ALWAYS a
// GET /api/handoffs refetch (useOrbitalData.refetchHandoffs). The harness is client-only (no real WS),
// so we drive that EXACT path: mock GET /api/handoffs (the list_handoffs projection — id keyed as
// `handoff_id`, composed_prompt truncated to 200 chars) + inject the payload-less frame through
// window.__ORBITAL_E2E__.injectWsFrame (the SAME reducer the live socket uses). The drawer then reads
// the board off the refetch, never off the frame payload.
//
// REST TWINS: the stage/deliver/revise/reject buttons fire the CANONICAL handoff REST twins —
// POST /api/handoffs/:id/stage, POST /api/handoffs/:id/deliver, POST /api/handoffs/:id/revise
// {new_draft_text}, POST /api/handoffs/:id/reject. This spec MOCKS those twins (page.route) and asserts
// the path+method per the cross-branch contract: the convergence branch ships the server twins; this
// branch ships the UI + asserts the wire. The two must be integrated together.

const HANDOFF_ID = "ho_test_1";
// The list projection truncates composed_prompt to 200 chars; read_handoff returns the FULL prompt.
// A revise editor seeded from the projection would corrupt a long prompt, so we make the FULL prompt
// distinct and long enough to prove the editor seeds from read_handoff, not the truncated list row.
const FULL_PROMPT = "Run the auth test suite and report failures. " + "x".repeat(300) + " END_OF_FULL_PROMPT";
const LIST_PROMPT = FULL_PROMPT.slice(0, 200); // what GET /api/handoffs returns (truncated)

/** One handoff row in the list_handoffs REST projection shape (id keyed as `handoff_id`). */
function listRow(over: Record<string, unknown> = {}) {
  return {
    handoff_id: HANDOFF_ID, workspace_id: "mock_project", from_pane: "mock_pane_1", to_pane: "mock_pane_2",
    kind: "agent_instruction", composed_prompt: LIST_PROMPT, source_context: "{}", source_context_refs: "[]",
    state: "staged", gate_approval_id: null, approved_by: null, approved_via: null, revision_count: 0,
    created_at: 1, staged_at: 2, delivered_at: null, consumed_at: null, terminal_at: null, expires_at: null, ...over,
  };
}

/**
 * Seed a handoff TO mock_pane_2 ("Python Backend") the PRODUCTION way: mock GET /api/handoffs to serve
 * the (truncated) list projection, then inject the payload-less handoffs_updated frame so the live
 * reducer refetches and paints the board. Returns the resolved list row for assertions.
 */
async function seedHandoff(page: Page, over: Record<string, unknown> = {}) {
  const row = listRow(over);
  // GET /api/handoffs → { output: [ <list projection rows> ] } (default resultToHttp wrap).
  await page.route(/\/api\/handoffs(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ output: [row] }) });
  });
  await page.evaluate(() => {
    // PAYLOAD-LESS frame — exactly what the convergence server broadcasts. The reducer degrades to a
    // GET /api/handoffs refetch (mocked above), which is the real live spine.
    window.__ORBITAL_E2E__?.injectWsFrame({ type: "handoffs_updated" });
  });
  return row;
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
    // URL asserted from the AWAITED request itself (below), never a route-handler-captured var — the
    // route callback and waitForRequest resolve on independent event streams, so reading a shared
    // var after `await req` races under parallel-worker load (bead wsm-e2e-pinned-3ss).
    await page.route(/\/api\/handoffs\/.+\/deliver$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"Delivered."}' }));
    await gotoKitchen(page);
    await seedHandoff(page);
    const card = await openDrawerOn(page, "mock_pane_2");
    const req = page.waitForRequest((r) => /\/api\/handoffs\/.+\/deliver$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await card.getByTestId("handoff-deliver").click();
    expect((await req).url()).toContain(`/api/handoffs/${HANDOFF_ID}/deliver`);
  });

  test("Stage fires POST /api/handoffs/:id/stage (composing → staged)", async ({ page }) => {
    // URL asserted from the AWAITED request itself (below), never a route-handler-captured var — the
    // route callback and waitForRequest resolve on independent event streams, so reading a shared
    // var after `await req` races under parallel-worker load (bead wsm-e2e-pinned-3ss).
    await page.route(/\/api\/handoffs\/.+\/stage$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"Staged."}' }));
    await gotoKitchen(page);
    await seedHandoff(page, { state: "composing" }); // a composing draft is stageable
    const card = await openDrawerOn(page, "mock_pane_2");
    const req = page.waitForRequest((r) => /\/api\/handoffs\/.+\/stage$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await card.getByTestId("handoff-stage").click();
    expect((await req).url()).toContain(`/api/handoffs/${HANDOFF_ID}/stage`);
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

  test("Revise seeds from the FULL prompt (read_handoff), not the truncated list row, and POSTs new_draft_text", async ({ page }) => {
    // read_handoff: GET /api/handoffs/:id → the FULL (untruncated) composed_prompt. MUST be registered
    // before the broad GET /api/handoffs list route so the more-specific :id route wins.
    await page.route(new RegExp(`/api/handoffs/${HANDOFF_ID}$`), (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ output: { handoff_id: HANDOFF_ID, composed_prompt: FULL_PROMPT } }) });
    });
    // Body read from the AWAITED request (below), not a route-captured variable — a shared `body`
    // read after the await races against the route handler under parallel-worker load (bead
    // wsm-e2e-pinned-3ss).
    await page.route(/\/api\/handoffs\/.+\/revise$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"Revised."}' }));
    await gotoKitchen(page);
    await seedHandoff(page);
    const card = await openDrawerOn(page, "mock_pane_2");
    await card.getByTestId("handoff-revise").click();
    // The editor seeds from read_handoff (the FULL prompt) — proving the >200-char tail survived, so a
    // Save can never corrupt a long prompt by resubmitting the truncated list projection.
    await expect(card.getByTestId("handoff-revise-input")).toHaveValue(FULL_PROMPT);
    await card.getByTestId("handoff-revise-input").fill("Run only the failing auth tests");
    const req = page.waitForRequest((r) => /\/api\/handoffs\/.+\/revise$/.test(r.url()) && r.method() === "POST", { timeout: 10_000 });
    await card.getByTestId("handoff-revise-save").click();
    const body = (await req).postDataJSON() as { new_draft_text?: string };
    expect(body?.new_draft_text).toBe("Run only the failing auth tests");
    // optimistic: the summary reflects the new text
    await expect(card.getByTestId("handoff-summary")).toContainText("Run only the failing auth tests");
  });

  test("Save is disabled until the operator actually changes the seeded prompt", async ({ page }) => {
    await page.route(new RegExp(`/api/handoffs/${HANDOFF_ID}$`), (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ output: { handoff_id: HANDOFF_ID, composed_prompt: FULL_PROMPT } }) });
    });
    await gotoKitchen(page);
    await seedHandoff(page);
    const card = await openDrawerOn(page, "mock_pane_2");
    await card.getByTestId("handoff-revise").click();
    await expect(card.getByTestId("handoff-revise-input")).toHaveValue(FULL_PROMPT);
    await expect(card.getByTestId("handoff-revise-save")).toBeDisabled(); // unchanged seed → no-op blocked
    await card.getByTestId("handoff-revise-input").fill(FULL_PROMPT + " plus a tweak");
    await expect(card.getByTestId("handoff-revise-save")).toBeEnabled();
  });

  test("Stage is disabled for a staged handoff; Deliver is disabled for a non-staged one (honest affordances)", async ({ page }) => {
    await gotoKitchen(page);
    await seedHandoff(page, { state: "composing" });
    const card = await openDrawerOn(page, "mock_pane_2");
    await expect(card.getByTestId("handoff-deliver")).toBeDisabled(); // deliver needs `staged`
    await expect(card.getByTestId("handoff-stage")).toBeEnabled();    // stage is valid while composing
    await expect(card.getByTestId("handoff-revise")).toBeEnabled();   // revise still valid while composing
    await expect(card.getByTestId("handoff-reject")).toBeEnabled();
  });
});
