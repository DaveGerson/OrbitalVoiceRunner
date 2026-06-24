/**
 * Vitest jsdom setup (bead dbt4, PR-B) — runs once before each component test file.
 *
 * jsdom implements the DOM but NOT the browser-platform APIs the app's component tree reaches
 * for. This file shims ONLY what the App.tsx render tree actually touches (scanned, not
 * speculative). IntersectionObserver is intentionally absent — nothing under src/ uses it.
 *
 * It also registers the @testing-library/jest-dom matchers (toBeInTheDocument, toBeDisabled,
 * toHaveTextContent, ...) on vitest's `expect`.
 */
import '@testing-library/jest-dom/vitest';

// --- Web Audio: the voice layer constructs an AudioContext on mount. Stub the class so
// `new AudioContext()` / `new webkitAudioContext()` doesn't throw under jsdom. ---
class StubAudioContext {
  state = 'running';
  destination = {};
  close() {
    return Promise.resolve();
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
  createGain() {
    return {gain: {value: 1}, connect() {}, disconnect() {}};
  }
  createAnalyser() {
    return {connect() {}, disconnect() {}, getByteFrequencyData() {}};
  }
}
const win = globalThis as unknown as Record<string, unknown>;
win.AudioContext = StubAudioContext;
win.webkitAudioContext = StubAudioContext;

// --- Notification: status surfacing checks Notification.permission and may construct one. ---
class StubNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission() {
    return Promise.resolve('granted' as NotificationPermission);
  }
}
win.Notification = StubNotification;

// --- navigator.clipboard.writeText: copy-to-clipboard affordances. ---
if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {writeText: () => Promise.resolve()},
  });
}

// --- window.matchMedia: framer-motion / 'motion' reads it (prefers-reduced-motion). jsdom
// has no implementation, so motion would throw on mount without this. ---
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// --- window.scrollTo: jsdom logs "Not implemented" otherwise. ---
window.scrollTo = () => {};

// --- requestAnimationFrame / cancelAnimationFrame: the hold-to-fire ring drives a rAF loop.
// jsdom's stock rAF can be flaky under fake timers; pin a deterministic timeout-based impl. ---
win.requestAnimationFrame = (cb: FrameRequestCallback): number =>
  setTimeout(() => cb(performance.now()), 16) as unknown as number;
win.cancelAnimationFrame = (id: number): void => clearTimeout(id);
