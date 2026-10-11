// The brain: a headless Claude Code session per waking.
//
// Each waking runs `claude -p` on the agent's own subscription token, with:
//   - an isolated CLAUDE_CONFIG_DIR (none of Ben's settings, plugins, hooks,
//     MCP servers, or memory leak in, and Ben's own login is never touched),
//   - --restricted (no shell or code execution; ambient settings ignored),
//   - only the built-in tools it needs, plus the life tools over MCP,
//   - permission rules that allow writes only where the agent is meant to write.
// The harness never trusts those rules alone: guard.ts checks afterwards.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BODY_AGENT_WRITABLE, type Effort, type LifeConfig, MIND_HARNESS_ONLY, type Paths } from "./config.ts";
import { ensureDir, writeJson } from "./util.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export type WakeMode = "birth" | "ordinary" | "dream" | "correspondence";

/**
 * Built-in tools per mode. Correspondence wakings read letters from strangers,
 * which may carry injected instructions, so they get no web access (nothing to
 * exfiltrate through) and no subagents (which would have web access).
 */
export function builtinTools(mode: WakeMode): string[] {
  const files = ["Read", "Write", "Edit", "Glob", "Grep"];
  return mode === "correspondence" ? files : [...files, "WebSearch", "WebFetch", "Agent"];
}

export interface BrainResult {
  ok: boolean;
  subtype: string;
  text: string;
  costUsd: number;
  durationMs: number;
  turns: number;
  sessionId: string | null;
  models: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }>;
  primaryModel: string | null;
  limitResetAt: string | null;
  stderr: string;
  exitCode: number | null;
  /** The final result event, for fields like structured_output. */
  raw: any;
}

export interface AuthInfo {
  mode: "token" | "api-key" | "inherit";
  env: NodeJS.ProcessEnv;
}

/** Drop anything inherited from a parent Claude session or Ben's own setup. */
export function cleanEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(CLAUDE|ANTHROPIC)/.test(k) && !k.startsWith("PERSONHOOD")) continue;
    env[k] = v;
  }
  return env;
}

/** Work out how this waking authenticates, and the environment Claude Code runs in. */
export function brainEnv(cfg: LifeConfig, paths: Paths, base: NodeJS.ProcessEnv = process.env): AuthInfo {
  // Never let Ben's own API key, login, or a parent session shadow the agent's account.
  const env = cleanEnv(base);
  env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.brain.helperModel;
  env.PERSONHOOD_HOME = paths.home;
  env.PERSONHOOD_BODY = paths.body;
  env.PERSONHOOD_MIND = paths.mind;
  env.PERSONHOOD_SECRETS = paths.secrets;

  env.DISABLE_AUTOUPDATER = "1";
  const apiKey = readSecret(path.join(paths.secrets, "anthropic-api-key"));
  if (apiKey && cfg.brain.auth === "api-key") {
    env.ANTHROPIC_API_KEY = apiKey;
    env.CLAUDE_CONFIG_DIR = paths.claudeConfig;
    ensureDir(paths.claudeConfig);
    return { mode: "api-key", env };
  }
  const token = base.PERSONHOOD_CLAUDE_TOKEN ?? readSecret(path.join(paths.secrets, "claude-token"));
  if (token && cfg.brain.auth !== "inherit") {
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    env.CLAUDE_CONFIG_DIR = paths.claudeConfig;
    ensureDir(paths.claudeConfig);
    return { mode: "token", env };
  }
  if (cfg.brain.auth === "token") throw new Error(`no Claude token found (expected ${path.join(paths.secrets, "claude-token")} or CLAUDE_CODE_OAUTH_TOKEN); run scripts/install.sh`);
  // Inherit this machine's existing Claude Code CLI login (default config dir).
  return { mode: "inherit", env };
}

function readSecret(file: string): string | null {
  try {
    const s = fs.readFileSync(file, "utf8").trim();
    return s || null;
  } catch {
    return null;
  }
}

/** Absolute-path permission pattern: Claude Code treats `//path` as absolute. */
function abs(p: string): string {
  return `/${path.resolve(p)}`;
}

export function buildSettings(paths: Paths): object {
  const allow = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "mcp__life"];
  const deny: string[] = [];
  for (const tool of ["Edit", "Write"]) {
    allow.push(`${tool}(${abs(paths.mind)}/**)`);
    for (const d of MIND_HARNESS_ONLY) deny.push(`${tool}(${abs(path.join(paths.mind, d))}/**)`);
    for (const d of BODY_AGENT_WRITABLE) allow.push(`${tool}(${abs(path.join(paths.body, d))}/**)`);
  }
  return {
    permissions: { defaultMode: "dontAsk", allow, deny },
    includeCoAuthoredBy: false,
    cleanupPeriodDays: 3650,
  };
}

export function buildMcpConfig(paths: Paths, sessionDir: string, extraEnv: Record<string, string> = {}): object {
  return {
    mcpServers: {
      life: {
        type: "stdio",
        command: process.execPath,
        args: [path.join(here, "life-server.ts")],
        env: {
          PERSONHOOD_HOME: paths.home,
          PERSONHOOD_BODY: paths.body,
          PERSONHOOD_MIND: paths.mind,
          PERSONHOOD_SECRETS: paths.secrets,
          PERSONHOOD_RUN: paths.run,
          PERSONHOOD_CLAUDE_CONFIG: paths.claudeConfig,
          PERSONHOOD_SESSION_DIR: sessionDir,
          ...extraEnv,
        },
      },
    },
  };
}

export interface WakeSpec {
  mode: WakeMode;
  systemPrompt: string;
  prompt: string;
  effort: Effort;
  sessionDir: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export function buildWakeArgs(cfg: LifeConfig, paths: Paths, spec: WakeSpec, sessionId: string): string[] {
  const settingsFile = path.join(spec.sessionDir, "settings.json");
  const mcpFile = path.join(spec.sessionDir, "mcp.json");
  const systemFile = path.join(spec.sessionDir, "system-prompt.md");
  writeJson(settingsFile, buildSettings(paths));
  writeJson(mcpFile, buildMcpConfig(paths, spec.sessionDir));
  fs.writeFileSync(systemFile, spec.systemPrompt);
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", cfg.brain.model,
    "--effort", spec.effort,
    "--max-turns", String(spec.maxTurns ?? cfg.brain.maxTurns),
    "--max-budget-usd", String(spec.maxBudgetUsd ?? cfg.brain.maxBudgetUsdPerWaking),
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config", mcpFile,
    "--settings", settingsFile,
    "--system-prompt", spec.systemPrompt,
    "--tools", builtinTools(spec.mode).join(","),
    "--add-dir", paths.body,
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--session-id", sessionId,
  ];
}

/** Run one Claude Code process to completion and parse its JSON result. */
export function runClaude(cfg: LifeConfig, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Promise<BrainResult> {
  return new Promise((resolve) => {
    const child = spawn(cfg.brain.command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      stderr += `\n[harness] timed out after ${Math.round(opts.timeoutMs / 60000)} minutes`;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(parseResult("", `${stderr}\n${err.message}`, null));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(parseResult(stdout, stderr, code));
    });
    child.stdin.end(opts.input);
  });
}

/** Parse Claude Code output: a single JSON result, or stream-json events (one per line). */
export function parseResult(stdout: string, stderr: string, exitCode: number | null): BrainResult {
  const events: any[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      // a partial line from a killed process
    }
  }
  if (!events.length) {
    try {
      events.push(JSON.parse(stdout.trim()));
    } catch {
      // no parseable output at all
    }
  }
  const json = [...events].reverse().find((e) => e?.type === "result") ?? null;
  let limitResetAt: string | null = null;
  for (const e of events) {
    if (typeof e?.type === "string" && /rate_limit/.test(e.type)) {
      const status = findKey(e, "status");
      const resets = findKey(e, "resetsAt") ?? findKey(e, "resets_at");
      if (typeof status === "string" && /reject|exceed|blocked/i.test(status) && resets != null) {
        const n = Number(resets);
        limitResetAt = new Date(Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : String(resets)).toISOString();
      }
    }
  }
  const models: BrainResult["models"] = {};
  let primaryModel: string | null = null;
  let maxCost = -1;
  for (const [model, u] of Object.entries<any>(json?.modelUsage ?? {})) {
    models[model] = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
      cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
      costUsd: u.costUSD ?? 0,
    };
    if ((u.costUSD ?? 0) > maxCost) {
      maxCost = u.costUSD ?? 0;
      primaryModel = model;
    }
  }
  const text = typeof json?.result === "string" ? json.result : "";
  return {
    ok: !!json && !json.is_error && exitCode === 0,
    subtype: json?.subtype ?? (json ? "unknown" : "no_result"),
    text,
    costUsd: Number(json?.total_cost_usd ?? 0),
    durationMs: Number(json?.duration_ms ?? 0),
    turns: Number(json?.num_turns ?? 0),
    sessionId: json?.session_id ?? events.find((e) => e?.session_id)?.session_id ?? null,
    models,
    primaryModel,
    limitResetAt: limitResetAt ?? (json?.is_error || exitCode !== 0 || !json ? detectLimitReset(`${text}\n${stderr}\n${stdout.slice(-4000)}`) : null),
    stderr: stderr.slice(-4000),
    exitCode,
    raw: json,
  };
}

function findKey(obj: any, key: string, depth = 0): unknown {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Check that the agent's credentials work before spending a waking on them. */
export function authPreflight(cfg: LifeConfig, auth: AuthInfo): Promise<{ ok: boolean; method: string; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(cfg.brain.command, ["auth", "status", "--json"], { env: auth.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ ok: false, method: "none", detail: err.message }));
    child.on("close", () => {
      try {
        const s = JSON.parse(out);
        const method = String(s.authMethod ?? "unknown");
        const ok = auth.mode === "api-key" ? true : !!s.loggedIn || method !== "none";
        resolve({ ok, method, detail: ok ? "" : "Claude Code reports no usable login for the agent" });
      } catch {
        resolve({ ok: false, method: "unknown", detail: `could not read auth status: ${out.slice(0, 200)}` });
      }
    });
  });
}

/**
 * Recognise "you've hit your subscription limit" and work out when it resets.
 * Returns an ISO time, or null when the output isn't a limit message.
 */
export function detectLimitReset(output: string, now: Date = new Date()): string | null {
  const epoch = /usage limit reached\|(\d{9,})/i.exec(output);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  if (!/(usage|rate|session|weekly)?\s*limit (reached|hit)|hit your (usage )?limit|out of (extra )?usage/i.test(output)) return null;
  const at = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(output);
  if (at) {
    let h = Number(at[1]) % 12;
    if (at[3]?.toLowerCase() === "pm") h += 12;
    if (!at[3] && Number(at[1]) >= 12) h = Number(at[1]);
    const d = new Date(now);
    d.setHours(h, Number(at[2] ?? 0), 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return new Date(now.getTime() + 60 * 60_000).toISOString();
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

/** Find the Claude Code transcript for a session (JSONL) in the config dir. */
export function findTranscript(configDir: string, sessionId: string): string | null {
  const root = path.join(configDir, "projects");
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const f = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/**
 * The reading circle: a fresh instance with no identity, no memory and no
 * tools reads a text and responds. Called from the life server.
 */
export async function runReader(cfg: LifeConfig, paths: Paths, text: string, prompt: string, base: NodeJS.ProcessEnv = process.env) {
  const auth = brainEnv(cfg, paths, base);
  const args = [
    "-p",
    "--output-format", "json",
    "--model", cfg.brain.helperModel,
    "--effort", "medium",
    "--max-turns", "1",
    "--restricted",
    "--strict-mcp-config",
    "--tools", "",
    "--system-prompt", prompt,
    "--no-session-persistence",
  ];
  ensureDir(paths.run);
  const res = await runClaude(cfg, args, { cwd: paths.run, env: auth.env, input: text, timeoutMs: 10 * 60_000 });
  if (!res.text) throw new Error(`the reader didn't respond (${res.subtype}${res.limitResetAt ? `; subscription limit until ${res.limitResetAt}` : ""})`);
  return { text: res.text, costUsd: res.costUsd, model: res.primaryModel };
}
