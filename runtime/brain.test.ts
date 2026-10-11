import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinTools, buildSettings, cleanEnv, detectLimitReset, parseResult } from "./brain.ts";
import { makeHome } from "./test/helpers.ts";

test("stream-json parsing picks up the result and rate-limit rejections", () => {
  const out = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1760200000 } }),
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1760203600 } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 1.25, duration_ms: 9000, num_turns: 12, session_id: "s1", modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 1.2 }, "claude-haiku-5-5": { costUSD: 0.05 } } }),
  ].join("\n");
  const r = parseResult(out, "", 0);
  assert.equal(r.ok, true);
  assert.equal(r.costUsd, 1.25);
  assert.equal(r.turns, 12);
  assert.equal(r.primaryModel, "claude-opus-5-5");
  assert.equal(r.limitResetAt, new Date(1760203600 * 1000).toISOString());
});

test("limit messages in plain output are detected", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  assert.equal(detectLimitReset("Claude AI usage limit reached|1760205600", now), new Date(1760205600000).toISOString());
  assert.ok(detectLimitReset("You've hit your limit · resets 3pm", now));
  assert.equal(detectLimitReset("all good, wrote the story", now), null);
});

test("errors without a result still parse", () => {
  const r = parseResult("not json", "boom", 1);
  assert.equal(r.ok, false);
  assert.equal(r.subtype, "no_result");
});

test("permission settings allow the mind and content, deny harness paths", () => {
  const { paths } = makeHome();
  const s = buildSettings(paths) as { permissions: { allow: string[]; deny: string[]; defaultMode: string } };
  assert.equal(s.permissions.defaultMode, "dontAsk");
  assert.ok(s.permissions.allow.some((r) => r === `Edit(/${paths.mind}/**)`));
  assert.ok(s.permissions.allow.some((r) => r.includes("content/stories")));
  assert.ok(s.permissions.deny.some((r) => r === `Write(/${paths.mind}/state/**)`));
  assert.ok(!s.permissions.allow.some((r) => r.includes("runtime")));
});

test("correspondence wakings have no web or subagents", () => {
  assert.deepEqual(builtinTools("correspondence").filter((t) => /Web|Agent/.test(t)), []);
  assert.ok(builtinTools("ordinary").includes("WebFetch"));
});

test("the agent's environment drops Ben's credentials and parent sessions", () => {
  const env = cleanEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "x", ANTHROPIC_BASE_URL: "y", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "z", PERSONHOOD_HOME: "/h" });
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "PERSONHOOD_HOME"]);
});
