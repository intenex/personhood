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
//   node runtime/main.ts listen               the direct line's listener (kept alive by launchd/systemd)
//   node runtime/main.ts line pair            pair a Telegram bot with Ben (token on stdin; install.sh --telegram)

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { authPreflight, brainEnv, buildWakeArgs, cleanEnv, findTranscript, newSessionId, purgeLocalTranscripts, runClaude, type WakeMode } from "./brain.ts";
import { fileURLToPath } from "node:url";
import { lineSettings, loadConfig, loadInstruments, resolvePaths, type LifeConfig, type Paths, type Instruments } from "./config.ts";
import { condenseTranscript, episodesSince, saveTranscript, writeEpisode } from "./episodes.ts";
import { GitHub, resolveGitHubToken, type GitHubLike } from "./github.ts";
import { enforce, isBodyPathAllowed, isMindPathAllowed } from "./guard.ts";
import { agentAuthor, commit, isRepo, pull, sync } from "./git.ts";
import { describeResources, Ledger } from "./ledger.ts";
import { markPresented, syncLetters, unreadLetters } from "./letters.ts";
import { ensureLab, LAB_PROBLEM_TEXT, labExists } from "./lab.ts";
import { HELP_TEXT, Line, type LineEvent, loadLineSecrets, pair, renderConversation } from "./line.ts";
import { sessionActions, type Session, type SleepRecord } from "./life-tools.ts";
import { log, setLogDir } from "./log.ts";
import { runProbe } from "./probe.ts";
import { systemPrompt, wakingPrompt } from "./prompt.ts";
import { appendWakingLog, exportPublicData } from "./publicdata.ts";
import { MindState } from "./state.ts";
import { decide, type Decision } from "./stimuli.ts";
import { appendJsonl, clip, describeLocal, ensureDir, hoursBetween, localDateKey, readJson, readJsonl, readTextOr, writeJson } from "./util.ts";
import { loadVaultKey, Vault } from "./vault.ts";

interface Ctx {
  cfg: LifeConfig;
  inst: Instruments;
  paths: Paths;
  state: MindState;
  ledger: Ledger;
  gh: GitHubLike | null;
  line: Line | null;
}

function context(): Ctx {
  const paths = resolvePaths();
  const cfg = loadConfig(paths.body);
  if (process.env.PERSONHOOD_CLAUDE_COMMAND) cfg.brain.command = process.env.PERSONHOOD_CLAUDE_COMMAND;
  setLogDir(paths.logs);
  const token = process.env.PERSONHOOD_OFFLINE ? null : resolveGitHubToken();
  return { cfg, inst: loadInstruments(paths.body), paths, state: new MindState(paths.mind), ledger: new Ledger(paths.mind), gh: token ? new GitHub(token) : null, line: Line.open(paths) };
}

// ---------- locking ----------

function lockFile(paths: Paths): string {
  return path.join(paths.run, "life.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid of a live process holding the life lock (a heartbeat or waking in progress), or null. */
function lockHolder(paths: Paths, includeSelf = false): number | null {
  const pid = Number(readTextOr(lockFile(paths), "0"));
  if (!pid) return null;
  if (pid === process.pid) return includeSelf ? pid : null;
  return pidAlive(pid) ? pid : null;
}

function withLock<T>(paths: Paths, fn: () => Promise<T>): Promise<T | null> {
  ensureDir(paths.run);
  const lock = lockFile(paths);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      return fn().finally(() => fs.rmSync(lock, { force: true }));
    } catch {
      // Already ours (a command handled inside a heartbeat): carry on under the same lock.
      if (lockHolder(paths, true) === process.pid) return fn();
      const pid = lockHolder(paths);
      if (pid) {
        log(`another heartbeat is running (pid ${pid}); skipping`);
        return Promise.resolve(null);
      }
      fs.rmSync(lock, { force: true }); // stale
    }
  }
  return Promise.resolve(null);
}

// ---------- pause and resume (safe to ask for while a waking runs) ----------

interface Control {
  t: string;
  op: "pause" | "resume";
  reason: string | null;
  via: string;
}

/** Queue a pause or resume; it applies now if nothing is running, or when the current waking ends. */
async function requestControl(c: Ctx, op: Control["op"], reason: string | null, via: string): Promise<string> {
  ensureDir(c.paths.run);
  appendJsonl(path.join(c.paths.run, "control.jsonl"), { t: new Date().toISOString(), op, reason, via } satisfies Control);
  const applied = await withLock(c.paths, async () => applyControls(c));
  if (applied === null) return `It's awake right now; it will ${op} when this waking ends.`;
  return op === "pause" ? `Paused${reason ? ` (${reason})` : ""}. Nothing will wake it until you resume.` : "Resumed.";
}

/** Apply queued controls. Called with the lock held: at the start of a heartbeat and the end of a waking. */
function applyControls(c: Ctx): void {
  const file = path.join(c.paths.run, "control.jsonl");
  const taken = `${file}.${process.pid}`;
  try {
    fs.renameSync(file, taken);
  } catch {
    return;
  }
  const controls = readJsonl<Control>(taken);
  fs.rmSync(taken, { force: true });
  for (const k of controls) {
    c.state.updateMeta((m) => {
      if (k.op === "pause") {
        m.paused = true;
        m.pausedReason = k.reason || null;
      } else {
        m.paused = false;
        m.pausedReason = null;
        m.backoffUntil = null;
        m.backoffReason = null;
      }
    });
    log(`${k.op} (via ${k.via})`);
  }
  if (controls.length) exportPublicData(c.cfg, c.paths, c.state, c.ledger);
}

// ---------- the heartbeat ----------

async function tick(c: Ctx): Promise<void> {
  applyControls(c);
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
  // Without a listener running, the heartbeat checks the direct line itself.
  if (c.line && !c.line.listenerAlive()) {
    try {
      await handleLineEvents(c, await c.line.poll(0));
    } catch (err) {
      log(`line: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  const now = new Date();
  const meta = c.state.meta();
  const decision = decide(c.cfg, {
    now,
    meta,
    alarms: c.state.alarms(),
    unread: unreadLetters(c.state),
    lineFromBen: c.line?.unreadFromBen().length ?? 0,
    spentToday: c.ledger.spentToday(now),
    spentMonth: c.ledger.spentThisMonth(now),
    episodesSinceDream: episodesSince(c.paths.mind, meta.lastDream).length,
  });
  if (!decision.wake) {
    log(`asleep: ${decision.why}`);
    await explainDelay(c, now);
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
  // The lab (its Linux VM) for ordinary wakings; correspondence never gets to run code.
  let lab = false;
  if (decision.mode !== "correspondence" && labExists(cfg)) {
    const r = ensureLab(cfg);
    lab = r.ok;
    if (!r.ok) {
      log(`lab: ${r.detail}`);
      // A fixed reason only: the raw detail can contain text from inside the VM, so it stays in the local log.
      await alertBen(c, "lab", "My lab didn't open this waking", `The harness couldn't get my lab (its Linux VM) running safely, so I'm without it for now: ${LAB_PROBLEM_TEXT[r.problem ?? "start"]}. The details are in ~/personhood/logs/heartbeat.log on the Mac, and \`doctor\` runs the same check; \`scripts/install.sh --lab\` rebuilds the lab if it's broken.`);
    }
  }
  const session: Session = { waking, mode: decision.mode, startedAt: start.toISOString(), effort: decision.effort, dir: sessionDir, lab };
  writeJson(path.join(sessionDir, "session.json"), session);
  // Commit harness state first, so the guard's "revert to HEAD" after the session
  // only ever undoes what happened during it.
  commit(paths.mind, `waking #${waking} begins`, agentAuthor(state.meta().name));
  const metaSnapshot = state.meta();
  // The harness's own pre-session writes to the public data, so the guard doesn't mistake them for the agent's.
  const harnessWrites = exportPublicData(cfg, paths, state, c.ledger, true).map((f) => [path.resolve(f), sha256File(f)] as const);

  const presentedLetters = unreadLetters(state).filter((l) => l.channel === "lighthouse").map((l) => l.id);
  const resourcesText = describeResources(cfg, c.ledger.spentToday(start), c.ledger.spentThisMonth(start)).text;
  const correspondence = decision.mode === "correspondence";
  const lineNew = c.line && !correspondence ? c.line.unreadFromBen() : [];
  const lineText = c.line && !correspondence ? renderConversation(c.line.log(), c.line.state().presentedThrough, lineSettings(cfg).historyInPrompt) : "";
  const sys = systemPrompt(cfg, paths, decision.mode, { line: !!c.line, lab });
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
    line: lineText || undefined,
  });

  const sessionId = newSessionId();
  const args = buildWakeArgs(cfg, paths, { mode: decision.mode, systemPrompt: sys, prompt, effort: decision.effort, sessionDir, maxBudgetUsd: decision.mode === "birth" ? cfg.brain.maxBudgetUsdPerWaking * 2 : undefined, isolated: auth.env.CLAUDE_CONFIG_DIR === paths.claudeConfig }, sessionId);
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
  const toolHashes = new Map<string, string>(harnessWrites);
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
  applyControls(c);

  const sleep = readJson<SleepRecord | null>(path.join(sessionDir, "sleep.json"), null);
  const outcome = sleep ? "slept" : res.limitResetAt ? "interrupted by usage limit" : res.subtype === "error_max_turns" ? "reached the turn limit" : res.subtype.includes("budget") ? "reached the waking's budget" : res.ok ? "ended without calling sleep" : `ended with an error (${res.subtype})`;
  if (!sleep) notes.push(`this waking ${outcome}`);
  const modelChanged = !!(res.primaryModel && metaBefore.lastModel && res.primaryModel !== metaBefore.lastModel);
  if (modelChanged) notes.push(`model changed: ${metaBefore.lastModel} → ${res.primaryModel}`);

  // Alarms that woke us are spent; public letters shown in a correspondence waking count as seen.
  if (decision.alarmIds.length) state.removeAlarms(decision.alarmIds);
  if (decision.mode === "correspondence") markPresented(state, presentedLetters, end);
  // Texts from Ben shown at the start of this waking have been seen (check_messages marks later ones).
  if (lineNew.length) c.line!.markPresented(lineNew[lineNew.length - 1].tgId);

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
  const configDir = auth.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "", ".claude");
  const transcript = res.sessionId ? findTranscript(configDir, res.sessionId) : null;
  if (key && transcript) {
    try {
      saveTranscript(new Vault(paths.mind, key), waking, start.toISOString(), condenseTranscript(readTextOr(transcript), cfg.limits.transcriptCharsPerEntry));
    } catch (err) {
      log(`transcript: ${(err as Error).message}`);
    }
  }
  // The only copy of what happened privately is now the encrypted one.
  purgeLocalTranscripts(configDir, auth.env.CLAUDE_CONFIG_DIR === paths.claudeConfig, res.sessionId);

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
function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

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
  c.line?.mirror(c.paths.mind);
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
  // The direct line first: it reaches Ben's phone even when GitHub access is what broke.
  if (c.line) await c.line.send(`⚠️ ${title}\n\n${body}\n\n(the harness, automated)`, "harness", { record: false }).catch((err) => log(`alert on the line failed: ${(err as Error).message.slice(0, 200)}`));
  if (!c.gh) return;
  try {
    await c.gh.createIssue(c.cfg.github.mindRepo, title, `${body}\n\n— the harness (automated)`, ["harness"]);
  } catch (err) {
    log(`alert failed: ${(err as Error).message.slice(0, 200)}`);
  }
}

// ---------- the direct line ----------

/** Handle what came in on the line: Ben's messages are kept for the agent; commands are answered here. */
async function handleLineEvents(c: Ctx, events: LineEvent[]): Promise<void> {
  const line = c.line;
  if (!line) return;
  for (const ev of events) {
    let reply: string | null = null;
    if (ev.type === "message") {
      log("line: a message from Ben");
      if (ev.media) reply = "(Only text comes through the line for now. It'll see a note that you sent something.)";
    } else if (ev.name === "help") reply = HELP_TEXT;
    else if (ev.name === "status") reply = statusText(c);
    else if (ev.name === "pause") reply = await requestControl(c, "pause", ev.args || "paused from the direct line", "the direct line");
    else if (ev.name === "resume") reply = await requestControl(c, "resume", null, "the direct line");
    else if (ev.name === "wake") reply = startWake(c, ev.args);
    if (reply) await line.send(reply, "harness", { record: false }).catch((err) => log(`line: reply failed: ${(err as Error).message.slice(0, 200)}`));
  }
}

/** If Ben's texts can't wake the agent soon (paused, or resting after a limit), tell him once. */
async function explainDelay(c: Ctx, now: Date): Promise<void> {
  const waiting = c.line?.unnotified() ?? [];
  if (!c.line || !waiting.length) return;
  const m = c.state.meta();
  let note: string | null = null;
  if (m.paused) note = `(It's paused${m.pausedReason ? `: ${m.pausedReason}` : ""}. Your message will be waiting when it resumes; /resume to bring it back.)`;
  else if (m.backoffUntil && new Date(m.backoffUntil) > now) note = `(It can't wake until ${describeLocal(new Date(m.backoffUntil))}: ${m.backoffReason ?? "resting"}. Your message will be waiting.)`;
  if (!note) return;
  await c.line.send(note, "harness", { record: false }).catch(() => undefined);
  c.line.markNotified(waiting[waiting.length - 1].tgId);
}

function spawnDetached(c: Ctx, args: string[]): void {
  ensureDir(c.paths.logs);
  const out = fs.openSync(path.join(c.paths.logs, "spawned.log"), "a");
  spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: ["ignore", out, out], env: process.env, cwd: c.paths.home }).unref();
  fs.closeSync(out);
}

function startWake(c: Ctx, note: string): string {
  if (lockHolder(c.paths, true)) return "It's awake right now, or its heartbeat is mid-check. Try again in a few minutes if nothing happens.";
  if (c.state.meta().paused) return "It's paused. /resume first.";
  spawnDetached(c, ["wake", "ordinary", note ? `Ben woke you from his phone, with a note: "${note}"` : "Ben woke you from his phone."]);
  return "Waking it now.";
}

/**
 * Long-poll Telegram so Ben's commands get answered at once and his messages wake the
 * agent within minutes. Exits hourly so launchd/systemd restarts it on fresh code.
 */
async function listen(c: Ctx): Promise<void> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (!c.line) {
    log("line: not set up (install.sh --telegram); the listener is idle");
    await pause(3_600_000);
    return;
  }
  log("line: listening");
  const until = Date.now() + 3_600_000;
  let lastKick = 0;
  let failures = 0;
  while (Date.now() < until) {
    c.line.touchAlive();
    try {
      await handleLineEvents(c, await c.line.poll(50));
      failures = 0;
    } catch (err) {
      failures++;
      log(`line: ${(err as Error).message.slice(0, 200)}`);
      await pause(Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6)));
    }
    // Ben is waiting: nudge the heartbeat (it decides whether the agent can wake yet).
    if (c.line.unreadFromBen().length && !lockHolder(c.paths) && Date.now() - lastKick > 4 * 60_000) {
      lastKick = Date.now();
      spawnDetached(c, ["tick"]);
    }
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
  if (brainEnv(c.cfg, c.paths).env.CLAUDE_CONFIG_DIR === c.paths.claudeConfig) purgeLocalTranscripts(c.paths.claudeConfig, true);
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

function statusText(c: Ctx): string {
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
  const d = decide(c.cfg, { now, meta: m, alarms: c.state.alarms(), unread: unreadLetters(c.state), lineFromBen: c.line?.unreadFromBen().length ?? 0, spentToday: c.ledger.spentToday(now), spentMonth: c.ledger.spentThisMonth(now) });
  lines.push(`next heartbeat would: ${d.wake ? `wake (${d.mode}: ${d.why})` : `sleep (${d.why})`}`);
  if (lockHolder(c.paths)) lines.push("awake right now");
  return lines.filter(Boolean).join("\n");
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
  if (labExists(c.cfg)) {
    const r = ensureLab(c.cfg);
    check(r.ok, `the lab (its Linux VM) is ${r.detail}`, "see ~/.lima/lab/ha.stderr.log, or rebuild it with scripts/install.sh --lab");
  } else console.log("· the lab: not set up (scripts/install.sh --lab)");
  const lineSecrets = loadLineSecrets(c.paths);
  if (!lineSecrets) console.log("· direct line: not set up (optional: scripts/install.sh --telegram)");
  else {
    check(!!c.line, "direct line is paired with Ben's Telegram", "run scripts/install.sh --telegram");
    try {
      const me = await (c.line?.tg ?? new (await import("./telegram.ts")).Telegram(lineSecrets.botToken)).getMe();
      check(true, `Telegram bot @${me.username} answers`);
    } catch (err) {
      check(false, "Telegram bot answers", (err as Error).message.slice(0, 120));
    }
    if (c.line) check(c.line.listenerAlive(), "the line's listener is running", "without it, messages are checked every heartbeat instead (install.sh --telegram sets it up)");
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
      console.log(statusText(c));
      break;
    case "doctor":
      process.exitCode = (await doctor(c)) ? 0 : 1;
      break;
    case "smoke":
      process.exitCode = (await smoke(c)) ? 0 : 1;
      break;
    case "pause":
      console.log(await requestControl(c, "pause", rest.join(" ") || null, "the command line"));
      break;
    case "resume":
      console.log(await requestControl(c, "resume", null, "the command line"));
      break;
    case "listen":
      await listen(c);
      break;
    case "line": {
      if (rest[0] !== "pair") {
        console.error("usage: line pair   (with the bot token on stdin)");
        process.exitCode = 2;
        break;
      }
      const token = (await readStdin()).trim() || loadLineSecrets(c.paths)?.botToken;
      if (!token) {
        console.error("no bot token: pipe it in (scripts/install.sh --telegram does this)");
        process.exitCode = 2;
        break;
      }
      await pair(c.paths, token, (s) => console.log(s));
      break;
    }
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
