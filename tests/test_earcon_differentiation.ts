// tests/test_earcon_differentiation.ts — BUG-018 residual (a)+(b): the earcon vocabulary + the
// blocked-vs-alert-vs-permission differentiation.
//
// THE GAP: approval_pending, command_blocked (and, before this bead, action_pending) all ring the ONE
// "alert" tone, so an eyes-off operator cannot distinguish "act now" (a pane needs your OK) from
// "already blocked" (a command was held back). Permission changes ring nothing at all. UX_BRIEF §4:
// eyes-off, a state change with no DISTINCT sound is a bug.
//
// REQUIRED (post-fix) BEHAVIOR pinned here:
//   (a) src/utils/earcon.ts adds new earcon tokens accepted by isEarconType (and given waveforms in the
//       TONE_TABLE — tsc enforces the waveform because TONE_TABLE is Record<EarconType,…>):
//         • "blocked"    (command_blocked)      — REQUIRED
//         • "permission" (permission_changed)   — REQUIRED
//         • "note"       (note-saved)           — OPTIONAL ("if cheap")
//   (b) The frame→earcon source of truth (src/orbital/useOrbitalDataHelpers.ts FRAME_EARCON, surfaced by
//       earconForFrame / earconForObserveFrame / playObserveEarcon) resolves:
//         • approval_pending   → "alert"       (UNCHANGED — regression guard)
//         • command_blocked    → "blocked"     (was the warn→alert default; MUST now differ from alert)
//         • permission_changed → "permission"
//       and the three tones are pairwise DISTINCT.
//
// Pure — imports the REAL earcon + helper modules the hook uses (no React/DOM).
//
// Runner: npx tsx --test --test-force-exit tests/test_earcon_differentiation.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isEarconType, type EarconType } from "../src/utils/earcon";
import { earconForFrame, playObserveEarcon } from "../src/orbital/useOrbitalDataHelpers";

// ── (a) vocabulary: the new tokens the runtime guard must accept ─────────────────────────────────
describe("isEarconType — the new differentiation tokens are real EarconTypes", () => {
  it("accepts 'blocked' and 'permission' (REQUIRED)", () => {
    assert.equal(isEarconType("blocked"), true, "'blocked' (command_blocked) must be a real EarconType");
    assert.equal(isEarconType("permission"), true, "'permission' (permission_changed) must be a real EarconType");
  });

  it("accepts 'note' (OPTIONAL note-saved token)", () => {
    assert.equal(isEarconType("note"), true, "'note' (note-saved) should be a real EarconType");
  });

  it("still accepts every pre-existing earcon (no regression)", () => {
    for (const t of ["completion", "alert", "success", "execute", "chime", "reconnect"]) {
      assert.equal(isEarconType(t), true, `${t} must still be accepted`);
    }
  });

  it("still rejects arbitrary strings and non-strings", () => {
    for (const v of ["bogus", "", "BLOCKED", "permissions", null, undefined, 7, {}]) {
      assert.equal(isEarconType(v), false, `${JSON.stringify(v)} must be rejected`);
    }
  });
});

// ── (b) frame→earcon mapping: the three tones must be distinct ───────────────────────────────────
describe("earconForFrame — command_blocked / permission_changed / approval_pending resolve distinctly", () => {
  it("approval_pending → 'alert' (UNCHANGED — regression guard)", () => {
    assert.equal(earconForFrame("approval_pending"), "alert");
  });

  it("command_blocked → 'blocked' (NOT the old warn→alert default)", () => {
    assert.equal(earconForFrame("command_blocked"), "blocked");
  });

  it("permission_changed → 'permission'", () => {
    assert.equal(earconForFrame("permission_changed"), "permission");
  });

  it("the three tones are pairwise DISTINCT (the core of BUG-018)", () => {
    const alert = earconForFrame("approval_pending");
    const blocked = earconForFrame("command_blocked");
    const permission = earconForFrame("permission_changed");
    assert.notEqual(blocked, alert, "command_blocked MUST differ from approval_pending's alert");
    assert.notEqual(permission, alert, "permission_changed MUST differ from approval_pending's alert");
    assert.notEqual(blocked, permission, "command_blocked and permission_changed are distinct tones");
  });

  it("every resolved tone is a real EarconType the player accepts (couples the two modules)", () => {
    for (const type of ["approval_pending", "command_blocked", "permission_changed"]) {
      const e = earconForFrame(type);
      assert.ok(e !== null && isEarconType(e), `${type} → a valid EarconType (got ${JSON.stringify(e)})`);
    }
  });
});

// ── the decide-AND-FIRE gate the hook actually routes observe frames through (playObserveEarcon) ──
describe("playObserveEarcon — fires the DIFFERENTIATED tone per frame", () => {
  it("command_blocked rings 'blocked'", () => {
    const fired: EarconType[] = [];
    playObserveEarcon({ type: "command_blocked", terminalId: "t1", cmd: "git push", reason: "HiTL" }, (t) => fired.push(t));
    assert.deepEqual(fired, ["blocked"]);
  });

  it("permission_changed rings 'permission'", () => {
    const fired: EarconType[] = [];
    playObserveEarcon({ type: "permission_changed", paneId: "t1", from: "Human-in-the-Loop", to: "Full Auto" }, (t) => fired.push(t));
    assert.deepEqual(fired, ["permission"]);
  });

  it("approval_pending still rings 'alert' (regression) — and it differs from blocked", () => {
    const firedAlert: EarconType[] = [];
    const firedBlocked: EarconType[] = [];
    playObserveEarcon({ type: "approval_pending", terminalId: "t1", cmd: "rm -rf" }, (t) => firedAlert.push(t));
    playObserveEarcon({ type: "command_blocked", terminalId: "t1", cmd: "rm -rf", reason: "HiTL" }, (t) => firedBlocked.push(t));
    assert.deepEqual(firedAlert, ["alert"]);
    assert.notDeepEqual(firedBlocked, firedAlert, "an eyes-off operator must hear a DIFFERENT tone for blocked vs pending");
  });
});
