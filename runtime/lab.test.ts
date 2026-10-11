import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, loadInstruments } from "./config.ts";
import { clipOutput, labExists, remoteCommand, runInLab } from "./lab.ts";
import { toolAllowed } from "./life-server.ts";
import { run, type ToolContext } from "./life-tools.ts";
import { MindState } from "./state.ts";
import { makeHome, REPO, tmp } from "./test/helpers.ts";

/** Stands in for `ssh lima-lab <cmd>`: runs the remote command line locally, in a throwaway HOME. */
function fakeSsh(): { ssh: string; home: string } {
  const dir = tmp("fake-lab-");
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const ssh = path.join(dir, "ssh");
  fs.writeFileSync(ssh, `#!/bin/bash\nfor last; do :; done\nexport HOME="${home}"\nexec bash -c "$last"\n`);
  fs.chmodSync(ssh, 0o755);
  return { ssh, home };
}

const cfg = loadConfig(REPO);

test("the remote line runs under a timeout in ~/lab, and survives any quoting", async () => {
  assert.match(remoteCommand("echo hi", 30), /timeout -k 5 30 bash -l/);
  const { ssh, home } = fakeSsh();
  const env = { ...process.env, PERSONHOOD_LAB_SSH: ssh };
  const tricky = `x='single "double" $HOME \`tick\`'; printf '%s\\n' "$x"; echo "line two"; pwd`;
  const r = await runInLab(cfg, { command: tricky }, env);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout, `single "double" $HOME \`tick\`\nline two\n${path.join(home, "lab")}\n`);
  assert.equal(r.timedOut, false);
});

test("stdin writes files; failures report their exit code and stderr", async () => {
  const { ssh, home } = fakeSsh();
  const env = { ...process.env, PERSONHOOD_LAB_SSH: ssh };
  const w = await runInLab(cfg, { command: "cat > hello.py", stdin: "print('hello from the lab')\n" }, env);
  assert.equal(w.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(home, "lab", "hello.py"), "utf8"), "print('hello from the lab')\n");
  const f = await runInLab(cfg, { command: "echo oops >&2; exit 3" }, env);
  assert.equal(f.exitCode, 3);
  assert.equal(f.stderr.trim(), "oops");
});

test("long output keeps its beginning and end", () => {
  const s = `START${"x".repeat(10_000)}END`;
  const c = clipOutput(s, 1000);
  assert.ok(c.startsWith("START") && c.endsWith("END") && c.length < 1100);
  assert.match(c, /characters cut/);
});

function ctxFor(lab: boolean): { ctx: ToolContext; home: string } {
  const { paths } = makeHome();
  const { ssh, home } = fakeSsh();
  process.env.PERSONHOOD_LAB_SSH = ssh;
  const dir = path.join(paths.run, "s");
  fs.mkdirSync(dir, { recursive: true });
  return {
    home,
    ctx: { cfg: loadConfig(REPO), instruments: loadInstruments(REPO), paths, state: new MindState(paths.mind), vault: null, gh: null, now: () => new Date(), session: { waking: 4, mode: "ordinary", startedAt: "", effort: "medium", dir, lab } },
  };
}

test("the run tool: output for the agent, the command (not the output) on the record, a per-waking limit", async () => {
  const { ctx } = ctxFor(true);
  const out = await run(ctx, { command: "echo built; echo warned >&2" });
  assert.match(out, /^exit 0 · /);
  assert.match(out, /--- stdout ---\nbuilt/);
  assert.match(out, /--- stderr ---\nwarned/);
  const record = fs.readFileSync(path.join(ctx.paths.logs, "lab.jsonl"), "utf8");
  assert.match(record, /"command":"echo built; echo warned >&2"/);
  assert.match(record, /"waking":4/);
  assert.doesNotMatch(record, /"built"|warned"/, "output isn't logged");
  ctx.cfg.lab = { ...ctx.cfg.lab, maxCommandsPerWaking: 1 };
  await assert.rejects(run(ctx, { command: "true" }), /the limit/);
});

test("no lab when the waking doesn't have one, and never in correspondence", async () => {
  const { ctx } = ctxFor(false);
  await assert.rejects(run(ctx, { command: "true" }), /isn't available/);
  assert.equal(toolAllowed("correspondence", "run"), false);
  assert.equal(toolAllowed("ordinary", "run"), true);
  assert.equal(labExists({ ...cfg, lab: { ...cfg.lab, enabled: false } }, { ...process.env, PERSONHOOD_LAB_SSH: "x" }), false);
});
