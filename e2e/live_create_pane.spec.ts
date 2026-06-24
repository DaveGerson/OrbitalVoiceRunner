import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

/**
 * LIVE lane (operator decision D6 = Real-server / LIVE lane) — the create-pane KEYSTONE driven
 * THROUGH the real capability gate, asserting the GATED OUTCOME end-to-end. Runs ONLY under the
 * "live" Playwright project (`npm run test:e2e:live` → PW_LIVE=1 → real `tsx server.ts` on a fresh
 * temp JANUS_DB, real PTYs, real gate engine; boots WITHOUT a GEMINI key). NO ?mock=1 — every
 * branch below crosses the real wire (PUT /api/settings → the gate matrix; POST /api/terminals →
 * the create_pane gateOrDefer; POST /api/actions/:id/confirm → the staged spawn).
 *
 * This file drives the REST create endpoint DIRECTLY (the task's fallback when no
 * data-testid='create-deploy' affordance exists — none does as of this writing) so the proof is
 * pinned to the gate's STATUS-VIA-KINDS contract, not UI chrome:
 *   create_pane gate Off  → 403 { error: "…gated Off…" }   → NO phantom pane (count unchanged)
 *   create_pane gate Ask  → 202 { status:"pending_approval", messageId } → 0 panes until CONFIRM;
 *                           confirming the action materializes EXACTLY ONE pane
 *   create_pane gate Auto → 200 { output }                 → EXACTLY ONE pane, immediately
 *
 * GET /api/terminals returns the FLAT array of ALL live `manager.terminals` (global, not active-
 * project-scoped — src/actions/registry.ts list_panes rest surface), so the phantom-pane assertion
 * is exact: a blocked/deferred create leaves the live terminal set untouched.
 *
 * Shares ONE live server with the other live_*.spec.ts files (single worker, filename order). All
 * names here are unique to this file and every pane it creates is 86'd at the end so the shared
 * board is left clean for later specs.
 */
test.describe.configure({ mode: "serial" });

const RUN = Math.random().toString(36).slice(2, 7);
const PROJECT_ID = `cp-${RUN}`;
const PROJECT_DIR = ".";

// Count live panes by id from the global GET /api/terminals flat array (server truth).
async function paneIds(req: APIRequestContext): Promise<string[]> {
  const res = await req.get("/api/terminals");
  expect(res.ok()).toBeTruthy();
  const data = (await res.json()) as Array<{ id: string }>;
  expect(Array.isArray(data)).toBeTruthy();
  return data.map((t) => t.id);
}

// PUT /api/settings, setting ONLY the create_pane global gate (a permissive passthrough merge — we
// re-read first so we never clobber unrelated settings the live server already holds).
async function setCreatePaneGate(req: APIRequestContext, mode: "Off" | "Ask" | "Auto"): Promise<void> {
  const current = await (await req.get("/api/settings")).json();
  const advanced = { ...(current.advanced ?? {}) };
  advanced.capabilityGates = { ...(advanced.capabilityGates ?? {}), create_pane: mode };
  const res = await req.put("/api/settings", { data: { ...current, advanced } });
  expect(res.ok(), `PUT /api/settings (create_pane=${mode}) should succeed`).toBeTruthy();
}

// POST the REST create-pane body the UI sends (App.tsx handleCreateTerminal): camelCase keys, a
// Custom preset (a bare shell — exists on every box; no agent binary needed in the live lane).
async function postCreate(req: APIRequestContext, terminalId: string) {
  return req.post("/api/terminals", {
    data: {
      terminalId,
      cwd: PROJECT_DIR,
      command: "",            // Custom + empty → server derives the bare defaultShellCommand
      toolPreset: "Custom",
      permissionsMode: "Human-in-the-Loop",
      projectId: PROJECT_ID,
    },
  });
}

async function boot(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("tab-line")).toBeVisible();
  // confirm we're on the REAL server (the ?mock=1 harness never armed)
  expect(await page.locator("html[data-e2e-ready='1']").count()).toBe(0);
  await expect(page.getByTestId("kitchen-status")).toContainText("Kitchen open", { timeout: 30_000 });
}

// CROSS-SPEC HYGIENE: each test below mutates the GLOBAL create_pane gate (Off/Ask/Auto). If a test
// body throws mid-flight (before its inline restore/stop runs), the shared live server would be left
// with the gate stuck and orphan panes alive — corrupting the alphabetically-later live_* specs,
// which all assume create_pane defaults to Ask on this single shared server. This afterEach is the
// unconditional safety net: it runs on PASS *and* on FAILURE/RETRY. It drives `page.request` (the
// browser context's APIRequestContext, which carries the auto-seeded auth cookie — the worker-scoped
// `request` fixture is NOT keyed and every /api call 401s), and Playwright keeps the page alive
// through afterEach, so the board + gate are reliably reset before the next spec runs.
test.afterEach(async ({ page }) => {
  const req = page.request;
  // (a) restore the global create_pane gate to its default (Ask) for the next spec. Best-effort:
  //     if the body died before the page rendered (no auth cookie) this throws — swallow it so a
  //     body failure isn't masked by a cleanup failure; the next spec's own boot reseeds defaults.
  try {
    await setCreatePaneGate(req, "Ask");
  } catch {
    // page never rendered / server unreachable — leave the body's real failure to surface
  }
  // (b) best-effort 86 any pane this file spawned this run (ids: cp-*-${RUN}); already-stopped
  //     panes (the inline cleanup beat us to it) just no-op, so swallow every stop error.
  let ids: string[] = [];
  try {
    ids = await paneIds(req);
  } catch {
    return; // server unreachable — nothing we can clean up
  }
  for (const id of ids) {
    if (!id.startsWith("cp-") || !id.endsWith(`-${RUN}`)) continue;
    try {
      await req.post(`/api/projects/${PROJECT_ID}/panes/${id}/stop`);
    } catch {
      // already gone / racing inline cleanup — ignore
    }
  }
});

test("create-pane gated Off → 403 and NO phantom pane; gated Auto → 200 and EXACTLY one pane", async ({ page }) => {
  await boot(page);
  const req = page.request;

  // A real project for the PTY spawn (create_pane would auto-create it, but we make it the ACTIVE
  // context the way a real operator would — the same REST routes live_kitchen/live_journeys ride).
  const made = await req.post("/api/projects", { data: { id: PROJECT_ID, directory: PROJECT_DIR } });
  expect(made.ok()).toBeTruthy();
  const switched = await req.post(`/api/projects/${PROJECT_ID}/switch`);
  expect(switched.ok()).toBeTruthy();

  // ── BLOCKED: gate create_pane Off → the POST is refused 403, and NO pane is born ──
  await setCreatePaneGate(req, "Off");
  const before = await paneIds(req);
  const blockedId = `cp-blocked-${RUN}`;
  const blocked = await postCreate(req, blockedId);
  expect(blocked.status(), "create_pane gated Off must refuse with 403").toBe(403);
  const blockedBody = await blocked.json();
  expect(blockedBody.error, "the 403 body carries the gated-Off refusal").toContain("gated Off");

  // the refusal left ZERO residue: no new terminal, and certainly not the one we asked for.
  const afterBlocked = await paneIds(req);
  expect(afterBlocked, "a blocked create must not spawn a phantom pane").toEqual(before);
  expect(afterBlocked).not.toContain(blockedId);

  // ── ALLOWED: gate create_pane Auto → 200, and EXACTLY one new pane materializes ──
  await setCreatePaneGate(req, "Auto");
  const allowedId = `cp-allowed-${RUN}`;
  const allowed = await postCreate(req, allowedId);
  expect(allowed.status(), "create_pane gated Auto must run immediately (200)").toBe(200);

  // server truth: the real PTY joined manager.terminals — exactly ONE new pane, the one we asked
  // for, and no others appeared (the count grew by precisely one over the pre-create snapshot).
  await expect
    .poll(async () => (await paneIds(req)).includes(allowedId), { timeout: 60_000 })
    .toBe(true);
  const afterAllowed = await paneIds(req);
  expect(afterAllowed.length, "exactly one pane was created").toBe(before.length + 1);
  expect(afterAllowed.filter((id) => id === allowedId).length, "exactly one pane has our id").toBe(1);

  // cleanup: 86 the live pane so the shared board is left clean for the next live spec.
  const stopped = await req.post(`/api/projects/${PROJECT_ID}/panes/${allowedId}/stop`);
  expect(stopped.ok()).toBeTruthy();
});

test("create-pane gated Ask → 202 pending (no pane), confirming materializes EXACTLY one pane", async ({ page }) => {
  await boot(page);
  const req = page.request;
  // The project + active context persist across this serial file (one live server); re-assert to
  // decouple this test from the first's ordering and to be explicit about the active target.
  const switched = await req.post(`/api/projects/${PROJECT_ID}/switch`);
  expect(switched.ok()).toBeTruthy();

  // ── DEFERRED: gate create_pane Ask → 202 pending; the pane does NOT exist yet ──
  await setCreatePaneGate(req, "Ask");
  const before = await paneIds(req);
  const askId = `cp-ask-${RUN}`;
  const deferred = await postCreate(req, askId);
  expect(deferred.status(), "create_pane gated Ask must DEFER (202)").toBe(202);
  const body = await deferred.json();
  expect(body.status).toBe("pending_approval");
  const messageId = body.messageId as string;
  expect(messageId, "the 202 carries the pending action id to confirm against").toBeTruthy();

  // the deferred create staged the spawn but ran NOTHING — no pane until the operator confirms.
  expect(await paneIds(req), "an Ask-deferred create must not spawn before confirm").toEqual(before);

  // the pending action is queued and addressable on the REST approvals surface.
  const pending = await (await req.get("/api/actions/pending")).json();
  expect(
    (pending as Array<{ id: string }>).some((a) => a.id === messageId),
    "the queued create_pane action is listed as pending",
  ).toBeTruthy();

  // ── confirm at the pass → the staged spawn fires → EXACTLY one pane materializes ──
  const confirmed = await req.post(`/api/actions/${messageId}/confirm`);
  expect(confirmed.ok(), "confirming the pending create_pane should 200").toBeTruthy();

  await expect
    .poll(async () => (await paneIds(req)).includes(askId), { timeout: 60_000 })
    .toBe(true);
  const afterConfirm = await paneIds(req);
  expect(afterConfirm.length, "the confirmed deferral created exactly one pane").toBe(before.length + 1);
  expect(afterConfirm.filter((id) => id === askId).length).toBe(1);

  // cleanup: 86 the live pane (leave the shared board clean for later live specs).
  const stopped = await req.post(`/api/projects/${PROJECT_ID}/panes/${askId}/stop`);
  expect(stopped.ok()).toBeTruthy();
});
