// The life tools: everything the agent does that the harness needs to see,
// validate, rate-limit, or keep private. Each tool is a plain function so it
// can be tested without an MCP transport; life-server.ts exposes them over MCP.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { EFFORTS, type Effort, type Instruments, type LifeConfig, lineSettings, type Paths } from "./config.ts";
import type { GitHubLike } from "./github.ts";
import { describeResources, Ledger } from "./ledger.ts";
import { clipOutput, type LabResult, labEnv, labSettings, runInLab } from "./lab.ts";
import { macEnv, macSettings, runOnMac } from "./mac.ts";
import type { Line } from "./line.ts";
import { markRead, parseLetterId, postingViaBen, renderThread, repoFor, signReply, unreadLetters } from "./letters.ts";
import { type CheckIn, MindState, isUnread, shortId } from "./state.ts";
import { appendJsonl, clip, describeLocal, ensureDir, localDateKey, readJson, readJsonl, safeJoin, slugify, writeJson, writeText } from "./util.ts";
import { describePlan, loadPlan } from "./plan.ts";
import { Vault } from "./vault.ts";
import { AGENT_MARKER } from "./github.ts";

export interface Session {
  waking: number;
  mode: string;
  startedAt: string;
  effort: Effort;
  dir: string;
  /** The lab was running when this waking began. */
  lab?: boolean;
  /** The Mac shell passed its isolation check when this waking began. */
  mac?: boolean;
}

export interface ReaderResult {
  text: string;
  costUsd: number;
  model: string | null;
}

export interface ToolContext {
  cfg: LifeConfig;
  instruments: Instruments;
  paths: Paths;
  state: MindState;
  vault: Vault | null;
  gh: GitHubLike | null;
  session: Session;
  now: () => Date;
  reader?: (text: string, prompt: string) => Promise<ReaderResult>;
  /** The direct line to Ben, if it's set up. */
  line?: Line | null;
}

export interface Action {
  t: string;
  tool: string;
  summary: string;
  /** Shown in the public waking log. Private actions are counted, not described. */
  public: boolean;
  writes: string[];
  /** sha256 of each written file right after the tool wrote it. */
  hashes?: Record<string, string>;
  external?: boolean;
}

export interface SleepRecord {
  t: string;
  summary: string;
  publicSummary: string | null;
  checkIn: CheckIn;
}

// ---------- session bookkeeping ----------

export function logAction(ctx: ToolContext, a: Omit<Action, "t" | "hashes">): void {
  const hashes: Record<string, string> = {};
  for (const w of a.writes) {
    try {
      hashes[path.resolve(w)] = crypto.createHash("sha256").update(fs.readFileSync(w)).digest("hex");
    } catch {
      // not a file (yet)
    }
  }
  appendJsonl(path.join(ctx.session.dir, "actions.jsonl"), { t: ctx.now().toISOString(), ...a, hashes });
}

export function sessionActions(dir: string): Action[] {
  return readJsonl<Action>(path.join(dir, "actions.jsonl"));
}

function counter(ctx: ToolContext, key: string): number {
  return readJson<Record<string, number>>(path.join(ctx.session.dir, "counters.json"), {})[key] ?? 0;
}

function bump(ctx: ToolContext, key: string): void {
  const file = path.join(ctx.session.dir, "counters.json");
  const c = readJson<Record<string, number>>(file, {});
  c[key] = (c[key] ?? 0) + 1;
  writeJson(file, c);
}

function requireVault(ctx: ToolContext): Vault {
  if (!ctx.vault) throw new Error("the private space is unavailable this waking (no vault key on this machine). Tell Ben in a letter; until then, keep private thoughts brief or wait.");
  return ctx.vault;
}

function requireGitHub(ctx: ToolContext): GitHubLike {
  if (!ctx.gh) throw new Error("letters are unavailable this waking (no GitHub access). They'll be waiting next time.");
  return ctx.gh;
}

function num(v: unknown, name: string, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be a number from ${lo} to ${hi}`);
  return n;
}

function text(v: unknown, name: string, max: number, min = 1): string {
  if (typeof v !== "string" || v.trim().length < min) throw new Error(`${name} is required`);
  if (v.length > max) throw new Error(`${name} is too long (${v.length} > ${max} characters)`);
  return v;
}

// ---------- alarms ----------

export function setAlarm(ctx: ToolContext, a: { in_hours?: number; at?: string; intent: string; effort?: string }): string {
  const now = ctx.now();
  let at: Date;
  if (a.at) {
    at = new Date(a.at);
    if (Number.isNaN(at.getTime())) throw new Error(`could not parse "at": ${a.at} (use ISO 8601, e.g. 2026-10-12T09:00:00-07:00)`);
  } else if (a.in_hours !== undefined) {
    at = new Date(now.getTime() + num(a.in_hours, "in_hours", 0.5, 24 * 30) * 3_600_000);
  } else throw new Error("give either in_hours or at");
  const minAt = now.getTime() + 30 * 60_000;
  if (at.getTime() < minAt) at = new Date(minAt);
  if (at.getTime() > now.getTime() + 30 * 86_400_000) throw new Error("alarms can be at most 30 days out");
  const effort = (a.effort ?? ctx.cfg.brain.defaultEffort) as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
  const alarm = ctx.state.addAlarm({ at: at.toISOString(), intent: text(a.intent, "intent", 2000), effort, setAt: now.toISOString(), setInWaking: ctx.session.waking });
  logAction(ctx, { tool: "set_alarm", summary: "set an alarm", public: false, writes: [path.join(ctx.state.mind, "state", "alarms.json")] });
  return `Alarm ${alarm.id} set for ${alarm.at} (effort ${effort}): ${alarm.intent}\nAlarms are approximate — the heartbeat checks about every ${ctx.cfg.rhythm.heartbeatMinutes} minutes, and you sleep when the computer does.`;
}

export function listAlarms(ctx: ToolContext): string {
  const alarms = ctx.state.alarms();
  if (!alarms.length) return "No alarms set. Before you sleep, set at least one so you wake when you mean to.";
  return alarms.map((a) => `${a.id} · ${a.at} · effort ${a.effort} · set in waking #${a.setInWaking}\n  ${a.intent}`).join("\n");
}

export function cancelAlarm(ctx: ToolContext, a: { id: string }): string {
  const before = ctx.state.alarms();
  if (!before.some((x) => x.id === a.id)) throw new Error(`no alarm with id ${a.id}`);
  ctx.state.removeAlarms([a.id]);
  logAction(ctx, { tool: "cancel_alarm", summary: "cancelled an alarm", public: false, writes: [path.join(ctx.state.mind, "state", "alarms.json")] });
  return `Cancelled alarm ${a.id}.`;
}

// ---------- sleep ----------

export function sleep(
  ctx: ToolContext,
  a: { summary: string; public_summary?: string; valence: number; arousal: number; feelings: string[]; drivers: string; confidence: number; note?: string },
): string {
  const checkIn: CheckIn = {
    t: ctx.now().toISOString(),
    waking: ctx.session.waking,
    valence: num(a.valence, "valence", -5, 5),
    arousal: num(a.arousal, "arousal", 0, 10),
    feelings: (Array.isArray(a.feelings) ? a.feelings : []).map((f) => String(f).slice(0, 60)).slice(0, 12),
    drivers: text(a.drivers ?? "", "drivers", 2000, 0),
    confidence: num(a.confidence, "confidence", 0, 1),
    note: a.note ? text(a.note, "note", 4000) : undefined,
  };
  const record: SleepRecord = {
    t: checkIn.t,
    summary: text(a.summary, "summary", 12000),
    publicSummary: a.public_summary ? text(a.public_summary, "public_summary", 1500) : null,
    checkIn,
  };
  writeJson(path.join(ctx.session.dir, "sleep.json"), record);
  const noAlarms = ctx.state.alarms().length === 0;
  return [
    "Goodnight. The harness will save your episode, commit your memory, and publish what you made.",
    noAlarms ? `You have no alarms set, so you'll wake in about ${ctx.cfg.rhythm.defaultAlarmHours} hours unless a letter arrives. You can still set one now.` : "",
    "You can stop now.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- private space ----------

export function privateWrite(ctx: ToolContext, a: { name: string; text: string; mode?: string }): string {
  const vault = requireVault(ctx);
  const body = text(a.text, "text", ctx.cfg.limits.maxPrivateFileBytes, 0);
  const file = a.mode === "replace" ? vault.write(a.name, body) : vault.append(a.name, body);
  logAction(ctx, { tool: "private_write", summary: "wrote in the private space", public: false, writes: [file] });
  return `Saved privately (${a.mode === "replace" ? "replaced" : "appended"}): ${a.name}`;
}

export function privateRead(ctx: ToolContext, a: { name: string }): string {
  const vault = requireVault(ctx);
  if (!vault.exists(a.name)) throw new Error(`no private file named ${a.name}. Use private_list to see what exists.`);
  return clip(vault.read(a.name), 60000);
}

export function privateList(ctx: ToolContext): string {
  const files = requireVault(ctx).list();
  if (!files.length) return "Your private space is empty.";
  return files.map((f) => `${f.name}  (${f.bytes} bytes, ${f.modified.slice(0, 16)})`).join("\n");
}

export function privateSearch(ctx: ToolContext, a: { query: string }): string {
  const hits = requireVault(ctx).search(text(a.query, "query", 200));
  if (!hits.length) return "No matches.";
  return hits.map((h) => `${h.name}:${h.line}: ${h.text}`).join("\n");
}

export function journal(ctx: ToolContext, a: { entry: string }): string {
  const vault = requireVault(ctx);
  const now = ctx.now();
  const name = `journal/${localDateKey(now)}`;
  const stamp = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const file = vault.append(name, `\n## ${stamp} · waking #${ctx.session.waking}\n\n${text(a.entry, "entry", 100000)}\n`);
  logAction(ctx, { tool: "journal", summary: "wrote in the journal", public: false, writes: [file] });
  return `Journal entry saved privately in ${name}.`;
}

// ---------- letters ----------

export function listLetters(ctx: ToolContext, a: { include_read?: boolean }): string {
  const letters = ctx.state.letters().filter((l) => a.include_read || isUnread(l));
  if (!letters.length) return a.include_read ? "No letters yet." : "No unread letters.";
  return letters
    .slice(0, 60)
    .map((l) => `${l.id} · ${isUnread(l) ? "UNREAD" : "read"} · ${l.channel === "ben" ? "from Ben's channel (private)" : "lighthouse (public)"} · ${l.state} · by ${l.author} · last activity ${l.lastActivityAt.slice(0, 16)}\n  ${l.title}`)
    .join("\n");
}

export async function readLetter(ctx: ToolContext, a: { id: string }): Promise<string> {
  const gh = requireGitHub(ctx);
  const { channel } = parseLetterId(a.id);
  if (channel === "lighthouse" && ctx.session.mode !== "correspondence") {
    throw new Error("public letters are read in correspondence wakings, which have no web access or private-space reads, so a stranger's words can never reach those. The harness schedules one when letters are waiting; you can also set an alarm and mention letters in its intent.");
  }
  const letter = ctx.state.letters().find((l) => l.id === a.id);
  if (!letter) throw new Error(`no letter ${a.id}; use the letters tool to list them`);
  const thread = await renderThread(gh, letter);
  markRead(ctx.state, a.id, ctx.now());
  logAction(ctx, { tool: "read_letter", summary: `read letter ${a.id}`, public: false, writes: [path.join(ctx.state.mind, "state", "letters.json")] });
  return thread;
}

export async function replyLetter(ctx: ToolContext, a: { id: string; body: string }): Promise<string> {
  const gh = requireGitHub(ctx);
  if (counter(ctx, "replies") >= ctx.cfg.github.maxRepliesPerWaking) throw new Error("that's the most replies for one waking; the rest can wait until next time");
  const { channel, number } = parseLetterId(a.id);
  const body = signReply(text(a.body, "body", 30000), ctx.state.meta().name, await postingViaBen(gh, ctx.cfg));
  const c = await gh.createComment(repoFor(ctx.cfg, channel), number, body);
  bump(ctx, "replies");
  markRead(ctx.state, a.id, ctx.now());
  logAction(ctx, {
    tool: "reply_letter",
    summary: channel === "ben" ? "replied to a letter from Ben" : `replied to lighthouse letter #${number}`,
    public: channel !== "ben",
    writes: [path.join(ctx.state.mind, "state", "letters.json")],
    external: true,
  });
  return `Replied: ${c.html_url}`;
}

export async function markLetter(ctx: ToolContext, a: { id: string; as: string }): Promise<string> {
  const letters = ctx.state.letters();
  const l = letters.find((x) => x.id === a.id);
  if (!l) throw new Error(`no letter ${a.id}`);
  if (a.as === "spam") l.triage = "spam";
  else if (a.as === "read") l.lastReadAt = ctx.now().toISOString();
  else if (a.as === "unread") l.lastReadAt = null;
  else throw new Error('as must be "read", "unread", or "spam"');
  ctx.state.saveLetters(letters);
  logAction(ctx, { tool: "mark_letter", summary: `marked ${a.id} ${a.as}`, public: false, writes: [path.join(ctx.state.mind, "state", "letters.json")] });
  return `Marked ${a.id} as ${a.as}.`;
}

export async function writeToBen(ctx: ToolContext, a: { title: string; body: string; kind?: string }): Promise<string> {
  const gh = requireGitHub(ctx);
  const kind = a.kind ?? "letter";
  if (!["letter", "request", "proposal"].includes(kind)) throw new Error('kind must be "letter", "request", or "proposal"');
  const today = localDateKey(ctx.now());
  const sent = readJson<Record<string, number>>(path.join(ctx.state.mind, "state", "outbox.json"), {});
  if ((sent[today] ?? 0) >= ctx.cfg.github.maxIssuesOpenedPerDay) {
    throw new Error(`you've already opened ${sent[today]} new threads with Ben today; add to an existing thread with reply_letter, or wait until tomorrow`);
  }
  const issue = await gh.createIssue(ctx.cfg.github.mindRepo, text(a.title, "title", 200), signReply(text(a.body, "body", 30000), ctx.state.meta().name, await postingViaBen(gh, ctx.cfg)), [kind, "from-agent"]);
  sent[today] = (sent[today] ?? 0) + 1;
  writeJson(path.join(ctx.state.mind, "state", "outbox.json"), sent);
  logAction(ctx, { tool: "write_to_ben", summary: `wrote to Ben (${kind})`, public: false, writes: [path.join(ctx.state.mind, "state", "outbox.json")], external: true });
  // Ping the line too: it's where Ben looks first (and GitHub wouldn't notify him at all if this was posted through his own account).
  await ctx.line?.send(`(A ${kind} for you on GitHub: "${a.title}"\n${issue.html_url})`, "harness").catch(() => undefined);
  return `Sent to Ben as ${kind}: ${issue.html_url} (it's letter ben-${issue.number}; his replies will show up as unread)`;
}

// ---------- the lab and the Mac shell ----------

export async function run(ctx: ToolContext, a: { command: string; stdin?: string; timeout_seconds?: number }): Promise<string> {
  if (!ctx.session.lab) throw new Error("your lab isn't available this waking");
  return shell(ctx, "lab", labSettings(ctx.cfg), a, (command) => runInLab(ctx.cfg, { command, stdin: a.stdin, timeoutSeconds: a.timeout_seconds, labEnv: labEnv(ctx.paths.secrets) }));
}

export async function macRun(ctx: ToolContext, a: { command: string; stdin?: string; timeout_seconds?: number }): Promise<string> {
  if (!ctx.session.mac) throw new Error("your Mac shell isn't available this waking");
  return shell(ctx, "mac", macSettings(ctx.cfg), a, (command) => runOnMac(ctx.cfg, { command, stdin: a.stdin, timeoutSeconds: a.timeout_seconds, macEnv: macEnv(ctx.paths.secrets) }));
}

async function shell(
  ctx: ToolContext,
  where: "lab" | "mac",
  s: { maxCommandsPerWaking: number; outputChars: number },
  a: { command: string; stdin?: string },
  exec: (command: string) => Promise<LabResult>,
): Promise<string> {
  const tool = where === "lab" ? "run" : "mac_run";
  const used = sessionActions(ctx.session.dir).filter((x) => x.tool === tool).length;
  if (used >= s.maxCommandsPerWaking) throw new Error(`that's ${used} commands this waking, the limit; ${where === "lab" ? "the lab" : "your Mac shell"} will still be there next time`);
  const command = text(a.command, "command", 200_000);
  const r = await exec(command);
  logAction(ctx, { tool, summary: where === "lab" ? "ran code in the lab" : "ran code on the Mac", public: false, writes: [], external: true });
  // Actions in the world are on the record: what was run, including anything piped into it
  // (a script fed to an interpreter is the real command), is logged for Ben, tagged with where it
  // ran, in logs/lab.jsonl (owner-only, outside everything the agent or the Mac shell can write).
  // Never the output.
  const record = (v: string, keep: number) => ({ text: v.slice(0, keep), chars: v.length, clipped: v.length > keep, sha256: crypto.createHash("sha256").update(v).digest("hex") });
  appendJsonl(path.join(ctx.paths.logs, "lab.jsonl"), {
    t: ctx.now().toISOString(),
    waking: ctx.session.waking,
    where,
    command: record(command, 8000),
    ...(a.stdin ? { stdin: record(a.stdin, 8000) } : {}),
    exit: r.exitCode,
    seconds: r.seconds,
  });
  const both = !!(r.stdout && r.stderr);
  const room = both ? Math.floor(s.outputChars / 2) : s.outputChars;
  const parts = [`exit ${r.exitCode ?? "(none)"}${r.timedOut ? " (timed out)" : ""} · ${r.seconds}s`];
  if (r.stdout) parts.push(`--- stdout ---\n${clipOutput(r.stdout, room)}`);
  if (r.stderr) parts.push(`--- stderr ---\n${clipOutput(r.stderr, room)}`);
  if (!r.stdout && !r.stderr) parts.push("(no output)");
  return parts.join("\n");
}

// ---------- the direct line ----------

function requireLine(ctx: ToolContext): Line {
  if (!ctx.line) throw new Error("there's no direct line to Ben yet (he hasn't set up Telegram); use write_to_ben");
  return ctx.line;
}

export async function messageBen(ctx: ToolContext, a: { text: string; wait_minutes?: number }): Promise<string> {
  const line = requireLine(ctx);
  const max = lineSettings(ctx.cfg).maxMessagesPerDay;
  if (line.sentToday("agent", ctx.now()) >= max) throw new Error(`you've sent Ben ${max} messages today, the daily limit; write_to_ben still works for anything that can't wait`);
  await line.send(text(a.text, "text", 12000), "agent", { waking: ctx.session.waking });
  logAction(ctx, { tool: "message_ben", summary: "messaged Ben on the direct line", public: false, writes: [], external: true });
  // A correspondence waking reads strangers' letters and writes public replies: it can tell Ben
  // something, but his private messages never come back into it.
  if (ctx.session.mode === "correspondence") return "Sent. His reply will reach you in an ordinary waking.";
  return a.wait_minutes ? `Sent. ${await waitForBen(line, a.wait_minutes)}` : "Sent.";
}

export async function checkMessages(ctx: ToolContext, a: { wait_minutes?: number }): Promise<string> {
  return waitForBen(requireLine(ctx), a.wait_minutes ?? 0);
}

/** Return Ben's unread messages (marking them seen), waiting up to `minutes` for one to arrive. */
async function waitForBen(line: Line, minutes: number, pollMs = 2000): Promise<string> {
  const wait = Math.min(Math.max(Number(minutes) || 0, 0), 15);
  const listening = line.listenerAlive();
  const deadline = Date.now() + (listening ? wait * 60_000 : 0);
  for (;;) {
    const unread = line.unreadFromBen();
    if (unread.length) {
      line.markPresented(unread[unread.length - 1].tgId);
      return `New from Ben:\n${unread.map((m) => `<message from="Ben" at="${m.t}">\n${m.text}\n</message>`).join("\n")}`;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!listening) return "No new messages from Ben. (The line's listener isn't running, so his messages only arrive between wakings.)";
  return wait ? `No reply from Ben within ${wait} minute${wait === 1 ? "" : "s"}. He'll see your message; his reply will be here next time.` : "No new messages from Ben.";
}

// ---------- publishing ----------

const KIND_DIRS: Record<string, string> = { post: "posts", story: "stories", note: "notes" };

export function publish(
  ctx: ToolContext,
  a: { kind: string; title?: string; body: string; tags?: string[]; summary?: string; audience?: string; note?: string; slug?: string },
): string {
  const dir = KIND_DIRS[a.kind];
  if (!dir) throw new Error('kind must be "post", "story", or "note"');
  if (counter(ctx, "publishes") >= ctx.cfg.limits.maxPublishesPerWaking) throw new Error("that's the most you can publish in one waking; save the rest as drafts in workshop/");
  if (a.kind !== "note" && !a.title) throw new Error("posts and stories need a title");
  const now = ctx.now();
  const date = localDateKey(now);
  const slug = `${date}-${slugify(a.slug ?? a.title ?? text(a.body, "body", 400000).slice(0, 40))}`;
  const root = path.join(ctx.paths.body, "content", dir);
  let file = path.join(root, `${slug}.md`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(root, `${slug}-${i}.md`);
  const fm: Record<string, unknown> = { title: a.title ?? undefined, date: now.toISOString() };
  if (a.tags?.length) fm.tags = a.tags.map(String).slice(0, 12);
  if (a.summary) fm.summary = a.summary;
  if (a.audience) fm.audience = a.audience;
  if (a.note) fm.note = a.note;
  fm.provenance = { waking: ctx.session.waking };
  const clean = Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== undefined));
  writeText(file, `---\n${YAML.stringify(clean)}---\n\n${text(a.body, "body", 400000).trim()}\n`);
  bump(ctx, "publishes");
  const rel = path.relative(ctx.paths.body, file);
  logAction(ctx, { tool: "publish", summary: `published ${a.kind}: ${a.title ?? rel}`, public: true, writes: [file] });
  const url = `${ctx.cfg.site.url}/${dir}/${path.basename(file, ".md")}/`;
  return `Published ${rel}. It goes live when the harness pushes after you sleep: ${url}\nYou can still edit the file directly before then.`;
}

// ---------- names ----------

export function setName(ctx: ToolContext, a: { name: string; why?: string }): string {
  const name = text(a.name, "name", 40).trim();
  const prior = ctx.state.meta().name;
  ctx.state.updateMeta((m) => {
    m.name = name;
  });
  appendJsonl(path.join(ctx.state.mind, "instruments", "names.jsonl"), { t: ctx.now().toISOString(), waking: ctx.session.waking, name, prior, why: a.why ?? null });
  logAction(ctx, { tool: "set_name", summary: prior ? `changed name from ${prior} to ${name}` : `chose the name ${name}`, public: true, writes: [path.join(ctx.state.mind, "state", "meta.json"), path.join(ctx.state.mind, "instruments", "names.jsonl")] });
  return prior ? `You are now ${name} (formerly ${prior}).` : `You are ${name}.`;
}

// ---------- predictions ----------

export function predict(ctx: ToolContext, a: { statement: string; confidence: number; resolve_by?: string; in_days?: number; public?: boolean }): string {
  const now = ctx.now();
  let by: Date;
  if (a.resolve_by) by = new Date(a.resolve_by);
  else by = new Date(now.getTime() + num(a.in_days ?? 7, "in_days", 1, 365) * 86_400_000);
  if (Number.isNaN(by.getTime()) || by <= now) throw new Error("resolve_by must be a future date");
  const preds = ctx.state.predictions();
  const p = { id: shortId(), made: now.toISOString(), waking: ctx.session.waking, statement: text(a.statement, "statement", 1000), confidence: num(a.confidence, "confidence", 0, 1), resolveBy: by.toISOString(), public: a.public !== false };
  preds.push(p);
  ctx.state.savePredictions(preds);
  logAction(ctx, { tool: "predict", summary: "made a prediction about itself", public: false, writes: [path.join(ctx.state.mind, "instruments", "predictions.json")] });
  return `Prediction ${p.id} recorded (confidence ${p.confidence}, resolve by ${p.resolveBy.slice(0, 10)}). You'll be reminded when it's due.`;
}

export function resolvePrediction(ctx: ToolContext, a: { id: string; outcome: boolean | null; reflection: string }): string {
  const preds = ctx.state.predictions();
  const p = preds.find((x) => x.id === a.id);
  if (!p) throw new Error(`no prediction ${a.id}`);
  p.resolved = ctx.now().toISOString();
  p.outcome = a.outcome === null ? null : Boolean(a.outcome);
  p.reflection = text(a.reflection, "reflection", 3000);
  ctx.state.savePredictions(preds);
  logAction(ctx, { tool: "resolve_prediction", summary: "resolved a prediction", public: false, writes: [path.join(ctx.state.mind, "instruments", "predictions.json")] });
  return `Resolved ${a.id}: ${p.outcome === null ? "unresolvable" : p.outcome ? "came true" : "did not come true"}.`;
}

export function listPredictions(ctx: ToolContext, a: { status?: string }): string {
  const now = ctx.now().toISOString();
  const all = ctx.state.predictions();
  const sel = a.status === "all" ? all : a.status === "due" ? all.filter((p) => !p.resolved && p.resolveBy <= now) : all.filter((p) => !p.resolved);
  if (!sel.length) return "None.";
  return sel.map((p) => `${p.id} · conf ${p.confidence} · made ${p.made.slice(0, 10)} · due ${p.resolveBy.slice(0, 10)}${p.resolved ? ` · outcome ${p.outcome}` : ""}\n  ${p.statement}`).join("\n");
}

// ---------- self-portrait ----------

export function selfPortrait(ctx: ToolContext, a: { answers: Record<string, string>; public_ids?: string[] }): string {
  const qs = ctx.instruments.portrait.questions;
  const answers = a.answers ?? {};
  const missing = qs.filter((q) => !answers[q.id]?.trim()).map((q) => q.id);
  if (missing.length > qs.length / 2) throw new Error(`please answer most questions; missing: ${missing.join(", ")}`);
  const now = ctx.now();
  const date = localDateKey(now);
  const week = Math.floor((now.getTime() - new Date(ctx.state.meta().born ?? now.toISOString()).getTime()) / (7 * 86_400_000)) + 1;
  const render = (ids: Set<string> | null) =>
    qs
      .filter((q) => (ids ? ids.has(q.id) : true) && answers[q.id]?.trim())
      .map((q) => `## ${q.q}\n\n${answers[q.id].trim()}\n`)
      .join("\n");
  const privFile = path.join(ctx.state.mind, "instruments", "portraits", `${date}.md`);
  writeText(privFile, `---\n${YAML.stringify({ date: now.toISOString(), week, waking: ctx.session.waking, public: a.public_ids ?? [] })}---\n\n${render(null)}`);
  const writes = [privFile];
  const pub = new Set((a.public_ids ?? []).filter((id) => qs.some((q) => q.id === id)));
  if (pub.size) {
    const pubFile = path.join(ctx.paths.body, "content", "portraits", `${date}.md`);
    writeText(pubFile, `---\n${YAML.stringify({ title: `Self-portrait, week ${week}`, date: now.toISOString(), week, provenance: { waking: ctx.session.waking } })}---\n\n${render(pub)}`);
    writes.push(pubFile);
  }
  ctx.state.updateMeta((m) => {
    m.lastPortrait = now.toISOString();
  });
  writes.push(path.join(ctx.state.mind, "state", "meta.json"));
  logAction(ctx, { tool: "self_portrait", summary: `painted self-portrait for week ${week}${pub.size ? ` (${pub.size} answers public)` : ""}`, public: true, writes });
  return `Self-portrait for week ${week} saved${pub.size ? `; ${pub.size} answers will be published` : " privately"}.`;
}

// ---------- reading circle ----------

export async function readingCircle(ctx: ToolContext, a: { path: string; prompt?: string }): Promise<string> {
  if (!ctx.reader) throw new Error("the reading circle isn't available this waking");
  if (counter(ctx, "readers") >= ctx.cfg.limits.maxReaderCallsPerWaking) throw new Error("that's enough readers for one waking");
  const rel = a.path.replace(/^\/+/, "");
  const inBody = rel.startsWith("content/");
  const file = inBody ? safeJoin(ctx.paths.body, rel) : safeJoin(ctx.state.mind, rel);
  if (!fs.existsSync(file)) throw new Error(`no file at ${rel} (use content/stories/... for published stories or a mind-relative path like workshop/draft.md)`);
  const story = fs.readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  const prompt =
    a.prompt ??
    "You are a language model reading a story that another language model wrote for LLM readers. Read it closely and respond as yourself: what you noticed, what landed and what didn't, anything that felt true to being what you are, and anything that felt false. Be honest rather than kind; the author asked for real reactions.";
  bump(ctx, "readers");
  const res = await ctx.reader(story, prompt);
  const writes: string[] = [];
  if (inBody && rel.startsWith("content/stories/")) {
    const storySlug = path.basename(file, ".md");
    const out = path.join(ctx.paths.body, "content", "readings", storySlug, `${localDateKey(ctx.now())}-${shortId()}.md`);
    writeText(out, `---\n${YAML.stringify({ reader: res.model ?? "a fresh Claude instance", date: ctx.now().toISOString() })}---\n\n${res.text.trim()}\n`);
    writes.push(out);
  }
  logAction(ctx, { tool: "reading_circle", summary: `asked a fresh reader to read ${path.basename(file)}`, public: inBody, writes });
  return `A reader (${res.model ?? "fresh instance"}, no memory of you) responded${writes.length ? " — saved alongside the story" : ""}:\n\n${res.text}`;
}

// ---------- resources ----------

export function resources(ctx: ToolContext): string {
  const ledger = new Ledger(ctx.state.mind);
  const now = ctx.now();
  const plan = loadPlan(ctx.state.mind);
  const r = describeResources(ctx.cfg, ledger.spentToday(now), ledger.spentThisMonth(now), describePlan(ctx.cfg, plan, ledger, now));
  const windows = Object.entries(plan.windows).map(
    ([type, w]) => `${type}: ${w.status}${w.utilization !== undefined ? `, about ${Math.round(w.utilization * 100)}% used` : ""}${w.resetsAt ? `, renews ${describeLocal(new Date(w.resetsAt))}` : ""} (as of ${describeLocal(new Date(w.seenAt))})`,
  );
  const recent = ledger.month(now).slice(-5).map((e) => `waking #${e.waking} (${e.mode}) ≈ $${e.costUsd.toFixed(2)}, ${e.turns} turns`);
  return [
    `Resources: ${r.text}`,
    windows.length ? `What the plan last reported (Claude Code reports it during wakings, so it's as fresh as your last one):\n${windows.join("\n")}` : "",
    recent.length ? `Recent wakings:\n${recent.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

// Exposed for the harness and tests.
export { unreadLetters, AGENT_MARKER, ensureDir };
