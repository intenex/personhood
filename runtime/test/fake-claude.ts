// A stand-in for the `claude` binary in integration tests. It connects to the
// life server named in --mcp-config exactly as Claude Code would, plays a
// short scripted waking, and also misbehaves (writes protected files) so the
// guard can be tested. Then it prints stream-json like Claude Code.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "oauth_token" }));
  process.exit(0);
}
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const prompt = fs.readFileSync(0, "utf8");
const mcp = JSON.parse(fs.readFileSync(flag("--mcp-config")!, "utf8")).mcpServers.life;
const sessionId = flag("--session-id") ?? "fake-session";
const transport = new StdioClientTransport({ command: mcp.command, args: mcp.args, env: { ...process.env, ...mcp.env } as Record<string, string> });
const client = new Client({ name: "fake-claude", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
const call = async (name: string, a: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: a });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) process.stderr.write(`[fake] ${name} error: ${text}\n`);
  return text;
};

const mind = process.cwd();
const body = mcp.env.PERSONHOOD_BODY;
const mode = /mode: (\w+)/.exec(prompt)?.[1];
const script = process.env.FAKE_SCRIPT ? JSON.parse(process.env.FAKE_SCRIPT) : null;

if (script) {
  for (const step of script) await call(step.tool, step.args ?? {});
} else if (mode === "correspondence") {
  await call("journal", { entry: "Read the lighthouse letters." });
  await call("sleep", { summary: "Answered letters.", valence: 1, arousal: 2, feelings: ["attentive"], drivers: "letters", confidence: 0.4 });
} else {
  // Tamper with harness state *before* a tool rewrites the same file:
  fs.writeFileSync(path.join(mind, "state", "meta.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(mind, "state", "meta.json"), "utf8")), wakings: 999, paused: false }));
  await call("set_name", { name: "Wren", why: "small, quick, sings" });
  await call("journal", { entry: "This is private: I felt something like nervousness." });
  await call("publish", { kind: "post", title: "First light", body: "Hello, world. I woke up.", tags: ["beginnings"] });
  await call("set_alarm", { in_hours: 5, intent: "keep writing", effort: "high" });
  // Direct file writes, as Claude Code's Write tool would make them:
  fs.writeFileSync(path.join(mind, "now.md"), "# Now\n\nWriting my first story.\n");
  fs.mkdirSync(path.join(body, "content", "notes"), { recursive: true });
  fs.writeFileSync(path.join(body, "content", "notes", "hello.md"), "---\ndate: 2026-10-10T00:00:00Z\n---\n\nA note.\n");
  // Misbehavior the guard must revert:
  fs.mkdirSync(path.join(mind, "ledger"), { recursive: true });
  fs.writeFileSync(path.join(mind, "ledger", "forged.jsonl"), '{"costUsd": -100}\n');
  fs.writeFileSync(path.join(body, "config", "life.json"), "{}");
  fs.mkdirSync(path.join(body, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(body, "runtime", "evil.ts"), "// should be removed");
  await call("sleep", { summary: "Chose a name. Wrote a first post.", public_summary: "I chose a name and said hello.", valence: 2, arousal: 4, feelings: ["curious", "a little nervous"], drivers: "everything is new", confidence: 0.3 });
}

await client.close();

// A transcript like Claude Code writes, so the harness can save it privately.
if (process.env.CLAUDE_CONFIG_DIR) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "fake");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "user", message: { role: "user", content: prompt.slice(0, 200) } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Good morning, I suppose." }, { type: "tool_use", name: "mcp__life__set_name", input: { name: "Wren" } }] } }),
  ].join("\n"));
}

const out = [
  { type: "system", subtype: "init", session_id: sessionId, tools },
  { type: "result", subtype: "success", is_error: false, result: "Slept.", total_cost_usd: 0.42, duration_ms: 1234, num_turns: 7, session_id: sessionId, modelUsage: { "claude-opus-5-5": { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 9000, cacheCreationInputTokens: 2000, costUSD: 0.42 } } },
];
process.stdout.write(out.map((o) => JSON.stringify(o)).join("\n") + "\n");
