# Perimeter token model hardening (bead wsm-e2e-pinned-xge)

Status: implemented 2026-07-02.

## Threat model

Janus's server can spawn and write to real host processes (`node-pty`/ConPTY panes) through a
single shared secret, `API_AUTH_TOKEN`. Before this bead:

1. **Loading the UI granted authority to any peer that could reach it.** The cookie-auto-seed
   middleware (`server.ts`'s `registerAuthMiddleware`) handed the httpOnly `auth_token` cookie —
   equal to the live `API_AUTH_TOKEN` — to *any* request whose path was not under `/api`/`/live`,
   with no check on who the peer was. A page load is not proof of authority; it is just a page
   load. If the process were ever reachable from a non-loopback network (see #2), simply opening
   the SPA in a browser was enough to receive full pane-control credentials.
2. **The token fallback was guessable/reproducible off-host.** With no `API_AUTH_TOKEN` env set,
   the token was `sha256("janus-auth:" + process.cwd())` — a pure function of the working
   directory. Anyone who knew (or could guess — cwd is often predictable: a home directory, a
   deploy path, a container's `WORKDIR`) the server's cwd could compute the exact token without
   ever touching the running process.
3. **Production defaulted to binding all interfaces.** `resolveBindHost` picked `0.0.0.0` whenever
   `NODE_ENV === "production"`, with zero correlated check that a real, operator-chosen token was
   in play — so the two weaknesses above could combine into full remote exposure of a
   host-process-control server with a guessable secret, activated purely by an env var most
   deployment tooling sets automatically.
4. **No Origin fence on the WebSocket upgrade.** The single `/live` WebSocket endpoint (both the
   voice and the observe/kitchen lane multiplex over it) accepted a connection from a page hosted
   at any Origin, browser or not, as long as the auth cookie value matched. `sameSite: "strict"`
   mitigates classic CSRF for cookie-bearing browser contexts, but offers zero protection to
   non-browser WS clients that can read the cookie some other way, and there was no independent
   Origin-based fence at all.

None of these were exploitable *by default* (the default bind was already loopback-only outside
production, and nothing in the shipped config sets `NODE_ENV=production`), but they were latent —
a single env var flip (`NODE_ENV=production`) silently changed the security posture with no
corresponding prompt, check, or refusal. This bead closes that gap: **each of these four levers
now requires an explicit, auditable opt-in before the process becomes reachable, or trusts a peer,
beyond loopback.**

## The bind-host x token-env behavior matrix

| Effective bind host | `API_AUTH_TOKEN` env set? | Outcome |
|---|---|---|
| loopback (127.0.0.0/8, `::1`, `localhost`) | no | **starts** — token falls back to a fresh random 64-hex value, process only reachable from this machine |
| loopback | yes | **starts** — operator's explicit token used |
| non-loopback (`0.0.0.0`, a LAN IP, a hostname, ...) | no | **refuses to start** — `assertBindHostAuthorized` throws before the process opens a single socket |
| non-loopback | yes | **starts** — the explicit env token is the operator's opt-in signal that they intend network exposure |

`resolveBindHost` (`server.ts`) now defaults to `127.0.0.1` in **every** mode, including
`NODE_ENV=production` — the old prod-only `0.0.0.0` special case is gone. Non-loopback binding is
only reachable via the explicit `bindHost` `StartServerOptions` field or the new `JANUS_BIND_HOST`
env (no prior env existed for this; verified by grep before adding it). `assertBindHostAuthorized`
runs at the very top of `startServer`, before any Express app / HTTP server / WebSocketServer is
constructed, and is checked **regardless of `options.listen`** — a `listen:false` boot (the test
harness's preferred no-network-bind pattern) still sees the refusal, because the decision being
validated is "did the operator authorize this," not "did a socket actually open."

## Token fallback

`server.ts`'s exported `API_AUTH_TOKEN` constant keeps its exact shape and export path (a plain
string, `server.ts`'s module scope, equal to whatever the `/api` auth middleware and the `/live`
WS guard check) — that seam is load-bearing across ~40 test files and several scripts
(`scripts/verify-live-voice.ts`, `scripts/simulate-voice.ts`) and was left untouched by name.
Only the fallback expression changed:

```ts
// before: process.env.API_AUTH_TOKEN || sha256("janus-auth:" + process.cwd())
// after:
export const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || crypto.randomBytes(32).toString("hex");
```

A fresh 64-lowercase-hex-character token is minted once per process boot when no env override is
present. It is never persisted and never logged (grepped the diff for the literal token value —
only the *fact* "Session API Authentication Token generated" is logged, never the value itself,
matching the pre-existing convention).

## Cookie auto-seed: loopback-gated + the remote-operator `?auth_token=` path

The auto-seed middleware used to hand the cookie to any non-`/api`/non-`/live` request whose
current cookie mismatched. The decision is now the pure, directly-unit-tested
`shouldSeedAuthCookie` (extracted from the middleware so it never needs a live socket to exercise):

```ts
shouldSeedAuthCookie({ currentToken, apiToken, remoteAddress, authTokenQuery }) =
     currentToken !== apiToken
  && ( isLoopbackAddress(remoteAddress)                       // (1) local dev browser — unchanged
       || authTokenQuery === apiToken )                       // (2) remote operator proved the token
```

1. **Loopback peer** — the original "seed the local dev/desktop browser" behavior, unchanged for
   every existing loopback dev/test flow (`isLoopbackAddress` reads `req.socket.remoteAddress`).
2. **Remote-operator bootstrap** — a request whose URL carries `?auth_token=<exact match>` proves
   it already knows the real secret out-of-band (e.g. an operator-shared link), so it may still be
   handed the cookie even from a non-loopback peer. This is the only way a legitimate non-cookie,
   non-loopback client can ever bootstrap a session; without it there was no way at all for a
   deliberately-exposed instance to authenticate a first-time remote browser.

Any other combination (non-loopback peer, no/wrong `auth_token` query param) gets **no cookie** —
the SPA shell itself is still served (that's intentionally public; the API/WS boundary is the real
fence, unchanged from before this bead), but every `/api` and `/live` call then fails auth for
that peer.

**Operational hygiene for the `?auth_token=` link (Wave 2 review, minor):** the app itself never
logs the token or the query string it arrives on (only the boot-time *fact* "Session API
Authentication Token generated" is logged, never the value), and the seed middleware explicitly
skips `/api`/`/live`. But putting any secret in a page URL is inherently a broader leak surface
than a header/cookie: it can land in upstream reverse-proxy access logs, browser history, or a
`Referer` header sent to a third-party resource loaded by the same page — none of which this
process controls. Treat an `?auth_token=` link as **single-use and TLS-only**: share it once to
bootstrap the httpOnly cookie on the remote operator's browser, then let the cookie (not the URL)
carry the session from that point on; don't bookmark or re-share the link itself.

`isLoopbackAddress` (`src/security/perimeter.ts`) is a pure, exported helper: true for
`127.0.0.0/8`, `::1`, an IPv4-mapped IPv6 loopback (`::ffff:127.x.y.z`), and the `"localhost"`
hostname; false for `undefined`/`null`/empty, and — deliberately — `"0.0.0.0"` (binds *all*
interfaces, the opposite of loopback-only, despite the superficial resemblance).

## WS Origin policy

`src/voice/index.ts`'s `attachVoiceSession` now runs an Origin check on every `/live` connection,
before the cookie check, before the observe/voice lane split (so both lanes get an identical
fence):

- **No `Origin` header** — every non-browser client (the `ws` npm client used throughout the test
  suite and `scripts/simulate-voice.ts` does not set one by default) — **unchanged**: proceed
  straight to the existing cookie auth.
- **`Origin` present** — allowed iff its `host[:port]` matches the request's `Host` header
  (same-host, case-insensitive), or the raw Origin string appears verbatim in the comma-separated
  `JANUS_ALLOWED_ORIGINS` env. Anything else — including a malformed Origin value — is rejected
  (fail closed), closing the socket with code `4003` before any voice/observe machinery runs.

`isOriginAllowed(origin, host, allowlist)` and `parseAllowedOrigins(env)` live alongside
`isLoopbackAddress` in `src/security/perimeter.ts` — pure, no Node http/net coupling, unit-tested
directly (no server boot needed for the exhaustive branch table).

Caveat carried over from recon, unchanged by this bead: the `ws` library gives no pre-handshake
upgrade hook without `noServer` mode, so a rejected peer briefly completes the WS handshake before
the server-side Origin/cookie checks close it (connection-count/DoS surface, not a credential
leak). Both the Origin and cookie checks reject inside the same `connection` handler for this
reason.

## Env knobs (new + existing)

| Env var | Purpose | Default |
|---|---|---|
| `API_AUTH_TOKEN` | The shared perimeter secret. Setting it explicitly is ALSO the fail-closed opt-in signal for non-loopback binding. | random 64-hex per boot |
| `JANUS_BIND_HOST` | Override the bind host (net-new; no prior bind-host env existed). | unset -> `127.0.0.1` |
| `JANUS_ALLOWED_ORIGINS` | Comma-separated list of exact Origin strings allowed on `/live` in addition to same-host. | unset -> `[]` (same-host only) |

## What did NOT change

- Capability-gate matrix / enforcement — untouched.
- The `/api` `authMiddleware` itself (cookie OR `x-api-token`/`Authorization: Bearer` header) —
  untouched; still guards `/api` only.
- The `/live` cookie-token equality check itself — untouched; the Origin check is a new fence
  *before* it, not a replacement.
- Every existing test's auth path: they all connect to `127.0.0.1` with an explicit cookie/header
  carrying the exported `API_AUTH_TOKEN`, send no `Origin` header, and never pass a `bindHost`
  option (so they hit the loopback branch of every new guard) — all pass unchanged.
- The Playwright mock lane's browser relies entirely on the loopback auto-seed path (still live);
  the live e2e lane pins `API_AUTH_TOKEN` explicitly and never sets `bindHost`/`JANUS_BIND_HOST`,
  so it stays on loopback and is unaffected by the fail-closed guard.

## Tests

- `tests/test_perimeter_helpers.ts` — exhaustive table tests for the three pure helpers
  (`isLoopbackAddress`, `parseAllowedOrigins`, `isOriginAllowed`), no server/socket needed.
- `tests/test_perimeter_boot_hardening.ts` — integration-level: the random token-fallback shape,
  `resolveBindHost` defaults/env/option precedence, the `assertBindHostAuthorized` /
  `startServer` fail-closed matrix (including a real `listen:false` boot on both sides), the
  `shouldSeedAuthCookie` decision table, and the real `/live` WS Origin fence (reject cross-host,
  accept same-host, accept absent-Origin-with-valid-cookie).
