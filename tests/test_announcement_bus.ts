import { describe, it } from "node:test";
import assert from "node:assert";
import {
  AnnouncementBus,
  pruneAttentionQueue,
  DEFAULT_ANNOUNCEMENT_TEMPLATES,
  type Clock,
} from "../src/announcementBus";
import {
  effectForEvent,
  earconForAttention,
  earconForTransition,
} from "../src/eventBus";
import {
  upsertNotification,
  dismissNotification,
  sortNotifications,
  type ProactiveNotification,
} from "../src/notificationStack";
import type { AttentionItem } from "../src/types";
import { UniversalTerminal } from "../src/terminal";
import { FallbackProbe } from "../src/statusProbe";
import type { StatusProbe, ProbeResult } from "../src/statusProbe";

/**
 * WS-D tests. All timing is driven by an injected FakeClock so no real timers are armed
 * and the suite exits cleanly. Every constructed AnnouncementBus is stopped in teardown.
 */

/** Advanceable clock: timers fire only when `advance()` crosses their deadline. */
class FakeClock implements Clock {
  private t = 0;
  private timers: { id: number; fireAt: number; fn: () => void }[] = [];
  private nextId = 1;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.push({ id, fireAt: this.t + ms, fn });
    return id;
  }
  clearTimeout(handle: any) {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }
  advance(ms: number) {
    const target = this.t + ms;
    // Fire due timers in order, allowing re-arms scheduled within the window.
    for (;;) {
      const due = this.timers
        .filter((x) => x.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0];
      this.timers = this.timers.filter((x) => x.id !== next.id);
      this.t = next.fireAt;
      next.fn();
    }
    this.t = target;
  }
}

function makeBus(broadcastSpy: any[], clock: FakeClock, opts: any = {}) {
  return new AnnouncementBus({
    broadcast: (msg) => broadcastSpy.push(msg),
    clock,
    coalesceWindowMs: 1500,
    perPaneDebounceMs: 4000,
    rateLimitWindowMs: 3000,
    rateLimitBurst: 2,
    ...opts,
  });
}

const notifs = (msgs: any[]) => msgs.filter((m) => m.type === "proactive_notification");
const earcons = (msgs: any[]) => msgs.filter((m) => m.type === "proactive_earcon");

describe("AnnouncementBus — coalescing / debounce / rate-limit", () => {
  it("emits one notification with the redacted summary after the coalesce window", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    bus.enqueue({ kind: "completion", terminalId: "tests", summary: "all passing" });
    // Earcon is immediate; notification waits for the window.
    assert.strictEqual(earcons(sink).length, 1);
    assert.strictEqual(notifs(sink).length, 0);
    clock.advance(1500);
    const out = notifs(sink);
    assert.strictEqual(out.length, 1);
    assert.match(out[0].message, /tests/);
    assert.match(out[0].message, /all passing/);
    bus.stop();
  });

  it("coalesces 3 different panes in one window into 3 entries, but never spawns dupes for the same pane+severity", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    bus.enqueue({ kind: "completion", terminalId: "a", summary: "x" });
    bus.enqueue({ kind: "completion", terminalId: "b", summary: "y" });
    bus.enqueue({ kind: "completion", terminalId: "c", summary: "z" });
    clock.advance(1500);
    const out = notifs(sink);
    assert.strictEqual(out.length, 3);
    // Distinct coalescing ids (pane+severity).
    const ids = new Set(out.map((m) => m.id));
    assert.strictEqual(ids.size, 3);
    bus.stop();
  });

  it("per-pane debounce suppresses a 2nd announcement for the same pane within the window", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    const first = bus.enqueue({ kind: "completion", terminalId: "build", summary: "1" });
    const second = bus.enqueue({ kind: "completion", terminalId: "build", summary: "2" });
    assert.strictEqual(first, true);
    assert.strictEqual(second, false, "2nd same-pane within debounce must be suppressed");
    clock.advance(1500);
    assert.strictEqual(notifs(sink).length, 1);
    bus.stop();
  });

  it("priority: an error leads the flush ahead of a completion", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    bus.enqueue({ kind: "completion", terminalId: "a", summary: "done" });
    bus.enqueue({ kind: "error", terminalId: "b", summary: "boom" });
    clock.advance(1500);
    const out = notifs(sink);
    assert.strictEqual(out[0].kind, "error", "highest severity first");
    assert.strictEqual(out[0].severity, "high");
    bus.stop();
  });

  it("rate limit: a burst of completions is spaced across windows, none dropped", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    // burst 1 so each flush consumes the only token; debounce 0 so distinct panes flow.
    const bus = makeBus(sink, clock, { perPaneDebounceMs: 0, rateLimitBurst: 1, rateLimitWindowMs: 3000 });
    for (const id of ["a", "b", "c"]) {
      bus.enqueue({ kind: "completion", terminalId: id, summary: id });
    }
    clock.advance(1500); // first flush -> emits buffered items (a,b,c) but only 1 token
    const firstCount = notifs(sink).length;
    assert.ok(firstCount >= 1);
    // All 3 panes eventually surface once the bucket refills.
    clock.advance(10000);
    const ids = new Set(notifs(sink).map((m) => m.terminalId));
    assert.deepStrictEqual([...ids].sort(), ["a", "b", "c"]);
    bus.stop();
  });

  it("redaction: a summary is passed through verbatim (server pre-redacts) and never re-derives raw text", () => {
    // The bus trusts an already-redacted summary; assert it interpolates the given (redacted) token.
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    bus.enqueue({ kind: "completion", terminalId: "tests", summary: "[REDACTED:aws-key] scrubbed" });
    clock.advance(1500);
    const out = notifs(sink);
    assert.match(out[0].message, /\[REDACTED:aws-key\]/);
    bus.stop();
  });

  it("custom templates from getTemplates are honored", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock, {
      getTemplates: () => ({ ...DEFAULT_ANNOUNCEMENT_TEMPLATES, completion: "DONE {pane}" }),
    });
    bus.enqueue({ kind: "completion", terminalId: "lint", summary: "n/a" });
    clock.advance(1500);
    assert.strictEqual(notifs(sink)[0].message, "DONE lint");
    bus.stop();
  });

  it("applyTemplate: a summary with regex replacement specials ($&, $`, $', $1) passes through verbatim (no injection)", () => {
    // BUG: a plain String.replace replacement string treats `$&`/`` $` ``/`$'`/`$n` as
    // special. A summary from build output containing `$` would corrupt/inject text. The
    // function-replacer fix must emit the dynamic value byte-for-byte.
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock, {
      getTemplates: () => ({ ...DEFAULT_ANNOUNCEMENT_TEMPLATES, completion: "{pane}: {summary}" }),
    });
    bus.enqueue({ kind: "completion", terminalId: "ci", summary: "result $` and $& done $1" });
    clock.advance(1500);
    const out = notifs(sink);
    assert.strictEqual(out[0].message, "ci: result $` and $& done $1");
    bus.stop();
  });

  it("a $ in the pane name is also passed through verbatim", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock, {
      getTemplates: () => ({ ...DEFAULT_ANNOUNCEMENT_TEMPLATES, completion: "[{pane}] {summary}" }),
    });
    bus.enqueue({ kind: "completion", terminalId: "pane$&x", summary: "ok" });
    clock.advance(1500);
    assert.strictEqual(notifs(sink)[0].message, "[pane$&x] ok");
    bus.stop();
  });

  it("completion enqueues even with an empty/absent summary (genuine onIdle with trivial output)", () => {
    // BUG: the completion was previously gated behind substantive output; a genuine
    // Running->Idle with no/trivial output must still announce.
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    const ok = bus.enqueue({ kind: "completion", terminalId: "quiet" });
    assert.strictEqual(ok, true, "trivial completion still enqueues");
    clock.advance(1500);
    const out = notifs(sink);
    assert.strictEqual(out.length, 1);
    assert.match(out[0].message, /quiet/);
    bus.stop();
  });

  it("exited is HIGH severity: alert earcon, its own high coalescing bucket, debounce-exempt (never starved by a completion)", () => {
    // BUG-002: `exited` was mis-bucketed as normal severity despite carrying an alert
    // earcon -> it collided with completion's `notif_{pane}_normal` id and was starved by
    // the per-pane debounce. As high severity it gets its own bucket and is debounce-exempt.
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    const first = bus.enqueue({ kind: "completion", terminalId: "p", summary: "done" });
    const second = bus.enqueue({ kind: "exited", terminalId: "p", summary: "code 1" });
    assert.strictEqual(first, true);
    assert.strictEqual(second, true, "exited is debounce-exempt on the same pane");
    // exited earcon is "alert".
    const exitEarcon = earcons(sink).find((e) => e.kind === "exited");
    assert.ok(exitEarcon);
    assert.strictEqual(exitEarcon.earcon, "alert");
    clock.advance(1500);
    const out = notifs(sink);
    // Two distinct notifications (different severity buckets), no coalescing collision.
    assert.strictEqual(out.length, 2);
    const exited = out.find((m) => m.kind === "exited");
    assert.ok(exited);
    assert.strictEqual(exited.severity, "high");
    assert.notStrictEqual(out[0].id, out[1].id, "completion (normal) and exited (high) keep distinct ids");
    bus.stop();
  });

  // 1C.1 (Phase 1 Track C): approvals previously BORROWED kind:"exited" for its high severity,
  // so the rendered notification literally claimed a healthy pane died ("Pane 'x' exited.")
  // while it was merely awaiting approval. The REAL kinds must render approval truth.
  it("approval_pending renders 'needs your approval' — never the exited template", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    const ok = bus.enqueue({ kind: "approval_pending", terminalId: "pane-7", summary: "Awaiting your approval." });
    assert.strictEqual(ok, true, "high severity => debounce-exempt enqueue");
    // Immediate earcon reuses the EXISTING client-known "alert" tone (kitchen client updates later).
    const earcon = earcons(sink).find((e) => e.kind === "approval_pending");
    assert.ok(earcon, "approval_pending fires an immediate earcon");
    assert.strictEqual(earcon.earcon, "alert");
    clock.advance(1500);
    const out = notifs(sink);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].severity, "high", "approval arrival keeps its high-severity bucket");
    assert.match(out[0].message, /needs your approval/);
    assert.match(out[0].message, /pane-7/);
    assert.match(out[0].message, /Awaiting your approval\./, "{summary} is interpolated");
    assert.doesNotMatch(out[0].message, /exited/i, "an approval must never read as a pane death");
    bus.stop();
  });

  it("approval_expired renders the expiry — never the exited template", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    const ok = bus.enqueue({ kind: "approval_expired", terminalId: "pane-9", summary: "Approval expired." });
    assert.strictEqual(ok, true);
    const earcon = earcons(sink).find((e) => e.kind === "approval_expired");
    assert.ok(earcon, "approval_expired fires an immediate earcon");
    assert.strictEqual(earcon.earcon, "alert");
    clock.advance(1500);
    const out = notifs(sink);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].severity, "high");
    assert.match(out[0].message, /approval for pane 'pane-9' expired/i);
    assert.doesNotMatch(out[0].message, /exited/i, "an expired approval must never read as a pane death");
    bus.stop();
  });

  it("an older operator templates object WITHOUT the new approval keys degrades to the defaults (no crash)", () => {
    // Settings persisted before these kinds existed lack approvalPending/approvalExpired; the
    // render must fall back to the default template instead of throwing on undefined.replace.
    const sink: any[] = [];
    const clock = new FakeClock();
    const legacyTemplates: any = {
      completion: "Pane '{pane}' finished. {summary}",
      error: "Pane '{pane}' reported an error. {summary}",
      buildFailed: "Build failed on pane '{pane}'.",
      exited: "Pane '{pane}' exited.",
      planCompleted: "Plan completed. {summary}",
      planPaused: "Plan paused. {summary}",
    };
    const bus = makeBus(sink, clock, { getTemplates: () => legacyTemplates });
    bus.enqueue({ kind: "approval_pending", terminalId: "old-cfg", summary: "Awaiting your approval." });
    clock.advance(1500);
    const out = notifs(sink);
    assert.strictEqual(out.length, 1, "renders despite the missing key");
    assert.match(out[0].message, /needs your approval/);
    assert.doesNotMatch(out[0].message, /exited/i);
    bus.stop();
  });

  it("stop() clears pending timers so nothing keeps the loop alive", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    bus.enqueue({ kind: "completion", terminalId: "a", summary: "x" });
    bus.stop();
    clock.advance(5000);
    assert.strictEqual(notifs(sink).length, 0, "no flush after stop()");
  });
});

describe("pruneAttentionQueue — BUG-035 cap + TTL", () => {
  const item = (id: string, ageMs: number, dismissed = false): AttentionItem => ({
    id,
    type: "error",
    terminalId: "t",
    projectId: "p",
    message: "m",
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    dismissed,
  });

  it("evicts items older than the TTL", () => {
    const now = Date.now();
    const q: AttentionItem[] = [item("fresh", 1000), item("stale", 11 * 60 * 1000)];
    pruneAttentionQueue(q, now);
    assert.deepStrictEqual(q.map((i) => i.id), ["fresh"]);
  });

  it("evicts dismissed items quickly (dismissed TTL)", () => {
    const now = Date.now();
    // dismissed item older than the dismissed-TTL (default 60s) is evicted; the
    // non-dismissed sibling of the same age survives (well under the 10min active TTL).
    const q: AttentionItem[] = [item("a", 90_000, true), item("b", 90_000, false)];
    pruneAttentionQueue(q, now);
    assert.deepStrictEqual(q.map((i) => i.id), ["b"]);
  });

  it("dismiss_attention semantics: by id and dismiss-all (mirrors the voice handler)", () => {
    // The voice dismiss_attention tool sets item.dismissed and prunes; replicate that
    // queue contract here (the handler shares this path with the REST dismiss).
    const q: AttentionItem[] = [item("x1", 1000), item("x2", 1000)];
    // dismiss by id
    const target = q.find((i) => i.id === "x1");
    assert.ok(target);
    target!.dismissed = true;
    assert.strictEqual(q.filter((i) => !i.dismissed).length, 1);
    // dismiss all
    q.forEach((i) => (i.dismissed = true));
    assert.strictEqual(q.filter((i) => !i.dismissed).length, 0);
    // prune evicts the now-stale dismissed items (older than dismissed TTL).
    const old: AttentionItem[] = [item("d", 90_000, true)];
    pruneAttentionQueue(old, Date.now());
    assert.strictEqual(old.length, 0);
  });

  it("evicts an item with an unparseable/NaN timestamp (was pinned forever)", () => {
    // BUG: `new Date(badTimestamp).getTime()` is NaN, and `NaN > ttl` is false, so such an
    // item never aged out. It must now be treated as stale and evicted.
    const now = Date.now();
    const bad: AttentionItem = {
      id: "bad", type: "error", terminalId: "t", projectId: "p", message: "m",
      timestamp: "not-a-date", dismissed: false,
    };
    const q: AttentionItem[] = [bad, item("fresh", 1000)];
    pruneAttentionQueue(q, now);
    assert.deepStrictEqual(q.map((i) => i.id), ["fresh"]);
  });

  it("caps length, dropping dismissed-then-oldest", () => {
    const now = Date.now();
    const q: AttentionItem[] = [];
    for (let i = 0; i < 55; i++) q.push(item("i" + i, 1000));
    q[3].dismissed = true; // but not old enough for dismissed-TTL (5s < 60s)
    pruneAttentionQueue(q, now, { cap: 50, dismissedTtlMs: 60_000 });
    assert.ok(q.length <= 50);
    assert.ok(!q.find((i) => i.id === "i3"), "dismissed item dropped first under cap");
  });
});

describe("eventBus — BUG-010 dispatch mapping", () => {
  it("maps every server broadcast to the right setter + earcon", () => {
    const cases: Array<[any, string, string | null]> = [
      [{ type: "attention_updated", queue: [{ type: "error", dismissed: false }] }, "setAttentionQueue", "alert"],
      [{ type: "attention_updated", queue: [] }, "setAttentionQueue", null],
      [{ type: "plans_updated", plans: [] }, "setPlans", null],
      [{ type: "watch_rules_updated", watchRules: [] }, "setWatchRules", null],
      [{ type: "pane_transition", transition: "error" }, "fetchTerminals", "alert"],
      // idle yields NO earcon from the event bus: the AnnouncementBus owns the completion
      // tone on the genuine onIdle edge, so mapping it here too would double-play it.
      [{ type: "pane_transition", transition: "idle" }, "fetchTerminals", null],
      [{ type: "pane_transition", transition: "prompt" }, "fetchTerminals", null],
      [{ type: "plan_step_completed" }, "fetchPlans", "execute"],
      [{ type: "plan_completed" }, "fetchPlans", "success"],
      [{ type: "plan_paused" }, "fetchPlans", "alert"],
      [{ type: "history_updated" }, "noop", null],
      // Prompt-composer refactor: a matched watch rule is a co-pilot suggestion (queued via a
      // paired attention_updated event), so the event itself only chimes — it never writes.
      [{ type: "watch_rule_suggested" }, "noop", "chime"],
    ];
    for (const [msg, setter, earcon] of cases) {
      const eff = effectForEvent(msg);
      assert.ok(eff, `event ${msg.type} must map`);
      assert.strictEqual(eff!.setter, setter, `${msg.type} setter`);
      assert.strictEqual(eff!.earcon, earcon, `${msg.type} earcon`);
    }
  });

  it("returns null for an unknown / already-handled type (additive, no throw)", () => {
    assert.strictEqual(effectForEvent({ type: "audio" }), null);
    assert.strictEqual(effectForEvent({ type: "stdout_chunk" }), null);
  });

  it("earcon selection helpers", () => {
    assert.strictEqual(earconForAttention([{ type: "build-failed", dismissed: false }]), "alert");
    assert.strictEqual(earconForAttention([{ type: "approval", dismissed: false }]), "completion");
    assert.strictEqual(earconForAttention([{ type: "error", dismissed: true }]), null);
    assert.strictEqual(earconForTransition("exited"), "alert");
    // idle -> no earcon from the bus mapping (completion tone is owned by AnnouncementBus).
    assert.strictEqual(earconForTransition("idle"), null);
    assert.strictEqual(earconForTransition("prompt"), null);
  });
});

// ---------------------------------------------------------------------------
// WS-C coupling: the completion announcement is driven ONLY by the genuine
// Running->Idle edge (manager.onIdle). A false idle must NOT enqueue.
// ---------------------------------------------------------------------------
class ScriptedProbe implements StatusProbe {
  constructor(private result: ProbeResult) {}
  set(r: ProbeResult) { this.result = r; }
  probe(): ProbeResult { return this.result; }
}

function makeTerm(probe: StatusProbe): UniversalTerminal {
  const t = new UniversalTerminal(
    `wsd-${Math.random().toString(16).slice(2)}`,
    ".", "bash", "Custom", "Human-in-the-Loop", "", "default_project", probe
  );
  (t as any).shellPid = 1234;
  t.status = "Running";
  return t;
}

describe("WS-C coupling — announce only on genuine onIdle", () => {
  it("genuine Running->Idle edge fires onIdle -> bus enqueues a completion", async () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    const probe = new ScriptedProbe({ hasRunningChild: true, confidence: "authoritative" });
    const term = makeTerm(probe);
    term.idleTimeoutMs = 30;
    term.onIdle = (id) => { bus.enqueue({ kind: "completion", terminalId: id, summary: "done" }); };

    (term as any).runProbeTick();              // busy -> work seen
    probe.set({ hasRunningChild: false, confidence: "authoritative" });
    (term as any).runProbeTick();              // arms idle debounce
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(term.status, "Idle");
    // Earcon fired immediately on enqueue; advance fake clock to flush the notification.
    assert.strictEqual(earcons(sink).length, 1, "exactly one completion earcon");
    clock.advance(1500);
    assert.strictEqual(notifs(sink).length, 1, "one completion notification on the genuine edge");
    bus.stop();
    await term.stop();
  });

  it("false idle (idle timer with NO work since idle) does NOT fire onIdle -> no enqueue", async () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = makeBus(sink, clock);
    const fb = new FallbackProbe();
    const term = makeTerm(fb);
    term.status = "Idle";       // already idle, no work performed
    (term as any).sawWorkSinceIdle = false;
    term.idleTimeoutMs = 20;
    term.onIdle = (id) => { bus.enqueue({ kind: "completion", terminalId: id, summary: "FALSE" }); };

    // A bare idle-timer event with no work seen must be suppressed by the realDone gate.
    (term as any).applyStatusEvent({ kind: "idleTimer" });
    await new Promise((r) => setTimeout(r, 100));
    clock.advance(2000);
    assert.strictEqual(earcons(sink).length, 0, "no earcon on a false idle");
    assert.strictEqual(notifs(sink).length, 0, "no announcement on a false idle");
    bus.stop();
    await term.stop();
  });
});

describe("notificationStack — coalesce-to-latest", () => {
  const n = (id: string, message: string, severity: "high" | "normal" = "normal"): ProactiveNotification => ({
    id, kind: "completion", terminalId: id.split("_")[1] || "t", severity, message, timestamp: new Date().toISOString(),
  });

  it("updates the existing entry to the latest message rather than spawning a duplicate", () => {
    let stack: ProactiveNotification[] = [];
    stack = upsertNotification(stack, n("notif_tests_normal", "first"));
    stack = upsertNotification(stack, n("notif_tests_normal", "second"));
    assert.strictEqual(stack.length, 1, "same id coalesces");
    assert.strictEqual(stack[0].message, "second", "latest message wins");
  });

  it("keeps distinct ids as distinct entries", () => {
    let stack: ProactiveNotification[] = [];
    stack = upsertNotification(stack, n("notif_a_normal", "a"));
    stack = upsertNotification(stack, n("notif_b_normal", "b"));
    assert.strictEqual(stack.length, 2);
  });

  it("sorts high severity before normal", () => {
    const sorted = sortNotifications([
      n("notif_a_normal", "a", "normal"),
      n("notif_b_high", "b", "high"),
    ]);
    assert.strictEqual(sorted[0].severity, "high");
  });

  it("dismiss removes the entry by id", () => {
    let stack = upsertNotification([], n("notif_a_normal", "a"));
    stack = dismissNotification(stack, "notif_a_normal");
    assert.strictEqual(stack.length, 0);
  });
});
