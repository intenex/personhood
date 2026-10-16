import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildSettings, extraDirs } from "./brain.ts";
import { loadConfig, loadInstruments } from "./config.ts";
import { toolAllowed } from "./life-server.ts";
import { macRun, run, type ToolContext } from "./life-tools.ts";
import { isolationCheck, macEnv, macExists, macSettings, runOnMac } from "./mac.ts";
import { MindState } from "./state.ts";
import { makeHome, REPO, tmp } from "./test/helpers.ts";

/** Stands in for `sudo -n -u wick … bash -c <wrapper>`: runs the wrapper locally in a throwaway HOME, and keeps its argv. */
function fakeSudo(): { sudo: string; home: string; argv: string } {
  const dir = tmp("fake-mac-");
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const argv = path.join(dir, "argv");
  const sudo = path.join(dir, "sudo");
  fs.writeFileSync(sudo, `#!/bin/bash\nprintf '%s\\n' "$@" >> "${argv}"\nfor last; do :; done\nexport HOME="${home}"\nexec /bin/bash --noprofile --norc -c "$last"\n`);
  fs.chmodSync(sudo, 0o755);
  return { sudo, home, argv };
}

const cfg = loadConfig(REPO);
const macCfg = { ...cfg, mac: { ...cfg.mac, enabled: true } };

test("the Mac shell runs a login shell in its home, survives any quoting, and keeps the command out of argv", async () => {
  const { sudo, home, argv } = fakeSudo();
  const env = { ...process.env, PERSONHOOD_MAC_SUDO: sudo };
  const tricky = `x='single "double" $HOME \`tick\`'; printf '%s\\n' "$x"; echo "line two"; pwd`;
  const r = await runOnMac(macCfg, { command: tricky, macEnv: { DEMO_TOKEN: "s3cret-value" } }, env);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout, `single "double" $HOME \`tick\`\nline two\n${home}\n`);
  assert.equal(r.timedOut, false);
  const args = fs.readFileSync(argv, "utf8");
  assert.match(args, /^-n\n-u\nwick\n-H\n\/usr\/bin\/env\n-i\nHOME=\/Users\/wick\n/, "sudo -n -u wick, with a clean environment");
  assert.ok(!args.includes("line two") && !args.includes("s3cret-value"), "the command and credentials travel on stdin, never in argv");
  assert.ok(!args.includes(Buffer.from("export DEMO_TOKEN").toString("base64").slice(0, 12)));
});

test("stdin reaches the command after the script line; failures report their exit code and stderr", async () => {
  const { sudo, home } = fakeSudo();
  const env = { ...process.env, PERSONHOOD_MAC_SUDO: sudo };
  const w = await runOnMac(macCfg, { command: "cat > hello.py", stdin: "print('hello from the Mac')\nsecond line\n" }, env);
  assert.equal(w.exitCode, 0, w.stderr);
  assert.equal(fs.readFileSync(path.join(home, "hello.py"), "utf8"), "print('hello from the Mac')\nsecond line\n");
  const f = await runOnMac(macCfg, { command: "echo oops >&2; exit 3" }, env);
  assert.equal(f.exitCode, 3);
  assert.equal(f.stderr.trim(), "oops");
});

test("a timeout ends the whole process group, background jobs included", async () => {
  const { sudo, home } = fakeSudo();
  const env = { ...process.env, PERSONHOOD_MAC_SUDO: sudo };
  const started = Date.now();
  const r = await runOnMac(macCfg, { command: "sleep 60 & echo $! > bg.pid; sleep 60", timeoutSeconds: 1 }, env);
  assert.equal(r.exitCode, 124);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 15_000);
  const pid = Number(fs.readFileSync(path.join(home, "bg.pid"), "utf8"));
  assert.equal(spawnSync("kill", ["-0", String(pid)]).status, 1, "the background sleep is gone");
});

test("the Mac shell has the lab's caps unless config says otherwise, and exists only when enabled", () => {
  const s = macSettings(macCfg, {});
  assert.equal(s.user, "wick");
  assert.equal(s.home, "/Users/wick");
  assert.equal(s.maxCommandsPerWaking, 300);
  assert.equal(s.defaultTimeoutSeconds, 120);
  assert.equal(s.maxTimeoutSeconds, 900);
  assert.equal(macSettings(macCfg, { PERSONHOOD_MAC_USER: "other" }).home, "/Users/other");
  assert.equal(macExists({ ...cfg, mac: { enabled: false } }, { PERSONHOOD_MAC_SUDO: "x" }), false);
  assert.equal(macExists(macCfg, { PERSONHOOD_MAC_USER: "personhood-no-such-user" }), false);
});

function ctxFor(mac: boolean): { ctx: ToolContext; home: string } {
  const { paths } = makeHome();
  const { sudo, home } = fakeSudo();
  process.env.PERSONHOOD_MAC_SUDO = sudo;
  const dir = path.join(paths.run, "s");
  fs.mkdirSync(dir, { recursive: true });
  return {
    home,
    ctx: { cfg: loadConfig(REPO), instruments: loadInstruments(REPO), paths, state: new MindState(paths.mind), vault: null, gh: null, now: () => new Date(), session: { waking: 7, mode: "ordinary", startedAt: "", effort: "medium", dir, lab: false, mac } },
  };
}

test("mac_run: output for the agent, the command (not the output) on the record tagged mac, its own per-waking limit", async () => {
  const { ctx } = ctxFor(true);
  const out = await macRun(ctx, { command: "echo built; echo warned >&2" });
  assert.match(out, /^exit 0 · /);
  assert.match(out, /--- stdout ---\nbuilt/);
  assert.match(out, /--- stderr ---\nwarned/);
  const log = path.join(ctx.paths.logs, "lab.jsonl");
  const first = JSON.parse(fs.readFileSync(log, "utf8").trim());
  assert.equal(first.where, "mac");
  assert.equal(first.waking, 7);
  assert.equal(first.command.text, "echo built; echo warned >&2");
  assert.doesNotMatch(fs.readFileSync(log, "utf8"), /"built"|warned"/, "output isn't logged");
  await macRun(ctx, { command: "bash", stdin: "echo from a piped script" });
  const second = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[1]);
  assert.equal(second.stdin.text, "echo from a piped script");
  ctx.cfg.mac = { ...ctx.cfg.mac, maxCommandsPerWaking: 2 };
  await assert.rejects(macRun(ctx, { command: "true" }), /the limit/);
  // The lab's count is separate (and the lab is closed this waking anyway).
  await assert.rejects(run(ctx, { command: "true" }), /lab isn't available/);
});

test("no Mac shell when the waking doesn't have one, and never in correspondence", async () => {
  const { ctx } = ctxFor(false);
  await assert.rejects(macRun(ctx, { command: "true" }), /isn't available/);
  assert.equal(toolAllowed("correspondence", "mac_run"), false);
  assert.equal(toolAllowed("ordinary", "mac_run"), true);
});

test("credentials in secrets/mac reach mac_run commands as environment variables, and stay out of the log", async () => {
  const { ctx } = ctxFor(true);
  const dir = path.join(ctx.paths.secrets, "mac");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "GMAIL_APP_PASSWORD"), "pa'ss \"word\" $x `y`\n");
  fs.writeFileSync(path.join(dir, "not-a-valid-name"), "ignored");
  fs.mkdirSync(path.join(ctx.paths.secrets, "lab"));
  fs.writeFileSync(path.join(ctx.paths.secrets, "lab", "LAB_ONLY"), "lab-only-value");
  assert.deepEqual(Object.keys(macEnv(ctx.paths.secrets)), ["GMAIL_APP_PASSWORD"]);
  const out = await macRun(ctx, { command: 'printf "[%s][%s]" "$GMAIL_APP_PASSWORD" "${LAB_ONLY:-none}"' });
  assert.match(out, /\[pa'ss "word" \$x `y`\]\[none\]/, "its own credentials, and not the lab's");
  assert.doesNotMatch(fs.readFileSync(path.join(ctx.paths.logs, "lab.jsonl"), "utf8"), /pa'ss/, "the command log never holds a credential");
});

test("the isolation check notices anything the account can read or write that it shouldn't", () => {
  const { paths } = makeHome();
  fs.mkdirSync(paths.logs, { recursive: true });
  // Run as the owner, everything is open: the check must say so and never say mac-ok.
  const r = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", isolationCheck(paths, paths.home)], { encoding: "utf8" });
  assert.match(r.stdout, new RegExp(`can read ${paths.secrets}`));
  assert.match(r.stdout, new RegExp(`can write ${path.join(paths.body, "config")}`));
  assert.match(r.stdout, new RegExp(`can write ${paths.logs}`));
  assert.doesNotMatch(r.stdout, /mac-ok/);
});

test("ordinary wakings can read their own tool results and the Mac shell's home; transcripts and the rest of the config stay closed", () => {
  const { paths } = makeHome();
  fs.mkdirSync(path.join(paths.claudeConfig, "projects", "p", "s", "tool-results"), { recursive: true });
  fs.mkdirSync(path.join(paths.claudeConfig, "sessions"));
  fs.writeFileSync(path.join(paths.claudeConfig, ".claude.json"), "{}");
  const cc = `/${paths.claudeConfig}`;
  const s = buildSettings(paths, "ordinary", true, "/Users/wick") as { permissions: { allow: string[]; deny: string[] } };
  assert.ok(s.permissions.allow.includes(`Read(${cc}/projects/*/tool-results/**)`));
  assert.ok(s.permissions.allow.includes(`Read(${cc}/projects/*/*/tool-results/**)`));
  assert.ok(s.permissions.allow.includes("Read(//Users/wick/**)"));
  assert.ok(!s.permissions.deny.includes(`Read(${cc}/**)`), "a blanket deny would beat the allow");
  for (const r of [`Read(${cc}/projects/**/*.jsonl)`, `Read(${cc}/.claude.json)`, `Read(${cc}/sessions/**)`, `Edit(${cc}/**)`, `Write(${cc}/**)`]) assert.ok(s.permissions.deny.includes(r), r);
  const c = buildSettings(paths, "correspondence", true, "/Users/wick") as { permissions: { allow: string[]; deny: string[] } };
  assert.ok(c.permissions.deny.includes(`Read(${cc}/**)`), "correspondence: none of it");
  assert.ok(!c.permissions.allow.some((r) => r.includes("tool-results") || r.includes("/Users/wick")));
  const wick = tmp("wick-home-");
  assert.deepEqual(extraDirs(paths, "ordinary", wick), [paths.body, path.join(paths.claudeConfig, "projects"), wick]);
  assert.deepEqual(extraDirs(paths, "correspondence", wick), [paths.body]);
  assert.deepEqual(extraDirs(paths, "ordinary", "/nonexistent/wick"), [paths.body, path.join(paths.claudeConfig, "projects")]);
});
