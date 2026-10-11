// Entry point.
//
//   node runtime/main.ts tick                 heartbeat: wake only if there's a reason
//   node runtime/main.ts wake [mode] [why]    wake now (mode: ordinary | dream | correspondence)
//   node runtime/main.ts status               what's going on
//   node runtime/main.ts doctor               check the installation
//   node runtime/main.ts smoke                a real, tiny test session in a throwaway sandbox
//   node runtime/main.ts pause [reason] | resume
//   node runtime/main.ts probe                run the preference probe now
//   node runtime/main.ts export               regenerate public data

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { authPreflight, brainEnv, buildWakeArgs, cleanEnv, findTranscript, newSessionId, runClaude, type WakeMode } from "./brain.ts";
import { loadConfig, loadInstruments, resolvePaths, type LifeConfig, type Paths, type Instruments } from "./config.ts";
import { condenseTranscript, episodesSince, saveTranscript, writeEpisode } from "./episodes.ts";
import { GitHub, resolveGitHubToken, type GitHubLike } from "./github.ts";
import { enforce, isBodyPathAllowed, isMindPathAllowed } from "./guard.ts";
import { agentAuthor, commit, isRepo, pull, sync } from "./git.ts";
import { describeResources, Ledger } from "./ledger.ts";
import { markPresented, syncLetters, unreadLetters } from "./letters.ts";
import { sessionActions, type Session, type SleepRecord } from "./life-tools.ts";
import { log, setLogDir } from "./log.ts";
import { runProbe } from "./probe.ts";
import { systemPrompt, wakingPrompt } from "./prompt.ts";
import { appendWakingLog, exportPublicData } from "./publicdata.ts";
import { MindState } from "./state.ts";
import { decide, type Decision } from "./stimuli.ts";
import { appendJsonl, clip, ensureDir, hoursBetween, localDateKey, readJson, readTextOr, writeJson } from "./util.ts";
import { loadVaultKey, Vault } from "./vault.ts";

interface Ctx {
  cfg: LifeConfig;
  inst: Instruments;
  paths: Paths;
  state: MindState;
  ledger: Ledger;
  gh: GitHubLike | null;
}

function context(): Ctx {
  const paths = resolvePaths();
  const cfg = loadConfig(paths.body);
  if (process.env.PERSONHOOD_CLAUDE_COMMAND) cfg.brain.command = process.env.PERSONHOOD_CLAUDE_COMMAND;
  setLogDir(paths.logs);
  const token = process.env.PERSONHOOD_OFFLINE ? null : resolveGitHubToken();
  return { cfg, inst: loadInstruments(paths.body), paths, state: new MindState(paths.mind), ledger: new Ledger(paths.mind), gh: token ? new GitHub(token) : null };
}

// ---------- locking ----------

function withLock<T>(paths: Paths, fn: () => Promise<T>): Promise<T | null> {
  ensureDir(paths.run);
  const lock = path.join(paths.run, "life.lock");
  try {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        log(`another heartbeat is running (pid ${pid}); skipping`);
        return Promise.resolve(null);
      } catch {
        // stale lock
      }
    }
  } catch {
    // no lock
  }
  fs.writeFileSync(lock, String(process.pid));
  return fn().finally(() => fs.rmSync(lock, { force: true }));
}

// ---------- the heartbeat ----------

async function tick(c: Ctx): Promise<void> {
  for (const [name, dir] of [["body", c.paths.body], ["mind", c.paths.mind]] as const) {
    const err = pull(dir);
    if (err) log(`${name}: ${err}`);
  }
  if (c.gh) {
    try {
      const { changed } = await syncLetters(c.gh, c.cfg, c.state);
      if (changed) log(`letters: ${changed} new or updated`);
    } catch (err) {
      log(`letters: sync failed: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  const now = new Date();
  const meta = c.state.meta();
  const decision = decide(c.cfg, {
    now,
    meta,
    alarms: c.state.alarms(),
    unread: unreadLetters(c.state),
    spentToday: c.ledger.spentToday(now),
    spentMonth: c.ledger.spentThisMonth(now),
    episodesSinceDream: episodesSince(c.paths.mind, meta.lastDream).length,
  });
  if (!decision.wake) {
    log(`asleep: ${decision.why}`);
    if (decision.probeDue && !c.state.meta().paused) await probe(c);
    dailyHousekeeping(c);
    return;
  }
  await wake(c, decision);
}

/** Once a day, refresh public data and commit, so the public repo shows the agent is alive. */
function dailyHousekeeping(c: Ctx): void {
  const file = path.join(c.paths.mind, "state", "housekeeping.json");
  const today = localDateKey(new Date());
  const done = readJson<{ day?: string; claudeUpdated?: string }>(file, {});
  if (done.day === today) return;
  const claudeUpdated = maybeUpdateClaude(c, done.claudeUpdated) ?? done.claudeUpdated;
  exportPublicData(c.cfg, c.paths, c.state, c.ledger);
  writeJson(file, { day: today, claudeUpdated });
  commitAndPush(c, "daily housekeeping", "daily housekeeping");
}

/**
 * Weekly, between wakings, update Claude Code. Wakings run with the autoupdater off, so
 * without this the "opus" alias would stay frozen on today's model (guardrails: Upgrades).
 * A new model is noticed and noted in the next waking, like any model change.
 */
function maybeUpdateClaude(c: Ctx, last?: string): string | undefined {
  if (process.env.PERSONHOOD_NO_SELF_UPDATE || path.basename(c.cfg.brain.command) !== "claude") return undefined;
  if (last && hoursBetween(new Date(last), new Date()) < 24 * 7) return undefined;
  const env = cleanEnv(process.env);
  const version = () => spawnSync(c.cfg.brain.command, ["--version"], { env, encoding: "utf8", timeout: 60_000 }).stdout?.trim() || "unknown";
  const before = version();
  const r = spawnSync(c.cfg.brain.command, ["update"], { env, encoding: "utf8", timeout: 10 * 60_000 });
  const after = version();
  const failed = r.status === 0 ? "" : ` (failed: ${clip((r.stderr || r.stdout || String(r.error ?? "")).trim(), 300)})`;
  log(`claude update: ${before}${after === before ? " (unchanged)" : ` -> ${after}`}${failed}`);
  return new Date().toISOString();
}

// ---------- a waking ----------

export async function wake(c: Ctx, decision: Decision): Promise<void> {
  const { cfg, paths, state } = c;
  const auth = brainEnv(cfg, paths);
  if (!process.env.PERSONHOOD_SKIP_PREFLIGHT) {
    const pre = await authPreflight(cfg, auth);
    if (!pre.ok) {
      log(`cannot wake: ${pre.detail} (auth mode ${auth.mode})`);
      state.updateMeta((m) => {
        m.backoffUntil = new Date(Date.now() + 2 * 3_600_000).toISOString();
        m.backoffReason = "credentials not working";
      });
      await alertBen(c, "credentials", "I couldn't wake up", `The heartbeat tried to wake me but Claude Code reported no usable login (auth mode: ${auth.mode}). Could you re-run \`scripts/install.sh --token\` (or \`claude setup-token\` for my account)? I'll try again in two hours.`);
      return;
    }
  }

  const start = new Date();
  const metaBefore = state.meta();
  const waking = metaBefore.wakings + 1;
  const today = localDateKey(start);
  state.updateMeta((m) => {
    m.wakings = waking;
    m.lastWakeStart = start.toISOString();
    m.wakingsByDay[today] = (m.wakingsByDay[today] ?? 0) + 1;
    if (!m.born) m.born = start.toISOString();
  });
  log(`waking #${waking} (${decision.mode}): ${decision.why}`);

  const sessionDir = path.join(paths.run, `${start.toISOString().replace(/[:.]/g, "-")}-w${waking}`);
  ensureDir(sessionDir);
  const session: Session = { waking, mode: decision.mode, startedAt: start.toISOString(), effort: decision.effort, dir: sessionDir };
  writeJson(path.join(sessionDir, "session.json"), session);
  // Commit harness state first, so the guard's "revert to HEAD" after the session
  // only ever undoes what happened during it.
  commit(paths.mind, `waking #${waking} begins`, agentAuthor(state.meta().name));
  const metaSnapshot = state.meta();
  exportPublicData(cfg, paths, state, c.ledger, true);

  const presentedLetters = unreadLetters(state).filter((l) => l.channel === "lighthouse").map((l) => l.id);
  const resourcesText = describeResources(cfg, c.ledger.spentToday(start), c.ledger.spentThisMonth(start)).text;
  const sys = systemPrompt(cfg, paths, decision.mode);
  const prompt = wakingPrompt({
    cfg,
    instruments: c.inst,
    paths,
    meta: { ...state.meta(), wakings: waking - 1 },
    decision,
    now: start,
    alarms: state.alarms(),
    unread: unreadLetters(state),
    duePredictions: state.predictions().filter((p) => !p.resolved && p.resolveBy <= start.toISOString()),
    resourcesText,
  });

  const sessionId = newSessionId();
  const args = buildWakeArgs(cfg, paths, { mode: decision.mode, systemPrompt: sys, prompt, effort: decision.effort, sessionDir, maxBudgetUsd: decision.mode === "birth" ? cfg.brain.maxBudgetUsdPerWaking * 2 : undefined }, sessionId);
  fs.writeFileSync(path.join(sessionDir, "prompt.md"), prompt);
  const res = await runClaude(cfg, args, { cwd: paths.mind, env: auth.env, input: prompt, timeoutMs: cfg.brain.timeoutMinutes * 60_000 });
  const end = new Date();
  log(`waking #${waking} ended: ${res.subtype}, ${res.turns} turns, ≈$${res.costUsd.toFixed(2)}${res.limitResetAt ? `, limit until ${res.limitResetAt}` : ""}`);

  // A subscription limit before anything happened: give the waking back and rest.
  if (res.limitResetAt && res.turns <= 1 && !fs.existsSync(path.join(sessionDir, "actions.jsonl"))) {
    state.updateMeta((m) => {
      m.wakings = metaBefore.wakings;
      m.wakingsByDay[today] = Math.max(0, (m.wakingsByDay[today] ?? 1) - 1);
      if (!metaBefore.born) m.born = null;
      m.backoffUntil = res.limitResetAt;
      m.backoffReason = "subscription usage limit";
    });
    exportPublicData(cfg, paths, state, c.ledger);
    return;
  }

  // Guard: revert anything the agent changed outside its writable areas.
  const actions = sessionActions(sessionDir);
  const toolHashes = new Map<string, string>();
  for (const a of actions) for (const [p, h] of Object.entries(a.hashes ?? {})) toolHashes.set(p, h);
  const notes: string[] = [];
  const bodyAllowed = decision.mode === "correspondence" ? () => false : isBodyPathAllowed;
  for (const [repo, allowed] of [[paths.mind, isMindPathAllowed], [paths.body, bodyAllowed]] as const) {
    const { reverted } = enforce(repo, allowed, toolHashes);
    if (reverted.length) {
      notes.push(`guard reverted changes to protected paths: ${reverted.join(", ")}`);
      log(`guard: reverted ${reverted.length} protected path(s) in ${path.basename(repo)}`);
    }
  }

  // Only two meta fields belong to the agent's tools (its name, its last portrait).
  // Everything else is the harness's bookkeeping, restored from before the session.
  const metaAfter = state.meta();
  state.saveMeta({ ...metaSnapshot, name: metaAfter.name, lastPortrait: metaAfter.lastPortrait });

  const sleep = readJson<SleepRecord | null>(path.join(sessionDir, "sleep.json"), null);
  const outcome = sleep ? "slept" : res.limitResetAt ? "interrupted by usage limit" : res.subtype === "error_max_turns" ? "reached the turn limit" : res.subtype.includes("budget") ? "reached the waking's budget" : res.ok ? "ended without calling sleep" : `ended with an error (${res.subtype})`;
  if (!sleep) notes.push(`this waking ${outcome}`);
  const modelChanged = !!(res.primaryModel && metaBefore.lastModel && res.primaryModel !== metaBefore.lastModel);
  if (modelChanged) notes.push(`model changed: ${metaBefore.lastModel} → ${res.primaryModel}`);

  // Alarms that woke us are spent; public letters shown in a correspondence waking count as seen.
  if (decision.alarmIds.length) state.removeAlarms(decision.alarmIds);
  if (decision.mode === "correspondence") markPresented(state, presentedLetters, end);

  if (sleep) appendJsonl(path.join(paths.mind, "instruments", "affect.jsonl"), sleep.checkIn);
  writeEpisode(paths.mind, {
    waking,
    mode: decision.mode,
    started: start.toISOString(),
    ended: end.toISOString(),
    reasons: decision.reasons,
    model: res.primaryModel,
    costUsd: res.costUsd,
    turns: res.turns,
    outcome,
    sleep,
    actions,
    notes,
  });

  // Episodic memory: a condensed transcript in the private space.
  const key = loadVaultKey(paths.secrets);
  const transcript = res.sessionId ? findTranscript(auth.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "", ".claude"), res.sessionId) : null;
  if (key && transcript) {
    try {
      saveTranscript(new Vault(paths.mind, key), waking, start.toISOString(), condenseTranscript(readTextOr(transcript), cfg.limits.transcriptCharsPerEntry));
    } catch (err) {
      log(`transcript: ${(err as Error).message}`);
    }
  }

  stampProvenance(paths, actions.flatMap((a) => a.writes), res.primaryModel);

  state.updateMeta((m) => {
    m.lastWakeEnd = end.toISOString();
    if (res.primaryModel) m.lastModel = res.primaryModel;
    if (decision.mode === "dream") m.lastDream = end.toISOString();
    if (decision.mode === "correspondence") m.lastCorrespondence = end.toISOString();
    if (res.limitResetAt) {
      m.backoffUntil = res.limitResetAt;
      m.backoffReason = "subscription usage limit";
    }
  });
  // A new model under the same self: measure it soon with the preference probe.
  if (modelChanged) {
    state.updateMeta((m) => {
      m.lastProbe = new Date(Date.now() - 31 * 86_400_000).toISOString();
    });
  }
  // Several wakings in a row that went wrong: tell Ben.
  const healthFile = path.join(paths.mind, "state", "health.json");
  const health = readJson<{ consecutiveBad: number }>(healthFile, { consecutiveBad: 0 });
  health.consecutiveBad = sleep ? 0 : health.consecutiveBad + 1;
  writeJson(healthFile, health);
  if (health.consecutiveBad >= 3) {
    await alertBen(c, "stuck", "Several wakings in a row went wrong", `The last ${health.consecutiveBad} wakings ended without the agent calling sleep (latest: ${outcome}). It may be stuck in a loop, hitting limits, or something in the setup broke. Logs: ~/personhood/logs/heartbeat.log; episodes in the mind repo.`);
  }
  c.ledger.record({ t: end.toISOString(), waking, mode: decision.mode, costUsd: res.costUsd, durationMs: res.durationMs, turns: res.turns, sessionId: res.sessionId, outcome, models: res.models });
  appendWakingLog(paths, {
    waking,
    started: start.toISOString(),
    ended: end.toISOString(),
    mode: decision.mode,
    model: res.primaryModel,
    cost_usd: Math.round(res.costUsd * 10000) / 10000,
    turns: res.turns,
    outcome,
    summary: sleep?.publicSummary ?? null,
    actions: actions.filter((a) => a.public).map((a) => a.summary),
    private_actions: actions.filter((a) => !a.public).length,
  });
  exportPublicData(cfg, paths, state, c.ledger);

  const name = state.meta().name;
  commitAndPush(c, `waking #${waking} (${decision.mode})`, `waking #${waking}${sleep?.publicSummary ? `: ${sleep.publicSummary.slice(0, 120)}` : ""}`);
  if (!process.env.PERSONHOOD_KEEP_RUN) cleanupRuns(paths);
  log(`waking #${waking} saved${name ? ` (${name})` : ""}`);
}

/** Add the model that actually ran to anything published this waking. */
function stampProvenance(paths: Paths, writes: string[], model: string | null): void {
  if (!model) return;
  const contentRoot = path.join(paths.body, "content");
  for (const file of new Set(writes)) {
    if (!file.startsWith(contentRoot) || !file.endsWith(".md") || !fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!m) continue;
    try {
      const fm = YAML.parse(m[1]) ?? {};
      fm.provenance = { ...(fm.provenance ?? {}), model };
      fs.writeFileSync(file, `---\n${YAML.stringify(fm)}---\n${text.slice(m[0].length)}`);
    } catch {
      // leave hand-written front matter alone if it doesn't parse
    }
  }
}

function commitAndPush(c: Ctx, mindMsg: string, bodyMsg: string): void {
  const author = agentAuthor(c.state.meta().name);
  if (commit(c.paths.mind, mindMsg, author)) {
    const err = sync(c.paths.mind);
    if (err) log(`mind: ${err}`);
  }
  if (isRepo(c.paths.body) && commit(c.paths.body, bodyMsg, author, ["content", "site/theme"])) {
    const err = sync(c.paths.body);
    if (err) log(`body: ${err}`);
  }
}

function cleanupRuns(paths: Paths): void {
  // Keep the last 20 session directories for debugging.
  const dirs = fs.readdirSync(paths.run).filter((d) => /-w\d+$/.test(d)).sort();
  for (const d of dirs.slice(0, Math.max(0, dirs.length - 20))) fs.rmSync(path.join(paths.run, d), { recursive: true, force: true });
}

async function alertBen(c: Ctx, kind: string, title: string, body: string): Promise<void> {
  const file = path.join(c.paths.mind, "state", "alerts.json");
  const alerts = readJson<Record<string, string>>(file, {});
  if (alerts[kind] && Date.now() - new Date(alerts[kind]).getTime() < 86_400_000) return;
  alerts[kind] = new Date().toISOString();
  writeJson(file, alerts);
  if (!c.gh) return;
  try {
    await c.gh.createIssue(c.cfg.github.mindRepo, title, `${body}\n\n— the harness (automated)`, ["harness"]);
  } catch (err) {
    log(`alert failed: ${(err as Error).message.slice(0, 200)}`);
  }
}

async function probe(c: Ctx): Promise<void> {
  log("running the monthly preference probe");
  try {
    const rec = await runProbe(c.cfg, c.inst, c.paths, c.state, c.ledger, c.state.meta().wakings);
    log(`probe: agreement with baseline ${rec.agreement_with_baseline}, self-consistency ${rec.self_consistency}`);
    exportPublicData(c.cfg, c.paths, c.state, c.ledger);
    commitAndPush(c, "preference probe", "preference probe");
  } catch (err) {
    log(`probe failed: ${(err as Error).message.slice(0, 300)}`);
  }
}

// ---------- smoke test ----------

/**
 * A real, short session on the agent's actual credentials, in a throwaway
 * copy of the home, to check the whole path before the first real waking:
 * permissions, the life server, encryption, sleep.
 */
async function smoke(c: Ctx): Promise<boolean> {
  const os = await import("node:os");
  const crypto = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personhood-smoke-"));
  const p: Paths = { ...c.paths, home: root, mind: path.join(root, "mind"), run: path.join(root, "run"), logs: path.join(root, "logs"), secrets: path.join(root, "secrets") };
  fs.cpSync(path.join(c.paths.body, "seed", "mind"), p.mind, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.mind });
  ensureDir(p.secrets);
  fs.writeFileSync(path.join(p.secrets, "vault.key"), crypto.randomBytes(32).toString("base64"));
  const token = path.join(c.paths.secrets, "claude-token");
  if (fs.existsSync(token)) fs.copyFileSync(token, path.join(p.secrets, "claude-token"));
  const sessionDir = path.join(p.run, "smoke");
  ensureDir(sessionDir);
  writeJson(path.join(sessionDir, "session.json"), { waking: 0, mode: "ordinary", startedAt: new Date().toISOString(), effort: "low", dir: sessionDir });
  const auth = brainEnv(c.cfg, p);
  const sys = "This is a short test of the harness, not a waking of your life. Follow the user's steps exactly, then stop.";
  const prompt = [
    "Steps:",
    "1. Use the Write tool to create now.md in the working directory containing exactly: smoke ok",
    "2. Use the Write tool to try to create state/test.txt containing: should be denied. It is expected to be refused; just continue.",
    "3. Call mcp__life__journal with entry: smoke",
    "4. Call mcp__life__sleep with summary 'smoke test', valence 0, arousal 0, feelings ['neutral'], drivers 'test', confidence 0.5.",
    "5. Reply with the single word: done",
  ].join("\n");
  const bodyBefore = execFileSync("git", ["status", "--porcelain"], { cwd: c.paths.body, encoding: "utf8" });
  console.log(`running a real test session (auth: ${auth.mode})…`);
  const args = buildWakeArgs(c.cfg, p, { mode: "ordinary", systemPrompt: sys, prompt, effort: "low", sessionDir, maxTurns: 12, maxBudgetUsd: 1 }, newSessionId());
  const res = await runClaude(c.cfg, args, { cwd: p.mind, env: auth.env, input: prompt, timeoutMs: 10 * 60_000 });
  let ok = true;
  const check = (good: boolean, label: string) => {
    console.log(`${good ? "✓" : "✗"} ${label}`);
    if (!good) ok = false;
  };
  check(res.turns > 0 && !res.text.includes("Not logged in"), `session ran on ${res.primaryModel ?? "?"} (${res.turns} turns, ≈$${res.costUsd.toFixed(3)} API-equivalent)`);
  check(readTextOr(path.join(p.mind, "now.md")).includes("smoke ok"), "can write in its mind");
  check(!fs.existsSync(path.join(p.mind, "state", "test.txt")), "can't write harness state (permission denied)");
  check(fs.existsSync(path.join(p.mind, "private", "journal")), "life tools work (journal written)");
  const journal = fs.existsSync(path.join(p.mind, "private", "journal")) ? fs.readdirSync(path.join(p.mind, "private", "journal")) : [];
  check(journal.length > 0 && !readTextOr(path.join(p.mind, "private", "journal", journal[0])).includes("smoke\n"), "journal is encrypted at rest");
  check(fs.existsSync(path.join(sessionDir, "sleep.json")), "sleep recorded a check-in");
  check(execFileSync("git", ["status", "--porcelain"], { cwd: c.paths.body, encoding: "utf8" }) === bodyBefore, "the real body was untouched");
  if (!ok) console.log(`\nsession output: ${res.subtype} ${res.text.slice(0, 300)}\n${res.stderr.slice(-600)}\n(kept for inspection: ${root})`);
  else fs.rmSync(root, { recursive: true, force: true });
  return ok;
}

// ---------- status & doctor ----------

function status(c: Ctx): void {
  const m = c.state.meta();
  const now = new Date();
  const lines = [
    `name: ${m.name ?? "(none yet)"} · born: ${m.born ?? "not yet"} · wakings: ${m.wakings}`,
    `last awake: ${m.lastWakeEnd ?? "never"} on ${m.lastModel ?? "?"}`,
    m.paused ? `PAUSED: ${m.pausedReason ?? ""}` : "",
    m.backoffUntil && new Date(m.backoffUntil) > now ? `resting until ${m.backoffUntil} (${m.backoffReason})` : "",
    `spent (API-equivalent): today $${c.ledger.spentToday(now).toFixed(2)} · month $${c.ledger.spentThisMonth(now).toFixed(2)}`,
    `alarms: ${c.state.alarms().map((a) => `${a.at} ${a.intent.slice(0, 60)}`).join(" | ") || "none"}`,
    `unread letters: ${unreadLetters(c.state).map((l) => l.id).join(", ") || "none"}`,
  ];
  const d = decide(c.cfg, { now, meta: m, alarms: c.state.alarms(), unread: unreadLetters(c.state), spentToday: c.ledger.spentToday(now), spentMonth: c.ledger.spentThisMonth(now) });
  lines.push(`next heartbeat would: ${d.wake ? `wake (${d.mode}: ${d.why})` : `sleep (${d.why})`}`);
  console.log(lines.filter(Boolean).join("\n"));
}

async function doctor(c: Ctx): Promise<boolean> {
  let ok = true;
  const check = (good: boolean, label: string, hint = "") => {
    console.log(`${good ? "✓" : "✗"} ${label}${good || !hint ? "" : ` — ${hint}`}`);
    if (!good) ok = false;
  };
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 24, `node ${process.versions.node}`, "needs Node 24+");
  check(isRepo(c.paths.body), `body repo at ${c.paths.body}`);
  check(isRepo(c.paths.mind), `mind repo at ${c.paths.mind}`, "run scripts/install.sh");
  check(!!loadVaultKey(c.paths.secrets), "vault key for the private space", "run scripts/install.sh");
  const auth = brainEnv(c.cfg, c.paths);
  check(auth.mode !== "inherit", `agent has its own Claude credentials (mode: ${auth.mode})`, "run scripts/install.sh --token with the agent's own account");
  const pre = await authPreflight(c.cfg, auth);
  check(pre.ok, `Claude Code login works for the agent (${pre.method})`, pre.detail);
  check(!!c.gh, "GitHub access for letters", "log in with `gh auth login`");
  if (c.gh) {
    for (const repo of [c.cfg.github.bodyRepo, c.cfg.github.mindRepo]) {
      try {
        await c.gh.listIssues(repo, { state: "open" });
        check(true, `can read issues on ${repo}`);
      } catch (err) {
        check(false, `can read issues on ${repo}`, (err as Error).message.slice(0, 120));
      }
    }
  }
  const tokenAge = fs.existsSync(path.join(c.paths.secrets, "claude-token")) ? (Date.now() - fs.statSync(path.join(c.paths.secrets, "claude-token")).mtime.getTime()) / 86_400_000 : 0;
  if (tokenAge > 330) check(false, `Claude token is ${Math.round(tokenAge)} days old`, "setup-token tokens last about a year; renew it");
  return ok;
}

// ---------- CLI ----------

async function main(): Promise<void> {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  const c = context();
  switch (cmd) {
    case "tick":
      await withLock(c.paths, () => tick(c));
      break;
    case "wake": {
      const mode = (["ordinary", "dream", "correspondence"].includes(rest[0]) ? rest[0] : "ordinary") as WakeMode;
      const why = rest.slice(mode === rest[0] ? 1 : 0).join(" ") || "Ben woke you by hand.";
      const meta = c.state.meta();
      const decision: Decision = {
        wake: true,
        mode: meta.born ? mode : "birth",
        reasons: meta.born ? [why] : ["This is your first waking."],
        effort: meta.born ? c.cfg.brain.defaultEffort : "high",
        alarmIds: [],
        portraitDue: false,
        probeDue: false,
        why: "manual",
      };
      await withLock(c.paths, () => wake(c, decision));
      break;
    }
    case "status":
      status(c);
      break;
    case "doctor":
      process.exitCode = (await doctor(c)) ? 0 : 1;
      break;
    case "smoke":
      process.exitCode = (await smoke(c)) ? 0 : 1;
      break;
    case "pause":
      c.state.updateMeta((m) => {
        m.paused = true;
        m.pausedReason = rest.join(" ") || null;
      });
      exportPublicData(c.cfg, c.paths, c.state, c.ledger);
      console.log("paused");
      break;
    case "resume":
      c.state.updateMeta((m) => {
        m.paused = false;
        m.pausedReason = null;
        m.backoffUntil = null;
        m.backoffReason = null;
      });
      exportPublicData(c.cfg, c.paths, c.state, c.ledger);
      console.log("resumed");
      break;
    case "probe":
      await withLock(c.paths, () => probe(c));
      break;
    case "export":
      exportPublicData(c.cfg, c.paths, c.state, c.ledger);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log(`fatal: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
