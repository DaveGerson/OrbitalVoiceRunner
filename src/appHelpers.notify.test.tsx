/**
 * BUG-037 (b) — the classic approval path must REQUEST notification permission on the first
 * approval_pending. `requestNotifyPermission()` exists (src/utils/notify.ts:20-26) and self-guards on
 * `Notification.permission === "default"`, but it is wired ONLY to the orbital radio tune-in — the
 * classic `handleApprovalPending` (src/appHelpers.ts:431) never calls it, so a browser that has never
 * been asked stays on the default (no desktop notification will ever fire, because
 * triggerDesktopNotification no-ops until granted).
 *
 * REQUIRED POST-FIX BEHAVIOR pinned here:
 *   - On an approval_pending, when Notification.permission === "default", the app requests permission
 *     exactly once (reusing the guarded requestNotifyPermission()).
 *   - Once the browser has decided (granted / denied), it is NEVER re-requested.
 *   - triggerDesktopNotification is untouched (still gated on granted) — this test only pins the
 *     REQUEST, not the firing.
 *
 * The request is driven through the real WS dispatcher `dispatchWsMessage(msg, ctx)` -> the mapped
 * `approval_pending` handler (appHelpers WS_HANDLERS). We observe the browser API directly via a spy
 * on `Notification.requestPermission`, so this pins the BEHAVIOR regardless of whether the fix calls
 * requestNotifyPermission() directly or via an injected seam.
 *
 * Harness: vitest + jsdom (window.Notification is stubbed in vitest.setup.ts). This must run under
 * vitest, not node:test — the guard reads `window.Notification`, which does not exist under node.
 *
 * Runner: npx vitest run --config vitest.config.ts src/appHelpers.notify.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchWsMessage } from "./appHelpers";

const NotificationRef = window.Notification as unknown as {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
};

/** A minimal WS-handler ctx carrying only what handleApprovalPending touches. */
function makeCtx() {
  return {
    playEarcon: vi.fn(),
    triggerDesktopNotification: vi.fn(),
    setPendingCommands: vi.fn(),
  };
}

function approvalPending(messageId = "m1") {
  return { type: "approval_pending", messageId, cmd: "npm test", terminalId: "pane_1" };
}

let requestSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  NotificationRef.permission = "default";
  requestSpy = vi.spyOn(NotificationRef, "requestPermission").mockResolvedValue("granted" as NotificationPermission);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BUG-037 (b) — approval_pending requests notification permission", () => {
  it("requests permission when permission is 'default' (RED until the classic path is wired)", () => {
    NotificationRef.permission = "default";
    dispatchWsMessage(approvalPending("m1"), makeCtx() as any);
    // RED: handleApprovalPending does not request permission today.
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("does not re-request once the browser has decided (granted between pendings)", () => {
    NotificationRef.permission = "default";
    dispatchWsMessage(approvalPending("m1"), makeCtx() as any);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    // The browser resolves the prompt -> permission is no longer 'default'. A later pending must NOT
    // ask again (the requestNotifyPermission guard is permission-state based).
    NotificationRef.permission = "granted";
    dispatchWsMessage(approvalPending("m2"), makeCtx() as any);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("regression guard: never requests when already granted", () => {
    NotificationRef.permission = "granted";
    dispatchWsMessage(approvalPending("m3"), makeCtx() as any);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("regression guard: never re-requests when denied", () => {
    NotificationRef.permission = "denied";
    dispatchWsMessage(approvalPending("m4"), makeCtx() as any);
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
