import { expect, test, type Page } from "@playwright/test";
import { armE2EWire, injectAttention } from "./fixtures";

// hwu.7 — the read-only Action Panel. A deterministic sibling REGION in the right sidebar (beside the
// KitchenRadio, above the caption bar) that re-keys to the agent's most recent completed voice tool
// call via a new `action_activity` WS frame. Voice stays terse; the panel carries the depth. It
// AUGMENTS the attention inbox (which lives in ThePass) — it never replaces the inbox or its
// approve/deny flow. Frames are driven through the REAL observe-lane switch (injectWsFrame →
// handleObserveFrame → the useOrbitalData handlers table → setLastAction), the production path.

async function gotoKitchen(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page);
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await expect(page.getByTestId("the-pass")).toBeVisible();
}

async function injectActionActivity(page: Page, name: string, callId: string, payload: unknown) {
  await page.evaluate(
    ([n, c, p]) => window.__ORBITAL_E2E__?.injectWsFrame({
      type: "action_activity", name: n, callId: c, ts: Date.now(), payload: p,
    }),
    [name, callId, payload] as const,
  );
}

test.describe("Orbital Kitchen — action panel (hwu.7)", () => {
  test("nothing renders before the first tool completes (sidebar at rest is unchanged)", async ({ page }) => {
    await gotoKitchen(page);
    await expect(page.getByTestId("action-panel")).toHaveCount(0);
  });

  test("get_status_summary re-keys the panel to the SITREP view with the composed prose", async ({ page }) => {
    await gotoKitchen(page);
    await injectActionActivity(page, "get_status_summary", "call-sitrep-1", {
      kind: "ok",
      output: "2 items awaiting your approval — most pressing: \"deploy prod\". 1 pane idle.",
    });
    const panel = page.getByTestId("action-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-view", "sitrep");
    await expect(panel).toContainText("2 items awaiting your approval");
  });

  test("search_notes re-keys the panel to the note-list view with one row per result", async ({ page }) => {
    await gotoKitchen(page);
    await injectActionActivity(page, "search_notes", "call-notes-1", {
      kind: "ok",
      output: { query: "auth", count: 2, results: [{ id: "n1", snippet: "auth uses JWT" }, { id: "n2", snippet: "retry on 401" }] },
    });
    const panel = page.getByTestId("action-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-view", "notes");
    await expect(panel).toContainText("auth uses JWT");
    await expect(panel).toContainText("retry on 401");
  });

  test("the panel re-keys as newer tool calls land (sitrep → notes)", async ({ page }) => {
    await gotoKitchen(page);
    await injectActionActivity(page, "get_status_summary", "call-a", { kind: "ok", output: "all quiet on the line" });
    await expect(page.getByTestId("action-panel")).toHaveAttribute("data-view", "sitrep");

    await injectActionActivity(page, "search_notes", "call-b", {
      kind: "ok", output: { query: "x", count: 1, results: [{ id: "n9", snippet: "the freshest note" }] },
    });
    await expect(page.getByTestId("action-panel")).toHaveAttribute("data-view", "notes");
    await expect(page.getByTestId("action-panel")).toContainText("the freshest note");
  });

  test("a gating-refusal string renders as a refusal, not as cached note data", async ({ page }) => {
    await gotoKitchen(page);
    await injectActionActivity(page, "get_project_notes", "call-refuse", {
      kind: "ok",
      output: "Error: the 'read_notes' capability is gated Off; reading note content is forbidden by policy.",
    });
    const panel = page.getByTestId("action-panel");
    await expect(panel).toHaveAttribute("data-view", "refusal");
    await expect(panel).toContainText("gated Off");
  });

  test("an unknown tool name renders a generic card — never blank, never a crash", async ({ page }) => {
    await gotoKitchen(page);
    await injectActionActivity(page, "some_future_tool_x9", "call-unknown", { kind: "ok", output: { a: 1 } });
    const panel = page.getByTestId("action-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-view", "generic");
    // the app is still alive (the pass/inbox host is still mounted)
    await expect(page.getByTestId("the-pass")).toBeVisible();
  });

  test("the attention inbox stays present and functional alongside the panel", async ({ page }) => {
    await gotoKitchen(page);
    // seed a held approval into the inbox, THEN re-key the action panel — both must coexist
    await injectAttention(page, [
      { id: "att_held", type: "approval", terminalId: "mock_pane_1", message: "pane #1 needs your ok: rm -rf build", messageId: "msg_held_1" },
    ]);
    await injectActionActivity(page, "get_status_summary", "call-coexist", { kind: "ok", output: "line is busy" });

    // the action panel is showing
    await expect(page.getByTestId("action-panel")).toBeVisible();

    // and the attention inbox tab + its real Approve/Deny affordances are still reachable
    await expect(page.getByTestId("pass-tab-attention")).toBeVisible();
    await page.getByTestId("pass-tab-attention").click();
    await expect(page.getByTestId("attn-list")).toBeVisible();
    await expect(page.getByTestId("attn-approve")).toBeVisible();
    await expect(page.getByTestId("attn-deny")).toBeVisible();
  });
});
