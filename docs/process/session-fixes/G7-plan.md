# G7 — node-domexception stub left in a broken half-deleted state (restore + document)

**Bead:** `wsm-e2e-pinned-4ws` (P3 · CHORE · build/deps)
**Worktree (all edits here):** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes` (branch `feat/session-fixes`)

---

## BLUF

`package.json:41` pins a dependency override `"node-domexception": "file:./stubs/node-domexception"`, but the two stub files (`stubs/node-domexception/index.js`, `…/package.json`) were **deleted uncommitted in the main checkout** (`git status` shows them as `D`). A `file:` override that points at a missing directory is a **dangling local dependency** — it breaks a clean `npm install`. The stub is a deliberate one-line transitive shim (`module.exports = globalThis.DOMException;`) that satisfies `fetch-blob`'s peer on `node-domexception` using the platform-native `DOMException` (Node ≥17), avoiding the real package's deprecation-noisy install. It was undocumented, so it reads like cruft and got half-deleted. **Resolution: RESTORE the stub (it is already intact and tracked on `feat/session-fixes`) and DOCUMENT it (inline comment + `stubs/README.md`) so it is not re-deleted.** This is a docs/config fix — no TDD; the "test" is a clean `npm install` + `build` + `lint`.

---

## 1. Problem & Root Cause (code-anchored)

### 1a. The override and the missing target

`package.json` (verified line 41, inside `"overrides"`):

```json
"overrides": {
  "node-domexception": "file:./stubs/node-domexception"
}
```

This forces **every** transitive request for `node-domexception` (npm v8+ `overrides`) to resolve to the local stub directory instead of the registry package.

The stub itself (intact on `feat/session-fixes`, verified):

- `stubs/node-domexception/index.js` — `module.exports = globalThis.DOMException;` (43 bytes)
- `stubs/node-domexception/package.json` — `{ "name": "node-domexception", "version": "1.0.0", "main": "index.js" }` (83 bytes)

Both are **git-tracked** in this worktree (`git ls-files stubs/` lists both). The breakage is purely the **main checkout's uncommitted deletion**:

```
$ git -C <main> status --short stubs/
 D stubs/node-domexception/index.js
 D stubs/node-domexception/package.json
```

A `file:` override whose target directory does not exist makes `npm install` fail to resolve the link target. The fix does **not** touch the main checkout (single-owner rule + acceptance: "main checkout not touched"); it lands the restored-and-documented stub on `feat/session-fixes`, and the main checkout's stale deletion gets resolved when that branch is integrated (out of scope here).

### 1b. Why the stub exists (the load-bearing rationale)

`node-domexception` (the real registry package) is a polyfill for the WHATWG `DOMException` class, pulled in transitively by `fetch-blob` / `node-fetch` / `formdata-polyfill` (the `undici`/fetch stack). On modern Node (≥17) `DOMException` is a **global** — the polyfill is redundant, and recent versions print a deprecation/`punycode`-style install warning. The one-line stub re-exports the platform-native global, satisfying the peer with zero install noise and zero extra dependency surface. It is **intentional**, not leftover scaffolding — exactly the kind of thing that gets mistakenly "cleaned up" when undocumented. That mistaken cleanup is precisely what happened (the half-deletion in the main checkout).

---

## 2. The Exact Changes (`file:location:change`)

> This is a **docs/config** fix (the bead is type `chore`). No production code logic changes; no failing-test-first cycle. The verification gate is a clean dependency install + build + lint (§4).

### Change A — restore the stub files (already present on `feat/session-fixes`)

Confirm both files exist and are tracked on the feature branch; no edit needed if `git ls-files stubs/` already lists them (it does). If a future state shows them missing, restore verbatim:

`stubs/node-domexception/index.js`:
```js
// Intentional transitive shim — see stubs/README.md.
// fetch-blob/node-fetch pull a peer on `node-domexception`; on Node >=17 DOMException
// is a global, so the real polyfill is redundant (and install-noisy). Re-export the native one.
module.exports = globalThis.DOMException;
```

`stubs/node-domexception/package.json` (UNCHANGED — keep minimal so the `file:` link resolves):
```json
{
  "name": "node-domexception",
  "version": "1.0.0",
  "main": "index.js"
}
```

### Change B — add the inline "why" comment to `index.js`

Prepend the 3-line comment shown in Change A to `stubs/node-domexception/index.js` so the one-liner is no longer a mystery at the point of use. (Keep `package.json` comment-free — JSON has no comments and npm parses it.)

### Change C — add `stubs/README.md` (NEW)

A short README at the `stubs/` root explaining the convention and this specific stub, so the next person (or agent) reading `git status` does not delete it again:

```md
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
```

### Change D — annotate the `overrides` entry in `package.json` (optional, conditional)

JSON forbids comments, so do **not** add a `//` comment inside `package.json`. Instead, the cross-reference lives in `stubs/README.md` (Change C). If a machine-readable pointer is desired, a sibling `"overrides__comment"` key is an option but is **not** recommended (npm warns on unknown top-level keys in some versions) — **skip** unless review asks for it. Decision: rely on `stubs/README.md` + the `index.js` comment only.

---

## 3. Test Plan

> **No TDD cycle** — this is a docs/config fix (per the orchestrator's "except pure docs/config fixes like G7" carve-out). There is nothing executable to assert in a unit test; the regression surface is the dependency graph, which is exercised by `npm install` + `npm run build`. The "red→green" equivalent is:
>
> 1. **RED (the known break):** with the stub directory absent but the `overrides` line present, `npm install` fails to resolve the `file:` link. (Already demonstrated by the main checkout's `D`-marked deletion.)
> 2. **GREEN:** with the stub restored + documented on `feat/session-fixes`, `npm install` resolves cleanly and `npm run build` + `npm run lint` pass.

No new `tests/*.ts` file. Do **not** invent a test that imports the stub directly — its whole job is to re-export a Node global, and asserting `globalThis.DOMException` is just testing Node, not our change.

---

## 4. Verify Commands

Run from the feature worktree root `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes`:

```bash
npm install        # MUST resolve the file:./stubs/node-domexception override with no dangling-link error
npm run build      # vite + esbuild -> dist/server.cjs — confirms the fetch stack still bundles
npm run lint       # tsc --noEmit — must stay green (baseline)
npm test           # tsx --test --test-force-exit — must stay 397 pass / 0 fail (no regression)
```

`npm install` is the load-bearing check (it is what was broken). `build`/`lint`/`test` confirm no collateral regression.

---

## 5. Risks

1. **Main checkout still shows the deletion.** Acceptance explicitly forbids touching the main checkout. The stale `D` there is resolved when `feat/session-fixes` is integrated — **not** in this task. Do not `git checkout`/`restore` files in the main checkout (foreign tree, single-owner rule).
2. **`overrides` semantics are npm-version sensitive.** `overrides` is npm v8.3+. The repo already relies on it (the entry pre-exists), so no new floor is introduced. If the install env is older npm, that is a pre-existing constraint, not a G7 regression.
3. **Tempting "real fix" = drop the override entirely.** Deferred alternative (in the bead): remove the `overrides` entry and let the registry `node-domexception` install. That trades the stub for install-time deprecation noise and an extra dependency; **out of scope** — restore+document is the chosen, lower-risk path. File a follow-up bead if the team wants the full removal.
4. **JSON-comment trap.** Do not add `//`/`/* */` to any `package.json` (it is not valid JSON and npm will fail to parse). All "why" documentation lives in `stubs/README.md` and the `index.js` comment.

---

## 6. Acceptance Criteria (from the bead, made checkable)

- [ ] **Stub restored & intact** on `feat/session-fixes`: `stubs/node-domexception/index.js` (`module.exports = globalThis.DOMException;`) and `…/package.json` both present and git-tracked.
- [ ] **Documented:** inline "why" comment in `index.js` **and** a `stubs/README.md` explaining the override convention + this specific stub.
- [ ] **`package.json` `file:` override intact** — the `"node-domexception": "file:./stubs/node-domexception"` line (package.json:41) is unchanged and now has a documented target.
- [ ] **`npm install` + `npm run build` + `npm run lint` green** from the worktree; `npm test` stays at baseline (397 pass / 0 fail).
- [ ] **Main checkout not touched** — no edits, restores, or stashes in `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner` or any other worktree.
