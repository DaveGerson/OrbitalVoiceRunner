// tests/test_binary_on_path.ts — pure unit tests for src/binaryOnPath.ts (bead
// wsm-e2e-pinned-0bof: pre-spawn PATH preflight for NON-Custom create_pane presets).
//
// Every case is dependency-injected (platform/pathEnv/pathExtEnv/existsSync) so this suite never
// touches the real filesystem or the real PATH — it is deterministic on any host/CI.

import { describe, it } from "node:test";
import assert from "node:assert";
import { firstCommandToken, isOnPath, unresolvedPresetBinary } from "../src/binaryOnPath";

describe("firstCommandToken", () => {
  it("returns a bare command unchanged", () => {
    assert.strictEqual(firstCommandToken("claude"), "claude");
  });

  it("splits on the first whitespace run, dropping flags", () => {
    assert.strictEqual(firstCommandToken("claude --dangerously-skip-permissions"), "claude");
  });

  it("unwraps a double-quoted first segment (a path-with-spaces)", () => {
    assert.strictEqual(
      firstCommandToken('"C:\\Program Files\\agy\\agy.exe" --flag'),
      "C:\\Program Files\\agy\\agy.exe"
    );
  });

  it("unwraps a single-quoted first segment", () => {
    assert.strictEqual(firstCommandToken("'/opt/my tool/bin/codex' --flag"), "/opt/my tool/bin/codex");
  });

  it("returns null for an unterminated quote (unparseable -> caller must fail open)", () => {
    assert.strictEqual(firstCommandToken('"C:\\Program Files\\agy\\agy.exe --flag'), null);
  });

  it("returns null for an empty/blank command", () => {
    assert.strictEqual(firstCommandToken("   "), null);
  });
});

describe("isOnPath", () => {
  it("PATH miss -> false", () => {
    const found = isOnPath("nope-not-here", {
      platform: "linux",
      pathEnv: "/usr/bin:/bin",
      existsSync: () => false,
    });
    assert.strictEqual(found, false);
  });

  it("scans every PATH directory until a hit", () => {
    const found = isOnPath("agy", {
      platform: "linux",
      pathEnv: "/usr/bin:/opt/agy/bin",
      existsSync: (p) => p === "/opt/agy/bin/agy",
    });
    assert.strictEqual(found, true);
  });

  it("absolute path hit -> true, checked directly (no PATH scan)", () => {
    const found = isOnPath("C:\\tools\\claude.exe", {
      platform: "win32",
      pathEnv: "C:\\nonexistent",
      pathExtEnv: ".EXE",
      existsSync: (p) => p === "C:\\tools\\claude.exe",
    });
    assert.strictEqual(found, true);
  });

  it("win32: PATHEXT is tried case-as-configured — a lowercase PATHEXT still resolves", () => {
    const found = isOnPath("agy", {
      platform: "win32",
      pathEnv: "C:\\bin",
      pathExtEnv: ".com;.exe;.bat;.cmd",
      existsSync: (p) => p === "C:\\bin\\agy.exe",
    });
    assert.strictEqual(found, true, "lowercase PATHEXT entries still produce a matching candidate");
  });

  it("win32: an UPPERCASE PATHEXT also resolves a lowercase-suffixed binary on disk", () => {
    // Case-insensitivity cuts both ways: PATHEXT casing must never gate the match either way —
    // only existsSync (the real, case-insensitive Windows filesystem) decides.
    const found = isOnPath("agy", {
      platform: "win32",
      pathEnv: "C:\\bin",
      pathExtEnv: ".COM;.EXE;.BAT;.CMD",
      existsSync: (p) => p.toLowerCase() === "c:\\bin\\agy.exe",
    });
    assert.strictEqual(found, true);
  });

  it("win32: a bin that already carries an extension is checked as-is (no PATHEXT re-append)", () => {
    const seen: string[] = [];
    isOnPath("agy.exe", {
      platform: "win32",
      pathEnv: "C:\\bin",
      pathExtEnv: ".EXE;.CMD",
      existsSync: (p) => { seen.push(p); return false; },
    });
    assert.deepStrictEqual(seen, ["C:\\bin\\agy.exe"], "no PATHEXT re-append when the bin already has an extension");
  });

  it("non-win32 ignores PATHEXT entirely (single bare candidate per dir)", () => {
    const seen: string[] = [];
    isOnPath("agy", {
      platform: "linux",
      pathEnv: "/usr/bin",
      pathExtEnv: ".EXE", // must be ignored off win32
      existsSync: (p) => { seen.push(p); return false; },
    });
    assert.deepStrictEqual(seen, ["/usr/bin/agy"]);
  });

  it("empty bin -> false", () => {
    assert.strictEqual(
      isOnPath("", { platform: "linux", pathEnv: "/usr/bin", existsSync: () => true }),
      false
    );
  });
});

describe("unresolvedPresetBinary", () => {
  it("returns null (resolved) when the binary is found on PATH", () => {
    const result = unresolvedPresetBinary("claude --flag", {
      platform: "linux",
      pathEnv: "/usr/bin",
      existsSync: (p) => p === "/usr/bin/claude",
    });
    assert.strictEqual(result, null);
  });

  it("returns the unresolved first-token bin when the binary is missing", () => {
    const result = unresolvedPresetBinary("claude --flag", {
      platform: "linux",
      pathEnv: "/usr/bin",
      existsSync: () => false,
    });
    assert.strictEqual(result, "claude");
  });

  it("fails open (returns null) on an unparseable command — never refuse on ambiguity", () => {
    const result = unresolvedPresetBinary('"unterminated --flag', {
      platform: "linux",
      pathEnv: "/usr/bin",
      existsSync: () => false,
    });
    assert.strictEqual(result, null);
  });
});
