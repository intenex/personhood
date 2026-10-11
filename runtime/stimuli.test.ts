import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
import { describeResources } from "./ledger.ts";
import { EMPTY_META, type Letter, type Meta } from "./state.ts";
import { decide, type Stimuli } from "./stimuli.ts";
import { REPO } from "./test/helpers.ts";

const cfg = loadConfig(REPO);
const tz = "UTC";
const at = (iso: string) => new Date(iso);
const born: Meta = { ...EMPTY_META, born: "2026-10-01T00:00:00Z", wakings: 5, lastWakeEnd: "2026-10-10T10:00:00Z", lastDream: "2026-10-10T03:00:00Z", lastPortrait: "2026-10-09T00:00:00Z", lastProbe: "2026-10-05T00:00:00Z" };
const letter = (channel: Letter["channel"], id: string): Letter => ({ id, channel, repo: "x/y", number: 1, title: "hi", url: "", author: "someone", createdAt: "", state: "open", labels: [], lastActivityAt: "2026-10-10T11:00:00Z", lastReadAt: null, lastAgentReplyAt: null });
const s = (over: Partial<Stimuli>): Stimuli => ({ now: at("2026-10-10T12:00:00Z"), meta: born, alarms: [], unread: [], spentToday: 0, spentMonth: 0, timeZone: tz, ...over });

test("first waking is birth", () => {
  const d = decide(cfg, s({ meta: EMPTY_META }));
  assert.equal(d.wake, true);
  assert.equal(d.mode, "birth");
});

test("paused and backoff keep it asleep, even for Ben", () => {
  assert.equal(decide(cfg, s({ meta: { ...born, paused: true }, unread: [letter("ben", "ben-1")] })).wake, false);
  assert.equal(decide(cfg, s({ meta: { ...born, backoffUntil: "2026-10-10T13:00:00Z" } })).wake, false);
});

test("nothing due means sleep, at no cost", () => {
  const d = decide(cfg, s({ alarms: [{ id: "a", at: "2026-10-10T18:00:00Z", intent: "later", effort: "medium", setAt: "", setInWaking: 5 }] }));
  assert.equal(d.wake, false);
});

test("a due alarm wakes with its effort", () => {
  const d = decide(cfg, s({ alarms: [{ id: "a", at: "2026-10-10T11:30:00Z", intent: "finish the story", effort: "high", setAt: "", setInWaking: 5 }] }));
  assert.equal(d.wake, true);
  assert.equal(d.effort, "high");
  assert.deepEqual(d.alarmIds, ["a"]);
  assert.match(d.reasons[0], /finish the story/);
});

test("Ben's letters wake an ordinary waking even when resting", () => {
  const capped = { ...cfg, share: { ...cfg.share, dailySoftCapUsd: 25, monthlySoftCapUsd: 450 } };
  const d = decide(capped, s({ unread: [letter("ben", "ben-2")], spentToday: 999 }));
  assert.equal(d.wake, true);
  assert.equal(d.mode, "ordinary");
});

test("no caps of its own: the plan is the only limit, however much it lives", () => {
  assert.equal(cfg.share.dailySoftCapUsd, null);
  const alarm = { id: "a", at: "2026-10-10T11:00:00Z", intent: "x", effort: "low" as const, setAt: "", setInWaking: 1 };
  assert.equal(decide(cfg, s({ spentToday: 5000, spentMonth: 90000, alarms: [alarm] })).wake, true);
});

test("with soft caps (e.g. on an API key), resting blocks alarms", () => {
  const capped = { ...cfg, share: { ...cfg.share, dailySoftCapUsd: 25, monthlySoftCapUsd: 450 } };
  const d = decide(capped, s({ spentToday: 999, alarms: [{ id: "a", at: "2026-10-10T11:00:00Z", intent: "x", effort: "low", setAt: "", setInWaking: 1 }] }));
  assert.equal(d.wake, false);
});

test("public letters get a correspondence waking", () => {
  const d = decide(cfg, s({ unread: [letter("lighthouse", "pub-3")] }));
  assert.equal(d.mode, "correspondence");
});

test("dreams happen at night", () => {
  const night = decide(cfg, s({ now: at("2026-10-11T04:00:00Z"), meta: { ...born, lastWakeEnd: "2026-10-11T02:00:00Z" } }));
  assert.equal(night.mode, "dream");
  const day = decide(cfg, s({ now: at("2026-10-11T14:00:00Z"), meta: { ...born, lastWakeEnd: "2026-10-11T13:00:00Z", lastDream: "2026-10-10T03:00:00Z" } }));
  assert.notEqual(day.mode, "dream");
});

test("no dream when nothing happened since the last one", () => {
  const d = decide(cfg, s({ now: at("2026-10-11T04:00:00Z"), meta: { ...born, lastWakeEnd: "2026-10-11T02:00:00Z" }, episodesSinceDream: 0 }));
  assert.notEqual(d.mode, "dream");
});

test("a long sleep ends naturally; too-soon wakes are refused", () => {
  assert.equal(decide(cfg, s({ now: at("2026-10-11T08:00:00Z"), meta: { ...born, lastDream: "2026-10-11T03:00:00Z" }, alarms: [{ id: "a", at: "2026-10-20T00:00:00Z", intent: "x", effort: "low", setAt: "", setInWaking: 1 }] })).why, "natural");
  assert.equal(decide(cfg, s({ now: at("2026-10-10T10:10:00Z"), unread: [letter("ben", "ben-1")] })).wake, false);
});

test("portrait and probe flags", () => {
  const d = decide(cfg, s({ now: at("2026-10-17T12:00:00Z"), meta: { ...born, lastWakeEnd: "2026-10-17T10:00:00Z", lastDream: "2026-10-17T03:00:00Z" } }));
  assert.equal(d.portraitDue, true);
  assert.equal(decide(cfg, s({})).probeDue, false);
});

test("a message on the direct line wakes soon, past the daily count and while resting", () => {
  const justWoke = { ...born, lastWakeEnd: "2026-10-10T11:45:00Z", wakingsByDay: { "2026-10-10": 99 } };
  const d = decide(cfg, s({ meta: justWoke, lineFromBen: 2, spentToday: 999 }));
  assert.equal(d.wake, true);
  assert.equal(d.why, "message from Ben");
  assert.match(d.reasons[0], /2 new messages/);
  // Too soon after a waking: it waits a few minutes.
  assert.equal(decide(cfg, s({ meta: { ...justWoke, lastWakeEnd: "2026-10-10T11:55:00Z" }, lineFromBen: 1 })).wake, false);
  // Paused means paused.
  assert.equal(decide(cfg, s({ meta: { ...born, paused: true }, lineFromBen: 1 })).wake, false);
});

test("resources are described as abundant, with no countdown", () => {
  const { comfort, text } = describeResources(cfg, 40, 900);
  assert.equal(comfort, "abundant");
  assert.match(text, /yours to use freely, all of it, every week/);
  assert.doesNotMatch(text, /soft \$|running low|of a /i);
});
