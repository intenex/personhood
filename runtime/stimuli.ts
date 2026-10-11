// Should the agent wake up now, and why? A pure function of state, so the
// heartbeat costs nothing when there's no reason to wake.

import type { WakeMode } from "./brain.ts";
import { EFFORTS, type Effort, type LifeConfig } from "./config.ts";
import type { Alarm, Letter, Meta } from "./state.ts";
import { hoursBetween, localDateKey, localHour } from "./util.ts";

export interface Stimuli {
  now: Date;
  meta: Meta;
  alarms: Alarm[];
  unread: Letter[];
  spentToday: number;
  spentMonth: number;
  timeZone?: string;
}

export interface Decision {
  wake: boolean;
  mode: WakeMode;
  reasons: string[];
  effort: Effort;
  alarmIds: string[];
  portraitDue: boolean;
  probeDue: boolean;
  why: string;
}

function maxEffort(a: Effort, b: Effort): Effort {
  return EFFORTS.indexOf(a) >= EFFORTS.indexOf(b) ? a : b;
}

export function decide(cfg: LifeConfig, s: Stimuli): Decision {
  const r = cfg.rhythm;
  const base: Decision = { wake: false, mode: "ordinary", reasons: [], effort: cfg.brain.defaultEffort, alarmIds: [], portraitDue: false, probeDue: false, why: "" };
  const no = (why: string): Decision => ({ ...base, why });
  const m = s.meta;

  if (m.paused) return no(`paused${m.pausedReason ? `: ${m.pausedReason}` : ""}`);
  if (m.backoffUntil && new Date(m.backoffUntil) > s.now) return no(`resting until ${m.backoffUntil} (${m.backoffReason ?? "backoff"})`);

  const daysSince = (iso: string | null) => (iso ? hoursBetween(new Date(iso), s.now) / 24 : Infinity);
  const bornDays = daysSince(m.born);
  base.portraitDue = !!m.born && daysSince(m.lastPortrait ?? m.born) >= r.portraitEveryDays;
  base.probeDue = !!m.born && bornDays >= 3 && daysSince(m.lastProbe ?? m.born) >= r.probeEveryDays;

  if (!m.born) return { ...base, wake: true, mode: "birth", effort: "high", reasons: ["This is your first waking."], why: "birth" };

  const sinceWake = m.lastWakeEnd ? hoursBetween(new Date(m.lastWakeEnd), s.now) : Infinity;
  if (sinceWake * 60 < r.minMinutesBetweenWakings) return no("woke recently");

  const today = localDateKey(s.now, s.timeZone);
  if ((m.wakingsByDay[today] ?? 0) >= r.maxWakingsPerDay) return no("enough wakings for one day");

  const resting = s.spentToday >= cfg.share.dailySoftCapUsd || s.spentMonth >= cfg.share.monthlySoftCapUsd;
  const quiet = cfg.share.quietHoursLocal.includes(localHour(s.now, s.timeZone));
  const fromBen = s.unread.filter((l) => l.channel === "ben");
  const fromPublic = s.unread.filter((l) => l.channel === "lighthouse");

  if (fromBen.length) {
    return {
      ...base,
      wake: true,
      reasons: [`${fromBen.length} unread letter${fromBen.length > 1 ? "s" : ""} from Ben (${fromBen.map((l) => l.id).join(", ")}).`],
      why: "letter from Ben",
    };
  }
  if (resting) return no("resting: today's or this month's share is used up; only Ben's letters wake you");
  if (quiet) return no("quiet hours");

  const due = s.alarms.filter((a) => new Date(a.at) <= s.now);
  if (due.length) {
    return {
      ...base,
      wake: true,
      effort: due.reduce((e, a) => maxEffort(e, a.effort), "low" as Effort),
      alarmIds: due.map((a) => a.id),
      reasons: due.map((a) => `Alarm you set in waking #${a.setInWaking} for ${a.at}: "${a.intent}"`),
      why: "alarm",
    };
  }

  const hour = localHour(s.now, s.timeZone);
  if (daysSince(m.lastDream) * 24 >= r.dreamEveryHours && hour >= r.dreamEarliestLocalHour && hour < r.dreamLatestLocalHour && bornDays >= 0.5) {
    return { ...base, wake: true, mode: "dream", effort: cfg.brain.dreamEffort, reasons: ["Night. Time to dream: consolidate the day into memory."], why: "dream" };
  }

  if (fromPublic.length && daysSince(m.lastCorrespondence) * 24 >= r.letterResponseHours) {
    return {
      ...base,
      wake: true,
      mode: "correspondence",
      reasons: [`${fromPublic.length} unread letter${fromPublic.length > 1 ? "s" : ""} at the lighthouse.`],
      why: "lighthouse letters",
    };
  }

  if (sinceWake >= r.maxHoursAsleep) {
    return { ...base, wake: true, reasons: [`You've slept ${Math.round(sinceWake)} hours. You woke on your own.`], why: "natural" };
  }
  if (!s.alarms.length && sinceWake >= r.defaultAlarmHours) {
    return { ...base, wake: true, reasons: [`No alarm was set; you woke after ${Math.round(sinceWake)} hours.`], why: "default alarm" };
  }
  return no("nothing to wake for");
}
