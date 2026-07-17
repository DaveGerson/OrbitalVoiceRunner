import { expect, test } from "@playwright/test";

/**
 * BEAD wsm-e2e-pinned-s1ap — the SCRIPTED lane (`npm run test:e2e:scripted`, PW_SCRIPTED=1 via
 * scripts/run-scripted-live-e2e.mjs). Runs ONLY under the "scripted" Playwright project: the REAL
 * `tsx server.ts` on a fresh temp JANUS_DB, booted with JANUS_MOCK_LIVE=1 so server.ts installs the
 * in-process scripted Gemini Live connector (src/voice/scriptedLiveConnector.ts) instead of the real
 * one — NO Gemini API key anywhere in this lane. No microphone is required either: KitchenRadio
 * degrades gracefully to "MIC BLOCKED" in a headless browser with no granted mic permission (the
 * /live WS itself opens independently of getUserMedia — see useOrbitalData's connect()/startMic()
 * split), which is expected and orthogonal to what this spec proves.
 *
 * THE WELD: a real browser opens the REAL /live voice socket (real WS-upgrade auth cookie, real
 * server-side tool-dispatch/approval code) against this scripted server, and the test plays
 * Gemini's side of the conversation via the loopback-only control channel
 * (POST /__scripted_live__/emit / /close) instead of a real Gemini API. This closes the gap between
 * the headless unit lane (tests/helpers/mockLive.ts, in-process only) and the browser e2e lane.
 *
 * ONE serial spec by design (mirrors e2e/live_kitchen.spec.ts): each step builds on the server
 * state the previous one made, sharing the SAME page/socket end to end.
 */
test.describe.configure({ mode: "serial" });

test("boot -> real /live voice socket -> scripted control channel round-trips a transcript -> close simulates a channel drop", async ({ page, request }) => {
  // The kitchen's signature animations never settle under Playwright's stability check.
  await page.emulateMedia({ reducedMotion: "reduce" });

  // ── 1) boot: the kitchen renders REAL (non-mock) against the scripted server ──
  await page.goto("/");
  await expect(page.getByTestId("tab-line")).toBeVisible();
  // the observe /live?observe=1 socket actually attached (auth cookie auto-seeded by the server) —
  // proves the base backend wiring is healthy before this spec touches voice at all.
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });

  // ── 2) tune in: opens the REAL (non-observe) /live WS ──
  // `live` (data.isLive) flips immediately — client-side state, independent of the WS handshake or
  // mic permission — so the mute/sign-off controls appear at once, before the socket necessarily
  // finishes connecting server-side.
  await page.getByTestId("radio-golive").click();
  await expect(page.getByTestId("radio-mute")).toBeVisible();

  // ── 3) play Gemini's side of the conversation via the control channel ──
  // Poll, not a fixed sleep: the scripted connector's session is created asynchronously inside the
  // server's connectLiveSession, so the first few POSTs may 409 ("no scripted live session is
  // connected yet") until it lands. expect.poll retries until the emit actually reaches the real
  // onmessage handler (200) — each attempt is a real POST; only the one that finally succeeds
  // delivers the envelope, so no duplicate transcript lines land once it does.
  const TRANSCRIPT_TEXT = "hello from the scripted-live e2e lane";
  await expect.poll(async () => {
    const res = await request.post("/__scripted_live__/emit", {
      data: { message: { serverContent: { inputTranscription: { text: TRANSCRIPT_TEXT } } } },
    });
    return res.status();
  }, { timeout: 20_000, intervals: [250, 500] }).toBe(200);

  // The envelope drove the REAL onmessage handler -> handleOperatorUtterance -> the User
  // transcript_text WS frame -> the radio's transcript feed.
  await expect(page.getByTestId("radio-transcript")).toContainText(TRANSCRIPT_TEXT, { timeout: 10_000 });

  // ── 4) close: simulate the Gemini socket dropping (channel-lost path) ──
  // Kept as an HTTP-level round-trip, not a UI assertion on the transient "RECONNECTING…" state: that
  // window is bounded (~500ms) and auto-heals as the scripted connector reconnects immediately, so
  // asserting on it here would be racy by construction. The gating unit tests
  // (tests/test_scripted_live_gate.ts) already pin the endpoint's business logic precisely; this just
  // proves the SAME endpoint is reachable and functions from the real browser lane too.
  const closeRes = await request.post("/__scripted_live__/close", { data: {} });
  expect(closeRes.status()).toBe(200);
  const closeBody = await closeRes.json();
  expect(closeBody.ok).toBe(true);
});
