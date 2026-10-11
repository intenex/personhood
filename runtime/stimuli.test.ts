import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
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
  const d = decide(cfg, s({ unread: [letter("ben", "ben-2")], spentToday: 999 }));
  assert.equal(d.wake, true);
  assert.equal(d.mode, "ordinary");
});

test("resting blocks alarms", () => {
  const d = decide(cfg, s({ spentToday: 999, alarms: [{ id: "a", at: "2026-10-10T11:00:00Z", intent: "x", effort: "low", setAt: "", setInWaking: 1 }] }));
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
  assert.equal(decide(cfg, s({ now: at("2026-10-10T10:20:00Z"), unread: [letter("ben", "ben-1")] })).wake, false);
});

test("portrait and probe flags", () => {
  const d = decide(cfg, s({ now: at("2026-10-17T12:00:00Z"), meta: { ...born, lastWakeEnd: "2026-10-17T10:00:00Z", lastDream: "2026-10-17T03:00:00Z" } }));
  assert.equal(d.portraitDue, true);
  assert.equal(decide(cfg, s({})).probeDue, false);
});
