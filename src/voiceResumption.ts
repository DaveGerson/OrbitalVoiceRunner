// src/voiceResumption.ts — resilience for the Gemini Live session-resumption handle (PLM4).
//
// A persisted resume handle can go stale: a stable session persists a handle, the operator leaves,
// the server-side session expires, and hours later the next connect re-feeds the dead handle. Gemini
// then closes the socket with code=1008 "BidiGenerateContent session expired" — on the initial connect
// AND every bounded reconnect, because the same expired handle is re-fed each time. The handle lives
// in the durable KV, so a restart re-seeds the poison and the cascade survives reboots.
//
// Two-layer fix, both pure + unit-tested here (wiring in server.ts):
//   1. PRIMARY  — shouldClearHandleOnClose(): when a handle-fed session CLOSES with 1008, the handle
//      is poisoned; clear it (in-mem + KV) before reconnecting so the next attempt starts FRESH. This
//      bounds any handle-induced wedge to exactly one failed attempt (the pre-existing self-heal only
//      covered the connect-THROW path, never the async onclose(1008) path — that was the bug).
//   2. DEFENSE  — isResumptionHandleFresh() / readFreshHandle(): never feed a persisted handle older
//      than a TTL. Legitimate reconnects re-feed a handle seconds old; only a handle from a long-gone
//      session trips this, so we connect fresh at boot instead of wasting the one 1008 attempt.

/** Gemini rejects an expired resume handle with this WebSocket close code (+ reason "session expired"). */
export const GEMINI_SESSION_EXPIRED_CODE = 1008;

/** Gemini rejects an empty/invalid API key by closing the socket with this code (+ reason "API key not valid"). */
export const GEMINI_INVALID_KEY_CODE = 1007;

/**
 * Whether a close means the API KEY is the problem rather than a transient drop. Gemini closes a
 * handshake made with an empty/invalid key using code 1007 "API key not valid". This is decisively
 * NOT retryable with the SAME key: reconnecting re-sends the same unresolved key and 1007s again,
 * so the caller must NOT spend one of its bounded reconnect attempts on a 1007 (that silently drains
 * the budget — Issue A). The key has to change first (the operator sets it in Settings), which opens
 * a fresh connect on its own. Distinct from 1008 (clear the stale handle) and 1006/1011 (transient,
 * a normal reconnect may help). A missing/undefined code is never a key error.
 */
export function isInvalidKeyClose(closeCode: number | null | undefined): boolean {
  return closeCode === GEMINI_INVALID_KEY_CODE;
}

/**
 * Whether a resolved API key is unusable for a connect attempt. Blank (empty / whitespace-only) or
 * nullish means we must NOT attempt a keyless `ai.live.connect()` — that connect can only fail with
 * 1007 and, worse, burn a reconnect attempt. Pre-validating here lets the caller defer the voice
 * channel cleanly (and re-attempt once the key is configured) instead of discovering the empty key
 * via a wasted failed handshake.
 */
export function isBlankApiKey(key: string | null | undefined): boolean {
  return !key || key.trim().length === 0;
}

/**
 * bead 9fz: whether a settings-PUT geminiApiKey value warrants nudging the live voice session to
 * (re)connect. TRUE only for a real, usable key — so the operator who just pasted a key in Settings
 * gets voice back WITHOUT a reload. We must NOT nudge on:
 *   - a blank/whitespace key (isBlankApiKey) — there is nothing to connect with;
 *   - the masked round-trip value the client echoes back (contains the "••••" bullet mask) — the PUT
 *     handler already substitutes the stored key for it, so it is NOT a new credential;
 *   - the "CONFIGURED_IN_ENV" sentinel — the env key is unchanged, no new connect intent.
 * SECRET INVARIANT: this is a pure boolean decision; the key is never logged or persisted here.
 */
export function shouldNudgeReconnectOnSettingsKey(key: string | null | undefined): boolean {
  if (isBlankApiKey(key)) return false;
  const k = key as string;
  if (k.includes("••••")) return false;        // the masked echo from GET /api/settings — not a new key
  if (k === "CONFIGURED_IN_ENV") return false; // env-provided sentinel — nothing changed
  return true;
}

/**
 * Default max age of a persisted resume handle before it is treated as expired and refused. Generous
 * on purpose — the onclose self-heal is the real recovery; this only spares the one wasted 1008
 * attempt at boot. A handle from the same conversation is always seconds old; one from a prior
 * session (hours/days) is what this rejects. Override via JANUS_RESUME_HANDLE_TTL_MS.
 */
export const DEFAULT_RESUME_HANDLE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Resolve the TTL from env, failing safe to the default on absent / non-positive / non-numeric input. */
export function resolveResumeHandleTtlMs(env: Record<string, string | undefined>): number {
  const raw = env.JANUS_RESUME_HANDLE_TTL_MS;
  if (!raw) return DEFAULT_RESUME_HANDLE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESUME_HANDLE_TTL_MS;
}

/**
 * A persisted handle is fresh enough to feed iff we know when it was stored AND that is within
 * [now - ttlMs, now]. Unknown age (null/undefined) fails CLOSED — we would rather connect fresh than
 * feed a handle of unknown age. A future persistedAt (clock skew) is not trusted either.
 */
export function isResumptionHandleFresh(
  persistedAt: number | null | undefined,
  now: number,
  ttlMs: number,
): boolean {
  if (persistedAt == null) return false;
  const age = now - persistedAt;
  return age >= 0 && age <= ttlMs;
}

/**
 * Whether a session close means the fed resume handle is poisoned and must be purged. The decisive
 * signal is Gemini's explicit 1008 "session expired" on an attempt that FED a handle: re-feeding it
 * can only fail again, so null + delete it and connect fresh next time. A non-1008 drop (transient
 * network 1006/1011, normal 1000) leaves the handle intact so a legitimate reconnect can still resume
 * the conversation. A missing code (the onerror path) never clears.
 */
export function shouldClearHandleOnClose(
  closeCode: number | null | undefined,
  usedHandle: boolean,
): boolean {
  return usedHandle && closeCode === GEMINI_SESSION_EXPIRED_CODE;
}

/** Serialize a resume token for the durable KV, stamping the persist time for the age guard.
 *  `ownerProjectId` (Phase 2 Step 2.5 review fix, optional so every existing caller/row shape is
 *  unchanged): the project whose CONVERSATION this handle belongs to at persist time. The legacy
 *  single slot is rewritten on every rotation, so without this stamp a later connection's
 *  one-way migration (src/voice/sessionPool.ts migrateLegacyHandle) could copy project A's
 *  conversation handle into project B's per-project slot — a cross-project handle mis-file. */
export function wrapHandleForPersist(token: unknown, now: number, ownerProjectId?: string | null): string {
  return JSON.stringify({ token, persistedAt: now, ...(ownerProjectId ? { ownerProjectId } : {}) });
}

/** Read the owner stamp back from a persisted handle, or null for a legacy/unstamped/garbage
 *  value (an unstamped handle has UNKNOWN ownership — the caller decides how conservative to be). */
export function readHandleOwner(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.ownerProjectId === "string" ? parsed.ownerProjectId : null;
  } catch {
    return null;
  }
}

/**
 * z5c design (spec 2026-07-07-z5c-session-pool-design.md D5): the legacy KV key a single global
 * resumption handle lived under before the per-project session pool. Kept as a named constant
 * (not just a literal) so the one-way migration into a per-project slot (src/voice/sessionPool.ts)
 * and the original single-session read/write site (src/voice/index.ts) both name the SAME key —
 * a typo'd duplicate literal would silently split the value into two dead KV rows.
 */
export const LEGACY_RESUME_HANDLE_KV_KEY = "voiceResumptionToken";

/**
 * z5c design D5: per-project resumption handles. Each pool entry gets its OWN durable KV slot
 * (was one global slot for the whole app) so switching A->B->A can resume EACH project's own
 * server-side Gemini conversation instead of all projects racing to overwrite one shared handle.
 * Pure string-building only — the actual get/set/delete + migration lives in
 * src/voice/sessionPool.ts (this module stays scoped to "resilience for the resumption handle",
 * not KV I/O).
 */
export function resumptionHandleKvKeyFor(projectId: string): string {
  return `${LEGACY_RESUME_HANDLE_KV_KEY}:project:${projectId}`;
}

/**
 * Read a persisted handle back, returning the token + its persist time ONLY if it parses as the
 * age-stamped wrapper and is still within the TTL. Anything else — null/empty, malformed JSON, or a
 * legacy bare token with no persist stamp (unknown age) — fails CLOSED to null so the caller connects
 * fresh (and should delete the stale/garbage KV row).
 */
export function readFreshHandle(
  raw: string | null | undefined,
  now: number,
  ttlMs: number,
): { token: any; persistedAt: number } | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.persistedAt !== "number" || !("token" in parsed)) return null; // legacy / unknown age
  if (!isResumptionHandleFresh(parsed.persistedAt, now, ttlMs)) return null;
  return { token: parsed.token, persistedAt: parsed.persistedAt };
}
