// src/memory/breadcrumbs.ts — Janus's decaying short-term working memory ("post-it notes").
import type { Breadcrumb } from "./types";

export class BreadcrumbRing {
  private items: Breadcrumb[] = [];
  constructor(private cfg: { breadcrumbMax: number; breadcrumbMaxAgeMs: number }) {}

  add(b: Breadcrumb): void {
    this.items.push(b);
    // Keep a bounded buffer (a few × breadcrumbMax) so recent() always has enough to pick from
    const hardCap = Math.max(this.cfg.breadcrumbMax * 4, 64);
    if (this.items.length > hardCap) this.items.splice(0, this.items.length - hardCap);
  }

  recent(now: number): Breadcrumb[] {
    const cutoff = now - this.cfg.breadcrumbMaxAgeMs;
    return this.items
      .filter(b => b.ts >= cutoff)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, this.cfg.breadcrumbMax);
  }
}
