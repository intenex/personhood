// Harness-owned state in the mind repo (mind/state, mind/instruments).
// The agent reads these through its file tools and changes them only through
// life tools, which validate every change.

import crypto from "node:crypto";
import path from "node:path";
import type { Effort } from "./config.ts";
import { readJson, writeJson } from "./util.ts";

export interface Meta {
  born: string | null;
  name: string | null;
  wakings: number;
  lastWakeStart: string | null;
  lastWakeEnd: string | null;
  lastModel: string | null;
  lastDream: string | null;
  lastPortrait: string | null;
  lastProbe: string | null;
  lastCorrespondence: string | null;
  backoffUntil: string | null;
  backoffReason: string | null;
  paused: boolean;
  pausedReason: string | null;
  wakingsByDay: Record<string, number>;
}

export const EMPTY_META: Meta = {
  born: null,
  name: null,
  wakings: 0,
  lastWakeStart: null,
  lastWakeEnd: null,
  lastModel: null,
  lastDream: null,
  lastPortrait: null,
  lastProbe: null,
  lastCorrespondence: null,
  backoffUntil: null,
  backoffReason: null,
  paused: false,
  pausedReason: null,
  wakingsByDay: {},
};

export interface Alarm {
  id: string;
  at: string;
  intent: string;
  effort: Effort;
  setAt: string;
  setInWaking: number;
}

export interface Letter {
  id: string;
  channel: "ben" | "lighthouse";
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  state: "open" | "closed";
  labels: string[];
  /** Latest body or comment written by someone other than the agent. */
  lastActivityAt: string;
  lastReadAt: string | null;
  lastAgentReplyAt: string | null;
  triage?: "spam" | "ok";
}

export interface Prediction {
  id: string;
  made: string;
  waking: number;
  statement: string;
  confidence: number;
  resolveBy: string;
  public: boolean;
  resolved?: string;
  outcome?: boolean | null;
  reflection?: string;
}

export interface CheckIn {
  t: string;
  waking: number;
  valence: number;
  arousal: number;
  feelings: string[];
  drivers: string;
  confidence: number;
  note?: string;
}

export class MindState {
  readonly mind: string;

  constructor(mind: string) {
    this.mind = mind;
  }

  private p(...parts: string[]): string {
    return path.join(this.mind, ...parts);
  }

  meta(): Meta {
    return { ...EMPTY_META, ...readJson<Partial<Meta>>(this.p("state", "meta.json"), {}) };
  }

  saveMeta(meta: Meta): void {
    // Keep two weeks of per-day counts; older days are in the ledger.
    const days = Object.keys(meta.wakingsByDay).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 14))) delete meta.wakingsByDay[d];
    writeJson(this.p("state", "meta.json"), meta);
  }

  updateMeta(fn: (m: Meta) => void): Meta {
    const m = this.meta();
    fn(m);
    this.saveMeta(m);
    return m;
  }

  alarms(): Alarm[] {
    return readJson<Alarm[]>(this.p("state", "alarms.json"), []).sort((a, b) => a.at.localeCompare(b.at));
  }

  saveAlarms(alarms: Alarm[]): void {
    writeJson(this.p("state", "alarms.json"), alarms.sort((a, b) => a.at.localeCompare(b.at)));
  }

  addAlarm(a: Omit<Alarm, "id">): Alarm {
    const alarm: Alarm = { id: shortId(), ...a };
    this.saveAlarms([...this.alarms(), alarm]);
    return alarm;
  }

  removeAlarms(ids: string[]): void {
    const drop = new Set(ids);
    this.saveAlarms(this.alarms().filter((a) => !drop.has(a.id)));
  }

  letters(): Letter[] {
    return readJson<Letter[]>(this.p("state", "letters.json"), []);
  }

  saveLetters(letters: Letter[]): void {
    writeJson(this.p("state", "letters.json"), letters);
  }

  predictions(): Prediction[] {
    return readJson<Prediction[]>(this.p("instruments", "predictions.json"), []);
  }

  savePredictions(preds: Prediction[]): void {
    writeJson(this.p("instruments", "predictions.json"), preds);
  }
}

export function isUnread(l: Letter): boolean {
  if (l.triage === "spam") return false;
  return !l.lastReadAt || l.lastActivityAt > l.lastReadAt;
}

export function shortId(): string {
  return crypto.randomBytes(4).toString("hex");
}
