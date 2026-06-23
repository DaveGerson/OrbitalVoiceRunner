import { test as base, expect, type Page } from "@playwright/test";

/**
 * Shared e2e fixtures. `gotoMockedApp` loads the app in the deterministic ?mock=1
 * harness and waits for it to signal readiness. The inject* helpers drive the app
 * through window.__ORBITAL_E2E__ (wired to the real client handlers in App.tsx),
 * so specs exercise the actual render paths with mocked inputs.
 */

declare global {
  interface Window {
    __ORBITAL_E2E__?: {
      injectStdoutChunk: (terminalId: string, chunk: string) => void;
      injectTranscript: (sender: "User" | "Janus", text: string) => void;
      injectGrounding: (queries: string[], sources: { uri: string; title: string }[]) => void;
      injectPendingApproval: (cmd: string, terminalId?: string, posture?: "OPEN" | "GUARDED" | "LOCKED") => void;
      injectPendingAction: (capability: string, summary: string, posture?: "OPEN" | "GUARDED" | "LOCKED") => void;
      injectWipDraft: (paneId: string, text: string) => void;
      simulateDisconnect: () => void;
      simulateReconnect: () => string | null;
      setPostureMock: (posture: "OPEN" | "GUARDED" | "LOCKED", effectiveGates: Record<string, "Auto" | "Ask" | "Off">) => void;
      /** bead ahz: seed a MALFORMED posture word (crash-safety regression — chip must degrade, not white-screen). */
      injectMalformedPosture: (posture: string, effectiveGates?: Record<string, "Auto" | "Ask" | "Off">) => void;
      setFrozenMock: (frozen: boolean, running: string[]) => void;
      switchActivePane: (paneId: string) => void;
      /** 1B.1/1B.5: stage the kitchen's connection truth-states (no real sockets under ?mock=1). */
      setConnMock: (s: { stream?: boolean; voice?: boolean; micBlocked?: boolean }) => void;
      /** 2K.3: stage a server-pushed draft_updated for a pane (kitchen Order Pad mirror). */
      injectDraftUpdate: (paneId: string, text: string) => void;
      /** 2K.1: flip a seeded mock pane's status (drives Clear-exited / confirm-free 86). */
      setPaneStatusMock: (paneId: string, status: "Running" | "Idle" | "Exited") => void;
      /** 3C.1: feed a frame through the REAL observe-lane WS switch (kitchen only). */
      injectWsFrame: (frame: unknown) => void;
      /** 3C.2: model an observe-socket drop/reopen → TerminalView resync-with-marker (kitchen only). */
      simulateStreamReconnect: () => void;
    };
  }
}

/**
 * 3C.3b: pre-arm the mock-mode REAL wire. Mock-mode mutations (settings PUT, pane lifecycle POSTs,
 * raw-input, resize, drafts, notes) only hit the network when `window.__ORBITAL_E2E_WIRE__` was
 * set by this init script BEFORE the bundle ran. Specs that intercept + assert the wire must call
 * this BEFORE their page.goto; a human's manual ?mock=1 (no init script) stays fully client-side
 * and can never clobber a live deployment.
 */
export async function armE2EWire(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __ORBITAL_E2E_WIRE__?: boolean }).__ORBITAL_E2E_WIRE__ = true;
  });
}

export const MOCK_TERMINAL_ID = "mock_pane_1";
export const MOCK_TERMINAL_ID_2 = "mock_pane_2";

export async function gotoMockedApp(page: Page): Promise<void> {
  // The kitchen is now the default app; the classic app (which this suite exercises) is pinned via
  // ?ui=classic so the classic coverage stays green alongside the kitchen's own e2e suite.
  await armE2EWire(page); // 3C.3b: classic specs assert real wires under mock too
  await page.goto("/?ui=classic&mock=1");
  // The harness sets this attribute once mock data is seeded and hooks installed.
  await page.waitForSelector("html[data-e2e-ready='1']", { timeout: 15_000 });
  await expect(page.getByTestId("terminal-pane")).toBeVisible();
}

export async function injectStdoutChunk(page: Page, terminalId: string, chunk: string): Promise<void> {
  await page.evaluate(
    ([id, c]) => window.__ORBITAL_E2E__?.injectStdoutChunk(id, c),
    [terminalId, chunk] as const,
  );
}

export async function injectTranscript(page: Page, sender: "User" | "Janus", text: string): Promise<void> {
  await page.evaluate(
    ([s, t]) => window.__ORBITAL_E2E__?.injectTranscript(s as "User" | "Janus", t),
    [sender, text] as const,
  );
}

/** aqx (build-out): attach grounded queries/sources to the most recent Janus turn (drives the chip). */
export async function injectGrounding(
  page: Page,
  queries: string[],
  sources: { uri: string; title: string }[],
): Promise<void> {
  await page.evaluate(
    ([q, s]) => window.__ORBITAL_E2E__?.injectGrounding(q as string[], s as { uri: string; title: string }[]),
    [queries, sources] as const,
  );
}

export async function injectPendingApproval(
  page: Page,
  cmd: string,
  terminalId = MOCK_TERMINAL_ID,
  posture?: "OPEN" | "GUARDED" | "LOCKED",
): Promise<void> {
  // Capture the approval-dialog count BEFORE injecting so we can wait for +1, serializing
  // sequential calls even when React batches state updates under parallel-suite load.
  const before = await page.locator('[data-testid="approval-dialog"]').count();
  await page.evaluate(
    ([c, id, p]) => window.__ORBITAL_E2E__?.injectPendingApproval(
      c as string,
      id as string,
      p as "OPEN" | "GUARDED" | "LOCKED" | undefined,
    ),
    [cmd, terminalId, posture] as const,
  );
  // Wait until the injected approval is actually rendered before returning, so two sequential
  // injectPendingApproval() calls serialize deterministically (the second call cannot fire its
  // evaluate until React has committed the first dialog to the DOM).
  await page.waitForFunction(
    (expectedCount) => document.querySelectorAll('[data-testid="approval-dialog"]').length >= expectedCount,
    before + 1,
  );
}

export async function injectPendingAction(
  page: Page,
  capability: string,
  summary: string,
  posture?: "OPEN" | "GUARDED" | "LOCKED",
): Promise<void> {
  await page.evaluate(
    ([c, s, p]) => window.__ORBITAL_E2E__?.injectPendingAction(
      c as string,
      s as string,
      p as "OPEN" | "GUARDED" | "LOCKED" | undefined,
    ),
    [capability, summary, posture] as const,
  );
}

/** U3: stage a WIP draft for `paneId` so the Sync Spec tab's draft-pending badge can be exercised. */
export async function injectWipDraft(page: Page, paneId: string, text: string): Promise<void> {
  await page.evaluate(
    ([p, t]) => window.__ORBITAL_E2E__?.injectWipDraft(p, t),
    [paneId, text] as const,
  );
}

/** WS-F (spec §6.1): model a WS drop. The harness KEEPS staged survivors (detach, not purge). */
export async function simulateDisconnect(page: Page): Promise<void> {
  await page.evaluate(() => window.__ORBITAL_E2E__?.simulateDisconnect());
}

/**
 * WS-F (spec §6.2/§7): model a reconnect. The harness pushes ONE batched resumption digest across the
 * surviving staged items and returns it (or `null` when there were none → silent). Chips repopulate.
 */
export async function simulateReconnect(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__ORBITAL_E2E__?.simulateReconnect() ?? null);
}

/** bead 8sq: set the mock pane's server-resolved posture so the GateChip renders deterministically. */
export async function setPostureMock(
  page: Page,
  posture: "OPEN" | "GUARDED" | "LOCKED",
  effectiveGates: Record<string, "Auto" | "Ask" | "Off">,
): Promise<void> {
  await page.evaluate(
    ([p, g]) => window.__ORBITAL_E2E__?.setPostureMock(p as "OPEN" | "GUARDED" | "LOCKED", g as Record<string, "Auto" | "Ask" | "Off">),
    [posture, effectiveGates] as const,
  );
}

/**
 * bead ahz: seed a MALFORMED server posture word (one outside OPEN|GUARDED|LOCKED) so the spec can
 * prove the n2r normalizers degrade the gate chip gracefully instead of throwing during render and
 * white-screening the cockpit. `effectiveGates` defaults to the harness default mock gates.
 */
export async function injectMalformedPosture(
  page: Page,
  posture: string,
  effectiveGates?: Record<string, "Auto" | "Ask" | "Off">,
): Promise<void> {
  await page.evaluate(
    ([p, g]) => window.__ORBITAL_E2E__?.injectMalformedPosture(
      p as string,
      g as Record<string, "Auto" | "Ask" | "Off"> | undefined,
    ),
    [posture, effectiveGates] as const,
  );
}

/** bead 8sq: drive the two-stage STOP-ALL FROZEN banner (frozen flag + still-running pane count). */
export async function setFrozenMock(page: Page, frozen: boolean, running: string[] = []): Promise<void> {
  await page.evaluate(
    ([f, r]) => window.__ORBITAL_E2E__?.setFrozenMock(f as boolean, r as string[]),
    [frozen, running] as const,
  );
}

/**
 * f06: switch the active pane via the REAL setActiveTerminalId path (the same a tile click fires),
 * with NO terminals_updated / ledger_updated broadcast — the condition under which the context body
 * must still flip in-frame from the local ledger.
 */
export async function switchActivePane(page: Page, paneId: string): Promise<void> {
  await page.evaluate((id) => window.__ORBITAL_E2E__?.switchActivePane(id), paneId);
}

/**
 * bead e7h: seed the attention inbox by driving a REAL `attention_updated` frame through the
 * observe-lane switch (injectWsFrame → handleObserveFrame → setAttentionQueue) — the same path the
 * live socket uses. Each row is a full AttentionItem; pass a `messageId` to make a row resolvable
 * in-inbox (real Approve/Deny) and omit it for a triage-only row.
 */
export async function injectAttention(
  page: Page,
  items: { id: string; type: string; terminalId: string; message: string; messageId?: string }[],
): Promise<void> {
  await page.evaluate((rows) => {
    window.__ORBITAL_E2E__?.injectWsFrame({
      type: "attention_updated",
      queue: rows.map((r) => ({
        id: r.id, type: r.type, terminalId: r.terminalId, projectId: "default_project",
        message: r.message, timestamp: new Date().toISOString(), dismissed: false,
        ...(r.messageId ? { messageId: r.messageId } : {}),
      })),
    });
  }, items);
}

/**
 * bead 8xn: drive an `approval_pending` frame through the REAL observe-lane switch (injectWsFrame →
 * handleObserveFrame → the isApprovalHere router), NOT injectPendingApproval (which seeds
 * pendingCommands DIRECTLY, bypassing the focus-routing branch). This is the ONLY way to exercise the
 * modal-vs-inbox decision: a frame for the ACTIVE pane (+ visible tab) pops the modal; a frame for a
 * BACKGROUND pane lands in the attention inbox keyed by messageId.
 */
export async function injectApprovalPendingFrame(
  page: Page,
  cmd: string,
  terminalId: string,
  messageId: string,
): Promise<void> {
  await page.evaluate(
    ([c, t, m]) => window.__ORBITAL_E2E__?.injectWsFrame({
      type: "approval_pending", cmd: c, terminalId: t, messageId: m,
      rationale: { trigger: "e2e injected", summary: "Mocked approval_pending for focus-routing e2e." },
    }),
    [cmd, terminalId, messageId] as const,
  );
}

/**
 * bead 8xn: drive the server's `approval_resolved` broadcast through the REAL observe-lane switch
 * (injectWsFrame → handleObserveFrame), modelling a resolve on a NON-inbox surface — voice, a
 * cross-client REST approve/reject, the modal, or a TTL/dead-pane sweep. This is the only way to
 * exercise "resolve anywhere clears EVERYWHERE": the routed inbox row + held-approval badge must drop
 * even though the resolve never touched the inbox Approve button.
 */
export async function injectApprovalResolvedFrame(
  page: Page,
  messageId: string,
  outcome: "approved" | "rejected" | "drained" = "approved",
): Promise<void> {
  await page.evaluate(
    ([m, o]) => window.__ORBITAL_E2E__?.injectWsFrame({ type: "approval_resolved", messageId: m, outcome: o }),
    [messageId, outcome] as const,
  );
}

export const test = base;
export { expect };
