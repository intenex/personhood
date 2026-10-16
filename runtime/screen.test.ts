import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, loadInstruments } from "./config.ts";
import { registerLifeTools, toolAllowed } from "./life-server.ts";
import { redactCredentials, screen, type ToolContext } from "./life-tools.ts";
import { actionScript } from "./screen.ts";
import { MindState } from "./state.ts";
import { makeHome, REPO, tmp } from "./test/helpers.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A fake lab whose login shell finds stub xdotool and import: xdotool records its arguments (and typed text), import prints a PNG. */
function fakeLab(): { ssh: string; calls: string; typed: string } {
  const dir = tmp("fake-screen-");
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const calls = path.join(dir, "xdotool.calls");
  const typed = path.join(dir, "typed");
  fs.writeFileSync(path.join(bin, "xdotool"), `#!/bin/bash\n[ "$1" = getmouselocation ] && exit 0\necho "$*" >> "${calls}"\n[ "$1" = type ] && cat > "${typed}"\nexit 0\n`);
  fs.writeFileSync(path.join(bin, "import"), `#!/bin/bash\nprintf %s '${PNG}' | base64 -d\n`);
  for (const f of ["xdotool", "import"]) fs.chmodSync(path.join(bin, f), 0o755);
  fs.writeFileSync(path.join(home, ".bash_profile"), `export PATH="${bin}:$PATH"\n`);
  const ssh = path.join(dir, "ssh");
  fs.writeFileSync(ssh, `#!/bin/bash\nfor last; do :; done\nexport HOME="${home}"\nexec bash -c "$last"\n`);
  fs.chmodSync(ssh, 0o755);
  return { ssh, calls, typed };
}

function ctxFor(opts: { lab: boolean; screen: boolean }): { ctx: ToolContext; calls: string; typed: string } {
  const { paths } = makeHome();
  const { ssh, calls, typed } = fakeLab();
  process.env.PERSONHOOD_LAB_SSH = ssh;
  const dir = path.join(paths.run, "s");
  fs.mkdirSync(dir, { recursive: true });
  return {
    calls,
    typed,
    ctx: { cfg: loadConfig(REPO), instruments: loadInstruments(REPO), paths, state: new MindState(paths.mind), vault: null, gh: null, now: () => new Date(), session: { waking: 9, mode: "ordinary", startedAt: "", effort: "medium", dir, ...opts } },
  };
}

test("actions become xdotool commands, checked first: on the screen, real key names, text on stdin", () => {
  assert.match(actionScript({ action: "double_click", coordinate: [100, 200] }).script, /xdotool mousemove 100 200 click --repeat 2 --delay 80 1/);
  assert.match(actionScript({ action: "right_click", coordinate: [5, 5] }).script, /click --repeat 1 --delay 80 3/);
  assert.match(actionScript({ action: "scroll", coordinate: [640, 400], direction: "up", amount: 5 }).script, /click --repeat 5 --delay 30 4/);
  assert.match(actionScript({ action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] }).script, /mousemove 1 2 mousedown 1 .* mousemove 3 4 .* mouseup 1/);
  assert.match(actionScript({ action: "key", text: "ctrl+l" }).script, /xdotool key --delay 40 -- ctrl\+l/);
  assert.throws(() => actionScript({ action: "left_click", coordinate: [1280, 10] }), /off the screen/);
  assert.throws(() => actionScript({ action: "left_click" }), /\[x, y\]/);
  assert.throws(() => actionScript({ action: "key", text: "Return; rm -rf ~" }), /xdotool key names/);
  const t = actionScript({ action: "type", text: "it's \"quoted\" $HOME `x`" });
  assert.equal(t.stdin, "it's \"quoted\" $HOME `x`");
  assert.ok(!t.script.includes("quoted"), "typed text never goes into the script");
  assert.match(actionScript({ action: "screenshot" }).script, /import -display :1 -window root png:-/);
});

test("the screen tool: acts, returns a screenshot, and logs the action (never the picture)", async () => {
  const { ctx, calls } = ctxFor({ lab: true, screen: true });
  const r = await screen(ctx, { action: "left_click", coordinate: [10, 20] });
  assert.equal(r.text, "left_click at (10, 20) · the screen is 1280×800");
  assert.deepEqual(r.image, { data: PNG, mimeType: "image/png" });
  assert.equal(fs.readFileSync(calls, "utf8"), "mousemove 10 20 click --repeat 1 --delay 80 1\n");
  const rec = JSON.parse(fs.readFileSync(path.join(ctx.paths.logs, "lab.jsonl"), "utf8").trim());
  assert.equal(rec.where, "lab-screen");
  assert.equal(rec.action, "left_click");
  assert.deepEqual(rec.coordinate, [10, 20]);
  assert.equal(rec.waking, 9);
  assert.ok(!JSON.stringify(rec).includes(PNG.slice(0, 20)));
});

test("typed text reaches the screen exactly, and the log blanks any credential in it", async () => {
  const { ctx, typed } = ctxFor({ lab: true, screen: true });
  fs.mkdirSync(path.join(ctx.paths.secrets, "lab"), { recursive: true });
  fs.writeFileSync(path.join(ctx.paths.secrets, "lab", "GMAIL_APP_PASSWORD"), "abcd efgh ijkl\n");
  await screen(ctx, { action: "type", text: "user@example.com\tabcd efgh ijkl\n" });
  assert.equal(fs.readFileSync(typed, "utf8"), "user@example.com\tabcd efgh ijkl\n");
  const log = fs.readFileSync(path.join(ctx.paths.logs, "lab.jsonl"), "utf8");
  assert.match(log, /"text":"user@example.com\\t\[credential\]\\n"/);
  assert.ok(!log.includes("abcd efgh"));
  assert.equal(redactCredentials("a-x-b", ["x"]), "a-x-b", "very short values aren't blanked everywhere");
});

test("no screen without the lab and its display, never in correspondence, and a per-waking limit", async () => {
  await assert.rejects(screen(ctxFor({ lab: true, screen: false }).ctx, { action: "screenshot" }), /isn't available/);
  await assert.rejects(screen(ctxFor({ lab: false, screen: true }).ctx, { action: "screenshot" }), /isn't available/);
  assert.equal(toolAllowed("correspondence", "screen"), false);
  const { ctx } = ctxFor({ lab: true, screen: true });
  ctx.cfg.lab = { ...ctx.cfg.lab, maxScreenActionsPerWaking: 1 };
  await screen(ctx, { action: "screenshot" });
  await assert.rejects(screen(ctx, { action: "screenshot" }), /the limit/);
});

test("over MCP, the agent gets the screenshot as an image", async () => {
  const { ctx } = ctxFor({ lab: true, screen: true });
  const server = new McpServer({ name: "life", version: "test" });
  registerLifeTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "test" });
  await client.connect(b);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("screen"));
  const res = (await client.callTool({ name: "screen", arguments: { action: "screenshot" } })) as { content: { type: string; data?: string; mimeType?: string; text?: string }[] };
  assert.equal(res.content[0].type, "text");
  assert.deepEqual(res.content[1], { type: "image", data: PNG, mimeType: "image/png" });
  await client.close();
  // Without the screen, the tool isn't offered at all.
  const quiet = new McpServer({ name: "life", version: "test" });
  registerLifeTools(quiet, ctxFor({ lab: true, screen: false }).ctx);
  const [c, d] = InMemoryTransport.createLinkedPair();
  await quiet.connect(c);
  const client2 = new Client({ name: "test", version: "test" });
  await client2.connect(d);
  assert.ok(!(await client2.listTools()).tools.some((t) => t.name === "screen"));
  await client2.close();
});
