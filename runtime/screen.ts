// The lab's screen: a virtual display inside the lab VM (Xvfb :1, 1280x800, openbox, Chromium),
// set up by scripts/lab-screen-setup.sh. The `screen` life tool looks at it and acts on it the way
// computer use does (screenshot, click, type, key, scroll, drag), through the same ssh path as
// `run`: each action is a short script run in the VM with xdotool, followed by a fresh screenshot
// (ImageMagick's import, base64 on stdout). It's still the lab: sealed off from the Mac, its
// network behind the lab's firewall.

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { LifeConfig } from "./config.ts";
import { runInLab } from "./lab.ts";

export const SCREEN = { width: 1280, height: 800, display: ":1" };

export const SCREEN_ACTIONS = [
  "screenshot", "left_click", "right_click", "middle_click", "double_click", "triple_click",
  "mouse_move", "left_click_drag", "type", "key", "scroll", "wait",
] as const;
export type ScreenAction = (typeof SCREEN_ACTIONS)[number];

export interface ScreenArgs {
  action: ScreenAction;
  coordinate?: number[];
  start_coordinate?: number[];
  text?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  seconds?: number;
}

function point(v: number[] | undefined, name: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isFinite(n))) throw new Error(`${name} must be [x, y]`);
  const [x, y] = v.map(Math.round);
  if (x < 0 || y < 0 || x >= SCREEN.width || y >= SCREEN.height) throw new Error(`${name} (${x}, ${y}) is off the screen, which is ${SCREEN.width}×${SCREEN.height}`);
  return [x, y];
}

/** xdotool key names: "Return", "ctrl+l", "alt+Tab", "ctrl+shift+t", several separated by spaces. */
const KEYS = /^[A-Za-z0-9_+\-]+( [A-Za-z0-9_+\-]+)*$/;

/** The script run in the VM for one action, and what goes to its stdin (text to type). */
export function actionScript(a: ScreenArgs): { script: string; stdin?: string; label: string } {
  const pre = `export DISPLAY=${SCREEN.display}\nxdotool getmouselocation >/dev/null 2>&1 || { echo "the screen isn't running" >&2; exit 3; }\n`;
  const shot = `sleep 0.6\nimport -display ${SCREEN.display} -window root png:- | base64 | tr -d '\\n'`;
  const click = (button: number, repeat = 1) => {
    const [x, y] = point(a.coordinate, "coordinate");
    return { body: `xdotool mousemove ${x} ${y} click --repeat ${repeat} --delay 80 ${button}`, at: ` at (${x}, ${y})` };
  };
  let body = "";
  let label: string = a.action;
  let stdin: string | undefined;
  switch (a.action) {
    case "screenshot":
      break;
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const button = a.action === "right_click" ? 3 : a.action === "middle_click" ? 2 : 1;
      const repeat = a.action === "double_click" ? 2 : a.action === "triple_click" ? 3 : 1;
      const c = click(button, repeat);
      body = c.body;
      label += c.at;
      break;
    }
    case "mouse_move": {
      const [x, y] = point(a.coordinate, "coordinate");
      body = `xdotool mousemove ${x} ${y}`;
      label += ` to (${x}, ${y})`;
      break;
    }
    case "left_click_drag": {
      const [x0, y0] = point(a.start_coordinate, "start_coordinate");
      const [x1, y1] = point(a.coordinate, "coordinate");
      body = `xdotool mousemove ${x0} ${y0} mousedown 1 sleep 0.1 mousemove ${x1} ${y1} sleep 0.1 mouseup 1`;
      label += ` from (${x0}, ${y0}) to (${x1}, ${y1})`;
      break;
    }
    case "type": {
      if (!a.text) throw new Error("type needs text");
      if (a.text.length > 20_000) throw new Error("that's too much to type at once (20,000 characters at most)");
      body = `xdotool type --delay 8 --file -`;
      stdin = a.text;
      label += ` ${a.text.length} characters`;
      break;
    }
    case "key": {
      const keys = (a.text ?? "").trim();
      if (!KEYS.test(keys) || keys.length > 200) throw new Error('key needs xdotool key names in text, like "Return", "ctrl+l" or "alt+Tab" (several separated by spaces)');
      body = `xdotool key --delay 40 -- ${keys}`;
      label += ` ${keys}`;
      break;
    }
    case "scroll": {
      const [x, y] = point(a.coordinate, "coordinate");
      const button = { up: 4, down: 5, left: 6, right: 7 }[a.direction ?? "down"];
      if (!button) throw new Error("direction is up, down, left or right");
      const n = Math.min(Math.max(Math.round(a.amount ?? 3), 1), 20);
      body = `xdotool mousemove ${x} ${y} click --repeat ${n} --delay 30 ${button}`;
      label += ` ${a.direction ?? "down"} ×${n} at (${x}, ${y})`;
      break;
    }
    case "wait": {
      const s = Math.min(Math.max(a.seconds ?? 1, 0), 10);
      body = `sleep ${s}`;
      label += ` ${s}s`;
      break;
    }
    default:
      throw new Error(`unknown action; one of: ${SCREEN_ACTIONS.join(", ")}`);
  }
  return { script: `${pre}${body}\n${shot}`, stdin, label };
}

export interface ScreenResult {
  label: string;
  /** base64 PNG of the screen after the action. */
  png?: string;
  error?: string;
}

export async function screenAction(cfg: LifeConfig, a: ScreenArgs, env: NodeJS.ProcessEnv = process.env): Promise<ScreenResult> {
  const { script, stdin, label } = actionScript(a);
  const r = await runInLab(cfg, { command: script, stdin, timeoutSeconds: 60 }, env);
  const png = r.stdout.trim();
  if (r.exitCode !== 0 || !png) return { label, error: (r.stderr.trim() || `exit ${r.exitCode}`).slice(-600) };
  return { label, png };
}

/** At the start of a waking (after the firewall): make sure the screen service is up. Never fatal. */
export function ensureScreen(cfg: LifeConfig, env: NodeJS.ProcessEnv = process.env): { ok: boolean; detail: string } {
  if (env.PERSONHOOD_LAB_SSH) return { ok: true, detail: "test screen" };
  const instance = cfg.lab?.instance ?? "lab";
  const sshConfig = path.join(env.LIMA_HOME ?? path.join(os.homedir(), ".lima"), instance, "ssh.config");
  const check = `systemctl is-enabled --quiet lab-screen.service || { echo not-installed; exit 0; }
/usr/bin/sudo -n /usr/bin/systemctl start lab-screen.service
for _ in $(seq 50); do DISPLAY=${SCREEN.display} /usr/bin/xdpyinfo >/dev/null 2>&1 && { echo screen-ok; exit 0; }; sleep 0.2; done
echo no-display`;
  const r = spawnSync("ssh", ["-F", sshConfig, "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", `lima-${instance}`, "/bin/bash --noprofile --norc -s"], { env, input: check, encoding: "utf8", timeout: 60_000 });
  const out = (r.stdout ?? "").trim();
  if (out.endsWith("screen-ok")) return { ok: true, detail: "screen up" };
  return { ok: false, detail: out.endsWith("not-installed") ? "no screen in the lab (scripts/lab-screen-setup.sh)" : `screen didn't start: ${(out || r.stderr || String(r.error ?? "")).slice(-200)}` };
}
