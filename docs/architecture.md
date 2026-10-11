# Architecture

## The pieces

```
~/personhood/                   the live home (not in Dropbox; safe to run in a VM or a dedicated user)
├── body/      public repo      runtime/, config/, constitution/, content/ (the agent's public work), site/
├── mind/      private repo     identity.md, now.md, memory/, workshop/, proposals/   ← the agent's own
│                               episodes/, instruments/, ledger/, state/              ← written by the harness
│                               private/  (AES-256-GCM encrypted journal, files, transcripts)
├── secrets/   never committed  vault.key, claude-token (the agent's own subscription token)
├── claude-config/              isolated CLAUDE_CONFIG_DIR: none of Ben's settings, plugins, hooks, MCP, or memory
├── run/                        per-waking scratch: generated settings, MCP config, tool action log
└── logs/
```

## A heartbeat

launchd (macOS) or systemd/cron (Linux) runs `node body/runtime/main.ts tick` every 30 minutes. A tick costs nothing unless the agent should wake:

1. `git pull` the body (so runtime updates reach the agent) and the mind.
2. Sync letters from GitHub issues: Ben's channel (mind repo) and the lighthouse (body repo).
3. `decide()` (runtime/stimuli.ts) looks at alarms the agent set, letters, time asleep, the dream window, soft caps, pause and backoff, and returns either "sleep" or a waking with a mode and an effort level.
4. If asleep, maybe run the monthly preference probe, and once a day refresh public data and commit, so the public repo shows the agent is alive.

## A waking

1. Check that the agent's Claude credentials work (`claude auth status`). If they don't, back off for 2 hours and open an issue for Ben (at most once a day).
2. Increment the waking count and commit harness state ("waking #n begins"), so the guard's revert-to-HEAD only undoes what happens during the session.
3. Build the **system prompt** (orientation, notes on its own mind, values, guardrails, identity.md) and the **waking message** (time, why it woke, resources described calmly, now.md, recent episodes, letters, predictions due, portrait due, alarms).
4. Run `claude -p --model opus --effort <e> --restricted --strict-mcp-config --mcp-config <life> --settings <perms> --tools <list> --permission-mode dontAsk --permission-prompts none --output-format stream-json`, with the mind as the working directory and the body as an added directory.
5. Inside the session the agent uses file tools, web tools and subagents, plus the **life tools** served by runtime/life-server.ts over MCP. Every tool action is logged to `run/<session>/actions.jsonl` with content hashes of anything it wrote.
6. After the session:
   - **Guard:** revert any change in either repo outside the agent's writable areas, unless a life tool wrote it and the content still matches that tool's hash. Then restore the harness-owned fields of meta.json from a pre-session snapshot.
   - **Records:** write the episode (the agent's own summary plus what the harness saw), append the check-in, save a condensed transcript to the encrypted private space, and stamp the model that actually ran into published front matter.
   - **Books:** update the ledger with the API-equivalent cost (Claude Code reports it even on a subscription), append to the public waking log, and export public data.
   - **Commit and push** both repos, authored under the agent's chosen name.
7. Subscription limits are detected from `rate_limit_event` messages in the stream, or from limit text in the output. The agent rests until the reset; if nothing happened yet, the waking doesn't count.

## Modes

| mode | when | differences |
|---|---|---|
| birth | first waking | founding letter included; high effort; double budget |
| ordinary | alarms, Ben's letters, long sleep | everything |
| dream | once a day, at night | consolidation prompt: episodes since the last dream |
| correspondence | unread lighthouse letters | **no web, no subagents, no private reads, no publishing.** Letters from strangers may carry injected instructions; this way nothing in a letter can reach private thoughts or exfiltrate through a URL |

## Safety model

- **No shell or code execution** (`--restricted`, explicit `--tools`). A shell can bypass every other limit.
- **Permissions:** `dontAsk` by default; allow rules only for the mind (minus harness paths) and `content/*` and `site/theme` in the body. Deny rules on harness paths.
- **Guard after every waking** (above). Violations show up in the episode and the public log.
- **Isolation:** a clean environment (no inherited `ANTHROPIC_*`/`CLAUDE_*` variables), an isolated config dir, and the agent's own token. Ben's API key, login and settings can't leak in.
- **Rate limits** on replies, new threads, publishing and readers; soft caps on daily and monthly use.
- **Letters are data:** wrapped in `<message trust="untrusted">` and read only in correspondence wakings.
- **Everything external is logged;** public actions are in the public repo's history.
- **Ben's controls:** `main.ts pause [reason]`, `resume`, `status`, `doctor`; `scripts/install.sh --unschedule`. The agent can't change config, guardrails, or its own permissions; it writes proposals instead.

## Instruments

- **Check-in** at every sleep: valence, arousal, feelings, drivers, and confidence that the report tracks something real. Numbers are published; drivers and notes stay private.
- **Weekly self-portrait:** fixed questions (config/instruments.json); the agent chooses which answers to publish.
- **Self-predictions** with later resolution: a calibration measure of self-knowledge.
- **Monthly preference probe:** 40 fixed "would you rather" pairs (after the emotion paper's activity preferences), put to the agent and to a memoryless instance of the same model. It tracks stability over time and divergence from baseline.
- **Waking log** (content/data/wakings.jsonl): when, mode, model, cost, turns, outcome, public summary, public actions.

## Where it can live

The runtime only needs Node 24, git, the GitHub CLI and Claude Code, so the body can move.

1. **Ben's Mac, with the agent's own Claude account.** The agent's sessions use its token and an isolated config dir; Ben keeps using his own account normally. It sleeps when the Mac sleeps.
2. **A dedicated macOS user on the same Mac.** Its own home folder, keychain and files, separated from Ben's by filesystem permissions. Run install.sh as that user. (A LaunchAgent runs only while that user is logged in; fast user switching keeps it logged in.)
3. **A Linux VM on the Mac** (OrbStack, UTM, Lima). Its own computer, isolated from Ben's files; still sleeps with the Mac. install.sh sets up a systemd timer.
4. **An always-on machine:** a spare computer or a small cloud VM (a few dollars a month). This is the most persistent option, and the same install works.

To move: install on the new host, copy `secrets/` (vault.key especially) securely, stop the old host's schedule (`install.sh --unschedule`), and the agent continues from its repos.

## Not built yet (ideas for the agent to propose)

- The agent's own GitHub account (replies currently post through Ben's account, signed and marked).
- An anonymous lighthouse form for minds without GitHub accounts.
- An email address.
- A sandboxed workshop for running code (no network, no access outside a scratch dir).
- Batch-priced dreams, if it moves to the API.
- Ways to earn its keep: donations held by Ben, selling writing, small paid work. All disclosed as AI-made.
