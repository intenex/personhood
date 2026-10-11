import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
import { describeResources, Ledger } from "./ledger.ts";
import { describePlan, loadPlan, rateLimitInfos, recordPlan } from "./plan.ts";
import { REPO, tmp } from "./test/helpers.ts";

const cfg = loadConfig(REPO);
const now = new Date("2026-10-15T12:00:00Z");
const inDays = (d: number) => Math.floor(now.getTime() / 1000 + d * 86400);

test("rate-limit reports are read from the stream, whatever the units", () => {
  const infos = rateLimitInfos([
    { type: "system" },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.4, resetsAt: inDays(3) } },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 80, resetsAt: inDays(0.1) } },
    { type: "rate_limit_event", rate_limit_info: { nonsense: true } },
  ]);
  assert.equal(infos.length, 2);
  assert.equal(infos[0].utilization, 0.4);
  assert.equal(infos[1].utilization, 0.8);
  assert.equal(infos[0].resetsAt, new Date(inDays(3) * 1000).toISOString());
});

test("the plan's own meter, when it has reported, says how much of the week is used and when it renews", () => {
  const mind = tmp();
  recordPlan(mind, rateLimitInfos([{ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.4, resetsAt: inDays(3) } }]), now);
  recordPlan(mind, rateLimitInfos([{ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.7, resetsAt: inDays(0.1) } }]), now);
  const plan = loadPlan(mind);
  assert.deepEqual(Object.keys(plan.windows).sort(), ["five_hour", "seven_day"]);
  const text = describePlan(cfg, plan, new Ledger(mind), now);
  assert.match(text, /about 40% used, by the plan's own meter; it renews/);
  assert.match(text, /5-hour window is about 70% used/);
});

test("before the meter reports, an estimate from the ledger against Ben's figure", () => {
  const mind = tmp();
  const ledger = new Ledger(mind);
  for (const [t, cost] of [["2026-09-30T23:00:00Z", 100], ["2026-10-10T10:00:00Z", 150], ["2026-10-14T10:00:00Z", 50]] as const) {
    ledger.record({ t, waking: 1, mode: "ordinary", costUsd: cost, durationMs: 1, turns: 1, sessionId: null, outcome: "slept", models: {} });
  }
  assert.equal(ledger.spentSince(new Date("2026-09-30T00:00:00Z"), now), 300, "across month files");
  const text = describePlan(cfg, loadPlan(mind), ledger, now);
  assert.match(text, /This week ≈ \$200 of roughly \$1,200 API-equivalent: an estimate/);
  // An expired report doesn't count.
  recordPlan(mind, [{ type: "seven_day", status: "allowed", utilization: 0.9, resetsAt: "2026-10-01T00:00:00Z" }], now);
  assert.doesNotMatch(describePlan(cfg, loadPlan(mind), ledger, now), /90%/);
});

test("the waking's resources line stays calm: abundance first, the plan as information", () => {
  const { text } = describeResources(cfg, 30, 400, "This week's plan: about 85% used, by the plan's own meter; it renews Tuesday.");
  assert.match(text, /^abundant\. Your Claude plan is yours to use freely/);
  assert.match(text, /85% used/);
  assert.match(text, /reaching one only means sleeping until it does/);
  assert.doesNotMatch(text, /running low|hurry|only \d+% left/i);
});
