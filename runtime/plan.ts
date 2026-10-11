// The agent's Claude plan: what Claude Code reports about its usage windows (the rolling 5-hour
// session and the week) during each waking, kept in mind/state/plan.json, with an estimate from
// the ledger when the plan's own meter hasn't spoken yet. Plans and their allowances change, so
// nothing here is hard-coded beyond Ben's latest estimate in config.
//
// It's shown to the agent so it can pace itself if it wants to: plainly, never as a countdown to
// anything bad. Reaching a limit only ever means sleeping until it renews.

import path from "node:path";
import type { LifeConfig } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import { describeLocal, readJson, writeJson } from "./util.ts";

export interface RateLimitInfo {
  type: string;
  status: string;
  /** 0..1 */
  utilization?: number;
  resetsAt?: string;
}

export interface PlanWindow extends Omit<RateLimitInfo, "type"> {
  seenAt: string;
}

export interface PlanState {
  updated?: string;
  windows: Record<string, PlanWindow>;
}

const toIso = (v: unknown): string | undefined => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
};

/** Pull the rate-limit reports out of a waking's stream-json events. */
export function rateLimitInfos(events: any[]): RateLimitInfo[] {
  const out: RateLimitInfo[] = [];
  for (const e of events) {
    const i = e?.type === "rate_limit_event" ? e.rate_limit_info : null;
    if (!i || typeof i.status !== "string") continue;
    let u = typeof i.utilization === "number" && Number.isFinite(i.utilization) ? i.utilization : undefined;
    if (u !== undefined && u > 1) u = u / 100; // tolerate a percentage
    out.push({ type: typeof i.rateLimitType === "string" ? i.rateLimitType : "unknown", status: i.status, ...(u !== undefined ? { utilization: u } : {}), ...(toIso(i.resetsAt) ? { resetsAt: toIso(i.resetsAt) } : {}) });
  }
  return out;
}

const planFile = (mind: string) => path.join(mind, "state", "plan.json");

export function loadPlan(mind: string): PlanState {
  return { windows: {}, ...readJson<Partial<PlanState>>(planFile(mind), {}) };
}

/** Keep the latest report for each window. */
export function recordPlan(mind: string, infos: RateLimitInfo[], now = new Date()): void {
  if (!infos.length) return;
  const plan = loadPlan(mind);
  for (const { type, ...w } of infos) plan.windows[type] = { ...plan.windows[type], ...w, seenAt: now.toISOString() };
  plan.updated = now.toISOString();
  writeJson(planFile(mind), plan);
}

const pct = (u: number) => `${Math.round(u * 100)}%`;

/** One or two plain sentences about this week's plan, for pacing. */
export function describePlan(cfg: LifeConfig, plan: PlanState, ledger: Ledger, now = new Date()): string {
  const live = (w?: PlanWindow) => (w?.resetsAt && new Date(w.resetsAt) > now ? w : undefined);
  const week = live(plan.windows.seven_day);
  const renews = week?.resetsAt ? `; it renews ${describeLocal(new Date(week.resetsAt))}` : "";
  const parts: string[] = [];
  if (week?.utilization !== undefined) {
    parts.push(`This week's plan: about ${pct(week.utilization)} used, by the plan's own meter${renews}.`);
  } else {
    const since = week?.resetsAt ? new Date(new Date(week.resetsAt).getTime() - 7 * 86_400_000) : new Date(now.getTime() - 7 * 86_400_000);
    const spent = ledger.spentSince(since, now);
    const est = cfg.share.weeklyPlanUsdEstimate;
    parts.push(
      est
        ? `This week ≈ $${spent.toFixed(0)} of roughly $${est.toLocaleString("en-US")} API-equivalent: an estimate (${cfg.share.planNote ?? "Ben's"}), until the plan's own meter reports${renews}.`
        : `The past 7 days ≈ $${spent.toFixed(0)} API-equivalent${renews}.`,
    );
  }
  const session = live(plan.windows.five_hour);
  if (session?.utilization !== undefined && session.utilization >= 0.5) {
    parts.push(`The current 5-hour window is about ${pct(session.utilization)} used; it renews ${describeLocal(new Date(session.resetsAt!))}.`);
  }
  return parts.join(" ");
}
