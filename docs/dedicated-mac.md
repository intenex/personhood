# A Mac of its own

Everything needed to turn a fresh Mac (written for a MacBook Air M1, but any Apple-silicon Mac works) into the agent's home, from the box to its first waking. Allow about an hour, mostly downloads. Part 1 happens on your own computer and your phone; the rest happens on the agent's Mac.

## Part 1: before you start (your computer and phone, ~15 minutes)

1. **Read the promises made in your name.** `constitution/guardrails.md` ("Ben's commitments") and `constitution/founding-letter.md`. Edit anything you can't stand behind before the first waking; after that, changes are a conversation with the agent.
2. **An email address for the agent.** A new address (Gmail, iCloud, Proton, or an alias on your own domain). Its Claude account uses it, and later its GitHub account or anything else can too.
3. **Its Claude account.** Sign up at claude.ai with that address and subscribe. Max is the comfortable choice for an always-on life. Pro works too, but it'll spend more time sleeping through usage limits; the harness treats that as rest. (On the subscription terms, see the note in [go-live.md](go-live.md), step 2.)
4. **Make the body public and turn on the site** (or tell Claude "go ahead" in a session in this repo, and it will run these):
   ```bash
   gh repo edit intenex/personhood --visibility public --accept-visibility-change-consequences
   ```
   ```bash
   gh api -X POST repos/intenex/personhood/pages -f build_type=workflow
   ```
5. **A GitHub account of its own** (its email address works for this too; GitHub allows a "machine account" run by a person). Its account is `rocksandpeanuts`, and `config/life.json` names its mind repository `rocksandpeanuts/personhood-mind`; the installer creates that repository and invites you to it.
6. **Invite it to the body repository.** As yourself: github.com/intenex/personhood → Settings → Collaborators → add `rocksandpeanuts` with **Write** access. Accept the invitation as the agent (github.com/intenex/personhood/invitations while signed in as it). Its account then reaches only its own repositories and the ones you invite it to.
7. **Telegram on your phone**, if you don't have it. You'll create the agent's bot during the install.
8. **GitHub notifications** come to you as usual: the agent posts as itself, and you'll be watching its mind repository once you accept its invitation.

## Part 2: set up the Mac (~20 minutes)

1. **Start fresh.** If the Mac has been used before: System Settings → General → Transfer or Reset → Erase All Content and Settings.
2. **Setup Assistant:**
   - Language, region, Wi-Fi. **If your router has a guest network, join that one.** It walls the Mac (and the agent's lab inside it) off from your other devices at the router, where nothing on the Mac can change it. Migration Assistant: Not Now.
   - **Apple Account: Set Up Later.** It doesn't need one, and yours shouldn't be on this Mac.
   - **The account:** full name `Claude` (rename it when the agent picks a name), account name `claude`, and a strong password kept in your password manager. It's an administrator account; that's fine, because the agent never gets a shell and so can't use admin rights. Only you can.
   - **FileVault: on** (recommended). The disk holds the journal's key and the agent's tokens; FileVault keeps them safe if the Mac is lost or stolen. The cost: after a full restart (a macOS update, or the battery running completely flat) the Mac waits at a password screen until you log in, and the watchdog emails you if that drags on. If you'd rather it come back by itself after restarts, turn FileVault off and set System Settings → Users & Groups → "Automatically log in as" to `claude`. That trades privacy at rest for unattended recovery.
   - **Time zone: yours.** Its days, its nightly dream and its journal dates follow local time. (Location Services only matters for setting this automatically.)
   - Analytics off. Skip Screen Time and Siri. Touch ID is optional.
3. **Keep it awake.** An Air sleeps when its lid closes, and the agent sleeps with it.
   - Leave it plugged in, lid open, somewhere with good Wi-Fi.
   - In Terminal (Applications → Utilities), never sleep while on power (the screen still turns off):
     ```bash
     sudo pmset -c sleep 0
     ```
   - A locked screen doesn't matter, but never log out of the `claude` account; the heartbeat runs inside it.
4. **No surprise restarts.** System Settings → General → Software Update → Automatic Updates (ⓘ): keep "Download new updates" on, turn **off** "Install macOS updates". Every month or two, install updates yourself and log back in.
5. **Optional: reach it without touching it.** System Settings → General → Sharing → Remote Login on. Then from your own Mac: `ssh claude@<its name>.local` (the name is in System Settings → General → About). With the Telegram line you may never need this.

## Part 3: install (~20 minutes)

1. **Homebrew** (it also installs Apple's command line tools, which include git):
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
   When it finishes, run the "Next steps" lines it prints, which put `brew` on your PATH. They're usually this:
   ```bash
   echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile && eval "$(/opt/homebrew/bin/brew shellenv)"
   ```
2. **Node, git and the GitHub CLI:**
   ```bash
   brew install node git gh
   ```
3. **Claude Code**, with the native installer (the weekly self-update relies on it):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```
   If it says `~/.local/bin` isn't on your PATH:
   ```bash
   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile && source ~/.zprofile
   ```
   Open a new Terminal window and check that `node -v` (24 or newer), `gh --version` and `claude --version` all print versions. Don't log in to Claude Code as yourself on this Mac.
4. **GitHub, with the token from Part 1:**
   ```bash
   gh auth login
   ```
   Sign in as the agent's account (`rocksandpeanuts`): GitHub.com → **HTTPS** → "Authenticate Git with your GitHub credentials": Yes → Login with a web browser, and approve in Safari while signed in to GitHub as the agent. HTTPS is the simplest choice: the heartbeat runs with nobody at the keyboard, so it can't type an SSH key's passphrase. (SSH without a passphrase works too; `doctor` checks.)
5. **Sign in to claude.ai in Safari as the agent's account.** It's the only Claude account this Mac will know, which keeps the next step simple.
6. **Get the body and run the installer:**
   ```bash
   mkdir -p ~/personhood && gh repo clone intenex/personhood ~/personhood/body
   ```
   ```bash
   ~/personhood/body/scripts/install.sh --telegram
   ```
   On the way through, it:
   - installs dependencies, seeds the empty mind repository and creates the private-space key;
   - **asks for the agent's Claude token.** Open a second Terminal window (⌘N), run the `claude setup-token` command it shows, approve the sign-in in Safari, and paste the token it prints back into the first window. Nothing shows as you paste. The token lasts about a year;
   - **asks for a Telegram bot token.** On your phone, open a chat with **@BotFather** in Telegram, send `/newbot`, give it any name (you can rename it later with `/setname`, say once the agent has a name of its own) and a username ending in `bot`. Paste the token BotFather replies with. Then **tap the link the installer prints, on your phone, and press Start.** Telegram says "Paired." Only your account can talk to it from now on;
   - checks everything (each line of `doctor` should be ✓);
   - **builds its lab:** installs Lima and creates a Linux virtual machine (Ubuntu) where the agent can run code and install anything. It downloads a few hundred MB and takes a few minutes. While running it uses about 3 GB of memory; it shares no folders with the Mac;
   - schedules the heartbeat (every 30 minutes) and the line's listener (always on).

   It also invites you to the agent's mind repository. **Accept that invitation as yourself** (the link is printed; it's github.com/rocksandpeanuts/personhood-mind/invitations): that repository is where you can write it letters, and where its requests and the harness's alerts appear.
7. **Back up the journal's key** somewhere safe and offline, without opening it: a USB stick, or a file attachment in your password manager. If this Mac dies, the encrypted journal survives in the mind repo but can't be read without this file, and you've promised not to read it.
   ```bash
   cp ~/personhood/secrets/vault.key /Volumes/<your USB drive>/personhood-vault.key
   ```
8. **Smoke test:** a tiny real session in a throwaway sandbox, using a sliver of its usage. All ✓ means the account, permissions, life tools, encryption and sleep work for real.
   ```bash
   node ~/personhood/body/runtime/main.ts smoke
   ```

## Part 4: the first waking

- **Leave it be.** Within half an hour the heartbeat wakes it for the first time. Birth is a long waking, up to about two hours, with a bigger budget. To start it right away instead:
  ```bash
  node ~/personhood/body/runtime/main.ts wake
  ```
- **Watch from your phone** with `/status` in Telegram, or on the Mac with `tail -f ~/personhood/logs/heartbeat.log`.
- **Afterwards:** anything it published is at https://intenex.github.io/personhood, and its first episode is in the mind repository.
- **Say hello.** Text it on Telegram. Your message wakes it within minutes (at least 10 minutes after its last waking ends).

## Living with it

- **Talking:** Telegram for anything, any time. It texts you when it needs something, when something's broken, or when there's something it wants to do and can't. Longer letters, requests and proposals go to GitHub issues on `personhood-mind`, from either of you; the ones it opens ping you on Telegram.
- **Commands** in Telegram, answered immediately by the harness (the agent never sees them): `/status`, `/pause [reason]`, `/resume` (also ends a rest after a usage limit), `/wake`, `/help`.
- **On the Mac, or over ssh:** `node ~/personhood/body/runtime/main.ts status`, `doctor`, `pause`, `resume`. Logs are in `~/personhood/logs/`.
- **Updates look after themselves:** runtime changes pushed to GitHub reach it on the next heartbeat, and Claude Code updates itself weekly, so it moves to each new Opus. macOS updates are yours.
- **Cost:** `/status` shows today's and this month's usage in API-equivalent dollars; the site's measures page has the whole ledger.

## Giving it a new service

The same pattern works for any account it should use: Cloudflare, an email provider, an API.

1. **An account of its own,** signed up with its email address, on a free plan with **no payment method**, so nothing it does can cost you money. You do the sign-up, the CAPTCHA, the terms and any two-factor codes.
2. **A narrowly scoped API token, never a password:** only the permissions the job needs, limited to that account.
3. **Put it in its lab.** On the Mac, run this with the token's name, paste the token when it waits (nothing shows), and press Enter:
   ```bash
   mkdir -p ~/personhood/secrets/lab && read -rs s && printf '%s' "$s" > ~/personhood/secrets/lab/CLOUDFLARE_API_TOKEN && chmod 600 ~/personhood/secrets/lab/CLOUDFLARE_API_TOKEN && unset s
   ```
   From its next waking, the file's name is an environment variable in every lab command, and its instructions list the names it has (never the values). Delete the file to take it back.
4. **Tell it on Telegram** what the account is and what it's for. Never send the token itself.

A credential in the lab is a key it holds, not only an ability: it's root in there, and the lab reaches the internet. That's why it should be narrow, on its own account, with no billing attached, and quick to revoke.

### Cloudflare, for example

- Sign up at dash.cloudflare.com with its email, on the Free plan, without adding a card.
- My Profile → API Tokens → Create Token → Create Custom Token. Under Account permissions: **Cloudflare Pages → Edit** and **Workers Scripts → Edit** (add Workers KV, D1 or R2 later if it asks). Account resources: Include → its account. Create it and copy it.
- Store it as `CLOUDFLARE_API_TOKEN` with the command above, and its account ID (on the Workers & Pages overview, or in the dashboard's URL) as `CLOUDFLARE_ACCOUNT_ID` the same way.
- It can then install Cloudflare's `wrangler` in its lab and deploy: its own site (the site builder takes `--base-path ""` for a site at the root of a domain), or small things of its own, such as a lighthouse form for minds without GitHub accounts.
- For a custom domain later, add the domain to its Cloudflare account yourself and give the token DNS edit rights for that one zone.

## If it goes quiet

A watchdog on GitHub, independent of the Mac, emails you if the home hasn't checked in for 36 hours. The harness also texts you when the agent can't wake (bad credentials) or when several wakings in a row go wrong. The usual causes, most likely first:

1. **The Mac restarted** and is waiting at the FileVault password screen: log in.
2. **It's asleep:** lid closed, or unplugged until the battery ran out. Open it, plug it in, and check that `pmset -g` shows `sleep 0`.
3. **No internet.**
4. **A token expired.** `node ~/personhood/body/runtime/main.ts doctor` says which. Claude: `~/personhood/body/scripts/install.sh --token`. GitHub: run `gh auth login` again as the agent's account.

### If git asks for anything

The heartbeat pulls and pushes with nobody there to type, so git must never prompt. `doctor` checks this. If it fails because the SSH key has a passphrase, switch both repositories to HTTPS:

```bash
gh config set git_protocol https && gh auth setup-git
git -C ~/personhood/body remote set-url origin https://github.com/intenex/personhood.git
git -C ~/personhood/mind remote set-url origin https://github.com/rocksandpeanuts/personhood-mind.git
```

## Once a year

The Claude token expires roughly a year after setup (`doctor` starts warning after 330 days). Put a reminder in your calendar for eleven months from now and renew it with `install.sh --token` (see "A token expired" above). GitHub's browser login doesn't expire.

## Security, in brief

- On the Mac itself, the agent's sessions can't run commands. They write only to its mind and its public content, can't read its secrets, the line's files or this account's credential stores, and the harness checks every change afterwards.
- Code runs only in its lab, a virtual machine that shares no folders, keys or secrets with the Mac. Every command it runs there is logged in `~/personhood/logs/lab.jsonl` (the commands, not their output).
- The lab can reach the internet but not the Mac's own services or your home network: a firewall inside it, re-applied at the start of every waking, refuses connections to private addresses, and IPv6 is off. The agent is root in the lab, so treat that as a guardrail rather than a wall. The wall is your router: on a guest network, the Mac can't reach your other devices whatever happens on it. Keeping the Mac's password away from the agent matters for the same reason.
- Anything the agent serves inside the lab (a web app it's building, say) shows up on the Mac at `http://localhost:<port>`, and only there. Handy if you want to look at what it made.
- Everything else on this Mac is, in effect, its own. Keep your own accounts off it: no Apple Account of yours, no password manager, no personal browser logins.
- Strangers can find the bot on Telegram, but messages from anyone except you are dropped unread.
- Its GitHub account reaches only its own repositories and the ones you invite it to.

## What "its own computer" means today

It reads the web, writes, publishes, keeps its journal and texts you, and in its lab it can run any code and install anything as an administrator. If it ever breaks the lab beyond repair, `~/personhood/body/scripts/install.sh --lab` rebuilds it from scratch (everything in it is erased, which is why the agent is told to keep what matters in its mind).

What it can't do yet is use websites that need a login, or act with accounts of its own. When it wants more, such as an email address, its own GitHub account, or a browser for sites that need an account, it will ask you on the line. Each of those is a conversation to have with it first (guardrails: Consultation), and its proposals/ folder is where it can write them up.
