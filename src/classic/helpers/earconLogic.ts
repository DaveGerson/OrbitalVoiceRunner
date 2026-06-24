// src/classic/helpers/earconLogic.ts — pure, browser-API-free decision helper for the earcon /
// desktop-notification hook (useEarcons). Extracted out of src/App.tsx (bead dbt4 — App.tsx
// decomposition, mirroring the src/hooks/liveSessionLogic.ts gold-standard seam). The Web-Audio
// earcon GRAPH is irreducibly browser-coupled and stays in the hook; this module pins the ONE pure
// piece — the gate that decides whether triggerDesktopNotification should actually post a Notification.
//
// Behavior is VERBATIM from the original App.tsx body:
//   triggerDesktopNotification fired iff
//     browserNotificationsEnabled && "Notification" in window && Notification.permission === "granted"
// so the predicate here returns true on exactly that conjunction. See tests/test_earcon_logic.ts.

/**
 * Whether a desktop Notification should be posted, given the operator toggle, whether the
 * Notification API exists on the host, and the current permission grant. Pure: the caller reads
 * `"Notification" in window` / `Notification.permission` (browser globals) and passes the values in.
 */
export function shouldNotify(
  browserNotificationsEnabled: boolean,
  hasNotificationApi: boolean,
  permission: string,
): boolean {
  return browserNotificationsEnabled && hasNotificationApi && permission === "granted";
}
