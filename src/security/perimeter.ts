/**
 * src/security/perimeter.ts — pure perimeter-auth helpers (bead wsm-e2e-pinned-xge).
 *
 * This server can spawn and write to host processes, so loading the UI must not itself grant
 * authority to arbitrary network peers. These helpers back three independent fences:
 *   - isLoopbackAddress: is a raw peer/bind address local-only? (127.0.0.0/8, ::1, ::ffff:127.x.y.z,
 *     the "localhost" hostname). Used both for the fail-closed non-loopback bind guard AND to decide
 *     whether the cookie-auto-seed middleware may hand a page-load peer the shared secret.
 *   - parseAllowedOrigins: split the comma-separated JANUS_ALLOWED_ORIGINS env value into a trimmed,
 *     non-empty origin list.
 *   - isOriginAllowed: the WS-upgrade Origin fence. Absent Origin (every non-browser client — scripts,
 *     the existing test suite) is unchanged/allowed; a present Origin must match the request Host or
 *     appear verbatim in the allowlist.
 *   - timingSafeEqualString: constant-time secret comparison (crypto.timingSafeEqual), used by
 *     shouldSeedAuthCookie's remote-operator `?auth_token=` proof so an attacker cannot use response
 *     timing to recover the shared token one byte at a time.
 *
 * Deliberately pure (no Node http/net object coupling beyond string args) so both server.ts and
 * src/voice/index.ts can import directly and unit tests can exercise every branch without booting a
 * server or opening a socket.
 */

import crypto from "crypto";

/** True for 127.0.0.0/8, ::1, an IPv4-mapped IPv6 loopback (::ffff:127.x.y.z), or the "localhost"
 *  hostname. False for everything else, including undefined/null/empty and "0.0.0.0" (binds ALL
 *  interfaces — the opposite of loopback-only, even though it's often confused with it). */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const trimmed = addr.trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase() === "localhost") return true;
  if (trimmed === "::1") return true;

  const mapped = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const candidate = mapped ? mapped[1] : trimmed;
  const octets = candidate.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  return octets[0] === "127";
}

/** Split JANUS_ALLOWED_ORIGINS ("https://a.example,http://b.example:1234") into a trimmed,
 *  non-empty list. Missing/blank env -> []. */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * isOriginAllowed(origin, host, allowlist) — the WS-upgrade Origin fence.
 *  - No Origin header (undefined/null/empty) -> true (non-browser clients; unchanged behavior — the
 *    existing cookie/token auth is the only fence for them, exactly as before this bead).
 *  - Origin present -> allowed iff its host[:port] matches the request's Host header, OR the raw
 *    Origin string appears verbatim in `allowlist` (JANUS_ALLOWED_ORIGINS). Anything else, including
 *    a malformed Origin value, is rejected (fail closed).
 */
export function isOriginAllowed(
  origin: string | undefined | null,
  host: string | undefined | null,
  allowlist: readonly string[] = [],
): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (host && originHost.toLowerCase() === host.toLowerCase()) return true;
  return allowlist.includes(origin);
}

/** Constant-time equality check for comparing a candidate value against a known secret string.
 *  `candidate` is `unknown` because it typically comes straight off a query-string/header value
 *  (e.g. `req.query.auth_token`, which express types as `unknown`/`ParsedQs`-adjacent) — anything
 *  that is not a `string` (undefined, an array from a repeated query param, a number, ...) is
 *  rejected immediately, no timing signal needed since there is nothing byte-wise to compare.
 *  A length mismatch is also rejected before entering `crypto.timingSafeEqual`, which throws
 *  (rather than returning false) on differently-sized buffers. */
export function timingSafeEqualString(candidate: unknown, secret: string): boolean {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
