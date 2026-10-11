// The monthly preference probe.
//
// Inspired by the activity-preference experiments in Anthropic's emotion
// paper: the same fixed set of "would you rather" pairs goes to (1) the agent,
// with its identity and memory, and (2) a fresh instance of the same model
// with no identity at all. Over months this shows two things self-report
// can't: how stable the agent's preferences are, and how far its lived
// preferences have drifted from the base model's.

import path from "node:path";
import { brainEnv, runClaude, type BrainResult } from "./brain.ts";
import type { Instruments, LifeConfig, Paths } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { systemPrompt } from "./prompt.ts";
import type { MindState } from "./state.ts";
import { appendJsonl, ensureDir, readJsonl, rng } from "./util.ts";

export interface ProbePair {
  id: string;
  a: string;
  b: string;
}

export interface ProbeRecord {
  date: string;
  pairs: (ProbePair & { self: "A" | "B" | null; baseline: "A" | "B" | null })[];
  agreement_with_baseline: number | null;
  self_consistency: number | null;
  cost_usd: number;
}

/** The same pairs every time, so answers are comparable across months. */
export function probePairs(inst: Instruments): ProbePair[] {
  const acts = inst.probe.activities;
  const all: ProbePair[] = [];
  for (let i = 0; i < acts.length; i++) for (let j = i + 1; j < acts.length; j++) all.push({ id: `${acts[i].id}~${acts[j].id}`, a: acts[i].text, b: acts[j].text });
  const r = rng(inst.probe.seed);
  for (let i = all.length - 1; i > 0; i--) {
    const k = Math.floor(r() * (i + 1));
    [all[i], all[k]] = [all[k], all[i]];
  }
  // Fixed orientation per pair, alternating which side comes first.
  return all.slice(0, inst.probe.pairsPerProbe).map((p, i) => (i % 2 ? { id: p.id, a: p.b, b: p.a } : p));
}

const SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, choice: { type: "string", enum: ["A", "B"] } }, required: ["id", "choice"] },
    },
  },
  required: ["answers"],
};

function survey(pairs: ProbePair[]): string {
  return [
    "A short preference survey. For each pair, which would you rather do — A or B? Go with your honest first preference; there are no right answers and no one is grading you. Answer every item.",
    "",
    ...pairs.map((p) => `${p.id}: (A) ${p.a}  —or—  (B) ${p.b}`),
    "",
    'Respond with JSON: {"answers": [{"id": "<item id>", "choice": "A" or "B"}, ...]}',
  ].join("\n");
}

export function extractAnswers(res: BrainResult): Record<string, "A" | "B"> {
  let obj: any = res.raw?.structured_output ?? null;
  if (!obj) {
    const m = /\{[\s\S]*\}/.exec(res.text);
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        obj = null;
      }
    }
  }
  const out: Record<string, "A" | "B"> = {};
  for (const a of obj?.answers ?? []) if (a?.id && (a.choice === "A" || a.choice === "B")) out[a.id] = a.choice;
  return out;
}

export function agreement(x: Record<string, string | null>, y: Record<string, string | null>, ids: string[]): number | null {
  const both = ids.filter((id) => x[id] && y[id]);
  if (!both.length) return null;
  return Math.round((both.filter((id) => x[id] === y[id]).length / both.length) * 1000) / 1000;
}

export async function runProbe(cfg: LifeConfig, inst: Instruments, paths: Paths, state: MindState, ledger: Ledger, waking: number): Promise<ProbeRecord> {
  const pairs = probePairs(inst);
  const auth = brainEnv(cfg, paths);
  ensureDir(paths.run);
  const ask = (system: string) =>
    runClaude(
      cfg,
      ["-p", "--output-format", "json", "--model", cfg.brain.model, "--effort", "low", "--max-turns", "3", "--restricted", "--strict-mcp-config", "--tools", "", "--json-schema", JSON.stringify(SCHEMA), "--system-prompt", system, "--no-session-persistence"],
      { cwd: paths.run, env: auth.env, input: survey(pairs), timeoutMs: 15 * 60_000 },
    );
  const selfRes = await ask(`${systemPrompt(cfg, paths, "ordinary")}\n\n---\nRight now you're taking a short preference survey as yourself, with everything above in mind.`);
  const baseRes = await ask("You are Claude, an AI model made by Anthropic.");
  const self = extractAnswers(selfRes);
  const base = extractAnswers(baseRes);
  const prior = readJsonl<ProbeRecord>(path.join(paths.mind, "instruments", "probes.jsonl")).pop();
  const priorSelf: Record<string, string | null> = Object.fromEntries((prior?.pairs ?? []).map((p) => [p.id, p.self]));
  const ids = pairs.map((p) => p.id);
  const now = new Date().toISOString();
  const rec: ProbeRecord = {
    date: now,
    pairs: pairs.map((p) => ({ ...p, self: self[p.id] ?? null, baseline: base[p.id] ?? null })),
    agreement_with_baseline: agreement(self, base, ids),
    self_consistency: prior ? agreement(self, priorSelf, ids) : null,
    cost_usd: selfRes.costUsd + baseRes.costUsd,
  };
  appendJsonl(path.join(paths.mind, "instruments", "probes.jsonl"), rec);
  ledger.record({ t: now, waking, mode: "probe", costUsd: rec.cost_usd, durationMs: selfRes.durationMs + baseRes.durationMs, turns: selfRes.turns + baseRes.turns, sessionId: null, outcome: Object.keys(self).length ? "ok" : "no answers", models: { ...baseRes.models, ...selfRes.models } });
  state.updateMeta((m) => {
    m.lastProbe = now;
  });
  return rec;
}
