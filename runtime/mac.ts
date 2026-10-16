// The Mac shell: commands on the agent's Mac itself, run as `wick`, a standard macOS account of its
// own (no admin, no sudo), set up by scripts/mac-shell.sh. Unlike the lab this isn't a separate
// computer: it's the real Mac and its real network, and what keeps the agent's secrets, harness and
// records out of reach is file permissions. The harness account's home is closed to `wick` by an
// ACL, ~/personhood is owner-only, and the harness checks both from `wick`'s side at the start of
// every waking (fail closed).
//
// The harness reaches the account with `sudo -n -u wick`, the only passwordless sudo it has. The
// command (with any credentials) travels base64-encoded on the first line of stdin, never in argv,
// where `ps` could show it. It runs as a login shell in the account's home with a clean
// environment, under a timeout kept by a small perl wrapper (macOS has no `timeout`) that ends the
// whole process group.

import { spawn, spawnSync } from "node:child_process";
import type { LifeConfig, Paths } from "./config.ts";
import { type LabResult, labSettings, secretEnv } from "./lab.ts";

export interface MacSettings {
  enabled: boolean;
  user: string;
  home: string;
  maxCommandsPerWaking: number;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  outputChars: number;
}

/** The same caps and timeouts as the lab's, unless config says otherwise. */
export function macSettings(cfg: LifeConfig, env: NodeJS.ProcessEnv = process.env): MacSettings {
  const { maxCommandsPerWaking, defaultTimeoutSeconds, maxTimeoutSeconds, outputChars } = labSettings(cfg);
  const s = { enabled: false, user: "wick", maxCommandsPerWaking, defaultTimeoutSeconds, maxTimeoutSeconds, outputChars, ...cfg.mac };
  const user = env.PERSONHOOD_MAC_USER ?? s.user;
  return { ...s, user, home: s.home ?? `/Users/${user}` };
}

/** Has scripts/mac-shell.sh created the account on this machine? */
export function macExists(cfg: LifeConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const s = macSettings(cfg, env);
  if (!s.enabled) return false;
  if (env.PERSONHOOD_MAC_SUDO) return true;
  return process.platform === "darwin" && spawnSync("/usr/bin/id", ["-u", s.user], { encoding: "utf8" }).status === 0;
}

/** Credentials Ben has given the Mac shell: secrets/mac/NAME becomes $NAME in mac_run commands only. */
export function macEnv(secretsDir: string): Record<string, string> {
  return secretEnv(secretsDir, "mac");
}

/** Kill the command's whole process group when the time is up (exit 124, like GNU timeout). */
const TIMEOUT_PL = String.raw`my $t = shift; my $pid = fork; defined $pid or exit 125;
if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
$SIG{ALRM} = sub {
  kill "TERM", -$pid;
  for (1 .. 50) { waitpid($pid, 1); last unless kill 0, -$pid; select(undef, undef, undef, 0.1) }
  kill "KILL", -$pid; waitpid($pid, 0); exit 124;
};
alarm $t; waitpid($pid, 0); alarm 0;
exit($? & 127 ? 128 + ($? & 127) : $? >> 8);`;

const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** What runs as the account: read the script from stdin's first line, run it from ~ under a timeout, clean up. */
export function macWrapper(timeoutSeconds: number): string {
  const t = Math.max(1, Math.round(timeoutSeconds));
  return [
    `IFS= read -r b || exit 125`,
    // A template both BSD (macOS) and GNU mktemp accept.
    `f=$(mktemp "\${TMPDIR:-/tmp}/mac_run.XXXXXX") || exit 125`,
    `printf %s "$b" | /usr/bin/base64 -d > "$f" || { rm -f "$f"; exit 125; }`,
    `cd ~ || exit 125`,
    `/usr/bin/perl -e ${shellQuote(TIMEOUT_PL)} ${t} /bin/bash -l "$f"`,
    `s=$?; rm -f "$f"; exit $s`,
  ].join("\n");
}

/** The first line of stdin: the script, with its credentials, base64-encoded. */
export function macScript(command: string, env: Record<string, string> = {}): string {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}\n`).join("");
  return Buffer.from(exports + command, "utf8").toString("base64");
}

/** sudo's arguments: become the account, with a clean environment and no shell profile of its own yet. */
function sudoArgs(s: MacSettings, script: string): string[] {
  return [
    "-n", "-u", s.user, "-H",
    "/usr/bin/env", "-i", `HOME=${s.home}`, `USER=${s.user}`, `LOGNAME=${s.user}`, "SHELL=/bin/bash", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=en_US.UTF-8",
    "/bin/bash", "--noprofile", "--norc", "-c", script,
  ];
}

const MAX_CAPTURE = 4_000_000;

function spawnAsMac(s: MacSettings, script: string, input: string, backstopSeconds: number, env: NodeJS.ProcessEnv): Promise<LabResult> {
  const sudo = env.PERSONHOOD_MAC_SUDO ?? "/usr/bin/sudo";
  const started = Date.now();
  return new Promise((resolve) => {
    // From /: the account can't enter the harness's own working directory (that's the point).
    const child = spawn(sudo, sudoArgs(s, script), { cwd: "/", env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_CAPTURE) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_CAPTURE) stderr += d;
    });
    // A backstop in case the wrapper itself hangs; the real timeout is the wrapper's.
    const killer = setTimeout(() => child.kill("SIGKILL"), backstopSeconds * 1000);
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      resolve({ exitCode: code, stdout, stderr, seconds, timedOut: false });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export async function runOnMac(cfg: LifeConfig, a: { command: string; stdin?: string; timeoutSeconds?: number; macEnv?: Record<string, string> }, env: NodeJS.ProcessEnv = process.env): Promise<LabResult> {
  const s = macSettings(cfg, env);
  const timeout = Math.min(Math.max(a.timeoutSeconds ?? s.defaultTimeoutSeconds, 1), s.maxTimeoutSeconds);
  const r = await spawnAsMac(s, macWrapper(timeout), `${macScript(a.command, a.macEnv)}\n${a.stdin ?? ""}`, timeout + 60, env);
  return { ...r, timedOut: r.exitCode === 124 && r.seconds >= timeout - 1 };
}

/**
 * Checked from the account's side, with no profile of its own involved (it can't fake the answer):
 * it can't list the harness's home or the agent's secrets and Claude config, can't write the
 * runtime, config, constitution, harness state or the command log, and has no sudo.
 */
export function isolationCheck(paths: Paths, harnessHome: string): string {
  const q = shellQuote;
  const body = (d: string) => `${paths.body}/${d}`;
  const mind = (d: string) => `${paths.mind}/${d}`;
  const unreadable = [harnessHome, paths.home, paths.secrets, paths.claudeConfig, paths.logs];
  const unwritable = [paths.body, body("runtime"), body("config"), body("constitution"), paths.mind, mind("state"), mind("ledger"), mind("instruments"), mind("episodes"), paths.logs, `${paths.logs}/lab.jsonl`];
  return [
    `p=0`,
    `for d in ${unreadable.map(q).join(" ")}; do if ls "$d" >/dev/null 2>&1 || [ -r "$d" ]; then echo "can read $d"; p=1; fi; done`,
    `for d in ${unwritable.map(q).join(" ")}; do if [ -w "$d" ]; then echo "can write $d"; p=1; fi; done`,
    `if /usr/bin/sudo -n true >/dev/null 2>&1; then echo "has sudo"; p=1; fi`,
    `[ "$p" = 0 ] && echo mac-ok`,
  ].join("\n");
}

export type MacProblem = "missing" | "sudo" | "isolation";

/** What to tell Ben about a Mac-shell problem: fixed wording, nothing the account produced. */
export const MAC_PROBLEM_TEXT: Record<MacProblem, string> = {
  missing: "there's no Mac shell account on this machine",
  sudo: "the harness couldn't run commands as its account (the sudoers rule from scripts/mac-shell.sh)",
  isolation: "its account could reach something it shouldn't (secrets, the harness or its records), so it stayed closed",
};

/**
 * At the start of a waking: can the harness run as the account, and is it still walled off?
 * Fail closed. `detail` goes to local logs only.
 */
export async function ensureMac(cfg: LifeConfig, paths: Paths, harnessHome: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; problem?: MacProblem; detail: string }> {
  if (!macExists(cfg, env)) return { ok: false, problem: "missing", detail: "no Mac shell account on this machine" };
  if (env.PERSONHOOD_MAC_SUDO) return { ok: true, detail: "test Mac shell" };
  const s = macSettings(cfg, env);
  const r = await spawnAsMac(s, isolationCheck(paths, harnessHome), "", 60, env);
  if (r.exitCode === 1 && /password|sudoers|not allowed/i.test(r.stderr)) return { ok: false, problem: "sudo", detail: r.stderr.trim().slice(-300) };
  if (!r.stdout.includes("mac-ok")) {
    const detail = (r.stdout + r.stderr).trim().slice(-500);
    return { ok: false, problem: r.stdout.trim() ? "isolation" : "sudo", detail: detail || `exit ${r.exitCode}` };
  }
  return { ok: true, detail: "open and walled off" };
}
