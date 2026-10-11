import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { buildSettings } from "./brain.ts";
import { loadConfig, loadInstruments } from "./config.ts";
import { checkMessages, messageBen, type ToolContext } from "./life-tools.ts";
import { HELP_TEXT, Line, loadLineSecrets, pair, parseCommand, renderConversation } from "./line.ts";
import { MindState } from "./state.ts";
import { chunkText, Telegram, type TelegramLike, type TgMessage, type TgUpdate } from "./telegram.ts";
import { makeHome, REPO } from "./test/helpers.ts";

const BEN = { chatId: 4242, userId: 4242 };

class FakeTelegram implements TelegramLike {
  updates: TgUpdate[] = [];
  sent: { chatId: number; text: string }[] = [];
  private nextId = 1000;
  private nextUpdate = 1;

  async getMe() {
    return { id: 1, is_bot: true, username: "home_bot" };
  }
  async getUpdates(offset: number) {
    return this.updates.filter((u) => u.update_id >= offset);
  }
  async sendMessage(chatId: number, text: string): Promise<TgMessage[]> {
    this.sent.push({ chatId, text });
    return [{ message_id: this.nextId++, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" } }];
  }
  /** A message arriving from someone (Ben by default). */
  incoming(text: string | undefined, from = BEN.userId, chat = BEN.chatId, extra: Partial<TgMessage> = {}): void {
    const id = this.nextId++;
    this.updates.push({ update_id: this.nextUpdate++, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "private" }, from: { id: from, is_bot: false, first_name: "Ben" }, text, ...extra } });
  }
}

function pairedLine(): { line: Line; tg: FakeTelegram; paths: ReturnType<typeof makeHome>["paths"] } {
  const { paths } = makeHome();
  const tg = new FakeTelegram();
  const line = new Line(paths.line, { botToken: "t", ...BEN }, tg);
  return { line, tg, paths };
}

test("long texts split under Telegram's limit, on paragraph breaks when possible", () => {
  const para = "word ".repeat(300).trim();
  const chunks = chunkText([para, para, para, para].join("\n\n"), 4000);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 4000));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), [para, para, para, para].join(" "));
});

test("commands: known ones parse; /start is help; anything else is a message", () => {
  assert.deepEqual(parseCommand("/pause going away for the weekend"), { name: "pause", args: "going away for the weekend" });
  assert.deepEqual(parseCommand("/status@home_bot"), { name: "status", args: "" });
  assert.deepEqual(parseCommand("/start abc123"), { name: "help", args: "" });
  assert.equal(parseCommand("/shrug"), null);
  assert.equal(parseCommand("hello /status"), null);
});

test("only Ben's private chat gets through; his texts are kept once, in order", async () => {
  const { line, tg } = pairedLine();
  tg.incoming("hi from a stranger", 999, 999);
  tg.incoming("Morning! How did the story go?");
  tg.incoming("/status");
  tg.incoming(undefined, BEN.userId, BEN.chatId, { photo: [{}], caption: "the view from here" });
  const events = await line.poll(0);
  assert.deepEqual(events.map((e) => e.type), ["message", "command", "message"]);
  const unread = line.unreadFromBen();
  assert.equal(unread.length, 2);
  assert.equal(unread[0].text, "Morning! How did the story go?");
  assert.match(unread[1].text, /a photo.*the view from here/);
  assert.ok(!line.log().some((m) => m.text.includes("stranger")), "strangers' messages are dropped unread");
  // The offset moved past everything, so a second poll is empty and nothing is kept twice.
  assert.deepEqual(await line.poll(0), []);
  assert.equal(line.log().length, 2);
});

test("seen and notified marks move forward only", async () => {
  const { line, tg } = pairedLine();
  tg.incoming("one");
  tg.incoming("two");
  await line.poll(0);
  const [one, two] = line.unreadFromBen();
  line.markPresented(two.tgId);
  line.markPresented(one.tgId);
  assert.equal(line.unreadFromBen().length, 0);
  tg.incoming("three");
  await line.poll(0);
  assert.deepEqual(line.unnotified().map((m) => m.text), ["three"]);
  line.markNotified(line.unnotified()[0].tgId);
  assert.equal(line.unnotified().length, 0);
  assert.equal(line.unreadFromBen().length, 1, "notifying Ben of a delay doesn't mean the agent saw it");
});

test("the conversation renders with new messages marked", async () => {
  const { line, tg } = pairedLine();
  tg.incoming("are you there?");
  await line.poll(0);
  await line.send("I'm here.", "agent", { waking: 3 });
  await line.send("(status reply)", "harness", { record: false });
  tg.incoming("good :)");
  await line.poll(0);
  const text = renderConversation(line.log(), line.unreadFromBen()[0].tgId - 1, 10);
  assert.match(text, /from="Ben"[^>]*>\nare you there\?/);
  assert.match(text, /from="you"[^>]*>\nI'm here\./);
  assert.match(text, /from="Ben"[^>]* new="true">\ngood :\)/);
  assert.ok(!text.includes("status reply"), "harness command replies aren't part of the conversation");
});

test("pairing accepts only the /start code it printed, and saves Ben's chat", async () => {
  const { paths } = makeHome();
  const tg = new FakeTelegram();
  tg.incoming("/start wrongcode", 7, 7);
  const out: string[] = [];
  const secrets = await pair(paths, "bot-token", (s) => {
    out.push(s);
    const code = /start=(\w+)/.exec(s)?.[1];
    if (code) tg.incoming(`/start ${code}`);
  }, tg, 1);
  assert.equal(secrets.chatId, BEN.chatId);
  assert.equal(loadLineSecrets(paths)?.userId, BEN.userId);
  assert.equal((fs.statSync(path.join(paths.secrets, "telegram.json")).mode & 0o777).toString(8), "600");
  assert.match(tg.sent[0].text, /Paired/);
  assert.ok(tg.sent[0].text.includes(HELP_TEXT));
  // The pairing message is consumed, not delivered to the agent later.
  const line = Line.open(paths, tg)!;
  assert.deepEqual(await line.poll(0), []);
});

function toolContext(paths: ReturnType<typeof makeHome>["paths"], line: Line): ToolContext {
  return {
    cfg: loadConfig(REPO),
    instruments: loadInstruments(REPO),
    paths,
    state: new MindState(paths.mind),
    vault: null,
    gh: null,
    session: { waking: 7, mode: "ordinary", startedAt: new Date().toISOString(), effort: "medium", dir: fs.mkdtempSync(path.join(paths.home, "session-")) },
    now: () => new Date(),
    line,
  };
}

test("message_ben sends, waits for a reply, and respects the daily limit", async () => {
  const { line, tg, paths } = pairedLine();
  const ctx = toolContext(paths, line);
  line.touchAlive();
  setTimeout(() => {
    tg.incoming("Yes! Go for it.");
    void line.poll(0);
  }, 300);
  const res = await messageBen(ctx, { text: "Could I have an email address of my own?", wait_minutes: 0.2 });
  assert.match(res, /Sent\. New from Ben:/);
  assert.match(res, /Go for it/);
  assert.equal(tg.sent[0].text, "Could I have an email address of my own?");
  assert.equal(line.log().find((m) => m.from === "agent")?.waking, 7);
  assert.equal(line.unreadFromBen().length, 0, "replies returned by the tool count as seen");
  assert.match(await checkMessages(ctx, {}), /No new messages/);

  ctx.cfg.line = { ...ctx.cfg.line!, maxMessagesPerDay: 1 };
  await assert.rejects(messageBen(ctx, { text: "one more" }), /daily limit/);
});

test("without a listener, waiting returns at once and says why", async () => {
  const { line, paths } = pairedLine();
  const started = Date.now();
  const res = await checkMessages(toolContext(paths, line), { wait_minutes: 10 });
  assert.ok(Date.now() - started < 1000);
  assert.match(res, /listener isn't running/);
});

test("the Telegram client speaks the Bot API and keeps the token out of errors", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      calls.push({ url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/getMe")) return res.end(JSON.stringify({ ok: false, description: "Unauthorized" }));
      res.end(JSON.stringify({ ok: true, result: { message_id: calls.length, date: 1, chat: { id: body.chat_id, type: "private" } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const tg = new Telegram("SECRET-TOKEN", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const sent = await tg.sendMessage(4242, `${"a".repeat(3990)} ${"b".repeat(100)}`);
    assert.equal(sent.length, 2);
    assert.equal(calls[0].url, "/botSECRET-TOKEN/sendMessage");
    assert.equal(calls[0].body.chat_id, 4242);
    assert.equal(calls[0].body.parse_mode, undefined, "plain text only");
    await assert.rejects(tg.getMe(), (err: Error) => /Unauthorized/.test(err.message) && !err.message.includes("SECRET"));
  } finally {
    server.close();
  }
});

test("the agent can't read or write the line's files directly", () => {
  const { paths } = makeHome();
  const s = buildSettings(paths) as { permissions: { deny: string[] } };
  assert.ok(s.permissions.deny.includes(`Read(/${paths.line}/**)`));
  assert.ok(s.permissions.deny.includes(`Write(/${paths.line}/**)`));
});
