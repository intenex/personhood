// Defense in depth. Permission rules should already stop the agent's file
// tools from touching protected paths; after every waking the guard checks
// what actually changed in both repositories and reverts anything outside the
// agent's writable areas that a life tool didn't write. Violations are
// recorded in the episode and the public log.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BODY_AGENT_WRITABLE, MIND_HARNESS_ONLY } from "./config.ts";

export interface Change {
  status: string;
  path: string;
}

export function gitChanges(repo: string): Change[] {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
  } catch {
    return [];
  }
  const parts = out.split("\0").filter(Boolean);
  const changes: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    changes.push({ status, path: entry.slice(3) });
    if (status.startsWith("R") || status.startsWith("C")) i++; // skip the rename source
  }
  return changes;
}

function under(rel: string, dirs: string[]): boolean {
  return dirs.some((d) => rel === d || rel.startsWith(`${d}/`));
}

export function isMindPathAllowed(rel: string): boolean {
  return !under(rel, MIND_HARNESS_ONLY);
}

export function isBodyPathAllowed(rel: string): boolean {
  return under(rel, BODY_AGENT_WRITABLE);
}

export interface GuardReport {
  reverted: string[];
}

function sha(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Revert disallowed changes. `toolHashes` maps absolute paths written by life
 * tools this waking to the content hash the tool left; a protected file is
 * kept only if it still has exactly that content.
 */
export function enforce(repo: string, allowed: (rel: string) => boolean, toolHashes: Map<string, string>): GuardReport {
  const reverted: string[] = [];
  for (const c of gitChanges(repo)) {
    const abs = path.resolve(repo, c.path);
    if (allowed(c.path)) continue;
    const expected = toolHashes.get(abs);
    if (expected && sha(abs) === expected) continue;
    if (c.status === "??") fs.rmSync(abs, { force: true });
    else {
      try {
        execFileSync("git", ["checkout", "HEAD", "--", c.path], { cwd: repo, stdio: "ignore" });
      } catch {
        fs.rmSync(abs, { force: true });
      }
    }
    reverted.push(c.path);
  }
  return { reverted };
}
