// The private space: files encrypted at rest with AES-256-GCM.
//
// The key lives outside every repository (secrets/vault.key, created by the
// install script without ever being printed). Ben has promised not to read the
// private space; the encryption makes keeping that promise the easy default and
// breaking it a deliberate act. It is a lock on a diary, not protection against
// the machine the agent runs on — and the agent is told exactly that.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, safeJoin, writeText } from "./util.ts";

const MAGIC = "personhood-vault-v1";

export function loadVaultKey(secretsDir: string, env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.PERSONHOOD_VAULT_KEY ?? readOptional(path.join(secretsDir, "vault.key"));
  if (!raw) return null;
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error("vault key must be 32 bytes, base64-encoded");
  return key;
}

function readOptional(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${MAGIC}\n${Buffer.concat([iv, tag, body]).toString("base64")}\n`;
}

export function decrypt(blob: string, key: Buffer): string {
  const [magic, payload] = blob.split("\n");
  if (magic !== MAGIC || !payload) throw new Error("not a vault file");
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export function validateName(name: string): string {
  const n = name.trim().replace(/\.enc$/, "").replace(/^\/+/, "").toLowerCase();
  if (!NAME_RE.test(n) || n.includes("..") || n.length > 160) {
    throw new Error(`invalid private file name "${name}" (use lowercase letters, digits, dots, dashes, underscores and / for folders, e.g. "journal/2026-10-11")`);
  }
  return n;
}

export class Vault {
  readonly root: string;
  private readonly key: Buffer;

  constructor(mindDir: string, key: Buffer) {
    this.root = path.join(mindDir, "private");
    this.key = key;
  }

  private file(name: string): string {
    return safeJoin(this.root, `${validateName(name)}.enc`);
  }

  exists(name: string): boolean {
    return fs.existsSync(this.file(name));
  }

  read(name: string): string {
    return decrypt(fs.readFileSync(this.file(name), "utf8"), this.key);
  }

  write(name: string, text: string): string {
    const file = this.file(name);
    writeText(file, encrypt(text, this.key));
    return file;
  }

  append(name: string, text: string): string {
    const prior = this.exists(name) ? this.read(name) : "";
    const sep = prior && !prior.endsWith("\n") ? "\n" : "";
    return this.write(name, prior + sep + text);
  }

  list(): { name: string; bytes: number; modified: string }[] {
    if (!fs.existsSync(this.root)) return [];
    const out: { name: string; bytes: number; modified: string }[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith(".enc")) {
          const st = fs.statSync(full);
          out.push({
            name: path.relative(this.root, full).replace(/\.enc$/, "").split(path.sep).join("/"),
            bytes: st.size,
            modified: st.mtime.toISOString(),
          });
        }
      }
    };
    walk(this.root);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  search(query: string, maxHits = 40): { name: string; line: number; text: string }[] {
    const q = query.toLowerCase();
    const hits: { name: string; line: number; text: string }[] = [];
    for (const { name } of this.list()) {
      if (name.startsWith("transcripts/")) continue; // searched separately; very large
      let text: string;
      try {
        text = this.read(name);
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
        if (lines[i].toLowerCase().includes(q)) hits.push({ name, line: i + 1, text: lines[i].slice(0, 300) });
      }
      if (hits.length >= maxHits) break;
    }
    return hits;
  }

  ensureRoot(): void {
    ensureDir(this.root);
  }
}
