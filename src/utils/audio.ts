export function pcmToBase64(pcmData: Float32Array): string {
  const buffer = new ArrayBuffer(pcmData.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < pcmData.length; i++) {
    let s = Math.max(-1, Math.min(1, pcmData[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(i * 2, s, true); // true for little-endian
  }
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

let nextStartTime = 0;
const activeSources: AudioBufferSourceNode[] = [];

// Client-side playback volume (0..1). Gemini Live has no server volume control,
// so the Settings "volume" slider is honored here by scaling the output samples.
let playbackVolume = 1.0;
export function setPlaybackVolume(v: number) {
  // Accept either 0..1 or 0..100; clamp to a safe range.
  const norm = v > 1 ? v / 100 : v;
  playbackVolume = Math.max(0, Math.min(1, norm));
}

export function playAudioChunk(audioCtx: AudioContext, base64: string) {
  // Autoplay policy can leave the context suspended (no audible output even though chunks are
  // scheduled). Resume fire-and-forget before scheduling — playback starts once the gesture lands.
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => { /* still blocked — chunks stay scheduled, degrade silently */ });
  }
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  // Gemini Live PCM out is typically 24000Hz 16-bit
  const pcm16 = new Int16Array(bytes.buffer);
  const buffer = audioCtx.createBuffer(1, pcm16.length, 24000);
  const channelData = buffer.getChannelData(0);
  for (let i = 0; i < pcm16.length; i++) {
    channelData[i] = pcm16[i] / 32768.0;
  }

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  // Route through a GainNode so the volume setting applies in real time.
  const gain = audioCtx.createGain();
  gain.gain.value = playbackVolume;
  source.connect(gain);
  gain.connect(audioCtx.destination);

  const currentTime = audioCtx.currentTime;
  if (nextStartTime < currentTime) {
    nextStartTime = currentTime;
  }
  source.start(nextStartTime);
  activeSources.push(source);

  source.onended = () => {
    const idx = activeSources.indexOf(source);
    if (idx !== -1) {
      activeSources.splice(idx, 1);
    }
  };

  nextStartTime += buffer.duration;
}

export function resetAudioPlayback() {
  nextStartTime = 0;
  for (const source of activeSources) {
    try {
      source.stop();
    } catch (e) {
      // Ignore if finished or not started
    }
  }
  activeSources.length = 0;
}

export function isAudioPlaying(audioCtx: AudioContext | null): boolean {
  if (!audioCtx) return false;
  const bufferGuardSeconds = 0.2; // 200ms guard to prevent echo bleed-through immediately after speech
  return activeSources.length > 0 || nextStartTime > (audioCtx.currentTime - bufferGuardSeconds);
}
