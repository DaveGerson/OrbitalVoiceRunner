# vc-D Production Wiring + D4 Delivery-Mode Dial — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close beads `fikj.12` (D4 delivery-mode dial: operator-tunable arbiter matrix + completionAnnounce with a never-silent floor), `fikj.11` (vc-D production wiring: record()/invalidate() producer sites for the correction ledger), and thereby the remaining scope of `fikj.4`.

**Architecture:** The turn-arbiter program (PR #153) already shipped the pure decision core (`src/voice/turnArbiter.ts`), the pure correction ledger (`src/voice/correctionLedger.ts`), the shared-arbiter construction in `server.ts:1838`, and the continuous drain loop + sink in `src/voice/index.ts:2591-2629`. What is missing is exactly two things: (1) the D4 matrix and completionAnnounce are hardcoded to spec defaults — no settings schema, no live re-dial, no dialog rows; (2) nothing constructs the correction ledger or calls `record()`/`invalidate()` — spoken corrections can never fire. This plan adds a live `updateMatrix` seam on the arbiter, a `voiceAi.deliveryMatrix`/`voiceAi.completionAnnounce` settings surface following the capability-gate validate-strip-clamp idiom, and three claim producers (renderApproved dispatch claims, restart acks, vc-C completion claims) feeding one server-constructed ledger whose only output is class-0 submissions into the existing shared arbiter — **no new send site exists anywhere in this plan** (the T1 send-site ratchet stays untouched).

**Tech Stack:** TypeScript only (per the LOCKED Python/TS seam rule — every piece here is turn-timing, frontend, or I/O shell). `node:test` via `npx tsx --test --test-force-exit`. Playwright for the one pure-JSX e2e leg. Zod for the settings enum (existing server.ts idiom).

**Task ordering rationale (differs slightly from the bead order):** fikj.12 first (Tasks 1–4) — it is mechanical plumbing on existing validators, AND Task 8's completion-claim `spoken` flag depends on the dial semantics being live (a class-3 item drained under a `passive-context` dial is NOT a spoken claim; recording at the drain sink where `turnComplete` is known makes that correct by construction). Then fikj.11: the ledger gains one additive query (Task 5) that the completion producer needs, then the three producers (Tasks 6–8) — each is harness-injectable through an optional dep member on its own seam, so they don't need server.ts first — then the server.ts construction/threading (Task 9), then the cross-producer journey + full battery (Task 10).

**E2E coverage statement (explicit):** the browser e2e lanes cannot observe server→model narration sends — the scripted-live connector records `clientContents` (`src/voice/scriptedLiveConnector.ts:43`) but exposes no read endpoint (`server.ts:988-1009` registers only `/emit` and `/close`), and the `?mock=1` harness is frontend-only. So corrections/narration behavior is pinned at the in-process journey layer (the established `tests/test_turn_arbiter_journeys.ts` idiom: real modules composed, fake boundaries). The one e2e spec added here covers the SettingsDialog dial rows — the pure-JSX leg — the exact split `e2e/voice_silence_gate.spec.ts` already uses. Do NOT invent a scripted-lane read endpoint in this plan.

**Product decisions taken (defaults picked; do not block — flag to director in the PR):**
1. **Settings home** = `voiceAi.deliveryMatrix` + `voiceAi.completionAnnounce` (not `voiceUx`, not `advanced`) — the SettingsDialog Voice Session tab is where the rows go, `voiceAi` shallow-merge (`src/terminal.ts:1646`) protects round-trips, and both keys stay ABSENT in `getDefaultSettings()` (the `sessionPoolHotSlots` precedent) so pristine-settings shape pins stay green.
2. **`spoken` semantics per producer:** dispatch = narration push succeeded (`pushApprovalNarration !== false` with a live session, 3V.3 semantics); restart = always `true` (the confirm string always reaches the invoking surface — UI response or spoken confirm); completion = digest send succeeded with `turnComplete: true`.
3. **`COMPLETION_CONTRADICTION_WINDOW_MS = 15_000`** — a producer-side recency guard deciding whether an error/exited signal genuinely contradicts the last spoken completion claim. This is NOT a ledger staleness clock (Sam's dealbreaker is untouched: a pending correction still never decays inside the ledger/arbiter).
4. **Violation surfacing** = clamp-in-place at the PUT boundary + `dialViolations` in the PUT response + boot-time `console.warn` for hand-edited persisted files + structurally floor-limited dialog options (classes 0/2 never offer `passive-context`). No toast/announcementBus lane is added.
5. **Approve-on-Exited-pane** now routes to `renderDeadPane` (honest FIRST claim) instead of silently buffering the write into a dead pane's `pendingInput` — the co-design §D "ships-now ordering fix", matching the Full-Auto guard precedent in `src/dispatch/paneWrite.ts:235`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/voice/turnArbiter.ts` | Modify | + `updateMatrix(raw)` live re-dial (Task 1) |
| `src/types.ts` | Modify | + `voiceAi.deliveryMatrix` / `voiceAi.completionAnnounce` (Task 2) |
| `server.ts` | Modify | boundary clamp validator, PUT wiring, boot matrix + violations log (Task 2); correctionLedger construction + threading (Task 9) |
| `src/voice/index.ts` | Modify | live completionAnnounce read (Task 3); `recordSpokenCompletionClaims` / `completionContradiction` helpers + sink/subscriber wiring + `VoiceDeps.correctionLedger` (Task 8) |
| `src/components/settingsDialogHelpers.ts` | Modify | dial derive/options helpers + VoiceFields extension (Task 4) |
| `src/components/SettingsDialog.tsx` | Modify | dial rows + form state + compile-in (Task 4) |
| `src/voice/correctionLedger.ts` | Modify | + `latestSpokenClaim(paneId)` additive query (Task 5) |
| `src/gating/index.ts` | Modify | `GatingDeps.correctionLedger`, renderApproved Exited-guard + dispatch-claim record, effect-deps threading (Tasks 6–7) |
| `src/actions/types.ts` | Modify | `ActionContext.correctionLedger` (Task 7) |
| `src/actions/respawnFromLedger.ts` | Modify | + shared `invalidateRestartClaim` helper (Task 7) |
| `src/actions/defs/panes_rest.ts` | Modify | restart-ack record + invalidate arms (Task 7) |
| `src/actionEffects.ts` | Modify | `ActionEffectDeps.correctionLedger` + replay twin (Task 7) |
| `tests/test_delivery_dial.ts` | Create | Tasks 1–3 RED suite |
| `tests/test_delivery_dial_settings.ts` | Create | Task 4 helper unit suite |
| `e2e/delivery_dial.spec.ts` | Create | Task 4 pure-JSX row leg |
| `tests/test_correction_ledger_query.ts` | Create | Task 5 RED suite |
| `tests/test_vcd_producer_dispatch.ts` | Create | Task 6 RED suite |
| `tests/test_vcd_producer_restart.ts` | Create | Task 7 RED suite |
| `tests/test_vcd_producer_completion.ts` | Create | Task 8 RED suite |
| `tests/test_vcd_journeys.ts` | Create | Task 9 wiring conformance + Task 10 cross-producer journey |

Run every unit file with: `npx tsx --test --test-force-exit tests/<file>.ts` (the `--test-force-exit` is mandatory — a PTY keeps the loop alive otherwise). Set `$env:PYTHONIOENCODING='utf-8'` is NOT needed here (no Python anywhere in this plan — LOCKED seam rule).

---

### Task 1: `TurnArbiter.updateMatrix` — the live re-dial core (fikj.12)

The shared arbiter is constructed ONCE at server boot (`server.ts:1838`). Reconstructing it on a settings PUT would drop queued items (a silent-drop path — forbidden). Instead the arbiter gains an additive `updateMatrix(raw)` that re-normalizes (same floor clamp + fallback as construction) and swaps the active matrix in place, returning the violations for the boundary to surface.

**Files:**
- Modify: `src/voice/turnArbiter.ts` (interface at ~line 141, factory at ~line 205)
- Test: `tests/test_delivery_dial.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_delivery_dial.ts`:

```ts
// tests/test_delivery_dial.ts — fikj.12 RED: the D4 delivery-mode dial becomes operator-tunable.
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md §3.2 (D4 "A dial, with a floor");
// beads fikj.12. Task 1 pins the arbiter's live re-dial seam (updateMatrix); Task 2 pins the
// settings boundary (clamp + violations, never a silent value); Task 3 pins the live
// completionAnnounce read at the idle edge (source-conformance, the test_turn_arbiter_journeys
// item-2/3 idiom).
//
// Runner: npx tsx --test --test-force-exit tests/test_delivery_dial.ts

process.env.JANUS_NO_AUTOSTART = "1";
if (!process.env.JANUS_DB) process.env.JANUS_DB = ":memory:";

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnArbiter, DEFAULT_DELIVERY_MATRIX } from "../src/voice/turnArbiter";

type AnyRec = Record<string, any>;
const T0 = 1_700_000_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ── Task 1: TurnArbiter.updateMatrix ───────────────────────────────────────────────────────────

test("updateMatrix exists and re-dials a class without dropping queued items", () => {
  const arb: AnyRec = createTurnArbiter();
  assert.strictEqual(typeof arb.updateMatrix, "function",
    "fikj.12 feature absent: TurnArbiter.updateMatrix(raw) must exist (live re-dial, no reconstruction)");
  arb.submit({ facts: "pane p1 finished", cls: 3, paneId: "p1" });
  const result = arb.updateMatrix({ "3": "passive-context" });
  assert.deepStrictEqual(result.violations, [], "an in-floor dial produces no violations");
  const d = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.mode, "passive-context",
    "an item queued BEFORE the dial drains under the NEW mode (the matrix is swapped, the queue is not touched)");
});

test("updateMatrix clamps under-floor values and reports the violation (classes 0/2 refuse passive)", () => {
  const arb: AnyRec = createTurnArbiter();
  const result = arb.updateMatrix({ "0": "passive-context", "2": "passive-context" });
  assert.strictEqual(result.violations.length, 2, "one violation per clamped class");
  assert.strictEqual(result.matrix[0], "steered-digest", "class 0 clamps to the steered-digest floor");
  assert.strictEqual(result.matrix[2], "steered-digest", "class 2 clamps to the steered-digest floor");
  arb.submit({ facts: "correction: pane p1 — retracting", cls: 0, paneId: "p1" });
  const d = arb.evaluate({ now: T0, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.notStrictEqual(d.mode, "passive-context", "the never-silent floor holds in the live decision core");
});

test("updateMatrix falls back to per-class defaults on garbage and reports class-1 dial attempts", () => {
  const arb: AnyRec = createTurnArbiter();
  const result = arb.updateMatrix({ "3": "silent", "1": "forced-turn" });
  assert.ok(result.violations.some((v: string) => v.includes("class 3")), "the invalid class-3 value is reported");
  assert.ok(result.violations.some((v: string) => v.includes("class 1")), "class 1 has no dial — reported, ignored");
  assert.strictEqual(result.matrix[3], DEFAULT_DELIVERY_MATRIX[3], "garbage falls back to the class default, never a throw");
});
```

- [ ] **Step 2: Run the new file — verify the three Task-1 tests fail**

Run: `npx tsx --test --test-force-exit tests/test_delivery_dial.ts`
Expected: 3 failing tests, each with `fikj.12 feature absent: TurnArbiter.updateMatrix` (the first assert trips; the other two fail calling `arb.updateMatrix` as not-a-function).

- [ ] **Step 3: Implement `updateMatrix`**

In `src/voice/turnArbiter.ts`, extend the `TurnArbiter` interface (currently lines 141-146):

```ts
export interface TurnArbiter {
  submit(item: SubmitItem): void;
  evaluate(ctx: EvaluateCtx): DrainDecision;
  /** The gating sweep consults this per last-call coalesceKey before expiring it (D1). */
  floorPausedMs(coalesceKey: string): number;
  /** D4 (fikj.12): live re-dial. Re-normalizes `raw` (the SAME floor clamp + fallback as
   *  construction — defense in depth) and swaps the ACTIVE matrix in place: already-queued items
   *  drain under the new modes, nothing is dropped or reconstructed. Violations are returned for
   *  the settings boundary to surface. */
  updateMatrix(raw: unknown): NormalizeMatrixResult;
}
```

In `createTurnArbiter` (the factory), the first line currently reads `const { matrix } = normalizeDeliveryMatrix(opts?.matrix);`. Leave it, and add the method just before the return, then extend the return:

```ts
  function updateMatrix(raw: unknown): NormalizeMatrixResult {
    const result = normalizeDeliveryMatrix(raw);
    // Swap IN PLACE: buildQueueDrain closed over `matrix` by reference, so mutating the same
    // object re-dials every future drain without touching the queue (never-drop invariant).
    Object.assign(matrix, result.matrix);
    return result;
  }

  return { submit, evaluate, floorPausedMs, updateMatrix };
```

- [ ] **Step 4: Run the file — Task-1 tests pass**

Run: `npx tsx --test --test-force-exit tests/test_delivery_dial.ts`
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Run the existing arbiter suites (regression guard) and lint**

Run: `npx tsx --test --test-force-exit tests/test_turn_arbiter_corrections.ts tests/test_turn_arbiter_completions.ts tests/test_turn_arbiter_deadlines.ts tests/test_turn_arbiter_journeys.ts`
Expected: all pass (updateMatrix is purely additive).
Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/voice/turnArbiter.ts tests/test_delivery_dial.ts
git commit -m "feat(voice): TurnArbiter.updateMatrix live re-dial with floor clamp (fikj.12 D4)"
```

---

### Task 2: Settings schema + boundary clamp + boot/PUT wiring (fikj.12)

The dial persists at `voiceAi.deliveryMatrix` / `voiceAi.completionAnnounce`. Boundary behavior (the capability-gate idiom, adapted per D4): under-floor or invalid matrix values are NEVER a 400 — `normalizeDeliveryMatrix` clamps them IN PLACE (so the persisted value is the clamped truth) and the violations ride the PUT response as `dialViolations`. A non-enum `completionAnnounce` IS a 400 (the `voiceUx.sitrepShape` strict-when-present idiom). Boot logs violations from a hand-edited persisted file and constructs the arbiter with the settings matrix.

**Files:**
- Modify: `src/types.ts` (~line 476, inside the `voiceAi` block after `groundingEnabled`)
- Modify: `server.ts` (import at line 71; validators after line 283; `validateSettingsPutBody` at line 285; `registerDraftAndSettingsRoutes` deps at line 1281 + PUT handler at line 1380; boot at line 1838; call site at line 2154)
- Test: `tests/test_delivery_dial.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_delivery_dial.ts`:

```ts
// ── Task 2: the settings boundary (server.ts validateSettingsPutBody) ──────────────────────────
// server.ts is imported DEFERRED (env guards at module top of this file) — the same preamble
// tests/helpers/mockLive.ts uses, so no real listener boots.

const { validateSettingsPutBody } = await import("../server");

test("PUT boundary: an under-floor deliveryMatrix CLAMPS in place and surfaces dialViolations (never a 400)", () => {
  const body: AnyRec = { voiceAi: { deliveryMatrix: { "0": "passive-context", "3": "passive-context" } } };
  const v: AnyRec = validateSettingsPutBody(body);
  assert.strictEqual(v.ok, true, "an under-floor value is a policy clamp, not a rejection");
  assert.ok(Array.isArray(v.dialViolations), "fikj.12 feature absent: validateSettingsPutBody must return dialViolations");
  assert.strictEqual(v.dialViolations.length, 1, "exactly the class-0 clamp is reported");
  assert.strictEqual(body.voiceAi.deliveryMatrix["0"], "steered-digest", "clamped IN PLACE — the persisted value is the clamped truth");
  assert.strictEqual(body.voiceAi.deliveryMatrix["3"], "passive-context", "class 3 has no floor — passes through");
});

test("PUT boundary: unknown matrix class keys are dropped by normalization; garbage values fall back + report", () => {
  const body: AnyRec = { voiceAi: { deliveryMatrix: { "7": "forced-turn", "4": "loud" } } };
  const v: AnyRec = validateSettingsPutBody(body);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(body.voiceAi.deliveryMatrix["7"], undefined, "unknown class stripped (the full normalized matrix replaces the raw map)");
  assert.strictEqual(body.voiceAi.deliveryMatrix["4"], DEFAULT_DELIVERY_MATRIX[4], "garbage value -> the class default");
  assert.ok(v.dialViolations.some((s: string) => s.includes("class 4")), "the fallback is reported");
});

test("PUT boundary: a non-enum completionAnnounce is a 400 naming the field (retired 'focused' included)", () => {
  const v: AnyRec = validateSettingsPutBody({ voiceAi: { completionAnnounce: "focused" } });
  assert.strictEqual(v.ok, false, "strict-when-present, same as voiceUx.sitrepShape");
  assert.ok(String(v.error).includes("voiceAi.completionAnnounce"), `error names the field, got: ${v.error}`);
  const ok: AnyRec = validateSettingsPutBody({ voiceAi: { completionAnnounce: "exceptions" } });
  assert.strictEqual(ok.ok, true);
});

test("PUT boundary: absent voiceAi / absent dial fields are untouched (back-compat)", () => {
  const v1: AnyRec = validateSettingsPutBody({ advanced: { globalPermissionsMode: "Inherit" } });
  assert.strictEqual(v1.ok, true);
  assert.deepStrictEqual(v1.dialViolations ?? [], [], "no dial fields -> no violations");
  const v2: AnyRec = validateSettingsPutBody({ voiceAi: { voice: "Zephyr" } });
  assert.strictEqual(v2.ok, true, "a voiceAi block without dial fields validates exactly as before");
});

test("server.ts constructs the boot arbiter FROM settings and wires the PUT re-dial (source conformance)", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "server.ts"), "utf-8");
  assert.ok(src.includes("createTurnArbiter({ matrix: manager.settings.voiceAi?.deliveryMatrix })"),
    "fikj.12 feature absent: the boot arbiter must be constructed from the persisted deliveryMatrix");
  assert.ok(src.includes("applyDeliveryDial"),
    "fikj.12 feature absent: the settings PUT must re-dial the LIVE arbiter (applyDeliveryDial dep)");
  assert.ok(src.includes("turnArbiter.updateMatrix(manager.settings.voiceAi?.deliveryMatrix)"),
    "the re-dial must read the (already clamped + persisted) settings value");
});
```

- [ ] **Step 2: Run — verify the Task-2 tests fail**

Run: `npx tsx --test --test-force-exit tests/test_delivery_dial.ts`
Expected: Task-1 tests pass; the four boundary tests fail on `dialViolations` being `undefined` / `ok:true` for `focused` / conformance strings missing. (If the `await import("../server")` fails, check the env-guard preamble from Task 1 Step 1 is at the very top of the file.)

- [ ] **Step 3: Add the settings schema fields**

In `src/types.ts`, inside `SystemSettings.voiceAi` immediately after the `groundingEnabled?: boolean;` member (~line 476), add:

```ts
    // fikj.12 (turn-arbiter D4 "a dial, with a floor"): the operator-tunable per-class narration
    // delivery matrix. Keys are arbiter classes ("0" corrections, "2" deadline narrations,
    // "3" completions, "4" acks, "5" passive context); class 1 (operator-response) has no dial.
    // ABSENT by default (the voiceUx.sessionPoolHotSlots idiom): normalizeDeliveryMatrix treats
    // absent as the spec defaults, so a pristine settings file's shape is unchanged. Under-floor
    // persisted values (passive-context on classes 0/2) CLAMP at every boundary and surface a
    // violation — no silent value exists in the type. CONFIG (persists to disk), NOT a secret.
    deliveryMatrix?: Partial<Record<"0" | "2" | "3" | "4" | "5", "forced-turn" | "steered-digest" | "passive-context">>;
    // fikj.12: vc-C's completionAnnounce tier (co-design §C). ABSENT => `dispatched` (the LOCKED
    // epic default, hasExchange-keyed). Read LIVE at the idle edge (src/voice/index.ts) — a PUT
    // applies immediately, no Apply & Reconnect. The retired v1 `focused` tier is rejected at the
    // PUT boundary and normalized away at every read site.
    completionAnnounce?: "off" | "exceptions" | "dispatched" | "all";
```

(Deliberately inline unions — `src/types.ts` stays import-free of voice modules.)

- [ ] **Step 4: Add the boundary validator + wire it into `validateSettingsPutBody`**

In `server.ts`:

(a) Extend the import at line 71 from `import { createTurnArbiter } from "./src/voice/turnArbiter";` to:

```ts
import { createTurnArbiter, normalizeDeliveryMatrix } from "./src/voice/turnArbiter";
```

(b) After `validateVoiceUxField` (line 283), add:

```ts
// fikj.12 (turn-arbiter D4): boundary handling for voiceAi's dial fields. The deliveryMatrix is
// NEVER a 400 — normalizeDeliveryMatrix (the SAME validator the arbiter re-runs internally) clamps
// under-floor/invalid values IN PLACE so the persisted value is the clamped truth, and the
// violations surface through the PUT response (`dialViolations`). completionAnnounce is a plain
// enum knob — strict-when-present, mirroring voiceUx.sitrepShape.
const SettingsCompletionAnnounceSchema = z.enum(["off", "exceptions", "dispatched", "all"]);

function clampVoiceAiDialFields(body: Record<string, unknown>): { error: string | null; violations: string[] } {
  const voiceAi = body.voiceAi;
  if (voiceAi === undefined) return { error: null, violations: [] };
  if (!isPlainObject(voiceAi)) {
    return { error: "Invalid settings field 'voiceAi': expected an object.", violations: [] };
  }
  if (voiceAi.completionAnnounce !== undefined &&
      !SettingsCompletionAnnounceSchema.safeParse(voiceAi.completionAnnounce).success) {
    return {
      error: `Invalid settings field 'voiceAi.completionAnnounce': must be one of ${SettingsCompletionAnnounceSchema.options.join(", ")}.`,
      violations: [],
    };
  }
  if (voiceAi.deliveryMatrix === undefined) return { error: null, violations: [] };
  if (!isPlainObject(voiceAi.deliveryMatrix)) {
    return { error: "Invalid settings field 'voiceAi.deliveryMatrix': expected an object map of class -> delivery mode.", violations: [] };
  }
  const { matrix, violations } = normalizeDeliveryMatrix(voiceAi.deliveryMatrix);
  voiceAi.deliveryMatrix = matrix; // clamp IN PLACE (the strip idiom): persist the clamped truth.
  return { error: null, violations };
}
```

(c) Replace `validateSettingsPutBody` (line 285) with:

```ts
export function validateSettingsPutBody(body: unknown): { ok: boolean; error?: string; dialViolations?: string[] } {
  if (!isPlainObject(body)) {
    return { ok: false, error: "Settings body must be a JSON object." };
  }
  const advanced = body.advanced;
  if (advanced !== undefined) {
    if (!isPlainObject(advanced)) {
      return { ok: false, error: "Invalid settings field 'advanced': expected an object." };
    }
    const modeError = validateGlobalModeField(advanced);
    if (modeError) return { ok: false, error: modeError };
    const gatesError = validateCapabilityGatesField(advanced);
    if (gatesError) return { ok: false, error: gatesError };
  }
  const voiceUxError = validateVoiceUxField(body);
  if (voiceUxError) return { ok: false, error: voiceUxError };
  // fikj.12: dial fields — completionAnnounce may 400; the deliveryMatrix only ever clamps+reports.
  const dial = clampVoiceAiDialFields(body);
  if (dial.error) return { ok: false, error: dial.error };
  return { ok: true, dialViolations: dial.violations };
}
```

(The return type widens additively — existing callers/tests destructure `ok`/`error` only.)

- [ ] **Step 5: Wire boot construction + the PUT re-dial**

(a) `server.ts:1838` — replace `const turnArbiter = createTurnArbiter();` with:

```ts
  // fikj.12 (D4): the boot arbiter is dialed from persisted settings. A hand-edited under-floor
  // file is clamped by the arbiter's own internal re-normalize (defense in depth); the violations
  // are surfaced here at boot so the clamp is never silent.
  for (const v of normalizeDeliveryMatrix(manager.settings.voiceAi?.deliveryMatrix).violations) {
    console.warn(`[turn-arbiter] delivery-dial settings violation (clamped at boot): ${v}`);
  }
  const turnArbiter = createTurnArbiter({ matrix: manager.settings.voiceAi?.deliveryMatrix });
```

(b) `registerDraftAndSettingsRoutes` deps (line 1281-1292) — add one optional member and destructure it:

```ts
function registerDraftAndSettingsRoutes(
  app: express.Express,
  deps: {
    broadcast: (msg: any) => void;
    broadcastDraft: (projectId: string, paneId: string) => void;
    requestVoiceReconnect: () => void;
    /** Step 3.5: the gating resolve choke-point — the typed-edit convergence + operator-direct
     *  send use it to invalidate a pending approval staged from a now-stale draft version. */
    applyResolution: (messageId: string, mode: "reject", opts?: { vocal?: boolean }) => unknown;
    /** fikj.12 (D4): re-dial the LIVE shared arbiter from the just-persisted settings. Returns any
     *  clamp violations (normally [] — the PUT boundary already clamped the body in place). */
    applyDeliveryDial?: () => string[];
  }
): void {
  const { broadcast, broadcastDraft, requestVoiceReconnect, applyResolution, applyDeliveryDial } = deps;
```

(c) In the PUT handler (line 1380-1411), thread the violations. Replace the body from `const validated = ...` through the final `res.json(...)` with:

```ts
    const validated = validateSettingsPutBody(req.body);
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const newSettings = req.body;
    // bead 9fz (part 2): capture the RAW incoming key BEFORE the masked/sentinel substitution below
    // mutates it, so we can tell a genuinely-new credential from a masked round-trip echo. NEVER logged.
    const incomingGeminiKey: string | null | undefined = newSettings.secrets?.geminiApiKey;
    const keyKeptUnchanged = newSettings.secrets && (newSettings.secrets.geminiApiKey?.includes("••••") || newSettings.secrets.geminiApiKey === "CONFIGURED_IN_ENV" || !newSettings.secrets.geminiApiKey);
    if (keyKeptUnchanged) {
      newSettings.secrets.geminiApiKey = manager.settings.secrets.geminiApiKey;
    }
    manager.updateSettings(newSettings);
    // fikj.12: apply the (already-clamped) delivery dial to the LIVE arbiter — queued items drain
    // under the new modes immediately; no reconnect, no reconstruction. Violations from the live
    // apply are normally [] (the boundary clamped the body in place above).
    const dialViolations = [ ...(validated.dialViolations ?? []), ...(applyDeliveryDial?.() ?? []) ];
    broadcast({
      type: "settings_updated",
      globalPermissionsMode: manager.globalPermissionsMode,
      settings: sanitizeSettingsForClient(manager.settings)
    });
    // bead 9fz (part 2): the operator just set a REAL (non-blank, non-masked, non-env-sentinel) Gemini
    // key — nudge the live voice session to (re)connect so they need not reload the page. The blank-key
    // short-circuit (realLiveConnector) means a prior keyless connect failed cleanly; this resumes it.
    if (shouldNudgeReconnectOnSettingsKey(incomingGeminiKey)) {
      requestVoiceReconnect();
    }
    res.json({
      success: true,
      settings: sanitizeSettingsForClient(manager.settings),
      globalPermissionsMode: manager.globalPermissionsMode,
      keyKeptUnchanged: !!keyKeptUnchanged,
      ...(dialViolations.length ? { dialViolations } : {}),
    });
```

(d) The call site at line 2154 becomes:

```ts
  registerDraftAndSettingsRoutes(app, {
    broadcast, broadcastDraft, requestVoiceReconnect, applyResolution,
    applyDeliveryDial: () => turnArbiter.updateMatrix(manager.settings.voiceAi?.deliveryMatrix).violations,
  });
```

- [ ] **Step 6: Run — Task-2 tests pass; regressions green**

Run: `npx tsx --test --test-force-exit tests/test_delivery_dial.ts`
Expected: all pass.
Run: `npx tsx --test --test-force-exit tests/test_settings_put_validation.ts tests/test_voice_ux_settings.ts`
Expected: pass (the return type widened additively; `voiceAi` without dial fields is untouched).
Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts server.ts tests/test_delivery_dial.ts
git commit -m "feat(settings): voiceAi.deliveryMatrix + completionAnnounce with boundary clamp, boot dial, live PUT re-dial (fikj.12)"
```

---

### Task 3: completionAnnounce read LIVE at the idle edge (fikj.12)

`src/voice/index.ts:2657` currently hardcodes `policy: DEFAULT_COMPLETION_ANNOUNCE`. Replace with a per-edge normalized settings read (cheap, pure — a PUT applies immediately).

**Files:**
- Modify: `src/voice/index.ts` (~line 2654-2658 + the completionPolicy import)
- Test: `tests/test_delivery_dial.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_delivery_dial.ts`:

```ts
// ── Task 3: the idle-edge completion policy reads LIVE settings ────────────────────────────────

test("the idle-edge completionNarration site reads voiceAi.completionAnnounce, not the hardcoded default", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "src/voice/index.ts"), "utf-8");
  assert.ok(src.includes("normalizeCompletionAnnounce(manager.settings.voiceAi?.completionAnnounce)"),
    "fikj.12 feature absent: the production completionNarration call site must read the live setting");
  assert.ok(!src.includes("policy: DEFAULT_COMPLETION_ANNOUNCE"),
    "the hardcoded spec default must not remain at the production call site");
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx tsx --test --test-force-exit tests/test_delivery_dial.ts`
Expected: the new test fails on the first `assert.ok` (string absent).

- [ ] **Step 3: Implement the live read**

In `src/voice/index.ts`, find the completionPolicy import (it currently imports `completionNarration` and `DEFAULT_COMPLETION_ANNOUNCE` — grep `DEFAULT_COMPLETION_ANNOUNCE` to locate it) and change it to:

```ts
import { completionNarration, normalizeCompletionAnnounce } from "./completionPolicy";
```

Then at the idle-edge site (~line 2654), replace:

```ts
          if (sig.kind === "idle") {
            const outcomeKind = completionKindFor ? completionKindFor(sig.paneId) : "completion";
            const decision = completionNarration({
              sig, outcomeKind, hasExchange: hasActiveExchange(sig.paneId), policy: DEFAULT_COMPLETION_ANNOUNCE,
            });
```

with:

```ts
          if (sig.kind === "idle") {
            const outcomeKind = completionKindFor ? completionKindFor(sig.paneId) : "completion";
            const decision = completionNarration({
              sig, outcomeKind, hasExchange: hasActiveExchange(sig.paneId),
              // fikj.12: the operator's LIVE completionAnnounce tier. normalize guards retired
              // ("focused") / garbage persisted values; absent -> the LOCKED `dispatched` default.
              // Read per idle edge (pure, cheap) so a settings PUT applies immediately.
              policy: normalizeCompletionAnnounce(manager.settings.voiceAi?.completionAnnounce),
            });
```

- [ ] **Step 4: Run — pass + regressions**

Run: `npx tsx --test --test-force-exit tests/test_delivery_dial.ts`
Expected: all pass.
Run: `npx tsx --test --test-force-exit tests/test_turn_arbiter_completions.ts tests/test_voice_journeys.ts`
Expected: pass (the mock harnesses' `manager.settings.voiceAi` is absent/partial → normalize returns `dispatched`, byte-identical to the old hardcoded default).
Run: `npm run lint`
Expected: exit 0 (confirms `DEFAULT_COMPLETION_ANNOUNCE` is no longer imported-but-unused).

- [ ] **Step 5: Commit**

```bash
git add src/voice/index.ts tests/test_delivery_dial.ts
git commit -m "feat(voice): completionAnnounce reads live settings at the idle edge (fikj.12)"
```

---

### Task 4: SettingsDialog rows + helpers + e2e leg (fikj.12)

Form state + rows in the Voice Session tab, following the silenceGate/grounding row idiom. The floor is STRUCTURAL in the UI: classes 0/2 never offer `passive-context`. CRITICAL: `getCompiledSettings` builds `voiceAi` from scratch — if the two new fields are not compiled in, every dialog save ERASES them (the 8sq drop-on-save data-loss class).

**Files:**
- Modify: `src/components/settingsDialogHelpers.ts` (VoiceFields ~line 117, deriveVoiceFields ~line 127, jsonVoicePatch ~line 198; new dial helpers)
- Modify: `src/components/SettingsDialog.tsx` (state ~line 128, applyInitialSettings ~line 206, getCompiledSettings ~line 259, JSON-sync dep list ~line 316, applyParsedJson ~line 355, JSX after the silence-gate label ~line 999)
- Test: `tests/test_delivery_dial_settings.ts` (create), `e2e/delivery_dial.spec.ts` (create)

- [ ] **Step 1: Write the failing unit tests**

Create `tests/test_delivery_dial_settings.ts`:

```ts
// tests/test_delivery_dial_settings.ts — fikj.12 RED: the SettingsDialog dial helpers.
// Runner: npx tsx --test --test-force-exit tests/test_delivery_dial_settings.ts
import { test } from "node:test";
import assert from "node:assert";
import * as helpersModule from "../src/components/settingsDialogHelpers";

type AnyRec = Record<string, any>;
const helpers = helpersModule as AnyRec;

test("dialModeOptions enforces the floor structurally: classes 0/2 never offer passive-context", () => {
  assert.strictEqual(typeof helpers.dialModeOptions, "function", "fikj.12 feature absent: dialModeOptions");
  assert.deepStrictEqual(helpers.dialModeOptions("0"), ["forced-turn", "steered-digest"]);
  assert.deepStrictEqual(helpers.dialModeOptions("2"), ["forced-turn", "steered-digest"]);
  assert.deepStrictEqual(helpers.dialModeOptions("3"), ["forced-turn", "steered-digest", "passive-context"]);
  assert.deepStrictEqual(helpers.dialModeOptions("5"), ["forced-turn", "steered-digest", "passive-context"]);
});

test("deriveDialFields: null settings -> spec defaults; persisted under-floor values CLAMP for display", () => {
  assert.strictEqual(typeof helpers.deriveDialFields, "function", "fikj.12 feature absent: deriveDialFields");
  const defaults = helpers.deriveDialFields(null);
  assert.deepStrictEqual(defaults.deliveryMatrix, {
    "0": "forced-turn", "2": "forced-turn", "3": "steered-digest", "4": "steered-digest", "5": "passive-context",
  });
  assert.strictEqual(defaults.completionAnnounce, "dispatched");
  const clamped = helpers.deriveDialFields({ voiceAi: { deliveryMatrix: { "0": "passive-context" }, completionAnnounce: "focused" } } as AnyRec);
  assert.strictEqual(clamped.deliveryMatrix["0"], "steered-digest", "the dialog never DISPLAYS an under-floor value");
  assert.strictEqual(clamped.completionAnnounce, "dispatched", "retired tier normalizes to the default");
});

test("deriveVoiceFields carries the dial fields (so applyInitialSettings + compile-in round-trip them)", () => {
  const v = helpers.deriveVoiceFields({ voiceAi: { deliveryMatrix: { "3": "forced-turn" }, completionAnnounce: "all" } } as AnyRec);
  assert.strictEqual(v.deliveryMatrix["3"], "forced-turn");
  assert.strictEqual(v.completionAnnounce, "all");
});

test("jsonVoicePatch round-trips the dial fields from the JSON tab", () => {
  const patch = helpers.jsonVoicePatch({ voiceAi: { deliveryMatrix: { "0": "passive-context" }, completionAnnounce: "off" } });
  assert.strictEqual(patch.deliveryMatrix["0"], "steered-digest", "JSON-tab input clamps too");
  assert.strictEqual(patch.completionAnnounce, "off");
  assert.deepStrictEqual(helpers.jsonVoicePatch({ voiceAi: { voice: "Zephyr" } }).deliveryMatrix, undefined,
    "absent in JSON -> absent in the patch (never overwrites form state)");
});
```

- [ ] **Step 2: Run — verify failures**

Run: `npx tsx --test --test-force-exit tests/test_delivery_dial_settings.ts`
Expected: 4 fail (`dialModeOptions`/`deriveDialFields` absent; `deliveryMatrix` undefined on VoiceFields/patch).

- [ ] **Step 3: Implement the helpers**

In `src/components/settingsDialogHelpers.ts`:

(a) Add imports at the top (alongside the existing ones):

```ts
import { normalizeDeliveryMatrix } from "../voice/turnArbiter";
import { normalizeCompletionAnnounce } from "../voice/completionPolicy";
```

(b) Add the dial block above `VoiceFields`:

```ts
// ─── fikj.12: the D4 delivery dial (per-class narration delivery + completionAnnounce) ─────────

export type DialClass = "0" | "2" | "3" | "4" | "5";
export type DialMode = "forced-turn" | "steered-digest" | "passive-context";
export type CompletionAnnounceTier = "off" | "exceptions" | "dispatched" | "all";

export const DIAL_CLASS_LABELS: Record<DialClass, { label: string; hint: string }> = {
  "0": { label: "Corrections", hint: "Retractions of narrated claims. Floor: never passive." },
  "2": { label: "Deadline narrations", hint: "Approval last-calls, autonomy warnings/expiry. Floor: never passive." },
  "3": { label: "Completions", hint: "Deterministic pane-finished narration." },
  "4": { label: "Acks", hint: "Pane created/closed acknowledgements." },
  "5": { label: "Background context", hint: "Memory briefs + passive pane signals." },
};

/** The floor, structurally: classes 0/2 never OFFER passive-context, so the dialog cannot even
 *  express an under-floor value (the server boundary clamp is the backstop for hand-edited files). */
export function dialModeOptions(cls: DialClass): DialMode[] {
  return cls === "0" || cls === "2"
    ? ["forced-turn", "steered-digest"]
    : ["forced-turn", "steered-digest", "passive-context"];
}

export interface DialFields {
  deliveryMatrix: Record<DialClass, DialMode>;
  completionAnnounce: CompletionAnnounceTier;
}

/** Normalized (clamped) dial fields for display — the dialog never shows an under-floor value. */
export function deriveDialFields(s: SystemSettings | null): DialFields {
  const { matrix } = normalizeDeliveryMatrix(s?.voiceAi?.deliveryMatrix);
  return {
    deliveryMatrix: { "0": matrix[0], "2": matrix[2], "3": matrix[3], "4": matrix[4], "5": matrix[5] },
    completionAnnounce: normalizeCompletionAnnounce(s?.voiceAi?.completionAnnounce),
  };
}
```

(c) Extend `VoiceFields` + `deriveVoiceFields`:

```ts
export interface VoiceFields {
  voice: string;
  voiceStyle: "Direct" | "Creative" | "Concise" | "Explanatory";
  volume: number;
  isMicMuted: boolean;
  model: string;
  systemPrompt: string;
  groundingEnabled: boolean;
  silenceGate: boolean;
  // fikj.12: the D4 dial rides the same voice-tab field group.
  deliveryMatrix: Record<DialClass, DialMode>;
  completionAnnounce: CompletionAnnounceTier;
}
export function deriveVoiceFields(s: SystemSettings | null): VoiceFields {
  const v = s?.voiceAi;
  return {
    voice: nn(v?.voice, "Zephyr"),
    voiceStyle: nn(v?.voiceStyle, "Creative"),
    volume: nn(v?.volume, 80),
    isMicMuted: nn(v?.isMicMuted, false),
    model: nn(v?.model, "gemini-3.1-flash-live-preview"),
    systemPrompt: nn(v?.systemPrompt, ""),
    groundingEnabled: nn(v?.groundingEnabled, false),
    silenceGate: nn(v?.silenceGate, false),
    ...deriveDialFields(s),
  };
}
```

(d) Extend `jsonVoicePatch` (after the `silenceGate` line):

```ts
  if (v.deliveryMatrix !== undefined) {
    out.deliveryMatrix = deriveDialFields({ voiceAi: { deliveryMatrix: v.deliveryMatrix } } as SystemSettings).deliveryMatrix;
  }
  if (v.completionAnnounce !== undefined) out.completionAnnounce = normalizeCompletionAnnounce(v.completionAnnounce);
```

- [ ] **Step 4: Run the unit tests — pass**

Run: `npx tsx --test --test-force-exit tests/test_delivery_dial_settings.ts`
Expected: 4 pass.

- [ ] **Step 5: Wire the dialog (state, round-trip, rows)**

In `src/components/SettingsDialog.tsx`:

(a) Extend the helpers import with `deriveDialFields, dialModeOptions, DIAL_CLASS_LABELS` and types `DialClass, DialMode, CompletionAnnounceTier` (they live in `./settingsDialogHelpers`, already imported).

(b) Add state next to the other voice state (~line 128):

```ts
  const [deliveryMatrix, setDeliveryMatrix] = useState<Record<DialClass, DialMode>>(deriveDialFields(null).deliveryMatrix);
  const [completionAnnounce, setCompletionAnnounce] = useState<CompletionAnnounceTier>("dispatched");
```

(c) In `applyInitialSettings` after `setSilenceGate(v.silenceGate);` (~line 214):

```ts
    setDeliveryMatrix(v.deliveryMatrix);
    setCompletionAnnounce(v.completionAnnounce);
```

(d) In `getCompiledSettings`'s `voiceAi` block after `silenceGate: silenceGate || undefined` (~line 274) — **this is the drop-on-save guard**:

```ts
        silenceGate: silenceGate || undefined,
        // fikj.12: ALWAYS compiled in — omitting these here would erase them on every save (the
        // 8sq drop-on-save data-loss class the capabilityGates round-trip guard pins).
        deliveryMatrix,
        completionAnnounce
```

(e) Add `deliveryMatrix, completionAnnounce` to the JSON-sync `useEffect` dependency array (~line 316, on the line with `silenceGate`).

(f) In `applyParsedJson`'s voice `applyPatch` setters (~line 355-358), add:

```ts
      deliveryMatrix: setDeliveryMatrix, completionAnnounce: setCompletionAnnounce,
```

(g) Insert the rows block in the Voice Session tab JSX, directly after the silence-gate `</label>` (line ~999) and before the "Apply Voice Session Changes" div:

```tsx
      {/* fikj.12 (turn-arbiter D4): the per-class narration delivery dial. Classes 0/2 structurally
          exclude passive-context (the never-silent floor); the server boundary clamps hand-edited
          files the same way. Applies LIVE on save — no reconnect. */}
      <div className="p-3 bg-black/30 border border-white/10 rounded-lg">
        <span className="text-zinc-300 font-bold block text-xs mb-1">Narration delivery (per class)</span>
        <span className="text-xs text-zinc-500 leading-relaxed block mb-2">
          How each narration class reaches you: forced turn (always spoken at the next turn-clear),
          steered digest (spoken when it warrants speech), or passive context (context only, never a
          spoken turn). Corrections and deadline narrations can never be passive. Applies on save.
        </span>
        {(Object.keys(DIAL_CLASS_LABELS) as DialClass[]).map(cls => (
          <div key={cls} className="flex items-center justify-between gap-3 py-1">
            <span className="min-w-0">
              <span className="text-zinc-300 block text-xs">{`Class ${cls} — ${DIAL_CLASS_LABELS[cls].label}`}</span>
              <span className="text-xs text-zinc-600 block">{DIAL_CLASS_LABELS[cls].hint}</span>
            </span>
            <select
              data-testid={`settings-dial-class-${cls}`}
              value={deliveryMatrix[cls]}
              onChange={e => setDeliveryMatrix(prev => ({ ...prev, [cls]: e.target.value as DialMode }))}
              className="bg-black border border-white/10 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-cyan-500"
            >
              {dialModeOptions(cls).map(m => (<option key={m} value={m}>{m}</option>))}
            </select>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 py-1 mt-2 border-t border-white/5 pt-2">
          <span className="min-w-0">
            <span className="text-zinc-300 block text-xs">Completion announcements</span>
            <span className="text-xs text-zinc-600 block">
              off = earcon only · exceptions = failures/questions · dispatched = anything you started
              (default) · all = every idle
            </span>
          </span>
          <select
            data-testid="settings-completion-announce"
            value={completionAnnounce}
            onChange={e => setCompletionAnnounce(e.target.value as CompletionAnnounceTier)}
            className="bg-black border border-white/10 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-cyan-500"
          >
            {(["off", "exceptions", "dispatched", "all"] as const).map(t => (<option key={t} value={t}>{t}</option>))}
          </select>
        </div>
      </div>
```

- [ ] **Step 6: Write the e2e spec**

Create `e2e/delivery_dial.spec.ts`:

```ts
import { test, expect, gotoMockedApp } from "./fixtures";

/**
 * fikj.12: the D4 delivery-dial rows — the pure-JSX leg (same split as e2e/voice_silence_gate.spec.ts:
 * boundary + arbiter behavior are unit-pinned in tests/test_delivery_dial*.ts; this proves the rows
 * render with the STRUCTURAL floor and the locked defaults).
 */
test.describe("delivery-mode dial rows (fikj.12)", () => {
  test("per-class selects render with the never-silent floor and locked defaults", async ({ page }) => {
    await gotoMockedApp(page);
    await page.getByRole("button", { name: /config/i }).click();
    await page.getByRole("button", { name: "Voice Session", exact: true }).click();

    const class0 = page.getByTestId("settings-dial-class-0");
    await expect(class0).toBeVisible();
    await expect(class0.locator("option")).toHaveCount(2); // floor: passive-context not even offered
    await expect(class0).toHaveValue("forced-turn");

    const class3 = page.getByTestId("settings-dial-class-3");
    await expect(class3.locator("option")).toHaveCount(3);
    await expect(class3).toHaveValue("steered-digest");
    await class3.selectOption("forced-turn");
    await expect(class3).toHaveValue("forced-turn");

    await expect(page.getByTestId("settings-completion-announce")).toHaveValue("dispatched");
  });
});
```

- [ ] **Step 7: Run everything for this task**

Run: `npx tsx --test --test-force-exit tests/test_delivery_dial_settings.ts`
Expected: pass.
Run: `npm run lint`
Expected: exit 0.
Run: `npx playwright test e2e/delivery_dial.spec.ts e2e/voice_silence_gate.spec.ts`
Expected: both specs pass (silence-gate proves the tab still renders around the new block).

- [ ] **Step 8: Commit**

```bash
git add src/components/settingsDialogHelpers.ts src/components/SettingsDialog.tsx tests/test_delivery_dial_settings.ts e2e/delivery_dial.spec.ts
git commit -m "feat(ui): SettingsDialog delivery-dial rows with structural floor + completionAnnounce tier (fikj.12)"
```

---

### Task 5: `correctionLedger.latestSpokenClaim` — the producer-side query (fikj.11)

The completion producer (Task 8) must decide whether an error/exited signal contradicts *a completion claim specifically* — invalidating by bare paneId would retract whatever claim was last spoken (e.g. a dispatch claim), a FALSE correction. Add one additive read; kind/recency policy stays in the producer so the ledger remains clock-free.

**Files:**
- Modify: `src/voice/correctionLedger.ts` (factory return, ~line 110)
- Test: `tests/test_correction_ledger_query.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_correction_ledger_query.ts`:

```ts
// tests/test_correction_ledger_query.ts — fikj.11 RED: the latestSpokenClaim producer query.
// The ledger stays CLOCK-FREE (no staleness path — co-design §D revision); kind + recency policy
// live at the PRODUCER (src/voice/index.ts completionContradiction, Task 8), which needs this read.
// Runner: npx tsx --test --test-force-exit tests/test_correction_ledger_query.ts
import { test } from "node:test";
import assert from "node:assert";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";

type AnyRec = Record<string, any>;
const T0 = 1_700_000_000_000;

test("latestSpokenClaim resolves the newest SPOKEN claim on a pane ({claimId, kind, assertedAt})", () => {
  const led: AnyRec = createCorrectionLedger({ arbiter: createTurnArbiter() });
  assert.strictEqual(typeof led.latestSpokenClaim, "function",
    "fikj.11 feature absent: correctionLedger.latestSpokenClaim(paneId)");
  assert.strictEqual(led.latestSpokenClaim("p1"), undefined, "no claims -> undefined");
  led.record({ claimId: "c1", paneId: "p1", kind: "dispatch", assertedText: "Dispatching now.", assertedAt: T0, spoken: true });
  led.record({ claimId: "c2", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0 + 500, spoken: true });
  assert.deepStrictEqual(led.latestSpokenClaim("p1"), { claimId: "c2", kind: "completion", assertedAt: T0 + 500 });
});

test("latestSpokenClaim ignores unspoken claims (a suppressed ack is not an operative belief)", () => {
  const led: AnyRec = createCorrectionLedger({ arbiter: createTurnArbiter() });
  led.record({ claimId: "c1", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0, spoken: true });
  led.record({ claimId: "c2", paneId: "p1", kind: "readiness", assertedText: "pane p1 ready", assertedAt: T0 + 100, spoken: false });
  assert.deepStrictEqual(led.latestSpokenClaim("p1"), { claimId: "c1", kind: "completion", assertedAt: T0 });
});

test("latestSpokenClaim is pane-scoped", () => {
  const led: AnyRec = createCorrectionLedger({ arbiter: createTurnArbiter() });
  led.record({ claimId: "c1", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0, spoken: true });
  assert.strictEqual(led.latestSpokenClaim("p2"), undefined);
});
```

- [ ] **Step 2: Run — verify failure**

Run: `npx tsx --test --test-force-exit tests/test_correction_ledger_query.ts`
Expected: 3 fail (`latestSpokenClaim` is not a function).

- [ ] **Step 3: Implement the query**

In `src/voice/correctionLedger.ts`, before the factory's `return` (line 110), add — and extend the return:

```ts
  /** fikj.11 (additive): the producer-side read behind contradiction guards. Returns the newest
   *  SPOKEN claim on a pane so a producer can check KIND and RECENCY before electing an
   *  invalidation (e.g. an `exited` signal only contradicts a *completion* claim, and only a
   *  recent one). Policy stays in the producer — this module remains clock-free, and there is
   *  still no staleness path inside the ledger. */
  function latestSpokenClaim(
    paneId: string,
  ): { claimId: string; kind: CorrectionClaim["kind"]; assertedAt: number } | undefined {
    const id = latestSpokenByPane.get(paneId);
    const claim = id ? claims.get(id) : undefined;
    return claim ? { claimId: claim.claimId, kind: claim.kind, assertedAt: claim.assertedAt } : undefined;
  }

  return { record, invalidate, latestSpokenClaim };
```

- [ ] **Step 4: Run — pass + regression**

Run: `npx tsx --test --test-force-exit tests/test_correction_ledger_query.ts tests/test_turn_arbiter_corrections.ts`
Expected: all pass (PR #153's pinned surface is untouched — purely additive).

- [ ] **Step 5: Commit**

```bash
git add src/voice/correctionLedger.ts tests/test_correction_ledger_query.ts
git commit -m "feat(voice): correctionLedger.latestSpokenClaim producer query (fikj.11)"
```

---

### Task 6: Producer 1 — renderApproved dispatch claims + honest-first-claim ordering (fikj.11)

`renderApproved` (`src/gating/index.ts:1183`) is the single approved-write path. Two changes: (1) the a2tp ships-now ordering fix — an Exited-but-present pane routes to `renderDeadPane` (an honest FIRST claim) instead of `writeInput` silently buffering into `pendingInput` (`src/terminal.ts:1216`) under an optimistic "Dispatching now"; (2) on the success arm, record a `dispatch` claim whose `spoken` flag is the narration push result (3V.3: only a strict `false`, or no session, means unheard). The invalidate seam for dispatch claims is deliberately NOT fired from production here — a2tp (commit-time revalidation) and qj6s (launch plans) are the named future consumers; wiring a homegrown liveness probe would violate "does NOT re-implement liveness/policy checks".

**Files:**
- Modify: `src/gating/index.ts` (GatingDeps ~line 107-133, destructure ~line 217-229, renderApproved ~line 1183-1193)
- Test: `tests/test_vcd_producer_dispatch.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_vcd_producer_dispatch.ts`:

```ts
// tests/test_vcd_producer_dispatch.ts — fikj.11 RED, producer 1: renderApproved records the
// "Dispatching now" DISPATCH claim + the a2tp ships-now ordering fix (Exited pane -> honest
// renderDeadPane FIRST claim, never an optimistic claim needing retraction).
//
// Harness: the tests/test_turn_arbiter_deadlines.ts real-gating/fake-boundaries idiom.
// Runner: npx tsx --test --test-force-exit tests/test_vcd_producer_dispatch.ts
import { test } from "node:test";
import assert from "node:assert";
import { createGating } from "../src/gating";

type AnyRec = Record<string, any>;
const T0 = 1_700_000_000_000;

function captureLedger() {
  const records: AnyRec[] = [];
  const invalidations: AnyRec[] = [];
  return {
    records, invalidations,
    record: (c: AnyRec) => { records.push(c); },
    invalidate: (ref: string, groundTruth: string, opts?: AnyRec) => {
      invalidations.push({ ref, groundTruth, opts });
      return { corrected: true };
    },
    latestSpokenClaim: (_p: string) => undefined,
  };
}

function makeHarness(opts: { ledger?: AnyRec; paneStatus?: string; pushOk?: boolean } = {}) {
  const narrations: string[] = [];
  const broadcasts: AnyRec[] = [];
  const writes: string[] = [];
  const session = { sendClientContent: () => {} };
  const manager: AnyRec = {
    globalPermissionsMode: "Inherit",
    terminals: {
      t1: {
        status: opts.paneStatus ?? "Running",
        writeInput: (cmd: string) => { writes.push(cmd); },
        stop: async () => {},
      },
    },
    settings: { advanced: { capabilityGates: {} } },
    ledger: {
      activeProjectId: "default_project",
      getActiveProject: () => undefined,
      getDraft: () => undefined,
      setDraft: () => {},
      plans: [], watchRules: [], save: () => {},
    },
  };
  const coreState: AnyRec = {
    activeFrontendWs: null, activeLiveSession: session, clients: new Set(),
    activePaneId: null, frozen: false, lastStopAllFailed: [], setFrozen: () => {},
  };
  const deps: any = {
    manager, store: null,
    broadcast: (m: AnyRec) => broadcasts.push(m),
    broadcastLedgerUpdate: () => {}, broadcastDraft: () => {},
    coreState,
    announcementBus: { enqueue: () => true, stop: () => {} },
    pushApprovalNarration: (_s: any, text: string) => { narrations.push(text); return opts.pushOk ?? true; },
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
    ...(opts.ledger ? { correctionLedger: opts.ledger } : {}),
  };
  const gating: AnyRec = createGating(deps);
  return { gating, narrations, broadcasts, writes, session, manager };
}

function addApproval(h: AnyRec, id = "d1", session: AnyRec | null = h.session): void {
  h.gating.pendingApprovals.add(
    { messageId: id, instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: id, timestamp: T0 } as any,
    session,
  );
}

test("AC1: an approved dispatch records ONE spoken dispatch claim after the write + narration", () => {
  const led = captureLedger();
  const h = makeHarness({ ledger: led });
  addApproval(h);
  h.gating.applyResolution("d1", "approve");
  assert.deepStrictEqual(h.writes, ["npm run deploy"], "the write landed");
  assert.ok(h.narrations.some(n => n.includes("Dispatching now")), "the post-dispatch narration fired");
  assert.strictEqual(led.records.length, 1, "fikj.11 feature absent: renderApproved must record the dispatch claim");
  const claim = led.records[0];
  assert.strictEqual(claim.claimId, "dispatch:d1", "claimId is the approval messageId — the a2tp invalidate handle");
  assert.strictEqual(claim.paneId, "t1");
  assert.strictEqual(claim.kind, "dispatch");
  assert.strictEqual(claim.spoken, true, "a successful narration push == a spoken claim");
  assert.ok(claim.assertedText.includes("Dispatching now"));
  assert.strictEqual(led.invalidations.length, 0, "negative fixture: a clean dispatch is never self-corrected");
});

test("a failed narration push records spoken:false (3V.3 — the operator never heard the claim)", () => {
  const led = captureLedger();
  const h = makeHarness({ ledger: led, pushOk: false });
  addApproval(h);
  h.gating.applyResolution("d1", "approve");
  assert.strictEqual(led.records.length, 1);
  assert.strictEqual(led.records[0].spoken, false, "unheard -> a later invalidate must skip (never-spoken rule)");
});

test("no live session records spoken:false (bookkeeping only — nothing to retract)", () => {
  const led = captureLedger();
  const h = makeHarness({ ledger: led });
  addApproval(h, "d1", null);
  h.gating.applyResolution("d1", "approve");
  assert.strictEqual(led.records.length, 1);
  assert.strictEqual(led.records[0].spoken, false);
  assert.strictEqual(h.narrations.length, 0);
});

test("ships-now ordering: an Exited-but-present pane renders the DEAD-PANE truth, no write, no claim", () => {
  const led = captureLedger();
  const h = makeHarness({ ledger: led, paneStatus: "Exited" });
  addApproval(h);
  h.gating.applyResolution("d1", "approve");
  assert.deepStrictEqual(h.writes, [], "writeInput must NOT buffer into a dead pane");
  assert.ok(h.narrations.some(n => n.includes("could not dispatch")),
    "the honest failure is the FIRST claim (renderDeadPane), not a retraction-needing 'Dispatching now'");
  assert.ok(!h.narrations.some(n => n.includes("Dispatching now")));
  assert.strictEqual(led.records.length, 0, "no optimistic claim exists to retract");
  assert.ok(h.broadcasts.some(b => b.type === "blocked" || b.reason === "Target pane missing."),
    "the UI sees the blocked outcome");
});

test("no ledger injected (legacy harness) -> byte-identical approve behavior, no throw", () => {
  const h = makeHarness({});
  addApproval(h);
  const r = h.gating.applyResolution("d1", "approve");
  assert.strictEqual(r.reason, "approved");
  assert.deepStrictEqual(h.writes, ["npm run deploy"]);
});
```

- [ ] **Step 2: Run — verify failures**

Run: `npx tsx --test --test-force-exit tests/test_vcd_producer_dispatch.ts`
Expected: tests 1–4 fail (`led.records.length` is 0; Exited pane still writes). Test 5 passes (it pins today's behavior).

- [ ] **Step 3: Implement**

In `src/gating/index.ts`:

(a) Add to `GatingDeps` (after the `turnArbiter?` member, ~line 132) — structural type, NOT an import (gating never imports voice):

```ts
  /** fikj.11 (vc-D wiring): the correction-ledger seam. renderApproved records the spoken
   *  "Dispatching now" DISPATCH claim so ground-truth flips (a2tp commit-time revalidation, qj6s
   *  launch plans — the named future consumers) can retract it via invalidate; the boot-hydration
   *  effect builders thread it through to the restart replay (Task 7). OPTIONAL: absent (legacy
   *  harnesses) => byte-identical behavior. Structural — gating never imports src/voice. */
  correctionLedger?: {
    record(claim: {
      claimId: string; paneId: string;
      kind: "dispatch" | "restart" | "completion" | "readiness";
      assertedText: string; assertedAt: number; spoken: boolean;
    }): void;
    invalidate(ref: string, groundTruth: string, opts?: { severity?: "exception" | "info" }): { corrected: boolean; reason?: string };
  };
```

(b) Add `correctionLedger,` to the destructure at line 217-229 (after `turnArbiter,`).

(c) Replace `renderApproved` (lines 1183-1193) with:

```ts
  function renderApproved(record: ResolvedRecord, safeInstr: string, verb: string, session: any, opts?: { vocal?: boolean }): void {
    // Claim already won inside resolveDecision — this is the single write path.
    // fikj.11 / co-design §D (a2tp ships-now ordering): an Exited-but-present pane CANNOT receive a
    // dispatch — writeInput would silently buffer into pendingInput (src/terminal.ts:1216) and even
    // optimistically flip status to Running, making "Dispatching now" a FALSE claim. Same check the
    // Full-Auto arm already applies (src/dispatch/paneWrite.ts). Narrate the honest failure as the
    // FIRST claim (renderDeadPane) instead of an optimistic claim that needs retracting.
    const term = manager.terminals[record.terminalId];
    if (!term || term.status === "Exited") {
      renderDeadPane(record, safeInstr, session);
      return;
    }
    beginExchangeDeliveryOnApprove(record);
    addCommand(record.terminalId, record.instruction, record.exchangeId);
    term.writeInput(record.instruction);
    completeExchangeDeliveryOnApprove(record);
    clearMatchingDraftOnApprove(record);
    // Narration stays POST-dispatch (it already was — the write above precedes it). The push result
    // is the claim's `spoken` flag: 3V.3 semantics — only a strict `false` (or no session) is unheard.
    const narration = `Approving: ${verb} ${record.terminalId} — "${safeInstr}". Dispatching now.`;
    const spoken = session ? pushApprovalNarration(session, narration) !== false : false;
    recordDispatchClaim(record, narration, spoken);
    // P1-2: operator-APPROVED, not an auto-execution — flag it so the UI does not mislabel.
    broadcast({ type: WS_EVT.AUTO_EXECUTED, terminalId: record.terminalId, cmd: safeInstr, approved: true, ...(opts?.vocal ? { vocal: true } : {}) });
  }

  /** fikj.11: best-effort dispatch-claim record — a ledger fault must never break the resolution.
   *  claimId == `dispatch:<messageId>` so a2tp/qj6s can invalidate by approval identity; the
   *  ledger's (pane, kind) supersession handles repeat dispatches on one pane. */
  function recordDispatchClaim(record: ResolvedRecord, assertedText: string, spoken: boolean): void {
    if (!correctionLedger) return;
    try {
      correctionLedger.record({
        claimId: `dispatch:${record.messageId}`,
        paneId: record.terminalId,
        kind: "dispatch",
        assertedText,
        assertedAt: Date.now(),
        spoken,
      });
    } catch (e) {
      console.error("[vc-d] dispatch claim record failed:", e);
    }
  }
```

- [ ] **Step 4: Run — pass + regressions**

Run: `npx tsx --test --test-force-exit tests/test_vcd_producer_dispatch.ts`
Expected: 5 pass.
Run: `npx tsx --test --test-force-exit tests/test_approvals.ts tests/test_approvals_logic.ts tests/test_approval_golden_parity.ts tests/test_approval_dupsend.ts tests/test_turn_arbiter_deadlines.ts tests/test_turn_arbiter_journeys.ts tests/test_voice_journeys.ts`
Expected: all pass. **If any fail on the Exited-pane guard** (a harness approving into a pane whose fake has `status: "Exited"` or no `status` field): note that `!term || term.status === "Exited"` treats a status-less fake as alive (only the literal `"Exited"` string trips it) — investigate the specific fixture before touching the guard; the guard is spec-mandated.

- [ ] **Step 5: Commit**

```bash
git add src/gating/index.ts tests/test_vcd_producer_dispatch.ts
git commit -m "feat(gating): renderApproved dispatch-claim record + honest dead-pane first claim (fikj.11 producer 1)"
```

---

### Task 7: Producer 2 — restart-ack record + failure/cancel invalidate (fikj.11)

`"Terminal ${id} restarted."` is an ACK-BEFORE-READINESS claim: the ordered `stop()→start()` runs on a deferred promise chain AFTER the string returns (`src/actions/defs/panes_rest.ts:184-215`; replay twin `src/actionEffects.ts:579-614`). Today its failure arms only `console.error` — the operator is never told. Record the claim when the ack is produced (`spoken: true` — the confirm string always reaches the invoking surface); invalidate in the `.catch` and in the kdtu 86-during-restart guard-return (restart cancelled by an interleaved archive). The shared helper lives in `src/actions/respawnFromLedger.ts` — the file both restart paths already import — so the mirrored copies cannot drift.

**Files:**
- Modify: `src/actions/types.ts` (ActionContext, ~line 280 area)
- Modify: `src/actions/respawnFromLedger.ts` (add `invalidateRestartClaim`)
- Modify: `src/actions/defs/panes_rest.ts` (restartEffect, lines 184-221)
- Modify: `src/actionEffects.ts` (ActionEffectDeps ~line 220, buildRespawnPane ~line 579)
- Modify: `src/gating/index.ts` (boot-hydration `buildActionRun` deps bag, ~line 330-337)
- Test: `tests/test_vcd_producer_restart.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_vcd_producer_restart.ts`:

```ts
// tests/test_vcd_producer_restart.ts — fikj.11 RED, producer 2: the restart ACK-before-readiness
// claim records at ack time and RETRACTS on the async failure/cancel arms (which today only
// console.error — the operator is never told; co-design §D rank-5).
// Runner: npx tsx --test --test-force-exit tests/test_vcd_producer_restart.ts
import { test } from "node:test";
import assert from "node:assert";
import { respawnPane } from "../src/actions/defs/panes_rest";
import { buildActionRun } from "../src/actionEffects";

type AnyRec = Record<string, any>;
const tick = () => new Promise<void>(r => setImmediate(() => setImmediate(() => r())));

function captureLedger() {
  const records: AnyRec[] = [];
  const invalidations: AnyRec[] = [];
  return {
    records, invalidations,
    record: (c: AnyRec) => { records.push(c); },
    invalidate: (ref: string, groundTruth: string, opts?: AnyRec) => {
      invalidations.push({ ref, groundTruth, opts });
      return { corrected: true };
    },
    latestSpokenClaim: (_p: string) => undefined,
  };
}

function makeCtx(opts: { stopFails?: boolean; archiveDuringStop?: boolean; ledger?: boolean } = {}) {
  const ledger = captureLedger();
  const term: AnyRec = {
    projectId: "p1",
    started: false,
    stop: async () => {
      if (opts.stopFails) throw new Error("stop failed");
      if (opts.archiveDuringStop) ctx.manager.archivingPanes.add("t1");
    },
    start: () => { term.started = true; },
  };
  const ctx: AnyRec = {
    manager: {
      terminals: { t1: term },
      archivingPanes: new Set<string>(),
      ledger: { getProject: () => ({ id: "p1", panes: { t1: { id: "t1" } } }), getActiveProject: () => undefined },
      settings: { advanced: {} },
    },
    ...(opts.ledger === false ? {} : { correctionLedger: ledger }),
    gateOrDefer: (_cap: string, _pane: string, _summary: string, _run: () => string) => ({ disposition: "run" }),
    broadcastLedgerUpdate: () => {},
    broadcastTerminalsUpdated: () => {},
    broadcast: () => {},
  };
  return { ctx, ledger, term };
}

test("a live-terminal restart records ONE spoken restart claim; a clean restart never self-corrects", async () => {
  const { ctx, ledger, term } = makeCtx();
  const result: AnyRec = respawnPane.handler({ pane_id: "t1" } as AnyRec, ctx as AnyRec);
  assert.strictEqual(result.kind, "ok");
  assert.strictEqual(result.output, "Terminal t1 restarted.");
  assert.strictEqual(ledger.records.length, 1, "fikj.11 feature absent: the restart ack must record a claim");
  assert.strictEqual(ledger.records[0].kind, "restart");
  assert.strictEqual(ledger.records[0].paneId, "t1");
  assert.strictEqual(ledger.records[0].spoken, true, "the confirm string always reaches the invoking surface");
  assert.strictEqual(ledger.records[0].assertedText, "Terminal t1 restarted.");
  await tick();
  assert.strictEqual(term.started, true);
  assert.strictEqual(ledger.invalidations.length, 0, "negative fixture: a successful restart is never corrected");
});

test("a failed stop() RETRACTS the ack claim (exception severity, same claimId)", async () => {
  const { ctx, ledger } = makeCtx({ stopFails: true });
  respawnPane.handler({ pane_id: "t1" } as AnyRec, ctx as AnyRec);
  await tick();
  assert.strictEqual(ledger.invalidations.length, 1,
    "fikj.11 feature absent: the async failure arm must invalidate the restart claim");
  assert.strictEqual(ledger.invalidations[0].ref, ledger.records[0].claimId, "retracts by the SAME claim identity");
  assert.ok(ledger.invalidations[0].groundTruth.includes("failed"), "the ground truth names the failure");
  assert.deepStrictEqual(ledger.invalidations[0].opts, { severity: "exception" });
});

test("the kdtu 86-during-restart cancel RETRACTS the ack claim (restart never happened)", async () => {
  const { ctx, ledger, term } = makeCtx({ archiveDuringStop: true });
  respawnPane.handler({ pane_id: "t1" } as AnyRec, ctx as AnyRec);
  await tick();
  assert.strictEqual(term.started, false, "the guard held — no ghost PTY");
  assert.strictEqual(ledger.invalidations.length, 1);
  assert.ok(ledger.invalidations[0].groundTruth.includes("cancelled"), "the ground truth says cancelled, not failed");
});

test("no ledger on ctx (legacy) -> unchanged behavior, no throw", async () => {
  const { ctx } = makeCtx({ ledger: false, stopFails: true });
  const result: AnyRec = respawnPane.handler({ pane_id: "t1" } as AnyRec, ctx as AnyRec);
  assert.strictEqual(result.output, "Terminal t1 restarted.");
  await tick(); // the .catch console.errors — must not throw
});

test("the buildActionRun replay twin mirrors record + failure invalidate", async () => {
  const { ctx, ledger } = makeCtx({ stopFails: true });
  const deps: AnyRec = {
    manager: ctx.manager,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    sanitizeSettingsForClient: (s: AnyRec) => s,
    correctionLedger: ledger,
  };
  const out = buildActionRun({ capability: "restart_pane", params: { paneId: "t1" } } as AnyRec, deps)();
  assert.strictEqual(out, "Terminal t1 restarted.");
  assert.strictEqual(ledger.records.length, 1, "the replay records the claim too");
  await tick();
  assert.strictEqual(ledger.invalidations.length, 1, "the replay's failure arm retracts too");
});
```

- [ ] **Step 2: Run — verify failures**

Run: `npx tsx --test --test-force-exit tests/test_vcd_producer_restart.ts`
Expected: tests 1–3 and 5 fail (`records.length` 0 / `invalidations.length` 0); test 4 passes.

- [ ] **Step 3: Implement the shared seam + both restart paths**

(a) In `src/actions/types.ts`, add to `ActionContext` (near the other optional members, e.g. after `audit?`):

```ts
  /** fikj.11 (vc-D): correction-ledger seam for the restart-ack producer. `record` logs the
   *  "Terminal X restarted." ACK-before-readiness claim (spoken:true — the confirm string always
   *  reaches the invoking surface); `invalidate` retracts it when the ordered async stop()->start()
   *  later fails or is cancelled by an interleaved archive (the arms that today only console.error).
   *  OPTIONAL + structural (no src/voice value import); absent on test/legacy paths. */
  correctionLedger?: {
    record(claim: {
      claimId: string; paneId: string;
      kind: "dispatch" | "restart" | "completion" | "readiness";
      assertedText: string; assertedAt: number; spoken: boolean;
    }): void;
    invalidate(ref: string, groundTruth: string, opts?: { severity?: "exception" | "info" }): { corrected: boolean; reason?: string };
  };
```

(b) In `src/actions/respawnFromLedger.ts`, add at the bottom:

```ts
/** fikj.11 (vc-D): the restart-claim seam shared by the LIVE handler (panes_rest.ts) and the
 *  replay builder (actionEffects.ts) — kept in the respawn home both already import so the two
 *  mirrored restart paths cannot drift. Best-effort: a correction fault never breaks the restart. */
export type RestartClaimLedger = {
  record(claim: {
    claimId: string; paneId: string;
    kind: "dispatch" | "restart" | "completion" | "readiness";
    assertedText: string; assertedAt: number; spoken: boolean;
  }): void;
  invalidate(ref: string, groundTruth: string, opts?: { severity?: "exception" | "info" }): unknown;
};

/** Record the ACK-before-readiness claim at ack time. Returns the claimId the async arms retract
 *  by. Time-suffixed: a repeat restart supersedes its predecessor through the ledger's own
 *  (pane, kind) supersession — never a duplicate correction. */
export function recordRestartClaim(ledger: RestartClaimLedger | undefined, paneId: string, assertedText: string): string {
  const claimId = `restart:${paneId}:${Date.now()}`;
  if (!ledger) return claimId;
  try {
    ledger.record({ claimId, paneId, kind: "restart", assertedText, assertedAt: Date.now(), spoken: true });
  } catch (e) {
    console.error(`[vc-d] restart claim record failed for ${paneId}:`, e);
  }
  return claimId;
}

/** Retract a restart-ack claim (exception severity — a not-up pane is the worst kind of news). */
export function invalidateRestartClaim(
  ledger: RestartClaimLedger | undefined,
  claimId: string,
  paneId: string,
  groundTruth: string,
): void {
  if (!ledger) return;
  try {
    ledger.invalidate(claimId, `pane ${paneId}: ${groundTruth}`, { severity: "exception" });
  } catch (e) {
    console.error(`[vc-d] restart claim invalidate failed for ${paneId}:`, e);
  }
}
```

(c) In `src/actions/defs/panes_rest.ts`, extend the import from `../respawnFromLedger`:

```ts
import { respawnFromLedger, recordRestartClaim, invalidateRestartClaim } from "../respawnFromLedger";
```

and replace the live-terminal branch of `restartEffect` (lines 184-216) with:

```ts
    const restartEffect = (): string => {
      if (term) {
        // fikj.11 (vc-D): "Terminal X restarted." is an ACK-BEFORE-READINESS claim — the ordered
        // stop()->start() below runs AFTER this string returns. Record the claim now; the failure/
        // cancel arms retract it (a class-0 correction via the ledger's injected arbiter).
        const claimId = recordRestartClaim(ctx.correctionLedger, id, `Terminal ${id} restarted.`);
        // Ordered async restart, fire-and-return: stop() (SIGTERM->SIGKILL) MUST resolve before start()
        // spawns the replacement. The ordering is preserved inside this IIFE; the gate's sync `run`
        // contract only needs the confirm string back, which the inline route returned eagerly too.
        // kcc0: serialize per-pane via withPaneLifecycleLock so a SECOND overlapping respawn on this
        // pane queues behind this one instead of both racing term.stop()/term.start() (3P.3 already
        // stops two LIVE PTYs from coexisting, but a queued-not-racing pair is deterministic instead of
        // "whichever start() runs last wins"). On an uncontended pane (every scenario the existing
        // kdtu tests pin) the lock invokes this closure IMMEDIATELY in the same tick — term.stop() still
        // fires synchronously here, unchanged from before this lock existed.
        void withPaneLifecycleLock(id, async () => {
          await term.stop();
          // 86-during-restart race (wsm-e2e-pinned-kdtu): while stop() is awaited the pane reads Exited,
          // so the UI legitimately offers one-tap 86. If the operator archives in that gap, resuming here
          // and calling term.start() would respawn a GHOST PTY for a pane no longer on the board. TWO
          // guards, because the archive can land on either side of this continuation:
          //   1. OWNERSHIP — terminals[id] must still be THIS instance.
          //   2. ARCHIVE INTENT — manager.archivingPanes is marked SYNCHRONOUSLY at archive entry.
          // The checks and term.start() share one synchronous tick — no await re-opens the window.
          if (ctx.manager.terminals[id] !== term || ctx.manager.archivingPanes?.has(id)) {
            // fikj.11: the restart was CANCELLED — the already-delivered "restarted" ack is false.
            invalidateRestartClaim(ctx.correctionLedger, claimId, id, "the restart was cancelled — the pane was archived or removed first");
            return;
          }
          term.start();
          ctx.broadcastLedgerUpdate();
          ctx.broadcastTerminalsUpdated();
        }).catch((e) => {
          console.error(`[restart_pane] deferred restart failed for ${id}:`, e);
          // fikj.11: the ack was already delivered — retract it (today this arm is operator-silent).
          invalidateRestartClaim(ctx.correctionLedger, claimId, id, "the restart actually failed — the pane is not up");
        });
        return `Terminal ${id} restarted.`;
      }
      // Spawn into the pane's OWNING project (its directory + project id as the 7th arg), NOT the active
      // project — mirrors archive.ts Restore so a non-active-project pane lands back where it belongs.
      // Shared spawn closure: presetCommand(normalizePreset(pane.tool_preset), …) — one launch home.
      // (Synchronous — a throw here surfaces to the caller BEFORE any ack exists, so no claim to record.)
      return respawnFromLedger(ctx, id, pane!, owner!.projectId, `Terminal ${id} restored and started.`);
    };
```

(d) In `src/actionEffects.ts`:

- Extend `ActionEffectDeps` (line 220-226):

```ts
export interface ActionEffectDeps {
  manager: any;                 // OrchestratorManager (typed loosely to avoid a server import cycle)
  broadcast: (msg: any) => void;
  broadcastLedgerUpdate: () => void;
  sanitizeSettingsForClient: (s: any) => any;
  setActivePane?: (paneId: string | null) => void;
  /** fikj.11 (vc-D): threaded from GatingDeps by the boot-hydration loop so a REPLAYED restart
   *  records/retracts its ack claim exactly like the live handler (lockstep rule). Optional. */
  correctionLedger?: import("./actions/respawnFromLedger").RestartClaimLedger;
}
```

- Add `recordRestartClaim, invalidateRestartClaim` to the existing `respawnFromLedger` import in this file, and replace `buildRespawnPane`'s live-terminal branch (lines 588-604) with:

```ts
  return () => {
    const id = p.paneId;
    const term = deps.manager.terminals[id];
    const owner = findPaneOwningProject(deps.manager, id);
    if (!term && !owner) return `Terminal ${id} not found.`;
    if (term) {
      // fikj.11: same ACK-before-readiness claim + retraction arms as the live handler (lockstep).
      const claimId = recordRestartClaim(deps.correctionLedger, id, `Terminal ${id} restarted.`);
      void (async () => {
        await term.stop();
        // Same synchronous-tick guard as the live handler (kdtu): no await between the checks and
        // term.start() re-opens the 86-during-restart window.
        if (deps.manager.terminals[id] !== term || deps.manager.archivingPanes?.has(id)) {
          invalidateRestartClaim(deps.correctionLedger, claimId, id, "the restart was cancelled — the pane was archived or removed first");
          return;
        }
        term.start();
        deps.broadcastLedgerUpdate();
        deps.broadcast({ type: "terminals_updated" });
      })().catch((e: unknown) => {
        console.error(`[restart_pane replay] deferred restart failed for ${id}:`, e);
        invalidateRestartClaim(deps.correctionLedger, claimId, id, "the restart actually failed — the pane is not up");
      });
      return `Terminal ${id} restarted.`;
    }
    // respawnFromLedger only touches ctx.manager / ctx.broadcastLedgerUpdate / ctx.broadcastTerminalsUpdated
    // — the minimal ActionContext slice this replay deps bag can satisfy.
    const replayCtx = {
      manager: deps.manager,
      broadcastLedgerUpdate: deps.broadcastLedgerUpdate,
      broadcastTerminalsUpdated: () => deps.broadcast({ type: "terminals_updated" }),
    } as unknown as ActionContext;
    return respawnFromLedger(replayCtx, id, owner!.pane, owner!.projectId, `Terminal ${id} restored and started.`);
  };
```

(e) In `src/gating/index.ts`, in the boot-hydration loop's `buildActionRun` deps bag (~line 330-337), add the pass-through after `sanitizeSettingsForClient,`:

```ts
          correctionLedger: deps.correctionLedger,
```

- [ ] **Step 4: Run — pass + regressions**

Run: `npx tsx --test --test-force-exit tests/test_vcd_producer_restart.ts`
Expected: 5 pass.
Run: `npx tsx --test --test-force-exit tests/test_actionEffects.ts tests/test_restore_respawn.ts tests/test_boot_quarantine.ts`
Expected: pass (no-ledger paths are byte-identical).
Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/actions/types.ts src/actions/respawnFromLedger.ts src/actions/defs/panes_rest.ts src/actionEffects.ts src/gating/index.ts tests/test_vcd_producer_restart.ts
git commit -m "feat(actions): restart-ack claim record + failure/cancel retraction on both restart paths (fikj.11 producer 2)"
```

---

### Task 8: Producer 3 — completion claims at the drain sink + the false-done contradiction guard (fikj.11)

Completion claims are recorded at the DRAIN SINK (`sendArbiterDigest`) — the only place spokenness is ground truth: a class-3 item drained under a `passive-context` dial (Task 1's knob!) never completes a turn, so it must record `spoken:false` (a later invalidate then correctly skips it). Invalidation consumes the EXISTING pane-signal bus: an `error`/`exited` signal arriving within `COMPLETION_CONTRADICTION_WINDOW_MS` of a spoken completion claim on the same pane retracts it (co-design §D: "idle/error/exited signals contradicting a recent Change-C completion claim — closing C's false-done residue"). The kind check (via Task 5's `latestSpokenClaim`) is what keeps this from firing on dispatch/restart claims — a pane exiting after a dispatch is NOT evidence the dispatch never happened, and that false correction is exactly what fikj.11 forbids.

**Files:**
- Modify: `src/voice/index.ts` (new exported helpers near `renderArbiterDigest` ~line 560-627; `sendArbiterDigest` ~line 601; `VoiceDeps` ~line 761; destructure ~line 864; drain tick ~line 2611; subscriber ~line 2631)
- Test: `tests/test_vcd_producer_completion.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_vcd_producer_completion.ts`:

```ts
// tests/test_vcd_producer_completion.ts — fikj.11 RED, producer 3: vc-C completion claims record at
// the drain sink (spokenness = ground truth) and retract on a contradicting error/exited signal
// within the recency window. Pure helpers + REAL ledger + REAL arbiter composed end to end; the
// production wiring is pinned by source-conformance (the test_turn_arbiter_journeys idiom).
// Runner: npx tsx --test --test-force-exit tests/test_vcd_producer_completion.ts
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";
import * as voiceIndexModule from "../src/voice/index";

type AnyRec = Record<string, any>;
const voiceIndex = voiceIndexModule as AnyRec;
const T0 = 1_700_000_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function digestWith(items: AnyRec[]): AnyRec {
  const [headline, ...tail] = items;
  return { headline, tail, tailCount: tail.length, tailGroups: [] };
}

test("recordSpokenCompletionClaims: cls-3 digest items record completion claims; other classes never do", () => {
  const fn = voiceIndex.recordSpokenCompletionClaims;
  assert.strictEqual(typeof fn, "function", "fikj.11 feature absent: recordSpokenCompletionClaims export");
  const records: AnyRec[] = [];
  const ledger = { record: (c: AnyRec) => records.push(c) };
  fn(digestWith([
    { facts: "pane p1 finished", cls: 3, paneId: "p1", forVisualStack: false },
    { facts: "pane p2 finished", cls: 3, paneId: "p2", forVisualStack: true },
    { facts: "approve now", cls: 2, paneId: "p3", forVisualStack: true },
  ]), true, ledger, T0);
  assert.strictEqual(records.length, 2, "headline AND tail cls-3 items record; the cls-2 tail item does not");
  assert.ok(records.every(r => r.kind === "completion" && r.spoken === true && r.assertedAt === T0));
  assert.deepStrictEqual(records.map(r => r.paneId), ["p1", "p2"]);
});

test("recordSpokenCompletionClaims: a passive-context (non-turn) drain records spoken:false", () => {
  const records: AnyRec[] = [];
  voiceIndex.recordSpokenCompletionClaims(
    digestWith([{ facts: "pane p1 finished", cls: 3, paneId: "p1", forVisualStack: false }]),
    false, { record: (c: AnyRec) => records.push(c) }, T0,
  );
  assert.strictEqual(records[0].spoken, false,
    "the D4 dial can make class 3 passive — then the claim never reached the operator's ears");
});

test("completionContradiction: error/exited within the window against a COMPLETION claim -> retraction plan", () => {
  const fn = voiceIndex.completionContradiction;
  assert.strictEqual(typeof fn, "function", "fikj.11 feature absent: completionContradiction export");
  const WINDOW = voiceIndex.COMPLETION_CONTRADICTION_WINDOW_MS;
  assert.strictEqual(typeof WINDOW, "number");
  const claim = { claimId: "c1", kind: "completion", assertedAt: T0 };
  const ledger = { latestSpokenClaim: (_p: string) => claim };
  const hit = fn({ paneId: "p1", kind: "error" }, ledger, T0 + 1_000);
  assert.ok(hit, "a fresh error contradicts the just-spoken completion");
  assert.strictEqual(hit.claimId, "c1");
  assert.ok(hit.groundTruth.includes("p1"), "ground truth names the pane");
  // negative fixtures — every one of these MUST be null (a false correction is worse than a gap):
  assert.strictEqual(fn({ paneId: "p1", kind: "error" }, ledger, T0 + WINDOW + 1), null, "outside the window");
  assert.strictEqual(fn({ paneId: "p1", kind: "idle" }, ledger, T0 + 1_000), null, "idle is not a contradiction");
  assert.strictEqual(fn({ paneId: "p1", kind: "error" }, undefined, T0 + 1_000), null, "no ledger wired");
  const dispatchLedger = { latestSpokenClaim: (_p: string) => ({ claimId: "d1", kind: "dispatch", assertedAt: T0 }) };
  assert.strictEqual(fn({ paneId: "p1", kind: "exited" }, dispatchLedger, T0 + 1_000), null,
    "a pane exiting after a DISPATCH claim is not evidence the dispatch never happened — kind-scoped");
  assert.strictEqual(fn({ paneId: "p1", kind: "error" }, { latestSpokenClaim: () => undefined }, T0 + 1_000), null,
    "no spoken claim on the pane");
});

test("end to end: spoken completion -> error signal -> ONE class-0 retraction through the REAL arbiter", () => {
  const arb: AnyRec = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  voiceIndex.recordSpokenCompletionClaims(
    digestWith([{ facts: "pane p1 finished", cls: 3, paneId: "p1", forVisualStack: false }]), true, led, T0,
  );
  const hit = voiceIndex.completionContradiction({ paneId: "p1", kind: "error" }, led, T0 + 2_000);
  assert.ok(hit);
  assert.strictEqual(led.invalidate(hit.claimId, hit.groundTruth, { severity: "exception" }).corrected, true);
  const d: AnyRec = arb.evaluate({ now: T0 + 3_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 0, "the retraction is a class-0 arbiter item (AC2)");
  assert.match(d.digest.headline.facts, /correct|retract/i);
  // storm control: the same contradiction cannot fire twice.
  const again = voiceIndex.completionContradiction({ paneId: "p1", kind: "exited" }, led, T0 + 4_000);
  if (again) assert.strictEqual(led.invalidate(again.claimId, again.groundTruth).corrected, false, "already corrected -> skip");
});

test("an UNSPOKEN (passive-drained) completion claim never yields a correction (AC3 negative fixture)", () => {
  const arb: AnyRec = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  voiceIndex.recordSpokenCompletionClaims(
    digestWith([{ facts: "pane p1 finished", cls: 3, paneId: "p1", forVisualStack: false }]), false, led, T0,
  );
  assert.strictEqual(voiceIndex.completionContradiction({ paneId: "p1", kind: "error" }, led, T0 + 1_000), null,
    "latestSpokenClaim never surfaces an unspoken claim — nothing to retract");
  assert.strictEqual(arb.evaluate({ now: T0 + 2_000, floorHeld: false, turnClear: true }).action, "hold");
});

test("production wiring conformance: the sink records, the subscriber checks contradictions", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "src/voice/index.ts"), "utf-8");
  const sinkCalls = (src.match(/recordSpokenCompletionClaims\(/g) ?? []).length;
  assert.ok(sinkCalls >= 2, `recordSpokenCompletionClaims needs a definition AND a call site (found ${sinkCalls})`);
  const guardCalls = (src.match(/completionContradiction\(/g) ?? []).length;
  assert.ok(guardCalls >= 2, `completionContradiction needs a definition AND a call site (found ${guardCalls})`);
  assert.ok(src.includes("correctionLedger?: "), "VoiceDeps must declare the optional correctionLedger seam");
});
```

- [ ] **Step 2: Run — verify failures**

Run: `npx tsx --test --test-force-exit tests/test_vcd_producer_completion.ts`
Expected: all 6 fail (missing exports / conformance strings).

- [ ] **Step 3: Implement the pure helpers**

In `src/voice/index.ts`, directly after `isJumpOverSend` (~line 591), add:

```ts
/** fikj.11 (vc-D producer 3): the voice layer's structural view of src/voice/correctionLedger.ts.
 *  Kept structural (not the factory's inferred type) so test fakes stay trivially satisfiable. */
export interface CorrectionLedgerSeam {
  record(claim: {
    claimId: string; paneId: string;
    kind: "dispatch" | "restart" | "completion" | "readiness";
    assertedText: string; assertedAt: number; spoken: boolean;
  }): void;
  invalidate(ref: string, groundTruth: string, opts?: { severity?: "exception" | "info" }): { corrected: boolean; reason?: string };
  latestSpokenClaim(paneId: string): { claimId: string; kind: string; assertedAt: number } | undefined;
}

/**
 * recordSpokenCompletionClaims -- fikj.11: vc-C completion claims are recorded AT THE DRAIN SINK,
 * the only place spokenness is ground truth: a class-3 item drained under a passive-context dial
 * (D4) never completes a turn, so it records spoken:false and a later invalidate correctly skips
 * it (never-spoken rule) instead of retracting words nobody heard. Tail items ARE audible — the
 * rendered digest carries their facts verbatim (renderArbiterDigest) — so they record too. Pure
 * over its inputs; the caller supplies `now` and whether the send genuinely landed as a turn.
 */
export function recordSpokenCompletionClaims(
  digest: Digest,
  spokenTurn: boolean,
  ledger: Pick<CorrectionLedgerSeam, "record"> | undefined,
  now: number,
): void {
  if (!ledger) return;
  [digest.headline, ...digest.tail].forEach((it, i) => {
    if (it.cls !== 3 || !it.paneId) return;
    ledger.record({
      claimId: `completion:${it.paneId}:${now}:${i}`,
      paneId: it.paneId,
      kind: "completion",
      assertedText: it.facts,
      assertedAt: now,
      spoken: spokenTurn,
    });
  });
}

/** fikj.11: the false-done residue guard's recency bound (co-design §D: "idle/error/exited signals
 *  contradicting a RECENT Change-C completion claim"). PRODUCER-side — this is NOT a ledger
 *  staleness clock: a pending correction still never decays anywhere. It only decides whether a
 *  fresh bus signal genuinely contradicts the last spoken claim. */
export const COMPLETION_CONTRADICTION_WINDOW_MS = 15_000;

/**
 * completionContradiction -- elects a retraction plan (claimId + ground truth) when an error/exited
 * pane signal contradicts a JUST-SPOKEN completion claim on the same pane. Every other case is
 * null: wrong signal kind, no ledger, no spoken claim, claim of a DIFFERENT kind (a pane exiting
 * after a dispatch claim is NOT evidence the dispatch never happened — that would be a FALSE
 * correction, the one thing worse than a missing one), or outside the recency window. Consumes the
 * EXISTING pane-signal bus — no new liveness check is implemented here.
 */
export function completionContradiction(
  sig: { paneId: string; kind: string },
  ledger: Pick<CorrectionLedgerSeam, "latestSpokenClaim"> | undefined,
  now: number,
): { claimId: string; groundTruth: string } | null {
  if (!ledger || (sig.kind !== "error" && sig.kind !== "exited")) return null;
  const claim = ledger.latestSpokenClaim(sig.paneId);
  if (!claim || claim.kind !== "completion") return null;
  if (now - claim.assertedAt > COMPLETION_CONTRADICTION_WINDOW_MS) return null;
  const what = sig.kind === "error" ? "reported an error" : "exited";
  return {
    claimId: claim.claimId,
    groundTruth: `pane ${sig.paneId} ${what} right after the completion was announced — it did not finish cleanly`,
  };
}
```

- [ ] **Step 4: Wire the sink, the deps, and the subscriber**

Still in `src/voice/index.ts`:

(a) `VoiceDeps` — after the `turnArbiter?: TurnArbiter;` member (line 761), add:

```ts
  /** fikj.11 (vc-D): the ONE server-constructed correction ledger (same instance gating + the REST
   *  ActionContext receive). The drain sink records spoken class-3 completion claims into it; the
   *  pane-signal subscriber retracts them on a contradicting error/exited signal. Optional — a
   *  hand-built harness that injects none simply produces no completion claims. */
  correctionLedger?: CorrectionLedgerSeam;
```

(b) Add `correctionLedger,` to the `attachVoiceSession` destructure (after `turnArbiter,`, line 864).

(c) Replace `sendArbiterDigest` (lines 601-627) with:

```ts
function sendArbiterDigest(
  session: any,
  store: JanusStore | null,
  sessionId: string | null,
  ack: AckTurnState,
  digest: Digest,
  mode: DeliveryMode,
  ledger?: CorrectionLedgerSeam,
): void {
  const rendered = renderArbiterDigest(digest, mode);
  let sent = true;
  try {
    session.sendClientContent({ turns: [{ role: "user", parts: [{ text: rendered.text }] }], turnComplete: rendered.turnComplete });
  } catch (e) {
    sent = false;
    console.error("[turn-arbiter] drain send failed:", e);
  }
  // fikj.11: record vc-C completion claims HERE, where spokenness is ground truth (a failed send
  // or a passive-context turn is NOT a spoken claim). Best-effort — never breaks the drain.
  try {
    recordSpokenCompletionClaims(digest, sent && rendered.turnComplete, ledger, Date.now());
  } catch (e) {
    console.error("[vc-d] completion claim record failed:", e);
  }
  if (!store) return;
  const headlineCls = digest.headline.cls as 0 | 1 | 2 | 3 | 4 | 5;
  if (isJumpOverSend({ turnComplete: rendered.turnComplete, cls: headlineCls, ack })) {
    store.recordJumpOver({
      ts: Date.now(), sessionId, producer: "turn-arbiter-drain",
      cls: digest.headline.cls, detail: digest.headline.coalesceKey ?? null,
    });
  }
  store.recordArbiterDrain({
    ts: Date.now(), sessionId, mode, headlineCls: digest.headline.cls,
    drainSize: 1 + digest.tailCount, tailCount: digest.tailCount,
  });
}
```

(d) The drain tick call site (line 2611) becomes:

```ts
          sendArbiterDigest(justConnected, store, state.voiceSessionId, ackState(), plan.digest, plan.mode, correctionLedger);
```

(e) In the `paneSignalBus.subscribe` callback (line 2631), insert at the very top of the callback body (before the `paneSignalClass(sig.kind) === 4` branch):

```ts
          // fikj.11 (vc-D): a fresh error/exited signal contradicting a JUST-SPOKEN completion
          // claim retracts it (closes vc-C's false-done residue — co-design §D). Kind- and
          // recency-scoped inside completionContradiction so a dispatch/restart claim, an old
          // completion, or an unspoken one can NEVER yield a false correction. Fail-soft: a
          // ledger fault never blocks the signal path.
          try {
            const contradiction = completionContradiction(sig, correctionLedger, Date.now());
            if (contradiction && correctionLedger) {
              correctionLedger.invalidate(contradiction.claimId, contradiction.groundTruth, { severity: "exception" });
            }
          } catch (e) {
            console.error("[vc-d] completion contradiction check failed:", e);
          }
```

- [ ] **Step 5: Run — pass + regressions**

Run: `npx tsx --test --test-force-exit tests/test_vcd_producer_completion.ts`
Expected: 6 pass.
Run: `npx tsx --test --test-force-exit tests/test_turn_arbiter_journeys.ts tests/test_return_channel_journeys.ts tests/test_voice_journeys.ts tests/test_turn_arbiter_completions.ts`
Expected: pass (no ledger injected in those harnesses → the new code paths are inert no-ops).
Run: `npm run lint`
Expected: exit 0. (Complexity gate: `sendArbiterDigest` gained one param + one try/catch — still well under CC 10; the helpers are branches-light by construction.)

- [ ] **Step 6: Commit**

```bash
git add src/voice/index.ts tests/test_vcd_producer_completion.ts
git commit -m "feat(voice): completion claims recorded at the drain sink + false-done contradiction retraction (fikj.11 producer 3)"
```

---

### Task 9: server.ts — construct the ledger, thread it everywhere (fikj.11)

One `createCorrectionLedger({ arbiter: turnArbiter })` at boot, threaded into `createGating` (producer 1 + replay), `attachVoiceSession` (producer 3), and `buildRestActionContext` (producer 2's REST surface). Corrections enter the conversation ONLY as class-0 submissions into the already-wired shared arbiter — **no new send site, the T1 ratchet is untouched.**

**Files:**
- Modify: `server.ts` (import ~line 71; construction after line 1838's arbiter block; `createGating` deps ~line 1850; voice deps ~line 2227; `buildRestActionContext` ~line 2325)
- Test: `tests/test_vcd_journeys.ts` (create — the wiring-conformance half; Task 10 adds the journey half)

- [ ] **Step 1: Write the failing conformance test**

Create `tests/test_vcd_journeys.ts`:

```ts
// tests/test_vcd_journeys.ts — fikj.11: (a) server.ts wiring conformance (the
// test_turn_arbiter_journeys item-3 idiom — the shared instance must reach every producer seam or
// record()/invalidate() silently never fire in production, the exact fikj.11 gap), and (b) the
// cross-producer journey (Task 10): all three producers against ONE real ledger + ONE real
// arbiter, ending in exactly one truthful class-0 retraction.
// Runner: npx tsx --test --test-force-exit tests/test_vcd_journeys.ts
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGating } from "../src/gating";
import { createTurnArbiter } from "../src/voice/turnArbiter";
import { createCorrectionLedger } from "../src/voice/correctionLedger";
import { respawnPane } from "../src/actions/defs/panes_rest";
import * as voiceIndexModule from "../src/voice/index";

type AnyRec = Record<string, any>;
const voiceIndex = voiceIndexModule as AnyRec;
const T0 = 1_700_000_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

test("server.ts constructs ONE correction ledger on the shared arbiter and threads it into every producer seam", () => {
  const src = fs.readFileSync(path.resolve(repoRoot, "server.ts"), "utf-8");
  assert.ok(src.includes("createCorrectionLedger({ arbiter: turnArbiter })"),
    "fikj.11 feature absent: server.ts must construct the ledger on the SHARED arbiter (class-0 submissions only — no new send site)");
  const passthroughs = (src.match(/^\s*correctionLedger,\s*$/gm) ?? []).length;
  assert.ok(passthroughs >= 3,
    `correctionLedger must be threaded into createGating, attachVoiceSession, AND buildRestActionContext (found ${passthroughs} pass-throughs)`);
});
```

- [ ] **Step 2: Run — verify failure**

Run: `npx tsx --test --test-force-exit tests/test_vcd_journeys.ts`
Expected: 1 fail (construction string absent).

- [ ] **Step 3: Implement the wiring**

In `server.ts`:

(a) Add the import next to the turnArbiter import (line 71 area):

```ts
import { createCorrectionLedger } from "./src/voice/correctionLedger";
```

(b) Immediately after the `const turnArbiter = createTurnArbiter({ matrix: ... });` line (Task 2's block, ~line 1838), add:

```ts
  // fikj.11 (vc-D wiring): the ONE correction ledger, bound to the ONE shared arbiter. Every
  // producer records into the SAME bookkeeping — renderApproved dispatch claims (gating), restart
  // acks (REST ActionContext + the gating replay builders), vc-C completion claims (the voice
  // drain sink) — so pane-ref resolution and (pane, kind) supersession see the whole truth plane.
  // Corrections leave this object ONLY as class-0 submissions into `turnArbiter`: no new
  // model-bound send site exists (the T1 send-site ratchet is untouched by design).
  const correctionLedger = createCorrectionLedger({ arbiter: turnArbiter });
```

(c) In the `createGating` deps bag (line 1839-1851), add `correctionLedger,` on its own line after `turnArbiter,`.

(d) In the `attachVoiceSession` deps bag (the block containing `turnArbiter,` at ~line 2227), add `correctionLedger,` on its own line after `turnArbiter,`.

(e) In `buildRestActionContext`'s returned object (~line 2325-2361), add `correctionLedger,` on its own line (e.g. after `applyPaneMode,`).

- [ ] **Step 4: Run — pass + lint + build**

Run: `npx tsx --test --test-force-exit tests/test_vcd_journeys.ts`
Expected: pass.
Run: `npm run lint`
Expected: exit 0 (also proves the `createCorrectionLedger` return type structurally satisfies all three seam declarations — `record`/`invalidate`/`latestSpokenClaim`).
Run: `npm run build`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add server.ts tests/test_vcd_journeys.ts
git commit -m "feat(server): construct the correction ledger on the shared arbiter and thread it to all producer seams (fikj.11)"
```

---

### Task 10: Cross-producer journey + full battery + bead close-out

The money test: all three producers feed ONE real ledger + ONE real arbiter; a contradiction retracts the right claim and ONLY that claim; two pending corrections coalesce into one drain. Then the full quality battery.

**Files:**
- Modify: `tests/test_vcd_journeys.ts` (append the journey half)

- [ ] **Step 1: Write the journey tests (they should pass immediately if Tasks 5–9 are correct — treat any failure as a real integration bug, use superpowers:systematic-debugging, do NOT weaken the assertions)**

Append to `tests/test_vcd_journeys.ts`:

```ts
// ── the cross-producer journey: three producers, one ledger, one arbiter, truthful retraction ──

const tick = () => new Promise<void>(r => setImmediate(() => setImmediate(() => r())));

function makeGatingHarness(arbiter: AnyRec, ledger: AnyRec) {
  const narrations: string[] = [];
  const session = { sendClientContent: () => {} };
  const manager: AnyRec = {
    globalPermissionsMode: "Inherit",
    terminals: { t1: { status: "Running", writeInput: () => {}, stop: async () => {} } },
    settings: { advanced: { capabilityGates: {} } },
    ledger: {
      activeProjectId: "default_project", getActiveProject: () => undefined,
      getDraft: () => undefined, setDraft: () => {}, plans: [], watchRules: [], save: () => {},
    },
  };
  const coreState: AnyRec = {
    activeFrontendWs: null, activeLiveSession: session, clients: new Set(),
    activePaneId: null, frozen: false, lastStopAllFailed: [], setFrozen: () => {},
  };
  const gating: AnyRec = createGating({
    manager, store: null, broadcast: () => {}, broadcastLedgerUpdate: () => {}, broadcastDraft: () => {},
    coreState, announcementBus: { enqueue: () => true, stop: () => {} },
    pushApprovalNarration: (_s: any, text: string) => { narrations.push(text); return true; },
    sanitizeSettingsForClient: (s: any) => s, addCommand: () => {},
    turnArbiter: arbiter, correctionLedger: ledger,
  } as any);
  return { gating, narrations, session, manager };
}

test("journey: dispatch + completion + failed restart against ONE ledger -> exactly the TRUE retractions, coalesced", async () => {
  const arb: AnyRec = createTurnArbiter();
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });

  // Producer 1 (real gating): approve -> spoken dispatch claim on t1.
  const h = makeGatingHarness(arb, led);
  h.gating.pendingApprovals.add(
    { messageId: "d1", instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: "d1", timestamp: T0 } as any,
    h.session,
  );
  h.gating.applyResolution("d1", "approve");
  assert.ok(h.narrations.some((n: string) => n.includes("Dispatching now")));

  // Producer 3 (drain-sink helper, as wired): a spoken completion claim on pane p9.
  voiceIndex.recordSpokenCompletionClaims(
    { headline: { facts: "pane p9 finished", cls: 3, paneId: "p9", forVisualStack: false }, tail: [], tailCount: 0, tailGroups: [] },
    true, led, T0,
  );

  // Producer 2 (real action handler): a restart of t1 whose stop() fails -> retraction.
  const term: AnyRec = { projectId: "p1", stop: async () => { throw new Error("boom"); }, start: () => {} };
  const ctx: AnyRec = {
    manager: {
      terminals: { t1: term }, archivingPanes: new Set(),
      ledger: { getProject: () => ({ id: "p1", panes: { t1: { id: "t1" } } }), getActiveProject: () => undefined },
      settings: { advanced: {} },
    },
    correctionLedger: led,
    gateOrDefer: () => ({ disposition: "run" }),
    broadcastLedgerUpdate: () => {}, broadcastTerminalsUpdated: () => {}, broadcast: () => {},
  };
  respawnPane.handler({ pane_id: "t1" } as AnyRec, ctx as AnyRec);
  await tick();

  // A contradicting error signal against p9's completion claim (within the window).
  const hit = voiceIndex.completionContradiction({ paneId: "p9", kind: "error" }, led, T0 + 2_000);
  assert.ok(hit, "the completion contradiction elects");
  led.invalidate(hit.claimId, hit.groundTruth, { severity: "exception" });

  // The SAME signal shape against t1 must NOT elect (its latest spoken claim is the RESTART claim,
  // already corrected — and before that a dispatch claim; neither is a completion): no false correction.
  assert.strictEqual(voiceIndex.completionContradiction({ paneId: "t1", kind: "error" }, led, T0 + 2_000), null,
    "kind-scoping shields dispatch/restart claims from the completion guard");

  // Drain: BOTH pending corrections (restart failure + false-done) ride ONE class-0 digest.
  const d: AnyRec = arb.evaluate({ now: T0 + 5_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.strictEqual(d.digest.headline.cls, 0);
  const all = [d.digest.headline, ...d.digest.tail];
  assert.strictEqual(all.filter((i: AnyRec) => i.cls === 0).length, 2, "coalescing: one spoken turn, two retractions");
  assert.ok(all.some((i: AnyRec) => i.facts.includes("t1")) && all.some((i: AnyRec) => i.facts.includes("p9")));
  // …and nothing about the DISPATCH claim (its ground truth never flipped).
  assert.ok(!all.some((i: AnyRec) => /dispatch/i.test(i.facts)), "no false correction for the un-flipped dispatch claim");
  // One turn per turn-clear; nothing re-fires.
  assert.strictEqual(arb.evaluate({ now: T0 + 5_001, floorHeld: false, turnClear: true }).action, "hold");
});

test("journey: corrections fire regardless of completionAnnounce AND under a hostile dial (floor)", () => {
  // completionAnnounce=off silences COMPLETIONS (no claim is even recorded, so no correction can
  // false-fire) — but an already-recorded spoken claim still retracts under any dial (D4 floor).
  const arb: AnyRec = createTurnArbiter({ matrix: { 0: "passive-context" } }); // hostile — clamps
  const led: AnyRec = createCorrectionLedger({ arbiter: arb });
  led.record({ claimId: "c1", paneId: "p1", kind: "completion", assertedText: "pane p1 finished", assertedAt: T0, spoken: true });
  assert.strictEqual(led.invalidate("c1", "it did not finish").corrected, true);
  const d: AnyRec = arb.evaluate({ now: T0 + 1_000, floorHeld: false, turnClear: true });
  assert.strictEqual(d.action, "drain");
  assert.notStrictEqual(d.mode, "passive-context", "the never-silent floor holds end to end");
});
```

- [ ] **Step 2: Run the journey file**

Run: `npx tsx --test --test-force-exit tests/test_vcd_journeys.ts`
Expected: all pass. A failure here is an integration bug in Tasks 5–9 — debug it, never loosen the journey.

- [ ] **Step 3: Full unit battery + dependency check**

Run: `node scripts/check-deps.mjs`
Expected: in sync.
Run: `npm test`
Expected: the whole suite green. Watch specifically: `test_approval*`, `test_turn_arbiter_*`, `test_voice_journeys`, `test_actionEffects`, `test_settings_put_validation`, `test_voice_ux_settings`, the `test_us_epic*` vignettes (they drive approvals through mockLive — the Exited-guard in Task 6 is the likeliest tripwire; their panes are status "Running" so they should pass, but verify).

- [ ] **Step 4: Lint + complexity + build**

Run: `npm run lint`
Expected: exit 0.
Run: `npm run complexity`
Expected: exit 0 — zero suppressions (the burndown is COMPLETE; any new violation must be FIXED by extracting a helper, never suppressed).
Run: `npm run build`
Expected: clean `dist/server.cjs`.

- [ ] **Step 5: E2E**

Run: `npm run test:e2e`
Expected: green, including the new `e2e/delivery_dial.spec.ts`. (If the full suite is too slow for iteration, run the new spec + `voice_silence_gate` + `capability_matrix` first, then the full suite once.)

- [ ] **Step 6: Commit + bead close-out**

```bash
git add tests/test_vcd_journeys.ts
git commit -m "test(voice): cross-producer vc-D journey — three producers, one ledger, truthful coalesced retraction (fikj.11)"
```

Then (per the repo's team-maintainer worktree policy — this branch is an isolated worktree, the gate above is the battery):

```bash
bd close fikj.12 --notes "D4 dial shipped: voiceAi.deliveryMatrix + completionAnnounce; boundary clamp+dialViolations; live updateMatrix on PUT; SettingsDialog rows with structural floor; e2e + unit pinned."
bd close fikj.11 --notes "Producers wired: renderApproved dispatch claims (+ honest dead-pane first claim), restart-ack record/retract on both paths, completion claims at the drain sink + false-done contradiction guard; server constructs one ledger on the shared arbiter; negative fixtures + cross-producer journey green."
bd update fikj.4 --notes "Remaining scope (fikj.11) shipped on feat/vc-d-wiring-d4-dial; module+arbiter integration was PR #153. Director may close after PR merge. Note: the landed module has no drainPending (the arbiter queue IS the drain, per turn-arbiter spec §3.3) — bead text predates PR #153."
git push -u origin feat/vc-d-wiring-d4-dial
```

Open a PR stacked on `feat/turn-arbiter-program` (PR #153's branch) — the PR is the human review gate. Direct push to main is prohibited.

---

## Self-Review Notes (already applied)

- **Spec coverage:** fikj.12 AC1 (dial classes 0/2/3/4/5 within floors) → Tasks 1, 2, 4; AC2 (under-floor clamp + violation) → Tasks 1, 2, 4 (structural floor) + boot warn; AC3 (battery) → Task 10. fikj.11 AC1 (every claim-site records) → Tasks 6, 7, 8; AC2 (invalidation → class-0 submission) → Tasks 7, 8 + journey; AC3 (no false corrections — negative fixtures) → never-spoken (Task 6 push-fail/no-session, Task 8 passive-drain), superseded/storm-control (pinned in PR #153's suite + Task 8 e2e-journey re-pin), kind-scoping + recency (Task 8), clean-success negatives (Tasks 6, 7); AC4 (battery) → Task 10. fikj.4's "post-dispatch 'Dispatching now' ordering flip" → Task 6 (see the conflict note in the header: the happy path already narrated post-write; the real gap was the Exited-pane false claim).
- **Dispatch-claim invalidation:** deliberately seam-only in production (recorded with the `dispatch:<messageId>` handle; a2tp/qj6s are the named future invalidators). Wiring a homegrown post-dispatch liveness probe would violate the bead's own "does NOT re-implement liveness/policy checks".
- **Type consistency:** the ledger seam is declared structurally in three places (GatingDeps, ActionContext + RestartClaimLedger, CorrectionLedgerSeam) — all are supersets/subsets of the same three methods (`record`, `invalidate`, `latestSpokenClaim`) that `createCorrectionLedger` returns after Task 5; Task 9's lint step proves assignability. `NormalizeMatrixResult` is the existing exported type reused by `updateMatrix`.
- **No placeholders:** every step carries the full code, exact paths, exact commands, and expected output.
