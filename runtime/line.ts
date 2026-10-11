// The direct line: a private Telegram chat between Ben and the agent.
//
// A bot that Ben creates is paired with his Telegram account once (install.sh --telegram);
// after that only messages from his private chat are accepted, and anything else is ignored
// unread. The conversation lives in ~/personhood/line (outside both repos, out of the
// agent's reach, so a listener can write to it while a waking is in progress) and is
// mirrored into the mind's state/ after wakings.
//
// Messages from Ben wake the agent (see stimuli.ts). Commands (/status, /pause, /resume,
// /wake, /help) are answered by the harness and never reach the agent.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Paths } from "./config.ts";
import { Telegram, type TelegramLike, type TgMessage, type TgUpdate } from "./telegram.ts";
import { appendJsonl, ensureDir, localDateKey, readJson, readJsonl, writeJson } from "./util.ts";

export interface LineSecrets {
  botToken: string;
  botUsername?: string;
  chatId?: number;
  userId?: number;
}

export interface LineMessage {
  /** Telegram message id; increases through the chat, so it orders messages both ways. */
  tgId: number;
  t: string;
  from: "ben" | "agent" | "harness";
  text: string;
  waking?: number;
}

interface LineState {
  offset: number;
  /** The newest message from Ben that the agent has been shown. */
  presentedThrough: number;
  /** The newest message from Ben that the harness has sent an "it can't wake right now" note about. */
  notifiedThrough: number;
}

export const COMMANDS = ["status", "pause", "resume", "wake", "help"] as const;
export type Command = (typeof COMMANDS)[number];

export type LineEvent =
  | { type: "message"; msg: LineMessage; media: boolean }
  | { type: "command"; name: Command; args: string };

export const HELP_TEXT = [
  "This is a private line to the agent. Write anything and it will read it when it wakes (messages from you wake it).",
  "",
  "Commands, answered right away by the harness:",
  "/status: how it is and what it's doing",
  "/pause [reason]: stop waking it until /resume",
  "/resume: carry on (also clears a rest after a usage limit)",
  "/wake: wake it now",
  "/help: this message",
].join("\n");

export function secretsFile(paths: Paths): string {
  return path.join(paths.secrets, "telegram.json");
}

export function loadLineSecrets(paths: Paths): LineSecrets | null {
  const s = readJson<LineSecrets | null>(secretsFile(paths), null);
  return s?.botToken ? s : null;
}

export function saveLineSecrets(paths: Paths, s: LineSecrets): void {
  ensureDir(paths.secrets);
  writeJson(secretsFile(paths), s);
  fs.chmodSync(secretsFile(paths), 0o600);
}

function mediaLabel(m: TgMessage): string | null {
  if (m.photo) return "a photo";
  if (m.voice || m.audio) return "a voice message";
  if (m.video) return "a video";
  if (m.document) return "a file";
  if (m.sticker) return `a sticker${m.sticker.emoji ? ` (${m.sticker.emoji})` : ""}`;
  return null;
}

/** Split "/pause@my_bot going away" into a known command and its arguments, or null. */
export function parseCommand(text: string): { name: Command; args: string } | null {
  const m = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  // Tapping Start again (or a pairing link) just gets the help text.
  if (name === "start") return { name: "help", args: "" };
  return (COMMANDS as readonly string[]).includes(name) ? { name: name as Command, args: (m[2] ?? "").trim() } : null;
}

export class Line {
  readonly dir: string;
  readonly secrets: LineSecrets;
  readonly tg: TelegramLike;

  constructor(dir: string, secrets: LineSecrets, tg?: TelegramLike) {
    this.dir = dir;
    this.secrets = secrets;
    this.tg = tg ?? new Telegram(secrets.botToken);
    ensureDir(dir);
  }

  /** The paired line, or null if Telegram isn't set up (or not paired yet). */
  static open(paths: Paths, tg?: TelegramLike): Line | null {
    const s = loadLineSecrets(paths);
    if (!s?.chatId || !s.userId) return null;
    return new Line(paths.line, s, tg);
  }

  private get logFile(): string {
    return path.join(this.dir, "log.jsonl");
  }
  private get stateFile(): string {
    return path.join(this.dir, "state.json");
  }
  private get aliveFile(): string {
    return path.join(this.dir, "listener.alive");
  }

  log(): LineMessage[] {
    return readJsonl<LineMessage>(this.logFile);
  }

  state(): LineState {
    return { offset: 0, presentedThrough: 0, notifiedThrough: 0, ...readJson<Partial<LineState>>(this.stateFile, {}) };
  }

  private updateState(fn: (s: LineState) => void): void {
    const s = this.state();
    fn(s);
    writeJson(this.stateFile, s);
  }

  private record(m: LineMessage): boolean {
    if (this.log().some((x) => x.tgId === m.tgId)) return false;
    appendJsonl(this.logFile, m);
    return true;
  }

  /** Send a message to Ben. Harness notes that aren't part of the conversation pass record: false. */
  async send(text: string, from: "agent" | "harness", opts: { waking?: number; record?: boolean } = {}): Promise<LineMessage> {
    const sent = await this.tg.sendMessage(this.secrets.chatId!, text);
    const last = sent[sent.length - 1];
    const m: LineMessage = { tgId: last?.message_id ?? 0, t: new Date((last?.date ?? Date.now() / 1000) * 1000).toISOString(), from, text, ...(opts.waking ? { waking: opts.waking } : {}) };
    if (opts.record !== false) this.record(m);
    return m;
  }

  unreadFromBen(): LineMessage[] {
    const through = this.state().presentedThrough;
    return this.log().filter((m) => m.from === "ben" && m.tgId > through);
  }

  setOffset(offset: number): void {
    this.updateState((s) => {
      s.offset = Math.max(s.offset, offset);
    });
  }

  markPresented(throughTgId: number): void {
    this.updateState((s) => {
      s.presentedThrough = Math.max(s.presentedThrough, throughTgId);
    });
  }

  /** Messages from Ben the harness hasn't yet explained a delay for. */
  unnotified(): LineMessage[] {
    const s = this.state();
    return this.unreadFromBen().filter((m) => m.tgId > s.notifiedThrough);
  }

  markNotified(throughTgId: number): void {
    this.updateState((s) => {
      s.notifiedThrough = Math.max(s.notifiedThrough, throughTgId);
    });
  }

  sentToday(from: LineMessage["from"], now = new Date()): number {
    const today = localDateKey(now);
    return this.log().filter((m) => m.from === from && localDateKey(new Date(m.t)) === today).length;
  }

  /** Is a long-polling listener feeding this line? */
  listenerAlive(now = Date.now()): boolean {
    try {
      return now - fs.statSync(this.aliveFile).mtimeMs < 3 * 60_000;
    } catch {
      return false;
    }
  }

  touchAlive(): void {
    fs.writeFileSync(this.aliveFile, String(process.pid));
  }

  /** Fetch new updates, keep Ben's messages, and return what happened. Everything else is dropped unread. */
  async poll(timeoutSec = 0): Promise<LineEvent[]> {
    const updates = await this.tg.getUpdates(this.state().offset, timeoutSec);
    const events: LineEvent[] = [];
    for (const u of updates) {
      const ev = this.classify(u);
      const fresh = ev?.type !== "message" || this.record(ev.msg);
      if (ev && fresh) events.push(ev);
      this.setOffset(u.update_id + 1);
    }
    return events;
  }

  private classify(u: TgUpdate): LineEvent | null {
    const m = u.message;
    if (!m || m.chat.type !== "private" || m.chat.id !== this.secrets.chatId || m.from?.id !== this.secrets.userId) return null;
    const text = m.text ?? "";
    const cmd = text ? parseCommand(text) : null;
    if (cmd) return { type: "command", ...cmd };
    const media = mediaLabel(m);
    const body = media ? `[Ben sent ${media}, which can't come through the line yet${m.caption ? `, with the caption: ${m.caption}` : ""}]` : text;
    if (!body.trim()) return null;
    return { type: "message", media: !!media, msg: { tgId: m.message_id, t: new Date(m.date * 1000).toISOString(), from: "ben", text: body } };
  }

  /** Copy the conversation into the mind, so it's kept with the rest of its memory. */
  mirror(mind: string): void {
    if (!fs.existsSync(this.logFile)) return;
    ensureDir(path.join(mind, "state"));
    fs.copyFileSync(this.logFile, path.join(mind, "state", "line.jsonl"));
  }
}

/** Render the recent conversation for a waking: the last few exchanges, with what's new marked. */
export function renderConversation(log: LineMessage[], presentedThrough: number, keep: number): string {
  const recent = log.slice(-keep);
  if (!recent.length) return "";
  const lines = recent.map((m) => {
    const who = m.from === "ben" ? "Ben" : m.from === "agent" ? "you" : "harness";
    const isNew = m.from === "ben" && m.tgId > presentedThrough;
    return `<message from="${who}" at="${m.t}"${isNew ? ' new="true"' : ""}>\n${m.text}\n</message>`;
  });
  const older = log.length - recent.length;
  return [older > 0 ? `(${older} earlier message${older > 1 ? "s" : ""} in mind/state/line.jsonl)` : "", ...lines].filter(Boolean).join("\n");
}

// ---------- pairing ----------

export function pairingCode(): string {
  return crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "x");
}

/** Find the private chat that sent "/start <code>". */
export function findPairing(updates: TgUpdate[], code: string): { chatId: number; userId: number; name: string } | null {
  for (const u of updates) {
    const m = u.message;
    if (!m || m.chat.type !== "private" || !m.from || m.from.is_bot) continue;
    if ((m.text ?? "").trim() === `/start ${code}`) return { chatId: m.chat.id, userId: m.from.id, name: m.from.first_name ?? m.from.username ?? "you" };
  }
  return null;
}

/** Interactive pairing, run by install.sh --telegram. */
export async function pair(paths: Paths, botToken: string, out: (s: string) => void, tg: TelegramLike = new Telegram(botToken), waitMinutes = 15): Promise<LineSecrets> {
  const me = await tg.getMe();
  const code = pairingCode();
  out(`Bot found: @${me.username}.`);
  out(`On your phone, open this link and tap Start:\n\n    https://t.me/${me.username}?start=${code}\n\n(or send @${me.username} the message: /start ${code})\nWaiting for you...`);
  let offset = 0;
  const deadline = Date.now() + waitMinutes * 60_000;
  while (Date.now() < deadline) {
    const updates = await tg.getUpdates(offset, 20);
    if (updates.length) offset = updates[updates.length - 1].update_id + 1;
    const found = findPairing(updates, code);
    if (found) {
      const secrets: LineSecrets = { botToken, botUsername: me.username, chatId: found.chatId, userId: found.userId };
      saveLineSecrets(paths, secrets);
      // Confirm the updates so the pairing message isn't delivered to the agent later.
      await tg.getUpdates(offset, 0);
      const line = new Line(paths.line, secrets, tg);
      line.setOffset(offset);
      await line.send(`Paired. This is now a private line between you and the agent.\n\n${HELP_TEXT}`, "harness", { record: false });
      out(`Paired with ${found.name}.`);
      return secrets;
    }
  }
  throw new Error(`no /start ${code} arrived within ${waitMinutes} minutes; run install.sh --telegram again`);
}
