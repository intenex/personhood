// The lab: a Linux computer of the agent's own, a Lima virtual machine inside its Mac, where it
// can run any code and install anything as an administrator. It is created with no shared folders,
// so nothing on the Mac is reachable from inside it: not the agent's secrets, its private space,
// its harness, or anyone's files. A firewall inside it, re-applied by the harness at the start of
// every waking, keeps it off the Mac's own network services and the local network; the internet
// stays open.
//
// Commands go over Lima's own ssh config (no tty), wrapped in base64 so no quoting can break them,
// with a timeout enforced inside the VM.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LifeConfig } from "./config.ts";

export interface LabSettings {
  enabled: boolean;
  instance: string;
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
  maxCommandsPerWaking: number;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  outputChars: number;
}

export function labSettings(cfg: LifeConfig): LabSettings {
  return {
    enabled: false,
    instance: "lab",
    cpus: 4,
    memoryGiB: 3,
    diskGiB: 64,
    maxCommandsPerWaking: 300,
    defaultTimeoutSeconds: 120,
    maxTimeoutSeconds: 900,
    outputChars: 16000,
    ...cfg.lab,
  };
}

function limaHome(env: NodeJS.ProcessEnv): string {
  return env.LIMA_HOME ?? path.join(os.homedir(), ".lima");
}

/** Has the lab been created on this machine (install.sh does it)? */
export function labExists(cfg: LifeConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const s = labSettings(cfg);
  return s.enabled && (!!env.PERSONHOOD_LAB_SSH || fs.existsSync(path.join(limaHome(env), s.instance, "lima.yaml")));
}

/**
 * Rules for the lab's outgoing traffic (IPv4 and IPv6): replies and DNS are fine, new connections
 * to this Mac (the gateway), private networks, link-local and CGNAT ranges are refused, and the
 * rest of the internet is open. Idempotent: it rebuilds its own chain each time.
 */
export const FIREWALL = String.raw`set -e
command -v iptables >/dev/null 2>&1 || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables >/dev/null; }
iptables -N LAB-OUT 2>/dev/null || iptables -F LAB-OUT
iptables -C OUTPUT -j LAB-OUT 2>/dev/null || iptables -I OUTPUT 1 -j LAB-OUT
iptables -A LAB-OUT -o lo -j RETURN
iptables -A LAB-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for ns in $(for f in /run/systemd/resolve/resolv.conf /etc/resolv.conf; do [ -r "$f" ] && awk '/^nameserver/ {print $2}' "$f"; done | grep -v '^127\.' | grep -v ':' | sort -u); do
  iptables -A LAB-OUT -d "$ns" -p udp --dport 53 -j RETURN
  iptables -A LAB-OUT -d "$ns" -p tcp --dport 53 -j RETURN
done
gw=$(ip -4 route show default | awk '{print $3; exit}')
gwnet=""; [ -n "$gw" ] && gwnet="$gw/32"
for net in $gwnet 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  iptables -A LAB-OUT -d "$net" -j REJECT
done
set +e  # IPv6 is best effort: the lab's network is IPv4.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -N LAB-OUT 2>/dev/null || ip6tables -F LAB-OUT
  ip6tables -C OUTPUT -j LAB-OUT 2>/dev/null || ip6tables -I OUTPUT 1 -j LAB-OUT
  ip6tables -A LAB-OUT -o lo -j RETURN
  ip6tables -A LAB-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for net in fc00::/7 fe80::/10; do ip6tables -A LAB-OUT -d "$net" -j REJECT; done
fi
echo firewall-ok
`;

function sshArgs(cfg: LifeConfig, env: NodeJS.ProcessEnv, remote: string): string[] {
  const { instance } = labSettings(cfg);
  return ["-F", path.join(limaHome(env), instance, "ssh.config"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", `lima-${instance}`, remote];
}

/**
 * Make sure the lab is running (it stops when the Mac restarts) and its firewall is in place.
 * Without the firewall the lab stays closed for the waking: fail closed.
 */
export function ensureLab(cfg: LifeConfig, env: NodeJS.ProcessEnv = process.env): { ok: boolean; detail: string } {
  if (!labExists(cfg, env)) return { ok: false, detail: "no lab on this machine" };
  if (env.PERSONHOOD_LAB_SSH) return { ok: true, detail: "test lab" };
  const { instance } = labSettings(cfg);
  const list = spawnSync("limactl", ["list", "--format", "{{.Status}}", instance], { env, encoding: "utf8", timeout: 30_000 });
  if (list.error) return { ok: false, detail: `limactl: ${list.error.message}` };
  let detail = "running";
  if (list.stdout.trim() !== "Running") {
    const start = spawnSync("limactl", ["start", "--tty=false", instance], { env, encoding: "utf8", timeout: 5 * 60_000 });
    if (start.status !== 0) return { ok: false, detail: `couldn't start: ${(start.stderr || start.stdout || "").trim().slice(-300)}` };
    detail = "started";
  }
  const fw = spawnSync("ssh", sshArgs(cfg, env, remoteCommand("sudo bash", 300)), { env, input: FIREWALL, encoding: "utf8", timeout: 6 * 60_000 });
  if (fw.status !== 0 || !fw.stdout.includes("firewall-ok")) return { ok: false, detail: `${detail}, but its firewall couldn't be applied: ${(fw.stderr || fw.stdout || String(fw.error ?? "")).trim().slice(-300)}` };
  return { ok: true, detail: `${detail}, firewall in place` };
}

export interface LabResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  seconds: number;
  timedOut: boolean;
}

/** The shell line run inside the VM: decode the script, run it from ~/lab under a timeout, clean up. */
export function remoteCommand(script: string, timeoutSeconds: number): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const t = Math.max(1, Math.round(timeoutSeconds));
  return [
    `f=$(mktemp) && printf %s '${b64}' | base64 -d > "$f" && mkdir -p ~/lab && cd ~/lab`,
    `if command -v timeout >/dev/null 2>&1; then timeout -k 5 ${t} bash -l "$f"; else bash -l "$f"; fi; s=$?; rm -f "$f"; exit $s`,
  ].join(" && { ") + "; }";
}

const MAX_CAPTURE = 4_000_000;

export function runInLab(cfg: LifeConfig, a: { command: string; stdin?: string; timeoutSeconds?: number }, env: NodeJS.ProcessEnv = process.env): Promise<LabResult> {
  const s = labSettings(cfg);
  const timeout = Math.min(Math.max(a.timeoutSeconds ?? s.defaultTimeoutSeconds, 1), s.maxTimeoutSeconds);
  const ssh = env.PERSONHOOD_LAB_SSH ?? "ssh";
  const args = sshArgs(cfg, env, remoteCommand(a.command, timeout));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(ssh, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_CAPTURE) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_CAPTURE) stderr += d;
    });
    // A backstop in case the VM itself stops answering; the real timeout runs inside the VM.
    const killer = setTimeout(() => child.kill("SIGKILL"), (timeout + 60) * 1000);
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      resolve({ exitCode: code, stdout, stderr, seconds, timedOut: (code === 124 || code === 137) && seconds >= timeout - 1 });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(a.stdin ?? "");
  });
}

/** Keep the start and the end of long output; the middle is usually the least interesting part. */
export function clipOutput(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${s.slice(0, head)}\n… [${s.length - max} characters cut] …\n${s.slice(-tail)}`;
}
