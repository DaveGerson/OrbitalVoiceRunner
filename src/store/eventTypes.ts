// src/store/eventTypes.ts
export const EVENT_TYPES = Object.freeze({
  PROJECT_CREATED: "project_created",
  PANE_CREATED: "pane_created",
  PANE_ARCHIVED: "pane_archived",
  PANE_RESTORED: "pane_restored",
  STATUS_TRANSITION: "status_transition",
  COMMAND_PROPOSED: "command_proposed",
  COMMAND_DISPATCHED: "command_dispatched",
  COMMAND_OUTCOME: "command_outcome",
  APPROVAL_DECIDED: "approval_decided",
  PERMISSION_CHANGED: "permission_changed",
  NOTE_ADDED: "note_added",
  HANDOFF: "handoff",
  PLAN_STEP: "plan_step",
} as const);

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface NewEvent {
  type: EventType;
  ts?: number;            // defaults to Date.now()
  project_id?: string | null;
  pane_id?: string | null;
  session_id?: string | null;
  summary?: string;       // REDACTED by caller before passing in
  payload?: unknown;      // JSON-serializable, REDACTED by caller
}

export interface StoredEvent {
  id: number;
  ts: number;
  type: string;
  project_id: string | null;
  pane_id: string | null;
  session_id: string | null;
  summary: string;
  payload: any;           // parsed JSON
}
