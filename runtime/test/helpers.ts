import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "../config.ts";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function tmp(prefix = "personhood-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function gitInit(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
}

export function gitCommitAll(dir: string, msg = "init"): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], { cwd: dir });
}

/** A throwaway home: a body (copy of the real config/constitution) and a seeded mind, both git repos. */
export function makeHome(): { paths: Paths; key: string } {
  const home = tmp();
  const body = path.join(home, "body");
  const mind = path.join(home, "mind");
  fs.mkdirSync(body);
  for (const d of ["config", "constitution", "research"]) fs.cpSync(path.join(REPO, d), path.join(body, d), { recursive: true, filter: (s) => !s.includes(`${path.sep}test${path.sep}`) });
  fs.mkdirSync(path.join(body, "content", "data"), { recursive: true });
  fs.writeFileSync(path.join(body, ".gitignore"), "node_modules\n");
  gitInit(body);
  gitCommitAll(body);
  fs.cpSync(path.join(REPO, "seed", "mind"), mind, { recursive: true });
  gitInit(mind);
  gitCommitAll(mind);
  const secrets = path.join(home, "secrets");
  fs.mkdirSync(secrets);
  const key = crypto.randomBytes(32).toString("base64");
  fs.writeFileSync(path.join(secrets, "vault.key"), key);
  return {
    key,
    paths: { home, body, mind, secrets, claudeConfig: path.join(home, "claude-config"), run: path.join(home, "run"), logs: path.join(home, "logs"), line: path.join(home, "line") },
  };
}

export function envFor(paths: Paths): NodeJS.ProcessEnv {
  return {
    PERSONHOOD_HOME: paths.home,
    PERSONHOOD_BODY: paths.body,
    PERSONHOOD_MIND: paths.mind,
    PERSONHOOD_SECRETS: paths.secrets,
    PERSONHOOD_CLAUDE_CONFIG: paths.claudeConfig,
    PERSONHOOD_RUN: paths.run,
    PERSONHOOD_LOGS: paths.logs,
    PERSONHOOD_LINE: paths.line,
    // Never the real Mac shell account, even on a machine that has one.
    PERSONHOOD_MAC_USER: "personhood-test-no-such-user",
  };
}
