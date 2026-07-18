import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BEAD wsm-e2e-pinned-s1ap (part 2 of 2) — the SCRIPTED-lane BROWSER journeys. Runs ONLY under the
 * "scripted" Playwright project (`npm run test:e2e:scripted`). Companion to e2e/scripted_voice.spec.ts
 * (which pins the control-channel round-trip itself); this file drives the three scenarios the
 * testing-roadmap names as the flagship exit criteria for the voice thought-chunking fix
 * (wsm-e2e-pinned-zmu5) and the channel-loss contract, end-to-end through a REAL browser against the
 * REAL /live voice socket — no Gemini key, no microphone (see e2e/scripted_voice.spec.ts's header for
 * the full lane rationale).
 *
 * THREE INDEPENDENT scenarios, each its own `test()` (its own fresh page + its own fresh /live
 * socket + its own fresh scripted session — see "SESSION ISOLATION" below), sharing ONE real server
 * (playwright.config.ts's scripted project runs `workers: 1`, files/tests execute in written order).
 *
 * SESSION ISOLATION: src/voice/scriptedLiveConnector.ts's `currentSession` is a MODULE-LEVEL
 * singleton — every "go live" click opens a NEW real /live WS, which re-enters connectLiveSession's
 * INITIAL connect and re-invokes the scripted connector, overwriting `currentSession` with a session
 * scoped to THAT connection. Because Playwright gives each `test()` its own fresh `page` (a fresh
 * browser context ⇒ a fresh WS), and the scripted project's single worker runs tests strictly in
 * order, there is never a race between scenarios over the shared `currentSession` handle.
 *
 * MIC-BLOCKED MASKING (read before touching the CHANNEL LOST/RESTORED scenario): headless Chromium
 * denies getUserMedia by default (no fake-device flag, no granted permission) — see
 * scripted_voice.spec.ts's header. `useConversationalState`'s precedence ladder
 * (offline > blocked > tuning > reconnecting > muted > ...) puts `blocked` ABOVE `reconnecting`, so
 * once the mic denial lands the Kitchen Radio status chip is PINNED on "MIC BLOCKED" for the rest of
 * the session — a transient voice-channel loss/restore never surfaces as a chip-text change in this
 * lane. Scenario 3 below proves the loss/restore over the channel that actually carries it (the real
 * `/live` WS frame contract: `voice_channel_lost` → `voice_channel_restored`) plus the ONE UI surface
 * that is NOT gated by the mic-blocked mask (the toast, `voiceChannelRestoredToast`'s "Back on the
 * air." — a raw side effect of receiving `voice_channel_restored`, independent of the chip ladder),
 * and documents the masked chip explicitly rather than asserting something headless Chromium cannot
 * produce.
 */
test.describe.configure({ mode: "serial" });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INCIDENT_TRACE = path.join(HERE, "..", "tests", "fixtures", "traces", "incident-2026-07-16-chunked-thought.jsonl");
// Byte-identical to tests/test_trace_replay.ts's JOINED_INCIDENT / agenticBullet — this is the SAME
// fixture, pinned at the unit level already; this file proves the SAME contract survives a real
// browser + real WS + real HTTP control channel, not just an in-process emit().
const JOINED_INCIDENT = "My apologies again. The draft is ready for test-2 now. Say 'send it' to submit.";
function agenticBullet(text: string): string {
  return `* **Agentic Thought**: *${text}*`;
}

interface TraceEntry {
  ts: number;
  seq: number;
  message: unknown;
}

/** Parse the committed `.jsonl` capture into ordered entries — mirrors tests/helpers/traceReplay.ts's
 *  parseTraceText, duplicated (not imported) because e2e/ specs run under Playwright's own module
 *  resolution and this file has no other reason to reach into tests/helpers/. */
function loadTrace(filePath: string): TraceEntry[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceEntry);
}

async function boot(page: Page): Promise<void> {
  // The kitchen's signature animations never settle under Playwright's stability check (same
  // rationale as every other real-server lane spec).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("tab-line")).toBeVisible();
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });
}

async function goLive(page: Page): Promise<void> {
  await page.getByTestId("radio-golive").click();
  // `live` (data.isLive) flips immediately client-side — independent of mic permission or the WS
  // handshake finishing server-side (see e2e/scripted_voice.spec.ts step 2's identical rationale).
  await expect(page.getByTestId("radio-mute")).toBeVisible();
  // Headless Chromium denies getUserMedia (see the file header's MIC-BLOCKED MASKING note). That
  // denial fires ASYNCHRONOUSLY, shortly after go-live, and — via showToast — ALSO narrates a "Mic's
  // blocked…" bubble into radio-transcript (src/orbital/useOrbitalData.ts: "Narrate every ack into
  // the Kitchen Radio… renders as a Chef de Cuisine bubble", not just the toast overlay). Waiting for
  // it HERE, once, means every caller's own bubble-count assertions start from a settled baseline
  // instead of racing this one-time noise bubble landing at some arbitrary point mid-scenario.
  await expect(page.getByTestId("radio-transcript")).toContainText("Mic's blocked", { timeout: 15_000 });
}

/**
 * POST one synthetic Gemini envelope through the loopback control channel, polling until it lands.
 * `expect.poll` — not a fixed sleep — because the scripted connector's session is created
 * ASYNCHRONOUSLY inside the server's connectLiveSession (real Promise, not synchronous), so the first
 * emit(s) after a fresh "go live" (or, in scenario 3, after the server's own auto-reconnect) may 409
 * ("no scripted live session is connected yet") until the session lands. A 409 response mutates
 * nothing server-side (emitToScriptedSession returns before touching the session), so a retry can
 * never double-deliver; once a POST actually returns 200 the envelope has been delivered exactly once
 * and polling stops.
 */
async function emitScripted(request: APIRequestContext, message: unknown): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.post("/__scripted_live__/emit", { data: { message } });
        return res.status();
      },
      { timeout: 20_000, intervals: [100, 250, 500] }
    )
    .toBe(200);
}

/** Direct children of the transcript pane = exactly one DOM root per TranscriptEntry (each Bubble
 *  returns a single root div; the surrounding `<Fragment>` and the transcript-body `<>...</>` both
 *  collapse to nothing in the DOM). The empty-state placeholder only renders while transcript.length
 *  === 0, and the "listening for you, Chef…" trailing hint requires `listening` (live && connected &&
 *  !muted && !micBlocked) — false throughout this lane per the MIC-BLOCKED MASKING note above — so
 *  this selector counts exactly the transcript array's length with nothing else mixed in.
 *
 *  CAVEAT (discovered empirically, scenario 1 only): the AnnouncementBus (WS-D, src/announcementBus.ts)
 *  ALSO pushes plain Janus-sender bubbles into this SAME feed for ordinary kitchen events unrelated to
 *  voice at all — "New kitchen opened!", "Jotted it down", "Queued — needs your ok at the pass",
 *  "Fired it" all land here as a side effect of scenario 1's UI-driven project/ticket/pane setup, on
 *  their own ~1500ms coalesce-window flush timer. Scenario 1 therefore never asserts an ABSOLUTE bubble
 *  count; it filters for the incident sentence specifically (immune to how much unrelated announcement
 *  noise is interleaved) and additionally checks the pre/post DELTA once setup has had time to settle. */
function transcriptBubbles(page: Page) {
  return page.locator('[data-testid="radio-transcript"] > div');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SCENARIO 1 — INCIDENT REPLAY (the roadmap's flagship exit criterion).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
test("incident replay: 10 chunked outputTranscription fragments + turnComplete coalesce into ONE Janus bubble + ONE Order Pad bullet", async ({ page, request }) => {
  await boot(page);

  // Go live FIRST, before any modal/burner overlay ever opens. The burner (TerminalWindow) renders as
  // a `role="dialog"` overlay that stacks ABOVE the Kitchen Radio panel and intercepts pointer events
  // on it (confirmed empirically: a `radio-golive` click attempted while the burner was open timed out
  // with "<div> subtree intercepts pointer events") — so this test never has a burner/modal open at
  // the same time it clicks anything in the radio panel. Order Pad verification (below) opens the
  // burner LAST, once no further radio interaction is needed.
  await goLive(page);

  // ── arrange an active pane through the REAL UI (no ConPTY dependency — a "Custom" shell preset,
  // exactly the recipe e2e/live_kitchen.spec.ts already proves works in this real-server lane) so
  // appendActiveDraft (server.ts) has somewhere to compose the Agentic Thought bullet. create_pane's
  // action effect (src/actions/defs/panes_write.ts) auto-sets coreState.activePaneId AND broadcasts
  // switch_active_pane the moment the pane is created — no extra focus step needed server-side.
  await page.getByText("New project").click();
  const modal = page.getByTestId("orbital-modal");
  await expect(modal).toBeVisible();
  await page.getByTestId("newproject-name").fill("Incident Replay");
  await page.getByPlaceholder("~/code/notifications").fill(".");
  await modal.getByText("Open it up").click();
  const projRow = page.locator('[data-testid^="project-row-"]', { hasText: "Incident Replay" });
  await expect(projRow).toBeVisible({ timeout: 15_000 });
  await projRow.click();
  const projectId = (await projRow.getAttribute("data-testid"))!.replace("project-row-", "");

  // The sidebar row click above is a CLIENT-ONLY view selection (setSelected in src/orbital/views/
  // Line.tsx) — it does NOT move the SERVER's manager.ledger.activeProjectId. appendActiveDraft
  // (server.ts) composes against `activeDraftTarget()`, which resolves its project id from THAT
  // server-side field (falling back to "default_project" otherwise) — without this explicit switch,
  // the incident replay's Agentic Thought bullet would be appended under the WRONG workspace and the
  // Order Pad assertion below would see an empty draft. Same REST call e2e/live_kitchen.spec.ts uses
  // (ungated: switch_context's REST twin, src/actions/defs/orient.ts). `/api/*` requires the
  // auth_token cookie (authMiddleware) — `page.request` shares the browser context's cookie jar
  // (auto-seeded by the server's loopback-peer middleware on page load), unlike the standalone
  // `request` fixture used for the auth-EXEMPT `/__scripted_live__/*` control channel elsewhere in
  // this file.
  const switched = await page.request.post(`/api/projects/${projectId}/switch`);
  expect(switched.ok()).toBeTruthy();

  await page.getByTestId("pass-jot-input").fill("incident replay ticket");
  await page.getByTestId("pass-jot-add").click();
  await expect(page.getByTestId("pass-ticket")).toHaveCount(1);
  await page.getByTestId("pass-ticket-fire").click();
  await expect(modal).toBeVisible();
  await page.getByTestId("newpane-name").fill("incident pane");
  await modal.getByText("Custom", { exact: true }).click();
  await modal.getByText("let 'em cook").click();
  await modal.getByText("Fire it up").click();

  // create_pane defaults to Ask -> 202 -> action_pending -> confirm at the pass (tolerant of an Auto
  // resolution too, mirroring live_kitchen.spec.ts's own tolerance).
  const actionDialog = page.getByTestId("action-dialog");
  const stationCard = page.locator('[data-testid="station-card"]');
  await expect(actionDialog.or(stationCard.first())).toBeVisible({ timeout: 30_000 });
  if (await actionDialog.isVisible()) {
    await expect(actionDialog).toContainText("create_pane");
    await page.getByTestId("action-confirm").click();
  }
  await expect(stationCard).toHaveCount(1, { timeout: 60_000 });

  // The incident sentence must be ABSENT before the replay starts (sanity: proves the count-delta
  // check below, and the hasText filter, aren't vacuously true from stale state).
  const incidentBubbles = transcriptBubbles(page).filter({ hasText: JOINED_INCIDENT });
  await expect(incidentBubbles).toHaveCount(0);
  // Baseline AFTER the create-pane setup's own AnnouncementBus noise (see transcriptBubbles' CAVEAT
  // doc comment) — whatever unrelated bubbles that produced, this is the count right before the
  // incident replay's own frames start landing.
  const baselineCount = await transcriptBubbles(page).count();

  // ── replay the committed incident trace verbatim, in order, over the control channel ──
  const entries = loadTrace(INCIDENT_TRACE);
  expect(entries).toHaveLength(11); // 10 outputTranscription fragments + 1 turnComplete
  for (const entry of entries) {
    await emitScripted(request, entry.message);
  }

  // ── EXACTLY ONE Janus bubble holds the raw-concatenated sentence — not 10 separate fragment
  // bubbles (a regression back to per-fragment flushing would leave this at 0, since no single
  // fragment's bubble contains the full joined text) ──
  await expect(incidentBubbles).toHaveCount(1);
  // ── AND the replay added EXACTLY ONE bubble in total (rules out 10 fragment bubbles landing
  // ALONGSIDE a coincidentally-also-present full-text one, which the hasText check alone couldn't) ──
  await expect(transcriptBubbles(page)).toHaveCount(baselineCount + 1);

  // ── EXACTLY ONE Order Pad bullet, same text — opened LAST (see the ordering note above): the
  // textarea's initial GET (useDraft's mount effect) fetches whatever appendActiveDraft already
  // persisted server-side while composing the bubble above, so opening the burner only now still
  // observes the correct final draft. ──
  await stationCard.first().click();
  await expect(page.getByTestId("burner")).toBeVisible();
  await expect(page.getByTestId("burner-draft")).toHaveValue(agenticBullet(JOINED_INCIDENT));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SCENARIO 2 — BARGE-IN.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
test("barge-in: a partial thought flushes exactly once on interrupted, and a subsequent turnComplete does not double-flush", async ({ page, request }) => {
  await boot(page);
  await goLive(page); // settles with exactly the one-time "Mic's blocked" noise bubble landed (see goLive's doc comment)
  const baselineCount = await transcriptBubbles(page).count();

  // Same fragments/joined text as tests/test_voice_thought_buffer.ts scenario (b) — this is the SAME
  // contract, pinned here through a real browser + real WS instead of an in-process emit().
  const fragments = ["Wait", " I need", " to stop."];
  const joined = "Wait I need to stop.";
  for (const text of fragments) {
    await emitScripted(request, { serverContent: { outputTranscription: { text } } });
  }
  await emitScripted(request, { serverContent: { interrupted: true } });

  const bargeInBubble = transcriptBubbles(page).filter({ hasText: joined });
  await expect(bargeInBubble).toHaveCount(1);
  await expect(transcriptBubbles(page)).toHaveCount(baselineCount + 1); // exactly ONE new bubble, not 3 (one per fragment)

  // A subsequent turnComplete arrives with an EMPTY pendingModelThinking buffer (flushModelThinking
  // already drained + cleared it on the interrupted branch) — it must produce NOTHING.
  await emitScripted(request, { serverContent: { turnComplete: true } });

  // Condition-based proof of "nothing happened" (no sleep): a distinguishable operator-utterance
  // envelope is emitted AFTER the turnComplete and its own frame is awaited via toContainText. WS
  // frames on one connection are delivered in send order, and every control-channel POST here is
  // fully awaited (200) before the next is issued, so by the time THIS marker text is on screen, any
  // effect the turnComplete emit could have had (a second Janus bubble, had the fix regressed) has
  // already been delivered and rendered too — a same-tick React state update from one onmessage
  // dispatch cannot be reordered behind a later WS message on the same socket.
  const GHOST_CHECK = "ghost-bubble check — no post-interrupt double flush";
  await emitScripted(request, { serverContent: { inputTranscription: { text: GHOST_CHECK } } });
  await expect(page.getByTestId("radio-transcript")).toContainText(GHOST_CHECK);

  // Exactly 2 NEW bubbles total since goLive: the ONE Janus barge-in flush + the ONE User marker line
  // — never a 3rd (which a re-flushed empty-buffer turnComplete, or a doubled interrupted flush, would
  // produce), and the barge-in bubble is still the only one holding the joined text.
  await expect(transcriptBubbles(page)).toHaveCount(baselineCount + 2);
  await expect(bargeInBubble).toHaveCount(1);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SCENARIO 3 — CHANNEL LOST / RESTORED (the real-socket path — POST /__scripted_live__/close, not
// the harness-injected voice_channel_lost Wave 1 already covers headlessly).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
test("channel lost/restored: closing the scripted Gemini session broadcasts voice_channel_lost, then the server's own bounded auto-reconnect broadcasts voice_channel_restored", async ({ page, request }) => {
  await boot(page);

  // Tap the REAL `/live` voice WS's raw frames (attached BEFORE "go live" so the socket-open event is
  // never missed) — this is the ground truth the frontend's own voice_channel_lost/_restored handlers
  // (src/orbital/useOrbitalData.ts) react to, and the most precise way to pin "the REAL server's
  // voice_channel_lost frame drives" the rail without relying on a UI surface the mic-blocked mask
  // (see the file header) hides in this headless lane. `/live?observe=1` (the always-on data lane) is
  // excluded by the `endsWith` check below — only the voice socket carries these frame types anyway.
  const liveFrames: Record<string, unknown>[] = [];
  page.on("websocket", (ws) => {
    if (!ws.url().endsWith("/live")) return;
    ws.on("framereceived", (f) => {
      try {
        const msg = JSON.parse(String(f.payload));
        if (msg && typeof msg.type === "string") liveFrames.push(msg);
      } catch {
        /* non-JSON / binary (audio) frame — not a state-transition frame, ignore */
      }
    });
  });

  await goLive(page);

  // Prove the scripted session is genuinely wired end-to-end BEFORE dropping it (also the same
  // "settle" the existing scripted_voice.spec.ts control-channel round-trip relies on).
  await emitScripted(request, { serverContent: { inputTranscription: { text: "channel check before drop" } } });
  await expect(page.getByTestId("radio-transcript")).toContainText("channel check before drop");

  // The Kitchen Radio chip is PINNED on "MIC BLOCKED" throughout this lane (see file header) —
  // documented explicitly here, both before and after the drop, rather than silently skipped.
  const chip = page.getByTestId("kitchen-radio").locator('[role="status"][aria-live="polite"]');
  await expect(chip).toContainText("MIC BLOCKED");

  // ── drop the scripted Gemini session (simulates a real Gemini-side socket close) ──
  const closeRes = await request.post("/__scripted_live__/close", { data: {} });
  expect(closeRes.status()).toBe(200);
  expect((await closeRes.json()).ok).toBe(true);

  // ── read the REAL server's own reconnect semantics (src/voice/index.ts): onclose -> handleSessionLost
  // ("closed") broadcasts voice_channel_lost{reason:"closed"} (not permanent — the bounded reconnect
  // budget is fresh), then schedules ONE reconnect at RECONNECT_BASE_DELAY_MS (default 500ms, no lane
  // override here). That reconnect re-enters connectLiveSession, which calls the STILL-INSTALLED
  // scripted connector again (installScriptedLiveConnector's module-level `currentSession` swap is
  // exactly what makes this possible with zero API key) — hoisting the new session broadcasts
  // voice_channel_restored (voiceLostSinceLastRestore was armed by the loss). Net: the server
  // AUTO-HEALS a scripted-lane drop with NO further UI action — "go live" is clicked exactly once in
  // this test. That auto-heal is the real behavior pinned below (not a UI re-click). ──
  await expect(page.getByTestId("toast")).toContainText("Back on the air.", { timeout: 10_000 });

  // The chip is STILL masked "MIC BLOCKED" after the auto-heal too (blocked outranks reconnecting AND
  // the post-reconnect steady "listening" rung in the precedence ladder — the mic was never re-armed
  // because no fresh "go live" click happened).
  await expect(chip).toContainText("MIC BLOCKED");

  // ── the raw WS frame contract, captured independent of any UI masking ──
  const lostIdx = liveFrames.findIndex((f) => f.type === "voice_channel_lost");
  expect(lostIdx, `expected a voice_channel_lost frame; got: ${JSON.stringify(liveFrames)}`).toBeGreaterThanOrEqual(0);
  expect(liveFrames[lostIdx]).toMatchObject({ type: "voice_channel_lost", reason: "closed" });
  expect(liveFrames[lostIdx].permanent).not.toBe(true); // a bounded transient drop, not exhaustion
  const restoredIdx = liveFrames.findIndex((f) => f.type === "voice_channel_restored");
  expect(restoredIdx, `expected a voice_channel_restored frame; got: ${JSON.stringify(liveFrames)}`).toBeGreaterThan(lostIdx);

  // ── prove the NEW post-reconnect session is genuinely live, not just a broadcast frame ──
  await emitScripted(request, { serverContent: { inputTranscription: { text: "channel check after reconnect" } } });
  await expect(page.getByTestId("radio-transcript")).toContainText("channel check after reconnect");
});
