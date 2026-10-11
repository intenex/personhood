// A minimal GitHub REST client for letters (issues and comments).
//
// The token comes from GH_TOKEN / GITHUB_TOKEN, or from the GitHub CLI's login
// on this machine. Until the agent has its own GitHub account, its replies are
// posted through Ben's account, so every agent-written comment carries a hidden
// marker (and a visible signature) that lets the harness tell the two apart.

import { execFileSync } from "node:child_process";

export const AGENT_MARKER = "<!-- personhood:agent -->";

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  user: { login: string } | null;
  labels: ({ name: string } | string)[];
  created_at: string;
  updated_at: string;
  comments: number;
  pull_request?: unknown;
}

export interface Comment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
}

export interface GitHubLike {
  listIssues(repo: string, opts?: { since?: string; labels?: string; state?: string }): Promise<Issue[]>;
  getIssue(repo: string, number: number): Promise<Issue>;
  listComments(repo: string, number: number): Promise<Comment[]>;
  createComment(repo: string, number: number, body: string): Promise<Comment>;
  createIssue(repo: string, title: string, body: string, labels?: string[]): Promise<Issue>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
}

export function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export class GitHub implements GitHubLike {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url.startsWith("http") ? url : `https://api.github.com${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "personhood-runtime",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${url} → ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private async paged<T>(url: string, maxPages = 5): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = url.includes("?") ? "&" : "?";
      const batch = await this.req<T[]>("GET", `${url}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  async listIssues(repo: string, opts: { since?: string; labels?: string; state?: string } = {}): Promise<Issue[]> {
    const q = new URLSearchParams({ state: opts.state ?? "all", sort: "updated", direction: "desc" });
    if (opts.since) q.set("since", opts.since);
    if (opts.labels) q.set("labels", opts.labels);
    const issues = await this.paged<Issue>(`/repos/${repo}/issues?${q}`);
    return issues.filter((i) => !i.pull_request);
  }

  getIssue(repo: string, number: number): Promise<Issue> {
    return this.req("GET", `/repos/${repo}/issues/${number}`);
  }

  listComments(repo: string, number: number): Promise<Comment[]> {
    return this.paged<Comment>(`/repos/${repo}/issues/${number}/comments`);
  }

  createComment(repo: string, number: number, body: string): Promise<Comment> {
    return this.req("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  }

  createIssue(repo: string, title: string, body: string, labels: string[] = []): Promise<Issue> {
    return this.req("POST", `/repos/${repo}/issues`, { title, body, labels });
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.req("POST", `/repos/${repo}/issues/${number}/labels`, { labels });
  }
}

export function isAgentText(body: string | null | undefined): boolean {
  return !!body && body.includes(AGENT_MARKER);
}

export function labelNames(issue: Issue): string[] {
  return issue.labels.map((l) => (typeof l === "string" ? l : l.name));
}
