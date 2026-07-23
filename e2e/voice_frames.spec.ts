import { expect, test, type Page } from "@playwright/test";
import { armE2EWire, injectVoiceFrame } from "./fixtures";

// bead wsm-e2e-pinned-rqae — the voice lane (/live, the Gemini session socket) WAS unreachable from
// the ?mock=1 harness: its switch lived inline inside ws.onmessage and the mock lane never opens a
// real /live socket. These specs were written TDD-red against that state; the GREEN pass extracted
// the switch into the `handleVoiceFrame` useCallback (mirroring handleObserveFrame) and exposed it
// through the `injectVoiceFrame` harness hook (src/e2e/harness.ts) these cases now drive. They pin
// the voice-lane render contracts below so any future drift in an arm fails here first.
//
// Contracts pinned here, read directly off the current voice-lane switch arms (not guessed):
//   - transcript_text: setTranscript(prev => [...prev, {sender, text, timestamp}].slice(-50))
//     (useOrbitalData.ts:1255-1259) — one bubble per frame, capped at the last 50.
//   - interrupted: yourTurnDetectorRef.markInterrupted() + resetAudioPlayback() ONLY
//     (useOrbitalData.ts:1249-1254) — no setTranscript, no setToast/showToast. A barge-in is a
//     silent internal latch (it only suppresses the NEXT your-turn chime); it must NOT mint a new
//     transcript bubble or toast.
//   - voice_channel_lost (transient, permanent!==true): setVoiceReconnecting(true) only
//     (useOrbitalData.ts:1270-1283) — the rail falls to the "RECONNECTING…" rung
//     (useConversationalState.ts resolveKind: reconnecting outranks muted/speaking while still live+
//     connected).
//   - voice_channel_restored: setVoiceReconnecting(false) + showToast("Back on the air.", "fire",
//     "reconnect") (useOrbitalData.ts:1284-1293, voiceChannelRestoredToast()) — showToast ALSO mints
//     a transcript bubble (fromToast:true), unlike the plain setToast the "lost" arm uses.
//
// Per-message locator: KitchenRadio (src/orbital/KitchenRadio.tsx) gives each bubble no per-message
// testid, but BubbleFooter always renders `data-testid="radio-bubble-save"` for any non-empty-text
// message (OrbitalApp always wires onSaveBubble) — so its COUNT is a reliable one-per-bubble tell,
// the same idiom orbital_radio.spec.ts's bubble-save test already relies on.

async function gotoKitchen(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armE2EWire(page); // 3C.3b: mock-mode wires only fire on a Playwright-armed page
  await page.goto("/?ui=kitchen&mock=1");
  await page.waitForSelector("html[data-e2e-ready='1']");
  await expect(page.getByTestId("kitchen-radio")).toBeVisible();
}

async function goLive(page: Page): Promise<void> {
  await page.getByTestId("radio-golive").click();
  // Under ?mock=1, goLive() mirrors voiceConnected=true directly (no real socket) — the chip reads
  // "● LIVE" immediately, no setConnMock needed (useOrbitalData.ts:1353-1364).
  await expect(page.getByTestId("kitchen-radio")).toContainText("● LIVE");
}

test.describe("voice lane WS frame injection (?mock=1 harness) — bead wsm-e2e-pinned-rqae", () => {
  test("a. transcript_text renders one new bubble with sender attribution (Janus and User)", async ({ page }) => {
    await gotoKitchen(page);
    const feed = page.getByTestId("radio-transcript");
    const bubbles = page.getByTestId("radio-bubble-save");
    await expect(bubbles).toHaveCount(0);

    await injectVoiceFrame(page, { type: "transcript_text", sender: "Janus", text: "vf-janus-line-a1" });
    await expect(bubbles).toHaveCount(1);
    await expect(feed).toContainText("vf-janus-line-a1");
    // The Janus bubble carries the "Chef de Cuisine" label (KitchenRadio.tsx Bubble: `!me &&
    // <span>Chef de Cuisine</span>`).
    await expect(feed.getByText("vf-janus-line-a1")).toContainText("Chef de Cuisine");

    await injectVoiceFrame(page, { type: "transcript_text", sender: "User", text: "vf-user-line-b2" });
    await expect(bubbles).toHaveCount(2);
    await expect(feed).toContainText("vf-user-line-b2");
    // A User bubble never carries the Chef label — scope to the bubble containing the user's own text.
    await expect(feed.getByText("vf-user-line-b2")).not.toContainText("Chef de Cuisine");
  });

  test("b. transcript_text keeps only the most recent 50 entries (the real -50 slice cap)", async ({ page }) => {
    await gotoKitchen(page);
    const feed = page.getByTestId("radio-transcript");
    const bubbles = page.getByTestId("radio-bubble-save");

    for (let i = 0; i < 55; i++) {
      await injectVoiceFrame(page, { type: "transcript_text", sender: "Janus", text: `vf-cap-${i}` });
    }
    // useOrbitalData.ts:1257 — `.slice(-50)`: exactly 50 entries survive, oldest-first dropped.
    await expect(bubbles).toHaveCount(50);
    await expect(feed).not.toContainText("vf-cap-0");
    // A plain substring check for "vf-cap-4" would false-positive against the SURVIVING
    // "vf-cap-40".."vf-cap-49" entries — the negative lookahead pins "vf-cap-4" as a standalone
    // token (not immediately followed by another digit), matching the original intent exactly.
    await expect(feed).not.toContainText(/vf-cap-4(?!\d)/);
    await expect(feed).toContainText("vf-cap-5"); // the oldest SURVIVING entry (55 - 50 = 5)
    await expect(feed).toContainText("vf-cap-54"); // the newest entry
  });

  test("c. an interrupted (barge-in) frame is silent — no new bubble, no toast", async ({ page }) => {
    await gotoKitchen(page);
    const bubbles = page.getByTestId("radio-bubble-save");
    const toast = page.getByTestId("toast");
    await expect(bubbles).toHaveCount(0);
    await expect(toast).toHaveCount(0);

    await injectVoiceFrame(page, { type: "interrupted" });
    // Chain a marker frame right behind it (condition-waited, no sleep) so a real render has
    // definitely happened before we check what `interrupted` itself did — if `interrupted` had
    // (wrongly) minted a bubble or a toast, the assertions below catch it: only the marker frame
    // may account for the +1 bubble.
    await injectVoiceFrame(page, { type: "transcript_text", sender: "Janus", text: "vf-post-interrupt-marker" });
    await expect(page.getByTestId("radio-transcript")).toContainText("vf-post-interrupt-marker");
    await expect(bubbles).toHaveCount(1); // the marker only — `interrupted` minted nothing
    await expect(toast).toHaveCount(0); // markInterrupted()/resetAudioPlayback() never touch toast
  });

  test("d. voice_channel_lost drops the rail to RECONNECTING…, voice_channel_restored brings it back live with a toast", async ({ page }) => {
    await gotoKitchen(page);
    await goLive(page);

    await injectVoiceFrame(page, { type: "voice_channel_lost", permanent: false });
    // useConversationalState.ts resolveKind: live && connected && reconnecting -> "reconnecting".
    await expect(page.getByTestId("kitchen-radio")).toContainText("RECONNECTING…");
    await expect(page.getByTestId("kitchen-radio")).not.toContainText("● LIVE");

    await injectVoiceFrame(page, { type: "voice_channel_restored" });
    await expect(page.getByTestId("kitchen-radio")).toContainText("● LIVE");
    // voiceChannelRestoredToast(): { msg: "Back on the air.", kind: "fire", earcon: "reconnect" }.
    await expect(page.getByTestId("toast")).toContainText("Back on the air.");
  });

  test("e. a burst of chunk-like transcript_text frames for one thought renders one bubble PER FRAME", async ({ page }) => {
    await gotoKitchen(page);
    const feed = page.getByTestId("radio-transcript");
    const bubbles = page.getByTestId("radio-bubble-save");
    await expect(bubbles).toHaveCount(0);

    // Server-side coalescing (PR #135) is a SEPARATE concern from the client render contract: the
    // client still renders exactly one bubble per transcript_text frame it receives, chunked or not.
    const chunks = ["Let's refactor", " the retry logic", " to use exponential backoff."];
    for (const chunk of chunks) {
      await injectVoiceFrame(page, { type: "transcript_text", sender: "Janus", text: chunk });
    }
    await expect(bubbles).toHaveCount(chunks.length);
    for (const chunk of chunks) await expect(feed).toContainText(chunk);
    // Pin "one bubble per frame, never coalesced": the first chunk's own bubble must not also carry
    // the last chunk's text.
    await expect(feed.getByText(chunks[0], { exact: false })).not.toContainText(chunks[2].trim());
  });

  test("f. a draft_updated frame fills burner-draft, and a transcript_text(Janus) frame mints a bubble WITHOUT altering burner-draft", async ({ page }) => {
    await gotoKitchen(page);
    const draft = page.getByTestId("burner-draft");
    await expect(draft).toHaveValue("");

    // 1. Inject draft_updated frame -> fills burner-draft
    await page.evaluate(([p, t]) => window.__ORBITAL_E2E__?.injectDraftUpdate(p, t), ["mock_pane_1", "Check and see what's going on."]);
    await expect(draft).toHaveValue("Check and see what's going on.");

    // 2. Inject transcript_text(Janus) frame -> mints KitchenRadio bubble WITHOUT altering burner-draft
    await injectVoiceFrame(page, { type: "transcript_text", sender: "Janus", text: "I'm thinking about something." });
    await expect(page.getByTestId("radio-transcript")).toContainText("I'm thinking about something.");
    await expect(draft).toHaveValue("Check and see what's going on.");
  });
});
