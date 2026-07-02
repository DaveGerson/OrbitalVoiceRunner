// tests/test_perimeter_helpers.ts — pure-function table tests for src/security/perimeter.ts
// (bead wsm-e2e-pinned-xge, design direction #8).
//
// isLoopbackAddress / parseAllowedOrigins / isOriginAllowed are deliberately pure (no http/net
// object coupling), so every branch is exercised here directly — no server boot, no socket.
//
// Runner: npx tsx --test --test-force-exit tests/test_perimeter_helpers.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackAddress, isOriginAllowed, parseAllowedOrigins, timingSafeEqualString } from "../src/security/perimeter";

describe("isLoopbackAddress", () => {
  it("accepts 127.0.0.0/8", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("127.0.0.0"), true);
    assert.equal(isLoopbackAddress("127.255.255.255"), true);
    assert.equal(isLoopbackAddress("127.1.2.3"), true);
  });

  it("accepts ::1", () => {
    assert.equal(isLoopbackAddress("::1"), true);
  });

  it("accepts an IPv4-mapped IPv6 loopback (::ffff:127.x.y.z)", () => {
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::FFFF:127.0.0.5"), true); // case-insensitive prefix
  });

  it("accepts the localhost hostname", () => {
    assert.equal(isLoopbackAddress("localhost"), true);
    assert.equal(isLoopbackAddress("LOCALHOST"), true);
  });

  it("rejects undefined/null/empty", () => {
    assert.equal(isLoopbackAddress(undefined), false);
    assert.equal(isLoopbackAddress(null), false);
    assert.equal(isLoopbackAddress(""), false);
    assert.equal(isLoopbackAddress("   "), false);
  });

  it("rejects 0.0.0.0 (binds ALL interfaces — not loopback-only)", () => {
    assert.equal(isLoopbackAddress("0.0.0.0"), false);
  });

  it("rejects a LAN/public IPv4 address", () => {
    assert.equal(isLoopbackAddress("192.168.1.10"), false);
    assert.equal(isLoopbackAddress("10.0.0.5"), false);
    assert.equal(isLoopbackAddress("8.8.8.8"), false);
    assert.equal(isLoopbackAddress("128.0.0.1"), false); // starts with 12 but not 127.x
  });

  it("rejects a non-loopback IPv6 address", () => {
    assert.equal(isLoopbackAddress("::2"), false);
    assert.equal(isLoopbackAddress("2001:db8::1"), false);
  });

  it("rejects a malformed/garbage address", () => {
    assert.equal(isLoopbackAddress("not-an-address"), false);
    assert.equal(isLoopbackAddress("127.0.0"), false);
    assert.equal(isLoopbackAddress("127.0.0.1.1"), false);
  });
});

describe("parseAllowedOrigins", () => {
  it("splits a comma-separated list and trims whitespace", () => {
    assert.deepEqual(
      parseAllowedOrigins("https://a.example, http://b.example:1234 ,https://c.example"),
      ["https://a.example", "http://b.example:1234", "https://c.example"],
    );
  });

  it("filters out empty segments", () => {
    assert.deepEqual(parseAllowedOrigins("https://a.example,,  ,https://b.example"), [
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("returns [] for undefined/null/empty", () => {
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.deepEqual(parseAllowedOrigins(null), []);
    assert.deepEqual(parseAllowedOrigins(""), []);
  });
});

describe("isOriginAllowed", () => {
  it("allows an ABSENT Origin regardless of host/allowlist (non-browser clients — existing test suite)", () => {
    assert.equal(isOriginAllowed(undefined, "127.0.0.1:3000", []), true);
    assert.equal(isOriginAllowed(null, undefined, []), true);
    assert.equal(isOriginAllowed("", "127.0.0.1:3000", []), true);
  });

  it("allows a same-host Origin (host[:port] matches the request Host header)", () => {
    assert.equal(isOriginAllowed("http://127.0.0.1:3000", "127.0.0.1:3000", []), true);
    assert.equal(isOriginAllowed("https://example.com", "example.com", []), true);
  });

  it("is case-insensitive on the host comparison", () => {
    assert.equal(isOriginAllowed("http://Example.com", "example.com", []), true);
  });

  it("rejects a cross-host Origin not in the allowlist", () => {
    assert.equal(isOriginAllowed("http://evil.example", "127.0.0.1:3000", []), false);
  });

  it("allows a cross-host Origin present verbatim in the allowlist", () => {
    assert.equal(
      isOriginAllowed("https://trusted.example:8443", "127.0.0.1:3000", ["https://trusted.example:8443"]),
      true,
    );
  });

  it("rejects a cross-host Origin NOT an exact match to an allowlist entry", () => {
    // Different scheme/port than the allowlisted entry — no partial/prefix match.
    assert.equal(
      isOriginAllowed("http://trusted.example:8443", "127.0.0.1:3000", ["https://trusted.example:8443"]),
      false,
    );
  });

  it("rejects a malformed Origin value (fail closed)", () => {
    assert.equal(isOriginAllowed("not a url", "127.0.0.1:3000", []), false);
  });

  it("mismatched port on an otherwise-same host is rejected (host header includes port)", () => {
    assert.equal(isOriginAllowed("http://127.0.0.1:5173", "127.0.0.1:3000", []), false);
  });
});

describe("timingSafeEqualString", () => {
  // Wave 2 review (minor): shouldSeedAuthCookie's ?auth_token= proof used a plain `===` on the
  // secret. Not practically exploitable over the network against a 256-bit token, but the review
  // flagged it as the extension of a timing-unsafe pattern to a new bootstrap path — hardened via
  // crypto.timingSafeEqual, guarding the length mismatch (timingSafeEqual throws on unequal-length
  // buffers rather than returning false) before comparing.

  it("returns true for identical strings", () => {
    assert.equal(timingSafeEqualString("super-secret-token", "super-secret-token"), true);
  });

  it("returns false for same-length strings that differ", () => {
    assert.equal(timingSafeEqualString("super-secret-tokeX", "super-secret-tokeN"), false);
  });

  it("returns false for different-length strings (no throw on length mismatch)", () => {
    assert.equal(timingSafeEqualString("short", "much-longer-value"), false);
    assert.equal(timingSafeEqualString("much-longer-value", "short"), false);
  });

  it("returns false for empty vs non-empty, true for empty vs empty", () => {
    assert.equal(timingSafeEqualString("", "tok"), false);
    assert.equal(timingSafeEqualString("", ""), true);
  });

  it("returns false when the candidate is not a string (query param edge cases: array/undefined/number)", () => {
    assert.equal(timingSafeEqualString(undefined, "tok"), false);
    assert.equal(timingSafeEqualString(null, "tok"), false);
    assert.equal(timingSafeEqualString(["tok"], "tok"), false);
    assert.equal(timingSafeEqualString(42, "tok"), false);
  });
});
