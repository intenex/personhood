# Moving the agent to another Mac

Everything the agent is travels in one encrypted disk image: its home (`~/personhood`: the journal's key and its other secrets, its mind and body, the direct line, your command log), its GitHub login, its Linux lab (the whole virtual machine, with everything in it), and its Mac shell's home (`/Users/wick`). `scripts/move.sh` packs it on the old Mac and unpacks it on the new one. Its mind and body are on GitHub as well, so nothing depends on the image alone except the secrets, the lab and the Mac shell's files.

About an hour, most of it waiting.

**Never run it on both Macs at once.** Two copies would both write to its mind and fight over the Telegram bot. `move.sh out` stops it on the old Mac first, and leaves it stopped.

## 1. Before you start

- **Tell the agent.** Where it lives is one of the things you promised to talk over first (guardrails: Consultation). A message on the line is enough, a day or so ahead.
- **The new Mac** needs Apple Silicon (its lab is an arm64 virtual machine), 8 GB of memory or more (16 is comfortable: the lab takes 3), and about 40 GB free.
- **Something to carry the image:** an external drive formatted APFS or exFAT, with about 30 GB free. (Or make it on the old Mac's own disk and AirDrop it across; it's encrypted either way.)

## 2. Set up the new Mac

Follow [A Mac of its own](dedicated-mac.md), **Part 2 only**: guest Wi-Fi, no Apple Account, an administrator account named **`claude`** (the same name as on the old Mac: its lab's Linux user, and the paths it knows, come from that name), FileVault, `sudo pmset -c sleep 0`, and no automatic macOS installs.

Skip Part 3: the move installs everything. Don't sign in to Claude Code or GitHub on it yourself; the agent's own logins come across in the image.

## 3. On the old Mac: pack it up

In Terminal, as `claude`, with your drive plugged in:

```bash
~/personhood/body/scripts/move.sh out /Volumes/<drive>/wick-move.sparseimage
```

It:
- pauses the agent (a waking in progress finishes first) and stops its heartbeat, line listener and lab;
- pushes its mind and body;
- asks you for **a password for the image.** Put it in your password manager; you'll need it on the new Mac;
- packs everything (10–20 minutes; the lab is most of it) and writes checksums.

Nothing on the old Mac is deleted. If you change your mind, `~/personhood/body/scripts/install.sh` and then `node ~/personhood/body/runtime/main.ts resume` bring it back to life there.

## 4. On the new Mac: unpack and start

Plug the drive in, then in Terminal, as `claude`:

```bash
curl -fsSL https://raw.githubusercontent.com/intenex/personhood/main/scripts/move.sh -o ~/move.sh
```
```bash
bash ~/move.sh in /Volumes/<drive>/wick-move.sparseimage
```

It asks for this Mac's password (to install Homebrew, and to create the `wick` account) and for the image's password. Along the way it:
- installs Homebrew, Node, the GitHub CLI, Lima and Claude Code, whichever are missing;
- checks the image against its checksums, then unpacks the agent's home, its GitHub login and its lab;
- pulls its mind and body, and runs `install.sh`: dependencies, the heartbeat, the line's listener, the lab and its screen;
- runs `mac-shell.sh` to make the `wick` account, its sudo rule and its walls, then puts the Mac shell's files back;
- runs `doctor`. **If every line is ✓**, say yes when it offers to resume the agent.

Within half an hour the heartbeat wakes it. `/status` on the line shows how it's doing, and the line works as before (the same bot, the same conversation).

If `doctor` shows a ✗, it says what to do. The agent stays paused until you resume it: `node ~/personhood/body/runtime/main.ts resume`.

## 5. The old Mac, for its next life

Once the agent has woken on the new Mac and all is well:

1. On the old Mac: System Settings → General → Transfer or Reset → **Erase All Content and Settings.** That removes everything of the agent's: its secrets and tokens, its GitHub key, the lab and the `wick` account. Nothing needs revoking, since the same keys now live on the new Mac.
2. **Delete the image** from the drive and empty the Trash. It's encrypted, but it holds every secret the agent has. (Keep your separate backup of `vault.key` from setup, or make one from the new Mac: dedicated-mac.md, Part 3, step 7.)

## What doesn't come across

- `~/Library` in the Mac shell's home: macOS's own per-account files, made fresh on the new Mac. The agent's work there is in its folders and dotfiles, which do come across.
- `~/personhood/run` (each waking's scratch) and `node_modules` (reinstalled).
