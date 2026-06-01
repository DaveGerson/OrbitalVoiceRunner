import { test, expect, gotoMockedApp, injectTranscript } from "./fixtures";

test.describe("transcript", () => {
  test("user and model lines both render, in order, with sender attribution", async ({ page }) => {
    await gotoMockedApp(page);

    await injectTranscript(page, "User", "run the build please");
    await injectTranscript(page, "Janus", "Starting the build now.");

    const messages = page.getByTestId("transcript-message");
    await expect(messages).toHaveCount(2);

    // Order + attribution: first is the user line, second is the model line.
    await expect(messages.nth(0)).toContainText("run the build please");
    await expect(messages.nth(0)).toHaveAttribute("data-sender", "User");
    await expect(messages.nth(1)).toContainText("Starting the build now.");
    await expect(messages.nth(1)).toHaveAttribute("data-sender", "Janus");
  });

  test("a user line is attributed to the user bubble only", async ({ page }) => {
    await gotoMockedApp(page);
    await injectTranscript(page, "User", "solo user utterance");

    const userMessages = page.getByTestId("transcript-message").filter({ hasText: "solo user utterance" });
    await expect(userMessages).toHaveCount(1);
    await expect(userMessages.first()).toHaveAttribute("data-sender", "User");
  });
});
