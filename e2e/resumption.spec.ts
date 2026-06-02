import {
  test,
  expect,
  gotoMockedApp,
  injectPendingApproval,
  injectPendingAction,
  simulateDisconnect,
  simulateReconnect,
} from "./fixtures";

/**
 * WS-F `odb` — Resumption Digest e2e pin (bead `wsm-e2e-pinned-odb`, spec §8).
 *
 * Pins the disconnect → reconnect → ONE batched digest → approve-one / reject-one round-trip across
 * ≥2 staged items (a pane pending-approval + a deferred action).
 *
 * RENDER pin, by design: the ?mock=1 harness is CLIENT-ONLY (no real server WS), so this exercises the
 * disconnect-keeps-survivors + reconnect-re-announces seam at the harness/render layer. The actual
 * server round-trip — `detachSession` (keep, don't purge), `reannounceSurvivors`, the clock-pause and
 * last-call→grace→reject sweep — is pinned by the T2–T4 server/unit tests (tests/test_resumption_digest.ts,
 * tests/test_server.ts). What this proves at the UI: survivors are NOT discarded on disconnect (chips
 * persist), reconnect surfaces exactly ONE batched digest carrying each item's maintained context, and
 * approving/rejecting a re-surfaced item dismisses exactly that one dialog (proxy for the unchanged
 * exactly-once claim gate) while leaving the other untouched.
 */
test.describe("WS-F resumption digest round-trip", () => {
  test("disconnect keeps survivors; reconnect speaks one batched digest; approve-one / reject-another", async ({ page }) => {
    await gotoMockedApp(page);

    // --- Stage ≥2 items: a pane pending-approval + a deferred action. -------------------------
    await injectPendingApproval(page, "npm run deploy");
    await injectPendingAction(page, "create_pane", "Create pane build-1 (claude) in proj_x");

    // Both chips are surfaced (each staged item renders its own dialog overlay).
    const approvalDialog = page.getByTestId("approval-dialog");
    const actionDialog = page.getByTestId("action-dialog");
    await expect(approvalDialog).toHaveCount(1);
    await expect(actionDialog).toHaveCount(1);
    await expect(approvalDialog).toContainText("npm run deploy");
    await expect(page.getByTestId("action-capability")).toContainText("create_pane");
    // The header "VERIFY" telemetry reflects the single pending pane approval.
    await expect(page.getByText("1 VERIFY")).toBeVisible();

    // --- Disconnect: survivors must NOT be purged (detach, not purge — spec §6.1). ------------
    await simulateDisconnect(page);
    // Chips persist across the drop — this is the whole point of the pin.
    await expect(approvalDialog).toHaveCount(1);
    await expect(actionDialog).toHaveCount(1);
    await expect(approvalDialog).toContainText("npm run deploy");

    // --- Reconnect: ONE batched digest re-announced with context; chips repopulate. ----------
    const digest = await simulateReconnect(page);

    // Exactly one digest line was spoken (the batched envelope, not one line per item).
    expect(digest).not.toBeNull();
    const text = digest as string;
    // The envelope: "Welcome back — N actions waiting from before: …".
    expect(text).toContain("Welcome back");
    expect(text).toContain("2 actions waiting from before");
    // It carries each survivor's MAINTAINED context (the command + the action capability/summary).
    expect(text).toContain("npm run deploy");
    expect(text).toContain("create_pane");
    expect(text).toContain("Create pane build-1");
    // The pane approval also echoes its heard-trigger provenance ("you said: …").
    expect(text).toContain("you said:");

    // Exactly ONE Janus digest message landed in the transcript (not one per survivor).
    const digestMessages = page
      .getByTestId("transcript-message")
      .filter({ hasText: "Welcome back" });
    await expect(digestMessages).toHaveCount(1);
    await expect(digestMessages.first()).toHaveAttribute("data-sender", "Janus");

    // Chips repopulate for the FULL list (both survivors still actionable post-reconnect).
    await expect(approvalDialog).toHaveCount(1);
    await expect(actionDialog).toHaveCount(1);

    // The two survivors render as stacked full-screen modal overlays; the deferred action mounts
    // last so it sits on top. Resolve top-down (matching real UX): reject the action first, then
    // approve the pane approval underneath it.

    // --- Reject ONE (the deferred action): dismisses with NO side effect. ----------------------
    await page.getByTestId("action-cancel").click();
    await expect(actionDialog).toHaveCount(0);
    // The OTHER survivor (the pane approval) is untouched by rejecting the action.
    await expect(approvalDialog).toHaveCount(1);

    // --- Approve ANOTHER (the pane approval): dismisses exactly that dialog. -------------------
    // Proxy for the unchanged exactly-once claim gate — approving writes once, the chip clears.
    await page.getByTestId("approval-approve").click();
    await expect(approvalDialog).toHaveCount(0);

    // Round-trip complete: every survivor was re-surfaced and consciously resolved exactly once.
    await expect(approvalDialog).toHaveCount(0);
    await expect(actionDialog).toHaveCount(0);
    // Exactly the one digest line remains in the transcript — resolving chips spawns no new speech.
    await expect(digestMessages).toHaveCount(1);
  });

  test("reconnect with no survivors is silent (no digest, no transcript line)", async ({ page }) => {
    await gotoMockedApp(page);

    // Nothing staged → a reconnect must NOT speak (spec §7: 0 items = silent).
    await simulateDisconnect(page);
    const digest = await simulateReconnect(page);
    expect(digest).toBeNull();

    const digestMessages = page
      .getByTestId("transcript-message")
      .filter({ hasText: "Welcome back" });
    await expect(digestMessages).toHaveCount(0);
  });
});
