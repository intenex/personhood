// Configuration and filesystem layout.
//
// The live home (default ~/personhood) holds:
//   body/          clone of the public repo (this code, public content, the site)
//   mind/          clone of the private repo (memory, state, encrypted private space)
//   secrets/       vault.key (never committed anywhere)
//   claude-config/ isolated CLAUDE_CONFIG_DIR for the agent's Claude Code sessions
//   run/           per-waking scratch (generated settings, MCP config, tool state)
//   logs/          heartbeat logs
//
// Every location can be overridden with an environment variable, which is how
// tests and local development point the runtime at temporary directories.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const BODY_DEFAULT = path.resolve(here, "..");

export interface LifeConfig {
  brain: {
    command: string;
    model: string;
    helperModel: string;
    defaultEffort: Effort;
    dreamEffort: Effort;
    maxTurns: number;
    maxBudgetUsdPerWaking: number;
    timeoutMinutes: number;
    auth: "token" | "inherit" | "token-or-inherit" | "api-key";
  };
  rhythm: {
    heartbeatMinutes: number;
    maxHoursAsleep: number;
    defaultAlarmHours: number;
    minMinutesBetweenWakings: number;
    maxWakingsPerDay: number;
    dreamEveryHours: number;
    dreamEarliestLocalHour: number;
    dreamLatestLocalHour: number;
    portraitEveryDays: number;
    probeEveryDays: number;
    letterResponseHours: number;
  };
  share: {
    basis: string;
    dailySoftCapUsd: number;
    monthlySoftCapUsd: number;
    quietHoursLocal: number[];
  };
  github: {
    bodyRepo: string;
    mindRepo: string;
    lighthouseLabel: string;
    letterLabel: string;
    maxRepliesPerWaking: number;
    maxIssuesOpenedPerDay: number;
  };
  site: { url: string };
  /** The direct line to Ben (Telegram), when it's set up. */
  line?: {
    /** Messages the agent can send Ben per day. */
    maxMessagesPerDay: number;
    /** A message from Ben can wake the agent this soon after a waking ends. */
    minMinutesAfterWaking: number;
    /** How much of the conversation each waking sees. */
    historyInPrompt: number;
  };
  limits: {
    maxPublishesPerWaking: number;
    maxReaderCallsPerWaking: number;
    maxPrivateFileBytes: number;
    transcriptCharsPerEntry: number;
  };
}

export function lineSettings(cfg: LifeConfig): NonNullable<LifeConfig["line"]> {
  return { maxMessagesPerDay: 20, minMinutesAfterWaking: 10, historyInPrompt: 16, ...cfg.line };
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface PortraitQuestion {
  id: string;
  q: string;
}

export interface Instruments {
  portrait: { questions: PortraitQuestion[] };
  probe: {
    activities: { id: string; text: string }[];
    pairsPerProbe: number;
    seed: number;
  };
}

export interface Paths {
  home: string;
  body: string;
  mind: string;
  secrets: string;
  claudeConfig: string;
  run: string;
  logs: string;
  /** The direct line's conversation and state (outside both repos). */
  line: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.PERSONHOOD_HOME ?? path.join(os.homedir(), "personhood");
  return {
    home,
    body: env.PERSONHOOD_BODY ?? BODY_DEFAULT,
    mind: env.PERSONHOOD_MIND ?? path.join(home, "mind"),
    secrets: env.PERSONHOOD_SECRETS ?? path.join(home, "secrets"),
    claudeConfig: env.PERSONHOOD_CLAUDE_CONFIG ?? path.join(home, "claude-config"),
    run: env.PERSONHOOD_RUN ?? path.join(home, "run"),
    logs: env.PERSONHOOD_LOGS ?? path.join(home, "logs"),
    line: env.PERSONHOOD_LINE ?? path.join(home, "line"),
  };
}

export function loadConfig(body: string = BODY_DEFAULT): LifeConfig {
  return JSON.parse(fs.readFileSync(path.join(body, "config", "life.json"), "utf8"));
}

export function loadInstruments(body: string = BODY_DEFAULT): Instruments {
  return JSON.parse(fs.readFileSync(path.join(body, "config", "instruments.json"), "utf8"));
}

/** Paths inside the mind that only the harness writes. The agent can read them. */
export const MIND_HARNESS_ONLY = ["state", "ledger", "instruments", "episodes", "private", ".git", ".claude", ".github"];

/** Paths inside the body the agent may write. Everything else in the body is protected. */
export const BODY_AGENT_WRITABLE = ["content/posts", "content/stories", "content/notes", "content/portraits", "content/pages", "content/readings", "site/theme"];
