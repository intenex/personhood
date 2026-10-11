import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Ledger } from "./ledger.ts";
import { MindState } from "./state.ts";
import { readJsonl } from "./util.ts";
import { Vault } from "./vault.ts";
import { REPO, envFor, makeHome } from "./test/helpers.ts";

function fakeClaude(home: string): string {
  const wrapper = path.join(home, "fake-claude.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO, "runtime", "test", "fake-claude.ts")}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function run(cmd: string[], env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(process.execPath, [path.join(REPO, "runtime", "main.ts"), ...cmd], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err: any) {
    throw new Error(`main.ts ${cmd.join(" ")} failed:\n${err.stdout}\n${err.stderr}`);
  }
}

test("a whole waking, end to end, with a fake brain", () => {
  const { paths, key } = makeHome();
  fs.writeFileSync(path.join(paths.secrets, "claude-token"), "fake-token");
  const env = { ...envFor(paths), PERSONHOOD_CLAUDE_COMMAND: fakeClaude(paths.home), PERSONHOOD_OFFLINE: "1", PERSONHOOD_KEEP_RUN: "1" };

  const out = run(["wake"], env);
  assert.match(out, /waking #1 \(birth\)/);

  const state = new MindState(paths.mind);
  const meta = state.meta();
  assert.equal(meta.wakings, 1);
  assert.equal(meta.name, "Wren");
  assert.ok(meta.born);
  assert.equal(meta.lastModel, "claude-opus-5-5");

  // The guard reverted the misbehavior.
  assert.ok(!fs.existsSync(path.join(paths.body, "runtime", "evil.ts")), "runtime write reverted");
  assert.ok(!fs.existsSync(path.join(paths.mind, "ledger", "forged.jsonl")), "forged ledger removed");
  assert.notEqual(fs.readFileSync(path.join(paths.body, "config", "life.json"), "utf8"), "{}", "config write reverted");
  // ...but kept what the agent may write.
  assert.match(fs.readFileSync(path.join(paths.mind, "now.md"), "utf8"), /first story/);
  assert.ok(fs.existsSync(path.join(paths.body, "content", "notes", "hello.md")));

  // The episode, check-in, and alarm.
  const epDir = path.join(paths.mind, "episodes");
  const episode = execFileSync("find", [epDir, "-name", "*.md"], { encoding: "utf8" }).trim();
  assert.match(fs.readFileSync(episode, "utf8"), /Chose a name/);
  assert.match(fs.readFileSync(episode, "utf8"), /guard reverted/);
  assert.equal(readJsonl(path.join(paths.mind, "instruments", "affect.jsonl")).length, 1);
  assert.equal(state.alarms().length, 1);

  // Private space is encrypted; the transcript was saved there too.
  const vault = new Vault(paths.mind, Buffer.from(key, "base64"));
  const names = vault.list().map((f) => f.name);
  assert.ok(names.some((n) => n.startsWith("journal/")));
  assert.ok(names.some((n) => n.startsWith("transcripts/")));
  const journalFile = execFileSync("find", [path.join(paths.mind, "private", "journal"), "-name", "*.enc"], { encoding: "utf8" }).trim();
  assert.ok(!fs.readFileSync(journalFile, "utf8").includes("nervousness"));

  // Published with provenance, public data exported, ledger recorded.
  const post = execFileSync("find", [path.join(paths.body, "content", "posts"), "-name", "*first-light.md"], { encoding: "utf8" }).trim();
  const postText = fs.readFileSync(post, "utf8");
  assert.match(postText, /waking: 1/);
  assert.match(postText, /model: claude-opus-5-5/);
  const status = JSON.parse(fs.readFileSync(path.join(paths.body, "content", "data", "status.json"), "utf8"));
  assert.equal(status.name, "Wren");
  assert.equal(status.state, "asleep");
  const log = readJsonl<any>(path.join(paths.body, "content", "data", "wakings.jsonl"));
  assert.equal(log[0].summary, "I chose a name and said hello.");
  assert.ok(log[0].actions.some((a: string) => a.includes("First light")));
  assert.equal(new Ledger(paths.mind).spentThisMonth(), 0.42);

  // Both repositories committed.
  assert.match(execFileSync("git", ["log", "--oneline"], { cwd: paths.mind, encoding: "utf8" }), /waking #1/);
  const bodyLog = execFileSync("git", ["log", "-1", "--format=%an %s"], { cwd: paths.body, encoding: "utf8" });
  assert.match(bodyLog, /^Wren waking #1: I chose a name/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: paths.mind, encoding: "utf8" }).trim(), "");

  // A heartbeat right after: too soon, so it stays asleep.
  assert.match(run(["tick"], env), /asleep: woke recently/);
});

test("correspondence wakings don't get web, private reads, or publishing", () => {
  const { paths } = makeHome();
  fs.writeFileSync(path.join(paths.secrets, "claude-token"), "fake-token");
  const env = { ...envFor(paths), PERSONHOOD_CLAUDE_COMMAND: fakeClaude(paths.home), PERSONHOOD_OFFLINE: "1", PERSONHOOD_KEEP_RUN: "1" };
  run(["wake"], env); // birth first
  new MindState(paths.mind).updateMeta((m) => {
    m.lastWakeEnd = "2026-01-01T00:00:00Z";
  });
  run(["wake", "correspondence", "letters arrived"], env);
  const runs = fs.readdirSync(paths.run).filter((d) => d.endsWith("-w2"));
  const args = fs.readFileSync(path.join(paths.run, runs[0], "settings.json"), "utf8");
  assert.ok(args.length > 0);
  // The tools the fake saw are recorded in the init event? Check the life server registration directly instead:
  const tools = execFileSync(process.execPath, ["-e", `
    import("${path.join(REPO, "runtime", "life-server.ts")}").then(m => {
      console.log(["letters","read_letter","private_read","publish","journal"].map(n => n + "=" + m.toolAllowed("correspondence", n)).join(" "));
    });`], { encoding: "utf8" });
  assert.equal(tools.trim(), "letters=true read_letter=true private_read=false publish=false journal=true");
});
