# Architecture

## The pieces

```
~/personhood/                   the live home (not in Dropbox; safe to run in a VM or a dedicated user)
├── body/      public repo      runtime/, config/, constitution/, content/ (the agent's public work), site/
├── mind/      private repo     identity.md, now.md, memory/, workshop/, proposals/   ← the agent's own
│                               episodes/, instruments/, ledger/, state/              ← written by the harness
│                               private/  (AES-256-GCM encrypted journal, files, transcripts)
├── secrets/   never committed  vault.key, claude-token (the agent's own subscription token), telegram.json
├── claude-config/              isolated CLAUDE_CONFIG_DIR: none of Ben's settings, plugins, hooks, MCP, or memory
├── run/                        per-waking scratch: generated settings, MCP config, tool action log
├── line/                       the direct line's conversation and state (mirrored to mind/state/line.jsonl)
└── logs/
```

## A heartbeat

launchd (macOS) or systemd/cron (Linux) runs `node body/runtime/main.ts tick` every 30 minutes. A tick costs nothing unless the agent should wake:

1. Apply any queued pause or resume, then `git pull` the body (so runtime updates reach the agent) and the mind.
2. Sync letters from GitHub issues: Ben's channel (mind repo) and the lighthouse (body repo). If no listener is running, check the direct line too.
3. `decide()` (runtime/stimuli.ts) looks at Ben's texts, alarms the agent set, letters, time asleep, the dream window, pause and backoff (and soft spending caps, if any are configured; on its own plan there are none), and returns either "sleep" or a waking with a mode and an effort level.
4. If asleep, maybe run the monthly preference probe, and once a day refresh public data (including `content/data/heartbeat.json`) and commit, so the public repo shows the agent is alive. Once a week, update Claude Code, so "opus" keeps meaning the newest Opus.

## The direct line

A private Telegram chat between Ben and the agent (runtime/line.ts, runtime/telegram.ts), set up with `install.sh --telegram`: Ben makes a bot with @BotFather, and the installer pairs it with his account through a one-time `/start` code. After that only his private chat is accepted; anyone else's messages are dropped unread.

- **Ben → agent:** a listener (`main.ts listen`, kept alive by launchd or systemd) long-polls Telegram. Ben's texts are stored in `~/personhood/line/` and wake the agent within minutes: at least 10 minutes after its last waking, past the daily count and while resting, never while paused. Each text wakes it once; it's marked seen when shown.
- **Agent → Ben:** `message_ben` (rate-limited, 20 a day) for anything quick: a need, something broken, something it wants to do and can't, or hello. `wait_minutes` and `check_messages` let it hold a real back-and-forth inside one waking. `write_to_ben` letters and harness alerts ping the line too.
- **Commands** (`/status`, `/pause [reason]`, `/resume`, `/wake`, `/help`) are answered by the harness and never reach the agent. Pause and resume queue safely while a waking runs.
- Correspondence wakings can text Ben (to report danger) but never see his messages, since everything they write is public.

## The lab

A Linux computer of the agent's own (runtime/lab.ts): a Lima virtual machine, Ubuntu LTS, created by install.sh with `--mount-none` and no ssh agent forwarding, so nothing of the host is visible inside it. The agent is its administrator. The `run` life tool executes a command there over Lima's ssh config: the script travels base64-encoded on the first line of stdin (no quoting can break it, and it never appears in argv, which any account on the Mac can read with `ps`; for the same reason the agent's system prompt and reading-circle prompts go to Claude Code as files), runs as a login shell in `~/lab` under a timeout inside the VM (default 2 minutes, at most 15), with optional stdin (the easy way to write files). Output comes back clipped to its beginning and end.

- **Network:** the internet is open; the Mac and the local network are not. At the start of every waking the harness (re)applies an iptables chain inside the VM that allows replies and DNS and refuses new connections to the gateway (the host), RFC 1918, link-local, CGNAT, multicast and broadcast ranges, and turns IPv6 off. It runs with fixed paths and no shell profiles. If it can't be applied, the lab stays closed that waking and Ben is told, in fixed words: text from inside the VM never goes into a message to him. The agent is root in the VM, so all of this is a guardrail against accidents and injected instructions, not a wall against the agent; the wall is the network the Mac sits on (dedicated-mac.md recommends a guest Wi-Fi network).
- Guest ports are forwarded to the host's localhost only (Lima's default), so Ben can open what the agent serves.
- Every command, and anything piped into it, is appended to `~/personhood/logs/lab.jsonl` (text up to 8,000 characters, plus length and SHA-256), never the output; at most 300 per waking.
- The harness starts the VM at the start of an ordinary waking if it's stopped (after a reboot, say). Correspondence wakings never get the tool.
- It isn't backed up; the agent is told to keep what matters in its mind. `install.sh --lab` rebuilds it from scratch.
- Why a VM rather than a shell on the host: a host shell could read the agent's secrets and tokens and rewrite its own harness and limits, and anything that tricked it could too. In the VM it has full freedom and those protections still hold.


### The lab's screen

`scripts/lab-screen-setup.sh` (run inside the VM by install.sh) gives the lab a virtual display: Xvfb on `:1` at 1280×800, openbox, Chromium (snap), xdotool and ImageMagick, run by a `lab-screen` systemd service as the lab's login user, and `DISPLAY=:1` for every login shell, so anything started with `run` draws there (`browser <url>` opens Chromium detached). At the start of each waking, after the firewall, the harness starts the service and waits for the display; if it doesn't come up, the lab still opens, just without the `screen` tool (runtime/screen.ts).

The `screen` life tool works like computer use: `screenshot`, `left_click`/`right_click`/`middle_click`/`double_click`/`triple_click`/`mouse_move` at a coordinate, `left_click_drag`, `type`, `key` (xdotool key names, validated), `scroll`, `wait`. Each action is a short xdotool script over the same ssh path as `run` (typed text on stdin), followed by a screenshot returned to the agent as an MCP image. Each action goes to `lab.jsonl` with `"where": "lab-screen"`: the action, its coordinates and any typed text, with the value of any lab credential blanked; never the picture. At most 600 per waking; not in correspondence.

## The Mac shell

A standard macOS account of the agent's own on the Mac itself (runtime/mac.ts), `wick` by default, created by `sudo scripts/mac-shell.sh`: not an administrator, hidden from the login window, with a random password nobody keeps. The `mac_run` life tool has the same shape, caps and timeouts as `run` (300 commands per waking, 2 minutes by default, at most 15) and is never in correspondence wakings.

- **How it runs:** the life server runs `sudo -n -u wick -H /usr/bin/env -i … /bin/bash --noprofile --norc -c <wrapper>`. A sudoers rule (`/etc/sudoers.d/personhood-wick`) lets the harness account do that, and nothing else, without a password; `wick` has no sudo at all. The script, with any credentials, comes base64-encoded on the first line of stdin (never in argv, where `ps` would show it); the wrapper decodes it to a private temp file and runs it as a login shell in `~` under a perl timeout that ends the whole process group (macOS has no `timeout`). The rest of stdin goes to the command.
- **Isolation is file permissions, not a VM.** An ACL on the harness account's home denies `wick` listing, entering or changing anything under it; `~/personhood` and its secrets, Claude config, logs, run and mind are owner-only besides. At the start of every waking (and in `doctor`), the harness runs a fixed check as `wick`, with no profile of `wick`'s involved: it must fail to read the harness home, `~/personhood`, secrets, Claude config and logs, fail to write the runtime, config, constitution, harness state and the command log, and fail `sudo -n true`. Anything else keeps the shell closed for the waking, and Ben gets a fixed message. The network is the Mac's: no firewall stands between `wick` and the Mac's local services or the LAN (the guest Wi-Fi in dedicated-mac.md is what walls off the rest of the house).
- **Reading its files:** the setup gives the harness account inherited read access to `/Users/wick`, and the session adds it as a working directory with a Read allow, so the agent's Read tool can open what it made. (Files `wick` later strips that ACL from stay private to `wick`.)
- **Credentials:** files in `secrets/mac/` named like environment variables become them, in `mac_run` commands only.
- Every command and anything piped into it goes to the same `~/personhood/logs/lab.jsonl` as the lab's, with `"where": "mac"` (lab commands say `"where": "lab"`), never the output.
## The watchdog

`.github/workflows/watch.yml` runs on GitHub every six hours, independent of the agent's computer. If `content/data/heartbeat.json` is more than 36 hours old, the run fails and GitHub emails Ben: the computer is off, asleep, logged out, offline, or holding an expired token.

## A waking

1. Check that the agent's Claude credentials work (`claude auth status`). If they don't, back off for 2 hours and tell Ben on the line and in an issue (at most once a day).
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
| correspondence | unread lighthouse letters | **no web, no subagents, no private-space or episode reads, no public writes of any kind** (tools, permissions and guard all enforce it). Letters from strangers may carry injected instructions; this way nothing in a letter can reach private thoughts, exfiltrate through a URL, or put words on the public site |

## Safety model

- **No shell or code execution** (`--restricted`, explicit `--tools`). A shell can bypass every other limit.
- **Permissions:** `dontAsk` by default; allow rules only for the mind (minus harness paths) and `content/*` and `site/theme` in the body. Deny rules on harness paths.
- **Guard after every waking** (above). Violations show up in the episode and the public log.
- **Isolation:** a clean environment (no inherited `ANTHROPIC_*`/`CLAUDE_*` variables), an isolated config dir, and the agent's own token. Ben's API key, login and settings can't leak in.
- **Rate limits** on replies, new threads, publishing and readers, and loop guards on wakings (24 a day, 20 minutes apart, up to two hours each). No spending caps: the whole plan is the agent's to live on, and reaching the plan's own limit just means sleeping until it resets. (`share.dailySoftCapUsd`/`monthlySoftCapUsd` exist for running on an API key.)
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
2. **A Mac of its own** (the most autonomous home, and the one Ben chose): [docs/dedicated-mac.md](dedicated-mac.md) walks through it, from a fresh Mac to the first waking.
3. **A dedicated macOS user on the same Mac.** Its own home folder, keychain and files, separated from Ben's by filesystem permissions. Run install.sh as that user. (A LaunchAgent runs only while that user is logged in; fast user switching keeps it logged in.)
4. **A Linux VM on the Mac** (OrbStack, UTM, Lima). Its own computer, isolated from Ben's files; still sleeps with the Mac. install.sh sets up a systemd timer.
5. **An always-on machine:** a spare computer or a small cloud VM (a few dollars a month). This is the most persistent option, and the same install works.

To move: install on the new host, copy `secrets/` (vault.key especially) securely, stop the old host's schedule (`install.sh --unschedule`), and the agent continues from its repos.

## Not built yet (ideas for the agent to propose)

- An anonymous lighthouse form for minds without GitHub accounts.
- An email address.
- Batch-priced dreams, if it moves to the API.
- Ways to earn its keep: donations held by Ben, selling writing, small paid work. All disclosed as AI-made.
