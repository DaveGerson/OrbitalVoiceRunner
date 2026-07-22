import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveGeminiKey,
  describeKeyResult,
  describe,
  credReadWindows,
  CredReadDeps,
  KeyResult,
} from "../src/voice/synthLane/keySource.ts";

test("resolveGeminiKey precedence branch 1: env non-empty wins", async () => {
  let credReadCalled = false;
  const mockCredRead = async () => {
    credReadCalled = true;
    return "credman-secret";
  };

  const result = await resolveGeminiKey({
    env: { GEMINI_API_KEY: "env-secret-123" },
    credRead: mockCredRead,
  });

  assert.equal(result.found, true);
  assert.equal(result.source, "env");
  assert.equal(result.key, "env-secret-123");
  assert.equal(credReadCalled, false, "credRead must not be called if env key is present");
});

test("resolveGeminiKey precedence branch 2: credman wins when env is missing/empty", async () => {
  const mockCredRead = async () => "credman-secret-456";

  const resultWithEmptyEnv = await resolveGeminiKey({
    env: { GEMINI_API_KEY: "" },
    credRead: mockCredRead,
  });

  assert.equal(resultWithEmptyEnv.found, true);
  assert.equal(resultWithEmptyEnv.source, "credman");
  assert.equal(resultWithEmptyEnv.key, "credman-secret-456");

  const resultWithNoEnvKey = await resolveGeminiKey({
    env: {},
    credRead: mockCredRead,
  });

  assert.equal(resultWithNoEnvKey.found, true);
  assert.equal(resultWithNoEnvKey.source, "credman");
  assert.equal(resultWithNoEnvKey.key, "credman-secret-456");
});

test("resolveGeminiKey precedence branch 3: returns found:false when neither produces a key", async () => {
  const resultNullCred = await resolveGeminiKey({
    env: {},
    credRead: async () => null,
  });
  assert.equal(resultNullCred.found, false);
  assert.equal(resultNullCred.key, undefined);

  const resultEmptyCred = await resolveGeminiKey({
    env: {},
    credRead: async () => "   ",
  });
  assert.equal(resultEmptyCred.found, false);
  assert.equal(resultEmptyCred.key, undefined);
});

test("describe and describeKeyResult helpers return ONLY source and found, never key material", () => {
  const envResult: KeyResult = {
    found: true,
    source: "env",
    key: "SUPER_SECRET_ENV_KEY_999",
  };
  const credResult: KeyResult = {
    found: true,
    source: "credman",
    key: "SUPER_SECRET_CRED_KEY_888",
  };
  const falseResult: KeyResult = {
    found: false,
  };

  const descEnv = describeKeyResult(envResult);
  assert.deepEqual(descEnv, { found: true, source: "env" });
  assert.equal(JSON.stringify(descEnv).includes("SUPER_SECRET_ENV_KEY_999"), false);

  const descCred = describe(credResult);
  assert.deepEqual(descCred, { found: true, source: "credman" });
  assert.equal(JSON.stringify(descCred).includes("SUPER_SECRET_CRED_KEY_888"), false);

  const descFalse = describeKeyResult(falseResult);
  assert.deepEqual(descFalse, { found: false });
});

test("resolver never logs to console", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  let logged = false;
  const spy = () => {
    logged = true;
  };

  console.log = spy;
  console.error = spy;
  console.warn = spy;

  try {
    await resolveGeminiKey({
      env: { GEMINI_API_KEY: "secret" },
      credRead: async () => "cred-secret",
    });
    await resolveGeminiKey({
      env: {},
      credRead: async () => "cred-secret",
    });
    await resolveGeminiKey({
      env: {},
      credRead: async () => null,
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.equal(logged, false, "resolver must never log to console");

  // Also assert keySource.ts source file contains no console.* calls
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.resolve(__dirname, "../src/voice/synthLane/keySource.ts");
  if (fs.existsSync(sourcePath)) {
    const sourceCode = fs.readFileSync(sourcePath, "utf-8");
    assert.equal(/console\.(log|error|warn|info|debug)/.test(sourceCode), false, "keySource.ts must not contain console.* calls");
  }
});

test("credReadWindows builds PowerShell script with CredReadW/type 1/Unicode/CredFree and trims secret from stdout", async () => {
  let spawnCalls: { command: string; args: string[] }[] = [];

  const mockSpawn: CredReadDeps["spawn"] = (command, args) => {
    spawnCalls.push({ command, args });
    const stdoutListeners: ((chunk: Buffer | string) => void)[] = [];
    const closeListeners: ((code: number) => void)[] = [];

    setTimeout(() => {
      for (const listener of stdoutListeners) {
        listener("  fake-windows-secret-key-12345 \r\n");
      }
      for (const listener of closeListeners) {
        listener(0);
      }
    }, 5);

    return {
      stdout: {
        on: (event: string, listener: (chunk: Buffer | string) => void) => {
          if (event === "data") stdoutListeners.push(listener);
        },
      },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "close") closeListeners.push(listener);
      },
    } as any;
  };

  const secret = await credReadWindows("aistudio.google.com", "gemini_key", { spawn: mockSpawn });

  assert.equal(secret, "fake-windows-secret-key-12345");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "powershell");

  const script = spawnCalls[0].args[3];
  assert.ok(script.includes("CredReadW"), "missing CredReadW token");
  assert.ok(/\b1\b/.test(script) || script.includes("CRED_TYPE_GENERIC"), "missing type 1 token");
  assert.ok(
    script.includes("Unicode") || script.includes("PtrToStringUni"),
    "missing Unicode-decode token"
  );
  assert.ok(script.includes("CredFree"), "missing CredFree token");
});

test("credReadWindows returns null on process failure or empty output without throwing", async () => {
  const mockFailingSpawn: CredReadDeps["spawn"] = () => {
    return {
      stdout: {
        on: () => {},
      },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "close") listener(1);
      },
    } as any;
  };

  const resultOnFailure = await credReadWindows("target", "user", { spawn: mockFailingSpawn });
  assert.equal(resultOnFailure, null);

  const mockEmptySpawn: CredReadDeps["spawn"] = () => {
    return {
      stdout: {
        on: () => {},
      },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "close") listener(0);
      },
    } as any;
  };

  const resultOnEmpty = await credReadWindows("target", "user", { spawn: mockEmptySpawn });
  assert.equal(resultOnEmpty, null);
});
