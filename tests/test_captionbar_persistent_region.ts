// tests/test_captionbar_persistent_region.ts
//
// bead 8fz.3 — round-2 aria-live fix. The caption-janus live region must mount PERSISTENTLY once
// the radio is live + captions are on, rendered EMPTY before the first Janus line arrives, so a
// screen reader announces the FIRST utterance (an already-populated live region is NOT announced by
// some screen readers). The !live / !captionsOn early-return-null is preserved.
//
// Rendered with react-dom/server's renderToStaticMarkup (no jsdom needed) via React.createElement so
// the file stays a plain .ts the `tsx --test` runner picks up (tests/*.ts, no JSX transform).
//
// Runner: npx tsx --test --test-force-exit tests/test_captionbar_persistent_region.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CaptionBar } from "../src/orbital/CaptionBar";
import type { TranscriptEntry } from "../src/orbital/useOrbitalData";

function render(props: { transcript: TranscriptEntry[]; live: boolean; captionsOn: boolean; dark: boolean }): string {
  return renderToStaticMarkup(createElement(CaptionBar, props));
}

function janus(text: string, fromToast = false): TranscriptEntry {
  return { sender: "Janus", text, timestamp: new Date(), ...(fromToast ? { fromToast: true } : {}) };
}
function user(text: string): TranscriptEntry {
  return { sender: "User", text, timestamp: new Date() };
}

describe("CaptionBar — persistent aria-live region (round-2 fix)", () => {
  it("mounts the caption-janus polite live region EMPTY when live+captionsOn with no transcript yet", () => {
    const html = render({ transcript: [], live: true, captionsOn: true, dark: false });
    assert.match(html, /data-testid="caption-janus"/, "the live region must mount BEFORE any Janus line");
    assert.match(html, /aria-live="polite"/, "the empty region is polite so the FIRST utterance is announced");
  });

  it("still returns nothing when the radio is not live (early-return-null preserved)", () => {
    assert.equal(render({ transcript: [janus("hi")], live: false, captionsOn: true, dark: false }), "");
  });

  it("still returns nothing when captions are toggled off (early-return-null preserved)", () => {
    assert.equal(render({ transcript: [janus("hi")], live: true, captionsOn: false, dark: false }), "");
  });

  it("renders the latest Janus line into the persistent region, aria-live polite", () => {
    const html = render({ transcript: [user("copy"), janus("order up")], live: true, captionsOn: true, dark: false });
    assert.match(html, /data-testid="caption-janus"[^>]*aria-live="polite"[^>]*>order up</, "the genuine Janus line announces");
  });

  it("a toast-minted latest Janus line sets aria-live off (double-announce guard intact)", () => {
    const html = render({ transcript: [janus("Back on the air.", true)], live: true, captionsOn: true, dark: false });
    assert.match(html, /data-testid="caption-janus"[^>]*aria-live="off"/, "a toast line must NOT re-announce");
  });
});
