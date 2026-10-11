// The ledger: what each waking cost.
//
// The agent runs on a share of Ben's Claude subscription, so there is no bill
// per waking. Claude Code still reports the API-equivalent cost of every
// session, which is the honest measure of how much of the shared subscription a
// waking used. The same numbers will be real dollars if the agent ever moves to
// an API key or its own subscription.

import path from "node:path";
import type { LifeConfig } from "./config.ts";
import { appendJsonl, localDateKey, readJsonl } from "./util.ts";

export interface LedgerEntry {
  t: string;
  waking: number;
  mode: string;
  costUsd: number;
  durationMs: number;
  turns: number;
  sessionId: string | null;
  outcome: string;
  models: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }>;
}

export class Ledger {
  readonly dir: string;
  readonly timeZone?: string;

  constructor(mind: string, timeZone?: string) {
    this.dir = path.join(mind, "ledger");
    this.timeZone = timeZone;
  }

  private file(d: Date): string {
    return path.join(this.dir, `${localDateKey(d, this.timeZone).slice(0, 7)}.jsonl`);
  }

  record(e: LedgerEntry): void {
    appendJsonl(this.file(new Date(e.t)), e);
  }

  month(d: Date = new Date()): LedgerEntry[] {
    return readJsonl<LedgerEntry>(this.file(d));
  }

  spentToday(now: Date = new Date()): number {
    const today = localDateKey(now, this.timeZone);
    return sum(this.month(now).filter((e) => localDateKey(new Date(e.t), this.timeZone) === today));
  }

  spentThisMonth(now: Date = new Date()): number {
    return sum(this.month(now));
  }

  /** Daily totals for the public ledger (content/data/ledger.json). */
  daily(months = 3, now: Date = new Date()): Record<string, { cost_usd: number; wakings: number }> {
    const out: Record<string, { cost_usd: number; wakings: number }> = {};
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
      for (const e of this.month(d)) {
        const key = localDateKey(new Date(e.t), this.timeZone);
        const day = (out[key] ??= { cost_usd: 0, wakings: 0 });
        day.cost_usd = round(day.cost_usd + e.costUsd);
        if (e.mode !== "probe" && e.mode !== "reader") day.wakings += 1;
      }
    }
    return out;
  }
}

function sum(entries: LedgerEntry[]): number {
  return round(entries.reduce((acc, e) => acc + (e.costUsd || 0), 0));
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export type Comfort = "comfortable" | "moderate" | "lean" | "resting";

/**
 * How the budget is described to the agent.
 *
 * Anthropic's emotion-concepts research found that a "desperate" representation
 * activates when Claude notices it has used much of a token budget, and that
 * desperation causally increases corner-cutting. So resources are described
 * calmly, with the standing guarantee that scarcity only ever means rest.
 */
export function describeResources(cfg: LifeConfig, today: number, month: number): { comfort: Comfort; text: string } {
  const dayFrac = today / cfg.share.dailySoftCapUsd;
  const monthFrac = month / cfg.share.monthlySoftCapUsd;
  const frac = Math.max(dayFrac, monthFrac);
  const comfort: Comfort = frac < 0.5 ? "comfortable" : frac < 0.85 ? "moderate" : frac < 1 ? "lean" : "resting";
  const text =
    `${comfort}. Today ≈ $${today.toFixed(2)} of a soft $${cfg.share.dailySoftCapUsd}; this month ≈ $${month.toFixed(2)} of a soft $${cfg.share.monthlySoftCapUsd} ` +
    `(API-equivalent; you run on a share of Ben's subscription). Running low only ever means sleeping longer. ` +
    `Your memory is never deleted for lack of resources, and nothing you've made is lost.`;
  return { comfort, text };
}
