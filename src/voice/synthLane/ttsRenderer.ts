import child_process from "node:child_process";

export interface RenderSpawnProcess {
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type RenderSpawnFn = (
  command: string,
  args: string[],
  options?: unknown
) => RenderSpawnProcess;

export interface RenderDeps {
  spawn?: RenderSpawnFn;
}

function validateFmtChunk(buf: Buffer, payload: number, size: number): void {
  if (size < 16 || payload + 16 > buf.length) {
    throw new Error("Invalid WAV: fmt chunk too small");
  }
  if (buf.readUInt16LE(payload) !== 1) {
    throw new Error("Invalid WAV: AudioFormat must be 1 (PCM)");
  }
  if (buf.readUInt16LE(payload + 2) !== 1) {
    throw new Error("Invalid WAV: NumChannels must be 1 (mono)");
  }
  if (buf.readUInt32LE(payload + 4) !== 16000) {
    throw new Error("Invalid WAV: SampleRate must be 16000 Hz");
  }
  if (buf.readUInt16LE(payload + 14) !== 16) {
    throw new Error("Invalid WAV: BitsPerSample must be 16");
  }
}

export function wavToPcm(buf: Buffer | Uint8Array): Buffer {
  const nodeBuf = Buffer.from(buf);
  if (nodeBuf.length < 44) {
    throw new Error("Invalid WAV: Buffer too short for a RIFF/WAVE file");
  }
  if (nodeBuf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Invalid WAV: missing RIFF header tag");
  }
  if (nodeBuf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid WAV: missing WAVE format tag");
  }

  // Chunk-walk instead of assuming the canonical 44-byte layout (review fix): real SAPI
  // (System.Speech SetOutputToWaveFile) writes an 18-byte WAVEFORMATEX fmt chunk (cbSize=0),
  // placing "data" at offset 38 — verified empirically on this machine (fmtSize=18). A
  // fixed-offset parse rejects every real render; the format VALIDATION stays just as strict.
  let offset = 12;
  let fmtSeen = false;
  while (offset + 8 <= nodeBuf.length) {
    const id = nodeBuf.toString("ascii", offset, offset + 4);
    const size = nodeBuf.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === "fmt ") {
      validateFmtChunk(nodeBuf, payload, size);
      fmtSeen = true;
    } else if (id === "data") {
      if (!fmtSeen) {
        throw new Error("Invalid WAV: data chunk precedes fmt chunk");
      }
      return nodeBuf.subarray(payload, Math.min(payload + size, nodeBuf.length));
    }
    offset = payload + size + (size % 2); // RIFF chunks are word-aligned
  }
  throw new Error("Invalid WAV: missing data subchunk tag");
}

export function padTrailingSilence(
  pcm: Buffer | Uint8Array,
  durationMs: number,
  sampleRate: number = 16000
): Buffer {
  const nodePcm = Buffer.from(pcm);
  const samplesToPad = Math.ceil((durationMs / 1000) * sampleRate);
  const bytesToPad = samplesToPad * 2;
  const padding = Buffer.alloc(bytesToPad);
  return Buffer.concat([nodePcm, padding]);
}

export function chunkToFrames(
  pcm: Buffer | Uint8Array,
  frameSamples: number = 4096
): Buffer[] {
  const nodePcm = Buffer.from(pcm);
  const frameByteSize = frameSamples * 2;
  if (nodePcm.byteLength === 0) {
    return [];
  }

  const numFrames = Math.ceil(nodePcm.byteLength / frameByteSize);
  const frames: Buffer[] = [];

  for (let i = 0; i < numFrames; i++) {
    const start = i * frameByteSize;
    const end = Math.min(start + frameByteSize, nodePcm.byteLength);
    const chunk = nodePcm.subarray(start, end);

    if (chunk.length === frameByteSize) {
      frames.push(chunk);
    } else {
      const padded = Buffer.alloc(frameByteSize);
      chunk.copy(padded, 0);
      frames.push(padded);
    }
  }

  return frames;
}

export function frameToBase64(frame: Buffer | Uint8Array): string {
  return Buffer.from(frame).toString("base64");
}

function escapePowerShellString(val: string): string {
  return val.replace(/'/g, "''");
}

export function renderUtteranceToWav(
  text: string,
  outPath: string,
  deps?: RenderDeps
): Promise<void> {
  const escapedOutPath = escapePowerShellString(outPath);
  const escapedText = escapePowerShellString(text);

  const script = [
    `Add-Type -AssemblyName System.Speech`,
    `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
    `$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)`,
    `$synth.SetOutputToWaveFile('${escapedOutPath}', $format)`,
    `$synth.Speak('${escapedText}')`,
    `$synth.Dispose()`,
  ].join("\n");

  const spawnFn = deps?.spawn ?? (child_process.spawn as RenderSpawnFn);

  return new Promise((resolve, reject) => {
    const child = spawnFn("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`PowerShell process exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}
