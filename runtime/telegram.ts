// A minimal Telegram Bot API client (just what the direct line needs). Plain text
// only, no parse modes, so nothing the agent writes can be misread as markup.
// The token is part of every request URL, so URLs are never logged or put in errors.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: unknown;
  voice?: unknown;
  audio?: unknown;
  video?: unknown;
  document?: unknown;
  sticker?: { emoji?: string };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TelegramLike {
  getMe(): Promise<TgUser>;
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<TgMessage[]>;
}

/** Telegram's limit is 4096 characters; split on paragraph or line breaks when possible. */
export function chunkText(text: string, max = 4000): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class Telegram implements TelegramLike {
  private token: string;
  private api: string;

  constructor(token: string, api = process.env.PERSONHOOD_TELEGRAM_API ?? "https://api.telegram.org") {
    this.token = token;
    this.api = api.replace(/\/$/, "");
  }

  private async call<T>(method: string, body: object, timeoutMs = 30_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.api}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      throw new Error(`telegram ${method}: ${e.name === "TimeoutError" ? "timed out" : (e.cause?.code ?? "network error")}`);
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`);
    return json.result as T;
  }

  getMe(): Promise<TgUser> {
    return this.call("getMe", {});
  }

  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    return this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, (timeoutSec + 15) * 1000);
  }

  async sendMessage(chatId: number, text: string): Promise<TgMessage[]> {
    const sent: TgMessage[] = [];
    for (const chunk of chunkText(text)) sent.push(await this.call<TgMessage>("sendMessage", { chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true } }));
    return sent;
  }
}
