# Local dependency stubs (`overrides` targets)

These directories are **intentional** local shims wired up via `package.json` →
`"overrides"`. They are NOT cruft and must not be deleted — removing one while its
override line remains makes `npm install` fail with a dangling `file:` link.

## `node-domexception/`

- **Override:** `package.json` → `"overrides": { "node-domexception": "file:./stubs/node-domexception" }`
- **Why:** `fetch-blob`/`node-fetch` (the fetch/undici stack) declare a transitive peer on
  the `node-domexception` polyfill. On Node >=17 `DOMException` is a global, so the real
  polyfill is redundant and emits an install/deprecation warning. The stub
  (`module.exports = globalThis.DOMException;`) re-exports the native global — zero extra
  dependency, zero install noise.
- **If you want to drop it:** remove the `overrides` entry AND this directory together, then
  re-run `npm install` and the full build/test battery. Removing only one half re-breaks install.
