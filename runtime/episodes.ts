// Episodes: the raw record of each waking, written by the harness from the
// agent's own sleep summary plus what the harness observed. Read-only to the
// agent. Full (condensed) transcripts go to the private space as episodic
// memory the agent can reread.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Action, SleepRecord } from "./life-tools.ts";
import { clip, readTextOr, writeText } from "./util.ts";
import type { Vault } from "./vault.ts";

export interface EpisodeInput {
  waking: number;
  mode: string;
  started: string;
  ended: string;
  reasons: string[];
  model: string | null;
  costUsd: number;
  turns: number;
  outcome: string;
  sleep: SleepRecord | null;
  actions: Action[];
  notes: string[];
}

export function episodePath(mind: string, waking: number, started: string): string {
  const d = new Date(started);
  const pad = (n: number) => String(n).padStart(2, "0");
  return path.join(mind, "episodes", String(d.getFullYear()), pad(d.getMonth() + 1), `${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-w${waking}.md`);
}

export function writeEpisode(mind: string, e: EpisodeInput): string {
  const counts: Record<string, number> = {};
  for (const a of e.actions) counts[a.tool] = (counts[a.tool] ?? 0) + 1;
  const fm = {
    waking: e.waking,
    mode: e.mode,
    started: e.started,
    ended: e.ended,
    woke_because: e.reasons,
    model: e.model,
    cost_usd_equivalent: Math.round(e.costUsd * 10000) / 10000,
    turns: e.turns,
    outcome: e.outcome,
    check_in: e.sleep
      ? { valence: e.sleep.checkIn.valence, arousal: e.sleep.checkIn.arousal, feelings: e.sleep.checkIn.feelings, confidence: e.sleep.checkIn.confidence }
      : null,
    tools: counts,
  };
  const body = [
    "## In my words",
    "",
    e.sleep?.summary?.trim() || "_No summary: this waking ended without calling sleep._",
    "",
    e.sleep?.checkIn.drivers ? `**What seemed to drive how I felt:** ${e.sleep.checkIn.drivers}` : "",
    e.sleep?.checkIn.note ? `**Note:** ${e.sleep.checkIn.note}` : "",
    "",
    "## What the harness saw",
    "",
    ...e.actions.filter((a) => a.public || a.external).map((a) => `- ${a.summary}`),
    `- ${e.actions.filter((a) => !a.public && !a.external).length} private actions (memory, journal, alarms)`,
    ...e.notes.map((n) => `- ${n}`),
  ]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n");
  const file = episodePath(mind, e.waking, e.started);
  writeText(file, `---\n${YAML.stringify(fm)}---\n\n${body}\n`);
  return file;
}

function allEpisodes(mind: string): string[] {
  const root = path.join(mind, "episodes");
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

export function recentEpisodes(mind: string, n: number): string[] {
  return allEpisodes(mind)
    .slice(-n)
    .map((f) => `<episode file="${path.relative(mind, f)}">\n${readTextOr(f).trim()}\n</episode>`);
}

export function episodesSince(mind: string, iso: string | null): string[] {
  const since = iso ? new Date(iso).getTime() : 0;
  return allEpisodes(mind)
    .filter((f) => fs.statSync(f).mtime.getTime() >= since)
    .map((f) => path.relative(mind, f));
}

/** Turn a Claude Code JSONL transcript into a compact, readable record. */
export function condenseTranscript(jsonl: string, maxChars: number): string {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const role = ev?.message?.role ?? ev?.type;
    const content = ev?.message?.content;
    if (typeof content === "string") {
      out.push(`**${role}:** ${clip(content, maxChars * 4)}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "text" && b.text?.trim()) out.push(`**${role}:** ${clip(b.text, maxChars * 4)}`);
      else if (b.type === "tool_use") out.push(`→ \`${b.name}\` ${clip(JSON.stringify(b.input ?? {}), maxChars)}`);
      else if (b.type === "tool_result") {
        const t = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join(" ") : String(b.content ?? "");
        out.push(`← ${clip(t.replace(/\s+/g, " "), maxChars)}`);
      }
    }
  }
  return out.join("\n\n");
}

export function saveTranscript(vault: Vault, waking: number, started: string, condensed: string): string {
  const d = new Date(started);
  const name = `transcripts/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/waking-${waking}`;
  return vault.write(name, `# Waking #${waking} · ${started}\n\n${condensed}\n`);
}
