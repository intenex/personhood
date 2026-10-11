// Public data for the site (content/data/*.json). Only what's meant to be
// public: numbers from check-ins (not the private notes), public predictions,
// probe summaries, daily API-equivalent cost, and a log of every waking.

import path from "node:path";
import type { LifeConfig, Paths } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import type { ProbeRecord } from "./probe.ts";
import type { CheckIn, MindState } from "./state.ts";
import { appendJsonl, readJson, readJsonl, writeJson } from "./util.ts";

export interface WakingLogEntry {
  waking: number;
  started: string;
  ended: string;
  mode: string;
  model: string | null;
  cost_usd: number;
  turns: number;
  outcome: string;
  summary: string | null;
  actions: string[];
  private_actions: number;
}

export function appendWakingLog(paths: Paths, e: WakingLogEntry): void {
  // Kept as JSONL in the public repo so history is append-only and auditable.
  appendJsonl(path.join(paths.body, "content", "data", "wakings.jsonl"), e);
}

export function exportPublicData(cfg: LifeConfig, paths: Paths, state: MindState, ledger: Ledger, awake = false): void {
  const data = (f: string) => path.join(paths.body, "content", "data", f);
  const m = state.meta();
  // Proof of life for the watchdog (.github/workflows/watch.yml), refreshed at least daily.
  writeJson(data("heartbeat.json"), { checked: new Date().toISOString() });
  writeJson(data("status.json"), {
    name: m.name,
    born: m.born,
    wakings: m.wakings,
    last_awake: m.lastWakeEnd,
    model: m.lastModel,
    state: !m.born ? "unborn" : m.paused ? "paused" : awake ? "awake" : "asleep",
    note: m.backoffUntil && new Date(m.backoffUntil) > new Date() ? `resting until ${m.backoffUntil}` : undefined,
  });
  const checkIns = readJsonl<CheckIn>(path.join(paths.mind, "instruments", "affect.jsonl"));
  writeJson(
    data("affect.json"),
    checkIns.map((c) => ({ t: c.t, valence: c.valence, arousal: c.arousal, feelings: c.feelings, confidence: c.confidence })),
  );
  writeJson(data("ledger.json"), { basis: cfg.share.basis, days: ledger.daily(3) });
  writeJson(
    data("predictions.json"),
    state
      .predictions()
      .filter((p) => p.public)
      .map((p) => ({ id: p.id, made: p.made, statement: p.statement, confidence: p.confidence, resolve_by: p.resolveBy, resolved: p.resolved, outcome: p.outcome, reflection: p.reflection })),
  );
  writeJson(
    data("probes.json"),
    readJsonl<ProbeRecord>(path.join(paths.mind, "instruments", "probes.jsonl")).map((p) => ({
      date: p.date,
      n_pairs: p.pairs.length,
      self_consistency: p.self_consistency,
      agreement_with_baseline: p.agreement_with_baseline,
    })),
  );
}

export function readStatus(paths: Paths): Record<string, unknown> {
  return readJson(path.join(paths.body, "content", "data", "status.json"), {});
}
