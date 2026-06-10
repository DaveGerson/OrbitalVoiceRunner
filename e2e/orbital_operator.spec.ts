import { expect, test, type Page } from "@playwright/test";

// Phase 2 Track K — the kitchen as a full operator surface.
//   2K.1 pane lifecycle (86/rename/clear-exited/freezer restore+delete)
//   2K.2 per-pane autonomy visible (posture chip) + editable (Rulebook pane scope)
//   2K.3 the Order Pad mirrors dictation (draft_updated, focus-guarded)
//   2K.4 confirm the risky (Full Auto — pinned in orbital_controls), undo the destructive
//   2K.5 keyboard reachability (cards, dialogs, Escape, EmergencyStop hold)
// Driven through the ?mock=1 harness; lifecycle wires fire the REAL fetches so the
// specs intercept + assert them (the established kitchen pattern).

import { armE2EWire } from "./fixtures"; // also pulls the shared window.__ORBITAL_E2E__ declaration

const PANE = "mock_pane_1";

async function gotoKitchen(page: Page, params = "") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto(`/?ui=kitchen&mock=1${params}`);
  await page.waitForSelector("html[data-e2e-ready='1']");
}

async function openBurner(page: Page) {
  await page.locator(`[data-testid="station-card"][data-pane-id="${PANE}"]`).first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
}

async function injectDraftUpdate(page: Page, paneId: string, text: string) {
  await page.evaluate(([id, t]) => window.__ORBITAL_E2E__?.injectDraftUpdate(id, t), [paneId, text] as const);
}

async function setPaneStatusMock(page: Page, paneId: string, status: "Running" | "Idle" | "Exited") {
  await page.evaluate(
    ([id, s]) => window.__ORBITAL_E2E__?.setPaneStatusMock(id, s as "Running" | "Idle" | "Exited"),
    [paneId, status] as const,
  );
}

// ── 2K.1 — pane lifecycle ─────────────────────────────────────────────────

test.describe("2K.1 — pane lifecycle", () => {
  test("86 this station confirms once, then POSTs the stop+archive route", async ({ page }) => {
    await page.route(/\/api\/projects\/.+\/panes\/.+\/stop$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page);
    await openBurner(page);

    // First tap arms the inline confirm — nothing fires yet.
    await page.getByTestId("burner-86").click();
    await expect(page.getByTestId("burner-86")).toContainText("Sure, Chef?");

    const stopReq = page.waitForRequest(
      (r) => /\/api\/projects\/mock_project\/panes\/mock_pane_1\/stop$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("burner-86").click();
    await stopReq;
    await expect(page.getByTestId("toast")).toContainText("86'd");
  });

  test("an Exited pane is 86'd without the confirm step", async ({ page }) => {
    await page.route(/\/api\/projects\/.+\/panes\/.+\/stop$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page);
    await setPaneStatusMock(page, PANE, "Exited");
    await openBurner(page);

    const stopReq = page.waitForRequest(
      (r) => /\/panes\/mock_pane_1\/stop$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("burner-86").click(); // one tap — already exited, nothing to kill
    await stopReq;
  });

  test("Rename PUTs the rename route with the new name", async ({ page }) => {
    let body: { name?: string } | null = null;
    await page.route(/\/api\/projects\/.+\/panes\/.+\/rename$/, (route) => {
      if (route.request().method() === "PUT") body = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' });
    });
    await gotoKitchen(page);
    await openBurner(page);

    const putReq = page.waitForRequest(
      (r) => /\/api\/projects\/mock_project\/panes\/mock_pane_1\/rename$/.test(r.url()) && r.method() === "PUT",
      { timeout: 10_000 },
    );
    await page.getByTestId("burner-rename").click();
    await page.getByTestId("burner-rename-input").fill("Saucier Station");
    await page.getByTestId("burner-rename-input").press("Enter");
    await putReq;
    expect(body?.name).toBe("Saucier Station");
    await expect(page.getByTestId("toast")).toContainText("Saucier Station");
  });

  test("the Clear-exited chip appears only with an Exited station and POSTs clear-exited", async ({ page }) => {
    await page.route(/\/api\/terminals\/clear-exited$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true,"archived":1}' }));
    await gotoKitchen(page);
    await expect(page.getByTestId("clear-exited")).toHaveCount(0); // both seeded panes Running

    await setPaneStatusMock(page, PANE, "Exited");
    await expect(page.getByTestId("clear-exited")).toBeVisible();
    await expect(page.getByTestId("clear-exited")).toContainText("1");

    const clearReq = page.waitForRequest(
      (r) => /\/api\/terminals\/clear-exited$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("clear-exited").click();
    await clearReq;
    await expect(page.getByTestId("toast")).toContainText("freezer");
  });

  // 1B.3 honest feedback carries over: a dead clear-exited POST warns, never a false ack.
  test("a failed Clear-exited warns instead of a false ack", async ({ page }) => {
    await page.route(/\/api\/terminals\/clear-exited$/, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
    await gotoKitchen(page);
    await setPaneStatusMock(page, PANE, "Exited");
    await page.getByTestId("clear-exited").click();
    await expect(page.getByTestId("toast")).toContainText("Couldn't clear");
  });

  test("the Pantry freezer lists archived panes; Restore POSTs the restore route", async ({ page }) => {
    await page.route(/\/api\/archive$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        archived: [{ pane_id: "old_pane", name: "Webhook retries", project_id: "mock_project", tool_preset: "Claude Code", last_command: "npm test", archived_at: Date.now() }],
      }) }));
    await page.route(/\/api\/archive\/.+\/restore$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page, "&view=pantry");

    const row = page.getByTestId("freezer-pane");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Webhook retries");

    const restoreReq = page.waitForRequest(
      (r) => /\/api\/archive\/old_pane\/restore$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("freezer-restore").click();
    await restoreReq;
    await expect(page.getByTestId("toast")).toContainText("back on the line");
    await expect(page.getByTestId("freezer-pane")).toHaveCount(0); // out of the tray
  });

  test("freezer Delete takes a two-tap confirm, then DELETEs", async ({ page }) => {
    await page.route(/\/api\/archive$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        archived: [{ pane_id: "old_pane", name: "Webhook retries", project_id: "mock_project" }],
      }) }));
    await page.route(/\/api\/archive\/old_pane$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page, "&view=pantry");
    await expect(page.getByTestId("freezer-pane")).toHaveCount(1);

    await page.getByTestId("freezer-delete").click(); // arm
    await expect(page.getByTestId("freezer-delete")).toContainText("Sure, Chef?");
    const delReq = page.waitForRequest(
      (r) => /\/api\/archive\/old_pane$/.test(r.url()) && r.method() === "DELETE",
      { timeout: 10_000 },
    );
    await page.getByTestId("freezer-delete").click(); // fire
    await delReq;
    await expect(page.getByTestId("freezer-pane")).toHaveCount(0);
  });
});

// ── 2K.2 — per-pane autonomy visible + editable ──────────────────────────

test.describe("2K.2 — per-pane autonomy", () => {
  test("the station card and burner show the server-resolved posture chip", async ({ page }) => {
    await gotoKitchen(page);
    // the harness seeds posture GUARDED on the mock panes (server truth on the terminals payload)
    const cardChip = page.locator(`[data-testid="station-card"][data-pane-id="${PANE}"] [data-testid="posture-chip"]`);
    await expect(cardChip.first()).toHaveAttribute("data-posture", "GUARDED");
    await openBurner(page);
    await expect(page.locator('[data-testid="burner"] [data-testid="posture-chip"]')).toHaveAttribute("data-posture", "GUARDED");
  });

  test("the posture chip follows a server posture change", async ({ page }) => {
    await gotoKitchen(page);
    await page.evaluate(() => window.__ORBITAL_E2E__?.setPostureMock("OPEN", { write_to_pane: "Auto" }));
    await expect(page.locator('[data-testid="station-card"] [data-testid="posture-chip"]').first())
      .toHaveAttribute("data-posture", "OPEN");
  });

  test("the Rulebook gains a pane scope that PUTs the per-pane capability-gates route", async ({ page }) => {
    let body: { capabilityGates?: Record<string, string> } | null = null;
    await page.route(/\/api\/projects\/.+\/panes\/.+\/capability-gates$/, (route) => {
      if (route.request().method() === "PUT") body = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true,"capabilityGates":{"create_pane":"Off"}}' });
    });
    await gotoKitchen(page, "&view=boh");

    // whole-kitchen scope is the default (existing behavior)
    await expect(page.getByTestId("rulebook-scope-kitchen")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId(`rulebook-scope-${PANE}`).click();
    await expect(page.getByTestId("rulebook-scope-note")).toContainText("Tuning");

    const putReq = page.waitForRequest(
      (r) => /\/api\/projects\/mock_project\/panes\/mock_pane_1\/capability-gates$/.test(r.url()) && r.method() === "PUT",
      { timeout: 10_000 },
    );
    await page.getByTestId("rule-create_pane").getByTestId("gate-Off").click();
    await putReq;
    expect(body?.capabilityGates?.create_pane).toBe("Off");
    await expect(page.getByTestId("toast")).toContainText("Rulebook updated for that station");
  });

  test("a failed pane-scope write warns instead of failing silently", async ({ page }) => {
    await page.route(/\/api\/projects\/.+\/panes\/.+\/capability-gates$/, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
    await gotoKitchen(page, "&view=boh");
    await page.getByTestId(`rulebook-scope-${PANE}`).click();
    await page.getByTestId("rule-create_pane").getByTestId("gate-Off").click();
    await expect(page.getByTestId("toast")).toContainText("didn't save");
  });
});

// ── 2K.3 — the Order Pad mirrors dictation ────────────────────────────────

test.describe("2K.3 — Order Pad mirror", () => {
  test("a draft_updated frame fills the pad while it isn't focused", async ({ page }) => {
    await gotoKitchen(page);
    await openBurner(page);
    // initial dialog focus lands on the close light, NOT the textarea → the mirror applies
    await injectDraftUpdate(page, PANE, "Plate the demo for table six");
    await expect(page.getByTestId("burner-draft")).toHaveValue("Plate the demo for table six");
  });

  test("the focus-lock: an incoming draft never clobbers active typing", async ({ page }) => {
    await gotoKitchen(page);
    await openBurner(page);
    const pad = page.getByTestId("burner-draft");
    await pad.click();
    await pad.fill("operator is typing this");
    await injectDraftUpdate(page, PANE, "CLOBBER ATTEMPT");
    // still the operator's text — the focused pad wins (classic App.tsx focus-lock, ported)
    await expect(pad).toHaveValue("operator is typing this");

    // blur the pad → the NEXT incoming draft applies again
    await page.getByTestId("burner-tab-pad").click(); // moves focus off the textarea
    await injectDraftUpdate(page, PANE, "fresh from the chef");
    await expect(pad).toHaveValue("fresh from the chef");
  });
});

// ── 2K.4 — undo the destructive ───────────────────────────────────────────

test.describe("2K.4 — undo in toast", () => {
  test("86'ing a Pass ticket offers Undo, which re-POSTs the note", async ({ page }) => {
    await page.route(/\/api\/projects\/.+\/notes$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await page.route(/\/api\/notes\/.+$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page);

    await page.getByTestId("pass-jot-input").fill("check the walk-in temps");
    await page.getByTestId("pass-jot-add").click();
    await expect(page.getByTestId("pass-ticket")).toHaveCount(1);

    await page.getByTestId("pass-ticket-delete").click();
    await expect(page.getByTestId("pass-ticket")).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("86'd that one");
    await expect(page.getByTestId("toast-action")).toContainText("Undo");

    const undoPost = page.waitForRequest(
      (r) => /\/api\/projects\/.+\/notes$/.test(r.url()) && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("toast-action").click();
    const req = await undoPost;
    expect(req.postDataJSON()?.note).toBe("check the walk-in temps");
    await expect(page.getByTestId("pass-ticket")).toHaveCount(1); // optimistically back on the pass
  });
});

// ── 2K.5 — keyboard reachability ──────────────────────────────────────────

test.describe("2K.5 — keyboard reachability", () => {
  test("a station card is a keyboard button: focus + Enter opens the burner", async ({ page }) => {
    await gotoKitchen(page);
    const card = page.locator(`[data-testid="station-card"][data-pane-id="${PANE}"]`).first();
    await expect(card).toHaveAttribute("role", "button");
    await expect(card).toHaveAttribute("tabindex", "0");
    await card.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("burner")).toBeVisible();
  });

  test("Space also opens a focused station card", async ({ page }) => {
    await gotoKitchen(page);
    await page.locator(`[data-testid="station-card"][data-pane-id="${PANE}"]`).first().focus();
    await page.keyboard.press(" ");
    await expect(page.getByTestId("burner")).toBeVisible();
  });

  test("the burner is a dialog and Escape closes it", async ({ page }) => {
    await gotoKitchen(page);
    await openBurner(page);
    await expect(page.getByTestId("burner")).toHaveAttribute("role", "dialog");
    await expect(page.getByTestId("burner")).toHaveAttribute("aria-modal", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("burner")).toHaveCount(0);
  });

  test("Escape closes the New Pane modal and the call sheet", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTitle("Open a new pane in this project").first().click();
    await expect(page.getByTestId("orbital-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("orbital-modal")).toHaveCount(0);

    await page.getByRole("button", { name: "🎙 calls" }).click();
    await expect(page.getByTestId("radio-calls")).toBeVisible();
    await expect(page.getByTestId("radio-calls")).toHaveAttribute("role", "dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("radio-calls")).toHaveCount(0);
  });

  test("EmergencyStop: holding Space drives the same kill timer; early release cancels", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("all-hands").click();
    await expect(page.getByTestId("emergency-stop")).toBeVisible();
    const kill = page.getByTestId("hold-to-kill");
    await kill.focus();

    // early release → no kill, progress resets
    await page.keyboard.down(" ");
    await page.waitForTimeout(200);
    await page.keyboard.up(" ");
    await expect(page.getByText("ALL HANDS!")).toBeVisible();
    await expect(kill).toContainText("HOLD to kill");

    // a full hold crosses the threshold → stage 2
    await page.keyboard.down(" ");
    await page.waitForTimeout(900);
    await page.keyboard.up(" ");
    await expect(page.getByText("Gas is off.")).toBeVisible();
  });

  test("the toast is a polite live region", async ({ page }) => {
    await page.route(/\/api\/projects\/.+\/notes$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"output":"ok"}' }));
    await gotoKitchen(page);
    await page.getByTestId("pass-jot-input").fill("note for the live region");
    await page.getByTestId("pass-jot-add").click();
    await expect(page.getByTestId("toast")).toHaveAttribute("role", "status");
    await expect(page.getByTestId("toast")).toHaveAttribute("aria-live", "polite");
  });
});

// ── 2K.6 — desktop notes tweak ────────────────────────────────────────────
// The Notification API itself can't be meaningfully asserted here (the e2e tab is never hidden,
// and notifyDesktop is document.hidden-gated by design), so the spec pins the product surface:
// the dedicated "Desktop notes" tweak exists and toggles, separate from Voice cues.

test.describe("2K.6 — desktop notes", () => {
  test("the Tweaks panel has a separate Desktop notes toggle", async ({ page }) => {
    await gotoKitchen(page);
    await page.getByTestId("tweaks-toggle").click();
    const toggle = page.getByRole("switch", { name: "Desktop notes" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true"); // default on
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // Voice cues remains its own switch — audio and desktop notes are independent
    await expect(page.getByRole("switch", { name: "Voice cues" })).toBeVisible();
  });
});
