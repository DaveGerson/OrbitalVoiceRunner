import test from "node:test";
import assert from "node:assert/strict";
import { pcmToBase64 } from "../src/utils/audio.ts";
import {
  wavToPcm,
  padTrailingSilence,
  chunkToFrames,
  frameToBase64,
  renderUtteranceToWav,
  RenderDeps,
} from "../src/voice/synthLane/ttsRenderer.ts";

function createCanonicalWavBuffer(samples: Int16Array): Buffer {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(16000, 24); // 16000 Hz
  buf.writeUInt32LE(32000, 28); // ByteRate
  buf.writeUInt16LE(2, 32); // BlockAlign
  buf.writeUInt16LE(16, 34); // 16-bit
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}

test("wavToPcm strips 44-byte header and returns sample bytes for canonical WAV", () => {
  const samples = new Int16Array([100, -200, 300, -400, 500]);
  const wavBuf = createCanonicalWavBuffer(samples);
  const pcm = wavToPcm(wavBuf);
  assert.equal(pcm.length, samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    assert.equal(pcm.readInt16LE(i * 2), samples[i]);
  }
});

// Review-fix regression (Fable, 2026-07-22): the REAL SAPI writer emits an 18-byte
// WAVEFORMATEX fmt chunk (cbSize=0), so "data" sits at offset 38 — captured empirically from
// System.Speech on the target machine. wavToPcm must chunk-walk, not assume the 44-byte layout.
function createSapiShapeWavBuffer(samples: Int16Array): Buffer {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(46 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(38 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(18, 16); // WAVEFORMATEX: 16 base + 2-byte cbSize field
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.writeUInt16LE(0, 36); // cbSize = 0
  buf.write("data", 38);
  buf.writeUInt32LE(dataSize, 42);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 46 + i * 2);
  }
  return buf;
}

test("wavToPcm handles the real SAPI shape (18-byte fmt chunk, data at offset 38)", () => {
  const samples = new Int16Array([11, -22, 33, -44, 55, -66]);
  const pcm = wavToPcm(createSapiShapeWavBuffer(samples));
  assert.equal(pcm.length, samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    assert.equal(pcm.readInt16LE(i * 2), samples[i]);
  }
});

test("wavToPcm throws descriptive errors for non-canonical headers", () => {
  assert.throws(() => wavToPcm(Buffer.alloc(20)), /too short/i);

  const samples = new Int16Array([1, 2, 3]);

  // Non-RIFF
  const badRiff = createCanonicalWavBuffer(samples);
  badRiff.write("NOPE", 0);
  assert.throws(() => wavToPcm(badRiff), /RIFF/i);

  // Non-WAVE
  const badWave = createCanonicalWavBuffer(samples);
  badWave.write("NOPE", 8);
  assert.throws(() => wavToPcm(badWave), /WAVE/i);

  // Non-PCM (AudioFormat = 3 float)
  const badFmt = createCanonicalWavBuffer(samples);
  badFmt.writeUInt16LE(3, 20);
  assert.throws(() => wavToPcm(badFmt), /PCM/i);

  // Stereo (NumChannels = 2)
  const badChannels = createCanonicalWavBuffer(samples);
  badChannels.writeUInt16LE(2, 22);
  assert.throws(() => wavToPcm(badChannels), /mono/i);

  // Sample rate != 16000
  const badRate = createCanonicalWavBuffer(samples);
  badRate.writeUInt32LE(44100, 24);
  assert.throws(() => wavToPcm(badRate), /16000/i);

  // Bits per sample != 16
  const badBits = createCanonicalWavBuffer(samples);
  badBits.writeUInt16LE(8, 34);
  assert.throws(() => wavToPcm(badBits), /16/i);

  // Missing data chunk tag
  const badData = createCanonicalWavBuffer(samples);
  badData.write("NOPE", 36);
  assert.throws(() => wavToPcm(badData), /data/i);
});

test("padTrailingSilence appends >= 25600 zero bytes for 800ms at 16000Hz", () => {
  const initial = Buffer.from([1, 2, 3, 4]);
  const padded = padTrailingSilence(initial, 800, 16000);
  const expectedAddedBytes = 16000 * 0.8 * 2; // 25600
  assert.ok(expectedAddedBytes >= 25600);
  assert.equal(padded.length, initial.length + expectedAddedBytes);
  assert.equal(padded.subarray(0, 4).toString("hex"), initial.toString("hex"));
  const added = padded.subarray(initial.length);
  for (let i = 0; i < added.length; i++) {
    assert.equal(added[i], 0);
  }
});

test("chunkToFrames yields ceil(byteLen/8192) frames zero-padded to whole 4096-sample frames", () => {
  const pcmLen = 20000; // ceil(20000/8192) = 3 frames
  const pcm = Buffer.alloc(pcmLen);
  for (let i = 0; i < pcmLen; i++) {
    pcm[i] = (i % 250) + 1;
  }

  const frames = chunkToFrames(pcm, 4096);
  assert.equal(frames.length, Math.ceil(20000 / 8192));
  assert.equal(frames[0].length, 8192);
  assert.equal(frames[1].length, 8192);
  assert.equal(frames[2].length, 8192);

  // Assert contents of frame 0 & 1 match original
  assert.deepEqual(frames[0], pcm.subarray(0, 8192));
  assert.deepEqual(frames[1], pcm.subarray(8192, 16384));

  // Frame 2: first 3616 bytes match original, rest are zero-padded
  const frame2Original = pcm.subarray(16384, 20000);
  assert.deepEqual(frames[2].subarray(0, 3616), frame2Original);
  for (let i = 3616; i < 8192; i++) {
    assert.equal(frames[2][i], 0);
  }
});

test("frameToBase64 round-trips through same Int16-LE -> base64 scheme as pcmToBase64", () => {
  const floatSamples = new Float32Array([0.0, 0.5, -0.5, 0.25, -0.75, 1.0, -1.0]);
  const expectedBase64 = pcmToBase64(floatSamples);

  const int16Buffer = Buffer.alloc(floatSamples.length * 2);
  for (let i = 0; i < floatSamples.length; i++) {
    let s = Math.max(-1, Math.min(1, floatSamples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    int16Buffer.writeInt16LE(s, i * 2);
  }

  const actualBase64 = frameToBase64(int16Buffer);
  assert.equal(actualBase64, expectedBase64);
});

test("renderUtteranceToWav builds PowerShell 5.1 script with pinned tokens and invokes injected spawn", async () => {
  let spawnCalls: { command: string; args: string[] }[] = [];
  const mockSpawn: RenderDeps["spawn"] = (command, args) => {
    spawnCalls.push({ command, args });
    return {
      on: (event: string, listener: (code: number) => void) => {
        if (event === "close") {
          listener(0);
        }
      },
    } as any;
  };

  await renderUtteranceToWav("Hello world", "C:/tmp/test.wav", { spawn: mockSpawn });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "powershell");
  const args = spawnCalls[0].args;
  assert.equal(args[0], "-NoProfile");
  assert.equal(args[1], "-NonInteractive");
  assert.equal(args[2], "-Command");

  const script = args[3];
  assert.ok(script.includes("Add-Type -AssemblyName System.Speech"), "missing Add-Type System.Speech");
  assert.ok(script.includes("SpeechSynthesizer"), "missing SpeechSynthesizer");
  assert.ok(script.includes("SetOutputToWaveFile"), "missing SetOutputToWaveFile");
  assert.ok(
    script.includes(
      "SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)"
    ),
    "missing SpeechAudioFormatInfo"
  );
  assert.ok(script.includes(".Speak("), "missing .Speak");
  assert.ok(script.includes(".Dispose()"), "missing .Dispose()");
});
