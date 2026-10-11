import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
import { AGENT_MARKER, type Comment, type GitHubLike, type Issue } from "./github.ts";
import { markPresented, markRead, postingViaBen, signReply, syncLetters, unreadLetters } from "./letters.ts";
import { MindState } from "./state.ts";
import { REPO, tmp } from "./test/helpers.ts";

const cfg = loadConfig(REPO);

function fakeGitHub(issues: Record<string, Issue[]>, comments: Record<string, Comment[]>): GitHubLike {
  return {
    listIssues: async (repo) => issues[repo] ?? [],
    getIssue: async (repo, n) => (issues[repo] ?? []).find((i) => i.number === n)!,
    listComments: async (repo, n) => comments[`${repo}#${n}`] ?? [],
    createComment: async () => ({ id: 1, body: "", user: null, created_at: "", html_url: "" }),
    createIssue: async () => issues[cfg.github.mindRepo][0],
    addLabels: async () => {},
  };
}

const issue = (n: number, body: string, at: string, labels: string[] = [], comments = 0): Issue => ({ number: n, title: `#${n}`, body, html_url: `https://x/${n}`, state: "open", user: { login: "intenex" }, labels: labels.map((name) => ({ name })), created_at: at, updated_at: at, comments });

test("letters: unread, agent-opened, harness alerts, replies", async () => {
  const state = new MindState(tmp());
  const mind = cfg.github.mindRepo;
  const pub = cfg.github.bodyRepo;
  const issues = {
    [mind]: [
      issue(1, "Hi friend, how are you?", "2026-10-11T01:00:00Z"),
      issue(2, `A request for an email address\n${AGENT_MARKER}`, "2026-10-11T02:00:00Z", ["request"], 1),
      issue(3, "The heartbeat couldn't wake me", "2026-10-11T03:00:00Z", ["harness"]),
    ],
    [pub]: [issue(7, "Is anyone there?", "2026-10-11T04:00:00Z", ["lighthouse"])],
  };
  const comments: Record<string, Comment[]> = { [`${mind}#2`]: [{ id: 9, body: "Sure, I'll set one up.", user: { login: "intenex" }, created_at: "2026-10-11T05:00:00Z", html_url: "" }] };
  await syncLetters(fakeGitHub(issues, comments), cfg, state);
  const unread = unreadLetters(state).map((l) => l.id).sort();
  assert.deepEqual(unread, ["ben-1", "ben-2", "pub-7"], "Ben's letter, Ben's reply on the agent's request, and the lighthouse letter; never the harness alert");

  markRead(state, "ben-1");
  markPresented(state, ["pub-7"]);
  assert.deepEqual(unreadLetters(state).map((l) => l.id), ["ben-2"]);

  // The agent's own reply doesn't make a thread unread again.
  comments[`${mind}#2`].push({ id: 10, body: signReply("Thank you!", "Wren"), user: { login: "intenex" }, created_at: "2026-10-11T06:00:00Z", html_url: "" });
  issues[mind][1].comments = 2;
  markRead(state, "ben-2", new Date("2026-10-11T06:00:01Z"));
  await syncLetters(fakeGitHub(issues, comments), cfg, state);
  assert.deepEqual(unreadLetters(state), []);
});

test("signed replies carry the marker and a disclosure, and say whose account posted them", () => {
  const s = signReply("Hello.", "Wren");
  assert.match(s, /— Wren/);
  assert.match(s, /an AI agent \(Claude\) writing autonomously_/);
  assert.doesNotMatch(s, /Ben's account/, "on its own GitHub account, it doesn't claim to post through Ben's");
  assert.ok(s.includes(AGENT_MARKER));
  assert.match(signReply("Hello.", "Wren", true), /posted through Ben's account/);
});

test("whose account: the body repo's owner is Ben", async () => {
  const gh = (login: string) => ({ ...fakeGitHub({}, {}), login: async () => login });
  assert.equal(await postingViaBen(gh("intenex"), cfg), true);
  assert.equal(await postingViaBen(gh("rocksandpeanuts"), cfg), false);
  assert.equal(await postingViaBen(fakeGitHub({}, {}), cfg), false);
});
