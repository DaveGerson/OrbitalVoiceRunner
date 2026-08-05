/**
 * WS-D: SINGLE SOURCE OF TRUTH for per-announcement-kind metadata + the message-template
 * schema and its defaults.
 *
 * Previously the earcon mapping, severity bucket, priority ranking and template key were
 * spread across `announcementBus.ts`, `eventBus.ts`, `App.tsx` and `SettingsDialog.tsx` —
 * four copies that already drifted once (`exited` was mis-bucketed as normal severity while
 * carrying an `alert` earcon). This module collapses them into ONE compiler-enforced table:
 * adding a kind is a single object literal the type checker forces you to complete; there is
 * no second place to update.
 */

/** Status-keyed earcon vocabulary (App.tsx oscillator tones). BUG-018: "blocked" (command_blocked)
 *  and "permission" (permission_changed) are DISTINCT hands-free tones so an eyes-off operator can
 *  tell a held-back command / an autonomy change apart from a plain "alert" (an approval pending).
 *  "failure" (completion_failed, WS1) is likewise its own tone: a run that FAILED must never ring
 *  the same chime as a clean pass. */
export type EarconType = "completion" | "alert" | "success" | "execute" | "chime" | "blocked" | "permission" | "failure";

/** The earcon vocabulary as used by the client event bus, which may also yield "no earcon". */
export type EarconTypeOrNull = EarconType | null;

export type AnnouncementKind =
  | "completion"   // genuine WS-C Running->Idle edge (real work finished)
  | "completion_failed" // genuine Running->Idle edge whose settled outcome FAILED (WS1)
  | "error"        // error text detected
  | "build-failed" // build failure
  | "exited"       // process exited
  | "approval_pending" // a write is awaiting operator approval (WS-E HiTL arrival)
  | "approval_expired" // an unresolved approval crossed its TTL and was dropped
  | "plan_completed"
  | "plan_paused";

/** The operator-editable template keys (Settings surface). */
export type TemplateKey =
  | "completion"
  | "completionFailed"
  | "error"
  | "buildFailed"
  | "exited"
  | "approvalPending"
  | "approvalExpired"
  | "planCompleted"
  | "planPaused";

export interface KindMeta {
  /** Immediate non-verbal feedback tone. */
  earcon: EarconType;
  /** Severity bucket the notification stack groups by. */
  severity: "high" | "normal";
  /** Priority ranking — highest fires first when a coalescing window is flushed. */
  priority: number;
  /** Which operator-editable message template renders this kind. */
  templateKey: TemplateKey;
}

/**
 * The authoritative per-kind table. `Record<AnnouncementKind, KindMeta>` makes the compiler
 * reject any kind that omits a field or that is added without an entry here.
 *
 * `exited` is intentionally HIGH severity: it carries the `alert` earcon, gets its own
 * high-severity coalescing bucket, and is exempt from the per-pane debounce so a genuine
 * process exit is never starved by a preceding completion on the same pane (design §4).
 *
 * `approval_pending` / `approval_expired` (Phase 1 Track C, card 1C.1): the approval paths used
 * to BORROW kind:"exited" for its high severity, which rendered the exited template — the
 * notification literally claimed a healthy pane died. These are the REAL kinds: same high
 * severity + the EXISTING client-known "alert" earcon.
 *
 * `completion_failed` (WS1): a run that FAILED must not share the plain "completion" kind's
 * "ta-da" earcon or its normal-severity bucket — it gets the NEW "failure" earcon (added to the
 * client's playEarcon union in this same slice, the sanctioned BUG-018 path: server + client
 * unions updated together) and HIGH severity, ranked above the approval kinds (a failed run is a
 * more urgent signal than a pending approval) but below error/build-failed/exited (a process-level
 * failure still outranks an outcome-level one).
 */
export const KIND_META: Record<AnnouncementKind, KindMeta> = {
  "build-failed":     { earcon: "alert", severity: "high", priority: 8, templateKey: "buildFailed" },
  error:              { earcon: "alert", severity: "high", priority: 7, templateKey: "error" },
  exited:             { earcon: "alert", severity: "high", priority: 6, templateKey: "exited" },
  completion_failed:  { earcon: "failure", severity: "high", priority: 5, templateKey: "completionFailed" },
  approval_pending:   { earcon: "alert", severity: "high", priority: 4, templateKey: "approvalPending" },
  approval_expired:   { earcon: "alert", severity: "high", priority: 3, templateKey: "approvalExpired" },
  plan_paused:        { earcon: "alert", severity: "high", priority: 2, templateKey: "planPaused" },
  completion:         { earcon: "completion", severity: "normal", priority: 1, templateKey: "completion" },
  plan_completed:     { earcon: "success", severity: "normal", priority: 0, templateKey: "planCompleted" },
};

/** Derived projections — never hand-maintained; always read from KIND_META. */
export const EARCON_FOR: Record<AnnouncementKind, EarconType> =
  Object.fromEntries(
    (Object.keys(KIND_META) as AnnouncementKind[]).map((k) => [k, KIND_META[k].earcon])
  ) as Record<AnnouncementKind, EarconType>;

export const PRIORITY: Record<AnnouncementKind, number> =
  Object.fromEntries(
    (Object.keys(KIND_META) as AnnouncementKind[]).map((k) => [k, KIND_META[k].priority])
  ) as Record<AnnouncementKind, number>;

export function severityOf(kind: AnnouncementKind): "high" | "normal" {
  return KIND_META[kind].severity;
}

export function isHighSeverity(kind: AnnouncementKind): boolean {
  return KIND_META[kind].severity === "high";
}

/** Operator-editable message templates (Settings surface). `{pane}` / `{summary}` are
 *  interpolated. Defaults are intentionally brief (maintainer Decision 2). */
export type AnnouncementTemplates = Record<TemplateKey, string>;

export const DEFAULT_ANNOUNCEMENT_TEMPLATES: AnnouncementTemplates = {
  completion: "Pane '{pane}' finished. {summary}",
  completionFailed: "Pane '{pane}' finished WITH FAILURES. {summary}",
  error: "Pane '{pane}' reported an error. {summary}",
  buildFailed: "Build failed on pane '{pane}'.",
  exited: "Pane '{pane}' exited.",
  approvalPending: "Pane '{pane}' needs your approval. {summary}",
  approvalExpired: "An approval for pane '{pane}' expired. {summary}",
  planCompleted: "Plan completed. {summary}",
  planPaused: "Plan paused. {summary}",
};

/** Settings render order: [templateKey, human label]. The dialog drives its field list from
 *  this single array so the default strings are never re-typed by hand. */
export const ANNOUNCEMENT_TEMPLATE_FIELDS: ReadonlyArray<readonly [TemplateKey, string]> = [
  ["completion", "Completion"],
  ["completionFailed", "Completion (failed)"],
  ["error", "Error"],
  ["buildFailed", "Build failed"],
  ["exited", "Exited"],
  ["approvalPending", "Approval pending"],
  ["approvalExpired", "Approval expired"],
  ["planCompleted", "Plan completed"],
  ["planPaused", "Plan paused"],
];

export function templateFor(kind: AnnouncementKind, t: AnnouncementTemplates): string {
  // Default-merge degradation (card 1C.1): an operator templates object persisted BEFORE a kind
  // existed lacks its key (loadSettings default-merges, but a stale in-memory object or a direct
  // getTemplates injection may not). Fall back to the default template rather than handing the
  // renderer `undefined`.
  return t[KIND_META[kind].templateKey] ?? DEFAULT_ANNOUNCEMENT_TEMPLATES[KIND_META[kind].templateKey];
}
