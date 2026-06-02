// Intentional transitive shim — see stubs/README.md.
// fetch-blob/node-fetch pull a peer on `node-domexception`; on Node >=17 DOMException
// is a global, so the real polyfill is redundant (and install-noisy). Re-export the native one.
module.exports = globalThis.DOMException;
