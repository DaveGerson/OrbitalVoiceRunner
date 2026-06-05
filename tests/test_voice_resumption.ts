// tests/test_voice_resumption.ts — resilience for the Gemini Live session-resumption handle (PLM4).
//
// ROOT CAUSE THIS LOCKS (proven by the 2026-06-04 live capture): a session-resumption handle
// persisted by a STABLE session goes stale (the server-side session expires after the operator
// leaves). On the next connect the server re-feeds the expired handle and Gemini closes the socket
// with code=1008 "BidiGenerateContent session expired" — on the initial connect AND every bounded
// reconnect, because the handle was re-fed each time. The pre-existing self-heal only nulled the
// handle in the connect-THROW catch; a 1008 is an async CLOSE (no throw), so the poison was never
// cleared and the durable KV re-seeded it on every restart. These pure helpers encode the two-layer
// fix: (1) clear the handle when a handle-fed session CLOSES with 1008, (2) never feed a persisted
// handle older than a TTL. Wiring lives in server.ts; the logic is here so it is unit-tested without
// a live socket.
//
// Runner: npx tsx --test --test-force-exit tests/test_voice_resumption.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  GEMINI_SESSION_EXPIRED_CODE,
  DEFAULT_RESUME_HANDLE_TTL_MS,
  resolveResumeHandleTtlMs,
  isResumptionHandleFresh,
  shouldClearHandleOnClose,
  wrapHandleForPersist,
  readFreshHandle,
  GEMINI_INVALID_KEY_CODE,
  isInvalidKeyClose,
  isBlankApiKey,
} from "../src/voiceResumption";

test("GEMINI_SESSION_EXPIRED_CODE is the WebSocket 1008 'session expired' code", () => {
  assert.strictEqual(GEMINI_SESSION_EXPIRED_CODE, 1008);
});

// ── shouldClearHandleOnClose: the PRIMARY fix ────────────────────────────────────────────────
test("shouldClearHandleOnClose: a handle-fed session closing with 1008 is poisoned → clear", () => {
  assert.strictEqual(shouldClearHandleOnClose(1008, true), true);
});
test("shouldClearHandleOnClose: 1008 but NO handle was fed → nothing to clear (points elsewhere)", () => {
  assert.strictEqual(shouldClearHandleOnClose(1008, false), false);
});
test("shouldClearHandleOnClose: a non-1008 drop keeps the handle so a real reconnect can resume", () => {
  for (const code of [1000, 1006, 1011, 1001]) {
    assert.strictEqual(shouldClearHandleOnClose(code, true), false, `code ${code} must NOT clear`);
  }
});
test("shouldClearHandleOnClose: a missing/undefined code (e.g. onerror path) never clears", () => {
  assert.strictEqual(shouldClearHandleOnClose(undefined, true), false);
  assert.strictEqual(shouldClearHandleOnClose(null, true), false);
});

// ── isResumptionHandleFresh: the DEFENSE-in-depth age guard ───────────────────────────────────
test("isResumptionHandleFresh: within the TTL window is fresh; exactly at the edge is still fresh", () => {
  assert.strictEqual(isResumptionHandleFresh(1000, 1000 + 5000, 10000), true);
  assert.strictEqual(isResumptionHandleFresh(1000, 1000 + 10000, 10000), true, "age == ttl is fresh");
});
test("isResumptionHandleFresh: older than the TTL is stale", () => {
  assert.strictEqual(isResumptionHandleFresh(1000, 1000 + 10001, 10000), false);
});
test("isResumptionHandleFresh: unknown persistedAt (null/undefined) fails CLOSED (treated stale)", () => {
  assert.strictEqual(isResumptionHandleFresh(null, 5000, 10000), false);
  assert.strictEqual(isResumptionHandleFresh(undefined, 5000, 10000), false);
});
test("isResumptionHandleFresh: a future persistedAt (clock skew) is not trusted", () => {
  assert.strictEqual(isResumptionHandleFresh(10000, 5000, 10000), false);
});

// ── resolveResumeHandleTtlMs: env override, fail-safe to default ──────────────────────────────
test("resolveResumeHandleTtlMs: no override → default; valid override parsed; junk → default", () => {
  assert.strictEqual(resolveResumeHandleTtlMs({}), DEFAULT_RESUME_HANDLE_TTL_MS);
  assert.strictEqual(resolveResumeHandleTtlMs({ JANUS_RESUME_HANDLE_TTL_MS: "1234" }), 1234);
  assert.strictEqual(resolveResumeHandleTtlMs({ JANUS_RESUME_HANDLE_TTL_MS: "0" }), DEFAULT_RESUME_HANDLE_TTL_MS);
  assert.strictEqual(resolveResumeHandleTtlMs({ JANUS_RESUME_HANDLE_TTL_MS: "-5" }), DEFAULT_RESUME_HANDLE_TTL_MS);
  assert.strictEqual(resolveResumeHandleTtlMs({ JANUS_RESUME_HANDLE_TTL_MS: "abc" }), DEFAULT_RESUME_HANDLE_TTL_MS);
});

// ── wrapHandleForPersist + readFreshHandle: the durable-KV round trip with age stamping ───────
test("wrapHandleForPersist stamps persistedAt and round-trips through readFreshHandle while fresh", () => {
  const token = { newHandle: "h-abc", resumable: true };
  const raw = wrapHandleForPersist(token, 1000);
  const got = readFreshHandle(raw, 1000 + 500, 10000);
  assert.deepStrictEqual(got, { token, persistedAt: 1000 });
});
test("readFreshHandle returns null once the persisted handle ages past the TTL (boot self-heal)", () => {
  const raw = wrapHandleForPersist({ newHandle: "h-abc" }, 1000);
  assert.strictEqual(readFreshHandle(raw, 1000 + 10001, 10000), null);
});
test("readFreshHandle fails CLOSED on a legacy bare token (no persistedAt) — discard unknown age", () => {
  const legacy = JSON.stringify({ newHandle: "h-old" }); // pre-fix shape, unknown age
  assert.strictEqual(readFreshHandle(legacy, 5000, 10000), null);
});
test("readFreshHandle tolerates null / empty / garbage without throwing", () => {
  assert.strictEqual(readFreshHandle(null, 5000, 10000), null);
  assert.strictEqual(readFreshHandle(undefined, 5000, 10000), null);
  assert.strictEqual(readFreshHandle("", 5000, 10000), null);
  assert.strictEqual(readFreshHandle("not json{", 5000, 10000), null);
});

// ── Issue A — boot-time 1007 "API key not valid" must NOT drain the bounded reconnect budget ──
// A missing/invalid Gemini key at boot makes Gemini close the socket with code=1007. Retrying with
// the SAME unresolved key can only 1007 again, so a 1007 must be treated as a config error (do not
// spend a reconnect attempt), and a blank key must short-circuit BEFORE we ever attempt a keyless
// connect. These pure predicates encode that policy so server.ts wiring stays unit-testable.
test("GEMINI_INVALID_KEY_CODE is the WebSocket 1007 'API key not valid' code", () => {
  assert.strictEqual(GEMINI_INVALID_KEY_CODE, 1007);
});
test("isInvalidKeyClose: 1007 is a key/config error — the caller must NOT burn a reconnect attempt", () => {
  assert.strictEqual(isInvalidKeyClose(1007), true);
});
test("isInvalidKeyClose: transient (1006/1011), normal (1000/1001) and expired-handle (1008) are NOT key errors", () => {
  for (const code of [1000, 1001, 1006, 1008, 1011]) {
    assert.strictEqual(isInvalidKeyClose(code), false, `code ${code} must not be treated as an invalid-key close`);
  }
});
test("isInvalidKeyClose: a missing/undefined close code never counts as a key error", () => {
  assert.strictEqual(isInvalidKeyClose(undefined), false);
  assert.strictEqual(isInvalidKeyClose(null), false);
});
test("isBlankApiKey: empty / whitespace / nullish are blank — never attempt a keyless connect", () => {
  for (const k of ["", "   ", "\t", "\n  ", null, undefined]) {
    assert.strictEqual(isBlankApiKey(k as any), true, `${JSON.stringify(k)} must be blank`);
  }
});
test("isBlankApiKey: a real key is not blank", () => {
  assert.strictEqual(isBlankApiKey("AIzaSyA-validlookingkey-0123456789"), false);
});
