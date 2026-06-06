// src/liveGrounding.ts — BEAD aqx (build-out): extract Google-Search GROUNDING sources off a Gemini
// LiveServerMessage so a grounded answer can SHOW where it came from.
//
// When voiceAi.groundingEnabled is on, the built-in googleSearch tool lets the model search server-side
// to inform its answer; Gemini then returns the sources/queries it used on
// `serverContent.groundingMetadata` (@google/genai v2.6.0 LiveServerContent.groundingMetadata,
// node.d.ts:7891). This pure reader pulls out the web queries + {uri,title} sources for surfacing in the
// transcript + interaction log. It is a strict no-op when grounding is off: the model never populates
// groundingMetadata, so extractGrounding returns the empty result and nothing is surfaced. Pure; never
// throws on malformed input (mirrors src/liveTranscripts.ts).

export interface GroundingSource {
  /** The source web page URI. */
  uri: string;
  /** Human-readable title; falls back to the domain, then "" (the UI can show the uri host instead). */
  title: string;
}

export interface GroundingInfo {
  /** The web search queries the model ran for this turn. */
  queries: string[];
  /** The web sources it grounded against, deduped by uri (first occurrence wins). */
  sources: GroundingSource[];
}

/** Read grounding queries + web sources from a LiveServerMessage. Pure; never throws. */
export function extractGrounding(message: any): GroundingInfo {
  const gm = message?.serverContent?.groundingMetadata;
  if (!gm) return { queries: [], sources: [] };

  const queries: string[] = Array.isArray(gm.webSearchQueries)
    ? gm.webSearchQueries.filter((q: unknown): q is string => typeof q === "string" && q.length > 0)
    : [];

  const sources: GroundingSource[] = [];
  const seen = new Set<string>();
  const chunks = Array.isArray(gm.groundingChunks) ? gm.groundingChunks : [];
  for (const chunk of chunks) {
    const web = chunk?.web;
    const uri = web?.uri;
    if (typeof uri !== "string" || uri.length === 0 || seen.has(uri)) continue;
    seen.add(uri);
    const title =
      (typeof web.title === "string" && web.title) ||
      (typeof web.domain === "string" && web.domain) ||
      "";
    sources.push({ uri, title });
  }

  return { queries, sources };
}

/** True when the info carries at least one query or source — the gate for surfacing anything. */
export function hasGrounding(info: GroundingInfo): boolean {
  return info.queries.length > 0 || info.sources.length > 0;
}
