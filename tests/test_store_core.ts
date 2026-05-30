// tests/test_store_core.ts
import { test } from "node:test";
import assert from "node:assert";
import { EVENT_TYPES } from "../src/store/eventTypes";

test("event vocabulary is frozen and complete", () => {
  assert.ok(Object.isFrozen(EVENT_TYPES));
  for (const t of ["command_dispatched","command_outcome","approval_decided",
                   "status_transition","note_added","handoff","permission_changed",
                   "pane_created","pane_archived","pane_restored","project_created","plan_step"]) {
    assert.ok(Object.values(EVENT_TYPES).includes(t as any), `missing event type ${t}`);
  }
});
