/**
 * WS-D (BUG-024): coalescing notification-stack model.
 *
 * Pure reducer for the on-screen proactive-notification stack. It STACKS BY status and
 * COALESCES: a new `proactive_notification` for the same id (pane + severity bucket,
 * keyed server-side in announcementBus) UPDATES the existing entry to the LATEST message
 * instead of spawning a duplicate toast. Entries are sorted by severity then recency and
 * are individually dismissible. Kept DOM-free so it is unit-testable.
 *
 * Redaction: the `message` arrives already WS-B redacted from the server; this reducer
 * never re-derives text from raw pane content.
 */

/**
 * The single proactive-notification shape, shared by the server-side AnnouncementBus
 * (which constructs it) and the client stack (which renders it). The earcon is delivered
 * out-of-band by the separate `proactive_earcon` broadcast, so it is intentionally NOT a
 * field here.
 */
export interface ProactiveNotification {
  id: string;
  kind: string;
  terminalId: string;
  severity: "high" | "normal";
  message: string;
  timestamp: string;
}

const SEVERITY_RANK: Record<string, number> = { high: 1, normal: 0 };

/** Insert-or-update by id (coalesce to latest), then sort by severity, then recency. */
export function upsertNotification(
  stack: ProactiveNotification[],
  incoming: ProactiveNotification
): ProactiveNotification[] {
  const existingIdx = stack.findIndex((n) => n.id === incoming.id);
  let next: ProactiveNotification[];
  if (existingIdx >= 0) {
    // Coalesce: replace the existing entry's content with the latest message.
    next = [...stack];
    next[existingIdx] = { ...incoming };
  } else {
    next = [...stack, { ...incoming }];
  }
  return sortNotifications(next);
}

export function dismissNotification(
  stack: ProactiveNotification[],
  id: string
): ProactiveNotification[] {
  return stack.filter((n) => n.id !== id);
}

export function sortNotifications(stack: ProactiveNotification[]): ProactiveNotification[] {
  return [...stack].sort((a, b) => {
    const sev = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (sev !== 0) return sev;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });
}
