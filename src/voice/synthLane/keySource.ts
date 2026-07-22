import child_process from "node:child_process";

export interface KeySourceEnv {
  GEMINI_API_KEY?: string;
  [key: string]: string | undefined;
}

export type CredReadFn = () => Promise<string | null>;

export interface ResolveKeyOptions {
  env?: KeySourceEnv;
  credRead?: CredReadFn;
}

export interface KeyResult {
  found: boolean;
  source?: "env" | "credman";
  key?: string;
}

export interface KeyDescriptor {
  found: boolean;
  source?: "env" | "credman";
}

export interface CredReadSpawnProcess {
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "close" | "error", listener: (...args: any[]) => void): unknown;
}

export type CredReadSpawnFn = (
  command: string,
  args: string[],
  options?: unknown
) => CredReadSpawnProcess;

export interface CredReadDeps {
  spawn?: CredReadSpawnFn;
}

export function describeKeyResult(result: KeyResult): KeyDescriptor {
  if (!result.found || !result.source) {
    return { found: false };
  }
  return {
    found: true,
    source: result.source,
  };
}

export const describe = describeKeyResult;

export async function resolveGeminiKey(
  options: ResolveKeyOptions = {}
): Promise<KeyResult> {
  const env = options.env ?? process.env;
  const envKey = env.GEMINI_API_KEY?.trim();

  if (envKey) {
    return {
      found: true,
      source: "env",
      key: envKey,
    };
  }

  const credReadFn = options.credRead ?? credReadWindows;
  try {
    const credKey = await credReadFn();
    const trimmed = credKey?.trim();
    if (trimmed) {
      return {
        found: true,
        source: "credman",
        key: trimmed,
      };
    }
  } catch {
    // Ignore errors from credRead and fall through to found: false
  }

  return { found: false };
}

function escapePowerShellString(val: string): string {
  return val.replace(/'/g, "''");
}

export function credReadWindows(
  target: string = "aistudio.google.com",
  user: string = "gemini_key",
  deps?: CredReadDeps
): Promise<string | null> {
  const escapedTarget = escapePowerShellString(target);
  const escapedUser = escapePowerShellString(user);

  const script = [
    `$Signature = @"`,
    `[DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]`,
    `public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credPtr);`,
    `[DllImport("advapi32.dll", EntryPoint="CredFree", SetLastError=true)]`,
    `public static extern void CredFree(IntPtr credPtr);`,
    `"@`,
    `$CredTypeGeneric = [uint32]1`,
    `$type = Add-Type -MemberDefinition $Signature -Name "CredMan" -Namespace "AdvApi32" -PassThru`,
    `$credPtr = [IntPtr]::Zero`,
    `$target = '${escapedTarget}'`,
    `$expectedUser = '${escapedUser}'`,
    `$success = [AdvApi32.CredMan]::CredRead($target, $CredTypeGeneric, 0, [ref]$credPtr)`,
    `if ($success -and $credPtr -ne [IntPtr]::Zero) {`,
    `    try {`,
    `        $userNamePtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($credPtr, 72)`,
    `        $userName = if ($userNamePtr -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::PtrToStringUni($userNamePtr) } else { "" }`,
    `        if ($userName -eq $expectedUser) {`,
    `            $blobSize = [System.Runtime.InteropServices.Marshal]::ReadInt32($credPtr, 32)`,
    `            $blobPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($credPtr, 40)`,
    `            if ($blobPtr -ne [IntPtr]::Zero -and $blobSize -gt 0) {`,
    `                $secret = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($blobPtr, [int]($blobSize / 2))`,
    `                Write-Output $secret`,
    `            }`,
    `        }`,
    `    } finally {`,
    `        [AdvApi32.CredMan]::CredFree($credPtr)`,
    `    }`,
    `}`,
  ].join("\n");

  const spawnFn = deps?.spawn ?? (child_process.spawn as CredReadSpawnFn);

  return new Promise((resolve) => {
    let stdoutData = "";

    try {
      const child = spawnFn("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);

      child.stdout?.on("data", (chunk) => {
        stdoutData += chunk.toString("utf-8");
      });

      child.on("close", (code) => {
        if (code === 0) {
          const trimmed = stdoutData.trim();
          resolve(trimmed.length > 0 ? trimmed : null);
        } else {
          resolve(null);
        }
      });

      child.on("error", () => {
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}
