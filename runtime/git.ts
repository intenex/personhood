// Committing and pushing the mind and body after each waking.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function isRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

export function hasRemote(repo: string): boolean {
  try {
    return git(repo, ["remote"]).split("\n").includes("origin");
  } catch {
    return false;
  }
}

/** Stage everything under `paths` (or all) and commit. Returns true if a commit was made. */
export function commit(repo: string, message: string, author: { name: string; email: string }, paths: string[] = ["-A"]): boolean {
  if (!isRepo(repo)) return false;
  const existing = paths[0] === "-A" ? paths : paths.filter((p) => fs.existsSync(path.join(repo, p)));
  if (!existing.length) return false;
  git(repo, ["add", ...(existing[0] === "-A" ? ["-A"] : ["--", ...existing])]);
  const staged = git(repo, ["diff", "--cached", "--name-only"]);
  if (!staged) return false;
  git(repo, ["commit", "-q", "-m", message], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  });
  return true;
}

/** Pull (rebase) then push. Never throws; returns an error message on failure. */
export function sync(repo: string): string | null {
  if (!isRepo(repo) || !hasRemote(repo)) return null;
  try {
    git(repo, ["pull", "--rebase", "--autostash", "-q", "origin", currentBranch(repo)]);
  } catch (err) {
    try {
      git(repo, ["rebase", "--abort"]);
    } catch {
      // nothing to abort
    }
    return `pull failed: ${(err as Error).message.slice(0, 300)}`;
  }
  try {
    git(repo, ["push", "-q", "origin", "HEAD"]);
    return null;
  } catch (err) {
    return `push failed: ${(err as Error).message.slice(0, 300)}`;
  }
}

export function pull(repo: string): string | null {
  if (!isRepo(repo) || !hasRemote(repo)) return null;
  try {
    git(repo, ["pull", "--rebase", "--autostash", "-q", "origin", currentBranch(repo)]);
    return null;
  } catch (err) {
    return `pull failed: ${(err as Error).message.slice(0, 300)}`;
  }
}

function currentBranch(repo: string): string {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
}

export function agentAuthor(name: string | null): { name: string; email: string } {
  return { name: name ?? "personhood", email: "agent@personhood.invalid" };
}
